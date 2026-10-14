/**
 * SpatialWorld — the single source of truth (v4 §1.2, §16, §25; Phase 12).
 *
 * Everything the game, the collision system and the renderer know about the room is in here, and
 * nowhere else. They receive a `SpatialWorldView` — a frozen snapshot — and have no path back:
 * the architecture audit forbids `game/` and `renderer/` from reaching the tracker or the map, and
 * this class exposes its mutators only to the composition root that feeds it mapping's output.
 *
 * ## What it holds (§25)
 *
 * World origin, the current camera pose and a bounded history of it, the landmarks, the keyframe
 * poses, the surfaces, gravity, the tracking and mapping states, an overall confidence and the
 * time each part was last updated. §16 lists what it must hold *at least*; it holds nothing else,
 * and in particular nothing between the landmarks — no mesh, no volume, no inferred geometry.
 *
 * ## Fail closed (§1.4, §44)
 *
 * `READY` is a conjunction, re-derived on every change, never a flag someone sets:
 *
 *  - tracking is `GOOD` — the frame's pose was solved against the map and met its bar;
 *  - gravity is `ESTIMATED` — otherwise nothing is a floor;
 *  - a `GROUND` surface exists at `MIN_GROUND_CONFIDENCE` or better;
 *  - nothing in the world is non-finite.
 *
 * Any one failing names itself in `worldReasons`, which is what the SCAN screen tells the player.
 *
 * ## The epoch
 *
 * When the map has to redefine its world (Phase 10's epoch restart), everything expressed in the
 * old frame — poses, surfaces, gravity — is dropped in the same step. Nothing from one epoch is
 * ever read in another's coordinates.
 */

import { SCALE_LOCAL_UNITS } from '../mapping/triangulation';
import { GravityState, UNKNOWN_GRAVITY } from '../mapping/gravity';
import type { GravityEstimate } from '../mapping/gravity';
import { SurfaceClass } from '../mapping/surfaces';
import type { Surface } from '../mapping/surfaces';

/**
 * The vocabulary consumers need, re-exported so `game/` and `renderer/` take it from the world
 * rather than from `mapping/` — the architecture audit forbids them that import, and the world is
 * the only thing they are allowed to know about.
 */
export { SurfaceClass, SurfaceOrientation } from '../mapping/surfaces';
export type { Surface } from '../mapping/surfaces';
export { GravityState } from '../mapping/gravity';
export type { GravityEstimate } from '../mapping/gravity';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase12/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** Below this the pose is reported as LOW CONFIDENCE — DEGRADED, and play does not commit to it. */
export const MIN_GOOD_POSE_CONFIDENCE = 0.4;
/** A ground surface the stage may stand on. */
export const MIN_GROUND_CONFIDENCE = 0.5;
/** A pose older than this is not this frame's; tracking reads LOST until a new one arrives. */
export const POSE_STALE_MS = 600;
/** Bound on the pose history (§56: everything is bounded). */
export const MAX_POSE_HISTORY = 240;
/** Coverage cell edge, as a fraction of the scene depth. */
export const COVERAGE_CELL_FRACTION = 0.1;

export const TrackingState = {
  /** No map yet: nothing to be lost from. */
  INITIALIZING: 'INITIALIZING',
  GOOD: 'GOOD',
  /** Localized, below `MIN_GOOD_POSE_CONFIDENCE` — §1.4's POSE: LOW CONFIDENCE. */
  DEGRADED: 'DEGRADED',
  LOST: 'LOST',
} as const;
export type TrackingState = (typeof TrackingState)[keyof typeof TrackingState];

export const MappingState = {
  NO_MAP: 'NO_MAP',
  MAPPING: 'MAPPING',
  /** Surfaces exist. */
  MAPPED: 'MAPPED',
} as const;
export type MappingState = (typeof MappingState)[keyof typeof MappingState];

export const WorldState = {
  NOT_READY: 'NOT_READY',
  READY: 'READY',
  /** Something non-finite reached the world. Nothing is served from it until the next clean ingest. */
  INVALID: 'INVALID',
} as const;
export type WorldState = (typeof WorldState)[keyof typeof WorldState];

export interface CameraIntrinsicsRecord {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

export interface WorldPose {
  /** `X_camera = R · X_world + t`. */
  readonly rotation: readonly number[];
  readonly translation: readonly number[];
  readonly center: readonly number[];
  /** The camera's +z (viewing direction) in the world. */
  readonly forward: readonly number[];
  readonly confidence: number;
  readonly intrinsics: CameraIntrinsicsRecord;
  /** `performance.now()` on the main thread when it arrived. */
  readonly at: number;
  readonly medianErrorPx: number;
  readonly inliers: number;
}

export interface WorldLandmark {
  readonly id: number;
  readonly position: readonly number[];
  readonly confidence: number;
  readonly observations: number;
  readonly confirmed: boolean;
}

export interface WorldKeyframe {
  readonly id: number;
  readonly rotation: readonly number[];
  readonly translation: readonly number[];
  readonly center: readonly number[];
}

export interface WorldConfidenceTerm {
  readonly name: string;
  readonly value: number;
  readonly note: string;
}

/** What every consumer reads. Frozen: a consumer cannot write to the world through it. */
export interface SpatialWorldView {
  readonly version: number;
  readonly epoch: number;
  readonly origin: { readonly epoch: number; readonly definition: string };
  readonly scale: string;
  readonly cameraPose: WorldPose | null;
  readonly cameraHistory: readonly { readonly center: readonly number[]; readonly at: number }[];
  readonly landmarks: readonly WorldLandmark[];
  readonly keyframes: readonly WorldKeyframe[];
  readonly gravity: GravityEstimate;
  readonly surfaces: readonly Surface[];
  readonly sceneDepth: number;
  /** Camera height above the ground along gravity, world units. `-1` without ground. */
  readonly cameraHeight: number;
  readonly trackingState: TrackingState;
  readonly trackingReason: string;
  readonly mappingState: MappingState;
  readonly worldState: WorldState;
  /** Every condition `READY` is waiting on, in words — empty when READY. */
  readonly worldReasons: readonly string[];
  readonly confidence: number;
  readonly confidenceTerms: readonly WorldConfidenceTerm[];
  /** Occupied cells of a `COVERAGE_CELL_FRACTION` grid over the confirmed landmarks — never a clock. */
  readonly coverage: number;
  /** Area of GROUND and PLATFORM surfaces, world units² — §39's READY AREA. */
  readonly readyArea: number;
  readonly lastUpdated: {
    readonly pose: number;
    readonly map: number;
    readonly surfaces: number;
    readonly gravity: number;
  };
  readonly integrityIssues: number;
}

export interface MapIngest {
  readonly epoch: number;
  readonly version: number;
  readonly landmarks: readonly WorldLandmark[];
  readonly keyframes: readonly WorldKeyframe[];
}

export interface PoseIngest {
  readonly epoch: number;
  /** `LOCALIZED` / `REFUSED` / `TOO_FEW` / `NO_MAP`, as Phase 12's stage reported it. */
  readonly state: string;
  readonly reason: string;
  readonly rotation: readonly number[] | null;
  readonly translation: readonly number[] | null;
  readonly center: readonly number[] | null;
  readonly confidence: number;
  readonly intrinsics: CameraIntrinsicsRecord;
  readonly medianErrorPx: number;
  readonly inliers: number;
}

export interface SurfaceIngest {
  readonly epoch: number;
  readonly surfaces: readonly Surface[];
  readonly sceneDepth: number;
  readonly cameraHeight: number;
}

export class SpatialWorld {
  private version = 0;
  private epoch = 0;
  private pose: WorldPose | null = null;
  private poseState = 'NO_MAP';
  private poseReason = 'no frame has been localized yet';
  private history: { center: readonly number[]; at: number }[] = [];
  private landmarks: readonly WorldLandmark[] = [];
  private keyframes: readonly WorldKeyframe[] = [];
  private gravity: GravityEstimate = UNKNOWN_GRAVITY;
  private surfaces: readonly Surface[] = [];
  private sceneDepth = -1;
  private cameraHeight = -1;
  private coverage = 0;
  private lastPose = -1;
  private lastMap = -1;
  private lastSurfaces = -1;
  private lastGravity = -1;
  private integrityIssues = 0;
  private invalid = false;
  private epochChanges = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    this.version++;
    this.epoch = 0;
    this.clearEpochState();
    this.landmarks = [];
    this.keyframes = [];
    this.coverage = 0;
    this.lastMap = -1;
    this.invalid = false;
  }

  /** How many times the world was redefined under a running game — WORLD-005. */
  epochChangeCount(): number {
    return this.epochChanges;
  }

  ingestMap(map: MapIngest): void {
    if (!finiteDeep(map)) return this.reject('map');
    if (map.epoch !== this.epoch) this.changeEpoch(map.epoch);
    this.landmarks = map.landmarks;
    this.keyframes = map.keyframes;
    this.coverage = coverageOf(map.landmarks, this.sceneDepth > 0 ? this.sceneDepth : medianExtent(map.landmarks));
    this.lastMap = this.now();
    this.invalid = false;
    this.version++;
  }

  ingestPose(pose: PoseIngest): void {
    if (!finiteDeep(pose)) return this.reject('pose');
    if (pose.epoch !== this.epoch && this.epoch !== 0) {
      // A pose in a frame this world does not hold. The map snapshot that redefines the world
      // arrives on the same message and is ingested first; reaching here means it has not.
      this.poseState = 'REFUSED';
      this.poseReason = `pose is in epoch ${pose.epoch}, the world is in epoch ${this.epoch}`;
      this.pose = null;
      this.version++;
      return;
    }
    this.poseState = pose.state;
    this.poseReason = pose.reason;
    const at = this.now();
    if (pose.state === 'LOCALIZED' && pose.rotation && pose.translation && pose.center) {
      const r = pose.rotation;
      this.pose = {
        rotation: pose.rotation,
        translation: pose.translation,
        center: pose.center,
        forward: [r[6] ?? 0, r[7] ?? 0, r[8] ?? 0],
        confidence: pose.confidence,
        intrinsics: pose.intrinsics,
        at,
        medianErrorPx: pose.medianErrorPx,
        inliers: pose.inliers,
      };
      this.history.push({ center: pose.center, at });
      if (this.history.length > MAX_POSE_HISTORY) this.history.shift();
      this.lastPose = at;
    } else {
      this.pose = null;
    }
    this.invalid = false;
    this.version++;
  }

  ingestGravity(estimate: GravityEstimate, epoch: number): void {
    if (epoch !== this.epoch) return;
    if (!finiteDeep(estimate)) return this.reject('gravity');
    this.gravity = estimate;
    this.lastGravity = this.now();
    this.version++;
  }

  ingestSurfaces(s: SurfaceIngest): void {
    if (s.epoch !== this.epoch) return;
    if (!finiteDeep(s)) return this.reject('surfaces');
    this.surfaces = s.surfaces;
    this.sceneDepth = s.sceneDepth;
    this.cameraHeight = s.cameraHeight;
    this.coverage = coverageOf(this.landmarks, s.sceneDepth);
    this.lastSurfaces = this.now();
    this.version++;
  }

  /** The frozen snapshot every consumer reads. */
  view(): SpatialWorldView {
    const now = this.now();
    const tracking = this.trackingAt(now);
    const ground = this.surfaces.filter(
      (s) => s.surfaceClass === SurfaceClass.GROUND && s.confidence >= MIN_GROUND_CONFIDENCE,
    );
    const reasons: string[] = [];
    if (this.invalid) reasons.push('a non-finite value reached the world and was refused');
    if (tracking.state !== TrackingState.GOOD) reasons.push(`TRACKING ${tracking.state}: ${tracking.reason}`);
    if (this.gravity.state !== GravityState.ESTIMATED) reasons.push(`GRAVITY UNKNOWN: ${this.gravity.reason}`);
    if (ground.length === 0) {
      reasons.push(
        this.surfaces.length === 0
          ? 'SURFACE UNKNOWN: no surface has been observed yet'
          : `SURFACE UNKNOWN: no GROUND surface at confidence ${MIN_GROUND_CONFIDENCE} or better`,
      );
    }
    if (!(this.cameraHeight > 0) && ground.length > 0) reasons.push('the camera height above the ground is not measured');

    const terms = this.confidenceTerms(tracking.state, ground);
    const confidence = terms.length > 0 ? Math.min(...terms.map((t) => t.value)) : 0;
    const worldState = this.invalid ? WorldState.INVALID : reasons.length === 0 ? WorldState.READY : WorldState.NOT_READY;
    const readyArea = this.surfaces
      .filter((s) => s.surfaceClass === SurfaceClass.GROUND || s.surfaceClass === SurfaceClass.PLATFORM)
      .reduce((a, s) => a + s.area, 0);

    return deepFreeze({
      version: this.version,
      epoch: this.epoch,
      origin: {
        epoch: this.epoch,
        definition:
          'the camera frame of the first keyframe registered in this epoch of the landmark map, in ' +
          'units of that keyframe pair’s baseline — not a metre (v4 §18)',
      },
      scale: SCALE_LOCAL_UNITS,
      cameraPose: tracking.state === TrackingState.LOST ? null : this.pose,
      cameraHistory: this.history.slice(),
      landmarks: this.landmarks,
      keyframes: this.keyframes,
      gravity: this.gravity,
      surfaces: this.surfaces,
      sceneDepth: this.sceneDepth,
      cameraHeight: this.cameraHeight,
      trackingState: tracking.state,
      trackingReason: tracking.reason,
      mappingState:
        this.landmarks.length === 0
          ? MappingState.NO_MAP
          : this.surfaces.length === 0
            ? MappingState.MAPPING
            : MappingState.MAPPED,
      worldState,
      worldReasons: reasons,
      confidence: round(worldState === WorldState.INVALID ? 0 : confidence, 4),
      confidenceTerms: terms,
      coverage: this.coverage,
      readyArea: round(readyArea, 4),
      lastUpdated: {
        pose: this.lastPose,
        map: this.lastMap,
        surfaces: this.lastSurfaces,
        gravity: this.lastGravity,
      },
      integrityIssues: this.integrityIssues,
    });
  }

  /* ---------------------------------------------------------------------- */

  private trackingAt(now: number): { state: TrackingState; reason: string } {
    if (this.landmarks.length === 0 && this.poseState === 'NO_MAP') {
      return { state: TrackingState.INITIALIZING, reason: 'the map is still being built — keep looking around slowly' };
    }
    if (!this.pose) return { state: TrackingState.LOST, reason: this.poseReason };
    if (now - this.pose.at > POSE_STALE_MS) {
      return { state: TrackingState.LOST, reason: `no pose for ${Math.round(now - this.pose.at)} ms` };
    }
    if (this.pose.confidence < MIN_GOOD_POSE_CONFIDENCE) {
      return {
        state: TrackingState.DEGRADED,
        reason: `POSE: LOW CONFIDENCE — ${this.pose.confidence} below ${MIN_GOOD_POSE_CONFIDENCE}`,
      };
    }
    return { state: TrackingState.GOOD, reason: this.poseReason };
  }

  private confidenceTerms(tracking: TrackingState, ground: readonly Surface[]): WorldConfidenceTerm[] {
    const poseConfidence = tracking === TrackingState.LOST || !this.pose ? 0 : this.pose.confidence;
    const gravity =
      this.gravity.state === GravityState.ESTIMATED && this.gravity.spreadDeg >= 0
        ? Math.max(0, 1 - this.gravity.spreadDeg / 12)
        : 0;
    const bestGround = ground.reduce((a, s) => Math.max(a, s.confidence), 0);
    const confirmed = this.landmarks.filter((l) => l.confirmed).length;
    return [
      { name: 'pose', value: round(poseConfidence, 4), note: 'Phase 12’s localization confidence for the latest frame' },
      { name: 'gravity', value: round(gravity, 4), note: `spread ${this.gravity.spreadDeg}° against twice the 6° bar` },
      { name: 'ground', value: round(bestGround, 4), note: `best GROUND surface confidence (${ground.length} usable)` },
      { name: 'map', value: round(Math.min(1, confirmed / 100), 4), note: `${confirmed} confirmed landmark(s) against 100` },
    ];
  }

  private changeEpoch(epoch: number): void {
    if (this.epoch !== 0) this.epochChanges++;
    this.epoch = epoch;
    this.clearEpochState();
  }

  private clearEpochState(): void {
    this.pose = null;
    this.poseState = 'NO_MAP';
    this.poseReason = 'the world was (re)defined; no frame has been localized in it yet';
    this.history = [];
    this.gravity = UNKNOWN_GRAVITY;
    this.surfaces = [];
    this.sceneDepth = -1;
    this.cameraHeight = -1;
    this.lastPose = -1;
    this.lastSurfaces = -1;
    this.lastGravity = -1;
  }

  private reject(what: string): void {
    this.integrityIssues++;
    this.invalid = true;
    this.version++;
    void what;
  }
}

/** Distinct occupied cells over the confirmed landmarks. Changes only when the landmarks do. */
export function coverageOf(landmarks: readonly WorldLandmark[], sceneDepth: number): number {
  if (!(sceneDepth > 0)) return 0;
  const cell = COVERAGE_CELL_FRACTION * sceneDepth;
  const cells = new Set<string>();
  for (const l of landmarks) {
    if (!l.confirmed) continue;
    cells.add(l.position.map((v) => Math.floor(v / cell)).join(','));
  }
  return cells.size;
}

function medianExtent(landmarks: readonly WorldLandmark[]): number {
  if (landmarks.length === 0) return -1;
  const d = landmarks.map((l) => Math.hypot(l.position[0] ?? 0, l.position[1] ?? 0, l.position[2] ?? 0)).sort((a, b) => a - b);
  return d[d.length >> 1] ?? -1;
}

/** Every number in it finite — the check that keeps NaN out of the source of truth. */
export function finiteDeep(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => finiteDeep(v, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).every((v) => finiteDeep(v, depth + 1));
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
