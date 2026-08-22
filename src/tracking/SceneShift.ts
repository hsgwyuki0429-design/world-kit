/**
 * How far the image actually moved — measured without the tracker (FLOW-002's anti-fake gate).
 *
 * ## Why this file exists
 *
 * Phase 4's output can be produced convincingly without ever looking at the second frame. A
 * tracker that returns the points it was given reports every point surviving, a forward/
 * backward error of exactly 0.0 — §13's best band — and honestly climbing `age` and
 * `trackLength`. On a static scene it is indistinguishable from a working tracker, and
 * **no statistic computed from the tracker's own output can tell them apart.** Forward/
 * backward validation cannot: it is the tracker checking itself.
 *
 * So the harness measures the scene's motion with a second instrument that shares nothing
 * with the first:
 *
 *  - it does not call the Lucas-Kanade solver, and it duplicates none of its code — no
 *    bilinear sampling, no structure tensor, no iteration, no sub-pixel anything;
 *  - it never sees the feature list, so it cannot be steered by where the tracker chose to
 *    look;
 *  - it keeps its **own** copy of the previous frame, so it does not even share a buffer
 *    with the stage it is checking;
 *  - it is integer-valued and exhaustive over a small range: a sum of absolute differences
 *    at every shift in ±8 px on the pyramid's top level, and the smallest wins.
 *
 * It is the same shape of argument as Phase 2's provenance cross-check (an independent read
 * of the same frame) and Phase 3's contrast statistic (a statistic the detector's own score
 * map cannot fake) — and it is here for the reason §H.7 records: an invariant computed from
 * one side of a comparison cannot verify the comparison.
 *
 * ## What it is not
 *
 * It is not a better tracker and it is not offered as ground truth. It is coarse — integer
 * shifts on a level that is a quarter the width of level 0, so its own quantisation is 4
 * level-0 pixels — and it models the scene as a pure translation, which a rotation is not.
 * FLOW-002 accounts for both: it compares the two with a tolerance derived from this
 * instrument's own resolution, and it is a test about *slow lateral* motion, which is the
 * regime where a translation model is a fair description of the image.
 *
 * Pure array arithmetic: no DOM, no worker, no camera, no clock.
 */

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase4/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** Integer search range on the top level, in that level's pixels. */
export const SHIFT_SEARCH_RADIUS = 8;

/** Below this the measured shift cannot be resolved at all — the frame pair is static. */
export const STATIC_SHIFT_PX = 1.0;
/** Above this, motion has crossed half the 21 px window and LK's linearisation is past it. */
export const FAST_SHIFT_PX = 12.0;

/** Mean luma below which the lens is considered covered. */
export const OCCLUDED_LUMA = 12;
/** Top-level frame-to-frame MAD above which the image changed wholesale. */
export const OCCLUSION_MAD = 60;

/**
 * How much better the best shift must be than the median shift tried.
 *
 * **Not in the test plan's threshold table, and this is the derivation.** The plan names
 * `sceneShiftConfidence` and requires FLOW-002's frames to clear "its floor" without fixing
 * the number, so it is fixed here — before any Phase 4 result has been looked at — with the
 * argument written down rather than a value chosen to make a run pass. The amendment is
 * recorded in `docs/phase4/TEST-PLAN.md` under the same rule Phases 2 and 3 used.
 *
 * The residual is a mean absolute difference over 8-bit samples, so it is quantised at one
 * intensity level. On the top pyramid level of a real scene the residual at the best shift
 * runs a few levels per pixel, and a single level of quantisation is therefore on the order
 * of ten per cent of it. A margin smaller than that is not a measurement; a margin much
 * larger would require the scene to be strongly textured before its motion could be spoken
 * about at all, which would silently exclude exactly the frames Phase 3 calls texture-poor.
 * So: the best shift must beat the median tried shift by 10 %.
 *
 * A flat or featureless pair scores at or barely above 1.0 by construction — every shift
 * matches equally badly — and is excluded rather than reported as motionless, which is the
 * distinction this number exists to draw.
 */
export const MIN_SHIFT_CONFIDENCE = 1.1;

/**
 * The smallest residual the ratio above is allowed to divide by.
 *
 * The residual is a mean of *integer* absolute differences, so a value below half a level
 * means fewer than half the sampled pixels differ by even one — the two images are identical
 * to within the quantisation of the measurement, and dividing by that is dividing by a
 * number the instrument cannot resolve.
 *
 * It also keeps `confidence` finite, and that is not a cosmetic concern. A perfect match at
 * the best shift is the *most* confident answer the search can give; if it arrived as
 * `Infinity` every consumer would have to special-case it, and the first one that did not
 * would silently discard exactly the frames where the motion was clearest. Measured: a
 * synthetic pan produces exact matches on the top level, and treating those as unusable made
 * FLOW-002 report `PENDING` on a run whose motion was known by construction.
 */
export const MIN_RESIDUAL = 0.5;

/** How the harness classified the frame pair, from the image alone. */
export const FrameMotion = {
  STATIC: 'STATIC',
  SLOW: 'SLOW',
  FAST: 'FAST',
  OCCLUDED: 'OCCLUDED',
  /** No comparable predecessor, or the search found nothing distinctive enough to speak. */
  INDETERMINATE: 'INDETERMINATE',
} as const;
export type FrameMotion = (typeof FrameMotion)[keyof typeof FrameMotion];

export interface SceneShiftReading {
  /**
   * Displacement of the image content from the previous frame to the next, in top-level
   * pixels. Integer by construction.
   *
   * **Sign convention, stated because the comparison depends on it.** This is the same sense
   * the tracker reports: a feature at `p` in the previous frame is expected near `p + (dx, dy)`
   * in the next one. The search itself finds the offset that maps *next* back onto
   * *previous*, which is the negation, and it is negated here rather than at the point of
   * use so there is one place to be wrong.
   */
  readonly dx: number;
  readonly dy: number;
  /** The same shift in level-0 pixels — what the tracker's displacement is compared against. */
  readonly dx0: number;
  readonly dy0: number;
  /** Magnitude of (dx0, dy0). */
  readonly magnitude0: number;
  /** Mean absolute difference at the best shift, 0–255. */
  readonly residual: number;
  /** ...and at the median of every shift tried, which is what `confidence` is measured against. */
  readonly medianResidual: number;
  /** `medianResidual / residual`. 1.0 means the search could not tell shifts apart. */
  readonly confidence: number;
  /** Mean absolute difference at zero shift — the plain frame-to-frame change. */
  readonly zeroShiftResidual: number;
  /** Overlapping pixels compared at the best shift. */
  readonly samples: number;
  /** Shifts evaluated. `(2r+1)²`, less any that produced no overlap. */
  readonly candidates: number;
  /** Scale from top-level pixels to level-0 pixels. */
  readonly levelScale: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Exhaustive integer SAD translation search between two equally sized grayscale planes.
 *
 * Deliberately the dumbest thing that can measure a displacement: try every shift in the
 * range, sum |a − b| over the overlap, keep the smallest. No gradient, no iteration, no
 * interpolation, no early exit that depends on the data. The cost is fixed by the search
 * range and the image size, which on the top pyramid level (a 16th of level 0's pixels) is
 * a few hundred thousand byte comparisons.
 *
 * Sampling: every second pixel in each direction. A quarter of the work for a mean absolute
 * difference over thousands of samples that is indistinguishable at this precision — the
 * same trade the detector makes for its mean gradient, and for the same reason.
 */
export function estimateSceneShift(
  previous: Uint8Array,
  next: Uint8Array,
  width: number,
  height: number,
  levelScale: number,
  searchRadius: number = SHIFT_SEARCH_RADIUS,
): SceneShiftReading | null {
  if (width < 4 || height < 4) return null;
  if (previous.length < width * height || next.length < width * height) return null;

  const r = Math.max(1, Math.floor(searchRadius));
  const residuals: number[] = [];
  let bestSad = Number.POSITIVE_INFINITY;
  let bestDx = 0;
  let bestDy = 0;
  let bestSamples = 0;
  let zeroShift = -1;

  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      // Rows and columns of `next` that land inside `previous` once shifted.
      const y0 = Math.max(0, -dy);
      const y1 = Math.min(height, height - dy);
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(width, width - dx);
      if (y1 - y0 < 2 || x1 - x0 < 2) continue;

      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 2) {
        const rowNext = y * width;
        const rowPrev = (y + dy) * width + dx;
        for (let x = x0; x < x1; x += 2) {
          const d = (next[rowNext + x] ?? 0) - (previous[rowPrev + x] ?? 0);
          sum += d < 0 ? -d : d;
          count++;
        }
      }
      if (count === 0) continue;
      const sad = sum / count;
      residuals.push(sad);
      if (dx === 0 && dy === 0) zeroShift = sad;
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
        bestSamples = count;
      }
    }
  }

  if (residuals.length === 0 || !Number.isFinite(bestSad)) return null;

  residuals.sort((a, b) => a - b);
  const mid = residuals.length >> 1;
  const medianResidual =
    residuals.length % 2
      ? (residuals[mid] ?? 0)
      : ((residuals[mid - 1] ?? 0) + (residuals[mid] ?? 0)) / 2;

  // See `MIN_RESIDUAL`: a perfect match is the most confident answer the search can give,
  // and it is reported as a large finite number rather than as a division by zero.
  const confidence = medianResidual / Math.max(bestSad, MIN_RESIDUAL);

  // Negate into the tracker's sense — see the note on `SceneShiftReading.dx`. Written this
  // way rather than as a bare negation so a zero shift stays `0` and not `-0`, which serialises
  // into evidence as `-0` and compares unequal to `0` under `Object.is`.
  const shiftX = bestDx === 0 ? 0 : -bestDx;
  const shiftY = bestDy === 0 ? 0 : -bestDy;
  const dx0 = shiftX * levelScale;
  const dy0 = shiftY * levelScale;

  return {
    dx: shiftX,
    dy: shiftY,
    dx0,
    dy0,
    magnitude0: Math.sqrt(dx0 * dx0 + dy0 * dy0),
    residual: round(bestSad),
    medianResidual: round(medianResidual),
    confidence: Number.isFinite(confidence) ? round(confidence) : confidence,
    zeroShiftResidual: round(zeroShift),
    samples: bestSamples,
    candidates: residuals.length,
    levelScale,
    width,
    height,
  };
}

/**
 * Classify a frame pair from the image, never from what the operator meant to do.
 *
 * This is the discipline the whole test plan rests on: "the tester's intention is not
 * evidence". A run where someone believes they held the phone still and a run where the
 * tracker ignored the image produce identical numbers unless the scene's motion is measured
 * separately — so every Phase 4 test is defined against this classification, and this
 * classification is defined against `estimateSceneShift` and the frame's own luma.
 *
 * `OCCLUDED` is checked first and is two conditions, because a covered lens looks like two
 * different things depending on what the lens is covered *with*: a dark frame (mean luma
 * below `OCCLUDED_LUMA`), or a frame that changed wholesale with no shift explaining it —
 * a large top-level MAD together with a search that found nothing distinctive. The second
 * clause is what catches a hand passing across a bright scene.
 */
export function classifyFrameMotion(
  shift: SceneShiftReading | null,
  meanLuma: number,
  topLevelMad: number,
): FrameMotion {
  const undistinguished = shift === null || shift.confidence < MIN_SHIFT_CONFIDENCE;

  if (meanLuma >= 0 && meanLuma < OCCLUDED_LUMA) return FrameMotion.OCCLUDED;
  if (topLevelMad > OCCLUSION_MAD && undistinguished) return FrameMotion.OCCLUDED;

  if (shift === null) return FrameMotion.INDETERMINATE;
  if (undistinguished) return FrameMotion.INDETERMINATE;

  if (shift.magnitude0 < STATIC_SHIFT_PX) return FrameMotion.STATIC;
  if (shift.magnitude0 > FAST_SHIFT_PX) return FrameMotion.FAST;
  return FrameMotion.SLOW;
}

/**
 * FLOW-002's tolerance: `max(2.0 px, 0.35 × shift)`.
 *
 * The plan's derivation, kept next to the arithmetic: the coarse search is integer-valued on
 * a level a quarter of level 0's width, so its own quantisation is 4 level-0 pixels, while
 * LK is sub-pixel. Requiring the tracker to match a cruder instrument to better than that
 * instrument's own resolution would be requiring it to reproduce the crudeness.
 */
export const SHIFT_AGREEMENT_PX = 2.0;
export const SHIFT_AGREEMENT_FRACTION = 0.35;

export function shiftAgreementTolerance(measuredShiftPx: number): number {
  return Math.max(SHIFT_AGREEMENT_PX, SHIFT_AGREEMENT_FRACTION * Math.abs(measuredShiftPx));
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n;
}

/**
 * The search, with its own memory of the previous frame.
 *
 * The copy is not redundancy for its own sake. `GrayPyramid` reuses one buffer per level and
 * overwrites it every frame, and the flow tracker keeps its own copy for the same reason —
 * so if this class read the tracker's copy, the "independent" measurement would be sharing
 * the exact bytes it exists to check. One buffer, allocated when the size changes and never
 * per frame.
 */
export class SceneShiftProbe {
  private previous: Uint8Array | null = null;
  private width = 0;
  private height = 0;
  private allocationCount = 0;

  get allocations(): number {
    return this.allocationCount;
  }

  /** Drop the memory of the previous frame, e.g. when tracking is restarted. */
  reset(): void {
    this.previous = null;
  }

  /**
   * Measure against the frame handed in last time, then remember this one.
   *
   * Returns `null` on the first frame of a size, which is a frame pair that does not exist —
   * reporting a zero shift there would look exactly like a motionless scene.
   */
  measure(top: Uint8Array, width: number, height: number, levelScale: number): SceneShiftReading | null {
    const n = width * height;
    if (n <= 0 || top.length < n) return null;

    if (!this.previous || this.width !== width || this.height !== height) {
      this.previous = new Uint8Array(n);
      this.previous.set(top.subarray(0, n));
      this.width = width;
      this.height = height;
      this.allocationCount++;
      return null;
    }

    const reading = estimateSceneShift(this.previous, top, width, height, levelScale);
    this.previous.set(top.subarray(0, n));
    return reading;
  }
}
