/**
 * Frame pipeline orchestrator (§10, Phase 2).
 *
 *   camera → HTMLVideoElement → frame scheduler → acquire → worker → grayscale pyramid
 *
 * The UI thread's whole job here is to decide *whether* to take a frame and to hand a
 * handle to it across the boundary. Everything that costs real time — the readback, the
 * grayscale conversion, the pyramid — happens in `frameWorker.ts`. That division is not a
 * preference: §H.1 measured a main-thread `drawImage` + `getImageData` at 13.8 ms on the
 * device, and a 30 Hz pipeline has 33 ms in total.
 *
 * Three ideas do most of the work:
 *
 *  - **Pacing and backpressure are different things, and are counted separately.** The
 *    camera delivers 30 frames a second whatever the target rate is. A frame declined
 *    because the target is 20 FPS is the pacer doing its job; a frame declined because the
 *    worker is still busy with the previous one is backpressure; a frame handed over and
 *    never returned is a defect. Rolling the three together would let a pipeline that
 *    loses a third of its frames report a healthy "drop rate".
 *
 *  - **Nothing is cached that rotation can change.** §H.0 measured the source frame size
 *    swapping mid-session, so the source geometry is read per frame and the processing size
 *    is derived per frame from it.
 *
 *  - **The pipeline measures itself, and the controller sees only measurements.** No part
 *    of the adaptation reads a clock or a configuration flag; it reads worker latencies.
 */

import { logger } from '../debug/Logger';
import { describeError, toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { AdaptiveController, budgetForTier, tierLabel } from './AdaptiveController';
import type { TierDecision } from './AdaptiveController';
import { CrossCheckLog, SegmentLog, Series } from './PipelineMetrics';
import { deriveProcessingSize, aspectError, tierAt, tierPixelBudget, TIER_LADDER } from './tiers';
import { AcquireRoute, ROUTE_ORDER } from './messages';
import type { FramePayload, FromWorkerMessage, ResultMessage, WorkerScopeReport } from './messages';
import { rgbaToGray, madBetween, levelGeometry, PYRAMID_LEVELS, STRIP_W, STRIP_H } from './pyramid';
import type {
  DecisionOutcome,
  FrameRecord,
  PipelineStats,
  RouteProbeRecord,
  StressInterval,
  TierUsage,
} from './stats';

const PHASE = 2;

/** Successful round trips before a route stops being on probation. */
const ROUTE_LOCK_SUCCESSES = 5;
/** Consecutive failures that unlock a locked route and force a fallback. */
const ROUTE_UNLOCK_FAILURES = 5;
/** A frame still unanswered after this long is counted lost, and the slot is freed. */
const PENDING_TIMEOUT_MS = 3000;
/** Pacing slack: a frame arriving a hair early is admitted rather than skipped. */
const PACING_TOLERANCE_MS = 2;
/**
 * How far behind its cadence the pacer may fall before it resynchronises.
 *
 * After a stall — a tier change, a slow frame — the accumulated deadline can be several
 * intervals in the past. Catching up by admitting a burst would be worse than the stall, so
 * beyond this the schedule is simply re-anchored to now.
 */
const PACING_RESYNC_INTERVALS = 2;
/** Proof-strip cadence for the display. Not needed for the cross-check. */
const STRIP_INTERVAL_MS = 100;
/** §H.1: this readback is expensive, so it runs at 1 Hz and is reported separately. */
const CROSSCHECK_INTERVAL_MS = 1000;
/**
 * Load injection aims for this multiple of the current tier's worker budget.
 *
 * Six, not two, and the number comes from the ladder's own shape. Descending the whole
 * ladder cuts the pixels per frame by about four (1280×720 → 640×360) while relaxing the
 * worker budget by about 1.5 (33.3 ms → 50 ms), so a load worth twice the budget where it
 * was applied is comfortably affordable two steps down — the pipeline recovers, climbs back,
 * and overloads again. That limit cycle was measured on the desktop leg. Six times the
 * budget is still over budget at the floor, so the ladder is exercised end to end and then
 * settles, which is what a stress stimulus should do.
 */
const STRESS_TARGET_BUDGET_MULTIPLE = 6;
const MAX_STRESS_PASSES = 500;
const RECENT_FRAMES = 240;
const RATE_WINDOW = 90;

/** Frames per second implied by a series of arrival times. */
function rateOf(times: readonly number[]): number {
  if (times.length < 2) return 0;
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? 0;
  const span = last - first;
  return span > 0 ? ((times.length - 1) * 1000) / span : 0;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

interface PendingFrame {
  readonly frameId: number;
  readonly sentAtPerf: number;
  readonly uiCostMs: number;
}

interface RouteState {
  attempts: number;
  successes: number;
  consecutiveFailures: number;
  acquire: Series;
  error: string | null;
  note: string;
}

export interface PipelineHooks {
  readonly onStateChange?: () => void;
}

export class WorkerFramePipeline {
  private video: HTMLVideoElement | null = null;
  private worker: Worker | null = null;
  private workerScope: WorkerScopeReport | null = null;
  private workerStarted = false;
  private running = false;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;

  private readonly controller = new AdaptiveController();
  private readonly segments = new SegmentLog();
  private readonly crossCheck = new CrossCheckLog();

  private readonly uiCost = new Series();
  private readonly acquireCost = new Series();
  private readonly workerCost = new Series();
  private readonly roundTrip = new Series();
  private readonly pyramidPassCost = new Series(200);

  private frameSeq = 0;
  private callbacks = 0;
  private admitted = 0;
  private completed = 0;
  private pacedOut = 0;
  private backpressured = 0;
  private lost = 0;
  private acquireFailures = 0;

  private pending: PendingFrame | null = null;
  /**
   * Set between the decision to admit a frame and the post that hands it over.
   *
   * The ImageBitmap route awaits, so without this a second callback could slip past the
   * backpressure check while the first frame is still being acquired, and two frames would
   * be in flight against a `maxInFlight` of one.
   */
  private acquiring = false;
  /**
   * When the next frame is *due*, on an accumulating cadence rather than measured from the
   * last admission.
   *
   * Measuring from the last admission aliases badly whenever the camera rate is close to
   * the target rate: a 30 fps camera against a 33.3 ms interval has roughly half its frames
   * land a hair early, each of those is declined, and the next one arrives a full interval
   * later — so the pipeline settles at 15 fps while believing it is pacing to 30. That was
   * measured on the desktop leg, at 12.88 fps against a 30 fps target. Accumulating the
   * deadline instead keeps the long-run rate on the ideal grid, and lets a 20 fps target
   * from a 30 fps camera alternate 1-2 frames and still average 20.
   */
  private nextDueAt = 0;
  private lastStripAt = 0;
  private lastCrossCheckAt = 0;
  private readonly pendingCrossChecks = new Map<number, { mean: number; costMs: number; at: number }>();

  private routeIndex = 0;
  private routeLocked = false;
  private readonly routeStates = new Map<AcquireRoute, RouteState>();
  private noRouteAvailable = false;

  private readonly resultTimes: number[] = [];
  /** Camera frame arrivals, so the rate the source can actually offer is measured. */
  private readonly callbackTimes: number[] = [];
  private maxResultGapMs = 0;

  private sourceWidth = 0;
  private sourceHeight = 0;
  private readonly sourceSizes: string[] = [];
  private readonly processedSizes: string[] = [];
  private sourceChangedAt: number | null = null;
  private framesAfterSourceChange = 0;
  private procMatchedAfterSourceChange: boolean | null = null;
  private maxAspectError = 0;
  private overBudgetFrames = 0;
  private upscaledFrames = 0;

  private lastLevels: readonly { width: number; height: number; bytes: number }[] = [];
  private readonly pyramidProblems: string[] = [];
  private lastMeanLuma = -1;
  private readonly topMads: number[] = [];
  private topMadMax = -1;
  private readonly checksums = new Set<number>();
  private lastStrip: Uint8Array | null = null;
  /**
   * Frame-to-frame difference between consecutive proof strips, measured on this thread.
   *
   * Deliberately the same 64×48 grid Phase 1 used, so its calibrated floor of 8.0 applies
   * unchanged: the noise-attenuation argument behind that number depends on how many
   * source pixels each cell averages, and a different grid would need a different floor.
   */
  private previousStrip: Uint8Array | null = null;
  private readonly stripMads: number[] = [];
  private stripMadMax = -1;

  /** Frames and processing sizes actually produced at each tier step, for the whole run. */
  private readonly tierFrames = new Map<number, { frames: number; sizes: Set<string> }>();

  /**
   * What happened *after* each ladder move.
   *
   * FRAME-004 asks whether the adaptation had an effect, which cannot be read from the
   * decision itself. The next window of worker latencies is collected and compared with the
   * window that triggered the move.
   */
  private readonly decisionOutcomes: DecisionOutcome[] = [];
  private outcomeInProgress: { decisionIndex: number; before: number; direction: string; samples: number[] } | null = null;

  private stressPasses = 0;
  private readonly stressIntervals: StressInterval[] = [];

  private hiddenCount = 0;
  private wasEverHidden = false;
  private spontaneousDegrade = false;

  private readonly recentFrames: FrameRecord[] = [];
  private readonly workerErrors: string[] = [];

  private crossCheckCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private crossCheckCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private readonly crossCheckGray = new Uint8Array(STRIP_W * STRIP_H);
  private acquireCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private acquireCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  private readonly hooks: PipelineHooks;

  constructor(hooks: PipelineHooks = {}) {
    this.hooks = hooks;
    for (const route of ROUTE_ORDER) {
      this.routeStates.set(route, {
        attempts: 0,
        successes: 0,
        consecutiveFailures: 0,
        acquire: new Series(500),
        error: null,
        note: 'not yet tried',
      });
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  start(video: HTMLVideoElement): boolean {
    if (this.running) return true;
    this.reset();
    this.video = video;

    try {
      this.worker = new Worker(new URL('./frameWorker.ts', import.meta.url), {
        type: 'module',
        name: 'frame-pipeline',
      });
    } catch (err) {
      logger.error(
        PHASE, 'FramePipeline', 'the preprocessing worker could not be created',
        'the pipeline does not start and FRAME-002 fails rather than the work silently ' +
          'moving to the UI thread, which §10 forbids',
        err,
      );
      this.worker = null;
      return false;
    }

    this.worker.onmessage = (e: MessageEvent<FromWorkerMessage>) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e: ErrorEvent) => {
      const message = e.message || 'worker error with no message';
      this.workerErrors.push(message);
      logger.error(
        PHASE, 'FrameWorker', `worker error: ${message}`,
        'the frame is counted as lost; the pipeline keeps running so the loss rate is ' +
          'visible in FRAME-001 rather than the run simply ending',
      );
    };

    this.running = true;
    this.startedAt = performance.now();
    this.stoppedAt = null;
    this.segments.start(this.startedAt, false);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.scheduleNextFrame();
    logger.info(PHASE, 'FramePipeline', 'pipeline started', {
      startTier: tierLabel(this.controller.currentTier()),
      routeOrder: [...ROUTE_ORDER],
    });
    return true;
  }

  stop(reason: string): void {
    if (!this.running && !this.worker) return;
    this.running = false;
    const now = performance.now();
    this.stoppedAt = now;
    this.acquiring = false;
    this.cancelScheduled();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.pending) {
      // Honest accounting: a frame in the worker when the pipeline stops never came back.
      this.lost++;
      this.pending = null;
    }
    this.segments.close(now, reason);
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'shutdown' });
      } catch {
        // The worker is already gone; terminate below is the part that matters.
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.video = null;
    logger.info(PHASE, 'FramePipeline', `pipeline stopped: ${reason}`, {
      admitted: this.admitted,
      completed: this.completed,
      lost: this.lost,
    });
  }

  private reset(): void {
    this.frameSeq = 0;
    this.callbacks = 0;
    this.admitted = 0;
    this.completed = 0;
    this.pacedOut = 0;
    this.backpressured = 0;
    this.lost = 0;
    this.acquireFailures = 0;
    this.pending = null;
    this.acquiring = false;
    this.nextDueAt = 0;
    this.lastStripAt = 0;
    this.lastCrossCheckAt = 0;
    this.pendingCrossChecks.clear();
    this.resultTimes.length = 0;
    this.callbackTimes.length = 0;
    this.maxResultGapMs = 0;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.sourceSizes.length = 0;
    this.processedSizes.length = 0;
    this.sourceChangedAt = null;
    this.framesAfterSourceChange = 0;
    this.procMatchedAfterSourceChange = null;
    this.maxAspectError = 0;
    this.overBudgetFrames = 0;
    this.upscaledFrames = 0;
    this.lastLevels = [];
    this.pyramidProblems.length = 0;
    this.lastMeanLuma = -1;
    this.topMads.length = 0;
    this.topMadMax = -1;
    this.checksums.clear();
    this.lastStrip = null;
    this.previousStrip = null;
    this.stripMads.length = 0;
    this.stripMadMax = -1;
    this.tierFrames.clear();
    this.decisionOutcomes.length = 0;
    this.outcomeInProgress = null;
    this.stressPasses = 0;
    this.stressIntervals.length = 0;
    this.hiddenCount = 0;
    this.wasEverHidden = false;
    this.spontaneousDegrade = false;
    this.recentFrames.length = 0;
    this.workerErrors.length = 0;
    this.workerScope = null;
    this.workerStarted = false;
    this.routeIndex = 0;
    this.routeLocked = false;
    this.noRouteAvailable = false;
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.hiddenCount++;
      this.wasEverHidden = true;
      this.segments.noteHidden();
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Scheduling                                                              */
  /* ---------------------------------------------------------------------- */

  private scheduleNextFrame(): void {
    const video = this.video;
    if (!this.running || !video) return;

    const rvfc = (video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }).requestVideoFrameCallback;

    if (typeof rvfc === 'function') {
      this.rvfcHandle = rvfc.call(video, () => {
        void this.onVideoFrame();
        this.scheduleNextFrame();
      });
    } else {
      // The declared fallback. A rAF tick is not a frame, so `currentTime` gates it — the
      // same guard Phase 1's monitor used, for the same reason.
      this.rafHandle = requestAnimationFrame(() => {
        void this.onVideoFrame();
        this.scheduleNextFrame();
      });
    }
  }

  private cancelScheduled(): void {
    const video = this.video;
    if (this.rvfcHandle !== null && video) {
      const cancel = (video as unknown as { cancelVideoFrameCallback?: (h: number) => void })
        .cancelVideoFrameCallback;
      if (typeof cancel === 'function') cancel.call(video, this.rvfcHandle);
    }
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = null;
    this.rafHandle = null;
  }

  /**
   * One camera frame offered to the pipeline.
   *
   * Everything in the synchronous part of this method is charged to the UI thread and
   * measured against §55's 16.7 ms, which is what FRAME-005 reports.
   */
  private async onVideoFrame(): Promise<void> {
    const video = this.video;
    if (!this.running || !video || !this.worker) return;
    this.callbacks++;

    const t0 = performance.now();
    const now = t0;
    this.callbackTimes.push(now);
    if (this.callbackTimes.length > RATE_WINDOW) this.callbackTimes.shift();

    if (this.pending && now - this.pending.sentAtPerf > PENDING_TIMEOUT_MS) {
      const stale = this.pending;
      this.pending = null;
      this.lost++;
      this.pendingCrossChecks.delete(stale.frameId);
      this.crossCheck.noteUnmatched();
      logger.error(
        PHASE, 'FramePipeline', `frame ${stale.frameId} never returned from the worker`,
        'the slot is released so the pipeline recovers, and the frame is counted as lost ' +
          'rather than forgotten — FRAME-001 holds the loss rate to 2%',
        undefined,
        { pendingMs: Math.round(now - stale.sentAtPerf) },
      );
    }

    this.observeSourceGeometry(video, now);

    const tier = this.controller.currentTier();
    const minInterval = 1000 / tier.targetFps;
    if (this.nextDueAt > 0 && now + PACING_TOLERANCE_MS < this.nextDueAt) {
      this.pacedOut++;
      return;
    }
    if (this.pending || this.acquiring) {
      this.backpressured++;
      return;
    }
    if (this.noRouteAvailable) return;

    const proc = deriveProcessingSize(video.videoWidth, video.videoHeight, tier);
    if (proc.width < 2 || proc.height < 2) return;

    // The route is settled before anything is measured for this frame: a cross-check sample
    // taken for a frame that is then never sent would sit in the pending map forever.
    const route = this.currentRoute();
    if (!route) return;
    const state = this.routeStates.get(route);
    if (!state) return;

    const frameId = ++this.frameSeq;
    const wantStrip = now - this.lastStripAt >= STRIP_INTERVAL_MS;

    // The cross-check reads the same video frame the worker is about to be given, on this
    // thread, right now. Its cost is subtracted out below and reported on its own — it is
    // verification instrumentation, not part of the pipeline (§H.1).
    let crossCheckCostMs = 0;
    if (now - this.lastCrossCheckAt >= CROSSCHECK_INTERVAL_MS) {
      const sample = this.sampleForCrossCheck(video);
      if (sample) {
        crossCheckCostMs = sample.costMs;
        this.lastCrossCheckAt = now;
        this.pendingCrossChecks.set(frameId, { ...sample, at: now });
      }
    }

    this.acquiring = true;
    const acquireStart = performance.now();
    let acquired: { payload: FramePayload; transfer: Transferable[]; syncMs: number } | null = null;
    try {
      state.attempts++;
      acquired = await this.acquire(route, video, proc.width, proc.height);
    } catch (err) {
      this.acquiring = false;
      this.onAcquireFailure(route, state, err);
      if (this.pendingCrossChecks.delete(frameId)) this.crossCheck.noteUnmatched();
      return;
    }
    const acquireMs = performance.now() - acquireStart;
    state.acquire.push(acquireMs);
    this.acquireCost.push(acquireMs);

    const postStart = performance.now();
    this.worker.postMessage(
      {
        type: 'frame',
        frameId,
        postedAtEpoch: Date.now(),
        sourceWidth: video.videoWidth,
        sourceHeight: video.videoHeight,
        procWidth: proc.width,
        procHeight: proc.height,
        tierStep: tier.step,
        payload: acquired.payload,
        wantStrip,
      },
      acquired.transfer,
    );
    const postEnd = performance.now();
    if (wantStrip) this.lastStripAt = now;

    // Synchronous UI cost, charged honestly: the callback body up to the acquire (less the
    // cross-check, which is instrumentation), the synchronous part of the acquire itself,
    // and the post. For the ImageBitmap route the await in between happens off this
    // thread, so the wall-clock span is not charged to the UI.
    const preMs = Math.max(0, acquireStart - t0 - crossCheckCostMs);
    const uiCostMs = preMs + acquired.syncMs + (postEnd - postStart);
    this.uiCost.push(uiCostMs);

    this.admitted++;
    // Advance the cadence, not the clock: the next deadline is one interval after the last
    // one, so jitter does not accumulate. Re-anchor only when far enough behind that
    // catching up would mean a burst.
    this.nextDueAt =
      this.nextDueAt > 0 && now - this.nextDueAt < minInterval * PACING_RESYNC_INTERVALS
        ? this.nextDueAt + minInterval
        : now + minInterval;
    this.pending = { frameId, sentAtPerf: postEnd, uiCostMs };
    this.acquiring = false;
  }

  private observeSourceGeometry(video: HTMLVideoElement, now: number): void {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w < 1 || h < 1) return;
    if (w === this.sourceWidth && h === this.sourceHeight) return;

    const previous = this.sourceWidth > 0 ? `${this.sourceWidth}x${this.sourceHeight}` : null;
    this.sourceWidth = w;
    this.sourceHeight = h;
    const size = `${w}x${h}`;
    if (!this.sourceSizes.includes(size) && this.sourceSizes.length < 8) this.sourceSizes.push(size);

    if (previous) {
      // §H.0: this is an intrinsics change, not a cosmetic one. The controller's window
      // describes the old geometry and is discarded rather than carried across.
      this.sourceChangedAt = now;
      this.framesAfterSourceChange = 0;
      this.procMatchedAfterSourceChange = null;
      this.controller.invalidateWindow('source frame geometry changed');
      logger.info(PHASE, 'FramePipeline', `source frame size changed ${previous} -> ${size}`, {
        note:
          'the processing size is re-derived from this frame onwards; Phase 6 will derive ' +
          'different intrinsics either side of this point (§H.0)',
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Acquisition routes (§H.1)                                               */
  /* ---------------------------------------------------------------------- */

  private currentRoute(): AcquireRoute | null {
    const route = ROUTE_ORDER[this.routeIndex];
    if (!route) {
      if (!this.noRouteAvailable) {
        this.noRouteAvailable = true;
        logger.error(
          PHASE, 'FramePipeline', 'no frame acquisition route works on this platform',
          'the pipeline stops admitting frames and FRAME-001/002 fail; every route that ' +
            'was tried is recorded with the error it raised',
          undefined,
          { tried: [...ROUTE_ORDER] },
        );
      }
      return null;
    }
    return route;
  }

  private async acquire(
    route: AcquireRoute,
    video: HTMLVideoElement,
    width: number,
    height: number,
  ): Promise<{ payload: FramePayload; transfer: Transferable[]; syncMs: number }> {
    const t0 = performance.now();
    if (route === AcquireRoute.VIDEO_FRAME) {
      const frame = new VideoFrame(video);
      return {
        payload: { kind: 'VIDEO_FRAME', frame },
        transfer: [frame as unknown as Transferable],
        syncMs: performance.now() - t0,
      };
    }
    if (route === AcquireRoute.IMAGE_BITMAP) {
      const promise = createImageBitmap(video, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'medium',
      });
      const syncMs = performance.now() - t0;
      const bitmap = await promise;
      if (bitmap.width !== width || bitmap.height !== height) {
        bitmap.close();
        throw new Error(
          `createImageBitmap ignored the requested size: asked ${width}x${height}, ` +
            `got ${bitmap.width}x${bitmap.height}`,
        );
      }
      return { payload: { kind: 'IMAGE_BITMAP', bitmap }, transfer: [bitmap], syncMs };
    }

    // MAIN_CANVAS — the §H.1 route, kept as the declared last resort and measured so the
    // comparison that ruled it out is in the evidence rather than only in the plan.
    const ctx = this.ensureAcquireContext(width, height);
    if (!ctx) throw new Error('no 2D context available on the main thread');
    (ctx as CanvasRenderingContext2D).drawImage(video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return {
      payload: { kind: 'RGBA', buffer: image.data.buffer },
      transfer: [image.data.buffer],
      syncMs: performance.now() - t0,
    };
  }

  private ensureAcquireContext(
    width: number,
    height: number,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    if (!this.acquireCanvas) {
      if (typeof OffscreenCanvas === 'function') {
        this.acquireCanvas = new OffscreenCanvas(width, height);
      } else {
        this.acquireCanvas = document.createElement('canvas');
      }
      this.acquireCtx = (this.acquireCanvas as OffscreenCanvas).getContext('2d', {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    }
    if (this.acquireCanvas.width !== width || this.acquireCanvas.height !== height) {
      this.acquireCanvas.width = width;
      this.acquireCanvas.height = height;
    }
    return this.acquireCtx;
  }

  private onAcquireFailure(route: AcquireRoute, state: RouteState, err: unknown): void {
    this.acquireFailures++;
    state.consecutiveFailures++;
    state.error = describeError(err);
    state.note = `failed on the main thread: ${state.error}`;
    logger.error(
      PHASE, 'FramePipeline', `frame acquisition failed on route ${route}`,
      this.routeLocked
        ? 'the frame is skipped; after 5 consecutive failures the route is abandoned and ' +
          'the next one in the ladder is tried'
        : 'the route is abandoned and the next one in the ladder is tried',
      err,
    );
    if (!this.routeLocked || state.consecutiveFailures >= ROUTE_UNLOCK_FAILURES) {
      this.advanceRoute(route, state.error);
    }
  }

  private advanceRoute(from: AcquireRoute, reason: string): void {
    this.routeIndex++;
    this.routeLocked = false;
    const next = ROUTE_ORDER[this.routeIndex];
    logger.warn(PHASE, 'FramePipeline', `acquisition route ${from} abandoned`, {
      reason,
      next: next ?? 'none — the ladder is exhausted',
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Worker results                                                          */
  /* ---------------------------------------------------------------------- */

  private onWorkerMessage(msg: FromWorkerMessage): void {
    if (msg.type === 'hello') {
      this.workerStarted = true;
      this.workerScope = msg.scope;
      logger.info(PHASE, 'FrameWorker', 'preprocessing worker ready', {
        hasDocument: msg.scope.hasDocument,
        isWorkerGlobalScope: msg.scope.isWorkerGlobalScope,
        canvas2dAvailable: msg.scope.canvas2dAvailable,
      });
      this.hooks.onStateChange?.();
      return;
    }
    if (msg.type === 'error') {
      this.workerErrors.push(msg.message);
      if (msg.frameId !== null && this.pending?.frameId === msg.frameId) {
        this.pending = null;
        this.lost++;
        this.pendingCrossChecks.delete(msg.frameId);
        this.crossCheck.noteUnmatched();
      }
      const route = msg.route;
      const state = route ? this.routeStates.get(route) : undefined;
      if (route && state) {
        state.consecutiveFailures++;
        state.error = msg.message;
        state.note = `failed inside the worker: ${msg.message}`;
        if (!this.routeLocked || state.consecutiveFailures >= ROUTE_UNLOCK_FAILURES) {
          this.advanceRoute(route, msg.message);
        }
      }
      logger.error(
        PHASE, 'FrameWorker', `worker rejected a frame: ${msg.message}`,
        'the frame is counted as lost and, if the route is still on probation, the next ' +
          'acquisition route is tried',
        undefined,
        { frameId: msg.frameId, route, context: msg.context },
      );
      this.hooks.onStateChange?.();
      return;
    }
    this.onResult(msg);
  }

  private onResult(result: ResultMessage): void {
    const now = performance.now();
    const pending = this.pending;
    if (pending?.frameId === result.frameId) this.pending = null;

    this.completed++;
    const roundTripMs = pending ? now - pending.sentAtPerf : -1;
    if (roundTripMs >= 0) this.roundTrip.push(roundTripMs);
    this.workerCost.push(result.workerMs);
    if (result.stressPasses === 0 && result.pyramidMs > 0) {
      // The unstressed cost of one pyramid build, which is what a load level is computed
      // from. Measured, never assumed.
      this.pyramidPassCost.push(result.pyramidMs);
    }

    const state = this.routeStates.get(result.route);
    if (state) {
      state.successes++;
      state.consecutiveFailures = 0;
      state.note = 'round trip completed';
      if (!this.routeLocked && result.route === ROUTE_ORDER[this.routeIndex]) {
        if (state.successes >= ROUTE_LOCK_SUCCESSES) {
          this.routeLocked = true;
          logger.info(PHASE, 'FramePipeline', `acquisition route ${result.route} selected`, {
            successes: state.successes,
            meanAcquireMs: Math.round(state.acquire.mean * 1000) / 1000,
          });
        }
      }
    }

    /* Continuity */
    if (this.resultTimes.length > 0) {
      const last = this.resultTimes[this.resultTimes.length - 1] ?? now;
      const gap = now - last;
      if (gap > this.maxResultGapMs) this.maxResultGapMs = gap;
    }
    this.resultTimes.push(now);
    if (this.resultTimes.length > RATE_WINDOW) this.resultTimes.shift();
    this.segments.noteResult(now);

    /* Geometry checks (§H.0, FRAME-003, FRAME-006) */
    const procSize = `${result.procWidth}x${result.procHeight}`;
    if (!this.processedSizes.includes(procSize) && this.processedSizes.length < 12) {
      this.processedSizes.push(procSize);
    }
    const tier = tierAt(result.tierStep);
    if (result.procWidth * result.procHeight > tierPixelBudget(tier)) this.overBudgetFrames++;
    if (result.procWidth > result.sourceWidth || result.procHeight > result.sourceHeight) {
      this.upscaledFrames++;
    }
    const ae = aspectError(result.sourceWidth, result.sourceHeight, result.procWidth, result.procHeight);
    if (Number.isFinite(ae) && ae > this.maxAspectError) this.maxAspectError = ae;

    if (this.sourceChangedAt !== null) {
      this.framesAfterSourceChange++;
      if (this.procMatchedAfterSourceChange === null) {
        const expected = deriveProcessingSize(result.sourceWidth, result.sourceHeight, tier);
        this.procMatchedAfterSourceChange =
          expected.width === result.procWidth && expected.height === result.procHeight;
      }
    }

    /* Pyramid self-consistency (FRAME-002 criterion 4) */
    this.lastLevels = result.levels;
    this.checkPyramid(result);

    /* Image measurements */
    this.lastMeanLuma = result.meanLuma;
    if (result.topLevelMad >= 0) {
      this.topMads.push(result.topLevelMad);
      if (this.topMads.length > 600) this.topMads.shift();
      if (result.topLevelMad > this.topMadMax) this.topMadMax = result.topLevelMad;
    }
    if (this.checksums.size < 4000) this.checksums.add(result.checksum);
    if (result.strip) {
      const strip = new Uint8Array(result.strip);
      const mad = this.previousStrip ? madBetween(strip, this.previousStrip) : -1;
      if (mad >= 0) {
        this.stripMads.push(mad);
        if (this.stripMads.length > 600) this.stripMads.shift();
        if (mad > this.stripMadMax) this.stripMadMax = mad;
      }
      this.previousStrip = strip;
      this.lastStrip = strip;
    }

    /* Provenance cross-check (FRAME-002 criterion 2) */
    const cc = this.pendingCrossChecks.get(result.frameId);
    if (cc) {
      this.pendingCrossChecks.delete(result.frameId);
      this.crossCheck.add({
        frameId: result.frameId,
        at: cc.at,
        mainMeanLuma: Math.round(cc.mean * 1000) / 1000,
        workerMeanLuma: Math.round(result.meanLuma * 1000) / 1000,
        absDifference: Math.abs(cc.mean - result.meanLuma),
        costMs: cc.costMs,
      });
    }

    this.recentFrames.push({
      frameId: result.frameId,
      at: Math.round(now),
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      procWidth: result.procWidth,
      procHeight: result.procHeight,
      tierStep: result.tierStep,
      workerMs: Math.round(result.workerMs * 100) / 100,
      roundTripMs: Math.round(roundTripMs * 100) / 100,
      meanLuma: Math.round(result.meanLuma * 100) / 100,
      checksum: result.checksum,
      stressPasses: result.stressPasses,
    });
    if (this.recentFrames.length > RECENT_FRAMES) this.recentFrames.shift();

    const usage = this.tierFrames.get(result.tierStep) ?? { frames: 0, sizes: new Set<string>() };
    usage.frames++;
    if (usage.sizes.size < 8) usage.sizes.add(procSize);
    this.tierFrames.set(result.tierStep, usage);

    const outcome = this.outcomeInProgress;
    if (outcome) {
      outcome.samples.push(result.workerMs);
      if (outcome.samples.length >= 15) {
        const sorted = [...outcome.samples].sort((a, b) => a - b);
        const m = sorted.length >> 1;
        const after = sorted.length % 2
          ? (sorted[m] ?? 0)
          : (((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2);
        this.decisionOutcomes.push({
          decisionIndex: outcome.decisionIndex,
          direction: outcome.direction,
          beforeMedianWorkerMs: Math.round(outcome.before * 100) / 100,
          afterMedianWorkerMs: Math.round(after * 100) / 100,
          samples: outcome.samples.length,
        });
        this.outcomeInProgress = null;
      }
    }

    /* Adaptation */
    const decision = this.controller.observe({
      at: now,
      workerMs: result.workerMs,
      deliveredFps: this.deliveredFps(),
      sourceFps: this.sourceFps(),
    });
    if (decision) this.onTierDecision(decision);

    this.hooks.onStateChange?.();
  }

  private checkPyramid(result: ResultMessage): void {
    const problems: string[] = [];
    const expected = levelGeometry(result.procWidth, result.procHeight, PYRAMID_LEVELS);
    if (result.levels.length !== PYRAMID_LEVELS) {
      problems.push(`${result.levels.length} levels, expected ${PYRAMID_LEVELS}`);
    }
    result.levels.forEach((level, i) => {
      const want = expected[i];
      if (!want) return;
      if (level.width !== want.width || level.height !== want.height) {
        problems.push(
          `level ${i} is ${level.width}x${level.height}, but halving ${result.procWidth}x` +
            `${result.procHeight} gives ${want.width}x${want.height}`,
        );
      }
      if (level.bytes !== level.width * level.height) {
        problems.push(
          `level ${i} reports ${level.bytes} bytes for ${level.width}x${level.height} — ` +
            'the buffer does not hold the image it claims to',
        );
      }
    });
    for (const p of problems) {
      if (!this.pyramidProblems.includes(p) && this.pyramidProblems.length < 20) {
        this.pyramidProblems.push(p);
      }
    }
  }

  private onTierDecision(decision: TierDecision): void {
    const stressed = this.segments.currentStressed();
    this.outcomeInProgress = {
      decisionIndex: this.controller.decisions().length - 1,
      before: decision.medianWorkerMs,
      direction: decision.direction,
      samples: [],
    };
    if (decision.direction === 'DOWN' && !stressed) this.spontaneousDegrade = true;
    logger.info(
      PHASE, 'AdaptiveController',
      `tier ${decision.direction}: ${decision.fromLabel} -> ${decision.toLabel}`,
      {
        reason: decision.reason,
        medianWorkerMs: decision.medianWorkerMs,
        budgetMs: decision.budgetMs,
        underInjectedLoad: stressed,
      },
    );
    this.hooks.onStateChange?.();
  }

  /* ---------------------------------------------------------------------- */
  /* Provenance cross-check                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The main thread's own measurement of the video frame the worker is about to receive.
   *
   * This is the §H.1 operation, deliberately: it is the one route whose result cannot have
   * come from the pipeline, which is exactly what makes it usable as a check on the
   * pipeline. It costs what it costs, at 1 Hz, and the cost is reported.
   */
  private sampleForCrossCheck(video: HTMLVideoElement): { mean: number; costMs: number } | null {
    if (video.videoWidth < 1 || video.videoHeight < 1) return null;
    if (!this.crossCheckCanvas) {
      if (typeof OffscreenCanvas === 'function') {
        this.crossCheckCanvas = new OffscreenCanvas(STRIP_W, STRIP_H);
      } else {
        const c = document.createElement('canvas');
        c.width = STRIP_W;
        c.height = STRIP_H;
        this.crossCheckCanvas = c;
      }
      this.crossCheckCtx = (this.crossCheckCanvas as OffscreenCanvas).getContext('2d', {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    }
    const ctx = this.crossCheckCtx;
    if (!ctx) return null;
    const started = performance.now();
    try {
      (ctx as CanvasRenderingContext2D).drawImage(video, 0, 0, STRIP_W, STRIP_H);
      const data = ctx.getImageData(0, 0, STRIP_W, STRIP_H).data;
      const mean = rgbaToGray(data, this.crossCheckGray);
      return { mean, costMs: performance.now() - started };
    } catch (err) {
      logger.error(
        PHASE, 'FramePipeline', 'the provenance cross-check could not read the video frame',
        'the sample is skipped rather than recorded as agreement; FRAME-002 requires at ' +
          'least five real samples, so repeated failures leave it PENDING',
        err,
      );
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Load injection                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Switch injected load on or off.
   *
   * The pass count is *computed from measurement*, not chosen: it targets a worker latency
   * of roughly twice the current tier's budget, using the measured cost of one real pyramid
   * build on this device. That is why the same control produces a meaningful overload on a
   * fast laptop and on a phone without either number being written into the source.
   *
   * Returns the reason it refused, or `null` on success.
   */
  setStress(on: boolean): string | null {
    if (!this.running || !this.worker) return 'the pipeline is not running';
    if (on === (this.stressPasses > 0)) return null;

    const now = performance.now();
    if (!on) {
      this.stressPasses = 0;
      this.worker.postMessage({ type: 'stress', passes: 0 });
      const open = this.stressIntervals[this.stressIntervals.length - 1];
      if (open && open.endedAt === null) {
        this.stressIntervals[this.stressIntervals.length - 1] = { ...open, endedAt: Math.round(now) };
      }
      this.segments.setStressed(now, false);
      logger.info(PHASE, 'FramePipeline', 'load injection stopped', {});
      this.hooks.onStateChange?.();
      return null;
    }

    const passCost = this.pyramidPassCost.mean;
    const baseline = this.workerCost.mean;
    if (this.pyramidPassCost.count < 10 || passCost <= 0) {
      return (
        'no unstressed baseline yet — the load level is derived from the measured cost of ' +
        'one pyramid build, so the pipeline has to run normally for a moment first'
      );
    }
    const budget = budgetForTier(this.controller.currentTier());
    const targetMs = STRESS_TARGET_BUDGET_MULTIPLE * budget;
    const passes = Math.min(
      MAX_STRESS_PASSES,
      Math.max(1, Math.ceil((targetMs - baseline) / passCost)),
    );
    const derivedFrom =
      `target ${Math.round(targetMs)} ms (${STRESS_TARGET_BUDGET_MULTIPLE}x the ` +
      `${Math.round(budget)} ms budget at ${tierLabel(this.controller.currentTier())}), ` +
      `measured baseline ${Math.round(baseline * 100) / 100} ms and ` +
      `${Math.round(passCost * 1000) / 1000} ms per pyramid build over ` +
      `${this.pyramidPassCost.count} unstressed frames`;

    this.stressPasses = passes;
    this.worker.postMessage({ type: 'stress', passes });
    this.stressIntervals.push({ startedAt: Math.round(now), endedAt: null, passes, derivedFrom });
    this.segments.setStressed(now, true);
    logger.info(PHASE, 'FramePipeline', `load injection started: ${passes} extra pyramid passes`, {
      derivedFrom,
      note:
        'a stimulus, not a result — the extra passes are real work on real data, and every ' +
        'latency the controller sees remains a measurement (§28)',
    });
    this.hooks.onStateChange?.();
    return null;
  }

  isStressed(): boolean {
    return this.stressPasses > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Reporting                                                               */
  /* ---------------------------------------------------------------------- */

  private deliveredFps(): number {
    return rateOf(this.resultTimes);
  }

  /** What the camera is offering, which is the ceiling on what the pipeline can deliver. */
  private sourceFps(): number {
    return rateOf(this.callbackTimes);
  }

  /** The most recent proof strip, for the UI. 64×48 grayscale, straight from the worker. */
  getLastStrip(): { data: Uint8Array; width: number; height: number } | null {
    return this.lastStrip ? { data: this.lastStrip, width: STRIP_W, height: STRIP_H } : null;
  }

  getStats(): PipelineStats {
    const now = performance.now();
    const tier = this.controller.currentTier();
    const proc = deriveProcessingSize(this.sourceWidth, this.sourceHeight, tier);
    const decisions = this.controller.decisions();
    // Uptime freezes when the pipeline stops: a stopped pipeline that keeps accruing
    // seconds would quietly dilute every per-second figure derived from it.
    const endedAt = this.stoppedAt ?? now;
    const uptimeMs = this.startedAt === null ? 0 : endedAt - this.startedAt;
    const sessionSpan = this.resultTimes.length > 1 ? uptimeMs : 0;

    const topMadMedian = medianOf(this.topMads);

    let maxPer10s = 0;
    for (const d of decisions) {
      const n = decisions.filter((o) => o.at >= d.at && o.at - d.at <= 10_000).length;
      if (n > maxPer10s) maxPer10s = n;
    }

    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeMs: Math.round(uptimeMs),

      route: this.routeLocked ? (ROUTE_ORDER[this.routeIndex] ?? null) : null,
      routeLocked: this.routeLocked,
      routeProbes: this.routeReports(),

      workerStarted: this.workerStarted,
      workerScope: this.workerScope,
      workerErrors: [...this.workerErrors].slice(-20),

      callbacks: this.callbacks,
      admitted: this.admitted,
      completed: this.completed,
      pacedOut: this.pacedOut,
      backpressured: this.backpressured,
      lost: this.lost,
      acquireFailures: this.acquireFailures,

      deliveredFps: Math.round(this.deliveredFps() * 100) / 100,
      sourceFps: Math.round(this.sourceFps() * 100) / 100,
      sessionDeliveredFps:
        sessionSpan > 0 ? Math.round((this.completed / (sessionSpan / 1000)) * 100) / 100 : 0,
      maxResultGapMs: Math.round(this.maxResultGapMs * 100) / 100,

      uiCostMs: this.uiCost.summary(),
      acquireMs: this.acquireCost.summary(),
      workerMs: this.workerCost.summary(),
      roundTripMs: this.roundTrip.summary(),

      tierStep: tier.step,
      tierLabel: tierLabel(tier),
      targetFps: tier.targetFps,
      procWidth: proc.width,
      procHeight: proc.height,
      decisions: [...decisions],
      spontaneousDegrade: this.spontaneousDegrade,
      maxDecisionsPer10s: maxPer10s,

      sourceSizesObserved: [...this.sourceSizes],
      processedSizesObserved: [...this.processedSizes],
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      maxAspectError: Math.round(this.maxAspectError * 10000) / 10000,
      overBudgetFrames: this.overBudgetFrames,
      upscaledFrames: this.upscaledFrames,
      framesAfterSourceChange: this.framesAfterSourceChange,
      procMatchedAfterSourceChange: this.procMatchedAfterSourceChange,

      tierUsage: this.tierUsage(),
      decisionOutcomes: [...this.decisionOutcomes],

      pyramidLevels: this.lastLevels.map((l) => ({ ...l })),
      pyramidConsistent: this.completed > 0 && this.pyramidProblems.length === 0,
      pyramidProblems: [...this.pyramidProblems],
      meanLuma: Math.round(this.lastMeanLuma * 100) / 100,
      topMadMax: Math.round(this.topMadMax * 1000) / 1000,
      topMadMedian: Math.round(topMadMedian * 1000) / 1000,
      topMadSamples: this.topMads.length,
      stripMadMax: Math.round(this.stripMadMax * 1000) / 1000,
      stripMadMedian: Math.round(medianOf(this.stripMads) * 1000) / 1000,
      stripMadSamples: this.stripMads.length,
      distinctChecksums: this.checksums.size,
      crossCheck: {
        count: this.crossCheck.count,
        unmatched: this.crossCheck.unmatchedCount,
        medianAbsDifference: this.crossCheck.medianAbsDifference(),
        maxAbsDifference: this.crossCheck.maxAbsDifference(),
        sceneStdDev: this.crossCheck.sceneStdDev(),
        sceneRange: this.crossCheck.sceneRange(),
        costMs: this.crossCheck.costSummary(),
      },

      stressPasses: this.stressPasses,
      stressIntervals: [...this.stressIntervals],
      anyStressed: this.segments.anyStressed(now),

      segments: this.segments.segments(now),
      longestCleanSegment: this.segments.longestClean(now),
      wasEverHidden: this.wasEverHidden,
      hiddenCount: this.hiddenCount,

      recentFrames: [...this.recentFrames],
    };
  }

  private tierUsage(): TierUsage[] {
    return [...this.tierFrames.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, u]) => ({
        step,
        label: tierLabel(tierAt(step)),
        frames: u.frames,
        sizes: [...u.sizes],
      }));
  }

  private routeReports(): RouteProbeRecord[] {
    return ROUTE_ORDER.map((route, i) => {
      const s = this.routeStates.get(route);
      const selected = this.routeLocked && i === this.routeIndex;
      return {
        route,
        ok: (s?.successes ?? 0) > 0,
        attempts: s?.attempts ?? 0,
        successes: s?.successes ?? 0,
        meanAcquireMs: Math.round((s?.acquire.mean ?? 0) * 1000) / 1000,
        error: s?.error ?? null,
        note: selected
          ? 'selected'
          : i < this.routeIndex
            ? `abandoned: ${s?.error ?? 'no reason recorded'}`
            : i === this.routeIndex
              ? `on probation — ${s?.successes ?? 0}/${ROUTE_LOCK_SUCCESSES} round trips`
              : 'not reached; an earlier route is in use',
      };
    });
  }

  describe(): Record<string, JsonValue> {
    const now = performance.now();
    const stats = this.getStats();
    return toJsonSafe({
      ...stats,
      // Bounded: the ring already caps at 240, and the tail is what a reader inspects.
      recentFrames: stats.recentFrames.slice(-40),
      controller: this.controller.describe(),
      segmentLog: this.segments.describe(now),
      crossCheckDetail: this.crossCheck.describe(),
      ladder: TIER_LADDER.map((t) => ({
        step: t.step,
        label: tierLabel(t),
        pixelBudget: tierPixelBudget(t),
        budgetMs: Math.round(budgetForTier(t) * 100) / 100,
      })),
      routeOrder: [...ROUTE_ORDER],
      constants: {
        pacingResyncIntervals: PACING_RESYNC_INTERVALS,
        pacingToleranceMs: PACING_TOLERANCE_MS,
        routeLockSuccesses: ROUTE_LOCK_SUCCESSES,
        pendingTimeoutMs: PENDING_TIMEOUT_MS,
        stripIntervalMs: STRIP_INTERVAL_MS,
        crossCheckIntervalMs: CROSSCHECK_INTERVAL_MS,
        stressTargetBudgetMultiple: STRESS_TARGET_BUDGET_MULTIPLE,
        pyramidLevels: PYRAMID_LEVELS,
        stripSize: `${STRIP_W}x${STRIP_H}`,
      },
      note:
        'Frames declined by rate pacing (pacedOut) are the scheduler working as designed ' +
        'and are not drops. Frames declined because the worker was busy (backpressured) ' +
        'are deliberate too. Only `lost` counts frames that were handed over and never ' +
        'came back, and only that is held against FRAME-001.',
    }) as Record<string, JsonValue>;
  }
}
