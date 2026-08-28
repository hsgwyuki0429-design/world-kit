/**
 * Phase 8's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the reason `flowStats`, `verificationStats`,
 * `poseStats` and `fusionStats` are: the Phase 8 suite is evaluated against this shape and
 * nothing else, so a run can be examined in Node with no DOM, no worker and no camera — which is
 * how the harness can be shown a run driven by the real `KeyframeStage` beside one driven by a
 * metronome wearing this phase's labels, and checked that the two produce **different verdicts**.
 * That check is `tests/unit/keyframes.test.ts`.
 */

import type {
  KeyframeConditionRecord,
  KeyframeEvictionRecord,
  KeyframeRecord,
} from './trackingMessages';

/** One insertion that fired on the geometry over an interval in which nothing moved. */
export interface KeyframeViolationRecord {
  readonly reason: string;
  readonly rotationDeg: number;
  readonly displacementPx: number;
  readonly sinceLastMs: number;
  readonly sharedWithLast: number;
  readonly droppedIncrements: number;
  readonly reAnchors: number;
  readonly poseState: string;
  readonly poseAmbiguous: boolean;
  readonly poseRotationConfidence: number;
  readonly poseUnseparatedCandidates: number;
}

export interface KeyframeStats {
  readonly running: boolean;
  readonly decisions: number;

  /* ---- the current decision ---- */
  readonly inserted: boolean;
  readonly reason: string;
  readonly detail: string;
  readonly conditions: readonly KeyframeConditionRecord[];
  readonly rotationDeg: number;
  readonly displacementPx: number;
  readonly translationDirectionDeg: number;
  readonly sinceLastMs: number;
  readonly observations: number;
  readonly sharedWithLast: number;
  readonly frameMotion: string;
  readonly scale: string;

  /* ---- the store ---- */
  readonly keyframes: number;
  readonly maxStoreSize: number;
  readonly totalInserted: number;
  readonly insertionsByReason: Record<string, number>;
  /** Insertions on rotation, displacement or quality — never the heartbeat (KEY-001 c5). */
  readonly geometricInsertions: number;
  readonly heartbeatInsertions: number;
  readonly recent: readonly KeyframeRecord[];

  /* ---- KEY-001: the decision follows from its inputs ---- */
  /** Decisions whose reason `decideKeyframe` does not reproduce from the recorded inputs. */
  readonly reasonMismatches: number;
  /** Insertions inside v3 §20's minimum interval that were not the first of the run. */
  readonly minIntervalViolations: number;
  /** Gaps longer than v3 §20's maximum while the selector was running. */
  readonly maxIntervalGaps: number;
  readonly longestGapMs: number;

  /* ---- KEY-002: the gate ---- */
  /** Decisions taken while Phase 4's independent search reported `STATIC`. */
  readonly staticDecisions: number;
  readonly staticSelectorInsertions: number;
  /** ...of which fired on rotation, displacement or quality, on a frame classified `STATIC`. */
  readonly staticGeometricInsertions: number;
  /**
   * ...and of **those**, the ones where the whole interval since the previous keyframe was still.
   *
   * The figure KEY-002 judges. A geometric condition is accumulated over an interval, so one that
   * fires on the first still frame after a movement was honestly met — by the movement. One that
   * fires when nothing moved between the two views was not.
   */
  readonly stillIntervalGeometricInsertions: number;
  readonly stillIntervalDecisions: number;
  /**
   * The violating decisions themselves, with the numbers they were taken on.
   *
   * A count says a criterion failed; these say *what the selector thought it had measured* when
   * it did. Kept because the first two attempts at this defect were fixed from a hypothesis, and
   * neither hypothesis was right.
   */
  readonly stillIntervalViolations: readonly KeyframeViolationRecord[];
  /** ...broken down, because which condition fired on a still camera is the whole question. */
  readonly staticInsertionsByReason: Record<string, number>;
  readonly staticMetronomeInsertions: number;
  /** `staticMetronomeInsertions / staticSelectorInsertions`. `-1` where the selector inserted 0. */
  readonly staticRatio: number;
  readonly metronomeKeyframes: number;

  /* ---- KEY-003: bounded, and able to let go ---- */
  readonly evictions: number;
  /** Frames where the store held more than `MAX_KEYFRAMES`. Must be 0. */
  readonly storeOverflows: number;
  readonly evictionsWithoutReason: number;
  /** Evictions that took the newest keyframe — the one the next decision compares against. */
  readonly evictedNewest: number;
  /** Evictions whose retained set was at least as well spread as dropping the oldest. */
  readonly evictionsCoverageKept: number;
  readonly recentEvictions: readonly KeyframeEvictionRecord[];

  /* ---- KEY-004: what travels with a keyframe ---- */
  readonly observationFloorViolations: number;
  readonly duplicateObservationIds: number;
  /** Keyframes whose `K` does not follow from their own recorded frame geometry (§H.0). */
  readonly intrinsicsMismatches: number;
  readonly medianSharedWithLast: number;
  readonly sharedBelowFloor: number;

  /* ---- KEY-005: the condition this phase refuses ---- */
  readonly translationCondition: KeyframeConditionRecord | null;
  /** Decisions that fired on a translation magnitude. There is no such magnitude; must be 0. */
  readonly translationFired: number;
  readonly translationDirectionSamples: number;
  readonly medianTranslationDirectionDeg: number;
  readonly scaleViolations: number;

  /* ---- KEY-006: staleness ---- */
  readonly staleKeyframes: number;
  readonly staleEver: number;
  readonly stalePartnerUsed: number;
  readonly survivalSamples: number;
  readonly medianSurvivingFraction: number;
  readonly droppedIncrements: number;
  /** Poses declined because Phase 6 could not separate the decomposition's candidates. */
  readonly ambiguousPosesDeclined: number;

  /* ---- KEY-007 ---- */
  readonly meanKeyframeMs: number;
  readonly costSamples: number;

  /* ---- KEY-008: metadata honesty ---- */
  readonly rateOutOfRange: number;
  readonly eulerEmitted: number;
  /** Frames where the reported store size disagreed with the records it carried. */
  readonly sizeMismatches: number;
}
