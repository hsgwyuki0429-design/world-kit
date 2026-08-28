/**
 * Phase 5 test suite — GEO-001..GEO-006.
 *
 * Specs transcribed from `docs/phase5/TEST-PLAN.md`, written and committed before
 * `src/geometry/` existed (§29). Same verdict algebra as the phases before it: PASS / FAIL /
 * PENDING, with PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `VerificationStats` and nothing else — no DOM, no worker, no camera — so the
 * suite can be shown a run driven by the real verifier and one driven by a stage that **returns
 * every correspondence as an inlier**, and checked that the two produce different verdicts.
 *
 * **The claim.** v3 §14 names four figures — 30 inliers, ratio 0.35, 100 inliers, ratio 0.50 —
 * and *every one of them is satisfied perfectly by accepting everything*, because then the
 * inlier count is the correspondence count and the ratio is exactly 1.00. The exception is
 * GEO-003, which scores the verifier against outliers the harness made and it never saw.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  DEGENERATE_SPREAD_PX,
  GOOD_INLIERS,
  GOOD_INLIER_RATIO,
  MIN_BASELINE_PX,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  RANSAC_THRESHOLD_PX,
  USABLE_INLIER_RATIO,
  VerificationState,
} from '../geometry/verify';
import {
  OUTLIER_INJECTION_FRACTION,
  OUTLIER_INJECTION_PX,
} from '../tracking/VerificationStage';
import { TEXTURE_POOR_CEILING, TEXTURE_RICH_FLOOR } from '../tracking/featureTypes';
import type { VerificationStats } from '../tracking/verificationStats';
import type { Evaluation, PhaseTest } from './runTests';
import { pct, runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged frames of a condition before that condition is decided. */
export const MIN_JUDGED_FRAMES = 15;
/** GEO-003: of the harness's own outliers, this many must be rejected. */
export const MIN_OUTLIER_RECALL = 0.9;
/** ...while untouched correspondences are not rejected wholesale. */
export const MAX_CLEAN_REJECTION = 0.3;
/** ...and the paired form: the injected rate must beat the untouched rate by this factor. */
export const INJECTION_ADVANTAGE = 3.0;
/** §H's line for RANSAC (E/H) + pose recovery. */
export const GEO_BUDGET_MS = 6.0;
/** GEO-005 needs a population before a mean means anything. */
export const MIN_COST_SAMPLES = 10;
/** GEO-003 needs this many measurements before its median means anything. */
export const MIN_INJECTION_SAMPLES = 10;

export interface Phase5Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** Verification was switched on at least once in this run. */
  readonly verificationEverRan: boolean;
  readonly stats: VerificationStats;
}

type Phase5Test = PhaseTest<Phase5Context>;

function notRunning(ctx: Phase5Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.verificationEverRan && ctx.stats.verifiedFrames > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `geometric verification has not run (camera ${ctx.cameraState})`,
    reason: 'no correspondence set has been verified, so there is nothing to judge',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const GEO_001: Phase5Test = {
  spec: {
    id: 'GEO-001',
    title: 'High inlier scene',
    required: true,
    input: `frame pairs with a measured baseline over ${MIN_BASELINE_PX} px on a texture-rich scene`,
    expected: 'a large, consistent inlier set that satisfies v3 §14’s usable figures',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} judged frames; median inliers >= ${MIN_INLIERS} and median inlier ` +
      `ratio >= ${USABLE_INLIER_RATIO} (both v3 §14); the inlier set’s spatial spread clears ` +
      `${DEGENERATE_SPREAD_PX} px; RANSAC reached its own confidence target rather than its cap`,
    failureCondition:
      'a ratio that clears the bar on a set too small or too clustered to determine a model; ' +
      'or a run where the iteration cap always bound, so the reported ratio is whatever the ' +
      'last sample gave rather than an estimate with a probability behind it',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      judgedFrames: s.judgedFrames,
      medianInliers: s.medianInliers,
      medianInlierRatio: s.medianInlierRatio,
      medianCorrespondences: s.medianCorrespondences,
      medianBaselinePx: s.medianBaselinePx,
      medianSpreadPx: s.medianSpreadPx,
      cappedFrames: s.cappedFrames,
      verifiedFrames: s.verifiedFrames,
      textureRich: s.textureRich as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.judgedFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.judgedFrames}/${MIN_JUDGED_FRAMES} judged frames so far`,
        reason:
          `a frame is judged only when it has at least ${MIN_CORRESPONDENCES} correspondences ` +
          `and the two views are at least ${MIN_BASELINE_PX} px apart. Move the phone: with no ` +
          'baseline every model fits perfectly and the ratio would be 1.00 without verifying ' +
          'anything',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianInliers < MIN_INLIERS) {
      problems.push(
        `median ${s.medianInliers} inliers, below v3 §14's minimum of ${MIN_INLIERS}`,
      );
    }
    if (s.medianInlierRatio < USABLE_INLIER_RATIO) {
      problems.push(
        `median inlier ratio ${s.medianInlierRatio}, below v3 §14's usable ${USABLE_INLIER_RATIO}`,
      );
    }
    if (s.medianSpreadPx < DEGENERATE_SPREAD_PX) {
      problems.push(
        `the inliers sit ${s.medianSpreadPx} px about their own centroid, under ` +
          `${DEGENERATE_SPREAD_PX} px — a model fitted to a cluster that tight leaves the ` +
          'geometry undetermined everywhere else in the frame',
      );
    }
    if (s.cappedFrames >= s.verifiedFrames) {
      problems.push(
        `RANSAC hit its iteration cap on all ${s.cappedFrames} frames — the confidence target ` +
          'was never met, so the reported ratio is the best of a fixed number of samples ' +
          'rather than an estimate',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.judgedFrames} judged frames: median ${s.medianInliers} inliers of ` +
        `${s.medianCorrespondences} correspondences (ratio ${s.medianInlierRatio}), baseline ` +
        `${s.medianBaselinePx} px, spread ${s.medianSpreadPx} px; ${s.cappedFrames} frame(s) ` +
        'hit the iteration cap',
      reason:
        problems.length === 0
          ? 'a consistent subset of the tracked correspondences agrees on one geometric model, ' +
            'at v3 §14’s usable figures. On its own this proves nothing — a verifier that ' +
            'accepted everything would report a ratio of exactly 1.00 — and GEO-003 is what ' +
            'separates the two'
          : problems.join('; '),
      metrics,
    };
  },
};

const GEO_002: Phase5Test = {
  spec: {
    id: 'GEO-002',
    title: 'Low texture scene',
    required: true,
    input: `frames the worker classified TEXTURE_POOR, where few correspondences exist`,
    expected: 'the phase declines to verify, and says so',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} texture-poor frames; every frame with fewer than ` +
      `${MIN_CORRESPONDENCES} correspondences or fewer than ${MIN_INLIERS} inliers reports ` +
      'UNVERIFIED — never USABLE, never GOOD; the state never disagrees with its own inputs',
    failureCondition:
      'a USABLE or GOOD verdict reached on a correspondence set too small for v3 §14’s minimum',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const poor = s.texturePoor;
    const metrics: Record<string, JsonValue> = {
      poorFrames: poor.frames,
      poorJudged: poor.judged,
      poorMedianCorrespondences: poor.medianCorrespondences,
      poorMedianInliers: poor.medianInliers,
      poorStates: { UNVERIFIED: poor.unverified, USABLE: poor.usable, GOOD: poor.good },
      verdictOnThinEvidence: poor.verdictOnThinEvidence,
      goodOnThinEvidence: poor.goodOnThinEvidence,
      stateMismatches: s.stateMismatches,
      textureRich: s.textureRich as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (poor.frames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${poor.frames}/${MIN_JUDGED_FRAMES} texture-poor frames so far`,
        reason:
          `point the camera at a blank surface for a couple of seconds. A frame counts as poor ` +
          `when its own mean gradient magnitude is at or below ${TEXTURE_POOR_CEILING} — that ` +
          'is measured from the image, not asserted here',
        metrics,
      };
    }

    const problems: string[] = [];
    // The whole point of the test: a thin correspondence set must not produce a verdict.
    //
    // Counted **per frame**, because that is what the criterion says. The first version compared
    // the class's *median* correspondence count against the threshold and then blamed whichever
    // frames had reported USABLE — two different statements, and the device run of 2026-08-28
    // failed on the difference. It saw 59 judgeable texture-poor frames with a median of 14
    // correspondences, 23 USABLE and 1 GOOD, and reported the 24 as verdicts on 14
    // correspondences. They were nothing of the kind: 546 of those frames were UNVERIFIED
    // precisely because they were under the threshold, which is what dragged the median down,
    // and `stateMismatches` was 0 — every state agreed with its own inputs. §H.7: an invariant
    // that averages cannot verify a geometry.
    if (poor.verdictOnThinEvidence > 0) {
      problems.push(
        `${poor.verdictOnThinEvidence} texture-poor frame(s) reported USABLE or GOOD with fewer ` +
          `than ${MIN_CORRESPONDENCES} correspondences or fewer than ${MIN_INLIERS} inliers — ` +
          'a verdict on a set too small to fit anything worth checking',
      );
    }
    if (poor.goodOnThinEvidence > 0) {
      problems.push(
        `${poor.goodOnThinEvidence} of them reported GOOD, below v3 §14's minimum of ` +
          `${MIN_INLIERS} inliers`,
      );
    }
    if (s.stateMismatches > 0) {
      problems.push(
        `${s.stateMismatches} frame(s) reported a state that disagreed with their own measured ` +
          'inputs — the UI and the engine may not diverge (Rule 002)',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${poor.frames} texture-poor frames, ${poor.judged} judgeable: median ` +
        `${poor.medianCorrespondences} correspondences, ${poor.medianInliers} inliers; ` +
        `${poor.unverified} UNVERIFIED, ${poor.usable} USABLE, ${poor.good} GOOD; ` +
        `${poor.verdictOnThinEvidence} verdict(s) on evidence too thin for one`,
      reason:
        problems.length === 0
          ? 'where the scene did not supply enough correspondences, the phase reported that ' +
            'rather than a ratio computed over four points. §44’s fail-closed rule says the ' +
            'same thing: when the information is not there, lower the state rather than making ' +
            'the result convenient'
          : problems.join('; '),
      metrics,
    };
  },
};

const GEO_003: Phase5Test = {
  spec: {
    id: 'GEO-003',
    title: 'Outlier-heavy scene',
    required: true,
    input:
      `the real correspondence set with ${Math.round(OUTLIER_INJECTION_FRACTION * 100)}% of its ` +
      `targets displaced ${OUTLIER_INJECTION_PX} px by the harness, handed to the verifier unmarked`,
    expected: 'RANSACでOutlierが除外される — v3 §66’s pass condition, verbatim',
    passCriteria:
      `>= ${MIN_INJECTION_SAMPLES} injected frames; >= ${MIN_OUTLIER_RECALL} of the injected ` +
      `outliers rejected; <= ${MAX_CLEAN_REJECTION} of untouched correspondences rejected; the ` +
      `surviving inlier count still reaching ${MIN_INLIERS}; and the injected rejection rate at ` +
      `least ${INJECTION_ADVANTAGE}x the untouched rate`,
    failureCondition:
      'injected outliers accepted as inliers. A verifier that returns everything scores a recall ' +
      'of 0.00 here while satisfying every criterion in GEO-001',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      injectionSamples: s.injectionSamples,
      medianInjectedRecall: s.medianInjectedRecall,
      medianCleanRejection: s.medianCleanRejection,
      medianSurvivingInliers: s.medianSurvivingInliers,
      injectionFraction: OUTLIER_INJECTION_FRACTION,
      displacementPx: OUTLIER_INJECTION_PX,
      thresholdPx: RANSAC_THRESHOLD_PX,
      recent: s.injections.slice(-6) as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.injectionSamples < MIN_INJECTION_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.injectionSamples}/${MIN_INJECTION_SAMPLES} injected frames so far`,
        reason:
          'the injection runs on a sample of frames because it costs a second RANSAC pass, and ' +
          `it only runs where there are at least ${MIN_CORRESPONDENCES} correspondences to ` +
          'corrupt. Keep verifying',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianInjectedRecall < MIN_OUTLIER_RECALL) {
      problems.push(
        `only ${pct(s.medianInjectedRecall)} of the harness's own outliers were rejected, ` +
          `against ${pct(MIN_OUTLIER_RECALL)} required. They were displaced ` +
          `${OUTLIER_INJECTION_PX} px, which is ${Math.round(OUTLIER_INJECTION_PX / RANSAC_THRESHOLD_PX)}x ` +
          'the inlier threshold — a verifier that accepts them is not verifying'
      );
    }
    if (s.medianCleanRejection > MAX_CLEAN_REJECTION) {
      problems.push(
        `${pct(s.medianCleanRejection)} of untouched correspondences were rejected too, against ` +
          `${pct(MAX_CLEAN_REJECTION)} allowed — this is rejecting wholesale rather than ` +
          'discriminating',
      );
    }
    if (s.medianSurvivingInliers < MIN_INLIERS) {
      problems.push(
        `${s.medianSurvivingInliers} inliers survived the injection, below v3 §14's ` +
          `${MIN_INLIERS} — the rejection cost the frame its usability`,
      );
    }
    // The paired form, so a verifier that rejects at random cannot pass by rejecting enough.
    if (
      s.medianCleanRejection > 0 &&
      s.medianInjectedRecall < s.medianCleanRejection * INJECTION_ADVANTAGE
    ) {
      problems.push(
        `injected correspondences were rejected at ${pct(s.medianInjectedRecall)} against ` +
          `${pct(s.medianCleanRejection)} for untouched ones — under the ${INJECTION_ADVANTAGE}x ` +
          'margin that separates discriminating from rejecting at random',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.injectionSamples} injected frames: ${pct(s.medianInjectedRecall)} of the injected ` +
        `outliers rejected against ${pct(s.medianCleanRejection)} of untouched ones, ` +
        `${s.medianSurvivingInliers} inliers surviving`,
      reason:
        problems.length === 0
          ? 'the verifier found outliers it was never told about. The harness displaced ' +
            `${Math.round(OUTLIER_INJECTION_FRACTION * 100)}% of the targets by ` +
            `${OUTLIER_INJECTION_PX} px and handed the set over unmarked; this is the one ` +
            'number in Phase 5 that a stage returning its input cannot produce, because ' +
            'returning its input scores exactly 0 while satisfying every count-based criterion ' +
            'v3 §14 names'
          : problems.join('; '),
      metrics,
    };
  },
};

const GEO_004: Phase5Test = {
  spec: {
    id: 'GEO-004',
    title: 'Planar scene handling',
    required: true,
    input: 'every judged frame — both a fundamental matrix and a homography are fitted on all of them',
    expected: 'v3 §16’s comparison is made, and PLANAR SCENE follows from the two inlier counts',
    passCriteria:
      `both models fitted on >= ${MIN_JUDGED_FRAMES} frames; the planar flag follows from the ` +
      'two counts on every frame; both counts recorded per frame; and both outcomes seen, or ' +
      'the run reports which it never saw',
    failureCondition:
      'a run that fitted only one model; or a PLANAR flag that does not follow from the two ' +
      'counts beside it',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      bothModelsFitted: s.bothModelsFitted,
      planarFrames: s.planarFrames,
      nonPlanarFrames: s.nonPlanarFrames,
      planarMismatches: s.planarMismatches,
      medianFundamentalInliers: s.medianFundamentalInliers,
      medianHomographyInliers: s.medianHomographyInliers,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.bothModelsFitted < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.bothModelsFitted}/${MIN_JUDGED_FRAMES} frames with both models fitted`,
        reason:
          'both models are fitted on every frame that has enough correspondences; keep ' +
          'verifying until enough frames have',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.planarMismatches > 0) {
      problems.push(
        `${s.planarMismatches} frame(s) carried a planar flag that does not follow from the two ` +
          'inlier counts reported beside it — the decision must be auditable, not asserted',
      );
    }
    if (s.planarFrames === 0 && s.nonPlanarFrames === 0) {
      problems.push('neither outcome was recorded despite both models being fitted');
    }
    // A run that only ever saw one outcome cannot decide the other half, and says so rather
    // than being counted as having tested it.
    if (s.planarFrames === 0 || s.nonPlanarFrames === 0) {
      const missing = s.planarFrames === 0 ? 'planar' : 'non-planar';
      return {
        verdict: problems.length > 0 ? Verdict.FAIL : Verdict.PENDING,
        observed:
          `${s.bothModelsFitted} frames with both models fitted: ${s.planarFrames} planar, ` +
          `${s.nonPlanarFrames} non-planar; median ${s.medianFundamentalInliers} F inliers ` +
          `against ${s.medianHomographyInliers} H`,
        reason:
          problems.length > 0
            ? problems.join('; ')
            : `this run never produced a ${missing} frame pair, so that half of the comparison ` +
              'is untested. Point the camera at a flat wall and then at a scene with depth in ' +
              'it — a corner of the room, or objects at different distances',
        metrics,
      };
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.bothModelsFitted} frames with both models fitted: ${s.planarFrames} planar, ` +
        `${s.nonPlanarFrames} non-planar; median ${s.medianFundamentalInliers} fundamental ` +
        `inliers against ${s.medianHomographyInliers} homography`,
      reason:
        problems.length === 0
          ? 'both models were fitted on every judged frame and the planar flag follows from ' +
            'their two counts. The fundamental matrix is the weaker constraint and normally ' +
            'admits at least as many points, so the homography reaching it is the signal — and ' +
            'v3 §16 requires that case to lower translation confidence in Phase 6, because an ' +
            'Essential matrix decomposed from a planar scene is degenerate and gives a pose ' +
            'that looks entirely reasonable'
          : problems.join('; '),
      metrics,
    };
  },
};

const GEO_005: Phase5Test = {
  spec: {
    id: 'GEO-005',
    title: 'Verification cost',
    required: false,
    input: 'the measured cost of the RANSAC pass per frame',
    expected: 'verification fits §H’s budget, with the correspondence count recorded alongside',
    passCriteria: `mean <= ${GEO_BUDGET_MS} ms over >= ${MIN_COST_SAMPLES} frames`,
    failureCondition:
      'over budget. Advisory because §34 ranks correctness above performance, and because a ' +
      'device budget cannot be adjudicated off the device (§H.4)',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanVerifyMs: s.meanVerifyMs,
      samples: s.verifyCostSamples,
      budgetMs: GEO_BUDGET_MS,
      medianCorrespondences: s.medianCorrespondences,
      cappedFrames: s.cappedFrames,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.verifyCostSamples < MIN_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.verifyCostSamples}/${MIN_COST_SAMPLES} frames measured`,
        reason: 'a mean over a handful of frames says nothing; keep verifying',
        metrics,
      };
    }
    const over = s.meanVerifyMs > GEO_BUDGET_MS;
    return {
      verdict: over ? Verdict.FAIL : Verdict.PASS,
      observed:
        `${s.meanVerifyMs} ms mean over ${s.verifyCostSamples} frames at a median of ` +
        `${s.medianCorrespondences} correspondences, both models fitted, ` +
        `${s.cappedFrames} frame(s) at the iteration cap`,
      reason: over
        ? `mean ${s.meanVerifyMs} ms exceeds the ${GEO_BUDGET_MS} ms §H budgets for RANSAC. ` +
          'Both models are still fitted on every frame — v3 §16 is not skipped to save time'
        : 'verification fits its budget with both models fitted on every judged frame',
      metrics,
    };
  },
};

const GEO_006: Phase5Test = {
  spec: {
    id: 'GEO-006',
    title: 'Metadata honesty',
    required: false,
    input: 'the verification records themselves',
    expected: 'the phase claims a model only where it verified one, and no term it cannot measure',
    passCriteria:
      'inliers plus outliers equal the correspondence count on every frame; no frame reporting ' +
      'UNVERIFIED carries a model; the state is never inconsistent with its own inputs',
    failureCondition: 'any of the above unmet — in particular a model attached to a verdict of none',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      partitionFaults: s.partitionFaults,
      modelWithoutVerdict: s.modelWithoutVerdict,
      stateMismatches: s.stateMismatches,
      degenerateFrames: s.degenerateFrames,
      verifiedFrames: s.verifiedFrames,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.partitionFaults > 0) {
      problems.push(
        `${s.partitionFaults} frame(s) whose inliers and outliers did not add up to the ` +
          'correspondence count — a correspondence was lost or counted twice',
      );
    }
    if (s.modelWithoutVerdict > 0) {
      problems.push(
        `${s.modelWithoutVerdict} frame(s) reported UNVERIFIED while still carrying a model. ` +
          'A frame that verified nothing has no model, rather than a model with a note attached',
      );
    }
    if (s.stateMismatches > 0) {
      problems.push(`${s.stateMismatches} frame(s) reported a state their own inputs do not imply`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.verifiedFrames} frames inspected: partition intact, no model on an unverified ` +
        `frame, no state inconsistent with its inputs, ${s.degenerateFrames} frame(s) reported ` +
        'as degenerate rather than verified',
      reason:
        problems.length === 0
          ? 'the record says what was verified and nothing else. §15’s reprojection error stays ' +
            'null through this phase: an inlier’s residual against a fundamental matrix is a ' +
            'Sampson distance, not a reprojection error, and calling it one would be claiming ' +
            'a pose that has not been computed'
          : problems.slice(0, 5).join('; '),
      metrics,
    };
  },
};

export const PHASE5_TESTS: readonly Phase5Test[] = [
  GEO_001, GEO_002, GEO_003, GEO_004, GEO_005, GEO_006,
];

export const PHASE5_SPECS: readonly TestSpec[] = PHASE5_TESTS.map((t) => t.spec);

export function runPhase5Tests(ctx: Phase5Context): TestResult[] {
  return runTests(PHASE5_TESTS, ctx);
}

/** Re-exported so the screen shows the same numbers the tests judge (Rule 002). */
export { GOOD_INLIERS, GOOD_INLIER_RATIO, MIN_INLIERS, USABLE_INLIER_RATIO, VerificationState };
export { TEXTURE_RICH_FLOOR };
