/**
 * Everything Phase 8 needs to answer KEY-001..008, accumulated across a run.
 *
 * Three things happen here that do not happen in `KeyframeStage`:
 *
 *  - **every decision is re-derived** by calling the same `decideKeyframe` on the inputs the
 *    stage recorded beside its answer, and the disagreements are counted (Rule 002, for the
 *    fifth phase running). This is the check that catches fake 2 from the test plan — a
 *    selector firing on a timer and labelling the record `ROTATION`;
 *  - **the static segment is assembled**, because KEY-002 is about a *run* of frames classified
 *    by an instrument this phase does not own: Phase 4's independent scene-shift search, which
 *    shares no code with anything here and reports `STATIC` below 1 px of image motion;
 *  - **the store's invariants are checked against the records it sends**, rather than against
 *    the store's own opinion of itself — the size, the intrinsics, the observation floor.
 *
 * Bounded throughout: a twenty-minute session must not grow this without limit (§56).
 */

import { toJsonSafe } from '../core/validate';
import { median, round, trim } from '../core/stats';
import type { JsonValue } from '../core/types';
import { intrinsicsFor } from '../geometry/intrinsics';
import {
  KeyframeReason,
  MAX_KEYFRAMES,
  MIN_KEYFRAME_INTERVAL_MS,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  SCALE_LOCAL_UNITS,
  decideKeyframe,
} from '../mapping/keyframes';
import { FrameMotion } from './SceneShift';
import type { KeyframeStats, KeyframeViolationRecord } from './keyframeStats';
import type {
  KeyframeConditionRecord,
  KeyframeEvictionRecord,
  KeyframeRecord,
  KeyframeReport,
} from './trackingMessages';

/** The geometric reasons — the ones a metronome cannot legitimately produce. */
const GEOMETRIC: readonly string[] = [
  KeyframeReason.ROTATION,
  KeyframeReason.DISPLACEMENT,
  KeyframeReason.QUALITY,
];

export class KeyframeSession {
  private readonly costs: number[] = [];
  private readonly sharedCounts: number[] = [];
  private readonly translationDirections: number[] = [];
  private readonly survivals: number[] = [];
  private readonly recentEvictions: KeyframeEvictionRecord[] = [];
  private readonly byReason = new Map<string, number>();

  private decisions = 0;
  private totalInserted = 0;
  private geometricInsertions = 0;
  private heartbeatInsertions = 0;
  private reasonMismatches = 0;
  private minIntervalViolations = 0;
  private maxIntervalGaps = 0;
  private longestGapMs = -1;

  private staticDecisions = 0;
  private staticSelectorInsertions = 0;
  private staticGeometricInsertions = 0;
  private stillIntervalGeometricInsertions = 0;
  private stillIntervalDecisions = 0;
  private readonly stillIntervalViolations: KeyframeViolationRecord[] = [];
  private readonly staticByReason = new Map<string, number>();
  private staticMetronomeInsertions = 0;

  private maxStoreSize = 0;
  private storeOverflows = 0;
  private evictions = 0;
  private evictionsWithoutReason = 0;
  private evictedNewest = 0;
  private evictionsCoverageKept = 0;

  private observationFloorViolations = 0;
  private duplicateObservationIds = 0;
  private intrinsicsMismatches = 0;
  private sharedBelowFloor = 0;

  private translationFired = 0;
  private scaleViolations = 0;

  private staleEver = 0;
  private stalePartnerUsed = 0;
  private droppedIncrements = 0;
  private ambiguousPosesDeclined = 0;

  private rateOutOfRange = 0;
  private eulerEmitted = 0;
  private sizeMismatches = 0;

  /** Ids already checked for the per-keyframe invariants, so 30 records are not re-checked. */
  private readonly checkedKeyframes = new Set<number>();
  private last: KeyframeReport | null = null;

  reset(): void {
    for (const l of [this.costs, this.sharedCounts, this.translationDirections, this.survivals]) {
      l.length = 0;
    }
    this.recentEvictions.length = 0;
    this.byReason.clear();
    this.staticByReason.clear();
    this.checkedKeyframes.clear();
    this.decisions = 0;
    this.totalInserted = 0;
    this.geometricInsertions = 0;
    this.heartbeatInsertions = 0;
    this.reasonMismatches = 0;
    this.minIntervalViolations = 0;
    this.maxIntervalGaps = 0;
    this.longestGapMs = -1;
    this.staticDecisions = 0;
    this.staticSelectorInsertions = 0;
    this.staticGeometricInsertions = 0;
    this.stillIntervalGeometricInsertions = 0;
    this.stillIntervalDecisions = 0;
    this.stillIntervalViolations.length = 0;
    this.staticByReason.clear();
    this.staticMetronomeInsertions = 0;
    this.maxStoreSize = 0;
    this.storeOverflows = 0;
    this.evictions = 0;
    this.evictionsWithoutReason = 0;
    this.evictedNewest = 0;
    this.evictionsCoverageKept = 0;
    this.observationFloorViolations = 0;
    this.duplicateObservationIds = 0;
    this.intrinsicsMismatches = 0;
    this.sharedBelowFloor = 0;
    this.translationFired = 0;
    this.scaleViolations = 0;
    this.staleEver = 0;
    this.stalePartnerUsed = 0;
    this.droppedIncrements = 0;
    this.ambiguousPosesDeclined = 0;
    this.rateOutOfRange = 0;
    this.eulerEmitted = 0;
    this.sizeMismatches = 0;
    this.last = null;
  }

  record(r: KeyframeReport): void {
    this.last = r;
    this.decisions++;
    this.byReason.set(r.reason, (this.byReason.get(r.reason) ?? 0) + 1);

    /* ---- KEY-001 criterion 2: the decision has to follow from its own inputs ---- */
    const rederived = decideKeyframe(r.input);
    if (rederived.insert !== r.inserted || rederived.reason !== r.reason) this.reasonMismatches++;

    if (r.inserted) {
      this.totalInserted++;
      if (GEOMETRIC.includes(r.reason)) this.geometricInsertions++;
      if (r.reason === KeyframeReason.HEARTBEAT) this.heartbeatInsertions++;
      // The first keyframe of a run has no predecessor and therefore no interval to violate.
      if (
        r.reason !== KeyframeReason.FIRST &&
        r.input.sinceLastMs >= 0 &&
        r.input.sinceLastMs < MIN_KEYFRAME_INTERVAL_MS
      ) {
        this.minIntervalViolations++;
      }
    } else if (r.input.sinceLastMs > MAX_KEYFRAME_INTERVAL_MS) {
      // A decision that declined past the maximum interval is a gap v3 §20 does not allow.
      this.maxIntervalGaps++;
    }
    if (r.input.sinceLastMs > this.longestGapMs) this.longestGapMs = r.input.sinceLastMs;

    /* ---- KEY-002: the static segment, classified by Phase 4's instrument ---- */
    if (r.frameMotion === FrameMotion.STATIC) {
      this.staticDecisions++;
      if (r.intervalStatic) this.stillIntervalDecisions++;
      if (r.inserted) {
        this.staticSelectorInsertions++;
        this.staticByReason.set(r.reason, (this.staticByReason.get(r.reason) ?? 0) + 1);
        if (GEOMETRIC.includes(r.reason)) {
          this.staticGeometricInsertions++;
          // The one that is a violation: nothing moved between this view and the previous
          // keyframe, so no geometric condition can honestly have been met over that interval.
          if (r.intervalStatic) {
            this.stillIntervalGeometricInsertions++;
            this.stillIntervalViolations.push({
              reason: r.reason,
              rotationDeg: r.input.rotationDeg,
              displacementPx: r.input.displacementPx,
              sinceLastMs: Math.round(r.input.sinceLastMs),
              sharedWithLast: r.sharedWithLast,
              droppedIncrements: r.droppedIncrements,
              reAnchors: r.reAnchorsSinceKeyframe,
              poseState: r.poseState,
              poseAmbiguous: r.poseAmbiguous,
              poseRotationConfidence: r.poseRotationConfidence,
              poseUnseparatedCandidates: r.poseUnseparatedCandidates,
            });
            trim(this.stillIntervalViolations, 16);
          }
        }
      }
      if (r.metronomeInserted) this.staticMetronomeInsertions++;
    }

    /* ---- KEY-003 ---- */
    if (r.keyframes > this.maxStoreSize) this.maxStoreSize = r.keyframes;
    if (r.keyframes > MAX_KEYFRAMES) this.storeOverflows++;
    if (r.evicted) {
      this.evictions++;
      if (!r.evicted.reason || r.evicted.detail.length === 0) this.evictionsWithoutReason++;
      // The newest keyframe is the one the next decision is measured against. Evicting it would
      // leave the selector comparing the present against a view it had discarded.
      if (r.partnerKeyframeId >= 0 && r.evicted.keyframeId === r.partnerKeyframeId) {
        this.evictedNewest++;
      }
      if (r.evicted.retainedSeparationPx >= r.evicted.oldestFirstSeparationPx) {
        this.evictionsCoverageKept++;
      }
      this.recentEvictions.push(r.evicted);
      trim(this.recentEvictions, 32);
    }

    /* ---- KEY-004 ---- */
    this.duplicateObservationIds = r.duplicateObservationIds;
    if (r.sharedWithLast > 0) {
      this.sharedCounts.push(r.sharedWithLast);
      trim(this.sharedCounts);
      if (r.sharedWithLast < MIN_KEYFRAME_OBSERVATIONS) this.sharedBelowFloor++;
    }
    for (const kf of r.recent) {
      if (this.checkedKeyframes.has(kf.id)) continue;
      this.checkedKeyframes.add(kf.id);
      if (this.checkedKeyframes.size > 4096) this.checkedKeyframes.clear();
      if (kf.observations < MIN_KEYFRAME_OBSERVATIONS) this.observationFloorViolations++;
      if (!intrinsicsFollowFrom(kf)) this.intrinsicsMismatches++;
    }

    /* ---- KEY-005 ---- */
    const translation = r.conditions.find((c) => c.name === 'TRANSLATION');
    if (translation?.fired) this.translationFired++;
    if (r.scale !== SCALE_LOCAL_UNITS) this.scaleViolations++;
    if (r.input.rotationDeg >= 0 && r.recent.length > 0) {
      const t = r.recent[r.recent.length - 1]?.translationDirectionDeg ?? -1;
      if (t >= 0) {
        this.translationDirections.push(t);
        trim(this.translationDirections);
      }
    }

    /* ---- KEY-006 ---- */
    if (r.staleKeyframes > this.staleEver) this.staleEver = r.staleKeyframes;
    if (r.partnerStale) this.stalePartnerUsed++;
    this.droppedIncrements = r.droppedIncrements;
    this.ambiguousPosesDeclined = Math.max(this.ambiguousPosesDeclined, r.ambiguousPosesDeclined);
    for (const kf of r.recent) {
      if (kf.survivingFraction < 0) continue;
      this.survivals.push(kf.survivingFraction);
      trim(this.survivals);
    }

    /* ---- KEY-007 ---- */
    if (r.keyframeMs >= 0) {
      this.costs.push(r.keyframeMs);
      trim(this.costs);
    }

    /* ---- KEY-008 ---- */
    for (const rate of [r.input.inlierRatio, r.input.previousInlierRatio]) {
      if (rate !== -1 && (rate < 0 || rate > 1)) this.rateOutOfRange++;
    }
    for (const kf of r.recent) {
      if (kf.survivingFraction !== -1 && (kf.survivingFraction < 0 || kf.survivingFraction > 1)) {
        this.rateOutOfRange++;
      }
    }
    // §18: a quaternion has four components. A three-component orientation is an Euler triple,
    // and finding one anywhere is the failure — checked on the value, not on the field's name.
    for (const kf of r.recent) {
      if (kf.rotationFromPreviousDeg !== -1 && !Number.isFinite(kf.rotationFromPreviousDeg)) {
        this.eulerEmitted++;
      }
    }
    if (r.recent.length > Math.min(r.keyframes, 4)) this.sizeMismatches++;
  }

  getLast(): KeyframeReport | null {
    return this.last;
  }

  stats(running: boolean): KeyframeStats {
    const r = this.last;
    return {
      running,
      decisions: this.decisions,

      inserted: r?.inserted ?? false,
      reason: r?.reason ?? '',
      detail: r?.detail ?? 'no keyframe decision has been taken yet',
      conditions: r?.conditions ?? [],
      rotationDeg: r?.input.rotationDeg ?? -1,
      displacementPx: r?.input.displacementPx ?? -1,
      translationDirectionDeg:
        this.translationDirections.length > 0
          ? (this.translationDirections[this.translationDirections.length - 1] ?? -1)
          : -1,
      sinceLastMs: r?.input.sinceLastMs ?? -1,
      observations: r?.observations ?? 0,
      sharedWithLast: r?.sharedWithLast ?? 0,
      frameMotion: r?.frameMotion ?? '',
      scale: r?.scale ?? SCALE_LOCAL_UNITS,

      keyframes: r?.keyframes ?? 0,
      maxStoreSize: this.maxStoreSize,
      totalInserted: this.totalInserted,
      insertionsByReason: Object.fromEntries(this.byReason),
      geometricInsertions: this.geometricInsertions,
      heartbeatInsertions: this.heartbeatInsertions,
      recent: r?.recent ?? [],

      reasonMismatches: this.reasonMismatches,
      minIntervalViolations: this.minIntervalViolations,
      maxIntervalGaps: this.maxIntervalGaps,
      longestGapMs: round(this.longestGapMs, 1),

      staticDecisions: this.staticDecisions,
      staticSelectorInsertions: this.staticSelectorInsertions,
      staticGeometricInsertions: this.staticGeometricInsertions,
      stillIntervalGeometricInsertions: this.stillIntervalGeometricInsertions,
      stillIntervalDecisions: this.stillIntervalDecisions,
      stillIntervalViolations: [...this.stillIntervalViolations],
      staticInsertionsByReason: Object.fromEntries(this.staticByReason),
      staticMetronomeInsertions: this.staticMetronomeInsertions,
      staticRatio:
        this.staticSelectorInsertions > 0
          ? round(this.staticMetronomeInsertions / this.staticSelectorInsertions, 3)
          : -1,
      metronomeKeyframes: r?.metronomeKeyframes ?? 0,

      evictions: this.evictions,
      storeOverflows: this.storeOverflows,
      evictionsWithoutReason: this.evictionsWithoutReason,
      evictedNewest: this.evictedNewest,
      evictionsCoverageKept: this.evictionsCoverageKept,
      recentEvictions: [...this.recentEvictions],

      observationFloorViolations: this.observationFloorViolations,
      duplicateObservationIds: this.duplicateObservationIds,
      intrinsicsMismatches: this.intrinsicsMismatches,
      medianSharedWithLast: round(median(this.sharedCounts), 1),
      sharedBelowFloor: this.sharedBelowFloor,

      translationCondition: findTranslation(r?.conditions),
      translationFired: this.translationFired,
      translationDirectionSamples: this.translationDirections.length,
      medianTranslationDirectionDeg: round(median(this.translationDirections)),
      scaleViolations: this.scaleViolations,

      staleKeyframes: r?.staleKeyframes ?? 0,
      staleEver: this.staleEver,
      stalePartnerUsed: this.stalePartnerUsed,
      survivalSamples: this.survivals.length,
      medianSurvivingFraction: round(median(this.survivals), 4),
      droppedIncrements: this.droppedIncrements,
      ambiguousPosesDeclined: this.ambiguousPosesDeclined,

      meanKeyframeMs:
        this.costs.length > 0
          ? round(this.costs.reduce((a, b) => a + b, 0) / this.costs.length, 4)
          : -1,
      costSamples: this.costs.length,

      rateOutOfRange: this.rateOutOfRange,
      eulerEmitted: this.eulerEmitted,
      sizeMismatches: this.sizeMismatches,
    };
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe(this.stats(false)) as Record<string, JsonValue>;
  }
}

function findTranslation(
  conditions: readonly KeyframeConditionRecord[] | undefined,
): KeyframeConditionRecord | null {
  return conditions?.find((c) => c.name === 'TRANSLATION') ?? null;
}

/**
 * Does this keyframe's `K` follow from the frame geometry it recorded? (§H.0, KEY-004)
 *
 * Re-derived rather than trusted: a device rotation swaps the frame dimensions on the same track
 * and every one of `fx, fy, cx, cy` changes with it, so a keyframe that borrowed the *current*
 * `K` would be wrong for every view taken before the rotation — and Phase 9 triangulates from
 * these. The tolerance is a rounding tolerance only; the record carries three decimals.
 */
function intrinsicsFollowFrom(kf: KeyframeRecord): boolean {
  const k = intrinsicsFor(kf.intrinsics.width, kf.intrinsics.height, kf.intrinsics.assumedFovDeg);
  if (!k) return false;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.01;
  return (
    near(k.fx, kf.intrinsics.fx) &&
    near(k.fy, kf.intrinsics.fy) &&
    near(k.cx, kf.intrinsics.cx) &&
    near(k.cy, kf.intrinsics.cy) &&
    kf.intrinsics.estimated
  );
}

/** Re-exported so the screen and the tests name one set of numbers. */
export { MAX_KEYFRAMES, MIN_KEYFRAME_INTERVAL_MS, MAX_KEYFRAME_INTERVAL_MS };
