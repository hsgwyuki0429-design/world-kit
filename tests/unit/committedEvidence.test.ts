/**
 * Validation of the evidence bundles committed under docs/phase0/evidence/.
 *
 * §106 says an AI may not declare a pass on its own say-so, and §8 says the matrix must
 * match measurement. Both are only enforceable if the committed file is checked rather
 * than read. So this suite re-derives the verdict from the bundle's own test results using
 * the same `PhaseRegistry.evaluate` the app uses, and refuses to accept `overallVerdict`
 * as an input to that decision — a hand-edited "PASSED" is caught by the re-derivation
 * disagreeing with the results it claims to summarise.
 *
 * It runs in `npm test`, so committed evidence stays checked as the code evolves.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityState, DetectionMethod, EvidenceLeg, PhaseState, Verdict } from '../../src/core/types';
import type { CapabilityRecord, EvidenceBundle } from '../../src/core/types';
import { PhaseRegistry } from '../../src/core/PhaseRegistry';
import { findIntegrityIssues } from '../../src/core/validate';

const EVIDENCE_DIR = join(process.cwd(), 'docs', 'phase0', 'evidence');

function loadBundles(): { file: string; bundle: EvidenceBundle }[] {
  return readdirSync(EVIDENCE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => ({
      file,
      bundle: JSON.parse(readFileSync(join(EVIDENCE_DIR, file), 'utf-8')) as EvidenceBundle,
    }));
}

const bundles = loadBundles();

function rec(b: EvidenceBundle, id: string): CapabilityRecord | undefined {
  return b.capabilityMatrix.records.find((r) => r.id === id);
}

describe('committed evidence', () => {
  it('there is at least one bundle to check', () => {
    expect(bundles.length).toBeGreaterThan(0);
  });

  describe.each(bundles)('$file', ({ file, bundle }) => {
    it('the filename states the leg and verdict the file actually contains', () => {
      expect(file).toContain(bundle.leg === EvidenceLeg.REAL_DEVICE ? 'real-device' : 'desktop');
      if (file.includes('real-device')) expect(file).toContain(bundle.overallVerdict);
    });

    it('the verdict re-derives from its own test results — it is not taken on trust', () => {
      const rederived = PhaseRegistry.evaluate(bundle.testResults, bundle.leg);
      expect(rederived.state).toBe(bundle.overallVerdict);
    });

    it('the leg classification is consistent with its own recorded signals (Rule 004)', () => {
      const s = (bundle as unknown as { legDetermination: { signals: Record<string, unknown> } })
        .legDetermination.signals;
      if (bundle.leg === EvidenceLeg.REAL_DEVICE) {
        expect(s['protocol']).toBe('https:');
        expect(s['isLocalHost']).toBe(false);
        expect(s['navigatorWebdriver']).toBe(false);
        expect(s['uaSuggestsIOS']).toBe(true);
        expect(Number(s['maxTouchPoints'])).toBeGreaterThan(0);
        expect(bundle.secureContext).toBe(true);
      }
    });

    it('contains no NaN, infinity, undefined or reference cycle (§84)', () => {
      expect(findIntegrityIssues(bundle, '$')).toEqual([]);
    });

    it('every capability record is complete', () => {
      expect(bundle.capabilityMatrix.records.length).toBeGreaterThan(0);
      for (const r of bundle.capabilityMatrix.records) {
        expect(r.id, 'id').toBeTruthy();
        expect(r.state, `${r.id} state`).toBeTruthy();
        expect(r.method, `${r.id} method`).toBeTruthy();
        expect(r.detail, `${r.id} detail`).toBeTruthy();
        expect(r.timestamp, `${r.id} timestamp`).toBeGreaterThan(0);
        expect(Number.isFinite(r.durationMs), `${r.id} durationMs`).toBe(true);
      }
    });

    it('no INFERENCE record stands behind a pass criterion', () => {
      const criterionIds = [
        'platform.secureContext', 'camera.getUserMedia', 'camera.supportedConstraints',
        'graphics.webgpu', 'motion.deviceMotion', 'motion.deviceOrientation',
        'compute.webassembly', 'compute.worker', 'compute.offscreenCanvas',
        'spatial.cameraDepth', 'spatial.arkit', 'spatial.roomplan', 'spatial.metricScale',
      ];
      for (const id of criterionIds) {
        const r = rec(bundle, id);
        if (r) expect(r.method, id).not.toBe(DetectionMethod.INFERENCE);
      }
    });

    it('claims nothing the platform cannot provide (§80 anti-fake invariants)', () => {
      const bridge = rec(bundle, 'spatial.nativeBridge');
      const depth = rec(bundle, 'spatial.cameraDepth');
      const scale = rec(bundle, 'spatial.metricScale');

      expect(scale?.state, 'metric scale must stay UNKNOWN in Phase 0').toBe(
        CapabilityState.UNKNOWN,
      );
      for (const id of ['spatial.arkit', 'spatial.roomplan']) {
        const r = rec(bundle, id);
        if (r?.state === CapabilityState.AVAILABLE) {
          expect(bridge?.state, `${id} claims AVAILABLE`).toBe(CapabilityState.AVAILABLE);
        }
      }
      if (depth?.state === CapabilityState.AVAILABLE) {
        expect((depth.data['depthConstraintKeys'] as unknown[])?.length).toBeGreaterThan(0);
      }
    });

    it('an AVAILABLE sensor is backed by real, finite samples — never a bare constructor', () => {
      for (const id of ['motion.deviceMotion', 'motion.deviceOrientation']) {
        const r = rec(bundle, id);
        if (r?.state !== CapabilityState.AVAILABLE) continue;

        expect(r.method, id).toBe(DetectionMethod.FUNCTIONAL_PROBE);
        expect(Number(r.data['eventsWithFiniteData']), `${id} events`).toBeGreaterThanOrEqual(5);
        expect(Number(r.data['measuredHz']), `${id} rate`).toBeGreaterThan(0);

        // Every number in the recorded sample must be finite — a sensor reporting NaN is
        // worse than a sensor reporting nothing, because it looks like data.
        const sample = r.data['firstSample'];
        expect(sample, `${id} firstSample`).toBeTruthy();
        expect(findIntegrityIssues(sample, `$.${id}.firstSample`)).toEqual([]);
      }
    });

    it('the error log is present and, if non-empty, every entry names its recovery', () => {
      expect(Array.isArray(bundle.errorLog)).toBe(true);
      for (const e of bundle.errorLog) expect(e.recovery, e.message).toBeTruthy();
    });

    it('records the state transitions that produced the verdict (§60)', () => {
      expect(bundle.stateTransitions.length).toBeGreaterThan(0);
      for (const t of bundle.stateTransitions) {
        expect(t.reason, `${t.subject} ${t.from}->${t.to}`).toBeTruthy();
        expect(t.timestamp).toBeGreaterThan(0);
      }
    });
  });
});

describe('Phase 0 pass evidence', () => {
  const passing = bundles.filter(
    (b) => b.bundle.leg === EvidenceLeg.REAL_DEVICE && b.bundle.overallVerdict === PhaseState.PASSED,
  );

  it('exists — Phase 0 may only be marked PASSED against a real-device bundle', () => {
    expect(passing.length).toBeGreaterThan(0);
  });

  describe.each(passing)('$file', ({ bundle }) => {
    it('every required test passed, and none was left PENDING', () => {
      const required = bundle.testResults.filter((r) => r.spec.required);
      expect(required.length).toBeGreaterThanOrEqual(11);
      expect(required.filter((r) => r.verdict !== Verdict.PASS)).toEqual([]);
    });

    it('both gesture-gated sensor tests were actually determined, not skipped', () => {
      for (const id of ['CAP-0004', 'CAP-0005']) {
        const r = bundle.testResults.find((t) => t.spec.id === id);
        expect(r?.verdict, id).toBe(Verdict.PASS);
        expect(r?.observed, id).not.toContain('PERMISSION_REQUIRED');
      }
    });

    it('Phase Lock had opened Phase 1, and the UI still refused to offer it', () => {
      const lock = bundle.testResults.find((t) => t.spec.id === 'CAP-0011');
      expect(lock?.metrics['phase0State']).toBe(PhaseState.PASSED);
      expect(lock?.metrics['canEnterPhase1']).toBe(true);
      // Phase 1 is unwritten, so the control must stay disabled despite the lock opening.
      expect(lock?.metrics['phase1Implemented']).toBe(false);
      expect(lock?.metrics['startScanDisabled']).toBe(true);
    });

    it('ran clean — no errors logged during the passing run', () => {
      expect(bundle.errorLog).toEqual([]);
    });
  });
});
