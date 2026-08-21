/**
 * Frame integrity monitor (CAM-003, CAM-004).
 *
 * Answers two questions that a video element cannot answer by looking correct:
 * are frames still arriving, and is the image actually changing?
 *
 * A frozen stream, a black stream from a camera another app holds, or a still image
 * substituted for a camera all render as "a picture on screen". The only way to tell them
 * from a live camera is to measure the pixels over time, so this reads a small downsample
 * and reports the distribution of frame-to-frame difference alongside the noise floor.
 *
 * This is **verification instrumentation, not the frame pipeline.** It samples at ~4 Hz
 * into a 64×48 buffer — about 3 kB per sample — precisely so that Phase 1 can prove the
 * stream is real without pre-empting Phase 2's design (§10: worker, OffscreenCanvas,
 * adaptive resolution). Its cost is measured and reported so that claim is checkable.
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';

/** Small enough to be free, large enough that motion is unambiguous. */
const SAMPLE_W = 64;
const SAMPLE_H = 48;
const SAMPLE_INTERVAL_MS = 250;
/** §9 requires 30 s of continuous capture. */
export const REQUIRED_CAPTURE_MS = 30_000;

export interface FrameSample {
  readonly t: number;
  /** Mean absolute difference against the previous sample, 0–255. */
  readonly mad: number;
  readonly meanLuma: number;
}

export interface FrameStats {
  readonly frameCount: number;
  readonly firstFrameAt: number | null;
  readonly lastFrameAt: number | null;
  readonly observedMs: number;
  readonly meanFps: number;
  readonly maxGapMs: number;
  readonly source: 'requestVideoFrameCallback' | 'requestAnimationFrame' | 'none';
  readonly sampleCount: number;
  readonly madMin: number;
  readonly madMedian: number;
  readonly madMean: number;
  readonly madMax: number;
  readonly lumaMin: number;
  readonly lumaMax: number;
  readonly hiddenCount: number;
  readonly wasEverHidden: boolean;
  readonly orientationChanges: number;
  readonly lastOrientationAngle: number | null;
  readonly framesAfterLastOrientationChange: number;
  readonly msFromOrientationChangeToNextFrame: number | null;
  readonly sampleCostMsMean: number;
  /**
   * Dimensions of the largest frame actually seen, as a pair.
   *
   * The element reports 0x0 once the stream is detached, so reading it at export time says
   * nothing about whether the preview ever rendered. This remembers what was observed.
   *
   * Kept as a pair rather than a per-axis maximum: rotating the device swaps the frame
   * dimensions, and taking each axis's maximum independently reported "1280x1280" for a
   * 1280x720 camera — a size no frame ever had.
   */
  readonly videoWidthObserved: number;
  readonly videoHeightObserved: number;
  /**
   * Every distinct frame size seen, in the order first seen.
   *
   * More than one entry means the stream re-negotiated mid-session, which rotation does on
   * iOS. Phase 6 derives camera intrinsics from the frame dimensions, so a size change is
   * an intrinsics change and cannot be treated as noise.
   */
  readonly videoSizesObserved: readonly string[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}

export class FrameIntegrityMonitor {
  private video: HTMLVideoElement | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private source: FrameStats['source'] = 'none';

  private frameCount = 0;
  private firstFrameAt: number | null = null;
  private lastFrameAt: number | null = null;
  private maxGapMs = 0;
  private videoWidthObserved = 0;
  private videoHeightObserved = 0;
  private videoSizesObserved: string[] = [];

  private samples: FrameSample[] = [];
  private previousGray: Uint8ClampedArray | null = null;
  private lastSampleAt = 0;
  private sampleCosts: number[] = [];

  private hiddenCount = 0;
  private wasEverHidden = false;
  private orientationChanges = 0;
  private lastOrientationAngle: number | null = null;
  private orientationChangedAt: number | null = null;
  private msFromOrientationChangeToNextFrame: number | null = null;
  private framesAfterLastOrientationChange = 0;

  private onVisibility = (): void => {
    if (document.hidden) {
      this.hiddenCount++;
      this.wasEverHidden = true;
    }
  };

  private onOrientation = (): void => {
    const angle = this.readOrientationAngle();
    if (angle !== null && angle !== this.lastOrientationAngle) {
      this.orientationChanges++;
      this.lastOrientationAngle = angle;
      this.orientationChangedAt = performance.now();
      this.framesAfterLastOrientationChange = 0;
      this.msFromOrientationChangeToNextFrame = null;
    }
  };

  private readOrientationAngle(): number | null {
    const o = screen.orientation as ScreenOrientation | undefined;
    if (o && typeof o.angle === 'number') return o.angle;
    const legacy = (window as unknown as { orientation?: number }).orientation;
    return typeof legacy === 'number' ? legacy : null;
  }

  start(video: HTMLVideoElement): void {
    if (this.running) this.stop();
    this.reset();
    this.video = video;
    this.running = true;

    // OffscreenCanvas measured AVAILABLE on the target; the element canvas is the
    // declared fallback and both were proven byte-exact by CAP-0008.
    if (typeof OffscreenCanvas === 'function') {
      this.ctx = new OffscreenCanvas(SAMPLE_W, SAMPLE_H).getContext('2d', {
        willReadFrequently: true,
      });
    }
    if (!this.ctx) {
      const c = document.createElement('canvas');
      c.width = SAMPLE_W;
      c.height = SAMPLE_H;
      this.ctx = c.getContext('2d', { willReadFrequently: true });
    }

    this.lastOrientationAngle = this.readOrientationAngle();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('orientationchange', this.onOrientation);
    screen.orientation?.addEventListener?.('change', this.onOrientation);

    const rvfc = (video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }).requestVideoFrameCallback;

    if (typeof rvfc === 'function') {
      this.source = 'requestVideoFrameCallback';
      const tick = (): void => {
        if (!this.running || !this.video) return;
        this.onFrame();
        this.rvfcHandle = rvfc.call(this.video, tick);
      };
      this.rvfcHandle = rvfc.call(video, tick);
    } else {
      // Fallback: rAF plus currentTime change detection, so a paused video does not
      // register frames that never arrived.
      this.source = 'requestAnimationFrame';
      let lastMediaTime = -1;
      const tick = (): void => {
        if (!this.running || !this.video) return;
        if (this.video.currentTime !== lastMediaTime) {
          lastMediaTime = this.video.currentTime;
          this.onFrame();
        }
        this.rafHandle = requestAnimationFrame(tick);
      };
      this.rafHandle = requestAnimationFrame(tick);
    }
  }

  private onFrame(): void {
    const now = performance.now();
    if (this.firstFrameAt === null) {
      this.firstFrameAt = now;
    } else if (this.lastFrameAt !== null) {
      const gap = now - this.lastFrameAt;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
    }
    this.lastFrameAt = now;
    this.frameCount++;

    const v = this.video;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      // Largest by area, so the recorded pair is a size the element genuinely reported.
      if (v.videoWidth * v.videoHeight > this.videoWidthObserved * this.videoHeightObserved) {
        this.videoWidthObserved = v.videoWidth;
        this.videoHeightObserved = v.videoHeight;
      }
      const size = `${v.videoWidth}x${v.videoHeight}`;
      // Bounded: a stream that renegotiates constantly would otherwise grow this without
      // limit, and eight distinct sizes is already the interesting fact.
      if (!this.videoSizesObserved.includes(size) && this.videoSizesObserved.length < 8) {
        this.videoSizesObserved.push(size);
      }
    }

    if (this.orientationChangedAt !== null) {
      this.framesAfterLastOrientationChange++;
      if (this.msFromOrientationChangeToNextFrame === null) {
        this.msFromOrientationChangeToNextFrame = now - this.orientationChangedAt;
      }
    }

    if (now - this.lastSampleAt >= SAMPLE_INTERVAL_MS) {
      this.lastSampleAt = now;
      this.sample(now);
    }
  }

  private sample(now: number): void {
    const video = this.video;
    const ctx = this.ctx;
    if (!video || !ctx || video.videoWidth === 0 || video.videoHeight === 0) return;

    const started = performance.now();
    try {
      (ctx as CanvasRenderingContext2D).drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

      const gray = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
      let lumaSum = 0;
      for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        // Rec. 601 luma, integer-weighted to keep this cheap.
        const y = ((data[p] ?? 0) * 77 + (data[p + 1] ?? 0) * 150 + (data[p + 2] ?? 0) * 29) >> 8;
        gray[i] = y;
        lumaSum += y;
      }
      const meanLuma = lumaSum / gray.length;

      let mad = 0;
      const prev = this.previousGray;
      if (prev) {
        let diff = 0;
        for (let i = 0; i < gray.length; i++) diff += Math.abs((gray[i] ?? 0) - (prev[i] ?? 0));
        mad = diff / gray.length;
        this.samples.push({ t: now, mad: round(mad, 3), meanLuma: round(meanLuma, 2) });
      }
      this.previousGray = gray;
      this.sampleCosts.push(performance.now() - started);
      if (this.sampleCosts.length > 200) this.sampleCosts.shift();
    } catch {
      // A cross-origin or not-yet-decodable frame throws here. Skipping the sample is
      // correct — it must not be counted as a zero-difference sample, which would look
      // like a frozen image.
    }
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null && this.video) {
      const cancel = (this.video as unknown as { cancelVideoFrameCallback?: (h: number) => void })
        .cancelVideoFrameCallback;
      if (typeof cancel === 'function') cancel.call(this.video, this.rvfcHandle);
    }
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = null;
    this.rafHandle = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('orientationchange', this.onOrientation);
    screen.orientation?.removeEventListener?.('change', this.onOrientation);
    this.video = null;
  }

  private reset(): void {
    this.frameCount = 0;
    this.firstFrameAt = null;
    this.lastFrameAt = null;
    this.maxGapMs = 0;
    this.videoWidthObserved = 0;
    this.videoHeightObserved = 0;
    this.videoSizesObserved = [];
    this.samples = [];
    this.previousGray = null;
    this.lastSampleAt = 0;
    this.sampleCosts = [];
    this.hiddenCount = 0;
    this.wasEverHidden = false;
    this.orientationChanges = 0;
    this.orientationChangedAt = null;
    this.msFromOrientationChangeToNextFrame = null;
    this.framesAfterLastOrientationChange = 0;
  }

  getStats(): FrameStats {
    const mads = this.samples.map((s) => s.mad);
    const lumas = this.samples.map((s) => s.meanLuma);
    const observedMs =
      this.firstFrameAt !== null && this.lastFrameAt !== null
        ? this.lastFrameAt - this.firstFrameAt
        : 0;

    return {
      frameCount: this.frameCount,
      firstFrameAt: this.firstFrameAt,
      lastFrameAt: this.lastFrameAt,
      observedMs: round(observedMs),
      meanFps: observedMs > 0 ? round(((this.frameCount - 1) * 1000) / observedMs) : 0,
      maxGapMs: round(this.maxGapMs),
      source: this.source,
      sampleCount: this.samples.length,
      madMin: mads.length ? round(Math.min(...mads), 3) : 0,
      madMedian: round(median(mads), 3),
      madMean: mads.length ? round(mads.reduce((a, b) => a + b, 0) / mads.length, 3) : 0,
      madMax: mads.length ? round(Math.max(...mads), 3) : 0,
      lumaMin: lumas.length ? round(Math.min(...lumas)) : 0,
      lumaMax: lumas.length ? round(Math.max(...lumas)) : 0,
      hiddenCount: this.hiddenCount,
      wasEverHidden: this.wasEverHidden,
      orientationChanges: this.orientationChanges,
      lastOrientationAngle: this.lastOrientationAngle,
      framesAfterLastOrientationChange: this.framesAfterLastOrientationChange,
      msFromOrientationChangeToNextFrame:
        this.msFromOrientationChangeToNextFrame === null
          ? null
          : round(this.msFromOrientationChangeToNextFrame),
      sampleCostMsMean: this.sampleCosts.length
        ? round(this.sampleCosts.reduce((a, b) => a + b, 0) / this.sampleCosts.length, 3)
        : 0,
      videoWidthObserved: this.videoWidthObserved,
      videoHeightObserved: this.videoHeightObserved,
      videoSizesObserved: [...this.videoSizesObserved],
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      ...this.getStats(),
      sampleGridWidth: SAMPLE_W,
      sampleGridHeight: SAMPLE_H,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      requiredCaptureMs: REQUIRED_CAPTURE_MS,
    }) as Record<string, JsonValue>;
  }
}

/**
 * Pure MAD evaluation, extracted so the CAM-004 thresholds are unit-testable without a
 * camera.
 *
 * The gate is an absolute floor on the peak frame-to-frame difference, and that floor is
 * doing real work rather than being a round number. Sampling box-downsamples 1280×720 to
 * 64×48, averaging roughly 300 source pixels per cell, which attenuates uncorrelated
 * sensor noise by about √300 ≈ 17×. Reaching a mean absolute difference of 8 from noise
 * alone would need a per-pixel σ near 140 on a 0–255 scale, which is not a camera. So a
 * peak of 8 cannot be produced by a static scene, however noisy, and a frozen or still
 * image sits near zero.
 *
 * An earlier version also required the peak to be 4× the median. That was wrong; see the
 * amendment in `docs/phase1/TEST-PLAN.md`. It rejected a camera panned continuously
 * through the whole window — which raises the median along with the peak — and that is the
 * clearest demonstration of a live camera there is.
 */
export const MAD_ABSOLUTE_FLOOR = 8.0;
export const MIN_LUMA = 2.0;
export const MIN_SAMPLES_FOR_MOTION = 20;

export function evaluateImageChange(stats: FrameStats): {
  evaluable: boolean;
  changed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (stats.sampleCount < MIN_SAMPLES_FOR_MOTION) {
    return {
      evaluable: false,
      changed: false,
      reasons: [`${stats.sampleCount}/${MIN_SAMPLES_FOR_MOTION} samples so far`],
    };
  }
  const absoluteOk = stats.madMax >= MAD_ABSOLUTE_FLOOR;
  const notBlack = stats.lumaMax > MIN_LUMA;

  if (!absoluteOk) {
    reasons.push(
      `peak frame-to-frame difference ${stats.madMax} is below the ${MAD_ABSOLUTE_FLOOR} ` +
        'floor, which a static scene cannot exceed after downsampling — consistent with a ' +
        'frozen image, a still photo, or a camera that was never moved',
    );
  }
  if (!notBlack) {
    reasons.push(
      `peak mean luma ${stats.lumaMax} is at black — the camera may be held by another app`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `peak difference ${stats.madMax} against a floor of ${stats.madMin} and a median of ` +
        `${stats.madMedian} (${round(stats.madMax / Math.max(stats.madMedian, 0.001), 1)}x ` +
        `the median), luma up to ${stats.lumaMax}`,
    );
  }
  return { evaluable: true, changed: absoluteOk && notBlack, reasons };
}
