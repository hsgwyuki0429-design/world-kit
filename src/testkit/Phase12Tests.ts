/**
 * Phase 12 test suite — WORLD-001..WORLD-007 (v4 §1.2, §16, §25).
 *
 * Specs transcribed from `docs/phase12/TEST-PLAN.md`.
 *
 * **The claim.** A world can be made to look right by serving the keyframe pose for every frame,
 * or by setting READY when a timer runs out. The suite asks for a per-frame pose that predicts
 * landmarks it was not solved from (WORLD-002), that agrees with the map's own registration of a
 * keyframe (WORLD-003), and for READY to hold only while its four conditions do — checked from
 * outside the world on every frame (WORLD-004).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import {
  MAX_HELD_OUT_PX,
  MAX_LOCALIZATION_MEDIAN_PX,
} from '../tracking/LocalizationStage';
import { MAX_LANDMARKS } from '../mapping/landmarks';
import { MAX_POSE_HISTORY } from '../world/SpatialWorld';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const MIN_LOCALIZED_FRAMES = 60;
export const MIN_HELD_OUT = 10;
export const MIN_AGREEMENTS = 5;
export const MAX_AGREEMENT_DEG = 2;
export const MAX_AGREEMENT_CENTER = 0.05;
export const MIN_READY_FRAMES = 30;
export const LOCALIZATION_BUDGET_MS = 6;

type T = PhaseTest<SpatialContext>;

const WORLD_001: T = {
  spec: {
    id: 'WORLD-001',
    title: 'Every frame placed in the world',
    required: true,
    input: 'the tracker’s population each frame against the landmark map, by feature id',
    expected: 'a pose per frame whose reprojection error is inside v3 §33’s band',
    passCriteria: `>= ${MIN_LOCALIZED_FRAMES} localized frames; median reprojection error <= ${MAX_LOCALIZATION_MEDIAN_PX} px`,
    failureCondition: 'a median outside the band, or no frame localized',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { reports: w.reports, localized: w.localized, byState: w.byState, medianErrorPx: w.medianErrorPx };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.localized < MIN_LOCALIZED_FRAMES) {
      return pending(`${w.localized}/${MIN_LOCALIZED_FRAMES} frames localized (${JSON.stringify(w.byState)})`, 'the map needs a few keyframes before a frame can be placed in it', metrics);
    }
    return judged(
      w.medianErrorPx > MAX_LOCALIZATION_MEDIAN_PX ? [`median ${w.medianErrorPx} px past ${MAX_LOCALIZATION_MEDIAN_PX} px`] : [],
      `${w.localized}/${w.reports} frames localized, median ${w.medianErrorPx} px (${JSON.stringify(w.byState)})`,
      'each frame’s camera is placed against the map with a reprojection error inside the band',
      metrics,
    );
  },
};

const WORLD_002: T = {
  spec: {
    id: 'WORLD-002',
    title: 'Held-out prediction',
    required: true,
    input: 'the pose re-solved on half the landmark ids, projecting the other half',
    expected: 'the held-out half lands where the tracker sees it',
    passCriteria: `>= ${MIN_HELD_OUT} held-out measurements; median <= ${MAX_HELD_OUT_PX} px`,
    failureCondition: 'a pose that fits what it was solved from and predicts nothing else',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { samples: w.heldOutSamples, median: w.medianHeldOutPx, worst: w.worstHeldOutPx };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.heldOutSamples < MIN_HELD_OUT) return pending(`${w.heldOutSamples}/${MIN_HELD_OUT} held-out measurements`, 'one is taken every fifth localized frame', metrics);
    return judged(
      w.medianHeldOutPx > MAX_HELD_OUT_PX ? [`held-out median ${w.medianHeldOutPx} px past ${MAX_HELD_OUT_PX} px`] : [],
      `held-out median ${w.medianHeldOutPx} px (worst ${w.worstHeldOutPx} px) over ${w.heldOutSamples} measurements`,
      'the pose predicts landmarks it was not solved from',
      metrics,
    );
  },
};

const WORLD_003: T = {
  spec: {
    id: 'WORLD-003',
    title: 'Agrees with the map’s own registration',
    required: true,
    input: 'on frames where the map registered a keyframe, that registration’s pose beside this frame’s solved pose',
    expected: 'two independent routes to the same camera agree',
    passCriteria: `>= ${MIN_AGREEMENTS} comparisons; median rotation <= ${MAX_AGREEMENT_DEG}°; median centre <= ${MAX_AGREEMENT_CENTER} of a depth`,
    failureCondition: 'a frame pose that disagrees with the keyframe pose the map computed for the same view',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { samples: w.agreementSamples, rotationDeg: w.medianAgreementDeg, center: w.medianAgreementCenter };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.agreementSamples < MIN_AGREEMENTS) return pending(`${w.agreementSamples}/${MIN_AGREEMENTS} comparisons`, 'one is made each time the map registers a keyframe', metrics);
    const problems: string[] = [];
    if (w.medianAgreementDeg > MAX_AGREEMENT_DEG) problems.push(`rotation ${w.medianAgreementDeg}° past ${MAX_AGREEMENT_DEG}°`);
    if (w.medianAgreementCenter > MAX_AGREEMENT_CENTER) problems.push(`centre ${w.medianAgreementCenter} past ${MAX_AGREEMENT_CENTER}`);
    return judged(problems, `median ${w.medianAgreementDeg}° and ${w.medianAgreementCenter} of a depth over ${w.agreementSamples} keyframes`, 'the frame pose and the map registration agree', metrics);
  },
};

const WORLD_004: T = {
  spec: {
    id: 'WORLD-004',
    title: 'READY only while it is true',
    required: true,
    input: 'the world’s state each frame, checked from outside against its four conditions',
    expected: 'READY reached, and never held while tracking, gravity, ground or pose was missing',
    passCriteria: `>= ${MIN_READY_FRAMES} READY frames; 0 frames READY with a condition false`,
    failureCondition: 'WORLD READY without the data behind it (Rule 002)',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { readyFrames: w.readyFrames, violations: w.readyViolations, detail: w.readyViolationDetail, reasons: [...ctx.view.worldReasons] };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.readyViolations > 0) return judged([`${w.readyViolations} frame(s) READY with ${w.readyViolationDetail}`], `${w.readyFrames} READY frames`, '', metrics);
    if (w.readyFrames < MIN_READY_FRAMES) {
      return pending(`${w.readyFrames}/${MIN_READY_FRAMES} READY frames; waiting on: ${ctx.view.worldReasons.join(' | ') || 'nothing'}`, 'READY needs tracking, gravity and a ground', metrics);
    }
    return judged([], `${w.readyFrames} READY frames, 0 violations`, 'READY was a conjunction of measurements on every frame it was claimed', metrics);
  },
};

const WORLD_005: T = {
  spec: {
    id: 'WORLD-005',
    title: 'Integrity and bounds',
    required: true,
    input: 'every ingest into the world, and its bounded structures',
    expected: 'nothing non-finite admitted; history and landmarks within their bounds; coverage moving only with the map',
    passCriteria: `0 integrity issues; history <= ${MAX_POSE_HISTORY}; landmarks <= ${MAX_LANDMARKS}; 0 coverage changes without a map change; every §25 field present`,
    failureCondition: 'a NaN in the source of truth, an unbounded structure, or coverage that grows with time',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const v = ctx.view;
    const metrics: Record<string, JsonValue> = {
      integrityIssues: w.integrityIssues, maxHistory: w.maxHistory, maxLandmarks: w.maxLandmarks,
      coverageWithoutMap: w.coverageWithoutMap, coverage: v.coverage,
    };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.snapshots === 0) return pending('no map snapshot yet', 'the map ships when it changes', metrics);
    const problems: string[] = [];
    if (w.integrityIssues > 0) problems.push(`${w.integrityIssues} non-finite ingest(s)`);
    if (w.maxHistory > MAX_POSE_HISTORY) problems.push(`history reached ${w.maxHistory}`);
    if (w.maxLandmarks > MAX_LANDMARKS) problems.push(`landmarks reached ${w.maxLandmarks}`);
    if (w.coverageWithoutMap > 0) problems.push(`coverage changed ${w.coverageWithoutMap} time(s) without a map change`);
    const fields = ['origin', 'cameraPose', 'surfaces', 'landmarks', 'trackingState', 'mappingState', 'confidence', 'lastUpdated'];
    const missing = fields.filter((f) => !(f in v));
    if (missing.length > 0) problems.push(`§25 field(s) missing: ${missing.join(', ')}`);
    return judged(problems, `${w.snapshots} snapshots; history max ${w.maxHistory}; landmarks max ${w.maxLandmarks}; coverage ${v.coverage}`, 'the world stayed finite, bounded and time-independent', metrics);
  },
};

const WORLD_006: T = {
  spec: {
    id: 'WORLD-006',
    title: 'Localization cost',
    required: false,
    input: 'worker time per localized frame',
    expected: 'small beside the rest of the frame budget',
    passCriteria: `median <= ${LOCALIZATION_BUDGET_MS} ms`,
    failureCondition: 'a median past the budget',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { medianMs: w.medianLocalizationMs };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.localized < 10) return pending(`${w.localized}/10 localized frames`, 'needs frames to time', metrics);
    return judged(w.medianLocalizationMs > LOCALIZATION_BUDGET_MS ? [`median ${w.medianLocalizationMs} ms`] : [], `median ${w.medianLocalizationMs} ms`, 'within budget', metrics);
  },
};

const WORLD_007: T = {
  spec: {
    id: 'WORLD-007',
    title: 'One epoch at a time',
    required: false,
    input: 'the surfaces in the current view, against the landmarks of the current view',
    expected: 'no surface left over from a world that was redefined',
    passCriteria: 'every surface’s landmarks are in the current map',
    failureCondition: 'a surface from an earlier epoch served in this one’s coordinates',
  },
  evaluate: (ctx) => {
    const ids = new Set(ctx.view.landmarks.map((l) => l.id));
    const stale = ctx.view.surfaces.filter((s) => s.landmarkIds.some((id) => !ids.has(id))).length;
    const metrics: Record<string, JsonValue> = { epoch: ctx.view.epoch, epochChanges: ctx.world.epochChanges, stale };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    return judged(stale > 0 ? [`${stale} surface(s) rest on landmarks this map does not hold`] : [], `epoch ${ctx.view.epoch}, ${ctx.world.epochChanges} redefinition(s), ${stale} stale surface(s)`, 'everything served belongs to the current epoch', metrics);
  },
};

const PHASE12_TESTS: readonly T[] = [WORLD_001, WORLD_002, WORLD_003, WORLD_004, WORLD_005, WORLD_006, WORLD_007];
export const PHASE12_SPECS: readonly TestSpec[] = PHASE12_TESTS.map((t) => t.spec);
export function runPhase12Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE12_TESTS, ctx);
}
