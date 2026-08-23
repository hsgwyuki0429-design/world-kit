/**
 * Everything Phase 6 needs to answer POSE-001..007, accumulated across a run.
 *
 * Runs on the main thread and takes the message shape rather than the solver's own, because the
 * message is all that crossed. Two things happen here that do not happen in the worker, and both
 * are the reason this class exists rather than the worker reporting a finished verdict:
 *
 *  - **v3 §67's state is recomputed** from the inputs the worker reported, and every frame where
 *    the two answers differ is counted (Rule 002, as in Phases 4 and 5).
 *  - **POSE-002's comparison is made here**, because the gyroscope is a main-thread instrument.
 *    The worker never sees it. That is the whole point: a pose solver that could read the
 *    gyroscope could agree with it without recovering anything.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { PoseState } from '../geometry/pose';
import { INJECTED_ROTATION_DEG, INTRINSICS_SENSITIVITY } from './PoseStage';
import { NO_GYRO_ROTATION, integrateRotation } from './gyroRotation';
import type { GyroSample } from './gyroRotation';
import { poseStateFollowsFrom } from './poseStats';
import type { PoseInjectionSample, PoseStats, RotationAgreementSample } from './poseStats';
import type { PoseReport, TrackingResult } from './trackingMessages';

const MAX_SAMPLES = 400;

/**
 * The gyroscope tolerance: `max(3°, 30 % of what was measured)`.
 *
 * The same shape as Phase 4's scene-shift tolerance and for the same reason. The floor covers
 * what a consumer MEMS gyroscope drifts over an anchor's lifetime — a second or two — plus the
 * visual pose's own error on a real scene; the proportional part covers the fact that a longer
 * or faster turn accumulates more of both. Requiring a fixed 3° on a 40° turn would be requiring
 * the two instruments to agree to better than either one's own repeatability.
 */
export const ROTATION_AGREEMENT_DEG = 3.0;
export const ROTATION_AGREEMENT_FRACTION = 0.3;

/** How much of the gyroscope's path may be missing before a sample is not worth comparing. */
export const MIN_GYRO_SAMPLES = 4;

/**
 * The least net rotation worth comparing, in degrees.
 *
 * FLOW-002's criterion 3, one phase along: an agreement between two zeros is not an agreement.
 * A phone held still gives 0° from the gyroscope and ~0° from the solver, and a stage returning
 * a constant identity rotation matches it perfectly. Only frames where the camera demonstrably
 * turned can decide POSE-002.
 */
export const MIN_COMPARABLE_ROTATION_DEG = 2.0;

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}

function trim(list: unknown[], max = MAX_SAMPLES): void {
  while (list.length > max) list.shift();
}

export class PoseSession {
  private readonly rotations: number[] = [];
  private readonly reprojections: number[] = [];
  private readonly cheiralityFractions: number[] = [];
  private readonly confidences: number[] = [];
  private readonly sensitivityRotation: number[] = [];
  private readonly sensitivityTranslation: number[] = [];
  private readonly poseCosts: number[] = [];
  private readonly directions: number[][] = [];
  private readonly planarTranslationConfidence: number[] = [];
  private readonly nonPlanarTranslationConfidence: number[] = [];
  private readonly planarUnseparated: number[] = [];
  private readonly nonPlanarUnseparated: number[] = [];
  private readonly injections: PoseInjectionSample[] = [];
  private readonly injectedDeg: number[] = [];
  private readonly controlDeg: number[] = [];
  private readonly injectedDrift: number[] = [];
  private readonly controlDrift: number[] = [];
  /**
   * POSE-002's comparisons, as **one** bounded window that everything is derived from.
   *
   * It was four parallel structures — three trimmed arrays and an untrimmed `agreedFrames`
   * counter — and the counter kept climbing while the arrays stopped at 400. The device run of
   * 2026-08-23 therefore reported an agreement rate of **232.3%**, which is not a rate. One
   * window, one numerator, one denominator: the mismatch is now impossible rather than merely
   * fixed. `FlowSession` has always done it this way for FLOW-002, which is why Phase 4 never
   * had the defect.
   */
  private readonly comparisons: RotationAgreementSample[] = [];
  /** Total comparisons ever made, which is not the window's length once §56's bound bites. */
  private rotationComparisons = 0;
  private readonly stateFrames = new Map<string, number>();

  /** The gyroscope's own samples. Bounded: only the current anchor interval is ever needed. */
  private readonly gyro: GyroSample[] = [];
  private gyroAvailable = false;
  private gyroReason = 'the gyroscope has not reported yet';
  private anchorAt = -1;

  private poseFrames = 0;
  private posedFrames = 0;
  private stateMismatches = 0;
  private ambiguousFrames = 0;
  private belowCheiralityFraction = 0;
  private planarPosedFrames = 0;
  private nonPlanarPosedFrames = 0;
  private planarFromEssential = 0;
  private planarTranslationNotLowered = 0;
  private lowParallaxFrames = 0;
  private lowParallaxWithTranslation = 0;
  private unverifiedFrames = 0;
  private unverifiedWithRotation = 0;
  private injectionPlanarFlips = 0;
  private controlPlanarFlips = 0;
  private scaleViolations = 0;
  private intrinsicsUnmarked = 0;
  private reprojectionWithoutTriangulation = 0;
  private pointsInFrontOverflow = 0;
  private confidenceAboveWorstTerm = 0;
  private poseWithoutVerdict = 0;
  private last: PoseReport | null = null;

  reset(): void {
    for (const l of [
      this.rotations, this.reprojections, this.cheiralityFractions, this.confidences,
      this.sensitivityRotation, this.sensitivityTranslation, this.poseCosts,
      this.planarTranslationConfidence, this.nonPlanarTranslationConfidence,
      this.planarUnseparated, this.nonPlanarUnseparated,
      this.injectedDeg, this.controlDeg, this.injectedDrift, this.controlDrift,
    ]) l.length = 0;
    this.directions.length = 0;
    this.injections.length = 0;
    this.comparisons.length = 0;
    this.rotationComparisons = 0;
    this.gyro.length = 0;
    this.stateFrames.clear();
    this.anchorAt = -1;
    this.poseFrames = 0;
    this.posedFrames = 0;
    this.stateMismatches = 0;
    this.ambiguousFrames = 0;
    this.belowCheiralityFraction = 0;
    this.planarPosedFrames = 0;
    this.nonPlanarPosedFrames = 0;
    this.planarFromEssential = 0;
    this.planarTranslationNotLowered = 0;
    this.lowParallaxFrames = 0;
    this.lowParallaxWithTranslation = 0;
    this.unverifiedFrames = 0;
    this.unverifiedWithRotation = 0;
    this.injectionPlanarFlips = 0;
    this.controlPlanarFlips = 0;
    this.scaleViolations = 0;
    this.intrinsicsUnmarked = 0;
    this.reprojectionWithoutTriangulation = 0;
    this.pointsInFrontOverflow = 0;
    this.confidenceAboveWorstTerm = 0;
    this.poseWithoutVerdict = 0;
    this.last = null;
  }

  /** One `devicemotion` reading. Kept only as far back as the current anchor could reach. */
  noteGyro(sample: GyroSample): void {
    this.gyro.push(sample);
    this.gyroAvailable = true;
    this.gyroReason = '';
    // Ten seconds is far longer than any anchor lives (`MAX_BASELINE_PX` re-anchors well inside
    // that), and bounds the array regardless of what the sensor does.
    const cutoff = sample.at - 10_000;
    while (this.gyro.length > 0 && (this.gyro[0]?.at ?? 0) < cutoff) this.gyro.shift();
  }

  noteGyroUnavailable(reason: string): void {
    if (this.gyroAvailable) return;
    this.gyroReason = reason;
  }

  /** Fold one frame's Phase 6 result into the run. `now` is the main thread's clock. */
  record(result: TrackingResult, now: number): void {
    const p = result.pose;
    if (!p) return;
    this.poseFrames++;
    this.last = p;

    // The anchor's timestamp comes from the frame Phase 5 said it re-anchored on. That is what
    // makes the gyroscope's interval the *same* interval the visual rotation spans; deriving it
    // from a frame count and an assumed frame rate would compare two different intervals.
    if (result.verification?.reAnchored || this.anchorAt < 0) this.anchorAt = now;

    this.stateFrames.set(p.state, (this.stateFrames.get(p.state) ?? 0) + 1);

    const recomputed = poseStateFollowsFrom(p);
    if (recomputed !== null && recomputed !== p.state) this.stateMismatches++;

    // §80 / POSE-007: a frame that recovered nothing carries nothing.
    if (p.state === PoseState.NO_POSE && (p.rotationDeg >= 0 || p.translation !== null)) {
      this.poseWithoutVerdict++;
    }
    if (p.scale !== 'LOCAL_UNITS') this.scaleViolations++;
    if (p.intrinsics && !p.intrinsics.estimated) this.intrinsicsUnmarked++;
    if (p.reprojectionErrorPx >= 0 && p.pointsInFront <= 0) this.reprojectionWithoutTriangulation++;
    if (p.pointsInFront > p.correspondences) this.pointsInFrontOverflow++;
    if (p.confidenceTerms.length > 0) {
      const measured = p.confidenceTerms.filter((t) => t.value >= 0).map((t) => t.value);
      // Floating-point slack only: the confidence is the minimum, so anything above the worst
      // term by more than rounding means it was not computed as one.
      if (measured.length > 0 && p.confidence > Math.min(...measured) + 1e-6) {
        this.confidenceAboveWorstTerm++;
      }
    }

    if (result.verification && result.verification.state === 'UNVERIFIED') {
      this.unverifiedFrames++;
      if (p.rotationDeg >= 0) this.unverifiedWithRotation++;
    }

    if (p.state === PoseState.ROTATION_ONLY) {
      this.lowParallaxFrames++;
      if (p.translation !== null) this.lowParallaxWithTranslation++;
    }

    if (p.ambiguous) this.ambiguousFrames++;
    if (p.correspondences > 0 && p.state !== PoseState.NO_POSE) {
      const fraction = p.pointsInFront / p.correspondences;
      if (p.state === PoseState.POSE) {
        this.cheiralityFractions.push(fraction);
        trim(this.cheiralityFractions);
      }
    }

    if (p.rotationDeg >= 0) {
      this.rotations.push(p.rotationDeg);
      trim(this.rotations);
      this.compareWithGyro(p, now);
    }
    if (p.reprojectionErrorPx >= 0) {
      this.reprojections.push(p.reprojectionErrorPx);
      trim(this.reprojections);
    }
    if (p.confidence >= 0) {
      this.confidences.push(p.confidence);
      trim(this.confidences);
    }
    if (p.poseMs >= 0) {
      this.poseCosts.push(p.poseMs);
      trim(this.poseCosts);
    }
    if (p.sensitivity) {
      this.sensitivityRotation.push(p.sensitivity.rotationDeg);
      trim(this.sensitivityRotation);
      if (p.sensitivity.translationDeg >= 0) {
        this.sensitivityTranslation.push(p.sensitivity.translationDeg);
        trim(this.sensitivityTranslation);
      }
    }

    if (p.state === PoseState.POSE && p.translation) {
      this.posedFrames++;
      this.directions.push([...p.translation]);
      trim(this.directions);
      if (p.planar) {
        this.planarPosedFrames++;
        this.planarTranslationConfidence.push(p.translationConfidence);
        this.planarUnseparated.push(p.unseparatedCandidates);
        trim(this.planarTranslationConfidence);
        trim(this.planarUnseparated);
        // v3 §16: a planar scene must not have its pose taken from an Essential matrix.
        if (p.source === 'FUNDAMENTAL') this.planarFromEssential++;
        // ...and the penalty can only ever lower. Rounding slack only.
        if (p.translationConfidence > p.rotationConfidence + 1e-6) this.planarTranslationNotLowered++;
      } else {
        this.nonPlanarPosedFrames++;
        this.nonPlanarTranslationConfidence.push(p.translationConfidence);
        this.nonPlanarUnseparated.push(p.unseparatedCandidates);
        trim(this.nonPlanarTranslationConfidence);
        trim(this.nonPlanarUnseparated);
      }
    }

    if (p.injection) {
      const s: PoseInjectionSample = { ...p.injection, at: now };
      this.injections.push(s);
      while (this.injections.length > 40) this.injections.shift();
      if (p.injection.recoveredDeg >= 0) {
        this.injectedDeg.push(p.injection.recoveredDeg);
        trim(this.injectedDeg);
      }
      if (p.injection.controlDeg >= 0) {
        this.controlDeg.push(p.injection.controlDeg);
        trim(this.controlDeg);
      }
      const before = p.injection.inliersBefore;
      if (before > 0) {
        if (p.injection.inliersAfter >= 0) {
          this.injectedDrift.push(Math.abs(p.injection.inliersAfter - before) / before);
          trim(this.injectedDrift);
        }
        if (p.injection.controlInliers >= 0) {
          this.controlDrift.push(Math.abs(p.injection.controlInliers - before) / before);
          trim(this.controlDrift);
        }
      }
      if (p.injection.planarBefore !== p.injection.planarAfter) this.injectionPlanarFlips++;
      if (p.injection.planarBefore !== p.injection.controlPlanar) this.controlPlanarFlips++;
    }
  }

  /**
   * POSE-002 — the visual rotation against the gyroscope's, over the same interval.
   *
   * Angles only. `rotationRate` is in the device's frame and the camera's differs from it by a
   * fixed rotation nobody here has measured; a rotation *angle* is invariant under a change of
   * basis, so this comparison needs no extrinsic calibration while comparing axes would.
   */
  private compareWithGyro(p: PoseReport, now: number): void {
    if (!this.gyroAvailable || this.anchorAt < 0 || this.anchorAt >= now) return;
    const g = integrateRotation(this.gyro, this.anchorAt, now);
    if (g === NO_GYRO_ROTATION || g.samples < MIN_GYRO_SAMPLES || g.netDeg < 0) return;
    // An agreement between two zeros is not an agreement (FLOW-002's criterion 3).
    if (g.netDeg < MIN_COMPARABLE_ROTATION_DEG) return;

    const disagreement = Math.abs(p.rotationDeg - g.netDeg);
    const tolerance = Math.max(ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION * g.netDeg);
    const agreed = disagreement <= tolerance;
    this.rotationComparisons++;

    const sample: RotationAgreementSample = {
      at: now,
      visualDeg: round(p.rotationDeg, 3),
      gyroNetDeg: round(g.netDeg, 3),
      gyroPathDeg: round(g.pathDeg, 3),
      disagreementDeg: round(disagreement, 3),
      toleranceDeg: round(tolerance, 3),
      agreed,
      anchorAgeMs: round(now - this.anchorAt, 1),
      gyroSamples: g.samples,
    };
    this.comparisons.push(sample);
    trim(this.comparisons);
  }

  getLast(): PoseReport | null {
    return this.last;
  }

  /** The shape the Phase 6 suite is evaluated against. */
  stats(running: boolean): PoseStats {
    const p = this.last;
    const stateFrames: Record<string, number> = {};
    for (const [k, n] of this.stateFrames) stateFrames[k] = n;

    return {
      running,
      poseFrames: this.poseFrames,

      state: p?.state ?? PoseState.NO_POSE,
      stateReason: p?.stateReason ?? 'pose recovery has not run',
      source: p?.source ?? null,
      rotationDeg: p?.rotationDeg ?? -1,
      translation: p?.translation ?? null,
      scale: p?.scale ?? 'LOCAL_UNITS',
      planar: p?.planar ?? false,
      ambiguous: p?.ambiguous ?? false,
      pointsInFront: p?.pointsInFront ?? 0,
      correspondences: p?.correspondences ?? 0,
      reprojectionErrorPx: p?.reprojectionErrorPx ?? -1,
      rotationOnlyResidualPx: p?.rotationOnlyResidualPx ?? -1,
      confidence: p?.confidence ?? 0,
      rotationConfidence: p?.rotationConfidence ?? 0,
      translationConfidence: p?.translationConfidence ?? 0,
      confidenceTerms: p?.confidenceTerms ?? [],
      confidenceWithheld: p?.confidenceWithheld ?? [],
      intrinsics: p?.intrinsics ?? null,
      cheirality: p?.cheirality ?? [],
      chosen: p?.chosen ?? -1,
      sensitivity: p?.sensitivity ?? null,

      stateFrames,
      stateMismatches: this.stateMismatches,
      medianRotationDeg: round(median(this.rotations), 3),
      medianReprojectionPx: round(median(this.reprojections), 3),
      medianCheiralityFraction: round(median(this.cheiralityFractions), 4),
      medianConfidence: round(median(this.confidences), 4),
      medianSensitivityRotationDeg: round(median(this.sensitivityRotation), 4),
      medianSensitivityTranslationDeg: round(median(this.sensitivityTranslation), 4),

      posedFrames: this.posedFrames,
      translationSpreadDeg: round(this.directionSpread(), 3),
      ambiguousFrames: this.ambiguousFrames,
      belowCheiralityFraction: this.belowCheiralityFraction,

      gyroAvailable: this.gyroAvailable,
      gyroReason: this.gyroReason,
      // Every figure below is over the retained window, and `rotationSamples` is that window's
      // size — so the rate's denominator is the same set its numerator is counted from.
      rotationSamples: this.comparisons.length,
      rotationComparisons: this.rotationComparisons,
      medianVisualRotationDeg: round(median(this.comparisons.map((c) => c.visualDeg)), 3),
      medianGyroRotationDeg: round(median(this.comparisons.map((c) => c.gyroNetDeg)), 3),
      medianRotationDisagreementDeg: round(median(this.comparisons.map((c) => c.disagreementDeg)), 3),
      rotationAgreementRate:
        this.comparisons.length > 0
          ? round(this.comparisons.filter((c) => c.agreed).length / this.comparisons.length, 4)
          : -1,
      rotationAgreements: this.comparisons.slice(-12),

      planarPosedFrames: this.planarPosedFrames,
      nonPlanarPosedFrames: this.nonPlanarPosedFrames,
      planarFromEssential: this.planarFromEssential,
      medianPlanarTranslationConfidence: round(median(this.planarTranslationConfidence), 4),
      medianNonPlanarTranslationConfidence: round(median(this.nonPlanarTranslationConfidence), 4),
      medianPlanarUnseparated: round(median(this.planarUnseparated), 2),
      medianNonPlanarUnseparated: round(median(this.nonPlanarUnseparated), 2),
      planarTranslationNotLowered: this.planarTranslationNotLowered,

      lowParallaxFrames: this.lowParallaxFrames,
      lowParallaxWithTranslation: this.lowParallaxWithTranslation,
      unverifiedFrames: this.unverifiedFrames,
      unverifiedWithRotation: this.unverifiedWithRotation,

      injectionSamples: this.injectedDeg.length,
      medianInjectedDeg: round(median(this.injectedDeg), 3),
      medianControlDeg: round(median(this.controlDeg), 3),
      requestedInjectionDeg: INJECTED_ROTATION_DEG,
      medianInjectedInlierDrift: round(median(this.injectedDrift), 4),
      medianControlInlierDrift: round(median(this.controlDrift), 4),
      injectionPlanarFlips: this.injectionPlanarFlips,
      controlPlanarFlips: this.controlPlanarFlips,
      injections: this.injections.slice(-12),

      meanPoseMs:
        this.poseCosts.length > 0
          ? round(this.poseCosts.reduce((a, b) => a + b, 0) / this.poseCosts.length)
          : -1,
      poseCostSamples: this.poseCosts.length,

      scaleViolations: this.scaleViolations,
      intrinsicsUnmarked: this.intrinsicsUnmarked,
      reprojectionWithoutTriangulation: this.reprojectionWithoutTriangulation,
      pointsInFrontOverflow: this.pointsInFrontOverflow,
      confidenceAboveWorstTerm: this.confidenceAboveWorstTerm,
      poseWithoutVerdict: this.poseWithoutVerdict,
    };
  }

  /**
   * The angular spread of the recovered translation directions about their own mean.
   *
   * POSE-001's "the pose is not a constant". Deliberately a weak bar and not a strong one: on a
   * straight pan the true direction really is nearly constant, so a large spread cannot be
   * required without failing a correct solver on a straight-line motion. What this catches is a
   * stage returning a *literally* fixed vector; POSE-005 carries the "responds to the
   * computation" burden, with ground truth.
   */
  private directionSpread(): number {
    if (this.directions.length < 2) return -1;
    const mean = [0, 0, 0];
    for (const d of this.directions) {
      // Directions are signed; a two-view translation direction and its negative are different
      // poses, so they are averaged as they are rather than folded onto a half-sphere.
      for (let i = 0; i < 3; i++) mean[i] = (mean[i] ?? 0) + (d[i] ?? 0);
    }
    const len = Math.hypot(mean[0] ?? 0, mean[1] ?? 0, mean[2] ?? 0);
    if (len <= 1e-9) return 180;
    const unit = [(mean[0] ?? 0) / len, (mean[1] ?? 0) / len, (mean[2] ?? 0) / len];
    const angles = this.directions.map((d) => {
      const dot = Math.min(
        1,
        Math.max(-1, (d[0] ?? 0) * (unit[0] ?? 0) + (d[1] ?? 0) * (unit[1] ?? 0) + (d[2] ?? 0) * (unit[2] ?? 0)),
      );
      return (Math.acos(dot) * 180) / Math.PI;
    });
    return median(angles);
  }

  describe(): Record<string, JsonValue> {
    const s = this.stats(false);
    return toJsonSafe({
      poseFrames: s.poseFrames,
      current: {
        state: s.state,
        reason: s.stateReason,
        source: s.source,
        rotationDeg: s.rotationDeg,
        translation: s.translation as unknown as JsonValue,
        scale: s.scale,
        confidence: s.confidence,
        rotationConfidence: s.rotationConfidence,
        translationConfidence: s.translationConfidence,
        terms: s.confidenceTerms as unknown as JsonValue,
        withheld: s.confidenceWithheld as unknown as JsonValue,
        cheirality: s.cheirality as unknown as JsonValue,
      },
      intrinsics: {
        ...(s.intrinsics as unknown as Record<string, JsonValue>),
        note:
          'v3 §15: INTRINSICS: ESTIMATED. Safari exposes no focal length, so K is derived from ' +
          'an assumed field of view and every record says so. §H.0 is why it is recomputed per ' +
          'frame rather than read once: rotating the device swaps the frame dimensions on the ' +
          'same track, and fx, fy, cx, cy all change with them.',
      },
      overRun: {
        stateFrames: s.stateFrames as unknown as JsonValue,
        stateMismatches: s.stateMismatches,
        medianRotationDeg: s.medianRotationDeg,
        medianReprojectionPx: s.medianReprojectionPx,
        medianCheiralityFraction: s.medianCheiralityFraction,
        medianConfidence: s.medianConfidence,
        posedFrames: s.posedFrames,
        translationSpreadDeg: s.translationSpreadDeg,
        ambiguousFrames: s.ambiguousFrames,
      },
      sensitivity: {
        focalFactor: INTRINSICS_SENSITIVITY,
        medianRotationDeg: s.medianSensitivityRotationDeg,
        medianTranslationDeg: s.medianSensitivityTranslationDeg,
        note:
          'How far the pose moves when the assumed focal length is scaled by ±20%. This is the ' +
          'other half of being allowed to say INTRINSICS: ESTIMATED — a quantity that barely ' +
          'moves does not depend on the guess, and one that moves does.',
      },
      gyroscope: {
        available: s.gyroAvailable,
        reason: s.gyroReason,
        samples: s.rotationSamples,
        comparisonsMade: s.rotationComparisons,
        medianVisualDeg: s.medianVisualRotationDeg,
        medianGyroDeg: s.medianGyroRotationDeg,
        medianDisagreementDeg: s.medianRotationDisagreementDeg,
        agreementRate: s.rotationAgreementRate,
        recent: s.rotationAgreements as unknown as JsonValue,
        note:
          'POSE-002. The gyroscope is an instrument here and never an input: v3 §19 lists IMU ' +
          'consistency among the confidence terms and Phase 6 withholds it on purpose, because ' +
          'a confidence that consumed the gyroscope could not then be checked against it. ' +
          'Angles only — rotationRate is in the device frame and the camera frame differs by a ' +
          'fixed rotation nobody has measured; an angle is invariant under that, an axis is not.',
      },
      planarHandling: {
        planarPosedFrames: s.planarPosedFrames,
        nonPlanarPosedFrames: s.nonPlanarPosedFrames,
        planarFromEssential: s.planarFromEssential,
        medianPlanarTranslationConfidence: s.medianPlanarTranslationConfidence,
        medianNonPlanarTranslationConfidence: s.medianNonPlanarTranslationConfidence,
        medianPlanarUnseparated: s.medianPlanarUnseparated,
        medianNonPlanarUnseparated: s.medianNonPlanarUnseparated,
        planarTranslationNotLowered: s.planarTranslationNotLowered,
        note:
          'v3 §16. A planar scene is decomposed from the homography, never the Essential matrix, ' +
          'and its translation confidence is lowered by the number of candidates cheirality ' +
          'could not separate — generically two on a plane, so 1/2. Counted, not assumed. The ' +
          'two confidence medians are reported and NOT compared across classes: each is a ' +
          'minimum over several terms, and on a frame with a thin population the binding term ' +
          'is not the planar one, so the cross-class comparison measures the population rather ' +
          'than v3 §16. The candidate counts beside them are what the penalty is made of.',
      },
      failClosed: {
        lowParallaxFrames: s.lowParallaxFrames,
        lowParallaxWithTranslation: s.lowParallaxWithTranslation,
        unverifiedFrames: s.unverifiedFrames,
        unverifiedWithRotation: s.unverifiedWithRotation,
        note:
          'POSE-004. A camera that turned without moving produces large, well-conditioned image ' +
          'motion and no translation at all; the direction fitted to it would be noise with a ' +
          'unit length. Decided from the correspondences — what rotation alone leaves ' +
          'unexplained — rather than from the decomposition.',
      },
      injectedRotation: {
        samples: s.injectionSamples,
        requestedDeg: s.requestedInjectionDeg,
        medianRecoveredDeg: s.medianInjectedDeg,
        medianControlDeg: s.medianControlDeg,
        medianInlierDrift: s.medianInjectedInlierDrift,
        medianControlInlierDrift: s.medianControlInlierDrift,
        planarFlips: s.injectionPlanarFlips,
        controlPlanarFlips: s.controlPlanarFlips,
        recent: s.injections as unknown as JsonValue,
        note:
          'POSE-005, and the one number in this phase a stage returning a constant pose cannot ' +
          'produce — it scores exactly 0.00° while satisfying every other numeric criterion. ' +
          'The harness applies K Rj K^-1 to the second view, which is exactly the camera having ' +
          'turned by Rj, and re-runs the whole chain on a set handed over unmarked. The control ' +
          'is the same set unmodified: without it a solver returning noise would also pass.',
      },
      cost: { meanPoseMs: s.meanPoseMs, samples: s.poseCostSamples },
      integrity: {
        scaleViolations: s.scaleViolations,
        intrinsicsUnmarked: s.intrinsicsUnmarked,
        reprojectionWithoutTriangulation: s.reprojectionWithoutTriangulation,
        pointsInFrontOverflow: s.pointsInFrontOverflow,
        confidenceAboveWorstTerm: s.confidenceAboveWorstTerm,
        poseWithoutVerdict: s.poseWithoutVerdict,
      },
    }) as Record<string, JsonValue>;
  }
}
