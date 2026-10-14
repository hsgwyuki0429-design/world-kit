/**
 * Phase 13 test suite — VIEW-001..VIEW-005 (v4 §38, §40).
 *
 * Specs transcribed from `docs/phase13/TEST-PLAN.md`.
 *
 * **The claim.** An overlay can look aligned in a screenshot and be off by a transpose. So the
 * renderer's own projection is fed the tracker's observations and must land on them (VIEW-001);
 * every frame's draw is checked against the world it claims to draw (VIEW-002); the canvas box is
 * read back from the DOM against the video box (VIEW-003); and the labels the player reads are
 * read back from the DOM against the states they name (VIEW-004).
 */

import type { JsonValue, TestResult, TestSpec } from '../core/types';
import type { PhaseTest } from './runTests';
import { runTests } from './runTests';
import { judged, notRunning, pending } from './spatialContext';
import type { SpatialContext } from './spatialContext';

export const MIN_ALIGNMENT_READINGS = 30;
export const MAX_ALIGNMENT_PX = 2.5;
export const MIN_DRAWN_FRAMES = 60;
export const MAX_ASPECT_ERROR = 0.01;
export const MIN_UI_SAMPLES = 30;
export const DRAW_BUDGET_MS = 6;
export const MAX_FRAME_INTERVAL_MS = 34;

type T = PhaseTest<SpatialContext>;

const VIEW_001: T = {
  spec: {
    id: 'VIEW-001',
    title: 'The overlay lands where the tracker sees things',
    required: true,
    input: 'the worker’s correspondences each localized frame, projected through the renderer’s own projectWorld',
    expected: 'the map’s positions projected through the world pose land on the tracker’s pixels',
    passCriteria: `>= ${MIN_ALIGNMENT_READINGS} readings; median <= ${MAX_ALIGNMENT_PX} px`,
    failureCondition: 'a renderer that draws through a different projection from the one the pose was solved in',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { readings: r.alignmentReadings, median: r.medianAlignmentPx, worst: r.worstAlignmentPx };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.alignmentReadings < MIN_ALIGNMENT_READINGS) return pending(`${r.alignmentReadings}/${MIN_ALIGNMENT_READINGS} readings`, 'one per localized frame', metrics);
    return judged(r.medianAlignmentPx > MAX_ALIGNMENT_PX ? [`median ${r.medianAlignmentPx} px past ${MAX_ALIGNMENT_PX} px`] : [], `median ${r.medianAlignmentPx} px (worst ${r.worstAlignmentPx} px) over ${r.alignmentReadings} frames`, 'what the renderer draws at a world point is where the camera sees it', metrics);
  },
};

const VIEW_002: T = {
  spec: {
    id: 'VIEW-002',
    title: 'Draws only what the world holds',
    required: true,
    input: 'every frame’s draw report against the world view and game state it was drawn from',
    expected: 'no surface the world does not hold; no ring without a stage; nothing drawn without a pose',
    passCriteria: `>= ${MIN_DRAWN_FRAMES} frames drawn; 0 violations`,
    failureCondition: 'fixed geometry on screen (Rule 002), or a goal drawn with no stage behind it',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { frames: r.framesDrawn, violations: r.drawViolations, detail: r.drawViolationDetail };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.framesDrawn < MIN_DRAWN_FRAMES) return pending(`${r.framesDrawn}/${MIN_DRAWN_FRAMES} frames drawn`, 'the overlay draws once per display frame', metrics);
    return judged(r.drawViolations > 0 ? [`${r.drawViolations} frame(s): ${r.drawViolationDetail}`] : [], `${r.framesDrawn} frames, ${r.drawViolations} violation(s)`, 'every drawn object traces to the world or the stage generated from it', metrics);
  },
};

const VIEW_003: T = {
  spec: {
    id: 'VIEW-003',
    title: 'The overlay box is the video box',
    required: true,
    input: 'the canvas and video rectangles as laid out, read from the DOM',
    expected: 'the same aspect ratio, so a processing pixel maps to the canvas by one uniform scale',
    passCriteria: `>= ${MIN_UI_SAMPLES} samples; worst aspect error <= ${MAX_ASPECT_ERROR * 100}%`,
    failureCondition: 'a canvas stretched differently from the video it overlays',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { samples: r.aspectSamples, worst: r.worstAspectError };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.aspectSamples < MIN_UI_SAMPLES) return pending(`${r.aspectSamples}/${MIN_UI_SAMPLES} samples`, 'read from the DOM each tick', metrics);
    return judged(r.worstAspectError > MAX_ASPECT_ERROR ? [`worst aspect error ${r.worstAspectError}`] : [], `worst aspect error ${r.worstAspectError} over ${r.aspectSamples} samples`, 'the overlay is laid exactly over the video', metrics);
  },
};

const VIEW_004: T = {
  spec: {
    id: 'VIEW-004',
    title: 'The screen says what the engine says',
    required: true,
    input: 'the HUD’s tracking label, read from the DOM each tick, against the world’s tracking state',
    expected: 'TRACKING GOOD only when tracking is GOOD; LOST shown when it is lost',
    passCriteria: `>= ${MIN_UI_SAMPLES} samples; 0 mismatches`,
    failureCondition: 'TRACKING GOOD on screen while the engine is lost (Rule 002)',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { samples: r.uiSamples, mismatches: r.trackingMismatches, detail: r.uiMismatchDetail };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.uiSamples < MIN_UI_SAMPLES) return pending(`${r.uiSamples}/${MIN_UI_SAMPLES} samples`, 'read from the DOM each tick', metrics);
    return judged(r.trackingMismatches > 0 ? [`${r.trackingMismatches} mismatch(es): ${r.uiMismatchDetail}`] : [], `${r.uiSamples} samples, ${r.trackingMismatches} mismatch(es)`, 'the tracking label never claimed more than the engine had', metrics);
  },
};

const VIEW_005: T = {
  spec: {
    id: 'VIEW-005',
    title: 'Drawing cost and rate',
    required: false,
    input: 'time per overlay draw and the interval between display frames',
    expected: 'cheap enough to keep the overlay near the display rate (§10: rendering as close to 60 fps as possible)',
    passCriteria: `median draw <= ${DRAW_BUDGET_MS} ms; median frame interval <= ${MAX_FRAME_INTERVAL_MS} ms`,
    failureCondition: 'either past its bound',
  },
  evaluate: (ctx) => {
    const r = ctx.render;
    const metrics: Record<string, JsonValue> = { medianDrawMs: r.medianDrawMs, worstDrawMs: r.worstDrawMs, interval: r.medianFrameIntervalMs };
    const idle = notRunning(ctx, metrics);
    if (idle) return idle;
    if (r.framesDrawn < MIN_DRAWN_FRAMES) return pending(`${r.framesDrawn}/${MIN_DRAWN_FRAMES} frames`, 'needs frames to time', metrics);
    const problems: string[] = [];
    if (r.medianDrawMs > DRAW_BUDGET_MS) problems.push(`median draw ${r.medianDrawMs} ms`);
    if (r.medianFrameIntervalMs > MAX_FRAME_INTERVAL_MS) problems.push(`median interval ${r.medianFrameIntervalMs} ms`);
    return judged(problems, `draw ${r.medianDrawMs} ms median, frame every ${r.medianFrameIntervalMs} ms`, 'within budget', metrics);
  },
};

const PHASE13_TESTS: readonly T[] = [VIEW_001, VIEW_002, VIEW_003, VIEW_004, VIEW_005];
export const PHASE13_SPECS: readonly TestSpec[] = PHASE13_TESTS.map((t) => t.spec);
export function runPhase13Tests(ctx: SpatialContext): TestResult[] {
  return runTests(PHASE13_TESTS, ctx);
}
