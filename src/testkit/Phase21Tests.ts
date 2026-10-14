/**
 * Phase 21 test suite — AUDIT-001..AUDIT-003 (v4 §45, §53, §59, §60).
 *
 * Specs transcribed from `docs/phase21/TEST-PLAN.md`.
 *
 * The final audit has two halves and only one of them can run on a phone. The **repository** half
 * — no `Math.random` in `src/`, the layer graph, every committed bundle re-deriving its own verdict
 * — runs in `npm test` on every commit (`scripts/audit-*.mjs`, `committedEvidence.test.ts`). This
 * suite is the **session** half: did every phase pass, did every runtime invariant stay clean over
 * the whole session, and does the device report the platform's absences as absences.
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

type T = PhaseTest<SpatialContext>;

const AUDIT_001: T = {
  spec: {
    id: 'AUDIT-001',
    title: 'Every phase passed',
    required: true,
    input: 'the Phase Lock registry',
    expected: 'Phases 0–20 PASSED, in this session or carried from an earlier load of this build',
    passCriteria: 'every phase 0–20 PASSED or carried; none FAILED',
    failureCondition: 'any phase FAILED, or any not reached',
  },
  evaluate: (ctx) => {
    const carried = new Set(ctx.carried);
    const failed = ctx.phases.filter((p) => p.index <= 20 && p.state === 'FAILED').map((p) => p.index);
    const open = ctx.phases.filter((p) => p.index <= 20 && p.state !== 'PASSED' && !carried.has(p.index)).map((p) => `${p.index}:${p.state}`);
    const metrics: Record<string, JsonValue> = { failed, open, carried: [...carried] };
    if (failed.length > 0) return judged([`phase(s) ${failed.join(', ')} FAILED`], `failed: ${failed.join(', ')}`, '', metrics);
    if (open.length > 0) return pending(`not yet passed: ${open.join(', ')}`, 'every phase must pass on the device first (Rule 005)', metrics);
    return judged([], 'Phases 0–20 PASSED or carried', 'the whole chain stands', metrics);
  },
};

const AUDIT_002: T = {
  spec: {
    id: 'AUDIT-002',
    title: 'Runtime invariants clean for the whole session',
    required: true,
    input: 'every counter the session kept of a thing that must never happen',
    expected: 'all zero',
    passCriteria: 'integrity issues, READY violations, illegal transitions, replay mismatches, collision violations, UI mismatches, untraced contacts, draw violations: all 0',
    failureCondition: 'any one non-zero (§6 Stop Condition)',
  },
  evaluate: (ctx) => {
    const counters: Record<string, number> = {
      integrityIssues: ctx.world.integrityIssues,
      readyViolations: ctx.world.readyViolations,
      illegalTransitions: ctx.game.illegalTransitions,
      replayMismatches: ctx.game.replayMismatches,
      collisionViolations: ctx.collisionViolations,
      stateMismatches: ctx.render.stateMismatches,
      trackingMismatches: ctx.render.trackingMismatches,
      untracedContacts: ctx.game.untracedContacts,
      drawViolations: ctx.render.drawViolations,
      energyViolations: ctx.game.energyViolations,
      stepsWhileFrozen: ctx.game.stepsWhileFrozen,
    };
    const metrics: Record<string, JsonValue> = { ...counters };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (ctx.game.throwCount === 0) return pending('no throw yet', 'the audit covers a session that has played', metrics);
    const bad = Object.entries(counters).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`);
    return judged(bad, JSON.stringify(counters), 'no invariant was broken at any point in the session', metrics);
  },
};

const AUDIT_003: T = {
  spec: {
    id: 'AUDIT-003',
    title: 'Absences reported as absences',
    required: true,
    input: 'the capability matrix’s spatial records and the world’s scale',
    expected: 'depth, ARKit and RoomPlan UNAVAILABLE; metric scale UNKNOWN; the world in LOCAL_UNITS',
    passCriteria: 'all five as stated',
    failureCondition: 'any of them claimed (Rule 001, §45)',
  },
  evaluate: (ctx) => {
    const c = ctx.capabilities;
    const metrics: Record<string, JsonValue> = { ...c, scale: ctx.view.scale };
    const problems: string[] = [];
    if (c['spatial.cameraDepth'] === 'AVAILABLE') problems.push('camera depth claimed');
    if (c['spatial.arkit'] === 'AVAILABLE') problems.push('ARKit claimed');
    if (c['spatial.roomplan'] === 'AVAILABLE') problems.push('RoomPlan claimed');
    if (c['spatial.metricScale'] === 'AVAILABLE') problems.push('metric scale claimed');
    if (ctx.view.scale !== 'LOCAL_UNITS') problems.push(`world scale ${ctx.view.scale}`);
    if (Object.keys(c).length === 0) return pending('no capability matrix', 'Phase 0 has not run', metrics);
    return judged(problems, JSON.stringify(metrics), 'nothing the platform cannot provide is claimed', metrics);
  },
};

const PHASE21_TESTS: readonly T[] = [AUDIT_001, AUDIT_002, AUDIT_003];
export const PHASE21_SPECS: readonly TestSpec[] = PHASE21_TESTS.map((t) => t.spec);
export function runPhase21Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE21_TESTS, ctx);
}
