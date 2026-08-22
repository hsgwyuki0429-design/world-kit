/**
 * The tracked population: features with a history, frame to frame (§12, §13, §33).
 *
 * Phase 3 detected independently on every frame, so `age` was 0 and `trackLength` was 1 on
 * every record. This is the first stage in which a feature persists — and the first whose
 * output can be convincingly faked, because a list of points that never moves is exactly what
 * a perfectly tracked static scene looks like. Three decisions here exist for that reason.
 *
 * **1. Tracked and redetected are counted separately, always.** §11's refill ladder is still
 * running underneath: when the population falls the detector tops it back up. That means a
 * tracker which loses *every* point still shows a population near target, because detection
 * replaced them — the count hides a total failure. So `tracked` counts only points carried
 * forward from the previous frame, `redetected` counts what detection added, and every
 * survival figure in Phase 4 is computed from the first alone.
 *
 * **2. A point that failed to track is dropped, never returned where it was.** The solver
 * reports failures as failures (see `LucasKanade`) and this class deletes them. Returning a
 * point at its previous position would be indistinguishable from tracking it perfectly on a
 * static scene, and it would climb `age` and `trackLength` while doing it.
 *
 * **3. `age` and `trackLength` advance only on survival, and reset on redetection.** They
 * are the only fields whose value is a claim about history, so they are the fields a fake
 * would most easily inflate. FLOW-007 checks that no record claims a `trackLength` longer
 * than the number of frames since it appeared, and this class makes that true by
 * construction: both counters are incremented in exactly one place, on the survivor path.
 *
 * Pure array arithmetic over grayscale planes and its own state: no DOM, no worker, no
 * camera, no clock. The frame counter it advances is its own, not a wall clock, so a run can
 * be replayed frame by frame in a unit test and produce the same records.
 */

import type { Feature } from './featureTypes';
import { FEATURE_MAX, GRID_CELLS, cellIndexFor } from './featureTypes';
import {
  FbBand,
  LucasKanade,
  TrackStatus,
  solverFlow,
  trackWithValidation,
} from './LucasKanade';
import type { FlowSolve, ImagePlane, ValidatedTrack } from './LucasKanade';
import {
  deriveTrackingState,
  frameCountsAsFailure,
} from './trackingState';
import type { StateDerivation, TrackingMeasurement } from './trackingState';

/** Cells with fewer than this many tracked points say nothing about the local flow. */
export const MIN_CELL_POINTS_FOR_SPREAD = 3;
/** ...and a spread over fewer than this many cells is not a description of a field. */
export const MIN_CELLS_FOR_SPREAD = 4;

/** A feature that has been followed. Extends §11's record; adds nothing §11 does not list. */
export interface TrackedFeature extends Feature {
  /** The frame this feature was first detected in, on this tracker's own counter. */
  readonly bornFrame: number;
  /** Displacement from the previous frame to this one, level-0 px. 0 on the frame it appeared. */
  readonly displacement: number;
  /**
   * The detection level's scale, carried so `x`/`y` stay meaningful after tracking.
   *
   * §11's record has both a detection-level position and a level-0 one, and Phase 3 set them
   * at the same instant. Tracking works entirely in level-0 pixels, so the detection-level
   * pair is derived from `x0`/`y0` and this scale rather than being tracked separately —
   * which keeps the two from drifting apart and saying different things about one point.
   */
  readonly levelScale: number;
}

export interface FlowStepResult {
  /** Points handed to the solver — the previous frame's population. */
  readonly offered: number;
  /** ...that survived tracking *and* §13's forward/backward band. */
  readonly tracked: number;
  /** Rejected because the solver could not follow them at all. */
  readonly failedToTrack: number;
  /** Rejected by §13: forward/backward error above 3.0 px, or unmeasurable. */
  readonly rejectedByFb: number;
  /** Kept, but in §13's reduced-confidence band. */
  readonly reducedConfidence: number;
  /** `tracked / offered`. `-1` when nothing was offered, which is not a survival of 0. */
  readonly survival: number;
  /** Median displacement of the survivors, level-0 px. `-1` when there are none. */
  readonly medianDisplacementPx: number;
  /** Median §13 round-trip error over the survivors. `-1` when there are none. */
  readonly medianFbErrorPx: number;
  readonly fbAcceptable: number;
  readonly fbReduced: number;
  readonly fbRejected: number;
  /**
   * Spread of the per-cell mean displacement across the 8×6 grid, level-0 px.
   *
   * The population standard deviation over cells holding at least
   * `MIN_CELL_POINTS_FOR_SPREAD` survivors. A pure translation of a flat scene moves every
   * cell by the same amount and scores near zero; a rotation does not. `-1` when too few
   * cells were populated for the number to describe a field (FLOW-003 needs this).
   */
  readonly cellSpread: number;
  readonly occupiedFlowCells: number;
  /** Longest surviving track in the population, in frames. */
  readonly maxTrackLength: number;
  readonly medianAge: number;
  /** Whether this frame counted as a tracking failure for §33's consecutive rule. */
  readonly frameFailed: boolean;
  readonly consecutiveFailedFrames: number;
  /**
   * How many times the frame geometry has changed during this run.
   *
   * A tier step (§53) or a device rotation (§H.0) makes the previous frame and the population
   * incomparable with the current one. It is a discontinuity with a known cause, so it is
   * neither a tracking failure nor a fresh start — but it is not nothing either, and a run
   * with a dozen of them has had its population rebuilt a dozen times. Counted so that shows.
   */
  readonly geometryChanges: number;
}

const EMPTY_STEP: FlowStepResult = {
  offered: 0,
  tracked: 0,
  failedToTrack: 0,
  rejectedByFb: 0,
  reducedConfidence: 0,
  survival: -1,
  medianDisplacementPx: -1,
  medianFbErrorPx: -1,
  fbAcceptable: 0,
  fbReduced: 0,
  fbRejected: 0,
  cellSpread: -1,
  occupiedFlowCells: 0,
  maxTrackLength: 0,
  medianAge: 0,
  frameFailed: false,
  consecutiveFailedFrames: 0,
  geometryChanges: 0,
};

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}

export class FlowTracker {
  private readonly solve: FlowSolve;
  /**
   * How far in from the border a point must sit for the solver's window to cover it, in
   * level-0 pixels.
   *
   * Taken from the solver's own configuration rather than written down, so a change to §12's
   * window size cannot leave this stale.
   */
  private readonly trackableMargin: number;

  /** The population as of the last completed frame, in level-0 coordinates. */
  private population: TrackedFeature[] = [];
  /** Our own copy of the previous frame's pyramid — see `retain`. */
  private retained: { data: Uint8Array; width: number; height: number }[] = [];
  private retainedSignature = '';
  private allocationCount = 0;

  private nextId = 1;
  private frameIndex = 0;
  private everTracked = false;
  private consecutiveFailedFrames = 0;
  private geometryChanges = 0;
  private lastStep: FlowStepResult = EMPTY_STEP;

  /**
   * @param solve replaces the Lucas-Kanade solver, in *both* directions.
   *
   * It exists so a unit test can drive the whole of Phase 4 with a tracker that returns its
   * input — the population, the state machine, the statistics, the test suite — and show that
   * FLOW-002 rejects it. Both directions, because a fake that replaced only the forward pass
   * would be caught by §13 and so would not be the failure this phase is built to catch: a
   * short-circuiting solver short-circuits both ways and scores a perfect round trip.
   * Nothing in production passes this; the default is the real solver.
   */
  constructor(solver: LucasKanade = new LucasKanade(), solve?: FlowSolve) {
    this.solve = solve ?? solverFlow(solver);
    this.trackableMargin = solver.getConfig().halfWindow + 1;
  }

  get allocations(): number {
    return this.allocationCount;
  }

  getPopulation(): readonly TrackedFeature[] {
    return this.population;
  }

  getFrameIndex(): number {
    return this.frameIndex;
  }

  hasPrevious(): boolean {
    return this.retained.length > 0;
  }

  getLastStep(): FlowStepResult {
    return this.lastStep;
  }

  /**
   * Forget everything.
   *
   * Used when tracking is stopped or the processing size changes under us. A population in
   * level-0 coordinates from a 1280×720 frame means nothing on a 640×360 one, and carrying it
   * across would produce displacements that are an artefact of the tier ladder rather than of
   * the scene (§H.0: rotation changes the frame geometry mid-run, so this does happen).
   */
  reset(): void {
    this.population = [];
    this.retained = [];
    this.retainedSignature = '';
    this.everTracked = false;
    this.consecutiveFailedFrames = 0;
    this.geometryChanges = 0;
    this.lastStep = EMPTY_STEP;
  }

  /**
   * Track the population from the retained frame into `levels`.
   *
   * Returns the empty step on the first frame after a reset: there is no predecessor, so
   * there is nothing to track, and reporting a survival of 0 there would look like a tracker
   * that lost everything.
   */
  step(levels: readonly ImagePlane[]): FlowStepResult {
    this.frameIndex++;

    const signature = levels.map((l) => `${l.width}x${l.height}`).join(',');
    if (signature !== this.retainedSignature) {
      // Geometry changed: §53's tier ladder stepped, or the device rotated and swapped the
      // frame dimensions (§H.0). The retained frame and the population both describe an image
      // that no longer exists, so both go.
      //
      // **What does not go is `everTracked`, and that distinction cost a leg run.** Clearing
      // it put the state back to READY — "no frame pair has been tracked yet" — in the middle
      // of a run that had tracked thousands, and it cleared the consecutive-failure counter
      // with it. Measured on the Phase 4 leg: a tier step landed inside a covered-lens
      // segment, §33's counter restarted from zero, and a 14-frame occlusion never reached
      // LOST. FLOW-005 caught it as "tracking was maintained through a covered lens", which
      // is what it looked like from outside.
      //
      // A geometry change is a discontinuity this code *knows the reason for*. It is not a
      // tracking failure, so it does not count toward LOST; and it is not a return to the
      // start of the run, so it does not report READY. The population is empty and the state
      // says DEGRADED until detection rebuilds it, which is exactly true. `geometryChanges`
      // carries the count into the evidence so a run that stepped tiers is visible as one.
      const previouslyTracked = this.everTracked;
      this.population = [];
      this.consecutiveFailedFrames = 0;
      // The first frame of a run configures the geometry; it does not change it. Counting it
      // would put a 1 in every bundle and make the number useless for spotting a run that
      // actually stepped tiers.
      if (this.retainedSignature !== '') this.geometryChanges++;
      this.retain(levels, signature);
      const step: FlowStepResult = { ...EMPTY_STEP, geometryChanges: this.geometryChanges };
      this.everTracked = previouslyTracked;
      this.lastStep = step;
      return step;
    }

    if (this.population.length === 0) {
      this.retain(levels, signature);
      if (!this.everTracked) {
        // Nothing has been tracked yet and there is nothing to track. Not a failure: there
        // was no population to lose.
        this.lastStep = EMPTY_STEP;
        return EMPTY_STEP;
      }
      // There *was* a population and now there is none, and detection has not restored it.
      // That is a failed frame, not an absence of information — without this the population
      // going to zero reads as DEGRADED forever, because §33's consecutive-failure counter
      // would never advance again, and FLOW-005's "LOST within 1.0 s" could not be met by a
      // correct implementation.
      this.consecutiveFailedFrames++;
      const step: FlowStepResult = {
        ...EMPTY_STEP,
        frameFailed: true,
        consecutiveFailedFrames: this.consecutiveFailedFrames,
        geometryChanges: this.geometryChanges,
      };
      this.lastStep = step;
      return step;
    }

    const offered = this.population.length;
    const points = new Float64Array(offered * 2);
    for (let i = 0; i < offered; i++) {
      const f = this.population[i];
      points[i * 2] = f?.x0 ?? 0;
      points[i * 2 + 1] = f?.y0 ?? 0;
    }

    const validated = trackWithValidation(this.solve, this.retained, levels, points);

    const base = levels[0];
    const width = base?.width ?? 0;
    const height = base?.height ?? 0;

    const survivors: TrackedFeature[] = [];
    const displacements: number[] = [];
    const fbErrors: number[] = [];
    const ages: number[] = [];
    const cellSum = new Float64Array(GRID_CELLS);
    const cellCount = new Int32Array(GRID_CELLS);
    let failedToTrack = 0;
    let rejectedByFb = 0;
    let reduced = 0;
    let fbAcceptable = 0;
    let fbReduced = 0;
    let fbRejected = 0;
    let maxTrackLength = 0;

    for (let i = 0; i < offered; i++) {
      const prev = this.population[i];
      const v = validated[i];
      if (!prev || !v) continue;

      if (!isSolved(v)) {
        failedToTrack++;
        continue;
      }
      if (v.band === FbBand.ACCEPTABLE) fbAcceptable++;
      else if (v.band === FbBand.REDUCED) fbReduced++;
      else fbRejected++;

      if (v.band === FbBand.REJECT) {
        // §13: above 3.0 px, or unmeasurable, is a reject. It is dropped from the population
        // rather than kept with a bad score, because Phase 5 will consume these as
        // correspondences.
        rejectedByFb++;
        continue;
      }
      if (v.band === FbBand.REDUCED) reduced++;

      const x0 = v.forward.x;
      const y0 = v.forward.y;
      const dx = x0 - prev.x0;
      const dy = y0 - prev.y0;
      const displacement = Math.sqrt(dx * dx + dy * dy);

      const cell = cellIndexFor(prev.x0, prev.y0, width, height);
      cellSum[cell] = (cellSum[cell] ?? 0) + displacement;
      cellCount[cell] = (cellCount[cell] ?? 0) + 1;

      const trackLength = prev.trackLength + 1;
      if (trackLength > maxTrackLength) maxTrackLength = trackLength;
      displacements.push(displacement);
      if (v.error !== null) fbErrors.push(v.error);
      ages.push(prev.age + 1);

      const scale = prev.levelScale > 0 ? prev.levelScale : 1;
      survivors.push({
        ...prev,
        // Derived from the level-0 position, never tracked alongside it — see `levelScale`.
        x: x0 / scale,
        y: y0 / scale,
        x0,
        y0,
        age: prev.age + 1,
        trackLength,
        forwardBackwardError: v.error === null ? null : round(v.error),
        // Phase 6 owns this and has not run. A number here would be invented (§80).
        reprojectionError: null,
        cell: cellIndexFor(x0, y0, width, height),
        displacement: round(displacement),
      });
    }

    this.population = survivors;
    this.everTracked = true;
    this.retain(levels, signature);

    const frameFailed = frameCountsAsFailure(offered, survivors.length);
    this.consecutiveFailedFrames = frameFailed ? this.consecutiveFailedFrames + 1 : 0;

    // Per-cell mean displacement, then its spread. Only cells with enough survivors to have
    // a local mean at all; a cell holding one point describes that point, not the field.
    const cellMeans: number[] = [];
    let occupied = 0;
    for (let c = 0; c < GRID_CELLS; c++) {
      const n = cellCount[c] ?? 0;
      if (n > 0) occupied++;
      if (n >= MIN_CELL_POINTS_FOR_SPREAD) cellMeans.push((cellSum[c] ?? 0) / n);
    }
    let cellSpread = -1;
    if (cellMeans.length >= MIN_CELLS_FOR_SPREAD) {
      const mean = cellMeans.reduce((a, b) => a + b, 0) / cellMeans.length;
      const variance =
        cellMeans.reduce((a, b) => a + (b - mean) * (b - mean), 0) / cellMeans.length;
      cellSpread = round(Math.sqrt(variance));
    }

    const step: FlowStepResult = {
      offered,
      tracked: survivors.length,
      failedToTrack,
      rejectedByFb,
      reducedConfidence: reduced,
      survival: offered > 0 ? round(survivors.length / offered, 4) : -1,
      medianDisplacementPx: round(median(displacements)),
      medianFbErrorPx: round(median(fbErrors)),
      fbAcceptable,
      fbReduced,
      fbRejected,
      cellSpread,
      occupiedFlowCells: occupied,
      maxTrackLength,
      medianAge: round(median(ages), 1),
      frameFailed,
      consecutiveFailedFrames: this.consecutiveFailedFrames,
      geometryChanges: this.geometryChanges,
    };
    this.lastStep = step;
    return step;
  }

  /**
   * Add freshly detected features to the population, keeping the survivors.
   *
   * New features are only admitted where no survivor already sits within `separation0`: a
   * detection that lands on a point already being tracked would double-count it and, worse,
   * would let a redetected point inherit a tracked point's place in the population while
   * carrying `age` 0. Returns how many were actually added — which is what `redetected`
   * reports, and it is deliberately not the number the detector produced.
   */
  merge(
    detected: readonly Feature[],
    separation0: number,
    width: number,
    height: number,
    levelScale: number,
  ): number {
    if (detected.length === 0) return 0;
    const m = this.trackableMargin;
    const sep = Math.max(1, separation0);
    const sepSq = sep * sep;
    let added = 0;

    // Occupancy grid at the separation radius, so each candidate checks nine buckets rather
    // than the whole population. The same structure the detector's selector uses, for the
    // same reason: at 800 points the pairwise version is 640 000 comparisons a frame.
    const gw = Math.max(1, Math.ceil(width / sep));
    const gh = Math.max(1, Math.ceil(height / sep));
    const buckets = new Map<number, { x: number; y: number }[]>();
    const bucketOf = (x: number, y: number): number => {
      const bx = Math.min(gw - 1, Math.max(0, Math.floor(x / sep)));
      const by = Math.min(gh - 1, Math.max(0, Math.floor(y / sep)));
      return by * gw + bx;
    };
    const place = (x: number, y: number): void => {
      const key = bucketOf(x, y);
      const list = buckets.get(key);
      if (list) list.push({ x, y });
      else buckets.set(key, [{ x, y }]);
    };
    for (const existing of this.population) place(existing.x0, existing.y0);

    for (const f of detected) {
      if (this.population.length >= FEATURE_MAX) break;
      // A point the solver's window cannot cover is not a trackable feature, and admitting
      // one costs twice: it inflates `redetected` with something that was never followable,
      // and it is lost on the very next frame, which drags the *tracked* survival down with
      // a failure that says nothing about the tracker.
      //
      // Measured: detection at level 1 keeps a 5 px margin in that level's pixels — 10 in
      // level-0 pixels — while a 21×21 window at level 0 needs 11. That one-pixel band was
      // 15 % of the population on a synthetic scene, and it made FLOW-001's survival read
      // 84.6 % on a perfectly static image that the tracker had in fact followed exactly.
      if (
        f.x0 < m ||
        f.y0 < m ||
        f.x0 >= width - m - 1 ||
        f.y0 >= height - m - 1
      ) {
        continue;
      }
      const bx = Math.min(gw - 1, Math.max(0, Math.floor(f.x0 / sep)));
      const by = Math.min(gh - 1, Math.max(0, Math.floor(f.y0 / sep)));
      let tooClose = false;
      for (let ny = by - 1; ny <= by + 1 && !tooClose; ny++) {
        if (ny < 0 || ny >= gh) continue;
        for (let nx = bx - 1; nx <= bx + 1 && !tooClose; nx++) {
          if (nx < 0 || nx >= gw) continue;
          for (const p of buckets.get(ny * gw + nx) ?? []) {
            const dx = p.x - f.x0;
            const dy = p.y - f.y0;
            if (dx * dx + dy * dy < sepSq) {
              tooClose = true;
              break;
            }
          }
        }
      }
      if (tooClose) continue;
      place(f.x0, f.y0);
      this.population.push({
        ...f,
        id: this.nextId++,
        // A redetected feature has no history, and it does not borrow one. FLOW-007 checks
        // that `trackLength` never exceeds the frames since the record appeared, and this is
        // where that is made true.
        age: 0,
        trackLength: 1,
        // Nothing has been tracked for this point yet, so there is no round trip to report.
        // `null` rather than `0`, for the reason `featureTypes` gives at length.
        forwardBackwardError: null,
        reprojectionError: null,
        cell: cellIndexFor(f.x0, f.y0, width, height),
        bornFrame: this.frameIndex,
        displacement: 0,
        levelScale: levelScale > 0 ? levelScale : 1,
      });
      added++;
    }
    return added;
  }

  /** §33's state for the population as it now stands, from the one shared function. */
  state(inlierRatio: number | null = null, reprojectionError: number | null = null): StateDerivation {
    return deriveTrackingState(this.measurement(inlierRatio, reprojectionError));
  }

  /**
   * The inputs the state is derived from, exposed so the evidence can carry them.
   *
   * The statistics on the main thread recompute the state from exactly these and count any
   * frame where their answer differs from the one the worker reported — the Rule 002 check
   * Phase 3 introduced, applied to a state with more inputs.
   */
  measurement(
    inlierRatio: number | null = null,
    reprojectionError: number | null = null,
  ): TrackingMeasurement {
    return {
      everTracked: this.everTracked,
      trackedCount: this.lastStep.tracked,
      totalCount: this.population.length,
      consecutiveFailedFrames: this.consecutiveFailedFrames,
      inlierRatio,
      reprojectionError,
    };
  }

  /**
   * Keep our own copy of the frame we will track *from* next time.
   *
   * `GrayPyramid` reuses one buffer per level and overwrites it on the next frame, so a
   * reference would silently become a reference to the wrong image — and the failure would
   * be a tracker matching each frame against itself, which is the fake this phase exists to
   * rule out. Allocated when the geometry changes and never per frame.
   */
  private retain(levels: readonly ImagePlane[], signature: string): void {
    if (signature !== this.retainedSignature || this.retained.length !== levels.length) {
      this.retained = levels.map((l) => {
        this.allocationCount++;
        return { data: new Uint8Array(l.width * l.height), width: l.width, height: l.height };
      });
      this.retainedSignature = signature;
    }
    for (let i = 0; i < levels.length; i++) {
      const src = levels[i];
      const dst = this.retained[i];
      if (!src || !dst) continue;
      dst.data.set(src.data.subarray(0, dst.data.length));
    }
  }
}

function isSolved(v: ValidatedTrack): boolean {
  const s = v.forward.status;
  return (
    (s === TrackStatus.TRACKED || s === TrackStatus.NOT_CONVERGED) &&
    Number.isFinite(v.forward.x) &&
    Number.isFinite(v.forward.y)
  );
}
