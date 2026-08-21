/**
 * Phase 1 logic and test harness.
 *
 * The camera itself cannot be exercised in node, but the three things most likely to be
 * wrong can: the error mapping (which decides whether a denial is reported as a denial),
 * the MAD thresholds (which decide whether a frozen image passes as a live camera), and
 * the harness's willingness to say PASS when it should say PENDING.
 */

import { describe, expect, it } from 'vitest';
import { Verdict } from '../../src/core/types';
import {
  CameraState,
  CONSTRAINT_LADDER,
  mapCameraError,
  mappedErrorNames,
} from '../../src/capture/CameraSource';
import {
  evaluateImageChange,
  MAD_ABSOLUTE_FLOOR,
  MIN_SAMPLES_FOR_MOTION,
  REQUIRED_CAPTURE_MS,
} from '../../src/capture/FrameIntegrityMonitor';
import type { FrameStats } from '../../src/capture/FrameIntegrityMonitor';
import { runPhase1Tests } from '../../src/testkit/Phase1Tests';
import type { Phase1Context } from '../../src/testkit/Phase1Tests';
import type { LedgerEntry } from '../../src/capture/ScenarioLedger';

/* -------------------------------------------------------------------------- */

function stats(over: Partial<FrameStats> = {}): FrameStats {
  return {
    frameCount: 900, firstFrameAt: 0, lastFrameAt: 30_000, observedMs: 30_000,
    meanFps: 30, maxGapMs: 60, source: 'requestVideoFrameCallback',
    sampleCount: 120, madMin: 0.4, madMedian: 1.1, madMean: 6.2, madMax: 42.5,
    lumaMin: 40, lumaMax: 160,
    hiddenCount: 0, wasEverHidden: false,
    orientationChanges: 1, lastOrientationAngle: 90,
    framesAfterLastOrientationChange: 120, msFromOrientationChangeToNextFrame: 33,
    sampleCostMsMean: 0.4,
    ...over,
  };
}

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    scenario: 'GRANTED', at: Date.now(), origin: 'https://example.test',
    appVersion: '0.1.0', detail: 'detail', observedDirectly: true, ageMs: 0,
    ...over,
  };
}

function ctx(over: Partial<Phase1Context> = {}): Phase1Context {
  return {
    cameraState: CameraState.LIVE,
    openResult: {
      state: CameraState.LIVE, stream: {} as MediaStream,
      settings: {
        width: 1280, height: 720, frameRate: 30, facingMode: 'environment',
        deviceId: 'abc', label: 'Back Camera', aspectRatio: 1.778,
      },
      rungUsed: 1, attempts: [], failure: null, totalDurationMs: 120,
    },
    trackLive: true,
    videoWidth: 1280,
    videoHeight: 720,
    stats: stats(),
    granted: entry(),
    denied: entry({ scenario: 'DENIED', observedDirectly: false, ageMs: 120_000 }),
    previewPresented: true,
    cameraEverOpened: true,
    cameraEndedUnexpectedly: false,
    ...over,
  };
}

function verdictOf(c: Phase1Context, id: string): Verdict {
  const r = runPhase1Tests(c).find((x) => x.spec.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r.verdict;
}

/* -------------------------------------------------------------------------- */

describe('camera error mapping (§57, CAM-006)', () => {
  it('maps a denial to CAMERA_PERMISSION_DENIED, never to unavailable', () => {
    for (const name of ['NotAllowedError', 'PermissionDeniedError', 'SecurityError']) {
      const f = mapCameraError(Object.assign(new Error('x'), { name }));
      expect(f.state, name).toBe(CameraState.PERMISSION_DENIED);
      expect(f.unmapped).toBe(false);
    }
  });

  it('maps hardware, constraint and policy failures to CAMERA_UNAVAILABLE', () => {
    // NotSupportedError is in this list, not the denial list: Chromium raises it when the
    // request is refused by policy. "Nobody would service this" is not "the user said no",
    // and reporting it as a denial would send the user to a permission screen that has
    // nothing to change. It was added after a CI runner produced it.
    for (const name of [
      'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError',
      'NotSupportedError',
    ]) {
      expect(mapCameraError(Object.assign(new Error('x'), { name })).state, name).toBe(
        CameraState.UNAVAILABLE,
      );
    }
  });

  it('fails closed on an unrecognised name, and says that it was unrecognised', () => {
    const f = mapCameraError(Object.assign(new Error('x'), { name: 'SomeFutureError' }));
    expect(f.state).toBe(CameraState.UNAVAILABLE);
    expect(f.unmapped).toBe(true);
    expect(f.recovery).toContain('not in the error mapping table');
  });

  it('every mapped state carries a non-empty recovery action (§27)', () => {
    for (const name of mappedErrorNames()) {
      const f = mapCameraError(Object.assign(new Error('x'), { name }));
      expect(f.recovery.length, name).toBeGreaterThan(10);
    }
  });
});

describe('constraint ladder (§9 nearest fallback)', () => {
  it('starts at the rear camera at 1280x720 and ends at anything', () => {
    expect(CONSTRAINT_LADDER).toHaveLength(4);
    const first = CONSTRAINT_LADDER[0]?.constraints.video as MediaTrackConstraints;
    expect(first.facingMode).toEqual({ exact: 'environment' });
    expect(first.width).toEqual({ ideal: 1280 });
    expect(first.height).toEqual({ ideal: 720 });
    expect(CONSTRAINT_LADDER[3]?.constraints.video).toBe(true);
  });

  it('loosens monotonically, never asks for audio', () => {
    for (const rung of CONSTRAINT_LADDER) expect(rung.constraints.audio).toBe(false);
  });
});

describe('CAM-004 — a frozen or fake stream must not pass as a live camera', () => {
  it('passes on real motion well above the noise floor', () => {
    const r = evaluateImageChange(stats());
    expect(r.evaluable && r.changed).toBe(true);
  });

  it('rejects a frozen image: difference never leaves the noise floor', () => {
    const r = evaluateImageChange(stats({ madMin: 0, madMedian: 0.02, madMean: 0.03, madMax: 0.09 }));
    expect(r.changed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/frozen image/);
  });

  it('rejects an all-black stream even if it flickers', () => {
    const r = evaluateImageChange(stats({ lumaMin: 0, lumaMax: 1.2 }));
    expect(r.changed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/black/);
  });

  it('accepts a camera panned continuously — the regression the ratio gate caused', () => {
    // Constant motion raises the median along with the peak. The removed
    // `maxMad >= 4 x medianMad` rule failed this, which is the clearest possible
    // demonstration of a live camera. See the amendment in docs/phase1/TEST-PLAN.md.
    const r = evaluateImageChange(stats({ madMin: 5, madMedian: 20, madMax: 24 }));
    expect(r.changed).toBe(true);
  });

  it('rejects a camera pointed at a motionless scene — below the floor', () => {
    // A real, live camera on a static wall: noise survives downsampling only faintly.
    const r = evaluateImageChange(stats({ madMin: 0.3, madMedian: 0.9, madMax: 2.4 }));
    expect(r.changed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/never moved/);
  });

  it('the floor sits above every static case and below every moving one', () => {
    const staticCases = [0.09, 2.4, 5.0, 6.8];
    const movingCases = [12, 24, 40, 60];
    for (const m of staticCases) expect(m).toBeLessThan(MAD_ABSOLUTE_FLOOR);
    for (const m of movingCases) expect(m).toBeGreaterThan(MAD_ABSOLUTE_FLOOR);
  });

  it('is not evaluable before enough samples, and does not guess', () => {
    const r = evaluateImageChange(stats({ sampleCount: MIN_SAMPLES_FOR_MOTION - 1 }));
    expect(r.evaluable).toBe(false);
    expect(r.changed).toBe(false);
  });
});

describe('CAM-003 — 30 seconds of continuous capture', () => {
  it('passes a full clean window', () => {
    expect(verdictOf(ctx(), 'CAM-003')).toBe(Verdict.PASS);
  });

  it('is PENDING while the window is still filling', () => {
    expect(verdictOf(ctx({ stats: stats({ observedMs: 12_000 }) }), 'CAM-003')).toBe(Verdict.PENDING);
  });

  it('FAILS when the page was backgrounded — not excluded as an interruption', () => {
    const c = ctx({ stats: stats({ wasEverHidden: true, hiddenCount: 1 }) });
    const r = runPhase1Tests(c).find((x) => x.spec.id === 'CAM-003');
    expect(r?.verdict).toBe(Verdict.FAIL);
    expect(r?.reason).toMatch(/backgrounded/);
  });

  it('FAILS on a stall longer than the tolerance', () => {
    expect(verdictOf(ctx({ stats: stats({ maxGapMs: 3200 }) }), 'CAM-003')).toBe(Verdict.FAIL);
  });

  it('FAILS below the 15 fps floor', () => {
    expect(verdictOf(ctx({ stats: stats({ meanFps: 9 }) }), 'CAM-003')).toBe(Verdict.FAIL);
  });

  it('PASSES a full window even after the user stops the camera', () => {
    // Stopping after a complete window does not undo the demonstration.
    expect(verdictOf(ctx({ trackLive: false }), 'CAM-003')).toBe(Verdict.PASS);
    expect(REQUIRED_CAPTURE_MS).toBe(30_000);
  });

  it('is PENDING, not FAIL, when no stream was ever opened — the denied run', () => {
    const c = ctx({
      cameraEverOpened: false,
      trackLive: false,
      cameraState: CameraState.PERMISSION_DENIED,
      stats: stats({ frameCount: 0, observedMs: 0, meanFps: 0, sampleCount: 0, source: 'none' }),
    });
    const r = runPhase1Tests(c).find((x) => x.spec.id === 'CAM-003');
    expect(r?.verdict).toBe(Verdict.PENDING);
    expect(r?.reason).toMatch(/absence of an attempt/);
  });

  it('is PENDING when the user stopped short of the window', () => {
    const c = ctx({ trackLive: false, stats: stats({ observedMs: 9000 }) });
    const r = runPhase1Tests(c).find((x) => x.spec.id === 'CAM-003');
    expect(r?.verdict).toBe(Verdict.PENDING);
    expect(r?.reason).toMatch(/hold it for the full 30 s/);
  });

  it('FAILS when the track ended on its own before the window filled', () => {
    const c = ctx({
      trackLive: false,
      cameraEndedUnexpectedly: true,
      stats: stats({ observedMs: 12_000 }),
    });
    const r = runPhase1Tests(c).find((x) => x.spec.id === 'CAM-003');
    expect(r?.verdict).toBe(Verdict.FAIL);
    expect(r?.reason).toMatch(/ended on its own/);
  });
});

describe('CAM-001 / CAM-002 — the two scenarios are independent', () => {
  it('CAM-002 is PENDING when only the granted path was seen', () => {
    expect(verdictOf(ctx({ denied: null }), 'CAM-002')).toBe(Verdict.PENDING);
  });

  it('CAM-001 is PENDING when only the denied path was seen', () => {
    const c = ctx({ granted: null, cameraState: CameraState.PERMISSION_DENIED, trackLive: false });
    expect(verdictOf(c, 'CAM-001')).toBe(Verdict.PENDING);
  });

  it('CAM-002 FAILS if an image is still presented after a denial (Rule 002)', () => {
    const c = ctx({
      cameraState: CameraState.PERMISSION_DENIED,
      trackLive: false,
      previewPresented: true,
      denied: entry({ scenario: 'DENIED', observedDirectly: true }),
      openResult: {
        state: CameraState.PERMISSION_DENIED, stream: null, settings: null, rungUsed: null,
        attempts: [],
        failure: {
          state: CameraState.PERMISSION_DENIED, errorName: 'NotAllowedError',
          message: 'denied', recovery: 'no stream is held', unmapped: false,
        },
        totalDurationMs: 10,
      },
    });
    const r = runPhase1Tests(c).find((x) => x.spec.id === 'CAM-002');
    expect(r?.verdict).toBe(Verdict.FAIL);
    expect(r?.reason).toMatch(/image is presented/);
  });

  it('CAM-002 FAILS if a stream is still held after a denial', () => {
    const c = ctx({
      cameraState: CameraState.PERMISSION_DENIED,
      trackLive: true,
      previewPresented: false,
      denied: entry({ scenario: 'DENIED', observedDirectly: true }),
      openResult: {
        state: CameraState.PERMISSION_DENIED, stream: {} as MediaStream, settings: null,
        rungUsed: null, attempts: [],
        failure: {
          state: CameraState.PERMISSION_DENIED, errorName: 'NotAllowedError',
          message: 'denied', recovery: 'r', unmapped: false,
        },
        totalDurationMs: 10,
      },
    });
    expect(verdictOf(c, 'CAM-002')).toBe(Verdict.FAIL);
  });

  it('flags a carried-over result rather than presenting it as this run', () => {
    const r = runPhase1Tests(ctx()).find((x) => x.spec.id === 'CAM-002');
    expect(r?.verdict).toBe(Verdict.PASS);
    expect(r?.metrics['observedDirectly']).toBe(false);
    expect(r?.reason).toMatch(/carried over/);
  });

  it('CAM-001 FAILS on a zero-size stream that claims to be live', () => {
    expect(verdictOf(ctx({ videoWidth: 0, videoHeight: 0 }), 'CAM-001')).toBe(Verdict.FAIL);
  });
});

describe('CAM-005 — orientation', () => {
  it('is PENDING until a rotation happens', () => {
    const c = ctx({ stats: stats({ orientationChanges: 0, msFromOrientationChangeToNextFrame: null }) });
    expect(verdictOf(c, 'CAM-005')).toBe(Verdict.PENDING);
  });

  it('FAILS if capture stalled across the rotation', () => {
    const c = ctx({
      stats: stats({ framesAfterLastOrientationChange: 0, msFromOrientationChangeToNextFrame: null }),
    });
    expect(verdictOf(c, 'CAM-005')).toBe(Verdict.FAIL);
  });

  it('FAILS if the next frame took too long', () => {
    expect(
      verdictOf(ctx({ stats: stats({ msFromOrientationChangeToNextFrame: 3500 }) }), 'CAM-005'),
    ).toBe(Verdict.FAIL);
  });
});

describe('suite shape', () => {
  it('every result carries the full §61 record fields', () => {
    for (const r of runPhase1Tests(ctx())) {
      expect(r.spec.input).toBeTruthy();
      expect(r.spec.expected).toBeTruthy();
      expect(r.spec.passCriteria).toBeTruthy();
      expect(r.spec.failureCondition).toBeTruthy();
      expect(r.observed).toBeTruthy();
      expect(r.reason).toBeTruthy();
    }
  });

  it('a fully healthy run passes every required test', () => {
    const results = runPhase1Tests(ctx());
    expect(results.filter((r) => r.spec.required && r.verdict !== Verdict.PASS)).toEqual([]);
  });
});
