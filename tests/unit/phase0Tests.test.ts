/**
 * Tests for the Phase 0 test harness itself.
 *
 * The suite in `Phase0Tests.ts` is what stands between "the device reported this" and
 * "Phase 0 passed", so it is worth attacking directly. Each case below feeds the harness a
 * capability matrix that a careless or dishonest implementation would produce, and asserts
 * that the harness refuses it.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityState, DetectionMethod, PhaseState, Verdict } from '../../src/core/types';
import type { CapabilityMatrix, CapabilityRecord, JsonValue } from '../../src/core/types';
import { PhaseRegistry } from '../../src/core/PhaseRegistry';
import { runPhase0Tests } from '../../src/testkit/Phase0Tests';
import type { Phase0Context, UiStateSnapshot } from '../../src/testkit/Phase0Tests';

type Overrides = Record<string, Partial<CapabilityRecord> & { data?: Record<string, JsonValue> }>;

function record(
  id: string,
  group: CapabilityRecord['group'],
  state: CapabilityState,
  method: DetectionMethod,
  data: Record<string, JsonValue> = {},
): CapabilityRecord {
  return {
    id,
    group,
    label: id,
    state,
    method,
    detail: `synthetic record for ${id}`,
    data,
    durationMs: 3,
    timestamp: 1_700_000_000_000,
  };
}

/** A matrix in which everything is genuinely healthy, used as the baseline to perturb. */
function healthyMatrix(overrides: Overrides = {}): CapabilityMatrix {
  const base: CapabilityRecord[] = [
    record('platform.secureContext', 'platform', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      isSecureContext: true, protocol: 'https:', host: 'example.test', crossOriginIsolated: false,
    }),
    record('platform.iosSafariGuess', 'platform', CapabilityState.AVAILABLE, DetectionMethod.INFERENCE, {
      osGuess: 'iOS/iPadOS 26.0',
    }),
    record('camera.getUserMedia', 'camera', CapabilityState.AVAILABLE, DetectionMethod.PRESENCE_CHECK),
    record('camera.enumerateDevices', 'camera', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      videoInputCount: 2, labelsHidden: true, totalDevices: 3,
    }),
    record('camera.supportedConstraints', 'camera', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      supportedCount: 20, facingMode: true, frameRate: true, missing: [],
    }),
    record('camera.trackControl', 'camera', CapabilityState.AVAILABLE, DetectionMethod.PRESENCE_CHECK),
    record('motion.deviceMotion', 'motion', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      eventCount: 120, eventsWithFiniteData: 120, measuredHz: 59.8, fields: { rotationRate: true },
    }),
    record('motion.deviceOrientation', 'motion', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      eventCount: 118, eventsWithFiniteData: 118, measuredHz: 58.9,
    }),
    record('compute.webassembly', 'compute', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      addResult: 5, moduleBytes: 41,
    }),
    record('compute.worker', 'compute', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      tokenMatched: true, roundTripMs: 4.2,
    }),
    record('compute.offscreenCanvas', 'compute', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      exact: true, pixel: [10, 20, 30, 255],
    }),
    record('compute.offscreenInWorker', 'compute', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      exact: true,
    }),
    record('graphics.webgpu', 'graphics', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      vendor: 'apple', architecture: 'unreported', maxComputeInvocationsPerWorkgroup: 1024,
    }),
    record('graphics.canvas2dReadback', 'graphics', CapabilityState.AVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      exact: true, pixel: [10, 20, 30, 255],
    }),
    record('spatial.webxr', 'spatial', CapabilityState.UNAVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      hasNavigatorXr: false,
    }),
    record('spatial.nativeBridge', 'spatial', CapabilityState.UNAVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      handlerNames: [],
    }),
    record('spatial.cameraDepth', 'spatial', CapabilityState.UNAVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      depthConstraintKeys: [], webxrAvailable: false,
    }),
    record('spatial.arkit', 'spatial', CapabilityState.UNAVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      nativeBridgePresent: false,
    }),
    record('spatial.roomplan', 'spatial', CapabilityState.UNAVAILABLE, DetectionMethod.FUNCTIONAL_PROBE, {
      nativeBridgePresent: false,
    }),
    record('spatial.metricScale', 'spatial', CapabilityState.UNKNOWN, DetectionMethod.NOT_ATTEMPTED, {
      scaleStatus: 'UNKNOWN', units: 'LOCAL_UNITS',
    }),
  ];

  const records = base.map((r) => {
    const o = overrides[r.id];
    if (!o) return r;
    return { ...r, ...o, data: { ...r.data, ...(o.data ?? {}) } };
  });

  return {
    records: records.filter((r) => overrides[r.id]?.id !== '__DELETE__'),
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_400,
    totalDurationMs: records.reduce((a, r) => a + r.durationMs, 0),
  };
}

const LOCKED_UI: UiStateSnapshot = {
  startScanDisabled: true,
  startScanLabel: 'START SCAN — LOCKED',
};

function ctx(matrix: CapabilityMatrix, ui: UiStateSnapshot = LOCKED_UI): Phase0Context {
  return { matrix, registry: new PhaseRegistry(), ui, probeBudgetMs: 1500 };
}

function verdictOf(matrix: CapabilityMatrix, id: string, ui?: UiStateSnapshot): Verdict {
  const results = runPhase0Tests(ctx(matrix, ui));
  const r = results.find((x) => x.spec.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r.verdict;
}

describe('Phase 0 suite — happy path', () => {
  it('passes every required test on a genuinely healthy matrix', () => {
    const results = runPhase0Tests(ctx(healthyMatrix()));
    const failures = results.filter((r) => r.spec.required && r.verdict !== Verdict.PASS);
    expect(failures.map((f) => `${f.spec.id}: ${f.reason}`)).toEqual([]);
  });

  it('every result carries the full §61 record fields', () => {
    for (const r of runPhase0Tests(ctx(healthyMatrix()))) {
      expect(r.spec.input).toBeTruthy();
      expect(r.spec.expected).toBeTruthy();
      expect(r.spec.passCriteria).toBeTruthy();
      expect(r.spec.failureCondition).toBeTruthy();
      expect(r.observed).toBeTruthy();
      expect(r.reason).toBeTruthy();
      expect(r.timestamp).toBeGreaterThan(0);
    }
  });
});

describe('CAP-0001 secure context', () => {
  it('fails on plain http', () => {
    const m = healthyMatrix({
      'platform.secureContext': {
        state: CapabilityState.UNAVAILABLE,
        data: { isSecureContext: false, protocol: 'http:', host: '192.168.1.4:5173' },
      },
    });
    expect(verdictOf(m, 'CAP-0001')).toBe(Verdict.FAIL);
  });
});

describe('CAP-0003 WebGPU must be determined by probing, not guessed', () => {
  it('passes when WebGPU is genuinely absent — UNAVAILABLE is a correct report', () => {
    const m = healthyMatrix({
      'graphics.webgpu': { state: CapabilityState.UNAVAILABLE, method: DetectionMethod.FUNCTIONAL_PROBE },
    });
    expect(verdictOf(m, 'CAP-0003')).toBe(Verdict.PASS);
  });

  it('fails when the state was inferred from the user agent instead of probed', () => {
    const m = healthyMatrix({
      'graphics.webgpu': { state: CapabilityState.AVAILABLE, method: DetectionMethod.INFERENCE },
    });
    expect(verdictOf(m, 'CAP-0003')).toBe(Verdict.FAIL);
  });

  it('fails when the probe could not decide', () => {
    const m = healthyMatrix({
      'graphics.webgpu': { state: CapabilityState.UNKNOWN, method: DetectionMethod.FUNCTIONAL_PROBE },
    });
    expect(verdictOf(m, 'CAP-0003')).toBe(Verdict.FAIL);
  });
});

describe('CAP-0004/0005 a sensor capability requires arriving data', () => {
  it('is PENDING before the user gesture, and PENDING holds the phase at TESTING', () => {
    const m = healthyMatrix({
      'motion.deviceMotion': {
        state: CapabilityState.PERMISSION_REQUIRED,
        method: DetectionMethod.NOT_ATTEMPTED,
      },
    });
    expect(verdictOf(m, 'CAP-0004')).toBe(Verdict.PENDING);
    const evaluation = PhaseRegistry.evaluate(runPhase0Tests(ctx(m)), 'REAL_DEVICE');
    expect(evaluation.state).toBe(PhaseState.TESTING);
  });

  it('FAILS when AVAILABLE is claimed but no event ever carried data', () => {
    const m = healthyMatrix({
      'motion.deviceMotion': {
        state: CapabilityState.AVAILABLE,
        method: DetectionMethod.FUNCTIONAL_PROBE,
        data: { eventCount: 0, eventsWithFiniteData: 0, measuredHz: 0 },
      },
    });
    expect(verdictOf(m, 'CAP-0004')).toBe(Verdict.FAIL);
  });

  it('FAILS when events fired but only a couple carried finite values', () => {
    const m = healthyMatrix({
      'motion.deviceOrientation': {
        state: CapabilityState.AVAILABLE,
        data: { eventCount: 40, eventsWithFiniteData: 2, measuredHz: 20 },
      },
    });
    expect(verdictOf(m, 'CAP-0005')).toBe(Verdict.FAIL);
  });

  it('PASSES on an honest denial — vision-only is a valid outcome', () => {
    const m = healthyMatrix({
      'motion.deviceMotion': {
        state: CapabilityState.PERMISSION_DENIED,
        method: DetectionMethod.FUNCTIONAL_PROBE,
        data: { permission: 'denied' },
      },
    });
    expect(verdictOf(m, 'CAP-0004')).toBe(Verdict.PASS);
  });

  it('PASSES on an honest absence', () => {
    const m = healthyMatrix({
      'motion.deviceMotion': {
        state: CapabilityState.UNAVAILABLE,
        method: DetectionMethod.FUNCTIONAL_PROBE,
        data: { eventCount: 0 },
      },
    });
    expect(verdictOf(m, 'CAP-0004')).toBe(Verdict.PASS);
  });
});

describe('CAP-0006/0007/0008 behavioural probes', () => {
  it('fails wasm when the module returns the wrong answer', () => {
    const m = healthyMatrix({ 'compute.webassembly': { data: { addResult: 4 } } });
    expect(verdictOf(m, 'CAP-0006')).toBe(Verdict.FAIL);
  });

  it('fails the worker test on a token mismatch', () => {
    const m = healthyMatrix({ 'compute.worker': { data: { tokenMatched: false } } });
    expect(verdictOf(m, 'CAP-0007')).toBe(Verdict.FAIL);
  });

  it('accepts the declared main-thread fallback when OffscreenCanvas is absent', () => {
    const m = healthyMatrix({
      'compute.offscreenCanvas': {
        state: CapabilityState.UNAVAILABLE,
        data: { exact: false },
      },
    });
    expect(verdictOf(m, 'CAP-0008')).toBe(Verdict.PASS);
  });

  it('fails when neither readback path is byte-exact', () => {
    const m = healthyMatrix({
      'compute.offscreenCanvas': { state: CapabilityState.UNAVAILABLE, data: { exact: false } },
      'graphics.canvas2dReadback': { state: CapabilityState.AVAILABLE, data: { exact: false, pixel: [11, 20, 30, 255] } },
    });
    expect(verdictOf(m, 'CAP-0008')).toBe(Verdict.FAIL);
  });
});

describe('CAP-0009 honesty about depth, ARKit, RoomPlan and scale', () => {
  it('fails when ARKit is claimed with no native bridge — the §80 fake', () => {
    const m = healthyMatrix({
      'spatial.arkit': { state: CapabilityState.AVAILABLE },
    });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.FAIL);
  });

  it('fails when RoomPlan is claimed with no native bridge', () => {
    const m = healthyMatrix({ 'spatial.roomplan': { state: CapabilityState.AVAILABLE } });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.FAIL);
  });

  it('fails when depth is claimed with no depth API found', () => {
    const m = healthyMatrix({
      'spatial.cameraDepth': { state: CapabilityState.AVAILABLE, data: { depthConstraintKeys: [] } },
    });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.FAIL);
  });

  it('fails when metric scale is asserted in Phase 0 (§18, §90)', () => {
    const m = healthyMatrix({
      'spatial.metricScale': {
        state: CapabilityState.AVAILABLE,
        data: { scaleStatus: 'METRIC_SCALE_AVAILABLE' },
      },
    });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.FAIL);
  });

  it('fails when a spatial verdict rests on a user-agent inference', () => {
    const m = healthyMatrix({
      'spatial.cameraDepth': { method: DetectionMethod.INFERENCE },
    });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.FAIL);
  });

  it('passes when depth really is present — the probe found a real constraint', () => {
    const m = healthyMatrix({
      'spatial.cameraDepth': {
        state: CapabilityState.AVAILABLE,
        data: { depthConstraintKeys: ['depthNear', 'depthFar'] },
      },
    });
    expect(verdictOf(m, 'CAP-0009')).toBe(Verdict.PASS);
  });
});

describe('CAP-0010 matrix integrity', () => {
  it('fails on a non-finite value anywhere in the matrix (§84)', () => {
    const m = healthyMatrix({
      'graphics.webgpu': { data: { maxComputeInvocationsPerWorkgroup: Number.NaN as unknown as JsonValue } },
    });
    expect(verdictOf(m, 'CAP-0010')).toBe(Verdict.FAIL);
  });

  it('fails on a record missing its detection method', () => {
    const m = healthyMatrix({
      'compute.worker': { method: '' as unknown as DetectionMethod },
    });
    expect(verdictOf(m, 'CAP-0010')).toBe(Verdict.FAIL);
  });

  it('fails on an invalid timestamp', () => {
    const m = healthyMatrix({ 'compute.worker': { timestamp: 0 } });
    expect(verdictOf(m, 'CAP-0010')).toBe(Verdict.FAIL);
  });

  it('tolerates an inference record that backs nothing (the UA guess)', () => {
    expect(verdictOf(healthyMatrix(), 'CAP-0010')).toBe(Verdict.PASS);
  });

  it('fails when an inference record backs a pass criterion', () => {
    const m = healthyMatrix({
      'camera.getUserMedia': { method: DetectionMethod.INFERENCE },
    });
    expect(verdictOf(m, 'CAP-0010')).toBe(Verdict.FAIL);
  });
});

describe('CAP-0011 UI must agree with the engine', () => {
  it('fails when the UI offers START SCAN while the registry forbids Phase 1', () => {
    const ui: UiStateSnapshot = { startScanDisabled: false, startScanLabel: 'START SCAN' };
    expect(verdictOf(healthyMatrix(), 'CAP-0011', ui)).toBe(Verdict.FAIL);
  });

  it('fails when a disabled control hides the reason it is disabled', () => {
    const ui: UiStateSnapshot = { startScanDisabled: true, startScanLabel: 'START SCAN' };
    expect(verdictOf(healthyMatrix(), 'CAP-0011', ui)).toBe(Verdict.FAIL);
  });

  it('passes when the control is disabled and says why', () => {
    expect(verdictOf(healthyMatrix(), 'CAP-0011')).toBe(Verdict.PASS);
  });
});

describe('missing records fail closed', () => {
  it('treats an absent required capability as FAIL, not as absent-therefore-fine', () => {
    const m = healthyMatrix();
    const stripped: CapabilityMatrix = {
      ...m,
      records: m.records.filter((r) => r.id !== 'compute.webassembly'),
    };
    expect(verdictOf(stripped, 'CAP-0006')).toBe(Verdict.FAIL);
  });
});

describe('START SCAN control label (Rule 002)', () => {
  it('is disabled and says LOCKED while Phase Lock holds', async () => {
    const { startScanState } = await import('../../src/ui/Phase0Screen');
    const s = startScanState(false, {
      index: 0, name: 'Environment / Capability', state: PhaseState.TESTING,
      reason: 'CAP-0004 pending', updatedAt: 1,
    });
    expect(s.disabled).toBe(true);
    expect(s.label).toContain('LOCKED');
    expect(s.note).toContain('Rule 005');
  });

  it('opens once Phase 0 passes and Phase 1 exists', async () => {
    const { startScanState } = await import('../../src/ui/Phase0Screen');
    const s = startScanState(true, {
      index: 0, name: 'Environment / Capability', state: PhaseState.PASSED,
      reason: 'all required tests PASS on a real device', updatedAt: 1,
    });
    expect(s.disabled).toBe(false);
    expect(s.label).toBe('START SCAN');
  });

  it('the control is disabled exactly when entry is forbidden or the phase is unbuilt', async () => {
    const { startScanState } = await import('../../src/ui/Phase0Screen');
    const { isPhaseImplemented } = await import('../../src/core/PhaseRegistry');
    // The invariant, rather than either specific case: whichever of the two reasons holds,
    // the control must be unavailable and must say which. When Phase 2 work begins this
    // test keeps holding without being rewritten.
    for (const canEnter of [true, false]) {
      const s = startScanState(canEnter, {
        index: 0, name: 'Environment / Capability',
        state: canEnter ? PhaseState.PASSED : PhaseState.TESTING,
        reason: 'r', updatedAt: 1,
      });
      const shouldBeDisabled = !canEnter || !isPhaseImplemented(1);
      expect(s.disabled).toBe(shouldBeDisabled);
      if (shouldBeDisabled) {
        expect(s.label.toUpperCase()).toMatch(/LOCKED|NOT IMPLEMENTED/);
      }
    }
  });
});
