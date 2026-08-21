/**
 * Adaptive performance controller (§53, §54, §55).
 *
 * A pure function of its measurement window. It is given worker latencies and delivered
 * rates and returns ladder steps; it cannot see the clock except through the timestamps on
 * the samples it is handed, it holds no reference to the pipeline, and it never decides
 * anything on a timer. §59 requires the same input to produce the same output, and the
 * unit tests exercise exactly that by replaying sample sequences.
 *
 * The ordering in §54 — rendering quality, then tracking resolution, then feature target,
 * then mapping frequency — is expressed by the shape of the ladder in `tiers.ts`: a step
 * down gives up resolution before it gives up rate. This class only moves along it.
 *
 * **Why a decision clears the window.** Latencies measured at 960×540 say nothing about
 * how the pipeline behaves at 640×360. Carrying them across a step would let the
 * pre-change measurements immediately justify another change, which is how a controller
 * ends up stepping to the floor in three frames on one bad sample.
 */

import { toJsonSafe } from '../core/validate';
import type { JsonValue } from '../core/types';
import { DEFAULT_TIER_STEP, FLOOR_TIER_STEP, TIER_LADDER, tierAt } from './tiers';
import type { TierSpec } from './tiers';

/** §55: the tracking worker's hard ceiling, whatever the target rate implies. */
export const WORKER_CEILING_MS = 50;
/** §55: the ideal mean. Recorded for reporting; the ladder is driven by the budget below. */
export const WORKER_TARGET_MS = 33;

export interface AdaptiveConfig {
  /** Samples per decision window. 15 at 30 FPS is half a second of evidence. */
  readonly windowSize: number;
  /** Step down when the median worker latency exceeds this fraction of the budget. */
  readonly downThreshold: number;
  /** Step up only when the median is under this fraction of the *next* tier's budget. */
  readonly upThreshold: number;
  /** Step down when the delivered rate falls this far below the target. */
  readonly deliveredFpsFloorRatio: number;
  /**
   * Minimum share of the budget the worker must be using before a low delivered rate is
   * treated as something a ladder step can fix.
   *
   * §54's remedies all reduce *processing* cost. If the worker is idling and frames are
   * still not arriving, the constraint is upstream — the camera, the scheduler, the page —
   * and lowering the resolution cannot help. Without this the controller oscillates at the
   * floor: it steps down for a low rate, sees an idle worker, steps back up, and repeats.
   * That was measured on the desktop leg, at 13 changes in one run.
   */
  readonly deliveredFpsBlameRatio: number;
  /** Consecutive good windows required before stepping up. Hysteresis, deliberately slow. */
  readonly upWindowsRequired: number;
  /** No decision within this many ms of the previous one. */
  readonly cooldownMs: number;
  /**
   * No *upward* step within this many ms of a downward one.
   *
   * Flap damping. A load the ladder can partly escape produces a limit cycle without it:
   * the pipeline degrades, finds it can now afford the tier it just left, climbs back, and
   * is immediately overloaded again. Measured on the desktop leg as five ladder moves in one
   * ten-second window. Probing upward is right; probing every two seconds is not.
   */
  readonly upAfterDownCooldownMs: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveConfig = {
  windowSize: 15,
  downThreshold: 0.9,
  upThreshold: 0.5,
  deliveredFpsFloorRatio: 0.75,
  deliveredFpsBlameRatio: 0.5,
  upWindowsRequired: 3,
  cooldownMs: 4000,
  upAfterDownCooldownMs: 8000,
};

export interface AdaptiveSample {
  readonly at: number;
  /** Time the worker spent on the frame, measured in the worker. */
  readonly workerMs: number;
  /** Rate at which completed frames are currently arriving, measured by the pipeline. */
  readonly deliveredFps: number;
  /**
   * Rate at which the camera is offering frames, measured by the pipeline.
   *
   * The delivered rate cannot exceed this one, so a target above it is unreachable no
   * matter what the ladder does. Comparing delivery against the target alone made the
   * controller oscillate on the desktop leg, where the synthetic camera runs at 20 fps: at
   * a 30 fps target it read 20 as under-delivery, stepped down, found the worker idle,
   * stepped back up, and repeated. `0` means not yet measured.
   */
  readonly sourceFps: number;
}

export const AdaptiveDirection = { DOWN: 'DOWN', UP: 'UP' } as const;
export type AdaptiveDirection = (typeof AdaptiveDirection)[keyof typeof AdaptiveDirection];

/**
 * One ladder move, with the measurement that caused it.
 *
 * FRAME-004 requires every change to carry its cause, so the numbers that were compared
 * are stored on the decision rather than being reconstructed from a log afterwards.
 */
export interface TierDecision {
  readonly at: number;
  readonly direction: AdaptiveDirection;
  readonly fromStep: number;
  readonly toStep: number;
  readonly fromLabel: string;
  readonly toLabel: string;
  /** Target rates either side of the move, so FRAME-004 need not parse the labels. */
  readonly fromTargetFps: number;
  readonly toTargetFps: number;
  readonly medianWorkerMs: number;
  readonly budgetMs: number;
  readonly deliveredFps: number;
  readonly windowSize: number;
  readonly reason: string;
}

export function tierLabel(t: TierSpec): string {
  return `${t.name} ${t.longEdge}x${t.shortEdge}@${t.targetFps}`;
}

/**
 * Frame budget the worker has at a given tier.
 *
 * The smaller of the frame interval and §55's hard ceiling: at 15 FPS the interval is
 * 66.7 ms, but a worker taking 66 ms per frame is outside the spec's ceiling regardless of
 * how slowly frames are being requested.
 */
export function budgetForTier(t: TierSpec): number {
  return Math.min(1000 / t.targetFps, WORKER_CEILING_MS);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
}

export class AdaptiveController {
  private readonly config: AdaptiveConfig;
  private step: number;
  private window: AdaptiveSample[] = [];
  private goodWindows = 0;
  private lastDecisionAt: number | null = null;
  private lastDownAt: number | null = null;
  private readonly log: TierDecision[] = [];
  /** Highest step index reached, so "did it ever degrade" is answerable from the record. */
  private deepestStep: number;

  constructor(config: Partial<AdaptiveConfig> = {}, startStep = DEFAULT_TIER_STEP) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.step = Math.min(Math.max(startStep, 0), FLOOR_TIER_STEP);
    this.deepestStep = this.step;
  }

  currentStep(): number {
    return this.step;
  }

  currentTier(): TierSpec {
    return tierAt(this.step);
  }

  decisions(): readonly TierDecision[] {
    return this.log;
  }

  /**
   * Discard the window without deciding anything.
   *
   * Called when the source geometry changes: the per-frame cost at 720×1280 is not the
   * cost at 1280×720, so the samples either side of a rotation are not one population.
   */
  invalidateWindow(reason: string): void {
    this.window = [];
    this.goodWindows = 0;
    void reason;
  }

  /** Feed one completed frame. Returns a decision if this sample caused one. */
  observe(sample: AdaptiveSample): TierDecision | null {
    if (!Number.isFinite(sample.workerMs) || sample.workerMs < 0) return null;
    this.window.push(sample);
    if (this.window.length > this.config.windowSize) this.window.shift();
    if (this.window.length < this.config.windowSize) return null;

    const tier = this.currentTier();
    const budget = budgetForTier(tier);
    const med = median(this.window.map((s) => s.workerMs));
    const deliveredFps = median(this.window.map((s) => s.deliveredFps));

    const cooling =
      this.lastDecisionAt !== null && sample.at - this.lastDecisionAt < this.config.cooldownMs;

    const overBudget = med > budget * this.config.downThreshold;
    // A low rate is only this ladder's problem when the worker is actually working for it,
    // and only when the rate being missed was reachable in the first place.
    const workerIsBusy = med >= budget * this.config.deliveredFpsBlameRatio;
    const sourceFps = median(this.window.map((s) => s.sourceFps));
    const achievableFps = sourceFps > 0 ? Math.min(tier.targetFps, sourceFps) : tier.targetFps;
    const underDelivering =
      workerIsBusy &&
      deliveredFps > 0 &&
      deliveredFps < achievableFps * this.config.deliveredFpsFloorRatio;

    if ((overBudget || underDelivering) && this.step < FLOOR_TIER_STEP && !cooling) {
      const why = overBudget
        ? `median worker latency ${round(med)} ms exceeds ${round(this.config.downThreshold * budget)} ms ` +
          `(${this.config.downThreshold} of the ${round(budget)} ms budget at ${tierLabel(tier)})`
        : `delivered rate ${round(deliveredFps)} fps is below ${round(achievableFps * this.config.deliveredFpsFloorRatio)} fps, ` +
          `the floor for the ${round(achievableFps)} fps reachable from a ${round(sourceFps)} fps ` +
          `camera at a ${tier.targetFps} fps target, with the worker at ${round(med)} ms ` +
          `against a ${round(budget)} ms budget`;
      return this.move(AdaptiveDirection.DOWN, this.step + 1, sample, med, budget, deliveredFps, why);
    }

    const flapping =
      this.lastDownAt !== null && sample.at - this.lastDownAt < this.config.upAfterDownCooldownMs;

    if (this.step > 0 && !cooling && !flapping) {
      const next = tierAt(this.step - 1);
      const nextBudget = budgetForTier(next);
      // Judged against the budget of the tier being moved *into*, not the current one.
      // Comfortably meeting a slack budget says nothing about a tighter one.
      if (med < nextBudget * this.config.upThreshold) {
        this.goodWindows++;
        if (this.goodWindows >= this.config.upWindowsRequired) {
          const why =
            `median worker latency ${round(med)} ms is under ${round(this.config.upThreshold * nextBudget)} ms ` +
            `(${this.config.upThreshold} of the ${round(nextBudget)} ms budget at ${tierLabel(next)}) ` +
            `for ${this.goodWindows} consecutive windows`;
          return this.move(AdaptiveDirection.UP, this.step - 1, sample, med, nextBudget, deliveredFps, why);
        }
      } else {
        this.goodWindows = 0;
      }
    }
    return null;
  }

  private move(
    direction: AdaptiveDirection,
    toStep: number,
    sample: AdaptiveSample,
    med: number,
    budget: number,
    deliveredFps: number,
    reason: string,
  ): TierDecision {
    const from = this.currentTier();
    const to = tierAt(toStep);
    const decision: TierDecision = {
      at: sample.at,
      direction,
      fromStep: this.step,
      toStep,
      fromLabel: tierLabel(from),
      toLabel: tierLabel(to),
      fromTargetFps: from.targetFps,
      toTargetFps: to.targetFps,
      medianWorkerMs: round(med),
      budgetMs: round(budget),
      deliveredFps: round(deliveredFps),
      windowSize: this.window.length,
      reason,
    };
    this.step = toStep;
    this.deepestStep = Math.max(this.deepestStep, toStep);
    this.lastDecisionAt = sample.at;
    if (direction === AdaptiveDirection.DOWN) this.lastDownAt = sample.at;
    this.goodWindows = 0;
    // The new configuration has not been measured yet, and the old measurements do not
    // describe it. Deciding again requires a full window of samples from the new tier.
    this.window = [];
    this.log.push(decision);
    return decision;
  }

  /** Decisions within `ms` of the given instant — how FRAME-004 detects oscillation. */
  decisionsWithin(at: number, ms: number): number {
    return this.log.filter((d) => at - d.at <= ms).length;
  }

  describe(): Record<string, JsonValue> {
    return toJsonSafe({
      config: this.config,
      ladder: TIER_LADDER.map((t) => ({ step: t.step, label: tierLabel(t), budgetMs: round(budgetForTier(t)) })),
      startStep: DEFAULT_TIER_STEP,
      floorStep: FLOOR_TIER_STEP,
      currentStep: this.step,
      currentTier: tierLabel(this.currentTier()),
      deepestStep: this.deepestStep,
      windowFill: this.window.length,
      decisions: this.log,
      note:
        'Every decision carries the median worker latency and the budget it was compared ' +
        'against. The controller reads no clock of its own — only the timestamps on the ' +
        'samples it is given (§59).',
    }) as Record<string, JsonValue>;
  }
}
