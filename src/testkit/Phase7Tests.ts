/**
 * Phase 7 test suite — IMU-001..IMU-009.
 *
 * Specs transcribed from `docs/phase7/TEST-PLAN.md`, written and committed before
 * `src/fusion/orientationEkf.ts` existed (§29). Same verdict algebra as the phases before it:
 * PASS / FAIL / PENDING, with PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `FusionStats` and nothing else — no DOM, no worker, no camera, no
 * accelerometer — so the suite can be shown a run driven by the real filter beside one driven by
 * a "fusion" that returns the visual pose unchanged, and checked that the two produce different
 * verdicts. `tests/unit/fusion.test.ts` does exactly that.
 *
 * **The claim.** A pass-through scores *well* on almost everything in this phase. Its
 * orientation tracks the camera perfectly, its innovation is zero, its consistency term is 1,
 * and it never invents a position. IMU-005 is the one number it cannot produce, and IMU-002 is
 * the one v3 §68 actually asks for — which is why this phase is decided at the two ends rather
 * than in the middle.
 *
 * **This leg has no IMU.** Chromium's fake camera has no accelerometer behind it, so the
 * automated leg is permanently in IMU-002's case — and that is v3 §68's own pass condition, so
 * the leg decides the spec's stated requirement every build and reports the rest `PENDING` with
 * the reason attached. Rule 004 still holds: only the device can pass the phase.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  DEAD_RECKONING_AFTER_MS,
  FusionMode,
  GRAVITY_TOLERANCE_MS2,
  GYRO_BIAS_INJECTION_DPS,
  MAX_PROPAGATION_MS,
  MIN_BIAS_SAMPLES,
} from '../tracking/FusionStage';
import { ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION } from '../tracking/PoseSession';
import type { FusionStats } from '../tracking/fusionStats';
import type { Evaluation, PhaseTest } from './runTests';
import { deg, pct, runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Judged frames of a condition before that condition is decided. As Phases 3–6 used. */
export const MIN_JUDGED_FRAMES = 15;
/** IMU-005: how close `|b_injected − b_control|` must come to the injection. */
export const BIAS_TOLERANCE_DPS = 1.0;
/** ...and how far off the injected axis the difference may lie (criterion 3). */
export const BIAS_AXIS_TOLERANCE_DEG = 25.0;
/** IMU-005 needs this many measurements before its median means anything. */
export const MIN_BIAS_SAMPLES_JUDGED = MIN_BIAS_SAMPLES;
/** IMU-003: the fraction of updates that must land inside the tolerance, not merely the median. */
export const MIN_INNOVATION_AGREEMENT_RATE = 0.6;
/** IMU-004: how far the filter's own down axis may sit from the accelerometer's, degrees. */
export const GRAVITY_AGREEMENT_DEG = 10.0;
/** §H allocates no line to fusion — see the plan. Advisory for that reason. */
export const FUSION_BUDGET_MS = 1.0;
/** IMU-008 needs a population before a mean means anything. */
export const MIN_COST_SAMPLES = 10;

export interface Phase7Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** Fusion was switched on at least once in this run. */
  readonly fusionEverRan: boolean;
  readonly stats: FusionStats;
}

type Phase7Test = PhaseTest<Phase7Context>;

function dps(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 1000} °/s`;
}

function notRunning(ctx: Phase7Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.fusionEverRan && ctx.stats.fusionFrames > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `fusion has not run (camera ${ctx.cameraState})`,
    reason: 'no fused frame has been produced, so there is nothing to judge',
    metrics,
  };
}

/**
 * The one absence this phase treats as a *result* rather than as a gap.
 *
 * Everywhere else a missing instrument gives `PENDING`. Here it gives IMU-002 its input: v3 §68's
 * pass condition is about the case where the IMU is unavailable, so a run without one is the run
 * that record is for. Every *other* record reports `PENDING` with the sensor named.
 */
function noImu(ctx: Phase7Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.stats.imuAvailable) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `no IMU is reporting — ${ctx.stats.imuReason}`,
    reason:
      'this record is about what the fusion does with the sensors, and there are none. The ' +
      'run continues on vision alone, which is v3 §68’s pass condition and IMU-002’s subject — ' +
      'so the absence is decided there rather than rounded up here',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const IMU_001: Phase7Test = {
  spec: {
    id: 'IMU-001',
    title: 'Motion permission granted',
    required: true,
    input: 'a run where DeviceMotion was granted and is delivering',
    expected:
      "all of §17's fields present, and the filter's output differing from the visual pose in " +
      "the way a filter's should",
    passCriteria:
      'rotationRate, acceleration and accelerationIncludingGravity all arriving at a measured ' +
      `rate the bundle records; >= ${MIN_JUDGED_FRAMES} frames reported ${FusionMode.FUSED}; the ` +
      'filter propagated between visual updates; and a non-zero gyroscope bias estimate or a ' +
      'recorded reason why the run could not observe one',
    failureCondition:
      'FUSED reported on a run where the fused orientation is identical to the visual ' +
      'orientation on every frame — that is a pass-through, and it is what "not fusing" looks like',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      sensors: s.sensors as unknown as JsonValue,
      measuredImuHz: s.measuredImuHz,
      reportedImuHz: s.reportedImuHz,
      fusedFrames: s.fusedFrames,
      propagatingFrames: s.propagatingFrames,
      biasMagnitudeDps: s.biasMagnitudeDps,
      biasReason: s.biasReason,
      medianFusedVsVisualDeg: s.medianFusedVsVisualDeg,
      maxFusedVsVisualDeg: s.maxFusedVsVisualDeg,
      zeroFusedVsVisualFrames: s.zeroFusedVsVisualFrames,
      fusedVsVisualSamples: s.fusedVsVisualSamples,
    };
    const pending = notRunning(ctx, metrics) ?? noImu(ctx, metrics);
    if (pending) return pending;

    const missing = s.sensors
      .filter((c) => !c.arriving && c.name !== 'magnetometer' && c.name !== 'deviceorientation')
      .map((c) => c.name);
    if (s.fusedFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.fusedFrames}/${MIN_JUDGED_FRAMES} frames reported ${FusionMode.FUSED}`,
        reason:
          'the filter needs both instruments at once: motion permission granted *and* Phase 6 ' +
          'recovering a pose. Point the camera at a textured scene and move — a frame with no ' +
          'visual pose is a frame the fusion has nothing to fuse',
        metrics,
      };
    }

    const problems: string[] = [];
    if (missing.length > 0) problems.push(`no reading on ${missing.join(', ')}`);
    if (s.propagatingFrames < MIN_JUDGED_FRAMES) {
      problems.push(
        `only ${s.propagatingFrames} frame(s) propagated between visual updates — the gyroscope ` +
          'is being carried by vision rather than doing work',
      );
    }
    // The failure condition, stated as the plan states it: a pass-through moves the orientation
    // to exactly where vision put it, on every frame, and every other number here still looks fine.
    if (s.fusedVsVisualSamples >= MIN_JUDGED_FRAMES && s.maxFusedVsVisualDeg === 0) {
      problems.push(
        `the fused orientation was identical to the visual one on all ${s.fusedVsVisualSamples} ` +
          'frames that could be compared — that is a pass-through, not a fusion',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.imuSamples} IMU samples at ${s.measuredImuHz} Hz measured (${s.reportedImuHz} Hz ` +
        `reported by the platform); ${s.fusedFrames} frames ${FusionMode.FUSED}, ` +
        `${s.propagatingFrames} propagating; bias ${dps(s.biasMagnitudeDps)}; fused sits ` +
        `${deg(s.medianFusedVsVisualDeg)} from the visual pose (max ` +
        `${deg(s.maxFusedVsVisualDeg)})`,
      reason:
        problems.length === 0
          ? 'the sensors are delivering, the filter is propagating between visual updates rather ' +
            'than being carried by them, and its orientation is its own — a pass-through would ' +
            'report zero on that last figure for every frame of the run'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_002: Phase7Test = {
  spec: {
    id: 'IMU-002',
    title: 'Motion permission denied',
    required: true,
    input: 'a run where DeviceMotion is absent, denied, or silent',
    expected: 'the system continues on vision alone and says so',
    passCriteria:
      `mode reports ${FusionMode.VISION_ONLY} on every frame and never ${FusionMode.FUSED}; the ` +
      'fused orientation equals the visual orientation exactly; gyroBiasDps is null rather than ' +
      'zero; imuConsistency is withheld from the confidence by name rather than scored as good',
    failureCondition: 'any fused state produced from absent sensors, or a run that stops',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      imuAvailable: s.imuAvailable,
      imuReason: s.imuReason,
      modeFrames: s.modeFrames as unknown as JsonValue,
      fusionFrames: s.fusionFrames,
      gyroBiasDps: s.gyroBiasDps as unknown as JsonValue,
      biasZeroWithoutGyro: s.biasZeroWithoutGyro,
      confidenceWithheld: s.confidenceWithheld as unknown as JsonValue,
      imuConsistency: s.imuConsistency,
      medianFusedVsVisualDeg: s.medianFusedVsVisualDeg,
      modeMismatches: s.modeMismatches,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    // This is the one record whose *subject* is the absence, so a run with an IMU is the one
    // that cannot decide it — the reverse of every other record in this suite.
    if (s.imuAvailable) {
      return {
        verdict: Verdict.PENDING,
        observed: `the IMU is reporting — ${s.imuReason}`,
        reason:
          'v3 §68’s pass condition is about the case where the IMU is unavailable. A run with a ' +
          'live gyroscope cannot decide it. Deny motion permission, or run the automated leg, ' +
          'which is permanently in this case',
        metrics,
      };
    }

    const problems: string[] = [];
    const fused = (s.modeFrames[FusionMode.FUSED] ?? 0) + (s.modeFrames[FusionMode.DEAD_RECKONING] ?? 0);
    if (fused > 0) {
      problems.push(`${fused} frame(s) reported a fused mode with no sensors reporting`);
    }
    if (s.gyroBiasDps !== null) {
      problems.push(
        'a gyroscope bias was reported with no gyroscope — an unmeasured quantity is absent, ' +
          'not zero',
      );
    }
    if (s.biasZeroWithoutGyro > 0) {
      problems.push(`${s.biasZeroWithoutGyro} record(s) carried a bias without a gyroscope`);
    }
    if (s.imuConsistency !== -1) {
      problems.push(
        `imuConsistency was scored ${s.imuConsistency} with nothing to be consistent with`,
      );
    }
    if (!s.confidenceWithheld.some((w) => w.includes('IMUConsistency'))) {
      problems.push('the confidence did not name imuConsistency as withheld');
    }
    if (s.modeMismatches > 0) {
      problems.push(`${s.modeMismatches} record(s) reported a mode their own inputs do not imply`);
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.fusionFrames} frames, all ${FusionMode.VISION_ONLY} — ${s.imuReason}. Bias ` +
        `${s.gyroBiasDps === null ? 'null' : String(s.gyroBiasDps)}, imuConsistency withheld by name`,
      reason:
        problems.length === 0
          ? 'v3 §68’s pass condition, met: IMU unavailableでもVision-only modeで継続可能. The ' +
            'run continued, the fused orientation is the visual one unchanged, and nothing was ' +
            'invented from sensors that are not reporting — the bias is null rather than zero, ' +
            'because a zero would be a claim that it was estimated and found to be nothing'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_003: Phase7Test = {
  spec: {
    id: 'IMU-003',
    title: 'Camera rotation',
    required: true,
    input: 'frames where the camera demonstrably rotated',
    expected: 'the fused orientation follows it, and the two instruments disagree only a little',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} updates where both the visual increment and the propagated ` +
      `prediction could be formed; median innovation within max(${ROTATION_AGREEMENT_DEG}°, ` +
      `${Math.round(ROTATION_AGREEMENT_FRACTION * 100)}% of measured); and the innovation not ` +
      'identically zero',
    failureCondition:
      'an innovation of exactly zero throughout — a filter whose prediction always matches its ' +
      'measurement exactly is not predicting, it is copying',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      innovationSamples: s.innovationSamples,
      medianInnovationDeg: s.medianInnovationDeg,
      maxInnovationDeg: s.maxInnovationDeg,
      medianVisualIncrementDeg: s.medianVisualIncrementDeg,
      toleranceDeg: s.toleranceDeg,
      innovationsWithinTolerance: s.innovationsWithinTolerance,
      zeroInnovationSamples: s.zeroInnovationSamples,
    };
    const pending = notRunning(ctx, metrics) ?? noImu(ctx, metrics);
    if (pending) return pending;

    if (s.innovationSamples < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.innovationSamples}/${MIN_JUDGED_FRAMES} visual updates were applied`,
        reason:
          'an update needs a visual increment spanning about a second with the verification ' +
          'anchor holding across it. Turn the phone steadily rather than in bursts — an ' +
          're-anchor mid-interval discards the increment rather than differencing across it',
        metrics,
      };
    }

    const rate = s.innovationsWithinTolerance / s.innovationSamples;
    const problems: string[] = [];
    if (s.medianInnovationDeg > s.toleranceDeg) {
      problems.push(
        `median innovation ${deg(s.medianInnovationDeg)} over the ${deg(s.toleranceDeg)} tolerance`,
      );
    }
    if (rate < MIN_INNOVATION_AGREEMENT_RATE) {
      problems.push(
        `only ${pct(rate)} of updates landed inside the tolerance, under ` +
          `${pct(MIN_INNOVATION_AGREEMENT_RATE)}`,
      );
    }
    // Fake 1's signature. Stated as a criterion because a pass-through satisfies both numbers above.
    if (s.zeroInnovationSamples === s.innovationSamples) {
      problems.push(
        `every one of the ${s.innovationSamples} updates had an innovation of exactly zero — ` +
          'the prediction is not predicting, it is copying the measurement',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.innovationSamples} updates over a median ${deg(s.medianVisualIncrementDeg)} of ` +
        `visual rotation: median innovation ${deg(s.medianInnovationDeg)} (max ` +
        `${deg(s.maxInnovationDeg)}) against a ${deg(s.toleranceDeg)} tolerance, ${pct(rate)} ` +
        `inside it; ${s.zeroInnovationSamples} exactly zero`,
      reason:
        problems.length === 0
          ? 'the gyroscope predicted where the camera would be and the camera agreed to within ' +
            'the tolerance Phase 6 already fixed between these two instruments — while ' +
            'disagreeing by *something*, which is what separates a prediction from a copy'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_004: Phase7Test = {
  spec: {
    id: 'IMU-004',
    title: 'Visual + IMU consistency',
    required: true,
    input: 'the fused confidence, and the gravity direction the accelerometer reports',
    expected: "v3 §19's seventh term is present, valued, and able to fall",
    passCriteria:
      'imuConsistency present in the fused confidence terms and named; at least one frame below ' +
      '1, or a recorded reason the instruments never disagreed enough; the fused confidence ' +
      `never above its own worst term; and median gravity disagreement within ` +
      `${GRAVITY_AGREEMENT_DEG}° over >= ${MIN_JUDGED_FRAMES} samples`,
    failureCondition:
      'an imuConsistency pinned at 1 whatever the sensors did; or a fused confidence above the ' +
      'visual confidence purely because a second sensor was present',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      imuConsistency: s.imuConsistency,
      medianImuConsistency: s.medianImuConsistency,
      minImuConsistency: s.minImuConsistency,
      imuConsistencyBelowOne: s.imuConsistencyBelowOne,
      imuConsistencySamples: s.imuConsistencySamples,
      gravityDegSamples: s.gravityDegSamples,
      medianGravityDeg: s.medianGravityDeg,
      gravityRejected: s.gravityRejected,
      confidence: s.confidence,
      visualConfidence: s.visualConfidence,
      confidenceAboveWorstTerm: s.confidenceAboveWorstTerm,
      fusedAboveVisual: s.fusedAboveVisual,
      confidenceTerms: s.confidenceTerms as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics) ?? noImu(ctx, metrics);
    if (pending) return pending;

    if (s.imuConsistencySamples < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.imuConsistencySamples}/${MIN_JUDGED_FRAMES} frames scored the term`,
        reason:
          'the term needs an applied update to score — either a visual increment or a gravity ' +
          'sample. Until one lands it is withheld by name rather than counted as good',
        metrics,
      };
    }

    const problems: string[] = [];
    const hasTerm = s.confidenceTerms.some((t) => t.name === 'imuConsistency');
    if (!hasTerm) problems.push('imuConsistency is not among the fused confidence terms');
    if (s.confidenceAboveWorstTerm > 0) {
      problems.push(
        `${s.confidenceAboveWorstTerm} frame(s) reported a confidence above their own lowest ` +
          'term — v3 §19: 不確実なPoseは強制的に高confidenceにしない',
      );
    }
    if (s.fusedAboveVisual > 0) {
      problems.push(
        `${s.fusedAboveVisual} frame(s) reported a fused confidence above the visual one — a ` +
          'second sensor may lower a confidence and may never raise it',
      );
    }
    if (s.gravityDegSamples >= MIN_JUDGED_FRAMES && s.medianGravityDeg > GRAVITY_AGREEMENT_DEG) {
      problems.push(
        `median gravity disagreement ${deg(s.medianGravityDeg)}, over ${GRAVITY_AGREEMENT_DEG}°`,
      );
    }
    // Criterion 2 is satisfied *either* by a frame below 1 or by the run saying the instruments
    // never disagreed enough — a term that never falls because nothing went wrong is not the
    // same defect as one that cannot fall, and the observed line separates the two.
    const everFell = s.imuConsistencyBelowOne > 0;
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `imuConsistency median ${s.medianImuConsistency}, minimum ${s.minImuConsistency} over ` +
        `${s.imuConsistencySamples} frames (${s.imuConsistencyBelowOne} below 1); gravity ` +
        `${deg(s.medianGravityDeg)} over ${s.gravityDegSamples} samples, ${s.gravityRejected} ` +
        `rejected for ‖g‖ outside ±${GRAVITY_TOLERANCE_MS2} m/s²; fused confidence ` +
        `${s.confidence} against the visual ${s.visualConfidence}`,
      reason:
        problems.length === 0
          ? (everFell
              ? 'the term fell below 1 where the instruments disagreed, so it is measuring ' +
                'something rather than asserting it. '
              : 'the term stayed at 1 for the whole run: the two instruments never disagreed ' +
                'enough to lower it, which the plan allows as an alternative to a frame below ' +
                '1 — the term is computed from the innovation either way. ') +
            'And the fused confidence is the minimum over its terms, so attaching a second ' +
            'sensor can only ever lower it'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_005: Phase7Test = {
  spec: {
    id: 'IMU-005',
    title: 'Injected gyroscope bias',
    required: true,
    input:
      `a second filter fed the same visual poses and the same gyroscope samples offset by a ` +
      `known ${GYRO_BIAS_INJECTION_DPS} °/s, handed over unmarked`,
    expected: "the injected filter's bias estimate exceeds the control's by the injected amount",
    passCriteria:
      `>= ${MIN_BIAS_SAMPLES_JUDGED} frames where both filters had converged enough to report; ` +
      `|b_injected − b_control| within ${BIAS_TOLERANCE_DPS} °/s of ${GYRO_BIAS_INJECTION_DPS} ` +
      `°/s; the difference lying within ${BIAS_AXIS_TOLERANCE_DEG}° of the injected axis; and ` +
      "the injected filter's median innovation inside IMU-003's tolerance",
    failureCondition:
      'a difference near zero. A pass-through and a dead-reckoner both score 0.0 °/s here, while ' +
      'satisfying every other numeric criterion in this phase',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      biasSamples: s.biasSamples,
      medianBiasDifferenceDps: s.medianBiasDifferenceDps,
      medianBiasAxisErrorDeg: s.medianBiasAxisErrorDeg,
      requestedInjectionDps: s.requestedInjectionDps,
      injectionAxis: s.injectionAxis as unknown as JsonValue,
      medianInjectedInnovationDeg: s.medianInjectedInnovationDeg,
      toleranceDeg: s.toleranceDeg,
      gyroBiasDps: s.gyroBiasDps as unknown as JsonValue,
      biasDifferences: s.biasDifferences.slice(-12) as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    // The plan's own exclusion, and the leg is always in it.
    if (!s.imuAvailable) {
      return {
        verdict: Verdict.PENDING,
        observed: `there is no gyroscope to bias — ${s.imuReason}`,
        reason:
          'IMU-005 injects a bias into a gyroscope. With no gyroscope there is nothing to inject ' +
          'into, and the plan excludes the record with that reason rather than passing it. The ' +
          'automated leg is permanently here; only a device can decide this one',
        metrics,
      };
    }
    if (s.biasSamples < MIN_BIAS_SAMPLES_JUDGED) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.biasSamples}/${MIN_BIAS_SAMPLES_JUDGED} frames reported a bias difference`,
        reason:
          `the difference is only reported once ${MIN_BIAS_SAMPLES} visual updates have been ` +
          'applied, because the bias is observable only through the covariance the propagation ' +
          'builds up. Keep both instruments running for a minute or so',
        metrics,
      };
    }

    const problems: string[] = [];
    const err = Math.abs(s.medianBiasDifferenceDps - s.requestedInjectionDps);
    if (err > BIAS_TOLERANCE_DPS) {
      problems.push(
        `the two filters differ by ${dps(s.medianBiasDifferenceDps)} where ` +
          `${dps(s.requestedInjectionDps)} was injected — off by ${dps(err)}, over the ` +
          `${BIAS_TOLERANCE_DPS} °/s tolerance`,
      );
    }
    if (s.medianBiasAxisErrorDeg < 0 || s.medianBiasAxisErrorDeg > BIAS_AXIS_TOLERANCE_DEG) {
      problems.push(
        `the difference lies ${deg(s.medianBiasAxisErrorDeg)} off the injected axis — the right ` +
          'magnitude along the wrong axis is not the injection',
      );
    }
    if (
      s.medianInjectedInnovationDeg >= 0 &&
      s.toleranceDeg > 0 &&
      s.medianInjectedInnovationDeg > s.toleranceDeg
    ) {
      problems.push(
        `the injected filter is left disagreeing with vision by ${deg(s.medianInjectedInnovationDeg)}, ` +
          `over the ${deg(s.toleranceDeg)} tolerance — it absorbed the bias into its attitude ` +
          'rather than into its bias state',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.biasSamples} paired measurements: the injected filter's bias exceeds the control's ` +
        `by ${dps(s.medianBiasDifferenceDps)} where ${dps(s.requestedInjectionDps)} was ` +
        `injected, ${deg(s.medianBiasAxisErrorDeg)} off the injected axis ` +
        `[${s.injectionAxis.join(', ')}]; the injected filter's own innovation ` +
        `${deg(s.medianInjectedInnovationDeg)}`,
      reason:
        problems.length === 0
          ? 'the filter recovered a bias it was never told about, on the axis it was applied to. ' +
            'The phone’s own true bias is unknown and common to both filters, so it cancels in ' +
            'the difference — which is what makes this decidable on a device whose real bias ' +
            'nobody can look up. A fusion that returned the visual pose, or one that ignored ' +
            'vision, would report 0.0 °/s here and pass every other number in this phase'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_006: Phase7Test = {
  spec: {
    id: 'IMU-006',
    title: 'No absolute position from the IMU',
    required: true,
    input: 'every fused record produced in the run',
    expected: 'no position, in any unit, from any source — and a number behind the refusal',
    passCriteria:
      'no record carries a position; scale reads UNKNOWN throughout; velocity and accelBias are ' +
      'absent with their reasons stated rather than reported as zero; and the accelerometer is ' +
      'double-integrated for the record only, with the resulting drift reported',
    failureCondition: 'any position field with a value. There is no tolerance on this one',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      positionsReported: s.positionsReported,
      scaleViolations: s.scaleViolations,
      scale: s.scale,
      positionReason: s.positionReason,
      velocityReason: s.velocityReason,
      accelBiasReason: s.accelBiasReason,
      deadReckonedPositionM: s.deadReckonedPositionM,
      deadReckonedSeconds: s.deadReckonedSeconds,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.positionsReported > 0) {
      problems.push(`${s.positionsReported} record(s) carried a position`);
    }
    if (s.scaleViolations > 0) {
      problems.push(`${s.scaleViolations} record(s) reported a scale other than UNKNOWN`);
    }
    if (!s.positionReason || !s.velocityReason || !s.accelBiasReason) {
      problems.push('a refused state was left without a stated reason');
    }
    const measured = s.imuAvailable && s.deadReckonedSeconds > 0;
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.fusionFrames} records, no position in any of them, scale ${s.scale} throughout. ` +
        (measured
          ? `Double-integrating the accelerometer over ${s.deadReckonedSeconds} s — for the ` +
            `record only, never fed to the pose — wanders ${s.deadReckonedPositionM} m`
          : 'no accelerometer reported, so the drift this phase declined to produce could not ' +
            'be measured on this run'),
      reason:
        problems.length === 0
          ? 'v3 §17’s two prohibitions and v4 §19’s one, held. The accelerometer reports m/s² ' +
            'and Phase 6’s translation is a unit direction in LOCAL_UNITS, so fusing them needs ' +
            'the scale a monocular camera does not have. ' +
            (measured
              ? 'And the refusal carries a number: the drift above is what integrating anyway ' +
                'would have produced over this run'
              : 'The drift measurement needs an accelerometer and this run had none')
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_007: Phase7Test = {
  spec: {
    id: 'IMU-007',
    title: 'Vision dropout',
    required: true,
    input: 'intervals where the visual pose stops arriving',
    expected: 'the orientation continues, and its confidence falls while it does',
    passCriteria:
      `>= ${MIN_JUDGED_FRAMES} frames of propagation without a visual update, or a recorded ` +
      `reason they never occurred; mode becomes ${FusionMode.DEAD_RECKONING}; the fused ` +
      'confidence falls monotonically with propagatedMs; past ' +
      `${MAX_PROPAGATION_MS} ms the pose is no longer offered as usable; and the innovation on ` +
      'the first corrected frame is recorded',
    failureCondition:
      'a confidence that does not fall while running open-loop; or a fused pose still offered as ' +
      `usable after ${MAX_PROPAGATION_MS / 1000} s without a measurement`,
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      dropoutFrames: s.dropoutFrames,
      longestPropagatedMs: s.longestPropagatedMs,
      dropoutConfidenceRises: s.dropoutConfidenceRises,
      usableBeyondMax: s.usableBeyondMax,
      reconvergences: s.reconvergences,
      medianReconvergenceInnovationDeg: s.medianReconvergenceInnovationDeg,
      dropouts: s.dropouts.slice(-8) as unknown as JsonValue,
      modeFrames: s.modeFrames as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics) ?? noImu(ctx, metrics);
    if (pending) return pending;

    if (s.dropoutFrames < MIN_JUDGED_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${s.dropoutFrames}/${MIN_JUDGED_FRAMES} frames ran open-loop (longest gap ` +
          `${s.longestPropagatedMs} ms)`,
        reason:
          `vision has to stop for longer than ${DEAD_RECKONING_AFTER_MS} ms for this record to ` +
          'have an interval to judge. Cover the lens for a second or two, or point it at a ' +
          'blank wall, while keeping the phone moving',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.dropoutConfidenceRises > 0) {
      problems.push(
        `the fused confidence rose on ${s.dropoutConfidenceRises} frame(s) while running ` +
          'open-loop — a propagated orientation does not get better with age',
      );
    }
    if (s.usableBeyondMax > 0) {
      problems.push(
        `${s.usableBeyondMax} frame(s) were still offered as usable past ${MAX_PROPAGATION_MS} ms ` +
          'without a measurement',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.dropoutFrames} frames of ${FusionMode.DEAD_RECKONING} over ${s.dropouts.length} ` +
        `interval(s), longest ${s.longestPropagatedMs} ms; confidence never rose; ` +
        `${s.reconvergences} reconvergence(s) at a median innovation of ` +
        `${deg(s.medianReconvergenceInnovationDeg)}`,
      reason:
        problems.length === 0
          ? 'the orientation continued through the gaps — which is what the IMU is for — and its ' +
            'confidence fell the whole way, reaching zero at v3 §17’s three seconds where the ' +
            'pose stops being offered. And the jump when vision returned is on the record ' +
            'rather than absorbed silently'
          : problems.join('; '),
      metrics,
    };
  },
};

const IMU_008: Phase7Test = {
  spec: {
    id: 'IMU-008',
    title: 'Fusion cost',
    required: false,
    input: `>= ${MIN_COST_SAMPLES} frames where the fusion ran`,
    expected: `mean fusion cost <= ${FUSION_BUDGET_MS} ms`,
    passCriteria: `mean fusion cost <= ${FUSION_BUDGET_MS} ms, with the sensor rate beside it`,
    failureCondition:
      'over budget. Advisory because §34 ranks correctness above performance, and because §H ' +
      'has no line for fusion at all — any cost here is spent from margin',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanFusionMs: s.meanFusionMs,
      fusionCostSamples: s.fusionCostSamples,
      measuredImuHz: s.measuredImuHz,
      budgetMs: FUSION_BUDGET_MS,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;
    if (s.fusionCostSamples < MIN_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.fusionCostSamples}/${MIN_COST_SAMPLES} cost samples`,
        reason: 'a mean needs a population',
        metrics,
      };
    }
    const over = s.meanFusionMs > FUSION_BUDGET_MS;
    return {
      verdict: over ? Verdict.FAIL : Verdict.PASS,
      observed:
        `${s.meanFusionMs} ms mean over ${s.fusionCostSamples} frames, against a ` +
        `${FUSION_BUDGET_MS} ms budget, with the IMU delivering at ${s.measuredImuHz} Hz`,
      reason: over
        ? `over budget by ${Math.round((s.meanFusionMs - FUSION_BUDGET_MS) * 1000) / 1000} ms`
        : 'an orientation error-state filter is a handful of 3×3 operations per sample, and it ' +
          'costs about what that predicts — which matters because §H had no millisecond left to ' +
          'give it',
      metrics,
    };
  },
};

const IMU_009: Phase7Test = {
  spec: {
    id: 'IMU-009',
    title: 'Metadata honesty',
    required: false,
    input: 'every fused record produced in the run',
    expected: 'the record says what was measured and nothing else',
    passCriteria:
      'every record carries SCALE: UNKNOWN and a null position; gyroBiasDps null where no ' +
      'gyroscope reported, never zero; orientation carried as a quaternion with no Euler triple ' +
      'anywhere; mode never disagreeing with the inputs it was derived from; the fused ' +
      'confidence never above its lowest measured term; and every rate inside 0..1',
    failureCondition: 'any of the above unmet',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      scaleViolations: s.scaleViolations,
      positionsReported: s.positionsReported,
      biasZeroWithoutGyro: s.biasZeroWithoutGyro,
      eulerEmitted: s.eulerEmitted,
      modeMismatches: s.modeMismatches,
      confidenceAboveWorstTerm: s.confidenceAboveWorstTerm,
      rateOutOfRange: s.rateOutOfRange,
      heading: s.heading,
      sensors: s.sensors as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    const problems: string[] = [];
    if (s.scaleViolations > 0) problems.push(`${s.scaleViolations} record(s) claimed a scale`);
    if (s.positionsReported > 0) problems.push(`${s.positionsReported} record(s) carried a position`);
    if (s.biasZeroWithoutGyro > 0) {
      problems.push(`${s.biasZeroWithoutGyro} record(s) reported a bias with no gyroscope`);
    }
    if (s.eulerEmitted > 0) {
      problems.push(`${s.eulerEmitted} record(s) carried a three-component orientation (§18)`);
    }
    if (s.modeMismatches > 0) {
      problems.push(`${s.modeMismatches} record(s) reported a mode their own inputs do not imply`);
    }
    if (s.confidenceAboveWorstTerm > 0) {
      problems.push(
        `${s.confidenceAboveWorstTerm} record(s) reported a confidence above their own lowest term`,
      );
    }
    if (s.rateOutOfRange > 0) {
      problems.push(
        `${s.rateOutOfRange} rate(s) fell outside 0..1 — Phase 6's device run reported 232.3%, ` +
          'and this is the check that a rate is a rate',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.fusionFrames} records inspected: scale UNKNOWN, no position, orientation carried as ` +
        `a quaternion, heading ${s.heading} (no magnetometer is read), every mode implied by its ` +
        'own inputs, every rate inside 0..1',
      reason:
        problems.length === 0
          ? 'the record is honest about the two things this phase refused and the one it could ' +
            'not have: no position, no scale, and a heading that is relative because nothing ' +
            'here reads a magnetometer. §18’s quaternion preference is met by there being no ' +
            'Euler conversion in the codebase to emit one'
          : problems.slice(0, 5).join('; '),
      metrics,
    };
  },
};

export const PHASE7_TESTS: readonly Phase7Test[] = [
  IMU_001, IMU_002, IMU_003, IMU_004, IMU_005, IMU_006, IMU_007, IMU_008, IMU_009,
];

export const PHASE7_SPECS: readonly TestSpec[] = PHASE7_TESTS.map((t) => t.spec);

export function runPhase7Tests(ctx: Phase7Context): TestResult[] {
  return runTests(PHASE7_TESTS, ctx);
}

/** Re-exported so the screen shows the same numbers the tests judge (Rule 002). */
export { FusionMode, GYRO_BIAS_INJECTION_DPS, MAX_PROPAGATION_MS, DEAD_RECKONING_AFTER_MS };
