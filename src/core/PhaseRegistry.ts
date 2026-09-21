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
 *
 * **One thing it used to require and no longer does: that the pass be in this page load.**
 * The registry is constructed fresh on every load, so `canEnter` was reading "phase N-1 is
 * PASSED *right now, in this session*" — a condition Rule 005 does not state and which cost a
 * device run the whole chain behind it on every reload. `carryOver` accepts a pass the same
 * device recorded on the same build in an earlier load, and opens the lock on it. It does
 * **not** set a verdict: the phase's own state stays whatever this session measured, so no
 * screen, test result or evidence bundle ever reports a pass this run did not see. See
 * `PhasePassLedger` for where such a pass comes from and what pins it.
 */

import { PhaseState, Verdict, EvidenceLeg } from './types';
import type { PhaseInfo, StateTransition, TestResult } from './types';
import type { CarriedPass } from './PhasePassLedger';

/**
 * Phase list from §4, as spec **v4.0** states it. Kept complete so unimplemented phases are
 * visible, not hidden.
 *
 * **Six of these changed when the spec went from v3.0 to v4.0**, and the change is a change of
 * product rather than of wording. v3 treated the Spatial World as the deliverable and ended at
 * a golden test over it; v4 treats it as the substrate for a ball game played against the
 * surfaces actually observed in the room, and adds three phases to build that game. Phases 0–4
 * are untouched — the ones already passed on the device — and the renames begin at 11:
 *
 * | Index | v3.0 | v4.0 |
 * | --- | --- | --- |
 * | 11 | Plane Detection | Surface Understanding |
 * | 13 | World Viewer | Spatial Game Viewer |
 * | 14 | Save / Load | Save / Resume |
 * | 15 | Collision Geometry | Spatial Collision |
 * | 17 | Golden Test | **Stage Generator** |
 * | 18 | Performance / Stress | **Goal Ring System** |
 * | 19 | Final Audit | **Ball Physics** |
 * | 20 | — | **Gameplay Validation** |
 * | 21 | — | Final Audit |
 *
 * The list is 22 long now rather than 20. Nothing in this file depends on the length, and the
 * registry's own tests pin it so a future edit that drops a phase is a visible failure rather
 * than a silently shorter roadmap.
 */
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
  'Surface Understanding',
  'Spatial World',
  'Spatial Game Viewer',
  'Save / Resume',
  'Spatial Collision',
  'Game Integration',
  'Stage Generator',
  'Goal Ring System',
  'Ball Physics',
  'Gameplay Validation',
  'Final Audit',
];

/**
 * Phases that actually exist in this build.
 *
 * This is the codebase stating plainly what has been written, separate from what the
 * Phase Lock permits. Rule 002 forbids a UI that implies capability the engine lacks, so
 * a control for an unimplemented phase must say "NOT IMPLEMENTED" rather than simply
 * looking available. Add to this set only when the phase's code exists and its tests run.
 *
 * Membership here says the phase is *built*, never that it has passed. Whether a phase
 * passes is decided by `evaluate` against real-device evidence, exactly as for every other
 * phase.
 */
export const IMPLEMENTED_PHASES: ReadonlySet<number> = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

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
  /** Passes carried in from an earlier page load on this device and build (`carryOver`). */
  private readonly carried = new Map<number, CarriedPass>();
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

  /**
   * Rule 005: a phase may only be entered when its predecessor has PASSED.
   *
   * Either in this session, or — through `carryOver` — on this same device and build in an
   * earlier page load. Three things keep the second case from being a way around the rule:
   *
   *  - **A FAIL in this session closes the door.** A carried pass is an earlier observation, and
   *    an earlier observation does not survive a later contradiction. `TESTING` is not a
   *    contradiction: it means this session has not finished measuring, which is precisely the
   *    state a carried pass exists to spare the tester from having to leave.
   *  - **The chain is walked, not skipped.** A carried pass for phase N opens the door to N+1
   *    only if the door to N is itself open, so a stored pass cannot step over a gap — including
   *    a gap a later FAIL opened by re-locking everything after it.
   *  - **Nothing here reports a pass.** The predecessor's own state is untouched, so the screen
   *    and the exported bundle keep saying what this run measured.
   */
  canEnter(index: number): boolean {
    if (index === 0) return true;
    const prev = this.phases[index - 1];
    if (prev === undefined) return false;
    if (prev.state === PhaseState.PASSED) return true;
    if (prev.state === PhaseState.FAILED) return false;
    if (!this.carried.has(index - 1)) return false;
    return this.canEnter(index - 1);
  }

  /**
   * Open the lock in front of `index + 1` on a pass an earlier page load recorded.
   *
   * Refuses, and changes nothing, when the door to `index` is not itself open, or when this
   * session has already passed the phase directly — the direct observation is better evidence
   * and needs no help. The phase's state moves at most from BLOCKED to NOT_STARTED, which is
   * what it would have been had the lock been open all along; the reason says where the lock's
   * authority came from, and the transition puts that sentence into every bundle this session
   * exports (§60).
   */
  carryOver(index: number, pass: CarriedPass): boolean {
    const phase = this.phases[index];
    if (phase === undefined) return false;
    if (phase.state === PhaseState.PASSED) return false;
    if (!this.canEnter(index)) return false;

    this.carried.set(index, pass);
    const reason = describeCarriedPass(pass);
    const to = phase.state === PhaseState.BLOCKED ? PhaseState.NOT_STARTED : phase.state;
    this.transitions.push({
      timestamp: this.now(),
      subject: `phase[${index}] ${phase.name}`,
      from: phase.state,
      to,
      reason,
    });
    this.phases[index] = { ...phase, state: to, reason, updatedAt: this.now() };
    this.unlockNext(index);
    return true;
  }

  /** The carried-over pass still standing for a phase, if any. */
  carriedPass(index: number): CarriedPass | null {
    return this.carried.get(index) ?? null;
  }

  /** Every carried-over pass still standing, by ascending phase — for the evidence and the UI. */
  carriedPasses(): readonly CarriedPass[] {
    return [...this.carried.values()].sort((a, b) => a.phase - b.phase);
  }

  /**
   * Why the door in front of `index` is open, when it is open on something this session did not
   * watch happen. Empty otherwise: a lock opened by a pass measured in this run needs no
   * footnote, and one that is still shut has `blockedReason`.
   *
   * Rule 002 — the screen may not imply something the engine cannot support. An enterable
   * button in front of a phase whose predecessor reads NOT_STARTED looks exactly like a broken
   * Phase Lock, and the tester's correct response to a broken Phase Lock is to stop and report
   * it. So the screen has to say which run the door was opened by.
   */
  lockNote(index: number): string {
    if (index === 0) return '';
    const prev = this.phases[index - 1];
    if (prev === undefined || prev.state === PhaseState.PASSED) return '';
    const carried = this.carried.get(index - 1);
    if (carried === undefined || !this.canEnter(index)) return '';
    return `Phase ${index - 1} is ${prev.state} in this run — ${describeCarriedPass(carried)}`;
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
      // A pass observed here supersedes anything carried in for the same phase: the carried
      // record exists to stand in for an observation, and there is one now.
      this.carried.delete(index);
      this.unlockNext(index);
    } else if (state === PhaseState.FAILED) {
      // A FAIL contradicts a carried pass outright, so the carried pass goes and every phase
      // after it re-locks. The caller drops the stored record too (`PhasePassLedger.forget`),
      // or the next reload would re-open a door this session shut.
      this.carried.delete(index);
      this.relockAfter(index);
    } else if (this.carried.has(index)) {
      // TESTING or IMPLEMENTING over a carried pass. This is the ordinary case on arrival:
      // the stage has started and its records are still PENDING, which says this session has
      // not finished measuring — not that the earlier device pass was wrong. Re-locking here
      // would undo the carry-over the moment the tester started the stack the next phase needs,
      // which is every time.
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

/**
 * The sentence a carried-over pass is recorded and displayed with.
 *
 * One function so the transition in the evidence bundle, the phase's reason on its own screen
 * and the navigation footnote cannot drift apart into three accounts of the same fact. It names
 * the build and the origin because those are what the pass is pinned to, and the age because
 * that is the part a reader has to judge for themselves.
 */
export function describeCarriedPass(pass: CarriedPass): string {
  return (
    `carried over: phase ${pass.phase} PASSED on a ${pass.leg} run at ` +
    `${new Date(pass.at).toISOString()} (${describeAge(pass.ageMs)} ago), on build ` +
    `${pass.buildCommit} at ${pass.origin}, over ${pass.passCount} required test(s). ` +
    `This session has not re-measured it; the Phase Lock in front of phase ${pass.phase + 1} ` +
    `opens on that earlier run. Rule 004 is unaffected — the phase still needs a committed ` +
    `real-device bundle of its own.`
  );
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}
