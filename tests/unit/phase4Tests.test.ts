/**
 * The Phase 4 harness, tested against runs that did not happen.
 *
 * `runPhase4Tests` reads a `FlowStats` and nothing else, so the suite can be shown a run that
 * never tracked, one that worked, and — the cases that matter — the several distinct ways a
 * Phase 4 run can be wrong while every count on the screen looks healthy. A check that has
 * never been shown to fail is not a check.
 *
 * `flowTracker.test.ts` is the other half of this: it drives the real stage with a real
 * substituted solver and shows the same verdicts arising from actual pixels. This file
 * covers the branches a synthetic run cannot reach — an absent gyroscope, an occlusion that
 * never recovers, a fast-motion segment whose survival did not budge.
 */

import { describe, expect, it } from 'vitest';
import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import { runPhase4Tests, PHASE4_SPECS } from '../../src/testkit/Phase4Tests';
import type { Phase4Context } from '../../src/testkit/Phase4Tests';
import type { FlowStats, MotionClassStats } from '../../src/tracking/flowStats';
import type { FeatureRecordSample } from '../../src/tracking/trackingMessages';
import { TrackingState } from '../../src/tracking/trackingState';

function cls(over: Partial<MotionClassStats> = {}): MotionClassStats {
  return {
    frames: 40,
    framesSeen: 40,
    medianSurvival: 0.94,
    medianDisplacementPx: 5,
    medianFbErrorPx: 0.4,
    medianTracked: 420,
    medianCellSpread: 0.6,
    medianRejectFraction: 0.02,
    lostFrames: 0,
    degradedFrames: 0,
    ...over,
  };
}

function record(id: number, age: number): FeatureRecordSample {
  return {
    id,
    x: 100,
    y: 80,
    x0: 200,
    y0: 160,
    cornerStrength: 4200,
    age,
    trackLength: age + 1,
    // §13's error exists exactly where a round trip was measured, and nowhere else.
    forwardBackwardError: age > 0 ? 0.42 : null,
    // Phase 6 has not run.
    reprojectionError: null,
    qualityScore: 0.8,
    cell: 12,
  };
}

/** A run that did everything Phase 4 asks for. Every other fixture is a mutation of this. */
function healthyStats(): FlowStats {
  return {
    running: true,
    flowFrames: 260,
    trackedFrames: 250,

    tracked: 430,
    redetected: 60,
    total: 490,
    cumulativeTracked: 98_000,
    cumulativeRedetected: 12_000,
    maxTrackLength: 64,
    medianAge: 11,

    state: TrackingState.TRACKING,
    stateReason: '430 of 490 points carried from the previous frame',
    goodBlockedBy: [
      'inlierRatio — §14 geometric verification (Phase 5) has not been written',
      'reprojectionError — §15 pose (Phase 6) has not been written',
    ],
    stateFrames: { READY: 1, TRACKING: 210, DEGRADED: 34, LOST: 15 },
    stateMismatches: 0,
    consecutiveFailedFrames: 0,
    geometryChanges: 2,
    medianDetectionOffered: 180,
    medianDeclinedTooClose: 118,
    medianDeclinedOutOfReach: 2,

    medianFbErrorPx: 0.44,
    fbAcceptable: 92_000,
    fbReduced: 3_100,
    fbRejected: 2_400,

    staticFrames: cls({ frames: 60, medianSurvival: 0.97, medianDisplacementPx: 0.2, medianCellSpread: 0.1 }),
    slowFrames: cls({ frames: 90, medianSurvival: 0.88, medianDisplacementPx: 5.4 }),
    fastFrames: cls({
      frames: 40,
      medianSurvival: 0.31,
      medianDisplacementPx: 16,
      medianTracked: 60,
      medianRejectFraction: 0.28,
      degradedFrames: 25,
    }),
    occludedFrames: cls({
      frames: 22, medianSurvival: 0, medianDisplacementPx: -1, medianTracked: 0, lostFrames: 15,
    }),
    indeterminateFrames: 18,
    frameMotion: 'SLOW',
    lastSceneShift: {
      dx0: 5, dy0: 1, magnitude0: 5.1, residual: 3.2, medianResidual: 9.4, confidence: 2.94,
      zeroShiftResidual: 11.1, samples: 3600, candidates: 289, levelScale: 4, width: 180, height: 320,
    },

    shiftChecks: [],
    shiftCheckCount: 74,
    medianShiftDisagreementPx: 0.9,
    medianMeasuredShiftPx: 5.2,
    medianTrackedDisplacementPx: 5.5,
    shiftAgreementRate: 0.95,

    gyroAvailable: true,
    gyroReason: '',
    rotatingFrames: 38,
    medianRotationDeg: 11.2,
    medianSpreadRotating: 1.9,
    medianSpreadTranslating: 0.5,
    rotatingSurvival: 0.83,
    rotatingFbErrorPx: 0.62,

    occlusions: [
      { startedAt: 1000, frames: 22, msToLost: 132, survivedWithGoodFb: 0, recovered: true, recoveredAfterMs: 264 },
    ],

    meanFlowMs: 11.4,
    meanShiftMs: 1.2,
    meanTrackedPoints: 430,
    flowCostSamples: 260,

    recordSamples: [record(1, 12), record(2, 0), record(3, 40)],
    lastFlow: null,
  };
}

function ctx(stats: FlowStats, over: Partial<Phase4Context> = {}): Phase4Context {
  return {
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    trackingEverRan: true,
    stats,
    ...over,
  };
}

function verdict(stats: FlowStats, id: string, over: Partial<Phase4Context> = {}): Verdict {
  return runPhase4Tests(ctx(stats, over)).find((r) => r.spec.id === id)?.verdict ?? Verdict.PENDING;
}

function reason(stats: FlowStats, id: string): string {
  return runPhase4Tests(ctx(stats)).find((r) => r.spec.id === id)?.reason ?? '';
}

/* ========================================================================== */

describe('the suite itself', () => {
  it('covers §65’s five tests plus cost and metadata, with the five required', () => {
    expect(PHASE4_SPECS.map((s) => s.id)).toEqual([
      'FLOW-001', 'FLOW-002', 'FLOW-003', 'FLOW-004', 'FLOW-005', 'FLOW-006', 'FLOW-007',
    ]);
    const required = PHASE4_SPECS.filter((s) => s.required).map((s) => s.id);
    expect(required).toEqual(['FLOW-001', 'FLOW-002', 'FLOW-003', 'FLOW-004', 'FLOW-005']);
  });

  it('passes a healthy run', () => {
    const results = runPhase4Tests(ctx(healthyStats()));
    for (const r of results) {
      expect(`${r.spec.id}:${r.verdict}`).toBe(`${r.spec.id}:${Verdict.PASS}`);
    }
  });

  it('is PENDING throughout before anything has been tracked', () => {
    const results = runPhase4Tests(
      ctx({ ...healthyStats(), flowFrames: 0 }, { trackingEverRan: false }),
    );
    for (const r of results) expect(r.verdict).toBe(Verdict.PENDING);
  });
});

describe('FLOW-001 — 静止', () => {
  it('fails when the points drift on a scene the image says is still', () => {
    const s = healthyStats();
    expect(
      verdict({ ...s, staticFrames: cls({ frames: 60, medianDisplacementPx: 2.4 }) }, 'FLOW-001'),
    ).toBe(Verdict.FAIL);
  });

  it('fails when the population melts away with nothing degrading in the image', () => {
    const s = healthyStats();
    expect(
      verdict({ ...s, staticFrames: cls({ frames: 60, medianSurvival: 0.6, medianDisplacementPx: 0.2 }) }, 'FLOW-001'),
    ).toBe(Verdict.FAIL);
  });

  it('fails on a LOST frame while the scene was still and the count was healthy', () => {
    const s = healthyStats();
    expect(
      verdict(
        { ...s, staticFrames: cls({ frames: 60, medianDisplacementPx: 0.2, medianTracked: 420, lostFrames: 4 }) },
        'FLOW-001',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('is not tripped by the LOST frames FLOW-005 deliberately produces', () => {
    // The two criteria would contradict each other if LOST were counted run-wide: FLOW-005
    // requires an occlusion during which the state is LOST on purpose.
    const s = healthyStats();
    expect(s.occludedFrames.lostFrames).toBeGreaterThan(0);
    expect(verdict(s, 'FLOW-001')).toBe(Verdict.PASS);
  });

  it('waits rather than judging when the scene was never still', () => {
    const s = healthyStats();
    expect(verdict({ ...s, staticFrames: cls({ frames: 4 }) }, 'FLOW-001')).toBe(Verdict.PENDING);
  });
});

describe('FLOW-002 — the anti-fake gate', () => {
  it('fails a tracker reporting no motion while the image moved', () => {
    const s = healthyStats();
    const fake: FlowStats = {
      ...s,
      medianTrackedDisplacementPx: 0,
      medianShiftDisagreementPx: 5.2,
      shiftAgreementRate: 0,
      // Everything the fake computes from its own output still looks perfect.
      medianFbErrorPx: 0,
      fbRejected: 0,
      slowFrames: cls({ frames: 90, medianSurvival: 1, medianFbErrorPx: 0 }),
    };
    expect(verdict(fake, 'FLOW-002')).toBe(Verdict.FAIL);
    expect(reason(fake, 'FLOW-002')).toContain('independent search');
  });

  it('fails when the two instruments simply disagree, without either being zero', () => {
    const s = healthyStats();
    expect(
      verdict(
        { ...s, medianTrackedDisplacementPx: 12.0, medianMeasuredShiftPx: 5.2, medianShiftDisagreementPx: 6.8 },
        'FLOW-002',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('does not pass on a run that never moved', () => {
    // Criterion 3. A still run agrees with the search trivially, at zero, and that says
    // nothing about whether the tracker can follow anything.
    const s = healthyStats();
    expect(
      verdict(
        { ...s, medianTrackedDisplacementPx: 0.1, medianMeasuredShiftPx: 0.1, medianShiftDisagreementPx: 0 },
        'FLOW-002',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('waits for enough paired cross-checks rather than deciding on a handful', () => {
    const s = healthyStats();
    expect(verdict({ ...s, shiftCheckCount: 6 }, 'FLOW-002')).toBe(Verdict.PENDING);
  });

  it('scales its tolerance with the measured shift, as the plan derives', () => {
    const s = healthyStats();
    // 20 px of measured motion allows 7 px of disagreement (35 %); 6.5 is inside it.
    expect(
      verdict(
        { ...s, medianMeasuredShiftPx: 20, medianTrackedDisplacementPx: 13.5, medianShiftDisagreementPx: 6.5 },
        'FLOW-002',
      ),
    ).toBe(Verdict.PASS);
    // ...and at 5 px of motion the floor of 2 px applies, so the same 6.5 fails.
    expect(
      verdict({ ...s, medianMeasuredShiftPx: 5, medianShiftDisagreementPx: 6.5 }, 'FLOW-002'),
    ).toBe(Verdict.FAIL);
  });
});

describe('FLOW-003 — ゆっくり回転', () => {
  it('is PENDING with a reason when the gyroscope is absent, never FAIL', () => {
    const s = healthyStats();
    const noGyro: FlowStats = {
      ...s,
      gyroAvailable: false,
      gyroReason: 'the user did not grant motion access',
      rotatingFrames: 0,
    };
    expect(verdict(noGyro, 'FLOW-003')).toBe(Verdict.PENDING);
    expect(reason(noGyro, 'FLOW-003')).toContain('did not grant motion access');
  });

  it('fails a flow field no more varied under rotation than under translation', () => {
    const s = healthyStats();
    expect(
      verdict({ ...s, medianSpreadRotating: 0.4, medianSpreadTranslating: 0.5 }, 'FLOW-003'),
    ).toBe(Verdict.FAIL);
  });

  it('fails when the population does not survive a slow turn', () => {
    const s = healthyStats();
    expect(verdict({ ...s, rotatingSurvival: 0.4 }, 'FLOW-003')).toBe(Verdict.FAIL);
  });

  it('needs a translating control before it will judge the comparison', () => {
    const s = healthyStats();
    expect(verdict({ ...s, medianSpreadTranslating: -1 }, 'FLOW-003')).toBe(Verdict.PENDING);
  });
});

describe('FLOW-004 — 急速移動', () => {
  it('fails when survival is unchanged under motion the window cannot span', () => {
    const s = healthyStats();
    expect(
      verdict(
        { ...s, fastFrames: cls({ frames: 40, medianSurvival: 0.9, medianRejectFraction: 0.3, degradedFrames: 25 }) },
        'FLOW-004',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails when the lost points were not rejected by §13’s band', () => {
    const s = healthyStats();
    expect(
      verdict(
        { ...s, fastFrames: cls({ frames: 40, medianSurvival: 0.3, medianRejectFraction: 0.01, degradedFrames: 25 }) },
        'FLOW-004',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails when the count collapses and the state does not follow it', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          // The count collapsed under fast motion and the state stayed TRACKING throughout.
          fastFrames: cls({ frames: 40, medianSurvival: 0.2, medianTracked: 30, medianRejectFraction: 0.4 }),
          stateFrames: { TRACKING: 260 },
        },
        'FLOW-004',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails on any state that disagreed with its own measured inputs (Rule 002)', () => {
    const s = healthyStats();
    expect(verdict({ ...s, stateMismatches: 3 }, 'FLOW-004')).toBe(Verdict.FAIL);
  });
});

describe('FLOW-005 — Camera遮断', () => {
  it('fails when tracking is maintained through a covered lens', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          occlusions: [
            { startedAt: 1000, frames: 22, msToLost: -1, survivedWithGoodFb: 0, recovered: true, recoveredAfterMs: 100 },
          ],
        },
        'FLOW-005',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails when a track claims a good round trip across the dark frames', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          occlusions: [
            { startedAt: 1000, frames: 22, msToLost: 100, survivedWithGoodFb: 14, recovered: true, recoveredAfterMs: 90 },
          ],
        },
        'FLOW-005',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails when the state never comes back', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          occlusions: [
            { startedAt: 1000, frames: 22, msToLost: 100, survivedWithGoodFb: 0, recovered: false, recoveredAfterMs: -1 },
          ],
        },
        'FLOW-005',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('fails when LOST takes longer than a second', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          occlusions: [
            { startedAt: 1000, frames: 30, msToLost: 1400, survivedWithGoodFb: 0, recovered: true, recoveredAfterMs: 90 },
          ],
        },
        'FLOW-005',
      ),
    ).toBe(Verdict.FAIL);
  });

  it('waits for a long enough occlusion rather than judging a flicker', () => {
    const s = healthyStats();
    expect(
      verdict(
        {
          ...s,
          occlusions: [
            { startedAt: 1000, frames: 3, msToLost: -1, survivedWithGoodFb: 0, recovered: true, recoveredAfterMs: 30 },
          ],
        },
        'FLOW-005',
      ),
    ).toBe(Verdict.PENDING);
  });
});

describe('FLOW-006 — cost', () => {
  it('reports over budget as a FAIL, and is advisory so the phase survives it', () => {
    const s = healthyStats();
    expect(verdict({ ...s, meanFlowMs: 31.7 }, 'FLOW-006')).toBe(Verdict.FAIL);
    expect(PHASE4_SPECS.find((x) => x.id === 'FLOW-006')?.required).toBe(false);
  });

  it('records the point count the cost was measured at', () => {
    const results = runPhase4Tests(ctx(healthyStats()));
    const r = results.find((x) => x.spec.id === 'FLOW-006');
    expect(r?.observed).toContain('430 points');
    expect(r?.observed).toContain('21×21');
  });
});

describe('FLOW-007 — metadata honesty', () => {
  it('fails a fresh record that already carries a forward/backward error', () => {
    const s = healthyStats();
    const bad = { ...record(9, 0), forwardBackwardError: 0 };
    expect(verdict({ ...s, recordSamples: [bad] }, 'FLOW-007')).toBe(Verdict.FAIL);
  });

  it('fails a tracked record with no forward/backward error', () => {
    const s = healthyStats();
    const bad = { ...record(9, 5), forwardBackwardError: null };
    expect(verdict({ ...s, recordSamples: [bad] }, 'FLOW-007')).toBe(Verdict.FAIL);
  });

  it('fails a reprojection error, which is Phase 6’s to measure', () => {
    const s = healthyStats();
    const bad = { ...record(9, 5), reprojectionError: 1.2 };
    expect(verdict({ ...s, recordSamples: [bad] }, 'FLOW-007')).toBe(Verdict.FAIL);
  });

  it('fails a track claiming more frames than it has existed for', () => {
    const s = healthyStats();
    const bad = { ...record(9, 3), trackLength: 40 };
    expect(verdict({ ...s, recordSamples: [bad] }, 'FLOW-007')).toBe(Verdict.FAIL);
  });

  it('fails duplicate ids', () => {
    const s = healthyStats();
    expect(verdict({ ...s, recordSamples: [record(9, 3), record(9, 4)] }, 'FLOW-007')).toBe(
      Verdict.FAIL,
    );
  });
});
