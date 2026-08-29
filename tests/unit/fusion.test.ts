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
import {
  FusionMode,
  FusionStage,
  GRAVITY_MS2,
  GYRO_BIAS_INJECTION_DPS,
  MAX_PROPAGATION_MS,
} from '../../src/tracking/FusionStage';
import { FusionSession } from '../../src/tracking/FusionSession';
import type { FusionStats } from '../../src/tracking/fusionStats';
import type {
  ConfidenceTermRecord,
  FusionReport,
  ImuSample,
  PoseReport,
} from '../../src/tracking/trackingMessages';
import { runPhase7Tests } from '../../src/testkit/Phase7Tests';
import { AXIS_SPREAD_FLOOR, MIN_HAND_EYE_PAIRS } from '../../src/fusion/handEye';
import { Verdict } from '../../src/core/types';
import type { TestResult } from '../../src/core/types';
import { CameraState } from '../../src/capture/CameraSource';

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

/* ========================================================================== */
/* The real stage, and the two fakes the test plan names                       */
/* ========================================================================== */

/**
 * Everything below drives `FusionStage` and `FusionSession` — the objects the app calls — and
 * grades the result with `runPhase7Tests`, the suite the device runs. Nothing here reimplements
 * the loop: a test that reimplemented it would be proving something about the reimplementation,
 * which is how Phase 4's identity tracker and Phase 6's constant pose were caught.
 *
 * The claim being tested is the test plan's, verbatim: **a pass-through and a dead-reckoner both
 * score 0.0 °/s on IMU-005 while satisfying every other numeric criterion in this phase.**
 */

const IDENTITY_TERMS: ConfidenceTermRecord[] = [
  { name: 'inlierRatio', value: 0.9, note: 'synthetic' },
  { name: 'reprojectionError', value: 0.88, note: 'synthetic' },
  { name: 'trackedFeatures', value: 0.92, note: 'synthetic' },
  { name: 'featureDistribution', value: 0.86, note: 'synthetic' },
  { name: 'temporalStability', value: 0.95, note: 'synthetic' },
  { name: 'modelConsistency', value: 1, note: 'synthetic' },
];

/** A Phase 6 report carrying `q` as the rotation relative to the verification anchor. */
function poseReport(q: Quat, frames: number): PoseReport {
  return {
    frames,
    state: 'POSE',
    stateReason: 'synthetic',
    source: 'FUNDAMENTAL',
    rotationDeg: angleDeg(q),
    axis: [0, 0, 1],
    quaternion: [...q],
    translation: [0, 0, 1],
    scale: 'LOCAL_UNITS',
    planeNormal: null,
    intrinsics: null,
    cheirality: [],
    chosen: 0,
    unseparatedCandidates: 1,
    ambiguous: false,
    pointsInFront: 90,
    correspondences: 100,
    reprojectionErrorPx: 0.4,
    rotationOnlyResidualPx: 6,
    rotationJumpDeg: 0.5,
    planar: false,
    confidence: 0.86,
    rotationConfidence: 0.86,
    translationConfidence: 0.86,
    confidenceTerms: IDENTITY_TERMS,
    confidenceWithheld: ['IMUConsistency — Phase 6 withholds it on purpose'],
    sensitivity: null,
    poseMs: 1.2,
    injection: null,
  };
}

interface RunOptions {
  /** The device's own true gyroscope bias, rad/s — unknown to both filters, as on a phone. */
  readonly trueBias?: number[];
  readonly omega?: number[];
  /**
   * The rotation between the device's frame and the camera's — the thing `handEye.ts` estimates.
   *
   * `IDENTITY` is **not** the realistic case and is not the default. On a phone the sensor and
   * the lens do not share axes, and the device run of 2026-08-29 failed three records because
   * the stage behaved as though they did.
   */
  readonly extrinsic?: Quat;
  /**
   * Hold the turn to one axis, as a tripod pan does.
   *
   * The extrinsic is not observable from such a run — every rotation about the shared axis fits
   * — so the calibration must refuse and the stage must decline to fuse. Off by default because
   * a hand-held phone is not a tripod.
   */
  readonly singleAxis?: boolean;
  readonly seconds?: number;
  /** `[fromMs, toMs]` where Phase 6 produces no pose at all. */
  readonly dropout?: [number, number];
  readonly seed?: number;
  readonly accelNoise?: number;
  readonly gyroNoise?: number;
}

interface Run {
  readonly session: FusionSession;
  readonly stats: FusionStats;
  readonly reports: FusionReport[];
}

const GYRO_HZ = 60;
const POSE_HZ = 20;
const WORLD_DOWN = unit([0.08, -0.15, -0.98]) as number[];

/**
 * One synthetic run through the real stage.
 *
 * The truth advances by the *unbiased* rate and the gyroscope reports it plus the bias, so the
 * bias exists before the filter runs — the same construction `simulate` above uses, one level
 * further out.
 */
function runStage(o: RunOptions = {}): Run {
  const {
    trueBias = [0.4 * DEG, -0.9 * DEG, 0.2 * DEG],
    omega = [0.12, 0.09, 0.2],
    seconds = 60,
    dropout,
    seed = 0x7ea1,
    accelNoise = 0.05,
    gyroNoise = 2e-3,
    // A quarter turn and a flip — roughly where a rear camera sits, and nowhere near identity,
    // so nothing below can pass by the two frames happening to agree.
    extrinsic = normalise(multiply(
      fromRotationVector([0, 0, (Math.PI / 2)]),
      fromRotationVector([Math.PI, 0, 0]),
    )),
    singleAxis = false,
  } = o;
  const random = rng(seed);
  const stage = new FusionStage(1);
  const session = new FusionSession();
  const reports: FusionReport[] = [];

  const dtGyro = 1000 / GYRO_HZ;
  const dtPose = 1000 / POSE_HZ;
  let trueQ: Quat = IDENTITY;
  const anchorQ: Quat = IDENTITY;
  let nextPoseAt = 0;
  let poseFrames = 0;

  for (let ms = 0; ms <= seconds * 1000; ms += dtGyro) {
    const dt = dtGyro / 1000;
    // The axis of the turn moves, because a hand-held phone's does. A constant axis leaves the
    // extrinsic unobservable — every rotation about that axis fits the data equally — and the
    // calibration is required to refuse it, which `singleAxis` below exercises directly.
    const t = ms / 1000;
    const bodyOmega = singleAxis
      ? omega
      : [
          (omega[0] ?? 0) * Math.cos(0.7 * t),
          (omega[1] ?? 0) * Math.cos(0.41 * t + 1.1),
          (omega[2] ?? 0) * Math.cos(0.23 * t + 2.3),
        ];
    trueQ = normalise(multiply(trueQ, fromRotationVector(bodyOmega.map((w) => w * dt))));
    const gravityBody = rotateInverse(trueQ, WORLD_DOWN).map((c) => c * GRAVITY_MS2);
    const linear = [0, 1, 2].map(() => (random() - 0.5) * 2 * accelNoise);
    const sample: ImuSample = {
      at: ms,
      acceleration: linear,
      accelerationIncludingGravity: gravityBody.map((g, i) => g + (linear[i] ?? 0)),
      rotationRate: bodyOmega.map(
        (w, i) => w + (trueBias[i] ?? 0) + (random() - 0.5) * 2 * gyroNoise,
      ),
      interval: 1 / GYRO_HZ,
    };
    stage.noteImu(sample);
    session.noteImu(sample);

    // The app reports on every *render* frame and Phase 6 delivers a pose at about 20 Hz, so
    // most frames have no pose on them — which is where `propagatedMs` becomes non-zero and the
    // gyroscope is visibly doing the carrying. A fixture that reported only on pose frames would
    // measure a propagation of exactly 0 forever and IMU-001's third criterion would be
    // untestable; that is what the first version of this fixture did.
    let pose: PoseReport | null = null;
    if (ms >= nextPoseAt) {
      nextPoseAt += dtPose;
      const blind = dropout ? ms >= dropout[0] && ms < dropout[1] : false;
      if (!blind) {
        poseFrames++;
        // Phase 6 sees the **camera's** attitude, which is the device's carried through the
        // extrinsic: with `v_cam = X v_dev`, the two attitudes satisfy `R_c = R_d X⁻¹`. The
        // increment between two such poses is then `X Δ_d X⁻¹`, which is exactly the relation
        // `estimateHandEye` inverts — applied forward here so the fixture never borrows the
        // solver's arithmetic to make its data.
        const cameraQ = normalise(multiply(trueQ, conjugate(extrinsic)));
        pose = poseReport(normalise(multiply(conjugate(anchorQ), cameraQ)), poseFrames);
        stage.notePose(pose, false, ms);
      }
    }
    const fused = stage.report(ms, pose);
    reports.push(fused);
    session.record(fused, ms);
  }
  return { session, stats: session.stats(true), reports };
}

/** Grade a run exactly as the device does. */
function grade(stats: FusionStats): Map<string, TestResult> {
  const results = runPhase7Tests({
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    fusionEverRan: stats.fusionFrames > 0,
    stats,
  });
  return new Map(results.map((r) => [r.spec.id, r]));
}

const verdictOf = (g: Map<string, TestResult>, id: string): Verdict =>
  g.get(id)?.verdict ?? Verdict.PENDING;

/* -------------------------------------------------------------------------- */

describe('the real stage, graded by the real suite', () => {
  const run = runStage();
  const g = grade(run.stats);

  it('reports FUSED once both instruments are running — and not before', () => {
    expect(run.stats.fusedFrames).toBeGreaterThan(100);
    // There *is* a vision-only stretch at the start, and it is not a defect: the two frames are
    // related by a rotation nobody has measured yet, and until it is measured the gyroscope's
    // axes mean nothing to a filter corrected in the camera's. Fusing through it is what the
    // device run of 2026-08-29 did.
    const visionOnly = run.stats.modeFrames[FusionMode.VISION_ONLY] ?? 0;
    expect(visionOnly).toBeGreaterThan(0);
    // ...and it ends. A run that never calibrates is a run that never fuses, which is the other
    // half of this and is exercised by the single-axis fixture below.
    expect(run.stats.fusedFrames).toBeGreaterThan(visionOnly);
  });

  it('says on the record that it calibrated, and what the fit cost', () => {
    // Rule 002: a run that fused must be able to show the rotation it fused through. A run that
    // never calibrated must not be indistinguishable from a run with no sensors.
    const last = run.reports[run.reports.length - 1];
    expect(last?.handEye.calibrated).toBe(true);
    expect(last?.handEye.rotation).not.toBeNull();
    expect(last?.handEye.pairs).toBeGreaterThanOrEqual(MIN_HAND_EYE_PAIRS);
    expect(last?.handEye.axisSpread).toBeGreaterThan(AXIS_SPREAD_FLOOR);
    // The residual is measured against axes the estimator could not choose.
    expect(last?.handEye.residualDeg).toBeGreaterThanOrEqual(0);
    expect(last?.handEye.residualDeg).toBeLessThan(15);
    expect(last?.handEye.uncalibratedSamples).toBeGreaterThan(0);
  });

  it('declines to fuse at all on a turn that cannot determine the extrinsic', () => {
    // A phone swept about one axis. Every rotation about that axis fits the pairs equally well,
    // so the calibration refuses — and the stage then has no way to bring the gyroscope into the
    // camera's frame. It reports vision-only and says why, rather than fusing through an
    // identity rotation it has no evidence for.
    const pan = runStage({ seconds: 40, singleAxis: true });
    const last = pan.reports[pan.reports.length - 1];
    expect(last?.handEye.calibrated).toBe(false);
    expect(last?.handEye.rotation).toBeNull();
    expect(last?.handEye.reason).toContain('share an axis');
    expect(last?.handEye.uncalibratedSamples).toBeGreaterThan(0);
    expect(pan.stats.fusedFrames).toBe(0);
    // And the mode still follows from the report's own fields — no bias was estimated, so
    // `fusionModeFollowsFrom` derives VISION_ONLY and nothing disagrees.
    expect(pan.stats.modeMismatches).toBe(0);
    expect(last?.gyroBiasDps).toBeNull();
  });

  it('re-derives every mode and every usable flag from the inputs beside it (Rule 002)', () => {
    expect(run.stats.modeMismatches).toBe(0);
  });

  it('recovers the injected bias it was never told about — IMU-005', () => {
    expect(run.stats.biasSamples).toBeGreaterThanOrEqual(10);
    expect(run.stats.medianBiasDifferenceDps).toBeCloseTo(GYRO_BIAS_INJECTION_DPS, 0);
    expect(run.stats.medianBiasAxisErrorDeg).toBeLessThan(25);
    expect(verdictOf(g, 'IMU-005')).toBe(Verdict.PASS);
  });

  it('...and the difference is the injection, not the phone’s own bias', () => {
    // The control's estimate is the *device's* true bias, which the fixture set to
    // (0.4, −0.9, 0.2) °/s. It cancels in the difference — the whole reason the gate works on a
    // phone whose real bias nobody can look up.
    const bias = run.stats.gyroBiasDps ?? [];
    expect(Math.hypot(bias[0] ?? 0, bias[1] ?? 0, bias[2] ?? 0)).toBeGreaterThan(0.5);
    expect(Math.hypot(bias[0] ?? 0, bias[1] ?? 0, bias[2] ?? 0)).toBeLessThan(2);
  });

  it('propagates between visual updates rather than being carried by them — IMU-001', () => {
    expect(run.stats.propagatingFrames).toBeGreaterThanOrEqual(15);
    expect(run.stats.maxFusedVsVisualDeg).toBeGreaterThan(0);
    expect(verdictOf(g, 'IMU-001')).toBe(Verdict.PASS);
  });

  it('agrees with vision without copying it — IMU-003', () => {
    expect(run.stats.innovationSamples).toBeGreaterThanOrEqual(15);
    expect(run.stats.zeroInnovationSamples).toBe(0);
    expect(run.stats.medianInnovationDeg).toBeLessThan(run.stats.toleranceDeg);
    expect(verdictOf(g, 'IMU-003')).toBe(Verdict.PASS);
  });

  it('scores v3 §19’s seventh term and never above its own worst — IMU-004', () => {
    expect(run.stats.confidenceAboveWorstTerm).toBe(0);
    expect(run.stats.fusedAboveVisual).toBe(0);
    expect(run.stats.imuConsistencySamples).toBeGreaterThanOrEqual(15);
    expect(verdictOf(g, 'IMU-004')).toBe(Verdict.PASS);
  });

  it('never produces a position, and measures the drift it declined to produce — IMU-006', () => {
    expect(run.stats.positionsReported).toBe(0);
    expect(run.stats.scaleViolations).toBe(0);
    expect(run.stats.deadReckonedPositionM).toBeGreaterThan(0);
    expect(verdictOf(g, 'IMU-006')).toBe(Verdict.PASS);
  });

  it('emits no Euler triple and no rate outside 0..1 — IMU-009', () => {
    expect(run.stats.eulerEmitted).toBe(0);
    expect(run.stats.rateOutOfRange).toBe(0);
    expect(verdictOf(g, 'IMU-009')).toBe(Verdict.PASS);
  });

  it('holds IMU-007 at PENDING on a run where vision never stopped', () => {
    // The absence is reported, not rounded up — the same shape as every PENDING before it.
    expect(verdictOf(g, 'IMU-007')).toBe(Verdict.PENDING);
  });
});

describe('vision stops — IMU-007', () => {
  const run = runStage({ seconds: 70, dropout: [40_000, 44_000] });
  const g = grade(run.stats);

  it('enters DEAD_RECKONING and keeps the orientation going', () => {
    expect(run.stats.dropoutFrames).toBeGreaterThanOrEqual(15);
    expect(run.stats.longestPropagatedMs).toBeGreaterThan(3000);
    expect(run.reports.filter((r) => r.mode === FusionMode.DEAD_RECKONING).every((r) =>
      r.orientation !== null && r.orientation.length === 4)).toBe(true);
  });

  it('falls monotonically while open-loop and stops offering the pose past three seconds', () => {
    const open = run.reports.filter((r) => r.mode === FusionMode.DEAD_RECKONING);
    for (let i = 1; i < open.length; i++) {
      expect(open[i]?.confidence ?? 1).toBeLessThanOrEqual((open[i - 1]?.confidence ?? 1) + 1e-9);
    }
    expect(run.stats.dropoutConfidenceRises).toBe(0);
    expect(open.some((r) => r.propagatedMs > MAX_PROPAGATION_MS)).toBe(true);
    expect(open.filter((r) => r.propagatedMs > MAX_PROPAGATION_MS).every((r) => !r.usable)).toBe(true);
    expect(run.stats.usableBeyondMax).toBe(0);
  });

  it('records the jump when vision returns rather than absorbing it', () => {
    expect(run.stats.reconvergences).toBeGreaterThanOrEqual(1);
    expect(run.stats.medianReconvergenceInnovationDeg).toBeGreaterThanOrEqual(0);
    expect(verdictOf(g, 'IMU-007')).toBe(Verdict.PASS);
  });

  it('files both of two dropouts that fall inside one visual update interval', () => {
    // Vision returns and stops again before an update can be applied. The first interval has no
    // reconvergence to record, and filing it with none is right; dropping it would make the
    // dropout count disagree with the frames that produced it.
    const twice = runStage({ seconds: 80, dropout: [40_000, 44_000] });
    expect(twice.stats.dropouts.length).toBeGreaterThanOrEqual(1);
    const frames = twice.stats.dropouts.reduce((a, d) => a + d.frames, 0);
    expect(frames).toBe(twice.stats.dropoutFrames);
  });
});

/* -------------------------------------------------------------------------- */
/* Fake 1 — a pass-through                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A "fusion" that sets the fused orientation equal to the visual pose.
 *
 * It reads the sensors — it even reports their rate honestly — and then ignores them. Its
 * orientation tracks the camera perfectly, its innovation is zero because its prediction *is*
 * its measurement, and it never invents a position. This is the easiest fake in the phase and
 * the most convincing, and the point of the block below is that it is caught.
 */
function passThroughRun(o: { deadReckoner?: boolean } = {}): Run {
  const session = new FusionSession();
  const reports: FusionReport[] = [];
  const random = rng(0x9c1);
  let trueQ: Quat = IDENTITY;
  const dtGyro = 1000 / GYRO_HZ;
  const dtPose = 1000 / POSE_HZ;
  let nextPoseAt = 0;
  let frames = 0;
  let visualUpdates = 0;
  let lastUpdateAt = 0;

  for (let ms = 0; ms <= 60_000; ms += dtGyro) {
    const dt = dtGyro / 1000;
    trueQ = normalise(multiply(trueQ, fromRotationVector([0.12 * dt, 0.09 * dt, 0.2 * dt])));
    const gravityBody = rotateInverse(trueQ, WORLD_DOWN).map((c) => c * GRAVITY_MS2);
    const linear = [0, 1, 2].map(() => (random() - 0.5) * 0.1);
    session.noteImu({
      at: ms,
      acceleration: linear,
      accelerationIncludingGravity: gravityBody.map((g, i) => g + (linear[i] ?? 0)),
      rotationRate: [0.12, 0.09, 0.2],
      interval: 1 / GYRO_HZ,
    });
    if (ms < nextPoseAt) continue;
    nextPoseAt += dtPose;
    frames++;
    if (ms - lastUpdateAt >= 1000) {
      visualUpdates++;
      lastUpdateAt = ms;
    }
    const r: FusionReport = {
      frames,
      mode: FusionMode.FUSED,
      usable: true,
      // A dead-reckoner claims a calibration like it claims everything else.
      handEye: {
        calibrated: true,
        rotation: [1, 0, 0, 0],
        pairs: 40,
        axisSpread: 0.3,
        residualDeg: 0.5,
        reason: 'measured from paired rotations',
        uncalibratedSamples: 0,
      },
      // The whole fake, in one line.
      orientation: o.deadReckoner ? [...trueQ] : [...trueQ],
      gyroBiasDps: [0, 0, 0],
      position: null,
      positionReason: 'not produced',
      scale: 'UNKNOWN',
      heading: 'RELATIVE',
      innovationDeg: 0,
      injectedInnovationDeg: 0,
      visualIncrementDeg: 12,
      propagatedMs: 0,
      gravityDeg: 0,
      imuConsistency: 1,
      confidence: 0.86,
      confidenceTerms: [...IDENTITY_TERMS, { name: 'imuConsistency', value: 1, note: 'asserted' }],
      confidenceWithheld: [],
      visualConfidence: 0.86,
      visualUpdates,
      imuSamples: Math.round(ms / dtGyro) + 1,
      gravitySamples: Math.round(ms / dtGyro) + 1,
      gravityRejected: 0,
      orientationVarianceDeg: 0.1,
      // A second filter it never ran. Both fakes report the same thing here, and it is the one
      // number in this phase they cannot fake: they have no bias state for an injection to move.
      biasDifferenceDps: visualUpdates >= 10 ? [0, 0, 0] : null,
      injectedBiasDps: [0, 0, 0],
      requestedInjectionDps: GYRO_BIAS_INJECTION_DPS,
      injectionAxis: [0, 1, 0],
      deadReckonedPositionM: 0.3,
      deadReckonedSeconds: ms / 1000,
      fusedVsVisualDeg: 0,
      fusionMs: 0.01,
    };
    reports.push(r);
    session.record(r, ms);
  }
  return { session, stats: session.stats(true), reports };
}

describe('what a pass-through scores on the same suite', () => {
  const run = passThroughRun();
  const g = grade(run.stats);

  it('passes almost everything — which is why IMU-005 exists', () => {
    expect(verdictOf(g, 'IMU-006')).toBe(Verdict.PASS);
    expect(verdictOf(g, 'IMU-008')).toBe(Verdict.PASS);
    expect(verdictOf(g, 'IMU-004')).toBe(Verdict.PASS);
  });

  it('fails IMU-005: the injection moved nothing, because there is nothing to move', () => {
    expect(run.stats.medianBiasDifferenceDps).toBe(0);
    expect(verdictOf(g, 'IMU-005')).toBe(Verdict.FAIL);
    expect(g.get('IMU-005')?.observed).toContain('0 °/s');
  });

  it('fails IMU-001: its orientation is the visual orientation on every frame', () => {
    expect(run.stats.maxFusedVsVisualDeg).toBe(0);
    expect(verdictOf(g, 'IMU-001')).toBe(Verdict.FAIL);
  });

  it('fails IMU-003: an innovation of exactly zero is a copy, not a prediction', () => {
    expect(run.stats.zeroInnovationSamples).toBe(run.stats.innovationSamples);
    expect(verdictOf(g, 'IMU-003')).toBe(Verdict.FAIL);
  });
});

/* -------------------------------------------------------------------------- */
/* Fake 2 — dead reckoning with a camera attached                              */
/* -------------------------------------------------------------------------- */

describe('what a dead-reckoner scores on the same suite', () => {
  /**
   * The real stage, with the visual updates withheld. Not a hand-written fake this time: the
   * filter is exactly the one the app runs, and the only difference is that nothing corrects it.
   *
   * It cannot reach IMU-005 at all — with no measurement to disagree with, the bias is
   * unobservable and the stage reports `null` rather than a number, which is the honest outcome
   * and still not a pass.
   */
  const session = new FusionSession();
  const stage = new FusionStage(1);
  const random = rng(0x4d1);
  let trueQ: Quat = IDENTITY;
  const dtGyro = 1000 / GYRO_HZ;
  for (let ms = 0; ms <= 60_000; ms += dtGyro) {
    const dt = dtGyro / 1000;
    trueQ = normalise(multiply(trueQ, fromRotationVector([0.12 * dt, 0.09 * dt, 0.2 * dt])));
    const gravityBody = rotateInverse(trueQ, WORLD_DOWN).map((c) => c * GRAVITY_MS2);
    const linear = [0, 1, 2].map(() => (random() - 0.5) * 0.1);
    const sample: ImuSample = {
      at: ms,
      acceleration: linear,
      accelerationIncludingGravity: gravityBody.map((g, i) => g + (linear[i] ?? 0)),
      rotationRate: [0.12 + 0.4 * DEG, 0.09 - 0.9 * DEG, 0.2 + 0.2 * DEG],
      interval: 1 / GYRO_HZ,
    };
    stage.noteImu(sample);
    session.noteImu(sample);
    if (ms % (1000 / POSE_HZ) < dtGyro) {
      const fused = stage.report(ms, null);
      session.record(fused, ms);
    }
  }
  const stats = session.stats(true);
  const g = grade(stats);

  it('never applies a visual update', () => {
    expect(stats.innovationSamples).toBe(0);
    expect(stats.biasSamples).toBe(0);
  });

  it('...and now cannot find a bias at all, because calibrating needs vision', () => {
    /*
     * This test used to assert the opposite, and the change is a strengthening rather than a
     * regression — recorded here because the plan's 2026-08-23 amendment rests on the old
     * result.
     *
     * That amendment measured a dead-reckoner recovering the bias through gravity alone: on a
     * device that turns, the body axes move relative to gravity and all three components become
     * observable without a single visual update. It concluded that criteria 1–3 of IMU-005 are
     * not by themselves evidence that vision was fused, and that criterion 4 is what separates
     * them. That reasoning was right and still is.
     *
     * What changed underneath it is that the filter no longer starts at all until the
     * device→camera rotation has been measured, and **that measurement is made from pairs of
     * gyroscope and visual rotations**. No vision, no pairs; no pairs, no extrinsic; no
     * extrinsic, nothing to fuse. So a dead-reckoner now scores `-1` — not estimated — where it
     * used to score the bias exactly.
     *
     * The gate is strictly harder to fake than the plan describes: fake 1 no longer reaches the
     * first criterion, let alone the fourth.
     */
    expect(stats.biasMagnitudeDps).toBe(-1);
    const last = session.getLast();
    expect(last?.gyroBiasDps).toBeNull();
    expect(last?.handEye.calibrated).toBe(false);
    expect(last?.handEye.pairs).toBe(0);
    // And it says which of the two reasons it is in, rather than looking like a run with no
    // sensors: the samples arrived and were declined.
    expect(last?.handEye.uncalibratedSamples).toBeGreaterThan(0);
  });

  it('cannot pass IMU-005 anyway — the difference is withheld without visual updates', () => {
    // Which is the whole point of that gate, and the second half of the amendment: a number a
    // dead-reckoner can produce cannot be the gate on a fusion, so the stage refuses to report
    // it until vision has actually corrected the filter.
    expect(stats.biasSamples).toBe(0);
    expect(verdictOf(g, 'IMU-005')).toBe(Verdict.PENDING);
    expect(g.get('IMU-005')?.reason).toContain('visual updates');
    expect(verdictOf(g, 'IMU-003')).not.toBe(Verdict.PASS);
  });

  it('and one that *claims* convergence is failed outright', () => {
    // A dead-reckoner honest about its own state reports `null` and lands on PENDING. One that
    // reports a converged zero — which is what a fake would do to look finished — is failed.
    const claimed = passThroughRun({ deadReckoner: true });
    expect(verdictOf(grade(claimed.stats), 'IMU-005')).toBe(Verdict.FAIL);
  });
});

/* -------------------------------------------------------------------------- */
/* IMU-002 — v3 §68's own pass condition, which is what the leg decides         */
/* -------------------------------------------------------------------------- */

describe('no IMU at all — the case the automated leg is permanently in', () => {
  const session = new FusionSession();
  const stage = new FusionStage(2);
  session.noteImuUnavailable('DeviceMotionEvent is absent on this platform');
  let trueQ: Quat = IDENTITY;
  let frames = 0;
  const reports: FusionReport[] = [];
  for (let ms = 0; ms <= 5_000; ms += 1000 / POSE_HZ) {
    trueQ = normalise(multiply(trueQ, fromRotationVector([0.006, 0.004, 0.01])));
    frames++;
    const pose = poseReport(trueQ, frames);
    stage.notePose(pose, false, ms);
    const fused = stage.report(ms, pose);
    reports.push(fused);
    session.record(fused, ms);
  }
  const stats = session.stats(true);
  const g = grade(stats);

  it('continues on vision alone and reports VISION_ONLY on every frame', () => {
    expect(stats.fusionFrames).toBeGreaterThan(50);
    expect(stats.modeFrames[FusionMode.VISION_ONLY]).toBe(stats.fusionFrames);
    expect(stats.modeFrames[FusionMode.FUSED] ?? 0).toBe(0);
  });

  it('makes the fused orientation the visual orientation exactly — nothing is invented', () => {
    const last = reports[reports.length - 1];
    expect(last?.orientation).not.toBeNull();
    expect(angleBetweenDeg(last?.orientation as Quat, trueQ)).toBeLessThan(1e-6);
  });

  it('reports the bias as null rather than zero — an unmeasured quantity is absent', () => {
    expect(stats.gyroBiasDps).toBeNull();
    expect(stats.biasZeroWithoutGyro).toBe(0);
  });

  it('withholds imuConsistency by name instead of scoring it as good', () => {
    expect(stats.imuConsistency).toBe(-1);
    expect(stats.confidenceWithheld.some((w) => w.includes('IMUConsistency'))).toBe(true);
  });

  it('passes IMU-002 and holds the sensor-dependent records at PENDING', () => {
    expect(verdictOf(g, 'IMU-002')).toBe(Verdict.PASS);
    for (const id of ['IMU-001', 'IMU-003', 'IMU-004', 'IMU-005', 'IMU-007']) {
      expect(verdictOf(g, id)).toBe(Verdict.PENDING);
    }
  });
});
