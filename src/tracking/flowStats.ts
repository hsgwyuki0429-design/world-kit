/**
 * Phase 4's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the same reason `trackingStats.ts` is: the
 * Phase 4 suite is evaluated against this shape and nothing else, so it can be examined in
 * Node with no DOM, no worker and no camera — which is how the harness can be shown a run
 * driven by a real tracker and one driven by a tracker that **returns its input**, and
 * checked that the two produce different verdicts. That check is `flowTracker.test.ts`, and
 * it is the reason this file has no dependency on anything that needs a browser.
 */

import type { FeatureRecordSample, TrackingFlow, TrackingSceneShift } from './trackingMessages';

/** Everything accumulated for one measured motion class. */
export interface MotionClassStats {
  readonly frames: number;
  readonly medianSurvival: number;
  readonly medianDisplacementPx: number;
  readonly medianFbErrorPx: number;
  readonly medianTracked: number;
  readonly medianCellSpread: number;
  /** Fraction of round trips that landed above §13's 3.0 px reject band, median over frames. */
  readonly medianRejectFraction: number;
  /**
   * Frames of this class on which §33's state was `LOST` / `DEGRADED`.
   *
   * Per class, not per run, and that distinction is a correction rather than a nicety.
   * FLOW-001 asks that the state never be `LOST` *while the scene is static*; FLOW-005
   * requires a deliberate occlusion during which it certainly is. Counting `LOST` run-wide
   * made the two criteria contradict each other, so a correct implementation of both could
   * not exist. Recorded here so each test reads the frames it is actually about.
   */
  readonly lostFrames: number;
  readonly degradedFrames: number;
}

export const EMPTY_CLASS: MotionClassStats = {
  frames: 0,
  medianSurvival: -1,
  medianDisplacementPx: -1,
  medianFbErrorPx: -1,
  medianTracked: -1,
  medianCellSpread: -1,
  medianRejectFraction: -1,
  lostFrames: 0,
  degradedFrames: 0,
};

/**
 * One frame where both instruments spoke: what the tracker said the points did, and what the
 * independent search said the image did.
 *
 * FLOW-002 is decided on these pairs and on nothing else.
 */
export interface ShiftCrossCheck {
  readonly trackedDisplacementPx: number;
  readonly sceneShiftPx: number;
  /** `|tracked − scene|`. */
  readonly disagreementPx: number;
  readonly tolerancePx: number;
  readonly agreed: boolean;
  readonly confidence: number;
  readonly trackedCount: number;
  /** Signed components, recorded so a tracker moving points the wrong way is visible too. */
  readonly sceneDx0: number;
  readonly sceneDy0: number;
}

/** The occlusion episode FLOW-005 judges: when it started, and when the state reached LOST. */
export interface OcclusionEpisode {
  readonly startedAt: number;
  readonly frames: number;
  /** Milliseconds from the first `OCCLUDED` frame to the first `LOST` state. `-1` if never. */
  readonly msToLost: number;
  /** Tracks that came through the episode with a §13-acceptable round trip. Must be 0. */
  readonly survivedWithGoodFb: number;
  /** Whether the state left `LOST` after the episode ended. */
  readonly recovered: boolean;
  readonly recoveredAfterMs: number;
}

export interface FlowStats {
  readonly running: boolean;
  /** Frames on which optical flow actually ran. */
  readonly flowFrames: number;
  /** ...of which had a predecessor to track from. */
  readonly trackedFrames: number;

  /* Population, tracked and redetected kept apart throughout */
  readonly tracked: number;
  readonly redetected: number;
  readonly total: number;
  readonly cumulativeTracked: number;
  readonly cumulativeRedetected: number;
  readonly maxTrackLength: number;
  readonly medianAge: number;

  /* §33 */
  readonly state: string;
  readonly stateReason: string;
  readonly goodBlockedBy: readonly string[];
  readonly stateFrames: Record<string, number>;
  /** Frames where the state reported disagreed with the state its own inputs imply (Rule 002). */
  readonly stateMismatches: number;
  readonly consecutiveFailedFrames: number;
  /**
   * Tier steps and device rotations during the run.
   *
   * Each one empties the population, because a level-0 position from a 1280×720 frame means
   * nothing in a 640×360 one (§H.0). It is not a tracking failure and not a fresh start; it is
   * recorded so a run whose population was rebuilt a dozen times reads as one.
   */
  readonly geometryChanges: number;

  /* §13 */
  readonly medianFbErrorPx: number;
  readonly fbAcceptable: number;
  readonly fbReduced: number;
  readonly fbRejected: number;

  /* Motion classes, measured from the image */
  readonly staticFrames: MotionClassStats;
  readonly slowFrames: MotionClassStats;
  readonly fastFrames: MotionClassStats;
  readonly occludedFrames: MotionClassStats;
  readonly indeterminateFrames: number;
  readonly frameMotion: string;
  readonly lastSceneShift: TrackingSceneShift | null;

  /* FLOW-002 */
  readonly shiftChecks: readonly ShiftCrossCheck[];
  readonly shiftCheckCount: number;
  readonly medianShiftDisagreementPx: number;
  readonly medianMeasuredShiftPx: number;
  readonly medianTrackedDisplacementPx: number;
  readonly shiftAgreementRate: number;

  /* FLOW-003 */
  readonly gyroAvailable: boolean;
  readonly gyroReason: string;
  readonly rotatingFrames: number;
  readonly medianRotationDeg: number;
  readonly medianSpreadRotating: number;
  readonly medianSpreadTranslating: number;
  readonly rotatingSurvival: number;
  readonly rotatingFbErrorPx: number;

  /* FLOW-005 */
  readonly occlusions: readonly OcclusionEpisode[];

  /* FLOW-006 */
  readonly meanFlowMs: number;
  readonly meanShiftMs: number;
  readonly meanTrackedPoints: number;
  readonly flowCostSamples: number;

  /* FLOW-007 */
  readonly recordSamples: readonly FeatureRecordSample[];

  readonly lastFlow: TrackingFlow | null;
}
