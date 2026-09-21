/**
 * Cross-run Phase Lock ledger — the session scope Rule 005 never asked for.
 *
 * Rule 005 says a phase may be entered once its predecessor has PASSED. The registry is built
 * fresh on every page load, so in practice it has been asking for something stricter: that the
 * predecessor passed *in this page load*. That second requirement is nowhere in the rule, and it
 * is what made a device run expensive. Reaching Phase 9 meant passing 0 through 8 without
 * reloading — about twenty minutes of held motion, in one sitting — and a reload, a backgrounded
 * tab or a Phase 7 run that ended `TESTING` cost the whole chain. Phase 7 has now been retried
 * four times, and each retry was charged the price of re-passing six phases that had already
 * passed on the same phone minutes earlier.
 *
 * So this carries the answer to Rule 005's actual question — *has this device already passed the
 * phase in front of me* — from one page load to the next.
 *
 * **It does not carry a verdict**, and the distinction is the whole of its safety. Nothing here
 * writes PASSED into a phase's state, into a test result, or into an evidence bundle. A phase
 * whose pass was carried over reports, on its own screen and in anything exported from this
 * session, exactly what this session measured — which on arrival is nothing. What moves is one
 * boolean, consumed by `PhaseRegistry.canEnter` and by nothing else.
 *
 * **What it is not: proof.** Everything here lives in `localStorage`, which a person can edit.
 * `tests/unit/committedEvidence.test.ts` ignores it entirely and keeps requiring, for every
 * phase, a committed real-device bundle whose verdict re-derives from its own results. Rule 004
 * is untouched: only a `REAL_DEVICE` PASS is ever written here, because only that is a pass at
 * all. Convenience here; proof there — the arrangement `ScenarioLedger` already uses for Phase
 * 1's two permission scenarios.
 *
 * **Pinned to the build, and that pin is load-bearing.** A pass is evidence about the code that
 * produced it. Carrying one onto a different build would let a phone open Phase 9 on a lock that
 * an older, since-corrected engine had opened — which is the failure this project has already
 * paid for twice in one day, when a stalled Pages deploy left the device measuring week-old
 * instruments and no bundle could say which build it came from. Hence `buildCommit`, and hence
 * the refusal below to carry anything at all when the build cannot name itself: `unknown`
 * matches `unknown` across arbitrarily different builds, so a pin that accepts it is not a pin.
 * `ScenarioLedger` has that defect today — it pins `appVersion`, which has read `0.1.0` since
 * Phase 0 — and it is fixed there in the same change that adds this.
 *
 * There is deliberately **no expiry**. An age threshold would be a number invented to feel safe,
 * and it would be the wrong instrument: what makes a carried pass stale is the code changing,
 * which the build pin already catches exactly. The age is recorded and displayed instead, so a
 * reader can judge it rather than be judged by a constant.
 */

import { EvidenceLeg } from './types';
import { describeError, toJsonSafe } from './validate';
import type { JsonValue } from './types';

const STORAGE_KEY = 'ssm.phaseLock.passes.v1';

/** The build string meaning "this build could not name itself" — never pinned against. */
export const UNNAMED_BUILD = 'unknown';

export interface PhasePassRecord {
  readonly phase: number;
  /** When the pass was observed, not when it was last read. A carried pass does not refresh. */
  readonly at: number;
  readonly origin: string;
  readonly buildCommit: string;
  /**
   * Always `REAL_DEVICE` — a desktop run cannot reach PASSED (Rule 004), so there is nothing
   * else to store. Kept in the record so a reader can check that rather than trust it.
   */
  readonly leg: EvidenceLeg;
  /** The evaluation reason that produced the pass, so the carry-over can quote its origin. */
  readonly reason: string;
  readonly passCount: number;
}

export interface CarriedPass extends PhasePassRecord {
  readonly ageMs: number;
}

/**
 * The slice of `Storage` this needs, so the ledger can be driven by a test.
 *
 * The unit suite runs in Node, where `localStorage` does not exist. Taking the store as a
 * parameter is what lets the carry-over rules — the build pin, the origin pin, the refusal to
 * step over a gap — be tested rather than reasoned about, which is the same reason
 * `audit-architecture.mjs` accepts a fixture tree on argv.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class PhasePassLedger {
  private readonly buildCommit: string;
  private readonly origin: string;
  private readonly injected: KeyValueStore | null;
  private storageError: string | null = null;
  private refusal: string | null = null;

  constructor(buildCommit: string, origin?: string, store?: KeyValueStore) {
    this.buildCommit = buildCommit;
    this.origin = origin ?? (typeof location === 'undefined' ? '' : location.origin);
    this.injected = store ?? null;
    if (buildCommit === UNNAMED_BUILD || buildCommit.length === 0) {
      this.refusal =
        `this build does not name a commit, so a stored pass could not be tied to the code ` +
        `that produced it — nothing is carried over and nothing is written`;
    }
  }

  /** Whether this build is allowed to carry passes at all, and why not when it is not. */
  refusalReason(): string | null {
    return this.refusal;
  }

  /**
   * Record a pass this session observed directly.
   *
   * Refuses anything that is not a real-device PASS, because nothing else is a pass. The caller
   * is not trusted to have filtered: `applyPhase` hands every evaluation to this, and the
   * filtering that matters happens here where it can be read in one place.
   */
  record(
    phase: number,
    leg: EvidenceLeg,
    reason: string,
    passCount: number,
  ): void {
    if (this.refusal !== null) return;
    if (leg !== EvidenceLeg.REAL_DEVICE) return;
    const record: PhasePassRecord = {
      phase,
      at: Date.now(),
      origin: this.origin,
      buildCommit: this.buildCommit,
      leg,
      reason,
      passCount,
    };
    try {
      const all = this.readStored();
      all[String(phase)] = record;
      this.store().setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      // Private browsing and blocked storage both throw. The run is unaffected; only the
      // carry-over is lost, which costs the tester the session they would have had anyway.
      this.storageError = describeError(err);
    }
  }

  /**
   * Drop a stored pass this session has contradicted.
   *
   * A phase that FAILS now is not a phase that passed earlier, whatever the phone remembers,
   * and leaving the record in place would let the next reload re-open a door this session shut.
   */
  forget(phase: number): void {
    try {
      const all = this.readStored();
      if (!(String(phase) in all)) return;
      delete all[String(phase)];
      this.store().setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      this.storageError = describeError(err);
    }
  }

  /**
   * The passes eligible to be carried into this session, by ascending phase.
   *
   * Ascending because the registry restores them through the Phase Lock itself — phase N is only
   * carried when the door to N is already open — so a gap stops the chain rather than being
   * stepped over.
   */
  carried(): readonly CarriedPass[] {
    if (this.refusal !== null) return [];
    const now = Date.now();
    return Object.values(this.readStored())
      .filter((r) => r.buildCommit === this.buildCommit && r.origin === this.origin)
      .filter((r) => r.leg === EvidenceLeg.REAL_DEVICE)
      .map((r) => ({ ...r, ageMs: Math.max(0, now - r.at) }))
      .sort((a, b) => a.phase - b.phase);
  }

  clear(): void {
    try {
      this.store().removeItem(STORAGE_KEY);
    } catch (err) {
      this.storageError = describeError(err);
    }
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      storageKey: STORAGE_KEY,
      buildCommit: this.buildCommit,
      origin: this.origin,
      refusedBecause: this.refusal,
      storageError: this.storageError,
      carried: this.carried().map((c) => ({ ...c })),
      note:
        'Carried-over passes open the Phase Lock and nothing else. They set no verdict, and ' +
        'the repository gate ignores this ledger: every phase still needs a committed ' +
        'real-device bundle whose verdict re-derives from its own results.',
    }) as Record<string, JsonValue>;
  }

  /**
   * The store, or a throw. Every caller is already inside a try/catch that turns a storage
   * failure into a lost carry-over rather than a lost run — which is the same outcome private
   * browsing produces on a real device, and the one this must degrade to.
   */
  private store(): KeyValueStore {
    if (this.injected !== null) return this.injected;
    if (typeof localStorage === 'undefined') throw new Error('no localStorage in this runtime');
    return localStorage;
  }

  private readStored(): Record<string, PhasePassRecord> {
    try {
      const raw = this.store().getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, PhasePassRecord> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isPassRecord(value)) out[key] = value;
      }
      return out;
    } catch (err) {
      this.storageError = describeError(err);
      return {};
    }
  }
}

function isPassRecord(v: unknown): v is PhasePassRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['phase'] === 'number' &&
    Number.isInteger(o['phase']) &&
    typeof o['at'] === 'number' &&
    Number.isFinite(o['at']) &&
    typeof o['origin'] === 'string' &&
    typeof o['buildCommit'] === 'string' &&
    o['buildCommit'] !== UNNAMED_BUILD &&
    (o['leg'] === EvidenceLeg.REAL_DEVICE || o['leg'] === EvidenceLeg.DESKTOP_DEV) &&
    typeof o['reason'] === 'string' &&
    typeof o['passCount'] === 'number'
  );
}
