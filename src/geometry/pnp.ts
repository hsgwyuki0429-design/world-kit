/**
 * The camera's pose in the world from points the world already holds (Phase 12 — v4 §25).
 *
 * Phases 6 and 10 between them leave one gap that a game cannot play across. Phase 6 relates a
 * frame to an *anchor* — two views, no world. Phase 10 has a world, and the poses of the
 * **keyframes** that were registered into it, which arrive about once a second. A ring drawn
 * over the camera image needs the pose of *this* frame, thirty times a second, in the world's
 * frame. That is the perspective-n-point problem: the tracker says where landmark `id` is in
 * the image now, the map says where it is in the world, and the pose is whatever carries the
 * second onto the first.
 *
 * ## Why refinement and not a closed-form minimal solver
 *
 * The classical minimal solvers (P3P, the 6-point DLT) start from nothing. This stage never has
 * to: the previous frame's pose is a few pixels away, and the newest keyframe's pose — which the
 * map registered from landmarks, independently of this module — is never more than one keyframe
 * interval away, because the keyframe selector inserts one whenever the view has moved enough to
 * matter. So the problem is a local one, and Gauss–Newton on the reprojection error from that
 * start converges in a handful of iterations to the same optimum a minimal solver followed by
 * refinement would reach.
 *
 * The DLT has a second, disqualifying, property here: it is degenerate on **coplanar** points.
 * A room is mostly planes — the synthetic leg's scene is two of them — and a solver that fails
 * on the commonest configuration the camera will see is not a solver for this problem.
 *
 * ## Robustness without RANSAC
 *
 * The correspondences arrive already filtered twice — the tracker's forward/backward check and
 * the map's held-out gate — so the remaining outliers are few and isolated. Huber weights bound
 * their pull during the iterations, and a final pass re-solves on the points within
 * `OUTLIER_PX`. A RANSAC loop over minimal samples would buy little on top of that and would need
 * the minimal solver this module has just argued against.
 *
 * Pure arithmetic over arrays, as the architecture audit requires of this layer: the solver
 * cannot see the tracker, the map or the harness, only the numbers it is handed.
 */

import type { Intrinsics } from './intrinsics';

/** `X_camera = R · X_world + t`, row-major — the convention `mapping/landmarks.ts` uses. */
export interface CameraPose {
  readonly rotation: readonly number[];
  readonly translation: readonly number[];
}

/** One landmark seen in this frame: its pixel now, and its position in the world. */
export interface PnpCorrespondence {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly world: readonly number[];
}

export interface PnpResult {
  /** `null` when the problem could not be solved at all — too few points, or a singular system. */
  readonly pose: CameraPose | null;
  /** Per correspondence, in the order given. `-1` for a point at or behind the camera. */
  readonly residualsPx: readonly number[];
  /** Correspondences within `INLIER_PX` of where the pose projects them. */
  readonly inliers: number;
  /**
   * Median residual over the points the final solve rests on — those within `OUTLIER_PX`.
   * `-1` when there are none.
   *
   * Not over every correspondence. The first version took the median over all of them, outliers
   * included, and on the spatial leg's long run — a map that is never bundle-adjusted, so a share
   * of its landmarks drift — a pose with 162 of 247 landmarks inside 3 px reported a median of
   * 2.1–2.3 px, sat on the boundary between the two populations, and was refused every few
   * seconds. How many landmarks disagree is `inliers` and the share the caller holds it to; how
   * well the pose fits the ones that agree is this.
   */
  readonly medianErrorPx: number;
  /** ...and over every correspondence in front of the camera, outliers included. */
  readonly medianAllPx: number;
  readonly iterations: number;
  readonly converged: boolean;
  readonly reason: string;
}

/** Below this the six unknowns are not over-determined enough to say anything about outliers. */
export const MIN_PNP_POINTS = 8;

/** Where Huber stops trusting a residual quadratically, px. */
export const HUBER_PX = 2.0;

/** A correspondence this close is an inlier — v3 §33's 2 px GOOD band, widened by half for a solve. */
export const INLIER_PX = 3.0;

/** The final pass drops anything further than this before re-solving. Twice `INLIER_PX`. */
export const OUTLIER_PX = 6.0;

const MAX_ITERATIONS = 20;
const MIN_DEPTH = 1e-6;

/** Project `X_world` through the pose and `K`. `null` at or behind the camera. */
export function projectPoint(
  k: Intrinsics,
  pose: CameraPose,
  world: readonly number[],
): { x: number; y: number; depth: number } | null {
  const c = transformPoint(pose, world);
  const z = c[2] ?? 0;
  if (!(z > MIN_DEPTH)) return null;
  return { x: k.fx * ((c[0] ?? 0) / z) + k.cx, y: k.fy * ((c[1] ?? 0) / z) + k.cy, depth: z };
}

/** `R · X + t`. */
export function transformPoint(pose: CameraPose, p: readonly number[]): number[] {
  const r = pose.rotation;
  const t = pose.translation;
  const x = p[0] ?? 0;
  const y = p[1] ?? 0;
  const z = p[2] ?? 0;
  return [
    (r[0] ?? 0) * x + (r[1] ?? 0) * y + (r[2] ?? 0) * z + (t[0] ?? 0),
    (r[3] ?? 0) * x + (r[4] ?? 0) * y + (r[5] ?? 0) * z + (t[1] ?? 0),
    (r[6] ?? 0) * x + (r[7] ?? 0) * y + (r[8] ?? 0) * z + (t[2] ?? 0),
  ];
}

/** The camera's centre in the world: `−Rᵀ t`. */
export function cameraCenter(pose: CameraPose): number[] {
  const r = pose.rotation;
  const t = pose.translation;
  const tx = t[0] ?? 0;
  const ty = t[1] ?? 0;
  const tz = t[2] ?? 0;
  return [
    -((r[0] ?? 0) * tx + (r[3] ?? 0) * ty + (r[6] ?? 0) * tz),
    -((r[1] ?? 0) * tx + (r[4] ?? 0) * ty + (r[7] ?? 0) * tz),
    -((r[2] ?? 0) * tx + (r[5] ?? 0) * ty + (r[8] ?? 0) * tz),
  ];
}

/** The camera's viewing direction (its +z axis) in the world: the third row of `R`. */
export function cameraForward(pose: CameraPose): number[] {
  const r = pose.rotation;
  return [r[6] ?? 0, r[7] ?? 0, r[8] ?? 0];
}

/**
 * Refine `initial` to the pose that best explains the correspondences.
 *
 * Levenberg–Marquardt on the reprojection error with a left-multiplied SE(3) increment, Huber
 * weights, and a final re-solve on the points within `OUTLIER_PX`. Never returns a pose that is
 * worse than the one it was given — a step that raises the robust cost is refused and the damping
 * raised instead, so a bad start produces a bad (and honestly reported) answer rather than a
 * divergence.
 */
export function refinePose(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  initial: CameraPose,
): PnpResult {
  if (correspondences.length < MIN_PNP_POINTS) {
    return failure(
      correspondences.length,
      `${correspondences.length} correspondence(s), below the ${MIN_PNP_POINTS} a six-unknown ` +
        'solve needs with any redundancy',
    );
  }
  if (!isFinitePose(initial)) return failure(correspondences.length, 'the starting pose is not finite');

  const first = iterate(k, correspondences, initial);
  // The outlier pass: whatever is still far from the converged pose is not this pose's evidence.
  const residuals = residualsOf(k, correspondences, first.pose);
  const kept = correspondences.filter((_, i) => {
    const r = residuals[i] ?? -1;
    return r >= 0 && r <= OUTLIER_PX;
  });
  const second =
    kept.length >= MIN_PNP_POINTS && kept.length < correspondences.length
      ? iterate(k, kept, first.pose)
      : first;

  const finalResiduals = residualsOf(k, correspondences, second.pose);
  const front = finalResiduals.filter((r) => r >= 0);
  const inliers = front.filter((r) => r <= INLIER_PX).length;
  const resting = front.filter((r) => r <= OUTLIER_PX);
  return {
    pose: second.pose,
    residualsPx: finalResiduals.map((r) => (r < 0 ? -1 : round(r, 4))),
    inliers,
    medianErrorPx: resting.length > 0 ? round(median(resting), 4) : -1,
    medianAllPx: front.length > 0 ? round(median(front), 4) : -1,
    iterations: first.iterations + (second === first ? 0 : second.iterations),
    converged: second.converged,
    reason:
      `${inliers}/${correspondences.length} within ${INLIER_PX} px after ` +
      `${first.iterations + (second === first ? 0 : second.iterations)} iteration(s)` +
      (kept.length < correspondences.length
        ? `; ${correspondences.length - kept.length} beyond ${OUTLIER_PX} px left out of the final solve`
        : ''),
  };
}

/** Residual of every correspondence under `pose`, px; `-1` at or behind the camera. */
export function residualsOf(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  pose: CameraPose,
): number[] {
  return correspondences.map((c) => {
    const p = projectPoint(k, pose, c.world);
    return p ? Math.hypot(p.x - c.x, p.y - c.y) : -1;
  });
}

/* -------------------------------------------------------------------------- */

interface IterationOutcome {
  readonly pose: CameraPose;
  readonly iterations: number;
  readonly converged: boolean;
}

function iterate(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  initial: CameraPose,
): IterationOutcome {
  let pose = initial;
  let cost = robustCost(k, correspondences, pose);
  let lambda = 1e-3;
  let converged = false;
  let iterations = 0;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const system = normalEquations(k, correspondences, pose);
    if (!system) break;
    let accepted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const damped = system.h.slice();
      for (let i = 0; i < 6; i++) damped[i * 6 + i] = (damped[i * 6 + i] ?? 0) * (1 + lambda) + 1e-12;
      const delta = solve6(damped, system.g.map((v) => -v));
      if (!delta) {
        lambda *= 10;
        continue;
      }
      const candidate = applyIncrement(pose, delta);
      const candidateCost = robustCost(k, correspondences, candidate);
      if (Number.isFinite(candidateCost) && candidateCost <= cost) {
        const step = Math.hypot(...delta);
        pose = candidate;
        const improvement = cost - candidateCost;
        cost = candidateCost;
        lambda = Math.max(1e-7, lambda / 3);
        accepted = true;
        if (step < 1e-7 || improvement < 1e-9 * Math.max(1, cost)) converged = true;
        break;
      }
      lambda *= 4;
    }
    if (!accepted) {
      // No step lowers the cost: we are at a minimum the damping cannot leave.
      converged = true;
      break;
    }
    if (converged) {
      iterations++;
      break;
    }
  }
  return { pose, iterations, converged };
}

function normalEquations(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  pose: CameraPose,
): { h: number[]; g: number[] } | null {
  const h = new Array<number>(36).fill(0);
  const g = new Array<number>(6).fill(0);
  let used = 0;
  for (const c of correspondences) {
    const p = transformPoint(pose, c.world);
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    const z = p[2] ?? 0;
    if (!(z > MIN_DEPTH)) continue;
    const iz = 1 / z;
    const u = k.fx * x * iz + k.cx;
    const v = k.fy * y * iz + k.cy;
    const ru = u - c.x;
    const rv = v - c.y;
    const r = Math.hypot(ru, rv);
    const w = r <= HUBER_PX ? 1 : HUBER_PX / r;

    // ∂(u,v)/∂P, and ∂P/∂(ω, v) = [ −[P]× | I ] for a left increment.
    const du = [k.fx * iz, 0, -k.fx * x * iz * iz];
    const dv = [0, k.fy * iz, -k.fy * y * iz * iz];
    const ju = jacobianRow(du, x, y, z);
    const jv = jacobianRow(dv, x, y, z);
    for (let i = 0; i < 6; i++) {
      const jui = ju[i] ?? 0;
      const jvi = jv[i] ?? 0;
      g[i] = (g[i] ?? 0) + w * (jui * ru + jvi * rv);
      for (let j = i; j < 6; j++) {
        const add = w * (jui * (ju[j] ?? 0) + jvi * (jv[j] ?? 0));
        h[i * 6 + j] = (h[i * 6 + j] ?? 0) + add;
      }
    }
    used++;
  }
  if (used < MIN_PNP_POINTS) return null;
  for (let i = 0; i < 6; i++) for (let j = 0; j < i; j++) h[i * 6 + j] = h[j * 6 + i] ?? 0;
  return { h, g };
}

/** `d · [ −[P]× | I ]` for one image axis `d = ∂u/∂P`. */
function jacobianRow(d: readonly number[], x: number, y: number, z: number): number[] {
  const d0 = d[0] ?? 0;
  const d1 = d[1] ?? 0;
  const d2 = d[2] ?? 0;
  // −[P]× = [[0, z, −y], [−z, 0, x], [y, −x, 0]]
  return [
    d1 * -z + d2 * y,
    d0 * z + d2 * -x,
    d0 * -y + d1 * x,
    d0,
    d1,
    d2,
  ];
}

function robustCost(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  pose: CameraPose,
): number {
  let cost = 0;
  for (const c of correspondences) {
    const p = projectPoint(k, pose, c.world);
    if (!p) {
      // A point that falls behind the camera is the strongest possible disagreement.
      cost += 2 * HUBER_PX * OUTLIER_PX * 10;
      continue;
    }
    const r = Math.hypot(p.x - c.x, p.y - c.y);
    cost += r <= HUBER_PX ? 0.5 * r * r : HUBER_PX * (r - 0.5 * HUBER_PX);
  }
  return cost;
}

/** `R ← exp(ω) R`, `t ← exp(ω) t + v`. */
function applyIncrement(pose: CameraPose, delta: readonly number[]): CameraPose {
  const e = expSo3([delta[0] ?? 0, delta[1] ?? 0, delta[2] ?? 0]);
  const r = multiply(e, pose.rotation);
  const t = apply(e, pose.translation);
  return {
    rotation: orthonormalise(r),
    translation: [(t[0] ?? 0) + (delta[3] ?? 0), (t[1] ?? 0) + (delta[4] ?? 0), (t[2] ?? 0) + (delta[5] ?? 0)],
  };
}

/** Rodrigues. */
export function expSo3(w: readonly number[]): number[] {
  const wx = w[0] ?? 0;
  const wy = w[1] ?? 0;
  const wz = w[2] ?? 0;
  const theta = Math.hypot(wx, wy, wz);
  if (theta < 1e-12) return [1, -wz, wy, wz, 1, -wx, -wy, wx, 1];
  const kx = wx / theta;
  const ky = wy / theta;
  const kz = wz / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s,
    ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s,
    kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v,
  ];
}

/** Gram–Schmidt on the rows, so accumulated increments cannot drift off SO(3). */
function orthonormalise(r: readonly number[]): number[] {
  const a = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0];
  const b = [r[3] ?? 0, r[4] ?? 0, r[5] ?? 0];
  const na = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0) || 1;
  const x = a.map((v) => v / na);
  const d = (x[0] ?? 0) * (b[0] ?? 0) + (x[1] ?? 0) * (b[1] ?? 0) + (x[2] ?? 0) * (b[2] ?? 0);
  const y0 = b.map((v, i) => v - d * (x[i] ?? 0));
  const ny = Math.hypot(y0[0] ?? 0, y0[1] ?? 0, y0[2] ?? 0) || 1;
  const y = y0.map((v) => v / ny);
  const z = [
    (x[1] ?? 0) * (y[2] ?? 0) - (x[2] ?? 0) * (y[1] ?? 0),
    (x[2] ?? 0) * (y[0] ?? 0) - (x[0] ?? 0) * (y[2] ?? 0),
    (x[0] ?? 0) * (y[1] ?? 0) - (x[1] ?? 0) * (y[0] ?? 0),
  ];
  return [...x, ...y, ...z];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let q = 0; q < 3; q++) s += (a[i * 3 + q] ?? 0) * (b[q * 3 + j] ?? 0);
      out[i * 3 + j] = s;
    }
  }
  return out;
}

function apply(m: readonly number[], v: readonly number[]): number[] {
  return [0, 1, 2].map(
    (i) => (m[i * 3] ?? 0) * (v[0] ?? 0) + (m[i * 3 + 1] ?? 0) * (v[1] ?? 0) + (m[i * 3 + 2] ?? 0) * (v[2] ?? 0),
  );
}

/** Gaussian elimination with partial pivoting on a 6×6 system. `null` when singular. */
function solve6(a: readonly number[], b: readonly number[]): number[] | null {
  const n = 6;
  const m = a.slice();
  const x = b.slice();
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(m[col * n + col] ?? 0);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col] ?? 0);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (!(best > 1e-18)) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const tmp = m[col * n + c] ?? 0;
        m[col * n + c] = m[pivot * n + c] ?? 0;
        m[pivot * n + c] = tmp;
      }
      const tb = x[col] ?? 0;
      x[col] = x[pivot] ?? 0;
      x[pivot] = tb;
    }
    const diag = m[col * n + col] ?? 1;
    for (let r = col + 1; r < n; r++) {
      const f = (m[r * n + col] ?? 0) / diag;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[r * n + c] = (m[r * n + c] ?? 0) - f * (m[col * n + c] ?? 0);
      x[r] = (x[r] ?? 0) - f * (x[col] ?? 0);
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r] ?? 0;
    for (let c = r + 1; c < n; c++) s -= (m[r * n + c] ?? 0) * (out[c] ?? 0);
    out[r] = s / (m[r * n + r] ?? 1);
  }
  return out.every(Number.isFinite) ? out : null;
}

function isFinitePose(p: CameraPose): boolean {
  return (
    p.rotation.length === 9 &&
    p.translation.length === 3 &&
    p.rotation.every(Number.isFinite) &&
    p.translation.every(Number.isFinite)
  );
}

function failure(n: number, reason: string): PnpResult {
  return {
    pose: null,
    residualsPx: new Array<number>(n).fill(-1),
    inliers: 0,
    medianErrorPx: -1,
    medianAllPx: -1,
    iterations: 0,
    converged: false,
    reason,
  };
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
