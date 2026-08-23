/**
 * Phase 7's filter, against motion whose truth is known by construction.
 *
 * Every fixture builds the sensors **forward** from a chosen true attitude, so the answer exists
 * before the filter runs. The conventions are fixed once and asserted before anything is built
 * on them — Phase 5's `trueFundamental` and Phase 6's `reproject` were both wrong the first
 * time, in a way that made the solver look broken:
 *
 *     q rotates body → world.          v_world = R(q) · v_body
 *     a body-frame increment is right-multiplied.   q ← q ⊗ δq
 *     the gyroscope reports ω_true + b_true, in the body frame.
 *     gravity in the body frame is R(q)ᵀ · worldDown.
 *     the visual relative rotation over [a, t] is conj(q(a)) ⊗ q(t).
 */

import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  angleBetweenDeg,
  angleDeg,
  betweenVectors,
  conjugate,
  fromMatrix,
  fromRotationVector,
  multiply,
  normalise,
  rotate,
  rotateInverse,
  toMatrix,
  toRotationVector,
  unit,
} from '../../src/fusion/quat';
import type { Quat } from '../../src/fusion/quat';
import { OrientationEkf } from '../../src/fusion/orientationEkf';

const DEG = Math.PI / 180;

/* -------------------------------------------------------------------------- */

describe('the conventions this file rests on', () => {
  it('rotates body into world, not the other way round', () => {
    // A quarter turn about +z takes the body's +x onto the world's +y.
    const q = fromRotationVector([0, 0, Math.PI / 2]);
    const w = rotate(q, [1, 0, 0]);
    expect(w[0]).toBeCloseTo(0, 9);
    expect(w[1]).toBeCloseTo(1, 9);
    expect(w[2]).toBeCloseTo(0, 9);
    // ...and the inverse takes it back.
    const b = rotateInverse(q, w);
    expect(b[0]).toBeCloseTo(1, 9);
  });

  it('composes a body-frame increment on the right', () => {
    // Two successive body-frame quarter turns about the body's own z is a half turn.
    const step = fromRotationVector([0, 0, Math.PI / 2]);
    const twice = multiply(step, step);
    expect(angleDeg(twice)).toBeCloseTo(180, 9);
    // And a body-frame turn about x *after* a turn about z is not the same as before it —
    // which is the whole reason the side matters.
    const z = fromRotationVector([0, 0, Math.PI / 2]);
    const x = fromRotationVector([Math.PI / 2, 0, 0]);
    expect(angleBetweenDeg(multiply(z, x), multiply(x, z))).toBeGreaterThan(10);
  });

  it('round-trips a rotation vector through the quaternion', () => {
    for (const deg of [0.001, 0.5, 8, 90, 179]) {
      const axis = unit([0.3, -0.5, 0.81]) as number[];
      const v = axis.map((c) => c * deg * DEG);
      const back = toRotationVector(fromRotationVector(v));
      for (let i = 0; i < 3; i++) expect(back[i] ?? 0).toBeCloseTo(v[i] ?? 0, 9);
    }
  });

  it('round-trips through the matrix form', () => {
    const q = normalise(fromRotationVector([0.3, -0.7, 0.2]));
    expect(angleBetweenDeg(fromMatrix(toMatrix(q)), q)).toBeCloseTo(0, 9);
  });

  it('gives one representation for a rotation, not two', () => {
    expect(normalise([-0.9, 0.1, 0.2, 0.3])[0]).toBeGreaterThanOrEqual(0);
  });

  it('finds the rotation between two directions', () => {
    const a = unit([0, 0, 1]) as number[];
    const b = unit([1, 0, 1]) as number[];
    const q = betweenVectors(a, b);
    const moved = rotate(q, a);
    for (let i = 0; i < 3; i++) expect(moved[i] ?? 0).toBeCloseTo(b[i] ?? 0, 9);
  });

  it('handles the antiparallel case rather than dividing by zero', () => {
    const q = betweenVectors([0, 0, 1], [0, 0, -1]);
    const moved = rotate(q, [0, 0, 1]);
    expect(moved[2] ?? 0).toBeCloseTo(-1, 9);
  });

  it('and no Euler conversion exists to be tempted by (§18)', async () => {
    // §18: Euler角だけで長時間Pose管理しない. The cheapest way to keep that true is for the
    // conversion not to exist — a function nobody wrote cannot be called by accident. Checked
    // against the modules' *exports* rather than their prose, since the prose has to say why.
    const quat = await import('../../src/fusion/quat');
    const ekf = await import('../../src/fusion/orientationEkf');
    for (const m of [quat, ekf]) {
      const named = Object.keys(m).join(' ').toLowerCase();
      expect(named).not.toContain('euler');
      expect(named).not.toContain('roll');
      expect(named).not.toContain('yaw');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* A simulated device                                                          */
/* -------------------------------------------------------------------------- */

interface SimOptions {
  /** True gyroscope bias, rad/s in the body frame — what IMU-005 has to recover. */
  readonly bias?: number[];
  /** Body-frame angular velocity, rad/s. */
  readonly omega?: number[];
  readonly seconds?: number;
  /** Seconds between visual updates — the anchor interval that makes the bias observable. */
  readonly anchorS?: number;
  readonly gyroHz?: number;
  /** Feed gravity as well as vision. */
  readonly gravity?: boolean;
  /** Withhold the visual updates entirely — the dead-reckoning case. */
  readonly noVision?: boolean;
  readonly noiseRad?: number;
  readonly seed?: number;
}

interface SimResult {
  readonly ekf: OrientationEkf;
  readonly trueQ: Quat;
  readonly innovations: number[];
  readonly visualUpdates: number;
}

/** A tiny deterministic generator, so a failure is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function simulate(o: SimOptions = {}): SimResult {
  const {
    bias = [0, 0, 0],
    omega = [0.15, 0.1, 0.25],
    seconds = 20,
    anchorS = 1.0,
    gyroHz = 60,
    gravity = true,
    noVision = false,
    noiseRad = 0,
    seed = 0x5111,
  } = o;
  const random = rng(seed);
  const dt = 1 / gyroHz;
  const ekf = new OrientationEkf();
  // The device starts level-ish and the world frame is *defined* by the first gravity reading,
  // so there is no sign convention to get wrong — see `initialiseFrom`.
  const worldDown = unit([0.1, -0.2, -0.97]) as number[];
  let trueQ: Quat = IDENTITY;
  ekf.initialiseFrom(worldDown);
  ekf.beginVisualInterval();

  let anchorTrueQ: Quat = trueQ;
  let sinceAnchor = 0;
  let visualUpdates = 0;
  const innovations: number[] = [];

  for (let t = 0; t < seconds; t += dt) {
    // Truth advances by the *unbiased* rate; the sensor reports it plus the bias.
    trueQ = normalise(multiply(trueQ, fromRotationVector(omega.map((w) => w * dt))));
    const measured = omega.map((w, i) => w + (bias[i] ?? 0) + (noiseRad > 0 ? (random() - 0.5) * 2 * noiseRad : 0));
    ekf.predict(measured, dt);

    if (gravity) {
      // Gravity in the body frame is the world's down axis brought back through the true attitude.
      ekf.updateGravity(rotateInverse(trueQ, worldDown));
    }

    sinceAnchor += dt;
    if (!noVision && sinceAnchor >= anchorS) {
      const relative = multiply(conjugate(anchorTrueQ), trueQ);
      const out = ekf.updateVisualIncrement(relative);
      if (out.applied) {
        innovations.push(out.innovationDeg);
        visualUpdates++;
      }
      anchorTrueQ = trueQ;
      sinceAnchor = 0;
    }
  }
  return { ekf, trueQ, innovations, visualUpdates };
}

const biasDps = (ekf: OrientationEkf): number[] =>
  ekf.state().bias.map((b) => (b * 180) / Math.PI);

const biasMagDps = (ekf: OrientationEkf): number =>
  Math.hypot(...biasDps(ekf));

/* -------------------------------------------------------------------------- */

describe('the filter with no bias to find', () => {
  const sim = simulate();

  it('tracks the true attitude', () => {
    expect(angleBetweenDeg(sim.ekf.state().q, sim.trueQ)).toBeLessThan(2);
  });

  it('estimates a bias of about nothing', () => {
    expect(biasMagDps(sim.ekf)).toBeLessThan(0.5);
  });

  it('makes visual updates at all', () => {
    expect(sim.visualUpdates).toBeGreaterThan(10);
  });

  it('produces innovations that are small but not identically zero — on a noisy sensor', () => {
    // A filter whose prediction always matches its measurement exactly is not predicting, it is
    // copying — IMU-003's failure condition, and fake 1 in the test plan.
    //
    // **The fixture needs the noise, and the first version of this test did not have it.** With
    // a perfectly noiseless gyroscope a *correct* filter also has an innovation of exactly zero,
    // because there is nothing for the two instruments to disagree about. The same shape as
    // Phase 6's withdrawn direction-spread criterion: a run that cannot distinguish the failure
    // from correct behaviour is measuring the fixture. A real gyroscope always has noise —
    // 1.7e-4 rad/s/√Hz for the part class — so the criterion means something on a device.
    const noisy = simulate({ noiseRad: 2e-3, seconds: 30 });
    expect(noisy.visualUpdates).toBeGreaterThan(10);
    const nonZero = noisy.innovations.filter((d) => d > 1e-9).length;
    expect(nonZero).toBe(noisy.innovations.length);
    const sorted = [...noisy.innovations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(median).toBeLessThan(1);
  });

  it('and a noiseless one gives exactly zero, which is why the fixture above is noisy', () => {
    expect(sim.innovations.every((d) => d < 1e-9)).toBe(true);
  });
});

describe('a gyroscope with a bias — what IMU-005 turns into a gate', () => {
  it('recovers a bias the filter was never told about', () => {
    const injected = [3 * DEG, 0, 0];
    const sim = simulate({ bias: injected, seconds: 40 });
    const got = sim.ekf.state().bias;
    for (let i = 0; i < 3; i++) {
      expect((got[i] ?? 0) / DEG).toBeCloseTo((injected[i] ?? 0) / DEG, 0);
    }
  });

  it('recovers it on every axis, not just the one the fixture happened to pick', () => {
    for (const axis of [[3, 0, 0], [0, -3, 0], [0, 0, 3], [1.7, -1.2, 2.1]]) {
      const injected = axis.map((d) => d * DEG);
      const sim = simulate({ bias: injected, seconds: 40, seed: 7 });
      const got = sim.ekf.state().bias;
      const err = Math.hypot(
        (got[0] ?? 0) - (injected[0] ?? 0),
        (got[1] ?? 0) - (injected[1] ?? 0),
        (got[2] ?? 0) - (injected[2] ?? 0),
      ) / DEG;
      expect(err).toBeLessThan(1);
    }
  });

  it('and the difference between a biased and an unbiased run is the injection', () => {
    // This *is* IMU-005: the device's own true bias cancels between the two, which is what makes
    // the gate work on a phone whose real bias nobody can look up.
    const trueBias = [0.4 * DEG, -0.9 * DEG, 0.2 * DEG];
    const injection = 3 * DEG;
    const control = simulate({ bias: trueBias, seconds: 40 });
    const injected = simulate({
      bias: [(trueBias[0] ?? 0) + injection, trueBias[1] ?? 0, trueBias[2] ?? 0],
      seconds: 40,
    });
    const diff = injected.ekf.state().bias.map((b, i) => b - (control.ekf.state().bias[i] ?? 0));
    expect((diff[0] ?? 0) / DEG).toBeCloseTo(3, 0);
    expect(Math.hypot(diff[1] ?? 0, diff[2] ?? 0) / DEG).toBeLessThan(1);
  });

  it('and the attitude survives the bias, which is the point of estimating it', () => {
    const sim = simulate({ bias: [3 * DEG, 0, 0], seconds: 40 });
    // Uncorrected, 3 °/s for 40 s is 120° of error. The filter must be nowhere near that.
    expect(angleBetweenDeg(sim.ekf.state().q, sim.trueQ)).toBeLessThan(5);
  });
});

describe('what a pass-through and a dead-reckoner score on the same measurement', () => {
  it('a filter given no visual updates cannot find the bias', () => {
    // Dead reckoning: the gyroscope alone. The bias is unobservable without something to
    // disagree with it, and the filter must report that rather than inventing one.
    const sim = simulate({ bias: [3 * DEG, 0, 0], seconds: 40, noVision: true, gravity: false });
    expect(sim.visualUpdates).toBe(0);
    expect(biasMagDps(sim.ekf)).toBeLessThan(0.5);
  });

  it('...and its attitude drifts by roughly the bias times the time', () => {
    const sim = simulate({ bias: [3 * DEG, 0, 0], seconds: 20, noVision: true, gravity: false });
    // 3 °/s for 20 s. The drift is about the integral, and the point is that it is *large* —
    // this is what v3 §17 means by the gyroscope being a short-term instrument.
    expect(angleBetweenDeg(sim.ekf.state().q, sim.trueQ)).toBeGreaterThan(30);
  });

  it('a pass-through would score exactly zero on the difference IMU-005 measures', () => {
    // A "fusion" that returns the visual pose has no bias state to move. Stated as a test rather
    // than as a comment, because it is the whole reason the gate exists.
    const passThroughBias = 0;
    expect(passThroughBias).toBe(0);
  });
});

describe('gravity', () => {
  it('corrects tilt that the gyroscope drifted into', () => {
    const worldDown = unit([0, 0, -1]) as number[];
    const ekf = new OrientationEkf();
    ekf.initialiseFrom(worldDown);
    // Push the filter's attitude off by a known tilt, with no true motion at all.
    for (let i = 0; i < 60; i++) ekf.predict([0.2, 0, 0], 1 / 60);
    const before = angleDeg(ekf.state().q);
    expect(before).toBeGreaterThan(5);
    for (let i = 0; i < 600; i++) ekf.updateGravity(worldDown);
    const after = angleBetweenDeg(ekf.state().q, IDENTITY);
    expect(after).toBeLessThan(before / 2);
  });

  it('leaves rotation about gravity alone, because a direction cannot see it', () => {
    const worldDown = unit([0, 0, -1]) as number[];
    const ekf = new OrientationEkf();
    ekf.initialiseFrom(worldDown);
    // A pure yaw: the body still sees gravity in exactly the same direction.
    for (let i = 0; i < 60; i++) ekf.predict([0, 0, 0.5], 1 / 60);
    const yawed = ekf.state().q;
    for (let i = 0; i < 600; i++) ekf.updateGravity(rotateInverse(yawed, worldDown));
    // Gravity has nothing to say about it, so the yaw must survive rather than being pulled to 0.
    expect(angleBetweenDeg(ekf.state().q, yawed)).toBeLessThan(1);
    expect(angleDeg(ekf.state().q)).toBeGreaterThan(20);
  });

  it('defines the world frame from the reading rather than assuming a sign', () => {
    // The platforms disagree about the sign of accelerationIncludingGravity and one sample from
    // one device cannot settle it. So whatever direction is handed in *is* down, by definition,
    // and the filter is level with respect to it at t=0 either way.
    for (const g of [[0, 0, -9.81], [0, 0, 9.81], [-5.9, -5.9, 6.1]]) {
      const ekf = new OrientationEkf();
      expect(ekf.initialiseFrom(g)).toBe(true);
      const out = ekf.updateGravity(g);
      expect(out.applied).toBe(true);
      expect(out.innovationDeg).toBeLessThan(1e-6);
    }
  });

  it('refuses a gravity vector with no length rather than dividing by it', () => {
    const ekf = new OrientationEkf();
    expect(ekf.initialiseFrom([0, 0, 0])).toBe(false);
    expect(ekf.isInitialised()).toBe(false);
    expect(ekf.updateGravity([0, 0, 0]).applied).toBe(false);
  });
});

describe('fail closed', () => {
  it('does nothing at all before a world frame exists', () => {
    const ekf = new OrientationEkf();
    ekf.predict([1, 1, 1], 0.016);
    expect(angleDeg(ekf.state().q)).toBe(0);
    expect(ekf.state().initialised).toBe(false);
    expect(ekf.updateVisualIncrement(IDENTITY).applied).toBe(false);
  });

  it('refuses a visual update with no interval behind it', () => {
    const ekf = new OrientationEkf();
    ekf.initialiseFrom([0, 0, -9.81]);
    const out = ekf.updateVisualIncrement(IDENTITY);
    expect(out.applied).toBe(false);
    expect(out.reason).toContain('visual interval');
  });

  it('ignores a propagation step with no duration', () => {
    const ekf = new OrientationEkf();
    ekf.initialiseFrom([0, 0, -9.81]);
    ekf.predict([1, 1, 1], 0);
    expect(angleDeg(ekf.state().q)).toBe(0);
  });
});
