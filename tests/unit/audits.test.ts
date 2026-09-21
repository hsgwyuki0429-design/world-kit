/**
 * The audits are the mechanical half of §80. An audit that silently passes everything is
 * worse than no audit, so these tests plant the exact violations the audits exist to catch
 * and assert a non-zero exit.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function runAudit(script: string, ...targets: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [script, ...targets], { encoding: 'utf-8', stdio: 'pipe' });
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

  it('rejects a fusion filter reading the sensors directly (IMU-005, §H.7)', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'tests/fixtures/arch-src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('ReadsTheSensor');
    expect(r.out).toContain('fusion');
  });

  it('rejects a mapping module reaching the tracker (KEY-002, §H.7)', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'tests/fixtures/arch-src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('PeeksAtTheHarness');
    expect(r.out).toContain('mapping');
  });

  it('passes over the real src/ tree', () => {
    const r = runAudit('scripts/audit-architecture.mjs', 'src');
    expect(r.code).toBe(0);
  });
});

/**
 * The guides are the tester's instrument, and an instrument may not name a word the phone does
 * not show. The fixture plants one reference of each kind the audit has to tell apart.
 */
describe('audit-guide-labels', () => {
  it('reports a guide that names a label no screen renders any more', () => {
    const r = runAudit('scripts/audit-guide-labels.mjs', 'tests/fixtures/guide-ui', 'tests/fixtures/guide-docs');
    expect(r.code).toBe(1);
    expect(r.out).toContain('消えたラベル');
    // ...and only that one. A control built from a phase name and a fixed tail is a real label
    // that appears nowhere in the source as one string, and `… へ進む` is a shape, not a label.
    expect(r.out).toContain('1 NOT ON ANY SCREEN');
    expect(r.out).not.toContain('特徴点検出へ進む');
    expect(r.out).not.toContain('検出回数');
  });

  it('passes over the real guides and the real screens', () => {
    // This is the direction that can be checked without guessing: the guides quote the labels
    // in Japanese, so every such quotation is a label and has to still exist. The drift it was
    // written after ran the other way — 169 quotations of the English labels the screens had
    // until they were translated — and that one is not mechanically separable from prose, so
    // it stays a review matter. Any future rename lands in this direction.
    const r = runAudit('scripts/audit-guide-labels.mjs');
    expect(r.code).toBe(0);
    expect(r.out).toContain('all present in src/ui');
  });
});

/**
 * The one string the automated legs and the screen both have to spell the same way.
 *
 * `expectLocked` reads the live button text and looks for the word a closed Phase Lock puts in
 * it (Rule 002, Rule 005). The screen writes that word from `controlLabels.ts`, but the leg is a
 * plain `.mjs` script outside the TypeScript build and cannot import it, so it carries a copy.
 *
 * A drift between the two is not silent — `expectLocked` throws when the label does not contain
 * the word, so the leg goes red. What it is, is *late and expensive*: the legs are eleven minutes
 * of CI and they run after `npm test`, so a one-word rename is found by a Playwright timeout on a
 * built bundle rather than by a string comparison that takes a millisecond. This test is the
 * millisecond version.
 *
 * The genuinely quiet failure of the same rename is in `controlLabels.ts`: CAP-0011 hunting for a
 * word nobody displays any more would have reported a control as failing to state its reason
 * while it stated it perfectly well, on the device, as a Phase 0 failure.
 */
describe('the locked-control vocabulary', () => {
  it('is spelled the same in the screen and in the automated leg', async () => {
    const { LOCKED_LABEL } = await import('../../src/core/controlLabels');
    const harness = readFileSync('scripts/lib/harness.mjs', 'utf-8');
    expect(harness).toContain(`includes('${LOCKED_LABEL}')`);
  });
});
