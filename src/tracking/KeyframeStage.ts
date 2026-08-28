/**
 * One Phase 8 frame, end to end, with no worker around it (v3 §20, v4 §20).
 *
 * The worker calls this and adds nothing, for the same reason `FlowStage`, `VerificationStage`,
 * `PoseStage` and `FusionStage` exist: the Phase 8 test plan requires a **metronome** — a
 * selector that fires on a schedule and labels its records with geometric reasons — to be shown
 * to fail, and a unit test that reimplemented the frame loop to prove it would be proving
 * something about the reimplementation. `tests/unit/keyframes.test.ts` drives this.
 *
 * ## The two quantities this stage has to assemble rather than read
 *
 * **Rotation since the last keyframe.** Phase 6 reports a rotation measured from *Phase 5's
 * anchor*, which is re-taken on its own schedule; across a re-anchor two such rotations have
 * different origins and their difference means nothing. So the total is assembled **per anchor
 * epoch**: within one epoch it is `conj(q_at_keyframe) · q_now`, one composition however many
 * frames have passed, and the epochs are chained by one composition each at the re-anchor.
 *
 * The first version composed a per-frame increment instead — `conj(q_prev) · q_cur` on every
 * frame — which is what `FusionStage` does with its visual increments, and it is wrong here for
 * a reason that only shows up over a long interval: **composing noisy increments is a random
 * walk**. On the leg's lateral pan, where the true rotation is zero throughout, the accumulated
 * angle reached v3 §20's 10° and fired `ROTATION` **seven times while the image was not moving
 * at all** — a run of the same leg after this change fires it none. Phase 7 composes over one
 * second and is unaffected; Phase 8 composes over up to five, and the difference is the length
 * of the interval rather than the correctness of the arithmetic.
 *
 * What is still lost is the turn between the last view of the old epoch and the first of the new,
 * which no report measures. `droppedIncrements` counts those, because a run that dropped several
 * has a rotation figure that understates by that much and the reader has to be able to see it.
 * On a **still** camera that gap is nearly the whole epoch — the anchor is re-taken from the
 * current frame, the two views collapse to no baseline, and Phase 6 recovers nothing until
 * something moves — which is correct, and is why the re-anchor is handled on frames with no pose
 * as well as on frames with one.
 *
 * **Displacement since the last keyframe.** Not Phase 5's `baselinePx`, which is measured from
 * the anchor — a different view. Each keyframe keeps its observations by `FlowTracker` id, and
 * the displacement is the median over the ids this view and that keyframe **share**. That is a
 * net displacement between exactly the two views in question and it needs no anchor.
 *
 * ## What the store is compared against
 *
 * A `Metronome`, running on the same frames, firing as often as the real selector is allowed to.
 * KEY-002 is the difference between the two counts over a segment where Phase 4's own
 * independent scene-shift search reported `STATIC` — an instrument this stage does not compute
 * and cannot influence.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { angleDeg, conjugate, multiply, normalise } from '../fusion/quat';
import type { Quat } from '../fusion/quat';
import { intrinsicsFor } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import {
  KeyframeReason,
  KeyframeStore,
  Metronome,
  SCALE_LOCAL_UNITS,
  STALE_SURVIVAL_FRACTION,
  decideKeyframe,
} from '../mapping/keyframes';
import type { Keyframe, KeyframeDecisionInput, KeyframeObservation } from '../mapping/keyframes';
import { FrameMotion } from './SceneShift';
import type { FlowTracker } from './FlowTracker';
import type {
  KeyframeDecisionRecord,
  KeyframeRecord,
  KeyframeReport,
  PoseReport,
  TrackingFlow,
  VerificationReport,
} from './trackingMessages';

/** How many stored keyframes travel back to the main thread each frame. */
const RECENT_KEYFRAMES = 4;

export interface KeyframeStageInput {
  /** The frame clock, in the worker's own `performance.now()` domain. */
  readonly at: number;
  readonly frameIndex: number;
  /**
   * The live Phase 4 population, by the two methods this stage reads.
   *
   * Narrowed to `Pick` rather than taken as the whole tracker so the unit fixture can drive the
   * real stage over a synthetic population without constructing a Lucas-Kanade solver — the
   * stage under test is the selector, and a fixture that had to build a tracker to exercise it
   * would be testing the tracker.
   */
  readonly tracker: Pick<FlowTracker, 'getPopulation' | 'getFrameIndex'>;
  /** Level-0 geometry, from which this keyframe's own `K` is derived (§H.0). */
  readonly width: number;
  readonly height: number;
  readonly pose: PoseReport | null;
  readonly verification: VerificationReport | null;
  readonly flow: TrackingFlow | null;
}

export class KeyframeStage {
  private readonly store = new KeyframeStore();
  private readonly metronome = new Metronome();

  private frames = 0;
  private decisions = 0;
  private inserted = 0;

  /** Phase 6's last rotation, in the *current* anchor's frame. */
  private lastPoseQ: Quat | null = null;
  /** ...and the rotation this epoch started from: the pose when the epoch or the keyframe began. */
  private epochBaseQ: Quat | null = null;
  /** Rotation accumulated over epochs that have already closed. Identity at every insertion. */
  private carried: Quat = [1, 0, 0, 0];
  private hasRotation = false;
  private droppedIncrements = 0;
  private reAnchorsSinceKeyframe = 0;
  /** The translation direction of the last keyframe, in that keyframe's anchor frame. */
  private lastKeyframeTranslation: readonly number[] | null = null;
  private staleEver = 0;
  /** Whether every decision since the last keyframe saw a still image — KEY-002's subject. */
  private intervalStatic = true;
  /** Poses declined because Phase 6 could not separate the decomposition's candidates. */
  private ambiguousPosesDeclined = 0;
  /** Observation ids that repeated inside one keyframe. `FlowTracker`'s ids are run-unique, so
   * this is a check on that invariant rather than an expected condition — KEY-004. */
  private duplicateIds = 0;

  reset(): void {
    this.store.reset();
    this.metronome.reset();
    this.frames = 0;
    this.decisions = 0;
    this.inserted = 0;
    this.lastPoseQ = null;
    this.epochBaseQ = null;
    this.carried = [1, 0, 0, 0];
    this.hasRotation = false;
    this.droppedIncrements = 0;
    this.reAnchorsSinceKeyframe = 0;
    this.lastKeyframeTranslation = null;
    this.staleEver = 0;
    this.intervalStatic = true;
    this.ambiguousPosesDeclined = 0;
    this.duplicateIds = 0;
  }

  /** The store, for the phases that consume it. Read-only by convention and by `readonly`. */
  keyframes(): readonly Keyframe[] {
    return this.store.all();
  }

  process(input: KeyframeStageInput): KeyframeReport {
    const t0 = performance.now();
    this.frames++;
    this.decisions++;

    const observations: KeyframeObservation[] = this.observationsOf(input.tracker);
    const currentIds = new Set(observations.map((o) => o.id));
    if (currentIds.size !== observations.length) {
      this.duplicateIds += observations.length - currentIds.size;
    }

    this.advanceRotation(input);
    this.updateSurvival(currentIds);

    const partner = this.store.lastUsable();
    const displacement = partner ? medianSharedDisplacement(partner, observations) : -1;
    const shared = partner ? countShared(partner, currentIds) : 0;
    const translationDirectionDeg = this.translationDirectionDeg(input);

    const decisionInput: KeyframeDecisionInput = {
      at: input.at,
      observations: observations.length,
      hasPrevious: partner !== null,
      sinceLastMs: partner ? input.at - partner.at : -1,
      rotationDeg: this.hasRotation ? round(angleDeg(this.rotationSinceKeyframe()), 4) : -1,
      displacementPx: round(displacement, 4),
      inlierRatio: input.verification?.inlierRatio ?? -1,
      previousInlierRatio: partner?.inlierRatio ?? -1,
      trackingState: input.flow?.state ?? '',
      previousTrackingState: partner?.trackingState ?? '',
    };
    const decision = decideKeyframe(decisionInput);
    // Recorded **before** the insertion resets it, so the flag describes the interval the
    // decision was taken over rather than the empty one that follows it.
    const intervalStatic = this.intervalStatic && input.flow?.frameMotion === FrameMotion.STATIC;

    let evicted: KeyframeReport['evicted'] = null;
    if (decision.insert) {
      const k = intrinsicsFor(input.width, input.height);
      if (k) {
        const outcome = this.store.insert(
          this.buildKeyframe(input, decision.reason, observations, k, decisionInput, translationDirectionDeg),
        );
        evicted = outcome.eviction;
        this.inserted++;
        // The accumulators restart from this view: the next decision is about the distance from
        // *here*, not from wherever the run began.
        this.carried = [1, 0, 0, 0];
        this.epochBaseQ = this.lastPoseQ;
        this.droppedIncrements = 0;
        this.reAnchorsSinceKeyframe = 0;
        this.lastKeyframeTranslation = input.pose?.translation ? [...input.pose.translation] : null;
        this.intervalStatic = true;
        this.ambiguousPosesDeclined = 0;
      }
    }

    if (input.flow?.frameMotion !== FrameMotion.STATIC) this.intervalStatic = false;

    const metronomeInserted = this.metronome.note(input.at);
    const stale = this.store.staleCount();
    if (stale > 0) this.staleEver = Math.max(this.staleEver, stale);

    return {
      frames: this.frames,
      decisions: this.decisions,
      inserted: decision.insert,
      reason: decision.reason,
      detail: decision.detail,
      conditions: decision.conditions.map((c) => ({ ...c, value: round(c.value, 4) })),
      // Carried **unrounded**, and that is not an oversight. The first version rounded
      // `sinceLastMs` to a tenth of a millisecond for readability, and 499.99999999999955 became
      // 500 — so the session's re-derivation disagreed with the stage on every decision that
      // landed on v3 §20's minimum interval, 30 of them in a 32-second fixture. A re-derivation
      // whose inputs have been reformatted is checking the formatter. The decision's inputs and
      // the recorded inputs have to be the same numbers, to the bit.
      input: decisionInput as KeyframeDecisionRecord,
      observations: observations.length,
      sharedWithLast: shared,
      partnerKeyframeId: partner?.id ?? -1,
      partnerStale: partner ? this.store.isStale(partner.id) : false,
      duplicateObservationIds: this.duplicateIds,
      frameMotion: input.flow?.frameMotion ?? 'INDETERMINATE',
      intervalStatic,
      poseState: input.pose?.state ?? 'NO_POSE',
      poseAmbiguous: input.pose?.ambiguous ?? false,
      poseRotationConfidence: input.pose?.rotationConfidence ?? -1,
      poseUnseparatedCandidates: input.pose?.unseparatedCandidates ?? 0,
      keyframes: this.store.size(),
      totalInserted: this.inserted,
      totalEvictions: this.store.totalEvictions(),
      evicted,
      staleKeyframes: stale,
      droppedIncrements: this.droppedIncrements,
      ambiguousPosesDeclined: this.ambiguousPosesDeclined,
      reAnchorsSinceKeyframe: this.reAnchorsSinceKeyframe,
      scale: SCALE_LOCAL_UNITS,
      metronomeInserted,
      metronomeKeyframes: this.metronome.inserted(),
      recent: this.recentRecords(),
      keyframeMs: round(performance.now() - t0, 4),
    };
  }

  /** This view's features, in level-0 pixels, with the ids that persist for the run. */
  private observationsOf(tracker: KeyframeStageInput['tracker']): KeyframeObservation[] {
    return tracker.getPopulation().map((f) => ({ id: f.id, x: f.x0, y: f.y0 }));
  }

  /**
   * Close the anchor epoch if one ended on this frame, and carry the pose forward.
   *
   * One composition per re-anchor, not per frame — see the header for the measurement that
   * forced that. What crossing a re-anchor loses is the turn between the last view of the old
   * epoch and the first of the new, which no report measures; that is what `droppedIncrements`
   * counts.
   */
  private advanceRotation(input: KeyframeStageInput): void {
    // The re-anchor is handled **before** the pose, and unconditionally.
    //
    // The first version returned early on a frame Phase 6 recovered nothing from, which skipped
    // this — so a re-anchor landing on a pose-less frame left `epochBaseQ` holding a rotation
    // measured from the *old* anchor while the next pose to arrive was measured from the new
    // one. Their difference is not a rotation of the camera, and it is large.
    //
    // That is not a rare alignment: it is what a **still** camera produces. The anchor is
    // re-taken from the current frame, the two views collapse to no baseline, Phase 5 reports
    // UNVERIFIED and Phase 6 reports NO_POSE for as long as nothing moves. The automated leg
    // caught it as `ROTATION` firing on a pure lateral pan over intervals in which nothing moved
    // at all — 4 of them in a sixty-second run, on one run in five.
    if (input.verification?.reAnchored ?? false) {
      this.reAnchorsSinceKeyframe++;
      if (this.epochBaseQ && this.lastPoseQ) {
        this.carried = normalise(
          multiply(this.carried, multiply(conjugate(this.epochBaseQ), this.lastPoseQ)),
        );
        this.droppedIncrements++;
      }
      // Both are cleared, so the next pose to arrive — whenever it arrives — establishes the new
      // epoch's base in the frame it was actually measured in.
      this.epochBaseQ = null;
      this.lastPoseQ = null;
    }

    const q = input.pose?.quaternion;
    if (!q || q.length !== 4) return;

    // **A pose Phase 6 could not settle is not a rotation to accumulate.**
    //
    // `ambiguous` means cheirality did not separate the decomposition's candidates — Phase 6
    // reports the pose it chose *and says it could not tell*. On a static image that is not a
    // rare condition: the correspondences stop changing, the configuration stops separating the
    // candidates, and the recovered rotation **alternates** between two of them. The leg measured
    // the alternation at 18° and this stage was faithfully accumulating it into `ROTATION` on a
    // pure lateral pan where the true rotation is zero — four insertions in one sixty-second run,
    // on two runs in six.
    //
    // Every one of those violations carried `ambiguous: true` with two unseparated candidates.
    // The phase below had already said so; this one was not listening. v4 §25: 低Confidenceの
    // 情報は、ゲーム生成やCollisionで重要度を下げるか使用禁止にする.
    //
    // Declined rather than corrected: the accumulator holds at its last settled value, which is
    // what "nothing new is known" looks like, and the count travels in every record.
    if (input.pose?.ambiguous === true) {
      this.ambiguousPosesDeclined++;
      return;
    }

    const cur = normalise([q[0] ?? 1, q[1] ?? 0, q[2] ?? 0, q[3] ?? 0]);
    if (!this.epochBaseQ) this.epochBaseQ = cur;
    this.lastPoseQ = cur;
    this.hasRotation = true;
  }

  /** The total since the last keyframe: closed epochs, plus the open one. */
  private rotationSinceKeyframe(): Quat {
    if (!this.epochBaseQ || !this.lastPoseQ) return this.carried;
    return normalise(multiply(this.carried, multiply(conjugate(this.epochBaseQ), this.lastPoseQ)));
  }

  /**
   * KEY-005's number: how far the translation *direction* has moved since the last keyframe.
   *
   * `-1` where a re-anchor has intervened, because the two directions are then expressed in
   * different frames and the angle between them is not a rotation of anything. This is not the
   * magnitude v3 §20 asks for and it is not offered as one — it is what the platform *can*
   * measure, printed beside a refusal so the refusal carries a number.
   */
  private translationDirectionDeg(input: KeyframeStageInput): number {
    const t = input.pose?.translation;
    const prev = this.lastKeyframeTranslation;
    if (!t || !prev || t.length !== 3 || prev.length !== 3) return -1;
    if (this.reAnchorsSinceKeyframe > 0) return -1;
    const dot =
      (t[0] ?? 0) * (prev[0] ?? 0) + (t[1] ?? 0) * (prev[1] ?? 0) + (t[2] ?? 0) * (prev[2] ?? 0);
    const c = Math.max(-1, Math.min(1, dot));
    return round((Math.acos(c) * 180) / Math.PI, 4);
  }

  /**
   * How much of each stored keyframe is still being tracked (KEY-006).
   *
   * A function of surviving observations and of nothing else — deliberately not of age. v4 §20
   * forbids using old information blindly; it does not say old information is bad, and a
   * keyframe whose points are all still visible is as useful as the day it was taken.
   */
  private updateSurvival(currentIds: ReadonlySet<number>): void {
    for (const kf of this.store.all()) {
      if (kf.observations.length === 0) {
        this.store.noteSurvival(kf.id, 0);
        continue;
      }
      let alive = 0;
      for (const o of kf.observations) if (currentIds.has(o.id)) alive++;
      this.store.noteSurvival(kf.id, alive / kf.observations.length);
    }
  }

  private buildKeyframe(
    input: KeyframeStageInput,
    reason: KeyframeReason,
    observations: readonly KeyframeObservation[],
    k: Intrinsics,
    decisionInput: KeyframeDecisionInput,
    translationDirectionDeg: number,
  ): Omit<Keyframe, 'id'> {
    return {
      at: input.at,
      frameIndex: input.frameIndex,
      reason,
      observations: [...observations],
      intrinsics: k,
      rotationFromPreviousDeg: decisionInput.rotationDeg,
      displacementFromPreviousPx: decisionInput.displacementPx,
      translationDirectionDeg,
      quaternionFromPrevious:
        this.hasRotation && this.droppedIncrements === 0 ? [...this.rotationSinceKeyframe()] : null,
      droppedIncrements: this.droppedIncrements,
      inlierRatio: decisionInput.inlierRatio,
      trackedFeatures: input.flow?.tracked ?? -1,
      trackingState: decisionInput.trackingState,
      poseConfidence: input.pose?.confidence ?? -1,
    };
  }

  private recentRecords(): KeyframeRecord[] {
    return this.store
      .all()
      .slice(-RECENT_KEYFRAMES)
      .map((kf) => ({
        id: kf.id,
        at: round(kf.at, 1),
        frameIndex: kf.frameIndex,
        reason: kf.reason,
        observations: kf.observations.length,
        intrinsics: {
          fx: round(kf.intrinsics.fx, 3),
          fy: round(kf.intrinsics.fy, 3),
          cx: round(kf.intrinsics.cx, 3),
          cy: round(kf.intrinsics.cy, 3),
          width: kf.intrinsics.width,
          height: kf.intrinsics.height,
          estimated: true,
          assumedFovDeg: kf.intrinsics.assumedFovDeg,
        },
        rotationFromPreviousDeg: kf.rotationFromPreviousDeg,
        displacementFromPreviousPx: kf.displacementFromPreviousPx,
        translationDirectionDeg: kf.translationDirectionDeg,
        droppedIncrements: kf.droppedIncrements,
        inlierRatio: kf.inlierRatio,
        trackedFeatures: kf.trackedFeatures,
        trackingState: kf.trackingState,
        poseConfidence: kf.poseConfidence,
        survivingFraction: round(this.store.survivingFraction(kf.id), 4),
        stale: this.store.isStale(kf.id),
      }));
  }
}

/** Median displacement of the features a keyframe and the current view share, level-0 px. */
function medianSharedDisplacement(
  keyframe: Keyframe,
  observations: readonly KeyframeObservation[],
): number {
  const byId = new Map<number, KeyframeObservation>();
  for (const o of keyframe.observations) byId.set(o.id, o);
  const d: number[] = [];
  for (const o of observations) {
    const p = byId.get(o.id);
    if (!p) continue;
    d.push(Math.hypot(o.x - p.x, o.y - p.y));
  }
  if (d.length === 0) return -1;
  d.sort((a, b) => a - b);
  const mid = d.length >> 1;
  return d.length % 2 ? (d[mid] ?? 0) : (((d[mid - 1] ?? 0) + (d[mid] ?? 0)) / 2);
}

function countShared(keyframe: Keyframe, currentIds: ReadonlySet<number>): number {
  let n = 0;
  for (const o of keyframe.observations) if (currentIds.has(o.id)) n++;
  return n;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}

/** Re-exported so the screen, the tests and the session name one set of numbers. */
export { STALE_SURVIVAL_FRACTION };
