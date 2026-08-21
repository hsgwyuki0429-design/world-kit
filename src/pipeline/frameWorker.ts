/**
 * Preprocessing worker (§10, §52).
 *
 * Everything expensive about a frame happens here: the GPU→CPU readback that §H.1 measured
 * at 13.8 ms on the device, the grayscale conversion, and the three-level pyramid. The UI
 * thread's remaining job is to hand over a frame handle, which costs it a fraction of a
 * millisecond.
 *
 * The worker does not decide anything. It does not choose a resolution, it does not select
 * a tier, and it does not report a verdict — it processes what it is given and reports what
 * it measured, including its own failures. Deciding is the controller's job on the main
 * thread, where the measurements can be compared against the spec's budgets.
 *
 * Buffers are allocated once per processing size and reused. SharedArrayBuffer measured
 * UNAVAILABLE on the target (static hosting cannot send COOP/COEP), so nothing here can be
 * shared with the main thread; what crosses the boundary is transferred, and the only
 * per-frame allocation is the 3 kB proof strip, and only on the frames that ask for it.
 */

/// <reference lib="webworker" />

import { GrayPyramid, rgbaToGray, stridedChecksum } from './pyramid';
import { payloadRoute } from './messages';
import type {
  FrameMessage,
  FromWorkerMessage,
  LevelReport,
  ResultMessage,
  ToWorkerMessage,
  WorkerScopeReport,
} from './messages';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let pyramid: GrayPyramid | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let procWidth = 0;
let procHeight = 0;
let stressPasses = 0;

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name || 'Error'}: ${err.message}`;
  if (typeof err === 'string') return err;
  return String(err);
}

function post(message: FromWorkerMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

/**
 * What this worker can say about where it is running.
 *
 * FRAME-002's first criterion is that preprocessing is off the UI thread. A claim to that
 * effect in a comment proves nothing; the absence of `document` in this scope is a fact the
 * evidence can carry.
 */
function reportScope(): WorkerScopeReport {
  const g = self as unknown as Record<string, unknown>;
  let canvas2d = false;
  let error: string | null = null;
  try {
    if (typeof OffscreenCanvas === 'function') {
      const probe = new OffscreenCanvas(2, 2);
      canvas2d = probe.getContext('2d') !== null;
    }
  } catch (err) {
    error = describeError(err);
  }
  if (error) {
    post({
      type: 'error',
      frameId: null,
      route: null,
      message: `OffscreenCanvas probe failed in the worker: ${error}`,
      context: { stage: 'scope-probe' },
    });
  }
  return {
    hasDocument: typeof g['document'] !== 'undefined',
    hasWindow: typeof g['window'] !== 'undefined',
    isWorkerGlobalScope: typeof g['WorkerGlobalScope'] !== 'undefined',
    hasOffscreenCanvas: typeof OffscreenCanvas === 'function',
    canvas2dAvailable: canvas2d,
    hardwareConcurrency:
      typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
        ? navigator.hardwareConcurrency
        : -1,
  };
}

function configure(width: number, height: number): void {
  if (width === procWidth && height === procHeight && pyramid) return;
  procWidth = width;
  procHeight = height;
  pyramid = new GrayPyramid(width, height);
  if (typeof OffscreenCanvas === 'function') {
    canvas = new OffscreenCanvas(width, height);
    // `willReadFrequently` asks the platform for a CPU-backed surface. On WebKit this is
    // the difference between a readback that costs a memcpy and one that stalls on the GPU.
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } else {
    canvas = null;
    ctx = null;
  }
}

/** Draw whatever came across the boundary into the canvas and read it back as RGBA. */
function readbackRgba(msg: FrameMessage): Uint8ClampedArray {
  const payload = msg.payload;
  if (payload.kind === 'RGBA') {
    // The main thread already paid for the readback on this route; nothing to do here
    // beyond viewing the bytes. This is the §H.1 route and its cost shows up over there.
    return new Uint8ClampedArray(payload.buffer);
  }
  if (!ctx || !canvas) {
    throw new Error('no OffscreenCanvas 2D context in the worker; this route is unavailable');
  }
  if (canvas.width !== procWidth || canvas.height !== procHeight) {
    canvas.width = procWidth;
    canvas.height = procHeight;
  }
  if (payload.kind === 'VIDEO_FRAME') {
    // Scaling happens here, in the worker, on the way into the canvas.
    ctx.drawImage(payload.frame, 0, 0, procWidth, procHeight);
    payload.frame.close();
  } else {
    // Already resized by createImageBitmap, so this is a 1:1 blit.
    ctx.drawImage(payload.bitmap, 0, 0, procWidth, procHeight);
    payload.bitmap.close();
  }
  return ctx.getImageData(0, 0, procWidth, procHeight).data;
}

function closePayload(msg: FrameMessage): void {
  try {
    if (msg.payload.kind === 'VIDEO_FRAME') msg.payload.frame.close();
    else if (msg.payload.kind === 'IMAGE_BITMAP') msg.payload.bitmap.close();
  } catch {
    // Already closed by the successful path, or never opened. Either way there is nothing
    // to recover and nothing to report: this runs only to avoid leaking a frame handle
    // after an earlier failure that has already been posted.
  }
}

function handleFrame(msg: FrameMessage): void {
  const started = performance.now();
  configure(msg.procWidth, msg.procHeight);
  const p = pyramid;
  if (!p) {
    closePayload(msg);
    post({
      type: 'error',
      frameId: msg.frameId,
      route: payloadRoute(msg.payload),
      message: 'the worker has no pyramid configured',
      context: { procWidth: msg.procWidth, procHeight: msg.procHeight },
    });
    return;
  }

  const t0 = performance.now();
  const rgba = readbackRgba(msg);
  const t1 = performance.now();

  const base = p.base;
  const expected = base.width * base.height * 4;
  if (rgba.length < expected) {
    throw new Error(
      `readback produced ${rgba.length} bytes, short of the ${expected} needed for ` +
        `${base.width}x${base.height} — the frame does not match the configured size`,
    );
  }
  const meanLuma = rgbaToGray(rgba, base.data);
  const t2 = performance.now();

  p.buildLevels();
  const t3 = performance.now();

  // Injected load: the same pyramid build, done again, on the real data. It costs what it
  // costs, and the latency the controller then sees is a measurement rather than a number
  // someone chose.
  for (let i = 0; i < stressPasses; i++) p.buildLevels();
  const t4 = performance.now();

  const topMad = p.diffAgainstPrevious();
  const checksum = stridedChecksum(base.data);

  let strip: ArrayBuffer | null = null;
  if (msg.wantStrip) {
    p.fillStrip();
    // A 3 kB copy, on the ≤10 frames per second that ask for one. The pyramid itself is
    // never copied: it stays here, which is where Phase 3 will consume it.
    strip = p.strip.slice().buffer;
  }

  const levels: LevelReport[] = p.levels.map((l) => ({
    width: l.width,
    height: l.height,
    bytes: l.data.byteLength,
  }));

  const result: ResultMessage = {
    type: 'result',
    frameId: msg.frameId,
    postedAtEpoch: msg.postedAtEpoch,
    route: payloadRoute(msg.payload),
    sourceWidth: msg.sourceWidth,
    sourceHeight: msg.sourceHeight,
    procWidth: msg.procWidth,
    procHeight: msg.procHeight,
    tierStep: msg.tierStep,
    workerMs: performance.now() - started,
    readbackMs: t1 - t0,
    grayMs: t2 - t1,
    pyramidMs: t3 - t2,
    stressMs: t4 - t3,
    stressPasses,
    levels,
    meanLuma,
    topLevelMad: topMad,
    checksum,
    pyramidAllocations: p.allocations,
    strip,
  };
  post(result, strip ? [strip] : []);
}

scope.onmessage = (event: MessageEvent<ToWorkerMessage>): void => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'configure':
        configure(msg.procWidth, msg.procHeight);
        break;
      case 'frame':
        handleFrame(msg);
        break;
      case 'stress':
        stressPasses = Math.max(0, Math.floor(msg.passes));
        break;
      case 'shutdown':
        pyramid = null;
        canvas = null;
        ctx = null;
        scope.close();
        break;
    }
  } catch (err) {
    if (msg.type === 'frame') closePayload(msg);
    post({
      type: 'error',
      frameId: msg.type === 'frame' ? msg.frameId : null,
      route: msg.type === 'frame' ? payloadRoute(msg.payload) : null,
      message: describeError(err),
      context: { procWidth, procHeight, stressPasses },
    });
  }
};

post({ type: 'hello', scope: reportScope(), error: null });

export {};
