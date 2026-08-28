/**
 * Keyframe selection and the bounded store behind it (Phase 8 — v3 §20, v4 §20).
 *
 * Pure arithmetic over the numbers a frame produced. No DOM, no worker, no camera, no clock —
 * `at` arrives as a parameter — and, as the architecture audit enforces for this layer, it
 * cannot import from `tracking`, so the selector cannot see the population it is deciding about
 * or the harness that is scoring it. The same rule Phase 5 put on `geometry` and Phase 7 put on
 * `fusion`, for the same reason: KEY-002 scores this against a metronome running on the same
 * stream, and a selector able to reach the harness could read which one it is.
 *
 * ## Why `decideKeyframe` is a function and not a method
 *
 * Rule 002, for the fifth phase running. The decision is a pure function of the inputs recorded
 * beside it, so `KeyframeSession` can re-derive every decision the stage reported and count the
 * ones that do not follow. A selector that inserted on a timer and attached the label `ROTATION`
 * would satisfy every count in this phase and be caught by exactly that check — which is only
 * possible because the deciding lives here, in one place, taking nothing but its arguments.
 *
 * ## What v3 §20 asks for, and the one condition that cannot be answered
 *
 * Four conditions, a minimum interval and a maximum. Three of the four are measurable here.
 * The second — *relative translation ≥ 0.10 local unit* — is a **magnitude**, and Phase 6
 * recovers a unit direction with `SCALE: LOCAL_UNITS` because v3 §15 and v4 §18 both forbid a
 * monocular camera claiming one. So it is carried in every decision as `UNMEASURED` with that
 * reason and it never fires. What fires in its place is v3 §20's own third condition, the median
 * displacement of the features the two views share, which is the same quantity in the units this
 * platform can actually produce. See `docs/phase8/TEST-PLAN.md`, KEY-005.
 */

import type { Intrinsics } from '../geometry/intrinsics';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase8/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/** v3 §20. */
export const KEYFRAME_ROTATION_DEG = 10.0;

/**
 * v3 §20's translation condition, carried and never evaluated.
 *
 * It is here so the refusal is a **value** rather than an absent field — the shape IMU-006
 * established for `POSITION: UNAVAILABLE`. A later phase that acquires a scale has to remove
 * this deliberately rather than by forgetting.
 */
export const KEYFRAME_TRANSLATION_UNITS = 0.1;

/** v3 §20. Measured over the features the two views share, in level-0 pixels. */
export const KEYFRAME_DISPLACEMENT_PX = 30.0;

/** v3 §20. */
export const MIN_KEYFRAME_INTERVAL_MS = 500;
export const MAX_KEYFRAME_INTERVAL_MS = 5000;

/** §56 and §H.1's memory ceiling, fixed in the implementation plan before Phase 0 ran. */
export const MAX_KEYFRAMES = 30;

/**
 * What makes a change in tracking quality "significant" — v3 §20 says the words and no number.
 *
 * Not chosen here: v3 §14 separates a **usable** inlier ratio (> 0.35) from a **GOOD** one
 * (> 0.50), and 0.15 is the width of that band. A change that large moves the frame from one of
 * the spec's own quality classes to the other. A change of §33's tracking *state* fires the
 * condition too, and that needs no threshold at all.
 */
export const KEYFRAME_QUALITY_DELTA = 0.15;

/**
 * Below this a view cannot be half of a two-view geometry, so it is not worth keeping.
 *
 * `MIN_CORRESPONDENCES` from v3 §14's neighbourhood, reused rather than re-derived (§H.6).
 * Phase 9 pairs consecutive keyframes; a keyframe holding fewer observations than a pair needs
 * is a keyframe Phase 9 could never use.
 */
export const MIN_KEYFRAME_OBSERVATIONS = 20;

/**
 * When a keyframe has stopped describing anything the current frame can be related to.
 *
 * v4 §20: 古い情報を盲目的に永久利用しない. This is that made measurable, and it is deliberately
 * **not** a function of age: a quarter of the observations surviving is the point below which a
 * keyframe holding the ~80 points Phase 4's device run kept can no longer supply
 * `MIN_KEYFRAME_OBSERVATIONS` to a pair. Age is not a defect and is not treated as one.
 */
export const STALE_SURVIVAL_FRACTION = 0.25;

/** v4 §18, carried on every record so a later phase has to remove it deliberately. */
export const SCALE_LOCAL_UNITS = 'LOCAL_UNITS';

export const KeyframeReason = {
  /** The first view of a run. Nothing to compare against, so it is kept. */
  FIRST: 'FIRST',
  ROTATION: 'ROTATION',
  DISPLACEMENT: 'DISPLACEMENT',
  QUALITY: 'QUALITY',
  /** v3 §20's maximum interval elapsed with no condition met. */
  HEARTBEAT: 'HEARTBEAT',
  /* --- refusals --- */
  /** v3 §20's minimum interval has not elapsed. */
  TOO_SOON: 'TOO_SOON',
  /** No condition fired and the maximum interval has not elapsed. */
  NO_CONDITION: 'NO_CONDITION',
  /** This view holds too few features to be half of a pair. */
  TOO_FEW_OBSERVATIONS: 'TOO_FEW_OBSERVATIONS',
} as const;
export type KeyframeReason = (typeof KeyframeReason)[keyof typeof KeyframeReason];

/** Whether a condition's value is a measurement at all. `UNMEASURED` never fires. */
export const ConditionState = {
  MEASURED: 'MEASURED',
  /** The quantity exists in v3 §20 and cannot be produced by this build. */
  UNMEASURED: 'UNMEASURED',
  /** Measurable in principle, absent on this frame — no pose, no shared features. */
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ConditionState = (typeof ConditionState)[keyof typeof ConditionState];

/** One of v3 §20's conditions, with its measured value beside its threshold. */
export interface ConditionRecord {
  readonly name: string;
  readonly value: number;
  readonly threshold: number;
  readonly unit: string;
  readonly state: ConditionState;
  readonly fired: boolean;
  readonly note: string;
}

/**
 * Everything the decision depends on, and nothing else.
 *
 * Carried into the report verbatim so `KeyframeSession` can call `decideKeyframe` again on it
 * and compare — Rule 002's re-derivation, which is only a check if the inputs travel with the
 * answer.
 */
export interface KeyframeDecisionInput {
  readonly at: number;
  /** Features in this view. Below `MIN_KEYFRAME_OBSERVATIONS` the view is not kept. */
  readonly observations: number;
  readonly hasPrevious: boolean;
  /** Milliseconds since the last keyframe. `-1` when there is none. */
  readonly sinceLastMs: number;
  /** Rotation accumulated since the last keyframe, degrees. `-1` where it could not be formed. */
  readonly rotationDeg: number;
  /** Median displacement over the features shared with the last keyframe. `-1` where none. */
  readonly displacementPx: number;
  readonly inlierRatio: number;
  readonly previousInlierRatio: number;
  readonly trackingState: string;
  readonly previousTrackingState: string;
}

export interface KeyframeDecision {
  readonly insert: boolean;
  readonly reason: KeyframeReason;
  readonly detail: string;
  readonly conditions: readonly ConditionRecord[];
}

/**
 * v3 §20, as a pure function.
 *
 * Order matters and is the spec's: the observation floor first (a view that cannot be paired is
 * not a keyframe whatever else is true of it), then the maximum interval, then the minimum, then
 * the conditions. The maximum is checked **before** the minimum because it is the one that must
 * hold unconditionally — a run whose camera never moves still owes the store a view every five
 * seconds, and `MAX > MIN` makes the two consistent by construction.
 */
export function decideKeyframe(input: KeyframeDecisionInput): KeyframeDecision {
  const conditions = describeConditions(input);
  const fired = conditions.filter((c) => c.fired).map((c) => c.name);

  if (input.observations < MIN_KEYFRAME_OBSERVATIONS) {
    return {
      insert: false,
      reason: KeyframeReason.TOO_FEW_OBSERVATIONS,
      detail:
        `${input.observations} features in this view, below the ${MIN_KEYFRAME_OBSERVATIONS} a ` +
        'two-view pair needs — a view Phase 9 could never pair is not worth keeping',
      conditions,
    };
  }
  if (!input.hasPrevious) {
    return {
      insert: true,
      reason: KeyframeReason.FIRST,
      detail: 'the first view of the run; there is nothing to compare it against',
      conditions,
    };
  }
  if (input.sinceLastMs >= MAX_KEYFRAME_INTERVAL_MS) {
    return {
      insert: true,
      reason: KeyframeReason.HEARTBEAT,
      detail:
        `${Math.round(input.sinceLastMs)} ms since the last keyframe, at or past v3 §20's ` +
        `${MAX_KEYFRAME_INTERVAL_MS} ms maximum — kept with no condition met`,
      conditions,
    };
  }
  if (input.sinceLastMs < MIN_KEYFRAME_INTERVAL_MS) {
    return {
      insert: false,
      reason: KeyframeReason.TOO_SOON,
      detail:
        `${Math.round(input.sinceLastMs)} ms since the last keyframe, inside v3 §20's ` +
        `${MIN_KEYFRAME_INTERVAL_MS} ms minimum` +
        (fired.length > 0 ? ` (${fired.join(', ')} would otherwise have fired)` : ''),
      conditions,
    };
  }

  for (const name of [
    KeyframeReason.ROTATION,
    KeyframeReason.DISPLACEMENT,
    KeyframeReason.QUALITY,
  ] as const) {
    const c = conditions.find((x) => x.name === name);
    if (c && c.fired) {
      return {
        insert: true,
        reason: name,
        detail: `${c.name}: ${round(c.value, 3)} ${c.unit} against v3 §20's ${c.threshold}`,
        conditions,
      };
    }
  }

  return {
    insert: false,
    reason: KeyframeReason.NO_CONDITION,
    detail:
      'none of v3 §20’s conditions is met and the maximum interval has not elapsed — this ' +
      'view adds no viewpoint the store does not already hold',
    conditions,
  };
}

function describeConditions(input: KeyframeDecisionInput): ConditionRecord[] {
  const qualityDelta =
    input.inlierRatio >= 0 && input.previousInlierRatio >= 0
      ? Math.abs(input.inlierRatio - input.previousInlierRatio)
      : -1;
  const stateChanged =
    input.trackingState.length > 0 &&
    input.previousTrackingState.length > 0 &&
    input.trackingState !== input.previousTrackingState;

  return [
    {
      name: KeyframeReason.ROTATION,
      value: input.rotationDeg,
      threshold: KEYFRAME_ROTATION_DEG,
      unit: 'deg',
      state: input.rotationDeg >= 0 ? ConditionState.MEASURED : ConditionState.UNAVAILABLE,
      fired: input.rotationDeg >= KEYFRAME_ROTATION_DEG,
      note:
        'accumulated from Phase 6’s per-frame increments, not read from one report: its ' +
        'rotation is measured from Phase 5’s anchor, and across a re-anchor two such ' +
        'rotations have different origins',
    },
    {
      name: 'TRANSLATION',
      value: -1,
      threshold: KEYFRAME_TRANSLATION_UNITS,
      unit: 'local unit',
      state: ConditionState.UNMEASURED,
      fired: false,
      note:
        'v3 §20 asks for a translation **magnitude**. Phase 6 recovers a unit direction with ' +
        'SCALE: LOCAL_UNITS, because v3 §15 and v4 §18 forbid a monocular camera claiming a ' +
        'distance — so there is no such magnitude in this build and this condition never ' +
        'fires. DISPLACEMENT below is the same quantity in the units the platform can produce',
    },
    {
      name: KeyframeReason.DISPLACEMENT,
      value: input.displacementPx,
      threshold: KEYFRAME_DISPLACEMENT_PX,
      unit: 'px',
      state: input.displacementPx >= 0 ? ConditionState.MEASURED : ConditionState.UNAVAILABLE,
      fired: input.displacementPx >= KEYFRAME_DISPLACEMENT_PX,
      note:
        'median over the features this view and the last keyframe **share**, by feature id — a ' +
        'net displacement between exactly those two views, which needs no anchor',
    },
    {
      name: KeyframeReason.QUALITY,
      value: qualityDelta,
      threshold: KEYFRAME_QUALITY_DELTA,
      unit: 'inlier ratio',
      state:
        qualityDelta >= 0 || stateChanged ? ConditionState.MEASURED : ConditionState.UNAVAILABLE,
      fired: stateChanged || qualityDelta >= KEYFRAME_QUALITY_DELTA,
      note: stateChanged
        ? `§33's tracking state moved ${input.previousTrackingState} → ${input.trackingState}, ` +
          'which is a change of quality class and needs no threshold'
        : 'the inlier ratio moved by v3 §14’s own usable→GOOD band, so the frame changed ' +
          'quality class rather than merely changing',
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

export interface KeyframeObservation {
  /** `FlowTracker`'s id, unique for the life of the run. */
  readonly id: number;
  /** Level-0 pixels, which is what every later phase works in. */
  readonly x: number;
  readonly y: number;
}

export interface Keyframe {
  readonly id: number;
  readonly at: number;
  readonly frameIndex: number;
  readonly reason: KeyframeReason;
  readonly observations: readonly KeyframeObservation[];
  /**
   * The frame's **own** intrinsics (§H.0).
   *
   * A device rotation swaps the frame dimensions on the same track and every one of
   * `fx, fy, cx, cy` changes with it. A keyframe that borrowed the current `K` would be wrong
   * for every view taken before the rotation — and Phase 9 triangulates from these.
   */
  readonly intrinsics: Intrinsics;
  readonly rotationFromPreviousDeg: number;
  readonly displacementFromPreviousPx: number;
  /** The refusal's number: how far the translation *direction* moved. `-1` where not formable. */
  readonly translationDirectionDeg: number;
  /** Rotation increment previous → this, as a quaternion. `null` where increments were dropped. */
  readonly quaternionFromPrevious: readonly number[] | null;
  /** Increments dropped across a Phase 5 re-anchor while this keyframe was accumulating. */
  readonly droppedIncrements: number;
  readonly inlierRatio: number;
  readonly trackedFeatures: number;
  readonly trackingState: string;
  readonly poseConfidence: number;
}

export const EvictionReason = {
  /** Fewer than `STALE_SURVIVAL_FRACTION` of its observations are still tracked. */
  STALE: 'STALE',
  /** Nothing was stale, so the most redundant viewpoint went — see `chooseVictim`. */
  REDUNDANT: 'REDUNDANT',
} as const;
export type EvictionReason = (typeof EvictionReason)[keyof typeof EvictionReason];

export interface Eviction {
  readonly keyframeId: number;
  readonly reason: EvictionReason;
  readonly detail: string;
  readonly survivingFraction: number;
  /** Median pairwise separation of the set this policy retained, px. */
  readonly retainedSeparationPx: number;
  /** ...and of the set dropping the oldest would have retained. KEY-003's counterfactual. */
  readonly oldestFirstSeparationPx: number;
}

/**
 * A bounded set of keyframes, and a policy for what goes when it is full.
 *
 * §56 and §H.1 fix the bound at 30. The policy is the interesting half, and v4 §20 states the
 * requirement it has to meet: 古い情報を盲目的に永久利用しない — do not go on using old
 * information blindly. Two things follow, and they pull in opposite directions:
 *
 *  - a keyframe whose observations have all been lost cannot be related to the present, so it
 *    goes first, whatever its age;
 *  - and when nothing is stale, what goes is the **most redundant viewpoint**, not the oldest.
 *    Dropping the oldest is the obvious policy and it is the wrong one: it converts a store
 *    that describes the room into a store that describes the last fifteen seconds, which is
 *    exactly the failure §56's bound would otherwise cause rather than prevent.
 *
 * The counterfactual is measured rather than argued: every eviction records what the retained
 * set's median pairwise separation came to, and what dropping the oldest would have given.
 * KEY-003's fifth criterion reads those two numbers.
 */
export class KeyframeStore {
  private readonly frames: Keyframe[] = [];
  private readonly survival = new Map<number, number>();
  private nextId = 1;
  private evictionCount = 0;

  reset(): void {
    this.frames.length = 0;
    this.survival.clear();
    this.nextId = 1;
    this.evictionCount = 0;
  }

  size(): number {
    return this.frames.length;
  }

  all(): readonly Keyframe[] {
    return this.frames;
  }

  /** The newest keyframe — the one the next decision is measured against. */
  last(): Keyframe | null {
    return this.frames.length > 0 ? (this.frames[this.frames.length - 1] ?? null) : null;
  }

  /** The newest keyframe that is **not** stale, which is what a comparison may use (KEY-006). */
  lastUsable(): Keyframe | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const kf = this.frames[i];
      if (!kf) continue;
      if (!this.isStale(kf.id)) return kf;
    }
    return null;
  }

  nextKeyframeId(): number {
    return this.nextId;
  }

  totalEvictions(): number {
    return this.evictionCount;
  }

  /** Record how much of a keyframe is still being tracked. Never a function of age (KEY-006). */
  noteSurvival(id: number, fraction: number): void {
    this.survival.set(id, fraction);
  }

  survivingFraction(id: number): number {
    return this.survival.get(id) ?? -1;
  }

  isStale(id: number): boolean {
    const f = this.survival.get(id);
    return f !== undefined && f >= 0 && f < STALE_SURVIVAL_FRACTION;
  }

  staleCount(): number {
    return this.frames.filter((kf) => this.isStale(kf.id)).length;
  }

  /**
   * Add a keyframe, evicting first where the bound requires it.
   *
   * Returns the eviction, so the report can carry which keyframe went and why rather than a
   * size that silently stopped growing.
   */
  insert(kf: Omit<Keyframe, 'id'>): { keyframe: Keyframe; eviction: Eviction | null } {
    let eviction: Eviction | null = null;
    if (this.frames.length >= MAX_KEYFRAMES) eviction = this.evict();
    const keyframe: Keyframe = { ...kf, id: this.nextId++ };
    this.frames.push(keyframe);
    this.survival.set(keyframe.id, 1);
    return { keyframe, eviction };
  }

  private evict(): Eviction | null {
    // The newest is never a candidate: it is the view the next decision is measured against, and
    // evicting it would leave the selector comparing the present against something it discarded.
    const candidates = this.frames.slice(0, -1);
    if (candidates.length === 0) return null;

    const victim = this.chooseVictim(candidates);
    const index = this.frames.findIndex((k) => k.id === victim.keyframe.id);
    if (index < 0) return null;

    const retained = this.frames.filter((_, i) => i !== index);
    const oldestFirst = this.frames.slice(1);
    const survivingFraction = this.survivingFraction(victim.keyframe.id);

    this.frames.splice(index, 1);
    this.survival.delete(victim.keyframe.id);
    this.evictionCount++;

    return {
      keyframeId: victim.keyframe.id,
      reason: victim.reason,
      detail: victim.detail,
      survivingFraction: round(survivingFraction, 4),
      retainedSeparationPx: round(medianPairwiseSeparation(retained), 3),
      oldestFirstSeparationPx: round(medianPairwiseSeparation(oldestFirst), 3),
    };
  }

  private chooseVictim(candidates: readonly Keyframe[]): {
    keyframe: Keyframe;
    reason: EvictionReason;
    detail: string;
  } {
    let stalest: Keyframe | null = null;
    let stalestFraction = Number.POSITIVE_INFINITY;
    for (const kf of candidates) {
      if (!this.isStale(kf.id)) continue;
      const f = this.survivingFraction(kf.id);
      if (f < stalestFraction) {
        stalestFraction = f;
        stalest = kf;
      }
    }
    if (stalest) {
      return {
        keyframe: stalest,
        reason: EvictionReason.STALE,
        detail:
          `${Math.round(stalestFraction * 1000) / 10}% of its observations are still tracked, ` +
          `below ${STALE_SURVIVAL_FRACTION * 100}% — it can no longer be related to the present`,
      };
    }

    // Nothing stale. What goes is the view that **duplicates another most closely** — the one
    // whose nearest neighbour is nearest — not the oldest. Dropping the oldest is the obvious
    // policy and it is the wrong one: it turns a store that describes the room into one that
    // describes the last fifteen seconds.
    //
    // The first version scored a candidate by the sum of its two neighbour gaps, which is the
    // gap its removal would leave. On a camera panning in one direction that is the same number
    // for every interior keyframe — the separations add along the path — so the measure could
    // not tell a duplicated view from an evenly spaced one, and its only real effect was to
    // favour the endpoints, whose missing side counted as a zero. Both are fixed here: the
    // nearest neighbour decides, the merged gap breaks ties, and a side that cannot be measured
    // is `Infinity` rather than `0`, because two keyframes sharing no features are not "in the
    // same place" — they are not comparable, and a view that cannot be compared is not one to
    // discard on redundancy grounds.
    let victim = candidates[0] as Keyframe;
    let bestNearest = Number.POSITIVE_INFINITY;
    let bestMerged = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i++) {
      const kf = candidates[i];
      if (!kf) continue;
      const before = i > 0 ? sepOrInfinity(candidates[i - 1] as Keyframe, kf) : Infinity;
      const after =
        i + 1 < this.frames.length
          ? sepOrInfinity(kf, this.frames[i + 1] as Keyframe)
          : Infinity;
      const nearest = Math.min(before, after);
      const merged = before + after;
      if (nearest < bestNearest || (nearest === bestNearest && merged < bestMerged)) {
        bestNearest = nearest;
        bestMerged = merged;
        victim = kf;
      }
    }
    return {
      keyframe: victim,
      reason: EvictionReason.REDUNDANT,
      detail: Number.isFinite(bestNearest)
        ? `nothing is stale, so the most redundant viewpoint goes: its nearest neighbour is ` +
          `${round(bestNearest, 1)} px away, the closest pair in the store`
        : 'nothing is stale and no two keyframes in the store share enough features to be ' +
          'compared, so the oldest goes — there is no redundancy to measure',
    };
  }
}

/**
 * Median displacement over the features two keyframes share, in level-0 pixels.
 *
 * `-1` where they share nothing — which is not a separation of zero. Two views with no feature
 * in common are not in the same place; they are not comparable, and the difference matters to
 * the eviction policy above.
 */
export function separationPx(a: Keyframe, b: Keyframe): number {
  const byId = new Map<number, KeyframeObservation>();
  for (const o of a.observations) byId.set(o.id, o);
  const d: number[] = [];
  for (const o of b.observations) {
    const p = byId.get(o.id);
    if (!p) continue;
    d.push(Math.hypot(o.x - p.x, o.y - p.y));
  }
  return median(d);
}

/**
 * ...and over every pair in a set. KEY-003's coverage figure.
 *
 * Each keyframe's observations are indexed **once** rather than once per pair. With thirty
 * keyframes that is 435 pairs, and the first version built one index per pair — 435 index builds
 * over a population the desktop leg fills to several hundred points, which put the eviction
 * frames at tens of milliseconds each and Phase 8's mean cost over its own 1 ms ceiling. §H.8:
 * a cost measured before the obvious inefficiency is removed is not a measurement of the
 * platform.
 */
export function medianPairwiseSeparation(frames: readonly Keyframe[]): number {
  const index = frames.map((kf) => {
    const m = new Map<number, KeyframeObservation>();
    for (const o of kf.observations) m.set(o.id, o);
    return m;
  });
  const d: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const a = index[i];
    if (!a) continue;
    for (let j = i + 1; j < frames.length; j++) {
      const b = frames[j];
      if (!b) continue;
      const s = separationBetween(a, b);
      if (s >= 0) d.push(s);
    }
  }
  return median(d);
}

function separationBetween(
  index: ReadonlyMap<number, KeyframeObservation>,
  b: Keyframe,
): number {
  const d: number[] = [];
  for (const o of b.observations) {
    const p = index.get(o.id);
    if (!p) continue;
    d.push(Math.hypot(o.x - p.x, o.y - p.y));
  }
  return median(d);
}

/**
 * KEY-002's twin: a selector that fires as often as the real one is *allowed* to.
 *
 * This is fake 1 from the test plan, implemented and run beside the real thing on the same
 * stream — Phase 7's injected-bias twin in a different phase. On a moving camera it produces a
 * perfectly reasonable set, because on a moving camera any schedule does. On a camera that is
 * not moving it keeps inserting, and the real selector does not, and the difference between the
 * two counts is the one number this phase cannot fake.
 */
export class Metronome {
  private lastAt = -1;
  private count = 0;

  constructor(private readonly intervalMs: number = MIN_KEYFRAME_INTERVAL_MS) {}

  reset(): void {
    this.lastAt = -1;
    this.count = 0;
  }

  /** Would a fixed-interval selector have inserted on this frame? */
  note(at: number): boolean {
    if (this.lastAt >= 0 && at - this.lastAt < this.intervalMs) return false;
    this.lastAt = at;
    this.count++;
    return true;
  }

  inserted(): number {
    return this.count;
  }
}

/** A separation, or `Infinity` where the two views share nothing. Never `0` — see `chooseVictim`. */
function sepOrInfinity(a: Keyframe, b: Keyframe): number {
  const s = separationPx(a, b);
  return s >= 0 ? s : Number.POSITIVE_INFINITY;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
