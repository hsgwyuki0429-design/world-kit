/**
 * The net rotation the device's own gyroscope measured over an interval — POSE-002's instrument.
 *
 * This is the second instrument Phase 6 is scored against, and it shares nothing with the pose
 * solver: different sensor, different thread, different arithmetic, and the solver never sees
 * its output. §H.7's rule, one phase along from Phase 4's scene-shift search.
 *
 * ## Net rotation, not integrated speed
 *
 * `FlowSession` integrates `|ω|` over a one-second window, which is the total angular *path* and
 * is the right quantity for "is this frame a rotating one". It is the wrong quantity here: a
 * phone turned 10° left and 10° back has a path of 20° and a net rotation of 0°, and the visual
 * pose between two views can only ever report the net. Comparing the two would fail a correct
 * solver on any wobble. So the rotation vector is composed properly — `R ← R · exp([ω Δt]ₓ)` —
 * and both numbers are returned, because a path much larger than the net *is* worth seeing.
 *
 * ## Angles only, never axes
 *
 * `rotationRate` is expressed in the **device's** frame and the camera's differs from it by a
 * fixed rotation nobody here has measured. A rotation angle is invariant under a change of
 * basis — conjugation preserves it — so comparing angles needs no extrinsic calibration, while
 * comparing axes would need one. POSE-002 therefore compares angles, and this module returns
 * no axis at all rather than one that would be quietly wrong.
 */

import { multiply3x3 } from '../geometry/linalg';
import { fromAxisAngle, rotationAngleDeg } from '../geometry/rotation';

export interface GyroSample {
  readonly at: number;
  /** deg/s about the device's x, y, z. `DeviceMotionEvent` calls them beta, gamma, alpha. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The largest gap between consecutive samples that may be integrated across, in ms.
 *
 * `devicemotion` fires at 60 Hz on this platform, so a gap much beyond that means samples were
 * dropped — the page was backgrounded, or the event queue stalled — and the angular velocity in
 * between is unknown. Integrating across it would invent rotation. 250 ms is fifteen missed
 * events: generous enough to survive a hiccup, short enough that a real gap is refused.
 */
export const MAX_GYRO_GAP_MS = 250;

export interface GyroRotation {
  /** Net rotation angle over the interval, degrees. `-1` when it could not be measured. */
  readonly netDeg: number;
  /** Total angular path over the same interval. Larger than `netDeg` whenever the phone wobbled. */
  readonly pathDeg: number;
  readonly samples: number;
  /** Milliseconds actually integrated, which is less than `to - from` when samples were missing. */
  readonly spanMs: number;
  /** True when a gap over `MAX_GYRO_GAP_MS` was refused rather than integrated across. */
  readonly gapped: boolean;
}

export const NO_GYRO_ROTATION: GyroRotation = {
  netDeg: -1,
  pathDeg: -1,
  samples: 0,
  spanMs: 0,
  gapped: false,
};

/**
 * Compose the samples in `[from, to]` into one rotation and report its angle.
 *
 * The composition is right-multiplied because each increment is expressed in the *current* body
 * frame, which is what a strapdown gyroscope measures. At 60 Hz and ordinary hand speeds the
 * first-order error of treating each interval as a fixed-axis rotation is far below the
 * tolerance POSE-002 applies, and the alternative — a proper quaternion integrator with
 * coning correction — would be Phase 7's business, not a witness's.
 */
export function integrateRotation(
  samples: readonly GyroSample[],
  from: number,
  to: number,
): GyroRotation {
  if (!(to > from)) return NO_GYRO_ROTATION;
  let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let path = 0;
  let used = 0;
  let span = 0;
  let gapped = false;

  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    if (b.at <= from || a.at >= to) continue;
    const dtMs = b.at - a.at;
    if (dtMs <= 0) continue;
    if (dtMs > MAX_GYRO_GAP_MS) {
      gapped = true;
      continue;
    }
    const dt = dtMs / 1000;
    // Trapezoidal in the angular velocity, which is what the samples are.
    const wx = ((a.x + b.x) / 2) * dt;
    const wy = ((a.y + b.y) / 2) * dt;
    const wz = ((a.z + b.z) / 2) * dt;
    const mag = Math.hypot(wx, wy, wz);
    if (!Number.isFinite(mag)) continue;
    used++;
    span += dtMs;
    path += mag;
    if (mag > 1e-9) r = multiply3x3(r, fromAxisAngle([wx, wy, wz], mag));
  }

  if (used === 0) return { ...NO_GYRO_ROTATION, gapped };
  return {
    netDeg: rotationAngleDeg(r),
    pathDeg: path,
    samples: used,
    spanMs: span,
    gapped,
  };
}
