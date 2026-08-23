/**
 * Relative pose from a verified two-view geometry (Phase 6 — v3 §15, §16, §67).
 *
 * One correspondence set and one model in, one pose out. Nothing here knows about cameras,
 * workers, frames or time, and — as the architecture audit enforces for this whole layer — it
 * cannot import from `tracking`, so it cannot see the population it is being scored against.
 *
 * ## What it produces, and what it refuses to
 *
 *   - **A rotation**, always, when a model was verified. This is the first quantity in the
 *     project with a physical unit that a second instrument can also measure, which is what
 *     makes Phase 6 checkable at all (POSE-002, POSE-005).
 *   - **A translation direction**, only when the data contains one. Unit length. Never a
 *     distance: v3 §15 and v4 §18 both forbid assuming `1 unit = 1 metre`, so the scale is
 *     `LOCAL_UNITS` and the vector is normalised by construction.
 *   - **Nothing at all** where the configuration cannot support a pose. Two of those are
 *     ordinary in a room and both give a wrong answer that looks right:
 *     a **planar scene**, where an Essential matrix is degenerate — v3 §16, handled by
 *     decomposing the homography instead — and a **pure rotation**, where the image motion is
 *     large and well conditioned and there is no translation to find.
 *
 * ## How the pure-rotation case is decided
 *
 * Not from a formula about the decomposition, but from the correspondences: `R` alone predicts
 * `π(K R K⁻¹ ã)` for every point, and the median distance from that prediction to the observed
 * `b` **is** the parallax the translation is responsible for, in pixels. Under
 * `PURE_ROTATION_PARALLAX_PX` there is nothing left for a translation to explain, and the
 * honest output is `ROTATION_ONLY` rather than a unit vector pointing somewhere.
 */

import {
  apply3x3,
  determinant3x3,
  invert3x3,
  multiply3x3,
  norm3,
  normalise3,
  smallestRightSingularVector,
  svd3x3,
  transpose3x3,
} from './linalg';
import { GeometricModel } from './twoView';
import type { Correspondence } from './twoView';
import { inverseMatrixOf, matrixOf, projectRay, toCameraRay } from './intrinsics';
import type { Intrinsics } from './intrinsics';
import { RANSAC_THRESHOLD_PX } from './verify';
import { rotationAngleDeg, toAxisAngle, toQuaternion } from './rotation';
import type { Quaternion } from './rotation';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase6/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/**
 * Below this much rotation-only residual there is no translation to recover.
 *
 * `= RANSAC_THRESHOLD_PX`. §13's acceptable forward/backward band is what this project already
 * has for the positional uncertainty of a correspondence; a parallax smaller than that cannot
 * be told from the noise, and a direction fitted to it is noise with a unit length. §H.6: prefer
 * a constant the plan has already fixed for another purpose.
 */
export const PURE_ROTATION_PARALLAX_PX = RANSAC_THRESHOLD_PX;

/**
 * How far ahead of the runner-up the winning candidate must be.
 *
 * Decomposing `E` gives four candidates — `(R₁,t)`, `(R₁,−t)`, `(R₂,t)`, `(R₂,−t)` — of which
 * exactly one places the scene in front of both cameras. The textbook structure is that the
 * correct one takes nearly all the points, two take roughly half, and one takes almost none, so
 * `1.5` separates "nearly all" from "roughly half" without demanding the clean-data ideal.
 * Below it the decomposition is **reported ambiguous**, not settled by taking the maximum.
 */
export const CHEIRALITY_MARGIN = 1.5;

/** ...and the winner must place at least this fraction of the inliers in front of both. */
export const MIN_CHEIRALITY_FRACTION = 0.7;

/** v3 §33's GOOD condition, reused rather than re-derived. */
export const MAX_REPROJECTION_PX = 2.0;

export const PoseState = {
  /** Nothing was recoverable, and the reason says which of the ways it was not. */
  NO_POSE: 'NO_POSE',
  /** A rotation, and a measured statement that there is no translation in the data. */
  ROTATION_ONLY: 'ROTATION_ONLY',
  POSE: 'POSE',
} as const;
export type PoseState = (typeof PoseState)[keyof typeof PoseState];

/** v4 §18, as a value that has to be removed deliberately rather than forgotten. */
export const SCALE_LOCAL_UNITS = 'LOCAL_UNITS';

export interface CheiralityCount {
  /** Index into the candidate list the decomposition produced. */
  readonly candidate: number;
  /** Correspondences triangulating to positive depth in **both** views. */
  readonly inFront: number;
  readonly rotationDeg: number;
}

export interface PoseResult {
  readonly state: PoseState;
  readonly reason: string;
  readonly source: GeometricModel | null;
  /** Row-major 3×3, or `null` on `NO_POSE`. */
  readonly rotation: readonly number[] | null;
  readonly rotationDeg: number;
  readonly axis: readonly number[] | null;
  readonly quaternion: Quaternion | null;
  /** Unit direction, or `null` when the data contains no translation. Never a distance. */
  readonly translation: readonly number[] | null;
  /** v4 §18. `LOCAL_UNITS`, always, in this phase. */
  readonly scale: string;
  /** The plane's unit normal, when the pose came from a homography. */
  readonly planeNormal: readonly number[] | null;
  /** Every candidate's cheirality count, so the choice is auditable rather than asserted. */
  readonly cheirality: readonly CheiralityCount[];
  readonly chosen: number;
  /** The margin did not separate the candidates; the pose is reported, the ambiguity with it. */
  readonly ambiguous: boolean;
  readonly pointsInFront: number;
  readonly correspondences: number;
  /** RMS over the triangulated inliers, or `-1` where nothing was triangulated. */
  readonly reprojectionErrorPx: number;
  /** What `R` alone leaves unexplained — the parallax a translation would account for. */
  readonly rotationOnlyResidualPx: number;
  /** Carried from Phase 5, and the reason the homography path was taken. */
  readonly planar: boolean;
}

const NO_POSE = (
  reason: string,
  correspondences: number,
  planar: boolean,
  source: GeometricModel | null = null,
): PoseResult => ({
  state: PoseState.NO_POSE,
  reason,
  source,
  rotation: null,
  rotationDeg: -1,
  axis: null,
  quaternion: null,
  translation: null,
  scale: SCALE_LOCAL_UNITS,
  planeNormal: null,
  cheirality: [],
  chosen: -1,
  ambiguous: false,
  pointsInFront: 0,
  correspondences,
  reprojectionErrorPx: -1,
  rotationOnlyResidualPx: -1,
  planar,
});

/* -------------------------------------------------------------------------- */
/* Essential matrix                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `E = Kᵀ F K`, with the singular structure a real Essential matrix has.
 *
 * An `E` recovered from a fitted `F` will not have singular values `(σ, σ, 0)` exactly, and the
 * decomposition below assumes it does. Forcing `diag(1, 1, 0)` is the standard projection onto
 * the Essential manifold and it is the same idea as `enforceRank2` in `twoView.ts`: a matrix
 * that has to have a structure is given it, rather than the structure being assumed of a matrix
 * that does not.
 */
export function essentialFromFundamental(f: readonly number[], k: Intrinsics): number[] | null {
  const km = matrixOf(k);
  const e = multiply3x3(multiply3x3(transpose3x3(km), f), km);
  const svd = svd3x3(e);
  if (!svd) return null;
  const { u, v } = svd;
  const d = [1, 0, 0, 0, 1, 0, 0, 0, 0];
  return multiply3x3(multiply3x3(u, d), transpose3x3(v));
}

const W_MATRIX = [0, -1, 0, 1, 0, 0, 0, 0, 1];

export interface PoseCandidate {
  readonly rotation: number[];
  readonly translation: number[];
  readonly planeNormal: number[] | null;
}

/**
 * The four `(R, t)` candidates of an Essential matrix (Hartley & Zisserman 9.6.2).
 *
 * `E = U diag(1,1,0) Vᵀ` gives `R ∈ {U W Vᵀ, U Wᵀ Vᵀ}` and `t = ±u₃`.
 *
 * **`U` and `V` must each be a rotation, and making them one is not optional.** An Essential
 * matrix has a *repeated* singular value — `σ₁ = σ₂ = ‖t‖` by construction — so the first two
 * columns of `U` and `V` span a two-dimensional eigenspace in which no particular basis is
 * preferred. Any common rotation of that plane leaves `U W Vᵀ` alone, because `W` is itself a
 * rotation of the same plane and two-dimensional rotations commute; a common *reflection* does
 * not, and turns `R` into a different rotation entirely. The eigensolver has no reason to
 * prefer one over the other and will return whichever falls out of the arithmetic.
 *
 * This cost a test: `tests/unit/pose.test.ts` recovered one scene's rotation exactly and the
 * same scene turned by 4° with a 60° error, from the same code, because the second decomposition
 * happened to come back reflected. Negating whichever of `U`, `V` has a negative determinant
 * fixes it, and is free: it flips the sign of `E`, which is defined only up to sign, and the
 * sign of `t`, which is already enumerated both ways below.
 */
export function decomposeEssential(e: readonly number[]): PoseCandidate[] {
  const svd = svd3x3(e);
  if (!svd) return [];
  const u = determinant3x3(svd.u) < 0 ? svd.u.map((x) => -x) : svd.u;
  const v = determinant3x3(svd.v) < 0 ? svd.v.map((x) => -x) : svd.v;
  const vt = transpose3x3(v);
  // Both products are now rotations by construction; the guard is a belt-and-braces check that
  // costs one determinant and would catch a future change to the line above.
  const fix = (r: number[]): number[] => (determinant3x3(r) < 0 ? r.map((x) => -x) : r);
  const ra = fix(multiply3x3(multiply3x3(u, W_MATRIX), vt));
  const rb = fix(multiply3x3(multiply3x3(u, transpose3x3(W_MATRIX)), vt));
  const t = normalise3([u[2] ?? 0, u[5] ?? 0, u[8] ?? 0]);
  if (!t) return [];
  const tn = t.map((x) => -x);
  return [
    { rotation: ra, translation: t, planeNormal: null },
    { rotation: ra, translation: tn, planeNormal: null },
    { rotation: rb, translation: t, planeNormal: null },
    { rotation: rb, translation: tn, planeNormal: null },
  ];
}

/* -------------------------------------------------------------------------- */
/* Homography — v3 §16's half                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The candidates of a homography (Faugeras & Lustman), for the planar case v3 §16 names.
 *
 * `G = K⁻¹ H K ∝ R + t nᵀ/d`. Normalising by the middle singular value fixes the scale, and the
 * decomposition then enumerates eight `(R, t/d, n)` solutions, of which the ones with the plane
 * behind the camera are dropped here and the rest are settled by cheirality in `recoverPose`.
 *
 * **Two things are deliberately not hidden.** A homography decomposition has a genuine two-fold
 * ambiguity that two views cannot resolve — it needs a third — so when cheirality leaves two
 * candidates equally supported the result says `ambiguous` rather than picking one. And the
 * translation here is `t/d`, in units of the plane's distance: it is a *direction* once
 * normalised and never a length, which is the same rule the Essential path follows for the same
 * reason.
 */
export function decomposeHomography(h: readonly number[], k: Intrinsics): PoseCandidate[] {
  const g = multiply3x3(multiply3x3(inverseMatrixOf(k), h), matrixOf(k));
  const svd = svd3x3(g);
  if (!svd) return [];
  const d2 = svd.s[1] ?? 0;
  if (!(d2 > 1e-12)) return [];
  const gn = g.map((x) => x / d2);
  const sv = svd3x3(gn);
  if (!sv) return [];
  const { u, v, s } = sv;
  const d1 = s[0] ?? 0;
  const d3 = s[2] ?? 0;
  const sign = determinant3x3(u) * determinant3x3(v);

  const span = d1 * d1 - d3 * d3;
  const out: PoseCandidate[] = [];
  // A conjugate rotation: all three singular values equal, so there is no plane-induced part at
  // all and `n` is undetermined. `R = U Vᵀ` is the whole answer; the caller decides what to do
  // with a translation that does not exist, from the residual rather than from this threshold.
  if (span <= 1e-9) {
    const r = multiply3x3(u, transpose3x3(v));
    const fixed = determinant3x3(r) < 0 ? r.map((x) => -x) : r;
    return [{ rotation: fixed, translation: [0, 0, 0], planeNormal: null }];
  }

  const x1m = Math.sqrt(Math.max(0, (d1 * d1 - 1) / span));
  const x3m = Math.sqrt(Math.max(0, (1 - d3 * d3) / span));
  const signs: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  for (const [e1, e3] of signs) {
    const x1 = e1 * x1m;
    const x3 = e3 * x3m;
    // d' = +1: the plane is in front and the two views see the same side of it.
    {
      const sinT = ((d1 - d3) * x1 * x3);
      const cosT = d1 * x3 * x3 + d3 * x1 * x1;
      const rp = [cosT, 0, -sinT, 0, 1, 0, sinT, 0, cosT];
      const tp = [(d1 - d3) * x1, 0, -(d1 - d3) * x3];
      out.push(assemble(u, v, rp, tp, [x1, 0, x3], sign));
    }
    // d' = -1: the reflected family. Kept because dropping it silently would make the
    // enumeration look complete while missing half of it; cheirality removes what cannot be.
    {
      const sinP = ((d1 + d3) * x1 * x3);
      const cosP = d3 * x1 * x1 - d1 * x3 * x3;
      const rp = [cosP, 0, sinP, 0, -1, 0, sinP, 0, -cosP];
      const tp = [(d1 + d3) * x1, 0, (d1 + d3) * x3];
      out.push(assemble(u, v, rp, tp, [x1, 0, x3], sign));
    }
  }
  // The plane must be in front of the first camera to have been seen by it.
  return out.filter((c) => (c.planeNormal?.[2] ?? 0) > 0);
}

function assemble(
  u: readonly number[],
  v: readonly number[],
  rp: readonly number[],
  tp: readonly number[],
  np: readonly number[],
  sign: number,
): PoseCandidate {
  const vt = transpose3x3(v);
  let r = multiply3x3(multiply3x3(u, rp), vt);
  if (sign < 0) r = r.map((x) => -x);
  if (determinant3x3(r) < 0) r = r.map((x) => -x);
  const t = apply3x3(u, tp);
  let n = apply3x3(v, np);
  // `(t, n)` and `(-t, -n)` describe the same plane seen from the same place. Fixing the sign
  // of `n_z` picks the one where the plane is in front, so the filter above means what it says.
  if ((n[2] ?? 0) < 0) {
    n = n.map((x) => -x);
  }
  return { rotation: r, translation: t, planeNormal: n };
}

/* -------------------------------------------------------------------------- */
/* Triangulation and cheirality                                                */
/* -------------------------------------------------------------------------- */

/**
 * One point from two views, by the linear DLT (Hartley & Zisserman 12.2).
 *
 * The rows are the two cross-product constraints per view; the null vector of the resulting
 * `4×4` is the homogeneous point. Returned in the **first camera's** frame, in whatever units
 * `t` carried — which is why nothing outside this file is allowed to read a distance off it.
 */
export function triangulate(
  a: { x: number; y: number },
  b: { x: number; y: number },
  k: Intrinsics,
  rotation: readonly number[],
  translation: readonly number[],
): number[] | null {
  const ra = toCameraRay(k, a.x, a.y);
  const rb = toCameraRay(k, b.x, b.y);
  // P1 = [I | 0], P2 = [R | t], in normalised camera coordinates.
  const p1 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const p2 = [
    rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, translation[0] ?? 0,
    rotation[3] ?? 0, rotation[4] ?? 0, rotation[5] ?? 0, translation[1] ?? 0,
    rotation[6] ?? 0, rotation[7] ?? 0, rotation[8] ?? 0, translation[2] ?? 0,
  ];
  const row = (p: readonly number[], r: number, s: number, w: number): number[] =>
    [0, 1, 2, 3].map((c) => w * (p[8 + c] ?? 0) - (p[r * 4 + c] ?? 0) * s);
  const m = [
    ...row(p1, 0, 1, ra[0] ?? 0),
    ...row(p1, 1, 1, ra[1] ?? 0),
    ...row(p2, 0, 1, rb[0] ?? 0),
    ...row(p2, 1, 1, rb[1] ?? 0),
  ];
  const x = smallestRightSingularVector(m, 4, 4);
  const w = x[3] ?? 0;
  if (!Number.isFinite(w) || Math.abs(w) <= 1e-12) return null;
  return [(x[0] ?? 0) / w, (x[1] ?? 0) / w, (x[2] ?? 0) / w];
}

/** Depth of `X` in both views. A point behind either camera was not seen by it. */
function depths(
  x: readonly number[],
  rotation: readonly number[],
  translation: readonly number[],
): { z1: number; z2: number } {
  const z1 = x[2] ?? 0;
  const xc = apply3x3(rotation, x);
  const z2 = (xc[2] ?? 0) + (translation[2] ?? 0);
  return { z1, z2 };
}

/* -------------------------------------------------------------------------- */
/* The whole recovery                                                          */
/* -------------------------------------------------------------------------- */

export interface PoseInput {
  readonly points: readonly Correspondence[];
  /** Which of `points` Phase 5 verified. The pose is recovered from these and no others. */
  readonly inliers: readonly number[];
  readonly model: GeometricModel;
  readonly matrix: readonly number[];
  readonly planar: boolean;
  readonly intrinsics: Intrinsics;
}

/**
 * Recover the pose, choose among the candidates by cheirality, and say what could not be found.
 *
 * The order matters and is the plan's: decompose according to **Phase 5's** selected model
 * (v3 §16 — a planar scene goes to the homography, because an Essential matrix decomposed from
 * a plane is degenerate and yields a pose that looks entirely reasonable), then count how many
 * points each candidate places in front of both cameras, then decide whether the winner is
 * separated enough to be a choice rather than a coin toss, and only then ask whether there was
 * a translation in the data at all.
 */
export function recoverPose(input: PoseInput): PoseResult {
  const { points, inliers, model, matrix, planar, intrinsics } = input;
  const used = inliers.map((i) => points[i]).filter((c): c is Correspondence => c !== undefined);
  const n = used.length;
  if (n < 5) {
    return NO_POSE(`${n} verified correspondences, too few for any two-view pose`, n, planar);
  }

  const candidates =
    model === GeometricModel.HOMOGRAPHY
      ? decomposeHomography(matrix, intrinsics)
      : (() => {
          const e = essentialFromFundamental(matrix, intrinsics);
          return e ? decomposeEssential(e) : [];
        })();
  if (candidates.length === 0) {
    return NO_POSE(`the ${model.toLowerCase()} did not decompose into any pose`, n, planar, model);
  }

  // **Before cheirality, not after.** Triangulation needs a baseline, so on a camera that only
  // turned every candidate scores zero points in front and the frame would be reported as
  // `NO_POSE` — a pose refused for having no *translation*, which is the one case where a
  // rotation is perfectly recoverable. "Is the data explained by rotation alone?" is answerable
  // without knowing which sign of `t` puts the scene in front, so it is asked first.
  const residuals = candidates.map((c) => rotationOnlyResidual(used, c.rotation, intrinsics));
  let bestRotationOnly = -1;
  for (let i = 0; i < residuals.length; i++) {
    const r = residuals[i] ?? -1;
    if (r < 0) continue;
    if (bestRotationOnly < 0 || r < (residuals[bestRotationOnly] ?? Infinity)) bestRotationOnly = i;
  }
  const rotationOnlyPx = bestRotationOnly >= 0 ? (residuals[bestRotationOnly] ?? -1) : -1;
  if (bestRotationOnly >= 0 && rotationOnlyPx >= 0 && rotationOnlyPx <= PURE_ROTATION_PARALLAX_PX) {
    const c = candidates[bestRotationOnly];
    if (!c) return NO_POSE('the rotation-only candidate vanished', n, planar, model);
    const aa = toAxisAngle(c.rotation);
    return {
      state: PoseState.ROTATION_ONLY,
      reason:
        `rotation alone leaves ${round(rotationOnlyPx, 2)} px unexplained, at or under the ` +
        `${PURE_ROTATION_PARALLAX_PX} px §13 already tolerates in a correspondence — there is ` +
        'no parallax here for a translation to account for, so none is reported, and the ' +
        'cheirality counts are omitted rather than shown as zeros: with no baseline there is ' +
        'nothing to triangulate and a count of zero would read as a failed pose',
      source: model,
      rotation: c.rotation,
      rotationDeg: round(aa.angleDeg, 4),
      axis: aa.axis,
      quaternion: toQuaternion(c.rotation),
      translation: null,
      scale: SCALE_LOCAL_UNITS,
      planeNormal: null,
      cheirality: [],
      chosen: bestRotationOnly,
      ambiguous: false,
      pointsInFront: 0,
      correspondences: n,
      reprojectionErrorPx: -1,
      rotationOnlyResidualPx: round(rotationOnlyPx, 4),
      planar,
    };
  }

  const counts: CheiralityCount[] = candidates.map((c, i) => {
    let inFront = 0;
    for (const p of used) {
      const x = triangulate({ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }, intrinsics, c.rotation, c.translation);
      if (!x) continue;
      const { z1, z2 } = depths(x, c.rotation, c.translation);
      if (z1 > 0 && z2 > 0) inFront++;
    }
    return { candidate: i, inFront, rotationDeg: round(rotationAngleDeg(c.rotation), 3) };
  });

  const ranked = [...counts].sort((x, y) => y.inFront - x.inFront);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best) return NO_POSE('no candidate could be scored', n, planar, model);

  const fraction = best.inFront / n;
  if (fraction < MIN_CHEIRALITY_FRACTION) {
    return {
      ...NO_POSE(
        `the best of ${candidates.length} candidates put ${best.inFront} of ${n} correspondences ` +
          `in front of both cameras (${Math.round(fraction * 100)}%), under the ` +
          `${Math.round(MIN_CHEIRALITY_FRACTION * 100)}% a real pose reaches`,
        n,
        planar,
        model,
      ),
      cheirality: counts,
    };
  }
  // A pose is still reported when the margin is thin, because it is the best-supported one and
  // withholding it would lose a real measurement — but `ambiguous` travels with it, and a
  // homography's two-fold ambiguity is genuine and needs a third view rather than a tie-break.
  const ambiguous = !runnerUp || runnerUp.inFront <= 0
    ? false
    : best.inFront < runnerUp.inFront * CHEIRALITY_MARGIN;

  const chosen = candidates[best.candidate];
  if (!chosen) return NO_POSE('the chosen candidate vanished', n, planar, model);
  const rotation = chosen.rotation;

  // What `R` alone leaves unexplained for the candidate actually chosen. Above, the same
  // quantity over every candidate decided whether there was a translation at all.
  const residual = residuals[best.candidate] ?? rotationOnlyResidual(used, rotation, intrinsics);

  // Reprojection error under the chosen pose, over the points that triangulated in front.
  let sumSq = 0;
  let counted = 0;
  const km = intrinsics;
  for (const p of used) {
    const x = triangulate({ x: p.ax, y: p.ay }, { x: p.bx, y: p.by }, km, rotation, chosen.translation);
    if (!x) continue;
    const { z1, z2 } = depths(x, rotation, chosen.translation);
    if (!(z1 > 0 && z2 > 0)) continue;
    const pa = projectRay(km, x);
    const xc = apply3x3(rotation, x);
    const pb = projectRay(km, [
      (xc[0] ?? 0) + (chosen.translation[0] ?? 0),
      (xc[1] ?? 0) + (chosen.translation[1] ?? 0),
      (xc[2] ?? 0) + (chosen.translation[2] ?? 0),
    ]);
    if (!pa || !pb) continue;
    sumSq += (pa.x - p.ax) ** 2 + (pa.y - p.ay) ** 2 + (pb.x - p.bx) ** 2 + (pb.y - p.by) ** 2;
    counted += 2;
  }
  const reprojection = counted > 0 ? Math.sqrt(sumSq / counted) : -1;

  const axisAngle = toAxisAngle(rotation);
  const shared = {
    reason: '',
    source: model,
    rotation,
    rotationDeg: round(axisAngle.angleDeg, 4),
    axis: axisAngle.axis,
    quaternion: toQuaternion(rotation),
    scale: SCALE_LOCAL_UNITS,
    cheirality: counts,
    chosen: best.candidate,
    ambiguous,
    pointsInFront: best.inFront,
    correspondences: n,
    reprojectionErrorPx: round(reprojection, 4),
    rotationOnlyResidualPx: round(residual, 4),
    planar,
  };

  const direction = normalise3(chosen.translation);
  if (!direction) {
    return {
      ...shared,
      state: PoseState.ROTATION_ONLY,
      reason:
        'the chosen candidate carries a translation of no length, so there is no direction to ' +
        'report — a zero vector normalised is not a direction, it is a division by zero',
      translation: null,
      planeNormal: chosen.planeNormal ? (normalise3(chosen.planeNormal) ?? null) : null,
    };
  }

  return {
    ...shared,
    state: PoseState.POSE,
    reason:
      `${best.inFront} of ${n} correspondences in front of both cameras; rotation alone leaves ` +
      `${round(residual, 2)} px, which the translation direction accounts for. Direction only — ` +
      'a monocular camera has no scale (v3 §15, v4 §18)',
    translation: direction,
    planeNormal: chosen.planeNormal ? (normalise3(chosen.planeNormal) ?? null) : null,
  };
}

/**
 * The median distance between what `R` alone predicts and what was actually observed.
 *
 * `K R K⁻¹` is the image motion of a camera that only rotated. Whatever is left is parallax,
 * which is to say: translation. Measured, not derived — a decomposition can report a `t` of any
 * length and this cannot.
 */
export function rotationOnlyResidual(
  points: readonly Correspondence[],
  rotation: readonly number[],
  k: Intrinsics,
): number {
  const ki = invert3x3(matrixOf(k));
  if (!ki) return -1;
  const h = multiply3x3(multiply3x3(matrixOf(k), rotation), ki);
  const errs: number[] = [];
  for (const p of points) {
    const q = apply3x3(h, [p.ax, p.ay, 1]);
    const w = q[2] ?? 0;
    if (Math.abs(w) <= 1e-12) continue;
    errs.push(Math.hypot((q[0] ?? 0) / w - p.bx, (q[1] ?? 0) / w - p.by));
  }
  if (errs.length === 0) return -1;
  errs.sort((a, b) => a - b);
  const mid = errs.length >> 1;
  return errs.length % 2 ? (errs[mid] ?? 0) : ((errs[mid - 1] ?? 0) + (errs[mid] ?? 0)) / 2;
}

/**
 * The image-space homography of a camera that rotated by `R` — POSE-005's injection.
 *
 * Applying this to the second view of a correspondence set is **exactly** equivalent to the
 * camera having turned by `R` before the second frame was taken: if `b = π(K(RX + t))` then
 * `π(K Rⱼ K⁻¹ b̃) = π(K(Rⱼ R X + Rⱼ t))`. That identity is the whole reason POSE-005 is ground
 * truth rather than a plausibility check, so it lives here beside the pose it is used to score
 * — and `tests/unit/pose.test.ts` asserts the identity itself before anything is built on it.
 */
export function rotationHomography(k: Intrinsics, rotation: readonly number[]): number[] | null {
  const ki = invert3x3(matrixOf(k));
  if (!ki) return null;
  return multiply3x3(multiply3x3(matrixOf(k), rotation), ki);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}

/** Re-exported so a reader of a pose record can find the norm it is promised to have. */
export { norm3 };
