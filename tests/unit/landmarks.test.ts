/**
 * Phase 10 — the map, the similarity that brings batches into one frame, and the two fakes.
 *
 * The important tests drive the **real** `LandmarkStage` over batches the **real**
 * `TriangulationStage` produced from synthetic keyframes, and then run the **real** Phase 10
 * suite over what `LandmarkSession` accumulated. The chain matters: a fixture that handed the map
 * hand-made batches would be testing the map against a triangulator that does not exist.
 */

import { describe, expect, it } from 'vitest';

import { Verdict } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';
import { Rng } from '../../src/core/Rng';
import { intrinsicsFor, projectRay, toCameraRay } from '../../src/geometry/intrinsics';
import { apply3x3 } from '../../src/geometry/linalg';
import { fromAxisAngle } from '../../src/geometry/rotation';
import { KeyframeReason } from '../../src/mapping/keyframes';
import type { Keyframe } from '../../src/mapping/keyframes';
import {
  IngestState,
  LandmarkMap,
  MAX_LANDMARK_REPROJECTION_PX,
  MIN_OBSERVATIONS_CONFIRMED,
  MIN_REGISTRATION_POINTS,
  applySimilarity,
  overwrite,
  similarityFrom,
} from '../../src/mapping/landmarks';
import { TriangulationStage } from '../../src/tracking/TriangulationStage';
import { LandmarkStage } from '../../src/tracking/LandmarkStage';
import { LandmarkSession } from '../../src/tracking/LandmarkSession';
import { runPhase10Tests } from '../../src/testkit/Phase10Tests';
import type { LandmarkReport } from '../../src/tracking/trackingMessages';

const W = 640;
const H = 480;
const K = intrinsicsFor(W, H);
if (K === null) throw new Error('intrinsics fixture');
const INTRINSICS = K;

/* -------------------------------------------------------------------------- */
/* The similarity                                                              */
/* -------------------------------------------------------------------------- */

describe('similarityFrom', () => {
  const rng = new Rng(0x51a1);
  const source = Array.from({ length: 12 }, () => [
    rng.next() * 4 - 2,
    rng.next() * 4 - 2,
    2 + rng.next() * 6,
  ]);

  it('recovers a known scale, rotation and translation', () => {
    const r = fromAxisAngle([0.2, 0.9, 0.3], 27);
    const c = 2.75;
    const t = [1.5, -0.4, 3.2];
    const target = source.map((p) => apply3x3(r, p).map((v, i) => c * v + (t[i] ?? 0)));
    const fit = similarityFrom(source, target);
    expect(fit).not.toBeNull();
    expect(fit?.scale ?? 0).toBeCloseTo(c, 6);
    for (const [i, p] of source.entries()) {
      const mapped = applySimilarity(fit as never, p);
      const truth = target[i] ?? [0, 0, 0];
      expect(Math.hypot(
        (mapped[0] ?? 0) - (truth[0] ?? 0),
        (mapped[1] ?? 0) - (truth[1] ?? 0),
        (mapped[2] ?? 0) - (truth[2] ?? 0),
      )).toBeLessThan(1e-6);
    }
  });

  it('refuses a reflection rather than returning one', () => {
    // A mirrored target: no camera motion produces it, and a fit without the determinant guard
    // returns it happily, putting every landmark on the wrong side of the scene.
    const target = source.map((p) => [p[0] ?? 0, p[1] ?? 0, -(p[2] ?? 0)]);
    const fit = similarityFrom(source, target);
    expect(fit).not.toBeNull();
    // The rotation it returns is a rotation — the reflection cannot be represented, so the fit
    // is simply poor rather than geometrically impossible.
    const residual = source.reduce((worst, p, i) => {
      const mapped = applySimilarity(fit as never, p);
      const truth = target[i] ?? [0, 0, 0];
      return Math.max(worst, Math.hypot(
        (mapped[0] ?? 0) - (truth[0] ?? 0),
        (mapped[1] ?? 0) - (truth[1] ?? 0),
        (mapped[2] ?? 0) - (truth[2] ?? 0),
      ));
    }, 0);
    expect(residual).toBeGreaterThan(0.1);
  });

  it('needs three points and says so', () => {
    expect(similarityFrom(source.slice(0, 2), source.slice(0, 2))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

const KEYFRAME_STEP = 0.9;
const KEYFRAME_TURN_DEG = 0.6;

/** The Phase 9 fixture's scene and trajectory, so the two phases are tested on one world. */
function keyframeRun(count: number): Keyframe[] {
  const rng = new Rng(0x9a1b);
  // Wide enough in the direction of travel that the camera is still inside the scene at the end
  // of the walk. A run whose camera leaves its own world measures the map's epoch handling,
  // which is a different test from the one below.
  const points = Array.from({ length: 420 }, (_, id) => {
    const x = -6 + rng.next() * 48;
    const y = -4 + rng.next() * 8;
    const z = id % 2 === 0 ? 3 + rng.next() * 2 : 8 + rng.next() * 5;
    return { id, x: [x, y, z] };
  });

  const frames: Keyframe[] = [];
  for (let i = 0; i < count; i++) {
    const t = [-KEYFRAME_STEP * i, 0.02 * i, 0];
    const r = fromAxisAngle([0, 1, 0], KEYFRAME_TURN_DEG * i);
    const observations: { id: number; x: number; y: number }[] = [];
    for (const p of points) {
      const rel = apply3x3(r, p.x).map((v, j) => v + (t[j] ?? 0));
      const q = projectRay(INTRINSICS, rel);
      if (!q || q.x < 0 || q.y < 0 || q.x >= W || q.y >= H) continue;
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

/** Drive Phase 9's real stage and feed every batch it makes to Phase 10's real stage. */
function driveMap(frames: readonly Keyframe[], map?: LandmarkMap): LandmarkReport[] {
  const triangulation = new TriangulationStage();
  const stage = new LandmarkStage(0x2c1b_3a57, map);
  const reports: LandmarkReport[] = [];
  for (let i = 0; i < frames.length; i++) {
    triangulation.process({
      keyframes: frames.slice(0, i + 1),
      inserted: true,
      wantInjections: false,
    });
    reports.push(stage.process({ batch: triangulation.getBatch(), wantInjection: true }));
  }
  return reports;
}

function statsFor(reports: readonly LandmarkReport[]) {
  const session = new LandmarkSession();
  session.noteTrackedPopulation(220);
  for (const r of reports) session.record(r);
  return session.stats(true);
}

function verdictsFor(reports: readonly LandmarkReport[]): Map<string, string> {
  const results = runPhase10Tests({
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    landmarksEverRan: true,
    stats: statsFor(reports),
  });
  return new Map(results.map((r) => [r.spec.id, r.verdict]));
}

describe('LandmarkMap over a run of batches', () => {
  const reports = driveMap(keyframeRun(40));
  const stats = statsFor(reports);

  it('registers most batches, and reports a scale rather than a length', () => {
    expect(stats.registeredBatches).toBeGreaterThan(20);
    expect(stats.medianRegistrationScale).toBeGreaterThan(0);
    expect(stats.medianRegistrationResidual).toBeLessThan(0.05);
    expect(stats.scaleViolations).toBe(0);
  });

  it('accumulates landmarks across batches', () => {
    // The peak rather than the last batch's: an epoch restart clears the map, and MAP-003 is
    // where that is counted.
    expect(stats.peakLandmarks).toBeGreaterThan(50);
    expect(stats.peakConfirmed).toBeGreaterThan(20);
    expect(stats.landmarks).toBeLessThanOrEqual(stats.maxLandmarks);
  });

  it('predicts a landmark into a keyframe it was not computed from', () => {
    expect(stats.heldOutBatches).toBeGreaterThan(15);
    expect(stats.medianHeldOutPx).toBeLessThanOrEqual(MAX_LANDMARK_REPROJECTION_PX);
    expect(stats.zeroHeldOut).toBeLessThan(stats.heldOutSamples);
    expect(stats.medianObservationsAtPrediction).toBeGreaterThanOrEqual(1);
  });

  it('finds the positions the harness displaced, and spares the rest', () => {
    expect(stats.injections).toBeGreaterThanOrEqual(3);
    expect(stats.medianRecall).toBeGreaterThanOrEqual(0.9);
    // The excess over what the same gate refuses on the *uncorrupted* batch — see MAP-005's
    // amendment. An absolute rate here measures how noisy the scene is.
    expect(stats.medianCleanExcess).toBeLessThanOrEqual(0.1);
    expect(stats.medianBaselineRejectionRate).toBeGreaterThanOrEqual(0);
  });

  it('settles: the move a new observation causes falls with the count', () => {
    expect(stats.moveAtTwoSamples).toBeGreaterThan(0);
    expect(stats.moveAtFiveSamples).toBeGreaterThan(0);
    expect(stats.moveAtFive).toBeLessThanOrEqual(stats.moveAtTwo);
  });

  it('keeps its counts consistent', () => {
    expect(stats.accountingMismatches).toBe(0);
    expect(stats.unregisteredAdmissions).toBe(0);
    expect(stats.confidenceOutOfRange).toBe(0);
    expect(stats.boundBreaches).toBe(0);
  });

  it('passes the Phase 10 suite’s required records', () => {
    const v = verdictsFor(reports);
    for (const id of ['MAP-001', 'MAP-002', 'MAP-003', 'MAP-004', 'MAP-005', 'MAP-006', 'MAP-007']) {
      expect(`${id}:${v.get(id)}`).toBe(`${id}:${Verdict.PASS}`);
    }
  });
});

describe('a map that keeps only the newest observation', () => {
  /**
   * Fake 1 from the test plan, driven through the real stage with one rule replaced.
   *
   * It registers every batch, its counts add up, it stays inside the bound, and it can still
   * predict — from the *previous* batch's estimate, which on clean data is a perfectly good
   * position. What it cannot do is **settle**: the move a new observation causes stays at the
   * noise level instead of falling like 1/n, because there is nothing being averaged.
   */
  const reports = driveMap(keyframeRun(40), new LandmarkMap(overwrite));
  const stats = statsFor(reports);

  it('is caught by MAP-006, which is what MAP-006 is for', () => {
    expect(verdictsFor(reports).get('MAP-006')).toBe(Verdict.FAIL);
  });

  it('moves as much on its fifth observation as on its second', () => {
    const honest = statsFor(driveMap(keyframeRun(40)));
    expect(stats.moveAtFive).toBeGreaterThan(honest.moveAtFive);
    expect(stats.moveAtFive).toBeGreaterThan(stats.moveAtTwo * 0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* The map's own rules, directly                                               */
/* -------------------------------------------------------------------------- */

describe('LandmarkMap', () => {
  it('refuses a batch it cannot relate to what it already holds', () => {
    const map = new LandmarkMap();
    const first = syntheticBatch(1, 2, 0);
    map.ingest(first);
    // A batch sharing nothing: different ids entirely.
    const stranger = { ...syntheticBatch(9, 10, 0), points: syntheticBatch(9, 10, 900).points };
    const out = map.ingest(stranger);
    expect(out.state).toBe(IngestState.UNREGISTERED);
    expect(out.admitted.length).toBe(0);
    expect(out.merged.length).toBe(0);
    expect(out.rejected.length).toBe(stranger.points.length);
    expect(out.reason).toContain(String(MIN_REGISTRATION_POINTS));
  });

  it('confirms a landmark only once enough views have seen it', () => {
    const map = new LandmarkMap();
    map.ingest(syntheticBatch(1, 2, 0));
    expect(map.confirmedCount()).toBe(0);
    map.ingest(syntheticBatch(2, 3, 0));
    map.ingest(syntheticBatch(3, 4, 0));
    const some = map.all().filter((l) => l.observations >= MIN_OBSERVATIONS_CONFIRMED);
    expect(some.length).toBeGreaterThan(0);
    expect(map.confirmedCount()).toBe(some.length);
  });
});

/**
 * A batch of the same twenty points seen from a camera that has moved sideways once per step.
 *
 * Deliberately simple and exact: these tests are about the map's rules — registration, admission,
 * confirmation — not about the geometry, which the run above exercises through the real
 * triangulator.
 */
function syntheticBatch(a: number, b: number, idOffset: number) {
  // One fixed seed, so the same ids denote the same points across batches — this fixture is
  // about the map's rules, and a scene that changed between batches would be about registration.
  const rng = new Rng(0x1234);
  const points = Array.from({ length: 20 }, (_, i) => {
    const ax = 60 + rng.next() * (W - 120);
    const ay = 60 + rng.next() * (H - 120);
    const depth = 4 + rng.next() * 3;
    const ray = toCameraRay(INTRINSICS, ax, ay);
    const position = [(ray[0] ?? 0) * depth, (ray[1] ?? 0) * depth, depth];
    // `X_B = R X_A + t` with the batch's own declared translation — an observation taken at a
    // different baseline from the pose the batch declares is a fixture that contradicts itself,
    // and the map is right to refuse every point of it.
    const inB = [(position[0] ?? 0) - 1, position[1] ?? 0, position[2] ?? 0];
    const q = projectRay(INTRINSICS, inB) ?? { x: ax, y: ay };
    return {
      id: idOffset + i,
      position,
      depth,
      parallaxDeg: 5,
      observedX: q.x,
      observedY: q.y,
    };
  });
  return {
    keyframeA: a,
    keyframeB: b,
    intrinsics: INTRINSICS,
    points,
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [-1, 0, 0],
  };
}
