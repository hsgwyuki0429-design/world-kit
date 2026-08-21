/**
 * Measurement accumulators for the frame pipeline.
 *
 * Pure, DOM-free and unit tested, for the same reason the pyramid maths is: the numbers a
 * phase verdict rests on should be computable — and checkable — without a camera.
 *
 * The one design decision worth stating is **segments**. FRAME-001 claims 30 seconds of
 * continuous supply *in normal operation*, and the harness can deliberately overload the
 * worker to make FRAME-003 and FRAME-004 evaluable. Averaging the two together would let a
 * stressed interval quietly lower a continuity figure, or — worse — let a short clean burst
 * be reported as if the whole run had been clean. So the timeline is cut at every change of
 * load state, each piece is measured separately, and FRAME-001 reads the longest unstressed
 * piece rather than the session total.
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}

export interface SeriesSummary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

/**
 * A bounded sample series with percentiles.
 *
 * Bounded by dropping the oldest sample, which makes the percentiles describe the most
 * recent 4000 frames rather than the whole session. At 30 FPS that is a bit over two
 * minutes — longer than any single test window here, and short enough that a 20-minute
 * session cannot accumulate unbounded memory (§56).
 */
export class Series {
  private readonly values: number[] = [];
  private readonly limit: number;
  private sum = 0;
  private total = 0;
  private minSeen = Infinity;
  private maxSeen = -Infinity;

  constructor(limit = 4000) {
    this.limit = limit;
  }

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.values.push(v);
    if (this.values.length > this.limit) this.values.shift();
    this.sum += v;
    this.total++;
    if (v < this.minSeen) this.minSeen = v;
    if (v > this.maxSeen) this.maxSeen = v;
  }

  get count(): number {
    return this.total;
  }

  /** Mean over the whole session, not only the retained window. */
  get mean(): number {
    return this.total > 0 ? this.sum / this.total : 0;
  }

  percentile(p: number): number {
    if (this.values.length === 0) return 0;
    const s = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx] ?? 0;
  }

  /** Median of the most recent `n` samples — the controller's decision window. */
  recentMedian(n: number): number {
    const slice = this.values.slice(-n);
    if (slice.length === 0) return 0;
    const s = [...slice].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
  }

  summary(): SeriesSummary {
    return {
      count: this.total,
      mean: round(this.mean),
      p50: round(this.percentile(50)),
      p95: round(this.percentile(95)),
      min: this.total > 0 ? round(this.minSeen) : 0,
      max: this.total > 0 ? round(this.maxSeen) : 0,
    };
  }
}

export interface SegmentSummary {
  readonly index: number;
  readonly stressed: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Span from the first returned result to the last — what continuity actually means. */
  readonly observedMs: number;
  readonly results: number;
  readonly meanFps: number;
  readonly maxGapMs: number;
  readonly wasHidden: boolean;
  readonly endReason: string;
}

interface OpenSegment {
  index: number;
  stressed: boolean;
  startedAt: number;
  firstResultAt: number | null;
  lastResultAt: number | null;
  results: number;
  maxGapMs: number;
  wasHidden: boolean;
}

/** Cap on retained segments (§56 memory policy). Toggling load 64 times is already a lot. */
const MAX_SEGMENTS = 64;

export class SegmentLog {
  private closed: SegmentSummary[] = [];
  private open: OpenSegment | null = null;
  private nextIndex = 0;
  private droppedSegments = 0;

  start(at: number, stressed: boolean): void {
    this.open = {
      index: this.nextIndex++,
      stressed,
      startedAt: at,
      firstResultAt: null,
      lastResultAt: null,
      results: 0,
      maxGapMs: 0,
      wasHidden: false,
    };
  }

  isOpen(): boolean {
    return this.open !== null;
  }

  currentStressed(): boolean {
    return this.open?.stressed ?? false;
  }

  noteResult(at: number): void {
    const s = this.open;
    if (!s) return;
    if (s.firstResultAt === null) s.firstResultAt = at;
    else if (s.lastResultAt !== null) {
      const gap = at - s.lastResultAt;
      if (gap > s.maxGapMs) s.maxGapMs = gap;
    }
    s.lastResultAt = at;
    s.results++;
  }

  noteHidden(): void {
    if (this.open) this.open.wasHidden = true;
  }

  /** Close the current segment and open a new one with the given load state. */
  setStressed(at: number, stressed: boolean): void {
    if (this.open && this.open.stressed === stressed) return;
    const wasOpen = this.open !== null;
    this.close(at, stressed ? 'load injection started' : 'load injection stopped');
    if (wasOpen) this.start(at, stressed);
  }

  close(at: number, reason: string): void {
    const s = this.open;
    if (!s) return;
    const observedMs =
      s.firstResultAt !== null && s.lastResultAt !== null ? s.lastResultAt - s.firstResultAt : 0;
    this.closed.push({
      index: s.index,
      stressed: s.stressed,
      startedAt: round(s.startedAt),
      endedAt: round(at),
      observedMs: round(observedMs),
      results: s.results,
      meanFps: observedMs > 0 ? round(((s.results - 1) * 1000) / observedMs) : 0,
      maxGapMs: round(s.maxGapMs),
      wasHidden: s.wasHidden,
      endReason: reason,
    });
    if (this.closed.length > MAX_SEGMENTS) {
      this.closed.shift();
      this.droppedSegments++;
    }
    this.open = null;
  }

  /** All segments, the open one included as a live snapshot at `now`. */
  segments(now: number): SegmentSummary[] {
    const out = [...this.closed];
    const s = this.open;
    if (s) {
      const observedMs =
        s.firstResultAt !== null && s.lastResultAt !== null ? s.lastResultAt - s.firstResultAt : 0;
      out.push({
        index: s.index,
        stressed: s.stressed,
        startedAt: round(s.startedAt),
        endedAt: null,
        observedMs: round(observedMs),
        results: s.results,
        meanFps: observedMs > 0 ? round(((s.results - 1) * 1000) / observedMs) : 0,
        maxGapMs: round(s.maxGapMs),
        wasHidden: s.wasHidden,
        endReason: `open at ${round(now)}`,
      });
    }
    return out;
  }

  /**
   * The longest segment during which no load was injected.
   *
   * `null` when the pipeline has never run unstressed, which FRAME-001 reports as PENDING
   * rather than as a continuity failure.
   */
  longestClean(now: number): SegmentSummary | null {
    let best: SegmentSummary | null = null;
    for (const s of this.segments(now)) {
      if (s.stressed) continue;
      if (!best || s.observedMs > best.observedMs) best = s;
    }
    return best;
  }

  anyStressed(now: number): boolean {
    return this.segments(now).some((s) => s.stressed && s.results > 0);
  }

  describe(now: number): Record<string, JsonValue> {
    return toJsonSafe({
      segments: this.segments(now),
      droppedSegments: this.droppedSegments,
      longestCleanMs: this.longestClean(now)?.observedMs ?? 0,
      note:
        'The timeline is cut wherever load injection was switched on or off. FRAME-001 ' +
        'reads the longest unstressed segment; stressed segments are measured and reported ' +
        'but never counted toward continuity.',
    }) as Record<string, JsonValue>;
  }
}

export interface CrossCheckSample {
  readonly frameId: number;
  readonly at: number;
  /** Mean luma of the main thread's own 64x48 sample of the video frame. */
  readonly mainMeanLuma: number;
  /** Mean luma the worker reported for the level-0 grayscale of the same frame. */
  readonly workerMeanLuma: number;
  readonly absDifference: number;
  /** What the sample cost the UI thread (§H.1 measured 13.8 ms for this operation). */
  readonly costMs: number;
}

/**
 * The provenance cross-check (FRAME-002).
 *
 * Both numbers describe the same video frame — one measured on the main thread, one
 * measured in the worker on the pixels the pipeline actually delivered. Area averaging
 * preserves the mean under downsampling, so on a real pipeline they agree; a worker
 * emitting a frozen, synthetic or stale image diverges as soon as the camera moves.
 */
export class CrossCheckLog {
  private readonly samples: CrossCheckSample[] = [];
  private readonly limit: number;
  private readonly costs = new Series(400);
  private unmatched = 0;

  constructor(limit = 400) {
    this.limit = limit;
  }

  add(sample: CrossCheckSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.limit) this.samples.shift();
    this.costs.push(sample.costMs);
  }

  /** A main-thread sample whose frame never came back from the worker. */
  noteUnmatched(): void {
    this.unmatched++;
  }

  get count(): number {
    return this.samples.length;
  }

  get unmatchedCount(): number {
    return this.unmatched;
  }

  medianAbsDifference(): number {
    if (this.samples.length === 0) return -1;
    const s = this.samples.map((x) => x.absDifference).sort((a, b) => a - b);
    const mid = s.length >> 1;
    return round(s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2), 3);
  }

  maxAbsDifference(): number {
    return this.samples.length === 0 ? -1 : round(Math.max(...this.samples.map((x) => x.absDifference)), 3);
  }

  /**
   * How much the scene itself varied, measured on the main thread's own readings.
   *
   * Without this the cross-check is uninformative: pointed at a motionless wall, a worker
   * emitting a frozen image agrees with the camera perfectly. The spread of the *main
   * thread's* series says whether there was anything for the worker to track, and it also
   * sets the tolerance — agreement within half a standard deviation is something a frozen
   * series cannot achieve, whatever the scale of the scene.
   */
  sceneStdDev(): number {
    if (this.samples.length < 2) return -1;
    const values = this.samples.map((x) => x.mainMeanLuma);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / (values.length - 1);
    return round(Math.sqrt(variance), 3);
  }

  sceneRange(): number {
    if (this.samples.length === 0) return -1;
    const values = this.samples.map((x) => x.mainMeanLuma);
    return round(Math.max(...values) - Math.min(...values), 3);
  }

  costSummary(): SeriesSummary {
    return this.costs.summary();
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      count: this.samples.length,
      unmatched: this.unmatched,
      medianAbsDifference: this.medianAbsDifference(),
      maxAbsDifference: this.maxAbsDifference(),
      sceneStdDev: this.sceneStdDev(),
      sceneRange: this.sceneRange(),
      costMs: this.costs.summary(),
      // Bounded so a long session cannot inflate the bundle; the summary above covers all
      // of them, and the tail is what a reader wants to inspect by hand.
      recentSamples: this.samples.slice(-24),
      note:
        'Each pair is one video frame measured twice: on the main thread with an ' +
        'independent 64x48 readback, and in the worker on the pixels the pipeline actually ' +
        'delivered. The readback costs what §H.1 measured, which is why it runs at 1 Hz and ' +
        'is excluded from the pipeline UI cost in FRAME-005.',
    }) as Record<string, JsonValue>;
  }
}
