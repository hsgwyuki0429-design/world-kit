/**
 * Phase 6, driven end to end in Node — and the one test the phase is built around.
 *
 * `PoseStage` is the exact code the tracking worker runs on a Phase 6 frame. These tests drive it
 * over synthetic scenes whose camera motion is known by construction, fold the results into the
 * same `PoseSession` the app uses, and evaluate the same `Phase6Tests` suite the screen and the
 * evidence read.
 *
 * ## The stage that returns a constant pose
 *
 * It has a valid rotation matrix. Its translation is a unit vector. It is *perfectly* temporally
 * stable — more stable than a working solver. Its cheirality counts can be whatever looks best.
 * v3 §67's pass condition for this phase is one line and it names exactly this failure:
 *
 * > PASS条件：Poseが計算結果により変化。
 *
 * POSE-005 is what makes that decidable: the harness turns the camera by a known amount, in
 * image space, and hands the set over unmarked. A constant pose moves by 0.00° and fails; a
 * solver returning noise moves a lot on the *control* too, and fails there.
 */

import { describe, expect, it } from 'vitest';
import { CameraState } from '../../src/capture/CameraSource';
import { Verdict } from '../../src/core/types';
import { Rng } from '../../src/core/Rng';
import { SceneTexture } from '../../src/tracking/featureTypes';
import { apply3x3, normalise3 } from '../../src/geometry/linalg';
import { intrinsicsFor, projectRay } from '../../src/geometry/intrinsics';
import type { Intrinsics } from '../../src/geometry/intrinsics';
import { fromAxisAngle, toAxisAngle, toQuaternion } from '../../src/geometry/rotation';
import { PoseState, SCALE_LOCAL_UNITS } from '../../src/geometry/pose';
import { GeometricModel } from '../../src/geometry/twoView';
import type { Correspondence } from '../../src/geometry/twoView';
import { verifyCorrespondences, VerificationState } from '../../src/geometry/verify';
import { PoseStage, INJECTED_ROTATION_DEG } from '../../src/tracking/PoseStage';
import { PoseSession } from '../../src/tracking/PoseSession';
import { runPhase6Tests } from '../../src/testkit/Phase6Tests';
import type { VerificationOutcome } from '../../src/tracking/VerificationStage';
import type {
  PoseReport,
  TrackingResult,
  VerificationReport,
} from '../../src/tracking/trackingMessages';

const W = 1280;
const H = 720;
const K = intrinsicsFor(W, H) as Intrinsics;

/* -------------------------------------------------------------------------- */
/* Synthetic scenes, with the camera motion known by construction              */
/* -------------------------------------------------------------------------- */

function worldPoints(count: number, seed: number, planeZ?: number): number[][] {
  const rng = new Rng(seed);
  const out: number[][] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 60) {
    const z = planeZ ?? 3 + rng.next() * 6;
    const X = [(rng.next() - 0.5) * 4.5, (rng.next() - 0.5) * 3, z];
    const a = projectRay(K, X);
    if (!a || a.x < 20 || a.x > W - 20 || a.y < 20 || a.y > H - 20) continue;
    out.push(X);
  }
  return out;
}

function project(world: readonly number[][], r: readonly number[], t: readonly number[]): Correspondence[] {
  const out: Correspondence[] = [];
  for (const X of world) {
    const a = projectRay(K, X);
    const xc = apply3x3(r, X);
    const b = projectRay(K, [
      (xc[0] ?? 0) + (t[0] ?? 0),
      (xc[1] ?? 0) + (t[1] ?? 0),
      (xc[2] ?? 0) + (t[2] ?? 0),
    ]);
    if (!a || !b) continue;
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return out;
}

function outcomeFor(points: readonly Correspondence[], seed: number): VerificationOutcome {
  const result = verifyCorrespondences(points, seed);
  const report: VerificationReport = {
    frames: 1,
    correspondences: points.length,
    anchorAge: 10,
    reAnchored: false,
    reAnchorReason: '',
    state: result.state,
    stateReason: result.reason,
    goodBlockedBy: result.goodBlockedBy,
    baselinePx: result.baselinePx,
    model: result.model,
    inliers: result.inlierCount,
    outliers: result.outliers.length,
    inlierRatio: result.inlierRatio,
    fundamentalInliers: result.fundamentalInliers,
    homographyInliers: result.homographyInliers,
    planar: result.planar,
    spreadPx: result.spreadPx,
    degenerate: result.degenerate,
    meanErrorPx: result.meanErrorPx,
    iterations: result.iterations,
    terminatedEarly: result.terminatedEarly,
    verifyMs: 1,
    seed,
    injection: null,
  };
  return { report, result, correspondences: points };
}

function frameFor(v: VerificationReport, pose: PoseReport, reAnchored: boolean): TrackingResult {
  return {
    kind: 'phase3',
    detected: true,
    count: 200,
    detectMs: 1,
    detectWidth: W / 2,
    detectHeight: H / 2,
    detectLevel: 1,
    meanGradient: 12,
    texture: SceneTexture.RICH,
    maxCornerStrength: 1000,
    candidateCount: 300,
    occupiedCells: 40,
    maxCellShare: 0.1,
    quota: 17,
    state: 'TRACKING_GOOD',
    contrast: null,
    gridComparison: null,
    refill: null,
    recordSamples: [],
    level0Calibration: null,
    overlay: null,
    flow: null,
    flowAge: null,
    verification: { ...v, reAnchored },
    pose,
    keyframe: null,
  };
}

/** A pose stage, real or fake, over one run of frames. */
type Solver = (outcome: VerificationOutcome, wantInjection: boolean, frame: number) => PoseReport;

interface RunOptions {
  /** Degrees of camera rotation per frame away from the anchor. */
  readonly rotationPerFrame?: number;
  readonly axis?: number[];
  /** Camera translation per frame, in scene units. */
  readonly translationPerFrame?: number[];
  readonly frames?: number;
  readonly planeZ?: number;
  readonly seed?: number;
  /** Feed the session gyroscope samples consistent with the camera's actual rotation. */
  readonly gyro?: boolean;
  /** Deliberately mis-report the gyroscope, to show POSE-002 can fail. */
  readonly gyroScale?: number;
}

interface RunOutcome {
  readonly stats: ReturnType<PoseSession['stats']>;
  readonly results: ReturnType<typeof runPhase6Tests>;
  readonly reports: PoseReport[];
}

const FRAME_MS = 33;

function run(solver: Solver, o: RunOptions = {}): RunOutcome {
  const {
    rotationPerFrame = 0.35,
    axis = [0, 1, 0],
    translationPerFrame = [0.06, 0.006, 0.004],
    frames = 40,
    planeZ,
    seed = 0xa11ce,
    gyro = false,
    gyroScale = 1,
  } = o;
  const world = worldPoints(120, seed, planeZ);
  const session = new PoseSession();
  const reports: PoseReport[] = [];
  let now = 1000;

  if (!gyro) session.noteGyroUnavailable('no devicemotion in this run');

  for (let i = 1; i <= frames; i++) {
    const deg = rotationPerFrame * i;
    const r = fromAxisAngle(axis, deg);
    const t = [
      (translationPerFrame[0] ?? 0) * i,
      (translationPerFrame[1] ?? 0) * i,
      (translationPerFrame[2] ?? 0) * i,
    ];
    const points = project(world, r, t);
    const outcome = outcomeFor(points, (seed ^ (i * 2654435761)) >>> 0);
    const pose = solver(outcome, i % 6 === 0, i);
    reports.push(pose);

    if (gyro) {
      // Samples at 60 Hz whose angular velocity integrates to the frame's own rotation. The
      // solver never sees these; they exist only to be compared against what it produced.
      const unit = normalise3(axis) ?? [0, 1, 0];
      const rate = ((rotationPerFrame * gyroScale) / (FRAME_MS / 1000)) as number;
      for (let k = 0; k < 2; k++) {
        session.noteGyro({
          at: now + (k * FRAME_MS) / 2,
          x: (unit[0] ?? 0) * rate,
          y: (unit[1] ?? 0) * rate,
          z: (unit[2] ?? 0) * rate,
        });
      }
    }
    session.record(frameFor(outcome.report, pose, i === 1), now);
    now += FRAME_MS;
  }

  const stats = session.stats(true);
  const results = runPhase6Tests({
    cameraState: CameraState.LIVE,
    pipelineEverStarted: true,
    poseEverRan: true,
    stats,
    verifyMs: 1.5,
  });
  return { stats, results, reports };
}

function realSolver(): Solver {
  const stage = new PoseStage(0x1234_5678);
  return (outcome, wantInjection) =>
    stage.process({
      verification: outcome,
      width: W,
      height: H,
      trackedFeatures: 200,
      wantInjection,
    });
}

/**
 * A stage that returns the same pose on every frame.
 *
 * Shaped exactly like the real report so nothing downstream can tell by the shape, and generous
 * everywhere it can be: a full cheirality sweep, a tiny reprojection error, a perfect
 * confidence. This is what "not recovering a pose" looks like.
 */
function constantPose(): Solver {
  const rotation = fromAxisAngle([0, 1, 0], 4);
  const aa = toAxisAngle(rotation);
  const direction = normalise3([1, 0.1, 0.06]) as number[];
  return (outcome, wantInjection) => {
    const n = outcome.result.inlierCount;
    return {
      frames: 1,
      state: PoseState.POSE,
      stateReason: 'a pose, unconditionally',
      source: outcome.result.model ?? GeometricModel.FUNDAMENTAL,
      rotationDeg: aa.angleDeg,
      axis: aa.axis,
      quaternion: toQuaternion(rotation),
      translation: direction,
      scale: SCALE_LOCAL_UNITS,
      planeNormal: null,
      intrinsics: {
        fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, width: W, height: H,
        estimated: true, assumedFovDeg: K.assumedFovDeg,
      },
      cheirality: [
        { candidate: 0, inFront: n, rotationDeg: aa.angleDeg },
        { candidate: 1, inFront: 0, rotationDeg: aa.angleDeg },
        { candidate: 2, inFront: 0, rotationDeg: 180 },
        { candidate: 3, inFront: 0, rotationDeg: 180 },
      ],
      chosen: 0,
      unseparatedCandidates: 1,
      ambiguous: false,
      pointsInFront: n,
      correspondences: n,
      reprojectionErrorPx: 0.12,
      rotationOnlyResidualPx: 30,
      rotationJumpDeg: 0,
      planar: outcome.result.planar,
      confidence: 1,
      rotationConfidence: 1,
      translationConfidence: 1,
      confidenceTerms: [{ name: 'inlierRatio', value: 1, note: 'perfect' }],
      confidenceWithheld: [],
      sensitivity: { focalFactor: 0.2, rotationDeg: 0, translationDeg: 0 },
      poseMs: 0.4,
      // The injection is *run* — the fake is not refusing to be measured, it simply returns the
      // same pose for the turned set as for the original, which is what a constant does.
      injection: wantInjection
        ? {
            requestedDeg: INJECTED_ROTATION_DEG,
            recoveredDeg: 0,
            controlDeg: 0,
            axis: [0, 1, 0],
            inliersBefore: n,
            inliersAfter: n,
            planarBefore: outcome.result.planar,
            planarAfter: outcome.result.planar,
            controlInliers: n,
            controlPlanar: outcome.result.planar,
            seed: 1,
          }
        : null,
    };
  };
}

const verdictOf = (rs: RunOutcome['results'], id: string): Verdict =>
  rs.find((r) => r.spec.id === id)?.verdict ?? Verdict.PENDING;
const reasonOf = (rs: RunOutcome['results'], id: string): string =>
  rs.find((r) => r.spec.id === id)?.reason ?? '';
const observedOf = (rs: RunOutcome['results'], id: string): string =>
  rs.find((r) => r.spec.id === id)?.observed ?? '';

/* -------------------------------------------------------------------------- */

describe('a working solver on a scene with depth', () => {
  const out = run(realSolver(), { frames: 66 });

  it('recovers a full pose on frames with parallax', () => {
    expect(out.stats.posedFrames).toBeGreaterThanOrEqual(15);
    expect(verdictOf(out.results, 'POSE-001')).toBe(Verdict.PASS);
  });

  it('places the correspondences in front of both cameras', () => {
    expect(out.stats.medianCheiralityFraction).toBeGreaterThan(0.95);
  });

  it('reports a reprojection error inside §33’s 2 px', () => {
    expect(out.stats.medianReprojectionPx).toBeGreaterThanOrEqual(0);
    expect(out.stats.medianReprojectionPx).toBeLessThan(2);
  });

  it('follows a rotation the harness injected and never disclosed — the gate', () => {
    expect(out.stats.injectionSamples).toBeGreaterThanOrEqual(10);
    expect(out.stats.medianInjectedDeg).toBeCloseTo(INJECTED_ROTATION_DEG, 0);
    expect(out.stats.medianControlDeg).toBeLessThan(1.5);
  });

  it('keeps the inlier count and the planar flag across the injection', () => {
    // The exact epipolar geometry maps exactly; the pixel threshold does not, so the bar is
    // the plan's tenth with the control's own drift reported beside it.
    expect(out.stats.medianInjectedInlierDrift).toBeLessThanOrEqual(0.1);
    expect(out.stats.injectionPlanarFlips / out.stats.injectionSamples).toBeLessThanOrEqual(0.1);
  });

  it('claims no scale, and marks the intrinsics estimated', () => {
    expect(out.stats.scale).toBe('LOCAL_UNITS');
    expect(out.stats.scaleViolations).toBe(0);
    expect(out.stats.intrinsics?.estimated).toBe(true);
    expect(out.stats.intrinsicsUnmarked).toBe(0);
    expect(verdictOf(out.results, 'POSE-007')).toBe(Verdict.PASS);
  });

  it('reports a state that follows from its own inputs on every frame', () => {
    expect(out.stats.stateMismatches).toBe(0);
  });

  it('measures what the focal-length assumption is holding up', () => {
    // The point of reporting it: rotation should barely move under ±20 % of `f`, translation
    // direction should move more. Both are measured rather than assumed here.
    expect(out.stats.medianSensitivityRotationDeg).toBeGreaterThanOrEqual(0);
    expect(out.stats.medianSensitivityTranslationDeg).toBeGreaterThanOrEqual(0);
  });

  it('withholds v3 §19’s IMU term by name rather than silently', () => {
    expect(out.stats.confidenceWithheld.join(' ')).toContain('IMUConsistency');
  });
});

describe('a stage that returns the same pose on every frame', () => {
  // 66 frames rather than 40: the injection runs on every sixth, and POSE-005 declines to be
  // decided on fewer than ten samples. A gate that reported PENDING here would be reporting
  // "not yet" about a stage it had already seen sixty frames of.
  const out = run(constantPose(), { frames: 66 });

  it('looks perfect on everything computed from its own output', () => {
    expect(out.stats.medianCheiralityFraction).toBe(1);
    expect(out.stats.medianReprojectionPx).toBeLessThan(2);
    expect(out.stats.medianConfidence).toBe(1);
    expect(out.stats.posedFrames).toBeGreaterThanOrEqual(15);
  });

  it('FAILS POSE-005, and the reason names the rotation it did not follow', () => {
    expect(verdictOf(out.results, 'POSE-005')).toBe(Verdict.FAIL);
    expect(reasonOf(out.results, 'POSE-005')).toContain(`${INJECTED_ROTATION_DEG}°`);
    expect(out.stats.medianInjectedDeg).toBe(0);
  });

  it('PASSES POSE-001, which is exactly why POSE-005 exists', () => {
    // Worth asserting rather than merely allowing. Every criterion POSE-001 can apply is
    // satisfied by a constant: the cheirality counts are whatever the fake says, the
    // reprojection error is whatever it says, and the direction's spread of 0° is what a real
    // solver reports on a straight-line motion too. The plan's amendment records the measurement.
    expect(verdictOf(out.results, 'POSE-001')).toBe(Verdict.PASS);
    expect(out.stats.translationSpreadDeg).toBe(0);
  });

  it('and so the phase as a whole does not pass, on POSE-005 alone', () => {
    const failed = out.results.filter((r) => r.spec.required && r.verdict === Verdict.FAIL);
    expect(failed.map((r) => r.spec.id)).toEqual(['POSE-005']);
  });
});

describe('POSE-002 — against the gyroscope', () => {
  it('agrees when the camera really turned by what the gyroscope says', () => {
    const out = run(realSolver(), { gyro: true, rotationPerFrame: 0.6, frames: 45 });
    expect(out.stats.gyroAvailable).toBe(true);
    expect(out.stats.rotationSamples).toBeGreaterThanOrEqual(15);
    expect(verdictOf(out.results, 'POSE-002')).toBe(Verdict.PASS);
    expect(out.stats.medianRotationDisagreementDeg).toBeLessThan(3);
  });

  it('reports PENDING with the reason when there is no gyroscope', () => {
    const out = run(realSolver(), { gyro: false });
    expect(verdictOf(out.results, 'POSE-002')).toBe(Verdict.PENDING);
    // The reason is the platform's own, which is more use than a restatement of why it matters.
    expect(reasonOf(out.results, 'POSE-002')).toContain('no devicemotion');
  });

  it('catches a constant rotation while the gyroscope reports a turn', () => {
    const out = run(constantPose(), { gyro: true, rotationPerFrame: 0.6, frames: 45 });
    expect(verdictOf(out.results, 'POSE-002')).toBe(Verdict.FAIL);
    expect(observedOf(out.results, 'POSE-002')).toContain('disagreement');
  });

  it('does not count an agreement between two zeros', () => {
    // A phone held still: the gyroscope says 0° and a constant identity rotation says 0°. That
    // is not evidence of anything, and POSE-002 declines to be decided on it.
    const out = run(realSolver(), { gyro: true, rotationPerFrame: 0, frames: 40 });
    expect(out.stats.rotationSamples).toBe(0);
    expect(verdictOf(out.results, 'POSE-002')).toBe(Verdict.PENDING);
  });
});

describe('a camera that only turned — POSE-004', () => {
  const out = run(realSolver(), {
    rotationPerFrame: 0.5,
    translationPerFrame: [0, 0, 0],
    frames: 40,
  });

  it('recovers the rotation and names no translation', () => {
    expect(out.stats.lowParallaxFrames).toBeGreaterThanOrEqual(15);
    expect(out.stats.lowParallaxWithTranslation).toBe(0);
    expect(out.stats.stateFrames[PoseState.ROTATION_ONLY] ?? 0).toBeGreaterThan(0);
  });

  it('passes POSE-004 and does not claim a full pose', () => {
    expect(verdictOf(out.results, 'POSE-004')).toBe(Verdict.PASS);
    expect(out.stats.posedFrames).toBe(0);
  });

  it('still carries LOCAL_UNITS', () => {
    expect(out.stats.scaleViolations).toBe(0);
  });
});

describe('a planar scene — v3 §16', () => {
  const out = run(realSolver(), { planeZ: 5, rotationPerFrame: 0.2, frames: 40 });

  it('takes its pose from the homography, never from an Essential matrix', () => {
    expect(out.stats.planarPosedFrames + out.stats.lowParallaxFrames).toBeGreaterThan(0);
    expect(out.stats.planarFromEssential).toBe(0);
  });

  it('lowers translation confidence where cheirality could not separate the candidates', () => {
    // The penalty is counted, not chosen: a homography decomposition leaves a genuine two-fold
    // ambiguity, so the translation is one of `k` equally supported answers and the term is 1/k.
    const withPenalty = out.reports.filter((r) => r.unseparatedCandidates > 1);
    for (const r of withPenalty) {
      expect(r.translationConfidence).toBeLessThanOrEqual(r.rotationConfidence);
    }
  });
});

describe('a frame Phase 5 declined', () => {
  it('gets no pose at all — not even a rotation', () => {
    const stage = new PoseStage();
    // Four correspondences with no baseline: Phase 5 refuses, so Phase 6 must too.
    const points: Correspondence[] = [
      { ax: 10, ay: 10, bx: 10, by: 10 },
      { ax: 20, ay: 30, bx: 20, by: 30 },
      { ax: 40, ay: 15, bx: 40, by: 15 },
      { ax: 60, ay: 50, bx: 60, by: 50 },
    ];
    const outcome = outcomeFor(points, 7);
    expect(outcome.result.state).toBe(VerificationState.UNVERIFIED);
    const pose = stage.process({
      verification: outcome,
      width: W,
      height: H,
      trackedFeatures: 4,
      wantInjection: false,
    });
    expect(pose.state).toBe(PoseState.NO_POSE);
    expect(pose.rotationDeg).toBe(-1);
    expect(pose.translation).toBeNull();
    expect(pose.scale).toBe('LOCAL_UNITS');
    expect(pose.intrinsics?.estimated).toBe(true);
  });
});

describe('intrinsics are per frame, not per session', () => {
  it('recomputes K when the frame geometry changes (§H.0)', () => {
    const stage = new PoseStage();
    const world = worldPoints(120, 0xbeef);
    const points = project(world, fromAxisAngle([0, 1, 0], 3), [0.4, 0.03, 0.02]);
    const outcome = outcomeFor(points, 11);
    const landscape = stage.process({
      verification: outcome, width: 1280, height: 720, trackedFeatures: 100, wantInjection: false,
    });
    const portrait = stage.process({
      verification: outcome, width: 720, height: 1280, trackedFeatures: 100, wantInjection: false,
    });
    // The long edge is the same, so `f` is; the principal point is not, and that is the point.
    expect(landscape.intrinsics?.cx).not.toBe(portrait.intrinsics?.cx);
    expect(landscape.intrinsics?.cy).not.toBe(portrait.intrinsics?.cy);
    expect(landscape.intrinsics?.estimated).toBe(true);
  });
});


/**
 * The defect the device found: a rate that cannot be a rate.
 *
 * `PoseSession` bounds what it keeps (§56), and POSE-002's agreement rate was a counter that
 * kept climbing divided by an array that stopped at 400. The device run of 2026-08-23 reported
 * **232.3% agreeing** — and POSE-002's "at least 60% of individual frames agree" criterion
 * passed on it *without being applied*, because an inflated number clears a floor trivially.
 *
 * `FlowSession` never had this: FLOW-002 counts its agreements out of the same trimmed window it
 * divides by. Phase 6 now does the same, so the mismatch is impossible rather than fixed — and
 * the test below drives the session past its own bound, which is the only way to see it.
 */
describe('the agreement rate stays a rate past the session’s bound', () => {
  /** Degrees the camera turns per frame, and how often the verification anchor is re-taken. */
  const DEG_PER_FRAME = 1.5;
  const ANCHOR_EVERY = 5;
  const STEP_MS = 40;

  function comparisonRun(frames: number, agreeEvery: number): ReturnType<PoseSession['stats']> {
    const session = new PoseSession();
    let now = 1000;
    for (let i = 1; i <= frames; i++) {
      // A gyroscope turning at a constant rate, and an anchor re-taken every few frames — which
      // is what the real system does, and what bounds the interval the two are compared over.
      // Without the re-anchor the gyroscope integrates from the first frame forever and nothing
      // agrees with anything; that was this fixture's own first bug.
      const reAnchored = i % ANCHOR_EVERY === 1;
      for (let k = 0; k < 4; k++) {
        session.noteGyro({ at: now + k * 9, x: 0, y: DEG_PER_FRAME / (STEP_MS / 1000), z: 0 });
      }
      const sinceAnchor = ((i - 1) % ANCHOR_EVERY) * DEG_PER_FRAME;
      const rotation = fromAxisAngle([0, 1, 0], sinceAnchor);
      const aa = toAxisAngle(rotation);
      const agrees = i % agreeEvery === 0;
      const report: PoseReport = {
        frames: i,
        state: PoseState.POSE,
        stateReason: '',
        source: GeometricModel.FUNDAMENTAL,
        rotationDeg: agrees ? aa.angleDeg : aa.angleDeg + 40,
        axis: aa.axis,
        quaternion: toQuaternion(rotation),
        translation: [1, 0, 0],
        scale: SCALE_LOCAL_UNITS,
        planeNormal: null,
        intrinsics: {
          fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy, width: W, height: H,
          estimated: true, assumedFovDeg: K.assumedFovDeg,
        },
        cheirality: [],
        chosen: 0,
        unseparatedCandidates: 1,
        ambiguous: false,
        pointsInFront: 50,
        correspondences: 50,
        reprojectionErrorPx: 0.5,
        rotationOnlyResidualPx: 30,
        rotationJumpDeg: 0,
        planar: false,
        confidence: 1,
        rotationConfidence: 1,
        translationConfidence: 1,
        confidenceTerms: [],
        confidenceWithheld: [],
        sensitivity: null,
        poseMs: 0.3,
        injection: null,
      };
      const v: VerificationReport = {
        ...outcomeFor([{ ax: 1, ay: 1, bx: 2, by: 2 }], 1).report,
        reAnchored,
      };
      session.record(frameFor(v, report, reAnchored), now);
      now += STEP_MS;
    }
    return session.stats(true);
  }

  it('never exceeds 1, however many comparisons the run made', () => {
    // Well past the 400-frame window — the shape the device hit at 929 comparisons.
    const stats = comparisonRun(2000, 1);
    expect(stats.rotationComparisons).toBeGreaterThan(stats.rotationSamples);
    expect(stats.rotationAgreementRate).toBeLessThanOrEqual(1);
    expect(stats.rotationAgreementRate).toBe(1);
  });

  it('reports the window it was computed over beside the total', () => {
    const stats = comparisonRun(2000, 1);
    expect(stats.rotationSamples).toBe(400);
    expect(stats.rotationComparisons).toBeGreaterThan(400);
  });

  it('still measures disagreement rather than reporting everything as agreed', () => {
    // Every second frame agrees; the rest miss by 40°, far outside the tolerance. The exact
    // fraction depends on which frames clear MIN_COMPARABLE_ROTATION_DEG, so the assertion is
    // that it lands strictly between the two extremes rather than at either.
    const stats = comparisonRun(2000, 2);
    expect(stats.rotationAgreementRate).toBeGreaterThan(0.05);
    expect(stats.rotationAgreementRate).toBeLessThan(0.95);
  });

  it('and POSE-002 refuses a rate that is not a rate, rather than passing on it', () => {
    // The second lock: on the reading, not on the arithmetic. A criterion satisfied by an
    // impossible number is not a test.
    const stats = comparisonRun(2000, 1);
    const results = runPhase6Tests({
      cameraState: CameraState.LIVE,
      pipelineEverStarted: true,
      poseEverRan: true,
      stats: { ...stats, rotationAgreementRate: 2.3225 },
      verifyMs: 1,
    });
    expect(verdictOf(results, 'POSE-002')).toBe(Verdict.FAIL);
    expect(reasonOf(results, 'POSE-002')).toContain('not a rate');
  });
});
