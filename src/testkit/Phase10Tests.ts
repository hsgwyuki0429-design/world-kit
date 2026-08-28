/**
 * Phase 10 test suite — MAP-001..MAP-009.
 *
 * Specs transcribed from `docs/phase10/TEST-PLAN.md`, written and committed before
 * `src/mapping/landmarks.ts` existed (§29). Same verdict algebra as the phases before it.
 *
 * Every test reads `LandmarkStats` and nothing else, so the suite can be shown a run driven by
 * the real map beside one driven by a map that overwrites each landmark with the newest
 * triangulation, and checked that the two produce different verdicts.
 * `tests/unit/landmarks.test.ts` does that.
 *
 * **The claim.** A map with no memory scores *well* on almost everything here. Every landmark
 * agrees with the most recent observation exactly, nothing is ever inconsistent, the counts add
 * up, the bound holds and the culling never has anything to do. MAP-002 is the one number it
 * cannot produce — it has nothing to predict *with* — and MAP-005 is the one a map that keeps
 * everything cannot.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  MAX_LANDMARKS,
  MAX_LANDMARK_REPROJECTION_PX,
  MAX_REGISTRATION_RESIDUAL,
  MIN_OBSERVATIONS_CONFIRMED,
  MIN_REGISTRATION_POINTS,
  SCALE_LOCAL_UNITS,
} from '../mapping/landmarks';
import { LANDMARK_INJECTION_FRACTION } from '../tracking/LandmarkStage';
import type { LandmarkStats } from '../tracking/landmarkStats';
import type { Evaluation, PhaseTest } from './runTests';
import { pct, runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged batches of a condition before that condition is decided. As Phases 3–9 used. */
export const MIN_JUDGED_BATCHES = 15;
/** MAP-005: **GEO-003's** floor, reused — the same shape of measurement one layer up. */
export const INJECTION_RECALL_FLOOR = 0.9;
/**
 * ...and its companion — as an **excess over the batch's own baseline**, not as an absolute rate.
 *
 * Amended with the measurement that forced it (§29). GEO-003's 0.10 is an absolute rate because
 * its verifier either fits a correspondence to a model or does not; this gate compares **two
 * estimates of one point**, and refuses the ordinary tail of their disagreement whether or not
 * anything was injected — measured at 3–20 % on *uncorrupted* batches of the unit fixture. An
 * absolute ceiling on it is a measurement of how noisy the scene is.
 *
 * So the injection reports what the same gate refused on the same batch **without** the
 * displacement, and the criterion is the difference: did corrupting a third of the batch make
 * the gate suspicious of the innocent? Measured excess on the fixture: 0.032 to 0.053.
 */
export const MAX_CLEAN_CULL_EXCESS = 0.1;
export const MIN_INJECTIONS = 3;
/** Half Phase 9's per-batch ceiling: this stage fits no two-view model. */
export const LANDMARK_BUDGET_MS = 4.0;
export const MIN_COST_SAMPLES = 5;

export interface Phase10Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  readonly landmarksEverRan: boolean;
  readonly stats: LandmarkStats;
}

type Phase10Test = PhaseTest<Phase10Context>;

function notRunning(ctx: Phase10Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.landmarksEverRan && ctx.stats.batches > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `the map has been given no batch (camera ${ctx.cameraState})`,
    reason:
      'a batch reaches the map when Phase 9 triangulates a keyframe pair, so this needs the ' +
      'camera to be moving past a scene with depth in it',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const MAP_001: Phase10Test = {
  spec: {
    id: 'MAP-001',
    title: 'A map that persists',
    required: true,
    input: 'a run where Phase 9 is triangulating keyframe pairs',
    expected: 'landmarks that accumulate observations across batches, each with a stable identity',
    passCriteria:
      `>= ${MIN_JUDGED_BATCHES} batches offered; landmarks with more than one observation; every ` +
      'landmark carrying its id, observation count, observing keyframes, confidence and state',
    failureCondition:
      'a map whose landmarks all have exactly one observation — that is a list of the last ' +
      'batch, not a map',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      batches: s.batches,
      landmarks: s.landmarks,
      confirmed: s.confirmed,
      peakLandmarks: s.peakLandmarks,
      peakConfirmed: s.peakConfirmed,
      medianObservations: s.medianObservations,
      medianConfidence: s.medianConfidence,
      samples: s.samples as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.batches < MIN_JUDGED_BATCHES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.batches}/${MIN_JUDGED_BATCHES} batches offered to the map`,
        reason: 'keep moving — a batch is a keyframe pair Phase 9 triangulated',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.peakLandmarks === 0) problems.push('the map has never held anything');
    else if (s.peakConfirmed === 0) {
      problems.push(
        `no landmark has ever reached ${MIN_OBSERVATIONS_CONFIRMED} observations, so nothing has been ` +
          'seen from more than the pair that made it — that is a list of triangulations, not a map',
      );
    }
    const incomplete = s.samples.filter(
      (l) =>
        !Number.isFinite(l.id) ||
        l.position.length !== 3 ||
        !(l.observations >= 1) ||
        !(l.confidence >= 0) ||
        l.state.length === 0,
    );
    if (incomplete.length > 0) {
      problems.push(`${incomplete.length} sampled landmark(s) are missing part of their record`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.landmarks} landmark(s) held, ${s.confirmed} confirmed, over ${s.batches} batches ` +
        `(most ever held ${s.peakLandmarks}, confirmed ${s.peakConfirmed}); median ` +
        `${s.medianObservations} observations and ${s.medianConfidence} confidence`,
      reason:
        problems.length === 0
          ? 'landmarks accumulate across batches under a stable identity — the tracker’s own ' +
            'feature id, which is what lets a point seen now be recognised as one seen before'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_002: Phase10Test = {
  spec: {
    id: 'MAP-002',
    title: 'Held-out prediction',
    required: true,
    input:
      'every shared landmark whose position was computed without the keyframe the batch has ' +
      'just added',
    expected: 'the map says where it will be seen, and it is seen there',
    passCriteria:
      `>= ${MIN_JUDGED_BATCHES} batches with at least one held-out prediction; median error ` +
      `within ${MAX_LANDMARK_REPROJECTION_PX} px; the observation count at prediction time ` +
      'recorded; and the errors not identically zero',
    failureCondition:
      'a median outside the ceiling; or an error of exactly zero throughout, which means the ' +
      'position being predicted from is the observation being predicted',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      heldOutBatches: s.heldOutBatches,
      heldOutSamples: s.heldOutSamples,
      medianHeldOutPx: s.medianHeldOutPx,
      worstHeldOutPx: s.worstHeldOutPx,
      zeroHeldOut: s.zeroHeldOut,
      medianObservationsAtPrediction: s.medianObservationsAtPrediction,
      ceilingPx: MAX_LANDMARK_REPROJECTION_PX,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.heldOutBatches < MIN_JUDGED_BATCHES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.heldOutBatches}/${MIN_JUDGED_BATCHES} batches produced a held-out prediction`,
        reason:
          'a prediction needs a landmark the map already held and a keyframe it was not computed ' +
          'from. Keep the run going',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianHeldOutPx > MAX_LANDMARK_REPROJECTION_PX) {
      problems.push(
        `the map's predictions land ${s.medianHeldOutPx} px from where the tracker sees the ` +
          `points, past v3 §33's ${MAX_LANDMARK_REPROJECTION_PX} px`,
      );
    }
    if (s.heldOutSamples > 0 && s.zeroHeldOut === s.heldOutSamples) {
      problems.push(
        `all ${s.heldOutSamples} predictions were exactly right, which is not what a prediction ` +
          'is — the position being predicted from is the observation being predicted',
      );
    }
    if (s.medianObservationsAtPrediction < 1) {
      problems.push(
        'no prediction recorded the observation count its landmark had at the time, so there is ' +
          'nothing in the evidence to say the prediction preceded the merge',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `median ${s.medianHeldOutPx} px, worst ${s.worstHeldOutPx} px over ` +
        `${s.heldOutSamples} batch median(s); the landmarks had a median of ` +
        `${s.medianObservationsAtPrediction} observations when they were asked`,
      reason:
        problems.length === 0
          ? 'a position the map held before this batch, projected into a view it was not ' +
            'computed from, landing where the tracker saw it — the one thing a map that ' +
            'overwrites itself with the newest triangulation has nothing to do'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_003: Phase10Test = {
  spec: {
    id: 'MAP-003',
    title: 'One frame, and what it cost to get there',
    required: true,
    input: 'every batch offered to the map',
    expected: 'a similarity per batch whose scale is the ratio between two baselines',
    passCriteria:
      `every registered batch reporting the scale it recovered; median residual within ` +
      `${MAX_REGISTRATION_RESIDUAL}; unregisterable batches counted and not ingested; epochs ` +
      `counted; SCALE: ${SCALE_LOCAL_UNITS} throughout`,
    failureCondition: 'a batch ingested without a registration; or a metre anywhere',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      registeredBatches: s.registeredBatches,
      unregisteredBatches: s.unregisteredBatches,
      unregisteredReasons: s.unregisteredReasons as unknown as JsonValue,
      medianRegistrationScale: s.medianRegistrationScale,
      medianRegistrationResidual: s.medianRegistrationResidual,
      worstRegistrationResidual: s.worstRegistrationResidual,
      registrationOutliers: s.registrationOutliers,
      epochs: s.epochs,
      epochRestarts: s.epochRestarts,
      scale: s.scale,
      scaleViolations: s.scaleViolations,
      ingestedUnregistered: s.ingestedUnregistered,
      limit: MAX_REGISTRATION_RESIDUAL,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.registeredBatches === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `0 of ${s.batches} batches registered — ${JSON.stringify(s.unregisteredReasons)}`,
        reason:
          'the map needs a batch it can relate to what it already holds; the first defines the ' +
          'world and the rest need shared landmarks',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianRegistrationResidual > MAX_REGISTRATION_RESIDUAL) {
      problems.push(
        `median registration residual ${s.medianRegistrationResidual} against a limit of ` +
          `${MAX_REGISTRATION_RESIDUAL} — the batches and the map disagree about where the ` +
          'shared landmarks are',
      );
    }
    if (s.ingestedUnregistered > 0) {
      problems.push(`${s.ingestedUnregistered} batch(es) were ingested without a registration`);
    }
    if (s.scaleViolations > 0) {
      problems.push(`${s.scaleViolations} record(s) claimed a scale other than ${SCALE_LOCAL_UNITS}`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.registeredBatches} registered, ${s.unregisteredBatches} not ` +
        `(${JSON.stringify(s.unregisteredReasons)}); median scale ` +
        `${s.medianRegistrationScale}, residual ${s.medianRegistrationResidual} (worst ` +
        `${s.worstRegistrationResidual}); ${s.epochs} epoch(s), ${s.epochRestarts} restart(s)`,
      reason:
        problems.length === 0
          ? 'the scale a registration recovers is the ratio between that batch’s baseline and ' +
            'the world’s — the one quantity a monocular camera has no other way to obtain, and ' +
            'still not a metre'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_004: Phase10Test = {
  spec: {
    id: 'MAP-004',
    title: 'Bounded, and able to let go',
    required: true,
    input: 'the map over the whole run',
    expected: `at most ${MAX_LANDMARKS} landmarks, and a reason for every one that goes`,
    passCriteria:
      `the map never exceeded ${MAX_LANDMARKS}; every cull carrying a reason; landmarks whose ` +
      'observations stop agreeing culled and counted; every confidence in 0..1 and none of them ' +
      'a function of time',
    failureCondition:
      'a map above the bound; a cull with no reason; or a confidence that rises with nothing but ' +
      'time',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      landmarks: s.landmarks,
      bound: MAX_LANDMARKS,
      boundBreaches: s.boundBreaches,
      culled: s.culled,
      cullsByReason: s.cullsByReason as unknown as JsonValue,
      cullsWithoutReason: s.cullsWithoutReason,
      confidenceOutOfRange: s.confidenceOutOfRange,
      recentCulls: s.recentCulls as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.boundBreaches > 0) {
      problems.push(`${s.boundBreaches} batch(es) left the map above §56's ${MAX_LANDMARKS}`);
    }
    if (s.cullsWithoutReason > 0) {
      problems.push(`${s.cullsWithoutReason} cull(s) carried no reason`);
    }
    if (s.confidenceOutOfRange > 0) {
      problems.push(`${s.confidenceOutOfRange} confidence(s) outside 0..1`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.landmarks}/${MAX_LANDMARKS} held; ${s.culled} culled ` +
        `(${JSON.stringify(s.cullsByReason)})` +
        (s.culled === 0 ? ' — nothing has needed removing on this run' : ''),
      reason:
        problems.length === 0
          ? 'confidence is a function of observation count, parallax, prediction agreement and ' +
            'viewpoint spread — all measured, none of them a clock, which ' +
            '`audit-fake-data.mjs` enforces rather than review'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_005: Phase10Test = {
  spec: {
    id: 'MAP-005',
    title: 'Injected corruption',
    required: true,
    input:
      `on a sampled schedule, a known subset of the batch's positions displaced perpendicular ` +
      `to their viewing rays by ${LANDMARK_INJECTION_FRACTION} of their depth, handed over unmarked`,
    expected: 'the map’s own gate finds them',
    passCriteria:
      `>= ${MIN_INJECTIONS} injections; recall at least ${INJECTION_RECALL_FLOOR}; the rate at ` +
      'which untouched points were rejected no more than ' +
      `${MAX_CLEAN_CULL_EXCESS} above what the same gate refuses on the uncorrupted batch; and ` +
      'every one of those numbers reported',
    failureCondition:
      'a recall below the floor, or a false-cull rate that rises above the batch’s own baseline ' +
      'by more than the ceiling',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      injections: s.injections,
      medianRecall: s.medianRecall,
      worstRecall: s.worstRecall,
      medianCleanRejectionRate: s.medianCleanRejectionRate,
      medianBaselineRejectionRate: s.medianBaselineRejectionRate,
      medianCleanExcess: s.medianCleanExcess,
      worstCleanExcess: s.worstCleanExcess,
      displacementPx: s.injectionDisplacementPx,
      recallFloor: INJECTION_RECALL_FLOOR,
      excessCeiling: MAX_CLEAN_CULL_EXCESS,
      last: (s.lastInjection as unknown as JsonValue) ?? null,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.injections < MIN_INJECTIONS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.injections}/${MIN_INJECTIONS} injections`,
        reason:
          'the injection runs on a sampled schedule, and only over points the map already holds ' +
          '— a point it has never seen has no position to disagree with',
        metrics,
      };
    }

    const problems: string[] = [];
    if (!(s.medianRecall >= INJECTION_RECALL_FLOOR)) {
      problems.push(
        `the map found ${pct(s.medianRecall)} of the positions the harness displaced, below the ` +
          `${pct(INJECTION_RECALL_FLOOR)} floor`,
      );
    }
    if (!(s.medianCleanExcess <= MAX_CLEAN_CULL_EXCESS)) {
      problems.push(
        `it rejected ${pct(s.medianCleanRejectionRate)} of the untouched points where the same ` +
          `gate refuses ${pct(s.medianBaselineRejectionRate)} of them on the uncorrupted batch — ` +
          `an excess of ${pct(s.medianCleanExcess)}, above the ${pct(MAX_CLEAN_CULL_EXCESS)} ` +
          'ceiling. A map that rejects everything scores a perfect recall',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${pct(s.medianRecall)} recall; ${pct(s.medianCleanRejectionRate)} of the untouched ` +
        `points refused against a baseline of ${pct(s.medianBaselineRejectionRate)} on the same ` +
        `batches uncorrupted — an excess of ${pct(s.medianCleanExcess)} (worst ` +
        `${pct(s.worstCleanExcess)}) over ${s.injections} injections displacing by ` +
        `${s.injectionDisplacementPx} px`,
      reason:
        problems.length === 0
          ? 'the harness made the outliers, so it knows exactly which they are — and every one ' +
            'of the numbers is reported because each alone is scored perfectly by some ' +
            'degenerate map: recall by one that rejects everything, the untouched rate by one ' +
            'that rejects nothing, and an absolute untouched rate by a quiet scene'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_006: Phase10Test = {
  spec: {
    id: 'MAP-006',
    title: 'Convergence',
    required: true,
    input: 'the movement each new observation causes, relative to the landmark’s depth',
    expected: 'a position that settles as it is seen again',
    passCriteria:
      'the movement recorded per landmark; the median move at five or more observations at or ' +
      'below the median at two; and the sample count at each reported',
    failureCondition:
      'a movement that does not fall — a map whose landmarks random-walk is re-guessing rather ' +
      'than accumulating',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      moveAtTwo: s.moveAtTwo,
      moveAtFive: s.moveAtFive,
      moveAtTwoSamples: s.moveAtTwoSamples,
      moveAtFiveSamples: s.moveAtFiveSamples,
      medianMoveRelative: s.medianMoveRelative,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.moveAtTwoSamples === 0 || s.moveAtFiveSamples === 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${s.moveAtTwoSamples} batch median(s) at two observations, ${s.moveAtFiveSamples} at ` +
          'five or more',
        reason:
          'a landmark has to be seen five times before it can be asked whether it has settled. ' +
          'Keep the camera on the same part of the scene for longer',
        metrics,
      };
    }

    const problems: string[] = [];
    if (!(s.moveAtFive <= s.moveAtTwo)) {
      problems.push(
        `a landmark moves ${s.moveAtFive} of its depth on its fifth observation and ` +
          `${s.moveAtTwo} on its second — the position is not settling`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.moveAtTwo} of a depth at two observations (${s.moveAtTwoSamples} batch median(s)), ` +
        `${s.moveAtFive} at five or more (${s.moveAtFiveSamples})`,
      reason:
        problems.length === 0
          ? 'the position is a running mean, so what a new observation moves it by falls like ' +
            '1/n — a map that re-guesses each time random-walks instead, and the two are ' +
            'distinguishable in exactly this figure'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_007: Phase10Test = {
  spec: {
    id: 'MAP-007',
    title: 'Not a 3D model',
    required: true,
    input: 'every record this phase emits',
    expected: 'a set of observed places, with the sparsity as a number and no claim beyond it',
    passCriteria:
      'no surface, mesh, volume or completeness figure in the record; the density reported as ' +
      'landmarks per keyframe and per tracked feature; and the limitation carried as a value',
    failureCondition: 'any claim of completeness, or a geometry the observations do not support',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      modelClaim: s.modelClaim,
      landmarksPerKeyframe: s.landmarksPerKeyframe,
      confirmedShare: s.confirmedShare,
      landmarksPerTrackedFeature: s.landmarksPerTrackedFeature,
      landmarks: s.landmarks,
      confirmed: s.confirmed,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.modelClaim.length === 0) {
      problems.push(
        'the record carries no statement of what it is not — an omission that is not named ' +
          'reads as an oversight rather than as a decision',
      );
    }
    if (!(s.landmarksPerKeyframe >= 0)) {
      problems.push('the density is not reported, so "sparse" is an adjective rather than a number');
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.landmarks} landmark(s), ${s.landmarksPerKeyframe} per keyframe and ` +
        `${s.landmarksPerTrackedFeature} for every feature the tracker is following; ` +
        `${s.confirmed} confirmed, ${pct(s.confirmedShare)} of the map`,
      reason:
        problems.length === 0
          ? 'everything between the landmarks is unobserved and is not treated as geometry — ' +
            'v4 §16 and §22, carried as a value rather than as an absence'
          : problems.join('; '),
      metrics,
    };
  },
};

const MAP_008: Phase10Test = {
  spec: {
    id: 'MAP-008',
    title: 'Landmark cost',
    required: false,
    input: 'the per-batch cost of the landmark stage',
    expected: `mean <= ${LANDMARK_BUDGET_MS} ms per batch`,
    passCriteria: `mean cost <= ${LANDMARK_BUDGET_MS} ms over >= ${MIN_COST_SAMPLES} batches`,
    failureCondition: 'over budget',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanLandmarkMs: s.meanLandmarkMs,
      amortisedMsPerFrame: s.amortisedMsPerFrame,
      budgetMs: LANDMARK_BUDGET_MS,
      costSamples: s.costSamples,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.costSamples < MIN_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.costSamples}/${MIN_COST_SAMPLES} batches timed`,
        reason: 'a mean over fewer than five batches describes the scheduler, not the stage',
        metrics,
      };
    }
    const within = s.meanLandmarkMs >= 0 && s.meanLandmarkMs <= LANDMARK_BUDGET_MS;
    return {
      verdict: within ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.meanLandmarkMs} ms per batch over ${s.costSamples} batches, ` +
        `${s.amortisedMsPerFrame} ms amortised over every frame`,
      reason: within
        ? 'inside the per-batch ceiling; the amortised figure is what §B.2’s mapping-worker ' +
          'decision should be taken on'
        : `over the ${LANDMARK_BUDGET_MS} ms ceiling`,
      metrics,
    };
  },
};

const MAP_009: Phase10Test = {
  spec: {
    id: 'MAP-009',
    title: 'Metadata honesty',
    required: false,
    input: 'every record this phase emits',
    expected: 'rates in 0..1, counts that add up, and an unregistered batch that admits nothing',
    passCriteria:
      'every rate in 0..1; admitted plus merged plus rejected equalling the batch’s point ' +
      'count; no unregistered batch admitting anything; and a reported size that matches',
    failureCondition: 'any of the above unmet',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      rateOutOfRange: s.rateOutOfRange,
      accountingMismatches: s.accountingMismatches,
      unregisteredAdmissions: s.unregisteredAdmissions,
      sizeMismatches: s.sizeMismatches,
      confidenceOutOfRange: s.confidenceOutOfRange,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    const problems: string[] = [];
    if (s.rateOutOfRange > 0) problems.push(`${s.rateOutOfRange} rate(s) outside 0..1`);
    if (s.accountingMismatches > 0) {
      problems.push(`${s.accountingMismatches} batch(es) whose counts do not add up`);
    }
    if (s.unregisteredAdmissions > 0) {
      problems.push(`${s.unregisteredAdmissions} unregistered batch(es) admitted something anyway`);
    }
    if (s.sizeMismatches > 0) {
      problems.push(`${s.sizeMismatches} record(s) disagreed with the size they reported`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rateOutOfRange} rate(s) out of range, ${s.accountingMismatches} accounting ` +
        `mismatch(es), ${s.unregisteredAdmissions} unregistered admission(s), ` +
        `${s.sizeMismatches} size mismatch(es)`,
      reason: problems.length === 0 ? 'the records describe themselves' : problems.join('; '),
      metrics,
    };
  },
};

export const PHASE10_TESTS: readonly Phase10Test[] = [
  MAP_001, MAP_002, MAP_003, MAP_004, MAP_005, MAP_006, MAP_007, MAP_008, MAP_009,
];

export const PHASE10_SPECS: readonly TestSpec[] = PHASE10_TESTS.map((t) => t.spec);

export function runPhase10Tests(ctx: Phase10Context): TestResult[] {
  return runTests(PHASE10_TESTS, ctx);
}

/** Re-exported so the screen names the same numbers the suite judges against. */
export {
  LANDMARK_INJECTION_FRACTION,
  MAX_LANDMARKS,
  MAX_LANDMARK_REPROJECTION_PX,
  MAX_REGISTRATION_RESIDUAL,
  MIN_OBSERVATIONS_CONFIRMED,
  MIN_REGISTRATION_POINTS,
  SCALE_LOCAL_UNITS,
};
