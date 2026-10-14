/**
 * Phase 12 — the SpatialWorld, fed by the real localization stage and the real world builder.
 */

import { describe, expect, it } from 'vitest';

import { GravityState } from '../../src/mapping/gravity';
import { SurfaceClass } from '../../src/mapping/surfaces';
import {
  MAX_POSE_HISTORY,
  POSE_STALE_MS,
  SpatialWorld,
  TrackingState,
  WorldState,
} from '../../src/world/SpatialWorld';
import { ROOM_DOWN, runRoom } from './fixtures/room';

function angle(a: readonly number[], b: readonly number[]): number {
  const d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

describe('SpatialWorld fed by the real stages', () => {
  it('reaches READY on the room: localized, gravity measured, a ground found', () => {
    const run = runRoom(160);
    const v = run.world.view();
    expect(v.worldReasons).toEqual([]);
    expect(v.worldState).toBe(WorldState.READY);
    expect(v.trackingState).toBe(TrackingState.GOOD);
    expect(v.gravity.state).toBe(GravityState.ESTIMATED);
    expect(angle(v.gravity.worldDown ?? [0, 0, 0], ROOM_DOWN)).toBeLessThan(1.5);
    const ground = v.surfaces.find((s) => s.surfaceClass === SurfaceClass.GROUND);
    expect(ground).toBeDefined();
    expect(v.cameraHeight).toBeGreaterThan(1.25);
    expect(v.cameraHeight).toBeLessThan(1.55);
    expect(v.readyArea).toBeGreaterThan(0);
    expect(v.coverage).toBeGreaterThan(0);
    const s = run.builder.stats();
    expect(s.readyViolations).toBe(0);
    expect(s.provenanceViolations).toBe(0);
    expect(s.unclassifiedViolations).toBe(0);
    expect(s.medianErrorPx).toBeLessThan(0.5);
    expect(s.heldOutSamples).toBeGreaterThan(0);
    expect(s.persistenceFound).toBeGreaterThan(0);
    expect(s.controlRuns).toBeGreaterThan(0);
    expect(s.medianControlRatio).toBeLessThan(0.3);
  });

  it('pairs only poses the world would call GOOD with the orientation sensor', () => {
    // A pose the localization is itself unsure of carries its error straight into the estimate of
    // down; on a hand-held feed such frames kept the right layout's spread at 4–5° and the
    // estimate under its bar for over a minute.
    const run = runRoom(40);
    const before = run.builder.stats();
    const confident = before.pairings;
    expect(confident).toBeGreaterThan(0);
    const unsure = {
      frames: 1, localizedFrames: 1, state: 'LOCALIZED', reason: '', epoch: 1, mapVersion: 1, mapLandmarks: 100,
      pose: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] }, cameraCenter: [0, 0, 0],
      correspondences: 30, inliers: 14, medianErrorPx: 1.5, heldOutPx: -1, heldOutPoints: 0, startedFrom: 'PREVIOUS',
      keyframeAgreement: null, medianDepth: 3, confidence: 0.25, confidenceTerms: [], capturedAtEpoch: 3,
      width: 640, height: 480, projectionSamples: [], snapshot: null, localizationMs: 1,
      relinked: 0, relinkedTotal: 0, recovered: false, recoveredTotal: 0,
    } as unknown as Parameters<typeof run.builder.onLocalization>[0];
    run.builder.onLocalization(unsure);
    const after = run.builder.stats();
    expect(after.pairings).toBe(confident);
    expect(after.pairingsRefused['LOW_CONFIDENCE']).toBe(1);
  });

  it('never reaches READY without the orientation sensor — every surface stays UNKNOWN', () => {
    const run = runRoom(160, { gravity: false });
    const v = run.world.view();
    expect(v.worldState).toBe(WorldState.NOT_READY);
    expect(v.gravity.state).toBe(GravityState.UNKNOWN);
    expect(v.surfaces.length).toBeGreaterThan(0);
    expect(v.surfaces.every((x) => x.surfaceClass === SurfaceClass.UNKNOWN)).toBe(true);
    expect(v.worldReasons.some((r) => r.startsWith('GRAVITY UNKNOWN'))).toBe(true);
  });

  it('reads LOST when poses stop arriving, and drops the pose rather than serving a stale one', () => {
    const run = runRoom(160);
    run.clock.now += POSE_STALE_MS + 1;
    const v = run.world.view();
    expect(v.trackingState).toBe(TrackingState.LOST);
    expect(v.cameraPose).toBeNull();
    expect(v.worldState).toBe(WorldState.NOT_READY);
  });

  it('serves a frozen view that a consumer cannot write through', () => {
    const run = runRoom(60);
    const v = run.world.view();
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.surfaces)).toBe(true);
    expect(() => {
      (v as unknown as { worldState: string }).worldState = 'READY';
    }).toThrow();
  });

  it('refuses a non-finite ingest and says INVALID', () => {
    const world = new SpatialWorld(() => 0);
    world.ingestMap({ epoch: 1, version: 1, landmarks: [{ id: 1, position: [NaN, 0, 1], confidence: 1, observations: 3, confirmed: true }], keyframes: [] });
    const v = world.view();
    expect(v.worldState).toBe(WorldState.INVALID);
    expect(v.integrityIssues).toBe(1);
    expect(v.landmarks.length).toBe(0);
  });

  it('drops everything from the old epoch when the map redefines its world', () => {
    const run = runRoom(160);
    expect(run.world.view().surfaces.length).toBeGreaterThan(0);
    run.world.ingestMap({ epoch: 2, version: 99, landmarks: [], keyframes: [] });
    const v = run.world.view();
    expect(v.epoch).toBe(2);
    expect(v.surfaces.length).toBe(0);
    expect(v.gravity.state).toBe(GravityState.UNKNOWN);
    expect(v.cameraPose).toBeNull();
    expect(run.world.epochChangeCount()).toBe(1);
  });

  it('bounds the pose history', () => {
    const run = runRoom(MAX_POSE_HISTORY + 40);
    expect(run.world.view().cameraHistory.length).toBe(MAX_POSE_HISTORY);
  });
});
