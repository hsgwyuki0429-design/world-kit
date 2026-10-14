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
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { intrinsicsFor } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import { multiply3x3, transpose3x3 } from '../geometry/linalg';
import { rotationAngleDeg } from '../geometry/rotation';
import { OUTLIER_PX, cameraCenter, refinePose, transformPoint } from '../geometry/pnp';
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
  private previous: { pose: CameraPose; epoch: number } | null = null;
  private sentVersion = -1;
  private sentEpoch = -1;

  reset(): void {
    this.frames = 0;
    this.localizedFrames = 0;
    this.previous = null;
    this.sentVersion = -1;
    this.sentEpoch = -1;
  }

  process(input: LocalizationStageInput): LocalizationReport {
    const t0 = performance.now();
    this.frames++;
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
    for (const f of input.population) {
      const l = map.landmark(f.id);
      if (!l || l.epoch !== epoch) continue;
      correspondences.push({ id: f.id, x: f.x0, y: f.y0, world: l.position });
    }
    if (correspondences.length < MIN_LOCALIZATION_INLIERS) {
      this.previous = null;
      return this.finish(
        t0,
        { ...base, correspondences: correspondences.length },
        LocalizationState.TOO_FEW,
        `${correspondences.length} of the map's landmarks are tracked in this frame, below the ` +
          `${MIN_LOCALIZATION_INLIERS} a pose must rest on — the view has left the mapped part of the room`,
      );
    }

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
    if (starts.length === 0) {
      return this.finish(
        t0,
        { ...base, correspondences: correspondences.length },
        LocalizationState.NO_MAP,
        'no keyframe in the store has a pose in this epoch of the map, so there is nowhere to start a solve from',
      );
    }

    let best: { result: PnpResult; from: string } | null = null;
    for (const start of starts) {
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
    if (!best || !best.result.pose) {
      this.previous = null;
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
    if (accepted) {
      this.localizedFrames++;
      this.previous = { pose, epoch };
    } else {
      this.previous = null;
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
      },
      accepted ? LocalizationState.LOCALIZED : LocalizationState.REFUSED,
      accepted
        ? `${result.inliers}/${correspondences.length} landmark(s) agree within the solve's band; median ${result.medianErrorPx} px`
        : `refused: ${problems.join('; ')}`,
    );
  }

  /* ---------------------------------------------------------------------- */

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
      ...partial,
      localizationMs: round(performance.now() - t0, 4),
    };
  }
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
