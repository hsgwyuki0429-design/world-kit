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
  MAX_HAND_EYE_RESIDUAL_DEG,
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

/**
 * Pairs whose two instruments agree about *how far* the phone turned and not about *which way*.
 *
 * This is the device's own case rather than an invented one. The 2026-09-21 run's retained
 * comparisons show the camera and the gyroscope agreeing about the angle of the same turn to a
 * median of 1.4°, which is what gets a pair past `PAIR_ANGLE_TOLERANCE` — and then produce a fit
 * whose axes are 88.13° from their partners. Shuffling whole camera quaternions instead would
 * disturb the angles too, and the pairs would be taken by the angle filter before the fit ever
 * ran; the first draft of this test did exactly that and proved nothing about the residual.
 */
function agreeingAnglesWrongAxes(seed: number): HandEyePair[] {
  const rng = new Rng(seed);
  return spreadAxes(40, seed).map((axis) => {
    const deg = 6 + rng.next() * 18;
    const device = turn(axis, deg);
    // Same angle, an axis drawn independently: no single rotation can carry one set onto the
    // other, and every pair still says the two instruments measured the same amount of turning.
    const camera = turn([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5], deg);
    return { device, camera };
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

  /**
   * The check the estimator had and did not use.
   *
   * `residualDeg` is the median angle between `x · n_d` and `n_c` after the fit, and the field's
   * own doc calls it "the residual a fabricated `x` cannot make small". It was computed,
   * displayed, recorded — and never compared against anything, so `estimateHandEye` returned a
   * rotation it had just measured to be wrong. The device run of 2026-09-21 reported
   * `calibrated: true` at a residual of 88.13°, the filter's bias state absorbed the resulting
   * standing disagreement at 12.9 °/s, and IMU-004 failed on a fused gravity 23.19° from the
   * measured one.
   *
   * The two cases below are the two populations the floor sits between, measured rather than
   * argued — see `MAX_HAND_EYE_RESIDUAL_DEG`.
   */
  it('refuses a fit that does not fit, however well the axes are spread', () => {
    const out = estimateHandEye(agreeingAnglesWrongAxes(21));

    expect(out.rotation).toBeNull();
    if (out.rotation) return;
    // Refused by neither of the two filters that existed before: it cleared both.
    expect(out.pairs).toBeGreaterThanOrEqual(MIN_HAND_EYE_PAIRS);
    expect(out.axisSpread).toBeGreaterThan(AXIS_SPREAD_FLOOR);
    expect(out.rejections.angleDisagrees).toBe(0);
    // Two axes with nothing relating them average 90°, which is the scale this is read against.
    expect(out.residualDeg).toBeGreaterThan(45);
    expect(out.reason).toContain('apart');
  });

  it('says how far off the fit was, so a refusal can be read without a second device run', () => {
    const out = estimateHandEye(agreeingAnglesWrongAxes(33));
    if (out.rotation) throw new Error('expected a refusal');
    expect(out.reason).toContain(out.residualDeg.toFixed(1));
    expect(out.reason).toContain(String(MAX_HAND_EYE_RESIDUAL_DEG));
  });

  it('still admits a genuinely noisy fit — the floor refuses nothing that works', () => {
    // Twice Phase 6's own 3° agreement band on the visual rotation. The fixture measures a
    // median residual of about 8° here, and the worst of twelve seeds is 10.76°.
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(40, 9), 6.0, 5));
    expect(out.rotation).not.toBeNull();
    if (!out.rotation) return;
    expect(out.residualDeg).toBeLessThan(MAX_HAND_EYE_RESIDUAL_DEG);
    expect(angleBetweenDeg(out.rotation, trueX)).toBeLessThan(15);
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

/* -------------------------------------------------------------------------- */

/**
 * The parity probe — which of the three causes of a large residual this is.
 *
 * A device run on 2026-09-22 refused at **96.4°** with the axes well spread (0.1801) and the
 * camera and gyroscope agreeing about the same turn to a median of **0.55°**. The refusal could
 * say that no rotation fitted; it could not say *why*, and the two live explanations call for
 * opposite fixes. Either the two frames are related by a reflection — a negated sensor axis, an
 * image delivered mirrored — in which case no rotation exists to be found and the angles agree
 * anyway, because a reflection preserves the angle of a rotation. Or the two halves are not the
 * same motion, in which case they span different intervals.
 *
 * Fitting the same axes with the camera set negated separates them in one number, and it can
 * only ever refuse: `−R` is not a rotation and nothing fuses through the mirrored fit.
 */
describe('the parity probe — a reflection is not a rotation', () => {
  const trueX = normalise(multiply(turn([0, 0, 1], 90), turn([1, 0, 0], 180)));

  it('says a correct correspondence is not mirrored', () => {
    const out = estimateHandEye(pairsThrough(trueX, spreadAxes(30), 2));
    expect(out.rotation).not.toBeNull();
    expect(out.residualDeg).toBeLessThan(MAX_HAND_EYE_RESIDUAL_DEG);
    // The mirrored fit of data that really is related by a rotation is hopeless, which is what
    // makes the probe a discriminator rather than a coin toss.
    expect(out.mirroredResidualDeg).toBeGreaterThan(60);
  });

  it('names a reflection when one side’s axes are negated', () => {
    // Every camera half inverted: same angle, axis reversed — exactly what a negated sensor
    // axis triple or a mirrored image produces, and what `PAIR_ANGLE_TOLERANCE` cannot see.
    const mirrored = pairsThrough(trueX, spreadAxes(30), 2).map((p) => ({
      device: p.device,
      camera: conjugate(p.camera),
    }));
    const out = estimateHandEye(mirrored);
    expect(out.rotation).toBeNull();
    if (out.rotation) return;
    expect(out.residualDeg).toBeGreaterThan(MAX_HAND_EYE_RESIDUAL_DEG);
    expect(out.mirroredResidualDeg).toBeLessThan(MAX_HAND_EYE_RESIDUAL_DEG);
    expect(out.reason).toContain('reflection');
    // ...and it never suggests moving the phone differently, which is the mistake this
    // message was written to stop making.
    expect(out.reason).not.toMatch(/mix|different axes|spinning/);
  });

  it('says it is not a reflection either when the halves are different motions', () => {
    const out = estimateHandEye(agreeingAnglesWrongAxes(0x5150));
    expect(out.rotation).toBeNull();
    if (out.rotation) return;
    expect(out.residualDeg).toBeGreaterThan(MAX_HAND_EYE_RESIDUAL_DEG);
    expect(out.mirroredResidualDeg).toBeGreaterThan(MAX_HAND_EYE_RESIDUAL_DEG);
    expect(out.reason).toContain('not the same motion');
  });
});
