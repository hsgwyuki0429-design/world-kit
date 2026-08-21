/**
 * The feature record of §11, and the vocabulary around it.
 *
 * §11 lists eight fields per feature. Four of them are Phase 3's to fill; two are trivial at
 * detection; and two — `forwardBackwardError` and `reprojectionError` — cannot exist until
 * Phase 4 tracks the feature and Phase 6 has a pose to project against.
 *
 * **Those two are `null`, never `0`.** Zero is a value, and for an error term it is the best
 * possible one: a record carrying `forwardBackwardError: 0` reads as a perfectly tracked
 * point, which is §80's *Fake Confidence* written into a data structure. `null` says "not
 * measured", which is the truth, and it makes the later phases fill them deliberately rather
 * than inherit a number that was never earned. FEAT-006 checks it.
 */

/** §11: 8×6, to stop features piling into one corner of the frame. */
export const GRID_COLS = 8;
export const GRID_ROWS = 6;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;

/** §11's population figures. */
export const FEATURE_TARGET = 800;
export const FEATURE_MAX = 1200;
export const FEATURE_MIN = 200;
export const FEATURE_CRITICAL = 80;

/** §11's regeneration ladder. */
export const REFILL_BELOW = 500;
export const EMERGENCY_BELOW = 200;
export const DEGRADED_BELOW = 80;

export interface Feature {
  /** Unique within the frame it was detected in. */
  readonly id: number;
  /** Position in *detection-level* pixels; `positionLevel0` carries the frame-level one. */
  readonly x: number;
  readonly y: number;
  /** The same point in level-0 coordinates, which is what later phases work in. */
  readonly x0: number;
  readonly y0: number;
  /** Shi-Tomasi's smaller eigenvalue of the structure tensor. Higher is a stronger corner. */
  readonly cornerStrength: number;
  /** Frames since detection. 0 at detection; Phase 4 advances it. */
  readonly age: number;
  /** How many frames this feature has been seen in. 1 at detection. */
  readonly trackLength: number;
  /** Phase 4 fills this. `null` until then — see the note at the top of this file. */
  readonly forwardBackwardError: number | null;
  /** Phase 6 fills this. `null` until then. */
  readonly reprojectionError: number | null;
  /**
   * Derived from `cornerStrength` alone, normalised into [0,1] against the frame's own
   * strongest corner.
   *
   * Nothing else is known about the feature yet, so nothing else may go into it. When
   * Phase 4 has a forward/backward error and Phase 6 a reprojection error, this becomes a
   * combination — but not before those terms are measurements.
   */
  readonly qualityScore: number;
  /** Index of the 8×6 cell the feature fell in, row-major. */
  readonly cell: number;
}

/** How the scene itself was classified, measured from the image (see the test plan). */
export const SceneTexture = {
  RICH: 'TEXTURE_RICH',
  POOR: 'TEXTURE_POOR',
  AMBIGUOUS: 'AMBIGUOUS',
} as const;
export type SceneTexture = (typeof SceneTexture)[keyof typeof SceneTexture];

/** Mean gradient magnitude at or above which a frame counts as having structure. */
export const TEXTURE_RICH_FLOOR = 8.0;
/** ...and at or below which it counts as blank. Between the two, neither test judges it. */
export const TEXTURE_POOR_CEILING = 4.0;

export function classifyTexture(meanGradient: number): SceneTexture {
  if (!Number.isFinite(meanGradient)) return SceneTexture.AMBIGUOUS;
  if (meanGradient >= TEXTURE_RICH_FLOOR) return SceneTexture.RICH;
  if (meanGradient <= TEXTURE_POOR_CEILING) return SceneTexture.POOR;
  return SceneTexture.AMBIGUOUS;
}

/**
 * §57's feature-population states, which the UI must report verbatim (§58, Rule 002).
 *
 * Derived from the count alone, by §11's ladder. There is no hysteresis and no smoothing:
 * the displayed state has to be a function of the number on the same screen, or the two can
 * disagree, and FEAT-002 checks that they never do.
 */
export const FeatureState = {
  OK: 'FEATURES_OK',
  LOW: 'LOW_FEATURE_COUNT',
  DEGRADED: 'TRACKING_DEGRADED',
} as const;
export type FeatureState = (typeof FeatureState)[keyof typeof FeatureState];

export function featureStateFor(count: number): FeatureState {
  if (count < DEGRADED_BELOW) return FeatureState.DEGRADED;
  if (count < FEATURE_MIN) return FeatureState.LOW;
  return FeatureState.OK;
}

/** What §11's regeneration ladder asks for at a given count. */
export const RefillUrgency = {
  NONE: 'NONE',
  REFILL: 'REFILL',
  EMERGENCY: 'EMERGENCY',
} as const;
export type RefillUrgency = (typeof RefillUrgency)[keyof typeof RefillUrgency];

export function refillUrgencyFor(count: number): RefillUrgency {
  if (count < EMERGENCY_BELOW) return RefillUrgency.EMERGENCY;
  if (count < REFILL_BELOW) return RefillUrgency.REFILL;
  return RefillUrgency.NONE;
}

/** Row-major cell index for a point, given the image size. */
export function cellIndexFor(x: number, y: number, width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((x / width) * GRID_COLS)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((y / height) * GRID_ROWS)));
  return row * GRID_COLS + col;
}
