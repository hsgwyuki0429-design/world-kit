/**
 * Phase 10's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the reason every `*Stats` before it is: the
 * Phase 10 suite is evaluated against this shape and nothing else, so a run can be examined in
 * Node with no DOM, no worker and no camera — which is how the harness can be shown a run driven
 * by the real map beside one driven by a map that overwrites each landmark with the newest
 * triangulation, and checked that the two produce **different verdicts**. That check is
 * `tests/unit/landmarks.test.ts`.
 */

import type {
  LandmarkCullRecord,
  LandmarkInjectionRecord,
  LandmarkRecord,
} from './trackingMessages';

export interface LandmarkStats {
  readonly running: boolean;
  readonly frames: number;
  readonly batches: number;

  /* ---- the current batch ---- */
  readonly state: string;
  readonly stateReason: string;
  readonly keyframePair: readonly number[] | null;
  readonly shared: number;
  readonly admitted: number;
  readonly merged: number;
  readonly rejected: number;
  readonly samples: readonly LandmarkRecord[];

  /* ---- MAP-001 ---- */
  readonly landmarks: number;
  readonly confirmed: number;
  /**
   * The most the map has ever held, and the most it has ever confirmed.
   *
   * Reported beside the current figures because an **epoch restart** clears the map, and a run
   * that walked out of its own world and started again would otherwise report a nearly empty map
   * as if it had never accumulated anything. MAP-001 asks whether landmarks accumulate; MAP-003
   * asks how often the world had to be redefined. Reading the first off the last batch would
   * conflate them.
   */
  readonly peakLandmarks: number;
  readonly peakConfirmed: number;
  readonly maxLandmarks: number;
  readonly multiObservation: number;
  readonly medianObservations: number;
  readonly medianConfidence: number;

  /* ---- MAP-002: the gate ---- */
  readonly heldOutBatches: number;
  readonly heldOutSamples: number;
  readonly medianHeldOutPx: number;
  readonly worstHeldOutPx: number;
  /** Predictions that landed exactly on the observation — the signature of a map with no memory. */
  readonly zeroHeldOut: number;
  readonly medianObservationsAtPrediction: number;

  /* ---- MAP-003 ---- */
  readonly registeredBatches: number;
  readonly unregisteredBatches: number;
  readonly unregisteredReasons: Record<string, number>;
  readonly medianRegistrationScale: number;
  readonly medianRegistrationResidual: number;
  readonly worstRegistrationResidual: number;
  readonly registrationOutliers: number;
  readonly epochs: number;
  readonly epochRestarts: number;
  readonly scale: string;
  readonly scaleViolations: number;
  /** Batches ingested without a registration. Must be 0. */
  readonly ingestedUnregistered: number;

  /* ---- MAP-004 ---- */
  readonly culled: number;
  readonly cullsByReason: Record<string, number>;
  readonly cullsWithoutReason: number;
  readonly recentCulls: readonly LandmarkCullRecord[];
  readonly boundBreaches: number;
  readonly confidenceOutOfRange: number;

  /* ---- MAP-005: the second gate ---- */
  readonly injections: number;
  readonly medianRecall: number;
  readonly medianCleanRejectionRate: number;
  /** ...and what the same gate refused on the uncorrupted batch. The baseline. */
  readonly medianBaselineRejectionRate: number;
  /** The difference: whether the injection turned the gate against the innocent. */
  readonly medianCleanExcess: number;
  readonly worstCleanExcess: number;
  readonly worstRecall: number;
  readonly injectionDisplacementPx: number;
  readonly lastInjection: LandmarkInjectionRecord | null;

  /* ---- MAP-006 ---- */
  readonly moveAtTwo: number;
  readonly moveAtFive: number;
  readonly moveAtTwoSamples: number;
  readonly moveAtFiveSamples: number;
  readonly medianMoveRelative: number;

  /* ---- MAP-007 ---- */
  readonly modelClaim: string;
  readonly landmarksPerKeyframe: number;
  /** Confirmed landmarks as a share of the map's own — a rate, and in `0..1` by construction. */
  readonly confirmedShare: number;
  /**
   * Landmarks the map holds for every feature the tracker is following **right now**.
   *
   * A ratio and deliberately **not** a share: it is routinely greater than one, because the map
   * remembers points that have left the frame and the tracked population does not. The first
   * version called this a share of the population and the leg printed **338 %** — the same shape
   * as Phase 6's device run reporting an agreement rate of 232.3 %, and the reason every rate in
   * this project is checked against `0..1`. A quantity that can exceed one is not a rate, and
   * naming it as one is how a number stops meaning anything.
   */
  readonly landmarksPerTrackedFeature: number;

  /* ---- MAP-008 ---- */
  readonly meanLandmarkMs: number;
  readonly amortisedMsPerFrame: number;
  readonly costSamples: number;

  /* ---- MAP-009 ---- */
  readonly rateOutOfRange: number;
  /** Batches where `admitted + merged + rejected` did not equal the point count. Must be 0. */
  readonly accountingMismatches: number;
  /** Unregistered batches that admitted something anyway. Must be 0. */
  readonly unregisteredAdmissions: number;
  readonly sizeMismatches: number;
}
