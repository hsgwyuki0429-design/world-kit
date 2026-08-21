/**
 * The parts of the frame pipeline whose correctness does not need a camera.
 *
 * Tier derivation and pyramid arithmetic are pure, so they are tested directly rather than
 * inferred from a device run. Two properties get particular attention because a later phase
 * depends on them and would fail obscurely if they were wrong:
 *
 *  - §H.0's rotation case, where the source dimensions swap and the processing size has to
 *    be re-derived rather than reused;
 *  - the mean-preserving property of area downsampling, which is what makes FRAME-002's
 *    provenance cross-check able to compare two different downscales of one video frame.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIER_STEP,
  FLOOR_TIER_STEP,
  TIER_LADDER,
  aspectError,
  deriveProcessingSize,
  tierAt,
  tierPixelBudget,
} from '../../src/pipeline/tiers';
import {
  GrayPyramid,
  PYRAMID_LEVELS,
  STRIP_H,
  STRIP_W,
  boxDownsampleInto,
  halveInto,
  levelGeometry,
  madBetween,
  meanOf,
  rgbaToGray,
  stridedChecksum,
} from '../../src/pipeline/pyramid';

function rgbaOf(width: number, height: number, fn: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = fn(x, y);
      const p = (y * width + x) * 4;
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

describe('tier ladder (§53, §54)', () => {
  it('gives up resolution before frame rate, in that order', () => {
    for (let i = 1; i < TIER_LADDER.length; i++) {
      const prev = tierAt(i - 1);
      const next = tierAt(i);
      // Each step is no more expensive than the one before it, in both dimensions.
      expect(tierPixelBudget(next)).toBeLessThanOrEqual(tierPixelBudget(prev));
      expect(next.targetFps).toBeLessThanOrEqual(prev.targetFps);
      // ...and exactly one of the two actually changes, so the ladder has no wasted rungs
      // and no step that gives up both at once.
      const resolutionChanged = tierPixelBudget(next) !== tierPixelBudget(prev);
      const rateChanged = next.targetFps !== prev.targetFps;
      expect(resolutionChanged !== rateChanged, `step ${i}`).toBe(true);
    }
  });

  it('starts at BASIC and floors at 15 fps (§10, §H)', () => {
    expect(tierAt(DEFAULT_TIER_STEP).longEdge).toBe(960);
    expect(tierAt(DEFAULT_TIER_STEP).targetFps).toBe(30);
    expect(tierAt(FLOOR_TIER_STEP).targetFps).toBe(15);
    for (const t of TIER_LADDER) expect(t.targetFps).toBeGreaterThanOrEqual(15);
  });

  it('never permits a processing size above 1280x720, so 4K tracking is unreachable', () => {
    for (const t of TIER_LADDER) {
      const p = deriveProcessingSize(3840, 2160, t);
      expect(p.width * p.height).toBeLessThanOrEqual(1280 * 720);
      expect(p.scale).toBeLessThanOrEqual(1);
    }
  });
});

describe('deriveProcessingSize (§H.0)', () => {
  const basic = tierAt(1);

  it('derives the same pixel count either side of a rotation', () => {
    const landscape = deriveProcessingSize(1280, 720, basic);
    const portrait = deriveProcessingSize(720, 1280, basic);
    expect(landscape.width).toBe(portrait.height);
    expect(landscape.height).toBe(portrait.width);
    expect(landscape.width * landscape.height).toBe(portrait.width * portrait.height);
  });

  it('preserves the source aspect ratio', () => {
    for (const [w, h] of [[1280, 720], [720, 1280], [640, 480], [1920, 1080], [1440, 1080]]) {
      const p = deriveProcessingSize(w as number, h as number, basic);
      expect(aspectError(w as number, h as number, p.width, p.height)).toBeLessThan(0.02);
    }
  });

  it('never upscales a source smaller than the tier', () => {
    const p = deriveProcessingSize(320, 240, basic);
    expect(p.scale).toBe(1);
    expect(p.width).toBeLessThanOrEqual(320);
    expect(p.height).toBeLessThanOrEqual(240);
  });

  it('stays within the tier pixel budget whichever way the device is held', () => {
    for (const t of TIER_LADDER) {
      for (const [w, h] of [[1280, 720], [720, 1280], [4032, 3024]]) {
        const p = deriveProcessingSize(w as number, h as number, t);
        expect(p.width * p.height, `${t.name} ${w}x${h}`).toBeLessThanOrEqual(tierPixelBudget(t));
      }
    }
  });

  it('returns a zero size for a source that has not reported one yet', () => {
    expect(deriveProcessingSize(0, 0, basic).width).toBe(0);
    expect(deriveProcessingSize(Number.NaN, 720, basic).width).toBe(0);
  });

  it('produces even edges, so three pyramid levels exist without a half pixel', () => {
    for (const [w, h] of [[1281, 721], [999, 333], [1280, 720]]) {
      const p = deriveProcessingSize(w as number, h as number, basic);
      expect(p.width % 2).toBe(0);
      expect(p.height % 2).toBe(0);
    }
  });
});

describe('grayscale and pyramid', () => {
  it('converts RGBA to Rec. 601 luma and reports the mean', () => {
    const rgba = rgbaOf(4, 4, () => 100);
    const gray = new Uint8Array(16);
    const mean = rgbaToGray(rgba, gray);
    expect([...gray].every((v) => v === 100)).toBe(true);
    expect(mean).toBeCloseTo(100, 0);
  });

  it('halves by box average rather than by dropping pixels', () => {
    // A 2x2 checkerboard of 0 and 200 must average to 100, not to whichever pixel a
    // decimating filter happened to keep.
    const src = new Uint8Array([0, 200, 200, 0]);
    const dst = new Uint8Array(1);
    halveInto(src, 2, 2, dst, 1, 1);
    expect(dst[0]).toBe(100);
  });

  it('level geometry halves and never falls below one pixel', () => {
    expect(levelGeometry(960, 540)).toEqual([
      { width: 960, height: 540 },
      { width: 480, height: 270 },
      { width: 240, height: 135 },
    ]);
    expect(levelGeometry(1, 1, 4)).toEqual([
      { width: 1, height: 1 }, { width: 1, height: 1 },
      { width: 1, height: 1 }, { width: 1, height: 1 },
    ]);
  });

  it('area downsampling preserves the mean — the property the cross-check rests on', () => {
    // A horizontal ramp: every downscale that averages areas keeps the same mean, which is
    // why the worker's level-0 mean and the main thread's 64x48 mean are comparable even
    // though the two took different routes to get there.
    const w = 320;
    const h = 240;
    const src = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = (x * 255) / (w - 1);
    const strip = new Uint8Array(STRIP_W * STRIP_H);
    boxDownsampleInto(src, w, h, strip, STRIP_W, STRIP_H);
    expect(Math.abs(meanOf(strip) - meanOf(src))).toBeLessThan(1);
  });

  it('reports -1 rather than 0 for an incomparable difference', () => {
    expect(madBetween(new Uint8Array(4), new Uint8Array(5))).toBe(-1);
    expect(madBetween(new Uint8Array(0), new Uint8Array(0))).toBe(-1);
  });

  it('a checksum over a strided subsample still moves when the image moves', () => {
    const a = new Uint8Array(1024).fill(10);
    const b = new Uint8Array(1024).fill(10);
    b[512] = 200;
    expect(stridedChecksum(a, 16)).not.toBe(stridedChecksum(b, 16));
  });
});

describe('GrayPyramid', () => {
  it('builds the declared number of levels with self-consistent geometry', () => {
    const p = new GrayPyramid(64, 48);
    expect(p.levels.length).toBe(PYRAMID_LEVELS);
    for (const level of p.levels) {
      expect(level.data.length).toBe(level.width * level.height);
    }
    expect(p.base.width).toBe(64);
    expect(p.top.width).toBe(16);
  });

  it('allocates once and then reuses its buffers across frames', () => {
    const p = new GrayPyramid(64, 48);
    const before = p.allocations;
    const rgba = rgbaOf(64, 48, (x) => x * 3);
    for (let i = 0; i < 20; i++) {
      rgbaToGray(rgba, p.base.data);
      p.buildLevels();
      p.fillStrip();
      p.diffAgainstPrevious();
    }
    // Exactly one extra allocation: the first `diffAgainstPrevious` has nothing to compare
    // against and keeps a copy. Twenty frames after that add nothing.
    expect(p.allocations).toBe(before + 1);
  });

  it('reports -1 for the first frame difference instead of a misleading zero', () => {
    const p = new GrayPyramid(32, 32);
    const flat = rgbaOf(32, 32, () => 128);
    rgbaToGray(flat, p.base.data);
    p.buildLevels();
    expect(p.diffAgainstPrevious()).toBe(-1);

    rgbaToGray(flat, p.base.data);
    p.buildLevels();
    // A genuinely unchanged image now reads 0 — which is the point: the first frame's
    // absence of a predecessor must not look like a frozen image.
    expect(p.diffAgainstPrevious()).toBe(0);
  });

  it('measures a real difference when the image changes', () => {
    const p = new GrayPyramid(32, 32);
    rgbaToGray(rgbaOf(32, 32, () => 20), p.base.data);
    p.buildLevels();
    p.diffAgainstPrevious();
    rgbaToGray(rgbaOf(32, 32, () => 220), p.base.data);
    p.buildLevels();
    expect(p.diffAgainstPrevious()).toBeCloseTo(200, 0);
  });
});
