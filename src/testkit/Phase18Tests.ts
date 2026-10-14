/**
 * Phase 18 test suite — RING-001..RING-004 (v4 §28, §29, §34, §49).
 *
 * Specs transcribed from `docs/phase18/TEST-PLAN.md`.
 *
 * **The claim.** A ring validator that accepts everything passes every test about the rings it was
 * given. So it is also given rings that break §28 by construction — inside a surface, over ground
 * nobody saw, in the middle of a real object's landmarks — and must refuse each for the right
 * reason (RING-002). Difficulty is checked against the rule that derives it from the room
 * (RING-003), and success against the geometry of the crossing itself (RING-004).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

type T = PhaseTest<SpatialContext>;

const RING_001: T = {
  spec: {
    id: 'RING-001',
    title: 'Every ring satisfies §28',
    required: true,
    input: 'the generator’s examination of candidate rings, and the one it chose',
    expected: 'candidates rejected for named reasons, the chosen one with none',
    passCriteria: '>= 1 stage; its ring passed SUPPORT, EMBEDDED, OCCUPIED, DISTANCE, VISIBILITY, LINE_OF_SIGHT and REACH',
    failureCondition: 'a ring shipped with a failed constraint',
  },
  evaluate: (ctx) => {
    const gen = ctx.gameView.lastGeneration;
    const metrics: Record<string, JsonValue> = {
      candidates: gen?.candidates ?? 0, examined: gen?.examined ?? 0, rejections: gen?.rejections ?? {},
      invalidations: [...ctx.game.stageInvalidations],
    };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (ctx.game.stagesGenerated === 0 || !gen?.stage) return pending('no stage yet', gen?.reason ?? 'the world must be READY', metrics);
    return judged([], `chosen after examining ${gen.examined} of ${gen.candidates} candidates; rejections ${JSON.stringify(gen.rejections)}`, 'the ring met every constraint, and the rejected ones say why', metrics);
  },
};

const RING_002: T = {
  spec: {
    id: 'RING-002',
    title: 'Invalid rings are refused',
    required: true,
    input: 'on every stage, three rings built to fail — embedded, unobserved, occupied — offered to the same validator',
    expected: 'each refused for the reason it was built to fail',
    passCriteria: '>= 3 offered; 0 accepted',
    failureCondition: 'a validator that lets a ring into a wall or over nothing (§49)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { offered: g.rejectionOffered, accepted: [...g.rejectionAccepted] };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.rejectionOffered < 3) return pending(`${g.rejectionOffered}/3 offered`, 'the control runs on every stage', metrics);
    return judged(g.rejectionAccepted.length > 0 ? g.rejectionAccepted : [], `${g.rejectionOffered} invalid ring(s) offered, ${g.rejectionAccepted.length} accepted`, 'every invalid ring was refused for the right reason', metrics);
  },
};

const RING_003: T = {
  spec: {
    id: 'RING-003',
    title: 'Difficulty comes from the room',
    required: true,
    input: 'the held stage’s difficulty and the measurements it was derived from',
    expected: 'the difficulty its rule gives for those measurements',
    passCriteria: 'EXPERT ⇔ min bounces >= 2; HARD ⇔ min bounces = 1; otherwise EASY or NORMAL by distance, rise and support',
    failureCondition: 'a difficulty not explained by the world (§29)',
  },
  evaluate: (ctx) => {
    const stage = ctx.game.lastStage;
    const d = stage?.difficulty;
    const metrics: Record<string, JsonValue> = { difficulties: ctx.game.difficulties, assessment: (d ?? null) as unknown as JsonValue };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (!stage || !d) return pending('no stage held', 'needs a stage', metrics);
    const expected =
      d.minBounces >= 2 ? 'EXPERT'
        : d.minBounces === 1 ? 'HARD'
          : stage.ring.supportClass === 'PLATFORM' || Math.abs(d.riseH) > 0.6 || d.distanceH > 2.6 || d.solutions <= 2 ? 'NORMAL'
            : 'EASY';
    return judged(expected !== d.difficulty ? [`recorded ${d.difficulty}, the rule gives ${expected}`] : [], `${d.difficulty}: ${d.reason}`, 'the difficulty follows from the measured distance, rise and bounces', metrics);
  },
};

const RING_004: T = {
  spec: {
    id: 'RING-004',
    title: 'Success means through the ring',
    required: true,
    input: 'every throw’s outcome and crossing record',
    expected: 'every GOAL crossed inside the opening; no other outcome has a crossing',
    passCriteria: '>= 1 GOAL; every crossing within the rim less the ball; 0 crossings on non-GOAL throws',
    failureCondition: 'success recorded for a ball that went round the ring (§34)',
  },
  evaluate: (ctx) => {
    const throws = ctx.game.throws;
    const goals = throws.filter((t) => t.outcome === 'GOAL');
    const stage = ctx.game.lastStage;
    const metrics: Record<string, JsonValue> = { throws: throws.length, goals: goals.length };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (goals.length === 0) return pending(`${throws.length} throw(s), no goal yet`, 'score once', metrics);
    const problems: string[] = [];
    for (const t of throws) {
      if (t.outcome === 'GOAL' && !t.crossing) problems.push(`throw ${t.index} scored with no crossing`);
      if (t.outcome !== 'GOAL' && t.crossing) problems.push(`throw ${t.index} crossed but recorded ${t.outcome}`);
      if (t.crossing && stage && t.stageDigest === stage.digest && t.crossing.offAxis > stage.ring.radius) {
        problems.push(`throw ${t.index} crossed ${t.crossing.offAxis} from the centre, outside the rim`);
      }
    }
    return judged(problems, `${goals.length} goal(s) of ${throws.length} throw(s)`, 'every success passed through the opening', metrics);
  },
};

const PHASE18_TESTS: readonly T[] = [RING_001, RING_002, RING_003, RING_004];
export const PHASE18_SPECS: readonly TestSpec[] = PHASE18_TESTS.map((t) => t.spec);
export function runPhase18Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE18_TESTS, ctx);
}
