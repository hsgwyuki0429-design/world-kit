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
