/**
 * Phases 16 and 20 — the game's state machine, driven over a world the real stages produced.
 *
 * The throws here are aimed the way a player aims: the camera is pointed, the gauge is held for
 * as long as the power needs, and the touch is released. Nothing reaches past the controls.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { GameSession, GameState, LAUNCH_ELEVATION_DEG, POWER_PERIOD_S } from '../../src/game/GameSession';
import { MAX_SPEED_H, MIN_SPEED_H } from '../../src/game/physics';
import type { Stage } from '../../src/game/stage';
import { TrackingState, WorldState } from '../../src/world/SpatialWorld';
import type { SpatialWorldView, WorldPose } from '../../src/world/SpatialWorld';
import { runRoom } from './fixtures/room';

let base: SpatialWorldView;

beforeAll(() => {
  base = runRoom(160).world.view();
  if (base.worldState !== WorldState.READY) throw new Error(base.worldReasons.join('; '));
});

/** The camera turned so that the game's aim — forward lifted by the launch elevation — is `dir`. */
function aimedAt(view: SpatialWorldView, dir: readonly number[]): SpatialWorldView {
  const pose = view.cameraPose;
  if (!pose) throw new Error('no pose');
  const down = view.gravity.worldDown ?? [0, 1, 0];
  const up = down.map((x) => -x);
  const d = unit(dir);
  const c1 = unit(up.map((x, i) => x - dot(up, d) * (d[i] ?? 0)));
  const e = (LAUNCH_ELEVATION_DEG * Math.PI) / 180;
  const f = d.map((x, i) => x * Math.cos(e) - (c1[i] ?? 0) * Math.sin(e));
  const c = d.map((x, i) => x * Math.sin(e) + (c1[i] ?? 0) * Math.cos(e));
  const y = c.map((x) => -x);
  const xAxis = cross(y, f);
  const rotation = [...xAxis, ...y, ...f];
  const center = pose.center;
  const translation = [0, 1, 2].map((i) => -((rotation[i * 3] ?? 0) * (center[0] ?? 0) + (rotation[i * 3 + 1] ?? 0) * (center[1] ?? 0) + (rotation[i * 3 + 2] ?? 0) * (center[2] ?? 0)));
  const aimed: WorldPose = { ...pose, rotation, translation, forward: f };
  return { ...view, cameraPose: aimed };
}

function withTracking(view: SpatialWorldView, state: string): SpatialWorldView {
  return { ...view, trackingState: state as SpatialWorldView['trackingState'] };
}

/** Hold time that brings the triangle gauge to `power` on its rising half. */
function holdFor(power: number): number {
  return (power / 2) * POWER_PERIOD_S * 1000;
}

function powerFor(stage: Stage): number {
  return (stage.solution.speed / stage.unit - MIN_SPEED_H) / (MAX_SPEED_H - MIN_SPEED_H);
}

describe('GameSession', () => {
  it('goes SCAN → STAGE_GENERATING → READY on a READY world, and only through allowed transitions', () => {
    const clock = { t: 0 };
    const game = new GameSession(() => clock.t);
    expect(game.view().state).toBe(GameState.SCAN);
    game.update(base);
    expect(game.view().state).toBe(GameState.READY);
    expect(game.view().stage).not.toBeNull();
    const s = game.stats();
    expect(s.illegalTransitions).toBe(0);
    expect(s.visited).toEqual(expect.arrayContaining([GameState.SCAN, GameState.STAGE_GENERATING, GameState.READY]));
    expect(s.reproductions).toBe(1);
    expect(s.reproductionMismatches).toBe(0);
  });

  it('stays in SPATIALIZING, and generates nothing, while the world is not READY', () => {
    const noGravity = runRoom(120, { gravity: false }).world.view();
    const game = new GameSession(() => 0);
    game.update(noGravity);
    expect(game.view().state).toBe(GameState.SPATIALIZING);
    expect(game.view().stage).toBeNull();
    expect(game.stats().stagesGenerated).toBe(0);
  });

  it('scores when the player aims along the stage’s own solution, and the throw replays exactly', () => {
    const clock = { t: 0 };
    const game = new GameSession(() => clock.t);
    game.update(base);
    const stage = game.view().stage;
    if (!stage) throw new Error('no stage');
    const view = aimedAt(base, stage.solution.velocity);
    game.update(view);
    expect(game.press()).toBe(true);
    clock.t += holdFor(powerFor(stage));
    game.update(view);
    expect(game.view().aimWouldScore).toBe(true);
    expect(game.release()).toBe(true);
    expect(game.view().state).toBe(GameState.THROWING);
    for (let i = 0; i < 600 && game.view().state === GameState.THROWING; i++) {
      clock.t += 16;
      game.update(view);
    }
    expect(game.view().state).toBe(GameState.SUCCESS);
    const t = game.view().lastThrow;
    expect(t?.outcome).toBe('GOAL');
    expect(t?.crossing).not.toBeNull();
    expect(t?.replayMatched).toBe(true);
    expect(t?.energyOk).toBe(true);
    expect(t?.contactsTraced).toBe(true);
    // ...and on to a new stage in the same room.
    clock.t += 3000;
    game.update(view);
    expect([GameState.STAGE_GENERATING, GameState.READY]).toContain(game.view().state);
    const st = game.stats();
    expect(st.cycles).toBe(1);
    // The controls every stage and every goal is checked against.
    expect(st.solutionChecks).toBeGreaterThan(0);
    expect(st.solutionFailures).toBe(0);
    expect(st.stageControls).toBeGreaterThan(0);
    expect(st.stageControlFailures).toBe(0);
    expect(st.rejectionOffered).toBeGreaterThanOrEqual(3);
    expect(st.rejectionAccepted).toEqual([]);
    expect(st.goalControls).toBe(1);
    expect(st.goalControlFailures).toBe(0);
  });

  it('a throw into the floor misses, records its bounces, and the ball returns to the tee', () => {
    const clock = { t: 0 };
    const game = new GameSession(() => clock.t);
    game.update(base);
    const down = base.gravity.worldDown ?? [0, 1, 0];
    // Aimed steeply down: lifted by the elevation it still points at the floor in front.
    const view = aimedAt(base, down.map((x, i) => x + (base.cameraPose?.forward[i] ?? 0) * 0.4));
    game.update(view);
    game.press();
    clock.t += holdFor(0.2);
    game.release();
    for (let i = 0; i < 800 && game.view().state === GameState.THROWING; i++) {
      clock.t += 16;
      game.update(view);
    }
    expect(game.view().state).toBe(GameState.RETRY);
    const t = game.view().lastThrow;
    expect(t?.contacts.length).toBeGreaterThan(0);
    expect(t?.controlDiffers).toBe(true);
    clock.t += 2000;
    game.update(view);
    expect(game.view().state).toBe(GameState.READY);
  });

  it('freezes the ball while tracking is lost, and resumes the same flight when it returns', () => {
    const clock = { t: 0 };
    const game = new GameSession(() => clock.t);
    game.update(base);
    const stage = game.view().stage;
    if (!stage) throw new Error('no stage');
    const view = aimedAt(base, stage.solution.velocity);
    game.update(view);
    game.press();
    clock.t += holdFor(powerFor(stage));
    game.release();
    clock.t += 16;
    game.update(view);
    const lost = withTracking(view, TrackingState.LOST);
    clock.t += 16;
    game.update(lost);
    clock.t += 400;
    game.update(lost);
    expect(game.view().state).toBe(GameState.TRACKING_LOST);
    const frozenAt = game.view().ball;
    for (let i = 0; i < 20; i++) {
      clock.t += 50;
      game.update(lost);
    }
    expect(game.view().ball).toEqual(frozenAt);
    game.update(view);
    expect(game.view().state).toBe(GameState.THROWING);
    for (let i = 0; i < 600 && game.view().state === GameState.THROWING; i++) {
      clock.t += 16;
      game.update(view);
    }
    expect(game.view().state).toBe(GameState.SUCCESS);
    const s = game.stats();
    expect(s.stepsWhileFrozen).toBe(0);
    expect(s.lostEntries).toBe(1);
    expect(s.lostRecoveries).toBe(1);
    expect(s.illegalTransitions).toBe(0);
  });

  it('refuses a throw on a low-confidence pose', () => {
    const game = new GameSession(() => 0);
    game.update(base);
    game.update(withTracking(base, TrackingState.DEGRADED));
    expect(game.press()).toBe(false);
    expect(Object.keys(game.stats().pressesRefused).length).toBe(1);
  });

  it('drops the stage when the world is redefined', () => {
    const run = runRoom(160);
    const game = new GameSession(() => 0);
    game.update(run.world.view());
    expect(game.view().stage).not.toBeNull();
    run.world.ingestMap({ epoch: 2, version: 50, landmarks: [], keyframes: [] });
    game.update(run.world.view());
    expect(game.view().stage).toBeNull();
    expect(game.view().state).toBe(GameState.SCAN);
    expect(game.stats().epochInvalidations).toBe(1);
  });
});

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}
function unit(v: readonly number[]): number[] {
  const n = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  return v.map((x) => x / n);
}
function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

describe('GameSession — resume', () => {
  it('restores progress before the first throw, regenerating the stage at the saved index from the live world', () => {
    const clock = { t: 0 };
    const game = new GameSession(() => clock.t);
    game.update(base);
    const first = game.view().stage;
    expect(first).not.toBeNull();
    expect(game.restoreProgress({ stageIndex: 4, successes: 3, throws: 9 })).toBe(true);
    expect(game.view().stage).toBeNull();
    clock.t += 1000;
    game.update(base);
    const resumed = game.view().stage;
    expect(resumed?.seed).toBe(5);
    expect(resumed?.epoch).toBe(base.epoch);
    expect(game.view().successes).toBe(3);
    expect(game.stats().illegalTransitions).toBe(0);
    // Once is enough: a second resume would merge a third session in.
    expect(game.restoreProgress({ stageIndex: 1, successes: 0, throws: 0 })).toBe(false);
  });
});
