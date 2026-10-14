/**
 * Phase 13 — the renderer's edge arrow for a ring off the frame.
 *
 * A stage may put its ring 55° off the view it was made from, past the edge of a portrait frame.
 * The arrow has to appear exactly when the ring's centre is off the frame (or behind the camera),
 * and point the way to it — checked here against a canvas that records what was drawn.
 */

import { describe, expect, it } from 'vitest';

import type { GameView } from '../../src/game/GameSession';
import { ArRenderer } from '../../src/renderer/ArRenderer';
import type { SpatialWorldView } from '../../src/world/SpatialWorld';

const W = 360;
const H = 480;

interface Recorded {
  readonly moves: [number, number][];
  readonly fills: string[];
}

/** A 2-D context that does nothing but remember where paths started and what was filled. */
function recordingCanvas(): { canvas: HTMLCanvasElement; rec: Recorded } {
  const rec: Recorded = { moves: [], fills: [] };
  let fillStyle = '';
  const ctx = new Proxy(
    {},
    {
      get(_t, key) {
        if (key === 'moveTo') return (x: number, y: number) => rec.moves.push([x, y]);
        if (key === 'fill') return () => rec.fills.push(fillStyle);
        if (key === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
        if (key === 'fillStyle') return fillStyle;
        return () => undefined;
      },
      set(_t, key, value) {
        if (key === 'fillStyle') fillStyle = String(value);
        return true;
      },
    },
  );
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, rec };
}

function world(): SpatialWorldView {
  return {
    cameraPose: {
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      translation: [0, 0, 0],
      intrinsics: { fx: 300, fy: 300, cx: W / 2, cy: H / 2, width: W, height: H },
    },
    sceneDepth: 5,
    cameraHeight: 1,
    surfaces: [],
    landmarks: [],
    gravity: { worldDown: null },
  } as unknown as SpatialWorldView;
}

function game(center: number[]): GameView {
  return {
    state: 'READY',
    stage: {
      ring: { center, axis: [0, 0, 1], radius: 0.14 },
      start: { position: [0, 0.3, 0.65] },
      difficulty: { difficulty: 'EASY' },
    },
    aimGuide: [],
    aimWouldScore: false,
    ball: null,
    ballRadius: 0.04,
  } as unknown as GameView;
}

const ARROW = 'rgba(255, 196, 0, 0.95)';

describe('ArRenderer — the way to a ring off the frame', () => {
  it('draws no arrow while the ring is on the frame', () => {
    const { canvas, rec } = recordingCanvas();
    const report = new ArRenderer(canvas).draw(world(), game([0, 0, 2]), { surfaces: false, landmarks: false });
    expect(report.ringDrawn).toBe(true);
    expect(report.ringIndicated).toBe(false);
    expect(rec.fills).not.toContain(ARROW);
  });

  it('points right, from the right edge, at a ring 50° to the right', () => {
    const { canvas, rec } = recordingCanvas();
    const a = (50 * Math.PI) / 180;
    const report = new ArRenderer(canvas).draw(world(), game([2 * Math.sin(a), 0, 2 * Math.cos(a)]), { surfaces: false, landmarks: false });
    expect(report.ringIndicated).toBe(true);
    const tip = rec.moves[rec.moves.length - 1] ?? [0, 0];
    expect(tip[0]).toBeGreaterThan(W - 18);
    expect(Math.abs(tip[1] - H / 2)).toBeLessThan(1);
  });

  it('points left at a ring behind the camera and to the left, and draws no ring', () => {
    const { canvas, rec } = recordingCanvas();
    const report = new ArRenderer(canvas).draw(world(), game([-1, 0, -2]), { surfaces: false, landmarks: false });
    expect(report.ringDrawn).toBe(false);
    expect(report.ringIndicated).toBe(true);
    const tip = rec.moves[rec.moves.length - 1] ?? [0, 0];
    expect(tip[0]).toBeLessThan(18);
  });

  it('points down at a ring below the bottom of the frame', () => {
    const { canvas, rec } = recordingCanvas();
    const report = new ArRenderer(canvas).draw(world(), game([0, 3, 2]), { surfaces: false, landmarks: false });
    expect(report.ringIndicated).toBe(true);
    const tip = rec.moves[rec.moves.length - 1] ?? [0, 0];
    expect(tip[1]).toBeGreaterThan(H - 18);
    expect(Math.abs(tip[0] - W / 2)).toBeLessThan(1);
  });
});
