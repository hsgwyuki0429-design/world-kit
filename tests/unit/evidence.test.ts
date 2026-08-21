/**
 * Evidence naming and leg determination.
 *
 * The filename test exists because of a real incident: a bundle was exported before the
 * gesture-gated sensor probe had run, so it recorded TESTING with two required tests
 * PENDING, and its name was indistinguishable from a passing export. Phase verdicts are
 * filed from these names.
 */

import { describe, expect, it } from 'vitest';
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
