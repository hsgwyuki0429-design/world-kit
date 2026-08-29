/**
 * Phase 7's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the reason `flowStats`, `verificationStats`
 * and `poseStats` are: the Phase 7 suite is evaluated against this shape and nothing else, so a
 * run can be examined in Node with no DOM, no worker, no camera and no accelerometer — which is
 * how the harness can be shown a run driven by the real `FusionStage` beside one driven by a
 * "fusion" that returns the visual pose unchanged, and checked that the two produce **different
 * verdicts**. That check is `tests/unit/fusion.test.ts`.
 */

import type { ConfidenceTermRecord, FusionReport } from './trackingMessages';
import { DEAD_RECKONING_AFTER_MS, FusionMode, MAX_PROPAGATION_MS } from './FusionStage';
import type { HandEyeReport } from './trackingMessages';

/** One of §17's channels, and whether it is actually arriving. */
export interface SensorChannel {
  readonly name: string;
  readonly arriving: boolean;
  readonly detail: string;
}

/** One IMU-005 measurement, kept for the evidence. */
export interface BiasDifferenceSample {
  readonly at: number;
  /** `b_injected − b_control`, °/s per axis. The device's own true bias cancels between them. */
  readonly differenceDps: readonly number[];
  readonly magnitudeDps: number;
  /** Angle between that difference and the axis the harness injected along, degrees. */
  readonly axisErrorDeg: number;
  readonly visualUpdates: number;
}

/** One IMU-007 measurement: an interval where vision stopped, and what happened to it. */
export interface DropoutSample {
  readonly startedAt: number;
  readonly longestPropagatedMs: number;
  readonly frames: number;
  readonly confidenceAtStart: number;
  readonly confidenceAtEnd: number;
  /** Frames where the confidence went **up** while running open-loop. Must be 0. */
  readonly rises: number;
  /** Frames still offered as usable past `MAX_PROPAGATION_MS`. Must be 0. */
  readonly usableBeyondMax: number;
  /** Innovation on the first visual update after vision returned. `-1` where it never did. */
  readonly reconvergenceInnovationDeg: number;
}

export interface FusionStats {
  /** The device→camera rotation as the last report carried it — see `fusion/handEye.ts`. */
  readonly handEye: HandEyeReport;
  readonly running: boolean;
  /** Frames the fusion stage reported on at all. */
  readonly fusionFrames: number;

  /* ---- the current frame ---- */
  readonly mode: string;
  readonly usable: boolean;
  readonly orientation: readonly number[] | null;
  readonly gyroBiasDps: readonly number[] | null;
  /** v3 §17, v4 §19. Always `null`, with the reason beside it rather than implied. */
  readonly position: readonly number[] | null;
  readonly positionReason: string;
  readonly velocityReason: string;
  readonly accelBiasReason: string;
  readonly scale: string;
  readonly heading: string;
  readonly innovationDeg: number;
  readonly propagatedMs: number;
  readonly gravityDeg: number;
  readonly imuConsistency: number;
  readonly confidence: number;
  readonly confidenceTerms: readonly ConfidenceTermRecord[];
  readonly confidenceWithheld: readonly string[];
  /** Phase 6's own confidence for the same frame, unedited. */
  readonly visualConfidence: number;

  /* ---- IMU-001: the sensors ---- */
  readonly sensors: readonly SensorChannel[];
  readonly imuAvailable: boolean;
  readonly imuReason: string;
  readonly imuSamples: number;
  /** Delivered rate, measured over the run rather than assumed to be 60 Hz. */
  readonly measuredImuHz: number;
  /** ...and the rate the platform's own `interval` claims. */
  readonly reportedImuHz: number;
  readonly gravitySamples: number;
  readonly gravityRejected: number;
  readonly fusedFrames: number;
  /** Frames where the filter was carrying the orientation between poses. */
  readonly propagatingFrames: number;
  readonly biasMagnitudeDps: number;
  readonly biasReason: string;

  /* ---- over the run ---- */
  readonly modeFrames: Record<string, number>;
  /** Frames whose reported mode did not follow from its own inputs (Rule 002). */
  readonly modeMismatches: number;

  /* ---- IMU-003: the camera turned ---- */
  readonly innovationSamples: number;
  readonly medianInnovationDeg: number;
  readonly maxInnovationDeg: number;
  /** Updates whose innovation was exactly zero — the signature of a filter that is copying. */
  readonly zeroInnovationSamples: number;
  readonly medianVisualIncrementDeg: number;
  readonly toleranceDeg: number;
  readonly innovationsWithinTolerance: number;
  /** How far the fused orientation sat from Phase 6's, per frame. Zero throughout = fake 1. */
  readonly fusedVsVisualSamples: number;
  readonly medianFusedVsVisualDeg: number;
  readonly maxFusedVsVisualDeg: number;
  readonly zeroFusedVsVisualFrames: number;

  /* ---- IMU-004: consistency ---- */
  readonly imuConsistencySamples: number;
  readonly medianImuConsistency: number;
  readonly minImuConsistency: number;
  /** Frames where the term was below 1 — proof it can fall. */
  readonly imuConsistencyBelowOne: number;
  readonly gravityDegSamples: number;
  readonly medianGravityDeg: number;
  /** Frames whose confidence exceeded its own worst measured term. Must be 0. */
  readonly confidenceAboveWorstTerm: number;
  /** Frames where the fused confidence exceeded the visual one. Must be 0. */
  readonly fusedAboveVisual: number;

  /* ---- IMU-005: the gate ---- */
  readonly biasSamples: number;
  readonly medianBiasDifferenceDps: number;
  readonly medianBiasAxisErrorDeg: number;
  readonly requestedInjectionDps: number;
  readonly injectionAxis: readonly number[];
  readonly medianInjectedInnovationDeg: number;
  readonly biasDifferences: readonly BiasDifferenceSample[];

  /* ---- IMU-006: no position ---- */
  /** Records carrying a position, in any unit, from any source. Must be 0. There is no tolerance. */
  readonly positionsReported: number;
  readonly scaleViolations: number;
  /** What double-integrating the accelerometer would have produced. For the record only. */
  readonly deadReckonedPositionM: number;
  readonly deadReckonedSeconds: number;

  /* ---- IMU-007: vision dropout ---- */
  readonly dropoutFrames: number;
  readonly longestPropagatedMs: number;
  readonly dropouts: readonly DropoutSample[];
  readonly dropoutConfidenceRises: number;
  readonly usableBeyondMax: number;
  readonly reconvergences: number;
  readonly medianReconvergenceInnovationDeg: number;

  /* ---- IMU-008 ---- */
  readonly meanFusionMs: number;
  readonly fusionCostSamples: number;

  /* ---- IMU-009: metadata honesty ---- */
  /** Any Euler angle triple emitted anywhere. Must be 0 (§18). */
  readonly eulerEmitted: number;
  /** Frames reporting a zero bias where no gyroscope reported. An absent quantity is not zero. */
  readonly biasZeroWithoutGyro: number;
  /** Rates outside `0..1` — Phase 6's device run reported 232.3 %, and this is that check. */
  readonly rateOutOfRange: number;
}

/**
 * Re-derive the mode from the numbers reported beside it — Rule 002, for the fourth time.
 *
 * Phases 4, 5 and 6 all carry this check and it caught Phase 6's impossible agreement rate. The
 * mode is a pure function of what arrived: whether an IMU is reporting, and how long it has been
 * since vision produced a pose. A report whose mode does not follow from its own fields means
 * something assigned a mode somewhere other than the one place allowed to.
 */
export function fusionModeFollowsFrom(r: FusionReport): string {
  const hasImu = r.imuSamples > 0 && r.gyroBiasDps !== null;
  if (!hasImu) return FusionMode.VISION_ONLY;
  if (r.propagatedMs >= 0 && r.propagatedMs > DEAD_RECKONING_AFTER_MS) {
    return FusionMode.DEAD_RECKONING;
  }
  return FusionMode.FUSED;
}

/** ...and the same for `usable`, which IMU-007's fourth criterion turns on. */
export function usableFollowsFrom(r: FusionReport): boolean {
  if (r.mode !== FusionMode.DEAD_RECKONING) return true;
  return r.propagatedMs >= 0 && r.propagatedMs <= MAX_PROPAGATION_MS;
}
