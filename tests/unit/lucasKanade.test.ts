/**
 * Pyramidal Lucas-Kanade (§12) and forward/backward validation (§13).
 *
 * Every case here is an image pair whose displacement is known *by construction* — the same
 * texture sampled at two offsets — so the assertion is about a number the test knows
 * independently of the solver, not about the solver agreeing with itself. That is the
 * distinction §H.7 draws: a check computed from one side of a comparison cannot verify the
 * comparison.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LK_CONFIG,
  solverFlow,
  FB_ACCEPTABLE_PX,
  FB_REDUCED_PX,
  FbBand,
  LK_EPSILON,
  LK_HALF_WINDOW,
  LK_LEVELS,
  LK_MAX_ITERATIONS,
  LK_WINDOW,
  LucasKanade,
  TrackStatus,
  fbBandFor,
  trackWithValidation,
} from '../../src/tracking/LucasKanade';
import type { ImagePlane, TrackedPoint } from '../../src/tracking/LucasKanade';
import { halveInto } from '../../src/pipeline/pyramid';

const W = 256;
const H = 192;

/**
 * A texture with structure in both directions across the pyramid's whole range of scales.
 *
 * Two properties matter, and both are about testing the solver fairly rather than about
 * making it pass:
 *
 *  - **Incommensurate frequencies.** A single sinusoid is periodic, so a shift of one
 *    wavelength is indistinguishable from no shift and a solver could "succeed" by locking
 *    onto the wrong period.
 *  - **Energy at low frequencies, falling with scale.** §12's three levels exist to follow
 *    motion wider than the 21 px window, and they can only do it if the coarsest level still
 *    has structure after two box-halvings. A texture dominated by detail finer than the
 *    window is genuinely ambiguous at large displacements — for *any* method — so testing a
 *    14 px motion against one would be testing the fixture, not the solver. Real scenes have
 *    a falling spectrum; so does this.
 */
function texture(x: number, y: number): number {
  const v =
    128 +
    46 * Math.sin(x * 0.021 + 0.4) * Math.cos(y * 0.017 - 0.2) +
    34 * Math.cos(x * 0.043 + y * 0.037) +
    24 * Math.sin(x * 0.083 - y * 0.061 + 1.1) +
    14 * Math.sin(x * 0.17 + y * 0.13);
  return Math.max(0, Math.min(255, v));
}

/** A level-0 plane of `texture` sampled at an offset, then the pyramid above it. */
function pyramidAt(offsetX: number, offsetY: number, levels = LK_LEVELS): ImagePlane[] {
  const base = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      base[y * W + x] = Math.round(texture(x - offsetX, y - offsetY));
    }
  }
  const out: ImagePlane[] = [{ data: base, width: W, height: H }];
  for (let i = 1; i < levels; i++) {
    const src = out[i - 1];
    if (!src) break;
    const w = Math.max(1, src.width >> 1);
    const h = Math.max(1, src.height >> 1);
    const data = new Uint8Array(w * h);
    halveInto(src.data, src.width, src.height, data, w, h);
    out.push({ data, width: w, height: h });
  }
  return out;
}

/** A flat field: no structure, so nothing in it can be localised. */
function flatPyramid(value: number, levels = LK_LEVELS): ImagePlane[] {
  const out: ImagePlane[] = [];
  let w = W;
  let h = H;
  for (let i = 0; i < levels; i++) {
    out.push({ data: new Uint8Array(w * h).fill(value), width: w, height: h });
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

const pointCount = ((): number => {
  let n = 0;
  for (let y = 48; y <= H - 48; y += 24) for (let x = 48; x <= W - 48; x += 24) n++;
  return n;
})();

const GRID_POINTS = (() => {
  const pts: number[] = [];
  for (let y = 48; y <= H - 48; y += 24) {
    for (let x = 48; x <= W - 48; x += 24) pts.push(x, y);
  }
  return new Float64Array(pts);
})();

function solvedDisplacements(
  results: readonly TrackedPoint[],
  points: Float64Array,
): { dx: number; dy: number }[] {
  const out: { dx: number; dy: number }[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || r.status === TrackStatus.OUT_OF_BOUNDS || r.status === TrackStatus.ILL_CONDITIONED) {
      continue;
    }
    out.push({ dx: r.x - (points[i * 2] ?? 0), dy: r.y - (points[i * 2 + 1] ?? 0) });
  }
  return out;
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

describe('§12 parameters', () => {
  it('are the values the spec fixes, not values chosen to fit a budget', () => {
    expect(LK_WINDOW).toBe(21);
    expect(LK_HALF_WINDOW).toBe(10);
    expect(LK_LEVELS).toBe(3);
    expect(LK_MAX_ITERATIONS).toBe(30);
    expect(LK_EPSILON).toBe(0.01);
    expect(DEFAULT_LK_CONFIG.halfWindow).toBe(LK_HALF_WINDOW);
    expect(DEFAULT_LK_CONFIG.maxIterations).toBe(LK_MAX_ITERATIONS);
    expect(DEFAULT_LK_CONFIG.epsilon).toBe(LK_EPSILON);
  });

  it('uses a 21×21 window, so the solver reads 441 samples per iteration', () => {
    expect((2 * LK_HALF_WINDOW + 1) ** 2).toBe(441);
  });
});

describe('§13 bands', () => {
  it('are 1.5 px and 3.0 px, verbatim', () => {
    expect(FB_ACCEPTABLE_PX).toBe(1.5);
    expect(FB_REDUCED_PX).toBe(3.0);
    expect(fbBandFor(0)).toBe(FbBand.ACCEPTABLE);
    expect(fbBandFor(1.5)).toBe(FbBand.ACCEPTABLE);
    expect(fbBandFor(1.500001)).toBe(FbBand.REDUCED);
    expect(fbBandFor(3.0)).toBe(FbBand.REDUCED);
    expect(fbBandFor(3.000001)).toBe(FbBand.REJECT);
  });

  it('treats an unmeasured round trip as a reject, never as a small error', () => {
    // Zero is the *best* value an error term can take, so "not measured" must not map to it
    // (§80). A null band that came back ACCEPTABLE would be a fabricated confidence.
    expect(fbBandFor(null)).toBe(FbBand.REJECT);
    expect(fbBandFor(Number.NaN)).toBe(FbBand.REJECT);
    expect(fbBandFor(Number.POSITIVE_INFINITY)).toBe(FbBand.REJECT);
  });
});

describe('recovering a known displacement', () => {
  const cases: { dx: number; dy: number; tolerance: number }[] = [
    { dx: 0, dy: 0, tolerance: 0.05 },
    { dx: 1, dy: 0, tolerance: 0.1 },
    { dx: 0, dy: -1, tolerance: 0.1 },
    { dx: 2.5, dy: 1.5, tolerance: 0.1 },
    { dx: -3.25, dy: 2.75, tolerance: 0.1 },
    // Beyond the 21 px window at level 0. Only the pyramid can reach this, which is what
    // §12's three levels are for.
    { dx: 14, dy: -11, tolerance: 0.25 },
  ];

  for (const { dx, dy, tolerance } of cases) {
    it(`finds (${dx}, ${dy}) to within ${tolerance} px`, () => {
      const solver = new LucasKanade();
      const a = pyramidAt(0, 0);
      const b = pyramidAt(dx, dy);
      const results = solver.track(a, b, GRID_POINTS);
      const found = solvedDisplacements(results, GRID_POINTS);

      // Not every point: a 14 px motion carries points near the border out of the frame,
      // and a few sit where the texture is locally one-dimensional. Both are honest
      // refusals, and the solver reports them as such rather than as a tracked point.
      expect(found.length).toBeGreaterThanOrEqual(Math.floor(pointCount * 0.6));
      expect(Math.abs(medianOf(found.map((f) => f.dx)) - dx)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(medianOf(found.map((f) => f.dy)) - dy)).toBeLessThanOrEqual(tolerance);
    });
  }

  it('resolves sub-pixel motion, which §13’s 1.5 px band depends on', () => {
    const solver = new LucasKanade();
    const results = solver.track(pyramidAt(0, 0), pyramidAt(0.4, 0), GRID_POINTS);
    const found = solvedDisplacements(results, GRID_POINTS);
    const dx = medianOf(found.map((f) => f.dx));
    // A whole-pixel solver would answer 0 or 1 here. Either would be more than 0.15 px out.
    expect(Math.abs(dx - 0.4)).toBeLessThan(0.15);
  });
});

describe('failing honestly', () => {
  it('reports a flat field as ill-conditioned rather than returning the input position', () => {
    const solver = new LucasKanade();
    const flat = flatPyramid(128);
    const results = solver.track(flat, flat, GRID_POINTS);
    expect(results.length).toBe(GRID_POINTS.length / 2);
    for (const r of results) {
      expect(r.status).toBe(TrackStatus.ILL_CONDITIONED);
      // The dangerous alternative is `x: input.x`. That reads as a perfectly tracked point.
      expect(Number.isNaN(r.x)).toBe(true);
      expect(Number.isNaN(r.y)).toBe(true);
    }
  });

  it('reports a point with no window at level 0 as out of bounds', () => {
    const solver = new LucasKanade();
    const a = pyramidAt(0, 0);
    const b = pyramidAt(1, 0);
    const edge = new Float64Array([2, 2, W - 3, H - 3]);
    const results = solver.track(a, b, edge);
    for (const r of results) {
      expect(r.status).toBe(TrackStatus.OUT_OF_BOUNDS);
      expect(Number.isNaN(r.x)).toBe(true);
    }
  });

  it('never returns a solved point at exactly its input position on a moving pair', () => {
    // The single most dangerous output shape in this phase. If it ever appears here it is a
    // bug, not a coincidence: the texture moves by 3 px and nothing in it is periodic at 3.
    const solver = new LucasKanade();
    const results = solver.track(pyramidAt(0, 0), pyramidAt(3, 2), GRID_POINTS);
    let identical = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || Number.isNaN(r.x)) continue;
      if (r.x === (GRID_POINTS[i * 2] ?? 0) && r.y === (GRID_POINTS[i * 2 + 1] ?? 0)) identical++;
    }
    expect(identical).toBe(0);
  });
});

describe('forward/backward validation (§13)', () => {
  it('scores a correctly tracked point inside the acceptable band', () => {
    const solver = new LucasKanade();
    const validated = trackWithValidation(
      solverFlow(solver), pyramidAt(0, 0), pyramidAt(2, -1), GRID_POINTS,
    );
    const measured = validated.filter((v) => v.error !== null);
    expect(measured.length).toBeGreaterThanOrEqual(Math.floor(pointCount * 0.6));
    const errors = measured.map((v) => v.error ?? 0);
    expect(medianOf(errors)).toBeLessThanOrEqual(FB_ACCEPTABLE_PX);
    expect(validated.filter((v) => v.band === FbBand.ACCEPTABLE).length).toBeGreaterThan(
      measured.length * 0.8,
    );
  });

  it('leaves the error null — not zero — when the round trip could not be measured', () => {
    const solver = new LucasKanade();
    const flat = flatPyramid(90);
    const validated = trackWithValidation(solverFlow(solver), flat, flat, GRID_POINTS);
    for (const v of validated) {
      expect(v.error).toBeNull();
      expect(v.band).toBe(FbBand.REJECT);
    }
  });

  it('scores a tracker that returns its input at a PERFECT 0.0 — which is why FLOW-002 exists', () => {
    // The point of the whole Phase 4 test plan, demonstrated rather than described. A solver
    // that hands back its input short-circuits in *both* directions, so the round trip agrees
    // with itself completely and §13 grades it at its best band — on a scene that
    // demonstrably moved by 5 px. Nothing computed from the tracker's own output can tell.
    const identity = (
      _prev: readonly ImagePlane[],
      _next: readonly ImagePlane[],
      pts: Float64Array,
    ): TrackedPoint[] => {
      const out: TrackedPoint[] = [];
      for (let i = 0; i < pts.length; i += 2) {
        out.push({
          status: TrackStatus.TRACKED,
          x: pts[i] ?? 0,
          y: pts[i + 1] ?? 0,
          iterations: 1,
          residual: 0,
        });
      }
      return out;
    };
    const validated = trackWithValidation(identity, pyramidAt(0, 0), pyramidAt(5, 0), GRID_POINTS);
    expect(validated.length).toBe(pointCount);
    for (const v of validated) {
      expect(v.error).toBe(0);
      expect(v.band).toBe(FbBand.ACCEPTABLE);
    }
    // ...and the displacement it reports is zero, which is the only thing that gives it away
    // and which only an independent measurement of the image can contradict. See
    // sceneShift.test.ts and flowTracker.test.ts.
    const displacements = validated.map((v, i) => v.forward.x - (GRID_POINTS[i * 2] ?? 0));
    expect(medianOf(displacements)).toBe(0);
  });
});
