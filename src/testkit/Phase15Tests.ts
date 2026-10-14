/**
 * Phase 15 test suite — COL-001..COL-004 (v4 §33).
 *
 * Specs transcribed from `docs/phase15/TEST-PLAN.md`.
 *
 * **The claim.** "The ball bounced" proves nothing about where the wall came from. The suite asks
 * that every surface a ball touched trace to an observed surface (COL-001), that nothing unknown or
 * unconfident ever enters the collision set (COL-002), and that the touch mattered: the same throw
 * with the collision set emptied flies differently (COL-003).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const MIN_COLLISION_SAMPLES = 30;

type T = PhaseTest<SpatialContext>;

const COL_001: T = {
  spec: {
    id: 'COL-001',
    title: 'Every contact traces to an observed surface',
    required: true,
    input: 'every throw’s contacts against the collision set frozen at its release',
    expected: 'each contact names a collision surface built from a world surface of that epoch',
    passCriteria: '>= 1 throw; 0 untraced contacts',
    failureCondition: 'a contact with a surface the world did not hold (§33: Fake Collision)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { throws: g.throwCount, untraced: g.untracedContacts };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.throwCount === 0) return pending('no throw yet', 'throw the ball once', metrics);
    return judged(g.untracedContacts > 0 ? [`${g.untracedContacts} throw(s) with untraced contacts`] : [], `${g.throwCount} throw(s), ${g.untracedContacts} untraced`, 'every contact names an observed surface', metrics);
  },
};

const COL_002: T = {
  spec: {
    id: 'COL-002',
    title: 'Nothing unknown collides',
    required: true,
    input: 'the collision set built from the live world each tick',
    expected: 'no UNKNOWN surface, nothing below the confidence floor, and nothing at all while the world has no classified surface',
    passCriteria: `>= ${MIN_COLLISION_SAMPLES} samples; 0 violations`,
    failureCondition: 'a collision surface the world could not vouch for (§44: SURFACE UNKNOWN → do not use for collision)',
  },
  evaluate: (ctx) => {
    const metrics: Record<string, JsonValue> = { samples: ctx.collisionSamples, violations: ctx.collisionViolations, detail: ctx.collisionViolationDetail };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (ctx.collisionSamples < MIN_COLLISION_SAMPLES) return pending(`${ctx.collisionSamples}/${MIN_COLLISION_SAMPLES} samples`, 'sampled every tick', metrics);
    return judged(ctx.collisionViolations > 0 ? [`${ctx.collisionViolations} violation(s): ${ctx.collisionViolationDetail}`] : [], `${ctx.collisionSamples} samples, ${ctx.collisionViolations} violation(s)`, 'the collision set held only classified, confident, observed surfaces', metrics);
  },
};

const COL_003: T = {
  spec: {
    id: 'COL-003',
    title: 'The surfaces it touched mattered',
    required: true,
    input: 'every throw that touched a surface, re-flown with the collision set emptied',
    expected: 'a different flight — the contact changed what happened',
    passCriteria: '>= 1 throw with a contact; 0 controls identical to the real flight',
    failureCondition: 'a "bounce" that changed nothing — the ball was never really interacting with the room',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { checks: g.controlChecks, failures: g.controlFailures };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.controlChecks === 0) return pending('no throw has touched a surface yet', 'throw so the ball hits the floor or a wall', metrics);
    return judged(g.controlFailures > 0 ? [`${g.controlFailures} control(s) identical`] : [], `${g.controlChecks} throw(s) with contacts, ${g.controlFailures} unchanged by removing the surfaces`, 'every contact changed the flight', metrics);
  },
};

const COL_004: T = {
  spec: {
    id: 'COL-004',
    title: 'A ball has bounced off the room',
    required: false,
    input: 'the throws’ contacts by surface class',
    expected: 'at least one contact with an observed surface',
    passCriteria: '>= 1 contact',
    failureCondition: 'none — informational',
  },
  evaluate: (ctx) => {
    const byClass: Record<string, number> = {};
    for (const t of ctx.game.throws) for (const c of t.contacts) byClass[c.surfaceClass] = (byClass[c.surfaceClass] ?? 0) + 1;
    const total = Object.values(byClass).reduce((a, b) => a + b, 0);
    const metrics: Record<string, JsonValue> = { byClass };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (total === 0) return pending('no contact yet', 'throw so the ball hits something', metrics);
    return judged([], `${total} contact(s): ${JSON.stringify(byClass)}`, 'the ball interacted with observed surfaces', metrics);
  },
};

const PHASE15_TESTS: readonly T[] = [COL_001, COL_002, COL_003, COL_004];
export const PHASE15_SPECS: readonly TestSpec[] = PHASE15_TESTS.map((t) => t.spec);
export function runPhase15Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE15_TESTS, ctx);
}
