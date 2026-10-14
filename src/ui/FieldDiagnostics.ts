/**
 * What a phone in a hand did to the tracker, kept where a person can read it.
 *
 * The desktop legs film a synthetic room; they cannot say why a real iPhone loses the camera. So
 * the play screen keeps a short rolling record of what it saw and can put it on the screen or on
 * the clipboard in one tap. It answers the question a report of "tracking is lost" leaves open:
 *
 *  - **were results arriving at all?** — the gaps between the worker's results, and how many frames
 *    the main thread itself dropped (a stalled thread and a stalled worker look alike from the
 *    badge, and are fixed in different places);
 *  - **if they were, what did the localization say?** — the share of frames localized, and why the
 *    rest were not (`TOO_FEW`, `REFUSED`, `NO_MAP`) with the counts behind each;
 *  - **was the map being built?** — landmarks, keyframes, and how often the world was redefined;
 *  - **what did each stage cost?** — the worker's own per-stage timings, on this device.
 *
 * No DOM and no clock but the one it is given, so it is tested without either. Every figure is a
 * measurement the caller handed in; nothing here is estimated or filled in.
 */

import type { LocalizationReport, TrackingResult } from '../tracking/trackingMessages';
import type { SpatialWorldView } from '../world/SpatialWorld';

/** How much history the figures cover. */
export const WINDOW_MS = 30_000;
/** A main-thread frame this far apart from the last is a dropped one. */
export const LONG_FRAME_MS = 100;
/** Results kept (about thirty seconds at the slowest rate a phone delivers). */
const MAX_RESULTS = 600;
const MAX_FRAMES = 1200;
const MAX_EVENTS = 80;

interface ResultSample {
  readonly at: number;
  /** Time since the previous result. */
  readonly gap: number;
  readonly state: string;
  readonly correspondences: number;
  readonly inliers: number;
  readonly medianPx: number;
  readonly mapLandmarks: number;
  readonly relinked: number;
  readonly recovered: boolean;
  readonly keyframeInserted: boolean;
  readonly landmarksState: string;
  /** The pose confidence the localization reported, and the term that held it down. */
  readonly confidence: number;
  readonly lowTerm: string;
  /** For a refused frame, which bars it failed (INLIERS, SHARE, MEDIAN, NO_CONVERGE). */
  readonly refusal: string;
  readonly epoch: number;
  readonly workerMs: number;
  readonly stageMs: Readonly<Record<string, number>>;
}

export interface DiagnosticEvent {
  /** Seconds since the first result. */
  readonly atS: number;
  readonly kind: 'TRACKING' | 'EPOCH';
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  /** Milliseconds since a result last arrived — the stalled-worker-or-thread test. */
  readonly sinceResultMs: number;
  /** What the last result said, so a loss can be told from a stall. */
  readonly lastResult: string;
  readonly mapLandmarks: number;
}

/** One batch the map could not register, or a world it had to redefine. */
export interface RegistrationEvent {
  readonly atS: number;
  readonly state: string;
  readonly reason: string;
  readonly shared: number;
  readonly points: number;
  readonly mapLandmarks: number;
}

export interface Distribution {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface DiagnosticReport {
  readonly windowS: number;
  readonly resultsInWindow: number;
  readonly resultGapMs: Distribution;
  readonly longFrames: { readonly count: number; readonly maxMs: number };
  readonly localization: Record<string, number>;
  readonly localizedShare: number;
  readonly tracking: Record<string, number>;
  readonly landmarksStates: Record<string, number>;
  /** The newest batches the map could not register, with the reason it gave. */
  readonly registrationFailures: readonly RegistrationEvent[];
  /** When pose confidence sat under the 0.4 bar: which term was the lowest. */
  readonly lowConfidenceTerms: Record<string, number>;
  /** Refused frames by the bar they failed, and the median tracked/agreeing counts they had. */
  readonly refusals: Record<string, number>;
  readonly refusedMedian: { readonly tracked: number; readonly agree: number };
  /** Seconds in each tracking state's reason class (HOLD, LOW_CONFIDENCE, STALE, ...). */
  readonly trackingCauses: Record<string, number>;
  readonly map: { readonly landmarks: number; readonly keyframesInserted: number; readonly epoch: number; readonly epochChanges: number };
  readonly relinked: number;
  readonly recovered: number;
  /** Since the screen started, not only the window: time in LOST, its longest run, and time in GOOD. */
  readonly session: { readonly lostS: number; readonly longestLostS: number; readonly goodS: number; readonly totalS: number };
  readonly workerMs: Distribution;
  readonly stageMs: Record<string, Distribution>;
  readonly recentEvents: readonly DiagnosticEvent[];
  readonly meta: Record<string, string | number | boolean>;
}

/** The bars a refused frame failed, from the localization's own reason. */
function refusalOf(reason: string): string {
  const parts: string[] = [];
  if (reason.includes('inlier(s), below')) parts.push('INLIERS');
  if (reason.includes('correspondences agree')) parts.push('SHARE');
  if (reason.includes('median error')) parts.push('MEDIAN');
  if (reason.includes('did not converge')) parts.push('NO_CONVERGE');
  return parts.length > 0 ? parts.join('+') : 'OTHER';
}

/** The reason string, as one of a few classes a person can read. */
function causeOf(state: string, reason: string): string {
  if (state === 'GOOD') return 'OK';
  if (state === 'INITIALIZING') return 'BUILDING_MAP';
  if (reason.startsWith('holding the last pose')) return 'HOLD (a frame was refused or saw too few map points)';
  if (reason.startsWith('POSE: LOW CONFIDENCE')) return 'LOW_CONFIDENCE';
  if (reason.startsWith('no frame localized') || reason.startsWith('no pose for')) return 'STALE (no pose for more than 1.5 s)';
  if (reason.includes('(re)defined')) return 'NEW_WORLD';
  return reason.slice(0, 40);
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { n: 0, p50: -1, p95: -1, max: -1 };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(s[s.length - 1] ?? 0) };
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

function count(into: Record<string, number>, key: string, by = 1): void {
  into[key] = (into[key] ?? 0) + by;
}

export class FieldDiagnostics {
  private results: ResultSample[] = [];
  private frames: { at: number; gap: number }[] = [];
  private events: DiagnosticEvent[] = [];
  private firstResultAt = -1;
  private lastResultAt = -1;
  private lastFrameAt = -1;
  private lastTracking = '';
  private lastEpoch = -1;
  private epochChanges = 0;
  private keyframesInserted = 0;
  private trackingSeen: { at: number; state: string; cause: string }[] = [];
  private registrationFailures: RegistrationEvent[] = [];
  /** Whole-session totals: the window forgets, a session's worst moment must not. */
  private session = { lostMs: 0, longestLostMs: 0, goodMs: 0, totalMs: 0, runMs: 0, lastAt: -1, lastState: '' };
  private lastLocalization = 'NONE';
  private lastMapLandmarks = 0;

  reset(): void {
    this.results = [];
    this.frames = [];
    this.events = [];
    this.firstResultAt = -1;
    this.lastResultAt = -1;
    this.lastFrameAt = -1;
    this.lastTracking = '';
    this.lastEpoch = -1;
    this.epochChanges = 0;
    this.keyframesInserted = 0;
    this.trackingSeen = [];
    this.registrationFailures = [];
    this.session = { lostMs: 0, longestLostMs: 0, goodMs: 0, totalMs: 0, runMs: 0, lastAt: -1, lastState: '' };
    this.lastLocalization = 'NONE';
    this.lastMapLandmarks = 0;
  }

  /** One worker result. `at` is `performance.now()` on the main thread when it arrived. */
  recordResult(result: TrackingResult, at: number): void {
    const loc: LocalizationReport | null = result.localization;
    if (this.firstResultAt < 0) this.firstResultAt = at;
    const gap = this.lastResultAt < 0 ? 0 : at - this.lastResultAt;
    this.lastResultAt = at;
    if (result.keyframe?.inserted) this.keyframesInserted++;
    const stageMs = result.stageMs ?? {};
    const workerMs = Object.values(stageMs).reduce((a, b) => a + b, 0);
    if (loc) {
      this.lastLocalization = `${loc.state} (${loc.correspondences} tracked, ${loc.inliers} agree, ${loc.mapLandmarks} in the map)`;
      this.lastMapLandmarks = loc.mapLandmarks;
    }
    const terms = loc?.confidenceTerms ?? [];
    const low = terms.length > 0 ? terms.reduce((a, b) => (b.value < a.value ? b : a)) : null;
    const reg = result.landmarks;
    if (reg && (reg.state === 'UNREGISTERED' || reg.state === 'EPOCH_RESTART')) {
      this.registrationFailures.push({
        atS: this.since(at),
        state: reg.state,
        reason: reg.stateReason,
        shared: reg.shared,
        points: reg.points,
        mapLandmarks: reg.landmarks,
      });
      if (this.registrationFailures.length > 30) this.registrationFailures.shift();
    }
    this.results.push({
      at,
      gap,
      state: loc?.state ?? 'NOT_RUN',
      correspondences: loc?.correspondences ?? 0,
      inliers: loc?.inliers ?? 0,
      medianPx: loc?.medianErrorPx ?? -1,
      mapLandmarks: loc?.mapLandmarks ?? 0,
      relinked: loc?.relinked ?? 0,
      recovered: loc?.recovered ?? false,
      keyframeInserted: result.keyframe?.inserted ?? false,
      landmarksState: result.landmarks?.state ?? 'NONE',
      confidence: loc?.confidence ?? -1,
      lowTerm: low ? low.name : '',
      refusal: loc && loc.state === 'REFUSED' ? refusalOf(loc.reason) : '',
      epoch: loc?.epoch ?? -1,
      workerMs,
      stageMs,
    });
    if (this.results.length > MAX_RESULTS) this.results.shift();
  }

  /** One main-thread animation frame. Frames spaced past `LONG_FRAME_MS` are counted as dropped. */
  recordFrame(at: number): void {
    if (this.lastFrameAt >= 0) {
      this.frames.push({ at, gap: at - this.lastFrameAt });
      if (this.frames.length > MAX_FRAMES) this.frames.shift();
    }
    this.lastFrameAt = at;
  }

  /** The world as the game sees it; transitions are what get kept. */
  recordWorld(view: SpatialWorldView, at: number): void {
    const tracking = view.trackingState;
    // Epoch 0 is "no map yet"; the first map is epoch 1 and is not a redefinition of anything.
    if (this.lastEpoch >= 1 && view.epoch !== this.lastEpoch) {
      this.epochChanges++;
      this.push({
        atS: this.since(at),
        kind: 'EPOCH',
        from: String(this.lastEpoch),
        to: String(view.epoch),
        reason: 'the world was redefined: the map could not register consecutive keyframe batches, so every landmark and the stage were dropped',
        sinceResultMs: this.lastResultAt < 0 ? -1 : round(at - this.lastResultAt),
        lastResult: this.lastLocalization,
        mapLandmarks: this.lastMapLandmarks,
      });
    }
    this.lastEpoch = view.epoch;
    this.noteSession(tracking, at);
    if (this.lastTracking !== '' && tracking !== this.lastTracking) {
      this.push({
        atS: this.since(at),
        kind: 'TRACKING',
        from: this.lastTracking,
        to: tracking,
        reason: view.trackingReason,
        sinceResultMs: this.lastResultAt < 0 ? -1 : round(at - this.lastResultAt),
        lastResult: this.lastLocalization,
        mapLandmarks: this.lastMapLandmarks,
      });
    }
    this.lastTracking = tracking;
    this.trackingSeen.push({ at, state: tracking, cause: causeOf(tracking, view.trackingReason) });
    const cut = at - WINDOW_MS;
    while (this.trackingSeen.length > 1 && (this.trackingSeen[0]?.at ?? 0) < cut) this.trackingSeen.shift();
  }

  report(meta: Record<string, string | number | boolean> = {}, at: number = this.lastResultAt): DiagnosticReport {
    const cut = at - WINDOW_MS;
    const inWindow = this.results.filter((r) => r.at >= cut);
    const localization: Record<string, number> = {};
    const landmarksStates: Record<string, number> = {};
    let relinked = 0;
    let recovered = 0;
    const stageValues: Record<string, number[]> = {};
    const lowConfidenceTerms: Record<string, number> = {};
    const refusals: Record<string, number> = {};
    const refusedTracked: number[] = [];
    const refusedAgree: number[] = [];
    for (const r of inWindow) {
      if (r.refusal) {
        count(refusals, r.refusal);
        refusedTracked.push(r.correspondences);
        refusedAgree.push(r.inliers);
      }
      if (r.state === 'LOCALIZED' && r.confidence >= 0 && r.confidence < 0.4 && r.lowTerm) count(lowConfidenceTerms, r.lowTerm);
      count(localization, r.state);
      count(landmarksStates, r.landmarksState);
      relinked += r.relinked;
      if (r.recovered) recovered++;
      for (const [k, v] of Object.entries(r.stageMs)) (stageValues[k] ??= []).push(v);
    }
    const localized = localization['LOCALIZED'] ?? 0;
    const frames = this.frames.filter((f) => f.at >= cut);
    const long = frames.filter((f) => f.gap > LONG_FRAME_MS);
    const tracking: Record<string, number> = {};
    // Seconds spent in each state, by the span each sample covers.
    for (let i = 0; i < this.trackingSeen.length; i++) {
      const s = this.trackingSeen[i];
      const next = this.trackingSeen[i + 1];
      if (!s) continue;
      const span = (next ? next.at : at) - s.at;
      if (span > 0 && span < 5000) count(tracking, s.state, span);
    }
    const causes: Record<string, number> = {};
    for (let i = 0; i < this.trackingSeen.length; i++) {
      const s = this.trackingSeen[i];
      const next = this.trackingSeen[i + 1];
      if (!s || s.state === 'GOOD') continue;
      const span = (next ? next.at : at) - s.at;
      if (span > 0 && span < 5000) count(causes, `${s.state}/${s.cause}`, span);
    }
    for (const k of Object.keys(causes)) causes[k] = round((causes[k] ?? 0) / 1000);
    const total = Object.values(tracking).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(tracking)) tracking[k] = total > 0 ? Math.round(((tracking[k] ?? 0) / total) * 100) : 0;
    const last = this.results[this.results.length - 1];
    return {
      windowS: WINDOW_MS / 1000,
      resultsInWindow: inWindow.length,
      resultGapMs: distribution(inWindow.filter((r) => r.gap > 0).map((r) => r.gap)),
      longFrames: { count: long.length, maxMs: long.length > 0 ? round(Math.max(...long.map((f) => f.gap))) : 0 },
      localization,
      localizedShare: inWindow.length > 0 ? Math.round((localized / inWindow.length) * 100) : -1,
      tracking,
      landmarksStates,
      registrationFailures: this.registrationFailures.slice(-10),
      lowConfidenceTerms,
      refusals,
      refusedMedian: { tracked: distribution(refusedTracked).p50, agree: distribution(refusedAgree).p50 },
      trackingCauses: causes,
      map: { landmarks: last?.mapLandmarks ?? 0, keyframesInserted: this.keyframesInserted, epoch: last?.epoch ?? -1, epochChanges: this.epochChanges },
      relinked,
      recovered,
      session: {
        lostS: round(this.session.lostMs / 1000),
        longestLostS: round(this.session.longestLostMs / 1000),
        goodS: round(this.session.goodMs / 1000),
        totalS: round(this.session.totalMs / 1000),
      },
      workerMs: distribution(inWindow.map((r) => r.workerMs).filter((v) => v > 0)),
      stageMs: Object.fromEntries(Object.entries(stageValues).map(([k, v]) => [k, distribution(v)])),
      recentEvents: this.events.slice(-30),
      meta,
    };
  }

  /** The report as the lines the screen shows. Japanese for the reader, English for the numbers' names. */
  lines(report: DiagnosticReport): string[] {
    const out: string[] = [];
    const t = report.tracking;
    const pct = (k: string): number => t[k] ?? 0;
    out.push(`追跡（直近${report.windowS}秒）: GOOD ${pct('GOOD')}% / DEGRADED ${pct('DEGRADED')}% / LOST ${pct('LOST')}% / INITIALIZING ${pct('INITIALIZING')}%`);
    const g = report.resultGapMs;
    out.push(g.n > 0
      ? `結果の間隔: 中央値 ${g.p50} ms / 95% ${g.p95} ms / 最大 ${g.max} ms（${report.resultsInWindow} 件）`
      : '結果の間隔: まだ結果が届いていません');
    const loc = report.localization;
    const parts = Object.entries(loc).map(([k, v]) => `${k} ${v}`).join(' / ');
    out.push(`位置が求まった割合: ${report.localizedShare < 0 ? '—' : `${report.localizedShare}%`}（${parts || '—'}）`);
    const ss = report.session;
    out.push(`開始からの合計: LOST ${ss.lostS} 秒（最長 ${ss.longestLostS} 秒）/ GOOD ${ss.goodS} 秒 / 全体 ${ss.totalS} 秒`);
    out.push(`地図: 点 ${report.map.landmarks} / キーフレーム ${report.map.keyframesInserted} / エポック ${report.map.epoch}（作り直し ${report.map.epochChanges} 回）`);
    const causes = Object.entries(report.trackingCauses).map(([k, v]) => `${k} ${v}s`).join(' / ');
    if (causes) out.push(`GOOD でなかった理由（秒）: ${causes}`);
    const refused = Object.entries(report.refusals).map(([k, v]) => `${k} ${v}`).join(' / ');
    if (refused) out.push(`却下した理由（件数）: ${refused}（追跡 ${report.refusedMedian.tracked} 点・一致 ${report.refusedMedian.agree} 点が中央値）`);
    const lowTerms = Object.entries(report.lowConfidenceTerms).map(([k, v]) => `${k} ${v}`).join(' / ');
    if (lowTerms) out.push(`信頼度が 0.4 未満だった項目: ${lowTerms}`);
    const failed = report.registrationFailures[report.registrationFailures.length - 1];
    if (failed) out.push(`地図の登録失敗（最新）: ${failed.atS} 秒 ${failed.state} 共有 ${failed.shared}/${failed.points} 点 — ${failed.reason.slice(0, 90)}`);
    out.push(`再結びつけ ${report.relinked} 点 / 復帰 ${report.recovered} 回`);
    out.push(`画面の描画が止まった回数: ${report.longFrames.count}（最大 ${report.longFrames.maxMs} ms）`);
    const w = report.workerMs;
    if (w.n > 0) {
      const stages = Object.entries(report.stageMs).map(([k, v]) => `${k} ${v.p50}`).join(' / ');
      out.push(`ワーカーの処理: 中央値 ${w.p50} ms / 95% ${w.p95} ms（${stages}）`);
    }
    const e = report.recentEvents[report.recentEvents.length - 1];
    if (e) {
      out.push(`直近の変化: ${e.atS} 秒 ${e.kind} ${e.from}→${e.to} / 結果が止まっていた時間 ${e.sinceResultMs} ms / 直前: ${e.lastResult}`);
      out.push(`  理由: ${e.reason}`);
    }
    return out;
  }

  /** Everything, as text, for the clipboard. */
  text(report: DiagnosticReport): string {
    return JSON.stringify({ ...report, lines: undefined });
  }

  /** Time is credited to the state that was in force over the interval, and only the intervals the loop actually ran. */
  private noteSession(state: string, at: number): void {
    const s = this.session;
    if (s.lastAt >= 0 && s.lastState !== '') {
      const span = at - s.lastAt;
      // A span past five seconds is the loop not running (a screen change, a paused tab), not a state held.
      if (span > 0 && span < 5000) {
        s.totalMs += span;
        if (s.lastState === 'GOOD') s.goodMs += span;
        if (s.lastState === 'LOST') {
          s.lostMs += span;
          s.runMs += span;
          s.longestLostMs = Math.max(s.longestLostMs, s.runMs);
        } else {
          s.runMs = 0;
        }
      }
    }
    s.lastAt = at;
    s.lastState = state;
  }

  private push(e: DiagnosticEvent): void {
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private since(at: number): number {
    return this.firstResultAt < 0 ? 0 : round((at - this.firstResultAt) / 1000);
  }
}
