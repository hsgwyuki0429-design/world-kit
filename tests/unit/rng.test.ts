import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/Rng';

describe('Rng', () => {
  it('is deterministic for a given seed (§59)', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 32 }, () => a.next());
    const seqB = Array.from({ length: 32 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 16 }, ((r) => () => r.next())(new Rng(1)));
    const b = Array.from({ length: 16 }, ((r) => () => r.next())(new Rng(2)));
    expect(a).not.toEqual(b);
  });

  it('stays in [0,1) and is always finite', () => {
    const r = new Rng(99);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('reset replays the same sequence', () => {
    const r = new Rng(7);
    const first = [r.next(), r.next(), r.next()];
    r.reset();
    expect([r.next(), r.next(), r.next()]).toEqual(first);
  });

  it('sampleDistinct returns distinct in-range indices — the RANSAC sample step', () => {
    const r = new Rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const picked = r.sampleDistinct(5, 40);
      expect(new Set(picked).size).toBe(5);
      for (const i of picked) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(40);
      }
    }
  });

  it('sampleDistinct handles the exhaustive case', () => {
    const picked = new Rng(3).sampleDistinct(8, 8);
    expect([...picked].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('throws rather than returning a degenerate sample', () => {
    expect(() => new Rng(1).sampleDistinct(6, 5)).toThrow(/cannot draw/);
    expect(() => new Rng(1).nextInt(0)).toThrow(/positive integer/);
    expect(() => new Rng(Number.NaN)).toThrow(/finite/);
  });
});
