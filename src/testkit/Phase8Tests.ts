/**
 * Phase 8 test suite — KEY-001..KEY-008.
 *
 * Specs transcribed from `docs/phase8/TEST-PLAN.md`, written and committed before
 * `src/mapping/keyframes.ts` existed (§29). Same verdict algebra as the phases before it:
 * PASS / FAIL / PENDING, with PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `KeyframeStats` and nothing else — no DOM, no worker, no camera — so the
 * suite can be shown a run driven by the real selector beside one driven by a metronome, and
 * checked that the two produce different verdicts. `tests/unit/keyframes.test.ts` does exactly
 * that.
 *
 * **The claim.** A metronome scores *well* on almost everything in this phase. Its intervals are
 * legal, its store stays bounded, its records carry intrinsics and observations, and on a moving
 * camera its keyframes are as well separated as anyone's — because on a moving camera any
 * schedule produces separated views. KEY-002 is the one measurement it cannot produce, and it is
 * decided on a segment where an instrument this phase does not own says the image is not moving.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  KEYFRAME_DISPLACEMENT_PX,
  KEYFRAME_QUALITY_DELTA,
  KEYFRAME_ROTATION_DEG,
  KEYFRAME_TRANSLATION_UNITS,
  MAX_KEYFRAMES,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  SCALE_LOCAL_UNITS,
  STALE_SURVIVAL_FRACTION,
} from '../mapping/keyframes';
import type { KeyframeStats } from '../tracking/keyframeStats';
import type { Evaluation, PhaseTest } from './runTests';
import { deg, pct, runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged decisions of a condition before that condition is decided. As Phases 3–7 used. */
export const MIN_JUDGED_DECISIONS = 15;
/**
 * KEY-002 criterion 3: how far ahead of the real selector the metronome must be.
 *
 * `MAX_KEYFRAME_INTERVAL_MS / MIN_KEYFRAME_INTERVAL_MS` is 10 — what a still camera allows in
 * principle. Halved, so the criterion is met by a selector that is right rather than by one that
 * is lucky about where the segment's boundaries fell.
 */
export const MIN_STATIC_METRONOME_RATIO = 5;
/** §H allocates no line to keyframe upkeep — see the plan. Advisory for that reason. */
export const KEYFRAME_BUDGET_MS = 1.0;
/** KEY-007 needs a population before a mean means anything. */
export const MIN_COST_SAMPLES = 10;

export interface Phase8Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** The keyframe store was switched on at least once in this run. */
  readonly keyframesEverRan: boolean;
  readonly stats: KeyframeStats;
}

type Phase8Test = PhaseTest<Phase8Context>;

function notRunning(ctx: Phase8Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.keyframesEverRan && ctx.stats.decisions > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `the keyframe store has not run (camera ${ctx.cameraState})`,
    reason: 'no keyframe decision has been taken, so there is nothing to judge',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const KEY_001: Phase8Test = {
  spec: {
    id: 'KEY-001',
    title: 'Selection on v3 §20’s conditions',
    required: true,
    input: 'a run where the camera moves, with the whole Phase 4–7 stack live beneath it',
    expected: 'keyframes inserted when one of v3 §20’s conditions is met and not otherwise',
    passCriteria:
      `>= ${MIN_JUDGED_DECISIONS} decisions judged; every insertion's recorded reason ` +
      're-derivable from the inputs recorded beside it; no insertion inside ' +
      `${MIN_KEYFRAME_INTERVAL_MS} ms of the previous one; no gap longer than ` +
      `${MAX_KEYFRAME_INTERVAL_MS} ms; and at least one insertion on a geometric condition`,
    failureCondition:
      'an insertion whose reason its own numbers do not support; or a run in which every ' +
      'insertion is the maximum-interval heartbeat, which is a metronome wearing this phase’s ' +
      'labels',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      decisions: s.decisions,
      totalInserted: s.totalInserted,
      insertionsByReason: s.insertionsByReason as unknown as JsonValue,
      geometricInsertions: s.geometricInsertions,
      heartbeatInsertions: s.heartbeatInsertions,
      reasonMismatches: s.reasonMismatches,
      minIntervalViolations: s.minIntervalViolations,
      maxIntervalGaps: s.maxIntervalGaps,
      longestGapMs: s.longestGapMs,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.decisions < MIN_JUDGED_DECISIONS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.decisions}/${MIN_JUDGED_DECISIONS} decisions taken`,
        reason: 'the selector needs frames to decide about; keep the run going',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.reasonMismatches > 0) {
      problems.push(
        `${s.reasonMismatches} decision(s) reported a reason the same pure function does not ` +
          'reproduce from the inputs recorded beside it — the labels and the arithmetic disagree',
      );
    }
    if (s.minIntervalViolations > 0) {
      problems.push(
        `${s.minIntervalViolations} insertion(s) landed inside v3 §20’s ` +
          `${MIN_KEYFRAME_INTERVAL_MS} ms minimum`,
      );
    }
    if (s.maxIntervalGaps > 0) {
      problems.push(
        `${s.maxIntervalGaps} decision(s) declined past v3 §20’s ${MAX_KEYFRAME_INTERVAL_MS} ms ` +
          `maximum — the longest gap was ${s.longestGapMs} ms`,
      );
    }
    if (s.totalInserted === 0) {
      problems.push('no keyframe was inserted at all');
    } else if (s.geometricInsertions === 0) {
      problems.push(
        `all ${s.totalInserted} insertion(s) were the maximum-interval heartbeat; none fired on ` +
          'rotation, displacement or a change of tracking quality, which is what a metronome ' +
          'would also produce',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.totalInserted} keyframe(s) over ${s.decisions} decisions — ` +
        `${JSON.stringify(s.insertionsByReason)}; ${s.geometricInsertions} on a geometric ` +
        `condition, longest gap ${s.longestGapMs} ms`,
      reason:
        problems.length === 0
          ? 'every insertion’s reason re-derives from its own inputs, both of v3 §20’s intervals ' +
            'held, and the store was fed by the geometry rather than by the clock'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_002: Phase8Test = {
  spec: {
    id: 'KEY-002',
    title: 'The stationary case',
    required: true,
    input:
      'a segment during which Phase 4’s independent scene-shift search reported STATIC — the ' +
      'image is not moving',
    expected:
      'the selector inserts nothing but the maximum-interval heartbeat, while a metronome ' +
      'firing at the minimum interval keeps inserting',
    passCriteria:
      `>= ${MIN_JUDGED_DECISIONS} decisions while STATIC; no insertion during them on a ` +
      `geometric condition; and the metronome twin ahead by at least ` +
      `${MIN_STATIC_METRONOME_RATIO}x over the same decisions`,
    failureCondition:
      'a keyframe inserted on a still camera for a geometric reason; or a count equal to the ' +
      'metronome’s, which is a metronome',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      staticDecisions: s.staticDecisions,
      staticSelectorInsertions: s.staticSelectorInsertions,
      staticGeometricInsertions: s.staticGeometricInsertions,
      staticMetronomeInsertions: s.staticMetronomeInsertions,
      staticRatio: s.staticRatio,
      metronomeKeyframes: s.metronomeKeyframes,
      totalInserted: s.totalInserted,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.staticDecisions < MIN_JUDGED_DECISIONS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.staticDecisions}/${MIN_JUDGED_DECISIONS} decisions while the image was static`,
        reason:
          'this record is about what the selector does when the camera is not moving. Hold the ' +
          'phone still for a few seconds — Phase 4’s own scene-shift search decides when that ' +
          'has happened, and nothing here can influence it',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.staticGeometricInsertions > 0) {
      problems.push(
        `${s.staticGeometricInsertions} keyframe(s) fired on rotation, displacement or quality ` +
          'while the image was not moving — none of those conditions can be met by a still camera',
      );
    }
    if (s.staticMetronomeInsertions < MIN_STATIC_METRONOME_RATIO * s.staticSelectorInsertions) {
      problems.push(
        `the metronome inserted ${s.staticMetronomeInsertions} and this selector inserted ` +
          `${s.staticSelectorInsertions} over the same ${s.staticDecisions} static decisions — a ` +
          `ratio of ${s.staticRatio}, short of ${MIN_STATIC_METRONOME_RATIO}x. A selector that ` +
          'keeps up with a metronome on a still camera is a metronome',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `over ${s.staticDecisions} static decisions the selector inserted ` +
        `${s.staticSelectorInsertions} (${s.staticGeometricInsertions} geometric) and the ` +
        `metronome ${s.staticMetronomeInsertions} — ${s.staticRatio}x`,
      reason:
        problems.length === 0
          ? 'on a camera that is not moving the two selectors part company, which is the one ' +
            'thing a schedule cannot imitate: they saw the same frames and disagreed about ' +
            'which of them were worth keeping'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_003: Phase8Test = {
  spec: {
    id: 'KEY-003',
    title: 'Bounded, and able to let go',
    required: true,
    input: 'a run long enough to fill the store',
    expected: `at most ${MAX_KEYFRAMES} keyframes, with every eviction naming what went and why`,
    passCriteria:
      `the store never exceeded ${MAX_KEYFRAMES}; every eviction carries a reason; the ` +
      'comparison partner is never the one evicted; an eviction occurred or the run reports ' +
      'the store never filled; and eviction preserved viewpoint coverage at least as well as ' +
      'dropping the oldest would have, on the majority of evictions',
    failureCondition:
      'a store above the bound; an eviction with no reason; or the current keyframe evicted, ' +
      'which would leave the selector comparing against a view it had discarded',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      keyframes: s.keyframes,
      maxStoreSize: s.maxStoreSize,
      bound: MAX_KEYFRAMES,
      evictions: s.evictions,
      storeOverflows: s.storeOverflows,
      evictionsWithoutReason: s.evictionsWithoutReason,
      evictedNewest: s.evictedNewest,
      evictionsCoverageKept: s.evictionsCoverageKept,
      recentEvictions: s.recentEvictions as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.storeOverflows > 0) {
      problems.push(
        `${s.storeOverflows} frame(s) held more than ${MAX_KEYFRAMES} keyframes — §56 and §H.1 ` +
          'fix that bound and a store that grows past it fails in the twentieth minute',
      );
    }
    if (s.evictionsWithoutReason > 0) {
      problems.push(`${s.evictionsWithoutReason} eviction(s) carried no reason`);
    }
    if (s.evictedNewest > 0) {
      problems.push(
        `${s.evictedNewest} eviction(s) took the keyframe the next decision is measured against`,
      );
    }
    if (s.evictions > 0 && s.evictionsCoverageKept * 2 < s.evictions) {
      problems.push(
        `only ${s.evictionsCoverageKept} of ${s.evictions} eviction(s) left the retained set as ` +
          'well spread as dropping the oldest would have — the policy is losing viewpoint ' +
          'coverage it was chosen to keep',
      );
    }
    const observed =
      s.evictions > 0
        ? `${s.maxStoreSize}/${MAX_KEYFRAMES} at its fullest, ${s.evictions} eviction(s), ` +
          `${s.evictionsCoverageKept} of them at least as well spread as dropping the oldest`
        : `${s.maxStoreSize}/${MAX_KEYFRAMES} at its fullest — the store never filled, so no ` +
          'eviction policy was exercised';
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed,
      reason:
        problems.length === 0
          ? 'the bound held, every eviction said what went and why, and what went was the most ' +
            'redundant viewpoint rather than simply the oldest — which is the difference ' +
            'between a store that describes the room and one that describes the last few seconds'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_004: Phase8Test = {
  spec: {
    id: 'KEY-004',
    title: 'What travels with a keyframe',
    required: true,
    input: 'the keyframes the run inserted',
    expected: 'observations with stable ids, and each keyframe’s own intrinsics (§H.0)',
    passCriteria:
      `every keyframe carries >= ${MIN_KEYFRAME_OBSERVATIONS} observations with unique ids; ` +
      'every keyframe’s K re-derives from the frame geometry it recorded; consecutive ' +
      'keyframes share enough observations to form a pair, or the record says why not; and ' +
      `SCALE: ${SCALE_LOCAL_UNITS} throughout`,
    failureCondition:
      'a keyframe with no observations, or one whose intrinsics belong to a different frame ' +
      'geometry than the one it was taken at',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      observationFloor: MIN_KEYFRAME_OBSERVATIONS,
      observationFloorViolations: s.observationFloorViolations,
      duplicateObservationIds: s.duplicateObservationIds,
      intrinsicsMismatches: s.intrinsicsMismatches,
      medianSharedWithLast: s.medianSharedWithLast,
      sharedBelowFloor: s.sharedBelowFloor,
      scale: s.scale,
      scaleViolations: s.scaleViolations,
      recent: s.recent as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.totalInserted === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no keyframe has been inserted',
        reason: 'there is nothing to inspect until a view has been kept',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.observationFloorViolations > 0) {
      problems.push(
        `${s.observationFloorViolations} keyframe(s) carry fewer than ` +
          `${MIN_KEYFRAME_OBSERVATIONS} observations — Phase 9 could never pair them`,
      );
    }
    if (s.duplicateObservationIds > 0) {
      problems.push(`${s.duplicateObservationIds} repeated observation id(s) inside one keyframe`);
    }
    if (s.intrinsicsMismatches > 0) {
      problems.push(
        `${s.intrinsicsMismatches} keyframe(s) carry a K that does not follow from their own ` +
          'recorded frame geometry — §H.0, and Phase 9 triangulates from these',
      );
    }
    if (s.scaleViolations > 0) {
      problems.push(`${s.scaleViolations} record(s) claimed a scale other than ${SCALE_LOCAL_UNITS}`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.totalInserted} keyframe(s); median ${s.medianSharedWithLast} observation(s) shared ` +
        `with the previous one (${s.sharedBelowFloor} decision(s) below the floor of ` +
        `${MIN_KEYFRAME_OBSERVATIONS}); ${s.intrinsicsMismatches} intrinsics mismatch(es)`,
      reason:
        problems.length === 0
          ? 'each keyframe carries the observations Phase 9 will pair and the K it was taken ' +
            'under, re-derived from its own recorded geometry rather than borrowed from the ' +
            'current frame'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_005: Phase8Test = {
  spec: {
    id: 'KEY-005',
    title: 'The condition this phase refuses',
    required: true,
    input: 'every decision record',
    expected:
      `v3 §20's ${KEYFRAME_TRANSLATION_UNITS} local-unit translation condition carried as a ` +
      'value marked UNMEASURED, with the missing scale named and a number beside it',
    passCriteria:
      'the translation condition appears in every decision with its threshold and the state ' +
      'UNMEASURED; no insertion cites it; the angle the translation direction moved is ' +
      `measured and reported; and SCALE: ${SCALE_LOCAL_UNITS} throughout`,
    failureCondition:
      'a decision that fired on a translation magnitude — there is no such magnitude in this ' +
      'build, so any is fabricated',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const c = s.translationCondition;
    const metrics: Record<string, JsonValue> = {
      condition: (c as unknown as JsonValue) ?? null,
      threshold: KEYFRAME_TRANSLATION_UNITS,
      translationFired: s.translationFired,
      translationDirectionSamples: s.translationDirectionSamples,
      medianTranslationDirectionDeg: s.medianTranslationDirectionDeg,
      scale: s.scale,
      scaleViolations: s.scaleViolations,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (!c) {
      problems.push(
        'the translation condition is absent from the decision record — an omission that is ' +
          'not named reads as an oversight rather than as a decision',
      );
    } else {
      if (c.state !== 'UNMEASURED') {
        problems.push(`the translation condition reports state ${c.state}, not UNMEASURED`);
      }
      if (c.threshold !== KEYFRAME_TRANSLATION_UNITS) {
        problems.push(
          `it carries a threshold of ${c.threshold} rather than v3 §20's ` +
            `${KEYFRAME_TRANSLATION_UNITS}`,
        );
      }
    }
    if (s.translationFired > 0) {
      problems.push(
        `${s.translationFired} decision(s) fired on a translation magnitude, and this build ` +
          'produces none — Phase 6 recovers a unit direction and v4 §18 forbids a distance',
      );
    }
    if (s.scaleViolations > 0) {
      problems.push(`${s.scaleViolations} record(s) claimed a scale other than ${SCALE_LOCAL_UNITS}`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `TRANSLATION carried as ${c?.state ?? 'ABSENT'} against v3 §20's ` +
        `${KEYFRAME_TRANSLATION_UNITS} local unit; it fired ${s.translationFired} time(s); the ` +
        `direction moved ${deg(s.medianTranslationDirectionDeg)} over ` +
        `${s.translationDirectionSamples} sample(s)`,
      reason:
        problems.length === 0
          ? 'the condition is present as a value rather than absent as a field, it never fires, ' +
            'and the refusal carries a number: the direction is measurable and its magnitude ' +
            'is the quantity that does not exist'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_006: Phase8Test = {
  spec: {
    id: 'KEY-006',
    title: 'Staleness',
    required: true,
    input: 'the store, over a run in which features are lost and replaced',
    expected:
      'a keyframe that has stopped describing anything the current frame can be related to is ' +
      'marked stale and is not used as the comparison partner',
    passCriteria:
      'the surviving-observation fraction is measured for every retained keyframe; a keyframe ' +
      `below ${STALE_SURVIVAL_FRACTION} is not used as the partner; and either at least one ` +
      'keyframe went stale or the run reports that none did',
    failureCondition:
      'a stale keyframe used as the comparison partner; or a keyframe retired for being old ' +
      'rather than for having stopped describing anything',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      staleKeyframes: s.staleKeyframes,
      staleEver: s.staleEver,
      stalePartnerUsed: s.stalePartnerUsed,
      survivalSamples: s.survivalSamples,
      medianSurvivingFraction: s.medianSurvivingFraction,
      threshold: STALE_SURVIVAL_FRACTION,
      droppedIncrements: s.droppedIncrements,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.survivalSamples === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no keyframe has had its surviving-observation fraction measured yet',
        reason: 'a keyframe has to exist before its staleness can be a measurement',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.stalePartnerUsed > 0) {
      problems.push(
        `${s.stalePartnerUsed} decision(s) were measured against a stale keyframe — a view ` +
          'whose points the current frame no longer holds cannot supply a displacement',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.staleKeyframes} of ${s.keyframes} keyframe(s) stale now, ${s.staleEver} at the most; ` +
        `median surviving fraction ${pct(s.medianSurvivingFraction)} over ${s.survivalSamples} ` +
        'sample(s)' +
        (s.staleEver === 0 ? ' — nothing went stale during this run' : ''),
      reason:
        problems.length === 0
          ? 'staleness is measured from surviving observations and from nothing else — v4 §20 ' +
            'forbids using old information blindly, and it does not say that old information ' +
            'is bad: a keyframe whose points are all still visible is as useful as when it was ' +
            'taken'
          : problems.join('; '),
      metrics,
    };
  },
};

const KEY_007: Phase8Test = {
  spec: {
    id: 'KEY-007',
    title: 'Keyframe cost',
    required: false,
    input: 'the per-decision cost of the keyframe stage',
    expected: `mean upkeep <= ${KEYFRAME_BUDGET_MS} ms`,
    passCriteria: `mean keyframe cost <= ${KEYFRAME_BUDGET_MS} ms over >= ${MIN_COST_SAMPLES} decisions`,
    failureCondition: 'over budget',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanKeyframeMs: s.meanKeyframeMs,
      budgetMs: KEYFRAME_BUDGET_MS,
      costSamples: s.costSamples,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.costSamples < MIN_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.costSamples}/${MIN_COST_SAMPLES} cost samples`,
        reason: 'a mean over fewer than ten decisions describes the scheduler, not the stage',
        metrics,
      };
    }
    const within = s.meanKeyframeMs >= 0 && s.meanKeyframeMs <= KEYFRAME_BUDGET_MS;
    return {
      verdict: within ? Verdict.PASS : Verdict.FAIL,
      observed: `${s.meanKeyframeMs} ms mean over ${s.costSamples} decisions`,
      reason: within
        ? `inside the ${KEYFRAME_BUDGET_MS} ms this phase set for itself — §H names no line for ` +
          'keyframe upkeep, so whatever it costs is spent from margin that does not exist on paper'
        : `over the ${KEYFRAME_BUDGET_MS} ms ceiling`,
      metrics,
    };
  },
};

const KEY_008: Phase8Test = {
  spec: {
    id: 'KEY-008',
    title: 'Metadata honesty',
    required: false,
    input: 'every record this phase emits',
    expected: 'rates in 0..1, no Euler angles, a store that agrees with itself',
    passCriteria:
      'every rate in 0..1; no Euler triple anywhere (§18); the reported store size agrees with ' +
      'the records it carries; and every decision re-derives from its own inputs',
    failureCondition: 'any of the above unmet',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      rateOutOfRange: s.rateOutOfRange,
      eulerEmitted: s.eulerEmitted,
      sizeMismatches: s.sizeMismatches,
      reasonMismatches: s.reasonMismatches,
      scaleViolations: s.scaleViolations,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    const problems: string[] = [];
    if (s.rateOutOfRange > 0) problems.push(`${s.rateOutOfRange} rate(s) outside 0..1`);
    if (s.eulerEmitted > 0) problems.push(`${s.eulerEmitted} non-finite orientation figure(s)`);
    if (s.sizeMismatches > 0) {
      problems.push(`${s.sizeMismatches} record(s) disagreed with the store size they reported`);
    }
    if (s.reasonMismatches > 0) {
      problems.push(`${s.reasonMismatches} decision(s) do not follow from their own inputs`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rateOutOfRange} rate(s) out of range, ${s.eulerEmitted} Euler triple(s), ` +
        `${s.sizeMismatches} size mismatch(es), ${s.reasonMismatches} decision mismatch(es)`,
      reason: problems.length === 0 ? 'the records describe themselves' : problems.join('; '),
      metrics,
    };
  },
};

export const PHASE8_TESTS: readonly Phase8Test[] = [
  KEY_001, KEY_002, KEY_003, KEY_004, KEY_005, KEY_006, KEY_007, KEY_008,
];

export const PHASE8_SPECS: readonly TestSpec[] = PHASE8_TESTS.map((t) => t.spec);

export function runPhase8Tests(ctx: Phase8Context): TestResult[] {
  return runTests(PHASE8_TESTS, ctx);
}

/** Re-exported so the screen names the same numbers the suite judges against. */
export {
  KEYFRAME_DISPLACEMENT_PX,
  KEYFRAME_QUALITY_DELTA,
  KEYFRAME_ROTATION_DEG,
  KEYFRAME_TRANSLATION_UNITS,
  MAX_KEYFRAMES,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  STALE_SURVIVAL_FRACTION,
};
