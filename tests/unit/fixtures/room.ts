/**
 * A known room, for the phases that turn a map into a game (11–20).
 *
 * A floor, a back wall, a side wall and a table top, in a gravity-aligned frame with y pointing
 * down and the camera standing 1.4 units above the floor — then tilted by an arbitrary rotation,
 * because the world the landmark map produces is the first keyframe's camera frame, tilted however
 * the phone happened to be held. Every test that uses this checks that the room comes back
 * through the real stages: localization, gravity, surfaces, the world, the stage, the physics.
 */

import { Rng } from '../../../src/core/Rng';
import { intrinsicsFor } from '../../../src/geometry/intrinsics';
import { multiply3x3, transpose3x3 } from '../../../src/geometry/linalg';
import { fromAxisAngle } from '../../../src/geometry/rotation';
import { projectPoint } from '../../../src/geometry/pnp';
import type { CameraPose } from '../../../src/geometry/pnp';
import { deviceToCamera } from '../../../src/mapping/gravity';
import { LandmarkState } from '../../../src/mapping/landmarks';
import type { KeyframePose, Landmark } from '../../../src/mapping/landmarks';
import { LocalizationStage } from '../../../src/tracking/LocalizationStage';
import type { MapReader } from '../../../src/tracking/LocalizationStage';
import { SpatialWorld } from '../../../src/world/SpatialWorld';
import { WorldBuilder } from '../../../src/world/WorldBuilder';
import type { GravityReading } from '../../../src/world/WorldBuilder';

export const W = 640;
export const H = 480;
const K = intrinsicsFor(W, H);
if (!K) throw new Error('intrinsics fixture');
export const INTRINSICS = K;

export const ROOM_TILT = fromAxisAngle([1, 0.3, 0.2], 23);

export function toWorld(p: readonly number[]): number[] {
  return [0, 1, 2].map(
    (r) => (ROOM_TILT[r * 3] ?? 0) * (p[0] ?? 0) + (ROOM_TILT[r * 3 + 1] ?? 0) * (p[1] ?? 0) + (ROOM_TILT[r * 3 + 2] ?? 0) * (p[2] ?? 0),
  );
}

/** Down in the tilted world: the room's +y, carried through the tilt. */
export const ROOM_DOWN = toWorld([0, 1, 0]);

export interface RoomOptions {
  readonly table?: boolean;
  readonly noise?: number;
  readonly seed?: number;
}

/** Room-frame points of each surface, densely enough that the map holds hundreds. */
export function roomPoints(options: RoomOptions = {}): number[][] {
  const rng = new Rng(options.seed ?? 1);
  const noise = options.noise ?? 0.008;
  const j = (): number => (rng.next() - 0.5) * 2 * noise;
  const pts: number[][] = [];
  for (let i = 0; i < 260; i++) pts.push([-2 + rng.next() * 4, 1.4 + j(), 0.8 + rng.next() * 4.2]);
  for (let i = 0; i < 180; i++) pts.push([-2.4 + rng.next() * 4.8, -1 + rng.next() * 2.4, 5 + j()]);
  for (let i = 0; i < 120; i++) pts.push([-2.5 + j(), -1 + rng.next() * 2.4, 0.8 + rng.next() * 4.2]);
  if (options.table ?? true) {
    for (let i = 0; i < 70; i++) pts.push([0.4 + rng.next() * 1.0, 0.7 + j(), 2.6 + rng.next() * 1.0]);
  }
  return pts;
}

export function roomLandmarks(options: RoomOptions = {}): Landmark[] {
  return roomPoints(options).map((p, i) => ({
    id: 1000 + i,
    position: toWorld(p),
    observations: 5,
    keyframes: [1, 2, 3],
    maxParallaxDeg: 5,
    meanPredictionPx: 0.3,
    predictions: 3,
    lastMoveRelative: 0.001,
    confidence: 0.85,
    state: LandmarkState.CONFIRMED,
    epoch: 1,
  }));
}

/** The camera at frame `k`: looking into the room, turning and tilting, 1.4 above the floor. */
export function roomPose(k: number): CameraPose {
  const yaw = Math.sin(k * 0.05) * 22;
  const pitch = 20 + Math.cos(k * 0.037) * 9;
  const centerRoom = [Math.sin(k * 0.031) * 0.3, 0, Math.cos(k * 0.029) * 0.1];
  const inRoom = multiply3x3(fromAxisAngle([1, 0, 0], pitch), fromAxisAngle([0, 1, 0], yaw));
  const rotation = multiply3x3(inRoom, transpose3x3(ROOM_TILT));
  const c = toWorld(centerRoom);
  const translation = [0, 1, 2].map(
    (i) => -((rotation[i * 3] ?? 0) * (c[0] ?? 0) + (rotation[i * 3 + 1] ?? 0) * (c[1] ?? 0) + (rotation[i * 3 + 2] ?? 0) * (c[2] ?? 0)),
  );
  return { rotation, translation };
}

export function mapReaderFor(landmarks: readonly Landmark[], keyframes: Map<number, KeyframePose>, version: () => number = () => 1): MapReader {
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  return {
    landmark: (id) => byId.get(id),
    landmarks: () => landmarks,
    keyframePose: (id) => keyframes.get(id),
    epoch: () => 1,
    version,
  };
}

export function populationFor(map: MapReader, pose: CameraPose, rng: Rng, noisePx = 0.3): { id: number; x0: number; y0: number }[] {
  const out: { id: number; x0: number; y0: number }[] = [];
  for (const l of map.landmarks()) {
    const p = projectPoint(INTRINSICS, pose, l.position);
    if (!p || p.x < 2 || p.y < 2 || p.x > W - 2 || p.y > H - 2) continue;
    out.push({ id: l.id, x0: p.x + (rng.next() - 0.5) * noisePx, y0: p.y + (rng.next() - 0.5) * noisePx });
  }
  return out;
}

/** What the phone's orientation sensor reports as down for this pose, under the given layout. */
export function deviceDownFor(pose: CameraPose, layoutDeg = 0): number[] {
  const camDown = [0, 1, 2].map(
    (r) => (pose.rotation[r * 3] ?? 0) * (ROOM_DOWN[0] ?? 0) + (pose.rotation[r * 3 + 1] ?? 0) * (ROOM_DOWN[1] ?? 0) + (pose.rotation[r * 3 + 2] ?? 0) * (ROOM_DOWN[2] ?? 0),
  );
  const x = deviceToCamera(layoutDeg);
  return [0, 1, 2].map((c) => (x[c] ?? 0) * (camDown[0] ?? 0) + (x[3 + c] ?? 0) * (camDown[1] ?? 0) + (x[6 + c] ?? 0) * (camDown[2] ?? 0));
}

export interface RoomRun {
  readonly world: SpatialWorld;
  readonly builder: WorldBuilder;
  readonly clock: { now: number };
  readonly lastPose: CameraPose;
}

/**
 * Drive the real localization stage and the real world builder over `frames` frames of the room.
 *
 * `gravity: false` withholds the orientation sensor, which is what a phone that refused motion
 * permission looks like.
 */
export function runRoom(frames: number, options: RoomOptions & { gravity?: boolean } = {}): RoomRun {
  const clock = { now: 0 };
  const world = new SpatialWorld(() => clock.now);
  const readings = new Map<number, GravityReading>();
  const builder = new WorldBuilder(
    world,
    (epochMs) => (options.gravity === false ? null : (readings.get(epochMs) ?? null)),
    () => clock.now,
  );
  const landmarks = roomLandmarks(options);
  const keyframes = new Map<number, KeyframePose>([[1, roomPose(0)]]);
  const map = mapReaderFor(landmarks, keyframes);
  const stage = new LocalizationStage();
  const rng = new Rng(options.seed ?? 3);
  let lastPose = roomPose(0);
  for (let k = 0; k < frames; k++) {
    clock.now += 33;
    const pose = roomPose(k);
    lastPose = pose;
    readings.set(k, { down: deviceDownFor(pose), screenAngle: 0, turnRate: 10 });
    const report = stage.process({
      population: populationFor(map, pose, rng),
      width: W,
      height: H,
      map,
      keyframeIds: [1],
      registeredKeyframe: null,
      capturedAtEpoch: k,
    });
    builder.onLocalization(report);
  }
  return { world, builder, clock, lastPose };
}
