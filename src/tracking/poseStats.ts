/**
 * Phase 6's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the same reason `flowStats.ts` and
 * `verificationStats.ts` are: the Phase 6 suite is evaluated against this shape and nothing
 * else, so it can be examined in Node with no DOM, no worker and no camera — which is how the
 * harness can be shown a run driven by a real solver and one driven by a stage that **returns
 * the same pose on every frame**, and checked that the two produce different verdicts. That
 * check is `tests/unit/poseStage.test.ts`.
 */

import { MIN_INLIERS } from '../geometry/verify';
import { MIN_CHEIRALITY_FRACTION, PURE_ROTATION_PARALLAX_PX, PoseState } from '../geometry/pose';
import type {
  CheiralityRecord,
  ConfidenceTermRecord,
  IntrinsicsRecord,
  PoseInjection,
  PoseReport,
  PoseSensitivity,
} from './trackingMessages';

/** One POSE-005 measurement, kept for the evidence. */
export interface PoseInjectionSample extends PoseInjection {
  readonly at: number;
}

/** One POSE-002 measurement: what the camera did, and what the gyroscope says it did. */
export interface RotationAgreementSample {
  readonly at: number;
  readonly visualDeg: number;
  readonly gyroNetDeg: number;
  /** Total angular path over the same interval. Far above `gyroNetDeg` means the phone wobbled. */
  readonly gyroPathDeg: number;
  readonly disagreementDeg: number;
  readonly toleranceDeg: number;
  readonly agreed: boolean;
  readonly anchorAgeMs: number;
  readonly gyroSamples: number;
}

export interface PoseStats {
  readonly running: boolean;
  /** Frames on which pose recovery ran at all. */
  readonly poseFrames: number;

  /* The current frame */
  readonly state: string;
  readonly stateReason: string;
  readonly source: string | null;
  readonly rotationDeg: number;
  readonly translation: readonly number[] | null;
  readonly scale: string;
  readonly planar: boolean;
  readonly ambiguous: boolean;
  readonly pointsInFront: number;
  readonly correspondences: number;
  readonly reprojectionErrorPx: number;
  readonly rotationOnlyResidualPx: number;
  readonly confidence: number;
  readonly rotationConfidence: number;
  readonly translationConfidence: number;
  readonly confidenceTerms: readonly ConfidenceTermRecord[];
  readonly confidenceWithheld: readonly string[];
  readonly intrinsics: IntrinsicsRecord | null;
  readonly cheirality: readonly CheiralityRecord[];
  /** Which of them was taken. `-1` where none was. */
  readonly chosen: number;
  readonly sensitivity: PoseSensitivity | null;

  /* Over the run */
  readonly stateFrames: Record<string, number>;
  /** Frames where the reported state disagreed with the state its own inputs imply (Rule 002). */
  readonly stateMismatches: number;
  readonly medianRotationDeg: number;
  readonly medianReprojectionPx: number;
  readonly medianCheiralityFraction: number;
  readonly medianConfidence: number;
  readonly medianSensitivityRotationDeg: number;
  readonly medianSensitivityTranslationDeg: number;

  /* POSE-001 */
  readonly posedFrames: number;
  /** Angular spread of the recovered translation directions about their own mean. */
  readonly translationSpreadDeg: number;
  readonly ambiguousFrames: number;
  readonly belowCheiralityFraction: number;

  /* POSE-002 — the gyroscope */
  readonly gyroAvailable: boolean;
  readonly gyroReason: string;
  /** Comparisons in the retained window — the denominator of every figure below. */
  readonly rotationSamples: number;
  /** ...and the total ever made, which is larger once §56's bound starts discarding. */
  readonly rotationComparisons: number;
  readonly medianVisualRotationDeg: number;
  readonly medianGyroRotationDeg: number;
  readonly medianRotationDisagreementDeg: number;
  readonly rotationAgreementRate: number;
  readonly rotationAgreements: readonly RotationAgreementSample[];

  /* POSE-003 — v3 §16 */
  readonly planarPosedFrames: number;
  readonly nonPlanarPosedFrames: number;
  /** Planar frames that decomposed an Essential matrix. Must be 0. */
  readonly planarFromEssential: number;
  readonly medianPlanarTranslationConfidence: number;
  readonly medianNonPlanarTranslationConfidence: number;
  /**
   * Candidates cheirality could not separate, per frame — what v3 §16's penalty is *made of*.
   *
   * Reported per class because the confidence figures above cannot answer §16's question: each
   * is a minimum over several terms, and on a frame with a thin population the binding term is
   * not the planar one. Comparing them across classes compares two different constraints.
   */
  readonly medianPlanarUnseparated: number;
  readonly medianNonPlanarUnseparated: number;
  /** Planar frames whose translation confidence was **not** at or below their rotation's. */
  readonly planarTranslationNotLowered: number;

  /* POSE-004 — fail closed */
  readonly lowParallaxFrames: number;
  /** Low-parallax frames that still named a translation. Must be 0. */
  readonly lowParallaxWithTranslation: number;
  readonly unverifiedFrames: number;
  /** Frames Phase 5 declined that still carried a rotation. Must be 0. */
  readonly unverifiedWithRotation: number;

  /* POSE-005 — the gate */
  readonly injectionSamples: number;
  readonly medianInjectedDeg: number;
  readonly medianControlDeg: number;
  readonly requestedInjectionDeg: number;
  /**
   * How much injecting a rotation moved the inlier count, as a fraction, and the same for the
   * control.
   *
   * The exact epipolar geometry maps exactly under an image-space rotation; the **pixel
   * threshold** does not, because a Sampson distance is not invariant under a projective map of
   * one image. So a correspondence sitting on 1.5 px can cross. The control — the same data,
   * refitted with a different seed — is the noise floor that separates that from a fit
   * responding to something other than the geometry.
   */
  readonly medianInjectedInlierDrift: number;
  readonly medianControlInlierDrift: number;
  /** Injected frames that flipped v3 §16's planar flag, and the control's own flip count. */
  readonly injectionPlanarFlips: number;
  readonly controlPlanarFlips: number;
  readonly injections: readonly PoseInjectionSample[];

  /* POSE-006 */
  readonly meanPoseMs: number;
  readonly poseCostSamples: number;

  /* POSE-007 — metadata honesty */
  readonly scaleViolations: number;
  readonly intrinsicsUnmarked: number;
  readonly reprojectionWithoutTriangulation: number;
  readonly pointsInFrontOverflow: number;
  readonly confidenceAboveWorstTerm: number;
  /** Frames reporting NO_POSE while still carrying a rotation or a translation. */
  readonly poseWithoutVerdict: number;
}

/**
 * Re-derive the state from the numbers reported beside it — Rule 002, for the third time.
 *
 * Phases 4 and 5 both carry this check and it has earned its place in both. The state is a pure
 * function of measured quantities, so a report whose state does not follow from its own fields
 * means something assigned a state somewhere other than the one place allowed to.
 *
 * `null` where the inputs do not determine an answer — a frame with no residual measured cannot
 * be checked, and counting it as a mismatch would make the counter say "defect" where it should
 * say "not applicable".
 */
export function poseStateFollowsFrom(r: PoseReport): string | null {
  if (r.source === null || r.correspondences < MIN_INLIERS) return PoseState.NO_POSE;
  if (r.rotationOnlyResidualPx < 0) return null;
  if (r.rotationOnlyResidualPx <= PURE_ROTATION_PARALLAX_PX) return PoseState.ROTATION_ONLY;
  if (r.correspondences <= 0) return PoseState.NO_POSE;
  if (r.pointsInFront / r.correspondences < MIN_CHEIRALITY_FRACTION) return PoseState.NO_POSE;
  return PoseState.POSE;
}
