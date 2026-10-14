/**
 * Phase 12 on a phone in a hand: tracks break, and the camera must not be lost for it.
 *
 * A landmark is known to the map only by the id of the track that made it. On the device every
 * blur and glance away breaks tracks, and the point comes back under a new id. These tests break
 * tracks on purpose — by giving the points fresh ids, which is exactly what the tracker does — and
 * check that the stage finds the landmarks again, never finds the wrong ones, and that the world
 * holds a pose over a refused frame instead of reporting the camera lost.
 */

import { describe, expect, it } from 'vitest';

import { Rng } from '../../src/core/Rng';
import { multiply3x3 } from '../../src/geometry/linalg';
import { fromAxisAngle } from '../../src/geometry/rotation';
import type { CameraPose } from '../../src/geometry/pnp';
import { LandmarkState } from '../../src/mapping/landmarks';
import type { KeyframePose } from '../../src/mapping/landmarks';
import { FlowTracker } from '../../src/tracking/FlowTracker';
import type { TrackedFeature } from '../../src/tracking/FlowTracker';
import { LocalizationStage, LocalizationState } from '../../src/tracking/LocalizationStage';
import type { MapReader } from '../../src/tracking/LocalizationStage';
import { MIN_LOCALIZATION_INLIERS, RELINK_CONFIRM_FRAMES } from '../../src/tracking/LocalizationStage';
import { projectPoint } from '../../src/geometry/pnp';
import { POSE_STALE_MS, TrackingState, WorldState } from '../../src/world/SpatialWorld';
import { H, INTRINSICS, W, mapReaderFor, populationFor, roomLandmarks, roomPoints, roomPose, runRoom, toWorld } from './fixtures/room';

type Point = { id: number; x0: number; y0: number };

const FRESH = 900_000;

function setup(): { map: MapReader; stage: LocalizationStage } {
  const landmarks = roomLandmarks();
  const keyframes = new Map<number, KeyframePose>([[1, roomPose(0)]]);
  return { map: mapReaderFor(landmarks, keyframes), stage: new LocalizationStage() };
}

function solve(stage: LocalizationStage, map: MapReader, population: readonly Point[], frame = 0) {
  return stage.process({ population, width: W, height: H, map, keyframeIds: [1], registeredKeyframe: null, capturedAtEpoch: frame });
}

/**
 * A new id for every `every`-th landmark's point, as a broken track's point gets when it is
 * detected again — the same new id on every frame, as the tracker would keep it.
 */
function broken(population: readonly Point[], every = 1): { population: Point[]; truth: Map<number, number> } {
  const truth = new Map<number, number>();
  const out = population.map((p) => {
    if (p.id % every !== 0) return p;
    const id = FRESH + p.id;
    truth.set(id, p.id);
    return { ...p, id };
  });
  return { population: out, truth };
}

/** The camera turned by `deg` about its own vertical axis. */
function turned(pose: CameraPose, deg: number): CameraPose {
  const r = fromAxisAngle([0, 1, 0], deg);
  return { rotation: multiply3x3(r, pose.rotation), translation: [0, 1, 2].map((i) => (r[i * 3] ?? 0) * (pose.translation[0] ?? 0) + (r[i * 3 + 1] ?? 0) * (pose.translation[1] ?? 0) + (r[i * 3 + 2] ?? 0) * (pose.translation[2] ?? 0)) };
}

describe('re-linking under an accepted pose', () => {
  it('gives broken tracks their landmarks back once they have held for the confirmation frames', () => {
    const { map, stage } = setup();
    const rng = new Rng(5);
    let pairs: readonly (readonly [number, number])[] = [];
    let truth = new Map<number, number>();
    for (let f = 0; f < RELINK_CONFIRM_FRAMES; f++) {
      const b = broken(populationFor(map, roomPose(10 + f), rng), 2);
      truth = b.truth;
      const report = solve(stage, map, b.population, f);
      expect(report.state).toBe(LocalizationState.LOCALIZED);
      pairs = stage.takeRelabels();
      expect(report.relinked).toBe(pairs.length);
      if (f < RELINK_CONFIRM_FRAMES - 1) expect(pairs).toEqual([]);
    }
    expect(pairs.filter(([from, to]) => truth.get(from) !== to)).toEqual([]);
    expect(pairs.length).toBeGreaterThan(0.8 * truth.size);
  });

  it('re-links nothing on a refused frame', () => {
    const { map, stage } = setup();
    const rng = new Rng(6);
    // Nine of every ten points thrown 10–30 px in random directions: under the share bar, and no
    // pose fits what is left.
    const pop = populationFor(map, roomPose(10), rng).map((p, i) => {
      if (i % 10 === 0) return p;
      const a = rng.next() * 2 * Math.PI;
      const d = 10 + rng.next() * 20;
      return { ...p, x0: p.x0 + d * Math.cos(a), y0: p.y0 + d * Math.sin(a) };
    });
    const { population } = broken(pop, 3);
    for (let f = 0; f < RELINK_CONFIRM_FRAMES + 1; f++) {
      const report = solve(stage, map, population, f);
      expect(report.state).not.toBe(LocalizationState.LOCALIZED);
      expect(stage.takeRelabels()).toEqual([]);
    }
  });

  it('rarely mistakes a point the map never held for a landmark, as the camera moves', () => {
    const { map, stage } = setup();
    const rng = new Rng(11);
    // A second room's worth of points nobody mapped, tracked alongside the map's own.
    const unmapped = roomPoints({ seed: 77 }).map((p) => toWorld(p));
    const pairs: (readonly [number, number])[] = [];
    let truth = new Map<number, number>();
    for (let f = 0; f < 30; f++) {
      const pose = roomPose(10 + f * 0.7);
      const b = broken(populationFor(map, pose, rng), 2);
      truth = new Map([...truth, ...b.truth]);
      const others: Point[] = [];
      unmapped.forEach((w, i) => {
        const q = projectPoint(INTRINSICS, pose, w);
        if (q && q.x > 2 && q.y > 2 && q.x < W - 2 && q.y < H - 2) others.push({ id: FRESH * 2 + i, x0: q.x, y0: q.y });
      });
      const report = solve(stage, map, [...b.population, ...others], f);
      expect(report.state).toBe(LocalizationState.LOCALIZED);
      pairs.push(...stage.takeRelabels());
    }
    const wrong = pairs.filter(([from, to]) => truth.get(from) !== to);
    // Measured: see docs/phase12/TEST-PLAN.md, amendment 2.
    expect(pairs.length).toBeGreaterThan(100);
    expect(wrong.length / pairs.length).toBeLessThan(0.02);
    console.log(`[relink] ${pairs.length} re-link(s), ${wrong.length} wrong`);
  });
});

describe('recovery when every track the map knew has broken', () => {
  it('finds the camera again after a turn, through the last accepted pose', () => {
    const { map, stage } = setup();
    const rng = new Rng(7);
    const before = roomPose(10);
    expect(solve(stage, map, populationFor(map, before, rng), 1).state).toBe(LocalizationState.LOCALIZED);

    for (const deg of [2, -4, 7]) {
      const after = turned(before, deg);
      const { population, truth } = broken(populationFor(map, after, rng));
      const report = solve(stage, map, population, 2);
      expect(report.state, `after a ${deg}° turn: ${report.reason}`).toBe(LocalizationState.LOCALIZED);
      expect(report.recovered).toBe(true);
      const pairs = stage.takeRelabels();
      expect(pairs.filter(([from, to]) => truth.get(from) !== to)).toEqual([]);
      // Enough to carry the next frame on its own; the rest come back through ordinary
      // re-linking over the next `RELINK_CONFIRM_FRAMES`.
      expect(pairs.length).toBeGreaterThanOrEqual(2 * MIN_LOCALIZATION_INLIERS);

      // The tracker carries the landmark ids from here on: the next frame is an ordinary one.
      const relabel = new Map(pairs.map(([a, b]) => [a, b]));
      const next = population.map((p) => ({ ...p, id: relabel.get(p.id) ?? p.id }));
      const again = solve(stage, map, next, 3);
      expect(again.state).toBe(LocalizationState.LOCALIZED);
      expect(again.recovered).toBe(false);
      // Back to the starting view for the next turn.
      expect(solve(stage, map, populationFor(map, before, rng), 4).state).toBe(LocalizationState.LOCALIZED);
    }
    expect(stage.process({ population: [], width: W, height: H, map, keyframeIds: [1], registeredKeyframe: null, capturedAtEpoch: 9 }).recoveredTotal).toBe(3);
  });

  it('keeps the last pose through frames that fail, and recovers when the camera comes back', () => {
    const { map, stage } = setup();
    const rng = new Rng(8);
    const before = roomPose(10);
    expect(solve(stage, map, populationFor(map, before, rng)).state).toBe(LocalizationState.LOCALIZED);
    // Looking far away: nothing the map holds is in view, and the points there are new.
    const away = broken(populationFor(map, turned(before, 60), rng)).population;
    for (let i = 0; i < 5; i++) expect(solve(stage, map, away).state).not.toBe(LocalizationState.LOCALIZED);
    // Back, with every track new.
    const { population, truth } = broken(populationFor(map, turned(before, 1), rng));
    const report = solve(stage, map, population);
    expect(report.state).toBe(LocalizationState.LOCALIZED);
    expect(stage.takeRelabels().filter(([from, to]) => truth.get(from) !== to)).toEqual([]);
  });

  it('recovers a young map whose landmarks are all still candidates', () => {
    // The first version re-linked only confirmed landmarks, so a world that had just been
    // (re)defined — every landmark a candidate — could not recover from the dropout that made it
    // young, and was redefined again and again.
    const landmarks = roomLandmarks().map((l) => ({ ...l, state: LandmarkState.CANDIDATE, observations: 2 }));
    const keyframes = new Map<number, KeyframePose>([[1, roomPose(0)]]);
    const map = mapReaderFor(landmarks, keyframes);
    const stage = new LocalizationStage();
    const rng = new Rng(12);
    const before = roomPose(10);
    expect(solve(stage, map, populationFor(map, before, rng), 1).state).toBe(LocalizationState.LOCALIZED);
    const { population, truth } = broken(populationFor(map, turned(before, 3), rng));
    const report = solve(stage, map, population, 2);
    expect(report.state, report.reason).toBe(LocalizationState.LOCALIZED);
    expect(report.recovered).toBe(true);
    expect(stage.takeRelabels().filter(([from, to]) => truth.get(from) !== to)).toEqual([]);
  });

  it('recovers on a large map, where chance pairs crowd the vote', () => {
    // The first version trusted one vote peak that had to stand three times above the mean bin.
    // On a few hundred landmarks that held; on a map this size the chance votes near the true
    // shift come close to the true ones, and recovery failed at the third or fourth dropout of
    // every rough-feed run, after which the world was redefined.
    const second = roomLandmarks({ seed: 9 }).map((l) => ({ ...l, id: l.id + 5000 }));
    const landmarks = [...roomLandmarks(), ...second, ...roomLandmarks({ seed: 21 }).map((l) => ({ ...l, id: l.id + 9000 }))];
    expect(landmarks.length).toBeGreaterThan(1800);
    const map = mapReaderFor(landmarks, new Map<number, KeyframePose>([[1, roomPose(0)]]));
    const stage = new LocalizationStage();
    const rng = new Rng(14);
    const before = roomPose(10);
    expect(solve(stage, map, populationFor(map, before, rng), 1).state).toBe(LocalizationState.LOCALIZED);
    for (const deg of [2, -3, 5, -6]) {
      // After a dropout only some corners are found again, and the points are noisier.
      const seen = populationFor(map, turned(before, deg), rng, 0.8).filter((_, i) => i % 2 === 0);
      const { population, truth } = broken(seen);
      const report = solve(stage, map, population, 2);
      expect(report.state, `after a ${deg}° turn on ${landmarks.length} landmarks: ${report.reason}`).toBe(LocalizationState.LOCALIZED);
      expect(report.recovered).toBe(true);
      expect(stage.takeRelabels().filter(([from, to]) => truth.get(from) !== to)).toEqual([]);
      expect(solve(stage, map, populationFor(map, before, rng), 3).state).toBe(LocalizationState.LOCALIZED);
    }
  });

  it('follows a fast turn with most of the tracks wrong', () => {
    // A hand-held turn of 8–10° in one processed frame, and the tracks that survive it include
    // many the tracker has lost: six in ten points are thrown 15–60 px. The solve starts from the
    // last pose turned by the median image shift, so it does not settle on the few points that
    // happen to agree with the old pose; and four in ten agreeing is enough, because a hundred
    // points landing within 3 px of their prediction under a wrong pose does not happen by chance.
    const { map, stage } = setup();
    const rng = new Rng(15);
    const before = roomPose(10);
    expect(solve(stage, map, populationFor(map, before, rng), 1).state).toBe(LocalizationState.LOCALIZED);
    for (const deg of [9, -8, 10]) {
      const pop = populationFor(map, turned(before, deg), rng, 0.6).map((p, i) => {
        if (i % 5 >= 3) return p;
        const a = rng.next() * 2 * Math.PI;
        const d = 15 + rng.next() * 45;
        return { ...p, x0: p.x0 + d * Math.cos(a), y0: p.y0 + d * Math.sin(a) };
      });
      const report = solve(stage, map, pop, 2);
      expect(report.state, `after a ${deg}° turn: ${report.reason}`).toBe(LocalizationState.LOCALIZED);
      expect(report.medianErrorPx).toBeLessThan(1.5);
      // Back to the start for the next turn.
      expect(solve(stage, map, populationFor(map, before, rng), 3).state).toBe(LocalizationState.LOCALIZED);
    }
  });

  it('says whether the camera was placed in this world recently', () => {
    const { map, stage } = setup();
    expect(stage.localizedWithin(3000, 1)).toBe(false);
    solve(stage, map, populationFor(map, roomPose(10), new Rng(13)), 1);
    expect(stage.localizedWithin(3000, 1)).toBe(true);
    expect(stage.localizedWithin(3000, 2)).toBe(false);
    stage.reset();
    expect(stage.localizedWithin(3000, 1)).toBe(false);
  });

  it('does not invent a camera from points that are not the map', () => {
    const { map, stage } = setup();
    const rng = new Rng(9);
    expect(solve(stage, map, populationFor(map, roomPose(10), rng)).state).toBe(LocalizationState.LOCALIZED);
    const random: Point[] = Array.from({ length: 300 }, (_, i) => ({ id: FRESH + i, x0: 5 + rng.next() * (W - 10), y0: 5 + rng.next() * (H - 10) }));
    const report = solve(stage, map, random);
    expect(report.state).not.toBe(LocalizationState.LOCALIZED);
    expect(report.recovered).toBe(false);
    expect(stage.takeRelabels()).toEqual([]);
  });
});

describe('FlowTracker.relabel', () => {
  function trackerWith(ids: number[], nextId: number): FlowTracker {
    const t = new FlowTracker();
    const inner = t as unknown as { population: TrackedFeature[]; nextId: number };
    inner.population = ids.map((id) => ({ id, x0: id, y0: id, x: id, y: id }) as unknown as TrackedFeature);
    inner.nextId = nextId;
    return t;
  }

  it('takes only ids it issued that no live point carries', () => {
    const t = trackerWith([10, 11, 12], 20);
    // 3 is free and was issued; 11 is live; 25 was never issued.
    expect(t.relabel([[10, 3], [12, 11], [12, 25]])).toBe(1);
    expect(t.getPopulation().map((f) => f.id)).toEqual([3, 11, 12]);
    // A point already relabelled cannot be relabelled again onto an id now live.
    expect(t.relabel([[12, 3]])).toBe(0);
  });
});

describe('the world over a refused frame', () => {
  it('holds the pose as DEGRADED, and reports LOST only once it is stale', () => {
    const run = runRoom(160);
    expect(run.world.view().worldState).toBe(WorldState.READY);
    const { map } = setup();
    const empty = new LocalizationStage();
    const tooFew = () => empty.process({ population: [], width: W, height: H, map, keyframeIds: [1], registeredKeyframe: null, capturedAtEpoch: 0 });

    run.clock.now += 33;
    run.builder.onLocalization(tooFew());
    let v = run.world.view();
    expect(v.trackingState).toBe(TrackingState.DEGRADED);
    expect(v.cameraPose).not.toBeNull();
    expect(v.worldState).not.toBe(WorldState.READY);

    for (let t = 0; t < POSE_STALE_MS + 100; t += 33) {
      run.clock.now += 33;
      run.builder.onLocalization(tooFew());
    }
    v = run.world.view();
    expect(v.trackingState).toBe(TrackingState.LOST);
    expect(v.cameraPose).toBeNull();
    expect(run.builder.stats().readyViolations).toBe(0);
    expect(run.builder.stats().longestUnlocalizedRun).toBeGreaterThan(10);
  });
});
