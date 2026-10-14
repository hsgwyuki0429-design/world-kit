/**
 * Phase 11 test suite — SURF-001..SURF-009 (v4 §23, §24).
 *
 * Specs transcribed from `docs/phase11/TEST-PLAN.md`, written before `src/mapping/surfaces.ts`.
 *
 * **The claim.** A plane detector can be made to report planes from anything: lower the support,
 * widen the band, and a cloud of noise yields a floor. So the suite asks three things a detector
 * that invents surfaces cannot do: find the same surface again next time (SURF-003), find far less
 * in the same landmarks jittered off their planes (SURF-004), and classify nothing until gravity
 * has been measured (SURF-005, SURF-006).
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { MAX_SPREAD_DEG, MIN_DIVERSITY_DEG, MIN_GRAVITY_SAMPLES } from '../mapping/gravity';
import { MIN_SURFACE_SUPPORT, PLANE_INLIER_FRACTION } from '../mapping/surfaces';
import { MIN_GROUND_CONFIDENCE } from '../world/SpatialWorld';
import type { PhaseTest } from './runTests';
import { pct, runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const MIN_EXTRACTIONS = 8;
export const MAX_MEDIAN_RESIDUAL = PLANE_INLIER_FRACTION / 2;
export const MIN_PERSISTENCE_OFFERED = 8;
export const MIN_PERSISTENCE = 0.7;
export const MIN_CONTROL_RUNS = 3;
export const MAX_CONTROL_RATIO = 0.3;
export const EXTRACTION_BUDGET_MS = 12;
export const MAX_ACCELERATION_DISAGREEMENT_DEG = 15;

type T = PhaseTest<SpatialContext>;

const SURF_001: T = {
  spec: {
    id: 'SURF-001',
    title: 'Surfaces rest on observed landmarks',
    required: true,
    input: 'every surface extraction over the live landmark map',
    expected: 'surfaces whose every landmark is in the map they were extracted from, and none before a landmark was confirmed',
    passCriteria:
      `>= ${MIN_EXTRACTIONS} extractions; at least one surface of >= ${MIN_SURFACE_SUPPORT} landmarks; ` +
      '0 surfaces naming a landmark the map did not hold; 0 surfaces from a map with no confirmed landmark',
    failureCondition: 'a surface with no landmarks under it, or one that appeared before the map had anything confirmed (Rule 002)',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = {
      extractions: w.extractions, surfaces: w.surfaces, surfacesByClass: w.surfacesByClass,
      provenanceViolations: w.provenanceViolations, surfacesBeforeConfirmed: w.surfacesBeforeConfirmed,
      lastSupport: w.lastSupport, lastCandidates: w.lastCandidates,
    };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.extractions < MIN_EXTRACTIONS) {
      return pending(`${w.extractions}/${MIN_EXTRACTIONS} extractions`, 'surfaces are re-extracted as the map grows — keep looking around', metrics);
    }
    const problems: string[] = [];
    if (w.surfaces === 0) problems.push(`no plane among ${w.lastCandidates} confirmed landmarks has ${MIN_SURFACE_SUPPORT} connected supporters`);
    if (w.provenanceViolations > 0) problems.push(`${w.provenanceViolations} surface(s) named landmarks the map did not hold`);
    if (w.surfacesBeforeConfirmed > 0) problems.push(`${w.surfacesBeforeConfirmed} extraction(s) produced surfaces with no confirmed landmark`);
    return judged(
      problems,
      `${w.surfaces} surface(s) over ${w.lastSupport} of ${w.lastCandidates} confirmed landmarks after ${w.extractions} extractions: ${JSON.stringify(w.surfacesByClass)}`,
      'every surface rests on landmarks the map holds, and none appeared before the map had any',
      metrics,
    );
  },
};

const SURF_002: T = {
  spec: {
    id: 'SURF-002',
    title: 'Planar',
    required: true,
    input: 'the RMS distance of each surface’s landmarks from its plane, relative to the scene depth',
    expected: 'landmarks that lie on their plane far inside the inlier band',
    passCriteria: `median residual <= ${MAX_MEDIAN_RESIDUAL} of a depth (half the ${PLANE_INLIER_FRACTION} band)`,
    failureCondition: 'a median residual that fills the band — the signature of a slice through a cloud, not a surface',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { medianResidual: w.medianResidual, ceiling: MAX_MEDIAN_RESIDUAL };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.surfaces === 0 || w.medianResidual < 0) return pending('no surface yet', 'needs a surface to measure', metrics);
    return judged(
      w.medianResidual > MAX_MEDIAN_RESIDUAL ? [`median residual ${w.medianResidual} past ${MAX_MEDIAN_RESIDUAL}`] : [],
      `median residual ${w.medianResidual} of a depth`,
      'the landmarks lie on their planes well inside the band — uniform filling would put the median near 0.58 of it',
      metrics,
    );
  },
};

const SURF_003: T = {
  spec: {
    id: 'SURF-003',
    title: 'Persistent',
    required: true,
    input: 'each extraction’s surfaces against the previous extraction’s',
    expected: 'the same surfaces found again as the map grows, under the same ids',
    passCriteria: `>= ${MIN_PERSISTENCE_OFFERED} surfaces offered for re-finding; >= ${pct(MIN_PERSISTENCE)} found again`,
    failureCondition: 'surfaces that do not survive the next extraction — a detector reporting its own noise',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const rate = w.persistenceOffered > 0 ? w.persistenceFound / w.persistenceOffered : -1;
    const metrics: Record<string, JsonValue> = { offered: w.persistenceOffered, found: w.persistenceFound, rate };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.persistenceOffered < MIN_PERSISTENCE_OFFERED) {
      return pending(`${w.persistenceOffered}/${MIN_PERSISTENCE_OFFERED} surfaces offered`, 'needs several extractions with surfaces in them', metrics);
    }
    return judged(
      rate < MIN_PERSISTENCE ? [`${pct(rate)} found again, below ${pct(MIN_PERSISTENCE)}`] : [],
      `${w.persistenceFound}/${w.persistenceOffered} surfaces found again (${pct(rate)})`,
      'surfaces persist across extractions, as observed structure does and noise does not',
      metrics,
    );
  },
};

const SURF_004: T = {
  spec: {
    id: 'SURF-004',
    title: 'Nothing from structureless points',
    required: true,
    input: 'the same landmarks, each moved ten inlier bands in a seeded direction, through the same extraction',
    expected: 'the control’s largest surface far smaller than the room’s',
    passCriteria: `>= ${MIN_CONTROL_RUNS} control runs; median ratio of largest-surface support <= ${MAX_CONTROL_RATIO}`,
    failureCondition: 'a control that yields surfaces rivalling the real ones — the thresholds are finding planes in anything',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { controlRuns: w.controlRuns, median: w.medianControlRatio, worst: w.worstControlRatio };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.controlRuns < MIN_CONTROL_RUNS) return pending(`${w.controlRuns}/${MIN_CONTROL_RUNS} control runs`, 'the control runs on every fourth extraction', metrics);
    return judged(
      w.medianControlRatio > MAX_CONTROL_RATIO ? [`median ratio ${w.medianControlRatio} past ${MAX_CONTROL_RATIO}`] : [],
      `control's largest surface is ${pct(w.medianControlRatio)} of the room's (worst ${pct(w.worstControlRatio)}) over ${w.controlRuns} runs`,
      'jittering the landmarks off their planes removes the surfaces — they were in the landmarks, not in the thresholds',
      metrics,
    );
  },
};

const SURF_005: T = {
  spec: {
    id: 'SURF-005',
    title: 'Classified only against measured gravity',
    required: true,
    input: 'every classified surface, and the gravity state it was classified under',
    expected: 'no GROUND, WALL, PLATFORM or OBSTACLE while gravity is UNKNOWN; every class consistent with its tilt',
    passCriteria: `>= ${MIN_EXTRACTIONS} extractions; 0 classified-without-gravity; 0 orientation contradictions`,
    failureCondition: 'a floor named before anything measured down (v4 §1.4 PLANE: UNKNOWN)',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { unclassifiedViolations: w.unclassifiedViolations, orientationViolations: w.orientationViolations, extractions: w.extractions };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.extractions < MIN_EXTRACTIONS) return pending(`${w.extractions}/${MIN_EXTRACTIONS} extractions`, 'needs extractions to check', metrics);
    const problems: string[] = [];
    if (w.unclassifiedViolations > 0) problems.push(`${w.unclassifiedViolations} surface(s) classified while gravity was UNKNOWN`);
    if (w.orientationViolations > 0) problems.push(`${w.orientationViolations} class(es) inconsistent with their tilt`);
    return judged(problems, `${w.extractions} extractions; ${w.unclassifiedViolations} + ${w.orientationViolations} violation(s)`, 'nothing was called a floor or a wall before down was measured', metrics);
  },
};

const SURF_006: T = {
  spec: {
    id: 'SURF-006',
    title: 'Down, measured',
    required: true,
    input: 'localized frames paired with the orientation sensor’s down vector',
    expected: 'one image layout under which every frame agrees on down, clearly better than the others',
    passCriteria:
      `>= ${MIN_GRAVITY_SAMPLES} pairings over >= ${MIN_DIVERSITY_DEG}° of viewing direction; best spread <= ${MAX_SPREAD_DEG}°; ` +
      'runner-up at least twice as spread and 2° worse',
    failureCondition: 'a down vector assumed, or chosen from data that could not tell the layouts apart',
  },
  evaluate: (ctx) => {
    const g = ctx.world.gravity;
    const metrics: Record<string, JsonValue> = {
      state: g.state, spreadDeg: g.spreadDeg, runnerUpSpreadDeg: g.runnerUpSpreadDeg, candidateDeg: g.candidateDeg,
      samples: g.samples, diversityDeg: g.diversityDeg, pairings: ctx.world.pairings, refused: ctx.world.pairingsRefused,
      sensor: ctx.gravitySource,
    };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (ctx.gravitySource !== 'LIVE') {
      return pending(`orientation sensor ${ctx.gravitySource}`, ctx.gravityDetail, metrics);
    }
    if (g.state !== 'ESTIMATED') return pending(`gravity UNKNOWN: ${g.reason}`, 'look around — turn and tilt the phone', metrics);
    return {
      verdict: Verdict.PASS,
      observed: `down agreed to ${g.spreadDeg}° under the ${g.candidateDeg}° layout (runner-up ${g.runnerUpSpreadDeg}°) over ${g.samples} frames spanning ${g.diversityDeg}°`,
      reason: 'the pose and the orientation sensor agree on one down direction, and the motion separated the layouts',
      metrics,
    };
  },
};

const SURF_007: T = {
  spec: {
    id: 'SURF-007',
    title: 'A ground to play on',
    required: true,
    input: 'the classified surfaces',
    expected: `a GROUND surface at confidence >= ${MIN_GROUND_CONFIDENCE}`,
    passCriteria: 'at least one GROUND surface at that confidence, with the camera height above it measured',
    failureCondition: 'none — and the game cannot start, which is the correct outcome rather than a fake floor',
  },
  evaluate: (ctx) => {
    const ground = ctx.view.surfaces.filter((s) => s.surfaceClass === 'GROUND');
    const best = ground.reduce((a, s) => Math.max(a, s.confidence), 0);
    const metrics: Record<string, JsonValue> = { grounds: ground.length, best, cameraHeight: ctx.view.cameraHeight };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (ctx.world.gravity.state !== 'ESTIMATED') return pending('gravity UNKNOWN', 'nothing is a floor until down is measured', metrics);
    if (best < MIN_GROUND_CONFIDENCE || !(ctx.view.cameraHeight > 0)) {
      return pending(`${ground.length} GROUND surface(s), best confidence ${best}`, 'point the camera at the floor and move sideways a little', metrics);
    }
    return {
      verdict: Verdict.PASS,
      observed: `${ground.length} GROUND surface(s), best confidence ${best}; camera ${ctx.view.cameraHeight} units above it`,
      reason: 'an observed floor, measured against gravity',
      metrics,
    };
  },
};

const SURF_008: T = {
  spec: {
    id: 'SURF-008',
    title: 'Extraction cost',
    required: false,
    input: 'wall time of each extraction on the main thread',
    expected: 'small enough to run beside the render loop about once a second',
    passCriteria: `median <= ${EXTRACTION_BUDGET_MS} ms`,
    failureCondition: 'a median past the budget',
  },
  evaluate: (ctx) => {
    const w = ctx.world;
    const metrics: Record<string, JsonValue> = { medianMs: w.medianExtractionMs, worstMs: w.worstExtractionMs };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (w.extractions < 3) return pending(`${w.extractions}/3 extractions`, 'needs extractions to time', metrics);
    return judged(
      w.medianExtractionMs > EXTRACTION_BUDGET_MS ? [`median ${w.medianExtractionMs} ms past ${EXTRACTION_BUDGET_MS} ms`] : [],
      `median ${w.medianExtractionMs} ms, worst ${w.worstExtractionMs} ms`,
      'within budget',
      metrics,
    );
  },
};

const SURF_009: T = {
  spec: {
    id: 'SURF-009',
    title: 'The accelerometer agrees with the orientation sensor',
    required: false,
    input: '`accelerationIncludingGravity` near 1 g, against the orientation-derived down, with its sign measured',
    expected: 'agreement within a few degrees, and the sign recorded rather than assumed',
    passCriteria: `>= 30 samples; median disagreement <= ${MAX_ACCELERATION_DISAGREEMENT_DEG}°`,
    failureCondition: 'two gravity sensors on one phone disagreeing about down',
  },
  evaluate: (ctx) => {
    const a = ctx.acceleration;
    const metrics: Record<string, JsonValue> = { sign: a.sign, medianDeg: a.medianDeg, samples: a.samples };
    if (a.samples < 30) return pending(`${a.samples}/30 samples`, 'the accelerometer is read while the phone is near 1 g', metrics);
    return judged(
      a.medianDeg > MAX_ACCELERATION_DISAGREEMENT_DEG ? [`median ${a.medianDeg}° past ${MAX_ACCELERATION_DISAGREEMENT_DEG}°`] : [],
      `median ${a.medianDeg}° with accelerationIncludingGravity pointing ${a.sign > 0 ? 'down' : 'up'}`,
      'the two sensors agree, and the sign convention was measured on this device',
      metrics,
    );
  },
};

const PHASE11_TESTS: readonly T[] = [SURF_001, SURF_002, SURF_003, SURF_004, SURF_005, SURF_006, SURF_007, SURF_008, SURF_009];
export const PHASE11_SPECS: readonly TestSpec[] = PHASE11_TESTS.map((t) => t.spec);
export function runPhase11Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE11_TESTS, ctx);
}
