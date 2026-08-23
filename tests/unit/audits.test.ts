/**
 * The audits are the mechanical half of §80. An audit that silently passes everything is
 * worse than no audit, so these tests plant the exact violations the audits exist to catch
 * and assert a non-zero exit.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runAudit(script: string, target: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, target], { encoding: 'utf-8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('audit-fake-data', () => {
  it('rejects Math.random, fixed geometry and time-driven coverage/confidence', () => {
    const r = runAudit('scripts/audit-fake-data.mjs', 'tests/fixtures/fake-src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('MATH_RANDOM');
    expect(r.out).toContain('FIXED_GEOMETRY');
    expect(r.out).toContain('TIME_BASED_COVERAGE');
    expect(r.out).toContain('TIME_BASED_CONFIDENCE');
  });

  it('accepts code that uses the seeded Rng instead', () => {
    const r = runAudit('scripts/audit-fake-data.mjs', 'tests/fixtures/clean-src');
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 violations');
  });

  it('passes over the real src/ tree', () => {
    const r = runAudit('scripts/audit-fake-data.mjs', 'src');
    expect(r.code).toBe(0);
  });
});

describe('audit-architecture', () => {
  it('rejects a game module importing from tracking (§83)', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'tests/fixtures/arch-src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('game');
    expect(r.out).toContain('tracking');
  });

  it('rejects a geometry solver importing from tracking (GEO-003, §H.7)', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'tests/fixtures/arch-src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('PeeksAtTheTracker');
    expect(r.out).toContain('geometry');
  });

  it('passes over the real src/ tree', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'src');
    expect(r.code).toBe(0);
  });
});
