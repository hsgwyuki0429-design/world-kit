import { describe, expect, it } from 'vitest';
import {
  findIntegrityIssues,
  isValidConfidence,
  isFiniteNumber,
  toJsonSafe,
  describeError,
} from '../../src/core/validate';

describe('validate (§84 data integrity)', () => {
  it('accepts a clean structure', () => {
    expect(findIntegrityIssues({ a: 1, b: [2, 3], c: { d: 'x', e: null } })).toEqual([]);
  });

  it('finds NaN and Infinity at any depth, and reports every one', () => {
    const issues = findIntegrityIssues({
      pose: { position: [1, Number.NaN, 3] },
      landmarks: [{ confidence: Number.POSITIVE_INFINITY }],
    });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path).sort()).toEqual([
      '$.landmarks[0].confidence',
      '$.pose.position[1]',
    ]);
    expect(issues.map((i) => i.problem).sort()).toEqual(['NaN', 'non-finite']);
  });

  it('flags undefined and unserialisable values', () => {
    const issues = findIntegrityIssues({ a: undefined, b: () => 1, c: Symbol('s') });
    expect(issues.map((i) => i.problem).sort()).toEqual([
      'undefined',
      'unserializable function',
      'unserializable symbol',
    ]);
  });

  it('does not mistake a shared reference for a cycle', () => {
    // The evidence bundle genuinely does this: a test's metrics quote an array that also
    // lives in the capability matrix. That is a DAG, and JSON.stringify handles it by
    // writing the value twice, so it must not be reported as an integrity failure.
    const shared = [1, 2, 3];
    expect(findIntegrityIssues({ a: shared, b: shared, c: { d: shared } })).toEqual([]);
  });

  it('detects circular references instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const issues = findIntegrityIssues(a);
    expect(issues.some((i) => i.problem === 'circular reference')).toBe(true);
  });

  it('detects a cycle through an array and through a longer chain', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(findIntegrityIssues(arr).some((i) => i.problem === 'circular reference')).toBe(true);

    const x: Record<string, unknown> = {};
    const y: Record<string, unknown> = { x };
    const z: Record<string, unknown> = { y };
    x['z'] = z;
    expect(findIntegrityIssues(z).some((i) => i.problem === 'circular reference')).toBe(true);
  });

  it('confidence must be a real number in [0,1] (§31)', () => {
    expect(isValidConfidence(0)).toBe(true);
    expect(isValidConfidence(1)).toBe(true);
    expect(isValidConfidence(0.5)).toBe(true);
    expect(isValidConfidence(1.0001)).toBe(false);
    expect(isValidConfidence(-0.0001)).toBe(false);
    expect(isValidConfidence(Number.NaN)).toBe(false);
    expect(isValidConfidence('0.5')).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('toJsonSafe preserves the fact that a platform reported a non-finite value', () => {
    expect(toJsonSafe({ q: Number.POSITIVE_INFINITY })).toEqual({ q: 'NON_FINITE(Infinity)' });
    expect(toJsonSafe({ q: Number.NaN })).toEqual({ q: 'NON_FINITE(NaN)' });
    expect(toJsonSafe({ nested: { arr: [1, undefined, 'x'] } })).toEqual({
      nested: { arr: [1, null, 'x'] },
    });
  });

  it('describeError normalises anything thrown', () => {
    expect(describeError(new TypeError('bad'))).toBe('TypeError: bad');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ code: 7 })).toBe('{"code":7}');
  });
});
