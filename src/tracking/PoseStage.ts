/**
 * One Phase 6 frame, end to end, with no worker around it (v3 §15, §16, §19, §67).
 *
 * The worker calls this and adds nothing, for the same reason `FlowStage` and
 * `VerificationStage` exist: the Phase 6 test plan requires a stage that returns a **constant
 * pose** to be shown to fail, and a unit test that reimplemented the frame loop to prove it
 * would be proving something about the reimplementation. So the loop lives here, and
 * `tests/unit/poseStage.test.ts` drives this exact code.
 *
 * ## What happens on a frame
 *
 *  1. **Build K from this frame's geometry** (v3 §15, §H.0). Not once at open — a rotation swaps
 *     the frame's width and height on the same track, and every one of `fx, fy, cx, cy` changes
 *     with it.
 *  2. **Recover the pose from Phase 5's verified subset**, decomposing whichever model Phase 5
 *     selected — v3 §16, which sends a planar scene to the homography because an Essential matrix
 *     decomposed from a plane is degenerate and yields a pose that looks entirely reasonable.
 *  3. **Measure what the focal-length assumption is holding up**: the same pose recomputed at
 *     `f × 0.8` and `f × 1.2`, and how far the rotation and the translation direction moved.
 *  4. **On sampled frames, apply a known camera rotation to the second view and re-run the whole
 *     chain** — POSE-005, the gate. Plus a control on the same frame, because a recall without a
 *     control is satisfied by a solver returning noise.
 *
 * Step 4 is this phase's counterpart to Phase 5's injected outliers and Phase 4's independent
 * scene-shift search, and it is here for the same reason (§H.7): every other number in this phase
 * is produced, and produced *well*, by a stage that returns the same pose on every frame.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { Rng } from '../core/Rng';
import { intrinsicsFor, perturbed } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import { apply3x3, multiply3x3, normalise3 } from '../geometry/linalg';
import { angleBetweenDeg, fromAxisAngle } from '../geometry/rotation';
import {
  CHEIRALITY_MARGIN,
  PoseState,
  SCALE_LOCAL_UNITS,
  recoverPose,
  rotationHomography,
} from '../geometry/pose';
import type { PoseResult } from '../geometry/pose';
import { GeometricModel } from '../geometry/twoView';
import type { Correspondence } from '../geometry/twoView';
import { MIN_INLIERS, VerificationState, verifyCorrespondences } from '../geometry/verify';
import type { VerificationResult } from '../geometry/verify';
import { poseConfidence } from './poseConfidence';
import type { PoseInjection, PoseReport } from './trackingMessages';
import type { VerificationOutcome } from './VerificationStage';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase6/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/** POSE-005's ground truth: how far the harness turns the camera it is not telling anyone about. */
export const INJECTED_ROTATION_DEG = 8.0;

/** How often the injection runs. It costs a second full fit and a second full decomposition. */
export const POSE_INJECTION_SAMPLE_EVERY = 6;

/** How far `f` is perturbed each way to measure what the focal-length assumption is holding up. */
export const INTRINSICS_SENSITIVITY = 0.2;

export interface PoseStageInput {
  readonly verification: VerificationOutcome;
  /** The frame's own geometry, in level-0 pixels. `K` is derived from it, per frame (§H.0). */
  readonly width: number;
  readonly height: number;
  /** Phase 4's tracked count, for v3 §19's `tracked feature count` term. */
  readonly trackedFeatures: number;
  readonly wantInjection: boolean;
}

export class PoseStage {
  private frames = 0;
  private previousRotation: readonly number[] | null = null;
  private readonly seedRng: Rng;

  constructor(seed = 0x27d4_eb2f) {
    this.seedRng = new Rng(seed);
  }

  reset(): void {
    this.frames = 0;
    this.previousRotation = null;
    this.seedRng.reset();
  }

  process(input: PoseStageInput): PoseReport {
    this.frames++;
    const { verification, width, height, trackedFeatures, wantInjection } = input;
    const v = verification.result;
    const k = intrinsicsFor(width, height);

    if (!k) {
      return this.noPose('the frame has no geometry to derive intrinsics from', null, v);
    }
    // Fail closed, and closed means closed: a frame Phase 5 declined has no verified subset, so
    // it gets no rotation either. POSE-004 checks exactly this — the Phase 5 rule ("a frame that
    // verified nothing carries no model") one phase along.
    if (v.state === VerificationState.UNVERIFIED || !v.matrix || v.model === null) {
      return this.noPose(
        `Phase 5 reported ${v.state} on this frame — ${v.reason}`,
        k,
        v,
      );
    }
    if (v.inlierCount < MIN_INLIERS) {
      return this.noPose(
        `${v.inlierCount} verified correspondences, below v3 §14's ${MIN_INLIERS}`,
        k,
        v,
      );
    }

    const t0 = performance.now();
    const pose = recoverPose({
      points: verification.correspondences,
      inliers: v.inliers,
      model: v.model,
      matrix: v.matrix,
      planar: v.planar,
      intrinsics: k,
    });
    const poseMs = performance.now() - t0;

    const sensitivity = this.measureSensitivity(verification, k, pose);
    const injection = wantInjection ? this.measureInjection(verification, k, pose) : null;

    const jump =
      this.previousRotation && pose.rotation
        ? angleBetweenDeg(this.previousRotation, pose.rotation)
        : -1;
    if (pose.rotation) this.previousRotation = pose.rotation;

    // How many candidates cheirality could not separate — the count v3 §16's translation
    // penalty is derived from, rather than a chosen number for "planar".
    const bestInFront = pose.pointsInFront;
    const unseparated =
      pose.cheirality.length === 0
        ? 1
        : Math.max(
            1,
            pose.cheirality.filter((c) => c.inFront * CHEIRALITY_MARGIN >= bestInFront && c.inFront > 0).length,
          );

    const confidence = poseConfidence({
      inlierRatio: v.inlierRatio,
      reprojectionErrorPx: pose.reprojectionErrorPx,
      trackedFeatures,
      spreadPx: v.spreadPx,
      rotationJumpDeg: jump,
      unseparatedCandidates: unseparated,
      planar: v.planar,
      frameSpanPx: Math.max(width, height),
    });

    return {
      frames: this.frames,
      state: pose.state,
      stateReason: pose.reason,
      source: pose.source,
      rotationDeg: pose.rotationDeg,
      axis: pose.axis ? [...pose.axis] : null,
      quaternion: pose.quaternion ? [...pose.quaternion] : null,
      translation: pose.translation ? [...pose.translation] : null,
      scale: SCALE_LOCAL_UNITS,
      planeNormal: pose.planeNormal ? [...pose.planeNormal] : null,
      intrinsics: {
        fx: round(k.fx, 3),
        fy: round(k.fy, 3),
        cx: round(k.cx, 3),
        cy: round(k.cy, 3),
        width: k.width,
        height: k.height,
        estimated: true,
        assumedFovDeg: k.assumedFovDeg,
      },
      cheirality: pose.cheirality.map((c) => ({ ...c })),
      chosen: pose.chosen,
      unseparatedCandidates: unseparated,
      ambiguous: pose.ambiguous,
      pointsInFront: pose.pointsInFront,
      correspondences: pose.correspondences,
      reprojectionErrorPx: pose.reprojectionErrorPx,
      rotationOnlyResidualPx: pose.rotationOnlyResidualPx,
      rotationJumpDeg: round(jump, 4),
      planar: v.planar,
      confidence: confidence.overall,
      rotationConfidence: confidence.rotation,
      translationConfidence: confidence.translation,
      confidenceTerms: confidence.terms.map((t) => ({ ...t })),
      confidenceWithheld: [...confidence.withheld],
      sensitivity,
      poseMs: round(poseMs, 3),
      injection,
    };
  }

  /**
   * What the focal-length assumption is holding up, measured rather than asserted.
   *
   * v3 §15 permits `INTRINSICS: ESTIMATED`, and this is the other half of permitting it: the
   * same pose is recovered with `f` scaled ±20 % and the movement is reported. A quantity that
   * barely moves does not depend on the guess; one that moves does, and a reader of the bundle
   * can tell which is which instead of being asked to trust a nominal field of view.
   */
  private measureSensitivity(
    verification: VerificationOutcome,
    k: Intrinsics,
    base: PoseResult,
  ): PoseReport['sensitivity'] {
    if (!base.rotation) return null;
    const v = verification.result;
    if (!v.matrix || v.model === null) return null;
    let worstRotation = 0;
    let worstTranslation = -1;
    for (const factor of [1 - INTRINSICS_SENSITIVITY, 1 + INTRINSICS_SENSITIVITY]) {
      const out = recoverPose({
        points: verification.correspondences,
        inliers: v.inliers,
        model: v.model,
        matrix: v.matrix,
        planar: v.planar,
        intrinsics: perturbed(k, factor),
      });
      if (!out.rotation) continue;
      worstRotation = Math.max(worstRotation, angleBetweenDeg(base.rotation, out.rotation));
      if (base.translation && out.translation) {
        const dot = Math.min(
          1,
          Math.max(
            -1,
            (base.translation[0] ?? 0) * (out.translation[0] ?? 0) +
              (base.translation[1] ?? 0) * (out.translation[1] ?? 0) +
              (base.translation[2] ?? 0) * (out.translation[2] ?? 0),
          ),
        );
        worstTranslation = Math.max(worstTranslation, (Math.acos(Math.abs(dot)) * 180) / Math.PI);
      }
    }
    return {
      focalFactor: INTRINSICS_SENSITIVITY,
      rotationDeg: round(worstRotation, 4),
      translationDeg: round(worstTranslation, 4),
    };
  }

  /**
   * POSE-005 — turn the camera by a known amount and check the pose follows.
   *
   * `K Rⱼ K⁻¹` applied to the second view is *exactly* the camera having additionally rotated by
   * `Rⱼ`: if `b = π(K(RX + t))` then `π(K Rⱼ K⁻¹ b̃) = π(K(Rⱼ R X + Rⱼ t))`. The identity is
   * asserted in `tests/unit/pose.test.ts` before anything is built on it.
   *
   * The **whole chain** is re-run, model fit included, not just the decomposition — a pose stage
   * is not the only thing that could be returning a constant, and re-running only the last step
   * would leave the fit untested. The control is the same set, unmodified, refitted with a
   * different seed: without it, a solver returning noise scores a large difference on the
   * injected set and would pass.
   */
  private measureInjection(
    verification: VerificationOutcome,
    k: Intrinsics,
    base: PoseResult,
  ): PoseInjection | null {
    if (!base.rotation) return null;
    const seed = seedFrom(this.seedRng);
    const rng = new Rng(seed);
    // A seeded axis, so the injected rotation is not always about the same one — a stage that
    // happened to be right about one axis and wrong about the others would otherwise pass.
    const axis = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) ?? [0, 1, 0];
    const rj = fromAxisAngle(axis, INJECTED_ROTATION_DEG);
    const h = rotationHomography(k, rj);
    if (!h) return null;

    const turned: Correspondence[] = verification.correspondences.map((c) => {
      const q = apply3x3(h, [c.bx, c.by, 1]);
      const w = q[2] ?? 0;
      if (Math.abs(w) <= 1e-12) return c;
      return { ...c, bx: (q[0] ?? 0) / w, by: (q[1] ?? 0) / w };
    });

    const injected = this.refitAndRecover(turned, k, seed ^ 0x1234_5678);
    const control = this.refitAndRecover(
      [...verification.correspondences],
      k,
      seed ^ 0x7654_3210,
    );

    const injectedDeg = injected?.rotation ? angleBetweenDeg(base.rotation, injected.rotation) : -1;
    const controlDeg = control?.rotation ? angleBetweenDeg(base.rotation, control.rotation) : -1;

    return {
      requestedDeg: INJECTED_ROTATION_DEG,
      recoveredDeg: round(injectedDeg, 4),
      controlDeg: round(controlDeg, 4),
      axis: [...axis],
      // An image-space rotation is a bijection and preserves incidence, so the fit should find
      // the same inliers and the same planarity. If it does not, the fit is responding to
      // something other than the geometry.
      inliersBefore: verification.result.inlierCount,
      inliersAfter: injected?.inliers ?? -1,
      planarBefore: verification.result.planar,
      planarAfter: injected?.planar ?? false,
      seed,
    };
  }

  /** The whole chain — refit the model, then recover the pose — on a set handed over unmarked. */
  private refitAndRecover(
    points: readonly Correspondence[],
    k: Intrinsics,
    seed: number,
  ): { rotation: readonly number[] | null; inliers: number; planar: boolean } | null {
    const v: VerificationResult = verifyCorrespondences(points, seed);
    if (!v.matrix || v.model === null) return { rotation: null, inliers: v.inlierCount, planar: v.planar };
    const pose = recoverPose({
      points,
      inliers: v.inliers,
      model: v.model,
      matrix: v.matrix,
      planar: v.planar,
      intrinsics: k,
    });
    return { rotation: pose.rotation, inliers: v.inlierCount, planar: v.planar };
  }

  private noPose(reason: string, k: Intrinsics | null, v: VerificationResult): PoseReport {
    this.previousRotation = null;
    return {
      frames: this.frames,
      state: PoseState.NO_POSE,
      stateReason: reason,
      source: null,
      rotationDeg: -1,
      axis: null,
      quaternion: null,
      translation: null,
      scale: SCALE_LOCAL_UNITS,
      planeNormal: null,
      intrinsics: k
        ? {
            fx: round(k.fx, 3), fy: round(k.fy, 3), cx: round(k.cx, 3), cy: round(k.cy, 3),
            width: k.width, height: k.height, estimated: true, assumedFovDeg: k.assumedFovDeg,
          }
        : null,
      cheirality: [],
      chosen: -1,
      unseparatedCandidates: 0,
      ambiguous: false,
      pointsInFront: 0,
      correspondences: v.correspondences,
      reprojectionErrorPx: -1,
      rotationOnlyResidualPx: -1,
      rotationJumpDeg: -1,
      planar: v.planar,
      confidence: 0,
      rotationConfidence: 0,
      translationConfidence: 0,
      confidenceTerms: [],
      confidenceWithheld: [],
      sensitivity: null,
      poseMs: -1,
      injection: null,
    };
  }
}

function seedFrom(rng: Rng): number {
  return Math.floor(rng.next() * 0xffff_ffff) >>> 0;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}

/** Re-exported so the screen and the tests read the same names the solver does. */
export { GeometricModel, PoseState, multiply3x3 };
