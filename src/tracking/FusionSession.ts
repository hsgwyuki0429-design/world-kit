/**
 * Everything Phase 7 needs to answer IMU-001..009, accumulated across a run.
 *
 * Runs on the main thread, and unlike Phases 4–6 that is not an implementation detail — it is
 * where the sensors *are*. `devicemotion` fires on the main thread, the worker never sees it,
 * and Phase 6's pose comes back from the worker having been computed without it. The two
 * instruments meet here for the first time, which is exactly why the fusion is decidable: a
 * pose solver that could read the gyroscope could agree with it without recovering anything.
 *
 * Three things happen here that do not happen in `FusionStage`:
 *
 *  - **the mode is recomputed** from the inputs the stage reported, and every frame where the
 *    two answers differ is counted (Rule 002, for the fourth phase running);
 *  - **the sensor inventory** is kept, so IMU-001 and IMU-002 are decided by what actually
 *    arrived rather than by what the platform advertised;
 *  - **the dropout intervals are assembled**, because IMU-007 is about a *run* of frames and no
 *    single frame can see one.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import {
  DEAD_RECKONING_AFTER_MS,
  FusionMode,
  GYRO_BIAS_INJECTION_DPS,
  MAX_PROPAGATION_MS,
} from './FusionStage';
import { ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION } from './PoseSession';
import { fusionModeFollowsFrom, usableFollowsFrom } from './fusionStats';
import type {
  BiasDifferenceSample,
  DropoutSample,
  FusionStats,
  SensorChannel,
} from './fusionStats';
import type { FusionReport, ImuSample } from './trackingMessages';

const MAX_SAMPLES = 400;

/**
 * §17's channels, named once.
 *
 * Six, and only four of them are read. The last two are listed because an inventory that named
 * only what this phase uses could not record a *refusal*: `webkitCompassHeading` exists on this
 * platform and Phase 7 does not consume it, so the heading is `RELATIVE` rather than absolute,
 * and IMU-009 checks that claim against this list rather than against a comment.
 */
export const SENSOR_CHANNELS = [
  'acceleration',
  'accelerationIncludingGravity',
  'rotationRate',
  'interval',
  'deviceorientation',
  'magnetometer',
] as const;

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}

function trim(list: unknown[], max = MAX_SAMPLES): void {
  while (list.length > max) list.shift();
}

/** A dropout being assembled. Becomes a `DropoutSample` when vision returns or the run ends. */
interface OpenDropout {
  startedAt: number;
  longestPropagatedMs: number;
  frames: number;
  confidenceAtStart: number;
  confidenceAtEnd: number;
  rises: number;
  usableBeyondMax: number;
  lastConfidence: number;
}

export class FusionSession {
  private readonly innovations: number[] = [];
  private readonly injectedInnovations: number[] = [];
  private readonly visualIncrements: number[] = [];
  private readonly fusedVsVisual: number[] = [];
  private readonly consistencies: number[] = [];
  private readonly gravityDegs: number[] = [];
  private readonly costs: number[] = [];
  private readonly biasDifferences: BiasDifferenceSample[] = [];
  private readonly biasMagnitudes: number[] = [];
  private readonly biasAxisErrors: number[] = [];
  private readonly dropouts: DropoutSample[] = [];
  private readonly reconvergenceInnovations: number[] = [];
  private readonly modeFrames = new Map<string, number>();

  /** Which channels have actually delivered a finite value. Never what the platform advertised. */
  private readonly seen = new Map<string, boolean>();
  private imuAvailable = false;
  private imuReason = 'no devicemotion event has arrived yet';
  private imuEvents = 0;
  private firstImuAt = -1;
  private lastImuAt = -1;
  private reportedIntervalSum = 0;
  private reportedIntervalCount = 0;

  private fusionFrames = 0;
  private fusedFrames = 0;
  private propagatingFrames = 0;
  private dropoutFrames = 0;
  private longestPropagatedMs = -1;
  private modeMismatches = 0;
  private usableMismatches = 0;
  private zeroInnovationSamples = 0;
  private innovationsWithinTolerance = 0;
  private zeroFusedVsVisualFrames = 0;
  private imuConsistencyBelowOne = 0;
  private confidenceAboveWorstTerm = 0;
  private fusedAboveVisual = 0;
  private positionsReported = 0;
  private scaleViolations = 0;
  private eulerEmitted = 0;
  private biasZeroWithoutGyro = 0;
  private rateOutOfRange = 0;
  private lastVisualUpdates = 0;
  private open: OpenDropout | null = null;
  /** True while a dropout has ended but its first corrected update has not yet arrived. */
  private awaitingReconvergence: DropoutSample | null = null;
  private last: FusionReport | null = null;

  reset(): void {
    for (const l of [
      this.innovations, this.injectedInnovations, this.visualIncrements, this.fusedVsVisual,
      this.consistencies, this.gravityDegs, this.costs, this.biasMagnitudes, this.biasAxisErrors,
      this.reconvergenceInnovations,
    ]) l.length = 0;
    this.biasDifferences.length = 0;
    this.dropouts.length = 0;
    this.modeFrames.clear();
    this.seen.clear();
    this.imuAvailable = false;
    this.imuReason = 'no devicemotion event has arrived yet';
    this.imuEvents = 0;
    this.firstImuAt = -1;
    this.lastImuAt = -1;
    this.reportedIntervalSum = 0;
    this.reportedIntervalCount = 0;
    this.fusionFrames = 0;
    this.fusedFrames = 0;
    this.propagatingFrames = 0;
    this.dropoutFrames = 0;
    this.longestPropagatedMs = -1;
    this.modeMismatches = 0;
    this.usableMismatches = 0;
    this.zeroInnovationSamples = 0;
    this.innovationsWithinTolerance = 0;
    this.zeroFusedVsVisualFrames = 0;
    this.imuConsistencyBelowOne = 0;
    this.confidenceAboveWorstTerm = 0;
    this.fusedAboveVisual = 0;
    this.positionsReported = 0;
    this.scaleViolations = 0;
    this.eulerEmitted = 0;
    this.biasZeroWithoutGyro = 0;
    this.rateOutOfRange = 0;
    this.lastVisualUpdates = 0;
    this.open = null;
    this.awaitingReconvergence = null;
    this.last = null;
  }

  /**
   * One `devicemotion` sample, for the inventory only — the filtering happens in `FusionStage`.
   *
   * A channel counts as arriving when it has delivered a finite value at least once. A platform
   * that fires the event with every field `null` — which is what a denied permission looks like
   * on some builds — leaves every channel absent, and IMU-002 is then decided on that rather
   * than on `DeviceMotionEvent` merely existing.
   */
  noteImu(s: ImuSample): void {
    this.imuEvents++;
    if (this.firstImuAt < 0) this.firstImuAt = s.at;
    this.lastImuAt = s.at;
    if (channelPresent(s.acceleration)) this.seen.set('acceleration', true);
    if (channelPresent(s.accelerationIncludingGravity)) {
      this.seen.set('accelerationIncludingGravity', true);
    }
    if (channelPresent(s.rotationRate)) this.seen.set('rotationRate', true);
    if (s.interval > 0) {
      this.seen.set('interval', true);
      this.reportedIntervalSum += s.interval;
      this.reportedIntervalCount++;
    }
    if (this.seen.get('rotationRate')) {
      this.imuAvailable = true;
      this.imuReason = 'devicemotion is delivering finite rotationRate values';
    }
  }

  /** Record that the IMU is not available, with the reason a `PENDING` verdict will carry. */
  noteImuUnavailable(reason: string): void {
    this.imuAvailable = false;
    this.imuReason = reason;
  }

  /** Record that `deviceorientation` is arriving. Phase 7 does not consume it; the record does. */
  noteOrientationChannel(arriving: boolean): void {
    this.seen.set('deviceorientation', arriving);
  }

  /** One fused frame. `now` is the frame clock the report's `propagatedMs` was measured against. */
  record(r: FusionReport, now: number): void {
    this.last = r;
    this.fusionFrames++;
    this.modeFrames.set(r.mode, (this.modeFrames.get(r.mode) ?? 0) + 1);

    if (fusionModeFollowsFrom(r) !== r.mode) this.modeMismatches++;
    if (usableFollowsFrom(r) !== r.usable) this.usableMismatches++;

    if (r.mode === FusionMode.FUSED) this.fusedFrames++;
    if (r.mode !== FusionMode.VISION_ONLY && r.propagatedMs > 0) this.propagatingFrames++;
    if (r.propagatedMs > this.longestPropagatedMs) this.longestPropagatedMs = r.propagatedMs;

    /* ---- IMU-006: there is no tolerance on this one ---- */
    if (r.position !== null) this.positionsReported++;
    if (r.scale !== 'UNKNOWN') this.scaleViolations++;

    /* ---- IMU-009 ---- */
    // §18: a quaternion has four components. A three-component orientation is an Euler triple,
    // and finding one anywhere is the failure — checked on the value, not on the field's name.
    if (r.orientation !== null && r.orientation.length !== 4) this.eulerEmitted++;
    if (!this.imuAvailable && r.gyroBiasDps !== null) this.biasZeroWithoutGyro++;
    for (const rate of [r.confidence, r.imuConsistency, r.visualConfidence]) {
      if (rate !== -1 && (rate < 0 || rate > 1)) this.rateOutOfRange++;
    }

    /* ---- IMU-004 ---- */
    const worst = r.confidenceTerms
      .filter((t) => t.value >= 0)
      .reduce((a, t) => Math.min(a, t.value), Number.POSITIVE_INFINITY);
    if (Number.isFinite(worst) && r.confidence > worst + 1e-9) this.confidenceAboveWorstTerm++;
    if (r.visualConfidence >= 0 && r.confidence > r.visualConfidence + 1e-9) this.fusedAboveVisual++;
    if (r.imuConsistency >= 0) {
      this.consistencies.push(r.imuConsistency);
      trim(this.consistencies);
      if (r.imuConsistency < 1) this.imuConsistencyBelowOne++;
    }
    if (r.gravityDeg >= 0) {
      this.gravityDegs.push(r.gravityDeg);
      trim(this.gravityDegs);
    }

    /* ---- IMU-007: dropouts are runs of frames, so they are assembled here ---- */
    if (r.mode === FusionMode.DEAD_RECKONING) {
      this.dropoutFrames++;
      if (!this.open) {
        this.open = {
          startedAt: now,
          longestPropagatedMs: r.propagatedMs,
          frames: 0,
          confidenceAtStart: r.confidence,
          confidenceAtEnd: r.confidence,
          rises: 0,
          usableBeyondMax: 0,
          lastConfidence: r.confidence,
        };
      }
      const open = this.open;
      open.frames++;
      open.longestPropagatedMs = Math.max(open.longestPropagatedMs, r.propagatedMs);
      open.confidenceAtEnd = r.confidence;
      if (r.confidence > open.lastConfidence + 1e-9) open.rises++;
      open.lastConfidence = r.confidence;
      if (r.propagatedMs > MAX_PROPAGATION_MS && r.usable) open.usableBeyondMax++;
    } else if (this.open) {
      // Vision is back. The interval is complete except for its reconvergence innovation, which
      // arrives on the next applied update — so it waits rather than being closed with a −1.
      this.awaitingReconvergence = { ...this.open, reconvergenceInnovationDeg: -1 };
      this.open = null;
    }

    /* ---- IMU-003: one sample per *applied update*, not per frame ---- */
    if (r.visualUpdates > this.lastVisualUpdates && r.innovationDeg >= 0) {
      this.lastVisualUpdates = r.visualUpdates;
      this.innovations.push(r.innovationDeg);
      this.visualIncrements.push(r.visualIncrementDeg);
      trim(this.innovations);
      trim(this.visualIncrements);
      if (r.innovationDeg === 0) this.zeroInnovationSamples++;
      const tolerance = Math.max(
        ROTATION_AGREEMENT_DEG,
        ROTATION_AGREEMENT_FRACTION * Math.max(0, r.visualIncrementDeg),
      );
      if (r.innovationDeg <= tolerance) this.innovationsWithinTolerance++;
      if (r.injectedInnovationDeg >= 0) {
        this.injectedInnovations.push(r.injectedInnovationDeg);
        trim(this.injectedInnovations);
      }
      // IMU-007 criterion 5: the first correction after vision returned, recorded rather than
      // absorbed. A filter that snaps back without noting the jump is not reporting reconvergence.
      if (this.awaitingReconvergence) {
        this.dropouts.push({
          ...this.awaitingReconvergence,
          reconvergenceInnovationDeg: r.innovationDeg,
        });
        trim(this.dropouts, 64);
        this.reconvergenceInnovations.push(r.innovationDeg);
        trim(this.reconvergenceInnovations);
        this.awaitingReconvergence = null;
      }
    }

    if (r.fusedVsVisualDeg >= 0) {
      this.fusedVsVisual.push(r.fusedVsVisualDeg);
      trim(this.fusedVsVisual);
      if (r.fusedVsVisualDeg === 0) this.zeroFusedVsVisualFrames++;
    }

    /* ---- IMU-005: the gate ---- */
    if (r.biasDifferenceDps) {
      const d = r.biasDifferenceDps;
      const magnitude = Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);
      const sample: BiasDifferenceSample = {
        at: now,
        differenceDps: [...d],
        magnitudeDps: round(magnitude, 4),
        axisErrorDeg: round(angleToAxis(d, r.injectionAxis), 3),
        visualUpdates: r.visualUpdates,
      };
      this.biasDifferences.push(sample);
      this.biasMagnitudes.push(magnitude);
      this.biasAxisErrors.push(sample.axisErrorDeg);
      trim(this.biasDifferences, 64);
      trim(this.biasMagnitudes);
      trim(this.biasAxisErrors);
    }

    if (r.fusionMs >= 0) {
      this.costs.push(r.fusionMs);
      trim(this.costs);
    }
  }

  getLast(): FusionReport | null {
    return this.last;
  }

  /** The IMU's delivered rate, measured over the run. `-1` before two samples. */
  measuredImuHz(): number {
    if (this.imuEvents < 2 || this.lastImuAt <= this.firstImuAt) return -1;
    return round(((this.imuEvents - 1) * 1000) / (this.lastImuAt - this.firstImuAt), 2);
  }

  private sensors(): SensorChannel[] {
    return SENSOR_CHANNELS.map((name) => ({
      name,
      arriving: this.seen.get(name) === true,
      detail:
        this.seen.get(name) === true
          ? 'delivering finite values'
          : name === 'magnetometer'
            ? 'not read by Phase 7 at all — the heading is RELATIVE for that reason, and v3 ' +
              '§17 does not require an absolute one'
            : name === 'deviceorientation'
              ? 'not consumed: it is a fused attitude the platform computed, and consuming it ' +
                'would make the filter agree with itself rather than with the sensors'
              : 'no finite value has arrived on this channel',
    }));
  }

  /** All the dropouts, including one still open — the run may end inside a dropout. */
  private allDropouts(): DropoutSample[] {
    const list = [...this.dropouts];
    if (this.awaitingReconvergence) list.push(this.awaitingReconvergence);
    if (this.open) list.push({ ...this.open, reconvergenceInnovationDeg: -1 });
    return list;
  }

  stats(running: boolean): FusionStats {
    const r = this.last;
    const drops = this.allDropouts();
    const biasMagnitude = r?.gyroBiasDps
      ? Math.hypot(r.gyroBiasDps[0] ?? 0, r.gyroBiasDps[1] ?? 0, r.gyroBiasDps[2] ?? 0)
      : -1;

    return {
      running,
      fusionFrames: this.fusionFrames,

      mode: r?.mode ?? FusionMode.VISION_ONLY,
      usable: r?.usable ?? true,
      orientation: r?.orientation ?? null,
      gyroBiasDps: r?.gyroBiasDps ?? null,
      position: null,
      positionReason:
        r?.positionReason ??
        'no fused frame has been produced yet; the position is null in every one of them',
      velocityReason:
        'velocity is refused for the same reason as position: integrating an acceleration ' +
        'gives a velocity in m/s, and there is nothing in LOCAL_UNITS to correct it against ' +
        '(v3 §17, §18). It is absent rather than reported as zero',
      accelBiasReason:
        'accelerometer bias is not observable without position observability, and position is ' +
        'refused — so estimating it would be estimating a quantity nothing can correct (v3 §18)',
      scale: r?.scale ?? 'UNKNOWN',
      heading: r?.heading ?? 'RELATIVE',
      innovationDeg: r?.innovationDeg ?? -1,
      propagatedMs: r?.propagatedMs ?? -1,
      gravityDeg: r?.gravityDeg ?? -1,
      imuConsistency: r?.imuConsistency ?? -1,
      confidence: r?.confidence ?? -1,
      confidenceTerms: r?.confidenceTerms ?? [],
      confidenceWithheld: r?.confidenceWithheld ?? [],
      visualConfidence: r?.visualConfidence ?? -1,

      sensors: this.sensors(),
      imuAvailable: this.imuAvailable,
      imuReason: this.imuReason,
      imuSamples: r?.imuSamples ?? 0,
      measuredImuHz: this.measuredImuHz(),
      reportedImuHz:
        this.reportedIntervalCount > 0 && this.reportedIntervalSum > 0
          ? round(this.reportedIntervalCount / this.reportedIntervalSum, 2)
          : -1,
      gravitySamples: r?.gravitySamples ?? 0,
      gravityRejected: r?.gravityRejected ?? 0,
      fusedFrames: this.fusedFrames,
      propagatingFrames: this.propagatingFrames,
      biasMagnitudeDps: round(biasMagnitude, 4),
      biasReason:
        this.biasDifferences.length > 0
          ? 'estimated from the gyroscope’s disagreement with vision over the visual intervals ' +
            'and with gravity throughout — measured, both routes observe all three components on ' +
            'a device that turns'
          : this.imuAvailable
            ? 'not enough visual updates have accumulated for the estimate to mean anything yet'
            : 'no gyroscope is reporting, so the bias is unmeasured — and therefore absent, not zero',

      modeFrames: Object.fromEntries(this.modeFrames),
      modeMismatches: this.modeMismatches + this.usableMismatches,

      innovationSamples: this.innovations.length,
      medianInnovationDeg: round(median(this.innovations)),
      maxInnovationDeg: this.innovations.length > 0 ? round(Math.max(...this.innovations)) : -1,
      zeroInnovationSamples: this.zeroInnovationSamples,
      medianVisualIncrementDeg: round(median(this.visualIncrements)),
      toleranceDeg: round(
        Math.max(
          ROTATION_AGREEMENT_DEG,
          ROTATION_AGREEMENT_FRACTION * Math.max(0, median(this.visualIncrements)),
        ),
      ),
      innovationsWithinTolerance: this.innovationsWithinTolerance,
      fusedVsVisualSamples: this.fusedVsVisual.length,
      medianFusedVsVisualDeg: round(median(this.fusedVsVisual)),
      maxFusedVsVisualDeg:
        this.fusedVsVisual.length > 0 ? round(Math.max(...this.fusedVsVisual)) : -1,
      zeroFusedVsVisualFrames: this.zeroFusedVsVisualFrames,

      imuConsistencySamples: this.consistencies.length,
      medianImuConsistency: round(median(this.consistencies), 4),
      minImuConsistency:
        this.consistencies.length > 0 ? round(Math.min(...this.consistencies), 4) : -1,
      imuConsistencyBelowOne: this.imuConsistencyBelowOne,
      gravityDegSamples: this.gravityDegs.length,
      medianGravityDeg: round(median(this.gravityDegs)),
      confidenceAboveWorstTerm: this.confidenceAboveWorstTerm,
      fusedAboveVisual: this.fusedAboveVisual,

      biasSamples: this.biasMagnitudes.length,
      medianBiasDifferenceDps: round(median(this.biasMagnitudes), 4),
      medianBiasAxisErrorDeg: round(median(this.biasAxisErrors)),
      requestedInjectionDps: GYRO_BIAS_INJECTION_DPS,
      injectionAxis: r?.injectionAxis ?? [],
      medianInjectedInnovationDeg: round(median(this.injectedInnovations)),
      biasDifferences: [...this.biasDifferences],

      positionsReported: this.positionsReported,
      scaleViolations: this.scaleViolations,
      deadReckonedPositionM: r?.deadReckonedPositionM ?? -1,
      deadReckonedSeconds: r?.deadReckonedSeconds ?? -1,

      dropoutFrames: this.dropoutFrames,
      longestPropagatedMs: round(this.longestPropagatedMs, 1),
      dropouts: drops,
      dropoutConfidenceRises: drops.reduce((a, d) => a + d.rises, 0),
      usableBeyondMax: drops.reduce((a, d) => a + d.usableBeyondMax, 0),
      reconvergences: this.reconvergenceInnovations.length,
      medianReconvergenceInnovationDeg: round(median(this.reconvergenceInnovations)),

      meanFusionMs:
        this.costs.length > 0
          ? round(this.costs.reduce((a, b) => a + b, 0) / this.costs.length, 4)
          : -1,
      fusionCostSamples: this.costs.length,

      eulerEmitted: this.eulerEmitted,
      biasZeroWithoutGyro: this.biasZeroWithoutGyro,
      rateOutOfRange: this.rateOutOfRange,
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe(this.stats(false)) as Record<string, JsonValue>;
  }
}

/**
 * Whether a channel actually delivered a reading.
 *
 * A three-vector of finite numbers. The listener supplies an **empty** array for a channel the
 * event left `null`, rather than zeros, precisely so this can tell "the sensor reported nothing"
 * from "the sensor reported nothing *moving*" — a stationary phone reports a real `[0,0,0]`
 * rotation rate, and treating that as an absent channel would make a phone on a table look like
 * a phone with no gyroscope.
 */
function channelPresent(v: readonly number[]): boolean {
  return v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * Angle between a measured bias difference and the axis it was injected along, degrees.
 *
 * IMU-005's third criterion. A filter that recovered the right *magnitude* along the wrong axis
 * has not found the injection — it has found something else the same size, which on a device
 * with real motion is entirely possible. `-1` where either vector is too small to have a
 * direction, so a near-zero difference reports "no direction" rather than an arbitrary angle.
 */
export function angleToAxis(v: readonly number[], axis: readonly number[]): number {
  const vm = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  const am = Math.hypot(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0);
  if (vm < 1e-9 || am < 1e-9) return -1;
  const dot = (v[0] ?? 0) * (axis[0] ?? 0) + (v[1] ?? 0) * (axis[1] ?? 0) + (v[2] ?? 0) * (axis[2] ?? 0);
  const c = Math.max(-1, Math.min(1, dot / (vm * am)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Re-exported so the screen and the tests name one window and one threshold. */
export { DEAD_RECKONING_AFTER_MS, MAX_PROPAGATION_MS };
