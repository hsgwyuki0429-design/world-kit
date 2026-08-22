/**
 * The Phase 3 harness, tested against runs that did not happen.
 *
 * `runPhase3Tests` reads a `TrackingStats` and nothing else, so the suite can be shown a run
 * that never detected, one that worked, and — the case that matters — one whose detector was
 * emitting coordinates unrelated to the image while every count looked healthy. FEAT-001 is
 * the check that the points are real, and a check that has never been shown to fail is not a
 * check.
 */

import { describe, expect, it } from 'vitest';
import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import { runPhase3Tests, PHASE3_SPECS } from '../../src/testkit/Phase3Tests';
import type { Phase3Context } from '../../src/testkit/Phase3Tests';
import type { TrackingStats } from '../../src/tracking/trackingStats';
import type { FeatureRecordSample } from '../../src/tracking/trackingMessages';

function record(id: number, x: number, y: number, strength: number, quality: number): FeatureRecordSample {
  return {
    id,
    x,
    y,
    x0: x * 2,
    y0: y * 2,
    cornerStrength: strength,
    age: 0,
    trackLength: 1,
    forwardBackwardError: null,
    reprojectionError: null,
    qualityScore: quality,
    cell: 0,
  };
}

/** A run that did everything Phase 3 asks for. Every other fixture is a mutation of this. */
function healthyStats(): TrackingStats {
  return {
    running: true,
    detections: 190,
    detectLevel: 1,
    detectWidth: 360,
    detectHeight: 640,

    count: 780,
    state: 'FEATURES_OK',
    quota: 17,
    maxCountSeen: 900,
    overMaxFrames: 0,
    quotaBreaches: 0,
    stateMismatches: 0,
    stateFrames: { FEATURES_OK: 150, LOW_FEATURE_COUNT: 30, TRACKING_DEGRADED: 10 },

    textureRich: { frames: 120, medianCount: 780, minCount: 640, maxCount: 900, medianGradient: 21.4 },
    texturePoor: { frames: 40, medianCount: 90, minCount: 12, maxCount: 180, medianGradient: 2.1 },
    textureAmbiguous: { frames: 30, medianCount: 410, minCount: 200, maxCount: 620, medianGradient: 6.1 },
    gradientHistogram: [
      { meanGradient: 1, frames: 20 },
      { meanGradient: 2, frames: 20 },
      { meanGradient: 6, frames: 30 },
      { meanGradient: 21, frames: 120 },
    ],
    meanGradient: 21.4,
    texture: 'TEXTURE_RICH',

    contrastSamples: 34,
    // The detector out-textures a random position 96% of the time; chance is 50%.
    medianAboveChance: 0.964,

    grid: {
      samples: 34,
      totalSamples: 40,
      medianGridded: 0.055,
      medianUngridded: 0.19,
      medianCellGain: 6,
    },
    occupiedCells: 46,
    maxCellShare: 0.0218,

    refills: [
      {
        at: 1000, urgency: 'REFILL' as const, countBefore: 430, countAfter: 690,
        candidatesBefore: 900, candidatesAfter: 2400, exhausted: false,
        texture: 'TEXTURE_RICH', stateBefore: 'FEATURES_OK', stateAfter: 'FEATURES_OK',
        detectMs: 9.1,
      },
      {
        at: 2000, urgency: 'EMERGENCY' as const, countBefore: 44, countAfter: 44,
        candidatesBefore: 51, candidatesAfter: 51, exhausted: true,
        texture: 'TEXTURE_POOR', stateBefore: 'TRACKING_DEGRADED', stateAfter: 'TRACKING_DEGRADED',
        detectMs: 8.4,
      },
    ],

    meanDetectCostMs: 5.4,
    level0Calibration: { width: 720, height: 1280, detectMs: 22.6, features: 800 },

    recordSamples: [
      record(0, 120, 300, 88_400, 1),
      record(1, 210, 118, 42_100, 0.48),
      record(2, 44, 590, 12_900, 0.15),
    ],
    lastResult: null,
  };
}

function ctxWith(stats: TrackingStats, over: Partial<Phase3Context> = {}): Phase3Context {
  return {
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    detectionEverRan: true,
    stats,
    ...over,
  };
}

function verdictOf(ctx: Phase3Context, id: string): { verdict: Verdict; reason: string } {
  const r = runPhase3Tests(ctx).find((x) => x.spec.id === id);
  if (!r) throw new Error(`no such test: ${id}`);
  return { verdict: r.verdict, reason: r.reason };
}

describe('Phase 3 test specs', () => {
  it('declares the four tests §64 names as REQUIRED', () => {
    const required = PHASE3_SPECS.filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['FEAT-001', 'FEAT-002', 'FEAT-003', 'FEAT-004']);
  });

  it('every spec states its criteria and its failure condition before it runs (§29)', () => {
    for (const s of PHASE3_SPECS) {
      expect(s.input, s.id).toBeTruthy();
      expect(s.expected, s.id).toBeTruthy();
      expect(s.passCriteria, s.id).toBeTruthy();
      expect(s.failureCondition, s.id).toBeTruthy();
    }
  });
});

describe('a run where detection never happened', () => {
  const empty: TrackingStats = {
    ...healthyStats(),
    running: false,
    detections: 0,
    count: 0,
    textureRich: { frames: 0, medianCount: 0, minCount: 0, maxCount: 0, medianGradient: 0 },
    texturePoor: { frames: 0, medianCount: 0, minCount: 0, maxCount: 0, medianGradient: 0 },
    textureAmbiguous: { frames: 0, medianCount: 0, minCount: 0, maxCount: 0, medianGradient: 0 },
    contrastSamples: 0,
    medianAboveChance: -1,
    grid: { samples: 0, totalSamples: 0, medianGridded: -1, medianUngridded: -1, medianCellGain: 0 },
    refills: [],
    meanDetectCostMs: -1,
    level0Calibration: null,
    recordSamples: [],
    stateFrames: {},
  };
  const results = runPhase3Tests(
    ctxWith(empty, { detectionEverRan: false, pipelineEverStarted: false, cameraState: CameraState.IDLE }),
  );

  it('is PENDING everywhere, never PASS and never FAIL', () => {
    for (const r of results) {
      expect(r.verdict, `${r.spec.id}: ${r.reason}`).toBe(Verdict.PENDING);
    }
  });
});

describe('a healthy device run', () => {
  const results = runPhase3Tests(ctxWith(healthyStats()));

  it('passes every test', () => {
    for (const r of results) {
      expect(r.verdict, `${r.spec.id}: ${r.reason}`).toBe(Verdict.PASS);
    }
  });

  it('records the measurements behind the verdicts, not just the verdicts', () => {
    const f1 = results.find((r) => r.spec.id === 'FEAT-001');
    expect(Number(f1?.metrics['medianAboveChance'])).toBeGreaterThan(0.9);
    const f5 = results.find((r) => r.spec.id === 'FEAT-005');
    // The level-0 calibration answers the question the plan chose level 1 on.
    expect(f5?.metrics['level0WouldHaveFitBudget']).toBe(false);
  });
});

describe('FEAT-001 — the points are on real image structure', () => {
  it('fails a detector whose positions are unrelated to the image', () => {
    // Every count healthy, the grid working, the cost inside budget — and the positions
    // score at chance. This is the fabricated detector §80 prohibits, and nothing else in
    // the run would have caught it.
    const s = healthyStats();
    const fabricated = { ...s, medianAboveChance: 0.516 };
    const r = verdictOf(ctxWith(fabricated), 'FEAT-001');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('not on image structure');
  });

  it('is PENDING before enough textured frames to judge', () => {
    const s = healthyStats();
    const early = {
      ...s,
      textureRich: { ...s.textureRich, frames: 4 },
    };
    expect(verdictOf(ctxWith(early), 'FEAT-001').verdict).toBe(Verdict.PENDING);
  });

  it('is PENDING before enough contrast samples', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, contrastSamples: 3 }), 'FEAT-001').verdict).toBe(Verdict.PENDING);
  });

  it('fails a count that never reaches §11 minimum on a textured scene', () => {
    const s = healthyStats();
    const thin = { ...s, textureRich: { ...s.textureRich, medianCount: 90 } };
    expect(verdictOf(ctxWith(thin), 'FEAT-001').verdict).toBe(Verdict.FAIL);
  });

  it('fails a count above §11 maximum', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, maxCountSeen: 1400, overMaxFrames: 3 }), 'FEAT-001').verdict).toBe(
      Verdict.FAIL,
    );
  });
});

describe('FEAT-002 — the points vanish when the structure does', () => {
  it('fails a count that holds up on a blank wall', () => {
    // The other side of FEAT-001: output that does not depend on the image.
    const s = healthyStats();
    const unmoved = { ...s, texturePoor: { ...s.texturePoor, medianCount: 720, minCount: 600, maxCount: 810 } };
    const r = verdictOf(ctxWith(unmoved), 'FEAT-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('not tracking the image');
  });

  it('fails when the engine never reported LOW FEATURE COUNT despite the count falling', () => {
    const s = healthyStats();
    const silent = { ...s, stateFrames: { FEATURES_OK: 190 } };
    const r = verdictOf(ctxWith(silent), 'FEAT-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('LOW FEATURE COUNT');
  });

  it('fails when the reported state disagrees with the reported count (Rule 002)', () => {
    const s = healthyStats();
    const r = verdictOf(ctxWith({ ...s, stateMismatches: 7 }), 'FEAT-002');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('disagreed');
  });

  it('is PENDING without blank frames, and without textured ones to compare against', () => {
    const s = healthyStats();
    expect(
      verdictOf(ctxWith({ ...s, texturePoor: { ...s.texturePoor, frames: 2 } }), 'FEAT-002').verdict,
    ).toBe(Verdict.PENDING);
    expect(
      verdictOf(ctxWith({ ...s, textureRich: { ...s.textureRich, frames: 2 } }), 'FEAT-002').verdict,
    ).toBe(Verdict.PENDING);
  });
});

describe('FEAT-003 — the grid does something', () => {
  it('fails a cell over quota', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, quotaBreaches: 4 }), 'FEAT-003').verdict).toBe(Verdict.FAIL);
  });

  it('fails a grid no better than its own ungridded control', () => {
    const s = healthyStats();
    const useless = { ...s, grid: { ...s.grid, medianGridded: 0.2, medianUngridded: 0.19 } };
    const r = verdictOf(ctxWith(useless), 'FEAT-003');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('did not reduce clustering');
  });

  it('is PENDING before enough paired comparisons', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, grid: { ...s.grid, samples: 3 } }), 'FEAT-003').verdict).toBe(
      Verdict.PENDING,
    );
  });

  it('is PENDING, not FAIL, when the scene was too sparse for the quota to bind', () => {
    // The desktop leg's finding: 34 features across 48 cells, no cell near a quota of 17,
    // so the gridded and ungridded selections are identical. That is a sparse scene, not a
    // broken grid, and reporting it as a failure would condemn a working mechanism.
    const s = healthyStats();
    const sparse = {
      ...s,
      grid: { samples: 0, totalSamples: 55, medianGridded: -1, medianUngridded: -1, medianCellGain: 0 },
    };
    const r = verdictOf(ctxWith(sparse), 'FEAT-003');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('too sparse');
  });
});

describe('FEAT-004 — regeneration', () => {
  it('is PENDING when the population never fell far enough to need topping up', () => {
    const s = healthyStats();
    const r = verdictOf(ctxWith({ ...s, refills: [] }), 'FEAT-004');
    expect(r.verdict).toBe(Verdict.PENDING);
    expect(r.reason).toContain('never fell');
  });

  it('fails a refill that raised nothing on a frame that had candidates', () => {
    const s = healthyStats();
    const broken = {
      ...s,
      refills: [
        {
          ...s.refills[0]!,
          countBefore: 300,
          countAfter: 300,
          candidatesAfter: 4000,
          exhausted: false,
        },
      ],
    };
    const r = verdictOf(ctxWith(broken), 'FEAT-004');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('raised nothing');
  });

  it('accepts a refill that raised nothing on a frame with nothing left to give', () => {
    const s = healthyStats();
    const exhausted = { ...s, refills: [s.refills[1]!] };
    expect(verdictOf(ctxWith(exhausted), 'FEAT-004').verdict).toBe(Verdict.PASS);
  });

  it('fails a count above the §11 maximum after a refill', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, overMaxFrames: 2 }), 'FEAT-004').verdict).toBe(Verdict.FAIL);
  });

  it('fails an emergency refill recorded above the level that defines one', () => {
    const s = healthyStats();
    const mislabelled = {
      ...s,
      refills: [{ ...s.refills[1]!, urgency: 'EMERGENCY' as const, countBefore: 450 }],
    };
    expect(verdictOf(ctxWith(mislabelled), 'FEAT-004').verdict).toBe(Verdict.FAIL);
  });
});

describe('FEAT-005 and FEAT-006 — advisory', () => {
  it('FEAT-005 is PENDING before enough detections to mean anything', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, detections: 4 }), 'FEAT-005').verdict).toBe(Verdict.PENDING);
  });

  it('FEAT-005 fails detection over the §H budget', () => {
    const s = healthyStats();
    expect(verdictOf(ctxWith({ ...s, meanDetectCostMs: 19.2 }), 'FEAT-005').verdict).toBe(Verdict.FAIL);
  });

  it('FEAT-006 fails a zero where a measurement does not exist yet', () => {
    // The defect this test exists for: an error term filled in with the best possible value
    // before anything has measured it (§80 Fake Confidence).
    const s = healthyStats();
    const invented = {
      ...s,
      recordSamples: [{ ...s.recordSamples[0]!, forwardBackwardError: 0 }],
    };
    const r = verdictOf(ctxWith(invented), 'FEAT-006');
    expect(r.verdict).toBe(Verdict.FAIL);
    expect(r.reason).toContain('invented');
  });

  it('FEAT-006 fails a reprojection error before Phase 6 exists', () => {
    const s = healthyStats();
    const invented = {
      ...s,
      recordSamples: [{ ...s.recordSamples[0]!, reprojectionError: 0.4 }],
    };
    expect(verdictOf(ctxWith(invented), 'FEAT-006').verdict).toBe(Verdict.FAIL);
  });

  it('FEAT-006 fails a position outside the frame', () => {
    const s = healthyStats();
    const outside = { ...s, recordSamples: [{ ...s.recordSamples[0]!, x: 5000 }] };
    expect(verdictOf(ctxWith(outside), 'FEAT-006').verdict).toBe(Verdict.FAIL);
  });

  it('FEAT-006 fails duplicate ids within a frame', () => {
    const s = healthyStats();
    const dupes = {
      ...s,
      recordSamples: [s.recordSamples[0]!, { ...s.recordSamples[1]!, id: s.recordSamples[0]!.id }],
    };
    expect(verdictOf(ctxWith(dupes), 'FEAT-006').verdict).toBe(Verdict.FAIL);
  });
});
