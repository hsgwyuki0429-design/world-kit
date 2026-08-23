/**
 * Phase 2 test suite — FRAME-001..FRAME-006.
 *
 * Specs transcribed from `docs/phase2/TEST-PLAN.md`, written before `src/pipeline/` existed
 * (§29). Same verdict algebra as Phases 0 and 1: PASS / FAIL / PENDING, with PENDING
 * holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `PipelineStats` and nothing else — no DOM, no worker, no camera. That is
 * what lets `tests/unit/phase2Tests.test.ts` hand the harness a pipeline that never ran, one
 * that ran cleanly, and one whose worker was emitting an image that is not the camera's, and
 * check that the three produce different verdicts.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { PYRAMID_LEVELS } from '../pipeline/pyramid';
import { FLOOR_TIER_STEP, TIER_LADDER } from '../pipeline/tiers';
import type { PipelineStats } from '../pipeline/stats';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** §63 FRAME-001. */
export const REQUIRED_PIPELINE_MS = 30_000;
/** §10's minimum processing rate. */
export const MIN_DELIVERED_FPS = 15;
/** Same stall tolerance Phase 1 used for frame arrival. */
export const MAX_RESULT_GAP_MS = 2000;
/** Of *admitted* frames. Paced-out and backpressured frames are not losses. */
export const MAX_LOST_RATIO = 0.02;
/** §10: heavy image processing may not run continuously on the UI thread. */
export const MIN_WORKER_SHARE = 0.9;
/** §55 UI-thread target. */
export const UI_BUDGET_MS = 16.7;
/** Provenance cross-check: ceiling on the median absolute mean-luma difference, 0–255. */
export const MAX_LUMA_DISAGREEMENT = 10;
export const MIN_CROSSCHECKS = 5;
/**
 * How much the scene must have varied for the cross-check to be informative.
 *
 * Pointed at a motionless wall, a worker emitting a frozen image agrees with the camera
 * perfectly, so agreement proves nothing. This is the spread of the *main thread's* own
 * readings: below it, FRAME-002 reports PENDING rather than claiming a pass it cannot
 * support. Sensor noise on the mean of 3072 pixels is far under 1, so 3.0 is comfortably
 * above noise and trivially reached by any handheld motion.
 */
export const MIN_SCENE_STDDEV = 3.0;
/**
 * Agreement must also be tight *relative to the scene*.
 *
 * A frozen series differs from a varying one by about 0.8 standard deviations on average,
 * so half a standard deviation is a bound a frozen or stale image cannot meet at any scale
 * — where the fixed 10/255 ceiling alone could be met by accident on a scene that barely
 * moved.
 */
export const MAX_DISAGREEMENT_SCENE_FRACTION = 0.5;
/** FRAME-005 needs a population before percentiles mean anything. */
export const MIN_UI_SAMPLES = 100;
/** FRAME-003: aspect ratio must survive the downscale. */
export const MAX_ASPECT_ERROR = 0.02;
/** FRAME-004: more than this in a 10 s window means the hysteresis is not working. */
export const MAX_DECISIONS_PER_10S = 4;

export interface Phase2Context {
  readonly cameraState: CameraState;
  readonly cameraEverOpened: boolean;
  /** The pipeline was started at least once in this run. */
  readonly pipelineEverStarted: boolean;
  readonly stats: PipelineStats;
}

type Phase2Test = PhaseTest<Phase2Context>;

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

/* -------------------------------------------------------------------------- */

const FRAME_001: Phase2Test = {
  spec: {
    id: 'FRAME-001',
    title: '30 seconds of continuous frame supply to the worker',
    required: true,
    input: 'an open camera; the scheduler driven by requestVideoFrameCallback; no load injected',
    expected: 'frames reach the worker and results return continuously for at least 30 000 ms',
    passCriteria: `the longest unstressed contiguous segment is >= ${REQUIRED_PIPELINE_MS} ms; mean delivered rate within it >= ${MIN_DELIVERED_FPS} fps; longest gap between results <= ${MAX_RESULT_GAP_MS} ms; lost frames <= ${pct(MAX_LOST_RATIO)} of admitted; the page was never hidden during the segment`,
    failureCondition: 'any of the above unmet. Never starting the pipeline is PENDING, not FAIL',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const clean = s.longestCleanSegment;
    const lostRatio = s.admitted > 0 ? s.lost / s.admitted : 0;
    const metrics: Record<string, JsonValue> = {
      longestCleanMs: clean?.observedMs ?? 0,
      cleanResults: clean?.results ?? 0,
      cleanMeanFps: clean?.meanFps ?? 0,
      cleanMaxGapMs: clean?.maxGapMs ?? 0,
      admitted: s.admitted,
      completed: s.completed,
      lost: s.lost,
      lostRatio: Math.round(lostRatio * 10000) / 10000,
      pacedOut: s.pacedOut,
      backpressured: s.backpressured,
      acquireFailures: s.acquireFailures,
      sessionDeliveredFps: s.sessionDeliveredFps,
      wasEverHidden: s.wasEverHidden,
      route: s.route,
    };

    if (!ctx.pipelineEverStarted) {
      return {
        verdict: Verdict.PENDING,
        observed: `the pipeline has not been started (camera ${ctx.cameraState})`,
        reason:
          'FRAME-001 measures a running pipeline. With none started there is nothing to ' +
          'measure, which is an absence of an attempt rather than a failure of continuity',
        metrics,
      };
    }
    if (!clean || clean.results === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.completed} frame(s) completed, none in an unstressed segment`,
        reason:
          'continuity is a claim about normal operation, so it is measured over an interval ' +
          'with no injected load. Switch the load off and let the pipeline run',
        metrics,
      };
    }

    const windowFull = clean.observedMs >= REQUIRED_PIPELINE_MS;
    if (!windowFull && !clean.wasHidden) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${(clean.observedMs / 1000).toFixed(1)} s of ${REQUIRED_PIPELINE_MS / 1000} s ` +
          `unstressed, ${clean.results} frames at ${clean.meanFps} fps`,
        reason: s.running
          ? 'the observation window has not filled yet; keep the pipeline running with no load'
          : 'the pipeline was stopped before the window filled; start it again and hold it ' +
            'for the full 30 s',
        metrics,
      };
    }

    const problems: string[] = [];
    if (clean.wasHidden) {
      problems.push(
        'the page was backgrounded during the segment, which stops frame callbacks — this ' +
          'run has not demonstrated 30 s of supply and must be repeated without leaving the app',
      );
    }
    if (!windowFull) problems.push(`only ${(clean.observedMs / 1000).toFixed(1)} s observed`);
    if (clean.meanFps < MIN_DELIVERED_FPS) {
      problems.push(`mean ${clean.meanFps} fps is below the ${MIN_DELIVERED_FPS} fps floor`);
    }
    if (clean.maxGapMs > MAX_RESULT_GAP_MS) {
      problems.push(`longest gap ${clean.maxGapMs} ms exceeds ${MAX_RESULT_GAP_MS} ms`);
    }
    if (lostRatio > MAX_LOST_RATIO) {
      problems.push(
        `${s.lost} of ${s.admitted} admitted frames never came back (${pct(lostRatio)}), ` +
          `beyond the ${pct(MAX_LOST_RATIO)} tolerance`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${(clean.observedMs / 1000).toFixed(1)} s unstressed, ${clean.results} frames at ` +
        `${clean.meanFps} fps, longest gap ${clean.maxGapMs} ms, ${s.lost}/${s.admitted} lost, ` +
        `${s.pacedOut} paced out, ${s.backpressured} backpressured`,
      reason:
        problems.length === 0
          ? 'frames were supplied to the worker continuously for the full window with no ' +
            'stall beyond tolerance; frames declined by pacing and backpressure are the ' +
            'scheduler working, and are counted separately from losses'
          : problems.join('; '),
      metrics,
    };
  },
};

const FRAME_002: Phase2Test = {
  spec: {
    id: 'FRAME-002',
    title: 'Worker processing, on real camera pixels',
    required: true,
    input: 'the acquisition route selected by the runtime probe; the preprocessing worker; the 1 Hz provenance cross-check',
    expected: 'preprocessing runs off the UI thread, on pixels that came from the camera, producing a self-consistent grayscale pyramid',
    passCriteria: `worker scope has no document and a real WorkerGlobalScope; >= ${pct(MIN_WORKER_SHARE)} of measured per-frame processing time is spent in the worker; >= ${MIN_CROSSCHECKS} cross-checks over a scene whose own luma varied by at least ${MIN_SCENE_STDDEV} standard deviations, with median mean-luma disagreement <= ${MAX_LUMA_DISAGREEMENT}/255 and <= ${MAX_DISAGREEMENT_SCENE_FRACTION} of that spread; ${PYRAMID_LEVELS} levels, each byte length equal to its width x height and each the halving of the level above`,
    failureCondition: 'any of the four unmet. A cross-check median above tolerance fails outright: it means the worker image is not the camera image',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const scope = s.workerScope;
    const workerShare =
      s.workerMs.mean + s.uiCostMs.mean > 0
        ? s.workerMs.mean / (s.workerMs.mean + s.uiCostMs.mean)
        : 0;
    const metrics: Record<string, JsonValue> = {
      workerStarted: s.workerStarted,
      workerScope: scope as unknown as JsonValue,
      route: s.route,
      routeProbes: s.routeProbes as unknown as JsonValue,
      workerMsMean: s.workerMs.mean,
      workerMsP95: s.workerMs.p95,
      uiCostMsMean: s.uiCostMs.mean,
      workerShare: Math.round(workerShare * 10000) / 10000,
      crossCheckCount: s.crossCheck.count,
      crossCheckMedian: s.crossCheck.medianAbsDifference,
      crossCheckMax: s.crossCheck.maxAbsDifference,
      crossCheckUnmatched: s.crossCheck.unmatched,
      crossCheckCostMsMean: s.crossCheck.costMs.mean,
      sceneStdDev: s.crossCheck.sceneStdDev,
      sceneRange: s.crossCheck.sceneRange,
      stripMadMax: s.stripMadMax,
      stripMadMedian: s.stripMadMedian,
      stripMadSamples: s.stripMadSamples,
      topMadMax: s.topMadMax,
      distinctChecksums: s.distinctChecksums,
      pyramidLevels: s.pyramidLevels as unknown as JsonValue,
      pyramidProblems: [...s.pyramidProblems],
      workerErrors: [...s.workerErrors],
    };

    if (!ctx.pipelineEverStarted || s.completed === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: s.workerStarted
          ? 'the worker is ready but has completed no frames yet'
          : 'the worker has not reported in yet',
        reason: 'no frame has been through the worker, so there is nothing to check',
        metrics,
      };
    }

    // Criteria that can only be PENDING while evidence accumulates, before any that can FAIL.
    if (s.crossCheck.count < MIN_CROSSCHECKS) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.crossCheck.count}/${MIN_CROSSCHECKS} provenance cross-checks so far`,
        reason:
          'the cross-check runs at 1 Hz because the readback it uses is expensive (§H.1); ' +
          'keep the pipeline running for a few more seconds',
        metrics,
      };
    }
    if (s.crossCheck.sceneStdDev < MIN_SCENE_STDDEV) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `the scene's own luma varied by only ${s.crossCheck.sceneStdDev} (range ` +
          `${s.crossCheck.sceneRange}) across ${s.crossCheck.count} samples`,
        reason:
          'agreement between the worker and the camera proves nothing while the camera is ' +
          'looking at something that does not change — a frozen image would agree just as ' +
          'well. Move the camera so there is something for the pipeline to track',
        metrics,
      };
    }

    const problems: string[] = [];
    if (!scope) {
      problems.push('the worker never reported its scope, so nothing is known about where it ran');
    } else {
      if (scope.hasDocument) {
        problems.push('the worker scope has a `document` — this code is not off the UI thread');
      }
      if (!scope.isWorkerGlobalScope) {
        problems.push('the worker scope is not a WorkerGlobalScope');
      }
    }
    if (workerShare < MIN_WORKER_SHARE) {
      problems.push(
        `only ${pct(workerShare)} of per-frame processing time is in the worker ` +
          `(${s.workerMs.mean} ms worker vs ${s.uiCostMs.mean} ms UI), below the ` +
          `${pct(MIN_WORKER_SHARE)} §10 requires — the heavy work is on the UI thread`,
      );
    }
    // The tolerance is the tighter of a fixed ceiling and half the scene's own spread, so a
    // barely-moving scene demands correspondingly tighter agreement.
    const tolerance = Math.min(
      MAX_LUMA_DISAGREEMENT,
      MAX_DISAGREEMENT_SCENE_FRACTION * s.crossCheck.sceneStdDev,
    );
    if (s.crossCheck.medianAbsDifference > tolerance) {
      problems.push(
        `the worker's grayscale disagrees with an independent measurement of the same video ` +
          `frame by a median of ${s.crossCheck.medianAbsDifference}/255, beyond the ` +
          `${Math.round(tolerance * 100) / 100} tolerance for a scene varying by ` +
          `${s.crossCheck.sceneStdDev} — what the pipeline delivered is not what the ` +
          'camera showed',
      );
    }
    if (!s.pyramidConsistent) {
      problems.push(
        s.pyramidProblems.length > 0
          ? `pyramid geometry is inconsistent: ${s.pyramidProblems.slice(0, 3).join('; ')}`
          : 'pyramid geometry could not be confirmed',
      );
    }
    if (s.pyramidLevels.length !== PYRAMID_LEVELS) {
      problems.push(`${s.pyramidLevels.length} pyramid levels, expected ${PYRAMID_LEVELS}`);
    }

    const levelText = s.pyramidLevels.map((l) => `${l.width}x${l.height}`).join(' / ');
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `route ${s.route ?? 'none locked'}, ${pct(workerShare)} of processing time in the ` +
        `worker (${s.workerMs.mean} ms vs ${s.uiCostMs.mean} ms UI); ${s.crossCheck.count} ` +
        `cross-checks over a scene varying by ${s.crossCheck.sceneStdDev}, median Δluma ` +
        `${s.crossCheck.medianAbsDifference} / max ${s.crossCheck.maxAbsDifference}; strip Δ ` +
        `peak ${s.stripMadMax}; levels ${levelText}`,
      reason:
        problems.length === 0
          ? 'preprocessing ran in a scope with no document, took the overwhelming majority ' +
            'of per-frame processing time, produced a pyramid whose geometry checks out, ' +
            'and produced an image that agrees with an independent measurement of the same ' +
            'video frame — which a fabricated or stale image could not do'
          : problems.join('; '),
      metrics,
    };
  },
};

const FRAME_003: Phase2Test = {
  spec: {
    id: 'FRAME-003',
    title: 'Resolution fallback',
    required: true,
    input: 'measured worker latency rising until the controller steps down the tier ladder',
    expected: 'the processing resolution really changes, and every frame respects its tier',
    passCriteria: `two or more distinct processing resolutions produced, read from buffers the worker returned; at least one recorded downward step with the latency that caused it; no frame above its tier pixel budget or above ${TIER_LADDER[0]?.longEdge}x${TIER_LADDER[0]?.shortEdge}; aspect ratio preserved to within ${pct(MAX_ASPECT_ERROR)} and never upscaled`,
    failureCondition: 'the tier changed but the produced buffers did not; any frame above its budget; an aspect-ratio break; any upscale',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const downSteps = s.decisions.filter((d) => d.direction === 'DOWN');
    // Distinct processing resolutions actually produced, taken from what the worker returned
    // rather than from the tier variable: a tier that changed without the buffers changing is
    // exactly the failure this test exists to catch.
    const producedSizes = new Set<string>();
    for (const t of s.tierUsage) for (const size of t.sizes) producedSizes.add(size);

    // Compare the largest frame produced at the least-degraded tier against the largest at
    // the most-degraded one. Both must have produced frames, and the second must genuinely
    // be smaller — which a source rotation alone cannot manufacture, since it changes both.
    const used = [...s.tierUsage].filter((t) => t.frames > 0).sort((a, b) => a.step - b.step);
    const largestAt = (sizes: readonly string[]): number =>
      Math.max(
        0,
        ...sizes.map((size) => {
          const [w, h] = size.split('x').map(Number);
          return (w ?? 0) * (h ?? 0);
        }),
      );
    const highest = used[0];
    const lowest = used[used.length - 1];
    const resolutionFellBetweenTiers =
      !!highest && !!lowest && highest.step !== lowest.step &&
      largestAt(lowest.sizes) < largestAt(highest.sizes);
    const laddersDifferInResolution =
      !!highest && !!lowest && highest.step !== lowest.step &&
      TIER_LADDER[highest.step] !== undefined && TIER_LADDER[lowest.step] !== undefined &&
      (TIER_LADDER[highest.step]!.longEdge !== TIER_LADDER[lowest.step]!.longEdge ||
        TIER_LADDER[highest.step]!.shortEdge !== TIER_LADDER[lowest.step]!.shortEdge);

    const metrics: Record<string, JsonValue> = {
      tierUsage: s.tierUsage as unknown as JsonValue,
      producedSizes: [...producedSizes],
      distinctProducedSizes: producedSizes.size,
      highestTierUsed: highest?.label ?? null,
      lowestTierUsed: lowest?.label ?? null,
      largestPixelsAtHighestTier: highest ? largestAt(highest.sizes) : 0,
      largestPixelsAtLowestTier: lowest ? largestAt(lowest.sizes) : 0,
      downSteps: downSteps.length,
      decisions: s.decisions as unknown as JsonValue,
      overBudgetFrames: s.overBudgetFrames,
      upscaledFrames: s.upscaledFrames,
      maxAspectError: s.maxAspectError,
      spontaneousDegrade: s.spontaneousDegrade,
      underInjectedLoad: s.anyStressed,
      stressIntervals: s.stressIntervals as unknown as JsonValue,
      sourceSizesObserved: [...s.sourceSizesObserved],
    };

    if (!ctx.pipelineEverStarted || s.completed === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'the pipeline has produced no frames yet',
        reason: 'there is no processing resolution to observe',
        metrics,
      };
    }
    if (downSteps.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${producedSizes.size} distinct processing resolution(s) produced ` +
          `(${[...producedSizes].join(', ') || 'none'}), no downward step`,
        reason:
          'the fallback has not run. A device meeting its budget never degrades on its own, ' +
          'so switch load injection on: the extra work is real, the latency is measured, and ' +
          'the resolution the controller then selects is read back from what the worker ' +
          'actually produced',
        metrics,
      };
    }
    if (!laddersDifferInResolution) {
      // The ladder has moved, but only across steps that share a resolution — the rate
      // dropped and nothing else. That is FRAME-004's subject, not this one.
      return {
        verdict: Verdict.PENDING,
        observed:
          `the ladder moved between ${highest?.label ?? 'n/a'} and ${lowest?.label ?? 'n/a'}, ` +
          'which share a processing resolution',
        reason:
          'only the target rate has changed so far. Keep the load applied until the ' +
          'controller reaches a step that actually lowers the resolution',
        metrics,
      };
    }

    const problems: string[] = [];
    if (!resolutionFellBetweenTiers) {
      problems.push(
        `the tier moved from ${highest?.label} to ${lowest?.label} but the buffers the worker ` +
          `returned did not get smaller (${largestAt(highest?.sizes ?? [])} px against ` +
          `${largestAt(lowest?.sizes ?? [])} px) — the fallback changed a variable, not the work`,
      );
    }
    if (s.overBudgetFrames > 0) {
      problems.push(
        `${s.overBudgetFrames} frame(s) were processed above the pixel budget of the tier ` +
          'in force at the time',
      );
    }
    if (s.upscaledFrames > 0) {
      problems.push(`${s.upscaledFrames} frame(s) were upscaled — that is invented image data`);
    }
    if (s.maxAspectError > MAX_ASPECT_ERROR) {
      problems.push(
        `worst aspect-ratio error ${pct(s.maxAspectError)} exceeds ${pct(MAX_ASPECT_ERROR)}; a ` +
          'stretched image would give Phase 6 the wrong focal lengths',
      );
    }
    const unexplained = downSteps.filter((d) => !(d.medianWorkerMs > 0) || !d.reason);
    if (unexplained.length > 0) {
      problems.push(`${unexplained.length} downward step(s) carry no measurement`);
    }

    const cause = s.spontaneousDegrade
      ? 'at least one downward step was taken with no load injected — the device could not ' +
        'hold its tier on its own, which is worth knowing'
      : s.anyStressed
        ? 'every downward step was taken under injected load, which is a stimulus, not a result'
        : 'no load was injected';
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `resolutions produced: ${[...producedSizes].join(' -> ')}; ${downSteps.length} downward ` +
        `step(s), deepest ${s.tierUsage[s.tierUsage.length - 1]?.label ?? 'n/a'}; ` +
        `${s.overBudgetFrames} over budget, ${s.upscaledFrames} upscaled, worst aspect error ` +
        pct(s.maxAspectError),
      reason:
        problems.length === 0
          ? `the processing resolution really changed and every frame stayed within its ` +
            `tier's budget, preserved its source aspect ratio and was never upscaled. ${cause}`
          : problems.join('; '),
      metrics,
    };
  },
};

const FRAME_004: Phase2Test = {
  spec: {
    id: 'FRAME-004',
    title: 'FPS adaptation',
    required: true,
    input: 'the same measured latency stream; the controller target-rate ladder',
    expected: 'the target rate adapts to measured load, never below the §10 floor, with a measurable effect',
    passCriteria: `the target rate changed at least once and every selected target is >= ${MIN_DELIVERED_FPS} fps; each change carries the median worker latency and the budget it was compared against; after the last downward step that lowered the processing resolution, the following window's median worker latency is lower than the window that triggered it; once load was removed the pipeline returned to >= ${MIN_DELIVERED_FPS} fps and the controller recovered at least one step`,
    failureCondition: `a selected target below ${MIN_DELIVERED_FPS} fps; a change with no measurement behind it; no recovery after load was removed; more than ${MAX_DECISIONS_PER_10S} changes in any 10 s window`,
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const rateChanges = s.decisions.filter((d) => d.fromTargetFps !== d.toTargetFps);
    // The effect of a step is judged on the last downward step that changed the processing
    // *resolution*. A step that only lowers the target rate cannot reduce the time one frame
    // takes — it reduces how many frames are asked for — so measuring it against per-frame
    // latency would be measuring the wrong thing. See the amendment in the test plan.
    const resolutionChanged = (fromStep: number, toStep: number): boolean => {
      const a = TIER_LADDER[fromStep];
      const b = TIER_LADDER[toStep];
      return !!a && !!b && (a.longEdge !== b.longEdge || a.shortEdge !== b.shortEdge);
    };
    const downSteps = s.decisions.filter((d) => d.direction === 'DOWN');
    const resolutionDownSteps = downSteps.filter((d) => resolutionChanged(d.fromStep, d.toStep));
    const lastDown = resolutionDownSteps[resolutionDownSteps.length - 1];
    const lastDownIndex = lastDown ? s.decisions.lastIndexOf(lastDown) : -1;
    const lastDownOutcome = s.decisionOutcomes.find((o) => o.decisionIndex === lastDownIndex);
    const stressEnded = s.stressIntervals.filter((i) => i.endedAt !== null).pop();
    const recovery = stressEnded
      ? s.decisions.filter((d) => d.direction === 'UP' && d.at >= (stressEnded.endedAt ?? 0))
      : [];

    const metrics: Record<string, JsonValue> = {
      decisions: s.decisions as unknown as JsonValue,
      decisionOutcomes: s.decisionOutcomes as unknown as JsonValue,
      rateChanges: rateChanges.length,
      downSteps: downSteps.length,
      resolutionDownSteps: resolutionDownSteps.length,
      targetsSelected: [...new Set(s.decisions.map((d) => d.toTargetFps))],
      currentTargetFps: s.targetFps,
      deliveredFps: s.deliveredFps,
      maxDecisionsPer10s: s.maxDecisionsPer10s,
      recoverySteps: recovery.length,
      stressIntervals: s.stressIntervals as unknown as JsonValue,
      stillUnderLoad: s.stressPasses > 0,
      floorTierStep: FLOOR_TIER_STEP,
    };

    if (!ctx.pipelineEverStarted || s.completed === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'the pipeline has produced no frames yet',
        reason: 'there is no latency stream for the controller to adapt to',
        metrics,
      };
    }
    if (rateChanges.length === 0 || resolutionDownSteps.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${rateChanges.length} rate change(s) and ${resolutionDownSteps.length} resolution ` +
          `step(s); target rate is ${s.targetFps} fps`,
        reason:
          'adaptation has not run. Switch load injection on so the worker genuinely misses ' +
          'its budget, and the controller has something real to react to',
        metrics,
      };
    }
    if (s.stressPasses > 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `${rateChanges.length} rate change(s) so far, still under injected load`,
        reason:
          'the recovery half of this test needs the load switched off — an adaptation that ' +
          'only degrades is half a mechanism',
        metrics,
      };
    }
    if (stressEnded && recovery.length === 0 && s.tierStep > 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${rateChanges.length} rate change(s); load stopped, still at ${s.tierLabel} with ` +
          `${s.deliveredFps} fps delivered`,
        reason:
          'the controller has not recovered a step yet. Recovery is deliberately slow — it ' +
          'requires several consecutive windows comfortably inside the next tier budget — so ' +
          'leave the pipeline running',
        metrics,
      };
    }

    const problems: string[] = [];
    const belowFloor = s.decisions.filter((d) => d.toTargetFps < MIN_DELIVERED_FPS);
    if (belowFloor.length > 0) {
      problems.push(
        `the controller selected ${belowFloor.map((d) => `${d.toTargetFps} fps`).join(', ')}, ` +
          `below the ${MIN_DELIVERED_FPS} fps §10 sets as the minimum`,
      );
    }
    const unexplained = s.decisions.filter((d) => !(d.medianWorkerMs > 0) || !(d.budgetMs > 0) || !d.reason);
    if (unexplained.length > 0) {
      problems.push(
        `${unexplained.length} change(s) carry no measurement — a target rate that changed ` +
          'because something said so, rather than because something was measured',
      );
    }
    if (resolutionDownSteps.length === 0) {
      problems.push(
        'the ladder never took a step that lowered the processing resolution, so no ' +
          'downward step could have reduced the time a frame takes',
      );
    } else if (!lastDownOutcome) {
      problems.push(
        'no window of latencies was collected after the last resolution step, so its effect ' +
          'is unknown',
      );
    } else if (lastDownOutcome.afterMedianWorkerMs >= lastDownOutcome.beforeMedianWorkerMs) {
      problems.push(
        `the last downward step did not help: median worker latency was ` +
          `${lastDownOutcome.beforeMedianWorkerMs} ms before and ` +
          `${lastDownOutcome.afterMedianWorkerMs} ms after`,
      );
    }
    if (s.maxDecisionsPer10s > MAX_DECISIONS_PER_10S) {
      problems.push(
        `${s.maxDecisionsPer10s} changes within one 10 s window, beyond the ` +
          `${MAX_DECISIONS_PER_10S} that separates adaptation from oscillation`,
      );
    }
    if (stressEnded) {
      if (recovery.length === 0 && s.tierStep > 0) {
        problems.push('the controller never recovered a step after the load was removed');
      }
      if (s.deliveredFps > 0 && s.deliveredFps < MIN_DELIVERED_FPS) {
        problems.push(
          `delivered rate ${s.deliveredFps} fps is below the ${MIN_DELIVERED_FPS} fps floor ` +
            'with no load applied',
        );
      }
    }

    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${rateChanges.length} rate change(s) among ${s.decisions.length} ladder move(s); ` +
        `now ${s.tierLabel} delivering ${s.deliveredFps} fps; the last resolution step took ` +
        `median worker latency ${lastDownOutcome?.beforeMedianWorkerMs ?? 'n/a'} ms -> ` +
        `${lastDownOutcome?.afterMedianWorkerMs ?? 'n/a'} ms; ${recovery.length} recovery step(s)`,
      reason:
        problems.length === 0
          ? 'the target rate moved because measured latency moved, never below the 15 fps ' +
            'floor; the downward step measurably reduced worker latency, and the controller ' +
            'climbed back once the load was gone'
          : problems.join('; '),
      metrics,
    };
  },
};

const FRAME_005: Phase2Test = {
  spec: {
    id: 'FRAME-005',
    title: 'UI-thread budget',
    required: false,
    input: 'the synchronous cost of the pipeline own work on the callbacks where a frame is admitted',
    expected: 'the UI thread keeps a 60 Hz budget while the pipeline runs',
    passCriteria: `mean and 95th percentile pipeline UI cost <= ${UI_BUDGET_MS} ms over >= ${MIN_UI_SAMPLES} admitted frames, excluding the 1 Hz provenance cross-check whose own cost is reported in full`,
    failureCondition: 'either statistic over budget. Advisory: §34 ranks correctness above performance',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      uiCostMs: s.uiCostMs as unknown as JsonValue,
      acquireMs: s.acquireMs as unknown as JsonValue,
      roundTripMs: s.roundTripMs as unknown as JsonValue,
      workerMs: s.workerMs as unknown as JsonValue,
      crossCheckCostMs: s.crossCheck.costMs as unknown as JsonValue,
      route: s.route,
      budgetMs: UI_BUDGET_MS,
    };
    if (s.uiCostMs.count < MIN_UI_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.uiCostMs.count}/${MIN_UI_SAMPLES} admitted frames measured`,
        reason: 'percentiles over a handful of frames say nothing; keep the pipeline running',
        metrics,
      };
    }
    const problems: string[] = [];
    if (s.uiCostMs.mean > UI_BUDGET_MS) {
      problems.push(`mean ${s.uiCostMs.mean} ms exceeds the ${UI_BUDGET_MS} ms budget`);
    }
    if (s.uiCostMs.p95 > UI_BUDGET_MS) {
      problems.push(`p95 ${s.uiCostMs.p95} ms exceeds the ${UI_BUDGET_MS} ms budget`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `UI ${s.uiCostMs.mean} ms mean / ${s.uiCostMs.p95} ms p95 / ${s.uiCostMs.max} ms max ` +
        `over ${s.uiCostMs.count} frames via ${s.route ?? 'no locked route'}; the worker took ` +
        `${s.workerMs.mean} ms mean; the 1 Hz cross-check cost ${s.crossCheck.costMs.mean} ms mean`,
      reason:
        problems.length === 0
          ? 'the UI thread kept its 60 Hz budget while the worker carried the per-frame cost, ' +
            'which is the division §10 asks for and the one §H.1 said a main-thread readback ' +
            'could not deliver'
          : problems.join('; '),
      metrics,
    };
  },
};

const FRAME_006: Phase2Test = {
  spec: {
    id: 'FRAME-006',
    title: 'Source geometry is per-frame',
    required: false,
    input: 'the device rotated while the pipeline runs, changing the source frame size',
    expected: 'the processing size is re-derived from the new source geometry, and every frame record carries its own',
    passCriteria: 'at least two distinct source sizes observed; the first completed frame after the change carries a processing size derived from the new source geometry; every completed frame record carries its own source and processing size',
    failureCondition: 'the processing size stays derived from a stale source size, or frame records share one session-wide geometry',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const badRecords = s.recentFrames.filter(
      (f) => !(f.sourceWidth > 0) || !(f.sourceHeight > 0) || !(f.procWidth > 0) || !(f.procHeight > 0),
    );
    const metrics: Record<string, JsonValue> = {
      sourceSizesObserved: [...s.sourceSizesObserved],
      processedSizesObserved: [...s.processedSizesObserved],
      framesAfterSourceChange: s.framesAfterSourceChange,
      procMatchedAfterSourceChange: s.procMatchedAfterSourceChange,
      recentFrameCount: s.recentFrames.length,
      recordsMissingGeometry: badRecords.length,
    };
    if (s.sourceSizesObserved.length < 2) {
      return {
        verdict: Verdict.PENDING,
        observed: `one source size observed (${s.sourceSizesObserved.join(', ') || 'none'})`,
        reason:
          'rotate the device while the pipeline runs. §H.0 measured the frame dimensions ' +
          'swapping on this platform, which changes the intrinsics Phase 6 will derive — so ' +
          'it is a fact about the pipeline that must be observed, not assumed',
        metrics,
      };
    }
    const problems: string[] = [];
    if (s.procMatchedAfterSourceChange === false) {
      problems.push(
        'the first frame completed after the source size changed carried a processing size ' +
          'derived from the old geometry',
      );
    }
    if (s.procMatchedAfterSourceChange === null) {
      problems.push('no frame completed after the source size changed');
    }
    if (badRecords.length > 0) {
      problems.push(`${badRecords.length} completed frame record(s) carry no geometry of their own`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `source sizes ${s.sourceSizesObserved.join(' -> ')}; processing sizes ` +
        `${s.processedSizesObserved.join(' -> ')}; ${s.framesAfterSourceChange} frame(s) since ` +
        'the last change',
      reason:
        problems.length === 0
          ? 'the source geometry is read per frame and the processing size re-derived from it, ' +
            'so a rotation mid-scan is carried through rather than smoothed over (§H.0)'
          : problems.join('; '),
      metrics,
    };
  },
};

export const PHASE2_TESTS: readonly Phase2Test[] = [
  FRAME_001, FRAME_002, FRAME_003, FRAME_004, FRAME_005, FRAME_006,
];

export const PHASE2_SPECS: readonly TestSpec[] = PHASE2_TESTS.map((t) => t.spec);

export function runPhase2Tests(ctx: Phase2Context): TestResult[] {
  return runTests(PHASE2_TESTS, ctx);
}
