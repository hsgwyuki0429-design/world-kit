/**
 * The device→camera rotation, against extrinsics known by construction.
 *
 * Every fixture picks a true `x`, generates the same turn in both frames through it, and asks the
 * estimator to find it back. The answer therefore exists before the solver runs, which is the
 * convention `fusion.test.ts` and Phase 5's fixtures both established.
 *
 * The case that matters is the last one: a phone panned about a single axis leaves a whole
 * one-parameter family of extrinsics fitting the data equally well, and an estimator that returns
 * one of them with confidence is inventing the degree of freedom nothing constrained.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/Rng';
import {
  AXIS_SPREAD_FLOOR,
  MIN_HAND_EYE_PAIRS,
  estimateHandEye,
  rotateByHandEye,
} from '../../src/fusion/handEye';
import type { HandEyePair } from '../../src/fusion/handEye';
import { angleBetweenDeg, conjugate, fromRotationVector, multiply, normalise } from '../../src/fusion/quat';
import type { Quat } from '../../src/fusion/quat';

const DEG = Math.PI / 180;

/** A rotation of `deg` about a unit axis. */
function turn(axis: readonly number[], deg: number): Quat {
  const n = Math.hypot(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0) || 1;
  const r = deg * DEG;
  return fromRotationVector([
    ((axis[0] ?? 0) / n) * r,
    ((axis[1] ?? 0) / n) * r,
    ((axis[2] ?? 0) / n) * r,
  ]);
}

/**
 * Turns in the device frame, carried into the camera frame through the true extrinsic.
 *
 * `q_c = x ⊗ q_d ⊗ x*` — the relation the estimator inverts, applied forward here so the fixture
 * never uses the solver's own arithmetic to make its data.
 */
function pairsThrough(x: Quat, axes: readonly (readonly number[])[], noiseDeg = 0, seed = 7): HandEyePair[] {
  const rng = new Rng(seed);
  return axes.map((axis) => {
    const deg = 4 + rng.next() * 20;
    const device = turn(axis, deg);
    const clean = normalise(multiply(multiply(x, device), conjugate(x)));
    if (noiseDeg <= 0) return { device, camera: clean };
    const wobble = turn(
      [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5],
      (rng.next() - 0.5) * 2 * noiseDeg,
    );
    return { device, camera: normalise(multiply(clean, wobble)) };
  });
}

/** Axes spread over the sphere, as a hand-held phone produces within seconds. */
function spreadAxes(count: number, seed = 11): number[][] {
  const rng = new Rng(seed);
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    out.push([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]);
  }
  return out;
}

describe('the device→camera rotation, recovered', () => {
  // The rotation an iPhone's rear camera actually sits at is a quarter turn and a flip; the
  // fixture uses an awkward one instead, so nothing can pass by being close to identity.
  const trueX = normalise(multiply(turn([0, 0, 1], 90), turn([1, 0, 0], 180)));

  it('finds an extrinsic it was never told, from turns spread over the sphere', () => {
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(40)));
    expect(out.rotation).not.toBeNull();
    if (!out.rotation) return;
    // Recovered to well inside Phase 6's own 3° agreement band.
    expect(angleBetweenDeg(out.rotation, trueX)).toBeLessThan(0.5);
    expect(out.pairs).toBeGreaterThanOrEqual(MIN_HAND_EYE_PAIRS);
    expect(out.axisSpread).toBeGreaterThan(AXIS_SPREAD_FLOOR);
  });

  it('survives noise on the visual rotation, and says what it cost', () => {
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(60, 3), 2.0, 5));
    expect(out.rotation).not.toBeNull();
    if (!out.rotation) return;
    expect(angleBetweenDeg(out.rotation, trueX)).toBeLessThan(6);
    // The residual is measured against axes the estimator could not choose, so it is a fact
    // about the fit rather than a restatement of it.
    expect(out.residualDeg).toBeGreaterThan(0);
    expect(out.residualDeg).toBeLessThan(15);
  });

  it('is the rotation that actually carries a device axis onto its camera partner', () => {
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(40)));
    if (!out.rotation) throw new Error('expected an estimate');
    // Not a restatement of the fit: an independent vector, carried through both rotations.
    const v = [0.3, -0.7, 0.65];
    const throughEstimate = rotateByHandEye(out.rotation, v);
    const throughTruth = rotateByHandEye(trueX, v);
    for (let i = 0; i < 3; i++) {
      expect(throughEstimate[i] ?? 0).toBeCloseTo(throughTruth[i] ?? 0, 2);
    }
  });
});

describe('what the estimator refuses', () => {
  const trueX = normalise(multiply(turn([0, 0, 1], 90), turn([1, 0, 0], 180)));

  it('refuses a pan — one shared axis leaves a family of answers, not an answer', () => {
    // Every turn about the same axis, which is what a phone swept left and right produces.
    const axes = Array.from({ length: 40 }, () => [0, 1, 0]);
    const out = estimateHandEye(pairsThrough(trueX, axes));
    expect(out.rotation).toBeNull();
    if (out.rotation) return;
    expect(out.axisSpread).toBeLessThan(AXIS_SPREAD_FLOOR);
    expect(out.reason).toContain('share an axis');
  });

  it('...and the family is real: a wrong extrinsic fits that data exactly as well', () => {
    // The point behind the refusal, demonstrated rather than asserted. Composing the truth with
    // any turn *about the shared axis* leaves every pair satisfied — so the data cannot choose.
    const axis = [0, 1, 0];
    const pairs = pairsThrough(trueX, Array.from({ length: 20 }, () => axis));
    const imposter = normalise(multiply(trueX, turn(axis, 37)));
    expect(angleBetweenDeg(imposter, trueX)).toBeGreaterThan(30);
    for (const p of pairs) {
      const throughTruth = normalise(multiply(multiply(trueX, p.device), conjugate(trueX)));
      const throughImposter = normalise(multiply(multiply(imposter, p.device), conjugate(imposter)));
      expect(angleBetweenDeg(throughTruth, throughImposter)).toBeLessThan(1e-6);
    }
  });

  it('refuses before it has enough pairs, rather than fitting four points', () => {
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(4)));
    expect(out.rotation).toBeNull();
    if (out.rotation) return;
    expect(out.reason).toContain(String(MIN_HAND_EYE_PAIRS));
  });

  it('drops a pair whose two instruments disagree about the angle', () => {
    // The angle is frame-invariant, so this filter is available before `x` is known — and a pair
    // that fails it is not one turn seen twice, whatever its axes look like.
    const good = pairsThrough(trueX, spreadAxes(30));
    const broken: HandEyePair[] = good.map((p, i) =>
      i % 2 === 0 ? p : { device: p.device, camera: turn([1, 0, 0], 45) },
    );
    const out = estimateHandEye(broken);
    // Half the pairs are nonsense and are dropped rather than averaged in.
    expect(out.pairs).toBeLessThan(good.length);
    if (!out.rotation) return;
    expect(angleBetweenDeg(out.rotation, trueX)).toBeLessThan(3);
  });
});
