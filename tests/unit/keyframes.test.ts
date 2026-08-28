/**
 * Phase 8 — the keyframe selector, the store, and the metronome it is scored against.
 *
 * The important tests here drive the **real** `KeyframeStage` over a synthetic population and
 * then run the **real** Phase 8 suite over what `KeyframeSession` accumulated, because the test
 * plan's claim is about verdicts: a metronome satisfies every count in this phase except one, so
 * showing that the code produces the right numbers is not enough — the suite has to reach a
 * different verdict for the two.
 */

import { describe, expect, it } from 'vitest';

import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import {
  ConditionState,
  KEYFRAME_DISPLACEMENT_PX,
  KEYFRAME_QUALITY_DELTA,
  KEYFRAME_ROTATION_DEG,
  KEYFRAME_TRANSLATION_UNITS,
  KeyframeReason,
  KeyframeStore,
  MAX_KEYFRAMES,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  Metronome,
  STALE_SURVIVAL_FRACTION,
  decideKeyframe,
  medianPairwiseSeparation,
  separationPx,
} from '../../src/mapping/keyframes';
import type { Keyframe, KeyframeDecisionInput } from '../../src/mapping/keyframes';
import { intrinsicsFor } from '../../src/geometry/intrinsics';
import { KeyframeStage } from '../../src/tracking/KeyframeStage';
import { KeyframeSession } from '../../src/tracking/KeyframeSession';
import { runPhase8Tests } from '../../src/testkit/Phase8Tests';
import type { KeyframeReport, PoseReport, TrackingFlow, VerificationReport } from '../../src/tracking/trackingMessages';
import { PoseState } from '../../src/geometry/pose';

const W = 640;
const H = 480;
const K = intrinsicsFor(W, H);
if (K === null) throw new Error('intrinsics fixture');
const INTRINSICS = K;

/* -------------------------------------------------------------------------- */
/* The pure decision                                                           */
/* -------------------------------------------------------------------------- */

function input(over: Partial<KeyframeDecisionInput> = {}): KeyframeDecisionInput {
  return {
    at: 10_000,
    observations: 120,
    hasPrevious: true,
    sinceLastMs: 1000,
    rotationDeg: 0,
    displacementPx: 0,
    inlierRatio: 0.6,
    previousInlierRatio: 0.6,
    trackingState: 'TRACKING',
    previousTrackingState: 'TRACKING',
    ...over,
  };
}

describe('decideKeyframe — v3 §20', () => {
  it('keeps the first view of a run, with nothing to compare it against', () => {
    const d = decideKeyframe(input({ hasPrevious: false, sinceLastMs: -1 }));
    expect(d.insert).toBe(true);
    expect(d.reason).toBe(KeyframeReason.FIRST);
  });

  it('fires on rotation at v3 §20’s 10°', () => {
    expect(decideKeyframe(input({ rotationDeg: KEYFRAME_ROTATION_DEG - 0.01 })).insert).toBe(false);
    const d = decideKeyframe(input({ rotationDeg: KEYFRAME_ROTATION_DEG }));
    expect(d.insert).toBe(true);
    expect(d.reason).toBe(KeyframeReason.ROTATION);
  });

  it('fires on displacement at v3 §20’s 30 px', () => {
    expect(decideKeyframe(input({ displacementPx: KEYFRAME_DISPLACEMENT_PX - 0.01 })).insert).toBe(
      false,
    );
    const d = decideKeyframe(input({ displacementPx: KEYFRAME_DISPLACEMENT_PX }));
    expect(d.insert).toBe(true);
    expect(d.reason).toBe(KeyframeReason.DISPLACEMENT);
  });

  it('fires on a change of quality class, by ratio or by state', () => {
    const byRatio = decideKeyframe(
      input({ inlierRatio: 0.35, previousInlierRatio: 0.35 + KEYFRAME_QUALITY_DELTA }),
    );
    expect(byRatio.reason).toBe(KeyframeReason.QUALITY);
    const byState = decideKeyframe(input({ trackingState: 'DEGRADED' }));
    expect(byState.reason).toBe(KeyframeReason.QUALITY);
    // ...and a change smaller than v3 §14's own usable→GOOD band does not.
    expect(decideKeyframe(input({ inlierRatio: 0.5, previousInlierRatio: 0.6 })).insert).toBe(false);
  });

  it('refuses inside the minimum interval even when a condition is met', () => {
    const d = decideKeyframe(
      input({ sinceLastMs: MIN_KEYFRAME_INTERVAL_MS - 1, displacementPx: 500 }),
    );
    expect(d.insert).toBe(false);
    expect(d.reason).toBe(KeyframeReason.TOO_SOON);
    // The refusal names what would otherwise have fired, so the record is not silent about it.
    expect(d.detail).toContain(KeyframeReason.DISPLACEMENT);
  });

  it('inserts at the maximum interval with no condition met', () => {
    const d = decideKeyframe(input({ sinceLastMs: MAX_KEYFRAME_INTERVAL_MS }));
    expect(d.insert).toBe(true);
    expect(d.reason).toBe(KeyframeReason.HEARTBEAT);
  });

  it('refuses a view too small to be half of a pair', () => {
    const d = decideKeyframe(
      input({ observations: MIN_KEYFRAME_OBSERVATIONS - 1, displacementPx: 500 }),
    );
    expect(d.insert).toBe(false);
    expect(d.reason).toBe(KeyframeReason.TOO_FEW_OBSERVATIONS);
  });

  it('carries v3 §20’s translation condition as a value that never fires', () => {
    // KEY-005. The magnitude does not exist in this build, so the condition is present and
    // UNMEASURED rather than absent — a later phase that acquires a scale has to remove this
    // deliberately rather than by forgetting.
    for (const d of [
      decideKeyframe(input()),
      decideKeyframe(input({ displacementPx: 500 })),
      decideKeyframe(input({ rotationDeg: 90 })),
      decideKeyframe(input({ sinceLastMs: MIN_KEYFRAME_INTERVAL_MS - 1 })),
    ]) {
      const t = d.conditions.find((c) => c.name === 'TRANSLATION');
      expect(t).toBeDefined();
      expect(t?.state).toBe(ConditionState.UNMEASURED);
      expect(t?.threshold).toBe(KEYFRAME_TRANSLATION_UNITS);
      expect(t?.fired).toBe(false);
      expect(d.reason).not.toBe('TRANSLATION');
    }
  });

  it('reports an unmeasurable condition as UNAVAILABLE rather than as zero', () => {
    const d = decideKeyframe(input({ rotationDeg: -1, displacementPx: -1 }));
    const rotation = d.conditions.find((c) => c.name === KeyframeReason.ROTATION);
    expect(rotation?.state).toBe(ConditionState.UNAVAILABLE);
    expect(rotation?.fired).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

function keyframeAt(index: number, shift: number): Omit<Keyframe, 'id'> {
  return {
    at: index * 1000,
    frameIndex: index * 30,
    reason: KeyframeReason.DISPLACEMENT,
    // Every keyframe holds the same 60 ids, displaced by `shift` — so separations are exactly
    // the difference of the shifts and the eviction policy can be checked against arithmetic.
    observations: Array.from({ length: 60 }, (_, i) => ({ id: i, x: 10 + shift, y: 20 + i })),
    intrinsics: INTRINSICS,
    rotationFromPreviousDeg: 0,
    displacementFromPreviousPx: 40,
    translationDirectionDeg: -1,
    quaternionFromPrevious: [1, 0, 0, 0],
    droppedIncrements: 0,
    inlierRatio: 0.6,
    trackedFeatures: 60,
    trackingState: 'TRACKING',
    poseConfidence: 0.5,
  };
}

describe('KeyframeStore', () => {
  it('holds at most §H.1’s thirty and evicts to make room', () => {
    const store = new KeyframeStore();
    for (let i = 0; i < MAX_KEYFRAMES + 12; i++) {
      const out = store.insert(keyframeAt(i, i * 40));
      expect(store.size()).toBeLessThanOrEqual(MAX_KEYFRAMES);
      if (i >= MAX_KEYFRAMES) expect(out.eviction).not.toBeNull();
    }
    expect(store.size()).toBe(MAX_KEYFRAMES);
    expect(store.totalEvictions()).toBe(12);
  });

  it('never evicts the view the next decision is measured against', () => {
    const store = new KeyframeStore();
    const ids: number[] = [];
    for (let i = 0; i < MAX_KEYFRAMES + 20; i++) {
      const out = store.insert(keyframeAt(i, i * 40));
      const previousNewest = ids[ids.length - 1];
      if (out.eviction && previousNewest !== undefined) {
        expect(out.eviction.keyframeId).not.toBe(previousNewest);
      }
      ids.push(out.keyframe.id);
    }
  });

  it('drops a stale keyframe before a well-observed one, whatever its age', () => {
    const store = new KeyframeStore();
    for (let i = 0; i < MAX_KEYFRAMES; i++) store.insert(keyframeAt(i, i * 40));
    const all = store.all();
    for (const kf of all) store.noteSurvival(kf.id, 1);
    // The *newest but one* is the stale one, so "oldest first" and "stalest first" disagree.
    const stale = all[all.length - 2] as Keyframe;
    store.noteSurvival(stale.id, STALE_SURVIVAL_FRACTION / 2);
    const out = store.insert(keyframeAt(99, 99 * 40));
    expect(out.eviction?.keyframeId).toBe(stale.id);
    expect(out.eviction?.reason).toBe('STALE');
  });

  it('drops the most redundant viewpoint, not the oldest, when nothing is stale', () => {
    const store = new KeyframeStore();
    // Evenly spread except for one view sitting almost on top of its neighbours.
    for (let i = 0; i < MAX_KEYFRAMES; i++) {
      store.insert(keyframeAt(i, i === 20 ? 19 * 40 + 1 : i * 40));
    }
    for (const kf of store.all()) store.noteSurvival(kf.id, 1);
    // Either half of the duplicated pair is a correct answer; what must not happen is that the
    // oldest goes while two views sit 1 px apart. On a one-directional pan every *interior*
    // keyframe leaves the same merged gap, so the merged gap cannot decide this — the nearest
    // neighbour can, and that is what the policy reads.
    const pair = [store.all()[19]?.id, store.all()[20]?.id];
    const out = store.insert(keyframeAt(99, 99 * 40));
    expect(pair).toContain(out.eviction?.keyframeId);
    expect(out.eviction?.reason).toBe('REDUNDANT');
    // KEY-003 criterion 5: the counterfactual is measured, not argued.
    expect(out.eviction?.retainedSeparationPx).toBeGreaterThanOrEqual(
      out.eviction?.oldestFirstSeparationPx ?? Infinity,
    );
  });

  it('reports no separation between views that share nothing, rather than zero', () => {
    const a: Keyframe = { ...keyframeAt(0, 0), id: 1 };
    const b: Keyframe = {
      ...keyframeAt(1, 0),
      id: 2,
      observations: [{ id: 900, x: 10, y: 20 }],
    };
    expect(separationPx(a, b)).toBe(-1);
    expect(medianPairwiseSeparation([a, b])).toBe(-1);
  });

  it('skips a stale keyframe when handing over the comparison partner', () => {
    const store = new KeyframeStore();
    const first = store.insert(keyframeAt(0, 0)).keyframe;
    const second = store.insert(keyframeAt(1, 40)).keyframe;
    store.noteSurvival(first.id, 1);
    store.noteSurvival(second.id, STALE_SURVIVAL_FRACTION / 2);
    expect(store.last()?.id).toBe(second.id);
    expect(store.lastUsable()?.id).toBe(first.id);
  });
});

describe('Metronome', () => {
  it('fires exactly as often as the selector is allowed to', () => {
    const m = new Metronome();
    let fired = 0;
    for (let t = 0; t <= 10_000; t += 100) if (m.note(t)) fired++;
    expect(fired).toBe(21);
  });
});

/* -------------------------------------------------------------------------- */
/* The stage, and the verdicts                                                 */
/* -------------------------------------------------------------------------- */

interface Segment {
  readonly frames: number;
  /** Level-0 pixels of image motion per frame. 0 is a camera that is not moving. */
  readonly pxPerFrame: number;
  /** What Phase 4's independent search says about this segment. */
  readonly motion: string;
}

/**
 * Drive the real stage over a synthetic run.
 *
 * The population is 120 points that survive throughout and move rigidly, which is a scene the
 * tracker would report and the selector has no way to distinguish from a real one — it sees
 * positions and ids, nothing else.
 */
function driveStage(segments: readonly Segment[]): KeyframeReport[] {
  const stage = new KeyframeStage();
  const reports: KeyframeReport[] = [];
  let x = 0;
  let frame = 0;
  let at = 0;
  for (const seg of segments) {
    for (let i = 0; i < seg.frames; i++) {
      x += seg.pxPerFrame;
      frame++;
      at += 1000 / 30;
      const population = Array.from({ length: 120 }, (_, id) => ({
        id,
        x0: 40 + x + (id % 10) * 20,
        y0: 40 + Math.floor(id / 10) * 15,
      }));
      reports.push(
        stage.process({
          at,
          frameIndex: frame,
          tracker: {
            getPopulation: () => population as never,
            getFrameIndex: () => frame,
          },
          width: W,
          height: H,
          pose: poseReport(),
          verification: verificationReport(),
          flow: flowReport(seg.motion),
        }),
      );
    }
  }
  return reports;
}

function poseReport(): PoseReport {
  return {
    frames: 1,
    state: PoseState.POSE,
    stateReason: 'fixture',
    source: 'FUNDAMENTAL',
    rotationDeg: 0,
    axis: [0, 1, 0],
    quaternion: [1, 0, 0, 0],
    translation: [1, 0, 0],
    scale: 'LOCAL_UNITS',
    planeNormal: null,
    intrinsics: null,
    cheirality: [],
    chosen: 0,
    unseparatedCandidates: 1,
    ambiguous: false,
    pointsInFront: 100,
    correspondences: 120,
    reprojectionErrorPx: 0.5,
    rotationOnlyResidualPx: 5,
    rotationJumpDeg: 0,
    planar: false,
    confidence: 0.6,
    rotationConfidence: 0.7,
    translationConfidence: 0.5,
    confidenceTerms: [],
    confidenceWithheld: [],
    sensitivity: null,
    poseMs: 1,
    injection: null,
  };
}

function verificationReport(): VerificationReport {
  return {
    frames: 1,
    correspondences: 120,
    anchorAge: 10,
    reAnchored: false,
    reAnchorReason: '',
    state: 'GOOD',
    stateReason: 'fixture',
    goodBlockedBy: [],
    baselinePx: 20,
    model: 'FUNDAMENTAL',
    inliers: 100,
    outliers: 20,
    inlierRatio: 0.6,
    fundamentalInliers: 100,
    homographyInliers: 60,
    planar: false,
    spreadPx: 200,
    degenerate: false,
    meanErrorPx: 0.5,
    iterations: 50,
    terminatedEarly: false,
    verifyMs: 1,
    seed: 1,
    injection: null,
  };
}

function flowReport(motion: string): TrackingFlow {
  return {
    tracked: 120, redetected: 0, total: 120, offered: 120, survival: 1,
    failedToTrack: 0, rejectedByFb: 0, reducedConfidence: 0,
    medianDisplacementPx: 2, medianFbErrorPx: 0.2,
    fbAcceptable: 120, fbReduced: 0, fbRejected: 0,
    cellSpread: 1, occupiedFlowCells: 30, maxTrackLength: 100, medianAge: 50,
    frameFailed: false, consecutiveFailedFrames: 0, geometryChanges: 0, everTracked: true,
    state: 'TRACKING', stateReason: 'fixture', goodBlockedBy: [],
    flowMs: 1, shiftMs: 1, sceneShift: null,
    frameMotion: motion, meanLuma: 128, topLevelMad: 10,
    detectedThisFrame: false, detectionOffered: 0, declinedTooClose: 0, declinedOutOfReach: 0,
    refillUrgency: 'NONE',
  };
}

function verdictsFor(reports: readonly KeyframeReport[]): Map<string, string> {
  const session = new KeyframeSession();
  for (const r of reports) session.record(r);
  const results = runPhase8Tests({
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    keyframesEverRan: true,
    stats: session.stats(true),
  });
  return new Map(results.map((r) => [r.spec.id, r.verdict]));
}

/** A run that moves for ten seconds, holds still for twelve, then moves again. */
const RUN: readonly Segment[] = [
  { frames: 300, pxPerFrame: 4, motion: 'SLOW' },
  { frames: 360, pxPerFrame: 0, motion: 'STATIC' },
  { frames: 300, pxPerFrame: 4, motion: 'SLOW' },
];

describe('KeyframeStage over a run', () => {
  const reports = driveStage(RUN);
  const session = new KeyframeSession();
  for (const r of reports) session.record(r);
  const stats = session.stats(true);

  it('inserts on the geometry while the camera moves', () => {
    expect(stats.geometricInsertions).toBeGreaterThan(0);
    expect(stats.insertionsByReason[KeyframeReason.DISPLACEMENT] ?? 0).toBeGreaterThan(0);
  });

  it('inserts nothing but the heartbeat while the camera is still', () => {
    expect(stats.staticDecisions).toBeGreaterThan(15);
    expect(stats.stillIntervalGeometricInsertions).toBe(0);
    expect(stats.staticSelectorInsertions).toBeGreaterThan(0);
  });

  it('is left far behind by a metronome over the same static frames', () => {
    expect(stats.staticMetronomeInsertions).toBeGreaterThanOrEqual(
      5 * stats.staticSelectorInsertions,
    );
  });

  it('honours both of v3 §20’s intervals', () => {
    expect(stats.minIntervalViolations).toBe(0);
    expect(stats.maxIntervalGaps).toBe(0);
  });

  it('re-derives every decision from the inputs recorded beside it', () => {
    expect(stats.reasonMismatches).toBe(0);
  });

  it('gives every keyframe its own intrinsics, re-derived from its own geometry', () => {
    expect(stats.intrinsicsMismatches).toBe(0);
    expect(stats.observationFloorViolations).toBe(0);
  });

  it('passes the Phase 8 suite’s required records', () => {
    const v = verdictsFor(reports);
    for (const id of ['KEY-001', 'KEY-002', 'KEY-003', 'KEY-004', 'KEY-005', 'KEY-006']) {
      expect(`${id}:${v.get(id)}`).toBe(`${id}:${Verdict.PASS}`);
    }
  });
});

describe('a metronome wearing this phase’s labels', () => {
  /**
   * Fake 1 and fake 2 from the test plan, together: insert every `MIN_KEYFRAME_INTERVAL_MS` and
   * label the record `DISPLACEMENT`. It satisfies both intervals, it never exceeds the bound,
   * its keyframes carry observations and intrinsics — and it inserts on a still camera.
   */
  function metronomeReports(real: readonly KeyframeReport[]): KeyframeReport[] {
    let lastAt = -1;
    let inserted = 0;
    const metronome = new Metronome();
    return real.map((r) => {
      const insert = lastAt < 0 || r.input.at - lastAt >= MIN_KEYFRAME_INTERVAL_MS;
      const sinceLastMs = lastAt < 0 ? -1 : r.input.at - lastAt;
      if (insert) {
        lastAt = r.input.at;
        inserted++;
      }
      return {
        ...r,
        inserted: insert,
        reason: insert
          ? inserted === 1
            ? KeyframeReason.FIRST
            : KeyframeReason.DISPLACEMENT
          : KeyframeReason.NO_CONDITION,
        detail: 'inserted on schedule',
        input: { ...r.input, sinceLastMs, hasPrevious: lastAt >= 0 && inserted > 1 },
        keyframes: Math.min(inserted, MAX_KEYFRAMES),
        totalInserted: inserted,
        metronomeInserted: metronome.note(r.input.at),
      };
    });
  }

  const reports = metronomeReports(driveStage(RUN));

  it('fails KEY-002: it keeps inserting on a camera that is not moving', () => {
    expect(verdictsFor(reports).get('KEY-002')).toBe(Verdict.FAIL);
  });

  it('fails KEY-001: its reasons do not follow from its own inputs', () => {
    expect(verdictsFor(reports).get('KEY-001')).toBe(Verdict.FAIL);
  });
});
