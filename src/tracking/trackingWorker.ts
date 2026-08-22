/**
 * Tracking worker (§10, §52, §82).
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
 *
 * **Why this lives in `tracking/` and not in `pipeline/`.** §10's diagram ends at "Tracking
 * Worker" and §52 puts preprocessing *and* feature detection in the same worker, so this is
 * the tracking stage — preprocessing is merely the first thing it does. It was written in
 * `pipeline/` during Phase 2, when preprocessing was all it did, and moved here in Phase 3
 * when the detector §82 places in `tracking/` needed to run on the pyramid it holds. The
 * architecture audit forbids `pipeline → tracking`, which is the right rule; the file was on
 * the wrong side of it. `tracking → pipeline` is permitted and is the direction used below.
 */

/// <reference lib="webworker" />

import { GrayPyramid, rgbaToGray, stridedChecksum } from '../pipeline/pyramid';
import { FeatureDetector, DEFAULT_DETECTOR_CONFIG } from './FeatureDetector';
import { detectWithRefill, REFILL_QUALITY_FACTOR, REFILL_SEPARATION_FACTOR } from './FeaturePopulation';
import { GRID_CELLS, featureStateFor } from './featureTypes';
import { asTrackingOptions } from './trackingMessages';
import type { FeatureRecordSample, TrackingResult } from './trackingMessages';
import { payloadRoute } from '../pipeline/messages';
import type {
  FrameMessage,
  FromWorkerMessage,
  LevelReport,
  ResultMessage,
  ToWorkerMessage,
  WorkerScopeReport,
} from '../pipeline/messages';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let pyramid: GrayPyramid | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let procWidth = 0;
let procHeight = 0;
let stressPasses = 0;

/**
 * The detector, and a second one configured for refills.
 *
 * Two instances rather than one with mutable settings: each keeps its own scratch buffers,
 * and a detector whose configuration changed between the two passes of a single frame would
 * make the pair incomparable — which is exactly what the refill event reports on.
 */
const detector = new FeatureDetector();
const refillDetector = new FeatureDetector({
  qualityLevel: DEFAULT_DETECTOR_CONFIG.qualityLevel * REFILL_QUALITY_FACTOR,
  minSeparation: Math.max(
    2,
    Math.round(DEFAULT_DETECTOR_CONFIG.minSeparation * REFILL_SEPARATION_FACTOR),
  ),
});
/** Runs once per worker, so the level choice is answerable from a measurement (FEAT-005). */
const level0Detector = new FeatureDetector();
let level0Calibration: TrackingResult['level0Calibration'] = null;

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

  const tracking = runTracking(msg, p);

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
    tracking,
  };
  const transfer: Transferable[] = [];
  if (strip) transfer.push(strip);
  if (tracking?.overlay) transfer.push(tracking.overlay);
  post(result, transfer);
}

/**
 * Feature detection on the pyramid this worker just built (§11, Phase 3).
 *
 * Reads a pyramid level in place — nothing is copied and nothing is converted, which is the
 * whole reason detection lives in the same worker as preprocessing rather than a second one
 * behind another transfer.
 */
function runTracking(msg: FrameMessage, p: GrayPyramid): TrackingResult | undefined {
  const options = asTrackingOptions(msg.tracking);
  if (!options || !options.detect) return undefined;

  const levelIndex = Math.min(Math.max(0, Math.floor(options.level)), p.levels.length - 1);
  const level = p.levels[levelIndex];
  if (!level) return undefined;
  const levelScale = 2 ** levelIndex;

  const outcome = detectWithRefill(
    detector,
    refillDetector,
    level.data,
    level.width,
    level.height,
    {
      levelScale,
      wantContrast: options.wantContrast,
      wantGridComparison: options.wantGridComparison,
      target: options.target,
    },
    Date.now(),
  );
  const r = outcome.result;

  // The level-0 calibration: what detection *would* have cost at full resolution. Run once,
  // so the test plan's arithmetic for choosing level 1 is answered by a measurement rather
  // than left as an estimate — and never on the hot path afterwards.
  if (options.wantLevel0Calibration && !level0Calibration) {
    const base = p.levels[0];
    if (base) {
      const cal = level0Detector.detect(base.data, base.width, base.height, {
        levelScale: 1,
        wantContrast: false,
        wantGridComparison: false,
        target: options.target,
      });
      level0Calibration = {
        width: base.width,
        height: base.height,
        detectMs: Math.round(cal.detectMs * 100) / 100,
        features: cal.features.length,
      };
    }
  }

  const overlay = new Float32Array(r.features.length * 3);
  for (let i = 0; i < r.features.length; i++) {
    const f = r.features[i];
    if (!f) continue;
    overlay[i * 3] = f.x0;
    overlay[i * 3 + 1] = f.y0;
    overlay[i * 3 + 2] = f.qualityScore;
  }

  const samples: FeatureRecordSample[] = [];
  const wanted = Math.min(options.recordSamples, r.features.length);
  for (let i = 0; i < wanted; i++) {
    const f = r.features[Math.floor((i * r.features.length) / Math.max(1, wanted))];
    if (f) samples.push({ ...f });
  }

  return {
    kind: 'phase3',
    detected: true,
    count: r.features.length,
    detectMs: Math.round(r.detectMs * 1000) / 1000,
    detectWidth: r.width,
    detectHeight: r.height,
    detectLevel: levelIndex,
    meanGradient: Math.round(r.meanGradient * 1000) / 1000,
    texture: r.texture,
    maxCornerStrength: Math.round(r.maxCornerStrength * 100) / 100,
    candidateCount: r.candidateCount,
    occupiedCells: r.occupiedCells,
    maxCellShare: Math.round(r.maxCellShare * 10000) / 10000,
    quota: Math.ceil(options.target / GRID_CELLS),
    state: featureStateFor(r.features.length),
    contrast: r.contrast,
    gridComparison: r.gridComparison,
    refill: outcome.refill
      ? {
          urgency: outcome.refill.urgency,
          countBefore: outcome.refill.countBefore,
          countAfter: outcome.refill.countAfter,
          candidatesBefore: outcome.refill.candidatesBefore,
          candidatesAfter: outcome.refill.candidatesAfter,
          exhausted: outcome.refill.exhausted,
          stateBefore: outcome.refill.stateBefore,
          stateAfter: outcome.refill.stateAfter,
        }
      : null,
    recordSamples: samples,
    level0Calibration,
    overlay: overlay.buffer,
  };
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
