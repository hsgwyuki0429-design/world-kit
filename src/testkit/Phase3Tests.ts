/**
 * Phase 3 test suite — FEAT-001..FEAT-006.
 *
 * Specs transcribed from `docs/phase3/TEST-PLAN.md`, written before `src/tracking/` existed
 * (§29). Same verdict algebra as the phases before it: PASS / FAIL / PENDING, with PENDING
 * holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `TrackingStats` and nothing else — no DOM, no worker, no camera — so the
 * suite itself can be shown a run that detected nothing, one that worked, and one whose
 * detector was emitting coordinates unrelated to the image, and checked that the three
 * produce different verdicts.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  DEGRADED_BELOW,
  EMERGENCY_BELOW,
  FEATURE_MAX,
  FEATURE_MIN,
  FEATURE_TARGET,
  GRID_COLS,
  GRID_ROWS,
  REFILL_BELOW,
  TEXTURE_POOR_CEILING,
  TEXTURE_RICH_FLOOR,
} from '../tracking/featureTypes';
import type { TrackingStats } from '../tracking/trackingStats';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Frames of a texture class before that class is judged. */
export const MIN_SCENE_FRAMES = 15;
/**
 * Rank statistic floor for the contrast check. Chance is exactly 0.5, whatever the scene.
 *
 * See the plan amendment: this replaced a ratio threshold that measured how textured the
 * scene was as much as it measured the detector.
 */
export const MIN_CONTRAST_ABOVE_CHANCE = 0.75;
export const MIN_CONTRAST_SAMPLES = 10;
/** Paired grid comparisons before FEAT-003's median means anything. */
export const MIN_GRID_SAMPLES = 10;
/** §H: Shi-Tomasi is budgeted at 8 ms, amortised over refill frames. */
export const DETECT_BUDGET_MS = 8.0;
/** FEAT-005 needs a population before a mean means anything. */
export const MIN_DETECTIONS_FOR_COST = 10;
/**
 * On a blank wall the count must fall to at most this fraction of the textured median.
 *
 * Halving is a deliberately generous bar: a detector genuinely responding to the image
 * collapses far further than this, and one whose output does not depend on the image cannot
 * reach it at all.
 */
export const POOR_COUNT_FRACTION = 0.5;

export interface Phase3Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** Detection was switched on at least once in this run. */
  readonly detectionEverRan: boolean;
  readonly stats: TrackingStats;
}

type Phase3Test = PhaseTest<Phase3Context>;

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

/* -------------------------------------------------------------------------- */

const FEAT_001: Phase3Test = {
  spec: {
    id: 'FEAT-001',
    title: 'Texture-rich wall',
    required: true,
    input: 'the camera on a surface with structure; frames the worker classified TEXTURE_RICH',
    expected: 'features are found in useful numbers, and they sit on real image structure',
    passCriteria: `>= ${MIN_SCENE_FRAMES} texture-rich frames; median count >= ${FEATURE_MIN} and no frame above ${FEATURE_MAX}; over >= ${MIN_CONTRAST_SAMPLES} sampled frames the median probability that a detected position out-textures a seeded-random one in the same frame is >= ${MIN_CONTRAST_ABOVE_CHANCE}, against a chance value of 0.5`,
    failureCondition: 'counts inside the band but a contrast statistic at chance — a detector producing coordinates rather than finding corners',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const rich = s.textureRich;
    const metrics: Record<string, JsonValue> = {
      richFrames: rich.frames,
      richMedianCount: rich.medianCount,
      richMinCount: rich.minCount,
      richMaxCount: rich.maxCount,
      richMedianGradient: rich.medianGradient,
      contrastSamples: s.contrastSamples,
      medianAboveChance: s.medianAboveChance,
      maxCountSeen: s.maxCountSeen,
      overMaxFrames: s.overMaxFrames,
      detectLevel: s.detectLevel,
      detectSize: `${s.detectWidth}x${s.detectHeight}`,
    };

    if (!ctx.pipelineEverStarted || !ctx.detectionEverRan || s.detections === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `detection has not run (camera ${ctx.cameraState})`,
        reason: 'no frame has been detected on, so there is nothing to judge',
        metrics,
      };
    }
    if (rich.frames < MIN_SCENE_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${rich.frames}/${MIN_SCENE_FRAMES} texture-rich frames so far`,
        reason:
          `point the camera at a surface with structure in it. A frame counts as rich when ` +
          `its own mean gradient magnitude reaches ${TEXTURE_RICH_FLOOR} — that is measured ` +
          'from the image, not asserted here',
        metrics,
      };
    }
    if (s.contrastSamples < MIN_CONTRAST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.contrastSamples}/${MIN_CONTRAST_SAMPLES} contrast samples so far`,
        reason: 'the contrast check runs on a subset of frames; keep detecting for a moment',
        metrics,
      };
    }

    const problems: string[] = [];
    if (rich.medianCount < FEATURE_MIN) {
      problems.push(
        `median count ${rich.medianCount} on textured frames is below the ${FEATURE_MIN} §11 ` +
          'sets as the minimum',
      );
    }
    if (s.maxCountSeen > FEATURE_MAX) {
      problems.push(`${s.overMaxFrames} frame(s) exceeded the ${FEATURE_MAX} maximum`);
    }
    if (s.medianAboveChance < MIN_CONTRAST_ABOVE_CHANCE) {
      problems.push(
        `detected positions out-texture random ones only ${pct(s.medianAboveChance)} of the ` +
          `time, against ${pct(MIN_CONTRAST_ABOVE_CHANCE)} required and 50% for chance — these ` +
          'points are not on image structure',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${rich.frames} textured frames, median ${rich.medianCount} features ` +
        `(${rich.minCount}–${rich.maxCount}), gradient ${rich.medianGradient}; contrast ` +
        `${pct(s.medianAboveChance)} above chance over ${s.contrastSamples} samples at ` +
        `level ${s.detectLevel} (${s.detectWidth}x${s.detectHeight})`,
      reason:
        problems.length === 0
          ? 'features were found in useful numbers, and they sit where the image has ' +
            'structure — a rank statistic against seeded-random positions in the same frame, ' +
            'which a set of fabricated coordinates could not clear'
          : problems.join('; '),
      metrics,
    };
  },
};

const FEAT_002: Phase3Test = {
  spec: {
    id: 'FEAT-002',
    title: 'Texture-poor wall',
    required: true,
    input: 'the camera on a blank surface; frames the worker classified TEXTURE_POOR',
    expected: 'the feature count falls, the engine says so, and nothing is invented',
    passCriteria: `>= ${MIN_SCENE_FRAMES} texture-poor frames; median count there at most ${pct(POOR_COUNT_FRACTION)} of the textured median and no frame reaching ${FEATURE_TARGET}; LOW FEATURE COUNT reported where the count fell below ${FEATURE_MIN}; the reported state never disagrees with the reported count`,
    failureCondition: 'the count holding near target on a blank wall — a detector whose output does not depend on the image',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const poor = s.texturePoor;
    const rich = s.textureRich;
    const metrics: Record<string, JsonValue> = {
      poorFrames: poor.frames,
      poorMedianCount: poor.medianCount,
      poorMaxCount: poor.maxCount,
      poorMedianGradient: poor.medianGradient,
      richMedianCount: rich.medianCount,
      stateFrames: s.stateFrames as unknown as JsonValue,
      stateMismatches: s.stateMismatches,
      gradientHistogram: s.gradientHistogram as unknown as JsonValue,
    };

    if (!ctx.detectionEverRan || s.detections === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'detection has not run',
        reason: 'nothing to judge yet',
        metrics,
      };
    }
    if (poor.frames < MIN_SCENE_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${poor.frames}/${MIN_SCENE_FRAMES} texture-poor frames so far`,
        reason:
          `point the camera at a blank surface for a couple of seconds. A frame counts as ` +
          `poor when its own mean gradient magnitude is at or below ${TEXTURE_POOR_CEILING}. ` +
          'This is the other half of the claim FEAT-001 makes: the points vanish when the ' +
          'structure does',
        metrics,
      };
    }
    if (rich.frames < MIN_SCENE_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${poor.frames} blank frames but only ${rich.frames} textured ones`,
        reason:
          'the comparison needs both: a count that fell means nothing without a count it ' +
          'fell from. Point the camera at something with structure too',
        metrics,
      };
    }

    const problems: string[] = [];
    const ceiling = rich.medianCount * POOR_COUNT_FRACTION;
    if (poor.medianCount > ceiling) {
      problems.push(
        `median count on a blank surface is ${poor.medianCount}, against ${rich.medianCount} ` +
          `on a textured one — it did not fall below the ${Math.round(ceiling)} this test ` +
          'requires, so the output is not tracking the image',
      );
    }
    if (poor.maxCount >= FEATURE_TARGET) {
      problems.push(`a blank frame still reached ${poor.maxCount} features`);
    }
    const lowReported = (s.stateFrames['LOW_FEATURE_COUNT'] ?? 0) + (s.stateFrames['TRACKING_DEGRADED'] ?? 0);
    if (poor.minCount < FEATURE_MIN && lowReported === 0) {
      problems.push(
        `the count fell to ${poor.minCount} and the engine never reported LOW FEATURE COUNT ` +
          '(§57)',
      );
    }
    if (s.stateMismatches > 0) {
      problems.push(
        `${s.stateMismatches} frame(s) reported a state that disagreed with their own count ` +
          '— the UI and the engine may not diverge (Rule 002)',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `blank: ${poor.frames} frames, median ${poor.medianCount} features at gradient ` +
        `${poor.medianGradient}; textured: median ${rich.medianCount} at ` +
        `${rich.medianGradient}; states ${JSON.stringify(s.stateFrames)}`,
      reason:
        problems.length === 0
          ? 'the population collapsed when the structure did, and the engine reported it ' +
            'rather than holding a number up. FEAT-001 shows the points are on structure; ' +
            'this shows they disappear without it'
          : problems.join('; '),
      metrics,
    };
  },
};

const FEAT_003: Phase3Test = {
  spec: {
    id: 'FEAT-003',
    title: 'Feature grid distribution',
    required: true,
    input: `the ${GRID_COLS}x${GRID_ROWS} quota selector, and an ungridded control run on the same frames`,
    expected: 'the grid demonstrably prevents the clumping §11 asks it to prevent',
    passCriteria: `no cell ever above its quota; over >= ${MIN_GRID_SAMPLES} paired samples in which the quota actually bound, the gridded selection's largest single-cell share is lower than the ungridded control's in the median case, and it occupies at least as many cells`,
    failureCondition: 'any cell over quota; a grid that does not measurably reduce clustering against its own control',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const g = s.grid;
    const metrics: Record<string, JsonValue> = {
      bindingGridSamples: g.samples,
      totalGridSamples: g.totalSamples,
      medianGriddedMaxCellShare: g.medianGridded,
      medianUngriddedMaxCellShare: g.medianUngridded,
      medianCellGain: g.medianCellGain,
      quotaBreaches: s.quotaBreaches,
      quota: s.quota,
      occupiedCells: s.occupiedCells,
      cells: GRID_COLS * GRID_ROWS,
    };

    if (!ctx.detectionEverRan || s.detections === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'detection has not run',
        reason: 'nothing to judge yet',
        metrics,
      };
    }
    if (g.samples < MIN_GRID_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${g.samples}/${MIN_GRID_SAMPLES} comparisons where the quota bound ` +
          `(${g.totalSamples} taken)`,
        reason:
          g.totalSamples >= MIN_GRID_SAMPLES
            ? 'the comparisons taken so far were on frames too sparse for the quota to bind: ' +
              `no cell came near ${s.quota} features, so the gridded and ungridded selections ` +
              'were the same and say nothing about the grid. Point the camera at a scene with ' +
              'enough corners to crowd a cell'
            : 'the control runs a second selection on the same frame, so it is sampled rather ' +
              'than run every frame; keep detecting',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.quotaBreaches > 0) {
      problems.push(`${s.quotaBreaches} frame(s) held a cell above the quota of ${s.quota}`);
    }
    if (g.medianGridded >= g.medianUngridded) {
      problems.push(
        `the grid did not reduce clustering: largest cell share ${pct(g.medianGridded)} with ` +
          `it against ${pct(g.medianUngridded)} without, on the same frames`,
      );
    }
    if (g.medianCellGain < 0) {
      problems.push(
        `the gridded selection occupied ${-g.medianCellGain} fewer cells than the control`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${g.samples} binding of ${g.totalSamples} paired samples: largest cell share ` +
        `${pct(g.medianGridded)} gridded ` +
        `against ${pct(g.medianUngridded)} ungridded, ${g.medianCellGain >= 0 ? '+' : ''}` +
        `${g.medianCellGain} cells occupied; ${s.quotaBreaches} quota breach(es)`,
      reason:
        problems.length === 0
          ? `the ${GRID_COLS}x${GRID_ROWS} quota held on every frame and measurably spread ` +
            'the selection against an ungridded control on the same images — a scene that ' +
            'would have been evenly distributed anyway produces no difference and no pass'
          : problems.join('; '),
      metrics,
    };
  },
};

const FEAT_004: Phase3Test = {
  spec: {
    id: 'FEAT-004',
    title: 'Feature regeneration',
    required: true,
    input: `the population as the scene changes; §11's thresholds at ${REFILL_BELOW}, ${EMERGENCY_BELOW} and ${DEGRADED_BELOW}`,
    expected: 'the population is topped up when it falls, at the levels §11 names, with the state to match',
    passCriteria: `at least one refill triggered below ${REFILL_BELOW} with counts recorded either side; every refill either raised the count or recorded the frame's candidates as exhausted; every threshold crossing that occurred carries the state it produced; the count never exceeded ${FEATURE_MAX} after a refill`,
    failureCondition: 'a threshold crossed with no response; a refill that raised nothing where candidates existed; a count above the maximum',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const refills = s.refills;
    const ineffective = refills.filter((r) => r.countAfter <= r.countBefore && !r.exhausted);
    const metrics: Record<string, JsonValue> = {
      refillCount: refills.length,
      refills: refills.slice(-20) as unknown as JsonValue,
      ineffectiveRefills: ineffective.length,
      emergencyRefills: refills.filter((r) => r.urgency === 'EMERGENCY').length,
      degradedFrames: s.stateFrames['TRACKING_DEGRADED'] ?? 0,
      lowFrames: s.stateFrames['LOW_FEATURE_COUNT'] ?? 0,
      overMaxFrames: s.overMaxFrames,
      maxCountSeen: s.maxCountSeen,
    };

    if (!ctx.detectionEverRan || s.detections === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'detection has not run',
        reason: 'nothing to judge yet',
        metrics,
      };
    }
    if (refills.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.detections} detections, none below the ${REFILL_BELOW} refill threshold`,
        reason:
          'the population never fell far enough to need topping up, which is the mechanism ' +
          'not being exercised rather than failing. Pointing the camera at a blank surface ' +
          'and back does it — the same movement FEAT-002 needs',
        metrics,
      };
    }

    const problems: string[] = [];
    if (ineffective.length > 0) {
      const worst = ineffective[0];
      problems.push(
        `${ineffective.length} refill(s) raised nothing on a frame that still had candidates ` +
          `(e.g. ${worst?.countBefore} → ${worst?.countAfter} with ` +
          `${worst?.candidatesAfter} candidates available)`,
      );
    }
    if (s.overMaxFrames > 0) {
      problems.push(`${s.overMaxFrames} frame(s) exceeded the ${FEATURE_MAX} maximum`);
    }
    const emergencies = refills.filter((r) => r.urgency === 'EMERGENCY');
    for (const r of emergencies) {
      if (r.countBefore >= EMERGENCY_BELOW) {
        problems.push(
          `an emergency refill was recorded at ${r.countBefore} features, above the ` +
            `${EMERGENCY_BELOW} that defines one`,
        );
        break;
      }
    }
    const exhausted = refills.filter((r) => r.exhausted).length;
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${refills.length} refill(s), ${emergencies.length} of them emergency; ` +
        `${exhausted} found the frame exhausted; ` +
        `${s.stateFrames['LOW_FEATURE_COUNT'] ?? 0} frames LOW, ` +
        `${s.stateFrames['TRACKING_DEGRADED'] ?? 0} DEGRADED`,
      reason:
        problems.length === 0
          ? "the ladder ran at §11's levels and every refill either recovered features or " +
            'recorded that the frame had none left to give — which is a scene with nothing ' +
            'in it, not a mechanism that failed'
          : problems.join('; '),
      metrics,
    };
  },
};

const FEAT_005: Phase3Test = {
  spec: {
    id: 'FEAT-005',
    title: 'Detection cost',
    required: false,
    input: 'the measured cost of each detection, and the one-off level-0 calibration',
    expected: 'detection fits §H’s budget, and the level chosen for it is answerable by measurement',
    passCriteria: `mean detection cost <= ${DETECT_BUDGET_MS} ms over >= ${MIN_DETECTIONS_FOR_COST} detections`,
    failureCondition: 'over budget. Advisory because §34 ranks correctness above performance',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const cal = s.level0Calibration;
    const metrics: Record<string, JsonValue> = {
      detections: s.detections,
      meanDetectCostMs: s.meanDetectCostMs,
      budgetMs: DETECT_BUDGET_MS,
      detectLevel: s.detectLevel,
      detectSize: `${s.detectWidth}x${s.detectHeight}`,
      level0Calibration: cal as unknown as JsonValue,
      // The question the calibration exists to answer, computed rather than left to a reader.
      level0WouldHaveFitBudget: cal ? cal.detectMs <= DETECT_BUDGET_MS : null,
    };
    if (s.detections < MIN_DETECTIONS_FOR_COST) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.detections}/${MIN_DETECTIONS_FOR_COST} detections measured`,
        reason: 'a mean over a handful of frames says nothing; keep detecting',
        metrics,
      };
    }
    const problems: string[] = [];
    if (s.meanDetectCostMs > DETECT_BUDGET_MS) {
      problems.push(
        `mean ${s.meanDetectCostMs} ms exceeds the ${DETECT_BUDGET_MS} ms §H budgets for ` +
          'Shi-Tomasi',
      );
    }
    const calText = cal
      ? `level 0 (${cal.width}x${cal.height}) would have cost ${cal.detectMs} ms for ` +
        `${cal.features} features`
      : 'level-0 calibration not recorded';
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.meanDetectCostMs} ms mean at level ${s.detectLevel} ` +
        `(${s.detectWidth}x${s.detectHeight}) over ${s.detections} detections; ${calText}`,
      reason:
        problems.length === 0
          ? 'detection fits its budget at the level chosen, and the calibration says what ' +
            'the alternative would have cost rather than leaving the choice on an estimate'
          : problems.join('; '),
      metrics,
    };
  },
};

const FEAT_006: Phase3Test = {
  spec: {
    id: 'FEAT-006',
    title: 'Metadata honesty',
    required: false,
    input: 'the §11 feature records themselves',
    expected: 'every field §11 lists is present, and the fields Phase 3 cannot know are null',
    passCriteria: 'all eight §11 fields present; forwardBackwardError and reprojectionError null on every record; ids unique and positions inside the frame; cornerStrength and qualityScore finite',
    failureCondition: 'any of the above unmet — in particular a zero where a measurement does not exist yet',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const samples = s.recordSamples;
    const metrics: Record<string, JsonValue> = {
      sampledRecords: samples.length,
      records: samples.slice(0, 8) as unknown as JsonValue,
    };
    if (samples.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no feature records sampled yet',
        reason: 'detection has produced no features to inspect',
        metrics,
      };
    }
    const problems: string[] = [];
    const ids = new Set<number>();
    for (const f of samples) {
      const missing = (
        ['id', 'x', 'y', 'cornerStrength', 'age', 'trackLength', 'qualityScore'] as const
      ).filter((k) => !Number.isFinite(f[k]));
      if (missing.length > 0) problems.push(`record ${f.id} is missing ${missing.join(', ')}`);
      if (f.forwardBackwardError !== null) {
        problems.push(
          `record ${f.id} carries forwardBackwardError ${f.forwardBackwardError} — Phase 4 ` +
            'has not run, so any value there is invented (§80)',
        );
      }
      if (f.reprojectionError !== null) {
        problems.push(
          `record ${f.id} carries reprojectionError ${f.reprojectionError} — Phase 6 has not ` +
            'run',
        );
      }
      if (ids.has(f.id)) problems.push(`duplicate feature id ${f.id}`);
      ids.add(f.id);
      if (s.detectWidth > 0 && (f.x < 0 || f.x >= s.detectWidth || f.y < 0 || f.y >= s.detectHeight)) {
        problems.push(`record ${f.id} at ${f.x},${f.y} is outside the ${s.detectWidth}x${s.detectHeight} frame`);
      }
      if (!(f.qualityScore >= 0 && f.qualityScore <= 1)) {
        problems.push(`record ${f.id} has qualityScore ${f.qualityScore} outside [0,1]`);
      }
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${samples.length} records inspected; forwardBackwardError and reprojectionError ` +
        'null throughout, ids unique, positions inside the frame',
      reason:
        problems.length === 0
          ? 'the record carries what §11 asks for and nothing it cannot know. The two error ' +
            'terms are null rather than zero, because for an error term zero is the best ' +
            'possible value and claiming it unmeasured would be a fabricated confidence'
          : problems.slice(0, 5).join('; '),
      metrics,
    };
  },
};

export const PHASE3_TESTS: readonly Phase3Test[] = [
  FEAT_001, FEAT_002, FEAT_003, FEAT_004, FEAT_005, FEAT_006,
];

export const PHASE3_SPECS: readonly TestSpec[] = PHASE3_TESTS.map((t) => t.spec);

export function runPhase3Tests(ctx: Phase3Context): TestResult[] {
  return runTests(PHASE3_TESTS, ctx);
}
