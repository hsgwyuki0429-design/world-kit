/**
 * Phase 14 test suite — SAVE-001..SAVE-004 (v4 §41, §42).
 *
 * Specs transcribed from `docs/phase14/TEST-PLAN.md`.
 *
 * **The claim.** The easy version of resume reloads a saved world and plays on it — and in a new
 * session that world's coordinates belong to nobody: its surfaces would be walls where no one has
 * looked. So the suite asks that a save survive a round trip, that an altered or non-finite one be
 * refused, that a resumed world never reach the collision set, and that pausing in place keeps the
 * stage and the ball exactly where they were.
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

type T = PhaseTest<SpatialContext>;

const SAVE_001: T = {
  spec: {
    id: 'SAVE-001',
    title: 'A save survives the round trip',
    required: true,
    input: 'every save: the record serialised, parsed back and compared',
    expected: 'the same record, checksum intact',
    passCriteria: '>= 1 save; 0 round-trip differences',
    failureCondition: 'a save that does not read back as itself',
  },
  evaluate: (ctx) => {
    const s = ctx.save;
    const metrics: Record<string, JsonValue> = { saves: s.saves, roundTripFailures: s.roundTripFailures, refusals: s.saveRefusals, bytes: s.lastSaveBytes };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (s.saves === 0) return pending('no save yet', 'press 保存 once the world is READY', metrics);
    return judged(s.roundTripFailures > 0 ? [`${s.roundTripFailures} round trip(s) differed`] : [], `${s.saves} save(s), ${s.lastSaveBytes} bytes last, ${s.roundTripFailures} difference(s)`, 'every save reads back as itself', metrics);
  },
};

const SAVE_002: T = {
  spec: {
    id: 'SAVE-002',
    title: 'Altered or non-finite saves are refused',
    required: true,
    input: 'each save with one digit altered offered to the parser; a record with a NaN offered to the builder',
    expected: 'both refused',
    passCriteria: '>= 1 of each check; 0 accepted',
    failureCondition: 'a corrupted save loaded, or a NaN written',
  },
  evaluate: (ctx) => {
    const s = ctx.save;
    const metrics: Record<string, JsonValue> = { tamperChecks: s.tamperChecks, tamperAccepted: s.tamperAccepted, nonFiniteChecks: s.nonFiniteChecks, nonFiniteAccepted: s.nonFiniteAccepted };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (s.tamperChecks === 0 || s.nonFiniteChecks === 0) return pending('no save checked yet', 'the checks run on every save', metrics);
    const problems: string[] = [];
    if (s.tamperAccepted > 0) problems.push(`${s.tamperAccepted} altered save(s) accepted`);
    if (s.nonFiniteAccepted > 0) problems.push(`${s.nonFiniteAccepted} non-finite save(s) built`);
    return judged(problems, `${s.tamperChecks} tamper and ${s.nonFiniteChecks} non-finite check(s), ${s.tamperAccepted + s.nonFiniteAccepted} accepted`, 'the save fails closed', metrics);
  },
};

const SAVE_003: T = {
  spec: {
    id: 'SAVE-003',
    title: 'Resume never plays on a world nobody re-observed',
    required: true,
    input: 'a resume from a save, then the live collision set and stage while the restored world is held',
    expected: 'progress restored; the restored world shown, marked not relocalized, never collided with; stages only from the live world',
    passCriteria: '>= 1 resume; 0 samples with the restored world in the collision set; any stage held is of the live epoch',
    failureCondition: 'a saved world’s surfaces used as this session’s geometry (§45: goal placed using nonexistent geometry)',
  },
  evaluate: (ctx) => {
    const s = ctx.save;
    const stage = ctx.game.lastStage;
    const metrics: Record<string, JsonValue> = { resumes: s.resumes, refusals: s.resumeRefusals, used: s.restoredUsedForCollision, lastReason: s.lastResumeReason };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (s.resumes === 0) return pending(`no resume yet (${s.lastResumeReason || 'nothing tried'})`, 'save, reload the page, and press 前回の続きから', metrics);
    const problems: string[] = [];
    if (s.restoredUsedForCollision > 0) problems.push(`${s.restoredUsedForCollision} sample(s) collided against the restored world`);
    if (stage && stage.epoch !== ctx.view.epoch) problems.push(`a stage of epoch ${stage.epoch} held in world epoch ${ctx.view.epoch}`);
    return judged(problems, `${s.resumes} resume(s); restored world used ${s.restoredUsedForCollision} time(s)`, 'progress resumed on the room as observed now', metrics);
  },
};

const SAVE_004: T = {
  spec: {
    id: 'SAVE-004',
    title: 'Pause keeps the game in place',
    required: true,
    input: 'pause and resume within the session: the stage digest and the ball before and after',
    expected: 'the same stage and the same ball',
    passCriteria: '>= 1 pause/resume; 0 differences',
    failureCondition: 'a pause that moved the ball or replaced the stage',
  },
  evaluate: (ctx) => {
    const s = ctx.save;
    const metrics: Record<string, JsonValue> = { pauses: s.pauseResumes, mismatches: s.pauseResumeMismatches };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (s.pauseResumes === 0) return pending('no pause yet', 'press 一時停止 during play, then 再開', metrics);
    return judged(s.pauseResumeMismatches > 0 ? [`${s.pauseResumeMismatches} pause(s) changed the game`] : [], `${s.pauseResumes} pause(s), ${s.pauseResumeMismatches} difference(s)`, 'a pause holds everything where it was', metrics);
  },
};

const PHASE14_TESTS: readonly T[] = [SAVE_001, SAVE_002, SAVE_003, SAVE_004];
export const PHASE14_SPECS: readonly TestSpec[] = PHASE14_TESTS.map((t) => t.spec);
export function runPhase14Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE14_TESTS, ctx);
}
