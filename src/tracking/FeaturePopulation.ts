/**
 * The feature population and §11's regeneration ladder.
 *
 * §11 asks for three responses as the population falls: below 500 top it up, below 200 top
 * it up urgently, below 80 report `TRACKING DEGRADED`. Phase 4 is what *consumes* features —
 * it follows them frame to frame and loses some at every step — so in Phase 3 the population
 * falls for one reason only: the scene stopped having corners in it. Which is exactly the
 * case FEAT-002 asks the tester to produce, and the reason regeneration is testable now
 * rather than in Phase 4.
 *
 * **What a refill actually does here.** Detection thresholds corner strength at a fraction
 * of the frame's own strongest corner, so a frame with weak structure yields few features
 * even when it has plenty of usable ones. A refill re-runs the selection with the quality
 * floor relaxed and the separation reduced, which recovers the weaker corners the first
 * pass declined. It cannot conjure features out of a blank wall, and when it does not the
 * event says so — `exhausted` records that the frame had no more candidates to give, which
 * is the difference between a mechanism that failed and a scene that had nothing in it.
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { FeatureDetector } from './FeatureDetector';
import type { DetectOptions, DetectionResult } from './FeatureDetector';
import {
  FEATURE_MAX,
  FeatureState,
  RefillUrgency,
  SceneTexture,
  featureStateFor,
  refillUrgencyFor,
} from './featureTypes';
import type { FeatureRecordSample, TrackingResult } from './trackingMessages';
import type { TrackingStats } from './trackingStats';

/** How far the quality floor is relaxed on a refill pass. */
export const REFILL_QUALITY_FACTOR = 0.25;
/** ...and the separation radius, so weaker corners closer together become admissible. */
export const REFILL_SEPARATION_FACTOR = 0.6;

export interface RefillEvent {
  readonly at: number;
  readonly urgency: RefillUrgency;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly candidatesBefore: number;
  readonly candidatesAfter: number;
  /**
   * The frame had nothing more to offer: the relaxed pass found no additional candidates.
   *
   * FEAT-004 accepts a refill that raised nothing *only* when this is true. Otherwise a
   * refill that achieved nothing on a frame with corners available is a broken mechanism.
   */
  readonly exhausted: boolean;
  readonly texture: SceneTexture;
  readonly stateBefore: FeatureState;
  readonly stateAfter: FeatureState;
  readonly detectMs: number;
}

export interface DetectWithRefill {
  readonly result: DetectionResult;
  readonly refill: RefillEvent | null;
}

/**
 * Detect, and top up if §11 says to.
 *
 * Free of any state of its own so it can be unit tested one frame at a time.
 */
export function detectWithRefill(
  detector: FeatureDetector,
  refillDetector: FeatureDetector,
  gray: Uint8Array,
  width: number,
  height: number,
  options: DetectOptions,
  now: number,
): DetectWithRefill {
  const first = detector.detect(gray, width, height, options);
  const urgency = refillUrgencyFor(first.features.length);
  if (urgency === RefillUrgency.NONE) return { result: first, refill: null };

  // The relaxed pass replaces rather than supplements: it is the same selection over the
  // same candidates with a lower floor, so its output is a superset in spirit and merging
  // the two would double-count the corners both passes found.
  const second = refillDetector.detect(gray, width, height, options);
  const better = second.features.length > first.features.length ? second : first;

  return {
    result: better,
    refill: {
      at: now,
      urgency,
      countBefore: first.features.length,
      countAfter: better.features.length,
      candidatesBefore: first.candidateCount,
      candidatesAfter: second.candidateCount,
      exhausted: second.candidateCount <= first.candidateCount,
      texture: first.texture,
      stateBefore: featureStateFor(first.features.length),
      stateAfter: featureStateFor(better.features.length),
      detectMs: first.detectMs + second.detectMs,
    },
  };
}

/** Per-texture-class accumulation, so FEAT-001 and FEAT-002 judge the frames they mean to. */
export interface ClassStats {
  readonly frames: number;
  readonly medianCount: number;
  readonly minCount: number;
  readonly maxCount: number;
  readonly medianGradient: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}

interface ClassAccumulator {
  counts: number[];
  gradients: number[];
}

/**
 * Everything Phase 3 needs to answer FEAT-001..006, accumulated across a run.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */
export class FeaturePopulation {
  private readonly byTexture = new Map<SceneTexture, ClassAccumulator>();
  private readonly refills: RefillEvent[] = [];
  private readonly contrastSamples: number[] = [];
  private readonly gridSamples: {
    gridded: number;
    ungridded: number;
    griddedCells: number;
    ungriddedCells: number;
    binding: boolean;
  }[] = [];
  private readonly detectCosts: number[] = [];
  private readonly gradientHistogram = new Map<number, number>();

  private detections = 0;
  private framesSinceDetect = 0;
  private lastResult: TrackingResult | null = null;
  private lastRecordSamples: readonly FeatureRecordSample[] = [];
  private stateMismatches = 0;
  private overMaxFrames = 0;
  private quotaBreaches = 0;
  private maxCountSeen = 0;
  /** Every distinct §57 state the population reported, with how many frames held it. */
  private readonly stateFrames = new Map<FeatureState, number>();
  /** The one-off level-0 calibration the test plan requires, so the level choice is answerable. */
  private level0Calibration: { width: number; height: number; detectMs: number; features: number } | null = null;

  noteFrameWithoutDetection(): void {
    this.framesSinceDetect++;
  }

  /**
   * Fold one frame's tracking result into the run.
   *
   * Takes the message shape rather than the detector's own, because this runs on the main
   * thread and the message is all that crossed. Nothing here recomputes anything the worker
   * measured — it accumulates.
   */
  record(r: TrackingResult): void {
    this.detections++;
    this.lastResult = r;
    this.detectCosts.push(r.detectMs);
    if (this.detectCosts.length > 600) this.detectCosts.shift();

    const acc = this.byTexture.get(r.texture) ?? { counts: [], gradients: [] };
    acc.counts.push(r.count);
    acc.gradients.push(r.meanGradient);
    if (acc.counts.length > 2000) {
      acc.counts.shift();
      acc.gradients.shift();
    }
    this.byTexture.set(r.texture, acc);

    // A coarse histogram of the classifier's own input, so a run whose scenes all landed in
    // the ambiguous band is visible as that rather than as an absence of frames.
    const bucket = Math.min(40, Math.max(0, Math.round(r.meanGradient)));
    this.gradientHistogram.set(bucket, (this.gradientHistogram.get(bucket) ?? 0) + 1);

    const state = r.state as FeatureState;
    this.stateFrames.set(state, (this.stateFrames.get(state) ?? 0) + 1);
    // Rule 002: the state the engine reported and the count it reported must agree. If they
    // ever do not, that is a UI/engine divergence and FEAT-002 has to see it.
    if (state !== featureStateFor(r.count)) this.stateMismatches++;

    if (r.count > this.maxCountSeen) this.maxCountSeen = r.count;
    if (r.count > FEATURE_MAX) this.overMaxFrames++;
    // The quota is a hard cap in the selector, so a breach means the cap did not hold.
    if (r.maxCellShare * r.count > r.quota + 0.5) this.quotaBreaches++;

    if (r.contrast) {
      this.contrastSamples.push(r.contrast.aboveChance);
      if (this.contrastSamples.length > 400) this.contrastSamples.shift();
    }
    if (r.gridComparison) {
      this.gridSamples.push({
        gridded: r.gridComparison.griddedMaxCellShare,
        ungridded: r.gridComparison.ungriddedMaxCellShare,
        griddedCells: r.gridComparison.griddedOccupiedCells,
        ungriddedCells: r.gridComparison.ungriddedOccupiedCells,
        binding: r.gridComparison.binding,
      });
      if (this.gridSamples.length > 400) this.gridSamples.shift();
    }
    if (r.refill) {
      this.refills.push({
        at: Date.now(),
        urgency: r.refill.urgency as RefillUrgency,
        countBefore: r.refill.countBefore,
        countAfter: r.refill.countAfter,
        candidatesBefore: r.refill.candidatesBefore,
        candidatesAfter: r.refill.candidatesAfter,
        exhausted: r.refill.exhausted,
        texture: r.texture,
        stateBefore: r.refill.stateBefore as FeatureState,
        stateAfter: r.refill.stateAfter as FeatureState,
        detectMs: r.detectMs,
      });
      if (this.refills.length > 200) this.refills.shift();
    }
    if (r.level0Calibration && !this.level0Calibration) {
      this.level0Calibration = r.level0Calibration;
    }
    if (r.recordSamples.length > 0) this.lastRecordSamples = [...r.recordSamples];
    this.framesSinceDetect = 0;
  }

  getLastResult(): TrackingResult | null {
    return this.lastResult;
  }

  getRecordSamples(): readonly FeatureRecordSample[] {
    return this.lastRecordSamples;
  }

  getStateMismatches(): number {
    return this.stateMismatches;
  }

  framesWithoutDetection(): number {
    return this.framesSinceDetect;
  }

  getDetections(): number {
    return this.detections;
  }

  classStats(texture: SceneTexture): ClassStats {
    const acc = this.byTexture.get(texture);
    if (!acc || acc.counts.length === 0) {
      return { frames: 0, medianCount: 0, minCount: 0, maxCount: 0, medianGradient: 0 };
    }
    return {
      frames: acc.counts.length,
      medianCount: round(median(acc.counts), 1),
      minCount: Math.min(...acc.counts),
      maxCount: Math.max(...acc.counts),
      medianGradient: round(median(acc.gradients), 3),
    };
  }

  medianContrast(): number {
    return this.contrastSamples.length === 0 ? -1 : round(median(this.contrastSamples), 4);
  }

  contrastCount(): number {
    return this.contrastSamples.length;
  }

  /**
   * How much clustering the grid removed, over the frames where it had anything to remove.
   *
   * Only *binding* comparisons count: on a sparse frame no cell approaches the quota, the
   * two selections are identical, and including those samples measures the scene rather
   * than the mechanism. `samples` is the binding count, `totalSamples` the whole population,
   * so a run where the grid never bound is visible as that rather than as a failure.
   */
  gridImprovement(): {
    samples: number;
    totalSamples: number;
    medianGridded: number;
    medianUngridded: number;
    medianCellGain: number;
  } {
    const binding = this.gridSamples.filter((s) => s.binding);
    if (binding.length === 0) {
      return {
        samples: 0,
        totalSamples: this.gridSamples.length,
        medianGridded: -1,
        medianUngridded: -1,
        medianCellGain: 0,
      };
    }
    return {
      samples: binding.length,
      totalSamples: this.gridSamples.length,
      medianGridded: round(median(binding.map((s) => s.gridded)), 4),
      medianUngridded: round(median(binding.map((s) => s.ungridded)), 4),
      medianCellGain: round(median(binding.map((s) => s.griddedCells - s.ungriddedCells)), 2),
    };
  }

  refillEvents(): readonly RefillEvent[] {
    return this.refills;
  }

  meanDetectCostMs(): number {
    if (this.detectCosts.length === 0) return -1;
    return round(this.detectCosts.reduce((a, b) => a + b, 0) / this.detectCosts.length, 3);
  }

  getQuotaBreaches(): number {
    return this.quotaBreaches;
  }

  getOverMaxFrames(): number {
    return this.overMaxFrames;
  }

  getStateFrames(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.stateFrames) out[k] = v;
    return out;
  }

  getLevel0Calibration(): { width: number; height: number; detectMs: number; features: number } | null {
    return this.level0Calibration;
  }

  /** The shape the Phase 3 suite is evaluated against. */
  stats(running: boolean): TrackingStats {
    const last = this.lastResult;
    const grid = this.gridImprovement();
    return {
      running,
      detections: this.detections,
      detectLevel: last?.detectLevel ?? -1,
      detectWidth: last?.detectWidth ?? 0,
      detectHeight: last?.detectHeight ?? 0,

      count: last?.count ?? 0,
      state: last?.state ?? 'FEATURES_OK',
      quota: last?.quota ?? 0,
      maxCountSeen: this.maxCountSeen,
      overMaxFrames: this.overMaxFrames,
      quotaBreaches: this.quotaBreaches,
      stateMismatches: this.stateMismatches,
      stateFrames: this.getStateFrames(),

      textureRich: this.classStats(SceneTexture.RICH),
      texturePoor: this.classStats(SceneTexture.POOR),
      textureAmbiguous: this.classStats(SceneTexture.AMBIGUOUS),
      gradientHistogram: [...this.gradientHistogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([meanGradient, frames]) => ({ meanGradient, frames })),
      meanGradient: last?.meanGradient ?? -1,
      texture: last?.texture ?? 'AMBIGUOUS',

      contrastSamples: this.contrastSamples.length,
      medianAboveChance: this.medianContrast(),

      grid,
      occupiedCells: last?.occupiedCells ?? 0,
      maxCellShare: last?.maxCellShare ?? 0,

      refills: [...this.refills],

      meanDetectCostMs: this.meanDetectCostMs(),
      level0Calibration: this.level0Calibration,

      recordSamples: this.lastRecordSamples,
      lastResult: last,
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      detections: this.detections,
      byTexture: {
        TEXTURE_RICH: this.classStats(SceneTexture.RICH),
        TEXTURE_POOR: this.classStats(SceneTexture.POOR),
        AMBIGUOUS: this.classStats(SceneTexture.AMBIGUOUS),
      },
      gradientHistogram: [...this.gradientHistogram.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, frames]) => ({ meanGradient: bucket, frames })),
      stateFrames: this.getStateFrames(),
      contrast: {
        samples: this.contrastSamples.length,
        median: this.medianContrast(),
        recent: this.contrastSamples.slice(-24),
      },
      grid: this.gridImprovement(),
      quotaBreaches: this.quotaBreaches,
      stateMismatches: this.stateMismatches,
      lastRecordSamples: this.lastRecordSamples as unknown as JsonValue,
      overMaxFrames: this.overMaxFrames,
      maxCountSeen: this.maxCountSeen,
      refills: this.refills.slice(-40),
      refillCount: this.refills.length,
      meanDetectCostMs: this.meanDetectCostMs(),
      level0Calibration: this.level0Calibration,
      note:
        'Texture classes are measured from the image, not asserted by the harness: a frame ' +
        'counts as rich or poor by its own mean gradient magnitude, and the histogram above ' +
        'shows where the run actually sat. A refill marked `exhausted` found no further ' +
        'candidates, which is a scene with nothing left in it rather than a mechanism that ' +
        'failed.',
    }) as Record<string, JsonValue>;
  }
}
