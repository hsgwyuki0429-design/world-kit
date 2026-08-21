/**
 * Grayscale conversion and pyramid construction (§10 preprocessing).
 *
 * Pure array arithmetic on typed arrays: no DOM, no canvas, no platform. That is
 * deliberate — this is the part of the frame pipeline whose correctness can be proven
 * without a camera, so it is unit tested directly, and the worker that runs it on real
 * frames calls exactly these functions rather than a second copy of the same maths.
 *
 * Two constraints shape the implementation:
 *
 *  - **No per-frame allocation.** SharedArrayBuffer measured UNAVAILABLE on the target
 *    (static hosting cannot send COOP/COEP), so buffers cannot be shared between threads;
 *    what they can be is allocated once per configuration and reused, which is what
 *    `GrayPyramid` does. At 30 Hz the alternative is roughly 15 MB/s of garbage.
 *  - **Integer arithmetic in the inner loops.** The Rec. 601 weights are the same
 *    integer-shifted form Phase 1's monitor used, so the two measurements of the same
 *    image are comparable — which is what the provenance cross-check depends on.
 */

/** §10's preprocessing produces a 3-level pyramid; §H budgets it at ≤ 6 ms with acquire. */
export const PYRAMID_LEVELS = 3;

/** The proof strip: small enough to post every frame, large enough for motion to show. */
export const STRIP_W = 64;
export const STRIP_H = 48;

export interface LevelGeometry {
  readonly width: number;
  readonly height: number;
}

export interface PyramidLevel extends LevelGeometry {
  readonly data: Uint8Array;
}

/** Level dimensions for a base size. Each level halves, flooring, never below 1. */
export function levelGeometry(width: number, height: number, levels = PYRAMID_LEVELS): LevelGeometry[] {
  const out: LevelGeometry[] = [];
  let w = Math.max(1, Math.floor(width));
  let h = Math.max(1, Math.floor(height));
  for (let i = 0; i < levels; i++) {
    out.push({ width: w, height: h });
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return out;
}

/**
 * RGBA → 8-bit luma, Rec. 601, integer-weighted.
 *
 * Returns the mean luma, which the provenance cross-check compares against an independent
 * measurement of the same video frame taken on the main thread.
 */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, dst: Uint8Array): number {
  const n = dst.length;
  let sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const y = ((rgba[p] ?? 0) * 77 + (rgba[p + 1] ?? 0) * 150 + (rgba[p + 2] ?? 0) * 29) >> 8;
    dst[i] = y;
    sum += y;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Halve one level into the next by 2×2 box average.
 *
 * A box filter, not a decimation. Dropping every other pixel aliases, and the aliasing
 * would land in Phase 3's corner scores as texture that is not in the scene.
 */
export function halveInto(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dst: Uint8Array,
  dstW: number,
  dstH: number,
): void {
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.min(y * 2, srcH - 1);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const r0 = y0 * srcW;
    const r1 = y1 * srcW;
    const o = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.min(x * 2, srcW - 1);
      const x1 = Math.min(x0 + 1, srcW - 1);
      dst[o + x] =
        (((src[r0 + x0] ?? 0) + (src[r0 + x1] ?? 0) + (src[r1 + x0] ?? 0) + (src[r1 + x1] ?? 0)) +
          2) >>
        2;
    }
  }
}

/**
 * Area-average downsample to an arbitrary target size.
 *
 * Used for the proof strip, where the target grid is fixed at 64×48 regardless of the
 * frame's aspect ratio. Area averaging over the whole frame preserves the mean, which is
 * the property the cross-check relies on; the strip's aspect distortion is irrelevant to
 * it and is never used as image geometry.
 */
export function boxDownsampleInto(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dst: Uint8Array,
  dstW: number,
  dstH: number,
): void {
  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor((y * srcH) / dstH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor((x * srcW) / dstW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let sum = 0;
      let count = 0;
      for (let sy = sy0; sy < sy1 && sy < srcH; sy++) {
        const row = sy * srcW;
        for (let sx = sx0; sx < sx1 && sx < srcW; sx++) {
          sum += src[row + sx] ?? 0;
          count++;
        }
      }
      dst[y * dstW + x] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
}

export function meanOf(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
  return sum / data.length;
}

/** Mean absolute difference between two equal-length buffers, 0–255. `-1` if unequal. */
export function madBetween(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return diff / a.length;
}

/**
 * FNV-1a over a strided subsample.
 *
 * Cheap enough for the hot path and sufficient for its only job: showing that consecutive
 * frames carry different bytes. It is *not* offered as provenance — a checksum that
 * changes proves motion in some buffer, not that the buffer came from the camera. That is
 * the cross-check's job, and FRAME-002 says so explicitly.
 */
export function stridedChecksum(data: Uint8Array, stride = 16): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i += stride) {
    h ^= data[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A reusable pyramid for one processing size.
 *
 * Reconfigured — and reallocated — only when the processing size changes, which happens on
 * a tier step or a source rotation. `allocations` is exposed so the evidence can show that
 * a 30-second run allocated a handful of times rather than a thousand.
 */
export class GrayPyramid {
  readonly levels: PyramidLevel[] = [];
  readonly strip: Uint8Array = new Uint8Array(STRIP_W * STRIP_H);
  private previousTop: Uint8Array | null = null;
  private allocationCount = 0;

  constructor(width: number, height: number, levels = PYRAMID_LEVELS) {
    for (const g of levelGeometry(width, height, levels)) {
      this.levels.push({ width: g.width, height: g.height, data: new Uint8Array(g.width * g.height) });
      this.allocationCount++;
    }
  }

  get allocations(): number {
    return this.allocationCount;
  }

  get base(): PyramidLevel {
    const l = this.levels[0];
    if (!l) throw new Error('pyramid has no levels');
    return l;
  }

  get top(): PyramidLevel {
    const l = this.levels[this.levels.length - 1];
    if (!l) throw new Error('pyramid has no levels');
    return l;
  }

  /** Build levels 1..n from level 0, which the caller has already filled. */
  buildLevels(): void {
    for (let i = 1; i < this.levels.length; i++) {
      const src = this.levels[i - 1];
      const dst = this.levels[i];
      if (!src || !dst) continue;
      halveInto(src.data, src.width, src.height, dst.data, dst.width, dst.height);
    }
  }

  fillStrip(): void {
    const b = this.base;
    boxDownsampleInto(b.data, b.width, b.height, this.strip, STRIP_W, STRIP_H);
  }

  /**
   * Frame-to-frame difference on the smallest level.
   *
   * Returns `-1` when there is no comparable predecessor — the first frame after a
   * configuration change has nothing to be compared with, and reporting 0 there would look
   * exactly like a frozen image.
   */
  diffAgainstPrevious(): number {
    const t = this.top;
    if (!this.previousTop || this.previousTop.length !== t.data.length) {
      this.previousTop = new Uint8Array(t.data);
      this.allocationCount++;
      return -1;
    }
    const mad = madBetween(t.data, this.previousTop);
    this.previousTop.set(t.data);
    return mad;
  }

  geometry(): LevelGeometry[] {
    return this.levels.map((l) => ({ width: l.width, height: l.height }));
  }
}
