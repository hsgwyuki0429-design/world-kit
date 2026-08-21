/**
 * The tracking stage's measured state, as one plain structure.
 *
 * Separated from the session that produces it for the same reason `pipeline/stats.ts` is:
 * the Phase 3 suite is evaluated against this shape and nothing else, so it can be examined
 * in Node with no DOM, no worker and no camera — which is how the harness can be shown a run
 * that detected nothing, one that worked, and one whose detector was emitting coordinates
 * unrelated to the image, and checked that the three produce different verdicts.
 */

import type { ClassStats, RefillEvent } from './FeaturePopulation';
import type { FeatureRecordSample, TrackingResult } from './trackingMessages';

export interface GridImprovement {
  /** Comparisons where the quota actually bound. Only these are informative. */
  readonly samples: number;
  /** Every comparison taken, binding or not. */
  readonly totalSamples: number;
  readonly medianGridded: number;
  readonly medianUngridded: number;
  readonly medianCellGain: number;
}

export interface TrackingStats {
  readonly running: boolean;
  /** Frames on which detection actually ran. */
  readonly detections: number;
  readonly detectLevel: number;
  readonly detectWidth: number;
  readonly detectHeight: number;

  /* Population (§11) */
  readonly count: number;
  readonly state: string;
  readonly quota: number;
  readonly maxCountSeen: number;
  readonly overMaxFrames: number;
  readonly quotaBreaches: number;
  /** Frames where the reported state disagreed with the reported count (Rule 002). */
  readonly stateMismatches: number;
  readonly stateFrames: Record<string, number>;

  /* Scene classification, measured from the image */
  readonly textureRich: ClassStats;
  readonly texturePoor: ClassStats;
  readonly textureAmbiguous: ClassStats;
  readonly gradientHistogram: readonly { meanGradient: number; frames: number }[];
  readonly meanGradient: number;
  readonly texture: string;

  /* FEAT-001's anti-fake check */
  readonly contrastSamples: number;
  readonly medianAboveChance: number;

  /* FEAT-003 */
  readonly grid: GridImprovement;
  readonly occupiedCells: number;
  readonly maxCellShare: number;

  /* FEAT-004 */
  readonly refills: readonly RefillEvent[];

  /* FEAT-005 */
  readonly meanDetectCostMs: number;
  readonly level0Calibration:
    | { width: number; height: number; detectMs: number; features: number }
    | null;

  /* FEAT-006 */
  readonly recordSamples: readonly FeatureRecordSample[];

  readonly lastResult: TrackingResult | null;
}
