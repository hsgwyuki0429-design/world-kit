/**
 * Phase 12's per-frame camera pose in the map's world (v4 §25), with no worker around it.
 *
 * The map answers "where are the landmarks"; the keyframe poses answer "where was the camera when
 * a batch was registered", about once a second. A ring drawn over the live image needs the
 * camera of **this** frame. The tracker already knows where each landmark is in this frame — the
 * landmark's id *is* the tracker's feature id — so the correspondences are exact by construction
 * and the pose is a perspective-n-point refinement (`geometry/pnp.ts`).
 *
 * ## Where a solve starts
 *
 * From the previous frame's pose when there is one in this epoch, and from the newest keyframe
 * the map registered either way; both are refined and the better-supported answer is kept. The
 * keyframe start is what recovers a frame after the previous one was refused, and it is an
 * independent instrument: the map registered that pose from a similarity over shared landmarks,
 * not from anything this stage computed.
 *
 * ## What it measures about itself
 *
 *  - **A held-out error.** Every `HELD_OUT_EVERY` frames the correspondences are split by id
 *    parity, the pose is re-solved on one half, and the other half is projected through it. A
 *    solver that returned the keyframe pose unchanged, or one that fitted each point separately,
 *    has an in-sample error and no held-out one.
 *  - **Agreement with the map's own keyframe pose**, on the frame where the map registered one.
 *  - **The correspondences themselves**, a sample of them, so the main thread's renderer can
 *    project them through its own code path and say whether what it draws lands where the
 *    tracker sees it (VIEW-001).
 *
 * ## When a track breaks: re-linking
 *
 * A landmark is known to the map only by the id of the track that made it. On a phone in a hand,
 * tracks break all the time — a blur, an occlusion, a glance away — and the point comes back as a
 * new detection with a new id that no landmark has. Left alone, the map's landmarks fall out of
 * view one broken track at a time until fewer than `MIN_LOCALIZATION_INLIERS` remain, and the
 * pose is lost although the camera is looking at the mapped room. So:
 *
 *  - **On a localized frame**, every live point that is not a landmark is checked against the
 *    landmarks no live point carries, projected through the accepted pose. A point within
 *    `RELINK_RADIUS_PX` of exactly one of them — the next nearest at least twice as far and past
 *    the radius, and no other point claiming the same landmark — is a candidate, and becomes that
 *    landmark when it has been the same landmark's candidate on `RELINK_CONFIRM_FRAMES`
 *    consecutive localized frames. Points the map never held are most of what a tracker follows,
 *    and one of them lands near *some* landmark's projection by chance a few times in a hundred;
 *    a chance alignment of points at different depths comes apart as soon as the camera moves.
 *  - **On a frame with too few**, the same search runs through the last accepted pose, after
 *    voting for the image shift between the projections and the points (`RECOVERY_SEARCH_PX`):
 *    a turn of the camera moves the whole image, so the true pairs agree on one shift and chance
 *    pairs scatter. The pose is then solved and held to **every** bar a normal frame is, and only
 *    pairs within `INLIER_PX` of the accepted pose are kept.
 *
 * The pairs are handed to the tracker (`FlowTracker.relabel`), so from the next frame on the
 * point carries the landmark's id to every stage — this one, the keyframes, and the map's
 * registration, whose shared landmarks are what keeps the map from being redefined.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { intrinsicsFor } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import { multiply3x3, transpose3x3 } from '../geometry/linalg';
import { rotationAngleDeg } from '../geometry/rotation';
import { INLIER_PX, OUTLIER_PX, cameraCenter, refinePose, transformPoint } from '../geometry/pnp';
import type { CameraPose, PnpCorrespondence, PnpResult } from '../geometry/pnp';
import type { KeyframePose, Landmark } from '../mapping/landmarks';
import { LandmarkState } from '../mapping/landmarks';
import { MAP_SNAPSHOT_STRIDE } from './trackingMessages';
import type {
  ConfidenceTermRecord,
  KeyframeAgreementRecord,
  KeyframePoseRecord,
  LocalizationReport,
  MapSnapshot,
  ProjectionSample,
} from './trackingMessages';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase12/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** Inliers a pose must rest on. Six unknowns, so twice the minimum the solver itself refuses below. */
export const MIN_LOCALIZATION_INLIERS = 12;
/** ...and the share of the correspondences they must be. Half: a pose most points disagree with is not this frame's. */
export const MIN_INLIER_SHARE = 0.5;
/** v3 §33's GOOD band, which every reprojection figure in this project is held to. */
export const MAX_LOCALIZATION_MEDIAN_PX = 2.0;
/** The held-out error may be larger — half the points are missing from its solve — but not by more than half again. */
export const MAX_HELD_OUT_PX = 3.0;
/** How often the held-out split runs. It costs one extra refinement. */
export const HELD_OUT_EVERY = 5;
/** Correspondences shipped for the renderer's projection check. */
const PROJECTION_SAMPLES = 24;
/** Inliers at which the support term saturates. */
const SUPPORT_SATURATION = 60;
/** Image spread at which the distribution term saturates, as a fraction of the shorter edge. */
const SPREAD_SATURATION = 0.35;
/**
 * How near a live point must sit to a landmark's projection, through an accepted pose, to be
 * re-linked to it: the band an accepted pose's median must be inside.
 */
export const RELINK_RADIUS_PX = MAX_LOCALIZATION_MEDIAN_PX;
/** Consecutive localized frames a candidate re-link must hold before the point takes the landmark's id. */
export const RELINK_CONFIRM_FRAMES = 3;
/**
 * How far the image may have moved since the last accepted pose for recovery to find it: about
 * fifteen degrees of turn at this field of view (a wrist whipped through a quarter of a second
 * does that). Past it, recovery waits for the camera to come back.
 */
export const RECOVERY_SEARCH_PX = 120;
/** The shift histogram's bin. Wider than the relink radius, so one true shift lands in one or two bins. */
const SHIFT_BIN_PX = 4;
/** Candidate shifts tried per recovery, and how far apart they must be to count as different. */
const RECOVERY_HYPOTHESES = 4;
const RECOVERY_PEAK_GAP_PX = 24;

export const LocalizationState = {
  /** The map holds too little to localize against. */
  NO_MAP: 'NO_MAP',
  /** The map exists, but too few of its landmarks are being tracked in this frame. */
  TOO_FEW: 'TOO_FEW',
  LOCALIZED: 'LOCALIZED',
  /** A pose was solved and did not meet the bar — fail closed (v4 §1.4, §44). */
  REFUSED: 'REFUSED',
} as const;
export type LocalizationState = (typeof LocalizationState)[keyof typeof LocalizationState];

/** What the stage reads from the map. Nothing here can write to it. */
export interface MapReader {
  landmark(id: number): Landmark | undefined;
  landmarks(): readonly Landmark[];
  keyframePose(keyframe: number): KeyframePose | undefined;
  epoch(): number;
  version(): number;
}

export interface LocalizationStageInput {
  /** The tracker's population this frame, level-0 pixels. */
  readonly population: readonly { readonly id: number; readonly x0: number; readonly y0: number }[];
  readonly width: number;
  readonly height: number;
  readonly map: MapReader;
  /** Keyframe ids, oldest first, as the store holds them. */
  readonly keyframeIds: readonly number[];
  /** The keyframe the map registered on this frame, if one was — WORLD-003's comparison. */
  readonly registeredKeyframe: number | null;
  readonly capturedAtEpoch: number;
}

export class LocalizationStage {
  private frames = 0;
  private localizedFrames = 0;
  /** The last accepted pose in this epoch — a start for the solve, and recovery's prediction. */
  private previous: { pose: CameraPose; epoch: number } | null = null;
  private sentVersion = -1;
  private sentEpoch = -1;
  private relinkedTotal = 0;
  private recoveredTotal = 0;
  /** `performance.now()` when a pose was last accepted, and in which epoch. */
  private acceptedAt = -Infinity;
  private acceptedEpoch = -1;
  /** This frame's re-links, `[live id, landmark id]`, for the tracker. Empty unless the pose was accepted. */
  private relabels: [number, number][] = [];
  /** Candidate re-links waiting out `RELINK_CONFIRM_FRAMES`: live id → landmark and run length. */
  private pending = new Map<number, { landmarkId: number; frames: number }>();

  reset(): void {
    this.frames = 0;
    this.localizedFrames = 0;
    this.previous = null;
    this.sentVersion = -1;
    this.sentEpoch = -1;
    this.relinkedTotal = 0;
    this.recoveredTotal = 0;
    this.acceptedAt = -Infinity;
    this.acceptedEpoch = -1;
    this.relabels = [];
    this.pending.clear();
  }

  /**
   * Whether a pose was accepted in this epoch within `ms` — the world still holds the camera.
   * `LandmarkStage` is told, so a run of unregisterable batches does not redefine a world the
   * camera is still being placed in.
   */
  localizedWithin(ms: number, epoch: number): boolean {
    return this.acceptedEpoch === epoch && performance.now() - this.acceptedAt <= ms;
  }

  /** The re-links the last `process` accepted, for `FlowTracker.relabel`. */
  takeRelabels(): readonly (readonly [number, number])[] {
    const out = this.relabels;
    this.relabels = [];
    return out;
  }

  process(input: LocalizationStageInput): LocalizationReport {
    const t0 = performance.now();
    this.frames++;
    this.relabels = [];
    const map = input.map;
    const epoch = map.epoch();
    if (this.previous && this.previous.epoch !== epoch) this.previous = null;

    const snapshot = this.snapshotIfChanged(map);
    const k = intrinsicsFor(input.width, input.height);
    const all = map.landmarks();

    const base = {
      epoch,
      mapVersion: map.version(),
      mapLandmarks: all.length,
      capturedAtEpoch: input.capturedAtEpoch,
      width: input.width,
      height: input.height,
      snapshot,
    };

    if (!k || all.length < MIN_LOCALIZATION_INLIERS) {
      this.previous = null;
      return this.finish(
        t0,
        base,
        LocalizationState.NO_MAP,
        k
          ? `the map holds ${all.length} landmark(s), below the ${MIN_LOCALIZATION_INLIERS} a pose must rest on`
          : 'the frame has no usable dimensions',
      );
    }

    const correspondences: PnpCorrespondence[] = [];
    const unlinked: { id: number; x: number; y: number }[] = [];
    const observed = new Set<number>();
    for (const f of input.population) {
      const l = map.landmark(f.id);
      if (!l || l.epoch !== epoch) {
        unlinked.push({ id: f.id, x: f.x0, y: f.y0 });
        continue;
      }
      observed.add(f.id);
      correspondences.push({ id: f.id, x: f.x0, y: f.y0, world: l.position });
    }
    // The landmarks a point could be re-linked to: in this epoch and carried by no live point —
    // candidates included. A world that has just been (re)defined holds nothing else for its first
    // seconds, and the first version, which took only confirmed landmarks, could not recover a
    // young map from the very dropout that made it young: the map was redefined again, and again.
    const unobserved = all.filter((l) => l.epoch === epoch && !observed.has(l.id));

    // Too few of the map's tracks survive: look for the landmarks where the last accepted pose,
    // moved by the shift the points agree on, says they are.
    let recovery: Relink[] = [];
    if (correspondences.length < MIN_LOCALIZATION_INLIERS && this.previous && unlinked.length > 0) {
      // Several candidate image shifts, each tried by solving a pose from the pairs it implies:
      // the shift that gives the most points agreeing with one pose is the camera's. The vote
      // alone is not asked to be decisive — on a large map chance pairs make its peak a poor
      // judge, and the solve's own bars (a 2 px median, half the points agreeing) are the
      // judge that cannot be fooled by them.
      let bestHypothesis: { links: Relink[]; inliers: number; medianPx: number } | null = null;
      for (const links of recoverHypotheses(k, this.previous.pose, unlinked, unobserved)) {
        const trial = [...correspondences, ...links.map((r) => ({ id: r.landmarkId, x: r.x, y: r.y, world: r.world }))];
        if (trial.length < MIN_LOCALIZATION_INLIERS) continue;
        const solved = this.bestSolve(k, trial, input, map);
        if (!solved) continue;
        const r = solved.result;
        if (
          !bestHypothesis ||
          r.inliers > bestHypothesis.inliers ||
          (r.inliers === bestHypothesis.inliers && r.medianErrorPx < bestHypothesis.medianPx)
        ) {
          bestHypothesis = { links, inliers: r.inliers, medianPx: r.medianErrorPx };
        }
      }
      if (bestHypothesis) {
        recovery = bestHypothesis.links;
        for (const r of recovery) correspondences.push({ id: r.landmarkId, x: r.x, y: r.y, world: r.world });
      }
    }
    const recoveryFrom = correspondences.length - recovery.length;

    if (correspondences.length < MIN_LOCALIZATION_INLIERS) {
      return this.finish(
        t0,
        { ...base, correspondences: correspondences.length },
        LocalizationState.TOO_FEW,
        `${correspondences.length} of the map's landmarks are tracked in this frame, below the ` +
          `${MIN_LOCALIZATION_INLIERS} a pose must rest on — the view has left the mapped part of the room`,
      );
    }

    if (this.startsFor(input, map).length === 0) {
      return this.finish(
        t0,
        { ...base, correspondences: correspondences.length },
        LocalizationState.NO_MAP,
        'no keyframe in the store has a pose in this epoch of the map, so there is nowhere to start a solve from',
      );
    }

    const best = this.bestSolve(k, correspondences, input, map);
    if (!best || !best.result.pose) {
      return this.finish(
        t0,
        { ...base, correspondences: correspondences.length },
        LocalizationState.REFUSED,
        'the solve did not converge from any start',
      );
    }

    const result = best.result;
    const pose = best.result.pose;
    const share = result.inliers / correspondences.length;
    const medianDepth = medianDepthOf(pose, correspondences);
    const heldOut = this.frames % HELD_OUT_EVERY === 0 ? heldOutError(k, correspondences, pose) : null;
    const agreement = this.agreementWith(input, map, pose, medianDepth);
    const terms = confidenceTerms(result, correspondences, share, k);
    const confidence = Math.min(...terms.map((t) => t.value));

    const problems: string[] = [];
    if (result.inliers < MIN_LOCALIZATION_INLIERS) {
      problems.push(`${result.inliers} inlier(s), below ${MIN_LOCALIZATION_INLIERS}`);
    }
    if (share < MIN_INLIER_SHARE) {
      problems.push(`${round(share * 100, 1)}% of the correspondences agree, below ${MIN_INLIER_SHARE * 100}%`);
    }
    if (result.medianErrorPx > MAX_LOCALIZATION_MEDIAN_PX) {
      problems.push(`median error ${result.medianErrorPx} px, past ${MAX_LOCALIZATION_MEDIAN_PX} px`);
    }
    const accepted = problems.length === 0;
    if (!accepted) this.pending.clear();
    // A refused frame leaves the last accepted pose where it was: it is still the best guess at
    // where the camera is, and recovery needs it.
    let relinked = 0;
    const recovered = accepted && recovery.length > 0 && recoveryFrom < MIN_LOCALIZATION_INLIERS;
    if (accepted) {
      this.localizedFrames++;
      this.previous = { pose, epoch };
      this.acceptedAt = performance.now();
      this.acceptedEpoch = epoch;
      // Recovery's pairs stay only where the accepted pose agrees with them — and where, through
      // that pose, the point sits on its landmark and no other: the shift recovery voted for is
      // one shift for the whole image, and near the edges a neighbouring landmark can be the
      // nearer one through it.
      const agreed = recovery.filter((_, j) => {
        const r = result.residualsPx[recoveryFrom + j] ?? -1;
        return r >= 0 && r <= INLIER_PX;
      });
      const strict = new Map(
        relinkUnder(k, pose, agreed.map((r) => ({ id: r.featureId, x: r.x, y: r.y })), unobserved, RELINK_RADIUS_PX, { x: 0, y: 0 })
          .map((r) => [r.featureId, r.landmarkId]),
      );
      const kept = agreed.filter((r) => strict.get(r.featureId) === r.landmarkId);
      const taken = new Set(kept.map((r) => r.featureId));
      const claimed = new Set(kept.map((r) => r.landmarkId));
      const candidates = relinkUnder(
        k,
        pose,
        unlinked.filter((f) => !taken.has(f.id)),
        unobserved.filter((l) => !claimed.has(l.id)),
        RELINK_RADIUS_PX,
        { x: 0, y: 0 },
      );
      const confirmed: Relink[] = [];
      const pending = new Map<number, { landmarkId: number; frames: number }>();
      for (const c of candidates) {
        const before = this.pending.get(c.featureId);
        const frames = before && before.landmarkId === c.landmarkId ? before.frames + 1 : 1;
        if (frames >= RELINK_CONFIRM_FRAMES) confirmed.push(c);
        else pending.set(c.featureId, { landmarkId: c.landmarkId, frames });
      }
      // Consecutive: a candidate missing from this frame starts again.
      this.pending = pending;
      this.relabels = [...kept, ...confirmed].map((r) => [r.featureId, r.landmarkId]);
      relinked = this.relabels.length;
      this.relinkedTotal += relinked;
      if (recovered) this.recoveredTotal++;
    }

    const samples: ProjectionSample[] = [];
    const step = Math.max(1, Math.floor(correspondences.length / PROJECTION_SAMPLES));
    for (let i = 0; i < correspondences.length && samples.length < PROJECTION_SAMPLES; i += step) {
      const c = correspondences[i];
      if (!c || (result.residualsPx[i] ?? -1) < 0) continue;
      samples.push({ id: c.id, x: round(c.x, 3), y: round(c.y, 3), world: c.world.map((v) => round(v, 5)) });
    }

    return this.finish(
      t0,
      {
        ...base,
        pose: accepted ? { rotation: pose.rotation.map((v) => round(v, 7)), translation: pose.translation.map((v) => round(v, 6)) } : null,
        cameraCenter: accepted ? cameraCenter(pose).map((v) => round(v, 6)) : null,
        correspondences: correspondences.length,
        inliers: result.inliers,
        medianErrorPx: result.medianErrorPx,
        heldOutPx: heldOut ? heldOut.medianPx : -1,
        heldOutPoints: heldOut ? heldOut.points : 0,
        startedFrom: best.from,
        keyframeAgreement: agreement,
        medianDepth: round(medianDepth, 5),
        confidence: accepted ? round(confidence, 4) : 0,
        confidenceTerms: terms,
        projectionSamples: accepted ? samples : [],
        relinked,
        recovered,
      },
      accepted ? LocalizationState.LOCALIZED : LocalizationState.REFUSED,
      accepted
        ? `${result.inliers}/${correspondences.length} landmark(s) agree within the solve's band; median ${result.medianErrorPx} px` +
            (recovered ? `; recovered by re-linking ${recovery.length} point(s) to the map` : '') +
            (relinked > 0 ? `; ${relinked} re-linked` : '')
        : `refused: ${problems.join('; ')}` + (recovery.length > 0 ? ` (with ${recovery.length} point(s) tried against the map)` : ''),
    );
  }

  /* ---------------------------------------------------------------------- */

  /** Where a solve may start: the last accepted pose, and the newest keyframes the map registered. */
  private startsFor(input: LocalizationStageInput, map: MapReader): { pose: CameraPose; from: string }[] {
    const starts: { pose: CameraPose; from: string }[] = [];
    if (this.previous) starts.push({ pose: this.previous.pose, from: 'PREVIOUS' });
    for (let i = input.keyframeIds.length - 1, n = 0; i >= 0 && n < 2; i--) {
      const id = input.keyframeIds[i];
      if (id === undefined) continue;
      const pose = map.keyframePose(id);
      if (!pose) continue;
      starts.push({ pose, from: 'KEYFRAME' });
      n++;
    }
    return starts;
  }

  /** The best-supported refinement over every start, or `null` if none converged. */
  private bestSolve(
    k: Intrinsics,
    correspondences: readonly PnpCorrespondence[],
    input: LocalizationStageInput,
    map: MapReader,
  ): { result: PnpResult; from: string } | null {
    let best: { result: PnpResult; from: string } | null = null;
    for (const start of this.startsFor(input, map)) {
      const result = refinePose(k, correspondences, start.pose);
      if (!result.pose) continue;
      if (
        !best ||
        result.inliers > best.result.inliers ||
        (result.inliers === best.result.inliers && result.medianErrorPx < best.result.medianErrorPx)
      ) {
        best = { result, from: start.from };
      }
    }
    return best;
  }

  private agreementWith(
    input: LocalizationStageInput,
    map: MapReader,
    pose: CameraPose,
    medianDepth: number,
  ): KeyframeAgreementRecord | null {
    if (input.registeredKeyframe === null) return null;
    const registered = map.keyframePose(input.registeredKeyframe);
    if (!registered || !(medianDepth > 0)) return null;
    const rotationDeg = rotationAngleDeg(multiply3x3(pose.rotation, transpose3x3(registered.rotation)));
    const a = cameraCenter(pose);
    const b = cameraCenter(registered);
    const d = Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
    return {
      keyframeId: input.registeredKeyframe,
      rotationDeg: round(rotationDeg, 4),
      centerRelative: round(d / medianDepth, 5),
    };
  }

  private snapshotIfChanged(map: MapReader): MapSnapshot | null {
    const version = map.version();
    const epoch = map.epoch();
    if (version === this.sentVersion && epoch === this.sentEpoch) return null;
    this.sentVersion = version;
    this.sentEpoch = epoch;

    const all = map.landmarks().filter((l) => l.epoch === epoch);
    const ids = new Int32Array(all.length);
    const data = new Float32Array(all.length * MAP_SNAPSHOT_STRIDE);
    const keyframeIds = new Set<number>();
    all.forEach((l, i) => {
      ids[i] = l.id;
      const o = i * MAP_SNAPSHOT_STRIDE;
      data[o] = l.position[0] ?? 0;
      data[o + 1] = l.position[1] ?? 0;
      data[o + 2] = l.position[2] ?? 0;
      data[o + 3] = l.confidence;
      data[o + 4] = l.observations;
      data[o + 5] = l.state === LandmarkState.CONFIRMED ? 1 : 0;
      for (const kf of l.keyframes) keyframeIds.add(kf);
    });
    const keyframes: KeyframePoseRecord[] = [];
    for (const id of [...keyframeIds].sort((p, q) => p - q)) {
      const pose = map.keyframePose(id);
      if (pose) keyframes.push({ id, rotation: [...pose.rotation], translation: [...pose.translation] });
    }
    return { epoch, version, count: all.length, ids: ids.buffer, data: data.buffer, keyframes };
  }

  private finish(
    t0: number,
    partial: Partial<LocalizationReport> & Pick<LocalizationReport, 'epoch' | 'mapVersion' | 'mapLandmarks' | 'capturedAtEpoch' | 'width' | 'height' | 'snapshot'>,
    state: LocalizationState,
    reason: string,
  ): LocalizationReport {
    return {
      frames: this.frames,
      localizedFrames: this.localizedFrames,
      state,
      reason,
      pose: null,
      cameraCenter: null,
      correspondences: 0,
      inliers: 0,
      medianErrorPx: -1,
      heldOutPx: -1,
      heldOutPoints: 0,
      startedFrom: 'NONE',
      keyframeAgreement: null,
      medianDepth: -1,
      confidence: 0,
      confidenceTerms: [],
      projectionSamples: [],
      relinked: 0,
      recovered: false,
      ...partial,
      relinkedTotal: this.relinkedTotal,
      recoveredTotal: this.recoveredTotal,
      localizationMs: round(performance.now() - t0, 4),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Re-linking                                                                  */
/* -------------------------------------------------------------------------- */

interface Relink {
  readonly featureId: number;
  readonly landmarkId: number;
  readonly x: number;
  readonly y: number;
  readonly world: readonly number[];
}

interface Projection {
  readonly landmark: Landmark;
  readonly x: number;
  readonly y: number;
}

/**
 * Landmarks through `pose`, kept to `pad` pixels beyond the frame's edges: a point near the edge
 * must find its own landmark among the candidates, not the nearest one that projected inside.
 */
function project(k: Intrinsics, pose: CameraPose, landmarks: readonly Landmark[], pad: number): Projection[] {
  const out: Projection[] = [];
  for (const l of landmarks) {
    const p = transformPoint(pose, l.position);
    const z = p[2] ?? 0;
    if (!(z > 1e-6)) continue;
    const x = k.fx * ((p[0] ?? 0) / z) + k.cx;
    const y = k.fy * ((p[1] ?? 0) / z) + k.cy;
    if (x < -pad || y < -pad || x > k.width + pad || y > k.height + pad) continue;
    out.push({ landmark: l, x, y });
  }
  return out;
}

/** Projections bucketed by `cell`, for neighbourhood queries. */
function gridOf(points: readonly Projection[], cell: number): Map<string, Projection[]> {
  const grid = new Map<string, Projection[]>();
  for (const p of points) {
    const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const list = grid.get(key);
    if (list) list.push(p);
    else grid.set(key, [p]);
  }
  return grid;
}

function near(grid: Map<string, Projection[]>, cell: number, x: number, y: number, reach: number): Projection[] {
  const out: Projection[] = [];
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const r = Math.ceil(reach / cell);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const list = grid.get(`${cx + dx},${cy + dy}`);
      if (list) out.push(...list);
    }
  }
  return out;
}

/**
 * Points that sit on exactly one landmark's projection (moved by `shift`).
 *
 * Unique both ways: the next projection is at least twice as far as the nearest and past the
 * radius, and a landmark two points claim goes to neither. A wrong pair costs the map a corrupted
 * landmark; a missed one costs nothing but a frame's wait.
 */
function relinkUnder(
  k: Intrinsics,
  pose: CameraPose,
  points: readonly { id: number; x: number; y: number }[],
  landmarks: readonly Landmark[],
  radius: number,
  shift: { x: number; y: number },
): Relink[] {
  if (points.length === 0 || landmarks.length === 0) return [];
  const pad = 2 * radius + Math.max(Math.abs(shift.x), Math.abs(shift.y));
  const projected = project(k, pose, landmarks, pad).map((p) => ({ ...p, x: p.x + shift.x, y: p.y + shift.y }));
  const grid = gridOf(projected, radius);
  const claims = new Map<number, Relink[]>();
  for (const f of points) {
    let best: Projection | null = null;
    let d1 = Infinity;
    let d2 = Infinity;
    for (const p of near(grid, radius, f.x, f.y, 2 * radius)) {
      const d = Math.hypot(p.x - f.x, p.y - f.y);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best = p;
      } else if (d < d2) {
        d2 = d;
      }
    }
    if (!best || d1 > radius || d2 < Math.max(radius, 2 * d1)) continue;
    const pair: Relink = { featureId: f.id, landmarkId: best.landmark.id, x: f.x, y: f.y, world: best.landmark.position };
    const list = claims.get(best.landmark.id);
    if (list) list.push(pair);
    else claims.set(best.landmark.id, [pair]);
  }
  const out: Relink[] = [];
  for (const list of claims.values()) if (list.length === 1 && list[0]) out.push(list[0]);
  return out;
}

/**
 * Recovery's candidates: the image shifts the points and the last pose's projections most agree
 * on, each as the pairs it implies.
 *
 * A turn of the camera moves the whole image by nearly one shift. Every pair within
 * `RECOVERY_SEARCH_PX` votes for its difference; the true pairs pile into one bin and chance pairs
 * spread over all of them. The best `RECOVERY_HYPOTHESES` peaks that are `RECOVERY_PEAK_GAP_PX`
 * apart and hold at least `MIN_LOCALIZATION_INLIERS` votes are returned, each as the unique pairs
 * `relinkUnder` finds through it. The caller solves a pose from each; this function does not claim
 * any of them is right.
 *
 * The first version returned one peak and demanded it stand three times above the mean bin. On a
 * map of a few hundred landmarks that held; past about seven hundred the chance votes in a bin's
 * neighbourhood approach the true ones, the test failed, the camera was not found, and five
 * unregistered batches later the world was redefined — on the rough feed, at the third or fourth
 * dropout, in every run.
 */
function recoverHypotheses(
  k: Intrinsics,
  pose: CameraPose,
  points: readonly { id: number; x: number; y: number }[],
  landmarks: readonly Landmark[],
): Relink[][] {
  const projected = project(k, pose, landmarks, RECOVERY_SEARCH_PX);
  if (projected.length < MIN_LOCALIZATION_INLIERS) return [];
  const cell = RECOVERY_SEARCH_PX / 2;
  const grid = gridOf(projected, cell);
  const bins = new Map<string, number>();
  for (const f of points) {
    for (const p of near(grid, cell, f.x, f.y, RECOVERY_SEARCH_PX)) {
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (Math.abs(dx) > RECOVERY_SEARCH_PX || Math.abs(dy) > RECOVERY_SEARCH_PX) continue;
      const key = `${Math.floor(dx / SHIFT_BIN_PX)},${Math.floor(dy / SHIFT_BIN_PX)}`;
      bins.set(key, (bins.get(key) ?? 0) + 1);
    }
  }
  // Each bin's vote summed with its 2×2 neighbourhood, so a shift on a bin edge is not split.
  const peaks: { sum: number; x: number; y: number }[] = [];
  const seen = new Set<string>();
  for (const key of bins.keys()) {
    const [bx, by] = key.split(',').map(Number) as [number, number];
    for (let oy = -1; oy <= 0; oy++) {
      for (let ox = -1; ox <= 0; ox++) {
        const x0 = bx + ox;
        const y0 = by + oy;
        const id = `${x0},${y0}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let sum = 0;
        let sx = 0;
        let sy = 0;
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            const n = bins.get(`${x0 + dx},${y0 + dy}`) ?? 0;
            sum += n;
            sx += n * (x0 + dx + 0.5) * SHIFT_BIN_PX;
            sy += n * (y0 + dy + 0.5) * SHIFT_BIN_PX;
          }
        }
        if (sum >= MIN_LOCALIZATION_INLIERS) peaks.push({ sum, x: sx / sum, y: sy / sum });
      }
    }
  }
  peaks.sort((a, b) => b.sum - a.sum);
  const chosen: { x: number; y: number }[] = [];
  for (const p of peaks) {
    if (chosen.length >= RECOVERY_HYPOTHESES) break;
    if (chosen.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < RECOVERY_PEAK_GAP_PX)) continue;
    chosen.push({ x: p.x, y: p.y });
  }
  const out: Relink[][] = [];
  for (const shift of chosen) {
    const links = relinkUnder(k, pose, points, landmarks, SHIFT_BIN_PX, shift);
    if (links.length >= MIN_LOCALIZATION_INLIERS) out.push(links);
  }
  return out;
}

/**
 * Re-solve on the even ids, measure the odd ones.
 *
 * Split by id rather than by position in the list so the same landmark is always on the same
 * side, and a run's held-out figures are comparable frame to frame.
 */
function heldOutError(
  k: Intrinsics,
  correspondences: readonly PnpCorrespondence[],
  pose: CameraPose,
): { medianPx: number; points: number } | null {
  const fit = correspondences.filter((c) => c.id % 2 === 0);
  const held = correspondences.filter((c) => c.id % 2 !== 0);
  if (fit.length < MIN_LOCALIZATION_INLIERS || held.length < MIN_LOCALIZATION_INLIERS) return null;
  const r = refinePose(k, fit, pose);
  if (!r.pose) return null;
  const solved = r.pose;
  const errors: number[] = [];
  for (const c of held) {
    const p = transformPoint(solved, c.world);
    const z = p[2] ?? 0;
    if (!(z > 1e-6)) continue;
    errors.push(Math.hypot(k.fx * ((p[0] ?? 0) / z) + k.cx - c.x, k.fy * ((p[1] ?? 0) / z) + k.cy - c.y));
  }
  if (errors.length === 0) return null;
  // Over the held-out points within `OUTLIER_PX` of where the half-pose puts them — the same rule
  // the in-sample median is taken under (see `PnpResult.medianErrorPx` for the run that forced
  // it). A landmark the map has let drift is an outlier to every pose; counting it here would
  // measure the map's drift, which Phase 10 reports, rather than this pose's prediction.
  const resting = errors.filter((e) => e <= OUTLIER_PX);
  const used = resting.length >= MIN_LOCALIZATION_INLIERS ? resting : errors;
  return { medianPx: round(median(used), 4), points: used.length };
}

function confidenceTerms(
  result: PnpResult,
  correspondences: readonly PnpCorrespondence[],
  share: number,
  k: Intrinsics,
): ConfidenceTermRecord[] {
  const inlierPoints = correspondences.filter((_, i) => {
    const r = result.residualsPx[i] ?? -1;
    return r >= 0 && r <= 3;
  });
  const xs = inlierPoints.map((c) => c.x);
  const ys = inlierPoints.map((c) => c.y);
  const spread = xs.length > 1 ? Math.min(stddev(xs), stddev(ys)) : 0;
  const spreadTarget = SPREAD_SATURATION * Math.min(k.width, k.height);
  return [
    {
      name: 'support',
      value: round(Math.min(1, result.inliers / SUPPORT_SATURATION), 4),
      note: `${result.inliers} inlier(s) against ${SUPPORT_SATURATION}`,
    },
    {
      name: 'agreement',
      value: round(Math.max(0, Math.min(1, share)), 4),
      note: `${round(share * 100, 1)}% of the tracked landmarks agree with the pose`,
    },
    {
      name: 'reprojectionError',
      value: round(Math.max(0, 1 - Math.max(0, result.medianErrorPx) / (MAX_LOCALIZATION_MEDIAN_PX * 1.5)), 4),
      note: `median ${result.medianErrorPx} px against ${MAX_LOCALIZATION_MEDIAN_PX * 1.5} px`,
    },
    {
      name: 'distribution',
      value: round(Math.min(1, spread / spreadTarget), 4),
      note: `${round(spread, 1)} px spread against ${round(spreadTarget, 1)} px — a pose resting on one corner of the image is poorly constrained`,
    },
  ];
}

function medianDepthOf(pose: CameraPose, correspondences: readonly PnpCorrespondence[]): number {
  const depths: number[] = [];
  for (const c of correspondences) {
    const z = transformPoint(pose, c.world)[2] ?? 0;
    if (z > 0) depths.push(z);
  }
  return depths.length > 0 ? median(depths) : -1;
}

function stddev(v: readonly number[]): number {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
