/**
 * Everything Phase 9 needs to answer TRI-001..009, accumulated across a run.
 *
 * Three things happen here that do not happen in `TriangulationStage`:
 *
 *  - **the accounting is checked**, not assumed: `accepted + refusals` must equal `candidates` on
 *    every batch, and a refused batch must carry no points. Rule 002's shape applied to a
 *    counter rather than to a state;
 *  - **the per-batch depths are kept apart**, deliberately. There is no run-wide depth average in
 *    this file, because two batches' depths are in two different units — and the *spread* between
 *    the per-batch medians is reported instead, as the number behind that refusal;
 *  - **the two injections are folded across batches**, because three of them are what makes a
 *    median mean anything and no single batch can supply that.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import { median, round, trim } from '../core/stats';
import type { JsonValue } from '../core/types';
import { MIN_PARALLAX_DEG, SCALE_LOCAL_UNITS, TriangulationRefusal } from '../mapping/triangulation';
import { ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION } from './PoseSession';
import { TriangulationState } from './TriangulationStage';
import type { TriangulationStats } from './triangulationStats';
import type {
  DepthInjectionRecord,
  RotationInjectionRecord,
  TriangulationReport,
} from './trackingMessages';

export class TriangulationSession {
  private readonly acceptedPerBatch: number[] = [];
  private readonly parallax: number[] = [];
  private readonly acceptedParallax: number[] = [];
  private readonly uncertainties: number[] = [];
  private readonly reprojections: number[] = [];
  private readonly rotations: number[] = [];
  private readonly disagreements: number[] = [];
  private readonly batchDepths: number[] = [];
  private readonly depthErrors: number[] = [];
  private readonly controlErrors: number[] = [];
  private readonly rankCorrelations: number[] = [];
  private readonly costs: number[] = [];

  private readonly batchRefusals = new Map<string, number>();
  private readonly pointRefusals = new Map<string, number>();
  private readonly injectionPoseStates = new Map<string, number>();

  private frames = 0;
  private batches = 0;
  private batchesTriangulated = 0;
  private batchesRefused = 0;
  private totalAccepted = 0;
  private candidates = 0;
  private keyframesSeen = 0;

  private worstAcceptedParallax = Number.POSITIVE_INFINITY;
  private worstAcceptedReprojection = -1;
  private worstAcceptedDepth = Number.POSITIVE_INFINITY;

  private rotationInjections = 0;
  private rotationInjectionAccepted = 0;
  private rotationInjectionCleanAccepted = 0;
  private lastRotationInjection: RotationInjectionRecord | null = null;

  private depthInjections = 0;
  private worstDepthError = -1;
  private lastDepthInjection: DepthInjectionRecord | null = null;

  private rotationsWithinTolerance = 0;
  private zeroDisagreements = 0;
  private scaleViolations = 0;
  private rateOutOfRange = 0;
  private accountingMismatches = 0;
  private refusedWithPoints = 0;

  /** Batches already folded in, so an IDLE frame carrying the last batch cannot double-count. */
  private lastBatchIndex = 0;
  private last: TriangulationReport | null = null;

  reset(): void {
    for (const l of [
      this.acceptedPerBatch, this.parallax, this.acceptedParallax, this.uncertainties,
      this.reprojections, this.rotations, this.disagreements, this.batchDepths,
      this.depthErrors, this.controlErrors, this.rankCorrelations, this.costs,
    ]) l.length = 0;
    this.batchRefusals.clear();
    this.pointRefusals.clear();
    this.injectionPoseStates.clear();
    this.frames = 0;
    this.batches = 0;
    this.batchesTriangulated = 0;
    this.batchesRefused = 0;
    this.totalAccepted = 0;
    this.candidates = 0;
    this.keyframesSeen = 0;
    this.worstAcceptedParallax = Number.POSITIVE_INFINITY;
    this.worstAcceptedReprojection = -1;
    this.worstAcceptedDepth = Number.POSITIVE_INFINITY;
    this.rotationInjections = 0;
    this.rotationInjectionAccepted = 0;
    this.rotationInjectionCleanAccepted = 0;
    this.lastRotationInjection = null;
    this.depthInjections = 0;
    this.worstDepthError = -1;
    this.lastDepthInjection = null;
    this.rotationsWithinTolerance = 0;
    this.zeroDisagreements = 0;
    this.scaleViolations = 0;
    this.rateOutOfRange = 0;
    this.accountingMismatches = 0;
    this.refusedWithPoints = 0;
    this.lastBatchIndex = 0;
    this.last = null;
  }

  /** How many keyframes the store has inserted, for TRI-001's sparsity figure. */
  noteKeyframeInserted(): void {
    this.keyframesSeen++;
  }

  record(r: TriangulationReport): void {
    this.last = r;
    this.frames = r.frames;
    // An IDLE frame carries the previous batch's numbers forward so the screen has something to
    // show. Folding them in again would count one batch as many.
    if (r.state === TriangulationState.IDLE || r.batches === this.lastBatchIndex) return;
    this.lastBatchIndex = r.batches;
    this.batches++;

    if (r.scale !== SCALE_LOCAL_UNITS || r.baselineUnits !== 1) this.scaleViolations++;
    for (const rate of [r.inlierRatio]) {
      if (rate !== -1 && (rate < 0 || rate > 1)) this.rateOutOfRange++;
    }
    if (r.triangulationMs >= 0) {
      this.costs.push(r.triangulationMs);
      trim(this.costs);
    }

    if (r.state === TriangulationState.REFUSED) {
      this.batchesRefused++;
      const key = refusalKey(r.stateReason);
      this.batchRefusals.set(key, (this.batchRefusals.get(key) ?? 0) + 1);
      if (r.accepted > 0) this.refusedWithPoints++;
    } else {
      this.batchesTriangulated++;
      this.totalAccepted += r.accepted;
      this.candidates += r.candidates;
      this.acceptedPerBatch.push(r.accepted);
      trim(this.acceptedPerBatch);

      let refused = 0;
      for (const [reason, count] of Object.entries(r.refusals)) {
        refused += count;
        this.pointRefusals.set(reason, (this.pointRefusals.get(reason) ?? 0) + count);
      }
      // TRI-009 criterion 3. A stage whose counts do not add up is not reporting what it did.
      if (r.accepted + refused !== r.candidates) this.accountingMismatches++;

      if (r.medianParallaxDeg >= 0) {
        this.parallax.push(r.medianParallaxDeg);
        trim(this.parallax);
      }
      if (r.medianAcceptedParallaxDeg >= 0) {
        this.acceptedParallax.push(r.medianAcceptedParallaxDeg);
        trim(this.acceptedParallax);
      }
      if (r.medianDepthUncertainty >= 0) {
        this.uncertainties.push(r.medianDepthUncertainty);
        trim(this.uncertainties);
      }
      if (r.medianReprojectionPx >= 0) {
        this.reprojections.push(r.medianReprojectionPx);
        trim(this.reprojections);
      }
      // Kept per batch and never pooled: two batches' depths are in two different units.
      if (r.medianDepth >= 0) {
        this.batchDepths.push(r.medianDepth);
        trim(this.batchDepths);
      }
      if (r.minAcceptedParallaxDeg >= 0) {
        this.worstAcceptedParallax = Math.min(this.worstAcceptedParallax, r.minAcceptedParallaxDeg);
      }
      if (r.maxAcceptedReprojectionPx >= 0) {
        this.worstAcceptedReprojection = Math.max(
          this.worstAcceptedReprojection,
          r.maxAcceptedReprojectionPx,
        );
      }
      if (r.minAcceptedDepth >= 0) {
        this.worstAcceptedDepth = Math.min(this.worstAcceptedDepth, r.minAcceptedDepth);
      }

      /* ---- TRI-006 ---- */
      if (r.rotationDisagreementDeg >= 0 && r.rotationDeg >= 0) {
        this.rotations.push(r.rotationDeg);
        this.disagreements.push(r.rotationDisagreementDeg);
        trim(this.rotations);
        trim(this.disagreements);
        const tolerance = Math.max(
          ROTATION_AGREEMENT_DEG,
          ROTATION_AGREEMENT_FRACTION * Math.max(0, r.rotationDeg),
        );
        if (r.rotationDisagreementDeg <= tolerance) this.rotationsWithinTolerance++;
        if (r.rotationDisagreementDeg === 0) this.zeroDisagreements++;
      }
    }

    /* ---- TRI-003 ---- */
    const ri = r.rotationInjection;
    if (ri) {
      this.rotationInjections++;
      this.rotationInjectionAccepted += ri.accepted;
      this.rotationInjectionCleanAccepted += ri.cleanAccepted;
      this.injectionPoseStates.set(
        ri.poseState,
        (this.injectionPoseStates.get(ri.poseState) ?? 0) + 1,
      );
      this.lastRotationInjection = ri;
    }

    /* ---- TRI-004 ---- */
    const di = r.depthInjection;
    if (di) {
      this.depthInjections++;
      this.depthErrors.push(di.medianRelativeError);
      this.controlErrors.push(di.controlRelativeError);
      this.rankCorrelations.push(di.rankCorrelation);
      trim(this.depthErrors);
      trim(this.controlErrors);
      trim(this.rankCorrelations);
      this.worstDepthError = Math.max(this.worstDepthError, di.medianRelativeError);
      this.lastDepthInjection = di;
    }
  }

  getLast(): TriangulationReport | null {
    return this.last;
  }

  stats(running: boolean): TriangulationStats {
    const r = this.last;
    const totalCost = this.costs.reduce((a, b) => a + b, 0);
    const depthSpread =
      this.batchDepths.length >= 2
        ? (Math.max(...this.batchDepths) - Math.min(...this.batchDepths)) /
          Math.max(1e-9, median(this.batchDepths))
        : -1;

    return {
      running,
      frames: this.frames,
      batches: this.batches,

      state: r?.state ?? TriangulationState.IDLE,
      stateReason: r?.stateReason ?? 'triangulation has not run yet',
      keyframePair: r?.keyframePair ?? null,
      correspondences: r?.correspondences ?? 0,
      inliers: r?.inliers ?? 0,
      accepted: r?.accepted ?? 0,
      model: r?.model ?? null,
      planar: r?.planar ?? false,
      poseState: r?.poseState ?? 'NO_POSE',
      samples: r?.samples ?? [],

      batchesTriangulated: this.batchesTriangulated,
      batchesRefused: this.batchesRefused,
      batchRefusalsByReason: Object.fromEntries(this.batchRefusals),
      totalAccepted: this.totalAccepted,
      medianAcceptedPerBatch: round(median(this.acceptedPerBatch), 1),
      pointsPerKeyframe:
        this.keyframesSeen > 0 ? round(this.totalAccepted / this.keyframesSeen, 2) : -1,

      pointRefusals: Object.fromEntries(this.pointRefusals),
      candidates: this.candidates,
      acceptanceRate: this.candidates > 0 ? round(this.totalAccepted / this.candidates, 4) : -1,
      medianParallaxDeg: round(median(this.parallax), 4),
      medianAcceptedParallaxDeg: round(median(this.acceptedParallax), 4),
      worstAcceptedParallaxDeg: Number.isFinite(this.worstAcceptedParallax)
        ? round(this.worstAcceptedParallax, 4)
        : -1,
      medianDepthUncertainty: round(median(this.uncertainties), 5),
      lowParallaxRefusals: this.pointRefusals.get(TriangulationRefusal.LOW_PARALLAX) ?? 0,

      rotationInjections: this.rotationInjections,
      rotationInjectionAccepted: this.rotationInjectionAccepted,
      rotationInjectionCleanAccepted: this.rotationInjectionCleanAccepted,
      rotationInjectionPoseStates: Object.fromEntries(this.injectionPoseStates),
      lastRotationInjection: this.lastRotationInjection,

      depthInjections: this.depthInjections,
      medianDepthError: round(median(this.depthErrors), 6),
      medianControlError: round(median(this.controlErrors), 6),
      medianRankCorrelation: round(median(this.rankCorrelations), 5),
      worstDepthError: round(this.worstDepthError, 6),
      lastDepthInjection: this.lastDepthInjection,

      medianReprojectionPx: round(median(this.reprojections), 4),
      worstAcceptedReprojectionPx: round(this.worstAcceptedReprojection, 4),
      worstAcceptedDepth: Number.isFinite(this.worstAcceptedDepth)
        ? round(this.worstAcceptedDepth, 4)
        : -1,
      behindCameraRefusals: this.pointRefusals.get(TriangulationRefusal.BEHIND_CAMERA) ?? 0,
      highReprojectionRefusals: this.pointRefusals.get(TriangulationRefusal.HIGH_REPROJECTION) ?? 0,

      rotationSamples: this.disagreements.length,
      medianRotationDeg: round(median(this.rotations), 4),
      medianRotationDisagreementDeg: round(median(this.disagreements), 4),
      rotationToleranceDeg: round(
        Math.max(ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION * Math.max(0, median(this.rotations))),
        4,
      ),
      rotationsWithinTolerance: this.rotationsWithinTolerance,
      zeroDisagreements: this.zeroDisagreements,

      scale: r?.scale ?? SCALE_LOCAL_UNITS,
      baselineUnits: r?.baselineUnits ?? 1,
      baselineNote:
        r?.baselineNote ??
        'depths are in units of the pair’s own baseline, which is 1 by construction and has no ' +
          'length in the world',
      scaleViolations: this.scaleViolations,
      medianBatchDepth: round(median(this.batchDepths), 4),
      batchDepthSpread: round(depthSpread, 4),

      meanTriangulationMs:
        this.costs.length > 0 ? round(totalCost / this.costs.length, 4) : -1,
      amortisedMsPerFrame: this.frames > 0 ? round(totalCost / this.frames, 5) : -1,
      costSamples: this.costs.length,

      rateOutOfRange: this.rateOutOfRange,
      accountingMismatches: this.accountingMismatches,
      refusedWithPoints: this.refusedWithPoints,
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe(this.stats(false)) as Record<string, JsonValue>;
  }
}

/**
 * Which kind of refusal a batch's reason describes.
 *
 * The reason is a sentence, because a person reading the evidence needs one; the key is what the
 * counters group by. Derived from the sentence rather than carried beside it so the two cannot
 * come to disagree.
 */
function refusalKey(reason: string): string {
  if (reason.includes('share')) return 'TOO_FEW_SHARED';
  if (reason.includes('verified nothing')) return 'UNVERIFIED';
  if (reason.includes('below v3 §14')) return 'TOO_FEW_INLIERS';
  if (reason.includes('only turned')) return 'NO_TRANSLATION';
  if (reason.includes('pair needs two')) return 'NO_PAIR';
  return 'OTHER';
}

/** Re-exported so the screen and the tests name one floor. */
export { MIN_PARALLAX_DEG };
