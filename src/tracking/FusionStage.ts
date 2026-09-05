/**
 * One Phase 7 frame, end to end, with no browser around it (v3 §17, §18, §19).
 *
 * The app calls this and adds nothing, for the same reason `FlowStage`, `VerificationStage` and
 * `PoseStage` exist: the Phase 7 test plan requires a "fusion" that returns the visual pose
 * unchanged to be *shown* to fail, and a unit test that reimplemented the loop to prove it would
 * be proving something about the reimplementation. `tests/unit/fusionStage.test.ts` drives this.
 *
 * ## What arrives, and at what rate
 *
 *  - **IMU samples at ~60 Hz**, on the main thread, where `devicemotion` fires. The device
 *    measured 60.02 Hz with `acceleration`, `accelerationIncludingGravity`, `rotationRate` and
 *    `interval` all present.
 *  - **Phase 6 pose reports at ~20 Hz**, from the worker, carrying a rotation *relative to
 *    Phase 5's verification anchor* — not an absolute attitude.
 *
 * Two filters run, on the same visual increments and the same gravity, differing only in that
 * one is fed the gyroscope with a known bias added. Neither is told which it is. That is
 * IMU-005, and it is the only measurement in this phase a fusion that ignores the IMU cannot
 * produce.
 *
 * ## Why the visual updates are spaced about a second apart
 *
 * Not for cost — the filter is a handful of 3×3 operations. The bias is observable through the
 * covariance coupling the propagation builds up, and the information a *visual* run collects
 * about it works out proportional to the **interval length**: over a total time `T` split into
 * intervals of `Δt`, the information is `T·Δt/σ²`. Halving the interval halves what the run
 * learns. At `Δt = 1 s` and Phase 6's measured accuracy, a minute of running resolves the bias to
 * about 0.4 °/s; at one visual frame per update it resolves it to 1.7 °/s, which cannot separate
 * a 3 °/s injection from nothing with a 1 °/s tolerance.
 *
 * ## Vision is not the only thing that observes the bias — measured, and it changes a gate
 *
 * Gravity is a two-degree-of-freedom measurement, so it looks like it should leave the bias
 * about the vertical unobservable. It does not, on a device that turns: the body axes move
 * relative to gravity, and over a minute all three body-frame components become observable
 * through it alone. Measured on this stage with **no visual updates at all** and a true bias of
 * (0.4, −0.9, 0.2) °/s, the filter recovered (0.400, −0.900, 0.200) °/s, and the injected twin's
 * difference came back 2.9996 °/s along the injected axis against 3.0 injected.
 *
 * That is why `biasDifferenceDps` is withheld until `MIN_BIAS_SAMPLES` **visual** updates have
 * been applied. Not because the estimate would be poor without them — it is excellent without
 * them — but because IMU-005 is the gate on a *fusion*, and a number a dead-reckoner can produce
 * cannot be that gate. The finding is recorded in `docs/phase7/TEST-PLAN.md` beside the record
 * it affects, with the measurement that forced it.
 *
 * `propagatedMs` is deliberately **not** measured from the filter's update cadence — it is
 * measured from the last time Phase 6 produced a pose at all, because that is what "vision has
 * stopped" means and it is what IMU-007 is about.
 */

import { OrientationEkf } from '../fusion/orientationEkf';
import { fusionConfidence } from './fusionConfidence';
import {
  IDENTITY,
  angleBetweenDeg,
  angleDeg,
  multiply,
  conjugate,
  fromRotationVector,
  normalise,
} from '../fusion/quat';
import type { Quat } from '../fusion/quat';
import { MIN_HAND_EYE_PAIRS, NO_HAND_EYE, estimateHandEye, rotateByHandEye } from '../fusion/handEye';
import type { HandEyeEstimate, HandEyePair, HandEyeRefusal } from '../fusion/handEye';
import { PoseState } from '../geometry/pose';
import type {
  ConfidenceTermRecord,
  FusionReport,
  ImuSample,
  PoseReport,
} from './trackingMessages';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase7/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/** IMU-005's ground truth: the bias the harness adds and does not disclose, °/s. */
export const GYRO_BIAS_INJECTION_DPS = 3.0;

/** ...on this axis. Seeded per session so a run cannot be right about one axis by luck. */
export const INJECTION_AXES: readonly (readonly number[])[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0.577, 0.577, 0.577],
];

/**
 * How long a visual interval the filter is given, ms.
 *
 * See the header: the information a run collects about the bias is proportional to this, so it
 * is as long as the pose stays coherent. Phase 5 re-anchors well inside a few seconds, and an
 * increment cannot be formed across a re-anchor, so a second is what is reliably available.
 */
export const VISUAL_UPDATE_INTERVAL_MS = 1000;

/**
 * Vision has stopped, rather than merely skipped a frame.
 *
 * Phase 6's device run produced a full pose on 1137 of 3001 frames at about 20 Hz, so ordinary
 * gaps between poses run to a couple of hundred milliseconds and the mode must not flip on
 * those. 500 ms is beyond routine and well inside the three seconds past which a propagated
 * orientation stops being worth as much as a measurement.
 */
export const DEAD_RECKONING_AFTER_MS = 500;

/** Past this the gyroscope alone is no better than a measurement — see the plan's derivation. */
export const MAX_PROPAGATION_MS = 3000;

/** ‖gravity‖ must be this close to 9.81 m/s² for the sample to be a gravity direction at all. */
export const GRAVITY_TOLERANCE_MS2 = 0.5;
export const GRAVITY_MS2 = 9.80665;

/**
 * Visual updates before the bias difference is **reported** at all.
 *
 * The plan's `MIN_BIAS_SAMPLES`, at the value it fixed: as GEO-003 and POSE-005 used. See the
 * header for why this gate is about IMU-005 being a fusion test rather than about the estimate's
 * quality — gravity alone estimates the bias perfectly well, which is exactly the problem.
 */
export const MIN_BIAS_SAMPLES = 10;

/**
 * The gravity disagreement at which `imuConsistency` reaches zero, degrees.
 *
 * `GRAVITY_NOISE_RAD` is the 5° the filter itself assigns a gravity measurement, so a
 * disagreement at three times that is not noise — it is the accelerometer and the filter
 * describing different vertical directions. Three times, for the same reason the visual limit
 * is three times Phase 6's agreement floor.
 */
export const GRAVITY_LIMIT_DEG = 15.0;

/** The largest gap between IMU samples that may be integrated across, ms. */
export const MAX_IMU_GAP_MS = 250;

/**
 * The innovation at which `imuConsistency` reaches zero, degrees.
 *
 * Three times Phase 6's `ROTATION_AGREEMENT_DEG`. The term has to be able to *fall* — IMU-004's
 * criterion 2 — which means it cannot saturate at the first sign of disagreement; and it has to
 * reach zero somewhere the two instruments are genuinely inconsistent rather than merely noisy.
 * Phase 6 already fixed 3° as the point where a visual and an inertial rotation stop agreeing,
 * so three times that is where they are not talking about the same motion at all.
 */
export const VISUAL_INNOVATION_LIMIT_DEG = 9.0;

export const FusionMode = {
  /** No IMU has reported. The fused pose *is* the visual pose — v3 §68's own pass condition. */
  VISION_ONLY: 'VISION_ONLY',
  FUSED: 'FUSED',
  /** Vision has stopped and the gyroscope is carrying the orientation alone. */
  DEAD_RECKONING: 'DEAD_RECKONING',
} as const;
export type FusionMode = (typeof FusionMode)[keyof typeof FusionMode];

const DEG = Math.PI / 180;

/**
 * The most rotation pairs kept for the calibration.
 *
 * The extrinsic is a constant of the hardware, so more pairs only refine it — but a run is
 * bounded and so is what it may hold. 240 pairs at one visual update every 200 ms is the last
 * minute of motion, which is far more than the estimate needs and cheap to keep.
 */
export const MAX_HAND_EYE_PAIRS = 240;

/** How many new pairs must arrive before the 4×4 eigenproblem is solved again. */
export const HAND_EYE_RESOLVE_EVERY = 10;

export class FusionStage {
  private readonly main = new OrientationEkf();
  /** IMU-005's twin: the same everything, with a known bias added to the gyroscope. */
  private readonly injected = new OrientationEkf();
  private readonly injectionAxis: readonly number[];

  private lastImuAt = -1;
  private imuSamples = 0;
  private gravitySamples = 0;
  private gravityRejected = 0;
  private lastGravityDeg = -1;

  /** Phase 6's last usable rotation, and when it arrived. */
  private lastVisualQ: Quat | null = null;
  private lastVisualAt = -1;
  private lastPoseAt = -1;
  /** The visual rotation accumulated since the filter's interval began. */
  private pendingQ: Quat | null = null;
  private pendingSince = -1;

  /* The device→camera rotation, and the pairs it is estimated from — see `fusion/handEye.ts`. */
  /** The gyroscope's net rotation over the current visual window, in the **device** frame. */
  private pendingGyroQ: Quat = IDENTITY;
  private readonly handEyePairs: HandEyePair[] = [];
  private handEye: HandEyeEstimate | HandEyeRefusal = NO_HAND_EYE;
  /** Pair count at the last solve, so the estimate is not re-solved on every visual update. */
  private handEyeSolvedAt = 0;
  /** IMU samples that arrived while the extrinsic was still unknown and so were not fused. */
  private uncalibratedSamples = 0;
  /**
   * The lowest confidence reported since the current open-loop run began, or `-1` between runs.
   *
   * An orientation running open-loop does not become more trustworthy while it runs: no new
   * visual information is arriving, which is the whole meaning of the state. But `overall` is the
   * minimum of terms and one of them — `imuConsistency` — keeps being *measured* through a
   * dropout, because the accelerometer is still reporting. Its gravity half can improve as the
   * filter settles, and when it is the smallest term the reported confidence follows it up.
   *
   * Measured on the fixture the moment its motion was made realistic: 0.8576 → 0.8578 between two
   * consecutive dead-reckoning frames, while `propagation` fell 0.9933 → 0.9867 exactly as it
   * should. Small, and still the wrong direction — v3 §17 limits how long a propagated
   * orientation is worth anything, and IMU-007 requires the confidence to fall the whole way.
   *
   * So while propagating, the reported confidence is the running minimum. It is not a new term
   * and it hides nothing: every term keeps its own value on the record, including the one that
   * rose.
   */
  private openLoopFloor = -1;
  private visualUpdates = 0;
  private lastInnovationDeg = -1;
  /** The twin's innovation on the same update — IMU-005 criterion 4. */
  private lastInjectedInnovationDeg = -1;
  /** The angle of the visual increment the last update was formed from, degrees. */
  private lastVisualIncrementDeg = -1;
  /** Phase 6's own confidence terms from the last frame that had a pose, carried not recomputed. */
  private lastVisualTerms: readonly ConfidenceTermRecord[] = [];
  private lastVisualConfidence = -1;

  /* IMU-006: what double integration would have produced, kept for the record only. */
  private deadPosition = [0, 0, 0];
  private deadVelocity = [0, 0, 0];
  private deadSeconds = 0;

  private frames = 0;
  /** IMU-008: what this stage spent since the last `report`, ms. Reset every frame. */
  private frameCostMs = 0;

  constructor(seed = 0) {
    this.injectionAxis =
      INJECTION_AXES[Math.abs(Math.floor(seed)) % INJECTION_AXES.length] ?? [1, 0, 0];
  }

  reset(): void {
    this.main.reset();
    this.injected.reset();
    this.lastImuAt = -1;
    this.imuSamples = 0;
    this.gravitySamples = 0;
    this.gravityRejected = 0;
    this.lastGravityDeg = -1;
    this.lastVisualQ = null;
    this.lastVisualAt = -1;
    this.lastPoseAt = -1;
    this.pendingQ = null;
    this.pendingSince = -1;
    this.pendingGyroQ = IDENTITY;
    this.handEyePairs.length = 0;
    this.handEye = NO_HAND_EYE;
    this.handEyeSolvedAt = 0;
    this.uncalibratedSamples = 0;
    this.openLoopFloor = -1;
    this.visualUpdates = 0;
    this.lastInnovationDeg = -1;
    this.lastInjectedInnovationDeg = -1;
    this.lastVisualIncrementDeg = -1;
    this.lastVisualTerms = [];
    this.lastVisualConfidence = -1;
    this.deadPosition = [0, 0, 0];
    this.deadVelocity = [0, 0, 0];
    this.deadSeconds = 0;
    this.frames = 0;
    this.frameCostMs = 0;
  }

  /** The bias this stage adds to the twin's gyroscope, rad/s. Never given to either filter. */
  private injectionVector(): number[] {
    return this.injectionAxis.map((c) => c * GYRO_BIAS_INJECTION_DPS * DEG);
  }

  /**
   * One `devicemotion` sample.
   *
   * `gravity` is `accelerationIncludingGravity − acceleration`, which iOS supplies well enough
   * that the Phase 6 device bundle's first sample gives ‖g‖ = 9.80 m/s². A sample whose gravity
   * magnitude is not near `g` was taken while the phone was accelerating, and its direction is
   * not a gravity direction — it is rejected rather than fed in with a larger noise, because a
   * measurement of the wrong quantity is not a noisy measurement of the right one.
   */
  /**
   * Re-solve the extrinsic when enough new pairs have arrived to change the answer.
   *
   * Re-solved rather than solved once: the first estimate is taken from the fewest pairs that
   * can constrain it, and every later one is taken from more. It is not re-solved on every
   * update, because Davenport's method is a 4×4 eigenproblem and the answer does not move
   * measurably for one more pair out of a hundred.
   */
  private solveHandEyeIfDue(): void {
    const n = this.handEyePairs.length;
    if (n < MIN_HAND_EYE_PAIRS) return;
    if (n - this.handEyeSolvedAt < HAND_EYE_RESOLVE_EVERY && this.handEye.rotation !== null) return;
    this.handEyeSolvedAt = n;
    const next = estimateHandEye(this.handEyePairs);
    // A refusal never replaces a standing estimate: the calibration is a property of how the
    // sensor is mounted, and it does not stop being known because the last few turns shared an
    // axis. What a refusal means is *not yet*, and only while there is no estimate at all.
    if (next.rotation !== null || this.handEye.rotation === null) this.handEye = next;
  }

  noteImu(s: ImuSample): void {
    const t0 = performance.now();
    this.noteImuInner(s);
    this.frameCostMs += performance.now() - t0;
  }

  private noteImuInner(s: ImuSample): void {
    if (!Number.isFinite(s.at)) return;

    // The gyroscope's own rotation over the current visual window, composed in the **device**
    // frame and never touched by the extrinsic. It is one half of the pair the calibration is
    // solved from, so it must stay in the frame it was measured in.
    const gyroDtMs = this.lastImuAt >= 0 ? s.at - this.lastImuAt : -1;
    if (gyroDtMs > 0 && gyroDtMs <= MAX_IMU_GAP_MS) {
      const dtS = gyroDtMs / 1000;
      this.pendingGyroQ = normalise(
        multiply(this.pendingGyroQ, fromRotationVector(s.rotationRate.map((w) => w * dtS))),
      );
    }

    const gravity = [
      (s.accelerationIncludingGravity[0] ?? 0) - (s.acceleration[0] ?? 0),
      (s.accelerationIncludingGravity[1] ?? 0) - (s.acceleration[1] ?? 0),
      (s.accelerationIncludingGravity[2] ?? 0) - (s.acceleration[2] ?? 0),
    ];
    const gMag = Math.hypot(gravity[0] ?? 0, gravity[1] ?? 0, gravity[2] ?? 0);
    const gravityUsable = Math.abs(gMag - GRAVITY_MS2) <= GRAVITY_TOLERANCE_MS2;

    // **Nothing is fused until the two frames are related by a measured rotation.**
    //
    // `rotationRate` and `gravity` are in the device's frame; the filter is corrected by Phase
    // 6's increment, which is in the camera's. Feeding one to the other with no rotation between
    // them is what the device run of 2026-08-29 did, and the filter answered by driving its bias
    // to 9.19 °/s and its attitude 33° off gravity. An identity extrinsic is not a neutral
    // default — it is an unmeasured claim that the sensor and the lens share axes.
    //
    // While it is unknown the filter is left uninitialised, so `gyroBiasDps` stays null and
    // `fusionModeFollowsFrom` derives VISION_ONLY from the report's own fields. The samples are
    // still read — they are what the calibration is solved from — and counted, so a run that
    // never calibrated says how much it declined rather than looking like a run with no sensors.
    const extrinsic = this.handEye.rotation;
    if (extrinsic === null) {
      this.uncalibratedSamples++;
      this.imuSamples++;
      this.lastImuAt = s.at;
      return;
    }
    // Into the camera's frame, where the state and the visual correction already live.
    const rotationRate = rotateByHandEye(extrinsic, s.rotationRate);
    const gravityCam = rotateByHandEye(extrinsic, gravity);

    if (!this.main.isInitialised()) {
      if (!gravityUsable) {
        this.gravityRejected++;
        this.lastImuAt = s.at;
        return;
      }
      // The world frame is *defined* by this reading — see `initialiseFrom`. No sign convention
      // for `accelerationIncludingGravity` is assumed, because the platforms disagree about it.
      this.main.initialiseFrom(gravityCam);
      this.injected.initialiseFrom(gravityCam);
      this.main.beginVisualInterval();
      this.injected.beginVisualInterval();
      this.lastImuAt = s.at;
      this.imuSamples++;
      return;
    }

    const dtMs = this.lastImuAt >= 0 ? s.at - this.lastImuAt : -1;
    this.lastImuAt = s.at;
    if (!(dtMs > 0) || dtMs > MAX_IMU_GAP_MS) return;
    const dt = dtMs / 1000;
    this.imuSamples++;

    // Both in the camera's frame now. The injection is applied **after** the rotation, so
    // IMU-005's injected axis is the axis the filter's own bias state is expressed in — the
    // device run's 25.78° axis error was the injection and the state being read in two frames.
    this.main.predict(rotationRate, dt);
    const b = this.injectionVector();
    this.injected.predict(rotationRate.map((w, i) => w + (b[i] ?? 0)), dt);

    if (gravityUsable) {
      this.gravitySamples++;
      const out = this.main.updateGravity(gravityCam);
      this.injected.updateGravity(gravityCam);
      if (out.applied) this.lastGravityDeg = out.innovationDeg;
    } else {
      this.gravityRejected++;
    }

    // IMU-006, for the record only. This never reaches the pose and never leaves this object as
    // anything but a *reason*: it is the drift that refusing to integrate avoids.
    this.deadSeconds += dt;
    for (let i = 0; i < 3; i++) {
      const a = s.acceleration[i] ?? 0;
      this.deadPosition[i] = (this.deadPosition[i] ?? 0) + (this.deadVelocity[i] ?? 0) * dt + 0.5 * a * dt * dt;
      this.deadVelocity[i] = (this.deadVelocity[i] ?? 0) + a * dt;
    }
  }

  /**
   * One Phase 6 pose report.
   *
   * Phase 6's rotation is relative to *Phase 5's* verification anchor, which moves. So the
   * increment between two reports is only formable while the anchor holds; across a re-anchor
   * the two rotations are measured from different origins and their difference means nothing.
   * `reAnchored` is why that frame is dropped rather than differenced.
   */
  notePose(pose: PoseReport, reAnchored: boolean, at: number): void {
    const t0 = performance.now();
    this.notePoseInner(pose, reAnchored, at);
    this.frameCostMs += performance.now() - t0;
  }

  private notePoseInner(pose: PoseReport, reAnchored: boolean, at: number): void {
    if (pose.state === PoseState.NO_POSE || !pose.quaternion) {
      // Vision produced nothing this frame. The interval keeps accumulating; `propagatedMs`
      // grows from `lastPoseAt`, which is what IMU-007 measures.
      //
      // **But the re-anchor is still true, and returning without it threw it away.**
      //
      // `reAnchored` is a fact about Phase 5's anchor, not about whether Phase 6 posed on the
      // same frame, and `main.ts` calls this on *every* frame precisely so the stage sees both.
      // Discarding it left `lastVisualQ` holding a quaternion measured against the old anchor
      // while the next pose is measured against the new one, so `step` became a difference
      // between two origins rather than a rotation — and went straight into `pendingQ`.
      //
      // The device run of 2026-09-05 09:54 recorded NO_POSE on 1971 of 4032 frames against 1445
      // re-anchors, so about half of them landed here. It lost 65 of 111 pairs to the angle
      // filter, against 58 of 97 before the interval fix above — which is how a correct fix
      // moved nothing: it was in a branch these re-anchors never reached.
      //
      // Dropping `lastVisualQ` sends the next posed frame through the restart branch below,
      // which is the one place that knows how to begin an interval.
      if (reAnchored) {
        this.lastVisualQ = null;
        this.lastVisualAt = -1;
        this.pendingQ = null;
        this.pendingSince = -1;
      }
      return;
    }
    const q = normalise([
      pose.quaternion[0] ?? 1,
      pose.quaternion[1] ?? 0,
      pose.quaternion[2] ?? 0,
      pose.quaternion[3] ?? 0,
    ]);
    this.lastPoseAt = at;

    if (reAnchored || !this.lastVisualQ || this.lastVisualAt < 0) {
      this.lastVisualQ = q;
      this.lastVisualAt = at;
      // The pending increment cannot span the re-anchor, so it starts again from here.
      this.pendingQ = null;
      this.pendingSince = at;
      // **And so must the gyroscope's**, or the pair stops being one motion seen twice.
      //
      // `pendingGyroQ` used to be cleared only where a pair is *pushed*, so after a re-anchor
      // its half spanned from the previous push while the visual half spanned from here — two
      // measurements of two different intervals, handed over as one turn. `PAIR_ANGLE_TOLERANCE`
      // exists to catch exactly that and did: the device run of 2026-09-05 offered 97 pairs and
      // lost **58** to the angle filter, having re-anchored 3347 times in 8101 frames while a
      // pair needs 1000 ms of held anchor. Nothing calibrated, so nothing fused, so five of the
      // nine records could not be evaluated at all.
      //
      // The invariant is one line long and now holds in one place: `pendingGyroQ` and `pendingQ`
      // cover the same interval, the one beginning at `pendingSince`.
      this.pendingGyroQ = IDENTITY;
      this.main.beginVisualInterval();
      this.injected.beginVisualInterval();
      return;
    }

    const step = multiply(conjugate(this.lastVisualQ), q);
    this.lastVisualQ = q;
    this.lastVisualAt = at;
    this.pendingQ = this.pendingQ ? normalise(multiply(this.pendingQ, step)) : step;
    if (this.pendingSince < 0) this.pendingSince = at;

    if (at - this.pendingSince < VISUAL_UPDATE_INTERVAL_MS) return;
    if (!this.main.isInitialised()) {
      // Vision-only: there is no filter to correct, and inventing one from absent sensors is
      // what IMU-002 forbids. The pair is still worth keeping — while the extrinsic is unknown
      // this is the *only* path by which it becomes known, and the filter is uninitialised
      // precisely because it is unknown.
      this.handEyePairs.push({ device: this.pendingGyroQ, camera: this.pendingQ });
      while (this.handEyePairs.length > MAX_HAND_EYE_PAIRS) this.handEyePairs.shift();
      this.pendingGyroQ = IDENTITY;
      this.solveHandEyeIfDue();
      this.pendingQ = null;
      this.pendingSince = at;
      return;
    }

    const increment = this.pendingQ;

    // One interval, seen twice: by the gyroscope in the device's frame and by Phase 6 in the
    // camera's. The pair is offered to the calibration whether or not the filter is running,
    // because until it *has* run the filter is not running for want of this.
    this.handEyePairs.push({ device: this.pendingGyroQ, camera: increment });
    while (this.handEyePairs.length > MAX_HAND_EYE_PAIRS) this.handEyePairs.shift();
    this.pendingGyroQ = IDENTITY;
    this.solveHandEyeIfDue();

    const out = this.main.updateVisualIncrement(increment);
    const outInjected = this.injected.updateVisualIncrement(increment);
    if (out.applied) {
      this.visualUpdates++;
      this.lastInnovationDeg = out.innovationDeg;
      this.lastVisualIncrementDeg = angleDeg(increment);
      // The twin is corrected by the same measurement, so its innovation is what is left after
      // it has absorbed the injected bias — IMU-005's fourth criterion, not a spare number.
      this.lastInjectedInnovationDeg = outInjected.applied ? outInjected.innovationDeg : -1;
    }
    this.pendingQ = null;
    this.pendingSince = at;
  }

  /**
   * The frame's fused state.
   *
   * `visual` is Phase 6's report for this frame, or `null` where it produced none. The stage takes
   * both the quaternion and the confidence *terms* from it, because the fused confidence carries
   * Phase 6's six through unrecomputed — see `fusionConfidence`.
   */
  report(now: number, visual: PoseReport | null): FusionReport {
    const t0 = performance.now();
    this.frames++;
    // Two different facts, and conflating them is how a bundle came to say "no IMU is reporting
    // on this run" beside `imuSamples: 9619` and a measured 50.71 Hz. `hasImu` is *the filter is
    // running on the IMU*; `imuReporting` is *the sensor is delivering*. They differ for exactly
    // one reason — the device→camera rotation is not measured yet — and that reason is the thing
    // a reader needs, so it is now what the withheld term says.
    const imuReporting = this.imuSamples > 0;
    const hasImu = imuReporting && this.main.isInitialised();
    const propagatedMs = this.lastPoseAt >= 0 ? Math.max(0, now - this.lastPoseAt) : -1;

    const mode: FusionMode = !hasImu
      ? FusionMode.VISION_ONLY
      : propagatedMs >= 0 && propagatedMs > DEAD_RECKONING_AFTER_MS
        ? FusionMode.DEAD_RECKONING
        : FusionMode.FUSED;

    if (visual && visual.quaternion && visual.quaternion.length === 4) {
      this.lastVisualTerms = visual.confidenceTerms;
      this.lastVisualConfidence = visual.confidence;
    }
    const visualQ: Quat | null =
      visual && visual.quaternion && visual.quaternion.length === 4
        ? normalise([
            visual.quaternion[0] ?? 1,
            visual.quaternion[1] ?? 0,
            visual.quaternion[2] ?? 0,
            visual.quaternion[3] ?? 0,
          ])
        : this.lastVisualQ;

    const state = this.main.state();
    // In vision-only the fused orientation **is** the visual orientation: nothing is invented
    // from sensors that are not reporting (IMU-002 criterion 2).
    const orientation: Quat | null = hasImu ? state.q : visualQ;
    const usable =
      mode !== FusionMode.DEAD_RECKONING || (propagatedMs >= 0 && propagatedMs <= MAX_PROPAGATION_MS);

    const biasDps = hasImu ? state.bias.map((b) => round(b / DEG, 5)) : null;
    const injectedState = this.injected.state();
    const biasDifferenceDps =
      hasImu && this.visualUpdates >= MIN_BIAS_SAMPLES
        ? injectedState.bias.map((b, i) => round((b - (state.bias[i] ?? 0)) / DEG, 5))
        : null;

    const confidence = fusionConfidence({
      visualTerms: this.lastVisualTerms,
      innovationDeg: this.lastInnovationDeg,
      gravityDeg: this.lastGravityDeg,
      innovationLimitDeg: VISUAL_INNOVATION_LIMIT_DEG,
      gravityLimitDeg: GRAVITY_LIMIT_DEG,
      propagatedMs,
      deadReckoningAfterMs: DEAD_RECKONING_AFTER_MS,
      maxPropagationMs: MAX_PROPAGATION_MS,
      hasImu,
      imuReporting,
      handEyeReason: 'reason' in this.handEye ? this.handEye.reason : '',
    });
    const imuTerm = confidence.terms.find((t) => t.name === 'imuConsistency');

    // While open-loop, the reported confidence is the running minimum — see `openLoopFloor`.
    // The terms above are untouched, so the record still shows which of them moved and how.
    let overall = confidence.overall;
    if (mode === FusionMode.DEAD_RECKONING && overall >= 0) {
      if (this.openLoopFloor >= 0) overall = Math.min(overall, this.openLoopFloor);
      this.openLoopFloor = overall;
    } else if (mode !== FusionMode.DEAD_RECKONING) {
      // Vision is back; the next open-loop run is scored from its own start.
      this.openLoopFloor = -1;
    }
    // IMU-008 charges this stage for everything it did on this frame — the IMU samples and the
    // pose alike, not just the report — and the accumulator restarts here so the next frame is
    // charged for its own work only.
    const fusionMs = round(this.frameCostMs + (performance.now() - t0), 4);
    this.frameCostMs = 0;

    return {
      frames: this.frames,
      mode,
      usable,
      orientation: orientation ? [...orientation] : null,
      gyroBiasDps: biasDps,
      // v3 §17 and v4 §19, as a value a later phase has to remove deliberately.
      position: null,
      positionReason:
        'the accelerometer reports m/s² and Phase 6’s translation is a unit direction in ' +
        'LOCAL_UNITS with no scale, so fusing them needs the scale — which is exactly the ' +
        'quantity a monocular camera does not have (v3 §15, §17; v4 §18, §19)',
      scale: 'UNKNOWN',
      heading: 'RELATIVE',
      innovationDeg: this.lastInnovationDeg,
      injectedInnovationDeg: this.lastInjectedInnovationDeg,
      visualIncrementDeg: this.lastVisualIncrementDeg,
      propagatedMs: round(propagatedMs, 1),
      gravityDeg: this.lastGravityDeg,
      handEye: {
        // Rule 002: the state the fusion is actually in, as a value. A run that never
        // calibrated must not be indistinguishable on the record from a run with no sensors.
        calibrated: this.handEye.rotation !== null,
        rotation: this.handEye.rotation ? [...this.handEye.rotation] : null,
        pairs: this.handEye.pairs,
        axisSpread: round(this.handEye.axisSpread, 4),
        residualDeg: 'residualDeg' in this.handEye ? round(this.handEye.residualDeg, 3) : -1,
        reason: 'reason' in this.handEye ? this.handEye.reason : 'measured from paired rotations',
        uncalibratedSamples: this.uncalibratedSamples,
        // Which filter took the pairs that did not contribute. Without this a stalled run
        // reports a live gyroscope, healthy vision and "5 usable pairs", and says nothing about
        // what to do differently — which is what the device run of 2026-09-05 did for eleven
        // minutes.
        rejections: this.handEye.rejections,
      },
      imuConsistency: imuTerm ? imuTerm.value : -1,
      confidence: overall,
      confidenceTerms: confidence.terms,
      confidenceWithheld: confidence.withheld,
      // Phase 6's own number, unedited, beside the fused one — IMU-004's comparison is then a
      // reading rather than a re-derivation.
      visualConfidence: this.lastVisualConfidence,
      visualUpdates: this.visualUpdates,
      imuSamples: this.imuSamples,
      gravitySamples: this.gravitySamples,
      gravityRejected: this.gravityRejected,
      orientationVarianceDeg: hasImu
        ? round((Math.sqrt(Math.max(0, (state.variance[0] ?? 0) + (state.variance[1] ?? 0) + (state.variance[2] ?? 0))) * 180) / Math.PI, 4)
        : -1,
      biasDifferenceDps,
      injectedBiasDps: hasImu ? injectedState.bias.map((b) => round(b / DEG, 5)) : null,
      requestedInjectionDps: GYRO_BIAS_INJECTION_DPS,
      injectionAxis: [...this.injectionAxis],
      deadReckonedPositionM: round(
        Math.hypot(this.deadPosition[0] ?? 0, this.deadPosition[1] ?? 0, this.deadPosition[2] ?? 0),
        4,
      ),
      deadReckonedSeconds: round(this.deadSeconds, 2),
      fusedVsVisualDeg:
        hasImu && visualQ && orientation ? round(angleBetweenDeg(orientation, visualQ), 4) : -1,
      fusionMs,
    };
  }
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
