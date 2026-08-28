/**
 * Phase 9 test suite — TRI-001..TRI-009.
 *
 * Specs transcribed from `docs/phase9/TEST-PLAN.md`, written and committed before
 * `src/mapping/triangulation.ts` existed (§29). Same verdict algebra as the phases before it:
 * PASS / FAIL / PENDING, with PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `TriangulationStats` and nothing else, so the suite can be shown a run driven
 * by the real triangulator beside one driven by a stage that returns a constant depth, and
 * checked that the two produce different verdicts. `tests/unit/triangulation.test.ts` does that.
 *
 * **The claim.** A constant-depth triangulator scores *well* on almost everything here. Every
 * point is in front of both cameras, every reprojection is small — a two-view reprojection is
 * dominated by the ray direction, which is right, rather than by the depth, which is not — the
 * counts add up and the structure looks plausible on any screen that draws it. TRI-004 is the one
 * number it cannot produce, and TRI-003 is the one a triangulator that solves anything solvable
 * cannot produce.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  DEPTH_UNCERTAINTY_LIMIT,
  MAX_TRIANGULATION_REPROJECTION_PX,
  MIN_PAIR_CORRESPONDENCES,
  MIN_PARALLAX_DEG,
  SCALE_LOCAL_UNITS,
  TriangulationRefusal,
} from '../mapping/triangulation';
import { INJECTED_ROTATION_DEG } from '../tracking/TriangulationStage';
import type { TriangulationStats } from '../tracking/triangulationStats';
import type { Evaluation, PhaseTest } from './runTests';
import { deg, pct, runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged batches of a condition before that condition is decided. As Phases 3–8 used. */
export const MIN_JUDGED_BATCHES = 15;
/** TRI-004: how far the recovered depths may sit from the ones the harness chose. */
export const DEPTH_ERROR_TOLERANCE = 0.02;
/** ...and how far ahead of the best possible constant the measurement must be. */
export const MIN_CONTROL_ADVANTAGE = 10;
/** ...and how well the recovered depths must be *ordered* like the true ones. */
export const MIN_RANK_CORRELATION = 0.9;
/** Both injections need a population before a median means anything. */
export const MIN_INJECTIONS = 3;
/** §H puts mapping off the frame cadence; this is per keyframe insert. See the plan. */
export const TRIANGULATION_BUDGET_MS = 8.0;
export const MIN_COST_SAMPLES = 5;

export interface Phase9Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  readonly triangulationEverRan: boolean;
  readonly stats: TriangulationStats;
}

type Phase9Test = PhaseTest<Phase9Context>;

function notRunning(ctx: Phase9Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.triangulationEverRan && ctx.stats.batches > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `no keyframe pair has been triangulated (camera ${ctx.cameraState})`,
    reason:
      'a batch is two keyframes, so this needs Phase 8 to have inserted at least two of them ' +
      'and the camera to have moved between them',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const TRI_001: Phase9Test = {
  spec: {
    id: 'TRI-001',
    title: 'Structure from a keyframe pair',
    required: true,
    input: 'a run where Phase 8 is inserting keyframes and the camera is translating',
    expected: 'sparse 3D points, each identified by the feature it was triangulated from',
    passCriteria:
      `>= ${MIN_JUDGED_BATCHES} batches attempted; at least one produced points; every accepted ` +
      'point carries a position, a parallax, a depth uncertainty and a reprojection error; and ' +
      'every point is identified by its feature id',
    failureCondition:
      'points reported with no parallax measured, or with no identity — a 3D point that cannot ' +
      'be matched to the observation it came from is a point no later phase can update',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      batches: s.batches,
      batchesTriangulated: s.batchesTriangulated,
      batchesRefused: s.batchesRefused,
      batchRefusalsByReason: s.batchRefusalsByReason as unknown as JsonValue,
      totalAccepted: s.totalAccepted,
      medianAcceptedPerBatch: s.medianAcceptedPerBatch,
      pointsPerKeyframe: s.pointsPerKeyframe,
      samples: s.samples as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.batches < MIN_JUDGED_BATCHES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.batches}/${MIN_JUDGED_BATCHES} batches attempted`,
        reason: 'keep moving — a batch happens when Phase 8 inserts a keyframe',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.batchesTriangulated === 0) {
      problems.push(
        `all ${s.batches} batches were refused — ${JSON.stringify(s.batchRefusalsByReason)}`,
      );
    }
    const incomplete = s.samples.filter(
      (p) =>
        !Number.isFinite(p.id) ||
        p.position.length !== 3 ||
        !(p.parallaxDeg >= 0) ||
        !(p.depthUncertainty >= 0) ||
        !(p.reprojectionPx >= 0),
    );
    if (incomplete.length > 0) {
      problems.push(
        `${incomplete.length} sampled point(s) are missing an identity or one of the three ` +
          'measurements every accepted point has to carry',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.batchesTriangulated} of ${s.batches} batches produced points; ` +
        `${s.totalAccepted} in total, median ${s.medianAcceptedPerBatch} per batch, ` +
        `${s.pointsPerKeyframe} per keyframe`,
      reason:
        problems.length === 0
          ? 'each point carries where it is, how much parallax determined it, what that parallax ' +
            'bought, how well it reprojects, and which tracked feature it came from'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_002: Phase9Test = {
  spec: {
    id: 'TRI-002',
    title: 'Parallax gating',
    required: true,
    input: 'every candidate the pair’s fit verified',
    expected: `nothing accepted below ${MIN_PARALLAX_DEG}° of parallax`,
    passCriteria:
      `no accepted point below ${MIN_PARALLAX_DEG}°; refusals counted by reason; median depth ` +
      `uncertainty within ${DEPTH_UNCERTAINTY_LIMIT}; and at least one point refused for low ` +
      'parallax, or the run reports that every candidate had enough',
    failureCondition:
      'an accepted point below the floor; or an acceptance rate of 1.00 with a median parallax ' +
      'at the floor, which is a gate that is not gating',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      floorDeg: MIN_PARALLAX_DEG,
      worstAcceptedParallaxDeg: s.worstAcceptedParallaxDeg,
      medianParallaxDeg: s.medianParallaxDeg,
      medianAcceptedParallaxDeg: s.medianAcceptedParallaxDeg,
      medianDepthUncertainty: s.medianDepthUncertainty,
      uncertaintyLimit: DEPTH_UNCERTAINTY_LIMIT,
      pointRefusals: s.pointRefusals as unknown as JsonValue,
      acceptanceRate: s.acceptanceRate,
      candidates: s.candidates,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.totalAccepted === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no point has been accepted yet',
        reason: 'the gate cannot be judged until something has passed through it',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.worstAcceptedParallaxDeg >= 0 && s.worstAcceptedParallaxDeg < MIN_PARALLAX_DEG) {
      problems.push(
        `a point was accepted at ${s.worstAcceptedParallaxDeg}° of parallax, below the ` +
          `${MIN_PARALLAX_DEG}° floor — v4 §21 forbids exactly that`,
      );
    }
    // The plan's second failure condition: a gate that admits everything while the median sits
    // on the floor is not gating, it is agreeing with whatever arrived.
    if (s.acceptanceRate === 1 && s.medianAcceptedParallaxDeg <= MIN_PARALLAX_DEG * 1.1) {
      problems.push(
        `every one of ${s.candidates} candidates was accepted and the median parallax is ` +
          `${s.medianAcceptedParallaxDeg}°, within a tenth of the ${MIN_PARALLAX_DEG}° floor — ` +
          'a gate that admits everything sitting on its own threshold is not gating',
      );
    }
    if (s.medianDepthUncertainty > DEPTH_UNCERTAINTY_LIMIT) {
      problems.push(
        `median depth uncertainty ${s.medianDepthUncertainty} against a limit of ` +
          `${DEPTH_UNCERTAINTY_LIMIT} — the parallax that was accepted did not buy what the ` +
          'floor was derived to buy',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${pct(s.acceptanceRate)} of ${s.candidates} candidates accepted; median parallax ` +
        `${deg(s.medianParallaxDeg)} over all, ${deg(s.medianAcceptedParallaxDeg)} over the ` +
        `accepted; worst accepted ${deg(s.worstAcceptedParallaxDeg)}; ` +
        `${s.lowParallaxRefusals} refused for low parallax` +
        (s.lowParallaxRefusals === 0 ? ' — the gate was never exercised on this run' : ''),
      reason:
        problems.length === 0
          ? `the floor is derived rather than chosen: §13's 1.5 px over the assumed focal length ` +
            `is 0.089° of angular noise, and asking for a depth good to ` +
            `${DEPTH_UNCERTAINTY_LIMIT} of itself gives 0.89°`
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_003: Phase9Test = {
  spec: {
    id: 'TRI-003',
    title: 'A camera that only turned',
    required: true,
    input:
      `on a sampled schedule, the pair's second view replaced by K R K⁻¹ applied to its first, ` +
      `with R a seeded ${INJECTED_ROTATION_DEG}° rotation — a real rotation and no translation`,
    expected: 'nothing triangulated from it',
    passCriteria:
      `>= ${MIN_INJECTIONS} injections; zero points accepted from any of them; the refusal ` +
      'attributed to the pose or to the parallax gate; and the same batches’ untouched pairs ' +
      'producing points',
    failureCondition:
      'any point accepted from a pure rotation. There is no tolerance: a pure rotation ' +
      'determines no depth, and a number produced from it was invented',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      injections: s.rotationInjections,
      accepted: s.rotationInjectionAccepted,
      cleanAccepted: s.rotationInjectionCleanAccepted,
      poseStates: s.rotationInjectionPoseStates as unknown as JsonValue,
      last: (s.lastRotationInjection as unknown as JsonValue) ?? null,
      requestedDeg: INJECTED_ROTATION_DEG,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.rotationInjections < MIN_INJECTIONS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.rotationInjections}/${MIN_INJECTIONS} pure-rotation injections`,
        reason: 'the injection runs on a sampled schedule; keep the run going',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.rotationInjectionAccepted > 0) {
      problems.push(
        `${s.rotationInjectionAccepted} point(s) were triangulated from a camera that turned and ` +
          'did not move. Every ray pair in such a set meets at infinity; a depth taken from one ' +
          'is whatever the noise implied',
      );
    }
    if (s.rotationInjectionCleanAccepted === 0) {
      problems.push(
        'the untouched pairs on the same batches produced nothing either, so the refusal is not ' +
          'evidence of anything — a stage that refuses everything scores this perfectly',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rotationInjections} injection(s): ${s.rotationInjectionAccepted} point(s) accepted ` +
        `from the pure rotations, ${s.rotationInjectionCleanAccepted} from the untouched pairs; ` +
        `pose came back ${JSON.stringify(s.rotationInjectionPoseStates)}`,
      reason:
        problems.length === 0
          ? 'the refusal is attributed rather than assumed: either the pose declined to offer a ' +
            'translation, or it offered one and every ray pair turned out to meet at infinity'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_004: Phase9Test = {
  spec: {
    id: 'TRI-004',
    title: 'Depths the harness chose',
    required: true,
    input:
      'on a sampled schedule, a synthetic pair built from depths this stage picked, projected ' +
      'through a known (R, t) with a unit baseline using the frame’s own intrinsics',
    expected: 'the recovered depths are the depths the harness chose',
    passCriteria:
      `>= ${MIN_INJECTIONS} injections over >= ${MIN_PAIR_CORRESPONDENCES} points each; median ` +
      `relative depth error within ${DEPTH_ERROR_TOLERANCE}; at least ${MIN_CONTROL_ADVANTAGE}x ` +
      'better than the best possible constant depth; and a rank correlation of at least ' +
      `${MIN_RANK_CORRELATION} against the chosen depths`,
    failureCondition:
      'a median error at or near the control’s. A constant-depth stage scores the control ' +
      'exactly, while satisfying every count, every reprojection and every cheirality criterion ' +
      'in this phase',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      injections: s.depthInjections,
      medianDepthError: s.medianDepthError,
      medianControlError: s.medianControlError,
      medianRankCorrelation: s.medianRankCorrelation,
      worstDepthError: s.worstDepthError,
      tolerance: DEPTH_ERROR_TOLERANCE,
      last: (s.lastDepthInjection as unknown as JsonValue) ?? null,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.depthInjections < MIN_INJECTIONS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.depthInjections}/${MIN_INJECTIONS} known-depth injections`,
        reason: 'the injection runs on a sampled schedule; keep the run going',
        metrics,
      };
    }

    const problems: string[] = [];
    if (!(s.medianDepthError <= DEPTH_ERROR_TOLERANCE)) {
      problems.push(
        `median relative depth error ${s.medianDepthError} against a tolerance of ` +
          `${DEPTH_ERROR_TOLERANCE}`,
      );
    }
    if (!(s.medianDepthError * MIN_CONTROL_ADVANTAGE <= s.medianControlError)) {
      problems.push(
        `the best possible constant depth scores ${s.medianControlError} and this scored ` +
          `${s.medianDepthError} — not ${MIN_CONTROL_ADVANTAGE}x better, so the measurement does ` +
          'not separate a triangulator from a stage that returns one number',
      );
    }
    if (!(s.medianRankCorrelation >= MIN_RANK_CORRELATION)) {
      problems.push(
        `rank correlation ${s.medianRankCorrelation} against the chosen depths — the recovered ` +
          'set is not ordered like the true one, so whatever it got right it did not get the ' +
          'structure',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.depthInjections} injection(s): median relative error ${s.medianDepthError} ` +
        `(worst ${s.worstDepthError}) against a constant depth’s ${s.medianControlError}; rank ` +
        `correlation ${s.medianRankCorrelation}`,
      reason:
        problems.length === 0
          ? 'the depths came back as the harness set them, and the control is reported beside ' +
            'the measurement so the tolerance is not what separates a triangulator from a ' +
            'constant'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_005: Phase9Test = {
  spec: {
    id: 'TRI-005',
    title: 'In front, and consistent',
    required: true,
    input: 'every accepted point',
    expected: 'positive depth in both views, and a reprojection inside v3 §33’s ceiling',
    passCriteria:
      `every accepted point in front of both cameras and within ` +
      `${MAX_TRIANGULATION_REPROJECTION_PX} px in both views; failures refused and counted by ` +
      'reason rather than dropped',
    failureCondition: 'an accepted point behind either camera, or beyond the reprojection ceiling',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      medianReprojectionPx: s.medianReprojectionPx,
      worstAcceptedReprojectionPx: s.worstAcceptedReprojectionPx,
      ceilingPx: MAX_TRIANGULATION_REPROJECTION_PX,
      worstAcceptedDepth: s.worstAcceptedDepth,
      behindCameraRefusals: s.behindCameraRefusals,
      highReprojectionRefusals: s.highReprojectionRefusals,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.totalAccepted === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no point has been accepted yet',
        reason: 'there is nothing to check the sign or the residual of',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.worstAcceptedDepth >= 0 && s.worstAcceptedDepth <= 0) {
      problems.push(`a point was accepted at depth ${s.worstAcceptedDepth}`);
    }
    if (s.worstAcceptedReprojectionPx > MAX_TRIANGULATION_REPROJECTION_PX) {
      problems.push(
        `a point was accepted at ${s.worstAcceptedReprojectionPx} px of reprojection error, ` +
          `beyond v3 §33's ${MAX_TRIANGULATION_REPROJECTION_PX} px`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `median ${s.medianReprojectionPx} px, worst accepted ${s.worstAcceptedReprojectionPx} px, ` +
        `shallowest accepted depth ${s.worstAcceptedDepth}; ${s.behindCameraRefusals} refused ` +
        `behind a camera, ${s.highReprojectionRefusals} for reprojection`,
      reason:
        problems.length === 0
          ? 'every accepted point was seen by both cameras and lands where both saw it — and ' +
            'the ones that did not are refused with the reason rather than dropped'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_006: Phase9Test = {
  spec: {
    id: 'TRI-006',
    title: 'Two routes to one rotation',
    required: true,
    input: 'the pair fit’s rotation, and Phase 6’s own accumulated between the same two keyframes',
    expected: 'the two agree at Phase 6’s own tolerance',
    passCriteria:
      `>= ${MIN_JUDGED_BATCHES} batches where both could be formed; the median disagreement ` +
      'within max(3°, 30% of measured); and the disagreement not identically zero',
    failureCondition:
      'a median disagreement outside the tolerance — the pair’s fit and the chain of poses that ' +
      'led to it describe different camera motions, and at most one of them can be right',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      rotationSamples: s.rotationSamples,
      medianRotationDeg: s.medianRotationDeg,
      medianRotationDisagreementDeg: s.medianRotationDisagreementDeg,
      toleranceDeg: s.rotationToleranceDeg,
      rotationsWithinTolerance: s.rotationsWithinTolerance,
      zeroDisagreements: s.zeroDisagreements,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.rotationSamples < MIN_JUDGED_BATCHES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.rotationSamples}/${MIN_JUDGED_BATCHES} batches where both routes gave a rotation`,
        reason:
          'Phase 6’s route needs a pose on the frames between the two keyframes, and the pair ' +
          'fit needs the pair to verify. Keep the run going',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianRotationDisagreementDeg > s.rotationToleranceDeg) {
      problems.push(
        `median disagreement ${s.medianRotationDisagreementDeg}° against a tolerance of ` +
          `${s.rotationToleranceDeg}° — the two routes describe different camera motions`,
      );
    }
    if (s.zeroDisagreements === s.rotationSamples) {
      problems.push(
        `all ${s.rotationSamples} batches agreed exactly, which is not what two independent ` +
          'measurements do — one of the two numbers is the other',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `the pair fit says ${deg(s.medianRotationDeg)} and Phase 6’s chain disagrees by ` +
        `${deg(s.medianRotationDisagreementDeg)} against a tolerance of ` +
        `${deg(s.rotationToleranceDeg)}; ${s.rotationsWithinTolerance}/${s.rotationSamples} ` +
        'inside it',
      reason:
        problems.length === 0
          ? 'the fresh fit has a witness: Phase 6 measured the same rotation through per-frame ' +
            'poses against a moving anchor, and the two arrive at the same answer by routes ' +
            'that share no arithmetic'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_007: Phase9Test = {
  spec: {
    id: 'TRI-007',
    title: 'No distance',
    required: true,
    input: 'every record this phase emits',
    expected: `SCALE: ${SCALE_LOCAL_UNITS}, depths in units of each pair's own baseline`,
    passCriteria:
      'every record carries the local-units scale and a baseline of 1; the baseline note is ' +
      'present; the batch-to-batch spread of median depth is reported as the number behind the ' +
      'refusal to pool them; and the sparsity is a number',
    failureCondition:
      'a metre anywhere; or a depth statistic pooled across pairs, which would be an average ' +
      'over incommensurable units',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      scale: s.scale,
      baselineUnits: s.baselineUnits,
      scaleViolations: s.scaleViolations,
      medianBatchDepth: s.medianBatchDepth,
      batchDepthSpread: s.batchDepthSpread,
      pointsPerKeyframe: s.pointsPerKeyframe,
      medianAcceptedPerBatch: s.medianAcceptedPerBatch,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.scaleViolations > 0) {
      problems.push(
        `${s.scaleViolations} record(s) claimed a scale other than ${SCALE_LOCAL_UNITS} or a ` +
          'baseline other than 1',
      );
    }
    if (s.baselineNote.length === 0) {
      problems.push('the baseline note is empty, so a depth travels with no statement of its unit');
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.scale}, baseline ${s.baselineUnits} by construction; median batch depth ` +
        `${s.medianBatchDepth} with a batch-to-batch spread of ${s.batchDepthSpread}; ` +
        `${s.medianAcceptedPerBatch} point(s) per batch, ${s.pointsPerKeyframe} per keyframe`,
      reason:
        problems.length === 0
          ? 'the spread is the number behind the refusal: on one scene with one camera the ' +
            'median depth moves that much between batches purely because each pair’s baseline ' +
            'is a different unit. Phase 10 is where a shared one is obtained'
          : problems.join('; '),
      metrics,
    };
  },
};

const TRI_008: Phase9Test = {
  spec: {
    id: 'TRI-008',
    title: 'Triangulation cost',
    required: false,
    input: 'the per-batch cost of the triangulation stage',
    expected: `mean <= ${TRIANGULATION_BUDGET_MS} ms per keyframe insert`,
    passCriteria: `mean cost <= ${TRIANGULATION_BUDGET_MS} ms over >= ${MIN_COST_SAMPLES} batches`,
    failureCondition: 'over budget',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanTriangulationMs: s.meanTriangulationMs,
      amortisedMsPerFrame: s.amortisedMsPerFrame,
      budgetMs: TRIANGULATION_BUDGET_MS,
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
    const within = s.meanTriangulationMs >= 0 && s.meanTriangulationMs <= TRIANGULATION_BUDGET_MS;
    return {
      verdict: within ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.meanTriangulationMs} ms per batch over ${s.costSamples} batches, ` +
        `${s.amortisedMsPerFrame} ms amortised over every frame`,
      reason: within
        ? 'inside the per-insert ceiling, and the amortised figure is what §B.2’s mapping-worker ' +
          'decision should be taken on rather than the diagram'
        : `over the ${TRIANGULATION_BUDGET_MS} ms ceiling — the answer to a genuine overrun here ` +
          'is §B.2’s mapping worker rather than a smaller number',
      metrics,
    };
  },
};

const TRI_009: Phase9Test = {
  spec: {
    id: 'TRI-009',
    title: 'Metadata honesty',
    required: false,
    input: 'every record this phase emits',
    expected: 'rates in 0..1, counts that add up, and a refused batch with no points',
    passCriteria:
      'every rate in 0..1; accepted plus refusals equals candidates on every batch; and no ' +
      'refused batch reports points',
    failureCondition: 'any of the above unmet',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      rateOutOfRange: s.rateOutOfRange,
      accountingMismatches: s.accountingMismatches,
      refusedWithPoints: s.refusedWithPoints,
      pointRefusals: s.pointRefusals as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    const problems: string[] = [];
    if (s.rateOutOfRange > 0) problems.push(`${s.rateOutOfRange} rate(s) outside 0..1`);
    if (s.accountingMismatches > 0) {
      problems.push(
        `${s.accountingMismatches} batch(es) where accepted plus refusals did not equal the ` +
          'candidates — a stage whose counts do not add up is not reporting what it did',
      );
    }
    if (s.refusedWithPoints > 0) {
      problems.push(`${s.refusedWithPoints} refused batch(es) reported points anyway`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rateOutOfRange} rate(s) out of range, ${s.accountingMismatches} accounting ` +
        `mismatch(es), ${s.refusedWithPoints} refused batch(es) with points`,
      reason: problems.length === 0 ? 'the records describe themselves' : problems.join('; '),
      metrics,
    };
  },
};

export const PHASE9_TESTS: readonly Phase9Test[] = [
  TRI_001, TRI_002, TRI_003, TRI_004, TRI_005, TRI_006, TRI_007, TRI_008, TRI_009,
];

export const PHASE9_SPECS: readonly TestSpec[] = PHASE9_TESTS.map((t) => t.spec);

export function runPhase9Tests(ctx: Phase9Context): TestResult[] {
  return runTests(PHASE9_TESTS, ctx);
}

/** Re-exported so the screen names the same numbers the suite judges against. */
export {
  DEPTH_UNCERTAINTY_LIMIT,
  INJECTED_ROTATION_DEG,
  MAX_TRIANGULATION_REPROJECTION_PX,
  MIN_PAIR_CORRESPONDENCES,
  MIN_PARALLAX_DEG,
  SCALE_LOCAL_UNITS,
  TriangulationRefusal,
};
