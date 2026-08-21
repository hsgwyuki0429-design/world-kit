/**
 * Probe plumbing shared by the capability detector.
 *
 * Every probe is timed, wrapped, and forced to produce a record even when it throws.
 * A throw becomes `ERROR`, never `UNAVAILABLE`: "the probe blew up" and "the feature is
 * absent" are different facts and collapsing them would corrupt the matrix.
 */

import { CapabilityState, DetectionMethod } from '../core/types';
import type { CapabilityGroup, CapabilityRecord, JsonValue } from '../core/types';
import { describeError, toJsonSafe } from '../core/validate';

export interface ProbeOutcome {
  state: CapabilityState;
  method: DetectionMethod;
  detail: string;
  data?: Record<string, unknown>;
}

export interface ProbeDefinition {
  id: string;
  group: CapabilityGroup;
  label: string;
  run: () => ProbeOutcome | Promise<ProbeOutcome>;
  /** Milliseconds before the probe is abandoned and recorded as ERROR. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

export async function runProbe(def: ProbeDefinition): Promise<CapabilityRecord> {
  const started = performance.now();
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let outcome: ProbeOutcome;

  try {
    outcome = await withTimeout(Promise.resolve(def.run()), timeoutMs, def.id);
  } catch (err) {
    const durationMs = round2(performance.now() - started);
    return {
      id: def.id,
      group: def.group,
      label: def.label,
      state: CapabilityState.ERROR,
      method: DetectionMethod.FUNCTIONAL_PROBE,
      detail: `probe threw after ${durationMs} ms`,
      data: {},
      error: describeError(err),
      durationMs,
      timestamp: Date.now(),
    };
  }

  return {
    id: def.id,
    group: def.group,
    label: def.label,
    state: outcome.state,
    method: outcome.method,
    detail: outcome.detail,
    data: (toJsonSafe(outcome.data ?? {}) as Record<string, JsonValue>) ?? {},
    durationMs: round2(performance.now() - started),
    timestamp: Date.now(),
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Present/absent as an outcome, with the method fixed to PRESENCE_CHECK so a
 *  symbol-existence result can never be mistaken for a behavioural one. */
export function presence(present: boolean, detail: string, data?: Record<string, unknown>): ProbeOutcome {
  return {
    state: present ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    method: DetectionMethod.PRESENCE_CHECK,
    detail,
    ...(data ? { data } : {}),
  };
}

export function functional(
  state: CapabilityState,
  detail: string,
  data?: Record<string, unknown>,
): ProbeOutcome {
  return {
    state,
    method: DetectionMethod.FUNCTIONAL_PROBE,
    detail,
    ...(data ? { data } : {}),
  };
}
