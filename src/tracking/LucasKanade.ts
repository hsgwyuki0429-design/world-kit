/**
 * Pyramidal Lucas-Kanade optical flow (§12) and forward/backward validation (§13).
 *
 * Pure array arithmetic over grayscale planes: no DOM, no worker, no camera, no clock. The
 * same reasoning as `FeatureDetector` and `pipeline/pyramid` — this is the part of Phase 4
 * whose correctness can be established without a device, so it is unit tested against image
 * pairs whose displacement is known by construction (shift a synthetic texture by a known
 * vector and ask what the solver reports), and the worker that runs it on real frames calls
 * exactly these functions rather than a second copy of the same maths.
 *
 * **§12's parameters are fixed and are not tuned here.** 21×21 window, 3 pyramid levels, 30
 * iterations, epsilon 0.01. They are exported as named constants so a change is a visible
 * edit to a value the spec fixed, not a quiet drift inside a loop. In particular they are
 * *not* reduced to fit §H's 14 ms line: FLOW-006 is advisory precisely so that the cost of
 * the specified configuration can be measured and reported rather than engineered away
 * (§34 — correctness before performance).
 *
 * ## The method
 *
 * For a point p in image A, find d minimising Σ_w (A(p + w) − B(p + d + w))² over the 21×21
 * window w. Linearising B about the current estimate gives the normal equations
 *
 *     G ν = b,    G = Σ [ Ix²  IxIy ]     b = Σ (A − B) [ Ix ]
 *                       [ IxIy  Iy² ]                   [ Iy ]
 *
 * where the gradients are taken on A. Because G depends only on A it is computed **once per
 * point per level** and reused across all 30 iterations; only b is recomputed. That is the
 * difference between a solver that fits in a frame budget and one that does not.
 *
 * Levels are solved coarse to fine, each level's answer doubling into the next level's
 * initial guess, which is what lets a 21×21 window follow motion much larger than 21 px.
 *
 * ## What "failed" means, and why it is not a silent zero
 *
 * A point can fail to track for reasons that are facts about the image, not about the code:
 * its window can leave the frame, or the structure tensor can be singular (a point on a
 * featureless patch, or on an edge — the aperture problem, which is exactly what Shi-Tomasi
 * screens for at detection but which a *tracked* point can drift onto). Those points are
 * returned with `status` saying which, and with no position. They are never returned at
 * their input position: a tracker that hands back its input is indistinguishable from a
 * perfect tracker on a static scene, which is the single failure mode the Phase 4 test plan
 * is built around.
 */

import { TEXTURE_POOR_CEILING } from './featureTypes';

/* -------------------------------------------------------------------------- */
/* §12's parameters                                                            */
/* -------------------------------------------------------------------------- */

/** §12: window = 21×21. */
export const LK_WINDOW = 21;
/** Half-width of that window. 10, so the window is (2·10+1)² = 21×21. */
export const LK_HALF_WINDOW = (LK_WINDOW - 1) / 2;
/** §12: pyramid levels = 3. (§12 also names 4 at "high performance"; 3 is the default.) */
export const LK_LEVELS = 3;
/** §12: maxIterations = 30. */
export const LK_MAX_ITERATIONS = 30;
/** §12: epsilon = 0.01, in pixels of the level being solved. */
export const LK_EPSILON = 0.01;

/* -------------------------------------------------------------------------- */
/* §13's forward/backward bands                                                */
/* -------------------------------------------------------------------------- */

/** §13: FB error ≤ 1.5 px is acceptable. */
export const FB_ACCEPTABLE_PX = 1.5;
/** §13: 1.5–3.0 px is reduced confidence; above 3.0 px is a reject. */
export const FB_REDUCED_PX = 3.0;

export const FbBand = {
  ACCEPTABLE: 'ACCEPTABLE',
  REDUCED: 'REDUCED',
  REJECT: 'REJECT',
} as const;
export type FbBand = (typeof FbBand)[keyof typeof FbBand];

/**
 * §13's three bands, as one function.
 *
 * A round trip that could not be measured at all — the forward or the backward pass failed
 * — is a REJECT rather than a band, because "no measurement" must not read as "small error".
 */
export function fbBandFor(error: number | null): FbBand {
  if (error === null || !Number.isFinite(error)) return FbBand.REJECT;
  if (error <= FB_ACCEPTABLE_PX) return FbBand.ACCEPTABLE;
  if (error <= FB_REDUCED_PX) return FbBand.REDUCED;
  return FbBand.REJECT;
}

/* -------------------------------------------------------------------------- */

export interface ImagePlane {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export const TrackStatus = {
  TRACKED: 'TRACKED',
  /** The window left the image at some level, so there was nothing to match against. */
  OUT_OF_BOUNDS: 'OUT_OF_BOUNDS',
  /** The structure tensor could not be inverted: a flat patch, or an edge (aperture). */
  ILL_CONDITIONED: 'ILL_CONDITIONED',
  /** 30 iterations at the finest level without the update falling under epsilon. */
  NOT_CONVERGED: 'NOT_CONVERGED',
} as const;
export type TrackStatus = (typeof TrackStatus)[keyof typeof TrackStatus];

export interface TrackedPoint {
  readonly status: TrackStatus;
  /** Position in the *next* image, level-0 pixels. `NaN` on any non-TRACKED status. */
  readonly x: number;
  readonly y: number;
  /** Iterations spent at the finest level. Reported so convergence is visible, not assumed. */
  readonly iterations: number;
  /** Mean absolute photometric residual over the window at the solution, 0–255. */
  readonly residual: number;
}

export interface LucasKanadeConfig {
  readonly halfWindow: number;
  readonly maxIterations: number;
  readonly epsilon: number;
  /**
   * The least `λ_min(G) / windowArea` a point may have and still be solvable.
   *
   * **Derived, not chosen (§H.6).** `G/N` is the window mean of the squared gradients, so
   * `sqrt(λ_min(G)/N)` is in intensity levels per pixel — the same units `TEXTURE_POOR_CEILING`
   * is in, which is the value this phase already uses to call an image blank. Requiring the
   * *weaker* of the two directions to reach a quarter of that boundary asks a trackable
   * point to have some structure in both directions without demanding a strong corner, and
   * it reuses a constant fixed before any of this was measured rather than introducing one
   * tuned against a failing test.
   *
   * A quarter rather than the whole: the detector applies `TEXTURE_POOR_CEILING` to a
   * corner at the moment it is *selected*, where both directions are strong by construction.
   * A point that has been tracked for a while sits wherever the image took it, and rejecting
   * everything below the selection threshold would discard points that are still perfectly
   * localisable. The factor is squared into the eigenvalue below because λ has units of
   * gradient squared.
   */
  readonly minEigenvaluePerPixel: number;
}

const MIN_TRACKABLE_GRADIENT = TEXTURE_POOR_CEILING / 4;

export const DEFAULT_LK_CONFIG: LucasKanadeConfig = {
  halfWindow: LK_HALF_WINDOW,
  maxIterations: LK_MAX_ITERATIONS,
  epsilon: LK_EPSILON,
  minEigenvaluePerPixel: MIN_TRACKABLE_GRADIENT * MIN_TRACKABLE_GRADIENT,
};

/**
 * Bilinear sampling, and why it is written out at each call site rather than shared.
 *
 * Sub-pixel accuracy is the whole point: §13's bands are 1.5 and 3.0 px, so a solver
 * quantised to whole pixels would report a round-trip error of up to 2 px on a perfectly
 * tracked point.
 *
 * Both places that need it — building the window from the previous frame, and sampling the
 * next frame each iteration — sample a *whole 21×21 window at one sub-pixel offset*. So the
 * four interpolation weights are constant across the window and are computed once, and the
 * loop then walks consecutive indices. A shared `sample(x, y)` helper cannot express that:
 * it would recompute two `Math.floor`s and the four weights 441 times per iteration, in the
 * innermost loop of the most expensive stage in the frame. Measured on the Phase 4 leg's
 * generated feed: 65 ms per frame with the helper, about a third of that without it, at
 * identical results — the same four pixels combined with the same weights.
 *
 * Callers guarantee the window plus one pixel of margin lies inside the image.
 */

/**
 * A reusable solver.
 *
 * Holds three scratch buffers sized to the window — the previous frame's patch and its two
 * gradients — so a frame of 800 points allocates nothing. The class carries no state about
 * the images or the points between calls: `track` is a pure function of its arguments, and
 * the buffers exist only to keep the allocator out of the inner loop.
 */
export class LucasKanade {
  private readonly config: LucasKanadeConfig;
  private patch: Float32Array;
  private gradX: Float32Array;
  private gradY: Float32Array;

  constructor(config: Partial<LucasKanadeConfig> = {}) {
    this.config = { ...DEFAULT_LK_CONFIG, ...config };
    const n = (2 * this.config.halfWindow + 1) ** 2;
    this.patch = new Float32Array(n);
    this.gradX = new Float32Array(n);
    this.gradY = new Float32Array(n);
  }

  getConfig(): LucasKanadeConfig {
    return this.config;
  }

  /**
   * Track points from one pyramid to the next.
   *
   * `previous` and `next` are level 0 first, coarsest last — the layout `GrayPyramid`
   * already produces. Points are in level-0 pixels and results come back in level-0 pixels.
   *
   * `initialGuess`, when given, is a per-point (dx, dy) in level-0 pixels used to start the
   * search. The backward pass of `trackWithValidation` uses it to start from the negated
   * forward displacement, which is where the answer is when the tracking was correct.
   */
  track(
    previous: readonly ImagePlane[],
    next: readonly ImagePlane[],
    points: Float64Array,
    out: TrackedPoint[] = [],
    initialGuess?: Float64Array,
  ): TrackedPoint[] {
    out.length = 0;
    const levels = Math.min(previous.length, next.length);
    const count = points.length >> 1;
    if (levels === 0) {
      for (let i = 0; i < count; i++) out.push(FAILED_OOB);
      return out;
    }

    for (let p = 0; p < count; p++) {
      const x0 = points[p * 2] ?? 0;
      const y0 = points[p * 2 + 1] ?? 0;
      out.push(
        this.trackOne(
          previous,
          next,
          levels,
          x0,
          y0,
          initialGuess ? (initialGuess[p * 2] ?? 0) : 0,
          initialGuess ? (initialGuess[p * 2 + 1] ?? 0) : 0,
        ),
      );
    }
    return out;
  }

  /**
   * One point, coarse to fine.
   *
   * The guess enters at the coarsest level scaled down by 2^(levels-1), and each level hands
   * its answer to the next by doubling. That is the mechanism §12's three levels buy: the
   * finest level only ever has to explain the residual motion the coarser ones left behind,
   * so a 21×21 window can follow a displacement several times its own width.
   */
  private trackOne(
    previous: readonly ImagePlane[],
    next: readonly ImagePlane[],
    levels: number,
    x0: number,
    y0: number,
    guessX0: number,
    guessY0: number,
  ): TrackedPoint {
    const { halfWindow, maxIterations, epsilon, minEigenvaluePerPixel } = this.config;
    const win = 2 * halfWindow + 1;
    const windowArea = win * win;
    const minEigenvalue = minEigenvaluePerPixel * windowArea;

    const top = levels - 1;
    const scaleToTop = 1 / 2 ** top;
    let gx = guessX0 * scaleToTop;
    let gy = guessY0 * scaleToTop;
    let iterations = 0;
    let residual = 0;
    let converged = false;

    for (let level = top; level >= 0; level--) {
      const prev = previous[level];
      const nxt = next[level];
      if (!prev || !nxt || prev.width !== nxt.width || prev.height !== nxt.height) {
        return FAILED_OOB;
      }
      const scale = 1 / 2 ** level;
      const px = x0 * scale;
      const py = y0 * scale;

      // The window, plus one pixel each side for the central differences.
      const margin = halfWindow + 1;
      if (
        px < margin ||
        py < margin ||
        px >= prev.width - margin - 1 ||
        py >= prev.height - margin - 1
      ) {
        // Too close to the edge at *this* level. Coarser levels are smaller in pixels, so a
        // point near the border runs out of window there first; carry the guess down and let
        // a finer level, where there is room, do the work. At level 0 there is no finer
        // level, so the point genuinely has no window and fails.
        if (level === 0) return FAILED_OOB;
        gx *= 2;
        gy *= 2;
        continue;
      }

      const g = this.buildPatch(prev, px, py, halfWindow);
      const det = g.gxx * g.gyy - g.gxy * g.gxy;
      const trace = g.gxx + g.gyy;
      // λ_min of a 2×2 symmetric matrix. Clamped at 0: a negative value is rounding, not a
      // measurement.
      const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
      const lambdaMin = Math.max(0, (trace - disc) * 0.5);
      if (det <= 0 || lambdaMin < minEigenvalue) {
        // Same treatment as running out of window: a coarse level that has been box-filtered
        // three times can lose the structure a point is being tracked by, without that saying
        // anything about level 0 where the point actually lives. Level 0 failing is the point
        // failing — and it is reported as a failure, never as the input position.
        if (level === 0) return FAILED_ILL;
        gx *= 2;
        gy *= 2;
        continue;
      }

      let dx = gx;
      let dy = gy;
      let levelIterations = 0;
      let levelConverged = false;
      let levelResidual = 0;

      for (let it = 0; it < maxIterations; it++) {
        levelIterations = it + 1;
        const qx = px + dx;
        const qy = py + dy;
        if (
          qx < halfWindow ||
          qy < halfWindow ||
          qx >= nxt.width - halfWindow - 1 ||
          qy >= nxt.height - halfWindow - 1
        ) {
          return FAILED_OOB;
        }

        // The whole window shares one sub-pixel offset, so the four bilinear weights are
        // computed once per iteration rather than once per sample. That is 441 pairs of
        // `Math.floor` and eight arithmetic operations each, removed from the innermost loop
        // of the most expensive stage in the frame — measured at 65 ms per frame before and
        // roughly a third of that after, on the same feed. It changes no result: the same
        // four pixels are combined with the same weights.
        const qix = Math.floor(qx);
        const qiy = Math.floor(qy);
        const fx = qx - qix;
        const fy = qy - qiy;
        const w00 = (1 - fx) * (1 - fy);
        const w01 = fx * (1 - fy);
        const w10 = (1 - fx) * fy;
        const w11 = fx * fy;
        const nd = nxt.data;
        const nw = nxt.width;

        let bx = 0;
        let by = 0;
        let absResidual = 0;
        let k = 0;
        for (let wy = -halfWindow; wy <= halfWindow; wy++) {
          let base = (qiy + wy) * nw + qix - halfWindow;
          for (let wx = -halfWindow; wx <= halfWindow; wx++, base++) {
            const sample =
              (nd[base] ?? 0) * w00 +
              (nd[base + 1] ?? 0) * w01 +
              (nd[base + nw] ?? 0) * w10 +
              (nd[base + nw + 1] ?? 0) * w11;
            const diff = (this.patch[k] ?? 0) - sample;
            bx += diff * (this.gradX[k] ?? 0);
            by += diff * (this.gradY[k] ?? 0);
            absResidual += diff < 0 ? -diff : diff;
            k++;
          }
        }
        levelResidual = absResidual / windowArea;

        const nux = (g.gyy * bx - g.gxy * by) / det;
        const nuy = (g.gxx * by - g.gxy * bx) / det;
        dx += nux;
        dy += nuy;

        if (nux * nux + nuy * nuy < epsilon * epsilon) {
          levelConverged = true;
          break;
        }
      }

      // A step that runs away is not a solution. The window is 21 px wide, so a per-level
      // displacement far beyond it means the linearisation never held; the point is reported
      // as unconverged rather than at whatever coordinate the last division produced.
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return FAILED_ILL;

      gx = dx;
      gy = dy;
      iterations = levelIterations;
      residual = levelResidual;
      converged = levelConverged;
      if (level > 0) {
        gx *= 2;
        gy *= 2;
      }
    }

    const x = x0 + gx;
    const y = y0 + gy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return FAILED_ILL;

    return {
      status: converged ? TrackStatus.TRACKED : TrackStatus.NOT_CONVERGED,
      x,
      y,
      iterations,
      residual: Math.round(residual * 1000) / 1000,
    };
  }

  /**
   * Fill the window scratch buffers from the previous image and accumulate G.
   *
   * Done once per point per level: G is built from the *previous* frame only, so it does not
   * change as the estimate moves. The 30 iterations then cost one pass over the window each
   * rather than three.
   */
  private buildPatch(
    prev: ImagePlane,
    px: number,
    py: number,
    halfWindow: number,
  ): { gxx: number; gyy: number; gxy: number } {
    const { data, width } = prev;
    // One sub-pixel offset for the whole window, as in the iteration loop above. The window
    // is at a fixed position in the previous frame, so this runs once per point per level.
    const pix = Math.floor(px);
    const piy = Math.floor(py);
    const fx = px - pix;
    const fy = py - piy;
    const w00 = (1 - fx) * (1 - fy);
    const w01 = fx * (1 - fy);
    const w10 = (1 - fx) * fy;
    const w11 = fx * fy;
    const at = (i: number): number =>
      (data[i] ?? 0) * w00 +
      (data[i + 1] ?? 0) * w01 +
      (data[i + width] ?? 0) * w10 +
      (data[i + width + 1] ?? 0) * w11;

    let gxx = 0;
    let gyy = 0;
    let gxy = 0;
    let k = 0;
    for (let wy = -halfWindow; wy <= halfWindow; wy++) {
      let base = (piy + wy) * width + pix - halfWindow;
      for (let wx = -halfWindow; wx <= halfWindow; wx++, base++) {
        const v = at(base);
        // Central differences, halved — the same definition the detector's `gx`/`gy` use,
        // so "intensity levels per pixel" means the same thing in both files.
        const ix = (at(base + 1) - at(base - 1)) * 0.5;
        const iy = (at(base + width) - at(base - width)) * 0.5;
        this.patch[k] = v;
        this.gradX[k] = ix;
        this.gradY[k] = iy;
        gxx += ix * ix;
        gyy += iy * iy;
        gxy += ix * iy;
        k++;
      }
    }
    return { gxx, gyy, gxy };
  }
}

const FAILED_OOB: TrackedPoint = {
  status: TrackStatus.OUT_OF_BOUNDS,
  x: Number.NaN,
  y: Number.NaN,
  iterations: 0,
  residual: -1,
};

const FAILED_ILL: TrackedPoint = {
  status: TrackStatus.ILL_CONDITIONED,
  x: Number.NaN,
  y: Number.NaN,
  iterations: 0,
  residual: -1,
};

export interface ValidatedTrack {
  readonly forward: TrackedPoint;
  /** `null` when the forward pass failed, so there was nothing to track back. */
  readonly backward: TrackedPoint | null;
  /**
   * Distance from the round trip's landing point to where it started, in level-0 pixels.
   *
   * `null` when either pass failed. Not `0` — §13 grades this number, and for a graded
   * error term zero is the *best* possible value, so an unmeasured round trip reported as
   * zero would be a fabricated confidence (§80). The same reasoning that keeps
   * `forwardBackwardError` null on a freshly detected feature.
   */
  readonly error: number | null;
  readonly band: FbBand;
}

/**
 * The solver, as a replaceable function.
 *
 * It exists so the unit tests can substitute a tracker that returns its input and drive the
 * whole of Phase 4 with it — the population, the state machine, the statistics and the test
 * suite — and check that FLOW-002 rejects it. A fake that can only be described in prose is
 * a fake nothing has been shown to catch.
 *
 * **Both directions go through it**, which matters: a fake that replaced only the forward
 * pass would be caught by §13, because the real backward pass would travel the true motion
 * and the round trip would miss by that much. That is not the threat. The threat is a solver
 * that short-circuits, and a short-circuiting solver short-circuits both ways — forward and
 * backward agree perfectly and §13 scores it at exactly 0.0.
 */
export type FlowSolve = (
  previous: readonly ImagePlane[],
  next: readonly ImagePlane[],
  points: Float64Array,
  initialGuess?: Float64Array,
) => TrackedPoint[];

/** The real solver, as a `FlowSolve`. This is what production uses. */
export function solverFlow(solver: LucasKanade): FlowSolve {
  return (previous, next, points, initialGuess) =>
    solver.track(previous, next, points, [], initialGuess);
}

/**
 * Track A→B, then B→A, and measure how far the round trip lands from where it started (§13).
 *
 * **What this catches and what it cannot.** It catches a point that latched onto a different
 * piece of structure on the way out: the way back finds the original, and the two disagree.
 * It does *not* catch a tracker that returns its input — that scores a perfect 0.0, because
 * both directions are the same short circuit and they agree completely. Nothing computed
 * from the tracker's own output can catch that, which is why `SceneShift` exists and why
 * FLOW-002 gates on it. `tests/unit/flowTracker.test.ts` demonstrates both halves of that
 * sentence rather than leaving it as a claim.
 *
 * The backward pass starts from the negated forward displacement rather than from zero: if
 * the forward answer is right, the backward answer is its negation, so the search starts at
 * the solution and converges in a couple of iterations. It costs a fraction of the forward
 * pass and it does not bias the result — a wrong forward answer still lands somewhere the
 * backward pass has to travel away from, and the distance is measured from `points`, which
 * the backward pass never sees.
 */
export function trackWithValidation(
  solve: FlowSolve,
  previous: readonly ImagePlane[],
  next: readonly ImagePlane[],
  points: Float64Array,
): ValidatedTrack[] {
  const forward = solve(previous, next, points);
  const count = points.length >> 1;

  // Only the points that survived the forward pass are worth tracking back.
  const backIndex: number[] = [];
  const backPoints: number[] = [];
  const backGuess: number[] = [];
  for (let i = 0; i < count; i++) {
    const f = forward[i];
    if (!f || f.status === TrackStatus.OUT_OF_BOUNDS || f.status === TrackStatus.ILL_CONDITIONED) {
      continue;
    }
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    backIndex.push(i);
    backPoints.push(f.x, f.y);
    backGuess.push((points[i * 2] ?? 0) - f.x, (points[i * 2 + 1] ?? 0) - f.y);
  }

  const backward =
    backPoints.length > 0
      ? solve(next, previous, new Float64Array(backPoints), new Float64Array(backGuess))
      : [];

  const byIndex = new Map<number, TrackedPoint>();
  for (let i = 0; i < backIndex.length; i++) {
    const idx = backIndex[i];
    const b = backward[i];
    if (idx !== undefined && b) byIndex.set(idx, b);
  }

  const out: ValidatedTrack[] = [];
  for (let i = 0; i < count; i++) {
    const f = forward[i] ?? FAILED_OOB;
    const b = byIndex.get(i) ?? null;
    let error: number | null = null;
    if (
      b &&
      b.status !== TrackStatus.OUT_OF_BOUNDS &&
      b.status !== TrackStatus.ILL_CONDITIONED &&
      Number.isFinite(b.x) &&
      Number.isFinite(b.y)
    ) {
      const dx = b.x - (points[i * 2] ?? 0);
      const dy = b.y - (points[i * 2 + 1] ?? 0);
      error = Math.sqrt(dx * dx + dy * dy);
    }
    out.push({ forward: f, backward: b, error, band: fbBandFor(error) });
  }
  return out;
}
