/**
 * The pipeline's measured state, as one plain structure.
 *
 * Separated from `WorkerFramePipeline` because the Phase 2 test suite is evaluated against
 * this shape and nothing else. That keeps the tests runnable in Node with no DOM, no
 * worker and no camera — which is how `tests/unit/phase2Tests.test.ts` is able to feed the
 * harness a pipeline that never ran, one that ran perfectly, and one that lied, and check
 * that the verdicts differ.
 */

import type { AcquireRoute, WorkerScopeReport } from './messages';
import type { SegmentSummary, SeriesSummary } from './PipelineMetrics';
import type { TierDecision } from './AdaptiveController';

export interface RouteProbeRecord {
  readonly route: AcquireRoute;
  readonly ok: boolean;
  readonly attempts: number;
  readonly successes: number;
  /** Mean UI-thread cost of acquiring through this route, while it was being tried. */
  readonly meanAcquireMs: number;
  readonly error: string | null;
  readonly note: string;
}

export interface StressInterval {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly passes: number;
  /** How the pass count was derived from measurement, so it is not a magic number. */
  readonly derivedFrom: string;
}

/** One completed frame, kept in a bounded ring so §H.0's per-frame claim is checkable. */
export interface FrameRecord {
  readonly frameId: number;
  readonly at: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly procWidth: number;
  readonly procHeight: number;
  readonly tierStep: number;
  readonly workerMs: number;
  readonly roundTripMs: number;
  readonly meanLuma: number;
  readonly checksum: number;
  readonly stressPasses: number;
}

export interface TierUsage {
  readonly step: number;
  readonly label: string;
  readonly frames: number;
  readonly sizes: readonly string[];
}

/**
 * The measured effect of one ladder move.
 *
 * FRAME-004 asks whether adaptation *worked*, not whether it happened, so the median worker
 * latency over the window that triggered a move is kept alongside the median over the
 * window that followed it.
 */
export interface DecisionOutcome {
  readonly decisionIndex: number;
  readonly direction: string;
  readonly beforeMedianWorkerMs: number;
  readonly afterMedianWorkerMs: number;
  readonly samples: number;
}

export interface CrossCheckSummary {
  readonly count: number;
  readonly unmatched: number;
  readonly medianAbsDifference: number;
  readonly maxAbsDifference: number;
  /** Spread of the main thread's own luma readings — how much the scene varied at all. */
  readonly sceneStdDev: number;
  readonly sceneRange: number;
  readonly costMs: SeriesSummary;
}

export interface PipelineStats {
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly uptimeMs: number;

  /* Acquisition route (§H.1) */
  readonly route: AcquireRoute | null;
  readonly routeLocked: boolean;
  readonly routeProbes: readonly RouteProbeRecord[];

  /* Worker (§52, FRAME-002 criterion 1) */
  readonly workerStarted: boolean;
  readonly workerScope: WorkerScopeReport | null;
  readonly workerErrors: readonly string[];

  /* Counts */
  readonly callbacks: number;
  readonly admitted: number;
  readonly completed: number;
  /** Declined by rate pacing. Working as designed — never counted as a drop. */
  readonly pacedOut: number;
  /** Declined because the worker was still busy. Also by design, and counted separately. */
  readonly backpressured: number;
  /** Admitted and then never returned: a real defect. */
  readonly lost: number;
  readonly acquireFailures: number;

  /* Rates */
  readonly deliveredFps: number;
  /** What the camera offered — the ceiling on the delivered rate, whatever the target. */
  readonly sourceFps: number;
  readonly sessionDeliveredFps: number;
  readonly maxResultGapMs: number;

  /* Latency */
  readonly uiCostMs: SeriesSummary;
  readonly acquireMs: SeriesSummary;
  readonly workerMs: SeriesSummary;
  readonly roundTripMs: SeriesSummary;

  /* Tier (§53) */
  readonly tierStep: number;
  readonly tierLabel: string;
  readonly targetFps: number;
  readonly procWidth: number;
  readonly procHeight: number;
  readonly decisions: readonly TierDecision[];
  readonly decisionOutcomes: readonly DecisionOutcome[];
  /** Frames and processing sizes actually produced at each tier step, over the whole run. */
  readonly tierUsage: readonly TierUsage[];
  /** A downward step taken while no load was being injected: the device could not keep up. */
  readonly spontaneousDegrade: boolean;
  readonly maxDecisionsPer10s: number;

  /* Geometry (§H.0) */
  readonly sourceSizesObserved: readonly string[];
  readonly processedSizesObserved: readonly string[];
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly maxAspectError: number;
  readonly overBudgetFrames: number;
  readonly upscaledFrames: number;
  readonly framesAfterSourceChange: number;
  readonly procMatchedAfterSourceChange: boolean | null;

  /* Image (FRAME-002) */
  readonly pyramidLevels: readonly { width: number; height: number; bytes: number }[];
  readonly pyramidConsistent: boolean;
  readonly pyramidProblems: readonly string[];
  readonly meanLuma: number;
  readonly topMadMax: number;
  readonly topMadMedian: number;
  readonly topMadSamples: number;
  /** Strip-to-strip difference on the 64x48 grid Phase 1 calibrated its floor against. */
  readonly stripMadMax: number;
  readonly stripMadMedian: number;
  readonly stripMadSamples: number;
  readonly distinctChecksums: number;
  readonly crossCheck: CrossCheckSummary;

  /* Load injection */
  readonly stressPasses: number;
  readonly stressIntervals: readonly StressInterval[];
  readonly anyStressed: boolean;

  /* Continuity */
  readonly segments: readonly SegmentSummary[];
  readonly longestCleanSegment: SegmentSummary | null;
  readonly wasEverHidden: boolean;
  readonly hiddenCount: number;

  /** Bounded tail of completed frames, each carrying its own geometry. */
  readonly recentFrames: readonly FrameRecord[];
}
