/**
 * Numeric and structural validators.
 *
 * §84 (Data Integrity): nothing with NaN, ±Infinity or a non-finite coordinate may
 * ever enter the persisted world or an evidence bundle. These helpers are the choke
 * point — validation happens at the boundary where data is *created*, not at read
 * time, so a bad value never gets stored in the first place.
 */

import type { JsonValue } from './types';

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A confidence must be a real number in [0,1] (§31). */
export function isValidConfidence(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= 1;
}

export function isValidTimestamp(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0;
}

export interface IntegrityIssue {
  readonly path: string;
  readonly problem: string;
  readonly value: string;
}

/**
 * Deep scan for values that must never be persisted.
 *
 * Catches NaN, ±Infinity, `undefined`, functions and symbols anywhere in the tree.
 * Returns every issue found (not just the first) so a failure report is actionable.
 */
export function findIntegrityIssues(root: unknown, rootPath = '$'): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  // Ancestors on the current path, not every object ever visited. Two properties can
  // legitimately point at the same array — a test's metrics quoting a value that also
  // lives in the capability matrix, say — and that serialises to JSON perfectly well as
  // two copies. Only a reference back into its own ancestry is a real cycle, and treating
  // sharing as a cycle would report integrity failures that do not exist.
  const ancestors = new Set<object>();

  const walk = (value: unknown, path: string): void => {
    if (value === null) return;
    const t = typeof value;

    if (t === 'number') {
      const n = value as number;
      if (Number.isNaN(n)) issues.push({ path, problem: 'NaN', value: 'NaN' });
      else if (!Number.isFinite(n)) {
        issues.push({ path, problem: 'non-finite', value: String(n) });
      }
      return;
    }
    if (t === 'undefined') {
      issues.push({ path, problem: 'undefined', value: 'undefined' });
      return;
    }
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      issues.push({ path, problem: `unserializable ${t}`, value: String(value) });
      return;
    }
    if (t !== 'object') return;

    const obj = value as object;
    if (ancestors.has(obj)) {
      issues.push({ path, problem: 'circular reference', value: '[circular]' });
      return;
    }
    ancestors.add(obj);

    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else {
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
    }
    ancestors.delete(obj);
  };

  walk(root, rootPath);
  return issues;
}

/**
 * Coerce an unknown runtime value into something JSON-safe for a capability record.
 *
 * Non-finite numbers become the string `"NON_FINITE(<value>)"` rather than being
 * dropped or zeroed: losing the fact that a platform reported Infinity would itself
 * be a small lie. Callers get a value they can store *and* see.
 */
export function toJsonSafe(value: unknown): JsonValue {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value as JsonValue;
  if (t === 'number') {
    const n = value as number;
    return Number.isFinite(n) ? n : `NON_FINITE(${String(n)})`;
  }
  if (t === 'undefined') return null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (t === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as object)) {
      if (typeof v === 'function') continue;
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return String(value);
}

/** Normalise a thrown value into a readable single-line string. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    return `${name}: ${err.message}`;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
