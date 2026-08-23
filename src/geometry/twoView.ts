/**
 * The two geometric models v3 §14 and §16 ask for, and the distances that judge them.
 *
 * A correspondence set that survived §13's forward/backward check is not yet a set consistent
 * with **one rigid camera motion**. A point tracked perfectly onto a moving object, or onto a
 * repeating texture one period over, passes §13 and is wrong for pose. What separates them is a
 * geometric model that all the good correspondences agree on and the bad ones do not.
 *
 * Two models, both fitted on every judged frame:
 *
 *  - **The fundamental matrix `F`** — the general two-view relation. `x'ᵀ F x = 0` says the
 *    match lies on its epipolar line, which is a one-dimensional constraint: it leaves a point
 *    free to slide along that line.
 *  - **The homography `H`** — `x' = H x`, a two-dimensional constraint, exact when every point
 *    lies on one plane (or the camera only rotated).
 *
 * **Why both, always.** `F` is the weaker constraint and will normally admit at least as many
 * points as `H`. So `H` matching or beating `F` is strong evidence that the scene is planar,
 * and v3 §16 requires that case to be marked `PLANAR SCENE` with translation confidence
 * lowered. It is not an edge case: a room scan is mostly walls, floors and table tops, and an
 * Essential matrix decomposed from a planar scene is degenerate and produces a pose that looks
 * entirely reasonable. Skipping the homography as an optimisation would hide exactly the
 * failure §16 exists to prevent.
 *
 * No camera intrinsics appear here. `K` is §15's and belongs to Phase 6; `F` and `H` are
 * measured in pixels and need none, which is what lets this phase run before intrinsics exist.
 *
 * Pure array arithmetic: no DOM, no worker, no camera, no clock.
 */

import {
  applyHomogeneous,
  enforceRank2,
  invert3x3,
  multiply3x3,
  normaliseFrobenius,
  normalisePoints,
  smallestRightSingularVector,
  transpose3x3,
} from './linalg';

/** A matched pair, both positions in level-0 pixels. */
export interface Correspondence {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export const GeometricModel = {
  FUNDAMENTAL: 'FUNDAMENTAL',
  HOMOGRAPHY: 'HOMOGRAPHY',
} as const;
export type GeometricModel = (typeof GeometricModel)[keyof typeof GeometricModel];

/** Minimum correspondences each model needs. The eight-point algorithm is used for `F`. */
export const FUNDAMENTAL_SAMPLE = 8;
export const HOMOGRAPHY_SAMPLE = 4;

/* -------------------------------------------------------------------------- */
/* Fundamental matrix                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalised eight-point fundamental matrix.
 *
 * Three steps, and the second and third are the ones that are usually skipped and must not be:
 *
 *  1. Hartley-normalise both point sets (`normalisePoints`) — without it `AᵀA` has a condition
 *     number around 10¹² and its smallest eigenvector is noise.
 *  2. Solve `A f = 0` for the unit `f`.
 *  3. **Force the result to rank 2.** The linear system cannot express that constraint, so its
 *     answer has three non-zero singular values, and a rank-3 "fundamental matrix" generates
 *     epipolar lines that do not meet at an epipole. The residuals it reports are then of a
 *     geometry that cannot exist.
 *
 * Returns `null` where no matrix can be determined — fewer than eight points, or a degenerate
 * configuration such as every point at one place.
 */
export function fitFundamental(
  points: readonly Correspondence[],
  indices?: readonly number[],
): number[] | null {
  const idx = indices ?? points.map((_, i) => i);
  if (idx.length < FUNDAMENTAL_SAMPLE) return null;

  const aPts: number[] = [];
  const bPts: number[] = [];
  for (const i of idx) {
    const c = points[i];
    if (!c) return null;
    aPts.push(c.ax, c.ay);
    bPts.push(c.bx, c.by);
  }
  const na = normalisePoints(aPts);
  const nb = normalisePoints(bPts);
  if (!na || !nb) return null;

  const n = idx.length;
  const a = new Array<number>(n * 9);
  for (let i = 0; i < n; i++) {
    const x = na.points[i * 2] ?? 0;
    const y = na.points[i * 2 + 1] ?? 0;
    const xp = nb.points[i * 2] ?? 0;
    const yp = nb.points[i * 2 + 1] ?? 0;
    const r = i * 9;
    a[r] = xp * x;
    a[r + 1] = xp * y;
    a[r + 2] = xp;
    a[r + 3] = yp * x;
    a[r + 4] = yp * y;
    a[r + 5] = yp;
    a[r + 6] = x;
    a[r + 7] = y;
    a[r + 8] = 1;
  }

  const f = smallestRightSingularVector(a, n, 9);
  const ranked = enforceRank2(f);
  if (!ranked) return null;

  // Undo the normalisation: F = T'ᵀ · F_norm · T.
  const denormalised = multiply3x3(multiply3x3(transpose3x3(nb.transform), ranked), na.transform);
  return normaliseFrobenius(denormalised);
}

/**
 * Sampson distance: the first-order approximation to the geometric reprojection error.
 *
 * The algebraic residual `x'ᵀ F x` is not a distance — it scales with the coordinates and says
 * nothing in pixels, so it cannot be compared against a threshold derived from §13's 1.5 px
 * band. Sampson divides it by the norm of its own gradient, which turns it into a first-order
 * estimate of the distance to the true epipolar geometry, in pixels.
 *
 * Returned squared, because every caller compares it against a squared threshold.
 */
export function sampsonDistanceSq(f: readonly number[], c: Correspondence): number {
  const { ax, ay, bx, by } = c;
  // F x  — the epipolar line in the second image.
  const fx0 = (f[0] ?? 0) * ax + (f[1] ?? 0) * ay + (f[2] ?? 0);
  const fx1 = (f[3] ?? 0) * ax + (f[4] ?? 0) * ay + (f[5] ?? 0);
  const fx2 = (f[6] ?? 0) * ax + (f[7] ?? 0) * ay + (f[8] ?? 0);
  // Fᵀ x' — the epipolar line in the first.
  const ftx0 = (f[0] ?? 0) * bx + (f[3] ?? 0) * by + (f[6] ?? 0);
  const ftx1 = (f[1] ?? 0) * bx + (f[4] ?? 0) * by + (f[7] ?? 0);

  const residual = bx * fx0 + by * fx1 + fx2;
  const denom = fx0 * fx0 + fx1 * fx1 + ftx0 * ftx0 + ftx1 * ftx1;
  if (!Number.isFinite(denom) || denom < 1e-18) return Number.POSITIVE_INFINITY;
  return (residual * residual) / denom;
}

/* -------------------------------------------------------------------------- */
/* Homography                                                                  */
/* -------------------------------------------------------------------------- */

/** Normalised four-point DLT homography. Same normalisation argument as `fitFundamental`. */
export function fitHomography(
  points: readonly Correspondence[],
  indices?: readonly number[],
): number[] | null {
  const idx = indices ?? points.map((_, i) => i);
  if (idx.length < HOMOGRAPHY_SAMPLE) return null;

  const aPts: number[] = [];
  const bPts: number[] = [];
  for (const i of idx) {
    const c = points[i];
    if (!c) return null;
    aPts.push(c.ax, c.ay);
    bPts.push(c.bx, c.by);
  }
  const na = normalisePoints(aPts);
  const nb = normalisePoints(bPts);
  if (!na || !nb) return null;

  const n = idx.length;
  const a = new Array<number>(n * 2 * 9).fill(0);
  for (let i = 0; i < n; i++) {
    const x = na.points[i * 2] ?? 0;
    const y = na.points[i * 2 + 1] ?? 0;
    const xp = nb.points[i * 2] ?? 0;
    const yp = nb.points[i * 2 + 1] ?? 0;
    const r0 = i * 18;
    a[r0 + 3] = -x;
    a[r0 + 4] = -y;
    a[r0 + 5] = -1;
    a[r0 + 6] = yp * x;
    a[r0 + 7] = yp * y;
    a[r0 + 8] = yp;
    const r1 = r0 + 9;
    a[r1] = x;
    a[r1 + 1] = y;
    a[r1 + 2] = 1;
    a[r1 + 6] = -xp * x;
    a[r1 + 7] = -xp * y;
    a[r1 + 8] = -xp;
  }

  const h = smallestRightSingularVector(a, n * 2, 9);
  const invB = invert3x3(nb.transform);
  if (!invB) return null;
  // H = T'⁻¹ · H_norm · T.
  return normaliseFrobenius(multiply3x3(multiply3x3(invB, h), na.transform));
}

/**
 * Symmetric transfer error: the distance from each point to where the *other* one maps.
 *
 * Both directions, because a homography that collapses the second image onto a point has a
 * tiny forward error and an enormous backward one. Taking only the forward transfer would let
 * that model through. Returned squared, and summed over the two directions so it is comparable
 * to a squared pixel threshold on the same scale as the Sampson distance.
 */
export function symmetricTransferErrorSq(h: readonly number[], c: Correspondence): number {
  const forward = applyHomogeneous(h, c.ax, c.ay);
  if (!forward) return Number.POSITIVE_INFINITY;
  const hInv = invert3x3(h);
  if (!hInv) return Number.POSITIVE_INFINITY;
  const backward = applyHomogeneous(hInv, c.bx, c.by);
  if (!backward) return Number.POSITIVE_INFINITY;

  const df = (forward.x - c.bx) ** 2 + (forward.y - c.by) ** 2;
  const db = (backward.x - c.ax) ** 2 + (backward.y - c.ay) ** 2;
  // Halved, so a model that is right in both directions scores the same as a one-directional
  // error of the same size, and the threshold means the same thing for both models.
  return (df + db) / 2;
}

/**
 * The same, with the inverse computed once for a whole set.
 *
 * `symmetricTransferErrorSq` inverts `H` on every call, which is fine for a handful of points
 * and is 3× the cost of the error itself inside a RANSAC loop over hundreds.
 */
export function makeHomographyError(h: readonly number[]): ((c: Correspondence) => number) | null {
  const hInv = invert3x3(h);
  if (!hInv) return null;
  return (c: Correspondence): number => {
    const forward = applyHomogeneous(h, c.ax, c.ay);
    const backward = applyHomogeneous(hInv, c.bx, c.by);
    if (!forward || !backward) return Number.POSITIVE_INFINITY;
    const df = (forward.x - c.bx) ** 2 + (forward.y - c.by) ** 2;
    const db = (backward.x - c.ax) ** 2 + (backward.y - c.ay) ** 2;
    return (df + db) / 2;
  };
}
