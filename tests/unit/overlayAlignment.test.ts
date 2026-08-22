/**
 * The alignment probe, against the fault it exists for.
 *
 * A device reported corners that lined up in landscape and were rotated in portrait — and
 * every other check in the project passes such a buffer, because each is invariant to the
 * transform: the detector's unit tests never cross the video→worker path, Phase 2's
 * cross-check compares means, and FEAT-001's contrast statistic is computed on the same
 * buffer the detector used. These tests feed the probe a correct set of positions and a
 * rotated one and require it to tell them apart.
 */
import { describe, expect, it } from 'vitest';
import {
  ALIGNMENT_TRANSFORMS,
  isMisoriented,
  scoreAlignment,
} from '../../src/debug/OverlayAlignmentProbe';
import { Rng } from '../../src/core/Rng';

const W = 160;
const H = 120;

/** Bright blocks at asymmetric positions: no rotation or reflection maps this onto itself. */
const BLOCKS = [
  { cx: 0.20, cy: 0.22, w: 0.10, h: 0.14 },
  { cx: 0.78, cy: 0.18, w: 0.08, h: 0.10 },
  { cx: 0.26, cy: 0.76, w: 0.12, h: 0.12 },
];

function scene(): Float32Array {
  const g = new Float32Array(W * H).fill(20);
  for (const b of BLOCKS) {
    for (let y = Math.round((b.cy - b.h / 2) * H); y < Math.round((b.cy + b.h / 2) * H); y++) {
      for (let x = Math.round((b.cx - b.w / 2) * W); x < Math.round((b.cx + b.w / 2) * W); x++) {
        g[y * W + x] = 235;
      }
    }
  }
  return g;
}

/** The four corners of each block, in a coordinate space of the given size. */
function cornersIn(width: number, height: number): number[] {
  const pts: number[] = [];
  for (const b of BLOCKS) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        pts.push((b.cx + (sx * b.w) / 2) * width, (b.cy + (sy * b.h) / 2) * height);
      }
    }
  }
  return pts;
}

const rng = () => new Rng(0x1234_5678);

describe('overlay alignment probe', () => {
  it('says identity when the positions are on the image', () => {
    const r = rng();
    const reading = scoreAlignment(scene(), W, H, cornersIn(W, H), W, H, () => r.next());
    expect(reading).not.toBeNull();
    expect(reading!.best).toBe('identity');
    expect(reading!.identityOverRandom).toBeGreaterThan(2);
    expect(isMisoriented(reading!)).toBe(false);
  });

  it('names the rotation when the buffer is turned 90°', () => {
    // Exactly the reported fault: the worker measured a frame in the sensor's orientation
    // while the element displayed it rotated, so every position is turned about the centre.
    const pts = cornersIn(W, H);
    const turned: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const u = pts[i]! / W;
      const v = pts[i + 1]! / H;
      // Invert rot270 so that rot270 is the transform which restores the image.
      const [mu, mv] = ALIGNMENT_TRANSFORMS.rot90(u, v);
      turned.push(mu * W, mv * H);
    }
    const r = rng();
    const reading = scoreAlignment(scene(), W, H, turned, W, H, () => r.next());
    expect(reading!.best).not.toBe('identity');
    expect(isMisoriented(reading!)).toBe(true);
  });

  it('catches a flip, which leaves every average untouched', () => {
    const pts = cornersIn(W, H);
    const flipped: number[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      flipped.push(W - 1 - pts[i]!, pts[i + 1]!);
    }
    const r = rng();
    const reading = scoreAlignment(scene(), W, H, flipped, W, H, () => r.next());
    expect(reading!.best).toBe('flipX');
    expect(isMisoriented(reading!)).toBe(true);
  });

  it('compares in normalised space, so probe and overlay may differ in scale', () => {
    // The probe reads a 160-wide canvas; the overlay space is whatever the tier produced.
    const r = rng();
    const reading = scoreAlignment(scene(), W, H, cornersIn(720, 540), 720, 540, () => r.next());
    expect(reading!.best).toBe('identity');
    expect(isMisoriented(reading!)).toBe(false);
  });

  it('reports nothing rather than guessing when there is too little to go on', () => {
    const r = rng();
    expect(scoreAlignment(scene(), W, H, [1, 2], W, H, () => r.next())).toBeNull();
    expect(scoreAlignment(new Float32Array(4), 2, 2, cornersIn(2, 2), 2, 2, () => r.next()))
      .toBeNull();
  });
});

describe('scenes the probe cannot read', () => {
  /** Dense and periodic: every transform lands on corner-like pixels. */
  function repetitive(): Float32Array {
    const g = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        g[y * W + x] = 128 + 90 * Math.sin((x * Math.PI) / 8) * Math.sin((y * Math.PI) / 8);
      }
    }
    return g;
  }

  it('refuses to condemn a route on a scene where every transform scores alike', () => {
    // The false positive this guard exists for. A brick wall, a tiled floor, or the periodic
    // pan the Phase 4 leg generates puts corner-like pixels everywhere, so whichever transform
    // wins does so by noise — and acting on it would abandon a working acquisition route.
    const g = repetitive();
    const pts: number[] = [];
    for (let y = 12; y < H - 12; y += 16) for (let x = 12; x < W - 12; x += 16) pts.push(x, y);
    const r = new Rng(0xa11a_11ed);
    const reading = scoreAlignment(g, W, H, pts, W, H, () => r.next());
    expect(reading).not.toBeNull();
    // The probe has no discrimination here, whatever it names as the winner.
    expect(reading!.bestOverRandom).toBeLessThan(2);
    expect(isMisoriented(reading!)).toBe(false);
  });

  it('says a black frame is not measurable rather than reporting a ratio', () => {
    // Phase 4's FLOW-005 produces these on purpose: the lens is covered. Every score is zero,
    // and before this was handled the ratios were Infinity and the evidence recorder logged an
    // integrity error on a run in which nothing was wrong.
    const g = new Float32Array(W * H).fill(0);
    const pts = cornersIn(W, H);
    const r = new Rng(0xa11a_11ed);
    const reading = scoreAlignment(g, W, H, pts, W, H, () => r.next());
    expect(reading).not.toBeNull();
    expect(reading!.measurable).toBe(false);
    expect(Number.isFinite(reading!.bestOverIdentity)).toBe(true);
    expect(Number.isFinite(reading!.identityOverRandom)).toBe(true);
    expect(isMisoriented(reading!)).toBe(false);
  });
});
