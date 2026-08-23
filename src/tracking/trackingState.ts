/**
 * §33's tracking state, as one pure function of measured quantities.
 *
 * **Every "§33" in this file means spec v3.0 §33.** Spec v4.0 lists "Tracking State" as a
 * field of the Spatial World runtime state (v4 §25) and does not enumerate the states or
 * their conditions. v3 did, Phase 4 passed on the device against them, and dropping a
 * conjunct because the newer document is quieter would be relaxing a criterion after a
 * result — which is what §29 exists to prevent. `docs/SPEC-VERSIONS.md` records every number
 * in this position.
 *
 * §33 names six states: `READY`, `TRACKING`, `GOOD`, `DEGRADED`, `LOST`, `RELOCALIZING`.
 * Phase 4 owns the first five; relocalisation is §21 and belongs to Phase 8 and beyond, so
 * it is absent here rather than present and unreachable.
 *
 * **Why this is a function and not a field.** Phase 3's `stateMismatches` counter exists
 * because a state that is *assigned* can disagree with the numbers displayed beside it, and
 * a screen showing `GOOD` over 40 features is a Rule 002 violation that no test looking only
 * at the state can see. So the state is computed here, from the measurements, in one place —
 * the worker computes it, the screen displays what the worker computed, and the statistics
 * recompute it from the reported inputs and count every frame where the two disagree. If
 * anything ever drifts, the counter says so.
 *
 * ## §33's GOOD, and the two terms Phase 4 cannot measure
 *
 * §33 defines the GOOD candidate condition as three conjuncts:
 *
 *     features >= 300  AND  inlierRatio >= 0.50  AND  reprojectionError <= 2.0 px
 *
 * Phase 4 can measure the first. `inlierRatio` comes from §14's geometric verification
 * (Phase 5) and `reprojectionError` from §15's pose (Phase 6); neither has been written, and
 * a number for either would be invented. So `inlierRatio` and `reprojectionError` are
 * `null` here, a null fails its conjunct, and **`GOOD` is therefore unreachable in Phase 4
 * by construction** — with `goodBlockedBy` saying which terms are missing rather than the
 * state silently rounding up to it.
 *
 * That is deliberate and it is the same decision `featureTypes` made about
 * `forwardBackwardError` in Phase 3: for a criterion you cannot evaluate, the honest value
 * is "not measured", not the value that would be most convenient. When Phase 5 and Phase 6
 * exist they pass real numbers in and `GOOD` becomes reachable without this function
 * changing.
 */

import { DEGRADED_BELOW } from './featureTypes';

export const TrackingState = {
  /** Features exist but no frame pair has been tracked yet — there is nothing to judge. */
  READY: 'READY',
  TRACKING: 'TRACKING',
  GOOD: 'GOOD',
  DEGRADED: 'DEGRADED',
  LOST: 'LOST',
} as const;
export type TrackingState = (typeof TrackingState)[keyof typeof TrackingState];

/** §33's GOOD candidate condition, first conjunct. */
export const GOOD_FEATURES = 300;
/** §11's `TRACKING DEGRADED` threshold, reused — the same number, in the same units. */
export const DEGRADED_FEATURES = DEGRADED_BELOW;
/** §33's GOOD candidate condition, second conjunct. Phase 5 measures it. */
export const GOOD_INLIER_RATIO = 0.5;
/** §33's GOOD candidate condition, third conjunct, in pixels. Phase 6 measures it. */
export const GOOD_REPROJECTION_PX = 2.0;

/**
 * Fraction of the offered points that must survive one frame before the frame counts as a
 * tracking failure.
 *
 * A ratio, and §H.6 warns that a criterion normalised by the data it judges cannot express
 * "there is nothing here" — survival is 1.0 when one point was offered and one survived. The
 * complement here is not another threshold but a separate state: DEGRADED is the absolute
 * statement, on the count, in §11's units. `LOST_INLIERS` below records the absolute floor
 * §33 names and why it belongs to Phase 5 rather than here.
 */
export const LOST_SURVIVAL = 0.2;

/**
 * §33's other LOST condition — `inliers < 20` — and why Phase 4 does not evaluate it.
 *
 * Inliers come from §14's geometric verification, which is Phase 5 and has not been written.
 * Phase 4 has tracked points, which are a different quantity: every tracked point is a
 * correspondence that survived §13, and none of them has been tested against a geometric
 * model. Reusing this number for them would be relabelling one measurement as another.
 *
 * It was tried the other way round first, and the run said no. Applying the floor to tracked
 * points made *every* frame of a 20-feature scene a failure — survival 19/20 is a tracker
 * working perfectly — so the state sat at LOST for a run in which nothing had been lost, and
 * FLOW-005 could not distinguish a covered lens from a sparse one. A population too small to
 * work with is what DEGRADED says (§11's threshold, on the count); LOST is about losing what
 * you had.
 *
 * So Phase 4 evaluates only §33's *consecutive-failure* branch, and the constant is kept here
 * named and unused so that Phase 5 wires it to the quantity it actually describes rather than
 * reinventing a threshold.
 */
export const LOST_INLIERS = 20;

/**
 * §33: "1 Frame失敗だけでLOSTにしない。初期：3 consecutive failed frames → LOST."
 */
export const LOST_CONSECUTIVE_FAILURES = 3;

/**
 * Everything the state is allowed to depend on.
 *
 * All of it measured this frame, except the failure run, which is a count of measured
 * frames. Nothing here is asserted by the harness or chosen by the operator.
 */
export interface TrackingMeasurement {
  /** Whether any frame pair has been tracked at all. Before that the state is READY. */
  readonly everTracked: boolean;
  /** Points that survived tracking from the previous frame into this one. */
  readonly trackedCount: number;
  /** The whole population, tracked plus freshly detected. §33's "features" count. */
  readonly totalCount: number;
  /** Consecutive frames whose tracking counted as a failure, this one included. */
  readonly consecutiveFailedFrames: number;
  /** Phase 5's, when it exists. `null` until then, and a null fails GOOD's conjunct. */
  readonly inlierRatio: number | null;
  /** Phase 6's, when it exists. `null` until then. */
  readonly reprojectionError: number | null;
}

/**
 * Whether one frame's tracking counts as a failure, for §33's consecutive-failure rule.
 *
 * A failure is *losing* the population: fewer than `LOST_SURVIVAL` of the points offered came
 * through. It is deliberately not "the population is small" — that is what DEGRADED says, and
 * conflating the two makes a sparse scene indistinguishable from a covered lens (see
 * `LOST_INLIERS`).
 *
 * A frame that offered the tracker nothing (the first frame of a run) is not a failure:
 * there was nothing to fail at, and counting it would drive the state to LOST on a run that
 * had not started. A frame that offered nothing *after* tracking has begun is a different
 * matter and `FlowTracker` counts it, because there the population went to zero and stayed
 * there.
 */
export function frameCountsAsFailure(offered: number, tracked: number): boolean {
  if (offered <= 0) return false;
  return tracked / offered < LOST_SURVIVAL;
}

export interface StateDerivation {
  readonly state: TrackingState;
  /** Why, in the words of the criterion that decided it. Displayed and recorded verbatim. */
  readonly reason: string;
  /**
   * The §33 GOOD conjuncts that could not be evaluated, named.
   *
   * Empty only when Phase 5 and Phase 6 exist and supply their terms. Until then this is
   * the reason a healthy run reports `TRACKING` rather than `GOOD`, and it is carried into
   * the evidence so the absence is visible instead of looking like a tracker that never got
   * good enough.
   */
  readonly goodBlockedBy: readonly string[];
}

/**
 * The state, and nothing else deciding it.
 *
 * Order matters and follows §33: LOST is a run of failures, not one bad frame; DEGRADED is
 * §11's count threshold; GOOD needs all three conjuncts; everything else that is tracking is
 * TRACKING.
 */
export function deriveTrackingState(m: TrackingMeasurement): StateDerivation {
  const goodBlockedBy: string[] = [];
  if (m.inlierRatio === null) {
    goodBlockedBy.push('inlierRatio — §14 geometric verification (Phase 5) has not been written');
  } else if (m.inlierRatio < GOOD_INLIER_RATIO) {
    goodBlockedBy.push(`inlierRatio ${m.inlierRatio} < ${GOOD_INLIER_RATIO}`);
  }
  if (m.reprojectionError === null) {
    goodBlockedBy.push('reprojectionError — §15 pose (Phase 6) has not been written');
  } else if (m.reprojectionError > GOOD_REPROJECTION_PX) {
    goodBlockedBy.push(`reprojectionError ${m.reprojectionError} > ${GOOD_REPROJECTION_PX} px`);
  }
  if (m.totalCount < GOOD_FEATURES) {
    goodBlockedBy.push(`features ${m.totalCount} < ${GOOD_FEATURES}`);
  }

  if (!m.everTracked) {
    return {
      state: TrackingState.READY,
      reason:
        `${m.totalCount} feature(s) detected and no frame pair tracked yet — there is ` +
        'nothing to judge until a second frame arrives',
      goodBlockedBy,
    };
  }

  if (m.consecutiveFailedFrames >= LOST_CONSECUTIVE_FAILURES) {
    return {
      state: TrackingState.LOST,
      reason:
        `${m.consecutiveFailedFrames} consecutive frames kept under ` +
        `${Math.round(LOST_SURVIVAL * 100)}% of the points offered to the tracker — §33 ` +
        `requires ${LOST_CONSECUTIVE_FAILURES} in a row, so a single bad frame does not reach ` +
        `here. §33's other LOST condition, inliers < ${LOST_INLIERS}, needs §14's geometric ` +
        'verification and is Phase 5\'s to evaluate',
      goodBlockedBy,
    };
  }

  if (m.trackedCount < DEGRADED_FEATURES) {
    return {
      state: TrackingState.DEGRADED,
      reason:
        `${m.trackedCount} tracked point(s), below §11's ${DEGRADED_FEATURES}. Detection may ` +
        'have topped the population up, but a refilled point has no history and cannot carry ' +
        'the pose §15 will ask for',
      goodBlockedBy,
    };
  }

  if (goodBlockedBy.length === 0) {
    return {
      state: TrackingState.GOOD,
      reason:
        `${m.totalCount} features, inlier ratio ${m.inlierRatio}, reprojection error ` +
        `${m.reprojectionError} px — all three of §33's GOOD conjuncts met`,
      goodBlockedBy,
    };
  }

  return {
    state: TrackingState.TRACKING,
    reason:
      `${m.trackedCount} of ${m.totalCount} points carried from the previous frame. GOOD is ` +
      `not claimed: ${goodBlockedBy.join('; ')}`,
    goodBlockedBy,
  };
}

/** The state alone, for the callers that only need to compare. */
export function trackingStateFor(m: TrackingMeasurement): TrackingState {
  return deriveTrackingState(m).state;
}
