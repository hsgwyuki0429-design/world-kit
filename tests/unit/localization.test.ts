/**
 * Phase 12 — the stage that places each frame's camera in the map's world.
 *
 * Driven with a map whose landmarks and keyframe poses are known by construction, so the pose it
 * solves can be checked against the one that produced the pixels.
 */

import { describe, expect, it } from 'vitest';

import { Rng } from '../../src/core/Rng';
import { intrinsicsFor } from '../../src/geometry/intrinsics';
import { multiply3x3, transpose3x3 } from '../../src/geometry/linalg';
import { fromAxisAngle, rotationAngleDeg } from '../../src/geometry/rotation';
import { projectPoint } from '../../src/geometry/pnp';
import type { CameraPose } from '../../src/geometry/pnp';
import { LandmarkState } from '../../src/mapping/landmarks';
import type { KeyframePose, Landmark } from '../../src/mapping/landmarks';
import {
  HELD_OUT_EVERY,
  LocalizationStage,
  LocalizationState,
} from '../../src/tracking/LocalizationStage';
import type { MapReader } from '../../src/tracking/LocalizationStage';
import { MAP_SNAPSHOT_STRIDE } from '../../src/tracking/trackingMessages';

const W = 640;
const H = 480;
const K = intrinsicsFor(W, H);
if (!K) throw new Error('intrinsics fixture');
const INTRINSICS = K;

function poseAt(yawDeg: number, center: number[]): CameraPose {
  const r = fromAxisAngle([0, 1, 0], yawDeg);
  const t = [0, 1, 2].map(
    (i) => -((r[i * 3] ?? 0) * (center[0] ?? 0) + (r[i * 3 + 1] ?? 0) * (center[1] ?? 0) + (r[i * 3 + 2] ?? 0) * (center[2] ?? 0)),
  );
  return { rotation: r, translation: t };
}

function buildMap(n: number, keyframes: Map<number, KeyframePose>, version = 1): MapReader {
  const rng = new Rng(21);
  const landmarks = new Map<number, Landmark>();
  for (let i = 0; i < n; i++) {
    const id = 1000 + i;
    landmarks.set(id, {
      id,
      position: [(rng.next() - 0.5) * 10, (rng.next() - 0.5) * 6, 8 + rng.next() * 6],
      observations: 4,
      keyframes: [1, 2],
      maxParallaxDeg: 4,
      meanPredictionPx: 0.3,
      predictions: 2,
      lastMoveRelative: 0.001,
      confidence: 0.8,
      state: LandmarkState.CONFIRMED,
      epoch: 1,
    });
  }
  return {
    landmark: (id) => landmarks.get(id),
    landmarks: () => [...landmarks.values()],
    keyframePose: (id) => keyframes.get(id),
    epoch: () => 1,
    version: () => version,
  };
}

function populationFor(map: MapReader, pose: CameraPose, noise = 0.3): { id: number; x0: number; y0: number }[] {
  const rng = new Rng(4);
  const out: { id: number; x0: number; y0: number }[] = [];
  for (const l of map.landmarks()) {
    const p = projectPoint(INTRINSICS, pose, l.position);
    if (!p || p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
    out.push({ id: l.id, x0: p.x + (rng.next() - 0.5) * noise, y0: p.y + (rng.next() - 0.5) * noise });
  }
  return out;
}

describe('LocalizationStage', () => {
  it('places a frame between keyframes, from the newest keyframe the map registered', () => {
    const keyframes = new Map<number, KeyframePose>([[2, poseAt(0, [0, 0, 0])]]);
    const map = buildMap(200, keyframes);
    const truth = poseAt(6, [0.4, 0.1, 0.2]);
    const stage = new LocalizationStage();
    const r = stage.process({
      population: populationFor(map, truth),
      width: W,
      height: H,
      map,
      keyframeIds: [1, 2],
      registeredKeyframe: null,
      capturedAtEpoch: 1,
    });
    expect(r.state).toBe(LocalizationState.LOCALIZED);
    expect(r.startedFrom).toBe('KEYFRAME');
    expect(r.pose).not.toBeNull();
    if (!r.pose) return;
    expect(rotationAngleDeg(multiply3x3(r.pose.rotation, transpose3x3(truth.rotation)))).toBeLessThan(0.2);
    expect(r.medianErrorPx).toBeLessThan(0.5);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.projectionSamples.length).toBeGreaterThan(0);
    // The first frame ships the map; an unchanged map is not shipped again.
    expect(r.snapshot).not.toBeNull();
    expect(r.snapshot?.count).toBe(200);
    expect(new Float32Array(r.snapshot?.data ?? new ArrayBuffer(0)).length).toBe(200 * MAP_SNAPSHOT_STRIDE);
    const again = stage.process({
      population: populationFor(map, truth),
      width: W,
      height: H,
      map,
      keyframeIds: [1, 2],
      registeredKeyframe: null,
      capturedAtEpoch: 2,
    });
    expect(again.snapshot).toBeNull();
    expect(again.startedFrom).toBe('PREVIOUS');
  });

  it('measures a held-out error on its schedule, and it is small for a real pose', () => {
    const keyframes = new Map<number, KeyframePose>([[2, poseAt(0, [0, 0, 0])]]);
    const map = buildMap(240, keyframes);
    const stage = new LocalizationStage();
    let heldOut = -1;
    for (let i = 1; i <= HELD_OUT_EVERY; i++) {
      const r = stage.process({
        population: populationFor(map, poseAt(i, [0.05 * i, 0, 0])),
        width: W,
        height: H,
        map,
        keyframeIds: [2],
        registeredKeyframe: null,
        capturedAtEpoch: i,
      });
      if (r.heldOutPx >= 0) heldOut = r.heldOutPx;
    }
    expect(heldOut).toBeGreaterThan(0);
    expect(heldOut).toBeLessThan(1);
  });

  it('says NO_MAP and TOO_FEW rather than producing a pose', () => {
    const keyframes = new Map<number, KeyframePose>([[2, poseAt(0, [0, 0, 0])]]);
    const empty = buildMap(0, keyframes);
    const stage = new LocalizationStage();
    const r = stage.process({
      population: [], width: W, height: H, map: empty, keyframeIds: [2], registeredKeyframe: null, capturedAtEpoch: 1,
    });
    expect(r.state).toBe(LocalizationState.NO_MAP);
    expect(r.pose).toBeNull();

    const map = buildMap(200, keyframes);
    const few = populationFor(map, poseAt(0, [0, 0, 0])).slice(0, 5);
    const r2 = stage.process({
      population: few, width: W, height: H, map, keyframeIds: [2], registeredKeyframe: null, capturedAtEpoch: 2,
    });
    expect(r2.state).toBe(LocalizationState.TOO_FEW);
    expect(r2.pose).toBeNull();
  });

  it('refuses a pose when the pixels belong to a different arrangement of the room', () => {
    const keyframes = new Map<number, KeyframePose>([[2, poseAt(0, [0, 0, 0])]]);
    const map = buildMap(200, keyframes);
    const truth = poseAt(0, [0, 0, 0]);
    const pop = populationFor(map, truth);
    // Shuffle which id each pixel belongs to: the tracker's ids no longer name the map's points.
    const ids = pop.map((p) => p.id);
    const rng = new Rng(8);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      const tmp = ids[i] ?? 0;
      ids[i] = ids[j] ?? 0;
      ids[j] = tmp;
    }
    const scrambled = pop.map((p, i) => ({ ...p, id: ids[i] ?? p.id }));
    const r = new LocalizationStage().process({
      population: scrambled, width: W, height: H, map, keyframeIds: [2], registeredKeyframe: null, capturedAtEpoch: 1,
    });
    expect(r.state).toBe(LocalizationState.REFUSED);
    expect(r.pose).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('compares itself with the pose the map registered for this frame', () => {
    const truth = poseAt(4, [0.3, 0, 0.1]);
    const keyframes = new Map<number, KeyframePose>([
      [2, poseAt(0, [0, 0, 0])],
      [3, truth],
    ]);
    const map = buildMap(200, keyframes);
    const r = new LocalizationStage().process({
      population: populationFor(map, truth),
      width: W,
      height: H,
      map,
      keyframeIds: [2, 3],
      registeredKeyframe: 3,
      capturedAtEpoch: 1,
    });
    expect(r.keyframeAgreement).not.toBeNull();
    expect(r.keyframeAgreement?.rotationDeg).toBeLessThan(0.2);
    expect(r.keyframeAgreement?.centerRelative).toBeLessThan(0.01);
  });
});
