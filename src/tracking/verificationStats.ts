/**
 * Phase 5's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the same reason `flowStats.ts` is: the Phase
 * 5 suite is evaluated against this shape and nothing else, so it can be examined in Node with
 * no DOM, no worker and no camera — which is how the harness can be shown a run driven by a
 * real verifier and one driven by a stage that **returns every correspondence as an inlier**,
 * and checked that the two produce different verdicts. That check is
 * `tests/unit/verification.test.ts`.
 */

import type { VerificationInjection } from './trackingMessages';

/** Statistics for one texture class, so GEO-001 and GEO-002 judge the frames they mean to. */
export interface VerificationClassStats {
  /** Frames of this class on which verification ran. */
  readonly frames: number;
  /** ...of which had enough correspondences and enough baseline to be judged at all. */
  readonly judged: number;
  readonly medianCorrespondences: number;
  readonly medianInliers: number;
  readonly medianInlierRatio: number;
  readonly medianBaselinePx: number;
  readonly medianSpreadPx: number;
  /** Frames of this class that reported each state. */
  readonly unverified: number;
  readonly usable: number;
  readonly good: number;
}

export const EMPTY_VERIFICATION_CLASS: VerificationClassStats = {
  frames: 0,
  judged: 0,
  medianCorrespondences: -1,
  medianInliers: -1,
  medianInlierRatio: -1,
  medianBaselinePx: -1,
  medianSpreadPx: -1,
  unverified: 0,
  usable: 0,
  good: 0,
};

/** One GEO-003 measurement, kept for the evidence. */
export interface InjectionSample extends VerificationInjection {
  readonly at: number;
}

export interface VerificationStats {
  readonly running: boolean;
  /** Frames on which verification actually ran. */
  readonly verifiedFrames: number;
  /** ...of which cleared `MIN_CORRESPONDENCES` and `MIN_BASELINE_PX` and were judged. */
  readonly judgedFrames: number;

  /* The current frame */
  readonly state: string;
  readonly stateReason: string;
  readonly goodBlockedBy: readonly string[];
  readonly correspondences: number;
  readonly inliers: number;
  readonly inlierRatio: number;
  readonly baselinePx: number;
  readonly model: string | null;
  readonly planar: boolean;
  readonly anchorAge: number;

  /* Over the run */
  readonly medianInliers: number;
  readonly medianInlierRatio: number;
  readonly medianBaselinePx: number;
  readonly medianSpreadPx: number;
  readonly medianCorrespondences: number;
  readonly stateFrames: Record<string, number>;
  /** Frames where the reported state disagreed with the state its own inputs imply (Rule 002). */
  readonly stateMismatches: number;
  readonly reAnchors: number;

  /* GEO-001 / GEO-002, per texture class measured from the image */
  readonly textureRich: VerificationClassStats;
  readonly texturePoor: VerificationClassStats;

  /* GEO-003 — the gate */
  readonly injectionSamples: number;
  readonly medianInjectedRecall: number;
  readonly medianCleanRejection: number;
  readonly medianSurvivingInliers: number;
  readonly injections: readonly InjectionSample[];

  /* GEO-004 — v3 §16 */
  readonly bothModelsFitted: number;
  readonly planarFrames: number;
  readonly nonPlanarFrames: number;
  /** Frames where the planar flag did not follow from the two inlier counts beside it. */
  readonly planarMismatches: number;
  readonly medianFundamentalInliers: number;
  readonly medianHomographyInliers: number;

  /* GEO-005 */
  readonly meanVerifyMs: number;
  readonly verifyCostSamples: number;
  /** Frames where RANSAC hit its cap instead of reaching its confidence target. */
  readonly cappedFrames: number;

  /* GEO-006 */
  readonly degenerateFrames: number;
  /** Frames whose inlier and outlier counts did not add up to the correspondence count. */
  readonly partitionFaults: number;
  /** Frames reporting UNVERIFIED while still carrying a model. */
  readonly modelWithoutVerdict: number;
}
