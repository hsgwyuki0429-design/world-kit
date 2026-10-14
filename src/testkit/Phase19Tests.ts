/**
 * Phase 19 test suite — BALL-001..BALL-004 (v4 §32, §50).
 *
 * Specs transcribed from `docs/phase19/TEST-PLAN.md`.
 *
 * **The claim.** §50 asks for the same flight from the same input; a ball animated along a canned
 * curve satisfies that too. So reproducibility (BALL-001) sits beside energy — no bounce may add
 * any (BALL-002) — and beside units: the ball's size and gravity are in the measured camera
 * height, never in an asserted metre (BALL-003).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const PHYSICS_BUDGET_MS = 4;

type T = PhaseTest<SpatialContext>;

const BALL_001: T = {
  spec: {
    id: 'BALL-001',
    title: 'Deterministic',
    required: true,
    input: 'every throw replayed from its recorded origin, velocity and frozen collision set',
    expected: 'the same flight, step for step',
    passCriteria: '>= 1 throw; 0 replay mismatches',
    failureCondition: 'the same input giving a different flight (§50)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { throws: g.throwCount, mismatches: g.replayMismatches };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.throwCount === 0) return pending('no throw yet', 'throw once', metrics);
    return judged(g.replayMismatches > 0 ? [`${g.replayMismatches} replay mismatch(es)`] : [], `${g.throwCount} throw(s), ${g.replayMismatches} mismatch(es)`, 'every throw replays exactly', metrics);
  },
};

const BALL_002: T = {
  spec: {
    id: 'BALL-002',
    title: 'No bounce adds energy',
    required: true,
    input: 'kinetic plus potential energy at the start and after every contact',
    expected: 'never higher after a contact than before it',
    passCriteria: '>= 1 throw with a contact; 0 violations',
    failureCondition: 'a bounce that gains energy — the integrator, not the room, is moving the ball',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const withContacts = g.throws.filter((t) => t.contacts.length > 0).length;
    const metrics: Record<string, JsonValue> = { withContacts, violations: g.energyViolations };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (withContacts === 0) return pending('no throw has bounced yet', 'throw so the ball hits something', metrics);
    return judged(g.energyViolations > 0 ? [`${g.energyViolations} throw(s) gained energy`] : [], `${withContacts} throw(s) with contacts, ${g.energyViolations} violation(s)`, 'energy only ever left the ball', metrics);
  },
};

const BALL_003: T = {
  spec: {
    id: 'BALL-003',
    title: 'Local units, consistently',
    required: true,
    input: 'the held stage’s unit, the world’s camera height and scale',
    expected: 'the game unit is the measured camera height; the world says LOCAL_UNITS',
    passCriteria: 'unit > 0 and equal to the camera height the stage was made with; scale LOCAL_UNITS',
    failureCondition: 'a metre asserted anywhere (§32, v3 §15)',
  },
  evaluate: (ctx) => {
    const stage = ctx.game.lastStage;
    const metrics: Record<string, JsonValue> = { unit: stage?.unit ?? -1, cameraHeight: ctx.view.cameraHeight, scale: ctx.view.scale };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (!stage) return pending('no stage held', 'needs a stage', metrics);
    const problems: string[] = [];
    if (!(stage.unit > 0)) problems.push('the unit is not positive');
    if (ctx.view.scale !== 'LOCAL_UNITS') problems.push(`scale ${ctx.view.scale}`);
    return judged(problems, `1 game unit = camera height ${stage.unit} world units; scale ${ctx.view.scale}`, 'ball, gravity and throws are all in the measured camera height', metrics);
  },
};

const BALL_004: T = {
  spec: {
    id: 'BALL-004',
    title: 'Physics cost',
    required: false,
    input: 'the worst physics time in any display frame',
    expected: 'small',
    passCriteria: `<= ${PHYSICS_BUDGET_MS} ms`,
    failureCondition: 'past the budget',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { worstMs: g.worstPhysicsMs };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.throwCount === 0) return pending('no throw yet', 'throw once', metrics);
    return judged(g.worstPhysicsMs > PHYSICS_BUDGET_MS ? [`worst ${g.worstPhysicsMs} ms`] : [], `worst ${g.worstPhysicsMs} ms per frame`, 'within budget', metrics);
  },
};

const PHASE19_TESTS: readonly T[] = [BALL_001, BALL_002, BALL_003, BALL_004];
export const PHASE19_SPECS: readonly TestSpec[] = PHASE19_TESTS.map((t) => t.spec);
export function runPhase19Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE19_TESTS, ctx);
}
