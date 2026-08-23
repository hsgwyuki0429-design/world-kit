/**
 * The orientation error-state filter (v3 §17, §18).
 *
 * Six error states: `[δθ (3), δb (3)]`. The nominal state is a unit quaternion and a gyroscope
 * bias in rad/s; the filter carries the *error* about them, which is what keeps the quaternion a
 * quaternion — a covariance over four correlated components with a unit-norm constraint is a
 * covariance over a manifold, and the standard answer is not to try.
 *
 * ## What it estimates, and what it refuses
 *
 * v3 §18 names five states. **Two are estimated here and three are refused**, and the refusal is
 * a unit mismatch rather than a preference:
 *
 * > the accelerometer reports m/s²; Phase 6's translation is a unit direction in `LOCAL_UNITS`
 * > with no scale, because v3 §15 and v4 §18 both forbid a monocular camera claiming one.
 * > Fusing an acceleration with a scaleless direction requires the scale, which is exactly the
 * > quantity that does not exist.
 *
 * So there is no `position`, no `velocity` and no `accelBias` in this file — not omitted, but
 * absent for a reason `docs/phase7/TEST-PLAN.md` states and IMU-006 measures. v3 §17 forbids the
 * same thing twice from the other side.
 *
 * ## The three inputs
 *
 *  1. **Gyroscope** — propagates. `q ← q ⊗ exp(½(ω − b)Δt)`, right-multiplied because the sensor
 *     measures in the body frame.
 *  2. **The visual *relative* rotation** — corrects. Phase 6 does not produce an absolute
 *     attitude; it produces the rotation between the verification anchor and now. So the
 *     measurement is what the gyroscope *should* have integrated over that interval, and its
 *     residual is what makes the bias observable at all: a bias error shows up as a rotation
 *     error growing linearly in Δt, which nothing else in the model does.
 *  3. **Gravity** — corrects roll and pitch, and only those. The direction of gravity says
 *     nothing about rotation *about* gravity, so yaw is left to the gyroscope and to vision.
 *
 * ## What is approximated, said plainly
 *
 * The visual update treats the filter's attitude **at the anchor** as error-free. It was not:
 * the anchor was itself a propagated estimate. Doing this properly means keeping that state in
 * the filter (stochastic cloning) and is Phase 8's business, where a keyframe is a thing that
 * exists and is kept. Here the neglected term is covered by inflating the measurement noise —
 * `visualNoiseRad` is deliberately larger than Phase 6's own rotation accuracy — so the filter
 * under-trusts vision rather than over-trusting it. The bias still converges; it converges more
 * slowly than an optimal filter would.
 *
 * ## Yaw has no absolute reference, and the record says so
 *
 * Gravity fixes roll and pitch. Vision gives *relative* rotation, not heading. The magnetometer
 * is excluded — the device reports `absolute: false` — so **yaw is relative to wherever the
 * session started**, and `heading` is reported as `RELATIVE` rather than left to be assumed.
 *
 * Pure arithmetic: no DOM, no sensors, no clock. The caller supplies every timestamp.
 */

import { IDENTITY, betweenVectors, conjugate, fromRotationVector, multiply, normalise, rotateInverse, toRotationVector, unit } from './quat';
import type { Quat } from './quat';

/* -------------------------------------------------------------------------- */
/* Noise, and where each figure comes from                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gyroscope white noise, rad/s/√Hz.
 *
 * A consumer MEMS part in a phone sits around 0.01 °/s/√Hz. Converted: 1.7e-4 rad/s/√Hz. This is
 * the one figure here taken from the part class rather than from something this project measured,
 * and it is a *noise* term — it sets how fast the filter trusts new information, not what it
 * concludes. IMU-005 is what checks the conclusion.
 */
export const GYRO_NOISE = 1.7e-4;

/** Bias random walk, rad/s/√s. Small: a MEMS bias moves over minutes, not over frames. */
export const BIAS_RANDOM_WALK = 1e-5;

/**
 * Measurement noise on the visual relative rotation, radians.
 *
 * Phase 6's device run measured a median visual/inertial disagreement of 0.762°, so the visual
 * rotation is good to about that. This is set to **3°** — deliberately four times worse — because
 * the anchor's own attitude error is not modelled (see above) and the honest way to carry an
 * unmodelled term is to under-trust the measurement that carries it.
 */
export const VISUAL_NOISE_RAD = (3 * Math.PI) / 180;

/**
 * Measurement noise on the gravity direction, radians.
 *
 * Gravity is a *direction* measurement and a hand holds a phone with a tremor of a degree or so;
 * the accelerometer also picks up every linear acceleration the hand adds. 5° admits it as a slow
 * drift reference without letting it fight the gyroscope over the short term, which is the
 * division of labour v3 §17 describes.
 */
export const GRAVITY_NOISE_RAD = (5 * Math.PI) / 180;

/** Initial uncertainty: orientation is *defined* by the first gravity reading in roll and pitch. */
const INITIAL_TILT_VAR = ((10 * Math.PI) / 180) ** 2;
/** ...and yaw is arbitrary, which is what `heading: RELATIVE` means. */
const INITIAL_YAW_VAR = ((180 * Math.PI) / 180) ** 2;
/** The bias is unknown to about the part's spec, ~2 °/s. */
const INITIAL_BIAS_VAR = ((2 * Math.PI) / 180) ** 2;

const N = 6;

export interface EkfState {
  readonly q: Quat;
  /** rad/s, body frame. */
  readonly bias: readonly number[];
  /** Diagonal of the covariance, for reporting: `[δθ×3, δb×3]`. */
  readonly variance: readonly number[];
  readonly initialised: boolean;
}

export interface UpdateOutcome {
  /** The residual before the update, degrees — zero on a filter that is copying, not predicting. */
  readonly innovationDeg: number;
  /** `false` when the update was refused, with `reason` saying why. */
  readonly applied: boolean;
  readonly reason: string;
}

const NOT_APPLIED = (reason: string): UpdateOutcome => ({
  innovationDeg: -1,
  applied: false,
  reason,
});

/**
 * `OrientationEkf` — one filter. Phase 7 runs **two**: one on the sensors as they arrive and one
 * on a copy with a known bias added, which is IMU-005's gate. Neither is told which it is.
 */
export class OrientationEkf {
  private q: Quat = IDENTITY;
  private bias = [0, 0, 0];
  /** Row-major 6×6. */
  private p: number[] = [];
  private started = false;
  /** The world's down axis, in world coordinates, fixed by the first accepted gravity reading. */
  private worldDown: number[] | null = null;
  /** The filter's own attitude when the current visual interval began. */
  private visualRefQ: Quat | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.q = IDENTITY;
    this.bias = [0, 0, 0];
    this.p = new Array<number>(N * N).fill(0);
    this.p[0] = INITIAL_TILT_VAR;
    this.p[7] = INITIAL_TILT_VAR;
    this.p[14] = INITIAL_YAW_VAR;
    this.p[21] = INITIAL_BIAS_VAR;
    this.p[28] = INITIAL_BIAS_VAR;
    this.p[35] = INITIAL_BIAS_VAR;
    this.started = false;
    this.worldDown = null;
    this.visualRefQ = null;
  }

  state(): EkfState {
    return {
      q: this.q,
      bias: [...this.bias],
      variance: [0, 1, 2, 3, 4, 5].map((i) => this.p[i * N + i] ?? 0),
      initialised: this.started,
    };
  }

  isInitialised(): boolean {
    return this.started;
  }

  /**
   * Define the world frame from a gravity reading, once.
   *
   * **This is what lets the phase avoid a sign convention it cannot verify.** iOS and other
   * platforms disagree about the sign of `accelerationIncludingGravity`, and one sample from one
   * device cannot settle it. So no sign is assumed: whatever direction the measured gravity
   * vector points in the body frame at the moment of initialisation *is* the world's down axis,
   * by definition. Every later gravity reading is then checked against that definition rather
   * than against an assumption, and `gravityDeg` means "has the filter drifted relative to where
   * down was when it started" — which is the question worth asking.
   */
  initialiseFrom(gravityBody: readonly number[]): boolean {
    const g = unit(gravityBody);
    if (!g) return false;
    // q maps body → world, and at t=0 we choose world = body, so down is simply the measured
    // direction expressed in the world frame — the two frames coincide at this instant.
    this.q = IDENTITY;
    this.worldDown = g;
    this.started = true;
    return true;
  }

  /** Propagate on one gyroscope sample. `omega` is rad/s in the body frame; `dt` seconds. */
  predict(omega: readonly number[], dt: number): void {
    if (!this.started || !(dt > 0) || !Number.isFinite(dt)) return;
    const w = [
      (omega[0] ?? 0) - (this.bias[0] ?? 0),
      (omega[1] ?? 0) - (this.bias[1] ?? 0),
      (omega[2] ?? 0) - (this.bias[2] ?? 0),
    ];
    // Right-multiplied: the increment is in the body frame, which is where the sensor lives.
    this.q = normalise(multiply(this.q, fromRotationVector(w.map((x) => x * dt))));

    // F = [[I − [ω]ₓ dt, −I dt], [0, I]] — the standard error-state transition to first order.
    const f = identity(N);
    const sk = skew(w);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        f[r * N + c] = (r === c ? 1 : 0) - (sk[r * 3 + c] ?? 0) * dt;
      }
      f[r * N + (3 + r)] = -dt;
    }
    this.p = addDiagonal(
      multiply6(multiply6(f, this.p), transpose6(f)),
      [
        GYRO_NOISE * GYRO_NOISE * dt, GYRO_NOISE * GYRO_NOISE * dt, GYRO_NOISE * GYRO_NOISE * dt,
        BIAS_RANDOM_WALK * BIAS_RANDOM_WALK * dt,
        BIAS_RANDOM_WALK * BIAS_RANDOM_WALK * dt,
        BIAS_RANDOM_WALK * BIAS_RANDOM_WALK * dt,
      ],
    );
  }

  /** Start a visual interval: remember the filter's own attitude at the moment vision did. */
  beginVisualInterval(): void {
    this.visualRefQ = this.q;
  }

  hasVisualInterval(): boolean {
    return this.visualRefQ !== null;
  }

  /**
   * Correct with the visual relative rotation — the update that makes the bias observable.
   *
   * `relative` is the rotation vision says happened **since `beginVisualInterval` was called**,
   * and the residual is that against what the gyroscope integrated over the same span.
   *
   * ## Why `H = [I, 0]` and not `[I, −Δt·I]`
   *
   * The first version of this file used the latter, reasoning that a bias error contributes
   * `−δb·Δt` to the residual and that the term therefore belongs in the measurement model. It
   * does contribute that — but the propagation has **already** put it into `δθ`: that is exactly
   * what the `−I dt` block of `F` does, once per gyroscope sample. Writing it again in `H`
   * counts the same physics twice, and the filter then corrects the bias by about double what
   * the evidence supports. It over-shot, oscillated, and settled at a bias with the wrong sign.
   *
   * So the measurement is simply `z = δθ`, and the bias is corrected through the **covariance
   * coupling** `P_θb` that `F` builds up — which is the whole mechanism by which a bias becomes
   * observable, and the reason the interval wants to be long: `P_θb` grows with it.
   */
  updateVisualIncrement(relative: Quat): UpdateOutcome {
    if (!this.started) return NOT_APPLIED('the filter has no world frame yet');
    if (!this.visualRefQ) return NOT_APPLIED('no visual interval has been started');

    const predicted = multiply(conjugate(this.visualRefQ), this.q);
    const residualQ = multiply(conjugate(predicted), normalise(relative));
    const z = toRotationVector(residualQ);
    const innovationDeg = (Math.hypot(z[0] ?? 0, z[1] ?? 0, z[2] ?? 0) * 180) / Math.PI;

    const h = new Array<number>(3 * N).fill(0);
    for (let i = 0; i < 3; i++) h[i * N + i] = 1;
    const r = VISUAL_NOISE_RAD * VISUAL_NOISE_RAD;
    this.applyUpdate(h, z, [r, r, r]);
    // The corrected attitude begins the next interval; the error state is zero after injection.
    this.visualRefQ = this.q;
    return { innovationDeg, applied: true, reason: '' };
  }

  /**
   * Correct roll and pitch with gravity. Yaw is untouched — a direction cannot see rotation
   * about itself, and pretending otherwise is how a filter acquires a heading it never measured.
   */
  updateGravity(gravityBody: readonly number[]): UpdateOutcome {
    if (!this.started || !this.worldDown) return NOT_APPLIED('the filter has no world frame yet');
    const measured = unit(gravityBody);
    if (!measured) return NOT_APPLIED('the gravity vector has no length');

    // Where the filter thinks down is, expressed in the body frame.
    const predicted = unit(rotateInverse(this.q, this.worldDown));
    if (!predicted) return NOT_APPLIED('the predicted gravity direction has no length');

    // ## The measurement model, derived rather than guessed
    //
    // With the **local** error convention this filter uses — `q_true = q ⊗ δq` — the measured
    // gravity in the body frame is `R(δq)ᵀ g_pred ≈ (I − [δθ]ₓ) g_pred`, so
    //
    //     z = g_meas − g_pred ≈ −[δθ]ₓ g_pred = [g_pred]ₓ δθ      ⇒   H = [g_pred]ₓ
    //
    // The first version of this file took `z` to be the *rotation vector* from the prediction to
    // the measurement and set `H = I`. That rotation vector is `−δθ`, not `+δθ`, so the filter
    // drove the attitude away from gravity instead of toward it and settled 180° out — which is
    // what the tests reported before the derivation above was written down.
    //
    // `[g_pred]ₓ` is rank 2 and its null space is `g_pred` itself, so rotation *about* gravity
    // is untouched by construction rather than by being masked out afterwards. A direction
    // cannot see rotation about itself, and this is that fact expressed as a matrix.
    const z = [
      (measured[0] ?? 0) - (predicted[0] ?? 0),
      (measured[1] ?? 0) - (predicted[1] ?? 0),
      (measured[2] ?? 0) - (predicted[2] ?? 0),
    ];
    const dot = Math.min(
      1,
      Math.max(-1, (predicted[0] ?? 0) * (measured[0] ?? 0) + (predicted[1] ?? 0) * (measured[1] ?? 0) + (predicted[2] ?? 0) * (measured[2] ?? 0)),
    );
    const innovationDeg = (Math.acos(dot) * 180) / Math.PI;

    const sk = skew(predicted);
    const h = new Array<number>(3 * N).fill(0);
    for (let r0 = 0; r0 < 3; r0++) {
      for (let c = 0; c < 3; c++) h[r0 * N + c] = sk[r0 * 3 + c] ?? 0;
    }
    // The noise is on a *unit direction*, so the angular figure converts through its sine.
    const s = Math.sin(GRAVITY_NOISE_RAD);
    const r = s * s;
    this.applyUpdate(h, z, [r, r, r]);
    return { innovationDeg, applied: true, reason: '' };
  }

  /** The Joseph-free but symmetrised Kalman update, for a 3-row measurement. */
  private applyUpdate(h: readonly number[], z: readonly number[], rDiag: readonly number[]): void {
    const ht = transpose(h, 3, N);
    const pht = multiplyMat(this.p, N, N, ht, N, 3);
    const s = multiplyMat(h, 3, N, pht, N, 3);
    for (let i = 0; i < 3; i++) s[i * 3 + i] = (s[i * 3 + i] ?? 0) + (rDiag[i] ?? 0);
    const sInv = invert3(s);
    if (!sInv) return;
    const k = multiplyMat(pht, N, 3, sInv, 3, 3);

    const dx = multiplyMat(k, N, 3, [z[0] ?? 0, z[1] ?? 0, z[2] ?? 0], 3, 1);
    this.q = normalise(multiply(this.q, fromRotationVector([dx[0] ?? 0, dx[1] ?? 0, dx[2] ?? 0])));
    this.bias = [
      (this.bias[0] ?? 0) + (dx[3] ?? 0),
      (this.bias[1] ?? 0) + (dx[4] ?? 0),
      (this.bias[2] ?? 0) + (dx[5] ?? 0),
    ];

    const kh = multiplyMat(k, N, 3, h, 3, N);
    const ikh = identity(N).map((v, i) => v - (kh[i] ?? 0));
    const next = multiply6(ikh, this.p);
    // Symmetrise: `(I−KH)P` is symmetric in exact arithmetic and drifts out of it in floating
    // point, and an asymmetric covariance produces a gain that is not a gain.
    this.p = next.map((_, i) => {
      const r = Math.floor(i / N);
      const c = i % N;
      return (((next[r * N + c] ?? 0) + (next[c * N + r] ?? 0)) / 2);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Small dense linear algebra, sized for this filter and no larger              */
/* -------------------------------------------------------------------------- */

function identity(n: number): number[] {
  const m = new Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) m[i * n + i] = 1;
  return m;
}

function skew(v: readonly number[]): number[] {
  const [x, y, z] = [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [0, -z, y, z, 0, -x, -y, x, 0];
}

function multiplyMat(
  a: readonly number[], ar: number, ac: number,
  b: readonly number[], br: number, bc: number,
): number[] {
  if (ac !== br) return [];
  const out = new Array<number>(ar * bc).fill(0);
  for (let i = 0; i < ar; i++) {
    for (let k = 0; k < ac; k++) {
      const aik = a[i * ac + k] ?? 0;
      if (aik === 0) continue;
      for (let j = 0; j < bc; j++) out[i * bc + j] = (out[i * bc + j] ?? 0) + aik * (b[k * bc + j] ?? 0);
    }
  }
  return out;
}

const multiply6 = (a: readonly number[], b: readonly number[]): number[] =>
  multiplyMat(a, N, N, b, N, N);

function transpose(m: readonly number[], rows: number, cols: number): number[] {
  const out = new Array<number>(rows * cols).fill(0);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out[c * rows + r] = m[r * cols + c] ?? 0;
  return out;
}

const transpose6 = (m: readonly number[]): number[] => transpose(m, N, N);

function addDiagonal(m: readonly number[], d: readonly number[]): number[] {
  const out = [...m];
  for (let i = 0; i < d.length; i++) out[i * N + i] = (out[i * N + i] ?? 0) + (d[i] ?? 0);
  return out;
}

/** 3×3 inverse by cofactors. `null` when the innovation covariance is singular. */
function invert3(m: readonly number[]): number[] | null {
  const g = (i: number): number => m[i] ?? 0;
  const a = g(4) * g(8) - g(5) * g(7);
  const b = -(g(3) * g(8) - g(5) * g(6));
  const c = g(3) * g(7) - g(4) * g(6);
  const det = g(0) * a + g(1) * b + g(2) * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  return [
    a * inv, -(g(1) * g(8) - g(2) * g(7)) * inv, (g(1) * g(5) - g(2) * g(4)) * inv,
    b * inv, (g(0) * g(8) - g(2) * g(6)) * inv, -(g(0) * g(5) - g(2) * g(3)) * inv,
    c * inv, -(g(0) * g(7) - g(1) * g(6)) * inv, (g(0) * g(4) - g(1) * g(3)) * inv,
  ];
}

/** Re-exported so the stage and the tests name the same world frame this file defines. */
export { betweenVectors };
