/**
 * One Phase 4 frame, end to end, with no worker around it.
 *
 * This is the whole of what the tracking worker does on a Phase 4 frame: measure the scene
 * independently, follow the population, refill it if §11 says to, derive §33's state, and
 * build the message that crosses the boundary. The worker calls this and adds nothing.
 *
 * **Why it is a separate file rather than a function inside the worker.** The Phase 4 test
 * plan requires that a tracker which returns its input be *shown* to fail, not argued to.
 * A unit test that reimplemented the frame loop to prove that would be proving something
 * about the reimplementation — the class of mistake §H.7 is about. So the loop lives here,
 * the worker is wiring, and `tests/unit/flowTracker.test.ts` drives this exact code with a
 * substituted forward solver and checks that FLOW-002 rejects the run.
 *
 * The order of the four steps is load-bearing and is the order of the test plan's argument:
 *
 *  1. **The independent measurement first**, before the tracker has produced anything. It
 *     runs on its own copy of the previous top level and cannot be influenced by the flow.
 *  2. **Track**, which consumes the previous frame's population and drops everything that
 *     failed or that §13 rejected. `tracked` is fixed here and nothing later can raise it.
 *  3. **Refill**, which is §11's ladder and can only add to `redetected`. It exists so the
 *     population survives; it must never be able to make the tracker look better.
 *  4. **State**, from the one shared pure function, over the numbers steps 2 and 3 produced.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both and which is
 * what FLOW-006 measures.
 */

import { FeatureDetector, DEFAULT_DETECTOR_CONFIG } from './FeatureDetector';
import { detectWithRefill, REFILL_QUALITY_FACTOR, REFILL_SEPARATION_FACTOR } from './FeaturePopulation';
import type { DetectWithRefill } from './FeaturePopulation';
import { GRID_CELLS, RefillUrgency, SceneTexture, featureStateFor, refillUrgencyFor } from './featureTypes';
import { FlowTracker } from './FlowTracker';
import type { MergeOutcome, TrackedFeature } from './FlowTracker';
import type { FlowSolve, ImagePlane } from './LucasKanade';
import { SceneShiftProbe, classifyFrameMotion } from './SceneShift';
import { deriveTrackingState } from './trackingState';
import type {
  FeatureRecordSample,
  TrackingFlow,
  TrackingResult,
  TrackingSceneShift,
} from './trackingMessages';

export interface FlowFrameInput {
  /** The pyramid, level 0 first. Read in place; the stage keeps its own copies. */
  readonly levels: readonly ImagePlane[];
  /** Pyramid level detection runs on when §11's ladder asks for a refill. */
  readonly detectLevel: number;
  readonly target: number;
  readonly recordSamples: number;
  /** Measured by the caller during grayscale conversion; FLOW-005 classifies from it. */
  readonly meanLuma: number;
  /** Top-level frame-to-frame difference; the second half of the occlusion test. */
  readonly topLevelMad: number;
}

export class FlowStage {
  /**
   * The two instruments, and they are deliberately two.
   *
   * `tracker` follows the features. `shiftProbe` measures how far the image moved without
   * ever seeing a feature — it shares no code with the Lucas-Kanade solver and keeps its own
   * copy of the previous top level, so it does not even share a buffer with the stage it is
   * checking. FLOW-002 gates on the two agreeing, and that gate is only worth anything
   * because neither can see the other's answer.
   */
  private readonly tracker: FlowTracker;
  private readonly shiftProbe = new SceneShiftProbe();
  private readonly detector: FeatureDetector;
  private readonly refillDetector: FeatureDetector;

  /**
   * @param solve replaces the Lucas-Kanade solver, in both directions.
   *
   * Nothing in production passes this. It exists so the unit tests can run a tracker that
   * returns its input through this exact code and check the verdict, rather than describing
   * the failure in prose.
   */
  constructor(
    detector: FeatureDetector = new FeatureDetector(),
    refillDetector: FeatureDetector = new FeatureDetector({
      qualityLevel: DEFAULT_DETECTOR_CONFIG.qualityLevel * REFILL_QUALITY_FACTOR,
      minSeparation: Math.max(
        2,
        Math.round(DEFAULT_DETECTOR_CONFIG.minSeparation * REFILL_SEPARATION_FACTOR),
      ),
    }),
    solve?: FlowSolve,
  ) {
    this.detector = detector;
    this.refillDetector = refillDetector;
    this.tracker = new FlowTracker(undefined, solve);
  }

  /**
   * Forget the previous frame.
   *
   * Called when tracking stops. The next frame could be seconds later, and matching against
   * a stale one would produce a displacement that describes the gap rather than the scene.
   */
  reset(): void {
    this.tracker.reset();
    this.shiftProbe.reset();
  }

  getPopulation(): readonly TrackedFeature[] {
    return this.tracker.getPopulation();
  }

  process(input: FlowFrameInput): TrackingResult {
    const levels = input.levels;
    const base = levels[0];
    const top = levels[levels.length - 1];
    if (!base || !top) throw new Error('the flow stage was given a pyramid with no levels');

    const levelIndex = Math.min(Math.max(0, Math.floor(input.detectLevel)), levels.length - 1);
    const level = levels[levelIndex] ?? base;
    const levelScale = 2 ** levelIndex;
    const topScale = 2 ** (levels.length - 1);

    // 1. The independent search. Timed apart from the solve so FLOW-006 judges the solve.
    const s0 = performance.now();
    const shift = this.shiftProbe.measure(top.data, top.width, top.height, topScale);
    const shiftMs = performance.now() - s0;
    const frameMotion = classifyFrameMotion(shift, input.meanLuma, input.topLevelMad);

    // 2. The tracker.
    const f0 = performance.now();
    const step = this.tracker.step(levels);
    const flowMs = performance.now() - f0;

    // 3. §11's ladder, and only now. `redetected` is what this adds and it is never folded
    //    into `tracked` — a refill that tops the count back up must not be able to hide a
    //    tracker that lost every point, which is exactly what one number would let it do.
    const urgency = refillUrgencyFor(this.tracker.getPopulation().length);
    let redetected = 0;
    let detectionOffered = 0;
    let merged: MergeOutcome = { admitted: 0, declinedTooClose: 0, declinedOutOfReach: 0 };
    let detection: DetectWithRefill | null = null;
    if (urgency !== RefillUrgency.NONE) {
      detection = detectWithRefill(
        this.detector,
        this.refillDetector,
        level.data,
        level.width,
        level.height,
        {
          levelScale,
          wantContrast: false,
          wantGridComparison: false,
          target: input.target,
        },
        Date.now(),
      );
      detectionOffered = detection.result.features.length;
      merged = this.tracker.merge(
        detection.result.features,
        DEFAULT_DETECTOR_CONFIG.minSeparation * levelScale,
        base.width,
        base.height,
        levelScale,
      );
      redetected = merged.admitted;
    }

    // 4. §33, from the one function. `inlierRatio` and `reprojectionError` are null because
    //    Phases 5 and 6 have not been written; see `trackingState.ts` for why that makes GOOD
    //    unreachable here rather than being quietly dropped from the condition.
    const measurement = this.tracker.measurement();
    const derived = deriveTrackingState(measurement);
    const population = this.tracker.getPopulation();

    const overlay = new Float32Array(population.length * 3);
    const ages = new Uint16Array(population.length);
    const cellCounts = new Int32Array(GRID_CELLS);
    for (let i = 0; i < population.length; i++) {
      const f = population[i];
      if (!f) continue;
      overlay[i * 3] = f.x0;
      overlay[i * 3 + 1] = f.y0;
      overlay[i * 3 + 2] = f.qualityScore;
      ages[i] = Math.min(65535, f.age);
      cellCounts[f.cell] = (cellCounts[f.cell] ?? 0) + 1;
    }
    let occupied = 0;
    let maxInCell = 0;
    for (const c of cellCounts) {
      if (c > 0) occupied++;
      if (c > maxInCell) maxInCell = c;
    }

    const samples: FeatureRecordSample[] = [];
    const wanted = Math.min(input.recordSamples, population.length);
    for (let i = 0; i < wanted; i++) {
      const f = population[Math.floor((i * population.length) / Math.max(1, wanted))];
      if (!f) continue;
      samples.push({
        id: f.id, x: f.x, y: f.y, x0: f.x0, y0: f.y0,
        cornerStrength: f.cornerStrength, age: f.age, trackLength: f.trackLength,
        forwardBackwardError: f.forwardBackwardError,
        reprojectionError: f.reprojectionError,
        qualityScore: f.qualityScore, cell: f.cell,
      });
    }

    const sceneShift: TrackingSceneShift | null = shift
      ? {
          dx0: shift.dx0,
          dy0: shift.dy0,
          magnitude0: shift.magnitude0,
          residual: shift.residual,
          medianResidual: shift.medianResidual,
          confidence: Number.isFinite(shift.confidence) ? shift.confidence : -1,
          zeroShiftResidual: shift.zeroShiftResidual,
          samples: shift.samples,
          candidates: shift.candidates,
          levelScale: shift.levelScale,
          width: shift.width,
          height: shift.height,
        }
      : null;

    const flow: TrackingFlow = {
      tracked: step.tracked,
      redetected,
      total: population.length,
      offered: step.offered,
      survival: step.survival,
      failedToTrack: step.failedToTrack,
      rejectedByFb: step.rejectedByFb,
      reducedConfidence: step.reducedConfidence,
      medianDisplacementPx: step.medianDisplacementPx,
      medianFbErrorPx: step.medianFbErrorPx,
      fbAcceptable: step.fbAcceptable,
      fbReduced: step.fbReduced,
      fbRejected: step.fbRejected,
      cellSpread: step.cellSpread,
      occupiedFlowCells: step.occupiedFlowCells,
      maxTrackLength: step.maxTrackLength,
      medianAge: step.medianAge,
      frameFailed: step.frameFailed,
      consecutiveFailedFrames: step.consecutiveFailedFrames,
      geometryChanges: step.geometryChanges,
      everTracked: measurement.everTracked,
      state: derived.state,
      stateReason: derived.reason,
      goodBlockedBy: derived.goodBlockedBy,
      flowMs: round(flowMs),
      shiftMs: round(shiftMs),
      sceneShift,
      frameMotion,
      meanLuma: round(input.meanLuma),
      topLevelMad: round(input.topLevelMad),
      detectedThisFrame: detection !== null,
      detectionOffered,
      // Split by reason, because they mean opposite things about the tracker's health. See
      // `MergeOutcome`: the device run of 2026-08-22 sat at 41 tracked points and the bundle
      // could not say whether detection had found little or whether almost everything it
      // found was already being tracked.
      declinedTooClose: merged.declinedTooClose,
      declinedOutOfReach: merged.declinedOutOfReach,
      refillUrgency: urgency,
    };

    const r = detection?.result ?? null;
    return {
      kind: 'phase3',
      // Detection is §11's refill here, not a per-frame event, so this says what actually
      // happened on this frame rather than reporting the previous frame's numbers again.
      detected: detection !== null,
      count: population.length,
      detectMs: r ? round(r.detectMs) : -1,
      detectWidth: level.width,
      detectHeight: level.height,
      detectLevel: levelIndex,
      meanGradient: r ? round(r.meanGradient) : -1,
      texture: r ? r.texture : SceneTexture.AMBIGUOUS,
      maxCornerStrength: r ? round(r.maxCornerStrength, 2) : -1,
      candidateCount: r ? r.candidateCount : 0,
      occupiedCells: occupied,
      maxCellShare: population.length > 0 ? round(maxInCell / population.length, 4) : 0,
      quota: Math.ceil(input.target / GRID_CELLS),
      // §11's population state, the same vocabulary Phase 3 used. §33's tracking state is a
      // different question with a different answer and it lives on `flow.state` — conflating
      // the two would make one of them wrong on every frame.
      state: featureStateFor(population.length),
      contrast: r?.contrast ?? null,
      gridComparison: r?.gridComparison ?? null,
      refill: detection?.refill
        ? {
            urgency: detection.refill.urgency,
            countBefore: detection.refill.countBefore,
            countAfter: detection.refill.countAfter,
            candidatesBefore: detection.refill.candidatesBefore,
            candidatesAfter: detection.refill.candidatesAfter,
            exhausted: detection.refill.exhausted,
            stateBefore: detection.refill.stateBefore,
            stateAfter: detection.refill.stateAfter,
          }
        : null,
      recordSamples: samples,
      level0Calibration: null,
      overlay: overlay.buffer,
      flow,
      flowAge: ages.buffer,
      verification: null,
      pose: null,
      keyframe: null,
      triangulation: null,
    };
  }

  /**
   * The live population, for Phase 5's anchor and correspondence set.
   *
   * Phase 5 inherits Phase 4's machinery rather than rebuilding it (§H.5), and what it does
   * with it — takes an anchor, forms correspondences against it, re-anchors when the anchor
   * stops supporting a two-view geometry — is `VerificationStage`'s to decide.
   */
  getTracker(): FlowTracker {
    return this.tracker;
  }
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}
