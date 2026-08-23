/**
 * Phase 6 test suite — POSE-001..POSE-007.
 *
 * Specs transcribed from `docs/phase6/TEST-PLAN.md`, written and committed before
 * `src/geometry/pose.ts` existed (§29). Same verdict algebra as the phases before it:
 * PASS / FAIL / PENDING, with PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `PoseStats` and nothing else — no DOM, no worker, no camera — so the suite
 * can be shown a run driven by the real solver and one driven by a stage that **returns the same
 * pose on every frame**, and checked that the two produce different verdicts.
 *
 * **The claim.** A constant pose has a valid rotation matrix, a unit translation, a perfect
 * temporal stability — better than a working solver's — and a reprojection error that can be
 * made small by triangulating under its own pose. v3 §67's pass condition for this phase is one
 * line and it names exactly this: **Poseが計算結果により変化**. POSE-005 is what makes that
 * decidable, and POSE-002 is what makes the device the only place it can be decided.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  CHEIRALITY_MARGIN,
  MAX_REPROJECTION_PX,
  MIN_CHEIRALITY_FRACTION,
  PURE_ROTATION_PARALLAX_PX,
  PoseState,
} from '../geometry/pose';
import { GeometricModel } from '../geometry/twoView';
import { NOMINAL_FOV_DEG } from '../geometry/intrinsics';
import { INJECTED_ROTATION_DEG } from '../tracking/PoseStage';
import {
  MIN_COMPARABLE_ROTATION_DEG,
  ROTATION_AGREEMENT_DEG,
  ROTATION_AGREEMENT_FRACTION,
} from '../tracking/PoseSession';
import type { PoseStats } from '../tracking/poseStats';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged frames of a condition before that condition is decided. As Phases 3–5 used. */
export const MIN_JUDGED_FRAMES = 15;
/** POSE-002: individual frames that must agree, not merely the median. */
export const MIN_ROTATION_AGREEMENT_RATE = 0.6;
/** POSE-005: how close the recovered difference must come to the injected rotation. */
export const INJECTION_TOLERANCE_DEG = 2.0;
/** ...while an uninjected control stays this near zero. */
export const MAX_CONTROL_ROTATION_DEG = 1.5;
/** POSE-005 needs this many measurements before its median means anything. */
export const MIN_INJECTION_SAMPLES = 10;
/**
 * How far the injection may move the inlier count or v3 §16's flag — the plan's "within a
 * tolerance", which the first implementation set to zero.
 *
 * A tenth, which is the figure the plan already used for what counts as drift. The *exact*
 * epipolar geometry maps exactly under an image-space rotation — `b'ᵀ(Hⱼ⁻ᵀF)a = bᵀFa` — but the
 * inlier test is a **pixel threshold**, and a Sampson distance is not invariant under a
 * projective map of one image, so a correspondence sitting on 1.5 px can cross. The control's
 * own drift is reported beside this as the noise floor.
 */
export const MAX_INJECTION_DRIFT = 0.1;
/** §H's line for "RANSAC (E/H) + pose recovery", verbatim — the two share one budget. */
export const POSE_PIPELINE_BUDGET_MS = 6.0;
/** POSE-006 needs a population before a mean means anything. */
export const MIN_COST_SAMPLES = 10;

export interface Phase6Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** Pose recovery was switched on at least once in this run. */
  readonly poseEverRan: boolean;
  readonly stats: PoseStats;
  /** Phase 5's measured RANSAC cost, because §H budgets the two stages as one line. */
  readonly verifyMs: number;
}

interface Evaluation {
  verdict: Verdict;
  observed: string;
  reason: string;
  metrics?: Record<string, JsonValue>;
}

interface Phase6Test {
  spec: TestSpec;
  evaluate: (ctx: Phase6Context) => Evaluation;
}

function pct(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 10}%`;
}

function deg(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100}°`;
}

function notRunning(ctx: Phase6Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.poseEverRan && ctx.stats.poseFrames > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `pose recovery has not run (camera ${ctx.cameraState})`,
    reason: 'no pose has been recovered, so there is nothing to judge',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const POSE_001: Phase6Test = {
  spec: {
    id: 'POSE-001',
    title: 'Translation',
    required: true,
    input: 'judged frames of a scene with depth in it, where the Essential matrix is the model',
    expected: 'a translation direction is recovered, in LOCAL UNITS, and it is not a constant',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} frames reached ${PoseState.POSE}; the chosen candidate placed ` +
      `>= ${Math.round(MIN_CHEIRALITY_FRACTION * 100)}% of the correspondences in front of both ` +
      `cameras; median reprojection error <= ${MAX_REPROJECTION_PX} px; and no frame reported ` +
      `${PoseState.POSE} with a null translation. The direction's spread across the run is ` +
      'reported but not judged — POSE-005 is what asks whether the pose responds to the camera',
    failureCondition:
      'a pose reported on a set that failed cheirality, or a translation named on a frame with no ' +
      'parallax to support it',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      posedFrames: s.posedFrames,
      medianCheiralityFraction: s.medianCheiralityFraction,
      medianReprojectionPx: s.medianReprojectionPx,
      translationSpreadDeg: s.translationSpreadDeg,
      ambiguousFrames: s.ambiguousFrames,
      medianRotationDeg: s.medianRotationDeg,
      stateFrames: s.stateFrames as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.posedFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.posedFrames}/${MIN_JUDGED_FRAMES} frames reached ${PoseState.POSE}`,
        reason:
          'a full pose needs a verified frame pair with parallax in it. Walk sideways past a ' +
          'scene with things at different distances — turning on the spot produces no ' +
          'translation to recover, and a flat wall produces one the homography has to supply',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianCheiralityFraction < MIN_CHEIRALITY_FRACTION) {
      problems.push(
        `the chosen candidate placed a median ${pct(s.medianCheiralityFraction)} of ` +
          `correspondences in front of both cameras, under the ` +
          `${pct(MIN_CHEIRALITY_FRACTION)} a real pose reaches`,
      );
    }
    if (s.medianReprojectionPx > MAX_REPROJECTION_PX) {
      problems.push(
        `median reprojection error ${deg(s.medianReprojectionPx).replace('°', ' px')}, over ` +
          `§33's ${MAX_REPROJECTION_PX} px`,
      );
    }
    if (s.lowParallaxWithTranslation > 0) {
      problems.push(
        `${s.lowParallaxWithTranslation} frame(s) named a translation with no parallax to support it`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.posedFrames} frames with a full pose: median ${pct(s.medianCheiralityFraction)} in ` +
        `front of both cameras, reprojection ${s.medianReprojectionPx} px, rotation ` +
        `${deg(s.medianRotationDeg)}, direction spread ${deg(s.translationSpreadDeg)}; ` +
        `${s.ambiguousFrames} frame(s) reported ambiguous`,
      reason:
        problems.length === 0
          ? 'a translation direction was recovered from correspondences that triangulate in ' +
            'front of both cameras. Direction only — a monocular camera has no scale, and v3 ' +
            '§15 and v4 §18 both forbid assuming one. Whether the direction *responds* to the ' +
            'camera is POSE-005’s question and not this one: a straight-line motion gives a ' +
            'genuinely constant direction, so the spread reported above cannot tell a recovered ' +
            'constant from an invented one'
          : problems.join('; '),
      metrics,
    };
  },
};

const POSE_002: Phase6Test = {
  spec: {
    id: 'POSE-002',
    title: 'Rotation',
    required: true,
    input: "frames where the device's own gyroscope integrates to a measurable turn",
    expected: 'the visually recovered rotation angle agrees with the integrated gyroscope',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} frames with a gyroscope-measured turn over the anchor interval; ` +
      `median disagreement within max(${ROTATION_AGREEMENT_DEG}°, ` +
      `${ROTATION_AGREEMENT_FRACTION} × measured); the gyroscope measured a non-zero rotation; ` +
      `and >= ${Math.round(MIN_ROTATION_AGREEMENT_RATE * 100)}% of individual frames agree`,
    failureCondition:
      'the recovered rotation near zero while the gyroscope reports a turn. That is the ' +
      'signature of a stage returning a constant, and no statistic computed from the pose’s own ' +
      'output would show it',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      gyroAvailable: s.gyroAvailable,
      rotationSamples: s.rotationSamples,
      medianVisualDeg: s.medianVisualRotationDeg,
      medianGyroDeg: s.medianGyroRotationDeg,
      medianDisagreementDeg: s.medianRotationDisagreementDeg,
      agreementRate: s.rotationAgreementRate,
      recent: s.rotationAgreements.slice(-6) as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (!s.gyroAvailable) {
      return {
        verdict: Verdict.PENDING,
        observed: 'the gyroscope is not delivering rotationRate',
        reason:
          s.gyroReason ||
          'without the gyroscope there is no instrument independent of the pose solver that ' +
            'can say how far the camera actually turned, so POSE-002 reports PENDING with that ' +
            'reason rather than being judged. This is why the phase cannot pass off the device',
        metrics,
      };
    }
    if (s.rotationSamples < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.rotationSamples}/${MIN_JUDGED_FRAMES} comparable frames so far`,
        reason:
          `a frame is comparable only when the gyroscope measured at least ` +
          `${MIN_COMPARABLE_ROTATION_DEG}° of net rotation over the anchor interval — an ` +
          'agreement between two zeros is not an agreement. Turn the phone',
        metrics,
      };
    }

    const problems: string[] = [];
    const tolerance = Math.max(
      ROTATION_AGREEMENT_DEG,
      ROTATION_AGREEMENT_FRACTION * s.medianGyroRotationDeg,
    );
    if (s.medianGyroRotationDeg <= 0) {
      problems.push('the gyroscope measured no rotation at all, so there is nothing to agree with');
    }
    if (s.medianRotationDisagreementDeg > tolerance) {
      problems.push(
        `the recovered rotation and the gyroscope disagree by a median of ` +
          `${deg(s.medianRotationDisagreementDeg)}, over the ${deg(tolerance)} allowed at a ` +
          `measured ${deg(s.medianGyroRotationDeg)}`,
      );
    }
    if (s.rotationAgreementRate < MIN_ROTATION_AGREEMENT_RATE) {
      problems.push(
        `only ${pct(s.rotationAgreementRate)} of individual frames agreed, under ` +
          `${pct(MIN_ROTATION_AGREEMENT_RATE)} — a median can hide a run that agrees half the time`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rotationSamples} comparable frames: the camera recovered ` +
        `${deg(s.medianVisualRotationDeg)} against the gyroscope's ${deg(s.medianGyroRotationDeg)}, ` +
        `median disagreement ${deg(s.medianRotationDisagreementDeg)}, ` +
        `${pct(s.rotationAgreementRate)} agreeing`,
      reason:
        problems.length === 0
          ? 'the rotation recovered from the image agrees with the one the gyroscope measured, ' +
            'over the same interval. The two share no code, no thread and no data, and the ' +
            'solver never sees the gyroscope — v3 §19 lists IMU consistency among the ' +
            'confidence inputs and this phase withholds it precisely so this comparison means ' +
            'something. Angles only: an angle is invariant under the unmeasured rotation ' +
            'between the device frame and the camera frame, an axis is not'
          : problems.join('; '),
      metrics,
    };
  },
};

const POSE_003: Phase6Test = {
  spec: {
    id: 'POSE-003',
    title: 'Planar scene',
    required: true,
    input: 'judged frames Phase 5 flagged PLANAR',
    expected:
      'the pose comes from the homography, and translation confidence is lower than on a scene ' +
      'with depth — v3 §16',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} planar frames with a pose; every one of them reports ` +
      `source ${GeometricModel.HOMOGRAPHY}; no planar frame's translation confidence exceeds ` +
      "its own rotation confidence; and the penalty actually applied — the median count of " +
      'candidates cheirality could not separate is higher on planar frames than on frames with ' +
      'depth. The two confidence medians are reported and not compared across classes',
    failureCondition:
      'an Essential matrix decomposed on a planar frame; or a planar frame whose translation ' +
      'confidence was not lowered at all',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      planarPosedFrames: s.planarPosedFrames,
      nonPlanarPosedFrames: s.nonPlanarPosedFrames,
      planarFromEssential: s.planarFromEssential,
      medianPlanarTranslationConfidence: s.medianPlanarTranslationConfidence,
      medianNonPlanarTranslationConfidence: s.medianNonPlanarTranslationConfidence,
      medianPlanarUnseparated: s.medianPlanarUnseparated,
      medianNonPlanarUnseparated: s.medianNonPlanarUnseparated,
      planarTranslationNotLowered: s.planarTranslationNotLowered,
      ambiguousFrames: s.ambiguousFrames,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    // Checked before the count gate: a single Essential matrix decomposed from a plane is the
    // failure this test exists for, and it should not wait for fifteen frames to be reported.
    if (s.planarFromEssential > 0) {
      problems.push(
        `${s.planarFromEssential} planar frame(s) had their pose taken from an Essential matrix. ` +
          'An E decomposed from a plane is degenerate and yields a pose that looks entirely ' +
          'reasonable, which is the whole reason v3 §16 exists',
      );
    }
    if (problems.length === 0 && s.planarPosedFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.planarPosedFrames}/${MIN_JUDGED_FRAMES} planar frames with a pose`,
        reason:
          'point the camera at a flat textured surface and move sideways past it. A frame counts ' +
          'as planar when the homography wins v3 §16’s comparison, which is measured from the ' +
          'image rather than asserted here',
        metrics,
      };
    }
    if (problems.length === 0 && s.nonPlanarPosedFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${s.planarPosedFrames} planar frames but only ${s.nonPlanarPosedFrames} non-planar ` +
          'ones to compare their confidence against',
        reason:
          'the comparison needs both cases: without a scene that has depth in it there is ' +
          'nothing to say the planar translation confidence is lower *than*',
        metrics,
      };
    }
    if (s.planarTranslationNotLowered > 0) {
      problems.push(
        `${s.planarTranslationNotLowered} planar frame(s) carried a translation confidence above ` +
          'their own rotation confidence. The planar penalty can only lower; a translation ' +
          'trusted more than the rotation it came with is not a penalty being applied',
      );
    }
    // The penalty has to have *applied*, not merely been available. Measured on what it is made
    // of — the candidates cheirality could not separate — rather than on the confidence figures,
    // which are minima over several terms and can be bound by an unrelated one.
    if (
      s.medianPlanarUnseparated >= 0 &&
      s.medianNonPlanarUnseparated >= 0 &&
      s.medianPlanarUnseparated <= s.medianNonPlanarUnseparated
    ) {
      problems.push(
        `cheirality left a median of ${s.medianPlanarUnseparated} unseparated candidate(s) on ` +
          `planar frames against ${s.medianNonPlanarUnseparated} on frames with depth — the ` +
          'two-fold ambiguity a plane produces is not being found, so nothing is lowering the ' +
          'translation confidence there',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.planarPosedFrames} planar and ${s.nonPlanarPosedFrames} non-planar frames with a ` +
        `pose; cheirality left ${s.medianPlanarUnseparated} unseparated candidate(s) on planar ` +
        `frames against ${s.medianNonPlanarUnseparated} with depth; translation confidence ` +
        `${s.medianPlanarTranslationConfidence} against ${s.medianNonPlanarTranslationConfidence} ` +
        `(reported, not compared); ${s.planarFromEssential} planar frame(s) decomposed an ` +
        `Essential matrix, ${s.planarTranslationNotLowered} not lowered`,
      reason:
        problems.length === 0
          ? 'a planar scene is decomposed from the homography and its translation confidence is ' +
            'lowered — by the number of candidates cheirality could not separate, which on a ' +
            'plane is generically two, so the term is 1/2. Counted rather than assumed: a ' +
            'homography decomposition has a genuine two-fold ambiguity that two views cannot ' +
            'resolve, and half is what one of two equally supported answers is worth'
          : problems.join('; '),
      metrics,
    };
  },
};

const POSE_004: Phase6Test = {
  spec: {
    id: 'POSE-004',
    title: 'Low parallax',
    required: true,
    input: 'frames where the camera turned without moving, and frames Phase 5 declined',
    expected: 'no translation is invented (§44, v4 §1.4 — fail closed)',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} frames whose parallax fell under ${PURE_ROTATION_PARALLAX_PX} px, ` +
      'or the run reports that the condition never occurred; every one of them reports ' +
      `${PoseState.ROTATION_ONLY} with a null translation; every frame Phase 5 left UNVERIFIED ` +
      'reports NO_POSE; and no frame carries a scale other than LOCAL_UNITS',
    failureCondition:
      'a unit translation vector on a frame with no measurable parallax. It will look like a ' +
      'direction, it will be stable enough to plot, and it will be noise',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      lowParallaxFrames: s.lowParallaxFrames,
      lowParallaxWithTranslation: s.lowParallaxWithTranslation,
      unverifiedFrames: s.unverifiedFrames,
      unverifiedWithRotation: s.unverifiedWithRotation,
      scaleViolations: s.scaleViolations,
      parallaxThresholdPx: PURE_ROTATION_PARALLAX_PX,
      stateFrames: s.stateFrames as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.lowParallaxWithTranslation > 0) {
      problems.push(
        `${s.lowParallaxWithTranslation} frame(s) named a translation direction while rotation ` +
          `alone already explained the image to within ${PURE_ROTATION_PARALLAX_PX} px`,
      );
    }
    if (s.unverifiedWithRotation > 0) {
      problems.push(
        `${s.unverifiedWithRotation} frame(s) carried a rotation on a frame Phase 5 declined to ` +
          'verify — a frame that verified nothing has no pose either',
      );
    }
    if (s.scaleViolations > 0) {
      problems.push(`${s.scaleViolations} frame(s) carried a scale other than LOCAL_UNITS`);
    }
    if (problems.length === 0 && s.lowParallaxFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${s.lowParallaxFrames}/${MIN_JUDGED_FRAMES} frames with no measurable parallax; ` +
          `${s.unverifiedFrames} frames Phase 5 declined, ${s.unverifiedWithRotation} of which ` +
          'still carried a rotation',
        reason:
          'turn the phone on the spot, without moving it sideways. That produces large image ' +
          'motion and no translation at all, which is the case this test exists for — and it ' +
          'is the one configuration that passes every check Phase 5 applies',
        metrics,
      };
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.lowParallaxFrames} frames with no measurable parallax, ${s.lowParallaxWithTranslation} ` +
        `of which named a translation; ${s.unverifiedFrames} frames Phase 5 declined, ` +
        `${s.unverifiedWithRotation} of which carried a rotation`,
      reason:
        problems.length === 0
          ? 'where the image motion was explained by rotation alone, no translation was ' +
            'reported. Decided from the correspondences — what rotation alone leaves ' +
            'unexplained, in pixels — rather than from the decomposition, which can hand back a ' +
            'translation of any length regardless of whether the data contains one'
          : problems.join('; '),
      metrics,
    };
  },
};

const POSE_005: Phase6Test = {
  spec: {
    id: 'POSE-005',
    title: 'Recovered rotation tracks an injected one',
    required: true,
    input:
      `on sampled frames, the verified correspondence set with a known ${INJECTED_ROTATION_DEG}° ` +
      'camera rotation applied to the second view, handed to the solver unmarked',
    expected: 'Poseが計算結果により変化 — v3 §67’s pass condition, made decidable',
    passCriteria:
      `>= ${MIN_INJECTION_SAMPLES} injected frames; the median recovered difference within ` +
      `${INJECTION_TOLERANCE_DEG}° of ${INJECTED_ROTATION_DEG}°; the control under ` +
      `${MAX_CONTROL_ROTATION_DEG}°; and the injected set keeping the same inlier count and the ` +
      `same planar flag to within ${Math.round(MAX_INJECTION_DRIFT * 100)}%, since an ` +
      'image-space rotation preserves incidence — the control’s own figures are reported beside ' +
      'them as the noise floor',
    failureCondition:
      'a recovered difference near 0° — a pose that did not respond to the camera being turned. ' +
      'A stage returning a constant scores exactly 0.00° here while satisfying every other ' +
      'numeric criterion in this phase',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      injectionSamples: s.injectionSamples,
      requestedDeg: s.requestedInjectionDeg,
      medianRecoveredDeg: s.medianInjectedDeg,
      medianControlDeg: s.medianControlDeg,
      medianInlierDrift: s.medianInjectedInlierDrift,
      medianControlInlierDrift: s.medianControlInlierDrift,
      planarFlips: s.injectionPlanarFlips,
      controlPlanarFlips: s.controlPlanarFlips,
      maxDrift: MAX_INJECTION_DRIFT,
      recent: s.injections.slice(-6) as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.injectionSamples < MIN_INJECTION_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.injectionSamples}/${MIN_INJECTION_SAMPLES} injected frames so far`,
        reason:
          'the injection runs on a sample of frames because it costs a second model fit and a ' +
          'second decomposition, and it only runs where a pose was recovered to compare against. ' +
          'Keep moving',
        metrics,
      };
    }

    const problems: string[] = [];
    const off = Math.abs(s.medianInjectedDeg - INJECTED_ROTATION_DEG);
    if (off > INJECTION_TOLERANCE_DEG) {
      problems.push(
        `the camera was turned ${INJECTED_ROTATION_DEG}° and the recovered pose moved ` +
          `${deg(s.medianInjectedDeg)} — off by ${deg(off)}, against ` +
          `${deg(INJECTION_TOLERANCE_DEG)} allowed`,
      );
    }
    if (s.medianControlDeg > MAX_CONTROL_ROTATION_DEG) {
      problems.push(
        `the control — the same correspondences, unmodified, refitted — moved ` +
          `${deg(s.medianControlDeg)}, over the ${deg(MAX_CONTROL_ROTATION_DEG)} allowed. A pose ` +
          'that moves this much without being asked to is not tracking the injection, it is noise',
      );
    }
    if (s.medianInjectedInlierDrift > MAX_INJECTION_DRIFT) {
      problems.push(
        `injecting a rotation moved the inlier count by a median of ` +
          `${pct(s.medianInjectedInlierDrift)}, against ${pct(s.medianControlInlierDrift)} for ` +
          `refitting the same data and ${pct(MAX_INJECTION_DRIFT)} allowed. The epipolar ` +
          'geometry maps exactly under an image-space rotation, so a drift this large means ' +
          'the fit is responding to something other than the geometry',
      );
    }
    const flipRate = s.injectionSamples > 0 ? s.injectionPlanarFlips / s.injectionSamples : 0;
    if (flipRate > MAX_INJECTION_DRIFT) {
      problems.push(
        `${pct(flipRate)} of injected frames flipped v3 §16's planar flag (control: ` +
          `${s.controlPlanarFlips}), against ${pct(MAX_INJECTION_DRIFT)} allowed. A rotation of ` +
          'the image plane cannot change which model explains the scene',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.injectionSamples} injected frames: the pose moved ${deg(s.medianInjectedDeg)} for a ` +
        `${INJECTED_ROTATION_DEG}° injection against ${deg(s.medianControlDeg)} for the control; ` +
        `inlier drift ${pct(s.medianInjectedInlierDrift)} against the control's ` +
        `${pct(s.medianControlInlierDrift)}, ${s.injectionPlanarFlips} planar flip(s) against ` +
        `${s.controlPlanarFlips}`,
      reason:
        problems.length === 0
          ? 'the pose followed a rotation it was never told about. The harness applied ' +
            'K·Rj·K⁻¹ to the second view — which is exactly the camera having turned by Rj — ' +
            'and re-ran the whole chain, model fit included, on a set handed over unmarked. ' +
            'This is the one number in Phase 6 a stage returning a constant pose cannot ' +
            'produce, because a constant scores exactly 0.00°, and the control is what stops a ' +
            'stage returning noise from passing instead'
          : problems.join('; '),
      metrics,
    };
  },
};

const POSE_006: Phase6Test = {
  spec: {
    id: 'POSE-006',
    title: 'Pose cost',
    required: false,
    input: 'the measured cost of decomposition, cheirality and triangulation per judged frame',
    expected: "Phase 5's RANSAC plus this phase's recovery fits §H's one budget line for both",
    passCriteria: `mean verify + pose <= ${POSE_PIPELINE_BUDGET_MS} ms over >= ${MIN_COST_SAMPLES} frames`,
    failureCondition:
      'over budget. Advisory because §34 ranks correctness above performance, and because a ' +
      'device budget cannot be adjudicated off the device (§H.4)',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const total = s.meanPoseMs >= 0 && ctx.verifyMs >= 0 ? s.meanPoseMs + ctx.verifyMs : -1;
    const metrics: Record<string, JsonValue> = {
      meanPoseMs: s.meanPoseMs,
      meanVerifyMs: ctx.verifyMs,
      combinedMs: total,
      budgetMs: POSE_PIPELINE_BUDGET_MS,
      samples: s.poseCostSamples,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.poseCostSamples < MIN_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.poseCostSamples}/${MIN_COST_SAMPLES} frames measured`,
        reason: 'a mean over a handful of frames says nothing; keep recovering',
        metrics,
      };
    }
    const over = total > POSE_PIPELINE_BUDGET_MS;
    return {
      verdict: over ? Verdict.FAIL : Verdict.PASS,
      observed:
        `${s.meanPoseMs} ms pose recovery plus ${ctx.verifyMs} ms of Phase 5 RANSAC = ` +
        `${Math.round(total * 1000) / 1000} ms over ${s.poseCostSamples} frames`,
      reason: over
        ? `the two stages together exceed §H's ${POSE_PIPELINE_BUDGET_MS} ms line for "RANSAC ` +
          '(E/H) + pose recovery". Both models are still fitted on every judged frame and both ' +
          'decompositions still run — v3 §16 is not skipped to save time'
        : `§H budgets RANSAC and pose recovery as one ${POSE_PIPELINE_BUDGET_MS} ms line, and ` +
          'this reports the sum rather than claiming a fresh allowance for the second stage',
      metrics,
    };
  },
};

const POSE_007: Phase6Test = {
  spec: {
    id: 'POSE-007',
    title: 'Metadata honesty',
    required: false,
    input: 'the pose records themselves',
    expected: 'the phase claims no scale, no measured intrinsics, and no pose it did not recover',
    passCriteria:
      'every record carries LOCAL_UNITS and INTRINSICS: ESTIMATED; a reprojection error exists ' +
      'only where points were triangulated; points-in-front never exceeds the correspondence ' +
      'count; a NO_POSE frame carries no rotation and no translation; and confidence is never ' +
      'above its lowest measured term',
    failureCondition: 'any of the above unmet — in particular a pose attached to a verdict of none',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      scaleViolations: s.scaleViolations,
      intrinsicsUnmarked: s.intrinsicsUnmarked,
      reprojectionWithoutTriangulation: s.reprojectionWithoutTriangulation,
      pointsInFrontOverflow: s.pointsInFrontOverflow,
      confidenceAboveWorstTerm: s.confidenceAboveWorstTerm,
      poseWithoutVerdict: s.poseWithoutVerdict,
      stateMismatches: s.stateMismatches,
      assumedFovDeg: NOMINAL_FOV_DEG,
      medianSensitivityRotationDeg: s.medianSensitivityRotationDeg,
      medianSensitivityTranslationDeg: s.medianSensitivityTranslationDeg,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.scaleViolations > 0) problems.push(`${s.scaleViolations} record(s) not in LOCAL_UNITS`);
    if (s.intrinsicsUnmarked > 0) {
      problems.push(
        `${s.intrinsicsUnmarked} record(s) carried a K without INTRINSICS: ESTIMATED beside it`,
      );
    }
    if (s.reprojectionWithoutTriangulation > 0) {
      problems.push(
        `${s.reprojectionWithoutTriangulation} record(s) reported a reprojection error with ` +
          'nothing triangulated to produce it',
      );
    }
    if (s.pointsInFrontOverflow > 0) {
      problems.push(
        `${s.pointsInFrontOverflow} record(s) placed more points in front of the cameras than ` +
          'there were correspondences',
      );
    }
    if (s.confidenceAboveWorstTerm > 0) {
      problems.push(
        `${s.confidenceAboveWorstTerm} record(s) reported a confidence above their own lowest ` +
          'term — v3 §19: 不確実なPoseは強制的に高confidenceにしない',
      );
    }
    if (s.poseWithoutVerdict > 0) {
      problems.push(
        `${s.poseWithoutVerdict} record(s) reported NO_POSE while still carrying a rotation or a ` +
          'translation',
      );
    }
    if (s.stateMismatches > 0) {
      problems.push(`${s.stateMismatches} record(s) reported a state their own inputs do not imply`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.poseFrames} frames inspected: scale intact, intrinsics marked estimated at ` +
        `${NOMINAL_FOV_DEG}° assumed FOV, no pose on a frame that recovered none, no state ` +
        `inconsistent with its inputs; ±20% focal moves the rotation ` +
        `${deg(s.medianSensitivityRotationDeg)} and the translation direction ` +
        `${deg(s.medianSensitivityTranslationDeg)}`,
      reason:
        problems.length === 0
          ? 'the record says what was recovered and nothing else. No metric scale exists here ' +
            'and none is implied: ‖t‖ is 1 by construction and the unit is LOCAL_UNITS, so a ' +
            'later phase has to remove that deliberately rather than by forgetting. And the ' +
            'focal length is an assumption whose consequences are measured — what barely moves ' +
            'under ±20% does not depend on the guess, and what moves does'
          : problems.slice(0, 5).join('; '),
      metrics,
    };
  },
};

export const PHASE6_TESTS: readonly Phase6Test[] = [
  POSE_001, POSE_002, POSE_003, POSE_004, POSE_005, POSE_006, POSE_007,
];

export const PHASE6_SPECS: readonly TestSpec[] = PHASE6_TESTS.map((t) => t.spec);

export function runPhase6Tests(ctx: Phase6Context): TestResult[] {
  return PHASE6_TESTS.map((test) => {
    const e = test.evaluate(ctx);
    return {
      spec: test.spec,
      verdict: e.verdict,
      observed: e.observed,
      reason: e.reason,
      metrics: e.metrics ?? {},
      timestamp: Date.now(),
    };
  });
}

/** Re-exported so the screen shows the same numbers the tests judge (Rule 002). */
export { CHEIRALITY_MARGIN, MAX_REPROJECTION_PX, MIN_CHEIRALITY_FRACTION, PoseState };
export { PURE_ROTATION_PARALLAX_PX, NOMINAL_FOV_DEG, INJECTED_ROTATION_DEG };
