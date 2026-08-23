/**
 * Pose confidence (v3 §19), and the one input it deliberately refuses.
 *
 * v3 lists seven candidates:
 *
 * > inlier ratio / reprojection error / tracked feature count / feature distribution /
 * > **IMU consistency** / temporal stability / model consistency
 *
 * Six are used. **`IMU consistency` is not**, and its absence is reported beside the six that
 * are, because it is the instrument POSE-002 scores this phase with: a confidence that consumed
 * the gyroscope could not then be checked against it (§H.7). Phase 7 is where the IMU becomes an
 * input rather than a witness, and that is the phase to add the seventh term in.
 *
 * ## Minimum, not average
 *
 * v3 §19 closes with a prohibition — 不確実なPoseは強制的に高confidenceにしない — and an average
 * is precisely how an uncertain pose acquires a high confidence: five comfortable terms carry one
 * bad one and the number comes out reassuring. The combination is the **minimum**, so the
 * confidence is never better than its worst-supported term, and every term is reported by name
 * and value so the number can be taken apart.
 *
 * ## Rotation and translation are separate numbers
 *
 * v3 §16 does not say "lower confidence" on a planar scene. It says **Translation confidence を
 * 低下させる** — the rotation off a plane is fine, it is the translation that is degenerate. So
 * there are two figures, and the planar penalty applies to one of them.
 *
 * And the penalty is *counted*, not chosen: a homography decomposition leaves a genuine two-fold
 * ambiguity that two views cannot resolve, so where cheirality could not separate `k` candidates
 * the translation is one of `k` equally supported answers and its confidence is multiplied by
 * `1/k`. On a plane that is generically 0.5 — literally a coin toss between the two survivors —
 * and on a scene with depth it is 1. Nothing is assumed about planes; the candidates are counted.
 */

import { DEGRADED_FEATURES, GOOD_FEATURES } from './trackingState';
import {
  GOOD_INLIER_RATIO,
  USABLE_INLIER_RATIO,
  DEGENERATE_SPREAD_PX,
} from '../geometry/verify';
import { MAX_REPROJECTION_PX } from '../geometry/pose';

/** Above this much frame-to-frame change in the recovered rotation, stability is scored zero. */
export const STABILITY_JUMP_DEG = 15.0;

export interface ConfidenceInput {
  readonly inlierRatio: number;
  /** `-1` where nothing was triangulated; the term is then withheld rather than scored as good. */
  readonly reprojectionErrorPx: number;
  readonly trackedFeatures: number;
  /** The inlier set's spatial spread, level-0 px. */
  readonly spreadPx: number;
  /** How far this frame's rotation moved from the previous one's, degrees. `-1` on the first. */
  readonly rotationJumpDeg: number;
  /** Candidates cheirality could not separate. `1` means the pose is the only one supported. */
  readonly unseparatedCandidates: number;
  readonly planar: boolean;
  /** The frame's largest dimension, for scaling the spread term to the image rather than to px. */
  readonly frameSpanPx: number;
}

export interface ConfidenceTerm {
  readonly name: string;
  /** `0..1`, or `-1` when the term could not be measured on this frame. */
  readonly value: number;
  readonly note: string;
}

export interface PoseConfidence {
  readonly rotation: number;
  readonly translation: number;
  /** The lower of the two — what a consumer that needs both should read. */
  readonly overall: number;
  readonly terms: readonly ConfidenceTerm[];
  /** Named so the omission reads as a decision. */
  readonly withheld: readonly string[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Linear ramp from `lo` (0) to `hi` (1), clamped. `lo > hi` ramps downward. */
function ramp(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

export function poseConfidence(input: ConfidenceInput): PoseConfidence {
  const terms: ConfidenceTerm[] = [];

  terms.push({
    name: 'inlierRatio',
    value: ramp(input.inlierRatio, USABLE_INLIER_RATIO, GOOD_INLIER_RATIO),
    note: `${round(input.inlierRatio)} against v3 §14's ${USABLE_INLIER_RATIO} usable / ${GOOD_INLIER_RATIO} good`,
  });

  terms.push(
    input.reprojectionErrorPx < 0
      ? {
          name: 'reprojectionError',
          value: -1,
          note: 'nothing was triangulated on this frame, so there is no residual to score — the ' +
            'term is withheld rather than counted as good',
        }
      : {
          name: 'reprojectionError',
          value: ramp(input.reprojectionErrorPx, MAX_REPROJECTION_PX, 0),
          note: `${round(input.reprojectionErrorPx)} px against §33's ${MAX_REPROJECTION_PX} px`,
        },
  );

  terms.push({
    name: 'trackedFeatures',
    value: ramp(input.trackedFeatures, DEGRADED_FEATURES, GOOD_FEATURES),
    note: `${input.trackedFeatures} against §11's ${DEGRADED_FEATURES} degraded / ${GOOD_FEATURES} good`,
  });

  // Scaled to the frame rather than to a pixel count, so it means the same thing at every tier.
  const spreadTarget = Math.max(DEGENERATE_SPREAD_PX * 2, input.frameSpanPx * 0.25);
  terms.push({
    name: 'featureDistribution',
    value: ramp(input.spreadPx, DEGENERATE_SPREAD_PX, spreadTarget),
    note: `${round(input.spreadPx)} px spread against ${round(spreadTarget)} px, a quarter of the frame`,
  });

  terms.push(
    input.rotationJumpDeg < 0
      ? {
          name: 'temporalStability',
          value: -1,
          note: 'no previous pose to compare against yet',
        }
      : {
          name: 'temporalStability',
          value: ramp(input.rotationJumpDeg, STABILITY_JUMP_DEG, 0),
          note: `${round(input.rotationJumpDeg)}° from the previous frame's rotation`,
        },
  );

  const k = Math.max(1, Math.round(input.unseparatedCandidates));
  terms.push({
    name: 'modelConsistency',
    value: 1 / k,
    note:
      k === 1
        ? 'cheirality left exactly one candidate standing'
        : `${k} candidates were equally supported and two views cannot separate them — the ` +
          `translation is one of ${k} answers, so this term is 1/${k}. v3 §16's "Translation ` +
          'confidenceを低下させる", counted rather than assumed',
  });

  const measured = (name: string): number => {
    const t = terms.find((x) => x.name === name);
    return t && t.value >= 0 ? t.value : 1;
  };
  // A withheld term does not drag the minimum down — it is absent, not bad — but it is named.
  const rotation = Math.min(
    measured('inlierRatio'),
    measured('reprojectionError'),
    measured('trackedFeatures'),
    measured('featureDistribution'),
    measured('temporalStability'),
  );
  const translation = Math.min(rotation, measured('modelConsistency'));

  return {
    rotation: round(rotation),
    translation: round(translation),
    overall: round(Math.min(rotation, translation)),
    terms: terms.map((t) => ({ ...t, value: t.value < 0 ? -1 : round(t.value) })),
    withheld: [
      'IMUConsistency — v3 §19 lists it, and Phase 6 withholds it on purpose: it is the ' +
        'instrument POSE-002 scores this phase against, and a confidence that consumed the ' +
        'gyroscope could not then be checked against it (§H.7). Phase 7 adds it.',
      ...(input.planar && Math.round(input.unseparatedCandidates) <= 1
        ? [
            'the planar penalty did not apply on this frame: the scene is planar but cheirality ' +
              'still left one candidate standing, so there was nothing to halve',
          ]
        : []),
    ],
  };
}

function round(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x;
}
