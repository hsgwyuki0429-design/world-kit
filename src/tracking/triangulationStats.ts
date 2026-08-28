/**
 * Phase 9's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the reason every `*Stats` before it is: the
 * Phase 9 suite is evaluated against this shape and nothing else, so a run can be examined in
 * Node with no DOM, no worker and no camera — which is how the harness can be shown a run driven
 * by the real triangulator beside one driven by a stage that returns a constant depth, and
 * checked that the two produce **different verdicts**. That check is
 * `tests/unit/triangulation.test.ts`.
 */

import type {
  DepthInjectionRecord,
  RotationInjectionRecord,
  TriangulatedPointRecord,
} from './trackingMessages';

export interface TriangulationStats {
  readonly running: boolean;
  readonly frames: number;
  readonly batches: number;

  /* ---- the current batch ---- */
  readonly state: string;
  readonly stateReason: string;
  readonly keyframePair: readonly number[] | null;
  readonly correspondences: number;
  readonly inliers: number;
  readonly accepted: number;
  readonly model: string | null;
  readonly planar: boolean;
  readonly poseState: string;
  readonly samples: readonly TriangulatedPointRecord[];

  /* ---- TRI-001 ---- */
  readonly batchesTriangulated: number;
  readonly batchesRefused: number;
  readonly batchRefusalsByReason: Record<string, number>;
  readonly totalAccepted: number;
  readonly medianAcceptedPerBatch: number;
  /** Accepted points per keyframe inserted — v4 §21's *Sparse* as a number. */
  readonly pointsPerKeyframe: number;

  /* ---- TRI-002 ---- */
  readonly pointRefusals: Record<string, number>;
  readonly candidates: number;
  readonly acceptanceRate: number;
  readonly medianParallaxDeg: number;
  readonly medianAcceptedParallaxDeg: number;
  /** The lowest parallax any accepted point had, over the run. Must be at or above the floor. */
  readonly worstAcceptedParallaxDeg: number;
  readonly medianDepthUncertainty: number;
  readonly lowParallaxRefusals: number;

  /* ---- TRI-003: the pure-rotation gate ---- */
  readonly rotationInjections: number;
  /** Points accepted from a camera that only turned. Must be 0; there is no tolerance. */
  readonly rotationInjectionAccepted: number;
  readonly rotationInjectionCleanAccepted: number;
  readonly rotationInjectionPoseStates: Record<string, number>;
  readonly lastRotationInjection: RotationInjectionRecord | null;

  /* ---- TRI-004: the gate ---- */
  readonly depthInjections: number;
  readonly medianDepthError: number;
  /** What the best possible constant depth would have scored on the same sets. */
  readonly medianControlError: number;
  readonly medianRankCorrelation: number;
  readonly worstDepthError: number;
  readonly lastDepthInjection: DepthInjectionRecord | null;

  /* ---- TRI-005 ---- */
  readonly medianReprojectionPx: number;
  readonly worstAcceptedReprojectionPx: number;
  readonly worstAcceptedDepth: number;
  readonly behindCameraRefusals: number;
  readonly highReprojectionRefusals: number;

  /* ---- TRI-006: two routes to one rotation ---- */
  readonly rotationSamples: number;
  readonly medianRotationDeg: number;
  readonly medianRotationDisagreementDeg: number;
  readonly rotationToleranceDeg: number;
  readonly rotationsWithinTolerance: number;
  /** Batches where the two routes agreed *exactly*, which would mean one is the other. */
  readonly zeroDisagreements: number;

  /* ---- TRI-007: no distance ---- */
  readonly scale: string;
  readonly baselineUnits: number;
  readonly baselineNote: string;
  readonly scaleViolations: number;
  readonly medianBatchDepth: number;
  /**
   * `(max − min) / median` over the per-batch median depths.
   *
   * The number behind the refusal to pool them: on one scene with one camera, the median depth
   * moves by this much between batches purely because each pair's baseline is a different unit.
   */
  readonly batchDepthSpread: number;

  /* ---- TRI-008 ---- */
  readonly meanTriangulationMs: number;
  /** ...and the same cost spread over every frame, which is what §B.2's worker decision needs. */
  readonly amortisedMsPerFrame: number;
  readonly costSamples: number;

  /* ---- TRI-009 ---- */
  readonly rateOutOfRange: number;
  /** Batches where `accepted + refusals` did not equal `candidates`. Must be 0. */
  readonly accountingMismatches: number;
  /** Refused batches that reported points anyway. Must be 0. */
  readonly refusedWithPoints: number;
}
