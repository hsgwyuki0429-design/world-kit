/**
 * Shi-Tomasi, checked against images whose corners are known by construction.
 *
 * A checkerboard has corners exactly where four squares meet and nowhere else; a flat field
 * has none; a single straight edge has none either, because an edge is not a feature — one
 * eigenvalue is large and the other is nearly zero, and Phase 4's optical flow cannot
 * localise along it. Detection can therefore be tested for correctness rather than for
 * plausibility, without a camera.
 *
 * The contrast check gets particular attention: FEAT-001 rests on it, and a check that has
 * never been shown to fail is not a check. So one case feeds the detector's own output
 * through a control that scores at chance, and asserts the ratio collapses.
 */

import { describe, expect, it } from 'vitest';
import { FeatureDetector, localVariance, rankAboveChance } from '../../src/tracking/FeatureDetector';
import { Rng } from '../../src/core/Rng';
import {
  GRID_CELLS,
  SceneTexture,
  cellIndexFor,
  classifyTexture,
  featureStateFor,
  refillUrgencyFor,
  DEGRADED_BELOW,
  FEATURE_MIN,
  REFILL_BELOW,
} from '../../src/tracking/featureTypes';

function checkerboard(width: number, height: number, square: number): Uint8Array {
  const g = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      g[y * width + x] = on ? 220 : 30;
    }
  }
  return g;
}

function flat(width: number, height: number, value = 128): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

/** A single vertical step: strong gradient in x, none in y. An edge, not a corner. */
function verticalEdge(width: number, height: number): Uint8Array {
  const g = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) g[y * width + x] = x < width / 2 ? 30 : 220;
  }
  return g;
}

/**
 * Evenly spread texture whose corners differ in strength.
 *
 * A plain checkerboard is useless as the control for FEAT-003: every corner scores
 * identically, so the ungridded selection breaks ties in scan order and concentrates in the
 * top rows for reasons that have nothing to do with the image. Varying the contrast per
 * block gives a distribution that is genuinely even *and* orderable.
 */
function evenVariedTexture(width: number, height: number): Uint8Array {
  const g = new Uint8Array(width * height);
  const block = 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / block);
      const by = Math.floor(y / block);
      // Deterministic per-block amplitude, uncorrelated with position (§59 — no
      // Math.random anywhere in the tree, tests included).
      const h32 = Math.imul(bx * 73_856_093 ^ by * 19_349_663, 0x45d9f3b) >>> 0;
      const amp = 40 + (h32 % 180);
      const on = (bx + by) % 2 === 0;
      g[y * width + x] = on ? Math.min(255, 128 + amp / 2) : Math.max(0, 128 - amp / 2);
    }
  }
  return g;
}

/** Texture in the left third only — the case the 8×6 grid exists for. */
function clusteredTexture(width: number, height: number): Uint8Array {
  const g = flat(width, height, 128);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.floor(width / 3); x++) {
      const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      g[y * width + x] = on ? 230 : 20;
    }
  }
  return g;
}

const opts = { levelScale: 2, wantContrast: true, wantGridComparison: true };

describe('FeatureDetector', () => {
  it('finds corners on a checkerboard', () => {
    const d = new FeatureDetector();
    const r = d.detect(checkerboard(160, 120, 10), 160, 120, opts);
    expect(r.features.length).toBeGreaterThan(20);
    expect(r.maxCornerStrength).toBeGreaterThan(0);
    expect(r.texture).toBe(SceneTexture.RICH);
  });

  it('finds nothing on a flat field, and says the scene is blank', () => {
    const d = new FeatureDetector();
    const r = d.detect(flat(160, 120), 160, 120, opts);
    expect(r.features.length).toBe(0);
    expect(r.candidateCount).toBe(0);
    expect(r.maxCornerStrength).toBe(0);
    expect(r.meanGradient).toBe(0);
    expect(r.texture).toBe(SceneTexture.POOR);
  });

  it('rejects a straight edge — one strong eigenvalue is not a corner', () => {
    const d = new FeatureDetector();
    const edge = d.detect(verticalEdge(160, 120), 160, 120, opts);
    const board = d.detect(checkerboard(160, 120, 10), 160, 120, opts);
    // The edge has enormous gradient energy and yet almost no corner strength, which is the
    // whole reason Shi-Tomasi takes the *smaller* eigenvalue.
    expect(edge.meanGradient).toBeGreaterThan(0);
    expect(edge.maxCornerStrength).toBeLessThan(board.maxCornerStrength / 50);
  });

  it('respects the 8×6 quota — no cell may exceed it', () => {
    const d = new FeatureDetector();
    const target = 240;
    const r = d.detect(checkerboard(320, 240, 6), 320, 240, { ...opts, target });
    const quota = Math.ceil(target / GRID_CELLS);
    const counts = new Array<number>(GRID_CELLS).fill(0);
    for (const f of r.features) counts[f.cell] = (counts[f.cell] ?? 0) + 1;
    expect(Math.max(...counts)).toBeLessThanOrEqual(quota);
  });

  it('honours the separation radius between accepted features', () => {
    const d = new FeatureDetector({ minSeparation: 10 });
    const r = d.detect(checkerboard(240, 180, 5), 240, 180, opts);
    expect(r.features.length).toBeGreaterThan(5);
    for (let i = 0; i < r.features.length; i++) {
      for (let j = i + 1; j < r.features.length; j++) {
        const a = r.features[i];
        const b = r.features[j];
        if (!a || !b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('the grid measurably reduces clustering on a scene that clusters', () => {
    const d = new FeatureDetector();
    const r = d.detect(clusteredTexture(320, 240), 320, 240, { ...opts, target: 200 });
    const g = r.gridComparison;
    expect(g).toBeTruthy();
    expect(g!.griddedMaxCellShare).toBeLessThan(g!.ungriddedMaxCellShare);
    expect(g!.griddedOccupiedCells).toBeGreaterThanOrEqual(g!.ungriddedOccupiedCells);
  });

  it('the grid changes little on an evenly textured scene — so the test measures the grid', () => {
    // The control for the case above. If the gridded and ungridded selections differed here
    // too, FEAT-003 would be measuring the wallpaper rather than the mechanism.
    const d = new FeatureDetector();
    const r = d.detect(evenVariedTexture(320, 240), 320, 240, { ...opts, target: 200 });
    const g = r.gridComparison!;
    expect(Math.abs(g.griddedMaxCellShare - g.ungriddedMaxCellShare)).toBeLessThan(0.05);
  });

  it('puts features on the corner rather than beside it', () => {
    // The defect a flat box kernel produces: a plateau of equal scores around each corner,
    // with the scan keeping its top-left edge. Measured at 3 px of systematic bias before
    // `blurPasses` was introduced. Local variance is the independent check — a point beside
    // a checkerboard corner sits inside one flat square and has none.
    const width = 320;
    const height = 240;
    const gray = checkerboard(width, height, 10);
    const r = new FeatureDetector().detect(gray, width, height, opts);
    const onStructure = r.features.filter(
      (f) => localVariance(gray, width, height, Math.round(f.x), Math.round(f.y)) > 1000,
    );
    expect(onStructure.length / r.features.length).toBeGreaterThan(0.95);
  });

  it('scores far above chance on real corners — the contrast check', () => {
    const d = new FeatureDetector();
    const r = d.detect(checkerboard(320, 240, 10), 320, 240, opts);
    expect(r.contrast).toBeTruthy();
    expect(r.contrast!.aboveChance).toBeGreaterThan(0.75);
  });

  it('the ratio moves with the scene and the rank statistic does not', () => {
    // Why FEAT-001 gates on `aboveChance`. A checkerboard is textured everywhere, so the
    // random control is textured too and the ratio stays under 2 for a detector that is
    // working perfectly. The rank statistic is unmoved by that.
    const d = new FeatureDetector();
    const dense = d.detect(checkerboard(320, 240, 6), 320, 240, opts).contrast!;
    const sparse = d.detect(clusteredTexture(320, 240), 320, 240, opts).contrast!;
    expect(dense.ratio).toBeLessThan(sparse.ratio / 2);
    expect(dense.aboveChance).toBeGreaterThan(0.75);
    expect(sparse.aboveChance).toBeGreaterThan(0.75);
  });

  it('scores at chance when the positions are unrelated to the image — the check can fail', () => {
    // The fabricated detector FEAT-001 exists to catch: a lattice of plausible coordinates,
    // evenly spread, the right count, and nothing to do with the pixels. A check that has
    // never been shown to fail is not a check, so this is the failing case.
    const width = 320;
    const height = 240;
    const gray = clusteredTexture(width, height);
    const lattice: number[] = [];
    for (let y = 8; y < height - 8; y += 12) {
      for (let x = 8; x < width - 8; x += 12) lattice.push(localVariance(gray, width, height, x, y));
    }
    const control: number[] = [];
    const rng = new Rng(0x5eed_c0de);
    for (let i = 0; i < 400; i++) {
      control.push(
        localVariance(gray, width, height, 3 + rng.nextInt(width - 6), 3 + rng.nextInt(height - 6)),
      );
    }

    const fabricated = rankAboveChance(lattice, control);
    const real = new FeatureDetector().detect(gray, width, height, opts).contrast!;

    expect(fabricated).toBeLessThan(0.75);
    expect(real.aboveChance).toBeGreaterThan(0.75);
    expect(real.aboveChance).toBeGreaterThan(fabricated);
  });

  it('is deterministic: the same image gives the same features (§59)', () => {
    const gray = checkerboard(200, 160, 7);
    const a = new FeatureDetector().detect(gray, 200, 160, opts);
    const b = new FeatureDetector().detect(gray, 200, 160, opts);
    expect(a.features.map((f) => `${f.x},${f.y},${f.cornerStrength}`)).toEqual(
      b.features.map((f) => `${f.x},${f.y},${f.cornerStrength}`),
    );
    expect(a.contrast).toEqual(b.contrast);
  });

  it('reuses its buffers rather than allocating per frame', () => {
    const d = new FeatureDetector();
    const gray = checkerboard(160, 120, 8);
    d.detect(gray, 160, 120, opts);
    const after = d.bufferAllocations;
    for (let i = 0; i < 10; i++) d.detect(gray, 160, 120, opts);
    expect(d.bufferAllocations).toBe(after);
  });

  it('carries the §11 record, with the fields it cannot know left null', () => {
    const d = new FeatureDetector();
    const r = d.detect(checkerboard(160, 120, 8), 160, 120, opts);
    const ids = new Set<number>();
    for (const f of r.features) {
      expect(f.forwardBackwardError).toBeNull();
      expect(f.reprojectionError).toBeNull();
      expect(f.age).toBe(0);
      expect(f.trackLength).toBe(1);
      expect(Number.isFinite(f.cornerStrength)).toBe(true);
      expect(f.qualityScore).toBeGreaterThan(0);
      expect(f.qualityScore).toBeLessThanOrEqual(1);
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.x).toBeLessThan(160);
      expect(f.y).toBeLessThan(120);
      // levelScale 2: the level-0 coordinate is the detection coordinate doubled.
      expect(f.x0).toBe(f.x * 2);
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
    }
  });

  it('qualityScore is a function of cornerStrength alone', () => {
    const d = new FeatureDetector();
    const r = d.detect(checkerboard(240, 180, 9), 240, 180, opts);
    const sorted = [...r.features].sort((a, b) => b.cornerStrength - a.cornerStrength);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      expect(prev.qualityScore).toBeGreaterThanOrEqual(cur.qualityScore);
    }
  });

  it('returns an empty result rather than throwing on a degenerate image', () => {
    const d = new FeatureDetector();
    const r = d.detect(new Uint8Array(4), 2, 2, opts);
    expect(r.features).toEqual([]);
    expect(r.detectMs).toBeGreaterThanOrEqual(0);
  });
});

describe('§11 population ladder', () => {
  it('classifies the scene by the gap the test plan leaves', () => {
    expect(classifyTexture(20)).toBe(SceneTexture.RICH);
    expect(classifyTexture(8)).toBe(SceneTexture.RICH);
    expect(classifyTexture(6)).toBe(SceneTexture.AMBIGUOUS);
    expect(classifyTexture(4)).toBe(SceneTexture.POOR);
    expect(classifyTexture(0.5)).toBe(SceneTexture.POOR);
    expect(classifyTexture(Number.NaN)).toBe(SceneTexture.AMBIGUOUS);
  });

  it('maps counts to §57 states at §11 thresholds', () => {
    expect(featureStateFor(800)).toBe('FEATURES_OK');
    expect(featureStateFor(FEATURE_MIN)).toBe('FEATURES_OK');
    expect(featureStateFor(FEATURE_MIN - 1)).toBe('LOW_FEATURE_COUNT');
    expect(featureStateFor(DEGRADED_BELOW)).toBe('LOW_FEATURE_COUNT');
    expect(featureStateFor(DEGRADED_BELOW - 1)).toBe('TRACKING_DEGRADED');
  });

  it('maps counts to §11 regeneration urgency', () => {
    expect(refillUrgencyFor(REFILL_BELOW)).toBe('NONE');
    expect(refillUrgencyFor(REFILL_BELOW - 1)).toBe('REFILL');
    expect(refillUrgencyFor(199)).toBe('EMERGENCY');
  });

  it('assigns cells row-major across the 8×6 grid', () => {
    expect(cellIndexFor(0, 0, 800, 600)).toBe(0);
    expect(cellIndexFor(799, 599, 800, 600)).toBe(GRID_CELLS - 1);
    expect(cellIndexFor(100, 0, 800, 600)).toBe(1);
    expect(cellIndexFor(0, 100, 800, 600)).toBe(8);
    // Out of range clamps rather than producing an index outside the grid.
    expect(cellIndexFor(10_000, -5, 800, 600)).toBe(7);
  });
});
