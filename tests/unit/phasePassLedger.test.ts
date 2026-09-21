/**
 * The cross-run Phase Lock carry-over, and the four things it must refuse.
 *
 * This is the one mechanism in the project that can open a phase without the tester watching
 * the previous one pass, so its refusals matter more than its acceptance. The suite is written
 * around them: a pass from another build, a pass from another origin, a pass from a run that
 * could not have been a pass at all (Rule 004), and a pass that would step over a gap in Rule
 * 005's chain.
 *
 * `MemoryStore` stands in for `localStorage`, which the Node test environment does not have.
 * That is why `PhasePassLedger` takes a store at all — the carry-over rules are the whole of
 * its value and they are worth testing rather than reasoning about.
 */

import { describe, expect, it } from 'vitest';
import { PhasePassLedger, UNNAMED_BUILD } from '../../src/core/PhasePassLedger';
import type { KeyValueStore } from '../../src/core/PhasePassLedger';
import { PhaseRegistry, describeCarriedPass } from '../../src/core/PhaseRegistry';
import { EvidenceLeg, PhaseState } from '../../src/core/types';

class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** A store that refuses everything, as Safari's private browsing does. */
class ThrowingStore implements KeyValueStore {
  getItem(): string | null {
    throw new Error('SecurityError: storage is not available');
  }
  setItem(): void {
    throw new Error('SecurityError: storage is not available');
  }
  removeItem(): void {
    throw new Error('SecurityError: storage is not available');
  }
}

const BUILD = 'af28a62c0ffee1234567890abcdef0123456789a';
const ORIGIN = 'https://example.github.io';

function ledger(store: KeyValueStore, build = BUILD, origin = ORIGIN): PhasePassLedger {
  return new PhasePassLedger(build, origin, store);
}

describe('PhasePassLedger — what survives a page load', () => {
  it('carries a real-device pass into the next load on the same build and origin', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.REAL_DEVICE, 'all 9 required tests PASS', 9);

    const carried = ledger(store).carried();
    expect(carried).toHaveLength(1);
    expect(carried[0]?.phase).toBe(6);
    expect(carried[0]?.passCount).toBe(9);
    expect(carried[0]?.leg).toBe(EvidenceLeg.REAL_DEVICE);
    expect(carried[0]?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses a pass recorded by a different build', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9);

    // The whole reason the pin exists: the phone holds the pass, the deploy moves, and the
    // engine the pass was evidence about is no longer the engine running.
    expect(ledger(store, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef').carried()).toEqual([]);
  });

  it('refuses a pass recorded at a different origin', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9);
    expect(ledger(store, BUILD, 'https://somewhere.else').carried()).toEqual([]);
  });

  it('stores nothing at all when the build cannot name itself', () => {
    // `unknown` equals `unknown` across arbitrarily different builds, so a pin that accepted it
    // would not be a pin. This is the defect `ScenarioLedger` had while it pinned `appVersion`,
    // which has read 0.1.0 since Phase 0 — demonstrated here rather than described.
    const store = new MemoryStore();
    const l = ledger(store, UNNAMED_BUILD);
    expect(l.refusalReason()).toMatch(/does not name a commit/);
    l.record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9);
    expect(store.map.size).toBe(0);
    expect(l.carried()).toEqual([]);
  });

  it('never stores a desktop run, because a desktop run cannot be a pass (Rule 004)', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.DESKTOP_DEV, 'all required tests PASS on DESKTOP_DEV', 9);
    expect(store.map.size).toBe(0);
    expect(ledger(store).carried()).toEqual([]);
  });

  it('forgets a pass, so a session that contradicted one cannot have it back on reload', () => {
    const store = new MemoryStore();
    const l = ledger(store);
    l.record(5, EvidenceLeg.REAL_DEVICE, 'passed', 7);
    l.record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9);
    l.forget(6);
    expect(ledger(store).carried().map((c) => c.phase)).toEqual([5]);
  });

  it('degrades to carrying nothing when storage throws, rather than failing the run', () => {
    const l = ledger(new ThrowingStore());
    expect(() => l.record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9)).not.toThrow();
    expect(l.carried()).toEqual([]);
    expect(l.describe()['storageError']).toMatch(/SecurityError/);
  });

  it('ignores a stored entry that has been edited into something else', () => {
    // localStorage is editable by hand. The ledger is a convenience, so a malformed entry is
    // dropped rather than trusted or thrown over.
    const store = new MemoryStore();
    store.setItem('ssm.phaseLock.passes.v1', JSON.stringify({ 6: { phase: 6, leg: 'MADE_UP' } }));
    expect(ledger(store).carried()).toEqual([]);
  });

  it('reports the ledger in a form a bundle can carry, and says what it is not', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.REAL_DEVICE, 'passed', 9);
    const described = ledger(store).describe();
    expect(described['buildCommit']).toBe(BUILD);
    expect(String(described['note'])).toMatch(/committed real-device bundle/);
  });
});

describe('PhasePassLedger + PhaseRegistry — the lock opens, the verdict does not', () => {
  function carriedRegistry(phases: readonly number[]): PhaseRegistry {
    const store = new MemoryStore();
    const writer = ledger(store);
    for (const p of phases) writer.record(p, EvidenceLeg.REAL_DEVICE, `phase ${p} passed`, 9);
    const r = new PhaseRegistry();
    for (const pass of ledger(store).carried()) r.carryOver(pass.phase, pass);
    return r;
  }

  it('opens phase 7 without any phase reporting a pass it did not measure', () => {
    const r = carriedRegistry([0, 1, 2, 3, 4, 5, 6]);
    expect(r.canEnter(7)).toBe(true);
    // The point of the whole design: not one of these says PASSED.
    for (let i = 0; i <= 6; i++) {
      expect(r.get(i).state, `phase ${i}`).toBe(PhaseState.NOT_STARTED);
      expect(r.get(i).reason, `phase ${i}`).toMatch(/carried over/);
    }
    expect(r.canEnter(8)).toBe(false);
  });

  it('keeps the door open while this session is still measuring the phase behind it', () => {
    // The ordinary case on arrival: the tester starts the stack Phase 7 needs, so Phase 6's
    // stage runs again and its records are PENDING. That is "not re-measured yet", and
    // re-locking on it would undo the carry-over every single time.
    const r = carriedRegistry([0, 1, 2, 3, 4, 5, 6]);
    r.setState(6, PhaseState.IMPLEMENTING, 'RELATIVE POSE screen opened');
    r.setState(6, PhaseState.TESTING, 'PENDING: POSE-001 — not yet evaluable');
    expect(r.canEnter(7)).toBe(true);
    expect(r.get(6).state).toBe(PhaseState.TESTING);
  });

  it('shuts the door when this session actually contradicts the carried pass', () => {
    const r = carriedRegistry([0, 1, 2, 3, 4, 5, 6]);
    r.setState(6, PhaseState.FAILED, 'FAILED: POSE-004');
    expect(r.canEnter(7)).toBe(false);
    expect(r.carriedPass(6)).toBeNull();
    expect(r.blockedReason(7)).toMatch(/Phase 6 .*FAILED/);
  });

  it('will not step over a gap in Rule 005’s chain', () => {
    const store = new MemoryStore();
    ledger(store).record(6, EvidenceLeg.REAL_DEVICE, 'phase 6 passed', 9);
    const r = new PhaseRegistry();
    const [pass] = ledger(store).carried();
    expect(pass).toBeDefined();
    // Nothing is stored for 0..5, so phase 6's own door is shut and its pass may not open 7's.
    expect(r.carryOver(6, pass!)).toBe(false);
    expect(r.canEnter(7)).toBe(false);
    expect(r.get(6).state).toBe(PhaseState.BLOCKED);
  });

  it('closes a carried chain behind a failure further back', () => {
    // Phase 4's carried pass is untouched by a Phase 3 failure in the sense that nothing
    // contradicted it — and it must still not open Phase 5, because the door to Phase 4 is shut.
    const r = carriedRegistry([0, 1, 2, 3, 4]);
    expect(r.canEnter(5)).toBe(true);
    r.setState(3, PhaseState.FAILED, 'FAILED: FLOW-002');
    expect(r.canEnter(4)).toBe(false);
    expect(r.canEnter(5)).toBe(false);
    // And it re-opens when the failure is put right, without the tester re-running Phase 4.
    r.setState(3, PhaseState.PASSED, 'all required tests PASS on a real device');
    expect(r.canEnter(5)).toBe(true);
  });

  it('lets a pass measured in this session supersede the carried one', () => {
    const r = carriedRegistry([0, 1, 2, 3, 4, 5, 6]);
    r.setState(6, PhaseState.PASSED, 'all required tests PASS on a real device');
    expect(r.carriedPass(6)).toBeNull();
    expect(r.canEnter(7)).toBe(true);
    expect(r.lockNote(7)).toBe('');
  });

  it('refuses to carry over a phase this session has already passed directly', () => {
    const store = new MemoryStore();
    ledger(store).record(0, EvidenceLeg.REAL_DEVICE, 'phase 0 passed', 12);
    const r = new PhaseRegistry();
    r.setState(0, PhaseState.PASSED, 'all required tests PASS on a real device');
    const [pass] = ledger(store).carried();
    expect(r.carryOver(0, pass!)).toBe(false);
    expect(r.get(0).reason).not.toMatch(/carried over/);
  });

  it('records the carry-over as a transition, so every exported bundle carries it (§60)', () => {
    const r = carriedRegistry([0, 1]);
    const carried = r.getTransitions().filter((t) => t.reason.startsWith('carried over'));
    expect(carried).toHaveLength(2);
    expect(carried[0]?.subject).toMatch(/phase\[0\]/);
    expect(carried[0]?.reason).toContain(BUILD);
    expect(carried[0]?.reason).toContain(ORIGIN);
    expect(carried[0]?.reason).toMatch(/Rule 004 is unaffected/);
  });

  it('gives the screen a sentence for a door this session did not open (Rule 002)', () => {
    const r = carriedRegistry([0, 1, 2, 3, 4, 5, 6]);
    expect(r.lockNote(7)).toMatch(/Phase 6 is NOT_STARTED in this run/);
    expect(r.lockNote(7)).toMatch(/carried over/);
    // Nothing to explain where the lock is shut — that is `blockedReason`'s job.
    expect(r.lockNote(8)).toBe('');
  });

  it('says the same thing in the transition, the reason and the footnote', () => {
    // Three places quote one function, so a reader cannot be given three accounts of one fact.
    const r = carriedRegistry([0]);
    const pass = r.carriedPass(0);
    expect(pass).not.toBeNull();
    const sentence = describeCarriedPass(pass!);
    expect(r.get(0).reason).toBe(sentence);
    expect(r.lockNote(1)).toContain(sentence);
  });
});
