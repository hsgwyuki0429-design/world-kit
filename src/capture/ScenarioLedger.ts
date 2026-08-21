/**
 * Cross-run scenario ledger (CAM-001 / CAM-002).
 *
 * The granted and denied permission paths cannot both be observed in one session, and
 * neither may be inferred from the other. So Phase 1 needs two device runs, and this
 * carries an observation from the first into the second — purely so the second run can
 * show a complete picture instead of the tester having to hold it in their head.
 *
 * What it is not: proof. Everything here lives in `localStorage`, which a person can edit.
 * So every result derived from a carried-over observation is flagged `observedDirectly:
 * false` and shown with the age and origin of what it rests on, and the repository's gate
 * (`tests/unit/committedEvidence.test.ts`) ignores the ledger entirely — it requires
 * committed bundles that observed each scenario directly. Convenience here; proof there.
 */

import { describeError, toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';

const STORAGE_KEY = 'ssm.phase1.scenarios.v1';

export type PermissionScenario = 'GRANTED' | 'DENIED';

export interface ScenarioObservation {
  readonly scenario: PermissionScenario;
  readonly at: number;
  readonly origin: string;
  readonly appVersion: string;
  readonly detail: string;
}

export interface LedgerEntry extends ScenarioObservation {
  /** True when this observation was made in the current run. */
  readonly observedDirectly: boolean;
  readonly ageMs: number;
}

export class ScenarioLedger {
  private readonly appVersion: string;
  private readonly thisRun = new Map<PermissionScenario, ScenarioObservation>();
  private loadError: string | null = null;

  constructor(appVersion: string) {
    this.appVersion = appVersion;
  }

  /** Record something actually seen in this run, and persist it for the next one. */
  observe(scenario: PermissionScenario, detail: string): void {
    const obs: ScenarioObservation = {
      scenario,
      at: Date.now(),
      origin: location.origin,
      appVersion: this.appVersion,
      detail,
    };
    this.thisRun.set(scenario, obs);
    this.persist(obs);
  }

  /**
   * The observation for a scenario, from this run if there is one, otherwise a stored one.
   *
   * Stored observations are ignored unless they come from the same build and the same
   * origin: a result carried over from a different version of the code is evidence about
   * that version, not this one.
   */
  get(scenario: PermissionScenario): LedgerEntry | null {
    const direct = this.thisRun.get(scenario);
    if (direct) return { ...direct, observedDirectly: true, ageMs: 0 };

    const stored = this.readStored()[scenario];
    if (!stored) return null;
    if (stored.appVersion !== this.appVersion) return null;
    if (stored.origin !== location.origin) return null;
    return { ...stored, observedDirectly: false, ageMs: Date.now() - stored.at };
  }

  private persist(obs: ScenarioObservation): void {
    try {
      const all = this.readStored();
      all[obs.scenario] = obs;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (err) {
      // Private browsing and blocked storage both throw. The run is still valid; only the
      // carry-over is lost, so the tester repeats both scenarios in one sitting.
      this.loadError = describeError(err);
    }
  }

  private readStored(): Partial<Record<PermissionScenario, ScenarioObservation>> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Partial<Record<PermissionScenario, ScenarioObservation>> = {};
      for (const key of ['GRANTED', 'DENIED'] as const) {
        const v = (parsed as Record<string, unknown>)[key];
        if (isObservation(v)) out[key] = v;
      }
      return out;
    } catch (err) {
      this.loadError = describeError(err);
      return {};
    }
  }

  clear(): void {
    this.thisRun.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      this.loadError = describeError(err);
    }
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      storageKey: STORAGE_KEY,
      appVersion: this.appVersion,
      granted: this.get('GRANTED'),
      denied: this.get('DENIED'),
      storageError: this.loadError,
      note:
        'Carried-over observations are a convenience for a two-run test. The repository ' +
        'gate ignores this ledger and requires committed bundles that observed each ' +
        'scenario directly.',
    }) as Record<string, JsonValue>;
  }
}

function isObservation(v: unknown): v is ScenarioObservation {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o['scenario'] === 'GRANTED' || o['scenario'] === 'DENIED') &&
    typeof o['at'] === 'number' &&
    Number.isFinite(o['at']) &&
    typeof o['origin'] === 'string' &&
    typeof o['appVersion'] === 'string' &&
    typeof o['detail'] === 'string'
  );
}
