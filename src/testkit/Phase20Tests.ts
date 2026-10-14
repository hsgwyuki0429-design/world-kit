/**
 * Phase 20 test suite — PLAY-001..PLAY-003 (v4 §51, §52, §53).
 *
 * Specs transcribed from `docs/phase20/TEST-PLAN.md`.
 *
 * **The claim.** §52's golden test is a sequence, and §53 is a list of conditions under it. Both
 * are read off the session's own record: the transitions must contain the chain in order
 * (PLAY-001), every condition in §53 must hold — including that Phases 11–19 passed in this
 * session — (PLAY-002), and the success must have depended on the generated goal: the same throw
 * at a ring moved off its axis does not score (PLAY-003).
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

type T = PhaseTest<SpatialContext>;

/** §52, as states. */
export const GOLDEN_CHAIN = ['STAGE_GENERATING', 'READY', 'AIMING', 'THROWING', 'SUCCESS'] as const;

const PLAY_001: T = {
  spec: {
    id: 'PLAY-001',
    title: 'The golden sequence, in order',
    required: true,
    input: 'the game’s transition record',
    expected: 'scan → stage generation → ready → aim → throw → success, in that order',
    passCriteria: 'the chain appears as a contiguous run of transitions, preceded by SCAN or SPATIALIZING',
    failureCondition: 'success reached by any other route',
  },
  evaluate: (ctx) => {
    const t = ctx.game.transitions;
    const states = t.map((x) => x.to);
    let found = -1;
    for (let i = 0; i + GOLDEN_CHAIN.length <= states.length; i++) {
      if (GOLDEN_CHAIN.every((s, k) => states[i + k] === s)) {
        found = i;
        break;
      }
    }
    const scanned = ctx.game.visited.includes('SCAN') || ctx.game.visited.includes('SPATIALIZING');
    const metrics: Record<string, JsonValue> = { found, transitions: states.length, scanned };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (found < 0) return pending('the full chain has not been played yet', 'score a goal on a freshly generated stage', metrics);
    return judged(scanned ? [] : ['the session never scanned'], `the chain begins at transition ${found}`, 'the golden gameplay sequence was played in order', metrics);
  },
};

const PLAY_002: T = {
  spec: {
    id: 'PLAY-002',
    title: '§53, every condition',
    required: true,
    input: 'this session’s results for Phases 11–19, the world, the throws and the collision record',
    expected: 'camera, tracking, real surfaces, a stage from the current world, a valid goal, a ball that touched the room, success through the goal, no fixed collision',
    passCriteria: 'every required record of Phases 11–19 PASS in this session; ≥ 1 goal; ≥ 1 throw with a contact; 0 collision violations',
    failureCondition: 'any one missing',
  },
  evaluate: (ctx) => {
    const missing: string[] = [];
    const pendingPhases: string[] = [];
    for (let p = 11; p <= 19; p++) {
      const results = ctx.results.get(p) ?? [];
      const required = results.filter((r) => r.spec.required);
      if (required.length === 0) pendingPhases.push(`${p}: not run`);
      for (const r of required) {
        if (r.verdict === Verdict.FAIL) missing.push(`${r.spec.id} FAIL`);
        else if (r.verdict === Verdict.PENDING) pendingPhases.push(r.spec.id);
      }
    }
    const goals = ctx.game.throws.filter((x) => x.outcome === 'GOAL').length;
    const contacts = ctx.game.throws.filter((x) => x.contacts.length > 0).length;
    const metrics: Record<string, JsonValue> = { failing: missing, pending: pendingPhases, goals, contacts, collisionViolations: ctx.collisionViolations };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (missing.length > 0 || ctx.collisionViolations > 0) {
      return judged([...missing, ...(ctx.collisionViolations > 0 ? [`${ctx.collisionViolations} collision violation(s)`] : [])], `${goals} goal(s), ${contacts} throw(s) with contacts`, '', metrics);
    }
    if (pendingPhases.length > 0 || goals === 0 || contacts === 0) {
      return pending(
        `still pending: ${[...pendingPhases.slice(0, 8), ...(goals === 0 ? ['a goal'] : []), ...(contacts === 0 ? ['a bounce'] : [])].join(', ')}`,
        'every earlier phase’s records must pass in this session, and the ball must have both scored and touched the room',
        metrics,
      );
    }
    return judged([], `Phases 11–19 PASS; ${goals} goal(s); ${contacts} throw(s) touched the room`, 'every §53 condition held in one session', metrics);
  },
};

const PLAY_003: T = {
  spec: {
    id: 'PLAY-003',
    title: 'Success depended on the goal',
    required: true,
    input: 'every scoring throw re-flown at the same ring moved two and a half radii off its axis',
    expected: 'the moved ring is missed',
    passCriteria: '>= 1 scoring throw; 0 controls that still score',
    failureCondition: 'a success that did not depend on where the goal was (§53)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { controls: g.goalControls, failures: g.goalControlFailures };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.goalControls === 0) return pending('no goal yet', 'score once', metrics);
    return judged(g.goalControlFailures > 0 ? [`${g.goalControlFailures} control(s) still scored`] : [], `${g.goalControls} goal(s) checked, ${g.goalControlFailures} independent of the ring`, 'every success depended on entering the generated goal', metrics);
  },
};

const PHASE20_TESTS: readonly T[] = [PLAY_001, PLAY_002, PLAY_003];
export const PHASE20_SPECS: readonly TestSpec[] = PHASE20_TESTS.map((t) => t.spec);
export function runPhase20Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE20_TESTS, ctx);
}
