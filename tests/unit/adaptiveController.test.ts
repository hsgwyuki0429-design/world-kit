/**
 * The adaptive controller, driven by replayed measurement sequences.
 *
 * §59 requires the same input to produce the same result, and the controller was written to
 * make that testable: it reads no clock, holds no reference to the pipeline, and takes its
 * timestamps from the samples it is handed. So the whole of §54's behaviour can be checked
 * here rather than being inferred from a device run where the load is not repeatable.
 *
 * FRAME-004 says a target rate that changed "because a timer said so" is not a pass. These
 * tests are the other half of that: they show the rate changes because a *measurement*
 * said so, and that the same measurements always produce the same steps.
 */

import { describe, expect, it } from 'vitest';
import {
  AdaptiveController,
  budgetForTier,
  DEFAULT_ADAPTIVE_CONFIG,
  WORKER_CEILING_MS,
} from '../../src/pipeline/AdaptiveController';
import type { TierDecision } from '../../src/pipeline/AdaptiveController';
import { DEFAULT_TIER_STEP, FLOOR_TIER_STEP, tierAt } from '../../src/pipeline/tiers';

/** Feed `count` frames at a fixed worker latency, 30 ms apart, collecting any decisions. */
function feed(
  c: AdaptiveController,
  count: number,
  workerMs: number,
  opts: { startAt?: number; deliveredFps?: number; sourceFps?: number; stepMs?: number } = {},
): { decisions: TierDecision[]; endedAt: number } {
  const stepMs = opts.stepMs ?? 30;
  let at = opts.startAt ?? 0;
  const decisions: TierDecision[] = [];
  for (let i = 0; i < count; i++) {
    at += stepMs;
    const d = c.observe({
      at,
      workerMs,
      deliveredFps: opts.deliveredFps ?? tierAt(c.currentStep()).targetFps,
      // A camera comfortably faster than any target, unless a test says otherwise: the
      // point of most of these cases is latency, not supply.
      sourceFps: opts.sourceFps ?? 60,
    });
    if (d) decisions.push(d);
  }
  return { decisions, endedAt: at };
}

describe('budgetForTier (§55)', () => {
  it('is the frame interval, capped at the 50 ms hard ceiling', () => {
    expect(budgetForTier(tierAt(1))).toBeCloseTo(1000 / 30, 3);
    expect(budgetForTier(tierAt(2))).toBe(WORKER_CEILING_MS);
    expect(budgetForTier(tierAt(FLOOR_TIER_STEP))).toBe(WORKER_CEILING_MS);
  });
});

describe('AdaptiveController', () => {
  it('does nothing until it has a full window of measurements', () => {
    const c = new AdaptiveController();
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize - 1, 500);
    expect(decisions).toEqual([]);
    expect(c.currentStep()).toBe(DEFAULT_TIER_STEP);
  });

  it('steps down when the measured median exceeds the budget, and says why', () => {
    const c = new AdaptiveController();
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 60);
    expect(decisions.length).toBe(1);
    const d = decisions[0];
    expect(d?.direction).toBe('DOWN');
    expect(d?.fromStep).toBe(DEFAULT_TIER_STEP);
    expect(d?.toStep).toBe(DEFAULT_TIER_STEP + 1);
    expect(d?.medianWorkerMs).toBe(60);
    expect(d?.budgetMs).toBeCloseTo(1000 / 30, 1);
    expect(d?.reason).toContain('60 ms');
  });

  it('takes one step per decision, never several on one bad window', () => {
    const c = new AdaptiveController();
    // One window's worth of catastrophic latency. Without the window being cleared on a
    // decision, these same samples would justify a second and third step immediately.
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 5000);
    expect(decisions.length).toBe(1);
    expect(c.currentStep()).toBe(DEFAULT_TIER_STEP + 1);
  });

  it('never selects a target below the 15 fps floor (§10)', () => {
    const c = new AdaptiveController();
    // Sustained, hopeless overload for a long time.
    const { decisions } = feed(c, 4000, 5000, { stepMs: 100 });
    expect(c.currentStep()).toBe(FLOOR_TIER_STEP);
    expect(tierAt(c.currentStep()).targetFps).toBe(15);
    for (const d of decisions) expect(d.toTargetFps).toBeGreaterThanOrEqual(15);
  });

  it('steps down for a collapsed rate when the worker is the reason', () => {
    const c = new AdaptiveController();
    // Latency inside the budget but not comfortably: the worker is doing enough of the work
    // for a ladder step to plausibly help.
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 25, { deliveredFps: 9 });
    expect(decisions[0]?.direction).toBe('DOWN');
    expect(decisions[0]?.reason).toContain('delivered rate');
  });

  it('does not step down for a low rate the ladder cannot fix', () => {
    // The worker is idling at 2 ms and frames still are not arriving: the constraint is
    // upstream, and every remedy in §54 reduces processing cost. Stepping down here is what
    // made the desktop leg oscillate 13 times in one run.
    const c = new AdaptiveController();
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize * 4, 2, { deliveredFps: 9 });
    expect(decisions.filter((d) => d.direction === 'DOWN')).toEqual([]);
    // It climbs instead, which is right: 2 ms is comfortably inside the next tier's budget,
    // and the low rate is not something this ladder controls.
    expect(c.currentStep()).toBeLessThanOrEqual(DEFAULT_TIER_STEP);
  });

  it('does not chase a target the camera cannot supply', () => {
    // A 20 fps camera against a 30 fps target. Delivery of 20 is everything there is to
    // have, and no ladder step can produce a frame the camera never sent. Judging delivery
    // against the target alone made the desktop leg oscillate between 30 and 20 repeatedly.
    const c = new AdaptiveController();
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize * 4, 24, {
      deliveredFps: 20,
      sourceFps: 20,
    });
    expect(decisions.filter((d) => d.direction === 'DOWN')).toEqual([]);
  });

  it('still steps down when the camera could supply the rate and the pipeline cannot', () => {
    const c = new AdaptiveController();
    const { decisions } = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 24, {
      deliveredFps: 12,
      sourceFps: 30,
    });
    expect(decisions[0]?.direction).toBe('DOWN');
    expect(decisions[0]?.reason).toContain('delivered rate');
  });

  it('recovers only after several consecutive comfortable windows', () => {
    const c = new AdaptiveController();
    feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 60);
    expect(c.currentStep()).toBe(DEFAULT_TIER_STEP + 1);

    const w = DEFAULT_ADAPTIVE_CONFIG.windowSize;
    // One good window is not enough — hysteresis is the whole point.
    const first = feed(c, w, 4, { startAt: 10_000 });
    expect(first.decisions).toEqual([]);

    const rest = feed(c, w * DEFAULT_ADAPTIVE_CONFIG.upWindowsRequired, 4, { startAt: 20_000 });
    expect(rest.decisions.length).toBeGreaterThanOrEqual(1);
    expect(rest.decisions[0]?.direction).toBe('UP');
    expect(c.currentStep()).toBeLessThan(DEFAULT_TIER_STEP + 1);
  });

  it('will not climb back into a tier it has just left', () => {
    // Flap damping. Degrade, then hand it latencies that would justify climbing straight
    // back: the move has to wait out the up-after-down cooldown, not just the ordinary one.
    const c = new AdaptiveController();
    const down = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 60);
    expect(down.decisions.length).toBe(1);

    const soon = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize * 6, 3, {
      startAt: down.endedAt + DEFAULT_ADAPTIVE_CONFIG.cooldownMs + 100,
      stepMs: 5,
    });
    expect(soon.decisions).toEqual([]);

    const later = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize * 4, 3, {
      startAt: down.endedAt + DEFAULT_ADAPTIVE_CONFIG.upAfterDownCooldownMs + 1000,
      stepMs: 30,
    });
    expect(later.decisions[0]?.direction).toBe('UP');
  });

  it('holds a cooldown between decisions', () => {
    const c = new AdaptiveController();
    const first = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 60, { startAt: 0, stepMs: 10 });
    expect(first.decisions.length).toBe(1);
    // Another full window arriving well inside the cooldown must not move the ladder again.
    const second = feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 200, {
      startAt: first.endedAt,
      stepMs: 10,
    });
    expect(second.decisions).toEqual([]);
    expect(c.currentStep()).toBe(DEFAULT_TIER_STEP + 1);
  });

  it('discards its window when the source geometry changes', () => {
    const c = new AdaptiveController();
    feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize - 1, 500);
    c.invalidateWindow('rotation');
    // The samples from before the rotation described a different image size, so the next
    // sample starts a fresh window rather than completing the old one.
    const after = feed(c, 1, 500, { startAt: 10_000 });
    expect(after.decisions).toEqual([]);
  });

  it('is deterministic: the same sequence produces the same ladder moves (§59)', () => {
    const sequence = [
      ...Array<number>(20).fill(8),
      ...Array<number>(40).fill(70),
      ...Array<number>(40).fill(60),
      ...Array<number>(80).fill(5),
    ];
    const run = (): string[] => {
      const c = new AdaptiveController();
      const out: string[] = [];
      let at = 0;
      for (const ms of sequence) {
        at += 40;
        const d = c.observe({ at, workerMs: ms, deliveredFps: 25, sourceFps: 30 });
        if (d) out.push(`${d.at}:${d.direction}:${d.fromStep}->${d.toStep}:${d.medianWorkerMs}`);
      }
      return out;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('ignores a non-finite latency rather than acting on it', () => {
    const c = new AdaptiveController();
    for (let i = 0; i < 100; i++) {
      c.observe({ at: i * 30, workerMs: Number.NaN, deliveredFps: 30, sourceFps: 30 });
    }
    expect(c.decisions()).toEqual([]);
    expect(c.currentStep()).toBe(DEFAULT_TIER_STEP);
  });

  it('describes itself with the measurement behind every decision', () => {
    const c = new AdaptiveController();
    feed(c, DEFAULT_ADAPTIVE_CONFIG.windowSize, 60);
    const described = c.describe() as unknown as {
      decisions: TierDecision[];
      currentTier: string;
      deepestStep: number;
    };
    expect(described.decisions.length).toBe(1);
    expect(described.decisions[0]?.medianWorkerMs).toBeGreaterThan(0);
    expect(described.decisions[0]?.budgetMs).toBeGreaterThan(0);
    expect(described.deepestStep).toBe(DEFAULT_TIER_STEP + 1);
    expect(described.currentTier).toContain('@');
  });
});
