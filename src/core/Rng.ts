/**
 * Seeded PRNG.
 *
 * §59 requires determinism: the same input must produce the same spatial result, and
 * `Math.random` is banned inside `src/` (enforced by `scripts/audit-fake-data.mjs`).
 * Algorithms that legitimately need sampling — RANSAC in Phases 5, 6 and 11 — take an
 * `Rng` instance so a run can be replayed exactly from its seed.
 *
 * This exists to make sampling reproducible. It must never be used to *generate*
 * spatial data (§80: no random poses, landmarks, planes, confidences or coverage).
 */
export class Rng {
  private state: number;
  readonly seed: number;

  constructor(seed: number) {
    if (!Number.isFinite(seed)) throw new Error('Rng seed must be finite');
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** mulberry32 — small, fast, good enough for RANSAC sampling. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer bound, got ${maxExclusive}`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  /**
   * `count` distinct indices from [0, populationSize) — the sample step of RANSAC.
   * Throws rather than silently returning duplicates, because a degenerate sample
   * would quietly corrupt a geometric model.
   */
  sampleDistinct(count: number, populationSize: number): number[] {
    if (count > populationSize) {
      throw new Error(`cannot draw ${count} distinct from ${populationSize}`);
    }
    const picked = new Set<number>();
    const out: number[] = [];
    // Bounded: with count <= populationSize this terminates with probability 1;
    // the guard turns a pathological case into an error instead of a hang.
    let guard = 0;
    const maxAttempts = 100 * count + 1000;
    while (out.length < count) {
      if (++guard > maxAttempts) throw new Error('sampleDistinct failed to converge');
      const i = this.nextInt(populationSize);
      if (!picked.has(i)) {
        picked.add(i);
        out.push(i);
      }
    }
    return out;
  }

  reset(): void {
    this.state = this.seed;
  }
}
