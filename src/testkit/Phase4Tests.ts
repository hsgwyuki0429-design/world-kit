/**
 * Phase 4 test suite — FLOW-001..FLOW-007.
 *
 * Specs transcribed from `docs/phase4/TEST-PLAN.md`, written before `src/tracking/LucasKanade.ts`
 * existed (§29). Same verdict algebra as the phases before it: PASS / FAIL / PENDING, with
 * PENDING holding the phase at TESTING rather than rounding up.
 *
 * Every test reads `FlowStats` and nothing else — no DOM, no worker, no camera — so the suite
 * can be shown a run driven by the real solver and one driven by a tracker that **returns its
 * input**, and checked that the two produce different verdicts. That check exists, in
 * `tests/unit/flowTracker.test.ts`, and it is what makes the claim below testable rather than
 * merely stated.
 *
 * **The claim.** Every number in this phase except one can be produced by a tracker that
 * never looked at the second frame: the survival is perfect, §13's round trip is *exactly*
 * zero, and `age` and `trackLength` climb honestly. The exception is FLOW-002 criterion 2 —
 * the agreement between the tracker's displacement and an independent measurement of the
 * image's motion — and it is the number that carries the phase.
 */

import { Verdict } from '../core/types';
import type { JsonValue, TestResult, TestSpec } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import {
  FB_ACCEPTABLE_PX,
  FB_REDUCED_PX,
  LK_EPSILON,
  LK_LEVELS,
  LK_MAX_ITERATIONS,
  LK_WINDOW,
} from '../tracking/LucasKanade';
import {
  FAST_SHIFT_PX,
  MIN_SHIFT_CONFIDENCE,
  SHIFT_AGREEMENT_FRACTION,
  SHIFT_AGREEMENT_PX,
  STATIC_SHIFT_PX,
} from '../tracking/SceneShift';
import {
  DEGRADED_FEATURES,
  GOOD_FEATURES,
  LOST_SURVIVAL,
  TrackingState,
} from '../tracking/trackingState';
import { ROTATING_DEG, ROTATION_WINDOW_MS } from '../tracking/FlowSession';
import type { FlowStats } from '../tracking/flowStats';
import type { Evaluation, PhaseTest } from './runTests';
import { runTests } from './runTests';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in the test plan before any of this was measured          */
/* -------------------------------------------------------------------------- */

/** Frames of a measured motion class before that class is judged. */
export const MIN_CLASS_FRAMES = 15;
/** ...and occluded frames, which are produced deliberately and briefly. */
export const MIN_OCCLUDED_FRAMES = 10;
/** Paired tracker/scene cross-checks before FLOW-002's agreement means anything. */
export const MIN_SHIFT_SAMPLES = 10;
/** Median displacement allowed on a scene the image says is static. */
export const STATIC_DRIFT_PX = 1.0;
/** Fraction of tracked points that must survive one slow frame. */
export const MIN_SURVIVAL_SLOW = 0.7;
/** ...and one static frame, where nothing in the image is moving away from the window. */
export const MIN_SURVIVAL_STATIC = 0.9;
/** §H's line for pyramidal LK on ~700 points. */
export const FLOW_BUDGET_MS = 14.0;
/** FLOW-006 needs a population before a mean means anything. */
export const MIN_FLOW_COST_SAMPLES = 10;
/** FLOW-005: how quickly the state must reach LOST once the lens is covered. */
export const LOST_WITHIN_MS = 1000;

export interface Phase4Context {
  readonly cameraState: CameraState;
  readonly pipelineEverStarted: boolean;
  /** Optical flow was switched on at least once in this run. */
  readonly trackingEverRan: boolean;
  readonly stats: FlowStats;
}

type Phase4Test = PhaseTest<Phase4Context>;

function pct(n: number): string {
  return `${Math.round(n * 1000) / 10}%`;
}

function notRunning(ctx: Phase4Context, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.trackingEverRan && ctx.stats.flowFrames > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `optical flow has not run (camera ${ctx.cameraState})`,
    reason: 'no frame pair has been tracked, so there is nothing to judge',
    metrics,
  };
}

/* -------------------------------------------------------------------------- */

const FLOW_001: Phase4Test = {
  spec: {
    id: 'FLOW-001',
    title: '静止 — a still scene',
    required: true,
    input: 'frames the harness measured as STATIC — scene shift below 1.0 level-0 px',
    expected: 'the tracker holds its points where they are, and says TRACKING',
    passCriteria:
      `>= ${MIN_CLASS_FRAMES} STATIC frames; median tracked displacement <= ${STATIC_DRIFT_PX} px; ` +
      `median forward/backward error <= ${FB_ACCEPTABLE_PX} px; tracked survival >= ${MIN_SURVIVAL_STATIC}; ` +
      `the state is never LOST while the scene is static and the count is above ${DEGRADED_FEATURES}`,
    failureCondition:
      'points drifting on a still scene, or the state degrading with nothing degrading in the image',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const c = s.staticFrames;
    const metrics: Record<string, JsonValue> = {
      staticFrames: c.frames,
      medianDisplacementPx: c.medianDisplacementPx,
      medianFbErrorPx: c.medianFbErrorPx,
      medianSurvival: c.medianSurvival,
      medianTracked: c.medianTracked,
      stateFrames: s.stateFrames as unknown as JsonValue,
      lostWhileStatic: c.lostFrames,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (c.frames < MIN_CLASS_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${c.frames}/${MIN_CLASS_FRAMES} STATIC frames so far`,
        reason:
          'hold the phone still for a couple of seconds. A frame counts as static when the ' +
          `independent scene-shift search measures under ${STATIC_SHIFT_PX} level-0 px — that ` +
          'is measured from the image, not asserted by whoever is holding it',
        metrics,
      };
    }

    const problems: string[] = [];
    if (c.medianDisplacementPx > STATIC_DRIFT_PX) {
      problems.push(
        `points drifted ${c.medianDisplacementPx} px per frame on a scene the image says is ` +
          `still, against ${STATIC_DRIFT_PX} px allowed`,
      );
    }
    if (c.medianFbErrorPx > FB_ACCEPTABLE_PX) {
      problems.push(
        `median forward/backward error ${c.medianFbErrorPx} px is outside §13's acceptable ` +
          `band of ${FB_ACCEPTABLE_PX} px`,
      );
    }
    if (c.medianSurvival < MIN_SURVIVAL_STATIC) {
      problems.push(
        `only ${pct(c.medianSurvival)} of tracked points survived a still frame, against ` +
          `${pct(MIN_SURVIVAL_STATIC)} required`,
      );
    }
    // Frames of *this class*, not of the run. FLOW-005 requires a deliberate occlusion during
    // which the state is LOST on purpose; counting those here would make the two criteria
    // contradict each other.
    if (c.lostFrames > 0 && c.medianTracked > DEGRADED_FEATURES) {
      problems.push(
        `the state reached LOST on ${c.lostFrames} static frame(s) while the median tracked ` +
          `count was ${c.medianTracked}, above §11's ${DEGRADED_FEATURES} — nothing in the ` +
          'image was degrading',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${c.frames} static frames: median displacement ${c.medianDisplacementPx} px, ` +
        `FB ${c.medianFbErrorPx} px, survival ${pct(c.medianSurvival)}, ` +
        `median ${c.medianTracked} tracked`,
      reason:
        problems.length === 0
          ? 'the population stayed where the image stayed. On its own this proves nothing — ' +
            'a tracker returning its input satisfies every line of it perfectly; FLOW-002 is ' +
            'what separates the two, and neither passes without the other'
          : problems.join('; '),
      metrics,
    };
  },
};

const FLOW_002: Phase4Test = {
  spec: {
    id: 'FLOW-002',
    title: 'ゆっくり横移動 — the anti-fake gate',
    required: true,
    input:
      `frames measured SLOW (${STATIC_SHIFT_PX}–${FAST_SHIFT_PX} level-0 px) whose scene-shift ` +
      `confidence cleared ${MIN_SHIFT_CONFIDENCE}`,
    expected: 'points follow the image, by the amount the image actually moved',
    passCriteria:
      `>= ${MIN_CLASS_FRAMES} SLOW frames and >= ${MIN_SHIFT_SAMPLES} paired cross-checks; the ` +
      `median |tracked displacement − independently measured scene shift| within ` +
      `max(${SHIFT_AGREEMENT_PX} px, ${SHIFT_AGREEMENT_FRACTION} × shift); the tracked median ` +
      `displacement itself >= ${STATIC_SHIFT_PX} px; tracked survival >= ${MIN_SURVIVAL_SLOW}; ` +
      `median forward/backward error <= ${FB_ACCEPTABLE_PX} px`,
    failureCondition:
      'displacement disagreeing with the measured motion — in particular a tracker reporting ' +
      '~0 while the image demonstrably moved',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const c = s.slowFrames;
    const tolerance = Math.max(
      SHIFT_AGREEMENT_PX,
      SHIFT_AGREEMENT_FRACTION * Math.max(0, s.medianMeasuredShiftPx),
    );
    const metrics: Record<string, JsonValue> = {
      slowFrames: c.frames,
      shiftCheckSamples: s.shiftCheckCount,
      medianMeasuredShiftPx: s.medianMeasuredShiftPx,
      medianTrackedDisplacementPx: s.medianTrackedDisplacementPx,
      medianDisagreementPx: s.medianShiftDisagreementPx,
      tolerancePx: Math.round(tolerance * 1000) / 1000,
      agreementRate: s.shiftAgreementRate,
      medianSurvival: c.medianSurvival,
      medianFbErrorPx: c.medianFbErrorPx,
      recentChecks: s.shiftChecks.slice(-8) as unknown as JsonValue,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (c.frames < MIN_CLASS_FRAMES || s.shiftCheckCount < MIN_SHIFT_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${c.frames}/${MIN_CLASS_FRAMES} SLOW frames, ` +
          `${s.shiftCheckCount}/${MIN_SHIFT_SAMPLES} paired cross-checks`,
        reason:
          'pan the phone slowly sideways across a surface with structure in it. A cross-check ' +
          'is only taken where the independent search found a shift distinctive enough to ' +
          `speak about (confidence >= ${MIN_SHIFT_CONFIDENCE}); a blank wall produces frames ` +
          'but no comparisons, which is the distinction between "it did not move" and "this ' +
          'pair cannot say"',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.medianShiftDisagreementPx > tolerance) {
      problems.push(
        `the tracker says the points moved ${s.medianTrackedDisplacementPx} px while an ` +
          `independent search says the image moved ${s.medianMeasuredShiftPx} px — a median ` +
          `disagreement of ${s.medianShiftDisagreementPx} px against ` +
          `${Math.round(tolerance * 100) / 100} px allowed`,
      );
    }
    if (s.medianTrackedDisplacementPx < STATIC_SHIFT_PX) {
      problems.push(
        `the tracked median displacement is ${s.medianTrackedDisplacementPx} px — the points ` +
          'did not move at all, which is what a tracker returning its input reports',
      );
    }
    if (c.medianSurvival < MIN_SURVIVAL_SLOW) {
      problems.push(
        `only ${pct(c.medianSurvival)} of tracked points survived a slow frame, against ` +
          `${pct(MIN_SURVIVAL_SLOW)} required`,
      );
    }
    if (c.medianFbErrorPx > FB_ACCEPTABLE_PX) {
      problems.push(
        `median forward/backward error ${c.medianFbErrorPx} px is outside §13's acceptable band`,
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.shiftCheckCount} cross-checks over ${c.frames} slow frames: tracker ` +
        `${s.medianTrackedDisplacementPx} px vs image ${s.medianMeasuredShiftPx} px, ` +
        `median disagreement ${s.medianShiftDisagreementPx} px within ` +
        `${Math.round(tolerance * 100) / 100} px; ${pct(s.shiftAgreementRate)} of frames agreed; ` +
        `survival ${pct(c.medianSurvival)}, FB ${c.medianFbErrorPx} px`,
      reason:
        problems.length === 0
          ? 'what the tracker says the points did agrees with what a separate instrument says ' +
            'the image did. That instrument is an integer SAD translation search on the ' +
            'pyramid’s top level: it shares no code with the solver, never sees the feature ' +
            'list, and keeps its own copy of the previous frame. A tracker returning its ' +
            'input reports zero here while the search reports the real motion, and the ' +
            'disagreement is the failure'
          : problems.join('; '),
      metrics,
    };
  },
};

const FLOW_003: Phase4Test = {
  spec: {
    id: 'FLOW-003',
    title: 'ゆっくり回転 — rotation',
    required: true,
    input:
      `frames during which the device's own gyroscope integrated >= ${ROTATING_DEG}° over a ` +
      `${ROTATION_WINDOW_MS} ms trailing window — a second independent instrument`,
    expected: 'tracking survives rotation, and the flow field is not a pure translation',
    passCriteria:
      `>= ${MIN_CLASS_FRAMES} rotating frames; tracked survival >= ${MIN_SURVIVAL_SLOW}; median ` +
      `forward/backward error <= ${FB_ACCEPTABLE_PX} px; the displacement field's spread across ` +
      'the 8×6 grid measurably larger while rotating than during pure translation',
    failureCondition:
      'losing the population on a slow rotation; or a flow field identical in every cell, ' +
      'which is a translation-only model rather than a measurement',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      gyroAvailable: s.gyroAvailable,
      gyroReason: s.gyroReason,
      rotatingFrames: s.rotatingFrames,
      medianRotationDeg: s.medianRotationDeg,
      medianSpreadRotating: s.medianSpreadRotating,
      medianSpreadTranslating: s.medianSpreadTranslating,
      rotatingSurvival: s.rotatingSurvival,
      rotatingFbErrorPx: s.rotatingFbErrorPx,
      rotationWindowMs: ROTATION_WINDOW_MS,
      rotatingDeg: ROTATING_DEG,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (!s.gyroAvailable) {
      // Excluded rather than judged, as Phase 1 did for CAM-004. An absent instrument is not
      // a failed test, and calling it one would make the phase pass or fail on the platform.
      return {
        verdict: Verdict.PENDING,
        observed: 'the gyroscope is not delivering rotationRate',
        reason:
          `${s.gyroReason || 'no rotationRate samples have arrived'} — FLOW-003 is defined ` +
          'against the device’s own rotation, and without it there is no independent way to ' +
          'know a frame was rotating rather than translating',
        metrics,
      };
    }
    if (s.rotatingFrames < MIN_CLASS_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.rotatingFrames}/${MIN_CLASS_FRAMES} rotating frames so far`,
        reason:
          `turn the phone slowly about its own axis. A frame counts as rotating when the ` +
          `gyroscope integrates at least ${ROTATING_DEG}° over the previous ` +
          `${ROTATION_WINDOW_MS} ms`,
        metrics,
      };
    }
    if (s.medianSpreadTranslating < 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${s.rotatingFrames} rotating frames but no translating control frames to compare ` +
          'against',
        reason:
          'the comparison needs both: a flow field that varies across the frame means nothing ' +
          'without one that did not. Pan the phone sideways without turning it as well',
        metrics,
      };
    }

    const problems: string[] = [];
    if (s.rotatingSurvival < MIN_SURVIVAL_SLOW) {
      problems.push(
        `only ${pct(s.rotatingSurvival)} of tracked points survived a rotating frame, against ` +
          `${pct(MIN_SURVIVAL_SLOW)} required`,
      );
    }
    if (s.rotatingFbErrorPx > FB_ACCEPTABLE_PX) {
      problems.push(
        `median forward/backward error while rotating is ${s.rotatingFbErrorPx} px, outside ` +
          '§13’s acceptable band',
      );
    }
    if (s.medianSpreadRotating <= s.medianSpreadTranslating) {
      problems.push(
        `the flow field is no more varied while rotating (${s.medianSpreadRotating} px spread ` +
          `across the 8×6 grid) than while translating (${s.medianSpreadTranslating} px) — a ` +
          'rotation moves image corners by different amounts, and a field that does not is a ' +
          'translation-only model rather than a measurement',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${s.rotatingFrames} rotating frames at a median ${s.medianRotationDeg}° per ` +
        `${ROTATION_WINDOW_MS} ms: survival ${pct(s.rotatingSurvival)}, FB ` +
        `${s.rotatingFbErrorPx} px, grid spread ${s.medianSpreadRotating} px rotating vs ` +
        `${s.medianSpreadTranslating} px translating`,
      reason:
        problems.length === 0
          ? 'the population survived the rotation, and the flow field varied across the frame ' +
            'while it did — measured against the same field during pure translation on the ' +
            'same run, so a scene that would have varied anyway produces no difference and ' +
            'no pass'
          : problems.join('; '),
      metrics,
    };
  },
};

const FLOW_004: Phase4Test = {
  spec: {
    id: 'FLOW-004',
    title: '急速移動 — fast motion',
    required: true,
    input: `frames measured FAST — scene shift above ${FAST_SHIFT_PX} level-0 px`,
    expected: 'the tracker fails honestly; §65 asks for the transition, not for success',
    passCriteria:
      `>= ${MIN_CLASS_FRAMES} FAST frames; survival there measurably lower than during SLOW ` +
      `frames; the fraction of round trips rejected by §13's ${FB_REDUCED_PX} px band rises; ` +
      `the state reaches DEGRADED or LOST when the tracked count falls below ${DEGRADED_FEATURES}, ` +
      'and the state never disagrees with the count displayed beside it',
    failureCondition:
      'survival unchanged under motion the window cannot span — which means the numbers are ' +
      'not coming from the image; or a count that collapses with the state still reporting GOOD',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const fast = s.fastFrames;
    const slow = s.slowFrames;
    const metrics: Record<string, JsonValue> = {
      fastFrames: fast.frames,
      fastSurvival: fast.medianSurvival,
      slowSurvival: slow.medianSurvival,
      fastRejectFraction: fast.medianRejectFraction,
      slowRejectFraction: slow.medianRejectFraction,
      fastMedianTracked: fast.medianTracked,
      stateFrames: s.stateFrames as unknown as JsonValue,
      stateMismatches: s.stateMismatches,
      windowPx: LK_WINDOW,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (fast.frames < MIN_CLASS_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${fast.frames}/${MIN_CLASS_FRAMES} FAST frames so far`,
        reason:
          `sweep the phone quickly. A frame counts as fast when the image moved more than ` +
          `${FAST_SHIFT_PX} level-0 px, which is over half the ${LK_WINDOW} px window — past ` +
          'where the solver’s linearisation holds',
        metrics,
      };
    }
    if (slow.frames < MIN_CLASS_FRAMES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${fast.frames} fast frames but only ${slow.frames} slow ones`,
        reason:
          'the comparison needs both: survival that fell means nothing without the survival it ' +
          'fell from. Pan slowly as well',
        metrics,
      };
    }

    const problems: string[] = [];
    if (fast.medianSurvival >= slow.medianSurvival) {
      problems.push(
        `survival under fast motion (${pct(fast.medianSurvival)}) is not lower than under slow ` +
          `motion (${pct(slow.medianSurvival)}) — a 21 px window cannot span a displacement ` +
          'this large, so numbers that do not change are not coming from the image',
      );
    }
    if (fast.medianRejectFraction <= slow.medianRejectFraction) {
      problems.push(
        `§13 rejected no larger a fraction of round trips under fast motion ` +
          `(${pct(Math.max(0, fast.medianRejectFraction))}) than under slow ` +
          `(${pct(Math.max(0, slow.medianRejectFraction))}) — the points that fail are ` +
          'supposed to fail the forward/backward check, not vanish silently',
      );
    }
    // Again scoped to the class: the question is whether the state followed the count down
    // *under fast motion*, not whether the run ever saw a DEGRADED frame for another reason.
    const degradedOrLost = fast.degradedFrames + fast.lostFrames;
    if (fast.medianTracked >= 0 && fast.medianTracked < DEGRADED_FEATURES && degradedOrLost === 0) {
      problems.push(
        `the tracked count fell to a median of ${fast.medianTracked} under fast motion and the ` +
          'state never reported DEGRADED or LOST (§33)',
      );
    }
    if (s.stateMismatches > 0) {
      problems.push(
        `${s.stateMismatches} frame(s) reported a state that disagreed with their own measured ` +
          'inputs — the UI and the engine may not diverge (Rule 002)',
      );
    }
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${fast.frames} fast frames: survival ${pct(fast.medianSurvival)} against ` +
        `${pct(slow.medianSurvival)} slow; §13 rejected ` +
        `${pct(Math.max(0, fast.medianRejectFraction))} against ` +
        `${pct(Math.max(0, slow.medianRejectFraction))}; median ${fast.medianTracked} tracked; ` +
        `states ${JSON.stringify(s.stateFrames)}`,
      reason:
        problems.length === 0
          ? 'the tracker lost points under motion its window cannot span, the points it lost ' +
            'were rejected by §13 rather than silently dropped, and the state followed the ' +
            'count down. §65 asks for the transition, not for success'
          : problems.join('; '),
      metrics,
    };
  },
};

const FLOW_005: Phase4Test = {
  spec: {
    id: 'FLOW-005',
    title: 'Camera遮断 — the lens covered',
    required: true,
    input: 'frames measured OCCLUDED — a dark frame, or a wholesale change no shift explains',
    expected: 'LOST, promptly, and recovery once the lens is uncovered',
    passCriteria:
      `>= ${MIN_OCCLUDED_FRAMES} OCCLUDED frames; the state reaches LOST within ${LOST_WITHIN_MS} ms ` +
      'of the occlusion beginning; no track survives the occlusion with a §13-acceptable round ' +
      'trip; after the lens is uncovered the state leaves LOST',
    failureCondition: 'TRACKING maintained through a black frame; or never recovering',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const occluded = s.occludedFrames;
    const episodes = s.occlusions;
    const complete = episodes.filter((e) => e.frames >= MIN_OCCLUDED_FRAMES);
    const metrics: Record<string, JsonValue> = {
      occludedFrames: occluded.frames,
      episodes: episodes as unknown as JsonValue,
      completeEpisodes: complete.length,
      lostFrames: s.stateFrames[TrackingState.LOST] ?? 0,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (complete.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed:
          `${episodes.length} occlusion episode(s), longest ` +
          `${Math.max(0, ...episodes.map((e) => e.frames))} frames of ${MIN_OCCLUDED_FRAMES} needed`,
        reason:
          'cover the lens with a finger for about a second, then uncover it. A frame counts as ' +
          'occluded from the image — mean luma below 12, or a wholesale change with no shift ' +
          'explaining it — not from anyone saying the lens was covered',
        metrics,
      };
    }

    const problems: string[] = [];
    for (const e of complete) {
      if (e.msToLost < 0) {
        problems.push(
          `an occlusion of ${e.frames} frames never reached LOST — tracking was maintained ` +
            'through a covered lens',
        );
      } else if (e.msToLost > LOST_WITHIN_MS) {
        problems.push(
          `the state took ${e.msToLost} ms to reach LOST, against ${LOST_WITHIN_MS} ms required`,
        );
      }
      if (e.survivedWithGoodFb > 0) {
        problems.push(
          `${e.survivedWithGoodFb} round trip(s) scored inside §13's acceptable band across ` +
            'the occlusion — a point that tracks across a covered lens was never tracked',
        );
      }
      if (!e.recovered) {
        problems.push(
          `the state did not leave LOST after an occlusion of ${e.frames} frames ended`,
        );
      }
    }
    const worst = complete.reduce((a, b) => (a.msToLost > b.msToLost ? a : b));
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${complete.length} occlusion(s) of ${MIN_OCCLUDED_FRAMES}+ frames; slowest reached LOST ` +
        `in ${worst.msToLost} ms and recovered after ${worst.recoveredAfterMs} ms; ` +
        `${complete.reduce((n, e) => n + e.survivedWithGoodFb, 0)} track(s) claimed a good ` +
        'round trip through the dark',
      reason:
        problems.length === 0
          ? 'the state went LOST while the lens was covered, nothing claimed to have tracked ' +
            'across the black frames, and the population came back when the image did'
          : problems.join('; '),
      metrics,
    };
  },
};

const FLOW_006: Phase4Test = {
  spec: {
    id: 'FLOW-006',
    title: 'Optical flow cost',
    required: false,
    input: `the measured cost of the Lucas-Kanade solve per frame, at §12's parameters`,
    expected: 'the solve fits §H’s budget, with the point count recorded alongside',
    passCriteria: `mean <= ${FLOW_BUDGET_MS} ms over >= ${MIN_FLOW_COST_SAMPLES} frames`,
    failureCondition:
      'over budget. Advisory because §34 ranks correctness above performance, and because a ' +
      'device budget cannot be adjudicated off the device (§H.4)',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const metrics: Record<string, JsonValue> = {
      meanFlowMs: s.meanFlowMs,
      meanShiftMs: s.meanShiftMs,
      meanTrackedPoints: s.meanTrackedPoints,
      samples: s.flowCostSamples,
      budgetMs: FLOW_BUDGET_MS,
      window: LK_WINDOW,
      levels: LK_LEVELS,
      maxIterations: LK_MAX_ITERATIONS,
      epsilon: LK_EPSILON,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (s.flowCostSamples < MIN_FLOW_COST_SAMPLES) {
      return {
        verdict: Verdict.PENDING,
        observed: `${s.flowCostSamples}/${MIN_FLOW_COST_SAMPLES} frames measured`,
        reason: 'a mean over a handful of frames says nothing; keep tracking',
        metrics,
      };
    }
    const over = s.meanFlowMs > FLOW_BUDGET_MS;
    return {
      verdict: over ? Verdict.FAIL : Verdict.PASS,
      observed:
        `${s.meanFlowMs} ms mean over ${s.flowCostSamples} frames at ${s.meanTrackedPoints} ` +
        `points, ${LK_WINDOW}×${LK_WINDOW} window, ${LK_LEVELS} levels, ` +
        `${LK_MAX_ITERATIONS} iterations, epsilon ${LK_EPSILON}; the independent scene-shift ` +
        `search cost ${s.meanShiftMs} ms on top`,
      reason: over
        ? `mean ${s.meanFlowMs} ms exceeds the ${FLOW_BUDGET_MS} ms §H budgets for pyramidal ` +
          'LK. §12’s parameters are not reduced to make this pass — the budget is what is ' +
          'reported as missed'
        : 'the solve fits its budget at the parameters §12 fixes, with the point count it was ' +
          'measured at recorded beside it',
      metrics,
    };
  },
};

const FLOW_007: Phase4Test = {
  spec: {
    id: 'FLOW-007',
    title: 'Metadata honesty',
    required: false,
    input: 'the §11 feature records, now that features have a history',
    expected:
      'forwardBackwardError is a number on tracked records and null on fresh ones; ' +
      'reprojectionError is still null; age and trackLength describe what actually happened',
    passCriteria:
      'forwardBackwardError a number on every record with age > 0 and null on every record ' +
      'with age 0; reprojectionError null throughout; trackLength never longer than the frames ' +
      'since the record appeared; ids unique',
    failureCondition: 'any of the above unmet — in particular a number where none was measured',
  },
  evaluate: (ctx) => {
    const s = ctx.stats;
    const samples = s.recordSamples;
    const metrics: Record<string, JsonValue> = {
      sampledRecords: samples.length,
      records: samples.slice(0, 8) as unknown as JsonValue,
      flowFrames: s.flowFrames,
      maxTrackLength: s.maxTrackLength,
    };
    const pending = notRunning(ctx, metrics);
    if (pending) return pending;

    if (samples.length === 0) {
      return {
        verdict: Verdict.PENDING,
        observed: 'no feature records sampled yet',
        reason: 'tracking has produced no population to inspect',
        metrics,
      };
    }

    const problems: string[] = [];
    const ids = new Set<number>();
    for (const f of samples) {
      if (ids.has(f.id)) problems.push(`duplicate feature id ${f.id}`);
      ids.add(f.id);
      if (f.age > 0 && f.forwardBackwardError === null) {
        problems.push(
          `record ${f.id} has age ${f.age} but no forwardBackwardError — it was tracked, so ` +
            '§13 measured a round trip for it',
        );
      }
      if (f.age === 0 && f.forwardBackwardError !== null) {
        problems.push(
          `record ${f.id} was detected this frame and carries forwardBackwardError ` +
            `${f.forwardBackwardError} — there has been no round trip to measure (§80)`,
        );
      }
      if (f.reprojectionError !== null) {
        problems.push(
          `record ${f.id} carries reprojectionError ${f.reprojectionError} — §15's pose is ` +
            'Phase 6 and has not been written',
        );
      }
      if (f.trackLength > f.age + 1) {
        problems.push(
          `record ${f.id} claims a trackLength of ${f.trackLength} at age ${f.age} — it cannot ` +
            'have been seen in more frames than it has existed for',
        );
      }
      if (f.trackLength > s.flowFrames + 1) {
        problems.push(
          `record ${f.id} claims a trackLength of ${f.trackLength} over ${s.flowFrames} tracked ` +
            'frames',
        );
      }
    }
    const tracked = samples.filter((f) => f.age > 0).length;
    return {
      verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
      observed:
        `${samples.length} records inspected, ${tracked} of them with a history; ` +
        'forwardBackwardError present exactly where a round trip was measured, ' +
        'reprojectionError null throughout, longest track ' +
        `${s.maxTrackLength} frame(s)`,
      reason:
        problems.length === 0
          ? 'the record says what was measured and nothing else. §13’s error appears the moment ' +
            'a point has been tracked and not before; §15’s stays null because Phase 6 has not ' +
            'run, and for an error term an invented number is an invented confidence'
          : problems.slice(0, 5).join('; '),
      metrics,
    };
  },
};

export const PHASE4_TESTS: readonly Phase4Test[] = [
  FLOW_001, FLOW_002, FLOW_003, FLOW_004, FLOW_005, FLOW_006, FLOW_007,
];

export const PHASE4_SPECS: readonly TestSpec[] = PHASE4_TESTS.map((t) => t.spec);

export function runPhase4Tests(ctx: Phase4Context): TestResult[] {
  return runTests(PHASE4_TESTS, ctx);
}

/** Re-exported so the screen shows the same numbers the tests judge (Rule 002). */
export { GOOD_FEATURES, LOST_SURVIVAL };
