/**
 * Processing tier ladder (§53, §54, §10).
 *
 * One ordered list rather than two independent knobs. §54 requires tracking resolution to
 * be given up before frame rate, and a single ladder makes that ordering structural: to
 * lower the rate you must first have lowered the resolution, because that is the step that
 * comes before it.
 *
 * Resolution is stored as a pair of *edges*, not as width and height. §H.0 measured that
 * rotating the device swaps the source dimensions on the same track, so a tier that said
 * "960 wide" would mean two different things depending on which way the phone is held. The
 * processing size for a frame is derived from that frame's own source geometry.
 */

export const TierName = {
  HIGH: 'HIGH',
  BASIC: 'BASIC',
  REDUCED: 'REDUCED',
} as const;
export type TierName = (typeof TierName)[keyof typeof TierName];

export interface TierSpec {
  readonly step: number;
  readonly name: TierName;
  /** Long edge of the processing image, in pixels. */
  readonly longEdge: number;
  /** Short edge of the processing image, in pixels. */
  readonly shortEdge: number;
  readonly targetFps: number;
  /**
   * §53's feature target for the tier. Phase 2 detects no features; the number is carried
   * so Phase 3 inherits the tier decision rather than inventing a second ladder.
   */
  readonly featureTarget: number;
}

/** §53 resolutions and rates, ordered from most to least expensive. */
export const TIER_LADDER: readonly TierSpec[] = [
  { step: 0, name: TierName.HIGH, longEdge: 1280, shortEdge: 720, targetFps: 30, featureTarget: 1000 },
  { step: 1, name: TierName.BASIC, longEdge: 960, shortEdge: 540, targetFps: 30, featureTarget: 700 },
  { step: 2, name: TierName.BASIC, longEdge: 960, shortEdge: 540, targetFps: 20, featureTarget: 700 },
  { step: 3, name: TierName.REDUCED, longEdge: 640, shortEdge: 360, targetFps: 20, featureTarget: 300 },
  { step: 4, name: TierName.REDUCED, longEdge: 640, shortEdge: 360, targetFps: 15, featureTarget: 300 },
];

/** §H: BASIC at 30 FPS is the declared default start. Never HIGH before measuring. */
export const DEFAULT_TIER_STEP = 1;
/** §10: 15 FPS is the minimum processing rate. The floor is a ladder position, not a clamp. */
export const FLOOR_TIER_STEP = TIER_LADDER.length - 1;

export function tierAt(step: number): TierSpec {
  const clamped = Math.min(Math.max(step, 0), TIER_LADDER.length - 1);
  const t = TIER_LADDER[clamped];
  // Unreachable after the clamp; thrown rather than defaulted so a ladder edit that breaks
  // the invariant fails loudly instead of silently selecting tier 0.
  if (!t) throw new Error(`tier ${step} is outside the ladder`);
  return t;
}

/** Pixel budget of a tier — the product of its edges, which rotation does not change. */
export function tierPixelBudget(tier: TierSpec): number {
  return tier.longEdge * tier.shortEdge;
}

export interface ProcessingSize {
  readonly width: number;
  readonly height: number;
  /** Linear scale applied to the source. Never greater than 1. */
  readonly scale: number;
}

/**
 * Derive the processing size for one frame from that frame's source size.
 *
 * Three properties this must have, all of them checked by FRAME-003:
 *
 *  - **Aspect preserved.** A stretched image would change the apparent focal lengths in
 *    x and y independently, which is a lie about the camera Phase 6 would then inherit.
 *  - **Never upscaled.** Inventing pixels is inventing image data (§80).
 *  - **Within the tier's budget**, whichever way the device is held.
 *
 * Both edges are forced even so that three pyramid levels exist without a half-pixel
 * ambiguity at the first halving.
 */
export function deriveProcessingSize(
  sourceWidth: number,
  sourceHeight: number,
  tier: TierSpec,
): ProcessingSize {
  if (
    !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
    sourceWidth < 1 || sourceHeight < 1
  ) {
    return { width: 0, height: 0, scale: 0 };
  }
  const srcLong = Math.max(sourceWidth, sourceHeight);
  const srcShort = Math.min(sourceWidth, sourceHeight);
  // The binding constraint is whichever edge would overflow first.
  const scale = Math.min(1, tier.longEdge / srcLong, tier.shortEdge / srcShort);

  const width = Math.max(2, Math.floor((sourceWidth * scale) / 2) * 2);
  const height = Math.max(2, Math.floor((sourceHeight * scale) / 2) * 2);
  return { width, height, scale: Math.round(scale * 10000) / 10000 };
}

/** Relative aspect-ratio error between a source and a derived processing size. */
export function aspectError(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): number {
  if (sourceHeight <= 0 || height <= 0 || sourceWidth <= 0 || width <= 0) return Infinity;
  const src = sourceWidth / sourceHeight;
  const out = width / height;
  return Math.abs(out - src) / src;
}
