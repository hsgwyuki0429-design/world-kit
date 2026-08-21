/**
 * Phase Lock (Rule 005) and phase-pass authority.
 *
 * This class is the only thing in the codebase allowed to say a phase PASSED, and it
 * will not say it on prose. It requires:
 *
 *   - every REQUIRED test of the phase to have verdict PASS (no PENDING, no FAIL), and
 *   - the evidence to come from the REAL_DEVICE leg (Rule 004).
 *
 * A desktop/headless run that passes every test lands on TESTING, never PASSED, with a
 * reason that says exactly what is still missing. That is deliberate: the one thing an
 * AI implementer can most easily fake is the sentence "it works on the device", so the
 * registry refuses to derive that sentence from anything but device evidence.
 */

import { PhaseState, Verdict, EvidenceLeg } from './types';
import type { PhaseInfo, StateTransition, TestResult } from './types';

/** Phase list from §4. Kept complete so unimplemented phases are visible, not hidden. */
export const PHASE_NAMES: readonly string[] = [
  'Environment / Capability',
  'Camera Capture',
  'Frame Pipeline',
  'Feature Detection',
  'Optical Flow Tracking',
  'Geometric Verification',
  'Relative Pose',
  'IMU Support / Fusion',
  'Keyframe System',
  'Triangulation',
  'Landmark Map',
  'Plane Detection',
  'Spatial World',
  'World Viewer',
  'Save / Load',
  'Collision Geometry',
  'Game Integration',
  'Golden Test',
  'Performance / Stress',
  'Final Audit',
];

/**
 * Phases that actually exist in this build.
 *
 * This is the codebase stating plainly what has been written, separate from what the
 * Phase Lock permits. Rule 002 forbids a UI that implies capability the engine lacks, so
 * a control for an unimplemented phase must say "NOT IMPLEMENTED" rather than simply
 * looking available. Add to this set only when the phase's code exists and its tests run.
 */
export const IMPLEMENTED_PHASES: ReadonlySet<number> = new Set<number>([0]);

export function isPhaseImplemented(index: number): boolean {
  return IMPLEMENTED_PHASES.has(index);
}

export interface PhaseEvaluation {
  readonly state: PhaseState;
  readonly reason: string;
  readonly passCount: number;
  readonly failCount: number;
  readonly pendingCount: number;
}

export class PhaseRegistry {
  private readonly phases: PhaseInfo[];
  private readonly transitions: StateTransition[] = [];
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.phases = PHASE_NAMES.map((name, index) => ({
      index,
      name,
      state: index === 0 ? PhaseState.NOT_STARTED : PhaseState.BLOCKED,
      reason: index === 0 ? 'Phase 0 is the entry phase' : 'previous phase has not PASSED',
      updatedAt: this.now(),
    }));
  }

  get(index: number): PhaseInfo {
    const p = this.phases[index];
    if (!p) throw new Error(`no such phase: ${index}`);
    return p;
  }

  all(): readonly PhaseInfo[] {
    return this.phases;
  }

  getTransitions(): readonly StateTransition[] {
    return this.transitions;
  }

  /** Rule 005: a phase may only be entered when its predecessor has PASSED. */
  canEnter(index: number): boolean {
    if (index === 0) return true;
    const prev = this.phases[index - 1];
    return prev !== undefined && prev.state === PhaseState.PASSED;
  }

  /** Human-readable reason a phase is closed, for the UI to display verbatim. */
  blockedReason(index: number): string {
    if (this.canEnter(index)) return '';
    const prev = this.get(index - 1);
    return `Phase ${prev.index} (${prev.name}) is ${prev.state} — Phase Lock (Rule 005)`;
  }

  setState(index: number, state: PhaseState, reason: string): void {
    const current = this.get(index);
    if (current.state === state && current.reason === reason) return;
    this.transitions.push({
      timestamp: this.now(),
      subject: `phase[${index}] ${current.name}`,
      from: current.state,
      to: state,
      reason,
    });
    this.phases[index] = { ...current, state, reason, updatedAt: this.now() };
    if (state === PhaseState.PASSED) {
      this.unlockNext(index);
    } else {
      // A phase leaving PASSED re-locks everything after it, so a later regression can
      // never leave a downstream phase sitting on a stale PASSED.
      this.relockAfter(index);
    }
  }

  /**
   * Passing a phase opens exactly one door: the next phase moves from BLOCKED to
   * NOT_STARTED. It does not become available in any other sense — whether it has been
   * built at all is `isPhaseImplemented`, which is a separate fact.
   */
  private unlockNext(index: number): void {
    const next = this.phases[index + 1];
    if (!next || next.state !== PhaseState.BLOCKED) return;
    const reason = `phase ${index} PASSED; this phase may now be started`;
    this.transitions.push({
      timestamp: this.now(),
      subject: `phase[${next.index}] ${next.name}`,
      from: next.state,
      to: PhaseState.NOT_STARTED,
      reason,
    });
    this.phases[index + 1] = {
      ...next,
      state: PhaseState.NOT_STARTED,
      reason,
      updatedAt: this.now(),
    };
  }

  private relockAfter(index: number): void {
    for (let i = index + 1; i < this.phases.length; i++) {
      const p = this.get(i);
      if (p.state === PhaseState.BLOCKED) continue;
      this.transitions.push({
        timestamp: this.now(),
        subject: `phase[${i}] ${p.name}`,
        from: p.state,
        to: PhaseState.BLOCKED,
        reason: `phase ${index} is no longer PASSED`,
      });
      this.phases[i] = {
        ...p,
        state: PhaseState.BLOCKED,
        reason: `phase ${index} is no longer PASSED`,
        updatedAt: this.now(),
      };
    }
  }

  /**
   * Fold a set of test results into a phase verdict.
   *
   * Verdict algebra (fail closed):
   *   any REQUIRED FAIL          -> FAILED
   *   any REQUIRED PENDING       -> TESTING
   *   all REQUIRED PASS + device -> PASSED
   *   all REQUIRED PASS + desktop-> TESTING  (Rule 004: desktop cannot pass a phase)
   */
  static evaluate(results: readonly TestResult[], leg: EvidenceLeg): PhaseEvaluation {
    const required = results.filter((r) => r.spec.required);
    const failed = required.filter((r) => r.verdict === Verdict.FAIL);
    const pending = required.filter((r) => r.verdict === Verdict.PENDING);
    const passed = required.filter((r) => r.verdict === Verdict.PASS);

    if (required.length === 0) {
      return {
        state: PhaseState.TESTING,
        reason: 'no required tests were evaluated',
        passCount: 0,
        failCount: 0,
        pendingCount: 0,
      };
    }
    const counts = {
      passCount: passed.length,
      failCount: failed.length,
      pendingCount: pending.length,
    };
    if (failed.length > 0) {
      return {
        state: PhaseState.FAILED,
        reason: `FAILED: ${failed.map((r) => r.spec.id).join(', ')}`,
        ...counts,
      };
    }
    if (pending.length > 0) {
      return {
        state: PhaseState.TESTING,
        reason: `PENDING: ${pending.map((r) => r.spec.id).join(', ')} — not yet evaluable`,
        ...counts,
      };
    }
    if (leg !== EvidenceLeg.REAL_DEVICE) {
      return {
        state: PhaseState.TESTING,
        reason:
          'all required tests PASS on the DESKTOP_DEV leg — Rule 004 requires ' +
          'iPhone Safari over HTTPS before this phase can be PASSED',
        ...counts,
      };
    }
    return {
      state: PhaseState.PASSED,
      reason: `all ${passed.length} required tests PASS on a real device`,
      ...counts,
    };
  }

  applyEvaluation(index: number, evaluation: PhaseEvaluation): void {
    this.setState(index, evaluation.state, evaluation.reason);
  }
}
