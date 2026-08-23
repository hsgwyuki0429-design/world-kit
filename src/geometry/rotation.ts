/**
 * Rotations, in the three forms this project needs and with the conversions between them.
 *
 * §18 says クォータニオン優先 — quaternion first, and do not manage a pose over any length of
 * time in Euler angles alone. That is Phase 7's EKF, but the rule starts here, because Phase 6
 * is where a rotation first exists: the record carries a matrix (what the solver produced), an
 * axis and angle (what a person can read), and a quaternion (what Phase 7 will integrate).
 * Euler angles are not produced at all.
 *
 * Pure functions over row-major 3×3 arrays. Nothing here knows what a camera is.
 */

import { determinant3x3, multiply3x3, normalise3, transpose3x3 } from './linalg';

export interface AxisAngle {
  /** Unit axis. `[0,0,1]` by convention when the angle is zero and the axis is undetermined. */
  readonly axis: readonly number[];
  readonly angleDeg: number;
}

/** `[w, x, y, z]`, unit, with `w >= 0` so that a rotation has one representation and not two. */
export type Quaternion = readonly [number, number, number, number];

/**
 * The rotation angle of `R`, in degrees.
 *
 * From the trace: `tr(R) = 1 + 2cos θ`. Clamped before the arc-cosine because a matrix that has
 * been through a decomposition is orthogonal to within rounding, not exactly, and a trace of
 * 3.0000000004 would otherwise produce `NaN` — which would then travel into an evidence bundle
 * as a missing measurement rather than as a zero rotation.
 */
export function rotationAngleDeg(r: readonly number[]): number {
  const trace = (r[0] ?? 0) + (r[4] ?? 0) + (r[8] ?? 0);
  const c = Math.min(1, Math.max(-1, (trace - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Axis and angle of `R`. The axis comes from the quaternion, which is stable at every angle. */
export function toAxisAngle(r: readonly number[]): AxisAngle {
  const q = toQuaternion(r);
  const angleDeg = rotationAngleDeg(r);
  const axis = normalise3([q[1], q[2], q[3]]) ?? [0, 0, 1];
  return { axis, angleDeg };
}

/**
 * `R` as a unit quaternion.
 *
 * Shepperd's method: the largest of the four candidate denominators is chosen rather than
 * always taking `w`, because `w` vanishes at 180° and the naive formula loses all its
 * precision approaching it. A pose stage that only ever sees small rotations would never
 * notice; one handed a half-turn between keyframes would produce an axis of noise.
 */
export function toQuaternion(r: readonly number[]): Quaternion {
  const m = (i: number): number => r[i] ?? 0;
  const trace = m(0) + m(4) + m(8);
  let w: number;
  let x: number;
  let y: number;
  let z: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m(7) - m(5)) / s;
    y = (m(2) - m(6)) / s;
    z = (m(3) - m(1)) / s;
  } else if (m(0) > m(4) && m(0) > m(8)) {
    const s = Math.sqrt(1 + m(0) - m(4) - m(8)) * 2;
    w = (m(7) - m(5)) / s;
    x = 0.25 * s;
    y = (m(1) + m(3)) / s;
    z = (m(2) + m(6)) / s;
  } else if (m(4) > m(8)) {
    const s = Math.sqrt(1 + m(4) - m(0) - m(8)) * 2;
    w = (m(2) - m(6)) / s;
    x = (m(1) + m(3)) / s;
    y = 0.25 * s;
    z = (m(5) + m(7)) / s;
  } else {
    const s = Math.sqrt(1 + m(8) - m(0) - m(4)) * 2;
    w = (m(3) - m(1)) / s;
    x = (m(2) + m(6)) / s;
    y = (m(5) + m(7)) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(w, x, y, z) || 1;
  // `q` and `-q` are the same rotation. Fixing the sign of `w` gives one representation, so
  // two equal rotations compare equal instead of differing by a global sign.
  const sign = w < 0 ? -1 : 1;
  return [(sign * w) / n, (sign * x) / n, (sign * y) / n, (sign * z) / n];
}

/** A rotation of `angleDeg` about `axis`, by Rodrigues. */
export function fromAxisAngle(axis: readonly number[], angleDeg: number): number[] {
  const u = normalise3(axis) ?? [0, 0, 1];
  const t = (angleDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const [x, y, z] = [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0];
  const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

/**
 * The angle between two rotations — how far `a` must turn to become `b`.
 *
 * This is the phase's own unit of disagreement: POSE-002 compares a recovered rotation against
 * the gyroscope's with it, and POSE-005 compares a recovered rotation against one the harness
 * injected. Both are `angleBetween`, not a difference of Euler angles, which would be three
 * numbers with a wrap-around each.
 */
export function angleBetweenDeg(a: readonly number[], b: readonly number[]): number {
  return rotationAngleDeg(multiply3x3(b, transpose3x3(a)));
}

/** Whether `m` is a rotation: orthonormal with a positive determinant, to `tol`. */
export function isRotation(m: readonly number[], tol = 1e-6): boolean {
  if (m.length !== 9) return false;
  const should = multiply3x3(transpose3x3(m), m);
  const eye = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i++) {
    if (Math.abs((should[i] ?? 0) - (eye[i] ?? 0)) > tol) return false;
  }
  return Math.abs(determinant3x3(m) - 1) <= tol;
}
