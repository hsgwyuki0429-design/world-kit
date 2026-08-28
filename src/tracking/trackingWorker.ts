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
import { FlowStage } from './FlowStage';
import { VerificationStage } from './VerificationStage';
import { PoseStage } from './PoseStage';
import { KeyframeStage } from './KeyframeStage';
import { TriangulationStage } from './TriangulationStage';
import { LandmarkStage } from './LandmarkStage';
import { asTrackingOptions } from './trackingMessages';
import type { FeatureRecordSample, TrackingOptions, TrackingResult } from './trackingMessages';
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

/**
 * Phase 4's frame stage.
 *
 * Given the two detectors above so a refill in Phase 4 is the *same* §11 ladder Phase 3 ran,
 * with the same thresholds and the same relaxed second pass — not a second implementation of
 * it that could drift.
 */
const flowStage = new FlowStage(detector, refillDetector);
/** Phase 5. Given the flow stage's own tracker, so it verifies the population Phase 4 holds. */
const verificationStage = new VerificationStage();
/** Phase 6. Decomposes the model Phase 5 selected on this frame, never a fresh fit of its own. */
const poseStage = new PoseStage();
/**
 * Phase 8. Keeps the keyframe store beside Phase 5's anchor rather than in place of it.
 *
 * The anchor is what Phases 5 and 6 passed on the device with, and editing a passed phase is not
 * a fix. The two structures answer different questions: the anchor is one slot re-taken on
 * displacement so that *this frame* has a two-view partner, and the store is thirty views chosen
 * on v3 §20's conditions so that the *room* has a set of viewpoints.
 */
const keyframeStage = new KeyframeStage();
/**
 * Phase 9. Runs on keyframe inserts only, which is where §27 puts mapping work.
 *
 * In the tracking worker rather than in a second one, and that is a decision deferred to a
 * measurement rather than taken from §B.2's diagram: the cost per insert and the amortised
 * per-frame figure are both on the record, and a mapping worker is what the numbers should buy
 * if they turn out to need it.
 */
const triangulationStage = new TriangulationStage();
/**
 * Phase 10. Brings Phase 9's batches into one frame by the landmarks they share.
 *
 * In the same worker for the same reason Phase 9 is: it consumes the full point set, which the
 * report deliberately does not carry across the boundary, and it runs on keyframe inserts only.
 */
const landmarkStage = new LandmarkStage();
/** Whether the previous frame ran the flow path, so switching modes resets rather than drifts. */
let flowActive = false;

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

  const tracking = runTracking(msg, p, meanLuma, topMad);

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
  if (tracking?.flowAge) transfer.push(tracking.flowAge);
  post(result, transfer);
}

/**
 * Feature detection on the pyramid this worker just built (§11, Phase 3).
 *
 * Reads a pyramid level in place — nothing is copied and nothing is converted, which is the
 * whole reason detection lives in the same worker as preprocessing rather than a second one
 * behind another transfer.
 */
function runTracking(
  msg: FrameMessage,
  p: GrayPyramid,
  meanLuma: number,
  topLevelMad: number,
): TrackingResult | undefined {
  const options = asTrackingOptions(msg.tracking);
  if (!options || (!options.detect && !options.track)) {
    // Tracking was switched off. Forget the previous frame rather than keeping it: the next
    // frame to arrive could be seconds later, and matching against a stale one would produce
    // a displacement that describes the gap rather than the scene.
    if (flowActive) {
      flowStage.reset();
      verificationStage.reset();
      poseStage.reset();
      keyframeStage.reset();
      triangulationStage.reset();
      landmarkStage.reset();
      flowActive = false;
    }
    return undefined;
  }

  const levelIndex = Math.min(Math.max(0, Math.floor(options.level)), p.levels.length - 1);
  const level = p.levels[levelIndex];
  if (!level) return undefined;
  const levelScale = 2 ** levelIndex;

  if (options.track) return runFlow(options, p, levelIndex, meanLuma, topLevelMad);
  if (flowActive) {
    flowStage.reset();
    verificationStage.reset();
    poseStage.reset();
    keyframeStage.reset();
    triangulationStage.reset();
    landmarkStage.reset();
    flowActive = false;
  }

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
    flow: null,
    flowAge: null,
    verification: null,
    pose: null,
    keyframe: null,
    triangulation: null,
    landmarks: null,
  };
}

/**
 * One Phase 4 frame.
 *
 * Delegated whole to `FlowStage`, which is where the four steps and the reasons for their
 * order are written down. Nothing is added here: the same code the device runs is the code
 * `tests/unit/flowTracker.test.ts` drives with a substituted solver to show that a tracker
 * returning its input is rejected. A copy of the loop in the worker would put that proof
 * one step away from the thing it proves.
 */
function runFlow(
  options: TrackingOptions,
  p: GrayPyramid,
  levelIndex: number,
  meanLuma: number,
  topLevelMad: number,
): TrackingResult {
  flowActive = true;
  const result = flowStage.process({
    levels: p.levels,
    detectLevel: levelIndex,
    target: options.target,
    recordSamples: options.recordSamples,
    meanLuma,
    topLevelMad,
  });
  if (!options.verify) return result;

  // Phase 5 runs on the population Phase 4 just produced, in the same worker and on the same
  // frame. Splitting them would let an inlier ratio be reported beside a population from a
  // different frame.
  const outcome = verificationStage.process(flowStage.getTracker(), options.wantInjection);
  if (!options.pose) return { ...result, verification: outcome.report };

  // Phase 6 decomposes the model Phase 5 just selected, on the same frame, in the same worker.
  // `K` comes from this frame's own geometry rather than from a constant read at open (§H.0):
  // rotating the device swaps the frame dimensions on the same track.
  const pose = poseStage.process({
    verification: outcome,
    width: p.levels[0]?.width ?? 0,
    height: p.levels[0]?.height ?? 0,
    trackedFeatures: result.flow?.tracked ?? 0,
    wantInjection: options.wantPoseInjection,
  });
  if (!options.keyframes) return { ...result, verification: outcome.report, pose };

  // Phase 8 decides on the same frame, from the same three reports the screen shows. A decision
  // taken from one frame's pose beside another frame's population would be a decision about a
  // view nobody took.
  const keyframe = keyframeStage.process({
    at: performance.now(),
    frameIndex: flowStage.getTracker().getFrameIndex(),
    tracker: flowStage.getTracker(),
    width: p.levels[0]?.width ?? 0,
    height: p.levels[0]?.height ?? 0,
    pose,
    verification: outcome.report,
    flow: result.flow,
  });
  if (!options.triangulate) return { ...result, verification: outcome.report, pose, keyframe };

  // Phase 9 relates the keyframe Phase 8 has just inserted to the one before it. On every other
  // frame it reports IDLE and carries its counters forward, so the screen can tell "no pair this
  // frame" from "the stage has stopped".
  const triangulation = triangulationStage.process({
    keyframes: keyframeStage.keyframes(),
    inserted: keyframe.inserted,
    wantInjections: options.wantInjections,
  });
  if (!options.landmarks) {
    return { ...result, verification: outcome.report, pose, keyframe, triangulation };
  }

  // Phase 10 consumes the **full** batch, which the Phase 9 report deliberately does not carry
  // across the boundary — six sampled points is what a screen needs and every point is what a map
  // needs. `getBatch` is the same division `VerificationStage` makes between its report and its
  // outcome.
  const landmarks = landmarkStage.process({
    batch: triangulationStage.getBatch(),
    wantInjection: options.wantInjections,
  });
  return { ...result, verification: outcome.report, pose, keyframe, triangulation, landmarks };
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
