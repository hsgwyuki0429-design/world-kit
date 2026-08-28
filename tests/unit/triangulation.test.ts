/**
 * Phase 9 — the triangulator, its two gates, and the fake each of them exists to catch.
 *
 * The important tests drive the **real** `TriangulationStage` over synthetic keyframes and then
 * run the **real** Phase 9 suite over what `TriangulationSession` accumulated, because the test
 * plan's claim is about verdicts: a triangulator that returns one constant depth and reports a
 * small reprojection error satisfies every count in this phase, so showing the code produces the
 * right numbers is not enough — the suite has to reach a different verdict for the two.
 */

import { describe, expect, it } from 'vitest';

import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import { Rng } from '../../src/core/Rng';
import { intrinsicsFor, projectRay, toCameraRay } from '../../src/geometry/intrinsics';
import { apply3x3, normalise3 } from '../../src/geometry/linalg';
import { fromAxisAngle } from '../../src/geometry/rotation';
import { rotationHomography } from '../../src/geometry/pose';
import {
  CORRESPONDENCE_NOISE_PX,
  DEPTH_UNCERTAINTY_LIMIT,
  MAX_TRIANGULATION_REPROJECTION_PX,
  MIN_PARALLAX_DEG,
  TriangulationRefusal,
  parallaxForUncertainty,
  triangulatePair,
} from '../../src/mapping/triangulation';
import type {
  PairObservation,
  TriangulationInput,
  TriangulationOutcome,
} from '../../src/mapping/triangulation';
import { KeyframeReason } from '../../src/mapping/keyframes';
import type { Keyframe } from '../../src/mapping/keyframes';
import { TriangulationStage, spearman } from '../../src/tracking/TriangulationStage';
import { TriangulationSession } from '../../src/tracking/TriangulationSession';
import { runPhase9Tests } from '../../src/testkit/Phase9Tests';
import type { TriangulationReport } from '../../src/tracking/trackingMessages';

const W = 640;
const H = 480;
const K = intrinsicsFor(W, H);
if (K === null) throw new Error('intrinsics fixture');
const INTRINSICS = K;

/* -------------------------------------------------------------------------- */
/* The floor, against the arithmetic that produced it                          */
/* -------------------------------------------------------------------------- */

describe('MIN_PARALLAX_DEG', () => {
  it('is the parallax at which §13’s correspondence band buys a 10 % depth', () => {
    // The plan derives 0.89° at f ≈ 967 px — a 1280-long-edge frame at the assumed 67° FOV — and
    // rounds it to 1.0. Pinned here so the constant cannot drift away from what derived it.
    const wide = intrinsicsFor(1280, 720);
    expect(wide).not.toBeNull();
    const derived = parallaxForUncertainty(wide?.fx ?? 0, DEPTH_UNCERTAINTY_LIMIT);
    expect(derived).toBeGreaterThan(0.85);
    expect(derived).toBeLessThan(0.95);
    expect(MIN_PARALLAX_DEG).toBeGreaterThanOrEqual(derived);
    expect(CORRESPONDENCE_NOISE_PX).toBe(1.5);
  });
});

/* -------------------------------------------------------------------------- */
/* The solve                                                                   */
/* -------------------------------------------------------------------------- */

/** Project a set of depths through `(R, t)` and hand back the correspondences. */
function syntheticPair(
  depths: readonly number[],
  rotation: readonly number[],
  translation: readonly number[],
  rng = new Rng(7),
): PairObservation[] {
  const out: PairObservation[] = [];
  for (let i = 0; i < depths.length; i++) {
    const ax = 40 + rng.next() * (W - 80);
    const ay = 40 + rng.next() * (H - 80);
    const depth = depths[i] ?? 4;
    const ray = toCameraRay(INTRINSICS, ax, ay);
    const x = [(ray[0] ?? 0) * depth, (ray[1] ?? 0) * depth, depth];
    const inB = apply3x3(rotation, x).map((v, j) => v + (translation[j] ?? 0));
    const p = projectRay(INTRINSICS, inB);
    if (!p) continue;
    out.push({ id: i, ax, ay, bx: p.x, by: p.y });
  }
  return out;
}

function allInliers(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('triangulatePair', () => {
  const lateral = normalise3([1, 0, 0]) ?? [1, 0, 0];
  const smallTurn = fromAxisAngle([0, 1, 0], 3);

  it('recovers the depths it was given, in units of the baseline', () => {
    const depths = Array.from({ length: 60 }, (_, i) => 2 + (i % 12) * 0.5);
    const obs = syntheticPair(depths, smallTurn, lateral);
    const out = triangulatePair({
      observations: obs,
      inliers: allInliers(obs.length),
      rotation: smallTurn,
      translation: lateral,
      intrinsics: INTRINSICS,
    });
    expect(out.points.length).toBeGreaterThan(40);
    for (const p of out.points) {
      const truth = depths[p.id] ?? 0;
      expect(Math.abs(p.depth - truth) / truth).toBeLessThan(1e-6);
    }
  });

  it('refuses a point behind either camera', () => {
    const obs = syntheticPair([4, 4, 4], smallTurn, lateral);
    // Reflect one target through the principal point: the rays then diverge and the solution
    // lands behind the first camera.
    const broken = obs.map((o, i) =>
      i === 0 ? { ...o, bx: 2 * INTRINSICS.cx - o.bx, by: 2 * INTRINSICS.cy - o.by } : o,
    );
    const out = triangulatePair({
      observations: broken,
      inliers: allInliers(broken.length),
      rotation: smallTurn,
      translation: lateral,
      intrinsics: INTRINSICS,
    });
    expect(out.points.some((p) => p.id === 0)).toBe(false);
    const refused =
      (out.refusals[TriangulationRefusal.BEHIND_CAMERA] ?? 0) +
      (out.refusals[TriangulationRefusal.HIGH_REPROJECTION] ?? 0) +
      (out.refusals[TriangulationRefusal.LOW_PARALLAX] ?? 0) +
      (out.refusals[TriangulationRefusal.DEGENERATE] ?? 0);
    expect(refused).toBeGreaterThan(0);
  });

  it('refuses everything when the baseline is far too short for the depth', () => {
    // A baseline a thousandth of the depth is about 0.06° of parallax — well under the floor,
    // and the linear system still has a solution, which is exactly the problem.
    const depths = Array.from({ length: 40 }, () => 500);
    const obs = syntheticPair(depths, smallTurn, lateral);
    const out = triangulatePair({
      observations: obs,
      inliers: allInliers(obs.length),
      rotation: smallTurn,
      translation: lateral,
      intrinsics: INTRINSICS,
    });
    expect(out.points.length).toBe(0);
    expect(out.refusals[TriangulationRefusal.LOW_PARALLAX]).toBeGreaterThan(0);
  });

  it('every accepted point clears both gates, always', () => {
    const depths = Array.from({ length: 80 }, (_, i) => 1.5 + (i % 20) * 0.9);
    const obs = syntheticPair(depths, smallTurn, lateral);
    const out = triangulatePair({
      observations: obs,
      inliers: allInliers(obs.length),
      rotation: smallTurn,
      translation: lateral,
      intrinsics: INTRINSICS,
    });
    for (const p of out.points) {
      expect(p.parallaxDeg).toBeGreaterThanOrEqual(MIN_PARALLAX_DEG);
      expect(p.reprojectionPx).toBeLessThanOrEqual(MAX_TRIANGULATION_REPROJECTION_PX);
      expect(p.depth).toBeGreaterThan(0);
    }
    // ...and the counts add up, which TRI-009 checks on every batch of a real run.
    const refused = Object.values(out.refusals).reduce((a, b) => a + b, 0);
    expect(out.points.length + refused).toBe(out.candidates);
  });

  it('accepts nothing from a camera that only turned', () => {
    const h = rotationHomography(INTRINSICS, fromAxisAngle([0, 1, 0], 8));
    expect(h).not.toBeNull();
    const rng = new Rng(11);
    const obs: PairObservation[] = [];
    for (let i = 0; i < 60; i++) {
      const ax = 40 + rng.next() * (W - 80);
      const ay = 40 + rng.next() * (H - 80);
      const q = apply3x3(h ?? [], [ax, ay, 1]);
      const w = q[2] ?? 1;
      obs.push({ id: i, ax, ay, bx: (q[0] ?? 0) / w, by: (q[1] ?? 0) / w });
    }
    // The camera never moved, so whatever translation direction a decomposition offers, the rays
    // are parallel and no depth is determined. Any unit direction exposes the same fact.
    for (const t of [[1, 0, 0], [0, 1, 0], normalise3([1, 1, 0]) ?? [1, 0, 0]]) {
      const out = triangulatePair({
        observations: obs,
        inliers: allInliers(obs.length),
        rotation: fromAxisAngle([0, 1, 0], 8),
        translation: t,
        intrinsics: INTRINSICS,
      });
      expect(out.points.length).toBe(0);
    }
  });
});

describe('spearman', () => {
  it('is 1 for an order that matches and 0 for a constant', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
    expect(spearman([1, 2, 3, 4], [7, 7, 7, 7])).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The stage, and the verdicts                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A run of keyframes over a scene at two depths, with the camera translating sideways.
 *
 * The observations are what a tracker would have produced: the same ids across keyframes, moved
 * by the projection of a real camera motion. Nothing here tells the stage which pair it has.
 */
const KEYFRAME_STEP = 0.9;
const KEYFRAME_TURN_DEG = 0.6;

function keyframeRun(count: number): Keyframe[] {
  const rng = new Rng(0x9a1b);
  // A scene at two depths, spread wide enough in the direction of travel that consecutive
  // keyframes keep sharing points. `KEYFRAME_STEP` is chosen so the median shared displacement
  // lands near v3 §20's 30 px — which is what Phase 8 inserts on, and which is twice Phase 5's
  // 15 px minimum baseline, so a keyframe pair clears that floor by construction.
  const points = Array.from({ length: 220 }, (_, id) => {
    const x = -5 + rng.next() * 20;
    const y = -4 + rng.next() * 8;
    const z = id % 2 === 0 ? 3 + rng.next() * 2 : 8 + rng.next() * 5;
    return { id, x: [x, y, z] };
  });

  const frames: Keyframe[] = [];
  for (let i = 0; i < count; i++) {
    // One camera pose per keyframe: a steady sideways translation with a small turn.
    const t = [-KEYFRAME_STEP * i, 0.02 * i, 0];
    const r = fromAxisAngle([0, 1, 0], KEYFRAME_TURN_DEG * i);
    const observations: { id: number; x: number; y: number }[] = [];
    for (const p of points) {
      const rel = apply3x3(r, p.x).map((v, j) => v + (t[j] ?? 0));
      const q = projectRay(INTRINSICS, rel);
      if (!q || q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) continue;
      // A little seeded noise, because a noiseless fixture is not a fixture. §13 puts the
      // correspondence band at 1.5 px; a fifth of that is a well-tracked point. Without it the
      // pair fit and Phase 6's route agree to the last decimal on every batch, and TRI-006's
      // third criterion — that the two are not the same number — fires on the fixture rather
      // than on a defect.
      observations.push({
        id: p.id,
        x: q.x + (rng.next() - 0.5) * 0.6,
        y: q.y + (rng.next() - 0.5) * 0.6,
      });
    }
    frames.push({
      id: i + 1,
      at: i * 700,
      frameIndex: i * 21,
      reason: i === 0 ? KeyframeReason.FIRST : KeyframeReason.DISPLACEMENT,
      observations,
      intrinsics: INTRINSICS,
      // Phase 6's route, which TRI-006 compares the pair fit against. The true relative rotation
      // between consecutive keyframes is `KEYFRAME_TURN_DEG`.
      rotationFromPreviousDeg: i === 0 ? -1 : KEYFRAME_TURN_DEG,
      displacementFromPreviousPx: 35,
      translationDirectionDeg: -1,
      quaternionFromPrevious: null,
      droppedIncrements: 0,
      inlierRatio: 0.7,
      trackedFeatures: observations.length,
      trackingState: 'TRACKING',
      poseConfidence: 0.6,
    });
  }
  return frames;
}

function driveStage(
  frames: readonly Keyframe[],
  solve?: (input: TriangulationInput) => TriangulationOutcome,
): TriangulationReport[] {
  const stage = new TriangulationStage(0x51ed_270b, solve);
  const reports: TriangulationReport[] = [];
  for (let i = 0; i < frames.length; i++) {
    reports.push(
      stage.process({
        keyframes: frames.slice(0, i + 1),
        inserted: true,
        // The schedule is the stage's, keyed on its own batch index — see `INJECTION_SAMPLE_EVERY`.
        wantInjections: true,
      }),
    );
  }
  return reports;
}

function verdictsFor(reports: readonly TriangulationReport[]): Map<string, string> {
  const session = new TriangulationSession();
  for (const r of reports) {
    session.noteKeyframeInserted();
    session.record(r);
  }
  const results = runPhase9Tests({
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    triangulationEverRan: true,
    stats: session.stats(true),
  });
  return new Map(results.map((r) => [r.spec.id, r.verdict]));
}

function statsFor(reports: readonly TriangulationReport[]) {
  const session = new TriangulationSession();
  for (const r of reports) {
    session.noteKeyframeInserted();
    session.record(r);
  }
  return session.stats(true);
}

describe('TriangulationStage over a run of keyframes', () => {
  const reports = driveStage(keyframeRun(40));
  const stats = statsFor(reports);

  it('triangulates most pairs and refuses none of them wrongly', () => {
    expect(stats.batchesTriangulated).toBeGreaterThan(15);
    expect(stats.totalAccepted).toBeGreaterThan(100);
  });

  it('accepts nothing below the parallax floor', () => {
    expect(stats.worstAcceptedParallaxDeg).toBeGreaterThanOrEqual(MIN_PARALLAX_DEG);
    expect(stats.medianDepthUncertainty).toBeLessThanOrEqual(DEPTH_UNCERTAINTY_LIMIT);
  });

  it('recovers the depths the harness chose, far ahead of a constant', () => {
    expect(stats.depthInjections).toBeGreaterThanOrEqual(3);
    expect(stats.medianDepthError).toBeLessThan(0.02);
    expect(stats.medianControlError).toBeGreaterThan(10 * stats.medianDepthError);
    expect(stats.medianRankCorrelation).toBeGreaterThan(0.9);
  });

  it('accepts nothing from the pure-rotation injection', () => {
    expect(stats.rotationInjections).toBeGreaterThanOrEqual(3);
    expect(stats.rotationInjectionAccepted).toBe(0);
    expect(stats.rotationInjectionCleanAccepted).toBeGreaterThan(0);
  });

  it('agrees with Phase 6’s route about the rotation', () => {
    expect(stats.rotationSamples).toBeGreaterThan(15);
    expect(stats.medianRotationDisagreementDeg).toBeLessThanOrEqual(stats.rotationToleranceDeg);
    expect(stats.zeroDisagreements).toBeLessThan(stats.rotationSamples);
  });

  it('keeps its counts consistent', () => {
    expect(stats.accountingMismatches).toBe(0);
    expect(stats.refusedWithPoints).toBe(0);
    expect(stats.scaleViolations).toBe(0);
  });

  it('passes the Phase 9 suite’s required records', () => {
    const v = verdictsFor(reports);
    for (const id of ['TRI-001', 'TRI-002', 'TRI-003', 'TRI-004', 'TRI-005', 'TRI-006', 'TRI-007']) {
      expect(`${id}:${v.get(id)}`).toBe(`${id}:${Verdict.PASS}`);
    }
  });
});

describe('a triangulator that returns one constant depth', () => {
  /**
   * Fake 1 from the test plan, and it is the *convincing* version: every point sits on its own
   * ray at the set's mean depth — so the direction is right and only the distance is wrong — and
   * the stage reports a small reprojection error for each, because a stage that computes its own
   * statistics can compute whatever it likes about itself.
   *
   * Every count adds up. Every point is in front of both cameras. The reprojection it reports is
   * better than the real triangulator's. The depth distribution has the right centre. TRI-004 is
   * the only record it cannot survive, because that one is measured against depths it never saw.
   */
  function constantDepth(input: TriangulationInput): TriangulationOutcome {
    const honest = triangulatePair(input);
    if (honest.points.length === 0) return honest;
    const mean =
      honest.points.reduce((a, p) => a + p.depth, 0) / honest.points.length;
    const points = honest.points.map((p) => {
      const o = input.observations.find((x) => x.id === p.id);
      const ray = o ? toCameraRay(input.intrinsics, o.ax, o.ay) : [0, 0, 1];
      return {
        ...p,
        position: [(ray[0] ?? 0) * mean, (ray[1] ?? 0) * mean, mean],
        depth: mean,
        reprojectionPx: 0.05,
      };
    });
    return {
      ...honest,
      points,
      medianDepth: mean,
      medianReprojectionPx: 0.05,
      maxAcceptedReprojectionPx: 0.05,
      minAcceptedDepth: mean,
    };
  }

  const reports = driveStage(keyframeRun(40), constantDepth);
  const stats = statsFor(reports);

  it('fails TRI-004 and nothing else in the required suite', () => {
    const v = verdictsFor(reports);
    expect(v.get('TRI-004')).toBe(Verdict.FAIL);
    for (const id of ['TRI-001', 'TRI-002', 'TRI-003', 'TRI-005', 'TRI-006', 'TRI-007']) {
      expect(`${id}:${v.get(id)}`).toBe(`${id}:${Verdict.PASS}`);
    }
  });

  it('scores the control it was measured against', () => {
    // The plan's claim, executed: its error is the error of the best possible single number.
    expect(stats.medianDepthError).toBeGreaterThan(0.1);
    expect(stats.medianRankCorrelation).toBeLessThan(0.5);
  });

  it('reports a *better* reprojection error than the real triangulator', () => {
    const honest = statsFor(driveStage(keyframeRun(40)));
    expect(stats.medianReprojectionPx).toBeLessThanOrEqual(honest.medianReprojectionPx);
  });
});
