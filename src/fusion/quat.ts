/**
 * Quaternion algebra for the orientation filter (§18: クォータニオン優先).
 *
 * §18 says to prefer quaternions and not to manage a pose over any length of time in Euler
 * angles alone. That is why this file exists and why no Euler conversion is written in it: the
 * filter carries `[w, x, y, z]`, the record carries `[w, x, y, z]`, and there is nowhere for a
 * gimbal to appear because there is no triple of angles anywhere in the chain.
 *
 * ## Convention, stated once
 *
 * `q` rotates **body into world**: `v_world = R(q) · v_body`. Composition is
 * `q_ab ⊗ q_bc = q_ac`, and a body-frame increment is applied on the **right** — `q ← q ⊗ δq` —
 * because that is what a strapdown gyroscope measures: angular velocity in the frame it is
 * bolted to. Getting that side wrong reverses the sense of every correction while leaving every
 * magnitude right, which is the kind of error that looks like tuning.
 *
 * Pure array arithmetic over `[w, x, y, z]`. Nothing here knows what a camera or a sensor is.
 */

export type Quat = readonly [number, number, number, number];

export const IDENTITY: Quat = [1, 0, 0, 0];

export function multiply(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

/** The inverse of a **unit** quaternion, which is its conjugate. */
export function conjugate(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function normalise(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(n) || n <= 1e-12) return IDENTITY;
  // `w >= 0` so a rotation has one representation and two equal ones compare equal.
  const s = (q[0] < 0 ? -1 : 1) / n;
  return [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
}

/**
 * The quaternion of a rotation vector (axis × angle, radians).
 *
 * Uses the small-angle series below the point where `sin(θ/2)/θ` loses precision. At 60 Hz an
 * ordinary hand movement gives θ of a few milliradians per sample, so the series branch is the
 * one almost every propagation step takes — the exact form is there for the large corrections,
 * not the other way round.
 */
export function fromRotationVector(v: readonly number[]): Quat {
  const x = v[0] ?? 0;
  const y = v[1] ?? 0;
  const z = v[2] ?? 0;
  const theta = Math.hypot(x, y, z);
  if (!Number.isFinite(theta)) return IDENTITY;
  if (theta < 1e-8) {
    // q ≈ [1, v/2], renormalised. The dropped term is O(θ²) and θ² < 1e-16 here.
    return normalise([1, x / 2, y / 2, z / 2]);
  }
  const half = theta / 2;
  const s = Math.sin(half) / theta;
  return normalise([Math.cos(half), x * s, y * s, z * s]);
}

/** ...and back: the rotation vector of a unit quaternion, radians, shortest way round. */
export function toRotationVector(q: Quat): number[] {
  const u = normalise(q);
  const vecNorm = Math.hypot(u[1], u[2], u[3]);
  if (vecNorm < 1e-12) return [0, 0, 0];
  // `normalise` fixes w >= 0, so this is already the shorter of the two equivalent rotations.
  const theta = 2 * Math.atan2(vecNorm, u[0]);
  const k = theta / vecNorm;
  return [u[1] * k, u[2] * k, u[3] * k];
}

/** Rotation angle of `q`, degrees. */
export function angleDeg(q: Quat): number {
  const u = normalise(q);
  const vecNorm = Math.min(1, Math.hypot(u[1], u[2], u[3]));
  return (2 * Math.atan2(vecNorm, u[0]) * 180) / Math.PI;
}

/** The angle between two orientations, degrees — the phase's unit of disagreement. */
export function angleBetweenDeg(a: Quat, b: Quat): number {
  return angleDeg(multiply(conjugate(a), b));
}

/** `R(q) · v` — body into world. */
export function rotate(q: Quat, v: readonly number[]): number[] {
  const [w, x, y, z] = normalise(q);
  const vx = v[0] ?? 0;
  const vy = v[1] ?? 0;
  const vz = v[2] ?? 0;
  // t = 2 (q_vec × v); v' = v + w t + q_vec × t. Fewer operations than building R, and it
  // cannot drift away from orthonormal the way an accumulated matrix can.
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

/** `R(q)ᵀ · v` — world into body. */
export function rotateInverse(q: Quat, v: readonly number[]): number[] {
  return rotate(conjugate(q), v);
}

/** Row-major 3×3 of `q`, for the places that need a matrix rather than a rotation. */
export function toMatrix(q: Quat): number[] {
  const [w, x, y, z] = normalise(q);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** ...and from one, by Shepperd's method — the same branch selection `geometry/rotation.ts` uses. */
export function fromMatrix(m: readonly number[]): Quat {
  const g = (i: number): number => m[i] ?? 0;
  const trace = g(0) + g(4) + g(8);
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalise([0.25 * s, (g(7) - g(5)) / s, (g(2) - g(6)) / s, (g(3) - g(1)) / s]);
  }
  if (g(0) > g(4) && g(0) > g(8)) {
    const s = Math.sqrt(1 + g(0) - g(4) - g(8)) * 2;
    return normalise([(g(7) - g(5)) / s, 0.25 * s, (g(1) + g(3)) / s, (g(2) + g(6)) / s]);
  }
  if (g(4) > g(8)) {
    const s = Math.sqrt(1 + g(4) - g(0) - g(8)) * 2;
    return normalise([(g(2) - g(6)) / s, (g(1) + g(3)) / s, 0.25 * s, (g(5) + g(7)) / s]);
  }
  const s = Math.sqrt(1 + g(8) - g(0) - g(4)) * 2;
  return normalise([(g(3) - g(1)) / s, (g(2) + g(6)) / s, (g(5) + g(7)) / s, 0.25 * s]);
}

/**
 * The shortest rotation taking `from` onto `to`, both unit vectors.
 *
 * Used at initialisation to build a world frame from the first accepted gravity reading, which
 * is what lets this phase avoid assuming a sign convention for `accelerationIncludingGravity`
 * that the platforms disagree about. See `orientationEkf.ts`.
 */
export function betweenVectors(from: readonly number[], to: readonly number[]): Quat {
  const a = unit(from);
  const b = unit(to);
  if (!a || !b) return IDENTITY;
  const dot = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  if (dot > 1 - 1e-12) return IDENTITY;
  if (dot < -1 + 1e-12) {
    // Antiparallel: any perpendicular axis is a half turn. Pick one that cannot be degenerate.
    const axis = Math.abs(a[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const perp = unit(cross(a, axis)) ?? [0, 1, 0];
    return normalise([0, perp[0] ?? 0, perp[1] ?? 0, perp[2] ?? 0]);
  }
  const c = cross(a, b);
  return normalise([1 + dot, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]);
}

export function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

export function unit(v: readonly number[]): number[] | null {
  const n = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  if (!Number.isFinite(n) || n <= 1e-12) return null;
  return [(v[0] ?? 0) / n, (v[1] ?? 0) / n, (v[2] ?? 0) / n];
}
