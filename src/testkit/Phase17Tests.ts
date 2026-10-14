/**
 * Phase 17 test suite — STAGE-001..STAGE-004 (v4 §27, §35, §48).
 *
 * Specs transcribed from `docs/phase17/TEST-PLAN.md`.
 *
 * **The claim.** A generator can be reproducible by ignoring the room — a template is perfectly
 * reproducible. So reproducibility (STAGE-001) is paired with dependence: the same room moved by
 * half a camera height must give a different stage (STAGE-004). Between them sit "made from this
 * world" (STAGE-002) and "playable", checked by re-flying the stage's own scoring throw (STAGE-003).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

type T = PhaseTest<SpatialContext>;

const STAGE_001: T = {
  spec: {
    id: 'STAGE-001',
    title: 'Reproducible',
    required: true,
    input: 'every stage regenerated immediately from the same world and seed',
    expected: 'the same stage, digest for digest',
    passCriteria: '>= 1 stage; 0 mismatches',
    failureCondition: 'two different stages from one input (§48)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { reproductions: g.reproductions, mismatches: g.reproductionMismatches };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.reproductions === 0) return pending('no stage yet', `waiting on: ${ctx.view.worldReasons.join(' | ') || g.lastGenerationReason}`, metrics);
    return judged(g.reproductionMismatches > 0 ? [`${g.reproductionMismatches} mismatch(es)`] : [], `${g.reproductions} regeneration(s), ${g.reproductionMismatches} mismatch(es)`, 'the same world and seed give the same stage', metrics);
  },
};

const STAGE_002: T = {
  spec: {
    id: 'STAGE-002',
    title: 'Made from this world',
    required: true,
    input: 'the stage held, against the live world',
    expected: 'the stage’s epoch is the world’s, and its ring stands on a surface the world holds',
    passCriteria: '>= 1 stage; epoch matches; support surface present',
    failureCondition: 'a stage from another world, or standing on a surface nobody observed',
  },
  evaluate: (ctx) => {
    const stage = ctx.game.lastStage;
    const metrics: Record<string, JsonValue> = { stages: ctx.game.stagesGenerated, epoch: stage?.epoch ?? -1, worldEpoch: ctx.view.epoch, support: stage?.ring.supportSurfaceId ?? -1 };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (!stage) {
      if (ctx.game.stagesGenerated === 0) return pending('no stage yet', ctx.game.lastGenerationReason || 'the world must be READY', metrics);
      return pending('no stage held right now', 'between stages', metrics);
    }
    const problems: string[] = [];
    if (stage.epoch !== ctx.view.epoch) problems.push(`stage epoch ${stage.epoch}, world epoch ${ctx.view.epoch}`);
    if (!ctx.view.surfaces.some((s) => s.id === stage.ring.supportSurfaceId)) problems.push(`support surface ${stage.ring.supportSurfaceId} not in the world`);
    return judged(problems, `ring on surface ${stage.ring.supportSurfaceId} (${stage.ring.supportClass}) in epoch ${stage.epoch}`, 'the stage stands on the room as it is observed now', metrics);
  },
};

const STAGE_003: T = {
  spec: {
    id: 'STAGE-003',
    title: 'Playable',
    required: true,
    input: 'every stage’s reference throw, re-flown against the collision set of the world it was made from',
    expected: 'it scores',
    passCriteria: '>= 1 check; 0 failures',
    failureCondition: 'a stage shipped with no throw that reaches its goal (§35)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { checks: g.solutionChecks, failures: g.solutionFailures };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.solutionChecks === 0) return pending('no stage yet', 'the check runs on every stage', metrics);
    return judged(g.solutionFailures > 0 ? [`${g.solutionFailures} stage(s) whose own solution misses`] : [], `${g.solutionChecks} stage(s) checked, ${g.solutionFailures} failure(s)`, 'every stage came with a throw that reaches its goal', metrics);
  },
};

const STAGE_004: T = {
  spec: {
    id: 'STAGE-004',
    title: 'Depends on the room',
    required: true,
    input: 'every stage regenerated with every surface and landmark moved half a camera height, the player left in place',
    expected: 'a different stage',
    passCriteria: '>= 1 control; 0 identical',
    failureCondition: 'the same stage whatever the room — a template (§27)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { controls: g.stageControls, failures: g.stageControlFailures, last: g.lastStageControl };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.stageControls === 0) return pending('no stage yet', 'the control runs on every stage', metrics);
    return judged(g.stageControlFailures > 0 ? [`${g.stageControlFailures} control(s) gave the same stage`] : [], `${g.stageControls} control(s); ${g.lastStageControl}`, 'moving the room moves the stage', metrics);
  },
};

const PHASE17_TESTS: readonly T[] = [STAGE_001, STAGE_002, STAGE_003, STAGE_004];
export const PHASE17_SPECS: readonly TestSpec[] = PHASE17_TESTS.map((t) => t.spec);
export function runPhase17Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE17_TESTS, ctx);
}
