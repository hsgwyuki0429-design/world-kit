/**
 * Does the overlay draw on the image the camera is actually showing?
 *
 * This exists because **nothing else in the project can answer that question.** Every other
 * check is invariant to the error it looks for:
 *
 *  - the detector's unit tests run on an in-memory image and never cross the
 *    video → `VideoFrame` → canvas → `getImageData` → pyramid path;
 *  - Phase 2's provenance cross-check compares the *mean* luma of the worker's grayscale
 *    against an independent read of the same frame, and a mean is unchanged by a rotation,
 *    a flip or a transpose;
 *  - FEAT-001's contrast statistic is computed inside the worker on the same buffer the
 *    detector used, so it scores just as well on a buffer unrelated to the scene.
 *
 * A device reported corners that lined up in landscape and were rotated in portrait — a
 * class of fault all three would pass. So this takes the main thread's own reading of the
 * video element, scores the detected positions against it under each candidate transform,
 * and reports which one the image agrees with. Identity winning by a wide margin is the only
 * result that means the overlay and the tracking data describe the same picture.
 *
 * It matters beyond the overlay: Phase 4 consumes these positions. A rotated buffer would
 * make the drawing wrong *and* the optical flow wrong, so the answer must not be to correct
 * the drawing.
 */

/** Normalised remappings, as (u, v) in [0,1] of the *image* for a point at (u, v). */
export const ALIGNMENT_TRANSFORMS = {
  identity: (u: number, v: number) => [u, v] as const,
  rot90: (u: number, v: number) => [1 - v, u] as const,
  rot180: (u: number, v: number) => [1 - u, 1 - v] as const,
  rot270: (u: number, v: number) => [v, 1 - u] as const,
  flipX: (u: number, v: number) => [1 - u, v] as const,
  flipY: (u: number, v: number) => [u, 1 - v] as const,
  transpose: (u: number, v: number) => [v, u] as const,
};

export type AlignmentTransform = keyof typeof ALIGNMENT_TRANSFORMS;

export interface AlignmentReading {
  /** Mean local variance at the detected positions, per candidate transform. */
  readonly scores: Readonly<Record<AlignmentTransform, number>>;
  /** The same measure at seeded-random positions — what "no relationship" looks like. */
  readonly randomBaseline: number;
  /** Whichever transform the image agrees with best. */
  readonly best: AlignmentTransform;
  /** `best` over `identity`. 1 means identity is the winner. */
  readonly bestOverIdentity: number;
  /** `identity` over the random baseline. Below ~2 the overlay is on nothing. */
  readonly identityOverRandom: number;
  readonly samples: number;
}

/** Local intensity variance in a (2r+1)² window — the same measure FEAT-001 uses. */
function localVarianceAt(
  gray: Float32Array, width: number, height: number, x: number, y: number, r: number,
): number {
  const cx = Math.round(x);
  const cy = Math.round(y);
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= width) continue;
      const p = gray[yy * width + xx] ?? 0;
      sum += p;
      sumSq += p * p;
      n++;
    }
  }
  if (n < 2) return 0;
  const mean = sum / n;
  const v = sumSq / n - mean * mean;
  return v > 0 ? v : 0;
}

/**
 * Score the detected positions against an independent reading of the same scene.
 *
 * `points` are (x, y) pairs in a space `pointsWidth` x `pointsHeight`; `gray` is the probe's
 * own reading, which need not be the same size — everything is compared in normalised
 * coordinates so the two may differ in scale without affecting the answer.
 */
export function scoreAlignment(
  gray: Float32Array,
  width: number,
  height: number,
  points: readonly number[],
  pointsWidth: number,
  pointsHeight: number,
  nextRandom: () => number,
  windowRadius = 3,
): AlignmentReading | null {
  const n = Math.floor(points.length / 2);
  if (n < 4 || width < 8 || height < 8 || pointsWidth <= 0 || pointsHeight <= 0) return null;

  const scores = {} as Record<AlignmentTransform, number>;
  for (const name of Object.keys(ALIGNMENT_TRANSFORMS) as AlignmentTransform[]) {
    const map = ALIGNMENT_TRANSFORMS[name];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const u = (points[i * 2] ?? 0) / pointsWidth;
      const v = (points[i * 2 + 1] ?? 0) / pointsHeight;
      const [mu, mv] = map(u, v);
      total += localVarianceAt(gray, width, height, mu * width, mv * height, windowRadius);
    }
    scores[name] = total / n;
  }

  let randomTotal = 0;
  const draws = Math.max(64, n);
  for (let i = 0; i < draws; i++) {
    randomTotal += localVarianceAt(
      gray, width, height, nextRandom() * width, nextRandom() * height, windowRadius,
    );
  }
  const randomBaseline = randomTotal / draws;

  let best: AlignmentTransform = 'identity';
  for (const name of Object.keys(scores) as AlignmentTransform[]) {
    if ((scores[name] ?? 0) > (scores[best] ?? 0)) best = name;
  }
  const identity = scores.identity ?? 0;
  return {
    scores,
    randomBaseline,
    best,
    bestOverIdentity: identity > 0 ? (scores[best] ?? 0) / identity : Infinity,
    identityOverRandom: randomBaseline > 0 ? identity / randomBaseline : Infinity,
    samples: n,
  };
}

/** Identity must win, and must beat "the points are on nothing" by a clear margin. */
export const MIN_IDENTITY_OVER_RANDOM = 2.0;
/** How much better another transform must be before the buffer is called misoriented. */
export const MISORIENTED_RATIO = 1.5;

export function isMisoriented(r: AlignmentReading): boolean {
  return r.best !== 'identity' && r.bestOverIdentity >= MISORIENTED_RATIO;
}
