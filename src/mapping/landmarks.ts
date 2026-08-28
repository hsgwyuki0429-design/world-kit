/**
 * The landmark map (Phase 10 — v4 §22, §56, §34).
 *
 * Pure arithmetic over the structures it is handed. No DOM, no worker, no camera, no clock, and —
 * as the architecture audit enforces for this layer — no import from `tracking` or `testkit`, so
 * the map cannot see which of the positions it is given the harness displaced. The rule Phase 5
 * put on `geometry`, Phase 7 on `fusion` and Phase 8 on this layer.
 *
 * ## What this phase is for
 *
 * Phase 9 leaves one answer per keyframe pair, each in units of **that pair's own baseline**. On
 * the automated leg the median depth moved by 87 % of itself between consecutive batches on a
 * scene that never changed — not because the room moved, but because the unit did. This is where
 * that stops being true, and the mechanism is the only one a monocular camera has: **the
 * landmarks two batches share fix the ratio between their scales.**
 *
 * A similarity — seven degrees of freedom, solved in closed form — is fitted from the batch's
 * frame to the world over the landmarks they share. Its **scale term is the ratio**. Its rotation
 * and translation are the batch's first keyframe's pose in the world, which is why a batch whose
 * predecessor was refused can still be registered: the transform comes from the landmarks, not
 * from a chain of poses that a single refusal would break.
 *
 * ## The order the work has to happen in
 *
 * The transform is fitted first, because a prediction needs a pose to project through. What
 * MAP-002 requires is that the prediction is taken **before the merge** — from the position the
 * map held when the batch arrived, into a keyframe that position was not computed from. Both are
 * true here, and the record carries the observation count each landmark had at prediction time so
 * the claim is checkable from the evidence rather than from this comment.
 *
 * ## Nothing here is a function of time
 *
 * A landmark seen for a long while is not thereby a good landmark. Confidence comes from the
 * observation count, the parallax that determined it, the agreement of its predictions and the
 * spread of the viewpoints that saw it. `scripts/audit-fake-data.mjs` enforces the absence of the
 * alternative mechanically.
 */

import { projectRay } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import {
  apply3x3,
  determinant3x3,
  multiply3x3,
  transpose3x3,
} from '../geometry/linalg';
import { svd3x3 } from '../geometry/linalg';
import { MAX_TRIANGULATION_REPROJECTION_PX, MIN_PARALLAX_DEG, SCALE_LOCAL_UNITS } from './triangulation';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase10/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** §56 and §H.1's ceiling, fixed in the implementation plan before Phase 0 ran. */
export const MAX_LANDMARKS = 5000;

/** A point seen from three views is a landmark; from two it is a triangulation. */
export const MIN_OBSERVATIONS_CONFIRMED = 3;

/** v3 §33's GOOD condition, reused rather than re-derived. */
export const MAX_LANDMARK_REPROJECTION_PX = MAX_TRIANGULATION_REPROJECTION_PX;

/**
 * How far two estimates of one point may sit apart, in the image, before the newer is refused.
 *
 * **Twice** the ceiling above, and the factor is a derivation rather than a loosening. The
 * ceiling is what a *single* estimate may sit from the observation; every comparison this gate
 * makes is between **two** quantities that each carry their own error in their own direction —
 * the map's accumulated position against the batch's fresh one, and the map's prediction against
 * the tracker's observation. A difference of two is allowed twice what either is.
 *
 * This is §13's shape, reused: Phase 4's forward/backward validation has an *acceptable* band at
 * 1.5 px and a *rejection* band at twice it, with the middle counted as reduced confidence rather
 * than thrown away. Here the ceiling is what MAP-002's **median** must stay inside and what a
 * landmark's **running mean** is culled on; this is where a single observation is refused.
 *
 * The first version applied the single-estimate ceiling to the difference, and refused between
 * 5 % and 27 % of untouched points on clean batches — which made MAP-005's false-cull rate a
 * measurement of the threshold rather than of the gate.
 */
export const MAX_DISAGREEMENT_PX = 2 * MAX_LANDMARK_REPROJECTION_PX;

/** A similarity has 7 degrees of freedom; 3 points is the algebraic minimum, 6 doubles it. */
export const MIN_REGISTRATION_POINTS = 6;

/**
 * How far the registration may leave the shared landmarks, as a fraction of the median depth.
 *
 * Half Phase 9's `DEPTH_UNCERTAINTY_LIMIT`: a registration whose residual is at that figure has
 * added as much error as the depths already carry, and half of it is where the registration stops
 * being the dominant term. Relative rather than absolute because the world's unit is a baseline
 * whose length nobody knows, and an absolute threshold on it would be a threshold on an arbitrary
 * scale.
 */
export const MAX_REGISTRATION_RESIDUAL = 0.05;

/** The trimming band, in medians. */
export const REGISTRATION_OUTLIER_FACTOR = 2.5;

/**
 * How many times the trim is iterated.
 *
 * One is not enough when a third of the batch is corrupt — see `fit`. Three converge on the data
 * MAP-005 injects, and each costs one 3×3 SVD over a few dozen points.
 */
export const REGISTRATION_TRIM_PASSES = 3;

/** Consecutive unregisterable batches before the world has to be redefined. */
export const EPOCH_RESTART_AFTER = 5;

/** §56 again: the keyframe poses are bounded like everything else. */
export const MAX_KEYFRAME_POSES = 64;

/** How many observing keyframes a landmark remembers. §56: bounded, newest kept. */
export const MAX_KEYFRAMES_PER_LANDMARK = 8;

export const LandmarkState = {
  /** Seen from fewer than `MIN_OBSERVATIONS_CONFIRMED` views. */
  CANDIDATE: 'CANDIDATE',
  CONFIRMED: 'CONFIRMED',
} as const;
export type LandmarkState = (typeof LandmarkState)[keyof typeof LandmarkState];

export const CullReason = {
  /** Its predictions stopped landing where the tracker sees it. */
  DISAGREES: 'DISAGREES',
  /** §56's bound needed the room, and this was the least confident candidate. */
  BOUND: 'BOUND',
} as const;
export type CullReason = (typeof CullReason)[keyof typeof CullReason];

export const IngestState = {
  REGISTERED: 'REGISTERED',
  /** Too few shared landmarks, or a fit the map does not agree with. Nothing is ingested. */
  UNREGISTERED: 'UNREGISTERED',
  /** The world had to be redefined — see `EPOCH_RESTART_AFTER`. */
  EPOCH_RESTART: 'EPOCH_RESTART',
  /** There was no batch on this frame. */
  IDLE: 'IDLE',
} as const;
export type IngestState = (typeof IngestState)[keyof typeof IngestState];

/** One point a batch offers: where Phase 9 put it, and where the tracker saw it. */
export interface LandmarkPoint {
  readonly id: number;
  /** In the batch's **first** keyframe's camera frame, in units of that pair's baseline. */
  readonly position: readonly number[];
  readonly depth: number;
  readonly parallaxDeg: number;
  /** Where the tracker observed this feature in the batch's **second** keyframe, in pixels. */
  readonly observedX: number;
  readonly observedY: number;
}

export interface LandmarkBatch {
  readonly keyframeA: number;
  readonly keyframeB: number;
  readonly intrinsics: Intrinsics;
  readonly points: readonly LandmarkPoint[];
  /** Row-major, first keyframe → second. */
  readonly rotation: readonly number[];
  /** Unit direction, first → second. Its **length in the world** is what registration recovers. */
  readonly translation: readonly number[];
}

export interface Landmark {
  readonly id: number;
  /** In the world frame: the first registered keyframe's camera frame, in its batch's baseline. */
  readonly position: readonly number[];
  readonly observations: number;
  readonly keyframes: readonly number[];
  readonly maxParallaxDeg: number;
  /** Running mean of its held-out prediction errors, px. `-1` before it has been predicted. */
  readonly meanPredictionPx: number;
  readonly predictions: number;
  /** How far the last observation moved it, relative to its depth in that view. */
  readonly lastMoveRelative: number;
  readonly confidence: number;
  readonly state: LandmarkState;
  readonly epoch: number;
}

/** A camera pose in the world: `X_camera = R · X_world + t`. */
export interface KeyframePose {
  readonly rotation: readonly number[];
  readonly translation: readonly number[];
}

export interface Similarity {
  /** The ratio between the batch's baseline and the world's. Never a metre. */
  readonly scale: number;
  readonly rotation: readonly number[];
  readonly translation: readonly number[];
  /** Median residual after the robust re-fit, relative to the median depth. */
  readonly residual: number;
  readonly used: number;
  readonly outliers: number;
}

/** One held-out prediction: what the map said, and what the tracker saw. */
export interface PredictionSample {
  readonly id: number;
  readonly errorPx: number;
  /** The observation count the landmark had **at prediction time** — MAP-002's third criterion. */
  readonly observationsAtPrediction: number;
}

export interface CullRecord {
  readonly id: number;
  readonly reason: CullReason;
  readonly detail: string;
}

/** What an ingest would do, computed without changing anything. */
export interface IngestPlan {
  readonly state: IngestState;
  readonly reason: string;
  readonly shared: number;
  readonly registration: Similarity | null;
  readonly poseA: KeyframePose | null;
  readonly poseB: KeyframePose | null;
  readonly predictions: readonly PredictionSample[];
  /** Ids the held-out gate refuses — MAP-005's answer, when the batch was the corrupted one. */
  readonly rejected: readonly number[];
  readonly merged: readonly number[];
  readonly admitted: readonly number[];
}

export interface IngestOutcome extends IngestPlan {
  readonly culled: readonly CullRecord[];
  readonly landmarks: number;
  readonly confirmed: number;
  readonly epoch: number;
  readonly epochRestarted: boolean;
}

/**
 * How a landmark's position absorbs a new observation.
 *
 * Substitutable for the reason `FlowTracker` takes its solver and `TriangulationStage` its
 * solve: MAP-006 requires a map that **re-guesses** rather than accumulates to be shown to fail,
 * and `tests/unit/landmarks.test.ts` drives this exact class with the rule replaced by
 * `overwrite`. A fixture that reimplemented the map to prove that would be proving something
 * about the reimplementation.
 */
export type PositionUpdate = (
  existing: Landmark,
  observed: readonly number[],
  observations: number,
) => number[];

/**
 * The real rule: a running mean over every observation.
 *
 * What a new observation moves the position by falls like `1/n`, which is what MAP-006 measures.
 * A rule that returns the newest observation instead has a step size that does not fall, and the
 * two are distinguishable in exactly that figure and — on clean data — in very little else.
 */
export const runningMean: PositionUpdate = (existing, observed, n) =>
  existing.position.map((v, i) => (v * n + (observed[i] ?? 0)) / (n + 1));

/** The fixture's rule: keep only the newest. Exported so the fake has a name rather than a lambda. */
export const overwrite: PositionUpdate = (_existing, observed) => [...observed];

export class LandmarkMap {
  private readonly landmarks = new Map<number, Landmark>();
  private readonly poses = new Map<number, KeyframePose>();
  private epoch = 1;
  private unregisteredRun = 0;

  constructor(private readonly update: PositionUpdate = runningMean) {}

  reset(): void {
    this.landmarks.clear();
    this.poses.clear();
    this.epoch = 1;
    this.unregisteredRun = 0;
  }

  size(): number {
    return this.landmarks.size;
  }

  confirmedCount(): number {
    let n = 0;
    for (const l of this.landmarks.values()) if (l.state === LandmarkState.CONFIRMED) n++;
    return n;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  all(): readonly Landmark[] {
    return [...this.landmarks.values()];
  }

  get(id: number): Landmark | undefined {
    return this.landmarks.get(id);
  }

  poseOf(keyframe: number): KeyframePose | undefined {
    return this.poses.get(keyframe);
  }

  /**
   * What ingesting this batch **would** do, without doing it.
   *
   * MAP-005 hands over a batch with a known subset of its positions displaced, and it must not
   * corrupt the map to find out whether the gate catches them — the same reason GEO-003 verifies
   * a *copy* of the correspondence set. Everything the gate decides is here; `ingest` is this
   * plus the mutation.
   */
  evaluate(batch: LandmarkBatch): IngestPlan {
    if (batch.points.length === 0) {
      return refuse('the batch produced no points', 0, batch);
    }

    const shared: LandmarkPoint[] = [];
    for (const p of batch.points) {
      const l = this.landmarks.get(p.id);
      if (l && l.epoch === this.epoch) shared.push(p);
    }

    const first = this.landmarks.size === 0;
    const registration = first
      ? identitySimilarity()
      : shared.length >= MIN_REGISTRATION_POINTS
        ? this.fit(shared)
        : null;

    if (!registration) {
      return refuse(
        shared.length < MIN_REGISTRATION_POINTS
          ? `the batch shares ${shared.length} landmark(s) with the map, below the ` +
            `${MIN_REGISTRATION_POINTS} a similarity needs with any redundancy`
          : 'the shared landmarks do not admit a similarity — the fit was degenerate',
        shared.length,
        batch,
      );
    }
    if (registration.residual > MAX_REGISTRATION_RESIDUAL) {
      return refuse(
        `the registration leaves the shared landmarks ${round(registration.residual, 4)} of a ` +
          `depth away, past the ${MAX_REGISTRATION_RESIDUAL} at which it becomes the dominant ` +
          'error — the batch and the map disagree about where these points are',
        shared.length,
        batch,
        registration,
      );
    }

    const rt = transpose3x3(registration.rotation);
    const poseA: KeyframePose = {
      rotation: rt,
      translation: apply3x3(rt, registration.translation).map((v) => -v),
    };
    const poseB = poseBFor(registration, batch);

    const predictions: PredictionSample[] = [];
    const rejected: number[] = [];
    const merged: number[] = [];
    const admitted: number[] = [];

    for (const p of batch.points) {
      const l = this.landmarks.get(p.id);
      if (!l || l.epoch !== this.epoch) {
        admitted.push(p.id);
        continue;
      }

      // **Where the batch puts it, against where the map has it — in the image.**
      //
      // Two corrections are folded into that sentence, and both were found by measurement.
      //
      // The first version had only the prediction check below, and MAP-005 found the hole: the
      // injection displaces what the batch *offers*, and the prediction compares the map's own
      // position against the tracker's observation, which the injection never touches. Recall
      // came to 0.17 against a floor of 0.90 — the gate was not looking at the thing being
      // corrupted.
      //
      // The second version compared the two positions **in world units**, against what
      // `MAX_LANDMARK_REPROJECTION_PX` would be at that depth. That rejected **71 % of untouched
      // points**, because the dominant error in a triangulated position is *radial* — a depth
      // error of half a percent is 2.4 px worth of world displacement at this focal length and
      // is invisible in the image, which is precisely why the camera could not pin it down. So
      // the comparison happens where the camera can see it: both positions are projected into
      // this keyframe and the disagreement is measured in pixels. A depth disagreement the image
      // cannot show is not a disagreement this gate has any business rejecting.
      const world = applySimilarity(registration, p.position);
      const mapPixel = projectRay(batch.intrinsics, inCameraFrame(poseB, l.position));
      const batchPixel = projectRay(batch.intrinsics, inCameraFrame(poseB, world));
      if (!mapPixel || !batchPixel) {
        rejected.push(p.id);
        continue;
      }
      if (
        Math.hypot(mapPixel.x - batchPixel.x, mapPixel.y - batchPixel.y) >
        MAX_DISAGREEMENT_PX
      ) {
        rejected.push(p.id);
        continue;
      }

      // Held out only where the landmark's position owes nothing to this keyframe. A landmark
      // already observed in B would be being asked to predict its own input.
      const heldOut = !l.keyframes.includes(batch.keyframeB);
      if (!heldOut) {
        merged.push(p.id);
        continue;
      }
      const errorPx = Math.hypot(mapPixel.x - p.observedX, mapPixel.y - p.observedY);
      predictions.push({ id: p.id, errorPx: round(errorPx, 4), observationsAtPrediction: l.observations });
      // Refused past twice the ceiling, for the reason `MAX_DISAGREEMENT_PX` gives — and the
      // ceiling itself still bites, one level up: a landmark whose *running mean* prediction
      // error sits past it is culled by `cull()` even when no single observation was refused.
      if (errorPx > MAX_DISAGREEMENT_PX) rejected.push(p.id);
      else merged.push(p.id);
    }

    return {
      state: IngestState.REGISTERED,
      reason:
        `registered against ${shared.length} shared landmark(s) at a scale of ` +
        `${round(registration.scale, 4)} and a residual of ${round(registration.residual, 4)}`,
      shared: shared.length,
      registration,
      poseA,
      poseB,
      predictions,
      rejected,
      merged,
      admitted,
    };
  }

  /** Register the batch, fold it in, cull what has stopped agreeing, and stay inside the bound. */
  ingest(batch: LandmarkBatch): IngestOutcome {
    const plan = this.evaluate(batch);
    if (plan.state !== IngestState.REGISTERED || !plan.registration || !plan.poseB) {
      this.unregisteredRun++;
      // §H.8's three-way distinction: failed, restarted, and interrupted for a reason we can
      // name. A run of batches the map cannot register is the third until it is clearly the
      // second, and the count of epochs goes into the record so a run that restarted several
      // times is not read as one that never did.
      // Only a batch with something in it can seed a new world. The first version restarted on
      // any run of five, including one that ended on a batch with no points — which cleared the
      // map, re-ingested nothing, and reported `EPOCH_RESTART` with **no registration behind
      // it**. The leg caught it as one batch ingested without a registration, which is MAP-003's
      // failure condition and was exactly right about it.
      if (this.unregisteredRun >= EPOCH_RESTART_AFTER && batch.points.length > 0) {
        this.landmarks.clear();
        this.poses.clear();
        this.epoch++;
        this.unregisteredRun = 0;
        const restarted = this.ingest(batch);
        return {
          ...restarted,
          // ...and the restart is only claimed when the new world actually took. A batch that
          // could not seed one leaves the state it earned.
          state:
            restarted.state === IngestState.REGISTERED
              ? IngestState.EPOCH_RESTART
              : restarted.state,
          reason:
            `${EPOCH_RESTART_AFTER} consecutive batches could not be registered, so the world ` +
            `has been redefined from this one — epoch ${this.epoch}. The previous epoch's ` +
            'landmarks are gone rather than silently reused in a frame they do not belong to',
          epochRestarted: true,
        };
      }
      return {
        ...plan,
        // An unregistered batch admits nothing, and its points are accounted for as refused
        // rather than as absent — MAP-009's counts have to add up on every batch.
        rejected: batch.points.map((p) => p.id),
        merged: [],
        admitted: [],
        culled: [],
        landmarks: this.landmarks.size,
        confirmed: this.confirmedCount(),
        epoch: this.epoch,
        epochRestarted: false,
      };
    }
    this.unregisteredRun = 0;

    const reg = plan.registration;
    const rejected = new Set(plan.rejected);
    const errorById = new Map(plan.predictions.map((p) => [p.id, p.errorPx]));

    for (const p of batch.points) {
      if (rejected.has(p.id)) continue;
      const world = apply3x3(reg.rotation, p.position).map(
        (v, i) => reg.scale * v + (reg.translation[i] ?? 0),
      );
      const existing = this.landmarks.get(p.id);
      const worldDepth = Math.max(1e-9, p.depth * reg.scale);
      if (!existing || existing.epoch !== this.epoch) {
        this.landmarks.set(p.id, {
          id: p.id,
          position: world,
          observations: 1,
          keyframes: [batch.keyframeA, batch.keyframeB],
          maxParallaxDeg: p.parallaxDeg,
          meanPredictionPx: -1,
          predictions: 0,
          lastMoveRelative: -1,
          confidence: 0,
          state: LandmarkState.CANDIDATE,
          epoch: this.epoch,
        });
      } else {
        // A running mean. The move a new observation causes falls like 1/n, which is what
        // MAP-006 measures — a map that re-guesses each time random-walks instead.
        const n = existing.observations;
        const position = this.update(existing, world, n);
        const move = Math.hypot(
          (position[0] ?? 0) - (existing.position[0] ?? 0),
          (position[1] ?? 0) - (existing.position[1] ?? 0),
          (position[2] ?? 0) - (existing.position[2] ?? 0),
        );
        const errorPx = errorById.get(p.id);
        const predictions = errorPx === undefined ? existing.predictions : existing.predictions + 1;
        const meanPredictionPx =
          errorPx === undefined
            ? existing.meanPredictionPx
            : existing.meanPredictionPx < 0
              ? errorPx
              : (existing.meanPredictionPx * existing.predictions + errorPx) / predictions;
        this.landmarks.set(p.id, {
          ...existing,
          position,
          observations: n + 1,
          keyframes: trimKeyframes([...existing.keyframes, batch.keyframeB]),
          maxParallaxDeg: Math.max(existing.maxParallaxDeg, p.parallaxDeg),
          meanPredictionPx,
          predictions,
          lastMoveRelative: round(move / worldDepth, 6),
          state:
            n + 1 >= MIN_OBSERVATIONS_CONFIRMED ? LandmarkState.CONFIRMED : LandmarkState.CANDIDATE,
        });
      }
      const updated = this.landmarks.get(p.id);
      if (updated) this.landmarks.set(p.id, { ...updated, confidence: confidenceOf(updated) });
    }

    this.poses.set(batch.keyframeA, plan.poseA ?? { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] });
    this.poses.set(batch.keyframeB, plan.poseB);
    this.trimPoses();

    const culled = this.cull();

    return {
      ...plan,
      culled,
      landmarks: this.landmarks.size,
      confirmed: this.confirmedCount(),
      epoch: this.epoch,
      epochRestarted: false,
    };
  }

  /**
   * Fit the batch's frame to the world over the landmarks they share.
   *
   * Trimmed least squares, **iterated**: solve, measure every residual against that solution,
   * drop anything beyond `REGISTRATION_OUTLIER_FACTOR` medians, solve again — up to
   * `REGISTRATION_TRIM_PASSES` times. Not RANSAC: a similarity over shared landmarks is not the
   * ill-posed problem a two-view model is, and the points come from a map that has already
   * refused what it disagreed with once.
   *
   * **One pass is not enough, and MAP-005 is what showed it.** With the injection displacing 30 %
   * of the batch, the first least-squares solution is dragged by roughly that share of the
   * displacement — so the *clean* points inherit a residual of their own, the median-based band
   * opens to accommodate it, and part of the corruption survives into the second solve. The gate
   * then rejected up to 88 % of the untouched points, which is the failure a recall figure alone
   * would have hidden. Each further pass tightens the band around a cleaner solution; three
   * converge on this data, and the count of what was dropped goes into the record.
   */
  private fit(shared: readonly LandmarkPoint[]): Similarity | null {
    const source = shared.map((p) => [...p.position]);
    const target = shared.map((p) => [...(this.landmarks.get(p.id)?.position ?? [0, 0, 0])]);
    const medianDepth = Math.max(1e-9, median(shared.map((p) => p.depth)));

    let solution = similarityFrom(source, target);
    if (!solution) return null;
    let keptSource = source;
    let keptTarget = target;

    for (let pass = 0; pass < REGISTRATION_TRIM_PASSES; pass++) {
      const fitted = solution;
      // Residuals are measured against **every** shared point on every pass, not only against
      // the survivors of the last one: a point the previous band excluded on a dragged solution
      // deserves to be reconsidered once the solution is cleaner.
      //
      // In **world units**, unlike the gate, and that difference was measured rather than
      // assumed. Trimming in the image was tried — the gate's own lesson, applied here — and it
      // made things worse: a similarity's scale is a depth quantity, and a metric that cannot
      // see depth leaves it under-constrained, so the fit wandered and the clean rejections rose
      // from 0–12 % to 15–22 %. The gate compares two estimates of *one* point, where the radial
      // disagreement is the unobservable one; the fit determines a *scale*, where it is the
      // whole signal. Same numbers, opposite conclusions.
      const residuals = source.map((s, i) =>
        distanceBetween(applySimilarity(fitted, s), target[i] ?? [0, 0, 0]),
      );
      const limit = REGISTRATION_OUTLIER_FACTOR * Math.max(1e-9, median(residuals));
      const nextSource: number[][] = [];
      const nextTarget: number[][] = [];
      for (let i = 0; i < source.length; i++) {
        if ((residuals[i] ?? 0) > limit) continue;
        nextSource.push(source[i] ?? [0, 0, 0]);
        nextTarget.push(target[i] ?? [0, 0, 0]);
      }
      if (nextSource.length < MIN_REGISTRATION_POINTS) break;
      const refit = similarityFrom(nextSource, nextTarget);
      if (!refit) break;
      solution = refit;
      keptSource = nextSource;
      keptTarget = nextTarget;
    }

    const finalResiduals = keptSource.map((s, i) =>
      distanceBetween(applySimilarity(solution, s), keptTarget[i] ?? [0, 0, 0]),
    );

    return {
      scale: solution.scale,
      rotation: solution.rotation,
      translation: solution.translation,
      // Relative to the depth, because the world's unit is a baseline nobody has measured.
      residual: round(median(finalResiduals) / (medianDepth * Math.max(1e-9, solution.scale)), 6),
      used: keptSource.length,
      outliers: source.length - keptSource.length,
    };
  }

  /**
   * Remove what the room has stopped agreeing with, then what §56's bound has no room for.
   *
   * The order matters: a landmark culled for disagreeing is a finding, and one culled for the
   * bound is a resource decision. Doing the bound first would report the first as the second.
   */
  private cull(): CullRecord[] {
    const culled: CullRecord[] = [];
    for (const l of [...this.landmarks.values()]) {
      if (l.predictions >= 2 && l.meanPredictionPx > MAX_LANDMARK_REPROJECTION_PX) {
        this.landmarks.delete(l.id);
        culled.push({
          id: l.id,
          reason: CullReason.DISAGREES,
          detail:
            `its predictions land ${round(l.meanPredictionPx, 3)} px from where it is seen, over ` +
            `${l.predictions} of them — past v3 §33's ${MAX_LANDMARK_REPROJECTION_PX} px`,
        });
      }
    }
    if (this.landmarks.size > MAX_LANDMARKS) {
      // The least confident go, and confidence is a measurement rather than an age — so what is
      // dropped is what the map knows least about, not what it saw longest ago.
      const ordered = [...this.landmarks.values()].sort((a, b) => a.confidence - b.confidence);
      const excess = this.landmarks.size - MAX_LANDMARKS;
      for (let i = 0; i < excess; i++) {
        const l = ordered[i];
        if (!l) continue;
        this.landmarks.delete(l.id);
        culled.push({
          id: l.id,
          reason: CullReason.BOUND,
          detail:
            `§56 bounds the map at ${MAX_LANDMARKS} and this was the least confident of them ` +
            `at ${round(l.confidence, 3)}`,
        });
      }
    }
    return culled;
  }

  private trimPoses(): void {
    if (this.poses.size <= MAX_KEYFRAME_POSES) return;
    const keys = [...this.poses.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length - MAX_KEYFRAME_POSES; i++) {
      const key = keys[i];
      if (key !== undefined) this.poses.delete(key);
    }
  }
}

/**
 * A landmark's confidence, from what has been measured about it and nothing else.
 *
 * Four terms, combined as the **minimum** — the arrangement Phases 6 and 7 use, and for the same
 * reason: a combination that can be dragged up by one good term is a combination that hides a bad
 * one. None of the four is a clock, and `scripts/audit-fake-data.mjs` enforces that mechanically
 * rather than by review.
 */
export function confidenceOf(l: Landmark): number {
  const observed = clamp01(l.observations / (MIN_OBSERVATIONS_CONFIRMED + 2));
  // Three times Phase 9's floor: the parallax at which the depth is good to a thirtieth rather
  // than a tenth of itself.
  const parallax = clamp01(l.maxParallaxDeg / (3 * MIN_PARALLAX_DEG));
  const agreement =
    l.predictions === 0 || l.meanPredictionPx < 0
      ? 1
      : clamp01(1 - l.meanPredictionPx / MAX_LANDMARK_REPROJECTION_PX);
  const viewpoints = clamp01(l.keyframes.length / MIN_OBSERVATIONS_CONFIRMED);
  return round(Math.min(observed, parallax, agreement, viewpoints), 4);
}

/**
 * The similarity taking `source` onto `target`, in closed form (Umeyama 1991).
 *
 * `target ≈ c · R · source + t`, seven degrees of freedom from three or more point pairs. The
 * reflection guard is the part that is usually missing: without forcing `det(R) = +1` the fit
 * will happily return a reflection when the points are nearly coplanar, which is a transform no
 * camera motion can produce and which places every landmark on the wrong side of the plane.
 */
export function similarityFrom(
  source: readonly (readonly number[])[],
  target: readonly (readonly number[])[],
): Omit<Similarity, 'residual' | 'used' | 'outliers'> | null {
  const n = Math.min(source.length, target.length);
  if (n < 3) return null;

  const ms = centroid(source, n);
  const mt = centroid(target, n);
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const s = source[i] ?? [0, 0, 0];
    const t = target[i] ?? [0, 0, 0];
    const ds = [ (s[0] ?? 0) - (ms[0] ?? 0), (s[1] ?? 0) - (ms[1] ?? 0), (s[2] ?? 0) - (ms[2] ?? 0) ];
    const dt = [ (t[0] ?? 0) - (mt[0] ?? 0), (t[1] ?? 0) - (mt[1] ?? 0), (t[2] ?? 0) - (mt[2] ?? 0) ];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        cov[r * 3 + c] = (cov[r * 3 + c] ?? 0) + (dt[r] ?? 0) * (ds[c] ?? 0);
      }
    }
    variance += (ds[0] ?? 0) ** 2 + (ds[1] ?? 0) ** 2 + (ds[2] ?? 0) ** 2;
  }
  for (let i = 0; i < 9; i++) cov[i] = (cov[i] ?? 0) / n;
  variance /= n;
  if (!(variance > 1e-18)) return null;

  const svd = svd3x3(cov);
  if (!svd) return null;
  const reflected = determinant3x3(svd.u) * determinant3x3(svd.v) < 0;
  const s = [1, 0, 0, 0, 1, 0, 0, 0, reflected ? -1 : 1];
  const rotation = multiply3x3(multiply3x3(svd.u, s), transpose3x3(svd.v));
  const trace =
    (svd.s[0] ?? 0) * 1 + (svd.s[1] ?? 0) * 1 + (svd.s[2] ?? 0) * (reflected ? -1 : 1);
  const scale = trace / variance;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const translation = mt.map((v, i) => v - scale * (apply3x3(rotation, ms)[i] ?? 0));
  return { scale, rotation, translation };
}

export function applySimilarity(
  s: Omit<Similarity, 'residual' | 'used' | 'outliers'>,
  x: readonly number[],
): number[] {
  return apply3x3(s.rotation, x).map((v, i) => s.scale * v + (s.translation[i] ?? 0));
}

/* -------------------------------------------------------------------------- */

function identitySimilarity(): Similarity {
  return {
    scale: 1,
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [0, 0, 0],
    residual: 0,
    used: 0,
    outliers: 0,
  };
}

function refuse(
  reason: string,
  shared: number,
  batch: LandmarkBatch,
  registration: Similarity | null = null,
): IngestPlan {
  return {
    state: IngestState.UNREGISTERED,
    reason,
    shared,
    registration,
    poseA: null,
    poseB: null,
    predictions: [],
    rejected: batch.points.map((p) => p.id),
    merged: [],
    admitted: [],
  };
}

function trimKeyframes(list: readonly number[]): number[] {
  const unique = [...new Set(list)];
  return unique.slice(Math.max(0, unique.length - MAX_KEYFRAMES_PER_LANDMARK));
}

function centroid(points: readonly (readonly number[])[], n: number): number[] {
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p = points[i] ?? [0, 0, 0];
    c[0] = (c[0] ?? 0) + (p[0] ?? 0);
    c[1] = (c[1] ?? 0) + (p[1] ?? 0);
    c[2] = (c[2] ?? 0) + (p[2] ?? 0);
  }
  return c.map((v) => v / n);
}

/**
 * The pose of a batch's second keyframe implied by a candidate registration.
 *
 * `X_world = c R X_A + t`, so the camera A transform in world units is `X_A = Rᵀ X_world − Rᵀt`,
 * and B follows from the batch's own rotation and its translation scaled into world units.
 */
export function poseBFor(
  registration: Omit<Similarity, 'residual' | 'used' | 'outliers'>,
  batch: LandmarkBatch,
): KeyframePose {
  const rt = transpose3x3(registration.rotation);
  const poseA: KeyframePose = {
    rotation: rt,
    translation: apply3x3(rt, registration.translation).map((v) => -v),
  };
  return {
    rotation: multiply3x3(batch.rotation, poseA.rotation),
    translation: apply3x3(batch.rotation, poseA.translation).map(
      (v, i) => v + registration.scale * (batch.translation[i] ?? 0),
    ),
  };
}

/** `X_camera = R · X_world + t`. */
function inCameraFrame(pose: KeyframePose, x: readonly number[]): number[] {
  return apply3x3(pose.rotation, x).map((v, i) => v + (pose.translation[i] ?? 0));
}

function distanceBetween(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}

/** Re-exported so the stage, the screen and the tests name one scale. */
export { SCALE_LOCAL_UNITS };
