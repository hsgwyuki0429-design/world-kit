/**
 * Phase 11 — gravity in the world, and surfaces from landmarks.
 *
 * Every scene here is built from a known room — a floor, a wall, a side wall and a table — then
 * tilted by an arbitrary rotation, because the world the map produces is tilted however the first
 * keyframe happened to be held. The tests check the room comes back, and that the two fakes this
 * phase exists to refuse do not: surfaces from structureless points, and floors without gravity.
 */

import { describe, expect, it } from 'vitest';

import { Rng } from '../../src/core/Rng';
import { multiply3x3, transpose3x3 } from '../../src/geometry/linalg';
import { fromAxisAngle } from '../../src/geometry/rotation';
import {
  GravityAligner,
  GravityState,
  MIN_GRAVITY_SAMPLES,
  deviceToCamera,
} from '../../src/mapping/gravity';
import {
  SurfaceClass,
  assignSurfaceIds,
  extractSurfaces,
  jitteredControl,
} from '../../src/mapping/surfaces';
import type { SurfaceLandmark } from '../../src/mapping/surfaces';

/** The room in a gravity-aligned frame: y is down, the camera stands at the origin. */
function room(rng: Rng, noise = 0.01): number[][] {
  const pts: number[][] = [];
  const jitter = (): number => (rng.next() - 0.5) * 2 * noise;
  for (let i = 0; i < 160; i++) pts.push([-2 + rng.next() * 4, 1.4 + jitter(), 1 + rng.next() * 4]); // floor
  for (let i = 0; i < 120; i++) pts.push([-2 + rng.next() * 4, -1 + rng.next() * 2.4, 5 + jitter()]); // back wall
  for (let i = 0; i < 80; i++) pts.push([-2.5 + jitter(), -1 + rng.next() * 2.4, 1 + rng.next() * 4]); // side wall
  for (let i = 0; i < 50; i++) pts.push([0.5 + rng.next(), 0.7 + jitter(), 2.5 + rng.next()]); // table top
  return pts;
}

const TILT = fromAxisAngle([1, 0.3, 0.2], 23);

function tilted(points: number[][]): SurfaceLandmark[] {
  return points.map((p, i) => ({
    id: 100 + i,
    position: [0, 1, 2].map(
      (r) => (TILT[r * 3] ?? 0) * (p[0] ?? 0) + (TILT[r * 3 + 1] ?? 0) * (p[1] ?? 0) + (TILT[r * 3 + 2] ?? 0) * (p[2] ?? 0),
    ),
    confidence: 0.8,
    confirmed: true,
  }));
}

/** Down, in the tilted world. */
const TRUE_DOWN = [TILT[1] ?? 0, TILT[4] ?? 0, TILT[7] ?? 0];
const CAMERAS = [[0, 0, 0], [0.3, 0.05, 0.1], [-0.2, 0, 0.2]].map((c) =>
  [0, 1, 2].map((r) => (TILT[r * 3] ?? 0) * (c[0] ?? 0) + (TILT[r * 3 + 1] ?? 0) * (c[1] ?? 0) + (TILT[r * 3 + 2] ?? 0) * (c[2] ?? 0)),
);

function angle(a: readonly number[], b: readonly number[]): number {
  const d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

describe('GravityAligner', () => {
  /** Frames looking around the tilted room, and the device-frame down a phone would report. */
  function frames(layoutDeg: number, count: number, sweepDeg: number, noiseDeg: number, seed: number) {
    const rng = new Rng(seed);
    const x = deviceToCamera(layoutDeg);
    return Array.from({ length: count }, (_, k) => {
      const yaw = Math.sin(k * 0.21) * sweepDeg;
      const pitch = Math.cos(k * 0.13) * sweepDeg * 0.5;
      // Camera orientation in the gravity-aligned room, then expressed in the tilted world.
      const inRoom = multiply3x3(fromAxisAngle([1, 0, 0], pitch), fromAxisAngle([0, 1, 0], yaw));
      const rotation = multiply3x3(inRoom, transpose3x3(TILT));
      const camDown = [0, 1, 2].map(
        (r) => (rotation[r * 3] ?? 0) * (TRUE_DOWN[0] ?? 0) + (rotation[r * 3 + 1] ?? 0) * (TRUE_DOWN[1] ?? 0) + (rotation[r * 3 + 2] ?? 0) * (TRUE_DOWN[2] ?? 0),
      );
      // device = Xᵀ · camera, plus a little sensor noise.
      const dev = [0, 1, 2].map((c) => (x[c] ?? 0) * (camDown[0] ?? 0) + (x[3 + c] ?? 0) * (camDown[1] ?? 0) + (x[6 + c] ?? 0) * (camDown[2] ?? 0));
      const n = fromAxisAngle([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5], (rng.next() - 0.5) * 2 * noiseDeg);
      const noisy = [0, 1, 2].map((r) => (n[r * 3] ?? 0) * (dev[0] ?? 0) + (n[r * 3 + 1] ?? 0) * (dev[1] ?? 0) + (n[r * 3 + 2] ?? 0) * (dev[2] ?? 0));
      return { rotation, deviceDown: noisy, screenAngle: 0 };
    });
  }

  it('finds down, and the image layout, when the camera has looked around', () => {
    for (const layout of [0, 90, 180, 270]) {
      const a = new GravityAligner();
      for (const f of frames(layout, 80, 25, 1.0, 3 + layout)) a.add(f);
      const e = a.estimate();
      expect(e.state, e.reason).toBe(GravityState.ESTIMATED);
      expect(e.candidateDeg).toBe(layout);
      expect(angle(e.worldDown ?? [0, 0, 0], TRUE_DOWN)).toBeLessThan(1.5);
    }
  });

  it('stays UNKNOWN when the camera has not turned — every layout fits a single view', () => {
    const a = new GravityAligner();
    for (const f of frames(0, 80, 0.5, 0.5, 9)) a.add(f);
    const e = a.estimate();
    expect(e.state).toBe(GravityState.UNKNOWN);
    expect(e.worldDown).toBeNull();
  });

  it('stays UNKNOWN until it has enough frames', () => {
    const a = new GravityAligner();
    for (const f of frames(0, MIN_GRAVITY_SAMPLES - 1, 25, 0.5, 4)) a.add(f);
    expect(a.estimate().state).toBe(GravityState.UNKNOWN);
  });

  it('refuses when the sensor and the pose describe different motions', () => {
    const a = new GravityAligner();
    const good = frames(0, 80, 25, 0.5, 5);
    // Pair every pose with a down reading from a different frame of the run.
    good.forEach((f, i) => a.add({ ...f, deviceDown: good[(i * 37) % good.length]?.deviceDown ?? f.deviceDown }));
    expect(a.estimate().state).toBe(GravityState.UNKNOWN);
  });
});

describe('extractSurfaces', () => {
  it('recovers the floor, the walls and the table, and classifies them against gravity', () => {
    const lm = tilted(room(new Rng(1)));
    const r = extractSurfaces({ landmarks: lm, cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 42 });
    const classes = r.surfaces.map((s) => s.surfaceClass);
    expect(classes.filter((c) => c === SurfaceClass.GROUND).length).toBe(1);
    expect(classes.filter((c) => c === SurfaceClass.PLATFORM).length).toBe(1);
    expect(classes.filter((c) => c === SurfaceClass.WALL).length).toBe(2);
    const ground = r.surfaces.find((s) => s.surfaceClass === SurfaceClass.GROUND);
    expect(ground?.support).toBeGreaterThan(140);
    // The ground faces up.
    expect(angle(ground?.normal ?? [0, 0, 0], TRUE_DOWN.map((v) => -v))).toBeLessThan(2);
    // Camera height above the floor, in the room's units.
    expect(r.cameraHeight).toBeGreaterThan(1.3);
    expect(r.cameraHeight).toBeLessThan(1.5);
    const table = r.surfaces.find((s) => s.surfaceClass === SurfaceClass.PLATFORM);
    expect(table?.heightAboveGround).toBeGreaterThan(0.6);
    expect(table?.heightAboveGround).toBeLessThan(0.8);
  });

  it('is reproducible: the same map and seed give the same surfaces', () => {
    const lm = tilted(room(new Rng(2)));
    const a = extractSurfaces({ landmarks: lm, cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 7 });
    const b = extractSurfaces({ landmarks: lm, cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('classifies nothing without gravity — PLANE: UNKNOWN', () => {
    const lm = tilted(room(new Rng(3)));
    const r = extractSurfaces({ landmarks: lm, cameraCenters: CAMERAS, worldDown: null, seed: 1 });
    expect(r.surfaces.length).toBeGreaterThan(0);
    expect(r.surfaces.every((s) => s.surfaceClass === SurfaceClass.UNKNOWN)).toBe(true);
    expect(r.cameraHeight).toBe(-1);
  });

  it('finds far less in the jittered control than in the room', () => {
    const lm = tilted(room(new Rng(4)));
    const real = extractSurfaces({ landmarks: lm, cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 5 });
    const control = extractSurfaces({
      landmarks: jitteredControl(lm, real.sceneDepth, 99),
      cameraCenters: CAMERAS,
      worldDown: TRUE_DOWN,
      seed: 5,
    });
    const best = (s: typeof real): number => s.surfaces.reduce((a, x) => Math.max(a, x.support), 0);
    expect(best(control)).toBeLessThan(0.3 * best(real));
    // ...and what it does find fills its band the way a slice of a cloud does, not the way a plane does.
    const realResidual = Math.max(...real.surfaces.map((x) => x.residual));
    expect(control.surfaces.every((x) => x.residual > 2 * realResidual)).toBe(true);
  });

  it('does not join two tables at the same height into one surface', () => {
    const rng = new Rng(6);
    const pts: number[][] = [];
    for (let i = 0; i < 60; i++) pts.push([-2 + rng.next(), 0.7, 2 + rng.next()]);
    for (let i = 0; i < 60; i++) pts.push([1.5 + rng.next(), 0.7, 2 + rng.next()]);
    const r = extractSurfaces({ landmarks: tilted(pts), cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 2 });
    expect(r.surfaces.length).toBe(2);
    expect(r.surfaces.every((s) => s.support === 60)).toBe(true);
  });

  it('keeps a surface’s id when the next extraction finds it again', () => {
    const rng = new Rng(8);
    const pts = room(rng);
    const first = extractSurfaces({ landmarks: tilted(pts), cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 3 });
    const a = assignSurfaceIds([], first.surfaces, first.sceneDepth, 1);
    const more = pts.concat(room(new Rng(9)).slice(0, 60));
    const second = extractSurfaces({ landmarks: tilted(more), cameraCenters: CAMERAS, worldDown: TRUE_DOWN, seed: 3 });
    const b = assignSurfaceIds(a.surfaces, second.surfaces, second.sceneDepth, a.nextId);
    expect(b.persisted).toBe(a.surfaces.length);
    const groundA = a.surfaces.find((s) => s.surfaceClass === SurfaceClass.GROUND);
    const groundB = b.surfaces.find((s) => s.surfaceClass === SurfaceClass.GROUND);
    expect(groundB?.id).toBe(groundA?.id);
  });
});
