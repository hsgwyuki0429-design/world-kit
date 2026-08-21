/**
 * Shi-Tomasi "good features to track" (§11, §82).
 *
 * Pure array arithmetic over a grayscale plane: no DOM, no worker, no camera. That is what
 * lets the whole of it be unit tested against images whose corners are known by construction
 * — a checkerboard has corners exactly where the squares meet, and a flat field has none —
 * rather than inferred from a device run.
 *
 * The measure is the smaller eigenvalue of the structure tensor summed over a window:
 *
 *     M = [ ΣIx²  ΣIxIy ]      λ₂ = ((a + c) − √((a − c)² + 4b²)) / 2
 *         [ ΣIxIy  ΣIy² ]
 *
 * λ₂ is large only where the intensity varies in *both* directions, which is what separates
 * a corner from an edge. An edge has one large eigenvalue and one near zero, and Phase 4's
 * optical flow cannot localise along it — the aperture problem — so an edge is not a feature
 * however strong it looks.
 *
 * Three things shape the implementation:
 *
 *  - **The window sums are separable running sums.** A naive (2r+1)² accumulation per pixel
 *    is ~50 operations at r=3; two passes of a running sum is about 8, independent of r.
 *    At 230 400 pixels and three tensor components that is the difference between fitting
 *    §H's 8 ms budget and not.
 *  - **Buffers are allocated once per image size and reused.** Same reasoning as the
 *    pyramid: at detection rates this would otherwise be megabytes of garbage per second.
 *  - **The contrast check does not use λ₂.** It measures local intensity variance straight
 *    from the grayscale plane, so it is an independent statistic rather than a restatement
 *    of the score the selector just maximised. See `sampleContrast`.
 */

import { Rng } from '../core/Rng';
import {
  GRID_CELLS,
  SceneTexture,
  cellIndexFor,
  classifyTexture,
} from './featureTypes';
import type { Feature } from './featureTypes';

export interface DetectorConfig {
  /** How many features to aim for. §11's initial target is 800. */
  readonly target: number;
  /** Corner strength floor, as a fraction of the frame's own strongest corner. */
  readonly qualityLevel: number;
  /** Non-maximum suppression radius, in detection-level pixels. */
  readonly minSeparation: number;
  /** Half-width of the structure-tensor window. r=2 gives a 5×5 box per pass. */
  readonly windowRadius: number;
  /**
   * How many box passes make up the window.
   *
   * **Two, not one, and this is a correctness fix rather than a refinement.** A single box
   * is a flat kernel, so the response around a corner is a *plateau* 2r wide rather than a
   * peak — every point on it scores identically. Non-maximum suppression then has nothing to
   * choose between them and keeps whichever the scan reaches first, which is always the
   * plateau's top-left edge. Measured on a checkerboard: the response was flat from (7,7) to
   * (11,11) for a corner at (10,10), and the detector reported (7,7) — a systematic bias of
   * the full window radius, toward the top-left, on every feature in every frame. At level 1
   * that is 6 px of error in level-0 coordinates, handed to Phase 4's optical flow as a
   * starting point and to Phase 6 as a correspondence.
   *
   * Two box passes convolve to a triangular kernel, which has a single maximum at the corner
   * itself. It costs one more O(1)-per-pixel pass over three buffers and it is the
   * difference between a detector that finds corners and one that finds their neighbourhood.
   */
  readonly blurPasses: number;
  /** Positions sampled for the contrast check. */
  readonly contrastSamples: number;
  /** Seed for that sampling (§59 — reproducible, and `Math.random` is banned in src/). */
  readonly rngSeed: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  target: 800,
  qualityLevel: 0.01,
  minSeparation: 8,
  windowRadius: 2,
  blurPasses: 2,
  contrastSamples: 240,
  rngSeed: 0x5eed_c0de,
};

export interface ContrastSample {
  /** Mean local intensity variance at the positions the detector chose. */
  readonly atFeatures: number;
  /** ...and at seeded-random positions in the same frame. */
  readonly atRandom: number;
  /**
   * `atFeatures / atRandom`. Reported, but not what the test gates on — see `aboveChance`.
   */
  readonly ratio: number;
  /**
   * Probability that a detected position out-textures a random one — the rank statistic.
   *
   * **This is the number FEAT-001 judges, and the ratio above is not.** The ratio scales
   * with how textured the scene is overall: on a dense pattern where nearly every pixel sits
   * near an edge, a perfectly working detector scores under 2, because the random control is
   * itself highly textured. Measured at 1.87 on a checkerboard. Gating on the ratio would
   * fail a working detector pointed at a brick wall.
   *
   * A rank statistic has no such dependence. Chance is exactly 0.5 whatever the scene, by
   * construction, so the distance from 0.5 measures the detector rather than the wallpaper.
   * Ties count as half, which is what makes a flat image score 0.5 rather than 1.
   */
  readonly aboveChance: number;
  readonly samples: number;
}

export interface GridComparison {
  /** Largest single-cell share of the selection, with the 8×6 quota applied. */
  readonly griddedMaxCellShare: number;
  /** ...and without it, taking the strongest `target` candidates outright. */
  readonly ungriddedMaxCellShare: number;
  readonly griddedOccupiedCells: number;
  readonly ungriddedOccupiedCells: number;
}

export interface DetectionResult {
  readonly features: Feature[];
  /** Mean gradient magnitude over the frame — how much structure there is to find at all. */
  readonly meanGradient: number;
  readonly texture: SceneTexture;
  readonly maxCornerStrength: number;
  /** Points that cleared the quality floor and non-maximum suppression. */
  readonly candidateCount: number;
  readonly occupiedCells: number;
  readonly maxCellShare: number;
  /** Present only on frames where the check was asked for; it costs a little extra. */
  readonly contrast: ContrastSample | null;
  readonly gridComparison: GridComparison | null;
  readonly detectMs: number;
  readonly width: number;
  readonly height: number;
}

export interface DetectOptions {
  /** Scale from detection-level pixels to level-0 pixels. 1 at level 0, 2 at level 1. */
  readonly levelScale: number;
  readonly wantContrast: boolean;
  readonly wantGridComparison: boolean;
  /** Cap the population, e.g. when topping up rather than detecting from scratch. */
  readonly target?: number;
}

interface Candidate {
  index: number;
  score: number;
}

export class FeatureDetector {
  private readonly config: DetectorConfig;
  private width = 0;
  private height = 0;

  private ixx = new Float32Array(0);
  private iyy = new Float32Array(0);
  private ixy = new Float32Array(0);
  private scratch = new Float32Array(0);
  private score = new Float32Array(0);
  private allocations = 0;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  }

  get bufferAllocations(): number {
    return this.allocations;
  }

  getConfig(): DetectorConfig {
    return this.config;
  }

  /**
   * How far in from the edge a score is trustworthy.
   *
   * The blur passes compose, so the support is `passes * radius` wide either side; a pixel
   * closer than that to the border has had the clamped edge folded into its tensor sum and
   * would score as a corner because the image stops there.
   */
  private effectiveMargin(): number {
    return this.config.windowRadius * this.config.blurPasses + 1;
  }

  private ensure(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const n = width * height;
    this.ixx = new Float32Array(n);
    this.iyy = new Float32Array(n);
    this.ixy = new Float32Array(n);
    this.scratch = new Float32Array(n);
    this.score = new Float32Array(n);
    this.allocations += 5;
  }

  /**
   * Detect on one grayscale plane.
   *
   * `gray` is a level of the pyramid the tracking worker already holds — nothing is copied
   * and nothing is converted.
   */
  detect(
    gray: Uint8Array,
    width: number,
    height: number,
    options: DetectOptions,
  ): DetectionResult {
    const started = performance.now();
    const target = Math.max(0, Math.floor(options.target ?? this.config.target));

    if (width < 8 || height < 8 || gray.length < width * height) {
      return {
        features: [], meanGradient: 0, texture: SceneTexture.AMBIGUOUS, maxCornerStrength: 0,
        candidateCount: 0, occupiedCells: 0, maxCellShare: 0, contrast: null,
        gridComparison: null, detectMs: performance.now() - started, width, height,
      };
    }
    this.ensure(width, height);

    const meanGradient = this.computeTensor(gray, width, height);
    const maxCornerStrength = this.computeScores(width, height);

    const candidates = this.collectCandidates(width, height, maxCornerStrength);
    // Strongest first: both the quota selection and the ungridded control walk this order,
    // so the two differ only by the grid, which is what FEAT-003 compares.
    candidates.sort((a, b) => b.score - a.score);

    const gridded = this.select(candidates, width, height, target, true);
    const gridComparison = options.wantGridComparison
      ? this.compareGrid(candidates, width, height, target, gridded)
      : null;

    const features = this.toFeatures(gridded, width, height, maxCornerStrength, options.levelScale);
    const cellCounts = new Int32Array(GRID_CELLS);
    for (const f of features) cellCounts[f.cell] = (cellCounts[f.cell] ?? 0) + 1;
    let occupied = 0;
    let maxInCell = 0;
    for (const c of cellCounts) {
      if (c > 0) occupied++;
      if (c > maxInCell) maxInCell = c;
    }

    const contrast = options.wantContrast
      ? this.sampleContrast(gray, width, height, features)
      : null;

    return {
      features,
      meanGradient,
      texture: classifyTexture(meanGradient),
      maxCornerStrength,
      candidateCount: candidates.length,
      occupiedCells: occupied,
      maxCellShare: features.length > 0 ? maxInCell / features.length : 0,
      contrast,
      gridComparison,
      detectMs: performance.now() - started,
      width,
      height,
    };
  }

  /**
   * Gradients and the three tensor products, then a separable box sum of each.
   *
   * Returns the mean gradient magnitude, measured on a stride-2 lattice — a quarter of the
   * square roots for a mean that is indistinguishable at this sample count, and it is used
   * only to classify the scene, never as a per-pixel quantity.
   */
  private computeTensor(gray: Uint8Array, width: number, height: number): number {
    const { ixx, iyy, ixy } = this;
    ixx.fill(0);
    iyy.fill(0);
    ixy.fill(0);

    let gradSum = 0;
    let gradCount = 0;
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        const gx = ((gray[i + 1] ?? 0) - (gray[i - 1] ?? 0)) * 0.5;
        const gy = ((gray[i + width] ?? 0) - (gray[i - width] ?? 0)) * 0.5;
        ixx[i] = gx * gx;
        iyy[i] = gy * gy;
        ixy[i] = gx * gy;
        if ((x & 1) === 0 && (y & 1) === 0) {
          gradSum += Math.sqrt(gx * gx + gy * gy);
          gradCount++;
        }
      }
    }

    const r = this.config.windowRadius;
    for (let pass = 0; pass < this.config.blurPasses; pass++) {
      this.boxBlur(ixx, width, height, r);
      this.boxBlur(iyy, width, height, r);
      this.boxBlur(ixy, width, height, r);
    }

    return gradCount > 0 ? gradSum / gradCount : 0;
  }

  /** Separable running-sum box filter, in place, via one scratch buffer. */
  private boxBlur(buf: Float32Array, width: number, height: number, r: number): void {
    const tmp = this.scratch;
    const win = 2 * r + 1;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0;
      for (let x = 0; x < Math.min(r, width); x++) sum += buf[row + x] ?? 0;
      for (let x = 0; x < width; x++) {
        const add = x + r;
        const drop = x - r - 1;
        if (add < width) sum += buf[row + add] ?? 0;
        if (drop >= 0) sum -= buf[row + drop] ?? 0;
        tmp[row + x] = sum;
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = 0; y < Math.min(r, height); y++) sum += tmp[y * width + x] ?? 0;
      for (let y = 0; y < height; y++) {
        const add = y + r;
        const drop = y - r - 1;
        if (add < height) sum += tmp[add * width + x] ?? 0;
        if (drop >= 0) sum -= tmp[drop * width + x] ?? 0;
        buf[y * width + x] = sum;
      }
    }
    void win;
  }

  /** λ₂ of the summed tensor, per pixel. Returns the frame's maximum. */
  private computeScores(width: number, height: number): number {
    const { ixx, iyy, ixy, score } = this;
    score.fill(0);
    const margin = this.effectiveMargin();
    let max = 0;
    for (let y = margin; y < height - margin; y++) {
      const row = y * width;
      for (let x = margin; x < width - margin; x++) {
        const i = row + x;
        const a = ixx[i] ?? 0;
        const c = iyy[i] ?? 0;
        const b = ixy[i] ?? 0;
        const d = a - c;
        // The smaller eigenvalue. Never negative for a real symmetric PSD tensor, but the
        // clamp keeps a rounding artefact from becoming a negative "strength".
        const lambda2 = (a + c - Math.sqrt(d * d + 4 * b * b)) * 0.5;
        const v = lambda2 > 0 ? lambda2 : 0;
        score[i] = v;
        if (v > max) max = v;
      }
    }
    return max;
  }

  private collectCandidates(width: number, height: number, maxScore: number): Candidate[] {
    const out: Candidate[] = [];
    if (maxScore <= 0) return out;
    const threshold = maxScore * this.config.qualityLevel;
    const margin = this.effectiveMargin();
    const { score } = this;
    for (let y = margin; y < height - margin; y++) {
      const row = y * width;
      for (let x = margin; x < width - margin; x++) {
        const i = row + x;
        const v = score[i] ?? 0;
        if (v < threshold) continue;
        // Local maximum in the 8-neighbourhood. Cheap, and it removes the bulk of the
        // plateau around every corner before the sort sees it.
        if (
          v >= (score[i - 1] ?? 0) && v >= (score[i + 1] ?? 0) &&
          v >= (score[i - width] ?? 0) && v >= (score[i + width] ?? 0) &&
          v >= (score[i - width - 1] ?? 0) && v >= (score[i - width + 1] ?? 0) &&
          v >= (score[i + width - 1] ?? 0) && v >= (score[i + width + 1] ?? 0)
        ) {
          out.push({ index: i, score: v });
        }
      }
    }
    return out;
  }

  /**
   * Walk the candidates strongest-first, keeping those that clear the separation radius —
   * and, when `useGrid`, those whose 8×6 cell still has room.
   *
   * The quota is a hard cap, not a first pass with a relaxation afterwards. That costs
   * features on a scene where only part of the frame has texture, and it is the point: §11
   * asks the grid to *prevent local concentration*, and a cap that gives way as soon as it
   * binds prevents nothing. What the cap costs is visible — `candidateCount` against
   * `features.length` — rather than hidden by a second pass.
   */
  private select(
    candidates: readonly Candidate[],
    width: number,
    height: number,
    target: number,
    useGrid: boolean,
  ): Candidate[] {
    const chosen: Candidate[] = [];
    if (target <= 0) return chosen;

    const quota = Math.ceil(target / GRID_CELLS);
    const perCell = new Int32Array(GRID_CELLS);

    // Occupancy grid at the separation radius, so suppression checks 9 cells rather than
    // every feature accepted so far.
    const sep = Math.max(1, this.config.minSeparation);
    const gw = Math.ceil(width / sep);
    const gh = Math.ceil(height / sep);
    const occupied: number[][] = Array.from({ length: gw * gh }, () => []);
    const sepSq = sep * sep;

    for (const cand of candidates) {
      if (chosen.length >= target) break;
      const x = cand.index % width;
      const y = (cand.index - x) / width;

      if (useGrid) {
        const cell = cellIndexFor(x, y, width, height);
        if ((perCell[cell] ?? 0) >= quota) continue;
      }

      const gx = Math.min(gw - 1, Math.floor(x / sep));
      const gy = Math.min(gh - 1, Math.floor(y / sep));
      let tooClose = false;
      for (let dy = -1; dy <= 1 && !tooClose; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -1; dx <= 1 && !tooClose; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= gw) continue;
          for (const idx of occupied[ny * gw + nx] ?? []) {
            const ox = idx % width;
            const oy = (idx - ox) / width;
            const ddx = ox - x;
            const ddy = oy - y;
            if (ddx * ddx + ddy * ddy < sepSq) {
              tooClose = true;
              break;
            }
          }
        }
      }
      if (tooClose) continue;

      chosen.push(cand);
      occupied[gy * gw + gx]?.push(cand.index);
      if (useGrid) {
        const cell = cellIndexFor(x, y, width, height);
        perCell[cell] = (perCell[cell] ?? 0) + 1;
      }
    }
    return chosen;
  }

  /**
   * The same candidates selected without the quota, for FEAT-003's paired comparison.
   *
   * A paired control on the same frame is the only way to say the grid did anything: an
   * evenly textured scene distributes evenly with or without it, and a test that did not
   * compare would record the wallpaper as a pass.
   */
  private compareGrid(
    candidates: readonly Candidate[],
    width: number,
    height: number,
    target: number,
    gridded: readonly Candidate[],
  ): GridComparison {
    const ungridded = this.select(candidates, width, height, target, false);
    const share = (sel: readonly Candidate[]): { max: number; occupied: number } => {
      const counts = new Int32Array(GRID_CELLS);
      for (const c of sel) {
        const x = c.index % width;
        const y = (c.index - x) / width;
        const cell = cellIndexFor(x, y, width, height);
        counts[cell] = (counts[cell] ?? 0) + 1;
      }
      let max = 0;
      let occupied = 0;
      for (const v of counts) {
        if (v > 0) occupied++;
        if (v > max) max = v;
      }
      return { max: sel.length > 0 ? max / sel.length : 0, occupied };
    };
    const g = share(gridded);
    const u = share(ungridded);
    return {
      griddedMaxCellShare: g.max,
      ungriddedMaxCellShare: u.max,
      griddedOccupiedCells: g.occupied,
      ungriddedOccupiedCells: u.occupied,
    };
  }

  private toFeatures(
    chosen: readonly Candidate[],
    width: number,
    height: number,
    maxScore: number,
    levelScale: number,
  ): Feature[] {
    const out: Feature[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const c = chosen[i];
      if (!c) continue;
      const x = c.index % width;
      const y = (c.index - x) / width;
      out.push({
        id: i,
        x,
        y,
        x0: x * levelScale,
        y0: y * levelScale,
        cornerStrength: c.score,
        age: 0,
        trackLength: 1,
        // Phase 4 and Phase 6 own these. Until then a number would be invented, and for an
        // error term an invented number is an invented confidence (§80).
        forwardBackwardError: null,
        reprojectionError: null,
        qualityScore: maxScore > 0 ? Math.min(1, c.score / maxScore) : 0,
        cell: cellIndexFor(x, y, width, height),
      });
    }
    return out;
  }

  /**
   * The contrast check (FEAT-001).
   *
   * Local intensity variance in a 5×5 window, read straight from the grayscale plane, at the
   * positions the detector chose and at the same number of seeded-random positions.
   *
   * **Deliberately not λ₂.** Reading back the score the selector just maximised would prove
   * only that the selector is consistent with its own map; a fabricated map would sail
   * through. Variance computed afresh from the pixels is an independent statistic, so a
   * detector emitting coordinates unrelated to the image scores the same as chance, and the
   * ratio collapses to 1.
   */
  private sampleContrast(
    gray: Uint8Array,
    width: number,
    height: number,
    features: readonly Feature[],
  ): ContrastSample | null {
    if (features.length === 0) return null;
    const n = Math.min(this.config.contrastSamples, features.length);
    const rng = new Rng(this.config.rngSeed);
    const margin = 3;

    const featureVals: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = features[Math.floor((i * features.length) / n)];
      if (!f) continue;
      featureVals.push(localVariance(gray, width, height, Math.round(f.x), Math.round(f.y)));
    }
    const atFeatures = featureVals.reduce((a, b) => a + b, 0) / Math.max(1, featureVals.length);

    const randomVals: number[] = [];
    const wSpan = Math.max(1, width - 2 * margin);
    const hSpan = Math.max(1, height - 2 * margin);
    for (let i = 0; i < n; i++) {
      const x = margin + rng.nextInt(wSpan);
      const y = margin + rng.nextInt(hSpan);
      randomVals.push(localVariance(gray, width, height, x, y));
    }
    const atRandom = randomVals.reduce((a, b) => a + b, 0) / n;

    return {
      atFeatures: round(atFeatures, 3),
      atRandom: round(atRandom, 3),
      // A floor on the denominator so a perfectly flat random sample cannot divide by zero
      // and report an infinite ratio. `Infinity` in an evidence bundle fails §84 anyway.
      ratio: round(atFeatures / Math.max(atRandom, 0.001), 3),
      aboveChance: round(rankAboveChance(featureVals, randomVals), 4),
      samples: n,
    };
  }
}

/**
 * P(a value from `a` exceeds one from `b`), ties counted as half.
 *
 * The Mann-Whitney statistic, computed by ranking rather than by comparing every pair.
 * Exactly 0.5 when the two samples are drawn from the same distribution — which is what a
 * detector emitting positions unrelated to the image produces, and why this is the number
 * FEAT-001 gates on rather than a ratio that moves with the scene.
 */
export function rankAboveChance(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0.5;
  const sorted = [...b].sort((x, y) => x - y);
  let total = 0;
  for (const v of a) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    const below = lo;
    let hi2 = sorted.length;
    let lo2 = below;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if ((sorted[mid] ?? 0) <= v) lo2 = mid + 1;
      else hi2 = mid;
    }
    const equal = lo2 - below;
    total += (below + equal * 0.5) / sorted.length;
  }
  return total / a.length;
}

/** Population variance of a 5×5 neighbourhood, clamped to the image. */
export function localVariance(
  gray: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= height) continue;
    const row = y * width;
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= width) continue;
      const v = gray[row + x] ?? 0;
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return variance > 0 ? variance : 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}
