/**
 * Camera acquisition (§9, Phase 1).
 *
 * Owns exactly one thing: turning a user gesture into a live `MediaStream`, or into a
 * precise reason why there isn't one. It does not read pixels, schedule frames, or know
 * what a feature is — those are Phases 2 and 3.
 *
 * Two rules shape the code:
 *
 *  - **A failure is never silently a lack of camera.** Each `DOMException` name maps to a
 *    specific §57 state with a recovery action, and an unrecognised name maps to a state
 *    that says it was unrecognised rather than guessing.
 *  - **Nothing is assumed about what was obtained.** The requested constraints and the
 *    achieved settings are recorded separately, so "we asked for the rear camera at 1280×720"
 *    and "we got a front camera at 640×480" can never be confused.
 */

import { describeError, isFiniteNumber, toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';

export const CameraState = {
  IDLE: 'IDLE',
  REQUESTING: 'REQUESTING',
  LIVE: 'LIVE',
  PERMISSION_DENIED: 'CAMERA_PERMISSION_DENIED',
  UNAVAILABLE: 'CAMERA_UNAVAILABLE',
  ENDED: 'CAMERA_ENDED',
} as const;
export type CameraState = (typeof CameraState)[keyof typeof CameraState];

export interface CameraFailure {
  readonly state: CameraState;
  readonly errorName: string;
  readonly message: string;
  /** What the system does about it (§27). Never empty. */
  readonly recovery: string;
  /** True when the name was not in the mapping table — recorded, not guessed at. */
  readonly unmapped: boolean;
}

/**
 * §57 error states. Ordered by how the platform actually reports them; the legacy aliases
 * are included because WebKit has historically used them.
 */
const ERROR_MAP: Record<string, { state: CameraState; recovery: string }> = {
  NotAllowedError: {
    state: CameraState.PERMISSION_DENIED,
    recovery:
      'no stream is held and no image is presented; the user must grant camera access in ' +
      'Safari website settings and reload',
  },
  PermissionDeniedError: {
    state: CameraState.PERMISSION_DENIED,
    recovery: 'legacy alias of NotAllowedError; handled identically',
  },
  SecurityError: {
    state: CameraState.PERMISSION_DENIED,
    recovery:
      'the browser refused the request for a security reason, usually an insecure context; ' +
      'serve the page over HTTPS',
  },
  NotFoundError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'no camera matched; the constraint ladder falls back to a looser rung',
  },
  DevicesNotFoundError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'legacy alias of NotFoundError; handled identically',
  },
  OverconstrainedError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'the requested resolution or facing mode is unsupported; retry a looser rung',
  },
  ConstraintNotSatisfiedError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'legacy alias of OverconstrainedError; handled identically',
  },
  NotReadableError: {
    state: CameraState.UNAVAILABLE,
    recovery:
      'the camera exists but could not be started, usually because another app holds it; ' +
      'close the other app and retry',
  },
  TrackStartError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'legacy alias of NotReadableError; handled identically',
  },
  AbortError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'the request was aborted by the platform; retry',
  },
  TypeError: {
    state: CameraState.UNAVAILABLE,
    recovery: 'the constraints were malformed; this is a bug in the constraint ladder',
  },
};

export function mapCameraError(err: unknown): CameraFailure {
  const name = err instanceof DOMException || err instanceof Error ? err.name : 'UnknownError';
  const message = describeError(err);
  const entry = ERROR_MAP[name];
  if (entry) {
    return { state: entry.state, errorName: name, message, recovery: entry.recovery, unmapped: false };
  }
  return {
    state: CameraState.UNAVAILABLE,
    errorName: name,
    message,
    // Fail closed: an unrecognised failure is not evidence of anything except failure.
    recovery:
      `"${name}" is not in the error mapping table, so the camera is treated as ` +
      'unavailable rather than the failure being interpreted',
    unmapped: true,
  };
}

/** Every name the mapping covers, so a test can assert completeness (CAM-006). */
export function mappedErrorNames(): string[] {
  return Object.keys(ERROR_MAP);
}

/* -------------------------------------------------------------------------- */
/* Constraint ladder (§9 "nearest fallback")                                    */
/* -------------------------------------------------------------------------- */

export interface LadderRung {
  readonly index: number;
  readonly label: string;
  readonly constraints: MediaStreamConstraints;
}

export const CONSTRAINT_LADDER: readonly LadderRung[] = [
  {
    index: 1,
    label: 'rear camera (exact), 1280x720 ideal, 30 fps ideal',
    constraints: {
      video: {
        facingMode: { exact: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    },
  },
  {
    index: 2,
    label: 'rear camera (preferred), 1280x720 ideal',
    constraints: {
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    },
  },
  {
    index: 3,
    label: 'rear camera (preferred), any resolution',
    constraints: { video: { facingMode: 'environment' }, audio: false },
  },
  {
    index: 4,
    label: 'any camera, any resolution',
    constraints: { video: true, audio: false },
  },
];

/** Errors worth trying a looser rung for. A denial is not one of them. */
const RETRYABLE = new Set([
  'OverconstrainedError',
  'ConstraintNotSatisfiedError',
  'NotFoundError',
  'DevicesNotFoundError',
]);

export interface LadderAttempt {
  readonly rung: number;
  readonly label: string;
  readonly ok: boolean;
  readonly errorName?: string;
  readonly durationMs: number;
}

export interface CameraSettingsSnapshot {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly facingMode: string;
  readonly deviceId: string;
  readonly label: string;
  readonly aspectRatio: number;
}

export interface CameraOpenResult {
  readonly state: CameraState;
  readonly stream: MediaStream | null;
  readonly settings: CameraSettingsSnapshot | null;
  readonly rungUsed: number | null;
  readonly attempts: readonly LadderAttempt[];
  readonly failure: CameraFailure | null;
  readonly totalDurationMs: number;
}

function readSettings(track: MediaStreamTrack): CameraSettingsSnapshot {
  const s = track.getSettings();
  return {
    width: isFiniteNumber(s.width) ? s.width : -1,
    height: isFiniteNumber(s.height) ? s.height : -1,
    frameRate: isFiniteNumber(s.frameRate) ? Math.round(s.frameRate * 100) / 100 : -1,
    // Recorded as achieved, never as requested. On a device with no rear camera this will
    // legitimately read "user", and that must be visible rather than smoothed over.
    facingMode: typeof s.facingMode === 'string' ? s.facingMode : 'unreported',
    deviceId: typeof s.deviceId === 'string' ? s.deviceId : 'unreported',
    label: track.label || 'unlabelled',
    aspectRatio: isFiniteNumber(s.aspectRatio) ? Math.round(s.aspectRatio * 1000) / 1000 : -1,
  };
}

export type CameraEndedListener = (reason: string) => void;

export class CameraSource {
  private stream: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private state: CameraState = CameraState.IDLE;
  private endedListeners = new Set<CameraEndedListener>();
  private lastResult: CameraOpenResult | null = null;

  getState(): CameraState {
    return this.state;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getTrack(): MediaStreamTrack | null {
    return this.track;
  }

  getLastResult(): CameraOpenResult | null {
    return this.lastResult;
  }

  onEnded(fn: CameraEndedListener): () => void {
    this.endedListeners.add(fn);
    return () => this.endedListeners.delete(fn);
  }

  /** Live settings, re-read from the track rather than cached — resolution can change. */
  currentSettings(): CameraSettingsSnapshot | null {
    return this.track && this.track.readyState === 'live' ? readSettings(this.track) : null;
  }

  isLive(): boolean {
    return this.track !== null && this.track.readyState === 'live';
  }

  /**
   * Walk the constraint ladder. MUST be called from a user gesture (§9 "ユーザー操作後に要求").
   */
  async open(): Promise<CameraOpenResult> {
    if (this.stream) this.close('reopening');
    this.state = CameraState.REQUESTING;

    const startedAll = performance.now();
    const attempts: LadderAttempt[] = [];
    let lastFailure: CameraFailure | null = null;

    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
      const failure: CameraFailure = {
        state: CameraState.UNAVAILABLE,
        errorName: 'NoMediaDevices',
        message: 'navigator.mediaDevices.getUserMedia is not a function',
        recovery: 'the camera API is absent; this build cannot capture on this platform',
        unmapped: false,
      };
      this.state = failure.state;
      this.lastResult = {
        state: failure.state, stream: null, settings: null, rungUsed: null,
        attempts, failure, totalDurationMs: 0,
      };
      return this.lastResult;
    }

    for (const rung of CONSTRAINT_LADDER) {
      const started = performance.now();
      try {
        const stream = await md.getUserMedia(rung.constraints);
        const track = stream.getVideoTracks()[0];
        attempts.push({
          rung: rung.index, label: rung.label, ok: true,
          durationMs: Math.round(performance.now() - started),
        });
        if (!track) {
          // A stream with no video track is not a usable camera; release it rather than
          // holding a handle that looks live.
          stream.getTracks().forEach((t) => t.stop());
          lastFailure = {
            state: CameraState.UNAVAILABLE,
            errorName: 'NoVideoTrack',
            message: 'getUserMedia resolved with a stream containing no video track',
            recovery: 'the stream is released and the camera reported unavailable',
            unmapped: false,
          };
          continue;
        }
        this.attach(stream, track);
        this.lastResult = {
          state: CameraState.LIVE,
          stream,
          settings: readSettings(track),
          rungUsed: rung.index,
          attempts,
          failure: null,
          totalDurationMs: Math.round(performance.now() - startedAll),
        };
        return this.lastResult;
      } catch (err) {
        const failure = mapCameraError(err);
        lastFailure = failure;
        attempts.push({
          rung: rung.index, label: rung.label, ok: false, errorName: failure.errorName,
          durationMs: Math.round(performance.now() - started),
        });
        // A denial applies to the camera, not to a set of constraints. Retrying a looser
        // rung would re-prompt the user and could not succeed.
        if (!RETRYABLE.has(failure.errorName)) break;
      }
    }

    this.state = lastFailure?.state ?? CameraState.UNAVAILABLE;
    this.lastResult = {
      state: this.state,
      stream: null,
      settings: null,
      rungUsed: null,
      attempts,
      failure: lastFailure,
      totalDurationMs: Math.round(performance.now() - startedAll),
    };
    return this.lastResult;
  }

  private attach(stream: MediaStream, track: MediaStreamTrack): void {
    this.stream = stream;
    this.track = track;
    this.state = CameraState.LIVE;
    // The camera can be taken away — another app claiming it, or the OS revoking access.
    // That must surface as a state change, not as frames quietly stopping.
    track.addEventListener('ended', () => {
      this.state = CameraState.ENDED;
      for (const fn of this.endedListeners) fn('the video track ended');
    });
  }

  close(reason: string): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.track = null;
    this.state = CameraState.IDLE;
    void reason;
  }

  /** JSON-safe description for the evidence bundle. */
  describe(): Record<string, JsonValue> {
    const r = this.lastResult;
    return toJsonSafe({
      state: this.state,
      live: this.isLive(),
      trackReadyState: this.track?.readyState ?? null,
      rungUsed: r?.rungUsed ?? null,
      attempts: r?.attempts ?? [],
      requestedLadder: CONSTRAINT_LADDER.map((l) => ({ rung: l.index, label: l.label })),
      achievedSettings: this.currentSettings(),
      openDurationMs: r?.totalDurationMs ?? null,
      failure: r?.failure ?? null,
    }) as Record<string, JsonValue>;
  }
}
