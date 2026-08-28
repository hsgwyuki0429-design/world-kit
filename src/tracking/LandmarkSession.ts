/**
 * Everything Phase 10 needs to answer MAP-001..009, accumulated across a run.
 *
 * Three things happen here that do not happen in `LandmarkStage`:
 *
 *  - **the accounting is checked** — `admitted + merged + rejected` against the batch's point
 *    count, on every batch, and an unregistered batch admitting nothing. Rule 002's shape applied
 *    to a counter;
 *  - **the two convergence figures are assembled across batches**, because MAP-006 is about how a
 *    landmark settles over its life and no single batch can see that;
 *  - **the sparsity is related to something**. Landmarks per keyframe is one number; the fraction
 *    of the tracked population that ever became a confirmed landmark is the one that says what
 *    "sparse" means here, and it needs Phase 4's count, which arrives separately.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import { median, round, trim } from '../core/stats';
import type { JsonValue } from '../core/types';
import { IngestState, MAX_LANDMARKS, SCALE_LOCAL_UNITS } from '../mapping/landmarks';
import type { LandmarkStats } from './landmarkStats';
import type {
  LandmarkCullRecord,
  LandmarkInjectionRecord,
  LandmarkReport,
} from './trackingMessages';

export class LandmarkSession {
  private readonly heldOut: number[] = [];
  private readonly observationsAtPrediction: number[] = [];
  private readonly scales: number[] = [];
  private readonly residuals: number[] = [];
  private readonly confidences: number[] = [];
  private readonly moves: number[] = [];
  private readonly movesAtTwo: number[] = [];
  private readonly movesAtFive: number[] = [];
  private readonly recalls: number[] = [];
  private readonly cleanRates: number[] = [];
  private readonly baselineRates: number[] = [];
  private readonly cleanExcesses: number[] = [];
  private readonly costs: number[] = [];
  private readonly recentCulls: LandmarkCullRecord[] = [];

  private readonly unregisteredReasons = new Map<string, number>();
  private readonly cullsByReason = new Map<string, number>();

  private frames = 0;
  private batches = 0;
  private registeredBatches = 0;
  private unregisteredBatches = 0;
  private heldOutBatches = 0;
  private zeroHeldOut = 0;
  private worstHeldOut = -1;
  private worstResidual = -1;
  private registrationOutliers = 0;
  private epochRestarts = 0;
  private ingestedUnregistered = 0;
  private culled = 0;
  private cullsWithoutReason = 0;
  private boundBreaches = 0;
  private confidenceOutOfRange = 0;
  private injections = 0;
  private worstRecall = -1;
  private worstCleanExcess = -1;
  private injectionDisplacementPx = -1;
  private lastInjection: LandmarkInjectionRecord | null = null;
  private scaleViolations = 0;
  private rateOutOfRange = 0;
  private accountingMismatches = 0;
  private unregisteredAdmissions = 0;
  private sizeMismatches = 0;
  private trackedPopulation = -1;
  private peakLandmarks = 0;
  private peakConfirmed = 0;

  private lastBatchIndex = 0;
  private last: LandmarkReport | null = null;

  reset(): void {
    for (const l of [
      this.heldOut, this.observationsAtPrediction, this.scales, this.residuals, this.confidences,
      this.moves, this.movesAtTwo, this.movesAtFive, this.recalls, this.cleanRates,
      this.baselineRates, this.cleanExcesses, this.costs,
    ]) l.length = 0;
    this.recentCulls.length = 0;
    this.unregisteredReasons.clear();
    this.cullsByReason.clear();
    this.frames = 0;
    this.batches = 0;
    this.registeredBatches = 0;
    this.unregisteredBatches = 0;
    this.heldOutBatches = 0;
    this.zeroHeldOut = 0;
    this.worstHeldOut = -1;
    this.worstResidual = -1;
    this.registrationOutliers = 0;
    this.epochRestarts = 0;
    this.ingestedUnregistered = 0;
    this.culled = 0;
    this.cullsWithoutReason = 0;
    this.boundBreaches = 0;
    this.confidenceOutOfRange = 0;
    this.injections = 0;
    this.worstRecall = -1;
    this.worstCleanExcess = -1;
    this.injectionDisplacementPx = -1;
    this.lastInjection = null;
    this.scaleViolations = 0;
    this.rateOutOfRange = 0;
    this.accountingMismatches = 0;
    this.unregisteredAdmissions = 0;
    this.sizeMismatches = 0;
    this.trackedPopulation = -1;
    this.peakLandmarks = 0;
    this.peakConfirmed = 0;
    this.lastBatchIndex = 0;
    this.last = null;
  }

  /**
   * Phase 4's tracked population, for MAP-007's sparsity rate.
   *
   * Told rather than inferred: "what fraction of what the tracker was following became a
   * landmark" needs a denominator this phase does not own, and computing one from the map's own
   * counts would make the rate a statement about the map rather than about the room.
   */
  noteTrackedPopulation(tracked: number): void {
    if (tracked > 0) this.trackedPopulation = tracked;
  }

  record(r: LandmarkReport): void {
    this.last = r;
    this.frames = r.frames;
    if (r.state === IngestState.IDLE || r.batches === this.lastBatchIndex) return;
    this.lastBatchIndex = r.batches;
    this.batches++;

    this.peakLandmarks = Math.max(this.peakLandmarks, r.landmarks);
    this.peakConfirmed = Math.max(this.peakConfirmed, r.confirmed);
    if (r.scale !== SCALE_LOCAL_UNITS) this.scaleViolations++;
    if (r.landmarks > MAX_LANDMARKS) this.boundBreaches++;
    if (r.landmarkMs >= 0) {
      this.costs.push(r.landmarkMs);
      trim(this.costs);
    }
    if (r.admitted + r.merged + r.rejected !== r.points) this.accountingMismatches++;
    if (r.samples.length > Math.min(r.landmarks, 6)) this.sizeMismatches++;
    for (const s of r.samples) {
      if (s.confidence < 0 || s.confidence > 1) this.confidenceOutOfRange++;
    }
    if (r.medianConfidence !== -1 && (r.medianConfidence < 0 || r.medianConfidence > 1)) {
      this.rateOutOfRange++;
    }
    // Every rate this phase reports is checked against 0..1, including its own derived ones —
    // Phase 6's device run reported an agreement rate of 232.3 %, and this is that check.
    if (r.landmarks > 0 && r.confirmed > r.landmarks) this.rateOutOfRange++;

    if (r.epochRestarted) this.epochRestarts++;

    if (r.state === IngestState.UNREGISTERED) {
      this.unregisteredBatches++;
      const key = unregisteredKey(r.stateReason);
      this.unregisteredReasons.set(key, (this.unregisteredReasons.get(key) ?? 0) + 1);
      if (r.admitted > 0 || r.merged > 0) this.unregisteredAdmissions++;
    } else {
      this.registeredBatches++;
      if (r.registrationScale < 0) this.ingestedUnregistered++;
      if (r.registrationScale > 0) {
        this.scales.push(r.registrationScale);
        trim(this.scales);
      }
      if (r.registrationResidual >= 0) {
        this.residuals.push(r.registrationResidual);
        trim(this.residuals);
        this.worstResidual = Math.max(this.worstResidual, r.registrationResidual);
      }
      this.registrationOutliers += r.registrationOutliers;
    }

    /* ---- MAP-002 ---- */
    if (r.heldOut > 0) {
      this.heldOutBatches++;
      this.heldOut.push(r.medianHeldOutPx);
      trim(this.heldOut);
      this.worstHeldOut = Math.max(this.worstHeldOut, r.maxHeldOutPx);
      this.zeroHeldOut += r.zeroHeldOut;
      if (r.medianObservationsAtPrediction >= 0) {
        this.observationsAtPrediction.push(r.medianObservationsAtPrediction);
        trim(this.observationsAtPrediction);
      }
    }

    /* ---- MAP-004 ---- */
    for (const c of r.culled) {
      this.culled++;
      this.cullsByReason.set(c.reason, (this.cullsByReason.get(c.reason) ?? 0) + 1);
      if (!c.reason || c.detail.length === 0) this.cullsWithoutReason++;
      this.recentCulls.push(c);
      trim(this.recentCulls, 32);
    }

    /* ---- MAP-005 ---- */
    if (r.injection) {
      this.injections++;
      this.recalls.push(r.injection.recall);
      this.cleanRates.push(r.injection.cleanRejectionRate);
      this.baselineRates.push(r.injection.baselineRejectionRate);
      const excess = Math.max(0, r.injection.cleanRejectionRate - r.injection.baselineRejectionRate);
      this.cleanExcesses.push(excess);
      this.worstCleanExcess = Math.max(this.worstCleanExcess, excess);
      trim(this.recalls);
      trim(this.cleanRates);
      trim(this.baselineRates);
      trim(this.cleanExcesses);
      this.worstRecall =
        this.worstRecall < 0 ? r.injection.recall : Math.min(this.worstRecall, r.injection.recall);
      this.injectionDisplacementPx = r.injection.displacementPx;
      this.lastInjection = r.injection;
      for (const rate of [
        r.injection.recall,
        r.injection.cleanRejectionRate,
        r.injection.baselineRejectionRate,
      ]) {
        if (rate !== -1 && (rate < 0 || rate > 1)) this.rateOutOfRange++;
      }
    }

    /* ---- MAP-006 ---- */
    if (r.medianMoveRelative >= 0) {
      this.moves.push(r.medianMoveRelative);
      trim(this.moves);
    }
    if (r.moveAtTwo >= 0) {
      this.movesAtTwo.push(r.moveAtTwo);
      trim(this.movesAtTwo);
    }
    if (r.moveAtFive >= 0) {
      this.movesAtFive.push(r.moveAtFive);
      trim(this.movesAtFive);
    }
    if (r.medianConfidence >= 0) {
      this.confidences.push(r.medianConfidence);
      trim(this.confidences);
    }
  }

  getLast(): LandmarkReport | null {
    return this.last;
  }

  stats(running: boolean): LandmarkStats {
    const r = this.last;
    const totalCost = this.costs.reduce((a, b) => a + b, 0);
    const confirmed = r?.confirmed ?? 0;

    return {
      running,
      frames: this.frames,
      batches: this.batches,

      state: r?.state ?? IngestState.IDLE,
      stateReason: r?.stateReason ?? 'the map has not been given a batch yet',
      keyframePair: r?.keyframePair ?? null,
      shared: r?.shared ?? 0,
      admitted: r?.admitted ?? 0,
      merged: r?.merged ?? 0,
      rejected: r?.rejected ?? 0,
      samples: r?.samples ?? [],

      landmarks: r?.landmarks ?? 0,
      confirmed,
      peakLandmarks: this.peakLandmarks,
      peakConfirmed: this.peakConfirmed,
      maxLandmarks: MAX_LANDMARKS,
      multiObservation: (r?.samples ?? []).filter((s) => s.observations > 1).length,
      medianObservations: round(median((r?.samples ?? []).map((s) => s.observations)), 2),
      medianConfidence: round(median(this.confidences), 4),

      heldOutBatches: this.heldOutBatches,
      heldOutSamples: this.heldOut.length,
      medianHeldOutPx: round(median(this.heldOut), 4),
      worstHeldOutPx: round(this.worstHeldOut, 4),
      zeroHeldOut: this.zeroHeldOut,
      medianObservationsAtPrediction: round(median(this.observationsAtPrediction), 2),

      registeredBatches: this.registeredBatches,
      unregisteredBatches: this.unregisteredBatches,
      unregisteredReasons: Object.fromEntries(this.unregisteredReasons),
      medianRegistrationScale: round(median(this.scales), 5),
      medianRegistrationResidual: round(median(this.residuals), 6),
      worstRegistrationResidual: round(this.worstResidual, 6),
      registrationOutliers: this.registrationOutliers,
      epochs: r?.epoch ?? 1,
      epochRestarts: this.epochRestarts,
      scale: r?.scale ?? SCALE_LOCAL_UNITS,
      scaleViolations: this.scaleViolations,
      ingestedUnregistered: this.ingestedUnregistered,

      culled: this.culled,
      cullsByReason: Object.fromEntries(this.cullsByReason),
      cullsWithoutReason: this.cullsWithoutReason,
      recentCulls: [...this.recentCulls],
      boundBreaches: this.boundBreaches,
      confidenceOutOfRange: this.confidenceOutOfRange,

      injections: this.injections,
      medianRecall: round(median(this.recalls), 4),
      medianCleanRejectionRate: round(median(this.cleanRates), 4),
      medianBaselineRejectionRate: round(median(this.baselineRates), 4),
      medianCleanExcess: round(median(this.cleanExcesses), 4),
      worstCleanExcess: round(this.worstCleanExcess, 4),
      worstRecall: round(this.worstRecall, 4),
      injectionDisplacementPx: this.injectionDisplacementPx,
      lastInjection: this.lastInjection,

      moveAtTwo: round(median(this.movesAtTwo), 6),
      moveAtFive: round(median(this.movesAtFive), 6),
      moveAtTwoSamples: this.movesAtTwo.length,
      moveAtFiveSamples: this.movesAtFive.length,
      medianMoveRelative: round(median(this.moves), 6),

      modelClaim:
        r?.modelClaim ??
        'this is a set of places the tracker could follow, not a model of the room (v4 §16, §22)',
      landmarksPerKeyframe: r?.landmarksPerKeyframe ?? -1,
      confirmedShare: (r?.landmarks ?? 0) > 0 ? round(confirmed / (r?.landmarks ?? 1), 4) : -1,
      landmarksPerTrackedFeature:
        this.trackedPopulation > 0 ? round((r?.landmarks ?? 0) / this.trackedPopulation, 2) : -1,

      meanLandmarkMs: this.costs.length > 0 ? round(totalCost / this.costs.length, 4) : -1,
      amortisedMsPerFrame: this.frames > 0 ? round(totalCost / this.frames, 5) : -1,
      costSamples: this.costs.length,

      rateOutOfRange: this.rateOutOfRange,
      accountingMismatches: this.accountingMismatches,
      unregisteredAdmissions: this.unregisteredAdmissions,
      sizeMismatches: this.sizeMismatches,
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe(this.stats(false)) as Record<string, JsonValue>;
  }
}

/**
 * Which kind of refusal an unregistered batch's reason describes.
 *
 * The reason is a sentence, because a person reading the evidence needs one; the key is what the
 * counters group by. Derived from the sentence rather than carried beside it, so the two cannot
 * come to disagree — the arrangement Phase 9's session uses for the same reason.
 */
function unregisteredKey(reason: string): string {
  if (reason.includes('shares')) return 'TOO_FEW_SHARED';
  if (reason.includes('residual') || reason.includes('depth away')) return 'RESIDUAL';
  if (reason.includes('no points')) return 'NO_POINTS';
  if (reason.includes('degenerate')) return 'DEGENERATE';
  return 'OTHER';
}
