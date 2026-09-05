/**
 * Evidence naming and leg determination.
 *
 * The filename test exists because of a real incident: a bundle was exported before the
 * gesture-gated sensor probe had run, so it recorded TESTING with two required tests
 * PENDING, and its name was indistinguishable from a passing export. Phase verdicts are
 * filed from these names.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { evidenceFilename } from '../../src/debug/EvidenceRecorder';
import { EvidenceLeg, PhaseState } from '../../src/core/types';

import type { EvidenceBundle } from '../../src/core/types';

function bundle(overrides: Partial<EvidenceBundle>): EvidenceBundle {
  return {
    schemaVersion: 1,
    leg: EvidenceLeg.REAL_DEVICE,
    phase: 0,
    phaseName: 'Environment / Capability',
    createdAt: '2026-08-21T07:57:50.291Z',
    appVersion: '0.1.0',
    buildCommit: 'unknown',
    origin: 'https://example.test',
    secureContext: true,
    device: {} as EvidenceBundle['device'],
    capabilityMatrix: { records: [], startedAt: 1, completedAt: 2, totalDurationMs: 1 },
    testResults: [],
    overallVerdict: PhaseState.TESTING,
    overallReason: '',
    stateTransitions: [],
    errorLog: [],
    fullLog: [],
    ...overrides,
  };
}

describe('evidenceFilename', () => {
  it('names the verdict so a pending export cannot be filed as a pass', () => {
    const pendingName = evidenceFilename(bundle({ overallVerdict: PhaseState.TESTING }));
    const passName = evidenceFilename(bundle({ overallVerdict: PhaseState.PASSED }));

    expect(pendingName).toContain('TESTING');
    expect(passName).toContain('PASSED');
    expect(pendingName).not.toBe(passName);
  });

  it('names the leg, so a desktop export cannot be filed as device evidence', () => {
    expect(evidenceFilename(bundle({ leg: EvidenceLeg.REAL_DEVICE }))).toContain('real-device');
    expect(evidenceFilename(bundle({ leg: EvidenceLeg.DESKTOP_DEV }))).toContain('desktop-dev');
  });

  it('produces a filesystem-safe name (iOS strips nothing it needs)', () => {
    const name = evidenceFilename(bundle({ overallVerdict: PhaseState.FAILED }));
    expect(name).toBe('phase0-real-device-FAILED-2026-08-21T07-57-50-291Z.json');
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('bundle assembly', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sorts state transitions chronologically regardless of merge order', async () => {
    // determineLeg and the bundle read location/navigator/window; stub the minimum so the
    // assembly logic can be exercised outside a browser.
    vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost', origin: 'http://localhost' });
    vi.stubGlobal('navigator', { webdriver: true });
    vi.stubGlobal('window', { isSecureContext: true });

    const { buildEvidenceBundle } = await import('../../src/debug/EvidenceRecorder');
    // Simulates the real defect: transitions merged from two sources arriving out of order,
    // which put a TESTING->PASSED entry ahead of the IMPLEMENTING->TESTING that preceded it.
    const out = buildEvidenceBundle({
      phase: 0,
      phaseName: 'Environment / Capability',
      appVersion: '0.0.0',
      device: { maxTouchPoints: 0, isLikelyIOS: false } as never,
      matrix: { records: [], startedAt: 1, completedAt: 2, totalDurationMs: 1 },
      testResults: [],
      overallVerdict: PhaseState.TESTING,
      overallReason: '',
      transitions: [
        { timestamp: 300, subject: 'phase[0]', from: 'TESTING', to: 'PASSED', reason: 'r3' },
        { timestamp: 100, subject: 'phase[0]', from: 'NOT_STARTED', to: 'IMPLEMENTING', reason: 'r1' },
        { timestamp: 200, subject: 'phase[0]', from: 'IMPLEMENTING', to: 'TESTING', reason: 'r2' },
      ],
      log: [],
    });
    expect(out.bundle.stateTransitions.map((t) => t.timestamp)).toEqual([100, 200, 300]);
  });
});
