/**
 * Geometric verification of a correspondence set (Phase 5 — v3 §14, §16).
 *
 * One frame pair in, one verdict out. Both models of `twoView.ts` are fitted with the same
 * RANSAC driver and the same threshold, the better-supported one is selected, v3 §16's planar
 * comparison is recorded, and the state is derived from the measurements in one place.
 *
 * **What this does not do.** It produces no pose: `Pose candidate` is the last step of v3 §14's
 * chain and it belongs to §15, which is Phase 6. It uses no camera intrinsics, which is what
 * lets it run before Phase 6 exists. And it never returns its input unchanged — a verification
 * that accepts everything is what "not verifying" looks like, and it is the failure GEO-003
 * exists to catch.
 *
 * Pure array arithmetic plus an injected `Rng`: no DOM, no worker, no camera, no clock.
 */

import { Rng } from '../core/Rng';
import { ransac } from './ransac';
import {
  FUNDAMENTAL_SAMPLE,
  GeometricModel,
  HOMOGRAPHY_SAMPLE,
  fitFundamental,
  fitHomography,
  makeHomographyError,
  sampsonDistanceSq,
} from './twoView';
import type { Correspondence } from './twoView';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase5/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/** v3 §14: 最低inliers = 30. */
export const MIN_INLIERS = 30;
/** v3 §14: GOOD candidate > 100. */
export const GOOD_INLIERS = 100;
/** v3 §14: usable inlier ratio > 0.35. */
export const USABLE_INLIER_RATIO = 0.35;
/** v3 §14: GOOD inlier ratio > 0.50. */
export const GOOD_INLIER_RATIO = 0.5;

/**
 * The inlier threshold, in pixels.
 *
 * §13's acceptable forward/backward band, reused rather than invented. A correspondence's own
 * positional uncertainty is what §13 already quantifies — at or under 1.5 px the round trip is
 * *acceptable* — and a geometric residual smaller than the positional noise cannot be
 * distinguished from it. §H.6's rule: prefer a constant the plan has already fixed for another
 * purpose over a new one.
 */
export const RANSAC_THRESHOLD_PX = 1.5;

/**
 * The least median displacement a frame pair needs before it can be verified at all.
 *
 * Ten times `RANSAC_THRESHOLD_PX`. A two-view model can only be recovered when the signal — the
 * displacement between the views — is well above the noise in each measurement, and ten times
 * is the conventional margin for calling a measurement signal-dominated. Expressing it as a
 * multiple of §13's band ties it to the one number this project has for correspondence
 * uncertainty rather than to a guess about scenes.
 *
 * Below it the answer is `UNVERIFIED`, not a high inlier ratio: with zero displacement every
 * model fits perfectly and the ratio is exactly 1.00, which is what a phone lying on a desk
 * produces and is not a verification of anything.
 */
export const MIN_BASELINE_PX = 15.0;

/** Below this an eight-point model has almost no redundancy left to be checked against. */
export const MIN_CORRESPONDENCES = 20;

export const RANSAC_CONFIDENCE = 0.99;
export const MAX_RANSAC_ITERATIONS = 500;

/**
 * Inliers whose spatial spread is under this describe a point, not a scene.
 *
 * A model fitted to a tight cluster explains that cluster and nothing else, and its inlier
 * ratio can be 1.00 while the geometry is undetermined everywhere else in the frame. Measured
 * as the mean distance of the inliers from their own centroid, in level-0 pixels.
 */
export const DEGENERATE_SPREAD_PX = 20.0;

/**
 * The share of the two models' combined support the homography needs to win v3 §16.
 *
 * v3 §16 says to flag `PLANAR SCENE` "where the Homography wins". The obvious reading —
 * `hCount >= fCount`, the homography admitting at least as many correspondences — is the
 * reading this file shipped first, and **it is wrong in exactly the case §16 exists for.**
 *
 * The asymmetry that makes it wrong is the one written into this file from the start: `F` is
 * the weaker constraint. A correspondence has two measured degrees of freedom; `H` pins both,
 * while `F` pins only the component perpendicular to the epipolar line. So `F`'s acceptance
 * region is a strip across the frame where `H`'s is a disc, and `F` admits stray
 * correspondences at a far higher rate. On a *planar* scene it is worse than that: `F` is not
 * determined at all there — every `[e]ₓH` is consistent with the data for any epipole `e` —
 * so RANSAC has two free parameters that the correct correspondences do not constrain, and it
 * spends them on whatever else is in the set.
 *
 * Measured, on a synthetic plane with 30% of its targets displaced 25 px
 * (`tests/unit/verification.test.ts`, "a plane with outliers"): the homography admits
 * **exactly the untouched correspondences and not one outlier**, 70 of 100; the fundamental
 * matrix admits 74 to 77 — the same 70, plus four to seven of the outliers it captured with
 * its free epipole. Under `hCount >= fCount` that reads as a non-planar scene, the degenerate
 * model is selected, and those outliers survive as inliers. That is the failure v3 §16 is
 * written to prevent, produced by the test for it.
 *
 * So the comparison is made on the share of combined support rather than on which raw count is
 * larger: `hCount / (hCount + fCount) > 0.45`. The threshold is ORB-SLAM's (Mur-Artal, Montiel
 * & Tardós 2015), whose initialiser makes this identical choice between `H` and `F` and picks
 * the homography at `R_H > 0.45`. Two differences are worth stating rather than glossing: that
 * work compares robust *score sums* where this compares inlier counts, which is the coarser
 * statistic; and it uses the ratio to pick an initialisation method where §16 uses it to lower
 * translation confidence in Phase 6. What carries over is the shape of the comparison and the
 * reason for it, which is that a model with a whole free dimension per point cannot be judged
 * against one without it by counting.
 *
 * On the same measurements the two cases separate with room on both sides: a plane scores
 * 0.476–0.486, a two-depth scene 0.400–0.415, and a clean plane scores exactly 0.500.
 */
export const PLANAR_H_SHARE = 0.45;

/**
 * The same rule, as one function, because three places need it and they must not drift.
 *
 * `verify.ts` decides it, `VerificationSession` re-derives it to check that the flag on a
 * frame follows from the two counts beside it (GEO-004), and the unit tests assert on it. A
 * re-derivation that reimplemented the rule would be checking one implementation against
 * another rather than checking the flag against its inputs.
 */
export function isPlanarByCounts(fundamentalInliers: number, homographyInliers: number): boolean {
  const total = fundamentalInliers + homographyInliers;
  if (homographyInliers <= 0 || total <= 0) return false;
  return homographyInliers / total > PLANAR_H_SHARE;
}

/**
 * §14's verdict for one frame pair, as a pure function of the measurements below.
 *
 * Named for what v3 §14 calls them: an inlier set is *usable* above its ratio and count, and a
 * *GOOD candidate* above the higher pair. `UNVERIFIED` is everything else, and it is a real
 * answer rather than a failure — §44's fail-closed rule in v4's direction says the same thing:
 * when the information is not there, lower the state rather than making the result convenient.
 */
export const VerificationState = {
  UNVERIFIED: 'UNVERIFIED',
  USABLE: 'USABLE',
  GOOD: 'GOOD',
} as const;
export type VerificationState = (typeof VerificationState)[keyof typeof VerificationState];

export interface VerificationMeasurement {
  readonly correspondences: number;
  readonly baselinePx: number;
  readonly inliers: number;
  readonly inlierRatio: number;
  readonly spreadPx: number;
}

export interface VerificationVerdict {
  readonly state: VerificationState;
  readonly reason: string;
  /** Which of v3 §14's conditions a `GOOD` verdict is missing, named. */
  readonly goodBlockedBy: readonly string[];
}

/**
 * v3 §14's thresholds, applied in one place.
 *
 * The same discipline as §33's tracking state: the screen displays what this returned, and the
 * statistics recompute it from the reported inputs and count any frame where the two differ.
 * A state that is *assigned* can disagree with the numbers beside it; one that is *derived*
 * cannot without the counter noticing.
 */
export function deriveVerificationState(m: VerificationMeasurement): VerificationVerdict {
  const goodBlockedBy: string[] = [];
  if (m.inliers < GOOD_INLIERS) goodBlockedBy.push(`inliers ${m.inliers} <= ${GOOD_INLIERS}`);
  if (m.inlierRatio < GOOD_INLIER_RATIO) {
    goodBlockedBy.push(`inlier ratio ${round(m.inlierRatio, 3)} <= ${GOOD_INLIER_RATIO}`);
  }

  if (m.correspondences < MIN_CORRESPONDENCES) {
    return {
      state: VerificationState.UNVERIFIED,
      reason:
        `${m.correspondences} correspondence(s), below the ${MIN_CORRESPONDENCES} an ` +
        'eight-point model needs before there is any redundancy left to check it against',
      goodBlockedBy,
    };
  }
  if (m.baselinePx < MIN_BASELINE_PX) {
    return {
      state: VerificationState.UNVERIFIED,
      reason:
        `the two views are ${round(m.baselinePx, 2)} px apart, under the ${MIN_BASELINE_PX} px ` +
        'a two-view geometry needs. Every model fits a motionless pair perfectly, so a high ' +
        'inlier ratio here would verify nothing',
      goodBlockedBy,
    };
  }
  if (m.inliers < MIN_INLIERS) {
    return {
      state: VerificationState.UNVERIFIED,
      reason: `${m.inliers} inlier(s), below v3 §14's minimum of ${MIN_INLIERS}`,
      goodBlockedBy,
    };
  }
  if (m.inlierRatio < USABLE_INLIER_RATIO) {
    return {
      state: VerificationState.UNVERIFIED,
      reason:
        `inlier ratio ${round(m.inlierRatio, 3)} is below v3 §14's usable ` +
        `${USABLE_INLIER_RATIO} — most of what was tracked does not agree on one motion`,
      goodBlockedBy,
    };
  }
  if (m.spreadPx < DEGENERATE_SPREAD_PX) {
    return {
      state: VerificationState.UNVERIFIED,
      reason:
        `the inliers are spread ${round(m.spreadPx, 2)} px about their own centroid, under ` +
        `${DEGENERATE_SPREAD_PX} px — a model fitted to a cluster that tight explains the ` +
        'cluster and leaves the geometry undetermined everywhere else in the frame',
      goodBlockedBy,
    };
  }
  if (goodBlockedBy.length === 0) {
    return {
      state: VerificationState.GOOD,
      reason:
        `${m.inliers} inliers at ratio ${round(m.inlierRatio, 3)} — both of v3 §14's GOOD ` +
        'conditions met',
      goodBlockedBy,
    };
  }
  return {
    state: VerificationState.USABLE,
    reason:
      `${m.inliers} inliers at ratio ${round(m.inlierRatio, 3)}, over v3 §14's usable ` +
      `${MIN_INLIERS}/${USABLE_INLIER_RATIO}. Not GOOD: ${goodBlockedBy.join('; ')}`,
    goodBlockedBy,
  };
}

export interface VerificationResult {
  readonly state: VerificationState;
  readonly reason: string;
  readonly goodBlockedBy: readonly string[];
  readonly correspondences: number;
  readonly baselinePx: number;
  /** The selected model, or `null` when nothing could be fitted. */
  readonly model: GeometricModel | null;
  readonly matrix: readonly number[] | null;
  readonly inliers: readonly number[];
  readonly outliers: readonly number[];
  readonly inlierCount: number;
  readonly inlierRatio: number;
  /** Both counts, so v3 §16's decision is auditable rather than asserted. */
  readonly fundamentalInliers: number;
  readonly homographyInliers: number;
  /** v3 §16: the homography explains the scene at least as well. Phase 6 lowers translation confidence. */
  readonly planar: boolean;
  readonly spreadPx: number;
  readonly degenerate: boolean;
  readonly meanErrorPx: number;
  readonly iterations: number;
  readonly terminatedEarly: boolean;
  readonly seed: number;
}

const NOTHING_FITTED = (
  correspondences: number,
  baselinePx: number,
  seed: number,
  reason: string,
): VerificationResult => ({
  state: VerificationState.UNVERIFIED,
  reason,
  goodBlockedBy: ['no model could be fitted'],
  correspondences,
  baselinePx: round(baselinePx, 3),
  // A frame that verified nothing carries no model. GEO-006 checks that it is absent rather
  // than present with a note attached.
  model: null,
  matrix: null,
  inliers: [],
  outliers: Array.from({ length: correspondences }, (_, i) => i),
  inlierCount: 0,
  inlierRatio: 0,
  fundamentalInliers: 0,
  homographyInliers: 0,
  planar: false,
  spreadPx: 0,
  degenerate: true,
  meanErrorPx: -1,
  iterations: 0,
  terminatedEarly: false,
  seed,
});

/**
 * Verify one correspondence set.
 *
 * `seed` makes the run replayable: the same correspondences and the same seed give the same
 * inlier set, which is what lets a questioned result be re-examined rather than re-argued.
 */
export function verifyCorrespondences(
  points: readonly Correspondence[],
  seed: number,
): VerificationResult {
  const n = points.length;
  const baselinePx = medianBaseline(points);

  if (n < MIN_CORRESPONDENCES) {
    return NOTHING_FITTED(
      n,
      baselinePx,
      seed,
      `${n} correspondence(s), below the ${MIN_CORRESPONDENCES} needed to fit anything worth ` +
        'checking',
    );
  }

  // Both models get their own generator from the same seed, so neither is advantaged by the
  // order they happen to run in, and both see the same sequence of samples for a given set.
  const fundamental = ransac(
    n,
    {
      sampleSize: FUNDAMENTAL_SAMPLE,
      thresholdPx: RANSAC_THRESHOLD_PX,
      confidence: RANSAC_CONFIDENCE,
      maxIterations: MAX_RANSAC_ITERATIONS,
    },
    new Rng(seed),
    (idx) => fitFundamental(points, idx),
    (model, i) => {
      const c = points[i];
      return c ? sampsonDistanceSq(model, c) : Number.POSITIVE_INFINITY;
    },
  );

  // v3 §16: fitted on every judged frame, never skipped as an optimisation. Skipping it is
  // exactly what hides a planar scene, and a planar scene decomposed as an Essential matrix
  // gives a degenerate pose that looks entirely reasonable.
  const homography = ransac(
    n,
    {
      sampleSize: HOMOGRAPHY_SAMPLE,
      thresholdPx: RANSAC_THRESHOLD_PX,
      confidence: RANSAC_CONFIDENCE,
      maxIterations: MAX_RANSAC_ITERATIONS,
    },
    new Rng(seed ^ 0x5f37_1d0b),
    (idx) => fitHomography(points, idx),
    (model, i) => {
      const c = points[i];
      if (!c) return Number.POSITIVE_INFINITY;
      const err = makeHomographyError(model);
      return err ? err(c) : Number.POSITIVE_INFINITY;
    },
  );

  const fCount = fundamental?.inliers.length ?? 0;
  const hCount = homography?.inliers.length ?? 0;
  if (!fundamental && !homography) {
    return NOTHING_FITTED(
      n,
      baselinePx,
      seed,
      'neither a fundamental matrix nor a homography could be fitted to these correspondences',
    );
  }

  // `F` is the weaker constraint — it pins one of a correspondence's two degrees of freedom
  // where `H` pins both — and on a plane it is not determined at all, so it admits `H`'s
  // inliers plus whatever its free epipole can reach. Comparing raw counts hands it the
  // decision every time. See PLANAR_H_SHARE for the measurement that established this.
  const planar = isPlanarByCounts(fCount, hCount);
  const useHomography = planar && homography !== null;
  const chosen = useHomography ? homography : (fundamental ?? homography);
  if (!chosen) {
    return NOTHING_FITTED(n, baselinePx, seed, 'no model survived selection');
  }

  const inliers = chosen.inliers;
  const spreadPx = spreadOf(points, inliers);
  const measurement: VerificationMeasurement = {
    correspondences: n,
    baselinePx,
    inliers: inliers.length,
    inlierRatio: chosen.inlierRatio,
    spreadPx,
  };
  const verdict = deriveVerificationState(measurement);
  // A frame that did not verify hands nothing forward. The *measurements* stay — the inlier
  // counts, both models' support, the spread — because they are what make the frame
  // diagnosable; what is withheld is the product, the model itself. GEO-006 checks exactly
  // this, and it caught the first version of this function returning a fitted matrix beside
  // a verdict of `UNVERIFIED`, which is a model with a note attached.
  const verified = verdict.state !== VerificationState.UNVERIFIED;

  return {
    state: verdict.state,
    reason: verdict.reason,
    goodBlockedBy: verdict.goodBlockedBy,
    correspondences: n,
    baselinePx: round(baselinePx, 3),
    model: verified
      ? useHomography
        ? GeometricModel.HOMOGRAPHY
        : GeometricModel.FUNDAMENTAL
      : null,
    matrix: verified ? chosen.model : null,
    inliers,
    outliers: chosen.outliers,
    inlierCount: inliers.length,
    inlierRatio: round(chosen.inlierRatio, 4),
    fundamentalInliers: fCount,
    homographyInliers: hCount,
    planar,
    spreadPx: round(spreadPx, 3),
    degenerate: spreadPx < DEGENERATE_SPREAD_PX,
    meanErrorPx: Number.isFinite(chosen.meanSquaredError)
      ? round(Math.sqrt(chosen.meanSquaredError), 4)
      : -1,
    iterations: chosen.iterations,
    terminatedEarly: chosen.terminatedEarly,
    seed,
  };
}

/** Median displacement between the two views, level-0 px. The baseline the model rests on. */
export function medianBaseline(points: readonly Correspondence[]): number {
  if (points.length === 0) return 0;
  const d = points.map((c) => Math.hypot(c.bx - c.ax, c.by - c.ay)).sort((a, b) => a - b);
  const mid = d.length >> 1;
  return d.length % 2 ? (d[mid] ?? 0) : (((d[mid - 1] ?? 0) + (d[mid] ?? 0)) / 2);
}

/** Mean distance of the inliers from their own centroid, in the first view. */
function spreadOf(points: readonly Correspondence[], inliers: readonly number[]): number {
  if (inliers.length === 0) return 0;
  let cx = 0;
  let cy = 0;
  for (const i of inliers) {
    cx += points[i]?.ax ?? 0;
    cy += points[i]?.ay ?? 0;
  }
  cx /= inliers.length;
  cy /= inliers.length;
  let sum = 0;
  for (const i of inliers) {
    sum += Math.hypot((points[i]?.ax ?? 0) - cx, (points[i]?.ay ?? 0) - cy);
  }
  return sum / inliers.length;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}
