/**
 * What Phase 13 is judged on, accumulated frame by frame (v4 §37, §38, §40).
 *
 * Four questions, each answered by a measurement rather than by looking at the screen:
 *
 *  - **Does the overlay land where the tracker sees things?** The worker's correspondences,
 *    projected through this layer's own `projectWorld` (VIEW-001).
 *  - **Does it draw only what the world holds?** Every frame's draw report checked against the
 *    view and the game it was drawn from (VIEW-002).
 *  - **Is the canvas laid exactly over the video?** Both boxes read back from the DOM (VIEW-003).
 *  - **Does the screen say what the engine says?** The labels the HUD actually shows, read back
 *    from the DOM and compared with the states they claim to show (VIEW-004, GAME-002).
 */

import type { GameView } from '../game/GameSession';
import type { SpatialWorldView } from '../world/SpatialWorld';
import type { AlignmentReading, DrawReport } from './ArRenderer';

export interface ViewStats {
  readonly framesDrawn: number;
  readonly medianDrawMs: number;
  readonly worstDrawMs: number;
  readonly medianFrameIntervalMs: number;
  readonly alignmentReadings: number;
  readonly medianAlignmentPx: number;
  readonly worstAlignmentPx: number;
  readonly aspectSamples: number;
  readonly worstAspectError: number;
  readonly drawViolations: number;
  readonly drawViolationDetail: string;
  readonly uiSamples: number;
  readonly stateMismatches: number;
  readonly trackingMismatches: number;
  readonly uiMismatchDetail: string;
}

const HISTORY = 600;

export class ViewStatsCollector {
  private framesDrawn = 0;
  private drawMs: number[] = [];
  private intervals: number[] = [];
  private lastFrameAt = -1;
  private alignments: number[] = [];
  private worstAlignment = -1;
  private aspectSamples = 0;
  private worstAspect = -1;
  private drawViolations = 0;
  private drawViolationDetail = '';
  private uiSamples = 0;
  private stateMismatches = 0;
  private trackingMismatches = 0;
  private uiMismatchDetail = '';

  reset(): void {
    Object.assign(this, new ViewStatsCollector());
  }

  recordDraw(report: DrawReport, world: SpatialWorldView, game: GameView | null, ms: number, at: number): void {
    this.framesDrawn++;
    push(this.drawMs, ms);
    if (this.lastFrameAt >= 0) push(this.intervals, at - this.lastFrameAt);
    this.lastFrameAt = at;
    const problems: string[] = [];
    const ids = new Set(world.surfaces.map((s) => s.id));
    const foreign = report.surfaceIds.filter((id) => !ids.has(id));
    if (foreign.length > 0) problems.push(`drew surface(s) ${foreign.join(', ')} the world does not hold`);
    if (!world.cameraPose && (report.surfacesDrawn > 0 || report.ringDrawn || report.ballDrawn)) {
      problems.push('drew with no camera pose in the world');
    }
    if (report.ringDrawn && !game?.stage) problems.push('drew a ring with no stage');
    if (report.ringIndicated && !game?.stage) problems.push('pointed the way to a ring with no stage');
    if (report.ballDrawn && !game?.ball) problems.push('drew a ball the game does not have');
    if (problems.length > 0) {
      this.drawViolations++;
      this.drawViolationDetail = problems.join('; ');
    }
  }

  recordAlignment(reading: AlignmentReading): void {
    if (reading.samples === 0 || reading.medianPx < 0) return;
    push(this.alignments, reading.medianPx);
    this.worstAlignment = Math.max(this.worstAlignment, reading.medianPx);
  }

  /** Canvas and video boxes as laid out, from `getBoundingClientRect`. */
  recordAspect(canvas: { width: number; height: number }, video: { width: number; height: number }): void {
    if (!(canvas.height > 0) || !(video.height > 0) || !(canvas.width > 0) || !(video.width > 0)) return;
    this.aspectSamples++;
    const a = canvas.width / canvas.height;
    const b = video.width / video.height;
    const err = Math.abs(a - b) / b;
    this.worstAspect = Math.max(this.worstAspect, err);
  }

  /** What the HUD shows, read from the DOM, against what it is meant to show. */
  recordUi(expectedState: string, shownState: string | null, expectedTracking: string, shownTracking: string | null): void {
    this.uiSamples++;
    if (shownState === null || !shownState.includes(expectedState)) {
      this.stateMismatches++;
      this.uiMismatchDetail = `state ${expectedState} shown as ${JSON.stringify(shownState)}`;
    }
    if (shownTracking === null || !shownTracking.includes(expectedTracking)) {
      this.trackingMismatches++;
      this.uiMismatchDetail = `tracking ${expectedTracking} shown as ${JSON.stringify(shownTracking)}`;
    }
  }

  stats(): ViewStats {
    return {
      framesDrawn: this.framesDrawn,
      medianDrawMs: round(median(this.drawMs), 3),
      worstDrawMs: this.drawMs.length > 0 ? round(Math.max(...this.drawMs), 3) : -1,
      medianFrameIntervalMs: round(median(this.intervals), 2),
      alignmentReadings: this.alignments.length,
      medianAlignmentPx: round(median(this.alignments), 4),
      worstAlignmentPx: round(this.worstAlignment, 4),
      aspectSamples: this.aspectSamples,
      worstAspectError: round(this.worstAspect, 5),
      drawViolations: this.drawViolations,
      drawViolationDetail: this.drawViolationDetail,
      uiSamples: this.uiSamples,
      stateMismatches: this.stateMismatches,
      trackingMismatches: this.trackingMismatches,
      uiMismatchDetail: this.uiMismatchDetail,
    };
  }
}

function push(list: number[], v: number): void {
  list.push(v);
  if (list.length > HISTORY) list.shift();
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
