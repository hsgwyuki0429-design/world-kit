/**
 * Feeds the SpatialWorld from mapping's output, and keeps the measurements Phases 11 and 12 are
 * judged on (v4 §23–§25).
 *
 * The world itself only stores and serves. This is the one place that turns the worker's
 * per-frame localization report into the world's inputs: it decodes the map snapshot, pairs each
 * localized frame with the gravity reading taken nearest to it, re-estimates down, re-extracts
 * the surfaces when the map or gravity has changed, and carries surface identities across
 * extractions. Every one of those steps is `mapping/` arithmetic; this file only sequences it.
 *
 * ## What it measures while it does that
 *
 *  - **Persistence** — what fraction of the surfaces found last time are found again (SURF-003).
 *    A detector that produced planes from noise would produce different ones every time.
 *  - **The control** — every few extractions the same landmarks are offered jittered off their
 *    planes, and the support found there is compared with the real extraction's (SURF-004).
 *  - **Provenance** — every surface's landmarks are checked to be in the map it was extracted
 *    from (SURF-001), and no surface may be classified while gravity is UNKNOWN (SURF-005).
 *  - **Localization quality** and **READY's own invariant**, for Phase 12.
 */

import { intrinsicsFor } from '../geometry/intrinsics';
import { GravityAligner, GravityState } from '../mapping/gravity';
import type { GravityEstimate } from '../mapping/gravity';
import {
  SurfaceClass,
  SurfaceOrientation,
  ORIENTATION_TOLERANCE_DEG,
  assignSurfaceIds,
  extractSurfaces,
  jitteredControl,
} from '../mapping/surfaces';
import type { Surface, SurfaceLandmark } from '../mapping/surfaces';
import { MAP_SNAPSHOT_STRIDE } from '../tracking/trackingMessages';
import type { LocalizationReport, MapSnapshot } from '../tracking/trackingMessages';
import { MIN_GOOD_POSE_CONFIDENCE, SpatialWorld, TrackingState, WorldState } from './SpatialWorld';
import type { CameraIntrinsicsRecord, SpatialWorldView, WorldKeyframe, WorldLandmark } from './SpatialWorld';

/** How often surfaces may be re-extracted, ms. The map changes about once a second. */
export const SURFACE_INTERVAL_MS = 700;
/** The control runs on every this-many extractions. */
export const CONTROL_EVERY = 4;
/** Frames a pairing is refused on when the phone was turning faster than this, deg/s. */
export const MAX_PAIRING_TURN_DPS = 90;
/** Re-estimate gravity every this many new pairings. */
const GRAVITY_EVERY = 5;
const SURFACE_SEED = 0x5f3a_11c7;
const HISTORY = 600;

export interface GravityReading {
  readonly down: readonly number[];
  readonly screenAngle: number;
  /** deg/s, `-1` when unknown. */
  readonly turnRate: number;
}

export interface WorldBuilderStats {
  /* ---- Phase 11 ---- */
  readonly extractions: number;
  readonly surfaces: number;
  readonly surfacesByClass: Record<string, number>;
  readonly lastSupport: number;
  readonly lastCandidates: number;
  readonly sceneDepth: number;
  readonly cameraHeight: number;
  readonly medianResidual: number;
  readonly persistenceOffered: number;
  readonly persistenceFound: number;
  readonly controlRuns: number;
  readonly medianControlRatio: number;
  readonly worstControlRatio: number;
  readonly provenanceViolations: number;
  readonly unclassifiedViolations: number;
  readonly orientationViolations: number;
  readonly surfacesBeforeConfirmed: number;
  readonly medianExtractionMs: number;
  readonly worstExtractionMs: number;
  readonly gravity: GravityEstimate;
  readonly pairings: number;
  readonly pairingsRefused: Record<string, number>;
  /* ---- Phase 12 ---- */
  readonly reports: number;
  readonly localized: number;
  readonly byState: Record<string, number>;
  /** Points re-linked to landmarks whose tracks had broken, over the session (the worker's count). */
  readonly relinked: number;
  /** Frames localized only because of re-linking — the map's own tracks had all broken. */
  readonly recovered: number;
  /** The longest run of reports without a localized frame, while a pose was held or lost. */
  readonly longestUnlocalizedRun: number;
  readonly medianErrorPx: number;
  readonly heldOutSamples: number;
  readonly medianHeldOutPx: number;
  readonly worstHeldOutPx: number;
  readonly agreementSamples: number;
  readonly medianAgreementDeg: number;
  readonly medianAgreementCenter: number;
  readonly medianLocalizationMs: number;
  readonly snapshots: number;
  readonly epochs: number;
  readonly epochChanges: number;
  readonly readyFrames: number;
  readonly readyViolations: number;
  readonly readyViolationDetail: string;
  readonly coverageWithoutMap: number;
  readonly integrityIssues: number;
  readonly maxHistory: number;
  readonly maxLandmarks: number;
  readonly samplesInvariant: number;
}

export class WorldBuilder {
  private readonly aligner = new GravityAligner();
  private gravity: GravityEstimate;
  private surfaces: readonly Surface[] = [];
  private nextSurfaceId = 1;
  private mapVersion = -1;
  private epoch = -1;
  private extractedVersion = -1;
  private extractedGravityState = '';
  private lastExtractionAt = -Infinity;
  private landmarkIds = new Set<number>();
  private snapshotLandmarks: readonly WorldLandmark[] = [];
  private snapshotKeyframes: readonly WorldKeyframe[] = [];

  private extractions = 0;
  private lastSupport = 0;
  private lastCandidates = 0;
  private sceneDepth = -1;
  private cameraHeight = -1;
  private residuals: number[] = [];
  private persistenceOffered = 0;
  private persistenceFound = 0;
  private controlRatios: number[] = [];
  private provenanceViolations = 0;
  private unclassifiedViolations = 0;
  private orientationViolations = 0;
  private surfacesBeforeConfirmed = 0;
  private extractionMs: number[] = [];
  private pairings = 0;
  private pairingsRefused: Record<string, number> = {};

  private reports = 0;
  private localized = 0;
  private relinked = 0;
  private recovered = 0;
  private unlocalizedRun = 0;
  private longestUnlocalizedRun = 0;
  /** The newest report's state, for WORLD-004's outside check. */
  private lastPoseState = 'NONE';
  private byState: Record<string, number> = {};
  private errors: number[] = [];
  private heldOut: number[] = [];
  private agreementDeg: number[] = [];
  private agreementCenter: number[] = [];
  private localizationMs: number[] = [];
  private snapshots = 0;
  private epochs = new Set<number>();
  private readyFrames = 0;
  private readyViolations = 0;
  private readyViolationDetail = '';
  private coverageWithoutMap = 0;
  private lastCoverage = 0;
  private lastMapAt = -1;
  private maxHistory = 0;
  private maxLandmarks = 0;
  private samplesInvariant = 0;

  constructor(
    private readonly world: SpatialWorld,
    private readonly gravityAt: (epochMs: number) => GravityReading | null,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.gravity = this.aligner.estimate();
  }

  reset(): void {
    this.world.reset();
    this.aligner.reset();
    this.gravity = this.aligner.estimate();
    this.surfaces = [];
    this.nextSurfaceId = 1;
    this.mapVersion = -1;
    this.epoch = -1;
    this.extractedVersion = -1;
    this.extractedGravityState = '';
    this.lastExtractionAt = -Infinity;
    this.landmarkIds = new Set();
    this.snapshotLandmarks = [];
    this.snapshotKeyframes = [];
    this.extractions = 0;
    this.lastSupport = 0;
    this.lastCandidates = 0;
    this.sceneDepth = -1;
    this.cameraHeight = -1;
    this.residuals = [];
    this.persistenceOffered = 0;
    this.persistenceFound = 0;
    this.controlRatios = [];
    this.provenanceViolations = 0;
    this.unclassifiedViolations = 0;
    this.orientationViolations = 0;
    this.surfacesBeforeConfirmed = 0;
    this.extractionMs = [];
    this.pairings = 0;
    this.pairingsRefused = {};
    this.reports = 0;
    this.localized = 0;
    this.relinked = 0;
    this.recovered = 0;
    this.unlocalizedRun = 0;
    this.longestUnlocalizedRun = 0;
    this.lastPoseState = 'NONE';
    this.byState = {};
    this.errors = [];
    this.heldOut = [];
    this.agreementDeg = [];
    this.agreementCenter = [];
    this.localizationMs = [];
    this.snapshots = 0;
    this.epochs = new Set();
    this.readyFrames = 0;
    this.readyViolations = 0;
    this.readyViolationDetail = '';
    this.coverageWithoutMap = 0;
    this.lastCoverage = 0;
    this.lastMapAt = -1;
    this.maxHistory = 0;
    this.maxLandmarks = 0;
    this.samplesInvariant = 0;
  }

  view(): SpatialWorldView {
    return this.world.view();
  }

  /** One frame's report from the worker. */
  onLocalization(report: LocalizationReport): void {
    this.reports++;
    this.byState[report.state] = (this.byState[report.state] ?? 0) + 1;
    if (report.localizationMs >= 0) push(this.localizationMs, report.localizationMs);

    if (report.snapshot) this.ingestSnapshot(report.snapshot);
    this.lastPoseState = report.state === 'LOCALIZED' && report.pose ? 'LOCALIZED' : report.state;
    this.relinked = report.relinkedTotal ?? this.relinked;
    this.recovered = report.recoveredTotal ?? this.recovered;
    if (this.lastPoseState === 'LOCALIZED') {
      this.unlocalizedRun = 0;
    } else if (this.localized > 0) {
      this.unlocalizedRun++;
      this.longestUnlocalizedRun = Math.max(this.longestUnlocalizedRun, this.unlocalizedRun);
    }

    const intrinsics = intrinsicsRecord(report.width, report.height);
    this.world.ingestPose({
      epoch: report.epoch,
      state: report.state,
      reason: report.reason,
      rotation: report.pose?.rotation ?? null,
      translation: report.pose?.translation ?? null,
      center: report.cameraCenter,
      confidence: report.confidence,
      intrinsics,
      medianErrorPx: report.medianErrorPx,
      inliers: report.inliers,
    });

    if (report.state === 'LOCALIZED' && report.pose) {
      this.localized++;
      if (report.medianErrorPx >= 0) push(this.errors, report.medianErrorPx);
      if (report.heldOutPx >= 0) push(this.heldOut, report.heldOutPx);
      if (report.keyframeAgreement) {
        push(this.agreementDeg, report.keyframeAgreement.rotationDeg);
        push(this.agreementCenter, report.keyframeAgreement.centerRelative);
      }
      this.pairGravity(report);
    }

    this.maybeExtract();
    this.checkInvariants();
  }

  stats(): WorldBuilderStats {
    const byClass: Record<string, number> = {};
    for (const s of this.surfaces) byClass[s.surfaceClass] = (byClass[s.surfaceClass] ?? 0) + 1;
    return {
      extractions: this.extractions,
      surfaces: this.surfaces.length,
      surfacesByClass: byClass,
      lastSupport: this.lastSupport,
      lastCandidates: this.lastCandidates,
      sceneDepth: this.sceneDepth,
      cameraHeight: this.cameraHeight,
      medianResidual: round(median(this.residuals), 6),
      persistenceOffered: this.persistenceOffered,
      persistenceFound: this.persistenceFound,
      controlRuns: this.controlRatios.length,
      medianControlRatio: round(median(this.controlRatios), 4),
      worstControlRatio: this.controlRatios.length > 0 ? round(Math.max(...this.controlRatios), 4) : -1,
      provenanceViolations: this.provenanceViolations,
      unclassifiedViolations: this.unclassifiedViolations,
      orientationViolations: this.orientationViolations,
      surfacesBeforeConfirmed: this.surfacesBeforeConfirmed,
      medianExtractionMs: round(median(this.extractionMs), 3),
      worstExtractionMs: this.extractionMs.length > 0 ? round(Math.max(...this.extractionMs), 3) : -1,
      gravity: this.gravity,
      pairings: this.pairings,
      pairingsRefused: { ...this.pairingsRefused },
      reports: this.reports,
      localized: this.localized,
      relinked: this.relinked,
      recovered: this.recovered,
      longestUnlocalizedRun: this.longestUnlocalizedRun,
      byState: { ...this.byState },
      medianErrorPx: round(median(this.errors), 4),
      heldOutSamples: this.heldOut.length,
      medianHeldOutPx: round(median(this.heldOut), 4),
      worstHeldOutPx: this.heldOut.length > 0 ? round(Math.max(...this.heldOut), 4) : -1,
      agreementSamples: this.agreementDeg.length,
      medianAgreementDeg: round(median(this.agreementDeg), 4),
      medianAgreementCenter: round(median(this.agreementCenter), 5),
      medianLocalizationMs: round(median(this.localizationMs), 3),
      snapshots: this.snapshots,
      epochs: this.epochs.size,
      epochChanges: this.world.epochChangeCount(),
      readyFrames: this.readyFrames,
      readyViolations: this.readyViolations,
      readyViolationDetail: this.readyViolationDetail,
      coverageWithoutMap: this.coverageWithoutMap,
      integrityIssues: this.world.view().integrityIssues,
      maxHistory: this.maxHistory,
      maxLandmarks: this.maxLandmarks,
      samplesInvariant: this.samplesInvariant,
    };
  }

  /* ---------------------------------------------------------------------- */

  private ingestSnapshot(snapshot: MapSnapshot): void {
    this.snapshots++;
    if (snapshot.epoch !== this.epoch) {
      // A new world: everything expressed in the old frame goes, including the pairings the
      // gravity estimate was made from.
      this.epoch = snapshot.epoch;
      this.aligner.reset();
      this.gravity = this.aligner.estimate();
      this.surfaces = [];
      this.extractedVersion = -1;
      this.extractedGravityState = '';
    }
    this.epochs.add(snapshot.epoch);
    this.mapVersion = snapshot.version;
    const decoded = decodeSnapshot(snapshot);
    this.snapshotLandmarks = decoded.landmarks;
    this.snapshotKeyframes = decoded.keyframes;
    this.landmarkIds = new Set(decoded.landmarks.map((l) => l.id));
    this.maxLandmarks = Math.max(this.maxLandmarks, decoded.landmarks.length);
    this.world.ingestMap({
      epoch: snapshot.epoch,
      version: snapshot.version,
      landmarks: decoded.landmarks,
      keyframes: decoded.keyframes,
    });
    this.lastMapAt = this.now();
  }

  private pairGravity(report: LocalizationReport): void {
    if (!report.pose) return;
    // A pose the world would not call GOOD is one the camera's own estimate of itself is unsure of
    // — frames in a blur, or resting on a handful of points. Its error goes straight into the
    // estimate of down, and on a hand-held feed they were the reason the right layout's spread sat
    // at 4–5° instead of 2: the standing estimate failed its own bar and the stage never started.
    if (report.confidence < MIN_GOOD_POSE_CONFIDENCE) {
      this.refusePairing('LOW_CONFIDENCE');
      return;
    }
    const reading = this.gravityAt(report.capturedAtEpoch);
    if (!reading) {
      this.refusePairing('NO_READING');
      return;
    }
    if (reading.turnRate > MAX_PAIRING_TURN_DPS) {
      this.refusePairing('TURNING');
      return;
    }
    this.aligner.add({
      rotation: report.pose.rotation,
      deviceDown: reading.down,
      screenAngle: reading.screenAngle,
    });
    this.pairings++;
    if (this.pairings % GRAVITY_EVERY === 0 || this.gravity.state !== GravityState.ESTIMATED) {
      const before = this.gravity;
      this.gravity = this.aligner.estimate();
      if (before.state !== this.gravity.state || before.worldDown?.join() !== this.gravity.worldDown?.join()) {
        this.world.ingestGravity(this.gravity, this.epoch);
      }
    }
  }

  private refusePairing(reason: string): void {
    this.pairingsRefused[reason] = (this.pairingsRefused[reason] ?? 0) + 1;
  }

  private maybeExtract(): void {
    const now = this.now();
    if (this.snapshotLandmarks.length === 0) return;
    const gravityKey = `${this.gravity.state}:${this.gravity.worldDown?.join() ?? ''}`;
    const changed = this.mapVersion !== this.extractedVersion || gravityKey !== this.extractedGravityState;
    if (!changed || now - this.lastExtractionAt < SURFACE_INTERVAL_MS) return;
    this.lastExtractionAt = now;
    this.extractedVersion = this.mapVersion;
    this.extractedGravityState = gravityKey;

    const landmarks: SurfaceLandmark[] = this.snapshotLandmarks.map((l) => ({
      id: l.id,
      position: l.position,
      confidence: l.confidence,
      confirmed: l.confirmed,
    }));
    const cameras = this.snapshotKeyframes.map((k) => k.center);
    const worldDown = this.gravity.state === GravityState.ESTIMATED ? this.gravity.worldDown : null;
    const t0 = this.now();
    const extraction = extractSurfaces({
      landmarks,
      cameraCenters: cameras,
      worldDown,
      seed: SURFACE_SEED + this.epoch,
    });
    push(this.extractionMs, this.now() - t0);
    this.extractions++;

    const confirmed = landmarks.filter((l) => l.confirmed).length;
    if (confirmed === 0 && extraction.surfaces.length > 0) this.surfacesBeforeConfirmed++;

    const assigned = assignSurfaceIds(this.surfaces, extraction.surfaces, extraction.sceneDepth, this.nextSurfaceId);
    if (this.surfaces.length > 0) {
      this.persistenceOffered += this.surfaces.length;
      this.persistenceFound += assigned.persisted;
    }
    this.nextSurfaceId = assigned.nextId;
    this.surfaces = assigned.surfaces;
    this.lastSupport = extraction.used;
    this.lastCandidates = extraction.candidates;
    this.sceneDepth = extraction.sceneDepth;
    this.cameraHeight = extraction.cameraHeight;
    for (const s of assigned.surfaces) push(this.residuals, s.residual);
    this.checkSurfaces(assigned.surfaces, worldDown !== null);

    if (this.extractions % CONTROL_EVERY === 1 && extraction.used > 0 && extraction.sceneDepth > 0) {
      const control = extractSurfaces({
        landmarks: jitteredControl(landmarks, extraction.sceneDepth, SURFACE_SEED ^ this.extractions),
        cameraCenters: cameras,
        worldDown,
        seed: SURFACE_SEED + this.epoch,
      });
      // The **largest** surface each finds, not the total: a structureless cloud of a few hundred
      // points always yields some slices of twenty, and how many of them the sequential search
      // takes before it stops says more about `MAX_SURFACES` than about the detector. Whether the
      // control's best slice rivals the room's best surface is the question.
      const best = (list: readonly Surface[]): number => list.reduce((a, s) => Math.max(a, s.support), 0);
      const realBest = best(extraction.surfaces);
      if (realBest > 0) push(this.controlRatios, best(control.surfaces) / realBest);
    }

    this.world.ingestSurfaces({
      epoch: this.epoch,
      surfaces: assigned.surfaces,
      sceneDepth: extraction.sceneDepth,
      cameraHeight: extraction.cameraHeight,
    });
  }

  private checkSurfaces(surfaces: readonly Surface[], gravityKnown: boolean): void {
    for (const s of surfaces) {
      if (s.landmarkIds.some((id) => !this.landmarkIds.has(id))) this.provenanceViolations++;
      if (!gravityKnown && s.surfaceClass !== SurfaceClass.UNKNOWN) this.unclassifiedViolations++;
      if (gravityKnown && s.tiltDeg >= 0) {
        const horizontalClass = s.surfaceClass === SurfaceClass.GROUND || s.surfaceClass === SurfaceClass.PLATFORM;
        if (horizontalClass && s.tiltDeg > ORIENTATION_TOLERANCE_DEG) this.orientationViolations++;
        if (s.surfaceClass === SurfaceClass.WALL && s.orientation !== SurfaceOrientation.VERTICAL) this.orientationViolations++;
      }
    }
  }

  /** READY's conjunction, checked from outside the world on every frame (WORLD-004). */
  private checkInvariants(): void {
    const v = this.world.view();
    this.samplesInvariant++;
    this.maxHistory = Math.max(this.maxHistory, v.cameraHistory.length);
    if (v.coverage !== this.lastCoverage) {
      // Coverage may change only with the landmarks or the scene depth behind it.
      if (this.lastMapAt < 0 || (v.lastUpdated.map < 0 && v.lastUpdated.surfaces < 0)) this.coverageWithoutMap++;
      this.lastCoverage = v.coverage;
    }
    if (v.worldState !== WorldState.READY) return;
    this.readyFrames++;
    const problems: string[] = [];
    if (v.trackingState !== TrackingState.GOOD) problems.push(`tracking ${v.trackingState}`);
    if (v.gravity.state !== GravityState.ESTIMATED) problems.push('gravity UNKNOWN');
    if (!v.surfaces.some((s) => s.surfaceClass === SurfaceClass.GROUND)) problems.push('no GROUND');
    if (!v.cameraPose) problems.push('no camera pose');
    // A held pose (a refused frame) is DEGRADED by construction; READY on one would mean the hold
    // leaked into GOOD.
    if (this.lastPoseState !== 'LOCALIZED') problems.push(`the newest frame was ${this.lastPoseState}, not localized`);
    if (problems.length > 0) {
      this.readyViolations++;
      this.readyViolationDetail = problems.join(', ');
    }
  }
}

export function decodeSnapshot(snapshot: MapSnapshot): {
  landmarks: WorldLandmark[];
  keyframes: WorldKeyframe[];
} {
  const ids = new Int32Array(snapshot.ids);
  const data = new Float32Array(snapshot.data);
  const n = Math.min(ids.length, Math.floor(data.length / MAP_SNAPSHOT_STRIDE));
  const landmarks: WorldLandmark[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * MAP_SNAPSHOT_STRIDE;
    landmarks.push({
      id: ids[i] ?? 0,
      position: [data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0],
      confidence: data[o + 3] ?? 0,
      observations: data[o + 4] ?? 0,
      confirmed: (data[o + 5] ?? 0) > 0.5,
    });
  }
  const keyframes: WorldKeyframe[] = snapshot.keyframes.map((k) => {
    const r = k.rotation;
    const t = k.translation;
    return {
      id: k.id,
      rotation: k.rotation,
      translation: k.translation,
      center: [0, 1, 2].map(
        (i) => -((r[i] ?? 0) * (t[0] ?? 0) + (r[3 + i] ?? 0) * (t[1] ?? 0) + (r[6 + i] ?? 0) * (t[2] ?? 0)),
      ),
    };
  });
  return { landmarks, keyframes };
}

/** The same `K` the worker solved with: `intrinsicsFor` on the frame's own dimensions. */
function intrinsicsRecord(width: number, height: number): CameraIntrinsicsRecord {
  const k = intrinsicsFor(width, height);
  return k
    ? { fx: k.fx, fy: k.fy, cx: k.cx, cy: k.cy, width: k.width, height: k.height }
    : { fx: 1, fy: 1, cx: 0, cy: 0, width: 0, height: 0 };
}

function push(list: number[], v: number): void {
  list.push(v);
  if (list.length > HISTORY) list.shift();
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
