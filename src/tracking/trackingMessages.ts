/**
 * What the tracking stage sends and receives through the pipeline's opaque seam.
 *
 * `pipeline/messages.ts` types those two fields as `unknown` because §83 keeps `pipeline`
 * from importing `tracking`. The concrete shape lives here, on the side that owns it, and
 * both ends narrow through `asTrackingResult` rather than casting blindly — a message that
 * does not match is dropped and reported, not assumed.
 *
 * **What crosses the boundary, and what does not.** The full §11 feature records stay in the
 * worker: that is where Phase 4 will consume them, and structured-cloning 800 objects with
 * twelve fields each at 30 Hz would spend more time on the boundary than on the detection.
 * What crosses is a compact overlay buffer for §51's on-screen points, the summary statistics
 * the tests judge, and a small sample of complete records so FEAT-006 can check the schema
 * against evidence rather than against a promise. The same division Phase 2 made with the
 * pyramid and its proof strip.
 */

import type { SceneTexture } from './featureTypes';

/** Per-frame options the composition root hands to the tracking stage. */
export interface TrackingOptions {
  /** Whether to detect at all on frames this reaches. */
  readonly detect: boolean;
  /**
   * Whether to follow the existing population from the previous frame (Phase 4, §12).
   *
   * `false` in Phase 3, where detection is independent on every frame and no feature has a
   * history. `true` in Phase 4, and it changes what `detect` means: detection stops running
   * on every frame and becomes §11's refill, run only when the tracked population has fallen
   * far enough to need topping up. The two counts stay separate in the result for the reason
   * the Phase 4 test plan gives — a refill can hide a tracker that lost everything.
   */
  readonly track: boolean;
  /** Pyramid level to detect on. 1 by default — see the Phase 3 test plan. */
  readonly level: number;
  readonly target: number;
  /** Run the contrast check on this frame (FEAT-001). Costs a little extra. */
  readonly wantContrast: boolean;
  /** Run the paired ungridded control on this frame (FEAT-003). Costs a second selection. */
  readonly wantGridComparison: boolean;
  /** Run the one-off level-0 cost calibration on this frame (FEAT-005). */
  readonly wantLevel0Calibration: boolean;
  /** How many complete §11 records to send back, for FEAT-006. */
  readonly recordSamples: number;
}

export const DEFAULT_TRACKING_OPTIONS: TrackingOptions = {
  detect: true,
  track: false,
  level: 1,
  target: 800,
  wantContrast: false,
  wantGridComparison: false,
  wantLevel0Calibration: false,
  recordSamples: 8,
};

/** A complete §11 record, as it crosses the boundary. */
export interface FeatureRecordSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly x0: number;
  readonly y0: number;
  readonly cornerStrength: number;
  readonly age: number;
  readonly trackLength: number;
  readonly forwardBackwardError: number | null;
  readonly reprojectionError: number | null;
  readonly qualityScore: number;
  readonly cell: number;
}

export interface TrackingContrast {
  readonly atFeatures: number;
  readonly atRandom: number;
  readonly ratio: number;
  readonly aboveChance: number;
  readonly samples: number;
}

export interface TrackingGridComparison {
  readonly griddedMaxCellShare: number;
  readonly ungriddedMaxCellShare: number;
  readonly griddedOccupiedCells: number;
  readonly ungriddedOccupiedCells: number;
  /** Whether the quota had anything to do on this frame — see `GridComparison.binding`. */
  readonly binding: boolean;
  readonly quota: number;
}

export interface TrackingRefill {
  readonly urgency: string;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly candidatesBefore: number;
  readonly candidatesAfter: number;
  readonly exhausted: boolean;
  readonly stateBefore: string;
  readonly stateAfter: string;
}

/**
 * The independent scene-motion measurement, as it crosses the boundary.
 *
 * Produced by `SceneShift`, which shares no code with the Lucas-Kanade solver and never sees
 * the feature list. FLOW-002 compares this against what the tracker says the points did, and
 * that comparison is the one number that carries Phase 4 — see the test plan.
 */
export interface TrackingSceneShift {
  readonly dx0: number;
  readonly dy0: number;
  readonly magnitude0: number;
  readonly residual: number;
  readonly medianResidual: number;
  readonly confidence: number;
  readonly zeroShiftResidual: number;
  readonly samples: number;
  readonly candidates: number;
  readonly levelScale: number;
  readonly width: number;
  readonly height: number;
}

/** One frame of Phase 4: what the tracker did, and what the image independently did. */
export interface TrackingFlow {
  /** Points carried forward from the previous frame and kept by §13. */
  readonly tracked: number;
  /** Points detection added this frame. Counted apart from `tracked`, always. */
  readonly redetected: number;
  /** The whole population after both. */
  readonly total: number;
  /** Points the tracker was given. `survival` is `tracked / offered`. */
  readonly offered: number;
  readonly survival: number;
  readonly failedToTrack: number;
  readonly rejectedByFb: number;
  readonly reducedConfidence: number;
  readonly medianDisplacementPx: number;
  readonly medianFbErrorPx: number;
  readonly fbAcceptable: number;
  readonly fbReduced: number;
  readonly fbRejected: number;
  readonly cellSpread: number;
  readonly occupiedFlowCells: number;
  readonly maxTrackLength: number;
  readonly medianAge: number;
  readonly frameFailed: boolean;
  readonly consecutiveFailedFrames: number;
  /** Tier steps and device rotations so far — see `FlowStepResult.geometryChanges`. */
  readonly geometryChanges: number;
  readonly everTracked: boolean;
  /** §33's state, computed by the one shared pure function — see `trackingState.ts`. */
  readonly state: string;
  readonly stateReason: string;
  /** Which of §33's GOOD conjuncts could not be evaluated, named rather than assumed away. */
  readonly goodBlockedBy: readonly string[];
  /** Cost of the Lucas-Kanade solve including §13's backward pass. FLOW-006 judges this. */
  readonly flowMs: number;
  /** Cost of the independent search, measured separately so it is not charged to the solver. */
  readonly shiftMs: number;
  readonly sceneShift: TrackingSceneShift | null;
  /** `STATIC` / `SLOW` / `FAST` / `OCCLUDED` / `INDETERMINATE`, measured from the image. */
  readonly frameMotion: string;
  readonly meanLuma: number;
  readonly topLevelMad: number;
  readonly detectedThisFrame: boolean;
  /** Features §11's refill produced this frame, before merging. `0` on a frame with no refill. */
  readonly detectionOffered: number;
  /** ...how many were declined because the point is already in the population — a healthy sign. */
  readonly declinedTooClose: number;
  /** ...and how many sat where the solver's 21×21 window cannot reach. */
  readonly declinedOutOfReach: number;
  readonly refillUrgency: string;
}

export interface TrackingResult {
  readonly kind: 'phase3';
  readonly detected: boolean;
  readonly count: number;
  readonly detectMs: number;
  readonly detectWidth: number;
  readonly detectHeight: number;
  readonly detectLevel: number;
  readonly meanGradient: number;
  readonly texture: SceneTexture;
  readonly maxCornerStrength: number;
  readonly candidateCount: number;
  readonly occupiedCells: number;
  readonly maxCellShare: number;
  readonly quota: number;
  readonly state: string;
  readonly contrast: TrackingContrast | null;
  readonly gridComparison: TrackingGridComparison | null;
  readonly refill: TrackingRefill | null;
  readonly recordSamples: readonly FeatureRecordSample[];
  readonly level0Calibration: { width: number; height: number; detectMs: number; features: number } | null;
  /**
   * `[x0, y0, qualityScore] × count`, in level-0 coordinates, transferred.
   *
   * §51 requires the overlay to draw *actually detected* positions rather than a fixed
   * pattern, so the renderer is given the real ones and nothing else — there is no path by
   * which it could invent them.
   */
  readonly overlay: ArrayBuffer | null;
  /**
   * Phase 4's frame, or `null` on a Phase 3 frame where nothing was tracked.
   *
   * Carried on the same message as the detection result rather than on a second one: the two
   * describe one frame, and splitting them would let the screen show a population from one
   * frame beside a state derived from another.
   */
  readonly flow: TrackingFlow | null;
  /**
   * `age` per overlay point, `Uint16Array`, aligned with `overlay`'s triples.
   *
   * The overlay's stride stays 3 so Phase 3's renderer and the overlay alignment probe read
   * it unchanged; the ages ride alongside so Phase 4's screen can draw a tracked point
   * differently from one detection has just replaced. `null` outside Phase 4.
   */
  readonly flowAge: ArrayBuffer | null;
}

/** Narrow the opaque payload, or return `null`. Never casts on faith. */
export function asTrackingResult(payload: unknown): TrackingResult | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { kind?: unknown };
  return p.kind === 'phase3' ? (payload as TrackingResult) : null;
}

/** Narrow the options the worker receives, falling back to "do nothing". */
export function asTrackingOptions(payload: unknown): TrackingOptions | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Partial<TrackingOptions>;
  if (typeof p.detect !== 'boolean' || typeof p.level !== 'number') return null;
  return { ...DEFAULT_TRACKING_OPTIONS, ...p } as TrackingOptions;
}
