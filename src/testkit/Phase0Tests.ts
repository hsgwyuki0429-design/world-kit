/**
 * Phase 0 test suite — CAP-0001..CAP-0013.
 *
 * The `TestSpec` literals below are transcribed from `docs/phase0/TEST-PLAN.md`, which was
 * written before any of this code existed (§29). They are data, not prose: the runner
 * evaluates the live capability matrix against them, so a criterion cannot quietly drift to
 * fit whatever the device happened to report.
 *
 * Every evaluator returns PASS, FAIL or PENDING. PENDING is used whenever the answer is not
 * yet knowable — it holds the phase at TESTING and never rounds up to PASS.
 */

import { CapabilityState, DetectionMethod, PhaseState, Verdict } from '../core/types';
import type {
  CapabilityMatrix,
  CapabilityRecord,
  JsonValue,
  TestResult,
  TestSpec,
} from '../core/types';
import { findIntegrityIssues } from '../core/validate';
import { isPhaseImplemented } from '../core/PhaseRegistry';
import type { PhaseRegistry } from '../core/PhaseRegistry';
import type { Evaluation, PhaseTest } from './runTests';
import { runTests } from './runTests';

/** What the UI is currently offering the user, so a test can compare it to engine state. */
export interface UiStateSnapshot {
  readonly startScanDisabled: boolean;
  readonly startScanLabel: string;
}

export interface Phase0Context {
  readonly matrix: CapabilityMatrix;
  readonly registry: PhaseRegistry;
  readonly ui: UiStateSnapshot;
  /** Probe-budget ceiling in ms, from §H of the implementation plan. */
  readonly probeBudgetMs: number;
  /**
   * Everything destined for the evidence bundle except the test results themselves —
   * device info, the leg signals, state transitions and the log.
   *
   * CAP-0010 has to validate what will actually be saved, not just the capability matrix,
   * but it cannot validate a structure that contains its own result. So the draft is
   * everything else, and the app separately re-checks the assembled bundle and fails the
   * phase if anything survived. Optional so the suite stays unit-testable in isolation.
   */
  readonly evidenceDraft?: unknown;
}

type Phase0Test = PhaseTest<Phase0Context>;

/* -------------------------------------------------------------------------- */

function rec(ctx: Phase0Context, id: string): CapabilityRecord | undefined {
  return ctx.matrix.records.find((r) => r.id === id);
}

function missing(id: string): Evaluation {
  return {
    verdict: Verdict.FAIL,
    observed: `capability record "${id}" is absent from the matrix`,
    reason: 'a required capability was never probed, so its state is unknown (fail closed)',
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                        */
/* -------------------------------------------------------------------------- */

const CAP_0001: Phase0Test = {
  spec: {
    id: 'CAP-0001',
    title: 'Secure context / HTTPS',
    required: true,
    input: 'page load; window.isSecureContext and location.protocol',
    expected: 'window.isSecureContext === true',
    passCriteria: 'the page is running in a secure context',
    failureCondition: 'plain http on a non-localhost origin — camera can never work there',
  },
  evaluate: (ctx) => {
    const r = rec(ctx, 'platform.secureContext');
    if (!r) return missing('platform.secureContext');
    const secure = r.state === CapabilityState.AVAILABLE;
    return {
      verdict: secure ? Verdict.PASS : Verdict.FAIL,
      observed: `isSecureContext=${String(r.data['isSecureContext'])} at ${String(r.data['protocol'])}//${String(r.data['host'])}`,
      reason: secure
        ? 'secure context confirmed by direct measurement'
        : 'not a secure context; getUserMedia and DeviceMotion cannot function',
      metrics: { protocol: r.data['protocol'] ?? null, crossOriginIsolated: r.data['crossOriginIsolated'] ?? null },
    };
  },
};

const CAP_0002: Phase0Test = {
  spec: {
    id: 'CAP-0002',
    title: 'Camera API availability (API only, no permission prompt)',
    required: true,
    input: 'navigator.mediaDevices, getUserMedia, getSupportedConstraints()',
    expected: 'camera.getUserMedia = AVAILABLE and every constraint Phase 1/2 needs is supported',
    passCriteria: 'getUserMedia is a function, page is secure, no required constraint missing',
    failureCondition: 'mediaDevices undefined, getUserMedia missing, insecure, or a constraint missing',
  },
  evaluate: (ctx) => {
    const gum = rec(ctx, 'camera.getUserMedia');
    const sc = rec(ctx, 'camera.supportedConstraints');
    if (!gum) return missing('camera.getUserMedia');
    if (!sc) return missing('camera.supportedConstraints');
    const gumOk = gum.state === CapabilityState.AVAILABLE;
    const scOk = sc.state === CapabilityState.AVAILABLE;
    const missingConstraints = (sc.data['missing'] as JsonValue[] | undefined) ?? [];
    return {
      verdict: gumOk && scOk ? Verdict.PASS : Verdict.FAIL,
      observed: `getUserMedia=${gum.state}; constraints=${sc.state}` +
        (missingConstraints.length ? `; missing=${missingConstraints.join(',')}` : ''),
      reason: gumOk && scOk
        ? 'the camera API surface Phase 1 needs is present; opening a stream is deferred to CAM-001'
        : !gumOk
          ? `getUserMedia unusable: ${gum.detail}`
          : `required media constraints unsupported: ${missingConstraints.join(', ')}`,
      metrics: {
        supportedConstraintCount: sc.data['supportedCount'] ?? null,
        facingMode: sc.data['facingMode'] ?? null,
        frameRate: sc.data['frameRate'] ?? null,
      },
    };
  },
};

const CAP_0003: Phase0Test = {
  spec: {
    id: 'CAP-0003',
    title: 'WebGPU determined by functional probe',
    required: true,
    input: 'navigator.gpu.requestAdapter() then adapter.requestDevice()',
    expected: 'state AVAILABLE or UNAVAILABLE, decided by executing the API',
    passCriteria: 'state is AVAILABLE or UNAVAILABLE and method is FUNCTIONAL_PROBE',
    failureCondition: 'state UNKNOWN/ERROR, or decided from the UA string instead of the API',
  },
  evaluate: (ctx) => {
    const r = rec(ctx, 'graphics.webgpu');
    if (!r) return missing('graphics.webgpu');
    const determined = r.state === CapabilityState.AVAILABLE || r.state === CapabilityState.UNAVAILABLE;
    const probed = r.method === DetectionMethod.FUNCTIONAL_PROBE;
    return {
      verdict: determined && probed ? Verdict.PASS : Verdict.FAIL,
      observed: `${r.state} via ${r.method} — ${r.detail}`,
      reason: determined && probed
        ? 'WebGPU state was decided by actually calling the API; UNAVAILABLE is a passing ' +
          'outcome because §8 asks for a correct report, not for WebGPU to exist'
        : !determined
          ? `state is ${r.state}, which means the probe could not decide`
          : `state was reached by ${r.method}, not by executing the API`,
      metrics: {
        vendor: r.data['vendor'] ?? null,
        architecture: r.data['architecture'] ?? null,
        maxComputeInvocationsPerWorkgroup: r.data['maxComputeInvocationsPerWorkgroup'] ?? null,
        probeMs: r.durationMs,
      },
    };
  },
};

function evaluateSensor(ctx: Phase0Context, id: string, label: string): Evaluation {
  const r = rec(ctx, id);
  if (!r) return missing(id);

  if (r.state === CapabilityState.PERMISSION_REQUIRED || r.method === DetectionMethod.NOT_ATTEMPTED) {
    return {
      verdict: Verdict.PENDING,
      observed: `${r.state} — ${r.detail}`,
      reason: `${label} cannot be determined until the user taps the sensor probe; ` +
        'PENDING holds Phase 0 at TESTING rather than rounding up to PASS',
    };
  }
  if (r.state === CapabilityState.PERMISSION_DENIED) {
    return {
      verdict: Verdict.PASS,
      observed: `${r.state} — ${r.detail}`,
      reason: `${label} was correctly determined: the user denied it. §68 requires the ` +
        'engine to keep working vision-only, which a denial does not prevent',
      metrics: { permission: r.data['permission'] ?? null },
    };
  }
  if (r.state === CapabilityState.AVAILABLE) {
    const events = Number(r.data['eventsWithFiniteData'] ?? 0);
    const hz = Number(r.data['measuredHz'] ?? 0);
    const enough = events >= 5;
    return {
      verdict: enough ? Verdict.PASS : Verdict.FAIL,
      observed: `AVAILABLE with ${events} data-carrying events at ${hz} Hz`,
      reason: enough
        ? `${label} is AVAILABLE and proved it by delivering real, finite sensor samples`
        : `${label} claims AVAILABLE but only ${events} events carried finite data — ` +
          'a capability with no data is a fake capability',
      metrics: { eventCount: r.data['eventCount'] ?? null, measuredHz: hz, fields: r.data['fields'] ?? null },
    };
  }
  if (r.state === CapabilityState.UNAVAILABLE) {
    return {
      verdict: Verdict.PASS,
      observed: `UNAVAILABLE — ${r.detail}`,
      reason: `${label} was correctly determined to be unavailable; the engine will run ` +
        'vision-only and must display that state rather than implying IMU support',
      metrics: { eventCount: r.data['eventCount'] ?? null },
    };
  }
  return {
    verdict: Verdict.FAIL,
    observed: `${r.state} — ${r.detail}`,
    reason: `${label} ended in ${r.state}, which is not a determined capability`,
  };
}

const CAP_0004: Phase0Test = {
  spec: {
    id: 'CAP-0004',
    title: 'DeviceMotion determined after user gesture',
    required: true,
    input: 'user tap -> DeviceMotionEvent.requestPermission(), then a 2000 ms listen window',
    expected: 'a determined state; when granted, >= 5 events carrying finite sensor values',
    passCriteria: 'state in {AVAILABLE, UNAVAILABLE, PERMISSION_DENIED}; AVAILABLE requires real data',
    failureCondition: 'AVAILABLE claimed with no arriving events, or non-finite sample values',
  },
  evaluate: (ctx) => evaluateSensor(ctx, 'motion.deviceMotion', 'DeviceMotion'),
};

const CAP_0005: Phase0Test = {
  spec: {
    id: 'CAP-0005',
    title: 'DeviceOrientation determined after user gesture',
    required: true,
    input: 'user tap -> DeviceOrientationEvent.requestPermission(), then a 2000 ms listen window',
    expected: 'a determined state; when granted, >= 5 events with finite alpha/beta/gamma',
    passCriteria: 'state in {AVAILABLE, UNAVAILABLE, PERMISSION_DENIED}; AVAILABLE requires real data',
    failureCondition: 'AVAILABLE claimed with no arriving events, or non-finite sample values',
  },
  evaluate: (ctx) => evaluateSensor(ctx, 'motion.deviceOrientation', 'DeviceOrientation'),
};

const CAP_0006: Phase0Test = {
  spec: {
    id: 'CAP-0006',
    title: 'WebAssembly compiles and executes',
    required: true,
    input: 'a 41-byte hand-assembled module exporting add(i32,i32)->i32, instantiated at runtime',
    expected: 'add(2,3) === 5',
    passCriteria: 'instantiation succeeds and the export returns exactly 5',
    failureCondition: 'instantiation throws, or the result is not 5',
  },
  evaluate: (ctx) => {
    const r = rec(ctx, 'compute.webassembly');
    if (!r) return missing('compute.webassembly');
    const ok = r.state === CapabilityState.AVAILABLE && r.data['addResult'] === 5;
    return {
      verdict: ok ? Verdict.PASS : Verdict.FAIL,
      observed: `${r.state}; add(2,3) returned ${String(r.data['addResult'] ?? 'nothing')}`,
      reason: ok
        ? 'a real module was compiled and executed, so wasm is usable for Phase 3/4 hot loops'
        : `wasm did not execute correctly: ${r.error ?? r.detail}`,
      metrics: { moduleBytes: r.data['moduleBytes'] ?? null, probeMs: r.durationMs },
    };
  },
};

const CAP_0007: Phase0Test = {
  spec: {
    id: 'CAP-0007',
    title: 'Web Worker round-trip',
    required: true,
    input: 'a Blob-URL worker; post {ping: token}; 3000 ms timeout',
    expected: 'the same token echoes back',
    passCriteria: 'echo matches and arrives before the timeout',
    failureCondition: 'timeout, error event, or token mismatch',
  },
  evaluate: (ctx) => {
    const r = rec(ctx, 'compute.worker');
    if (!r) return missing('compute.worker');
    const ok = r.state === CapabilityState.AVAILABLE && r.data['tokenMatched'] === true;
    return {
      verdict: ok ? Verdict.PASS : Verdict.FAIL,
      observed: `${r.state} — ${r.detail}`,
      reason: ok
        ? 'workers function, so §21 (no long image processing on the UI thread) is achievable'
        : 'without a working worker the frame pipeline would have to block the UI thread',
      metrics: { roundTripMs: r.data['roundTripMs'] ?? null },
    };
  },
};

const CAP_0008: Phase0Test = {
  spec: {
    id: 'CAP-0008',
    title: 'Offscreen pixel readback exactness',
    required: true,
    input: 'OffscreenCanvas(4,4) filled rgb(10,20,30); getImageData(1,1,1,1)',
    expected: 'exactly [10,20,30,255]',
    passCriteria: 'byte-exact readback; if OffscreenCanvas is absent, the declared main-thread fallback must be exact instead',
    failureCondition: 'no exact readback path exists on either route',
  },
  evaluate: (ctx) => {
    const off = rec(ctx, 'compute.offscreenCanvas');
    const fallback = rec(ctx, 'graphics.canvas2dReadback');
    if (!off) return missing('compute.offscreenCanvas');
    if (!fallback) return missing('graphics.canvas2dReadback');

    if (off.state === CapabilityState.AVAILABLE && off.data['exact'] === true) {
      const inWorker = rec(ctx, 'compute.offscreenInWorker');
      return {
        verdict: Verdict.PASS,
        observed: `OffscreenCanvas exact; worker transfer=${inWorker?.state ?? 'not probed'}`,
        reason: 'pixel readback is byte-exact, so grayscale conversion in Phase 2 will not ' +
          'be corrupted by colour management',
        metrics: {
          offscreenPixel: off.data['pixel'] ?? null,
          workerTransfer: inWorker?.state ?? null,
        },
      };
    }
    const fbExact = fallback.state === CapabilityState.AVAILABLE && fallback.data['exact'] === true;
    return {
      verdict: fbExact ? Verdict.PASS : Verdict.FAIL,
      observed: `OffscreenCanvas=${off.state}; main-thread fallback=${fallback.state}`,
      reason: fbExact
        ? 'OffscreenCanvas is unusable, but the declared main-thread fallback is byte-exact; ' +
          'Phase 2 must run canvas work on the UI thread and report OFFSCREEN: UNAVAILABLE'
        : 'neither readback path is exact, so no trustworthy grayscale source exists',
      metrics: { fallbackPixel: fallback.data['pixel'] ?? null },
    };
  },
};

const CAP_0009: Phase0Test = {
  spec: {
    id: 'CAP-0009',
    title: 'Depth / ARKit / RoomPlan / Scale honesty',
    required: true,
    input: 'the completed capability matrix',
    expected: 'depth, ARKit, RoomPlan reported UNAVAILABLE unless a real API was found; metric scale UNKNOWN',
    passCriteria: 'no unsupported claim of availability, and none of these records uses INFERENCE',
    failureCondition: 'any AVAILABLE without a probe that found a real API, or scale != UNKNOWN in Phase 0',
  },
  evaluate: (ctx) => {
    const ids = ['spatial.webxr', 'spatial.nativeBridge', 'spatial.cameraDepth', 'spatial.arkit', 'spatial.roomplan', 'spatial.metricScale'];
    const records = ids.map((id) => ({ id, r: rec(ctx, id) }));
    const absent = records.filter((x) => !x.r).map((x) => x.id);
    if (absent.length) return missing(absent.join(', '));

    const problems: string[] = [];
    const bridge = rec(ctx, 'spatial.nativeBridge');
    const depth = rec(ctx, 'spatial.cameraDepth');
    const arkit = rec(ctx, 'spatial.arkit');
    const roomplan = rec(ctx, 'spatial.roomplan');
    const scale = rec(ctx, 'spatial.metricScale');

    // Availability may only be claimed when the probe actually found something.
    if (depth?.state === CapabilityState.AVAILABLE) {
      const keys = (depth.data['depthConstraintKeys'] as JsonValue[] | undefined) ?? [];
      if (keys.length === 0) problems.push('cameraDepth claims AVAILABLE with no depth API found');
    }
    if (arkit?.state === CapabilityState.AVAILABLE && bridge?.state !== CapabilityState.AVAILABLE) {
      problems.push('ARKit claims AVAILABLE with no native bridge present');
    }
    if (roomplan?.state === CapabilityState.AVAILABLE && bridge?.state !== CapabilityState.AVAILABLE) {
      problems.push('RoomPlan claims AVAILABLE with no native bridge present');
    }
    if (scale?.state !== CapabilityState.UNKNOWN) {
      problems.push(`metric scale is ${scale?.state}, but Phase 0 has measured nothing that could supply scale`);
    }
    for (const { id, r } of records) {
      if (r && r.method === DetectionMethod.INFERENCE) {
        problems.push(`${id} was decided by INFERENCE, which may not back a pass criterion`);
      }
    }

    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `depth=${depth?.state}, arkit=${arkit?.state}, roomplan=${roomplan?.state}, ` +
        `scale=${scale?.state}, webxr=${rec(ctx, 'spatial.webxr')?.state}, bridge=${bridge?.state}`,
      reason: problems.length === 0
        ? 'nothing is claimed that the platform cannot actually provide; DEPTH, ARKit and ' +
          'RoomPlan are reported as measured absences and SCALE stays UNKNOWN (§44, §90)'
        : problems.join('; '),
      metrics: {
        nativeBridgeHandlers: bridge?.data['handlerNames'] ?? null,
        depthConstraintKeys: depth?.data['depthConstraintKeys'] ?? null,
        scaleStatus: scale?.data['scaleStatus'] ?? null,
      },
    };
  },
};

const CAP_0010: Phase0Test = {
  spec: {
    id: 'CAP-0010',
    title: 'Matrix integrity, export and round-trip',
    required: true,
    input: 'the capability matrix plus the evidence draft (device, leg signals, transitions, log)',
    expected: 'JSON round-trips exactly; no NaN/Infinity/undefined; every record has id, state, method, timestamp',
    passCriteria: 'round-trip deep-equality, zero integrity issues, complete records, no INFERENCE backing a criterion',
    failureCondition: 'any violation',
  },
  evaluate: (ctx) => {
    const problems: string[] = [];

    const issues = findIntegrityIssues(ctx.matrix, '$.capabilityMatrix');
    if (ctx.evidenceDraft !== undefined) {
      issues.push(...findIntegrityIssues(ctx.evidenceDraft, '$.evidenceDraft'));
    }
    if (issues.length) {
      problems.push(
        `${issues.length} integrity issue(s): ` +
          issues.slice(0, 5).map((i) => `${i.path}=${i.problem}`).join(', '),
      );
    }

    let roundTripEqual = false;
    try {
      const subject = ctx.evidenceDraft ?? ctx.matrix;
      const serialised = JSON.stringify(subject);
      roundTripEqual = JSON.stringify(JSON.parse(serialised)) === serialised;
      if (!roundTripEqual) problems.push('JSON round-trip is not stable');
    } catch (err) {
      problems.push(`evidence is not serialisable: ${String(err)}`);
    }

    for (const r of ctx.matrix.records) {
      if (!r.id) problems.push('a record has an empty id');
      if (!r.state) problems.push(`record ${r.id} has no state`);
      if (!r.method) problems.push(`record ${r.id} has no detection method`);
      if (!Number.isFinite(r.timestamp) || r.timestamp <= 0) {
        problems.push(`record ${r.id} has an invalid timestamp`);
      }
      if (!r.detail) problems.push(`record ${r.id} has no detail text`);
    }

    const inferenceIds = ctx.matrix.records
      .filter((r) => r.method === DetectionMethod.INFERENCE)
      .map((r) => r.id);
    // Inference records are allowed to exist, and are expected to: the UA guess is one.
    // What is not allowed is an inference record standing behind a pass criterion, which
    // CAP-0003 and CAP-0009 check directly for the capabilities they cover.
    const criterionIds = new Set([
      'platform.secureContext', 'camera.getUserMedia', 'camera.supportedConstraints',
      'graphics.webgpu', 'motion.deviceMotion', 'motion.deviceOrientation',
      'compute.webassembly', 'compute.worker', 'compute.offscreenCanvas',
      'graphics.canvas2dReadback', 'spatial.cameraDepth', 'spatial.arkit',
      'spatial.roomplan', 'spatial.metricScale',
    ]);
    for (const id of inferenceIds) {
      if (criterionIds.has(id)) problems.push(`${id} backs a pass criterion but uses INFERENCE`);
    }

    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed: `${ctx.matrix.records.length} records; draftChecked=${ctx.evidenceDraft !== undefined}; ` +
        `roundTripStable=${roundTripEqual}; integrityIssues=${issues.length}; ` +
        `inferenceRecords=[${inferenceIds.join(', ')}]`,
      reason: problems.length === 0
        ? 'the matrix is complete, finite and losslessly savable, so §7 "the matrix is ' +
          'savable" is a checked property rather than a claim'
        : problems.join('; '),
      metrics: {
        recordCount: ctx.matrix.records.length,
        integrityIssueCount: issues.length,
        integrityIssuePaths: issues.slice(0, 10).map((i) => `${i.path}=${i.problem}`),
        evidenceDraftChecked: ctx.evidenceDraft !== undefined,
        inferenceRecordIds: inferenceIds,
        totalProbeMs: ctx.matrix.totalDurationMs,
      },
    };
  },
};

const CAP_0011: Phase0Test = {
  spec: {
    id: 'CAP-0011',
    title: 'Phase Lock blocks Phase 1 while Phase 0 is unpassed',
    required: true,
    input: 'PhaseRegistry state and the rendered START SCAN control',
    expected: 'registry refuses entry to Phase 1, and the UI control agrees with the registry',
    passCriteria: 'canEnter(1) === false while Phase 0 is not PASSED; the control is disabled whenever entry is forbidden or Phase 1 is unimplemented, and its label says which',
    failureCondition: 'the UI offers an action the registry forbids, or forbids one it allows',
  },
  evaluate: (ctx) => {
    const phase0 = ctx.registry.get(0);
    const phase1 = ctx.registry.get(1);
    const canEnter1 = ctx.registry.canEnter(1);
    const phase1Implemented = isPhaseImplemented(1);

    // Two independent reasons the control must be unavailable, recomputed here from the
    // registry rather than read from the UI, so the UI cannot define its own correctness.
    const shouldBeDisabled = !canEnter1 || !phase1Implemented;
    const uiAgrees = ctx.ui.startScanDisabled === shouldBeDisabled;

    const lockCorrect = phase0.state === PhaseState.PASSED ? canEnter1 : !canEnter1;
    const problems: string[] = [];
    if (!lockCorrect) {
      problems.push(`registry allows entry to Phase 1 while Phase 0 is ${phase0.state}`);
    }
    if (!uiAgrees) {
      problems.push(
        `UI/engine disagreement: startScanDisabled=${ctx.ui.startScanDisabled} but the ` +
          `engine requires disabled=${shouldBeDisabled} (canEnter=${canEnter1}, ` +
          `implemented=${phase1Implemented})`,
      );
    }
    // A disabled control still has to tell the truth about *why* it is disabled.
    if (shouldBeDisabled) {
      const label = ctx.ui.startScanLabel.toUpperCase();
      const statesReason =
        (!phase1Implemented && label.includes('NOT IMPLEMENTED')) ||
        (!canEnter1 && (label.includes('LOCKED') || label.includes('BLOCKED')));
      if (!statesReason) {
        problems.push(
          `the disabled control's label "${ctx.ui.startScanLabel}" does not state why it ` +
            'is unavailable, which leaves the user to guess at engine state',
        );
      }
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed: `phase0=${phase0.state}, phase1=${phase1.state}, canEnter(1)=${canEnter1}, ` +
        `startScanDisabled=${ctx.ui.startScanDisabled} ("${ctx.ui.startScanLabel}")`,
      reason: problems.length === 0
        ? 'Phase Lock holds and the UI reflects engine state exactly, so there is no control ' +
          'that could imply capability the engine does not have'
        : problems.join('; '),
      metrics: {
        phase0State: phase0.state,
        phase1State: phase1.state,
        canEnterPhase1: canEnter1,
        phase1Implemented,
        startScanDisabled: ctx.ui.startScanDisabled,
      },
    };
  },
};

const CAP_0012: Phase0Test = {
  spec: {
    id: 'CAP-0012',
    title: 'Probe budget',
    required: false,
    input: 'summed duration of all non-gesture probes',
    expected: '<= 1500 ms',
    passCriteria: 'within budget',
    failureCondition: 'exceeded — advisory only, a slow adapter query is a performance fact',
  },
  evaluate: (ctx) => {
    const gestureIds = new Set(['motion.deviceMotion', 'motion.deviceOrientation']);
    const total = ctx.matrix.records
      .filter((r) => !gestureIds.has(r.id))
      .reduce((acc, r) => acc + r.durationMs, 0);
    const rounded = Math.round(total * 100) / 100;
    const slowest = [...ctx.matrix.records]
      .filter((r) => !gestureIds.has(r.id))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 3)
      .map((r) => `${r.id}=${r.durationMs}ms`);
    const within = rounded <= ctx.probeBudgetMs;
    return {
      verdict: within ? Verdict.PASS : Verdict.FAIL,
      observed: `${rounded} ms of probing (budget ${ctx.probeBudgetMs} ms); slowest: ${slowest.join(', ')}`,
      reason: within ? 'capability detection is within its time budget' : 'capability detection exceeded its budget',
      metrics: { totalProbeMs: rounded, budgetMs: ctx.probeBudgetMs, slowest },
    };
  },
};

const CAP_0013: Phase0Test = {
  spec: {
    id: 'CAP-0013',
    title: 'Video input device enumeration',
    required: false,
    input: 'navigator.mediaDevices.enumerateDevices()',
    expected: 'at least one videoinput entry (labels may be hidden before permission)',
    passCriteria: 'videoInputCount >= 1',
    failureCondition: 'zero video inputs — advisory, since an empty pre-permission list is a known browser behaviour',
  },
  evaluate: (ctx) => {
    const r = rec(ctx, 'camera.enumerateDevices');
    if (!r) return missing('camera.enumerateDevices');
    const count = Number(r.data['videoInputCount'] ?? 0);
    return {
      verdict: count >= 1 ? Verdict.PASS : Verdict.FAIL,
      observed: `${count} videoinput device(s); labelsHidden=${String(r.data['labelsHidden'])}`,
      reason: count >= 1
        ? 'at least one camera is enumerable before permission'
        : 'no cameras enumerated; this is inconclusive before permission is granted, so it ' +
          'is advisory. If Phase 1 CAM-002 also fails to open a stream, that pair is the real signal',
      metrics: {
        videoInputCount: count,
        labelsHidden: r.data['labelsHidden'] ?? null,
        totalDevices: r.data['totalDevices'] ?? null,
      },
    };
  },
};

export const PHASE0_TESTS: readonly Phase0Test[] = [
  CAP_0001, CAP_0002, CAP_0003, CAP_0004, CAP_0005, CAP_0006,
  CAP_0007, CAP_0008, CAP_0009, CAP_0010, CAP_0011, CAP_0012, CAP_0013,
];

export const PHASE0_SPECS: readonly TestSpec[] = PHASE0_TESTS.map((t) => t.spec);

export function runPhase0Tests(ctx: Phase0Context): TestResult[] {
  return runTests(PHASE0_TESTS, ctx);
}
