/**
 * The fixed rotation between the device's frame and the camera's — estimated, never assumed.
 *
 * ## The defect this exists to remove
 *
 * `DeviceMotionEvent.rotationRate` and the accelerometer report in the **device's** body frame.
 * Phase 6's orientation is in the **camera's**. They differ by a fixed rotation that is a
 * property of how the sensor is mounted behind the lens, and until this module existed nothing
 * in this codebase had measured it. `gyroRotation.ts` and `PoseSession` both say so in as many
 * words, and both avoided needing it by comparing only the rotation *angle*, which is invariant
 * under a change of basis.
 *
 * Phase 7 cannot avoid it. Its filter propagates on the gyroscope, corrects on gravity — both in
 * the device frame — and corrects again on the visual increment, in the camera frame. Three
 * signals, two frames, no rotation between them. The device run of 2026-08-29 shows what a
 * filter does when asked to hold that contradiction: it drove the bias state to **9.19 °/s**
 * on a sensor whose true bias is a fraction of a degree, sat **33.16°** away from measured
 * gravity and **73.9°** away from vision, and produced a prediction *worse than predicting no
 * rotation at all* — a median innovation of 11.78° over visual increments whose own median was
 * 4.78°.
 *
 * ## What is solved, and why it is solvable
 *
 * Over one interval the same physical turn is seen twice: as `q_d` by the gyroscope, in the
 * device frame, and as `q_c` by Phase 6, in the camera frame. They are related by the fixed
 * rotation `x` we are after:
 *
 * ```
 *   q_c = x ⊗ q_d ⊗ x*
 * ```
 *
 * which is the rotation half of the classic hand-eye problem. Conjugation preserves the angle —
 * that is exactly why the phases below could compare angles without knowing `x` — and it carries
 * the **axis** through `x`. So each interval contributes one pair of unit axes `(n_d, n_c)` with
 * `n_c = x · n_d`, and `x` is the rotation that best carries one set onto the other: Wahba's
 * problem, solved here in closed form by Davenport's q-method on the symmetric 4×4 built from
 * the correlation matrix. `symmetricEigen` is the same Jacobi routine Phase 5's eight-point
 * solver uses.
 *
 * ## Why one axis is not enough, and what refuses
 *
 * A single rotation pair leaves `x` undetermined: any additional turn *about that shared axis*
 * maps `n_d` to `n_c` just as well, so a whole one-parameter family fits. Two turns about
 * different axes fix it. A phone panned only left and right therefore cannot calibrate this, and
 * a calibration that returned a confident answer from such a run would be inventing the
 * unconstrained degree of freedom.
 *
 * `AXIS_SPREAD_FLOOR` is what refuses. It is the smallest eigenvalue of the axis scatter matrix,
 * normalised by the largest — a number that is 0 for perfectly collinear axes and rises as the
 * turns spread over the sphere. Below the floor `estimateHandEye` returns `null` with the reason,
 * and the caller may not fuse: that is this phase's version of every other refusal in this
 * project, a missing quantity carried as an absence rather than as an identity rotation, which
 * is what "assume the frames agree" amounts to.
 */

import { symmetricEigen } from '../geometry/linalg';
import { IDENTITY, angleDeg, normalise, toRotationVector, unit } from './quat';
import type { Quat } from './quat';

/**
 * The smallest rotation worth taking an axis from, in degrees.
 *
 * The axis of a very small rotation is dominated by whatever noise is on the two measurements —
 * as the angle goes to zero the axis becomes arbitrary. Phase 6's own agreement band is 3°, so a
 * turn below a degree carries an axis whose direction is not established by anything, and
 * feeding it in would be feeding in noise with the weight of evidence.
 */
export const MIN_PAIR_ROTATION_DEG = 1.0;

/**
 * ...and the largest, because the two instruments must be describing the *same* turn.
 *
 * A visual increment this large has usually lost its correspondences and been re-anchored, and a
 * gyroscope interval this large has usually been integrated across a gap. Either way the pair is
 * no longer two views of one motion. 60° is well beyond any single visual interval the device run
 * produced — its median was 4.78° and its maximum 105.79°, and the tail above 60° is exactly the
 * re-anchors.
 */
export const MAX_PAIR_ROTATION_DEG = 60.0;

/**
 * How far the two instruments may disagree about the *angle* before the pair is dropped.
 *
 * The angle is frame-invariant, so it can be checked **before** `x` is known — which makes it the
 * one filter available on a pair whose axes cannot yet be compared. A pair whose two angles
 * disagree is not one turn seen twice; it is a dropped sample, a re-anchor, or a stale interval.
 * The fraction is Phase 6's own agreement band expressed relatively, so a large turn is allowed a
 * proportionally larger discrepancy.
 */
export const PAIR_ANGLE_TOLERANCE = 0.25;

/** The smallest number of usable pairs before an estimate is offered at all. */
export const MIN_HAND_EYE_PAIRS = 12;

/**
 * The floor on how spread the rotation axes must be — the number that refuses a pan.
 *
 * `λ_min / λ_max` of the axis scatter matrix. Perfectly collinear axes give 0. Turns spread over
 * two directions at right angles give 0.5 in the plane they span but still 0 out of it, so the
 * ratio taken against the *largest* eigenvalue only clears this floor when all three axes have
 * been exercised — which is what a hand-held phone does within seconds and a tripod pan never
 * does. 0.02 is two per cent of the dominant direction: low enough that ordinary hand motion
 * qualifies, high enough that a deliberate single-axis sweep does not.
 */
export const AXIS_SPREAD_FLOOR = 0.02;

/** One interval, seen by both instruments. */
export interface HandEyePair {
  /** The gyroscope's net rotation over the interval, in the device frame. */
  readonly device: Quat;
  /** Phase 6's visual rotation over the same interval, in the camera frame. */
  readonly camera: Quat;
}

/**
 * Which filter took the pairs that did not contribute — the diagnostic a stalled run needs.
 *
 * `estimateHandEye` returns this on **both** branches, because "5 usable pairs" is not a finding:
 * it does not say whether the turns were too small to carry an axis, too large to be one motion,
 * or two instruments disagreeing about the same one. The device run of 2026-09-05 sat at 5 usable
 * pairs for eleven minutes with a live 50 Hz gyroscope and every record in the bundle reading
 * healthy, and the reason it stalled was not recoverable from the evidence because this was not
 * in it.
 *
 * `offered` is the pairs handed in; the four counts partition `offered − pairs`.
 */
export interface HandEyeRejections {
  /** Pairs handed to the estimator, before any filter. */
  readonly offered: number;
  /** Either instrument turned less than `MIN_PAIR_ROTATION_DEG` — no axis to take. */
  readonly tooSmall: number;
  /** ...or more than `MAX_PAIR_ROTATION_DEG` — not one motion seen twice. */
  readonly tooLarge: number;
  /** The two angles disagreed by more than `PAIR_ANGLE_TOLERANCE` of the larger. */
  readonly angleDisagrees: number;
  /** A rotation vector of zero length, so no axis could be normalised. */
  readonly noAxis: number;
}

export const NO_REJECTIONS: HandEyeRejections = {
  offered: 0,
  tooSmall: 0,
  tooLarge: 0,
  angleDisagrees: 0,
  noAxis: 0,
};

export interface HandEyeEstimate {
  /** Device → camera. `v_camera = rotate(rotation, v_device)`. */
  readonly rotation: Quat;
  /** Pairs that survived the filters and contributed. */
  readonly pairs: number;
  /** `λ_min / λ_max` of the axis scatter — how much of the sphere the turns covered. */
  readonly axisSpread: number;
  /**
   * Median angle between `x · n_d` and `n_c` after the fit, in degrees. The residual a fabricated
   * `x` cannot make small: it is measured against axes the estimator was not free to choose.
   */
  readonly residualDeg: number;
  /** Which filter took the pairs that did not contribute. */
  readonly rejections: HandEyeRejections;
}

export interface HandEyeRefusal {
  readonly rotation: null;
  readonly pairs: number;
  readonly axisSpread: number;
  readonly reason: string;
  /** Which filter took the pairs that did not contribute. */
  readonly rejections: HandEyeRejections;
}

/** A pair reduced to what the fit uses: two unit axes and the angle that weights them. */
interface AxisPair {
  readonly device: readonly number[];
  readonly camera: readonly number[];
  readonly weightDeg: number;
}

/**
 * Reduce a pair to its two axes, or reject it with the reason.
 *
 * Exported because the caller counts the rejections by reason: a run that produced hundreds of
 * pairs and used none of them should say which filter took them, not simply report that no
 * estimate exists.
 */
export function axisPairFrom(pair: HandEyePair): AxisPair | { readonly rejected: string } {
  const dDeg = angleDeg(pair.device);
  const cDeg = angleDeg(pair.camera);
  if (dDeg < MIN_PAIR_ROTATION_DEG || cDeg < MIN_PAIR_ROTATION_DEG) {
    return { rejected: 'TOO_SMALL' };
  }
  if (dDeg > MAX_PAIR_ROTATION_DEG || cDeg > MAX_PAIR_ROTATION_DEG) {
    return { rejected: 'TOO_LARGE' };
  }
  // The angle is invariant under the rotation being solved for, so this check is available
  // before `x` is known and costs nothing that assumes it.
  const larger = Math.max(dDeg, cDeg);
  if (Math.abs(dDeg - cDeg) > PAIR_ANGLE_TOLERANCE * larger) {
    return { rejected: 'ANGLE_DISAGREES' };
  }
  const d = unit(toRotationVector(pair.device));
  const c = unit(toRotationVector(pair.camera));
  if (!d || !c) return { rejected: 'NO_AXIS' };
  // Weighted by the angle: a 30° turn establishes its axis far better than a 2° one, and the
  // fit should be told so rather than treating every pair as equally informative.
  return { device: d, camera: c, weightDeg: Math.min(dDeg, cDeg) };
}

/**
 * Solve for device → camera, or refuse with the reason.
 *
 * The returned rotation is the one that best carries every device-frame axis onto its
 * camera-frame partner. Nothing here reads a sensor, a tracker or a harness — it takes pairs of
 * quaternions and returns one.
 */
export function estimateHandEye(
  pairs: readonly HandEyePair[],
): HandEyeEstimate | HandEyeRefusal {
  const axes: AxisPair[] = [];
  let tooSmall = 0;
  let tooLarge = 0;
  let angleDisagrees = 0;
  let noAxis = 0;
  for (const p of pairs) {
    const a = axisPairFrom(p);
    if ('rejected' in a) {
      if (a.rejected === 'TOO_SMALL') tooSmall++;
      else if (a.rejected === 'TOO_LARGE') tooLarge++;
      else if (a.rejected === 'ANGLE_DISAGREES') angleDisagrees++;
      else noAxis++;
      continue;
    }
    axes.push(a);
  }
  const rejections: HandEyeRejections = {
    offered: pairs.length,
    tooSmall,
    tooLarge,
    angleDisagrees,
    noAxis,
  };
  if (axes.length < MIN_HAND_EYE_PAIRS) {
    return {
      rotation: null,
      pairs: axes.length,
      axisSpread: 0,
      rejections,
      // Which filter took the rest, in the reason itself: a run that stalls here is read from a
      // phone, and "below the 12 this needs" alone does not say what to do differently.
      reason:
        `${axes.length} usable rotation pair(s) of ${pairs.length} offered, below the ` +
        `${MIN_HAND_EYE_PAIRS} this needs — ${describeRejections(rejections)}`,
    };
  }

  // Scatter of the device-frame axes, weighted as the fit weights them. Its smallest eigenvalue
  // relative to its largest is how much of the sphere the turns covered — and a rotation about
  // an axis every pair shares is a degree of freedom no pair constrains.
  const scatter = new Array<number>(9).fill(0);
  let weightSum = 0;
  for (const a of axes) {
    weightSum += a.weightDeg;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        scatter[i * 3 + j] =
          (scatter[i * 3 + j] ?? 0) + a.weightDeg * (a.device[i] ?? 0) * (a.device[j] ?? 0);
      }
    }
  }
  if (weightSum <= 0) {
    return {
      rotation: null,
      pairs: axes.length,
      axisSpread: 0,
      rejections,
      reason: 'no weighted axes',
    };
  }
  const eig = symmetricEigen(scatter, 3);
  const largest = eig.values[2] ?? 0;
  const smallest = eig.values[0] ?? 0;
  const axisSpread = largest > 0 ? smallest / largest : 0;
  if (axisSpread < AXIS_SPREAD_FLOOR) {
    return {
      rotation: null,
      pairs: axes.length,
      axisSpread,
      rejections,
      reason:
        `the turns share an axis — spread ${axisSpread.toFixed(4)} against the ` +
        `${AXIS_SPREAD_FLOOR} needed. A rotation about the axis every turn shares is a degree ` +
        'of freedom none of them constrains, and solving for it anyway would invent it',
    };
  }

  // Wahba's problem, by Davenport's q-method. B is the weighted correlation of the two axis
  // sets; K is the symmetric 4×4 whose largest eigenvector is the quaternion that carries the
  // device axes onto the camera ones.
  const b = new Array<number>(9).fill(0);
  for (const a of axes) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        b[i * 3 + j] = (b[i * 3 + j] ?? 0) + a.weightDeg * (a.camera[i] ?? 0) * (a.device[j] ?? 0);
      }
    }
  }
  const trace = (b[0] ?? 0) + (b[4] ?? 0) + (b[8] ?? 0);
  const z = [
    (b[5] ?? 0) - (b[7] ?? 0),
    (b[6] ?? 0) - (b[2] ?? 0),
    (b[1] ?? 0) - (b[3] ?? 0),
  ];
  const s = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) s[i * 3 + j] = (b[i * 3 + j] ?? 0) + (b[j * 3 + i] ?? 0);
  }
  // K = [[trace, zᵀ], [z, S − trace·I]], row-major 4×4 and symmetric by construction.
  const k = new Array<number>(16).fill(0);
  k[0] = trace;
  for (let i = 0; i < 3; i++) {
    k[i + 1] = z[i] ?? 0;
    k[(i + 1) * 4] = z[i] ?? 0;
    for (let j = 0; j < 3; j++) {
      k[(i + 1) * 4 + (j + 1)] = (s[i * 3 + j] ?? 0) - (i === j ? trace : 0);
    }
  }
  const kEig = symmetricEigen(k, 4);
  // `symmetricEigen` returns ascending, so the largest is last — the maximum of Wahba's gain.
  const v = kEig.vectors[3] ?? [1, 0, 0, 0];
  const rotation = normalise([v[0] ?? 1, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0] as Quat);

  const residuals = axes.map((a) => angleBetweenAxesDeg(rotateVector(rotation, a.device), a.camera));
  residuals.sort((p, q) => p - q);
  const residualDeg = residuals[Math.floor(residuals.length / 2)] ?? -1;

  return { rotation, pairs: axes.length, axisSpread, residualDeg, rejections };
}

/**
 * The rejection tally as one clause, dominant filter first — what to do differently.
 *
 * Each filter has one thing that clears it, and they are not the same thing: turns too small need
 * a larger turn, turns too large need the visual anchor to hold across one, and two instruments
 * disagreeing about the same turn's *angle* is not a movement problem at all.
 */
export function describeRejections(r: HandEyeRejections): string {
  const rejected = r.tooSmall + r.tooLarge + r.angleDisagrees + r.noAxis;
  if (rejected === 0) {
    return 'no pair was rejected, so this is simply how many intervals have completed — keep ' +
      'both instruments running';
  }
  const ranked = [
    { n: r.angleDisagrees, why: 'the two instruments disagreed about the angle of the same turn' },
    { n: r.tooSmall, why: `the turn was under ${MIN_PAIR_ROTATION_DEG}°, too small to carry an axis` },
    { n: r.tooLarge, why: `the turn was over ${MAX_PAIR_ROTATION_DEG}°, so it is not one motion seen twice` },
    { n: r.noAxis, why: 'the rotation had no axis to take' },
  ]
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n);
  const parts = ranked.map((e) => `${e.n} because ${e.why}`);
  return `${rejected} of ${r.offered} rejected: ${parts.join('; ')}`;
}

/** `q · v · q*`, kept local so this module depends on nothing but the quaternion primitives. */
function rotateVector(q: Quat, v: readonly number[]): number[] {
  const [w, x, y, z] = q;
  const vx = v[0] ?? 0;
  const vy = v[1] ?? 0;
  const vz = v[2] ?? 0;
  // t = 2 (q_vec × v); v' = v + w t + q_vec × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function angleBetweenAxesDeg(a: readonly number[], b: readonly number[]): number {
  const dot = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Exported for the caller that has no estimate yet and must say so rather than assume one. */
export const NO_HAND_EYE: HandEyeRefusal = {
  rotation: null,
  pairs: 0,
  axisSpread: 0,
  rejections: NO_REJECTIONS,
  reason: 'no rotation pairs have been offered yet',
};

export { IDENTITY, rotateVector as rotateByHandEye };
