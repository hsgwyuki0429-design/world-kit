/**
 * One Phase 9 batch, end to end, with no worker around it (v4 §21, v3 §15, §16).
 *
 * The worker calls this and adds nothing, for the reason every stage before it exists: the test
 * plan requires a triangulator that returns a **constant depth** to be shown to fail, and a unit
 * test that reimplemented the batch to prove it would be proving something about the
 * reimplementation. `tests/unit/triangulation.test.ts` drives this.
 *
 * ## What a batch is
 *
 * Two **keyframes** — the one Phase 8 has just inserted, against the one before it — related by
 * the observations they share, matched by `FlowTracker`'s feature id rather than by proximity.
 * Not Phase 5's anchor pair: that anchor is one slot re-taken on displacement, and now that a
 * keyframe store exists it is not what a triangulation should be built on.
 *
 * ## The pose is fitted here, and that is not a second opinion on Phase 6's
 *
 * Phase 6 decomposes the model Phase 5 selected *on that frame*, never a fresh fit, so that the
 * pose belongs to the geometry the screen showed. This pair is a **different pair of views** and
 * no model exists for it, so one is fitted — by the same `verifyCorrespondences` Phase 5 uses,
 * decomposed by the same `recoverPose` Phase 6 uses, neither modified.
 *
 * What that buys is TRI-006. Phase 6 already measured the rotation between these two views by an
 * entirely different route — per-frame poses against Phase 5's moving anchor, composed by Phase 8
 * across anchor epochs — and the two numbers are compared at Phase 6's own tolerance. A fresh fit
 * with a witness is a measurement; a fresh fit without one is a second answer.
 *
 * ## The two injections
 *
 * Both are built here, outside the triangulator, which never learns which set is which.
 *
 *  - **TRI-004** synthesises a pair from depths this stage picks — projected through a known
 *    `(R, t)` with `‖t‖ = 1`, using the frame's own intrinsics — and runs the **whole chain** on
 *    it: fit, decompose, triangulate. A constant-depth stage satisfies every other criterion in
 *    the phase and scores the control here.
 *  - **TRI-003** replaces the pair's second view with `K R K⁻¹` applied to its **first**, which
 *    is exactly a camera that turned and did not move. `tests/unit/pose.test.ts` asserts that
 *    identity, and Phase 6's POSE-005 already relies on it.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { Rng } from '../core/Rng';
import { projectRay, toCameraRay } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import { apply3x3, normalise3 } from '../geometry/linalg';
import { angleBetweenDeg, fromAxisAngle, rotationAngleDeg } from '../geometry/rotation';
import { PoseState, recoverPose, rotationHomography } from '../geometry/pose';
import { MIN_INLIERS, verifyCorrespondences } from '../geometry/verify';
import type { Correspondence } from '../geometry/twoView';
import {
  MIN_PAIR_CORRESPONDENCES,
  SCALE_LOCAL_UNITS,
  TriangulationRefusal,
  triangulatePair,
} from '../mapping/triangulation';
import type {
  PairObservation,
  TriangulationInput,
  TriangulationOutcome,
} from '../mapping/triangulation';
import type { Keyframe, KeyframeObservation } from '../mapping/keyframes';
import type { LandmarkBatch, LandmarkPoint } from '../mapping/landmarks';
import type {
  DepthInjectionRecord,
  RotationInjectionRecord,
  TriangulatedPointRecord,
  TriangulationReport,
} from './trackingMessages';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase9/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/** TRI-004's ground truth: depths drawn from this range, in units of the injected baseline. */
export const INJECTED_DEPTH_MIN = 2.0;
export const INJECTED_DEPTH_MAX = 8.0;

/** TRI-003's rotation. **Phase 6's POSE-005 number**, reused — it is the same construction. */
export const INJECTED_ROTATION_DEG = 8.0;

/**
 * How often each injection runs, **in batches**.
 *
 * Each costs a full extra fit and a full extra solve, so this is the difference between a batch
 * that costs what a batch costs and one that costs three times as much. Sampled on the stage's
 * own batch index rather than on a per-frame option: a batch happens when Phase 8 inserts a
 * keyframe, and the main thread does not know when that is — the first version asked on the
 * option cadence and landed an injection on **64 % of batches** where the plan says *on a sampled
 * schedule*. At six, each injection runs on one batch in six and the two never share one.
 */
export const INJECTION_SAMPLE_EVERY = 6;

/** How many triangulated points travel back to the main thread each batch. */
const POINT_SAMPLES = 6;

export const TriangulationState = {
  TRIANGULATED: 'TRIANGULATED',
  REFUSED: 'REFUSED',
  /** No keyframe was inserted on this frame, so there was no pair to relate. */
  IDLE: 'IDLE',
} as const;
export type TriangulationState = (typeof TriangulationState)[keyof typeof TriangulationState];

export interface TriangulationStageInput {
  /** The store, oldest first. A batch needs its last two. */
  readonly keyframes: readonly Keyframe[];
  /** Whether Phase 8 inserted on this frame. Only then is there a new pair. */
  readonly inserted: boolean;
  /** Whether the injections run at all. *Which* batches they run on is decided here. */
  readonly wantInjections: boolean;
}

/** The solve this stage performs, substitutable so a fake can be driven through the real loop. */
export type TriangulateFn = (input: TriangulationInput) => TriangulationOutcome;

export class TriangulationStage {
  private frames = 0;
  private batches = 0;
  private readonly seedRng: Rng;
  private readonly solve: TriangulateFn;
  private last: TriangulationReport | null = null;
  /**
   * The full batch, for the phase that consumes it.
   *
   * The report carries six sampled points because the boundary does not need eight thousand of
   * them; Phase 10 runs in the same worker and needs every one, with the pixel each was observed
   * at in the second view. The same division `VerificationStage` makes between its report and its
   * `VerificationOutcome`, and for the same reason: what crosses the seam and what the next stage
   * consumes are different quantities.
   */
  private batch: LandmarkBatch | null = null;

  /**
   * `solve` exists for the fixture, and it is the same arrangement `FlowTracker` takes its solver
   * by: `tests/unit/triangulation.test.ts` drives **this** loop — the real batching, the real
   * fit, the real injections — with a triangulator that returns a constant depth, and checks the
   * suite reaches a different verdict. A fixture that reimplemented the loop to prove that would
   * be proving something about the reimplementation.
   */
  constructor(seed = 0x51ed_270b, solve: TriangulateFn = triangulatePair) {
    this.seedRng = new Rng(seed);
    this.solve = solve;
  }

  reset(): void {
    this.frames = 0;
    this.batches = 0;
    this.seedRng.reset();
    this.last = null;
    this.batch = null;
  }

  process(input: TriangulationStageInput): TriangulationReport {
    this.frames++;
    this.batch = null;
    if (!input.inserted) return this.idle();

    const t0 = performance.now();
    const n = input.keyframes.length;
    const a = n >= 2 ? input.keyframes[n - 2] : undefined;
    const b = n >= 2 ? input.keyframes[n - 1] : undefined;
    if (!a || !b) {
      return this.refused('the store holds one keyframe; a pair needs two', null, t0);
    }

    this.batches++;
    const observations = sharedObservations(a, b);
    const pair: readonly number[] = [a.id, b.id];
    if (observations.length < MIN_PAIR_CORRESPONDENCES) {
      return this.refused(
        `keyframes ${a.id} and ${b.id} share ${observations.length} observation(s), below the ` +
          `${MIN_PAIR_CORRESPONDENCES} a two-view geometry needs`,
        pair,
        t0,
        observations.length,
      );
    }

    // The pair's own fit. `a`'s intrinsics, because the points are expressed in `a`'s frame and
    // §H.0 makes `K` a function of the frame geometry each view was taken at.
    const k = a.intrinsics;
    const seed = seedFrom(this.seedRng);
    const correspondences: Correspondence[] = observations.map((o) => ({
      ax: o.ax, ay: o.ay, bx: o.bx, by: o.by,
    }));
    const verification = verifyCorrespondences(correspondences, seed);
    if (!verification.matrix || verification.model === null) {
      return this.refused(
        `the pair verified nothing — ${verification.reason}`,
        pair,
        t0,
        observations.length,
        verification.inlierCount,
      );
    }
    if (verification.inlierCount < MIN_INLIERS) {
      return this.refused(
        `${verification.inlierCount} verified correspondences over the pair, below v3 §14's ` +
          `${MIN_INLIERS}`,
        pair,
        t0,
        observations.length,
        verification.inlierCount,
      );
    }

    const pose = recoverPose({
      points: correspondences,
      inliers: verification.inliers,
      model: verification.model,
      matrix: verification.matrix,
      planar: verification.planar,
      intrinsics: k,
    });

    // A camera that only turned determines no depth at all. `recoverPose` measures that from the
    // correspondences rather than from a formula — the residual `R` alone leaves unexplained *is*
    // the parallax — and where there is none it declines the translation. Triangulating anyway is
    // exactly what TRI-003 exists to catch.
    if (pose.state !== PoseState.POSE || !pose.rotation || !pose.translation) {
      const record = this.refused(
        `the pair recovered ${pose.state} — ${pose.reason}. A camera that only turned ` +
          'determines no depth',
        pair,
        t0,
        observations.length,
        verification.inlierCount,
        pose.state,
      );
      return this.withInjections(record, input, observations, k, 0, t0);
    }

    const outcome = this.solve({
      observations,
      inliers: verification.inliers,
      rotation: pose.rotation,
      translation: pose.translation,
      intrinsics: k,
    });

    // TRI-006's witness, taken from the keyframe itself: Phase 6 measured this same rotation by
    // an entirely different route — per-frame poses against Phase 5's moving anchor, composed by
    // Phase 8 across anchor epochs — and Phase 8 stored it when it inserted `b`.
    this.batch = {
      keyframeA: a.id,
      keyframeB: b.id,
      intrinsics: k,
      rotation: pose.rotation,
      translation: pose.translation,
      points: outcome.points.map((p): LandmarkPoint => {
        const o = observations.find((x) => x.id === p.id);
        return {
          id: p.id,
          position: p.position,
          depth: p.depth,
          parallaxDeg: p.parallaxDeg,
          observedX: o?.bx ?? -1,
          observedY: o?.by ?? -1,
        };
      }),
    };

    const rotationDeg = pose.rotationDeg;
    const keyframeRotationDeg = b.rotationFromPreviousDeg;
    const disagreement =
      keyframeRotationDeg >= 0 && rotationDeg >= 0
        ? Math.abs(rotationDeg - keyframeRotationDeg)
        : -1;

    const report: TriangulationReport = {
      frames: this.frames,
      batches: this.batches,
      state: TriangulationState.TRIANGULATED,
      stateReason:
        `${outcome.points.length} of ${outcome.candidates} verified correspondence(s) had ` +
        'parallax enough to determine a depth',
      keyframePair: pair,
      correspondences: observations.length,
      inliers: verification.inlierCount,
      inlierRatio: verification.inlierRatio,
      candidates: outcome.candidates,
      accepted: outcome.points.length,
      refusals: outcome.refusals,
      medianParallaxDeg: round(outcome.medianParallaxDeg, 4),
      medianAcceptedParallaxDeg: round(outcome.medianAcceptedParallaxDeg, 4),
      minAcceptedParallaxDeg: round(outcome.minAcceptedParallaxDeg, 4),
      maxAcceptedReprojectionPx: round(outcome.maxAcceptedReprojectionPx, 4),
      minAcceptedDepth: round(outcome.minAcceptedDepth, 4),
      medianDepth: round(outcome.medianDepth, 4),
      medianDepthUncertainty: round(outcome.medianDepthUncertainty, 5),
      medianReprojectionPx: round(outcome.medianReprojectionPx, 4),
      rotationDeg: round(rotationDeg, 4),
      keyframeRotationDeg: round(keyframeRotationDeg, 4),
      rotationDisagreementDeg: round(disagreement, 4),
      model: verification.model,
      planar: verification.planar,
      poseState: pose.state,
      scale: SCALE_LOCAL_UNITS,
      baselineUnits: 1,
      baselineNote:
        'every depth here is in units of **this pair’s own baseline**, which is 1 by ' +
        'construction because Phase 6 recovers a unit direction and v3 §15 and v4 §18 forbid a ' +
        'monocular camera claiming a distance. Two batches’ depths are in two different units ' +
        'and must not be pooled; Phase 10 is where a shared scale is obtained',
      samples: sampleOf(outcome),
      depthInjection: null,
      rotationInjection: null,
      triangulationMs: round(performance.now() - t0, 4),
    };
    return this.withInjections(report, input, observations, k, outcome.points.length, t0);
  }

  getLast(): TriangulationReport | null {
    return this.last;
  }

  /** The batch this frame produced, or `null` on a frame that produced none. */
  getBatch(): LandmarkBatch | null {
    return this.batch;
  }

  /* ---------------------------------------------------------------------- */

  private withInjections(
    report: TriangulationReport,
    input: TriangulationStageInput,
    observations: readonly PairObservation[],
    k: Intrinsics,
    cleanAccepted: number,
    t0: number,
  ): TriangulationReport {
    // One batch in six for each, and never the same one: two full extra fits inside one batch
    // would put both measurements inside the cost TRI-008 is measuring — the reasoning Phase 6
    // used to offset its own two injections by one.
    const depthInjection =
      input.wantInjections && this.batches % INJECTION_SAMPLE_EVERY === 1
        ? this.measureDepthInjection(observations, k)
        : null;
    const rotationInjection =
      input.wantInjections && this.batches % INJECTION_SAMPLE_EVERY === 2
        ? this.measureRotationInjection(observations, k, cleanAccepted)
        : null;
    const out: TriangulationReport = {
      ...report,
      depthInjection,
      rotationInjection,
      triangulationMs: round(performance.now() - t0, 4),
    };
    this.last = out;
    return out;
  }

  /**
   * TRI-004 — depths this stage picked, recovered through the whole chain.
   *
   * The points are placed on the **real pair's own first-view pixels**, so their distribution in
   * the image is the distribution a real scene produced rather than a uniform grid that would
   * condition the fit better than anything the device ever sees. Their *depths* are the
   * harness's, drawn from `[INJECTED_DEPTH_MIN, INJECTED_DEPTH_MAX]`, and the second view is
   * where a camera at `(R, t)` would have seen them.
   *
   * The whole chain runs — fit, decompose, triangulate — rather than the solve alone. A stage
   * returning a constant is not the only thing that could be wrong, and re-running only the last
   * step would leave the fit untested.
   */
  private measureDepthInjection(
    observations: readonly PairObservation[],
    k: Intrinsics,
  ): DepthInjectionRecord | null {
    const seed = seedFrom(this.seedRng);
    const rng = new Rng(seed);
    // A translation that is mostly lateral, because a camera moving along its own optical axis
    // produces very little parallax off the centre and would be testing the gate rather than the
    // solver. A modest rotation with it, so the pair is not a pure translation either.
    const t = normalise3([0.9 + rng.next() * 0.2, rng.next() - 0.5, (rng.next() - 0.5) * 0.2]) ?? [1, 0, 0];
    const axis = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) ?? [0, 1, 0];
    const r = fromAxisAngle(axis, 5.0);

    const truth = new Map<number, number>();
    const synthetic: PairObservation[] = [];
    for (const o of observations) {
      const depth = INJECTED_DEPTH_MIN + rng.next() * (INJECTED_DEPTH_MAX - INJECTED_DEPTH_MIN);
      const ray = toCameraRay(k, o.ax, o.ay);
      const x = [(ray[0] ?? 0) * depth, (ray[1] ?? 0) * depth, depth];
      const inB = apply3x3(r, x).map((v, i) => v + (t[i] ?? 0));
      const p = projectRay(k, inB);
      // Outside the frame it would never have been matched, so it is not offered.
      if (!p || p.x < 0 || p.y < 0 || p.x >= k.width || p.y >= k.height) continue;
      truth.set(o.id, depth);
      synthetic.push({ id: o.id, ax: o.ax, ay: o.ay, bx: p.x, by: p.y });
    }
    if (synthetic.length < MIN_PAIR_CORRESPONDENCES) return null;

    const fitSeed = seedFrom(this.seedRng);
    const correspondences: Correspondence[] = synthetic.map((o) => ({
      ax: o.ax, ay: o.ay, bx: o.bx, by: o.by,
    }));
    const verification = verifyCorrespondences(correspondences, fitSeed);
    if (!verification.matrix || verification.model === null) return null;
    const pose = recoverPose({
      points: correspondences,
      inliers: verification.inliers,
      model: verification.model,
      matrix: verification.matrix,
      planar: verification.planar,
      intrinsics: k,
    });
    if (pose.state !== PoseState.POSE || !pose.rotation || !pose.translation) return null;

    const outcome = this.solve({
      observations: synthetic,
      inliers: verification.inliers,
      rotation: pose.rotation,
      translation: pose.translation,
      intrinsics: k,
    });

    const trueDepths: number[] = [];
    const recovered: number[] = [];
    const relative: number[] = [];
    for (const p of outcome.points) {
      const actual = truth.get(p.id);
      if (actual === undefined) continue;
      trueDepths.push(actual);
      recovered.push(p.depth);
      relative.push(Math.abs(p.depth - actual) / actual);
    }
    if (relative.length === 0) return null;

    // The control: what the **best possible constant** would have scored on this set. That is
    // the number fake 1 produces, and it is reported beside the measurement so the tolerance is
    // not what separates them.
    const meanTrue = trueDepths.reduce((s, d) => s + d, 0) / trueDepths.length;
    const control = trueDepths.map((d) => Math.abs(meanTrue - d) / d);

    return {
      points: synthetic.length,
      accepted: outcome.points.length,
      medianRelativeError: round(median(relative), 6),
      controlRelativeError: round(median(control), 6),
      rankCorrelation: round(spearman(trueDepths, recovered), 5),
      medianTrueDepth: round(median(trueDepths), 4),
      medianRecoveredDepth: round(median(recovered), 4),
      recoveredRotationDeg: round(angleBetweenDeg(pose.rotation, r), 4),
      requestedRotationDeg: round(rotationAngleDeg(r), 4),
      seed,
    };
  }

  /**
   * TRI-003 — a camera that turned and did not move.
   *
   * `K R K⁻¹` applied to the first view *is* the second view of a camera that additionally
   * rotated by `R` from the same place: if `b = π(K X)` then `π(K R K⁻¹ b̃) = π(K R X)`. The pair
   * therefore has a real rotation, large well-conditioned image motion, and **no baseline at
   * all**. `tests/unit/pose.test.ts` asserts the identity, and Phase 6's POSE-005 already relies
   * on it.
   */
  private measureRotationInjection(
    observations: readonly PairObservation[],
    k: Intrinsics,
    cleanAccepted: number,
  ): RotationInjectionRecord | null {
    const seed = seedFrom(this.seedRng);
    const rng = new Rng(seed);
    const axis = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) ?? [0, 1, 0];
    const h = rotationHomography(k, fromAxisAngle(axis, INJECTED_ROTATION_DEG));
    if (!h) return null;

    const turned: PairObservation[] = [];
    for (const o of observations) {
      const q = apply3x3(h, [o.ax, o.ay, 1]);
      const w = q[2] ?? 0;
      if (Math.abs(w) <= 1e-12) continue;
      turned.push({ id: o.id, ax: o.ax, ay: o.ay, bx: (q[0] ?? 0) / w, by: (q[1] ?? 0) / w });
    }
    if (turned.length < MIN_PAIR_CORRESPONDENCES) return null;

    const fitSeed = seedFrom(this.seedRng);
    const correspondences: Correspondence[] = turned.map((o) => ({
      ax: o.ax, ay: o.ay, bx: o.bx, by: o.by,
    }));
    const verification = verifyCorrespondences(correspondences, fitSeed);
    if (!verification.matrix || verification.model === null) {
      return {
        requestedDeg: INJECTED_ROTATION_DEG,
        correspondences: turned.length,
        accepted: 0,
        cleanAccepted,
        poseState: 'UNVERIFIED',
        lowParallaxRefusals: 0,
        seed,
      };
    }
    const pose = recoverPose({
      points: correspondences,
      inliers: verification.inliers,
      model: verification.model,
      matrix: verification.matrix,
      planar: verification.planar,
      intrinsics: k,
    });
    // The refusal can happen either way, and the record says which: the pose declines to offer a
    // translation, or it offers one and every ray pair turns out to meet at infinity.
    if (pose.state !== PoseState.POSE || !pose.rotation || !pose.translation) {
      return {
        requestedDeg: INJECTED_ROTATION_DEG,
        correspondences: turned.length,
        accepted: 0,
        cleanAccepted,
        poseState: pose.state,
        lowParallaxRefusals: 0,
        seed,
      };
    }
    const outcome = this.solve({
      observations: turned,
      inliers: verification.inliers,
      rotation: pose.rotation,
      translation: pose.translation,
      intrinsics: k,
    });
    return {
      requestedDeg: INJECTED_ROTATION_DEG,
      correspondences: turned.length,
      accepted: outcome.points.length,
      cleanAccepted,
      poseState: pose.state,
      lowParallaxRefusals: outcome.refusals[TriangulationRefusal.LOW_PARALLAX] ?? 0,
      seed,
    };
  }

  private idle(): TriangulationReport {
    const previous = this.last;
    const report: TriangulationReport = {
      ...(previous ?? emptyReport()),
      frames: this.frames,
      batches: this.batches,
      state: TriangulationState.IDLE,
      stateReason: 'no keyframe was inserted on this frame, so there was no new pair to relate',
      depthInjection: null,
      rotationInjection: null,
      triangulationMs: -1,
    };
    this.last = report;
    return report;
  }

  private refused(
    reason: string,
    pair: readonly number[] | null,
    t0: number,
    correspondences = 0,
    inliers = 0,
    poseState = 'NO_POSE',
  ): TriangulationReport {
    const report: TriangulationReport = {
      ...emptyReport(),
      frames: this.frames,
      batches: this.batches,
      state: TriangulationState.REFUSED,
      stateReason: reason,
      keyframePair: pair,
      correspondences,
      inliers,
      inlierRatio: correspondences > 0 ? round(inliers / correspondences, 4) : -1,
      poseState,
      triangulationMs: round(performance.now() - t0, 4),
    };
    this.last = report;
    return report;
  }
}

function emptyReport(): TriangulationReport {
  return {
    frames: 0,
    batches: 0,
    state: TriangulationState.IDLE,
    stateReason: 'nothing has been triangulated yet',
    keyframePair: null,
    correspondences: 0,
    inliers: 0,
    inlierRatio: -1,
    candidates: 0,
    accepted: 0,
    refusals: {},
    medianParallaxDeg: -1,
    medianAcceptedParallaxDeg: -1,
    minAcceptedParallaxDeg: -1,
    maxAcceptedReprojectionPx: -1,
    minAcceptedDepth: -1,
    medianDepth: -1,
    medianDepthUncertainty: -1,
    medianReprojectionPx: -1,
    rotationDeg: -1,
    keyframeRotationDeg: -1,
    rotationDisagreementDeg: -1,
    model: null,
    planar: false,
    poseState: 'NO_POSE',
    scale: SCALE_LOCAL_UNITS,
    baselineUnits: 1,
    baselineNote:
      'depths are in units of the pair’s own baseline, which is 1 by construction and has no ' +
      'length in the world',
    samples: [],
    depthInjection: null,
    rotationInjection: null,
    triangulationMs: -1,
  };
}

/**
 * The correspondences two keyframes share, matched by feature id.
 *
 * By id and never by proximity: the ids come from `FlowTracker` and are unique for the life of
 * the run, so a match here is the *same physical point followed by the tracker* rather than two
 * points that happen to be near each other. That is what makes a triangulated point recognisable
 * to Phase 10 — and what makes the correspondence set free of the matching errors a
 * nearest-neighbour association would introduce.
 */
export function sharedObservations(a: Keyframe, b: Keyframe): PairObservation[] {
  const byId = new Map<number, KeyframeObservation>();
  for (const o of a.observations) byId.set(o.id, o);
  const out: PairObservation[] = [];
  for (const o of b.observations) {
    const p = byId.get(o.id);
    if (!p) continue;
    out.push({ id: o.id, ax: p.x, ay: p.y, bx: o.x, by: o.y });
  }
  return out;
}

function sampleOf(outcome: TriangulationOutcome): TriangulatedPointRecord[] {
  const n = Math.min(POINT_SAMPLES, outcome.points.length);
  const out: TriangulatedPointRecord[] = [];
  for (let i = 0; i < n; i++) {
    const p = outcome.points[Math.floor((i * outcome.points.length) / Math.max(1, n))];
    if (!p) continue;
    out.push({
      id: p.id,
      position: p.position.map((v) => round(v, 4)),
      depth: round(p.depth, 4),
      parallaxDeg: round(p.parallaxDeg, 4),
      depthUncertainty: round(p.depthUncertainty, 5),
      reprojectionPx: round(p.reprojectionPx, 4),
    });
  }
  return out;
}

/**
 * Spearman rank correlation — TRI-004's fourth criterion.
 *
 * A triangulator that recovered the *mean* depth and none of the structure scores well on any
 * measure of central tendency and badly here, which is the separation the criterion is after.
 * Ties are given their average rank, which matters because a constant answer is all ties and
 * then the correlation is `0` rather than an accident of the sort order.
 */
export function spearman(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return -2;
  const ra = ranks(a.slice(0, n));
  const rb = ranks(b.slice(0, n));
  const mean = (n - 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (ra[i] ?? 0) - mean;
    const y = (rb[i] ?? 0) - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da <= 0 || db <= 0) return 0;
  return num / Math.sqrt(da * db);
}

function ranks(values: readonly number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.v === order[i]?.v) j++;
    const average = (i + j) / 2;
    for (let k = i; k <= j; k++) {
      const entry = order[k];
      if (entry) out[entry.i] = average;
    }
    i = j + 1;
  }
  return out;
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
