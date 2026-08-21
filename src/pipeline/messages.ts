/**
 * The main-thread ↔ worker protocol for the frame pipeline.
 *
 * Kept in its own module, free of DOM and worker globals, so both sides compile against
 * one definition of the wire format rather than two that drift.
 *
 * **Why the routes exist.** §H.1 recorded a measurement that rules out the obvious
 * implementation: `drawImage(video)` + `getImageData()` on the main thread costs 13.8 ms
 * per frame on the target device, which is 40 % of a 30 Hz budget spent before any pixel
 * has been looked at. So the acquire step has three candidate routes, and the pipeline
 * probes them at run time instead of assuming one works:
 *
 *  - `VIDEO_FRAME` — construct a `VideoFrame` from the element (cheap; no readback) and
 *    transfer it. All the pixel work, including the readback, happens in the worker.
 *  - `IMAGE_BITMAP` — `createImageBitmap(video, { resizeWidth, resizeHeight })`, which
 *    performs the downscale off the main thread and yields a transferable handle.
 *  - `MAIN_CANVAS` — the §H.1 route itself. Kept as the declared last resort so that a
 *    platform where neither of the others works still runs, and kept *measured* so the
 *    comparison that motivated this design is in the evidence rather than in a comment.
 */

import type { JsonValue } from '../core/types';

export const AcquireRoute = {
  VIDEO_FRAME: 'VIDEO_FRAME',
  IMAGE_BITMAP: 'IMAGE_BITMAP',
  MAIN_CANVAS: 'MAIN_CANVAS',
} as const;
export type AcquireRoute = (typeof AcquireRoute)[keyof typeof AcquireRoute];

/** Probe order: cheapest UI-thread cost first (§10's Worker → OffscreenCanvas ordering). */
export const ROUTE_ORDER: readonly AcquireRoute[] = [
  AcquireRoute.VIDEO_FRAME,
  AcquireRoute.IMAGE_BITMAP,
  AcquireRoute.MAIN_CANVAS,
];

export interface FrameGeometry {
  /** The element's frame size for *this* frame. Per-frame by §H.0, never cached once. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly procWidth: number;
  readonly procHeight: number;
  readonly tierStep: number;
}

export type FramePayload =
  | { readonly kind: 'VIDEO_FRAME'; readonly frame: VideoFrame }
  | { readonly kind: 'IMAGE_BITMAP'; readonly bitmap: ImageBitmap }
  | { readonly kind: 'RGBA'; readonly buffer: ArrayBuffer };

export interface ConfigureMessage {
  readonly type: 'configure';
  readonly procWidth: number;
  readonly procHeight: number;
  readonly reason: string;
}

export interface FrameMessage extends FrameGeometry {
  readonly type: 'frame';
  readonly frameId: number;
  /** Main-thread `Date.now()` at post time. Worker clocks have a different time origin. */
  readonly postedAtEpoch: number;
  readonly payload: FramePayload;
  /** Ask for the 64×48 proof strip back. Set for display frames and cross-check frames. */
  readonly wantStrip: boolean;
  /**
   * Whatever the stage downstream of preprocessing needs, passed through untouched.
   *
   * `unknown` on purpose. §83 keeps `pipeline` from importing `tracking`, so the pipeline
   * cannot name this type without acquiring the dependency the rule exists to prevent —
   * and it has no reason to: it schedules frames and measures latency, and what the worker
   * does with a frame after preprocessing is not its business. The composition root sets
   * it, the worker narrows it, and the two ends are typed even though the pipe is not.
   */
  readonly tracking?: unknown;
}

export interface StressMessage {
  readonly type: 'stress';
  /**
   * Extra real passes over the pyramid the worker genuinely built.
   *
   * A stimulus, not a result (§28): it makes the worker slower by making it do more work,
   * and every number downstream is still measured. `0` is the normal state.
   */
  readonly passes: number;
}

export type ToWorkerMessage =
  | ConfigureMessage
  | FrameMessage
  | StressMessage
  | { readonly type: 'shutdown' };

/** What the worker can prove about its own execution context (FRAME-002, criterion 1). */
export interface WorkerScopeReport {
  readonly hasDocument: boolean;
  readonly hasWindow: boolean;
  readonly isWorkerGlobalScope: boolean;
  readonly hasOffscreenCanvas: boolean;
  readonly canvas2dAvailable: boolean;
  readonly hardwareConcurrency: number;
}

export interface HelloMessage {
  readonly type: 'hello';
  readonly scope: WorkerScopeReport;
  readonly error: string | null;
}

export interface LevelReport {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface ResultMessage extends FrameGeometry {
  readonly type: 'result';
  readonly frameId: number;
  readonly postedAtEpoch: number;
  readonly route: AcquireRoute;
  /** Total time inside the worker for this frame, on the worker's own clock. */
  readonly workerMs: number;
  /** Getting pixels into an RGBA buffer: draw + readback, or nothing for the RGBA route. */
  readonly readbackMs: number;
  readonly grayMs: number;
  readonly pyramidMs: number;
  readonly stressMs: number;
  readonly stressPasses: number;
  readonly levels: readonly LevelReport[];
  readonly meanLuma: number;
  /** Frame-to-frame difference on the top pyramid level; `-1` when incomparable. */
  readonly topLevelMad: number;
  readonly checksum: number;
  readonly pyramidAllocations: number;
  /** 64×48 grayscale, transferred, only when requested. */
  readonly strip: ArrayBuffer | null;
  /** The downstream stage's own result, opaque here for the reason given on `FrameMessage`. */
  readonly tracking?: unknown;
}

export interface WorkerErrorMessage {
  readonly type: 'error';
  readonly frameId: number | null;
  readonly route: AcquireRoute | null;
  readonly message: string;
  readonly context: Record<string, JsonValue>;
}

export type FromWorkerMessage = HelloMessage | ResultMessage | WorkerErrorMessage;

export function payloadRoute(payload: FramePayload): AcquireRoute {
  switch (payload.kind) {
    case 'VIDEO_FRAME':
      return AcquireRoute.VIDEO_FRAME;
    case 'IMAGE_BITMAP':
      return AcquireRoute.IMAGE_BITMAP;
    case 'RGBA':
      return AcquireRoute.MAIN_CANVAS;
  }
}
