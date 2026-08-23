/**
 * The two-view models, against geometry whose answer is known by construction.
 *
 * Every fixture here is built from a synthetic camera pair: 3D points, two known poses, and a
 * known intrinsics matrix, projected to make the correspondences. The fundamental matrix that
 * relates them can then be written down independently — `F = K'⁻ᵀ [t]ₓ R K⁻¹` — so the test
 * compares the solver against arithmetic rather than against itself.
 *
 * That distinction is the point. A test that checked "the residuals under the matrix we fitted
 * are small" would pass for a matrix fitted to noise, because a model always explains the data
 * it was fitted to. §H.7 is about exactly this class of mistake.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/Rng';
import {
  enforceRank2,
  invert3x3,
  multiply3x3,
  normaliseFrobenius,
  normalisePoints,
  smallestRightSingularVector,
  symmetricEigen,
  transpose3x3,
} from '../../src/geometry/linalg';
import {
  fitFundamental,
  fitHomography,
  makeHomographyError,
  sampsonDistanceSq,
  symmetricTransferErrorSq,
} from '../../src/geometry/twoView';
import type { Correspondence } from '../../src/geometry/twoView';
import { ransac, requiredIterations } from '../../src/geometry/ransac';

/* -------------------------------------------------------------------------- */
/* A synthetic camera pair                                                     */
/* -------------------------------------------------------------------------- */

const K = [600, 0, 320, 0, 600, 240, 0, 0, 1];

/** Rotation about the y axis, in radians. */
function rotY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function apply3(m: readonly number[], v: readonly number[]): number[] {
  return [
    (m[0] ?? 0) * (v[0] ?? 0) + (m[1] ?? 0) * (v[1] ?? 0) + (m[2] ?? 0) * (v[2] ?? 0),
    (m[3] ?? 0) * (v[0] ?? 0) + (m[4] ?? 0) * (v[1] ?? 0) + (m[5] ?? 0) * (v[2] ?? 0),
    (m[6] ?? 0) * (v[0] ?? 0) + (m[7] ?? 0) * (v[1] ?? 0) + (m[8] ?? 0) * (v[2] ?? 0),
  ];
}

function project(p: readonly number[]): { x: number; y: number } | null {
  const z = p[2] ?? 0;
  if (z <= 0.1) return null;
  const u = apply3(K, [(p[0] ?? 0) / z, (p[1] ?? 0) / z, 1]);
  return { x: u[0] ?? 0, y: u[1] ?? 0 };
}

/** Skew-symmetric cross-product matrix. */
function skew(t: readonly number[]): number[] {
  const [x, y, z] = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  return [0, -z, y, z, 0, -x, -y, x, 0];
}

/**
 * The fundamental matrix for a known pose pair, from the closed form.
 *
 * The second camera has rotation `R` and centre `t` in the first camera's frame, so a point `X`
 * there is `R(X − t)` in the second — i.e. `P₁ = K[I|0]` and `P₂ = K[R | −Rt]`.
 *
 * The textbook form is `F = K⁻ᵀ [t']ₓ R' K⁻¹` with `R' = R` and `t' = −Rt`. Using
 * `[Rv]ₓ = R[v]ₓ Rᵀ`, that collapses to `E = [−Rt]ₓ R = −R[t]ₓ`, and the sign is irrelevant
 * because `F` is homogeneous. So `E = R[t]ₓ`.
 *
 * Written out because the first version of this helper used `Rᵀ[t]ₓ` and the test failed while
 * the solver was right — the fitted matrix was already giving every true correspondence a
 * Sampson distance under 0.05 px, which a wrong matrix cannot do. Worth keeping as a note: when
 * a closed form and a solver disagree, the residuals say which one to doubt.
 */
function trueFundamental(r: readonly number[], t: readonly number[]): number[] {
  const kInv = invert3x3(K);
  if (!kInv) throw new Error('K is not invertible');
  const e = multiply3x3(r, skew(t));
  return normaliseFrobenius(multiply3x3(multiply3x3(transpose3x3(kInv), e), kInv)) ?? [];
}

interface Scene {
  readonly correspondences: Correspondence[];
  readonly fundamental: number[];
}

/** A general (non-planar) scene seen from two poses. */
function generalScene(count = 60, seed = 0xbeef): Scene {
  const rng = new Rng(seed);
  const r = rotY(0.06);
  const t = [0.35, 0.02, 0.05];
  const correspondences: Correspondence[] = [];
  let guard = 0;
  while (correspondences.length < count && guard++ < count * 40) {
    const X = [rng.next() * 4 - 2, rng.next() * 3 - 1.5, 3 + rng.next() * 5];
    const a = project(X);
    const b = project(apply3(r, [(X[0] ?? 0) - (t[0] ?? 0), (X[1] ?? 0) - (t[1] ?? 0), (X[2] ?? 0) - (t[2] ?? 0)]));
    if (!a || !b) continue;
    if (a.x < 0 || a.x > 640 || a.y < 0 || a.y > 480) continue;
    if (b.x < 0 || b.x > 640 || b.y < 0 || b.y > 480) continue;
    correspondences.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return { correspondences, fundamental: trueFundamental(r, t) };
}

/** Every point on one plane — the case v3 §16 exists for. */
function planarScene(count = 60, seed = 0xf00d): Correspondence[] {
  const rng = new Rng(seed);
  const r = rotY(0.05);
  const t = [0.3, 0.0, 0.0];
  const out: Correspondence[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    // z = 5 exactly: a wall square to the camera.
    const X = [rng.next() * 4 - 2, rng.next() * 3 - 1.5, 5];
    const a = project(X);
    const b = project(apply3(r, [(X[0] ?? 0) - (t[0] ?? 0), (X[1] ?? 0) - (t[1] ?? 0), (X[2] ?? 0) - (t[2] ?? 0)]));
    if (!a || !b) continue;
    if (a.x < 0 || a.x > 640 || a.y < 0 || a.y > 480) continue;
    if (b.x < 0 || b.x > 640 || b.y < 0 || b.y > 480) continue;
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return out;
}

function medianOf(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

/* ========================================================================== */

describe('linear algebra', () => {
  it('finds the eigenvalues of a matrix whose spectrum is written down', () => {
    // Diagonal: the eigenvalues are the diagonal, ascending.
    const { values } = symmetricEigen([3, 0, 0, 0, -1, 0, 0, 0, 7], 3);
    expect(values[0]).toBeCloseTo(-1, 10);
    expect(values[1]).toBeCloseTo(3, 10);
    expect(values[2]).toBeCloseTo(7, 10);
  });

  it('produces orthonormal eigenvectors on a non-diagonal case', () => {
    const a = [4, 1, 2, 1, 3, 0, 2, 0, 5];
    const { values, vectors } = symmetricEigen(a, 3);
    for (const v of vectors) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    }
    // A v = λ v, checked entry by entry.
    for (let k = 0; k < 3; k++) {
      const v = vectors[k] ?? [];
      const av = apply3(a, v);
      for (let i = 0; i < 3; i++) {
        expect(av[i] ?? 0).toBeCloseTo((values[k] ?? 0) * (v[i] ?? 0), 8);
      }
    }
  });

  it('finds a null vector that is known in advance', () => {
    // Rows orthogonal to (0, 0, 1): the null space is exactly that direction.
    const a = [1, 0, 0, 0, 1, 0, 2, 3, 0];
    const v = smallestRightSingularVector(a, 3, 3);
    expect(Math.abs(v[2] ?? 0)).toBeCloseTo(1, 8);
    expect(Math.abs(v[0] ?? 0)).toBeLessThan(1e-7);
    expect(Math.abs(v[1] ?? 0)).toBeLessThan(1e-7);
  });

  it('makes a matrix rank 2, and leaves an already-rank-2 one alone', () => {
    // det of a rank-2 matrix is 0, and that is checkable without trusting the routine.
    const full = [2, 0, 0, 0, 3, 0, 0, 0, 5];
    const ranked = enforceRank2(full);
    expect(ranked).not.toBeNull();
    const det =
      (ranked?.[0] ?? 0) * ((ranked?.[4] ?? 0) * (ranked?.[8] ?? 0) - (ranked?.[5] ?? 0) * (ranked?.[7] ?? 0)) -
      (ranked?.[1] ?? 0) * ((ranked?.[3] ?? 0) * (ranked?.[8] ?? 0) - (ranked?.[5] ?? 0) * (ranked?.[6] ?? 0)) +
      (ranked?.[2] ?? 0) * ((ranked?.[3] ?? 0) * (ranked?.[7] ?? 0) - (ranked?.[4] ?? 0) * (ranked?.[6] ?? 0));
    expect(Math.abs(det)).toBeLessThan(1e-9);
    // The smallest singular value (2) is what was discarded; the other two survive.
    expect(ranked?.[8]).toBeCloseTo(5, 9);
    expect(ranked?.[4]).toBeCloseTo(3, 9);
    expect(ranked?.[0]).toBeCloseTo(0, 9);
  });

  it('normalises to a centroid at the origin and a mean distance of √2', () => {
    const n = normalisePoints([0, 0, 10, 0, 0, 10, 10, 10]);
    expect(n).not.toBeNull();
    let cx = 0;
    let cy = 0;
    let d = 0;
    for (let i = 0; i < 4; i++) {
      cx += n?.points[i * 2] ?? 0;
      cy += n?.points[i * 2 + 1] ?? 0;
    }
    expect(cx / 4).toBeCloseTo(0, 9);
    expect(cy / 4).toBeCloseTo(0, 9);
    for (let i = 0; i < 4; i++) {
      d += Math.hypot(n?.points[i * 2] ?? 0, n?.points[i * 2 + 1] ?? 0);
    }
    expect(d / 4).toBeCloseTo(Math.SQRT2, 9);
  });

  it('refuses a point set with no scale rather than dividing by zero', () => {
    expect(normalisePoints([5, 5, 5, 5, 5, 5])).toBeNull();
  });
});

describe('the fundamental matrix', () => {
  const scene = generalScene();

  it('gives the closed-form matrix sub-pixel residuals — so the fixture is right', () => {
    // Checked before the comparison below, because if this fails it is the fixture's closed
    // form that is wrong, not the solver.
    const errs = scene.correspondences.map((c) => Math.sqrt(sampsonDistanceSq(scene.fundamental, c)));
    expect(medianOf(errs)).toBeLessThan(0.01);
  });

  it('recovers the matrix the synthetic geometry was built from', () => {
    expect(scene.correspondences.length).toBeGreaterThan(30);
    const f = fitFundamental(scene.correspondences);
    expect(f).not.toBeNull();

    // Both are normalised to unit Frobenius norm and defined up to sign, so compare the
    // entries after aligning the sign. This is the whole claim: the solver found the matrix
    // the geometry has, not merely a matrix that fits the points it was given.
    const truth = scene.fundamental;
    const dot = (f ?? []).reduce((acc, v, i) => acc + v * (truth[i] ?? 0), 0);
    const sign = dot < 0 ? -1 : 1;
    for (let i = 0; i < 9; i++) {
      expect((f?.[i] ?? 0) * sign).toBeCloseTo(truth[i] ?? 0, 5);
    }
  });

  it('is rank 2, which the linear system cannot express on its own', () => {
    const f = fitFundamental(scene.correspondences) ?? [];
    const det =
      (f[0] ?? 0) * ((f[4] ?? 0) * (f[8] ?? 0) - (f[5] ?? 0) * (f[7] ?? 0)) -
      (f[1] ?? 0) * ((f[3] ?? 0) * (f[8] ?? 0) - (f[5] ?? 0) * (f[6] ?? 0)) +
      (f[2] ?? 0) * ((f[3] ?? 0) * (f[7] ?? 0) - (f[4] ?? 0) * (f[6] ?? 0));
    expect(Math.abs(det)).toBeLessThan(1e-8);
  });

  it('gives every true correspondence a sub-pixel Sampson distance', () => {
    const f = fitFundamental(scene.correspondences) ?? [];
    const errs = scene.correspondences.map((c) => Math.sqrt(sampsonDistanceSq(f, c)));
    expect(medianOf(errs)).toBeLessThan(0.05);
    expect(Math.max(...errs)).toBeLessThan(0.5);
  });

  it('gives a corrupted correspondence a large one', () => {
    // The GEO-003 mechanism in miniature: a target displaced by 25 px must not be an inlier
    // at a 1.5 px threshold.
    const f = fitFundamental(scene.correspondences) ?? [];
    const good = scene.correspondences[0];
    expect(good).toBeDefined();
    const corrupted = { ...good!, bx: good!.bx + 25, by: good!.by - 18 };
    expect(Math.sqrt(sampsonDistanceSq(f, corrupted))).toBeGreaterThan(1.5);
  });

  it('refuses fewer than eight correspondences rather than inventing a matrix', () => {
    expect(fitFundamental(scene.correspondences.slice(0, 7))).toBeNull();
  });
});

describe('the homography', () => {
  const planar = planarScene();

  it('maps every point of a planar scene onto its match', () => {
    expect(planar.length).toBeGreaterThan(30);
    const h = fitHomography(planar);
    expect(h).not.toBeNull();
    const err = makeHomographyError(h ?? []);
    expect(err).not.toBeNull();
    const errs = planar.map((c) => Math.sqrt(err!(c)));
    expect(medianOf(errs)).toBeLessThan(0.05);
    expect(Math.max(...errs)).toBeLessThan(0.5);
  });

  it('does not explain a general scene as well as a fundamental matrix does', () => {
    // The asymmetry v3 §16's test rests on: H is the stronger constraint, so on a scene with
    // real depth it fits fewer points. If this were not so, "H matched F" would mean nothing.
    const scene = generalScene();
    const h = fitHomography(scene.correspondences) ?? [];
    const f = fitFundamental(scene.correspondences) ?? [];
    const hErr = makeHomographyError(h);
    const hMedian = medianOf(scene.correspondences.map((c) => Math.sqrt(hErr!(c))));
    const fMedian = medianOf(scene.correspondences.map((c) => Math.sqrt(sampsonDistanceSq(f, c))));
    expect(hMedian).toBeGreaterThan(fMedian * 5);
  });

  it('is symmetric: a model that collapses one image is caught by the other direction', () => {
    const c: Correspondence = { ax: 100, ay: 100, bx: 200, by: 150 };
    // A degenerate "homography" mapping everything to one point. Forward error at this
    // particular point happens to be small; the backward direction is what objects.
    const collapse = [0, 0, 200, 0, 0, 150, 0, 0, 1];
    expect(symmetricTransferErrorSq(collapse, c)).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses fewer than four correspondences', () => {
    expect(fitHomography(planar.slice(0, 3))).toBeNull();
  });
});

describe('RANSAC', () => {
  it('computes the iteration count from the standard formula', () => {
    // 50% inliers, 8-point sample, 99% confidence: log(0.01)/log(1 - 0.5^8) = 1177.
    expect(requiredIterations(0.5, 8, 0.99, 100_000)).toBe(1177);
    // A clean set needs one sample; a hopeless one is capped by the caller.
    expect(requiredIterations(1.0, 8, 0.99, 500)).toBe(1);
    expect(requiredIterations(0, 8, 0.99, 500)).toBe(500);
  });

  it('finds the inlier set when a known fraction is corrupted', () => {
    const scene = generalScene(80, 0x1234);
    const rng = new Rng(7);
    const corrupted = new Set<number>();
    const pts = scene.correspondences.map((c, i) => {
      if (i % 3 !== 0) return c;
      corrupted.add(i);
      return { ...c, bx: c.bx + 30, by: c.by - 22 };
    });

    const result = ransac(
      pts.length,
      { sampleSize: 8, thresholdPx: 1.5, confidence: 0.99, maxIterations: 500 },
      rng,
      (idx) => fitFundamental(pts, idx),
      (m, i) => {
        const c = pts[i];
        return c ? sampsonDistanceSq(m, c) : Number.POSITIVE_INFINITY;
      },
    );
    expect(result).not.toBeNull();

    // Ground truth the estimator never saw.
    const rejected = new Set(result?.outliers ?? []);
    let caught = 0;
    for (const i of corrupted) if (rejected.has(i)) caught++;
    expect(caught / corrupted.size).toBeGreaterThanOrEqual(0.9);

    let wronglyRejected = 0;
    for (const i of rejected) if (!corrupted.has(i)) wronglyRejected++;
    expect(wronglyRejected / (pts.length - corrupted.size)).toBeLessThan(0.3);
  });

  it('is reproducible from its seed', () => {
    const scene = generalScene(50, 0x99);
    const run = (): number[] =>
      ransac(
        scene.correspondences.length,
        { sampleSize: 8, thresholdPx: 1.5, confidence: 0.99, maxIterations: 200 },
        new Rng(42),
        (idx) => fitFundamental(scene.correspondences, idx),
        (m, i) => {
          const c = scene.correspondences[i];
          return c ? sampsonDistanceSq(m, c) : Number.POSITIVE_INFINITY;
        },
      )?.inliers ?? [];
    expect(run()).toEqual(run());
  });

  it('reports when the cap bound rather than the confidence target', () => {
    // Pure noise: no model explains it, so the adaptive rule never converges.
    const rng = new Rng(3);
    const pts: Correspondence[] = Array.from({ length: 40 }, () => ({
      ax: rng.next() * 640,
      ay: rng.next() * 480,
      bx: rng.next() * 640,
      by: rng.next() * 480,
    }));
    const result = ransac(
      pts.length,
      { sampleSize: 8, thresholdPx: 1.5, confidence: 0.99, maxIterations: 40 },
      new Rng(11),
      (idx) => fitFundamental(pts, idx),
      (m, i) => {
        const c = pts[i];
        return c ? sampsonDistanceSq(m, c) : Number.POSITIVE_INFINITY;
      },
    );
    expect(result?.iterations).toBe(40);
    expect(result?.terminatedEarly).toBe(false);
  });

  it('refuses a population smaller than its sample', () => {
    expect(
      ransac(5, { sampleSize: 8, thresholdPx: 1.5, confidence: 0.99, maxIterations: 10 },
        new Rng(1), () => null, () => 0),
    ).toBeNull();
  });
});
