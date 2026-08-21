/**
 * The Phase 2 harness, tested against pipelines that did not happen.
 *
 * `runPhase2Tests` reads a `PipelineStats` and nothing else, so the suite itself can be
 * examined without a camera, a worker or a device. That matters more here than it did in
 * earlier phases: FRAME-002 is the check that the pipeline is delivering the real camera
 * image, and a check that has never been shown to fail is not a check. So the fixtures
 * below include a pipeline whose worker is emitting an image that is not the camera's, one
 * that quietly ran the heavy work on the UI thread, one that upscaled, and one whose tier
 * variable moved while its buffers did not — and each must be caught.
 */

import { describe, expect, it } from 'vitest';
import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import { runPhase2Tests, PHASE2_SPECS } from '../../src/testkit/Phase2Tests';
import type { Phase2Context } from '../../src/testkit/Phase2Tests';
import type { PipelineStats } from '../../src/pipeline/stats';
import { AcquireRoute } from '../../src/pipeline/messages';

function series(mean: number, p95 = mean, count = 900): PipelineStats['uiCostMs'] {
  return { count, mean, p50: mean, p95, min: 0, max: p95 * 2 };
}

/** A run that did everything Phase 2 asks for. Every other fixture is a mutation of this. */
function healthyStats(): PipelineStats {
  return {
    running: true,
    startedAt: 0,
    uptimeMs: 65_000,

    route: AcquireRoute.VIDEO_FRAME,
    routeLocked: true,
    routeProbes: [
      {
        route: AcquireRoute.VIDEO_FRAME,
        ok: true,
        attempts: 940,
        successes: 935,
        meanAcquireMs: 0.42,
        error: null,
        note: 'selected',
      },
    ],

    workerStarted: true,
    workerScope: {
      hasDocument: false,
      hasWindow: false,
      isWorkerGlobalScope: true,
      hasOffscreenCanvas: true,
      canvas2dAvailable: true,
      hardwareConcurrency: 4,
    },
    workerErrors: [],

    callbacks: 1900,
    admitted: 940,
    completed: 935,
    pacedOut: 940,
    backpressured: 20,
    lost: 5,
    acquireFailures: 0,

    deliveredFps: 24.1,
    sourceFps: 30.1,
    sessionDeliveredFps: 23.8,
    maxResultGapMs: 96,

    uiCostMs: series(0.62, 1.4),
    acquireMs: series(0.44, 0.9),
    workerMs: series(18.4, 27.2),
    roundTripMs: series(20.1, 31.5),

    tierStep: 2,
    tierLabel: 'BASIC 960x540@20',
    targetFps: 20,
    procWidth: 960,
    procHeight: 540,
    decisions: [
      {
        at: 40_000,
        direction: 'DOWN',
        fromStep: 1,
        toStep: 2,
        fromLabel: 'BASIC 960x540@30',
        toLabel: 'BASIC 960x540@20',
        fromTargetFps: 30,
        toTargetFps: 20,
        medianWorkerMs: 31.2,
        budgetMs: 33.33,
        deliveredFps: 29.4,
        windowSize: 15,
        reason: 'median worker latency 31.2 ms exceeds 30 ms (0.9 of the 33.33 ms budget)',
      },
      {
        at: 43_000,
        direction: 'DOWN',
        fromStep: 2,
        toStep: 3,
        fromLabel: 'BASIC 960x540@20',
        toLabel: 'REDUCED 640x360@20',
        fromTargetFps: 20,
        toTargetFps: 20,
        medianWorkerMs: 62.7,
        budgetMs: 50,
        deliveredFps: 18.2,
        windowSize: 15,
        reason: 'median worker latency 62.7 ms exceeds 45 ms (0.9 of the 50 ms budget)',
      },
      {
        at: 60_000,
        direction: 'UP',
        fromStep: 3,
        toStep: 2,
        fromLabel: 'REDUCED 640x360@20',
        toLabel: 'BASIC 960x540@20',
        fromTargetFps: 20,
        toTargetFps: 20,
        medianWorkerMs: 11.9,
        budgetMs: 50,
        deliveredFps: 20.1,
        windowSize: 15,
        reason: 'median worker latency 11.9 ms is under 25 ms for 3 consecutive windows',
      },
    ],
    decisionOutcomes: [
      { decisionIndex: 0, direction: 'DOWN', beforeMedianWorkerMs: 31.2, afterMedianWorkerMs: 30.8, samples: 15 },
      { decisionIndex: 1, direction: 'DOWN', beforeMedianWorkerMs: 62.7, afterMedianWorkerMs: 27.4, samples: 15 },
      { decisionIndex: 2, direction: 'UP', beforeMedianWorkerMs: 11.9, afterMedianWorkerMs: 18.6, samples: 15 },
    ],
    tierUsage: [
      { step: 1, label: 'BASIC 960x540@30', frames: 700, sizes: ['960x540'] },
      { step: 2, label: 'BASIC 960x540@20', frames: 160, sizes: ['960x540'] },
      { step: 3, label: 'REDUCED 640x360@20', frames: 75, sizes: ['640x360'] },
    ],
    spontaneousDegrade: false,
    maxDecisionsPer10s: 2,

    sourceSizesObserved: ['1280x720', '720x1280'],
    processedSizesObserved: ['960x540', '640x360', '540x960'],
    sourceWidth: 1280,
    sourceHeight: 720,
    maxAspectError: 0.004,
    overBudgetFrames: 0,
    upscaledFrames: 0,
    framesAfterSourceChange: 220,
    procMatchedAfterSourceChange: true,

    pyramidLevels: [
      { width: 960, height: 540, bytes: 518_400 },
      { width: 480, height: 270, bytes: 129_600 },
      { width: 240, height: 135, bytes: 32_400 },
    ],
    pyramidConsistent: true,
    pyramidProblems: [],
    meanLuma: 121.4,
    topMadMax: 22.5,
    topMadMedian: 9.1,
    topMadSamples: 900,
    stripMadMax: 41.2,
    stripMadMedian: 18.6,
    stripMadSamples: 250,
    distinctChecksums: 928,
    crossCheck: {
      count: 31,
      unmatched: 0,
      medianAbsDifference: 1.24,
      maxAbsDifference: 4.9,
      // The scene moved: the main thread's own readings spread over 24.6, and the worker
      // tracked them to within 1.24. A frozen image could not do that.
      sceneStdDev: 24.6,
      sceneRange: 92.4,
      costMs: series(13.8, 16.1, 31),
    },

    stressPasses: 0,
    stressIntervals: [
      {
        startedAt: 38_000,
        endedAt: 52_000,
        passes: 24,
        derivedFrom: 'target 67 ms, measured baseline 18.4 ms and 2.03 ms per pyramid build',
      },
    ],
    anyStressed: true,

    segments: [],
    longestCleanSegment: {
      index: 0,
      stressed: false,
      startedAt: 0,
      endedAt: 38_000,
      observedMs: 32_400,
      results: 780,
      meanFps: 24.0,
      maxGapMs: 96,
      wasHidden: false,
      endReason: 'load injection started',
    },
    wasEverHidden: false,
    hiddenCount: 0,

    recentFrames: [
      {
        frameId: 930, at: 64_000, sourceWidth: 1280, sourceHeight: 720,
        procWidth: 960, procHeight: 540, tierStep: 2, workerMs: 18.2,
        roundTripMs: 20.4, meanLuma: 120.9, checksum: 3_412_991, stressPasses: 0,
      },
      {
        frameId: 931, at: 64_040, sourceWidth: 1280, sourceHeight: 720,
        procWidth: 960, procHeight: 540, tierStep: 2, workerMs: 17.9,
        roundTripMs: 19.8, meanLuma: 121.8, checksum: 998_112, stressPasses: 0,
      },
    ],
  };
}

function ctxWith(stats: PipelineStats, over: Partial<Phase2Context> = {}): Phase2Context {
  return {
    cameraState: CameraState.LIVE,
    cameraEverOpened: true,
    pipelineEverStarted: true,
    stats,
    ...over,
  };
}

function verdictOf(ctx: Phase2Context, id: string): { verdict: Verdict; reason: string } {
  const r = runPhase2Tests(ctx).find((x) => x.spec.id === id);
  if (!r) throw new Error(`no such test: ${id}`);
  return { verdict: r.verdict, reason: r.reason };
}

describe('Phase 2 test specs', () => {
  it('declares the four tests §63 names as REQUIRED', () => {
    const required = PHASE2_SPECS.filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['FRAME-001', 'FRAME-002', 'FRAME-003', 'FRAME-004']);
  });

  it('every spec states its criteria and its failure condition before it runs (§29)', () => {
    for (const s of PHASE2_SPECS) {
      expect(s.input, s.id).toBeTruthy();
      expect(s.expected, s.id).toBeTruthy();
      expect(s.passCriteria, s.id).toBeTruthy();
      expect(s.failureCondition, s.id).toBeTruthy();
    }
  });
});

describe('a pipeline that never ran', () => {
  const results = runPhase2Tests(
    ctxWith(
      {
        ...healthyStats(),
        running: false,
        completed: 0,
        admitted: 0,
        callbacks: 0,
        workerStarted: false,
        workerScope: null,
        longestCleanSegment: null,
          crossCheck: {
          count: 0, unmatched: 0, medianAbsDifference: -1, maxAbsDifference: -1,
          sceneStdDev: -1, sceneRange: -1, costMs: series(0, 0, 0),
        },
        stripMadSamples: 0,
        decisions: [],
        tierUsage: [],
        sourceSizesObserved: [],
        uiCostMs: series(0, 0, 0),
      },
      { pipelineEverStarted: false, cameraState: CameraState.IDLE, cameraEverOpened: false },
    ),
  );

  it('is PENDING everywhere, never PASS and never FAIL', () => {
    for (const r of results) {
      expect(r.verdict, `${r.spec.id}: ${r.reason}`).toBe(Verdict.PENDING);
    }
  });
});

describe('a healthy device run', () => {
  const results = runPhase2Tests(ctxWith(healthyStats()));

  it('passes every test', () => {
    for (const r of results) {
      expect(r.verdict, `${r.spec.id}: ${r.reason}`).toBe(Verdict.PASS);
    }
  });

  it('records the measurements behind the verdicts, not just the verdicts', () => {
    const f2 = results.find((r) => r.spec.id === 'FRAME-002');
    expect(Number(f2?.metrics['crossCheckMedian'])).toBeGreaterThanOrEqual(0);
    expect(Number(f2?.metrics['workerShare'])).toBeGreaterThan(0.9);
    const f4 = results.find((r) => r.spec.id === 'FRAME-004');
    expect(Array.isArray(f4?.metrics['decisions'])).toBe(true);
  });
});

describe('FRAME-001 — continuity', () => {
  it('is PENDING while the unstressed window is still filling', () => {
    const s = healthyStats();
    const clean = s.longestCleanSegment;
    expect(clean).toBeTruthy();
    const short = { ...s, longestCleanSegment: { ...clean!, observedMs: 12_000, results: 290 } };
    expect(verdictOf(ctxWith(short), 'FRAME-001').verdict).toBe(Verdict.PENDING);
  });

  it('does not accept a long stressed segment in place of an unstressed one', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, longestCleanSegment: null }), 'FRAME-001').verdict).toBe(
      Verdict.PENDING,
    );
  });

  it('fails when frames were handed over and never came back', () => {
    const s = healthyStats();
    const lossy = { ...s, lost: 200, admitted: 940 };
    const r = verdictOf(ctxWith(lossy), 'FRAME-001');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('never came back');
  });

  it('does not count paced-out or backpressured frames as losses', () => {
    const s = healthyStats();
    const paced = { ...s, pacedOut: 9000, backpressured: 4000 };
    expect(verdictOf(ctxWith(paced), 'FRAME-001').verdict).toBe(Verdict.PASS);
  });

  it('fails a window the page was backgrounded during', () => {
    const s = healthyStats();
    const clean = s.longestCleanSegment!;
    const hidden = {
      ...s,
      wasEverHidden: true,
      hiddenCount: 1,
      longestCleanSegment: { ...clean, wasHidden: true },
    };
    const r = verdictOf(ctxWith(hidden), 'FRAME-001');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('backgrounded');
  });

  it('fails a stalled segment even when its mean rate looks fine', () => {
    const s = healthyStats();
    const stalled = { ...s, longestCleanSegment: { ...s.longestCleanSegment!, maxGapMs: 5000 } };
    expect(verdictOf(ctxWith(stalled), 'FRAME-001').verdict).toBe(Verdict.FAIL);
  });
});

describe('FRAME-002 — the worker is processing the real camera image', () => {
  it('fails when the worker image does not agree with the camera', () => {
    // The pipeline is otherwise perfect: frames flow, latency is good, the pyramid is
    // consistent, the checksum changes every frame. Only the provenance check disagrees —
    // and that alone must sink it.
    const s = healthyStats();
    const lying = {
      ...s,
      crossCheck: { ...s.crossCheck, medianAbsDifference: 47.2, maxAbsDifference: 96.4 },
    };
    const r = verdictOf(ctxWith(lying), 'FRAME-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('not what the camera showed');
  });

  it('fails when the heavy work is on the UI thread after all', () => {
    const s = healthyStats();
    const onUi = { ...s, uiCostMs: series(14.2, 21.0), workerMs: series(3.1, 6.0) };
    const r = verdictOf(ctxWith(onUi), 'FRAME-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('UI thread');
  });

  it('fails when the worker scope turns out to have a document', () => {
    const s = healthyStats();
    const notAWorker = {
      ...s,
      workerScope: { ...s.workerScope!, hasDocument: true, isWorkerGlobalScope: false },
    };
    expect(verdictOf(ctxWith(notAWorker), 'FRAME-002').verdict).toBe(Verdict.FAIL);
  });

  it('fails a worker image frozen against a gently moving scene', () => {
    // The case the fixed 10/255 ceiling alone would miss. The scene varied by only 6.2, so
    // a frozen worker series sits about 4.8 away from it on average — comfortably inside
    // the fixed ceiling, and comfortably outside half the scene's own spread.
    const s = healthyStats();
    const frozen = {
      ...s,
      crossCheck: {
        ...s.crossCheck,
        medianAbsDifference: 4.8,
        maxAbsDifference: 11.9,
        sceneStdDev: 6.2,
        sceneRange: 21.4,
      },
      stripMadMax: 0.3,
      stripMadMedian: 0.1,
    };
    const r = verdictOf(ctxWith(frozen), 'FRAME-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('not what the camera showed');
  });

  it('fails a worker image frozen against a scene that moved a lot', () => {
    const s = healthyStats();
    const frozen = {
      ...s,
      crossCheck: { ...s.crossCheck, medianAbsDifference: 19.7, maxAbsDifference: 48.1 },
    };
    expect(verdictOf(ctxWith(frozen), 'FRAME-002').verdict).toBe(Verdict.FAIL);
  });

  it('is PENDING, not PASS, when the scene never varied enough to be informative', () => {
    // Perfect agreement against a motionless wall proves nothing: a frozen worker image
    // would agree just as well.
    const s = healthyStats();
    const static_ = {
      ...s,
      crossCheck: { ...s.crossCheck, medianAbsDifference: 0.02, sceneStdDev: 0.3, sceneRange: 1.1 },
    };
    const r = verdictOf(ctxWith(static_), 'FRAME-002');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('does not change');
  });

  it('fails a pyramid whose buffers do not hold the image they claim to', () => {
    const s = healthyStats();
    const bad = {
      ...s,
      pyramidConsistent: false,
      pyramidProblems: ['level 1 reports 129600 bytes for 480x271'],
    };
    expect(verdictOf(ctxWith(bad), 'FRAME-002').verdict).toBe(Verdict.FAIL);
  });

  it('is PENDING, not PASS, before enough cross-checks exist to mean anything', () => {
    const s = healthyStats();
    const early = { ...s, crossCheck: { ...s.crossCheck, count: 2 } };
    expect(verdictOf(ctxWith(early), 'FRAME-002').verdict).toBe(Verdict.PENDING);
  });
});

describe('FRAME-003 — resolution fallback', () => {
  it('is PENDING until the fallback has actually run', () => {
    const s = healthyStats();
    const never = {
      ...s,
      decisions: [],
      tierUsage: [{ step: 1, label: 'BASIC 960x540@30', frames: 900, sizes: ['960x540'] }],
    };
    const r = verdictOf(ctxWith(never), 'FRAME-003');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('has not run');
  });

  it('fails when the tier moved but the buffers never did', () => {
    // The failure this test exists for: a tier variable that changes while every frame is
    // still produced at the old size. The ladder says REDUCED; the worker returned 960x540
    // throughout.
    const s = healthyStats();
    const cosmetic = {
      ...s,
      tierUsage: [
        { step: 1, label: 'BASIC 960x540@30', frames: 700, sizes: ['960x540'] },
        { step: 3, label: 'REDUCED 640x360@20', frames: 200, sizes: ['960x540'] },
      ],
    };
    const r = verdictOf(ctxWith(cosmetic), 'FRAME-003');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('changed a variable, not the work');
  });

  it('is PENDING while the ladder has only lowered the rate, not the resolution', () => {
    const s = healthyStats();
    const rateOnly = {
      ...s,
      tierUsage: [
        { step: 1, label: 'BASIC 960x540@30', frames: 700, sizes: ['960x540'] },
        { step: 2, label: 'BASIC 960x540@20', frames: 200, sizes: ['960x540'] },
      ],
    };
    const r = verdictOf(ctxWith(rateOnly), 'FRAME-003');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('only the target rate');
  });

  it('fails a frame processed above its tier budget', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, overBudgetFrames: 12 }), 'FRAME-003').verdict).toBe(Verdict.FAIL);
  });

  it('fails an upscale, which is invented image data', () => {
    const s = healthyStats();
    const r = verdictOf(ctxWith({ ...s, upscaledFrames: 3 }), 'FRAME-003');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('invented image data');
  });

  it('fails a stretched image, which would give Phase 6 the wrong intrinsics', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, maxAspectError: 0.19 }), 'FRAME-003').verdict).toBe(Verdict.FAIL);
  });

  it('reports a spontaneous degrade differently from a stress-induced one', () => {
    const s = healthyStats();
    const spontaneous = verdictOf(ctxWith({ ...s, spontaneousDegrade: true }), 'FRAME-003');
    expect(spontaneous.verdict).toBe(Verdict.PASS);
    expect(spontaneous.reason).toContain('could not hold its tier');
    expect(verdictOf(ctxWith(s), 'FRAME-003').reason).toContain('stimulus');
  });
});

describe('FRAME-004 — FPS adaptation', () => {
  it('is PENDING while load is still being injected', () => {
    const s = healthyStats();
    const r = verdictOf(ctxWith({ ...s, stressPasses: 24 }), 'FRAME-004');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('recovery');
  });

  it('is PENDING when the target rate has never moved', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, decisions: [] }), 'FRAME-004').verdict).toBe(Verdict.PENDING);
  });

  it('fails a downward step that did not reduce worker latency', () => {
    const s = healthyStats();
    const ineffective = {
      ...s,
      decisionOutcomes: s.decisionOutcomes.map((o) =>
        o.decisionIndex === 1 ? { ...o, afterMedianWorkerMs: 71.0 } : o,
      ),
    };
    const r = verdictOf(ctxWith(ineffective), 'FRAME-004');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('did not help');
  });

  it('fails a change with no measurement behind it', () => {
    const s = healthyStats();
    const asserted = {
      ...s,
      decisions: s.decisions.map((d, i) => (i === 0 ? { ...d, medianWorkerMs: 0, reason: '' } : d)),
    };
    const r = verdictOf(ctxWith(asserted), 'FRAME-004');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('no measurement');
  });

  it('fails a target below the 15 fps floor', () => {
    const s = healthyStats();
    const belowFloor = {
      ...s,
      decisions: s.decisions.map((d, i) => (i === 1 ? { ...d, toTargetFps: 10 } : d)),
    };
    const r = verdictOf(ctxWith(belowFloor), 'FRAME-004');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('below the 15 fps');
  });

  it('fails oscillation', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, maxDecisionsPer10s: 9 }), 'FRAME-004').verdict).toBe(Verdict.FAIL);
  });

  it('is PENDING while recovery has not happened yet, rather than failing early', () => {
    const s = healthyStats();
    const noRecovery = { ...s, decisions: s.decisions.slice(0, 2), tierStep: 3 };
    const r = verdictOf(ctxWith(noRecovery), 'FRAME-004');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('recovered');
  });
});

describe('FRAME-005 and FRAME-006 — advisory', () => {
  it('FRAME-005 is PENDING before there are enough samples for a percentile', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, uiCostMs: series(0.6, 1.0, 12) }), 'FRAME-005').verdict).toBe(
      Verdict.PENDING,
    );
  });

  it('FRAME-005 fails a UI thread over the 16.7 ms budget', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, uiCostMs: series(19.5, 24.0) }), 'FRAME-005').verdict).toBe(
      Verdict.FAIL,
    );
  });

  it('FRAME-006 is PENDING when the device was never rotated', () => {
    const s = healthyStats();
    const noRotation = { ...s, sourceSizesObserved: ['1280x720'], procMatchedAfterSourceChange: null };
    expect(verdictOf(ctxWith(noRotation), 'FRAME-006').verdict).toBe(Verdict.PENDING);
  });

  it('FRAME-006 fails a processing size derived from a stale source geometry', () => {
    const s = healthyStats();
    const stale = { ...s, procMatchedAfterSourceChange: false };
    const r = verdictOf(ctxWith(stale), 'FRAME-006');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('old geometry');
  });

  it('FRAME-006 fails frame records that carry no geometry of their own', () => {
    const s = healthyStats();
    const shared = {
      ...s,
      recentFrames: s.recentFrames.map((f) => ({ ...f, sourceWidth: 0, sourceHeight: 0 })),
    };
    expect(verdictOf(ctxWith(shared), 'FRAME-006').verdict).toBe(Verdict.FAIL);
  });
});
