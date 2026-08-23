/**
 * RANSAC, as v3 §14's second step.
 *
 * ```
 * Feature Correspondence → RANSAC → Inlier Selection → Geometric Model → Pose candidate
 * ```
 *
 * The driver is generic over the model so that the fundamental matrix and the homography get
 * *the same* sampling, the same termination rule and the same threshold semantics. Two
 * implementations would be two chances for the comparison v3 §16 rests on to be unfair.
 *
 * Three things about this implementation are deliberate.
 *
 * **Sampling is seeded.** §59 bans `Math.random` in `src/`, and the audit enforces it. Beyond
 * that: a verification that cannot be replayed cannot be re-examined when its result is
 * questioned, and the whole point of this project is that results are re-examinable. The seed
 * travels into the evidence.
 *
 * **Termination is adaptive, and says which way it ended.** The iteration count is recomputed
 * from the best inlier ratio so far, so a clean set stops after a handful of samples and a
 * dirty one keeps going. If the cap binds before the confidence target is met, the result says
 * so — a reported inlier ratio from a run that never reached its confidence target is whatever
 * the last sample happened to give, and a test that could not tell the difference would treat
 * the two as equal.
 *
 * **The final model is refitted on all its inliers.** The model from a minimal sample is
 * determined by 4 or 8 points and carries their noise. Refitting over every inlier is what
 * turns a hypothesis into an estimate.
 *
 * Pure array arithmetic plus an injected `Rng`: no DOM, no worker, no camera, no clock.
 */

import type { Rng } from '../core/Rng';

export interface RansacOptions {
  /** Points drawn per hypothesis — 8 for a fundamental matrix, 4 for a homography. */
  readonly sampleSize: number;
  /** Inlier threshold, in pixels. Squared internally. */
  readonly thresholdPx: number;
  /** Probability that at least one all-inlier sample is drawn. The standard 0.99. */
  readonly confidence: number;
  readonly maxIterations: number;
}

export interface RansacResult<M> {
  readonly model: M;
  /** Indices into the input, in input order. */
  readonly inliers: number[];
  readonly outliers: number[];
  readonly inlierRatio: number;
  /** Mean squared error over the inliers, in px². */
  readonly meanSquaredError: number;
  readonly iterations: number;
  /**
   * Whether the adaptive rule stopped it, rather than the cap.
   *
   * `false` means the confidence target was never met and the reported ratio is the best of
   * `maxIterations` samples rather than an estimate with a stated probability behind it.
   */
  readonly terminatedEarly: boolean;
}

/**
 * How many samples are needed for `confidence` that one was all-inlier, at ratio `w`.
 *
 * `N = log(1 − p) / log(1 − wˢ)`. Guarded at both ends: `w` at or above 1 needs one sample,
 * and `w` at 0 needs more than any cap, so the caller's cap decides.
 */
export function requiredIterations(
  inlierRatio: number,
  sampleSize: number,
  confidence: number,
  cap: number,
): number {
  if (!(inlierRatio > 0)) return cap;
  if (inlierRatio >= 1) return 1;
  const pNoOutliers = inlierRatio ** sampleSize;
  if (pNoOutliers >= 1) return 1;
  const denom = Math.log(1 - pNoOutliers);
  if (!Number.isFinite(denom) || denom >= 0) return cap;
  const n = Math.log(1 - confidence) / denom;
  if (!Number.isFinite(n)) return cap;
  return Math.min(cap, Math.max(1, Math.ceil(n)));
}

/**
 * @param fit builds a model from the sampled indices, or returns `null` for a degenerate sample.
 * @param errorSq squared geometric error of one item under a model, in px².
 */
export function ransac<M>(
  count: number,
  options: RansacOptions,
  rng: Rng,
  fit: (indices: readonly number[]) => M | null,
  errorSq: (model: M, index: number) => number,
): RansacResult<M> | null {
  const { sampleSize, thresholdPx, confidence, maxIterations } = options;
  if (count < sampleSize) return null;
  const thresholdSq = thresholdPx * thresholdPx;

  let bestModel: M | null = null;
  let bestInliers: number[] = [];
  let iterations = 0;
  let needed = maxIterations;
  let terminatedEarly = false;

  while (iterations < Math.min(needed, maxIterations)) {
    iterations++;
    let sample: number[];
    try {
      sample = rng.sampleDistinct(sampleSize, count);
    } catch {
      // The population cannot supply a distinct sample. Not a failure of the model.
      break;
    }
    const model = fit(sample);
    if (!model) continue;

    const inliers: number[] = [];
    for (let i = 0; i < count; i++) {
      if (errorSq(model, i) <= thresholdSq) inliers.push(i);
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestModel = model;
      needed = requiredIterations(
        inliers.length / count,
        sampleSize,
        confidence,
        maxIterations,
      );
      if (iterations >= needed) {
        terminatedEarly = true;
        break;
      }
    }
  }
  if (!bestModel) return null;
  if (iterations < maxIterations) terminatedEarly = true;

  // Refit over every inlier: the sampled model is determined by `sampleSize` points and
  // carries their noise, and this is the step that turns a hypothesis into an estimate.
  let model = bestModel;
  let inliers = bestInliers;
  if (inliers.length > sampleSize) {
    const refined = fit(inliers);
    if (refined) {
      const refinedInliers: number[] = [];
      for (let i = 0; i < count; i++) {
        if (errorSq(refined, i) <= thresholdSq) refinedInliers.push(i);
      }
      // Kept only if it does not lose ground. A refit can drift on a marginal set, and
      // silently returning a worse model than the one that was measured would make the
      // reported iteration count describe a different model from the reported inliers.
      if (refinedInliers.length >= inliers.length) {
        model = refined;
        inliers = refinedInliers;
      }
    }
  }

  const inlierSet = new Set(inliers);
  const outliers: number[] = [];
  for (let i = 0; i < count; i++) if (!inlierSet.has(i)) outliers.push(i);

  let sumSq = 0;
  for (const i of inliers) sumSq += errorSq(model, i);

  return {
    model,
    inliers,
    outliers,
    inlierRatio: count > 0 ? inliers.length / count : 0,
    meanSquaredError: inliers.length > 0 ? sumSq / inliers.length : Number.POSITIVE_INFINITY,
    iterations,
    terminatedEarly,
  };
}
