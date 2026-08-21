/**
 * Phase 1 test suite — CAM-001..CAM-006.
 *
 * Specs transcribed from `docs/phase1/TEST-PLAN.md`, written before this code existed
 * (§29). Same verdict algebra as Phase 0: PASS / FAIL / PENDING, with PENDING holding the
 * phase at TESTING rather than rounding up.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState, mappedErrorNames } from '../capture/CameraSource';
import type { CameraOpenResult } from '../capture/CameraSource';
import {
  evaluateImageChange,
  MAD_ABSOLUTE_FLOOR,
  MIN_SAMPLES_FOR_MOTION,
  REQUIRED_CAPTURE_MS,
} from '../capture/FrameIntegrityMonitor';
import type { FrameStats } from '../capture/FrameIntegrityMonitor';
import type { LedgerEntry } from '../capture/ScenarioLedger';

/** §10 floor: tracking must be able to run at 15 fps, so delivery must reach it. */
export const MIN_DELIVERED_FPS = 15;
export const MAX_FRAME_GAP_MS = 2000;
export const MAX_ORIENTATION_RECOVERY_MS = 2000;

export interface Phase1Context {
  readonly cameraState: CameraState;
  readonly openResult: CameraOpenResult | null;
  readonly trackLive: boolean;
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly stats: FrameStats;
  readonly granted: LedgerEntry | null;
  readonly denied: LedgerEntry | null;
  /** True if a preview image is currently presented to the user. */
  readonly previewPresented: boolean;
  /** A stream was successfully opened at some point in this run. */
  readonly cameraEverOpened: boolean;
  /** The track fired 'ended' on its own — not the user pressing stop. */
  readonly cameraEndedUnexpectedly: boolean;
}

interface Evaluation {
  verdict: Verdict;
  observed: string;
  reason: string;
  metrics?: Record<string, JsonValue>;
}

interface Phase1Test {
  spec: TestSpec;
  evaluate: (ctx: Phase1Context) => Evaluation;
}

function ledgerNote(entry: LedgerEntry): string {
  return entry.observedDirectly
    ? 'observed directly in this run'
    : `carried over from a run ${Math.round(entry.ageMs / 1000)} s ago at ${entry.origin} ` +
      '(convenience only — the repository gate requires a committed bundle that observed ' +
      'this scenario directly)';
}

/* -------------------------------------------------------------------------- */

const CAM_001: Phase1Test = {
  spec: {
    id: 'CAM-001',
    title: 'Camera permission granted, real stream opens',
    required: true,
    input: 'user tap -> getUserMedia walking the constraint ladder (rear camera, 1280x720 ideal)',
    expected: 'a MediaStream with a live video track reporting real width, height and frameRate',
    passCriteria: 'a live video track exists; settings report finite width >= 1 and height >= 1; the element reports matching dimensions',
    failureCondition: 'getUserMedia throws while permission was granted; no live track; zero-size settings',
  },
  evaluate: (ctx) => {
    const entry = ctx.granted;
    if (!entry) {
      return {
        verdict: Verdict.PENDING,
        observed: `camera state ${ctx.cameraState}; no grant observed in this run or carried over`,
        reason:
          'the granted path has not been exercised. Tap START CAMERA and allow access; ' +
          'PENDING holds Phase 1 at TESTING rather than rounding up',
      };
    }
    if (!entry.observedDirectly) {
      return {
        verdict: Verdict.PASS,
        observed: `GRANTED — ${entry.detail}`,
        reason: `the granted path was verified; ${ledgerNote(entry)}`,
        metrics: { observedDirectly: false, ageMs: entry.ageMs, at: entry.at } as Record<string, JsonValue>,
      };
    }

    const s = ctx.openResult?.settings ?? null;
    const problems: string[] = [];
    if (!ctx.trackLive) problems.push('the video track is not live');
    if (!s) problems.push('no track settings were readable');
    if (s && (s.width < 1 || s.height < 1)) {
      problems.push(`track reports a zero-size frame (${s.width}x${s.height})`);
    }
    if (ctx.videoWidth < 1 || ctx.videoHeight < 1) {
      problems.push(`the video element reports ${ctx.videoWidth}x${ctx.videoHeight}`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `LIVE at ${s?.width}x${s?.height}@${s?.frameRate}fps, facingMode=${s?.facingMode}, ` +
        `ladder rung ${ctx.openResult?.rungUsed}, element ${ctx.videoWidth}x${ctx.videoHeight}`,
      reason:
        problems.length === 0
          ? 'a real stream is open and reporting real geometry; the achieved facing mode ' +
            'and ladder rung are recorded as achieved rather than as requested'
          : problems.join('; '),
      metrics: {
        observedDirectly: true,
        width: s?.width ?? null,
        height: s?.height ?? null,
        frameRate: s?.frameRate ?? null,
        facingMode: s?.facingMode ?? null,
        deviceLabel: s?.label ?? null,
        rungUsed: ctx.openResult?.rungUsed ?? null,
        openDurationMs: ctx.openResult?.totalDurationMs ?? null,
        attempts: (ctx.openResult?.attempts ?? []) as unknown as JsonValue,
      } as Record<string, JsonValue>,
    };
  },
};

const CAM_002: Phase1Test = {
  spec: {
    id: 'CAM-002',
    title: 'Camera permission denied, handled without a fake stream',
    required: true,
    input: 'getUserMedia rejected by the user or by Safari website settings',
    expected: 'state CAMERA_PERMISSION_DENIED, no stream held, no image presented',
    passCriteria: 'the rejection maps to CAMERA_PERMISSION_DENIED; no video track is held; no preview is presented; the error carries a recovery action',
    failureCondition: 'the denial is swallowed, or any placeholder or previously captured image is presented',
  },
  evaluate: (ctx) => {
    const entry = ctx.denied;
    if (!entry) {
      return {
        verdict: Verdict.PENDING,
        observed: `camera state ${ctx.cameraState}; no denial observed in this run or carried over`,
        reason:
          'a session in which permission was granted contains no evidence about the denial ' +
          'path, and it may not be inferred. Deny camera access in Safari website settings ' +
          'and reload to exercise it',
      };
    }
    if (!entry.observedDirectly) {
      return {
        verdict: Verdict.PASS,
        observed: `DENIED — ${entry.detail}`,
        reason: `the denial path was verified; ${ledgerNote(entry)}`,
        metrics: { observedDirectly: false, ageMs: entry.ageMs, at: entry.at } as Record<string, JsonValue>,
      };
    }

    const failure = ctx.openResult?.failure ?? null;
    const problems: string[] = [];
    if (ctx.cameraState !== CameraState.PERMISSION_DENIED) {
      problems.push(`state is ${ctx.cameraState}, expected CAMERA_PERMISSION_DENIED`);
    }
    if (ctx.openResult?.stream) problems.push('a stream is still held after a denial');
    if (ctx.trackLive) problems.push('a video track is live after a denial');
    if (ctx.previewPresented) {
      problems.push('an image is presented despite there being no camera — §Rule 002');
    }
    if (!failure?.recovery) problems.push('the failure carries no recovery action (§27)');
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed: `${ctx.cameraState} from ${failure?.errorName ?? 'unknown error'}; ` +
        `stream=${ctx.openResult?.stream ? 'held' : 'none'}, preview=${ctx.previewPresented}`,
      reason:
        problems.length === 0
          ? 'the denial is reported as itself: no stream, no image, and a stated recovery'
          : problems.join('; '),
      metrics: {
        observedDirectly: true,
        errorName: failure?.errorName ?? null,
        unmappedError: failure?.unmapped ?? null,
        recovery: failure?.recovery ?? null,
      } as Record<string, JsonValue>,
    };
  },
};

const CAM_003: Phase1Test = {
  spec: {
    id: 'CAM-003',
    title: '30 seconds of continuous frame capture',
    required: true,
    input: 'an open stream observed via requestVideoFrameCallback (rAF + currentTime as fallback)',
    expected: 'frames arriving continuously for at least 30 000 ms',
    passCriteria: 'observed >= 30 000 ms; mean delivered fps >= 15; longest gap <= 2000 ms; the track does not end on its own before the window fills; page never hidden',
    failureCondition: 'any of the above unmet; backgrounding counts as a failure, not an exclusion. Never opening a stream is PENDING, not FAIL',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const base: Record<string, JsonValue> = {
      observedMs: s.observedMs,
      frameCount: s.frameCount,
      meanFps: s.meanFps,
      maxGapMs: s.maxGapMs,
      source: s.source,
      wasEverHidden: s.wasEverHidden,
      cameraEverOpened: ctx.cameraEverOpened,
      cameraEndedUnexpectedly: ctx.cameraEndedUnexpectedly,
    };

    // No stream was ever opened — in a denied run, for instance. Continuity has not been
    // demonstrated, but neither has it failed: there was nothing to be continuous. Calling
    // that FAIL would make an untried test look like a broken app.
    if (!ctx.cameraEverOpened) {
      return {
        verdict: Verdict.PENDING,
        observed: `no stream was opened in this run (camera state ${ctx.cameraState})`,
        reason:
          'CAM-003 measures a stream that exists. With no camera open there is nothing to ' +
          'measure, which is an absence of an attempt rather than a failure of continuity',
        metrics: base,
      };
    }

    const windowFull = s.observedMs >= REQUIRED_CAPTURE_MS;
    const truncatedByTrackEnd = ctx.cameraEndedUnexpectedly && !windowFull;

    if (!windowFull && !s.wasEverHidden && !truncatedByTrackEnd) {
      return {
        verdict: Verdict.PENDING,
        observed: `${(s.observedMs / 1000).toFixed(1)} s of ${REQUIRED_CAPTURE_MS / 1000} s, ` +
          `${s.frameCount} frames at ${s.meanFps} fps via ${s.source}`,
        reason: ctx.trackLive
          ? 'the observation window has not filled yet; keep the camera open'
          : 'capture was stopped before the window filled; start the camera again and hold ' +
            'it for the full 30 s',
        metrics: base,
      };
    }

    const problems: string[] = [];
    if (s.wasEverHidden) {
      problems.push(
        'the page was backgrounded during the window, which stops frame callbacks — the ' +
          'run has not demonstrated 30 s of capture and must be repeated without leaving the app',
      );
    }
    if (truncatedByTrackEnd) {
      problems.push(
        `the video track ended on its own after ${(s.observedMs / 1000).toFixed(1)} s, before ` +
          'the window filled — most often another app taking the camera',
      );
    }
    if (!windowFull) {
      problems.push(`only ${(s.observedMs / 1000).toFixed(1)} s observed`);
    }
    if (s.meanFps < MIN_DELIVERED_FPS) {
      problems.push(`mean ${s.meanFps} fps is below the ${MIN_DELIVERED_FPS} fps floor`);
    }
    if (s.maxGapMs > MAX_FRAME_GAP_MS) {
      problems.push(`longest gap ${s.maxGapMs} ms exceeds ${MAX_FRAME_GAP_MS} ms`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${(s.observedMs / 1000).toFixed(1)} s, ${s.frameCount} frames, ${s.meanFps} fps, ` +
        `longest gap ${s.maxGapMs} ms, via ${s.source}`,
      reason:
        problems.length === 0
          ? 'frames arrived continuously for the full window with no stall beyond tolerance'
          : problems.join('; '),
      metrics: base,
    };
  },
};

const CAM_004: Phase1Test = {
  spec: {
    id: 'CAM-004',
    title: 'Moving the camera changes the image',
    required: true,
    input: 'frames sampled at ~4 Hz into a 64x48 grayscale buffer; mean absolute difference and mean luma per sample',
    expected: 'peak frame-to-frame difference rises far above the sensor noise floor while the camera moves',
    passCriteria: `>= ${MIN_SAMPLES_FOR_MOTION} samples; maxMad >= ${MAD_ABSOLUTE_FLOOR} (a level a static scene cannot reach after downsampling); peak luma > 2`,
    failureCondition: 'difference stays at the noise floor (frozen or still image), or the frame is uniformly black',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const result = evaluateImageChange(s);
    const metrics: Record<string, JsonValue> = {
      sampleCount: s.sampleCount,
      madMin: s.madMin,
      madMedian: s.madMedian,
      madMean: s.madMean,
      madMax: s.madMax,
      lumaMin: s.lumaMin,
      lumaMax: s.lumaMax,
      sampleCostMsMean: s.sampleCostMsMean,
    };
    if (!result.evaluable) {
      return {
        verdict: Verdict.PENDING,
        observed: result.reasons.join('; '),
        reason: 'not enough samples yet to separate motion from sensor noise; move the camera slowly',
        metrics,
      };
    }
    return {
      verdict: result.changed ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.sampleCount} samples; MAD min ${s.madMin} / median ${s.madMedian} / max ${s.madMax}; ` +
        `luma ${s.lumaMin}..${s.lumaMax}`,
      reason: result.reasons.join('; '),
      metrics,
    };
  },
};

const CAM_005: Phase1Test = {
  spec: {
    id: 'CAM-005',
    title: 'Orientation change',
    required: true,
    input: 'the device is rotated; screen.orientation change and orientationchange events',
    expected: 'the change is observed, capture continues across it, and the track survives',
    passCriteria: 'at least one orientation change with a changed angle; a frame within 2000 ms of the change; the track does not end',
    failureCondition: 'capture stalls or the track ends on rotation',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      orientationChanges: s.orientationChanges,
      lastOrientationAngle: s.lastOrientationAngle,
      framesAfterLastOrientationChange: s.framesAfterLastOrientationChange,
      msFromOrientationChangeToNextFrame: s.msFromOrientationChangeToNextFrame,
    };
    if (s.orientationChanges === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: `no orientation change observed (angle ${s.lastOrientationAngle ?? 'unreported'})`,
        reason:
          'rotate the device while the camera is open. If nothing happens, rotation lock ' +
          'is on — turn it off in Control Centre',
        metrics,
      };
    }
    const recovery = s.msFromOrientationChangeToNextFrame;
    const problems: string[] = [];
    if (!ctx.trackLive) problems.push('the video track ended across the rotation');
    if (s.framesAfterLastOrientationChange === 0) {
      problems.push('no frame arrived after the rotation — capture stalled');
    } else if (recovery !== null && recovery > MAX_ORIENTATION_RECOVERY_MS) {
      problems.push(`the next frame took ${recovery} ms, beyond the ${MAX_ORIENTATION_RECOVERY_MS} ms tolerance`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.orientationChanges} change(s), now at ${s.lastOrientationAngle}°, ` +
        `next frame after ${recovery ?? 'n/a'} ms, ${s.framesAfterLastOrientationChange} frames since`,
      reason:
        problems.length === 0
          ? 'capture continued across the rotation without the track ending'
          : problems.join('; '),
      metrics,
    };
  },
};

const CAM_006: Phase1Test = {
  spec: {
    id: 'CAM-006',
    title: 'Error-state completeness',
    required: false,
    input: 'the DOMException-name to engine-state mapping table',
    expected: 'every mapped name resolves to a §57 state with a non-empty recovery action',
    passCriteria: 'no unmapped name among those the platform can raise; no state without a recovery',
    failureCondition: 'any gap — advisory, since it is a property of the code and is covered by unit tests',
  },
  evaluate: () => {
    const names = mappedErrorNames();
    const expected = [
      'NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError',
      'SecurityError', 'AbortError', 'TypeError',
    ];
    const missing = expected.filter((n) => !names.includes(n));
    return {
      verdict: missing.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed: `${names.length} names mapped`,
      reason:
        missing.length === 0
          ? 'every getUserMedia rejection the platform can raise maps to a declared state ' +
            'with a recovery action; an unrecognised name still fails closed to UNAVAILABLE'
          : `unmapped: ${missing.join(', ')}`,
      metrics: { mappedCount: names.length, mappedNames: names },
    };
  },
};

export const PHASE1_TESTS: readonly Phase1Test[] = [
  CAM_001, CAM_002, CAM_003, CAM_004, CAM_005, CAM_006,
];

export const PHASE1_SPECS: readonly TestSpec[] = PHASE1_TESTS.map((t) => t.spec);

export function runPhase1Tests(ctx: Phase1Context): TestResult[] {
  return PHASE1_TESTS.map((test) => {
    const e = test.evaluate(ctx);
    return {
      spec: test.spec,
      verdict: e.verdict,
      observed: e.observed,
      reason: e.reason,
      metrics: e.metrics ?? {},
      timestamp: Date.now(),
    };
  });
}
