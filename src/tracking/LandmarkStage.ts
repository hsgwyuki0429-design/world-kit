/**
 * One Phase 10 batch, end to end, with no worker around it (v4 §22, §56, §34).
 *
 * The worker calls this and adds nothing, for the reason every stage before it exists: the test
 * plan requires a map that **overwrites each landmark with the newest triangulation** to be shown
 * to fail, and a unit test that reimplemented the loop to prove it would be proving something
 * about the reimplementation. `tests/unit/landmarks.test.ts` drives this.
 *
 * ## What happens on a batch
 *
 *  1. **The map registers it**, or refuses it. Everything about that — the similarity, the
 *     held-out predictions, the gate — is in `LandmarkMap`, which is pure and cannot see the
 *     harness.
 *  2. **On a sampled schedule, the same batch is offered again with a known subset of its
 *     positions displaced**, and the map is asked what it *would* do with it. `evaluate` rather
 *     than `ingest`, because finding out whether the gate catches an injection must not corrupt
 *     the thing being measured — the same reason GEO-003 verifies a copy of the correspondence
 *     set rather than the set itself.
 *
 * ## Why the displacement is perpendicular to the ray, and 5 % of the depth
 *
 * A point moved *along* its ray changes depth and barely moves in the image; a point moved across
 * it moves by `f · Δ/Z` pixels. At `Δ = 0.05 Z` that is `0.05 f` — about 24 px at the leg's focal
 * length — **whatever the depth is**, so the injection is the same size for a near point and a
 * far one. Sixteen times §13's 1.5 px correspondence band: an outlier by construction, arrived at
 * from the geometry rather than copied from GEO-003's 25 px.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { Rng } from '../core/Rng';
import { normalise3 } from '../geometry/linalg';
import {
  IngestState,
  LandmarkMap,
  MAX_LANDMARKS,
  MIN_OBSERVATIONS_CONFIRMED,
  SCALE_LOCAL_UNITS,
} from '../mapping/landmarks';
import type { Landmark, LandmarkBatch, LandmarkPoint } from '../mapping/landmarks';
import type {
  LandmarkCullRecord,
  LandmarkInjectionRecord,
  LandmarkRecord,
  LandmarkReport,
} from './trackingMessages';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase10/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** MAP-005's displacement, as a fraction of the point's depth. See the header. */
export const LANDMARK_INJECTION_FRACTION = 0.05;

/** ...and how much of the batch it touches. GEO-003's fraction, reused. */
export const LANDMARK_INJECTION_SHARE = 0.3;

/** How often the injection runs, in batches. It costs one extra dry-run registration. */
export const LANDMARK_INJECTION_EVERY = 4;

/** How many landmarks travel back to the main thread each batch. */
const LANDMARK_SAMPLES = 6;

export interface LandmarkStageInput {
  /** Phase 9's batch, or `null` on a frame that produced none. */
  readonly batch: LandmarkBatch | null;
  readonly wantInjection: boolean;
}

export class LandmarkStage {
  private readonly map: LandmarkMap;
  private readonly seedRng: Rng;
  private frames = 0;
  private batches = 0;
  private keyframesSeen = 0;
  private last: LandmarkReport | null = null;

  /**
   * `map` exists for the fixture, in the arrangement `FlowTracker` and `TriangulationStage` both
   * use: `tests/unit/landmarks.test.ts` drives **this** loop — the real registration, the real
   * gate, the real injection — with a map whose position rule keeps only the newest observation,
   * and checks the suite reaches a different verdict.
   */
  constructor(seed = 0x2c1b_3a57, map: LandmarkMap = new LandmarkMap()) {
    this.seedRng = new Rng(seed);
    this.map = map;
  }

  reset(): void {
    this.map.reset();
    this.seedRng.reset();
    this.frames = 0;
    this.batches = 0;
    this.keyframesSeen = 0;
    this.last = null;
  }

  /** The map, for the screen and for whatever phase consumes it next. Read-only by type. */
  landmarks(): readonly Landmark[] {
    return this.map.all();
  }

  process(input: LandmarkStageInput): LandmarkReport {
    this.frames++;
    if (!input.batch) return this.idle();

    const t0 = performance.now();
    this.batches++;
    this.keyframesSeen++;
    const batch = input.batch;

    // The injection first, on the batch as it arrived — the map has not seen it yet, so what the
    // gate says about the displaced copy is what it would have said about the real one.
    const injection =
      input.wantInjection && this.batches % LANDMARK_INJECTION_EVERY === 1
        ? this.measureInjection(batch)
        : null;

    const outcome = this.map.ingest(batch);
    const all = this.map.all();
    const predictions = outcome.predictions;
    const errors = predictions.map((p) => p.errorPx);

    const moves = all.filter((l) => l.lastMoveRelative >= 0);
    const atTwo = moves.filter((l) => l.observations === 2).map((l) => l.lastMoveRelative);
    const atFive = moves.filter((l) => l.observations >= 5).map((l) => l.lastMoveRelative);

    const report: LandmarkReport = {
      frames: this.frames,
      batches: this.batches,
      state: outcome.state,
      stateReason: outcome.reason,
      keyframePair: [batch.keyframeA, batch.keyframeB],
      points: batch.points.length,
      shared: outcome.shared,
      admitted: outcome.admitted.length,
      merged: outcome.merged.length,
      rejected: outcome.rejected.length,
      registrationScale: round(outcome.registration?.scale ?? -1, 5),
      registrationResidual: round(outcome.registration?.residual ?? -1, 6),
      registrationUsed: outcome.registration?.used ?? 0,
      registrationOutliers: outcome.registration?.outliers ?? 0,

      heldOut: predictions.length,
      medianHeldOutPx: round(median(errors), 4),
      maxHeldOutPx: errors.length > 0 ? round(Math.max(...errors), 4) : -1,
      zeroHeldOut: errors.filter((e) => e === 0).length,
      medianObservationsAtPrediction: round(
        median(predictions.map((p) => p.observationsAtPrediction)),
        2,
      ),

      landmarks: outcome.landmarks,
      confirmed: outcome.confirmed,
      culled: outcome.culled.map((c): LandmarkCullRecord => ({ ...c })),
      epoch: outcome.epoch,
      epochRestarted: outcome.epochRestarted,
      medianConfidence: round(median(all.map((l) => l.confidence)), 4),
      medianMoveRelative: round(median(moves.map((l) => l.lastMoveRelative)), 6),
      moveAtTwo: round(median(atTwo), 6),
      moveAtFive: round(median(atFive), 6),
      moveAtTwoSamples: atTwo.length,
      moveAtFiveSamples: atFive.length,

      scale: SCALE_LOCAL_UNITS,
      modelClaim:
        'this is a set of places the tracker could follow, not a model of the room. Everything ' +
        'between the landmarks is **unobserved** and is not treated as geometry (v4 §16, §22): ' +
        'there is no surface here, no mesh, no volume and no completeness figure, and the ' +
        'density below is what makes "sparse" a measurement rather than an adjective',
      landmarksPerKeyframe:
        this.keyframesSeen > 0 ? round(outcome.landmarks / this.keyframesSeen, 2) : -1,
      samples: sampleOf(all),
      injection,
      landmarkMs: round(performance.now() - t0, 4),
    };
    this.last = report;
    return report;
  }

  getLast(): LandmarkReport | null {
    return this.last;
  }

  /**
   * MAP-005 — displace a known subset and ask the map what it would do.
   *
   * Only points the map already holds are worth displacing: a point it has never seen has no
   * position to disagree with, so the gate has nothing to say about it and counting it either way
   * would be measuring the wrong thing. The clean rejection rate is taken over the *other* points
   * it already holds, for the same reason — a point admitted for the first time is not evidence
   * that the gate spares what it should.
   */
  private measureInjection(batch: LandmarkBatch): LandmarkInjectionRecord | null {
    const known = batch.points.filter((p) => this.map.get(p.id) !== undefined);
    if (known.length < 2 * (1 / LANDMARK_INJECTION_SHARE)) return null;

    const seed = seedFrom(this.seedRng);
    const rng = new Rng(seed);
    const target = Math.max(1, Math.round(known.length * LANDMARK_INJECTION_SHARE));
    const chosenIndices = new Set(rng.sampleDistinct(Math.min(target, known.length), known.length));
    const chosen = new Set<number>();
    for (const i of chosenIndices) {
      const p = known[i];
      if (p) chosen.add(p.id);
    }

    const corrupted: LandmarkPoint[] = batch.points.map((p) => {
      if (!chosen.has(p.id)) return p;
      // Perpendicular to the viewing ray: a seeded direction in the plane through the point that
      // faces the camera. Moving *along* the ray would change the depth and barely move the
      // projection, which is the one displacement this gate is not for.
      const ray = normalise3(p.position) ?? [0, 0, 1];
      const arbitrary = Math.abs(ray[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = normalise3(cross(ray, arbitrary)) ?? [1, 0, 0];
      const v = normalise3(cross(ray, u)) ?? [0, 1, 0];
      const angle = rng.next() * Math.PI * 2;
      const amount = LANDMARK_INJECTION_FRACTION * p.depth;
      return {
        ...p,
        position: p.position.map(
          (c, i) =>
            c + amount * (Math.cos(angle) * (u[i] ?? 0) + Math.sin(angle) * (v[i] ?? 0)),
        ),
      };
    });

    const plan = this.map.evaluate({ ...batch, points: corrupted });
    const rejected = new Set(plan.rejected);
    // The same gate on the **uncorrupted** batch, as the baseline. Both are dry runs, so neither
    // touches the map. Without this the companion figure is a measurement of how noisy the scene
    // is rather than of whether the injection turned the gate against the innocent.
    const baselineRejected = new Set(this.map.evaluate(batch).rejected);

    let injectedRejected = 0;
    for (const id of chosen) if (rejected.has(id)) injectedRejected++;
    let cleanRejected = 0;
    let baselineCleanRejected = 0;
    let cleanCount = 0;
    for (const p of known) {
      if (chosen.has(p.id)) continue;
      cleanCount++;
      if (rejected.has(p.id)) cleanRejected++;
      if (baselineRejected.has(p.id)) baselineCleanRejected++;
    }

    return {
      injected: chosen.size,
      clean: cleanCount,
      injectedRejected,
      cleanRejected,
      recall: chosen.size > 0 ? round(injectedRejected / chosen.size, 4) : -1,
      cleanRejectionRate: cleanCount > 0 ? round(cleanRejected / cleanCount, 4) : -1,
      baselineRejectionRate: cleanCount > 0 ? round(baselineCleanRejected / cleanCount, 4) : -1,
      // What the displacement does in the image: `f · Δ/Z` with `Δ = fraction · Z`, so the depth
      // cancels and the same number applies to every point in the batch.
      displacementPx: round(LANDMARK_INJECTION_FRACTION * batch.intrinsics.fx, 2),
      fraction: LANDMARK_INJECTION_FRACTION,
      seed,
    };
  }

  private idle(): LandmarkReport {
    const previous = this.last;
    const report: LandmarkReport = {
      ...(previous ?? emptyReport()),
      frames: this.frames,
      batches: this.batches,
      state: IngestState.IDLE,
      stateReason: 'Phase 9 produced no batch on this frame, so there was nothing to register',
      culled: [],
      epochRestarted: false,
      injection: null,
      landmarkMs: -1,
    };
    this.last = report;
    return report;
  }
}

function emptyReport(): LandmarkReport {
  return {
    frames: 0,
    batches: 0,
    state: IngestState.IDLE,
    stateReason: 'the map has not been given a batch yet',
    keyframePair: null,
    points: 0,
    shared: 0,
    admitted: 0,
    merged: 0,
    rejected: 0,
    registrationScale: -1,
    registrationResidual: -1,
    registrationUsed: 0,
    registrationOutliers: 0,
    heldOut: 0,
    medianHeldOutPx: -1,
    maxHeldOutPx: -1,
    zeroHeldOut: 0,
    medianObservationsAtPrediction: -1,
    landmarks: 0,
    confirmed: 0,
    culled: [],
    epoch: 1,
    epochRestarted: false,
    medianConfidence: -1,
    medianMoveRelative: -1,
    moveAtTwo: -1,
    moveAtFive: -1,
    moveAtTwoSamples: 0,
    moveAtFiveSamples: 0,
    scale: SCALE_LOCAL_UNITS,
    modelClaim:
      'this is a set of places the tracker could follow, not a model of the room (v4 §16, §22)',
    landmarksPerKeyframe: -1,
    samples: [],
    injection: null,
    landmarkMs: -1,
  };
}

function sampleOf(all: readonly Landmark[]): LandmarkRecord[] {
  // The most confident, because a sample of six from a map of hundreds should show what the map
  // is for rather than what it happens to hold at the front of a hash table.
  const ordered = [...all].sort((a, b) => b.confidence - a.confidence).slice(0, LANDMARK_SAMPLES);
  return ordered.map((l) => ({
    id: l.id,
    position: l.position.map((v) => round(v, 4)),
    observations: l.observations,
    keyframes: l.keyframes.length,
    maxParallaxDeg: round(l.maxParallaxDeg, 3),
    meanPredictionPx: round(l.meanPredictionPx, 4),
    predictions: l.predictions,
    lastMoveRelative: l.lastMoveRelative,
    confidence: l.confidence,
    state: l.state,
  }));
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function seedFrom(rng: Rng): number {
  return Math.floor(rng.next() * 0xffff_ffff) >>> 0;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}

/** Re-exported so the screen, the tests and the session name one set of numbers. */
export { MAX_LANDMARKS, MIN_OBSERVATIONS_CONFIRMED };
