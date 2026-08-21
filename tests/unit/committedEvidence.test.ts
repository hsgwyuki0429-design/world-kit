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

const EVIDENCE_DIRS = [
  join(process.cwd(), 'docs', 'phase0', 'evidence'),
  join(process.cwd(), 'docs', 'phase1', 'evidence'),
];

function loadBundles(): { file: string; bundle: EvidenceBundle }[] {
  const out: { file: string; bundle: EvidenceBundle }[] = [];
  for (const dir of EVIDENCE_DIRS) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      out.push({
        file,
        bundle: JSON.parse(readFileSync(join(dir, file), 'utf-8')) as EvidenceBundle,
      });
    }
  }
  return out;
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
    (b) =>
      b.bundle.phase === 0 &&
      b.bundle.leg === EvidenceLeg.REAL_DEVICE &&
      b.bundle.overallVerdict === PhaseState.PASSED,
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

    it('Phase Lock had opened, and the UI agreed with the engine about the control', () => {
      const lock = bundle.testResults.find((t) => t.spec.id === 'CAP-0011');
      expect(lock?.metrics['phase0State']).toBe(PhaseState.PASSED);
      expect(lock?.metrics['canEnterPhase1']).toBe(true);
      // The invariant, not the historical values. This bundle was recorded when Phase 1 was
      // unwritten, so it shows implemented=false and the control disabled. A bundle
      // recorded now would show implemented=true and the control open — equally correct.
      // Asserting the specific pair would make a later, valid run fail this gate.
      const implemented = lock?.metrics['phase1Implemented'] === true;
      const canEnter = lock?.metrics['canEnterPhase1'] === true;
      expect(lock?.metrics['startScanDisabled']).toBe(!canEnter || !implemented);
    });

    it('ran clean — no errors logged during the passing run', () => {
      expect(bundle.errorLog).toEqual([]);
    });
  });
});

/**
 * Phase 1 coverage gate.
 *
 * CAM-001 and CAM-002 cannot both be observed in one session, so Phase 1 needs two device
 * runs. The in-app ledger carries an observation between runs for the tester's benefit;
 * this gate deliberately ignores it and requires each scenario to have been observed
 * *directly* in some committed bundle. A phase must not pass on a carried-over result.
 */
describe('Phase 1 evidence coverage', () => {
  const phase1Device = bundles.filter(
    (b) => b.bundle.phase === 1 && b.bundle.leg === EvidenceLeg.REAL_DEVICE,
  );

  it.runIf(phase1Device.length > 0)(
    'covers both permission scenarios with a direct observation',
    () => {
      const directly = (id: string): boolean =>
        phase1Device.some((b) =>
          b.bundle.testResults.some(
            (r) =>
              r.spec.id === id &&
              r.verdict === Verdict.PASS &&
              r.metrics['observedDirectly'] === true,
          ),
        );
      expect(directly('CAM-001'), 'CAM-001 observed directly in a committed bundle').toBe(true);
      expect(directly('CAM-002'), 'CAM-002 observed directly in a committed bundle').toBe(true);
    },
  );

  it.runIf(phase1Device.length > 0)('never passed Phase 1 through the dev override', () => {
    for (const { file, bundle } of phase1Device) {
      const ctxData = (bundle as unknown as { phaseContext?: { devEntry?: boolean } }).phaseContext;
      expect(ctxData?.devEntry ?? false, `${file} used the desktop dev override`).toBe(false);
    }
  });

  it('the desktop Phase 1 bundles record that they used a synthetic camera', () => {
    const desktop = bundles.filter(
      (b) => b.bundle.phase === 1 && b.bundle.leg === EvidenceLeg.DESKTOP_DEV,
    );
    for (const { file, bundle } of desktop) {
      const ctxData = (bundle as unknown as {
        phaseContext?: { devEntry?: boolean; camera?: Record<string, unknown> };
      }).phaseContext;
      // The dev override is how the desktop leg reaches Phase 1 at all, and it must be in
      // the record rather than invisible.
      expect(ctxData, `${file} has no phaseContext`).toBeTruthy();
      expect(typeof ctxData?.devEntry, `${file} devEntry`).toBe('boolean');
      expect(ctxData?.camera, `${file} camera context`).toBeTruthy();
    }
  });
});
