/**
 * Phase 4, driven end to end in Node — and the one test the whole phase is built around.
 *
 * `FlowStage` is the exact code the tracking worker runs on a Phase 4 frame. These tests
 * drive it over a synthetic run whose motion is known by construction, fold the results into
 * the same `FlowSession` the app uses, and evaluate the same `Phase4Tests` suite the screen
 * and the evidence read. Nothing here is a reimplementation of the pipeline; substituting a
 * tracker is the only thing that changes between the two runs.
 *
 * ## The tracker that returns its input
 *
 * It is the most dangerous failure this phase can have, because it looks *better* than a
 * working tracker on every statistic computed from the tracker's own output:
 *
 *  - every point survives, so the count and the survival are perfect;
 *  - the forward/backward round trip agrees with itself, so §13 passes at its best band;
 *  - `age` and `trackLength` climb honestly, so the metadata test is satisfied;
 *  - and on a static scene it is genuinely indistinguishable from a working tracker.
 *
 * The run below moves the image by a known amount every frame, and the fake still reports
 * zero displacement. FLOW-001 passes it. FLOW-002 does not — and FLOW-002 is the only test
 * that can, because it is the only one that compares the tracker against a measurement of the
 * image made without the tracker.
 */

import { describe, expect, it } from 'vitest';
import { CameraState } from '../../src/capture/CameraSource';
import { Verdict } from '../../src/core/types';
import { FlowStage } from '../../src/tracking/FlowStage';
import { FlowSession } from '../../src/tracking/FlowSession';
import { FlowTracker } from '../../src/tracking/FlowTracker';
import { TrackStatus } from '../../src/tracking/LucasKanade';
import type { ImagePlane, TrackedPoint } from '../../src/tracking/LucasKanade';
import { FrameMotion } from '../../src/tracking/SceneShift';
import { TrackingState, deriveTrackingState } from '../../src/tracking/trackingState';
import { runPhase4Tests } from '../../src/testkit/Phase4Tests';
import type { TrackingResult } from '../../src/tracking/trackingMessages';
import { halveInto } from '../../src/pipeline/pyramid';
import type { FlowStats } from '../../src/tracking/flowStats';

const W = 320;
const H = 240;
/** Level-0 pixels of image motion per frame. Inside SLOW, and well over the static floor. */
const SHIFT_PER_FRAME = 4;
const FRAMES = 40;

/**
 * The scene, as a sum of incommensurate sinusoids across the pyramid's whole range of scales.
 *
 * Low frequencies so the coarse pyramid levels still have structure to track by, and enough
 * fine detail that Shi-Tomasi finds a population worth talking about — around a hundred
 * corners at level 1 here. A smoother version yielded twenty, which is a regime §11's
 * thresholds were never written for and which would have made this whole file a test of a
 * sparse edge case rather than of the tracker.
 */
function texture(x: number, y: number): number {
  const v =
    128 +
    40 * Math.sin(x * 0.021 + 0.4) * Math.cos(y * 0.017 - 0.2) +
    30 * Math.cos(x * 0.043 + y * 0.037) +
    26 * Math.sin(x * 0.083 - y * 0.061 + 1.1) +
    22 * Math.sin(x * 0.19 + y * 0.15) +
    16 * Math.cos(x * 0.27 - y * 0.23 + 0.6) +
    10 * Math.sin(x * 0.41 + y * 0.37 + 2.1);
  return Math.max(0, Math.min(255, v));
}

interface Frame {
  readonly levels: ImagePlane[];
  readonly meanLuma: number;
  readonly topLevelMad: number;
}

let previousTop: Uint8Array | null = null;

/** The same three-level pyramid the worker builds, from a texture displaced by (dx, dy). */
function makeFrame(dx: number, dy: number, dark = false): Frame {
  const base = new Uint8Array(W * H);
  let sum = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = dark ? 4 : Math.round(texture(x - dx, y - dy));
      base[y * W + x] = v;
      sum += v;
    }
  }
  const levels: ImagePlane[] = [{ data: base, width: W, height: H }];
  for (let i = 1; i < 3; i++) {
    const src = levels[i - 1];
    if (!src) break;
    const w = Math.max(1, src.width >> 1);
    const h = Math.max(1, src.height >> 1);
    const data = new Uint8Array(w * h);
    halveInto(src.data, src.width, src.height, data, w, h);
    levels.push({ data, width: w, height: h });
  }
  const top = levels[levels.length - 1];
  let mad = -1;
  if (top && previousTop && previousTop.length === top.data.length) {
    let diff = 0;
    for (let i = 0; i < top.data.length; i++) {
      diff += Math.abs((top.data[i] ?? 0) - (previousTop[i] ?? 0));
    }
    mad = diff / top.data.length;
  }
  if (top) previousTop = new Uint8Array(top.data);
  return { levels, meanLuma: sum / (W * H), topLevelMad: mad };
}

/**
 * A tracker that hands back exactly the points it was given.
 *
 * Reported as `TRACKED`, with a zero residual, because that is what the dangerous version of
 * this bug looks like — a solver that quietly short-circuits, not one that admits it.
 */
const identitySolve = (
  _previous: readonly ImagePlane[],
  _next: readonly ImagePlane[],
  points: Float64Array,
): TrackedPoint[] => {
  const out: TrackedPoint[] = [];
  for (let i = 0; i < points.length; i += 2) {
    out.push({
      status: TrackStatus.TRACKED,
      x: points[i] ?? 0,
      y: points[i + 1] ?? 0,
      iterations: 1,
      residual: 0,
    });
  }
  return out;
};

interface RunOutcome {
  readonly stats: FlowStats;
  readonly results: ReturnType<typeof runPhase4Tests>;
  readonly frames: TrackingResult[];
}

/**
 * Drive a whole Phase 4 run through the real stage and the real session.
 *
 * `motion(i)` returns the level-0 displacement applied to frame `i`, so the caller decides
 * what the image does and the harness never tells the tracker what to expect.
 */
function run(
  motion: (frame: number) => { dx: number; dy: number; dark?: boolean },
  forwardSolve?: typeof identitySolve,
  frames = FRAMES,
): RunOutcome {
  previousTop = null;
  const stage = new FlowStage(undefined, undefined, forwardSolve);
  const session = new FlowSession();
  const produced: TrackingResult[] = [];
  let x = 0;
  let y = 0;

  for (let i = 0; i < frames; i++) {
    const m = motion(i);
    x += m.dx;
    y += m.dy;
    const frame = makeFrame(x, y, m.dark);
    const result = stage.process({
      levels: frame.levels,
      detectLevel: 1,
      target: 800,
      recordSamples: 12,
      meanLuma: frame.meanLuma,
      topLevelMad: frame.topLevelMad,
    });
    produced.push(result);
    // A 33 ms clock, so the occlusion timings in FLOW-005 are measured against a plausible
    // frame interval rather than against however fast the test machine happens to run.
    session.record(result, i * 33);
  }

  const stats = session.stats(true);
  return {
    stats,
    results: runPhase4Tests({
      cameraState: CameraState.LIVE,
      pipelineEverStarted: true,
      trackingEverRan: true,
      stats,
    }),
    frames: produced,
  };
}

function verdictOf(results: ReturnType<typeof runPhase4Tests>, id: string): Verdict {
  return results.find((r) => r.spec.id === id)?.verdict ?? Verdict.PENDING;
}

function reasonOf(results: ReturnType<typeof runPhase4Tests>, id: string): string {
  return results.find((r) => r.spec.id === id)?.reason ?? '';
}

/* ========================================================================== */

describe('a working tracker on a slowly panning scene', () => {
  const outcome = run(() => ({ dx: SHIFT_PER_FRAME, dy: 0 }));

  it('measures the scene as SLOW from the image, not from the harness', () => {
    expect(outcome.stats.slowFrames.frames).toBeGreaterThanOrEqual(15);
    expect(outcome.stats.staticFrames.frames).toBe(0);
  });

  it('follows the points by the amount the image actually moved', () => {
    expect(outcome.stats.medianTrackedDisplacementPx).toBeGreaterThan(SHIFT_PER_FRAME * 0.8);
    expect(outcome.stats.medianMeasuredShiftPx).toBe(SHIFT_PER_FRAME);
    expect(outcome.stats.medianShiftDisagreementPx).toBeLessThanOrEqual(2.0);
  });

  it('passes FLOW-002 — the phase’s anti-fake gate', () => {
    expect(verdictOf(outcome.results, 'FLOW-002')).toBe(Verdict.PASS);
  });

  it('keeps its population, with §13 grading the round trips', () => {
    expect(outcome.stats.slowFrames.medianSurvival).toBeGreaterThanOrEqual(0.7);
    expect(outcome.stats.medianFbErrorPx).toBeGreaterThanOrEqual(0);
    expect(outcome.stats.medianFbErrorPx).toBeLessThanOrEqual(1.5);
    expect(outcome.stats.fbAcceptable).toBeGreaterThan(0);
  });

  it('accumulates a history: age and trackLength climb', () => {
    expect(outcome.stats.maxTrackLength).toBeGreaterThan(10);
    const last = outcome.frames[outcome.frames.length - 1];
    const withHistory = (last?.recordSamples ?? []).filter((f) => f.age > 0);
    expect(withHistory.length).toBeGreaterThan(0);
    for (const f of withHistory) {
      expect(f.trackLength).toBeLessThanOrEqual(f.age + 1);
      expect(f.forwardBackwardError).not.toBeNull();
      // Phase 6 has not run. A number here would be invented (§80).
      expect(f.reprojectionError).toBeNull();
    }
    expect(verdictOf(outcome.results, 'FLOW-007')).toBe(Verdict.PASS);
  });

  it('never claims GOOD, and says which of §33’s conjuncts it cannot evaluate', () => {
    expect(outcome.stats.state).not.toBe(TrackingState.GOOD);
    expect(outcome.stats.goodBlockedBy.join(' ')).toContain('inlierRatio');
    expect(outcome.stats.goodBlockedBy.join(' ')).toContain('reprojectionError');
  });

  it('never reports a state that disagrees with its own measured inputs (Rule 002)', () => {
    expect(outcome.stats.stateMismatches).toBe(0);
  });
});

describe('a tracker that returns its input', () => {
  const fake = run(() => ({ dx: SHIFT_PER_FRAME, dy: 0 }), identitySolve);

  it('looks perfect on everything computed from its own output', () => {
    // This is the point. Each of these is a *pass* for the fake.
    expect(fake.stats.slowFrames.medianSurvival).toBe(1);
    expect(fake.stats.medianFbErrorPx).toBe(0);
    expect(fake.stats.fbRejected).toBe(0);
    expect(fake.stats.maxTrackLength).toBeGreaterThan(10);
  });

  it('reports zero displacement while the image demonstrably moved', () => {
    expect(fake.stats.medianTrackedDisplacementPx).toBe(0);
    expect(fake.stats.medianMeasuredShiftPx).toBe(SHIFT_PER_FRAME);
  });

  it('FAILS FLOW-002, and the reason names the disagreement', () => {
    expect(verdictOf(fake.results, 'FLOW-002')).toBe(Verdict.FAIL);
    const reason = reasonOf(fake.results, 'FLOW-002');
    expect(reason).toContain('independent search');
    expect(reason.toLowerCase()).toContain('did not move');
  });

  it('is NOT caught by §13’s forward/backward validation', () => {
    // Stated as a test so the limitation is recorded rather than assumed. §13 checks the
    // tracker against itself; it cannot see a tracker that agrees with itself perfectly.
    expect(fake.stats.medianFbErrorPx).toBeLessThanOrEqual(1.5);
    expect(fake.stats.fbAcceptable).toBeGreaterThan(0);
  });

  it('is NOT caught by the survival, the population or the metadata tests', () => {
    expect(verdictOf(fake.results, 'FLOW-007')).toBe(Verdict.PASS);
    expect(fake.stats.stateMismatches).toBe(0);
    expect(fake.stats.cumulativeTracked).toBeGreaterThan(0);
  });

  it('and so the phase as a whole does not pass', () => {
    const required = fake.results.filter((r) => r.spec.required);
    expect(required.some((r) => r.verdict === Verdict.FAIL)).toBe(true);
  });
});

describe('a still scene', () => {
  const still = run(() => ({ dx: 0, dy: 0 }));

  it('is measured STATIC from the image', () => {
    expect(still.stats.staticFrames.frames).toBeGreaterThanOrEqual(15);
  });

  it('passes FLOW-001 with the points holding still', () => {
    expect(still.stats.staticFrames.medianDisplacementPx).toBeLessThanOrEqual(1.0);
    expect(verdictOf(still.results, 'FLOW-001')).toBe(Verdict.PASS);
  });

  it('does not let FLOW-002 pass on a scene that never moved', () => {
    // Criterion 3 exists for exactly this: on a still scene the tracker and the search agree
    // trivially at zero, and agreement without motion says nothing about either.
    expect(verdictOf(still.results, 'FLOW-002')).not.toBe(Verdict.PASS);
  });

  it('cannot tell a working tracker from one returning its input, on its own', () => {
    const fakeStill = run(() => ({ dx: 0, dy: 0 }), identitySolve);
    expect(verdictOf(fakeStill.results, 'FLOW-001')).toBe(Verdict.PASS);
    // ...which is why the test plan says FLOW-001 is not accepted as a pass by itself.
    expect(verdictOf(fakeStill.results, 'FLOW-002')).not.toBe(Verdict.PASS);
  });
});

describe('a covered lens', () => {
  // Twenty frames of slow pan, then twelve dark ones, then the image comes back.
  const outcome = run(
    (i) => ({ dx: i >= 20 && i < 32 ? 0 : SHIFT_PER_FRAME, dy: 0, dark: i >= 20 && i < 32 }),
    undefined,
    46,
  );

  it('classifies the dark frames as OCCLUDED from the image alone', () => {
    expect(outcome.stats.occludedFrames.frames + outcome.stats.indeterminateFrames).toBeGreaterThan(0);
    const occludedResults = outcome.frames.filter((f) => f.flow?.frameMotion === FrameMotion.OCCLUDED);
    expect(occludedResults.length).toBeGreaterThanOrEqual(10);
  });

  it('reaches LOST while the lens is covered and leaves it afterwards', () => {
    expect(outcome.stats.stateFrames[TrackingState.LOST] ?? 0).toBeGreaterThan(0);
    const episode = outcome.stats.occlusions[0];
    expect(episode).toBeDefined();
    expect(episode?.msToLost).toBeGreaterThanOrEqual(0);
    expect(episode?.recovered).toBe(true);
  });

  it('counts every occluded frame, not only the ones that had points to lose', () => {
    // The device run of 2026-08-22 recorded a 679-frame occlusion as *four* frames in the
    // class statistics, because a covered lens empties the population on its first frame and
    // every frame after it offers the tracker nothing. Four is the number of frames that
    // could be judged; it is not the length of the occlusion, and reporting only it read as
    // an occlusion that lasted four frames.
    const c = outcome.stats.occludedFrames;
    expect(c.framesSeen).toBeGreaterThan(c.frames);
    expect(c.framesSeen).toBeGreaterThanOrEqual(10);
  });

  it('says what the refill offered and what merge declined', () => {
    // Without these a population well below §11's minimum cannot be told apart from a
    // detector that found little — which is exactly the question the device run left open.
    expect(outcome.stats.medianDetectionOffered).toBeGreaterThan(0);
    // Split by reason: "already being tracked" is a healthy tracker, "outside the solver's
    // reach" is a border artefact, and one number could not tell them apart.
    expect(outcome.stats.medianDeclinedTooClose).toBeGreaterThan(0);
    expect(outcome.stats.medianDeclinedOutOfReach).toBeGreaterThanOrEqual(0);
    expect(
      outcome.stats.medianDeclinedTooClose + outcome.stats.medianDeclinedOutOfReach,
    ).toBeLessThanOrEqual(outcome.stats.medianDetectionOffered);
  });

  it('does not go LOST on a single bad frame — §33 requires three in a row', () => {
    const states = outcome.frames.map((f) => f.flow?.state);
    const firstLost = states.indexOf(TrackingState.LOST);
    const firstFailure = outcome.frames.findIndex((f) => f.flow?.frameFailed === true);
    expect(firstFailure).toBeGreaterThanOrEqual(0);
    expect(firstLost).toBeGreaterThanOrEqual(firstFailure + 2);
  });
});

describe('the tracker itself', () => {
  it('drops a point that failed to track rather than returning it where it was', () => {
    const tracker = new FlowTracker();
    const flat: ImagePlane[] = [
      { data: new Uint8Array(64 * 64).fill(100), width: 64, height: 64 },
      { data: new Uint8Array(32 * 32).fill(100), width: 32, height: 32 },
      { data: new Uint8Array(16 * 16).fill(100), width: 16, height: 16 },
    ];
    tracker.step(flat);
    tracker.merge(
      [
        {
          id: 0, x: 32, y: 32, x0: 32, y0: 32, cornerStrength: 10, age: 0, trackLength: 1,
          forwardBackwardError: null, reprojectionError: null, qualityScore: 1, cell: 0,
        },
      ],
      8,
      64,
      64,
      1,
    );
    expect(tracker.getPopulation().length).toBe(1);
    const step = tracker.step(flat);
    expect(step.offered).toBe(1);
    expect(step.tracked).toBe(0);
    expect(tracker.getPopulation().length).toBe(0);
  });

  it('does not fall back to READY when the frame geometry changes mid-run', () => {
    // The defect the Phase 4 leg caught: clearing `everTracked` on a tier step put §33's state
    // back to READY in the middle of a run and restarted the consecutive-failure counter with
    // it, so an occlusion that spanned a tier step never reached LOST. A geometry change is a
    // discontinuity with a known cause — not a tracking failure, and not a fresh start.
    const tracker = new FlowTracker();
    const big: ImagePlane[] = [
      { data: new Uint8Array(64 * 64), width: 64, height: 64 },
      { data: new Uint8Array(32 * 32), width: 32, height: 32 },
    ];
    const small: ImagePlane[] = [
      { data: new Uint8Array(32 * 32), width: 32, height: 32 },
      { data: new Uint8Array(16 * 16), width: 16, height: 16 },
    ];
    tracker.step(big);
    tracker.merge(
      [
        {
          id: 0, x: 20, y: 20, x0: 20, y0: 20, cornerStrength: 5, age: 0, trackLength: 1,
          forwardBackwardError: null, reprojectionError: null, qualityScore: 1, cell: 0,
        },
      ],
      4, 64, 64, 1,
    );
    // A frame that tracks (and loses the point, on a flat image) makes `everTracked` true.
    tracker.step(big);
    expect(tracker.measurement().everTracked).toBe(true);

    const step = tracker.step(small);
    expect(step.geometryChanges).toBe(1);
    expect(step.frameFailed).toBe(false);
    expect(step.consecutiveFailedFrames).toBe(0);
    // Still true: this run has tracked. The state is DEGRADED on an empty population, not
    // READY, which would say nothing had started.
    expect(tracker.measurement().everTracked).toBe(true);
    expect(deriveTrackingState(tracker.measurement()).state).toBe(TrackingState.DEGRADED);
  });

  it('forgets the population when the frame geometry changes (§H.0)', () => {
    const tracker = new FlowTracker();
    const big: ImagePlane[] = [{ data: new Uint8Array(64 * 64), width: 64, height: 64 }];
    const small: ImagePlane[] = [{ data: new Uint8Array(32 * 32), width: 32, height: 32 }];
    tracker.step(big);
    tracker.merge(
      [
        {
          id: 0, x: 20, y: 20, x0: 20, y0: 20, cornerStrength: 5, age: 0, trackLength: 1,
          forwardBackwardError: null, reprojectionError: null, qualityScore: 1, cell: 0,
        },
      ],
      4, 64, 64, 1,
    );
    expect(tracker.getPopulation().length).toBe(1);
    // A rotation swaps the frame dimensions mid-run (measured in Phase 1, recorded in §H.0),
    // and a level-0 position from the old geometry means nothing in the new one.
    tracker.step(small);
    expect(tracker.getPopulation().length).toBe(0);
  });
});

describe('§33’s state function', () => {
  const base = {
    everTracked: true,
    trackedCount: 400,
    totalCount: 500,
    consecutiveFailedFrames: 0,
    inlierRatio: null,
    reprojectionError: null,
  };

  it('is READY before any frame pair has been tracked', () => {
    expect(deriveTrackingState({ ...base, everTracked: false }).state).toBe(TrackingState.READY);
  });

  it('cannot reach GOOD in Phase 4, and names the missing terms', () => {
    const d = deriveTrackingState(base);
    expect(d.state).toBe(TrackingState.TRACKING);
    expect(d.goodBlockedBy).toHaveLength(2);
  });

  it('reaches GOOD once Phase 5 and Phase 6 supply their terms', () => {
    // Not reachable today; asserted so the condition is known to be a real conjunction rather
    // than a branch that was quietly deleted.
    const d = deriveTrackingState({ ...base, inlierRatio: 0.62, reprojectionError: 1.4 });
    expect(d.state).toBe(TrackingState.GOOD);
    expect(d.goodBlockedBy).toHaveLength(0);
  });

  it('is DEGRADED below §11’s threshold on the tracked count, not the total', () => {
    // The distinction the whole phase turns on: a refill can hold `totalCount` at target
    // while the tracker keeps nothing.
    const d = deriveTrackingState({ ...base, trackedCount: 40, totalCount: 800 });
    expect(d.state).toBe(TrackingState.DEGRADED);
  });

  it('needs three consecutive failed frames to reach LOST', () => {
    expect(deriveTrackingState({ ...base, consecutiveFailedFrames: 2 }).state).not.toBe(
      TrackingState.LOST,
    );
    expect(deriveTrackingState({ ...base, consecutiveFailedFrames: 3 }).state).toBe(
      TrackingState.LOST,
    );
  });
});
