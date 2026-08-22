/**
 * Everything Phase 4 needs to answer FLOW-001..007, accumulated across a run.
 *
 * Runs on the main thread and takes the message shape rather than the tracker's own, because
 * the message is all that crossed. Nothing here recomputes anything the worker measured —
 * with exactly one deliberate exception: **§33's state is recomputed from the inputs the
 * worker reported**, and every frame where the two answers differ is counted. That is
 * Phase 3's `stateMismatches` idea applied to a state with six inputs instead of one, and it
 * is the mechanism that keeps the number on the screen and the state beside it from being
 * able to disagree (Rule 002).
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { deriveTrackingState, TrackingState } from './trackingState';
import { FrameMotion, MIN_SHIFT_CONFIDENCE, shiftAgreementTolerance } from './SceneShift';
import type { FeatureRecordSample, TrackingFlow, TrackingResult } from './trackingMessages';
import { EMPTY_CLASS } from './flowStats';
import type { FlowStats, MotionClassStats, OcclusionEpisode, ShiftCrossCheck } from './flowStats';

/**
 * Trailing window over which gyroscope rotation is integrated for FLOW-003.
 *
 * The test plan asks for "frames with integrated gyro rotation ≥ 5°" and does not name the
 * window, so it is fixed here with the reasoning recorded, as the confidence floor was. One
 * second: long enough that a 5° threshold describes a deliberate slow turn rather than hand
 * shake, short enough that the frames it marks are the frames that were actually rotating
 * rather than a run that rotated once at the start. `rotationRate` measured AVAILABLE at
 * 60 Hz in Phase 0, so a one-second window holds about 60 samples.
 */
export const ROTATION_WINDOW_MS = 1000;
/** ...and the rotation in that window that makes a frame a rotating one. */
export const ROTATING_DEG = 5;

/** How many per-frame records to keep for the evidence. Bounded by §56. */
const MAX_SAMPLES = 400;

interface ClassAccumulator {
  survival: number[];
  displacement: number[];
  fbError: number[];
  tracked: number[];
  cellSpread: number[];
  rejectFraction: number[];
  lost: number;
  degraded: number;
}

function newAccumulator(): ClassAccumulator {
  return {
    survival: [], displacement: [], fbError: [], tracked: [], cellSpread: [], rejectFraction: [],
    lost: 0, degraded: 0,
  };
}

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

function trim(list: number[], max = MAX_SAMPLES): void {
  while (list.length > max) list.shift();
}

/** A gyroscope sample as the main thread receives it: degrees per second, at a moment. */
export interface RotationSample {
  readonly at: number;
  readonly degPerSecond: number;
}

export class FlowSession {
  private readonly byMotion = new Map<FrameMotion, ClassAccumulator>();
  private readonly shiftChecks: ShiftCrossCheck[] = [];
  private readonly flowCosts: number[] = [];
  private readonly shiftCosts: number[] = [];
  private readonly trackedCounts: number[] = [];
  /** Every frame's median §13 round trip, so the run-level figure is not the last frame's. */
  private readonly fbErrors: number[] = [];
  private readonly stateFrames = new Map<string, number>();
  private readonly occlusions: OcclusionEpisode[] = [];

  /** Rotating vs translating flow-field spreads, kept apart for FLOW-003's comparison. */
  private readonly spreadRotating: number[] = [];
  private readonly spreadTranslating: number[] = [];
  private readonly rotationDegrees: number[] = [];
  private readonly rotatingSurvival: number[] = [];
  private readonly rotatingFbError: number[] = [];

  private flowFrames = 0;
  private trackedFrames = 0;
  private cumulativeTracked = 0;
  private cumulativeRedetected = 0;
  private maxTrackLength = 0;
  private stateMismatches = 0;
  private fbAcceptable = 0;
  private fbReduced = 0;
  private fbRejected = 0;
  private indeterminateFrames = 0;
  private lastFlow: TrackingFlow | null = null;
  private lastRecordSamples: readonly FeatureRecordSample[] = [];

  /* Occlusion tracking (FLOW-005) */
  private occlusionStartedAt = -1;
  private occlusionFrames = 0;
  private occlusionLostAt = -1;
  private occlusionSurvivedWithGoodFb = 0;
  private pendingRecovery: { episode: number; startedAt: number } | null = null;

  /* Gyroscope (FLOW-003) */
  private rotationSamples: RotationSample[] = [];
  private gyroAvailable = false;
  private gyroReason = 'no devicemotion listener has been attached yet';

  /**
   * Tell the session what the gyroscope is doing.
   *
   * The main thread owns the sensor — the worker has no `window` — so the pairing of a flow
   * frame with a rotation happens here, at the moment the frame's result arrives. FLOW-003
   * needs a *second independent instrument*, and this is it: the scene shift measures the
   * image, the gyroscope measures the device, and neither is the tracker.
   */
  noteRotation(sample: RotationSample): void {
    this.rotationSamples.push(sample);
    this.gyroAvailable = true;
    this.gyroReason = '';
    const cutoff = sample.at - ROTATION_WINDOW_MS;
    while (this.rotationSamples.length > 0 && (this.rotationSamples[0]?.at ?? 0) < cutoff) {
      this.rotationSamples.shift();
    }
  }

  /** Record why the gyroscope is not contributing, so FLOW-003 can be PENDING with a reason. */
  noteGyroUnavailable(reason: string): void {
    if (this.gyroAvailable) return;
    this.gyroReason = reason;
  }

  isGyroAvailable(): boolean {
    return this.gyroAvailable;
  }

  /**
   * Rotation integrated over the trailing window, in degrees.
   *
   * A trapezoid over the samples actually received rather than a rate times an assumed
   * interval — the event rate is the platform's to decide and Phase 0 measured it rather
   * than assuming it.
   */
  integratedRotationDeg(now: number): number {
    const cutoff = now - ROTATION_WINDOW_MS;
    let total = 0;
    for (let i = 1; i < this.rotationSamples.length; i++) {
      const a = this.rotationSamples[i - 1];
      const b = this.rotationSamples[i];
      if (!a || !b || b.at < cutoff) continue;
      const dt = (b.at - a.at) / 1000;
      if (dt <= 0 || dt > 1) continue;
      total += ((a.degPerSecond + b.degPerSecond) / 2) * dt;
    }
    return total;
  }

  reset(): void {
    this.byMotion.clear();
    this.shiftChecks.length = 0;
    this.flowCosts.length = 0;
    this.shiftCosts.length = 0;
    this.trackedCounts.length = 0;
    this.fbErrors.length = 0;
    this.stateFrames.clear();
    this.occlusions.length = 0;
    this.spreadRotating.length = 0;
    this.spreadTranslating.length = 0;
    this.rotationDegrees.length = 0;
    this.rotatingSurvival.length = 0;
    this.rotatingFbError.length = 0;
    this.flowFrames = 0;
    this.trackedFrames = 0;
    this.cumulativeTracked = 0;
    this.cumulativeRedetected = 0;
    this.maxTrackLength = 0;
    this.stateMismatches = 0;
    this.fbAcceptable = 0;
    this.fbReduced = 0;
    this.fbRejected = 0;
    this.indeterminateFrames = 0;
    this.lastFlow = null;
    this.lastRecordSamples = [];
    this.occlusionStartedAt = -1;
    this.occlusionFrames = 0;
    this.occlusionLostAt = -1;
    this.occlusionSurvivedWithGoodFb = 0;
    this.pendingRecovery = null;
  }

  /** Fold one frame's Phase 4 result into the run. `now` is the main thread's clock. */
  record(result: TrackingResult, now: number): void {
    const f = result.flow;
    if (!f) return;
    this.flowFrames++;
    this.lastFlow = f;
    if (result.recordSamples.length > 0) this.lastRecordSamples = [...result.recordSamples];

    this.stateFrames.set(f.state, (this.stateFrames.get(f.state) ?? 0) + 1);

    // Rule 002: the state the worker reported must be the state its own reported inputs
    // imply. If they ever differ, something computed the state somewhere other than the one
    // function that is allowed to — and this is where that becomes visible.
    const recomputed = deriveTrackingState({
      everTracked: f.everTracked,
      trackedCount: f.tracked,
      totalCount: f.total,
      consecutiveFailedFrames: f.consecutiveFailedFrames,
      // Phase 5 and Phase 6 have not run. Passing anything else here would be inventing them.
      inlierRatio: null,
      reprojectionError: null,
    }).state;
    if (recomputed !== f.state) this.stateMismatches++;

    this.cumulativeTracked += f.tracked;
    this.cumulativeRedetected += f.redetected;
    if (f.maxTrackLength > this.maxTrackLength) this.maxTrackLength = f.maxTrackLength;
    this.fbAcceptable += f.fbAcceptable;
    this.fbReduced += f.fbReduced;
    this.fbRejected += f.fbRejected;

    this.flowCosts.push(f.flowMs);
    this.shiftCosts.push(f.shiftMs);
    this.trackedCounts.push(f.tracked);
    if (f.medianFbErrorPx >= 0) this.fbErrors.push(f.medianFbErrorPx);
    trim(this.fbErrors);
    trim(this.flowCosts);
    trim(this.shiftCosts);
    trim(this.trackedCounts);

    const motion = f.frameMotion as FrameMotion;
    if (motion === FrameMotion.INDETERMINATE) this.indeterminateFrames++;

    // Only frames where the tracker was actually given something to follow contribute to a
    // survival or displacement statistic. A frame with nothing offered has no survival, and
    // recording one as 0 would look exactly like a tracker that lost everything.
    if (f.offered > 0) {
      this.trackedFrames++;
      const acc = this.byMotion.get(motion) ?? newAccumulator();
      acc.survival.push(f.survival);
      acc.tracked.push(f.tracked);
      if (f.medianDisplacementPx >= 0) acc.displacement.push(f.medianDisplacementPx);
      if (f.medianFbErrorPx >= 0) acc.fbError.push(f.medianFbErrorPx);
      if (f.cellSpread >= 0) acc.cellSpread.push(f.cellSpread);
      const graded = f.fbAcceptable + f.fbReduced + f.fbRejected;
      if (graded > 0) acc.rejectFraction.push(f.fbRejected / graded);
      if (f.state === TrackingState.LOST) acc.lost++;
      else if (f.state === TrackingState.DEGRADED) acc.degraded++;
      trim(acc.survival);
      trim(acc.tracked);
      trim(acc.displacement);
      trim(acc.fbError);
      trim(acc.cellSpread);
      trim(acc.rejectFraction);
      this.byMotion.set(motion, acc);
    }

    this.recordShiftCheck(f);
    this.recordRotation(f, now);
    this.recordOcclusion(f, now);
  }

  /**
   * FLOW-002's pair, taken only where both instruments actually said something.
   *
   * The confidence floor is what excludes a frame pair the search could not read — a blank
   * wall gives every shift the same residual, and "the search found nothing" must not be
   * folded in as "the scene did not move".
   */
  private recordShiftCheck(f: TrackingFlow): void {
    const shift = f.sceneShift;
    if (!shift) return;
    if (shift.confidence < MIN_SHIFT_CONFIDENCE) return;
    if (f.offered <= 0 || f.tracked <= 0) return;
    if (f.medianDisplacementPx < 0) return;

    const tolerance = shiftAgreementTolerance(shift.magnitude0);
    const disagreement = Math.abs(f.medianDisplacementPx - shift.magnitude0);
    this.shiftChecks.push({
      trackedDisplacementPx: f.medianDisplacementPx,
      sceneShiftPx: shift.magnitude0,
      disagreementPx: round(disagreement),
      tolerancePx: round(tolerance),
      agreed: disagreement <= tolerance,
      confidence: shift.confidence,
      trackedCount: f.tracked,
      sceneDx0: shift.dx0,
      sceneDy0: shift.dy0,
    });
    while (this.shiftChecks.length > MAX_SAMPLES) this.shiftChecks.shift();
  }

  private recordRotation(f: TrackingFlow, now: number): void {
    if (!this.gyroAvailable || f.offered <= 0) return;
    const rotation = Math.abs(this.integratedRotationDeg(now));
    this.rotationDegrees.push(round(rotation, 2));
    trim(this.rotationDegrees);
    if (f.cellSpread < 0) return;

    if (rotation >= ROTATING_DEG) {
      this.spreadRotating.push(f.cellSpread);
      this.rotatingSurvival.push(f.survival);
      if (f.medianFbErrorPx >= 0) this.rotatingFbError.push(f.medianFbErrorPx);
      trim(this.spreadRotating);
      trim(this.rotatingSurvival);
      trim(this.rotatingFbError);
    } else if (f.frameMotion === FrameMotion.SLOW) {
      // The control: the device is moving laterally and not turning. A translation moves the
      // whole field by the same amount; that is the claim FLOW-003 compares against.
      this.spreadTranslating.push(f.cellSpread);
      trim(this.spreadTranslating);
    }
  }

  /**
   * FLOW-005: when the lens was covered, how quickly the state said LOST, and whether any
   * track claimed to survive the black frames with a good §13 round trip.
   */
  private recordOcclusion(f: TrackingFlow, now: number): void {
    const occluded = f.frameMotion === FrameMotion.OCCLUDED;

    if (occluded) {
      if (this.occlusionStartedAt < 0) {
        this.occlusionStartedAt = now;
        this.occlusionFrames = 0;
        this.occlusionLostAt = -1;
        this.occlusionSurvivedWithGoodFb = 0;
      }
      this.occlusionFrames++;
      if (this.occlusionLostAt < 0 && f.state === TrackingState.LOST) this.occlusionLostAt = now;
      // A point that "tracks" across a covered lens was never tracked. Counted, not assumed
      // absent — FLOW-005 criterion 3 fails on any of these.
      this.occlusionSurvivedWithGoodFb += f.fbAcceptable;
      return;
    }

    if (this.occlusionStartedAt >= 0) {
      const episode: OcclusionEpisode = {
        startedAt: this.occlusionStartedAt,
        frames: this.occlusionFrames,
        msToLost: this.occlusionLostAt >= 0 ? this.occlusionLostAt - this.occlusionStartedAt : -1,
        survivedWithGoodFb: this.occlusionSurvivedWithGoodFb,
        recovered: false,
        recoveredAfterMs: -1,
      };
      this.occlusions.push(episode);
      while (this.occlusions.length > 40) this.occlusions.shift();
      this.pendingRecovery = { episode: this.occlusions.length - 1, startedAt: now };
      this.occlusionStartedAt = -1;
    }

    if (this.pendingRecovery && f.state !== TrackingState.LOST) {
      const idx = this.pendingRecovery.episode;
      const e = this.occlusions[idx];
      if (e) {
        this.occlusions[idx] = {
          ...e,
          recovered: true,
          recoveredAfterMs: now - this.pendingRecovery.startedAt,
        };
      }
      this.pendingRecovery = null;
    }
  }

  private classStats(motion: FrameMotion): MotionClassStats {
    const acc = this.byMotion.get(motion);
    if (!acc || acc.survival.length === 0) return EMPTY_CLASS;
    return {
      frames: acc.survival.length,
      medianSurvival: round(median(acc.survival), 4),
      medianDisplacementPx: round(median(acc.displacement)),
      medianFbErrorPx: round(median(acc.fbError)),
      medianTracked: round(median(acc.tracked), 1),
      medianCellSpread: round(median(acc.cellSpread)),
      medianRejectFraction: round(median(acc.rejectFraction), 4),
      lostFrames: acc.lost,
      degradedFrames: acc.degraded,
    };
  }

  getLastFlow(): TrackingFlow | null {
    return this.lastFlow;
  }

  getFlowFrames(): number {
    return this.flowFrames;
  }

  /** The shape the Phase 4 suite is evaluated against. */
  stats(running: boolean): FlowStats {
    const f = this.lastFlow;
    const disagreements = this.shiftChecks.map((c) => c.disagreementPx);
    const agreed = this.shiftChecks.filter((c) => c.agreed).length;
    const stateFrames: Record<string, number> = {};
    for (const [k, v] of this.stateFrames) stateFrames[k] = v;

    return {
      running,
      flowFrames: this.flowFrames,
      trackedFrames: this.trackedFrames,

      tracked: f?.tracked ?? 0,
      redetected: f?.redetected ?? 0,
      total: f?.total ?? 0,
      cumulativeTracked: this.cumulativeTracked,
      cumulativeRedetected: this.cumulativeRedetected,
      maxTrackLength: this.maxTrackLength,
      medianAge: f?.medianAge ?? -1,

      state: f?.state ?? TrackingState.READY,
      stateReason: f?.stateReason ?? 'tracking has not started',
      goodBlockedBy: f?.goodBlockedBy ?? [],
      stateFrames,
      stateMismatches: this.stateMismatches,
      consecutiveFailedFrames: f?.consecutiveFailedFrames ?? 0,
      geometryChanges: f?.geometryChanges ?? 0,

      // Over the run, not the last frame: the last frame can be an occluded one with nothing
      // tracked, and a screen reading "FB error —" beside a healthy population is a worse
      // description of the run than the median of the frames that had a round trip to measure.
      medianFbErrorPx: round(median(this.fbErrors)),
      fbAcceptable: this.fbAcceptable,
      fbReduced: this.fbReduced,
      fbRejected: this.fbRejected,

      staticFrames: this.classStats(FrameMotion.STATIC),
      slowFrames: this.classStats(FrameMotion.SLOW),
      fastFrames: this.classStats(FrameMotion.FAST),
      occludedFrames: this.classStats(FrameMotion.OCCLUDED),
      indeterminateFrames: this.indeterminateFrames,
      frameMotion: f?.frameMotion ?? FrameMotion.INDETERMINATE,
      lastSceneShift: f?.sceneShift ?? null,

      shiftChecks: this.shiftChecks.slice(-40),
      shiftCheckCount: this.shiftChecks.length,
      medianShiftDisagreementPx: round(median(disagreements)),
      medianMeasuredShiftPx: round(median(this.shiftChecks.map((c) => c.sceneShiftPx))),
      medianTrackedDisplacementPx: round(
        median(this.shiftChecks.map((c) => c.trackedDisplacementPx)),
      ),
      shiftAgreementRate:
        this.shiftChecks.length > 0 ? round(agreed / this.shiftChecks.length, 4) : -1,

      gyroAvailable: this.gyroAvailable,
      gyroReason: this.gyroReason,
      rotatingFrames: this.spreadRotating.length,
      medianRotationDeg: round(median(this.rotationDegrees), 2),
      medianSpreadRotating: round(median(this.spreadRotating)),
      medianSpreadTranslating: round(median(this.spreadTranslating)),
      rotatingSurvival: round(median(this.rotatingSurvival), 4),
      rotatingFbErrorPx: round(median(this.rotatingFbError)),

      occlusions: [...this.occlusions],

      meanFlowMs:
        this.flowCosts.length > 0
          ? round(this.flowCosts.reduce((a, b) => a + b, 0) / this.flowCosts.length)
          : -1,
      meanShiftMs:
        this.shiftCosts.length > 0
          ? round(this.shiftCosts.reduce((a, b) => a + b, 0) / this.shiftCosts.length)
          : -1,
      meanTrackedPoints:
        this.trackedCounts.length > 0
          ? round(this.trackedCounts.reduce((a, b) => a + b, 0) / this.trackedCounts.length, 1)
          : -1,
      flowCostSamples: this.flowCosts.length,

      recordSamples: this.lastRecordSamples,
      lastFlow: f,
    };
  }

  describe(): Record<string, JsonValue> {
    const s = this.stats(false);
    return toJsonSafe({
      flowFrames: s.flowFrames,
      trackedFrames: s.trackedFrames,
      population: {
        tracked: s.tracked,
        redetected: s.redetected,
        total: s.total,
        cumulativeTracked: s.cumulativeTracked,
        cumulativeRedetected: s.cumulativeRedetected,
        maxTrackLength: s.maxTrackLength,
      },
      byMotion: {
        STATIC: s.staticFrames,
        SLOW: s.slowFrames,
        FAST: s.fastFrames,
        OCCLUDED: s.occludedFrames,
        INDETERMINATE: s.indeterminateFrames,
      },
      forwardBackward: {
        acceptable: s.fbAcceptable,
        reduced: s.fbReduced,
        rejected: s.fbRejected,
        medianPx: s.medianFbErrorPx,
      },
      shiftCrossCheck: {
        samples: s.shiftCheckCount,
        medianDisagreementPx: s.medianShiftDisagreementPx,
        medianMeasuredShiftPx: s.medianMeasuredShiftPx,
        medianTrackedDisplacementPx: s.medianTrackedDisplacementPx,
        agreementRate: s.shiftAgreementRate,
        recent: s.shiftChecks.slice(-24) as unknown as JsonValue,
      },
      rotation: {
        gyroAvailable: s.gyroAvailable,
        gyroReason: s.gyroReason,
        rotatingFrames: s.rotatingFrames,
        medianRotationDeg: s.medianRotationDeg,
        medianSpreadRotating: s.medianSpreadRotating,
        medianSpreadTranslating: s.medianSpreadTranslating,
        windowMs: ROTATION_WINDOW_MS,
        rotatingDeg: ROTATING_DEG,
      },
      occlusions: s.occlusions as unknown as JsonValue,
      state: {
        current: s.state,
        reason: s.stateReason,
        goodBlockedBy: s.goodBlockedBy as unknown as JsonValue,
        frames: s.stateFrames as unknown as JsonValue,
        mismatches: s.stateMismatches,
        geometryChanges: s.geometryChanges,
      },
      cost: {
        meanFlowMs: s.meanFlowMs,
        meanShiftMs: s.meanShiftMs,
        meanTrackedPoints: s.meanTrackedPoints,
        samples: s.flowCostSamples,
      },
      lastRecordSamples: s.recordSamples as unknown as JsonValue,
      note:
        'Motion classes are measured from the image by an integer SAD translation search on ' +
        'the pyramid’s top level, which shares no code with the Lucas-Kanade solver and never ' +
        'reads the feature list. `tracked` counts only points carried forward from the ' +
        'previous frame; `redetected` counts what §11’s refill added, and the two are never ' +
        'summed into a survival figure — a refill can top the population back up while the ' +
        'tracker is losing everything.',
    }) as Record<string, JsonValue>;
  }
}
