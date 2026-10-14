/**
 * Phase 16 test suite — GAME-001..GAME-005 (v4 §36, §37, §44).
 *
 * Specs transcribed from `docs/phase16/TEST-PLAN.md`.
 *
 * **The claim.** A game loop can be faked by a screen that changes labels on a timer. The suite
 * asks for every transition to be one §37 allows (GAME-001), for the label on screen to be the
 * state in the engine (GAME-002), for nothing to be generated, thrown or flown while the world
 * cannot support it (GAME-003), and for one whole loop to have been played (GAME-004).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const MIN_TRANSITIONS = 5;
export const MIN_UI_SAMPLES = 30;

type T = PhaseTest<SpatialContext>;

const GAME_001: T = {
  spec: {
    id: 'GAME-001',
    title: 'Only §37’s transitions',
    required: true,
    input: 'every state transition the game made, against its declared table',
    expected: 'each one allowed',
    passCriteria: `>= ${MIN_TRANSITIONS} transitions; 0 illegal`,
    failureCondition: 'a jump the state machine does not allow — e.g. straight from SCAN to SUCCESS',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { transitions: g.transitionCount, illegal: g.illegalTransitions, visited: [...g.visited] };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.transitionCount < MIN_TRANSITIONS) return pending(`${g.transitionCount}/${MIN_TRANSITIONS} transitions`, 'play on', metrics);
    return judged(g.illegalTransitions > 0 ? [`${g.illegalTransitions} illegal transition(s)`] : [], `${g.transitionCount} transitions through ${g.visited.join(', ')}`, 'every transition was one the state machine allows', metrics);
  },
};

const GAME_002: T = {
  spec: {
    id: 'GAME-002',
    title: 'The screen shows the state',
    required: true,
    input: 'the HUD’s state badge, read from the DOM each tick, against the game’s state',
    expected: 'always the same',
    passCriteria: `>= ${MIN_UI_SAMPLES} samples; 0 mismatches`,
    failureCondition: 'a badge saying one state while the engine is in another (§37: 状態とUI表示は必ず一致する)',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { samples: r.uiSamples, mismatches: r.stateMismatches, detail: r.uiMismatchDetail };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.uiSamples < MIN_UI_SAMPLES) return pending(`${r.uiSamples}/${MIN_UI_SAMPLES} samples`, 'read each tick', metrics);
    return judged(r.stateMismatches > 0 ? [`${r.stateMismatches} mismatch(es): ${r.uiMismatchDetail}`] : [], `${r.uiSamples} samples, ${r.stateMismatches} mismatch(es)`, 'the badge always named the engine’s state', metrics);
  },
};

const GAME_003: T = {
  spec: {
    id: 'GAME-003',
    title: 'Fails closed',
    required: true,
    input: 'stage generation, the frozen states and the stage’s epoch',
    expected: 'no stage generated while the world was not READY; no physics step while frozen; no stage held from another epoch',
    passCriteria: '0 of each',
    failureCondition: 'a game made playable by ignoring the world (§44)',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = {
      generatedWhileNotReady: g.generatedWhileNotReady, stepsWhileFrozen: g.stepsWhileFrozen,
      staleStageFrames: g.staleStageFrames, refused: g.pressesRefused,
    };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    const problems: string[] = [];
    if (g.generatedWhileNotReady > 0) problems.push(`${g.generatedWhileNotReady} stage(s) generated on a world that was not READY`);
    if (g.stepsWhileFrozen > 0) problems.push(`${g.stepsWhileFrozen} physics step(s) while frozen`);
    if (g.staleStageFrames > 0 && g.epochInvalidations < g.staleStageFrames) problems.push(`${g.staleStageFrames} frame(s) with a stale stage not dropped`);
    return judged(problems, `0-checks: ${JSON.stringify(metrics)}`, 'nothing was generated, thrown or flown without the world behind it', metrics);
  },
};

const GAME_004: T = {
  spec: {
    id: 'GAME-004',
    title: 'A whole loop played',
    required: true,
    input: 'the transitions',
    expected: 'READY → AIMING → THROWING → SUCCESS or RETRY, at least once',
    passCriteria: '>= 1 complete cycle',
    failureCondition: 'none played',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { cycles: g.cycles, successes: g.successes, misses: g.misses };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.cycles === 0) return pending('no complete cycle yet', 'hold to charge, release to throw', metrics);
    return judged([], `${g.cycles} cycle(s): ${g.successes} success(es), ${g.misses} miss(es)`, 'the loop runs end to end', metrics);
  },
};

const GAME_005: T = {
  spec: {
    id: 'GAME-005',
    title: 'Tracking loss handled',
    required: false,
    input: 'TRACKING_LOST entries and recoveries',
    expected: 'play freezes when tracking is lost and resumes when it returns',
    passCriteria: '>= 1 entry and >= 1 recovery',
    failureCondition: 'informational',
  },
  evaluate: (ctx) => {
    const g = ctx.game;
    const metrics: Record<string, JsonValue> = { entries: g.lostEntries, recoveries: g.lostRecoveries };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (g.lostEntries === 0) return pending('tracking has not been lost during play', 'cover the camera briefly during play', metrics);
    return judged(g.lostRecoveries === 0 ? ['never recovered'] : [], `${g.lostEntries} loss(es), ${g.lostRecoveries} recovery(ies)`, 'loss froze play and recovery resumed it', metrics);
  },
};

const PHASE16_TESTS: readonly T[] = [GAME_001, GAME_002, GAME_003, GAME_004, GAME_005];
export const PHASE16_SPECS: readonly TestSpec[] = PHASE16_TESTS.map((t) => t.spec);
export function runPhase16Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE16_TESTS, ctx);
}
