/**
 * The field diagnostics — what a phone's tracker did, kept where a person can read it.
 *
 * Driven with hand-made results and views; every figure it reports has to come from those, and a
 * loss has to be told apart as a stalled feed or a refused localization.
 */

import { describe, expect, it } from 'vitest';

import { FieldDiagnostics, LONG_FRAME_MS, WINDOW_MS } from '../../src/ui/FieldDiagnostics';
import type { LocalizationReport, TrackingResult } from '../../src/tracking/trackingMessages';
import type { SpatialWorldView } from '../../src/world/SpatialWorld';

function result(over: {
  state?: string;
  correspondences?: number;
  inliers?: number;
  mapLandmarks?: number;
  confidence?: number;
  terms?: { name: string; value: number }[];
  landmarks?: { state: string; reason: string; shared: number; points: number };
  stageMs?: Record<string, number>;
  keyframe?: boolean;
  epoch?: number;
}): TrackingResult {
  const loc = {
    state: over.state ?? 'LOCALIZED',
    reason: '',
    correspondences: over.correspondences ?? 100,
    inliers: over.inliers ?? 100,
    medianErrorPx: 0.5,
    mapLandmarks: over.mapLandmarks ?? 500,
    relinked: 0,
    recovered: false,
    confidence: over.confidence ?? 0.9,
    confidenceTerms: (over.terms ?? [{ name: 'support', value: 0.9 }]).map((t) => ({ ...t, note: '' })),
    epoch: over.epoch ?? 1,
  } as unknown as LocalizationReport;
  return {
    localization: loc,
    keyframe: { inserted: over.keyframe ?? false },
    landmarks: over.landmarks
      ? { state: over.landmarks.state, stateReason: over.landmarks.reason, shared: over.landmarks.shared, points: over.landmarks.points, landmarks: over.mapLandmarks ?? 500 }
      : null,
    stageMs: over.stageMs ?? { flow: 20, localization: 2 },
  } as unknown as TrackingResult;
}

function view(tracking: string, reason: string, epoch = 1): SpatialWorldView {
  return { trackingState: tracking, trackingReason: reason, epoch } as unknown as SpatialWorldView;
}

describe('FieldDiagnostics', () => {
  it('measures the gaps between results, not the frames', () => {
    const d = new FieldDiagnostics();
    let t = 1000;
    for (const gap of [100, 100, 100, 900, 100]) {
      t += gap;
      d.recordResult(result({}), t);
    }
    const r = d.report({}, t);
    expect(r.resultsInWindow).toBe(5);
    expect(r.resultGapMs.max).toBe(900);
    expect(r.resultGapMs.p50).toBe(100);
  });

  it('counts the main thread frames that were dropped', () => {
    const d = new FieldDiagnostics();
    let t = 0;
    for (const gap of [16, 16, 16, LONG_FRAME_MS + 40, 16]) {
      t += gap;
      d.recordFrame(t);
    }
    expect(d.report({}, t).longFrames).toEqual({ count: 1, maxMs: LONG_FRAME_MS + 40 });
  });

  it('tells a stalled feed from a refused localization when tracking is lost', () => {
    const stalled = new FieldDiagnostics();
    stalled.recordResult(result({}), 1000);
    stalled.recordWorld(view('GOOD', 'ok'), 1100);
    stalled.recordWorld(view('LOST', 'no frame localized for 700 ms'), 1800);
    const e1 = stalled.report({}, 1800).recentEvents[0];
    expect(e1?.from).toBe('GOOD');
    expect(e1?.to).toBe('LOST');
    expect(e1?.sinceResultMs).toBe(800);

    const refused = new FieldDiagnostics();
    refused.recordWorld(view('GOOD', 'ok'), 1000);
    refused.recordResult(result({ state: 'TOO_FEW', correspondences: 3, mapLandmarks: 240 }), 1790);
    refused.recordWorld(view('LOST', 'no frame localized'), 1800);
    const e2 = refused.report({}, 1800).recentEvents[0];
    expect(e2?.sinceResultMs).toBe(10);
    expect(e2?.lastResult).toContain('TOO_FEW');
    expect(e2?.lastResult).toContain('3 tracked');
    expect(e2?.mapLandmarks).toBe(240);
  });

  it('reports why the map refused batches, and when the world was redefined', () => {
    const d = new FieldDiagnostics();
    d.recordResult(result({ landmarks: { state: 'UNREGISTERED', reason: 'the batch shares 0 landmark(s) with the map', shared: 0, points: 214 } }), 1000);
    d.recordResult(result({ landmarks: { state: 'REGISTERED', reason: 'ok', shared: 90, points: 200 } }), 1100);
    d.recordWorld(view('GOOD', 'ok', 1), 1150);
    d.recordWorld(view('GOOD', 'ok', 2), 1200);
    const r = d.report({}, 1200);
    expect(r.registrationFailures).toHaveLength(1);
    expect(r.registrationFailures[0]?.shared).toBe(0);
    expect(r.landmarksStates).toEqual({ UNREGISTERED: 1, REGISTERED: 1 });
    expect(r.map.epochChanges).toBe(1);
    expect(r.recentEvents.some((e) => e.kind === 'EPOCH' && e.from === '1' && e.to === '2')).toBe(true);
  });

  it('names the confidence term that held a localized pose under the bar', () => {
    const d = new FieldDiagnostics();
    d.recordResult(result({ confidence: 0.39, terms: [{ name: 'support', value: 1 }, { name: 'distribution', value: 0.39 }] }), 1000);
    d.recordResult(result({ confidence: 0.9 }), 1100);
    expect(d.report({}, 1100).lowConfidenceTerms).toEqual({ distribution: 1 });
  });

  it('splits non-GOOD time by cause', () => {
    const d = new FieldDiagnostics();
    d.recordWorld(view('GOOD', 'ok'), 0);
    d.recordWorld(view('DEGRADED', 'holding the last pose (89 ms old) — x'), 1000);
    d.recordWorld(view('DEGRADED', 'POSE: LOW CONFIDENCE — 0.39 below 0.4'), 2000);
    d.recordWorld(view('GOOD', 'ok'), 3500);
    const r = d.report({}, 4000);
    expect(r.trackingCauses['DEGRADED/HOLD (a frame was refused or saw too few map points)']).toBe(1);
    expect(r.trackingCauses['DEGRADED/LOW_CONFIDENCE']).toBe(1.5);
  });

  it('keeps the whole session\'s worst moment after the window has forgotten it', () => {
    const d = new FieldDiagnostics();
    d.recordWorld(view('GOOD', 'ok'), 0);
    for (let t = 100; t <= 2000; t += 100) d.recordWorld(view('LOST', 'no frame localized'), t);
    for (let t = 2100; t <= WINDOW_MS + 6000; t += 100) d.recordWorld(view('GOOD', 'ok'), t);
    const r = d.report({}, WINDOW_MS + 6000);
    expect(r.tracking['LOST'] ?? 0).toBe(0);
    expect(r.session.lostS).toBeGreaterThanOrEqual(1.9);
    expect(r.session.longestLostS).toBeGreaterThanOrEqual(1.9);
    expect(r.session.longestLostS).toBeLessThan(2.2);
  });

  it('does not count the first map as a redefinition of the world', () => {
    const d = new FieldDiagnostics();
    d.recordWorld(view('INITIALIZING', 'building', 0), 0);
    d.recordWorld(view('GOOD', 'ok', 1), 100);
    expect(d.report({}, 100).map.epochChanges).toBe(0);
  });

  it('keeps only the window, and produces text the clipboard can carry', () => {
    const d = new FieldDiagnostics();
    d.recordResult(result({}), 0);
    d.recordResult(result({}), WINDOW_MS + 1000);
    const r = d.report({ build: 'abc1234' }, WINDOW_MS + 1000);
    expect(r.resultsInWindow).toBe(1);
    const parsed = JSON.parse(d.text(r));
    expect(parsed.meta.build).toBe('abc1234');
    expect(d.lines(r).length).toBeGreaterThan(3);
  });
});
