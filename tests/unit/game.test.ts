/**
 * Phases 15, 17, 18 and 19 — collision, the stage, the ring and the ball, on the known room.
 *
 * The world here is the one the real localization stage and the real world builder produced from
 * the room fixture, so every surface the ball touches went through the same path a device's would.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { buildCollisionSet, insideHull } from '../../src/game/collision';
import {
  BALL_RADIUS_H,
  FlightOutcome,
  GRAVITY_H,
  simulateThrow,
} from '../../src/game/physics';
import type { PhysicsWorld } from '../../src/game/physics';
import { RING_RADIUS_H, RingKind, goalDiscOf, validateRing } from '../../src/game/ring';
import type { GoalRing, RingContext } from '../../src/game/ring';
import { generateStage, revalidateStage, stageInputsFrom } from '../../src/game/stage';
import { SurfaceClass, WorldState } from '../../src/world/SpatialWorld';
import type { SpatialWorldView } from '../../src/world/SpatialWorld';
import { runRoom } from './fixtures/room';

let view: SpatialWorldView;
let physics: PhysicsWorld;

beforeAll(() => {
  view = runRoom(160).world.view();
  if (view.worldState !== WorldState.READY) throw new Error(`fixture world not READY: ${view.worldReasons.join('; ')}`);
  physics = { unit: view.cameraHeight, down: view.gravity.worldDown ?? [0, 1, 0], collision: buildCollisionSet(view) };
});

function groundOf(v: SpatialWorldView) {
  const g = v.surfaces.find((s) => s.surfaceClass === SurfaceClass.GROUND);
  if (!g) throw new Error('no ground');
  return g;
}

function above(point: readonly number[], h: number): number[] {
  return point.map((x, i) => x - (physics.down[i] ?? 0) * h);
}

describe('collision', () => {
  it('collides only with classified, confident surfaces, each carrying its provenance', () => {
    const set = buildCollisionSet(view);
    expect(set.surfaces.length).toBeGreaterThan(0);
    for (const s of set.surfaces) {
      expect(s.surfaceClass).not.toBe(SurfaceClass.UNKNOWN);
      const source = view.surfaces.find((x) => x.id === s.provenance.surfaceId);
      expect(source).toBeDefined();
      expect(s.provenance.epoch).toBe(view.epoch);
    }
  });

  it('has nothing to collide with in a world without gravity', () => {
    const noGravity = runRoom(160, { gravity: false }).world.view();
    const set = buildCollisionSet(noGravity);
    expect(set.surfaces.length).toBe(0);
    expect(set.excluded.length).toBe(noGravity.surfaces.length);
  });
});

describe('ball physics', () => {
  it('bounces on the observed ground, loses energy at every bounce, and comes to rest', () => {
    const g = groundOf(view);
    const u = physics.unit;
    const flight = simulateThrow(physics, above(g.centroid, 0.8 * u), [0, 0, 0], null);
    expect(flight.contacts.length).toBeGreaterThan(1);
    expect(flight.contacts.every((c) => c.surfaceId === g.id)).toBe(true);
    expect(flight.outcome).toBe(FlightOutcome.REST);
    const tolerance = 0.01 * GRAVITY_H * u * u;
    let previous = flight.energyStart;
    for (const e of flight.energyAfterContacts) {
      expect(e).toBeLessThanOrEqual(previous + tolerance);
      previous = e;
    }
    // At rest one radius above the floor, not sunk into it and not floating.
    const d = (g.normal[0] ?? 0) * (flight.final.position[0] ?? 0) + (g.normal[1] ?? 0) * (flight.final.position[1] ?? 0) + (g.normal[2] ?? 0) * (flight.final.position[2] ?? 0) - g.offset;
    expect(Math.abs(d - BALL_RADIUS_H * u)).toBeLessThan(0.01 * u);
  });

  it('falls through where nothing was observed — no fake floor', () => {
    const g = groundOf(view);
    const u = physics.unit;
    // Far outside the observed hull of anything.
    const away = g.centroid.map((x, i) => x + 40 * u * (g.basisU[i] ?? 0));
    const flight = simulateThrow(physics, above(away, 0.5 * u), [0, 0, 0], null);
    expect(flight.contacts.length).toBe(0);
    expect(flight.outcome).toBe(FlightOutcome.FELL);
  });

  it('is deterministic: the same throw into the same world is the same flight', () => {
    const g = groundOf(view);
    const u = physics.unit;
    const origin = above(g.centroid, 1.0 * u);
    const v = g.basisU.map((x, i) => x * 2 * u - (physics.down[i] ?? 0) * 1.5 * u);
    const a = simulateThrow(physics, origin, v, null);
    const b = simulateThrow(physics, origin, v, null);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('goal ring', () => {
  function ctxFor(): RingContext {
    const inputs = stageInputsFrom(view);
    if (!inputs) throw new Error('inputs');
    const up = physics.down.map((x) => -x);
    const flat = inputs.viewerForward.map((x, i) => x - ((inputs.viewerForward[0] ?? 0) * (up[0] ?? 0) + (inputs.viewerForward[1] ?? 0) * (up[1] ?? 0) + (inputs.viewerForward[2] ?? 0) * (up[2] ?? 0)) * (up[i] ?? 0));
    const n = Math.hypot(...flat);
    const start = inputs.viewer.map((x, i) => x + ((flat[i] ?? 0) / n) * 0.5 * physics.unit - (up[i] ?? 0) * 0.25 * physics.unit);
    return {
      physics,
      start,
      viewer: inputs.viewer,
      viewerForward: inputs.viewerForward,
      surfaces: view.surfaces.map((s) => ({ id: s.id, confidence: s.confidence, surfaceClass: s.surfaceClass })),
      landmarks: inputs.landmarks,
    };
  }

  it('rejects a ring embedded in the wall', () => {
    const wall = view.surfaces.find((s) => s.surfaceClass === SurfaceClass.WALL && s.support > 150);
    if (!wall) throw new Error('no back wall');
    const ring: GoalRing = {
      kind: RingKind.WALL_TARGET,
      center: wall.centroid,
      axis: wall.normal.map((x) => -x),
      radius: RING_RADIUS_H * physics.unit,
      supportSurfaceId: wall.id,
      supportClass: wall.surfaceClass,
      standoff: 0,
    };
    const v = validateRing(ring, ctxFor());
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('EMBEDDED');
  });

  it('rejects a ring over a part of the floor nobody observed', () => {
    const g = groundOf(view);
    const off = g.centroid.map((x, i) => x + 30 * physics.unit * (g.basisU[i] ?? 0));
    const ring: GoalRing = {
      kind: RingKind.HOOP,
      center: above(off, 0.4 * physics.unit),
      axis: physics.down,
      radius: RING_RADIUS_H * physics.unit,
      supportSurfaceId: g.id,
      supportClass: g.surfaceClass,
      standoff: 0.4 * physics.unit,
    };
    const v = validateRing(ring, ctxFor());
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('SUPPORT');
  });

  it('rejects a ring whose opening has observed landmarks in it — something real is there', () => {
    const table = view.surfaces.find((s) => s.surfaceClass === SurfaceClass.PLATFORM);
    if (!table) throw new Error('no table');
    // Centred on the table top itself, axis along gravity: the table's landmarks fill the opening.
    const ring: GoalRing = {
      kind: RingKind.HOOP,
      center: table.centroid,
      axis: physics.down,
      radius: RING_RADIUS_H * physics.unit,
      supportSurfaceId: table.id,
      supportClass: table.surfaceClass,
      standoff: 0,
    };
    const v = validateRing(ring, ctxFor());
    expect(v.valid).toBe(false);
    expect(v.failures).toEqual(expect.arrayContaining(['OCCUPIED']));
  });

  it('counts a goal only when the ball passes through the opening in the ring’s direction', () => {
    const g = groundOf(view);
    const u = physics.unit;
    const center = above(g.centroid, 0.4 * u);
    const ring: GoalRing = {
      kind: RingKind.HOOP, center, axis: physics.down, radius: RING_RADIUS_H * u,
      supportSurfaceId: g.id, supportClass: g.surfaceClass, standoff: 0.4 * u,
    };
    const disc = goalDiscOf(ring, u);
    const through = simulateThrow(physics, above(g.centroid, 1.2 * u), [0, 0, 0], disc);
    expect(through.outcome).toBe(FlightOutcome.GOAL);
    expect(through.crossing?.offAxis).toBeLessThan(disc.radius);
    // Dropped beside it: no goal, whatever else happens.
    const beside = g.centroid.map((x, i) => x + 0.5 * u * (g.basisU[i] ?? 0));
    const miss = simulateThrow(physics, above(beside, 1.2 * u), [0, 0, 0], disc);
    expect(miss.outcome).not.toBe(FlightOutcome.GOAL);
    // Thrown up through it from below and away: it passes the opening the wrong way and lands
    // elsewhere, so it never scores.
    const upward = physics.down.map((x, i) => -x * 2.5 * u + (g.basisU[i] ?? 0) * 1.0 * u);
    const up = simulateThrow(physics, above(g.centroid, 0.2 * u), upward, disc);
    expect(up.path.some((p) => {
      const d = p.map((x, i) => x - (center[i] ?? 0));
      return (d[0] ?? 0) * (physics.down[0] ?? 0) + (d[1] ?? 0) * (physics.down[1] ?? 0) + (d[2] ?? 0) * (physics.down[2] ?? 0) < 0;
    })).toBe(true);
    expect(up.crossing).toBeNull();
  });
});

describe('stage generator', () => {
  it('builds a stage from the observed room whose own solution scores when replayed', () => {
    const r = generateStage(view, 1);
    expect(r.stage, r.reason).not.toBeNull();
    const stage = r.stage;
    if (!stage) return;
    expect(stage.start.kind).toBe('VIRTUAL');
    expect(view.surfaces.some((s) => s.id === stage.ring.supportSurfaceId)).toBe(true);
    const flight = simulateThrow(physics, stage.start.position, stage.solution.velocity, goalDiscOf(stage.ring, stage.unit));
    expect(flight.outcome).toBe(FlightOutcome.GOAL);
    expect(['EASY', 'NORMAL', 'HARD', 'EXPERT']).toContain(stage.difficulty.difficulty);
    const support = physics.collision.surfaces.find((s) => s.id === stage.ring.supportSurfaceId);
    if (support && stage.ring.kind === RingKind.HOOP) expect(insideHull(support, stage.ring.center)).toBe(true);
  });

  it('is reproducible: the same world and seed give the same stage, digest for digest', () => {
    const a = generateStage(view, 7);
    const b = generateStage(view, 7);
    expect(a.stage?.digest).toBeDefined();
    expect(JSON.stringify(a.stage)).toBe(JSON.stringify(b.stage));
  });

  it('depends on the room: a different room gives a different stage', () => {
    const other = runRoom(160, { table: false, seed: 5 }).world.view();
    const a = generateStage(view, 3);
    const b = generateStage(other, 3);
    expect(a.inputDigest).not.toBe(b.inputDigest);
    expect(a.stage?.digest).not.toBe(b.stage?.digest);
  });

  it('refuses to generate in a world that is not READY', () => {
    const noGravity = runRoom(120, { gravity: false }).world.view();
    expect(generateStage(noGravity, 1).stage).toBeNull();
  });

  it('keeps a stage that is still valid, and invalidates it when the world is redefined', () => {
    const r = generateStage(view, 2);
    if (!r.stage) throw new Error(r.reason);
    expect(revalidateStage(r.stage, view).valid).toBe(true);
    expect(revalidateStage({ ...r.stage, epoch: r.stage.epoch + 1 }, view).valid).toBe(false);
  });
});
