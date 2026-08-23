/**
 * Everything Phase 5 needs to answer GEO-001..006, accumulated across a run.
 *
 * Runs on the main thread and takes the message shape rather than the verifier's own, because
 * the message is all that crossed. Nothing here recomputes anything the worker measured — with
 * three deliberate exceptions, and each is a Rule 002 check rather than a calculation:
 *
 *  - **v3 §14's state is recomputed** from the inputs the worker reported, and every frame where
 *    the two answers differ is counted. A state that is assigned can disagree with the numbers
 *    beside it; one that is derived cannot without the counter noticing.
 *  - **v3 §16's planar flag is recomputed** from the two inlier counts, for the same reason.
 *    GEO-004 requires the decision to be auditable rather than asserted, and this is what makes
 *    it so.
 *  - **The partition is checked**: inliers plus outliers must equal the correspondence count.
 *    A verifier that lost or duplicated a correspondence would otherwise be invisible.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { SceneTexture } from './featureTypes';
import {
  MIN_BASELINE_PX,
  MIN_CORRESPONDENCES,
  isPlanarByCounts,
  VerificationState,
  deriveVerificationState,
} from '../geometry/verify';
import type { TrackingResult, VerificationReport } from './trackingMessages';
import { EMPTY_VERIFICATION_CLASS } from './verificationStats';
import type {
  InjectionSample,
  VerificationClassStats,
  VerificationStats,
} from './verificationStats';

const MAX_SAMPLES = 400;

interface ClassAccumulator {
  frames: number;
  judged: number;
  correspondences: number[];
  inliers: number[];
  ratio: number[];
  baseline: number[];
  spread: number[];
  unverified: number;
  usable: number;
  good: number;
}

function newClass(): ClassAccumulator {
  return {
    frames: 0, judged: 0, correspondences: [], inliers: [], ratio: [], baseline: [], spread: [],
    unverified: 0, usable: 0, good: 0,
  };
}

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

function trim(list: number[], max = MAX_SAMPLES): void {
  while (list.length > max) list.shift();
}

export class VerificationSession {
  private readonly byTexture = new Map<SceneTexture, ClassAccumulator>();
  private readonly inliers: number[] = [];
  private readonly ratios: number[] = [];
  private readonly baselines: number[] = [];
  private readonly spreads: number[] = [];
  private readonly correspondences: number[] = [];
  private readonly verifyCosts: number[] = [];
  private readonly fundamentalInliers: number[] = [];
  private readonly homographyInliers: number[] = [];
  private readonly injectedRecall: number[] = [];
  private readonly cleanRejection: number[] = [];
  private readonly survivingInliers: number[] = [];
  private readonly injections: InjectionSample[] = [];
  private readonly stateFrames = new Map<string, number>();

  private verifiedFrames = 0;
  private judgedFrames = 0;
  private stateMismatches = 0;
  private planarMismatches = 0;
  private reAnchors = 0;
  private bothModelsFitted = 0;
  private planarFrames = 0;
  private nonPlanarFrames = 0;
  private cappedFrames = 0;
  private degenerateFrames = 0;
  private partitionFaults = 0;
  private modelWithoutVerdict = 0;
  private last: VerificationReport | null = null;

  reset(): void {
    this.byTexture.clear();
    for (const l of [
      this.inliers, this.ratios, this.baselines, this.spreads, this.correspondences,
      this.verifyCosts, this.fundamentalInliers, this.homographyInliers,
      this.injectedRecall, this.cleanRejection, this.survivingInliers,
    ]) l.length = 0;
    this.injections.length = 0;
    this.stateFrames.clear();
    this.verifiedFrames = 0;
    this.judgedFrames = 0;
    this.stateMismatches = 0;
    this.planarMismatches = 0;
    this.reAnchors = 0;
    this.bothModelsFitted = 0;
    this.planarFrames = 0;
    this.nonPlanarFrames = 0;
    this.cappedFrames = 0;
    this.degenerateFrames = 0;
    this.partitionFaults = 0;
    this.modelWithoutVerdict = 0;
    this.last = null;
  }

  /** Fold one frame's Phase 5 result into the run. `now` is the main thread's clock. */
  record(result: TrackingResult, now: number): void {
    const v = result.verification;
    if (!v) return;
    this.verifiedFrames++;
    this.last = v;
    if (v.reAnchored) this.reAnchors++;

    this.stateFrames.set(v.state, (this.stateFrames.get(v.state) ?? 0) + 1);

    // Rule 002, on v3 §14's thresholds. The screen shows what the worker computed; if the two
    // ever differ, something derived the state somewhere other than the one function allowed to.
    const recomputed = deriveVerificationState({
      correspondences: v.correspondences,
      baselinePx: v.baselinePx,
      inliers: v.inliers,
      inlierRatio: v.inlierRatio,
      spreadPx: v.spreadPx,
    }).state;
    if (recomputed !== v.state) this.stateMismatches++;

    // ...and on v3 §16's flag, which GEO-004 requires to follow from the two counts beside it.
    // The rule itself comes from `verify.ts` rather than being restated here: a re-derivation
    // that reimplemented it would be checking one implementation against another.
    const recomputedPlanar = isPlanarByCounts(v.fundamentalInliers, v.homographyInliers);
    if (recomputedPlanar !== v.planar) this.planarMismatches++;

    if (v.inliers + v.outliers !== v.correspondences) this.partitionFaults++;
    if (v.state === VerificationState.UNVERIFIED && v.model !== null) this.modelWithoutVerdict++;
    if (v.degenerate) this.degenerateFrames++;
    if (!v.terminatedEarly && v.iterations > 0) this.cappedFrames++;

    if (v.fundamentalInliers > 0 && v.homographyInliers > 0) {
      this.bothModelsFitted++;
      this.fundamentalInliers.push(v.fundamentalInliers);
      this.homographyInliers.push(v.homographyInliers);
      trim(this.fundamentalInliers);
      trim(this.homographyInliers);
      if (v.planar) this.planarFrames++;
      else this.nonPlanarFrames++;
    }

    this.correspondences.push(v.correspondences);
    this.baselines.push(v.baselinePx);
    trim(this.correspondences);
    trim(this.baselines);
    if (v.verifyMs >= 0) {
      this.verifyCosts.push(v.verifyMs);
      trim(this.verifyCosts);
    }

    // Only frames that could be judged contribute to the inlier statistics. A frame with too
    // few correspondences or no baseline has no inlier ratio worth the name, and folding its
    // zero in would drag the medians GEO-001 reads.
    const judged = v.correspondences >= MIN_CORRESPONDENCES && v.baselinePx >= MIN_BASELINE_PX;
    if (judged) {
      this.judgedFrames++;
      this.inliers.push(v.inliers);
      this.ratios.push(v.inlierRatio);
      this.spreads.push(v.spreadPx);
      trim(this.inliers);
      trim(this.ratios);
      trim(this.spreads);
    }

    // Texture class comes from the same detection result, measured from the image by the same
    // classifier Phase 3 used — never from what the operator was pointing at.
    const texture = result.texture as SceneTexture;
    const acc = this.byTexture.get(texture) ?? newClass();
    acc.frames++;
    if (judged) {
      acc.judged++;
      acc.inliers.push(v.inliers);
      acc.ratio.push(v.inlierRatio);
      acc.spread.push(v.spreadPx);
      trim(acc.inliers);
      trim(acc.ratio);
      trim(acc.spread);
    }
    acc.correspondences.push(v.correspondences);
    acc.baseline.push(v.baselinePx);
    trim(acc.correspondences);
    trim(acc.baseline);
    if (v.state === VerificationState.GOOD) acc.good++;
    else if (v.state === VerificationState.USABLE) acc.usable++;
    else acc.unverified++;
    this.byTexture.set(texture, acc);

    if (v.injection) {
      const s: InjectionSample = { ...v.injection, at: now };
      this.injections.push(s);
      while (this.injections.length > 60) this.injections.shift();
      if (v.injection.injectedRecall >= 0) {
        this.injectedRecall.push(v.injection.injectedRecall);
        trim(this.injectedRecall);
      }
      if (v.injection.cleanRejectionRate >= 0) {
        this.cleanRejection.push(v.injection.cleanRejectionRate);
        trim(this.cleanRejection);
      }
      this.survivingInliers.push(v.injection.survivingInliers);
      trim(this.survivingInliers);
    }
  }

  private classStats(texture: SceneTexture): VerificationClassStats {
    const acc = this.byTexture.get(texture);
    if (!acc || acc.frames === 0) return EMPTY_VERIFICATION_CLASS;
    return {
      frames: acc.frames,
      judged: acc.judged,
      medianCorrespondences: round(median(acc.correspondences), 1),
      medianInliers: round(median(acc.inliers), 1),
      medianInlierRatio: round(median(acc.ratio), 4),
      medianBaselinePx: round(median(acc.baseline), 2),
      medianSpreadPx: round(median(acc.spread), 2),
      unverified: acc.unverified,
      usable: acc.usable,
      good: acc.good,
    };
  }

  getLast(): VerificationReport | null {
    return this.last;
  }

  /** The shape the Phase 5 suite is evaluated against. */
  stats(running: boolean): VerificationStats {
    const v = this.last;
    const stateFrames: Record<string, number> = {};
    for (const [k, n] of this.stateFrames) stateFrames[k] = n;

    return {
      running,
      verifiedFrames: this.verifiedFrames,
      judgedFrames: this.judgedFrames,

      state: v?.state ?? VerificationState.UNVERIFIED,
      stateReason: v?.stateReason ?? 'verification has not run',
      goodBlockedBy: v?.goodBlockedBy ?? [],
      correspondences: v?.correspondences ?? 0,
      inliers: v?.inliers ?? 0,
      inlierRatio: v?.inlierRatio ?? -1,
      baselinePx: v?.baselinePx ?? -1,
      model: v?.model ?? null,
      planar: v?.planar ?? false,
      anchorAge: v?.anchorAge ?? -1,

      medianInliers: round(median(this.inliers), 1),
      medianInlierRatio: round(median(this.ratios), 4),
      medianBaselinePx: round(median(this.baselines), 2),
      medianSpreadPx: round(median(this.spreads), 2),
      medianCorrespondences: round(median(this.correspondences), 1),
      stateFrames,
      stateMismatches: this.stateMismatches,
      reAnchors: this.reAnchors,

      textureRich: this.classStats(SceneTexture.RICH),
      texturePoor: this.classStats(SceneTexture.POOR),

      injectionSamples: this.injectedRecall.length,
      medianInjectedRecall: round(median(this.injectedRecall), 4),
      medianCleanRejection: round(median(this.cleanRejection), 4),
      medianSurvivingInliers: round(median(this.survivingInliers), 1),
      injections: this.injections.slice(-20),

      bothModelsFitted: this.bothModelsFitted,
      planarFrames: this.planarFrames,
      nonPlanarFrames: this.nonPlanarFrames,
      planarMismatches: this.planarMismatches,
      medianFundamentalInliers: round(median(this.fundamentalInliers), 1),
      medianHomographyInliers: round(median(this.homographyInliers), 1),

      meanVerifyMs:
        this.verifyCosts.length > 0
          ? round(this.verifyCosts.reduce((a, b) => a + b, 0) / this.verifyCosts.length)
          : -1,
      verifyCostSamples: this.verifyCosts.length,
      cappedFrames: this.cappedFrames,

      degenerateFrames: this.degenerateFrames,
      partitionFaults: this.partitionFaults,
      modelWithoutVerdict: this.modelWithoutVerdict,
    };
  }

  describe(): Record<string, JsonValue> {
    const s = this.stats(false);
    return toJsonSafe({
      verifiedFrames: s.verifiedFrames,
      judgedFrames: s.judgedFrames,
      current: {
        state: s.state,
        reason: s.stateReason,
        goodBlockedBy: s.goodBlockedBy as unknown as JsonValue,
        correspondences: s.correspondences,
        inliers: s.inliers,
        inlierRatio: s.inlierRatio,
        baselinePx: s.baselinePx,
        model: s.model,
        planar: s.planar,
        anchorAge: s.anchorAge,
      },
      overRun: {
        medianCorrespondences: s.medianCorrespondences,
        medianInliers: s.medianInliers,
        medianInlierRatio: s.medianInlierRatio,
        medianBaselinePx: s.medianBaselinePx,
        medianSpreadPx: s.medianSpreadPx,
        stateFrames: s.stateFrames as unknown as JsonValue,
        stateMismatches: s.stateMismatches,
        reAnchors: s.reAnchors,
        cappedFrames: s.cappedFrames,
        degenerateFrames: s.degenerateFrames,
      },
      byTexture: {
        TEXTURE_RICH: s.textureRich as unknown as JsonValue,
        TEXTURE_POOR: s.texturePoor as unknown as JsonValue,
      },
      injectedOutliers: {
        samples: s.injectionSamples,
        medianRecall: s.medianInjectedRecall,
        medianCleanRejection: s.medianCleanRejection,
        medianSurvivingInliers: s.medianSurvivingInliers,
        recent: s.injections as unknown as JsonValue,
        note:
          'GEO-003. The harness displaces a known fraction of the correspondences by a known ' +
          'amount and hands the verifier the set with no marking. `medianRecall` is the ' +
          'fraction of the harness’s own outliers the verifier rejected — the one number in ' +
          'this phase a stage that returns its input cannot produce, because returning its ' +
          'input scores exactly 0 while satisfying every count-based criterion v3 §14 names.',
      },
      planarHandling: {
        bothModelsFitted: s.bothModelsFitted,
        planarFrames: s.planarFrames,
        nonPlanarFrames: s.nonPlanarFrames,
        planarMismatches: s.planarMismatches,
        medianFundamentalInliers: s.medianFundamentalInliers,
        medianHomographyInliers: s.medianHomographyInliers,
        note:
          'v3 §16. Both models are fitted on every judged frame, never skipped as an ' +
          'optimisation: the fundamental matrix is the weaker constraint and normally admits ' +
          'at least as many points, so the homography reaching it is the signal that the ' +
          'scene is planar. Phase 6 lowers translation confidence there, because an Essential ' +
          'matrix decomposed from a planar scene is degenerate and yields a pose that looks ' +
          'entirely reasonable.',
      },
      cost: { meanVerifyMs: s.meanVerifyMs, samples: s.verifyCostSamples },
      integrity: {
        partitionFaults: s.partitionFaults,
        modelWithoutVerdict: s.modelWithoutVerdict,
      },
    }) as Record<string, JsonValue>;
  }
}
