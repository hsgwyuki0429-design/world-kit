/**
 * What the tracking stage sends and receives through the pipeline's opaque seam.
 *
 * `pipeline/messages.ts` types those two fields as `unknown` because §83 keeps `pipeline`
 * from importing `tracking`. The concrete shape lives here, on the side that owns it, and
 * both ends narrow through `asTrackingResult` rather than casting blindly — a message that
 * does not match is dropped and reported, not assumed.
 *
 * **What crosses the boundary, and what does not.** The full §11 feature records stay in the
 * worker: that is where Phase 4 will consume them, and structured-cloning 800 objects with
 * twelve fields each at 30 Hz would spend more time on the boundary than on the detection.
 * What crosses is a compact overlay buffer for §51's on-screen points, the summary statistics
 * the tests judge, and a small sample of complete records so FEAT-006 can check the schema
 * against evidence rather than against a promise. The same division Phase 2 made with the
 * pyramid and its proof strip.
 */

import type { SceneTexture } from './featureTypes';

/** Per-frame options the composition root hands to the tracking stage. */
export interface TrackingOptions {
  /** Whether to detect at all on frames this reaches. */
  readonly detect: boolean;
  /**
   * Whether to follow the existing population from the previous frame (Phase 4, §12).
   *
   * `false` in Phase 3, where detection is independent on every frame and no feature has a
   * history. `true` in Phase 4, and it changes what `detect` means: detection stops running
   * on every frame and becomes §11's refill, run only when the tracked population has fallen
   * far enough to need topping up. The two counts stay separate in the result for the reason
   * the Phase 4 test plan gives — a refill can hide a tracker that lost everything.
   */
  readonly track: boolean;
  /**
   * Whether to verify the tracked correspondences geometrically (Phase 5, v3 §14).
   *
   * `false` in Phase 4. When `true` the worker also maintains the verification anchor, which
   * is what gives the correspondences a two-view baseline — see `FlowTracker.takeAnchor`.
   */
  readonly verify: boolean;
  /** Run GEO-003's injected-outlier measurement on this frame. Costs a second RANSAC pass. */
  readonly wantInjection: boolean;
  /**
   * Whether to recover the relative pose (Phase 6, v3 §15).
   *
   * `false` in Phases 4 and 5. When `true` the worker decomposes whichever model Phase 5
   * selected on that frame — never a fresh fit, so the pose belongs to the model the screen
   * showed.
   */
  readonly pose: boolean;
  /** Run POSE-005's injected-rotation measurement. Costs a second fit and a second decomposition. */
  readonly wantPoseInjection: boolean;
  /** Pyramid level to detect on. 1 by default — see the Phase 3 test plan. */
  readonly level: number;
  readonly target: number;
  /** Run the contrast check on this frame (FEAT-001). Costs a little extra. */
  readonly wantContrast: boolean;
  /** Run the paired ungridded control on this frame (FEAT-003). Costs a second selection. */
  readonly wantGridComparison: boolean;
  /** Run the one-off level-0 cost calibration on this frame (FEAT-005). */
  readonly wantLevel0Calibration: boolean;
  /** How many complete §11 records to send back, for FEAT-006. */
  readonly recordSamples: number;
}

export const DEFAULT_TRACKING_OPTIONS: TrackingOptions = {
  detect: true,
  track: false,
  verify: false,
  wantInjection: false,
  pose: false,
  wantPoseInjection: false,
  level: 1,
  target: 800,
  wantContrast: false,
  wantGridComparison: false,
  wantLevel0Calibration: false,
  recordSamples: 8,
};

/** A complete §11 record, as it crosses the boundary. */
export interface FeatureRecordSample {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly x0: number;
  readonly y0: number;
  readonly cornerStrength: number;
  readonly age: number;
  readonly trackLength: number;
  readonly forwardBackwardError: number | null;
  readonly reprojectionError: number | null;
  readonly qualityScore: number;
  readonly cell: number;
}

export interface TrackingContrast {
  readonly atFeatures: number;
  readonly atRandom: number;
  readonly ratio: number;
  readonly aboveChance: number;
  readonly samples: number;
}

export interface TrackingGridComparison {
  readonly griddedMaxCellShare: number;
  readonly ungriddedMaxCellShare: number;
  readonly griddedOccupiedCells: number;
  readonly ungriddedOccupiedCells: number;
  /** Whether the quota had anything to do on this frame — see `GridComparison.binding`. */
  readonly binding: boolean;
  readonly quota: number;
}

export interface TrackingRefill {
  readonly urgency: string;
  readonly countBefore: number;
  readonly countAfter: number;
  readonly candidatesBefore: number;
  readonly candidatesAfter: number;
  readonly exhausted: boolean;
  readonly stateBefore: string;
  readonly stateAfter: string;
}

/**
 * The independent scene-motion measurement, as it crosses the boundary.
 *
 * Produced by `SceneShift`, which shares no code with the Lucas-Kanade solver and never sees
 * the feature list. FLOW-002 compares this against what the tracker says the points did, and
 * that comparison is the one number that carries Phase 4 — see the test plan.
 */
export interface TrackingSceneShift {
  readonly dx0: number;
  readonly dy0: number;
  readonly magnitude0: number;
  readonly residual: number;
  readonly medianResidual: number;
  readonly confidence: number;
  readonly zeroShiftResidual: number;
  readonly samples: number;
  readonly candidates: number;
  readonly levelScale: number;
  readonly width: number;
  readonly height: number;
}

/** One frame of Phase 4: what the tracker did, and what the image independently did. */
export interface TrackingFlow {
  /** Points carried forward from the previous frame and kept by §13. */
  readonly tracked: number;
  /** Points detection added this frame. Counted apart from `tracked`, always. */
  readonly redetected: number;
  /** The whole population after both. */
  readonly total: number;
  /** Points the tracker was given. `survival` is `tracked / offered`. */
  readonly offered: number;
  readonly survival: number;
  readonly failedToTrack: number;
  readonly rejectedByFb: number;
  readonly reducedConfidence: number;
  readonly medianDisplacementPx: number;
  readonly medianFbErrorPx: number;
  readonly fbAcceptable: number;
  readonly fbReduced: number;
  readonly fbRejected: number;
  readonly cellSpread: number;
  readonly occupiedFlowCells: number;
  readonly maxTrackLength: number;
  readonly medianAge: number;
  readonly frameFailed: boolean;
  readonly consecutiveFailedFrames: number;
  /** Tier steps and device rotations so far — see `FlowStepResult.geometryChanges`. */
  readonly geometryChanges: number;
  readonly everTracked: boolean;
  /** §33's state, computed by the one shared pure function — see `trackingState.ts`. */
  readonly state: string;
  readonly stateReason: string;
  /** Which of §33's GOOD conjuncts could not be evaluated, named rather than assumed away. */
  readonly goodBlockedBy: readonly string[];
  /** Cost of the Lucas-Kanade solve including §13's backward pass. FLOW-006 judges this. */
  readonly flowMs: number;
  /** Cost of the independent search, measured separately so it is not charged to the solver. */
  readonly shiftMs: number;
  readonly sceneShift: TrackingSceneShift | null;
  /** `STATIC` / `SLOW` / `FAST` / `OCCLUDED` / `INDETERMINATE`, measured from the image. */
  readonly frameMotion: string;
  readonly meanLuma: number;
  readonly topLevelMad: number;
  readonly detectedThisFrame: boolean;
  /** Features §11's refill produced this frame, before merging. `0` on a frame with no refill. */
  readonly detectionOffered: number;
  /** ...how many were declined because the point is already in the population — a healthy sign. */
  readonly declinedTooClose: number;
  /** ...and how many sat where the solver's 21×21 window cannot reach. */
  readonly declinedOutOfReach: number;
  readonly refillUrgency: string;
}

/**
 * GEO-003's measurement: what the harness corrupted, and what the verifier rejected.
 *
 * The verifier is handed the corrupted set with no marking. `injectedRecall` is the fraction
 * of the harness's own outliers it found — the one number in Phase 5 that a stage returning
 * its input cannot produce, because returning its input scores exactly 0.
 */
export interface VerificationInjection {
  readonly injected: number;
  readonly clean: number;
  readonly injectedRejected: number;
  readonly cleanRejected: number;
  readonly injectedRecall: number;
  /** ...and the rate among untouched correspondences, so rejecting everything cannot pass. */
  readonly cleanRejectionRate: number;
  readonly survivingInliers: number;
  readonly state: string;
  readonly displacementPx: number;
  readonly seed: number;
}

/** One frame of Phase 5: v3 §14's chain up to — and stopping before — the pose candidate. */
export interface VerificationReport {
  readonly frames: number;
  readonly correspondences: number;
  /** Frames since the verification anchor was taken. `-1` when there is none. */
  readonly anchorAge: number;
  readonly reAnchored: boolean;
  readonly reAnchorReason: string;
  /** `UNVERIFIED` / `USABLE` / `GOOD`, from the one shared pure function. */
  readonly state: string;
  readonly stateReason: string;
  readonly goodBlockedBy: readonly string[];
  /** Median displacement between the two views. Below the floor, nothing can be verified. */
  readonly baselinePx: number;
  /** `FUNDAMENTAL` / `HOMOGRAPHY`, or `null` on a frame that verified nothing. */
  readonly model: string | null;
  readonly inliers: number;
  readonly outliers: number;
  readonly inlierRatio: number;
  /** Both counts, so v3 §16's planar decision is auditable rather than asserted. */
  readonly fundamentalInliers: number;
  readonly homographyInliers: number;
  readonly planar: boolean;
  readonly spreadPx: number;
  readonly degenerate: boolean;
  readonly meanErrorPx: number;
  readonly iterations: number;
  /** `false` means the cap bound before RANSAC's confidence target was met. */
  readonly terminatedEarly: boolean;
  readonly verifyMs: number;
  readonly seed: number;
  readonly injection: VerificationInjection | null;
}

/**
 * POSE-005's measurement: a rotation the harness applied and never disclosed.
 *
 * `recoveredDeg` is how far the pose moved when the camera was turned by `requestedDeg`, and
 * `controlDeg` is how far it moved when it was not. Both are needed: a stage returning a constant
 * pose reports 0 for the first, and one returning noise reports a large number for the second.
 */
export interface PoseInjection {
  readonly requestedDeg: number;
  readonly recoveredDeg: number;
  readonly controlDeg: number;
  readonly axis: readonly number[];
  /** An image-space rotation preserves incidence, so the fit should find the same inliers. */
  readonly inliersBefore: number;
  readonly inliersAfter: number;
  readonly planarBefore: boolean;
  readonly planarAfter: boolean;
  /** The same two, for the control — the noise floor of refitting the same data. */
  readonly controlInliers: number;
  readonly controlPlanar: boolean;
  readonly seed: number;
}

/** v3 §15's matrix, and the flag v3 §15 requires beside it when it could not be measured. */
export interface IntrinsicsRecord {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  /** `INTRINSICS: ESTIMATED`. Safari exposes no focal length, so this is never false. */
  readonly estimated: boolean;
  readonly assumedFovDeg: number;
}

/** One term of v3 §19's confidence, named and valued so the number can be taken apart. */
export interface ConfidenceTermRecord {
  readonly name: string;
  readonly value: number;
  readonly note: string;
}

export interface CheiralityRecord {
  readonly candidate: number;
  readonly inFront: number;
  readonly rotationDeg: number;
}

/** How far the pose moves when the assumed focal length is scaled — see `intrinsics.ts`. */
export interface PoseSensitivity {
  readonly focalFactor: number;
  readonly rotationDeg: number;
  /** Angle between the translation directions. `-1` when there was no translation to compare. */
  readonly translationDeg: number;
}

/** One frame of Phase 6: v3 §15's chain, and the terms v3 §19 asks to be attached to it. */
export interface PoseReport {
  readonly frames: number;
  /** `NO_POSE` / `ROTATION_ONLY` / `POSE`, from the one shared pure function. */
  readonly state: string;
  readonly stateReason: string;
  /** Which model was decomposed — v3 §16 sends a planar scene to the homography. */
  readonly source: string | null;
  readonly rotationDeg: number;
  readonly axis: readonly number[] | null;
  /** §18: quaternion preferred. Euler angles are not produced at all. */
  readonly quaternion: readonly number[] | null;
  /** Unit direction, or `null`. Never a distance — v4 §18 forbids assuming a metre. */
  readonly translation: readonly number[] | null;
  readonly scale: string;
  readonly planeNormal: readonly number[] | null;
  readonly intrinsics: IntrinsicsRecord | null;
  /** Every candidate's count, so the choice among them is auditable rather than asserted. */
  readonly cheirality: readonly CheiralityRecord[];
  readonly chosen: number;
  /** Candidates cheirality could not separate — what v3 §16's translation penalty is derived from. */
  readonly unseparatedCandidates: number;
  readonly ambiguous: boolean;
  readonly pointsInFront: number;
  readonly correspondences: number;
  readonly reprojectionErrorPx: number;
  /** What rotation alone leaves unexplained: the parallax a translation would account for. */
  readonly rotationOnlyResidualPx: number;
  readonly rotationJumpDeg: number;
  readonly planar: boolean;
  readonly confidence: number;
  readonly rotationConfidence: number;
  /** v3 §16's "Translation confidenceを低下させる", as a number beside the rotation's. */
  readonly translationConfidence: number;
  readonly confidenceTerms: readonly ConfidenceTermRecord[];
  /** Named omissions — v3 §19's `IMU consistency` is withheld on purpose. */
  readonly confidenceWithheld: readonly string[];
  readonly sensitivity: PoseSensitivity | null;
  readonly poseMs: number;
  readonly injection: PoseInjection | null;
}

/**
 * One `devicemotion` reading, as the main thread hands it to the fusion stage.
 *
 * All three vectors are in the **device body frame**, in the units the event uses: m/s² for the
 * accelerations and °/s for `rotationRate`, converted to rad/s at the one place that integrates
 * it. `at` is `performance.now()` at delivery rather than the event's own timestamp, because
 * Safari's `DeviceMotionEvent.timeStamp` has a different epoch from the frame clock and Phase 7
 * measures gaps *between a pose and an IMU sample*.
 *
 * `interval` is the sensor's own reported period, kept because IMU-001 judges the delivered rate
 * against what the platform claims rather than against an assumed 60 Hz.
 */
export interface ImuSample {
  readonly at: number;
  /** Linear acceleration with gravity removed by the platform, m/s². */
  readonly acceleration: readonly number[];
  /** ...and the same reading with gravity left in. Their difference is the gravity direction. */
  readonly accelerationIncludingGravity: readonly number[];
  /** Body-frame angular rate, rad/s. Converted at the listener — the filter never sees degrees. */
  readonly rotationRate: readonly number[];
  /** The event's own `interval`, seconds. `-1` when the platform did not supply one. */
  readonly interval: number;
}

/**
 * One frame of Phase 7: what the filter holds, and the two numbers that prove it is a filter.
 *
 * `fusedVsVisualDeg` is zero on every frame for a "fusion" that returns the visual pose, and
 * `biasDifferenceDps` is zero for one that ignores the gyroscope — the plan's IMU-002 and
 * IMU-005 are exactly those two readings, which is why both are on the record rather than
 * derived by whoever grades it.
 */
export interface FusionReport {
  readonly frames: number;
  /** `VISION_ONLY` / `FUSED` / `DEAD_RECKONING`. */
  readonly mode: string;
  /** Whether the orientation is still worth using — false past `MAX_PROPAGATION_MS`. */
  readonly usable: boolean;
  /** §18: quaternion, body → world. Euler angles are not produced at all. */
  readonly orientation: readonly number[] | null;
  /** The filter's gyroscope bias estimate, °/s per axis. `null` before any IMU reported. */
  readonly gyroBiasDps: readonly number[] | null;
  /** v3 §17's position. Always `null` in Phase 7, with the reason attached rather than implied. */
  readonly position: readonly number[] | null;
  readonly positionReason: string;
  /** v4 §18: never a metre. */
  readonly scale: string;
  /** No magnetometer is read, so the heading is relative to the first gravity reading. */
  readonly heading: string;
  /** How far the visual increment sat from the propagated one, degrees. `-1` before any update. */
  readonly innovationDeg: number;
  /** The same for the injected twin — a filter that found the bias is not left disagreeing. */
  readonly injectedInnovationDeg: number;
  /** The angle of the visual increment the last update was formed from, degrees. */
  readonly visualIncrementDeg: number;
  /** Milliseconds since Phase 6 last produced a pose — IMU-007's measurement. */
  readonly propagatedMs: number;
  /** ...and the same for the gravity update. */
  readonly gravityDeg: number;
  /** v3 §19's seventh term, which Phase 6 withheld on purpose. `-1` where it cannot be formed. */
  readonly imuConsistency: number;
  /** The **fused** pose's confidence — Phase 6's is untouched and travels beside it. */
  readonly confidence: number;
  readonly confidenceTerms: readonly ConfidenceTermRecord[];
  readonly confidenceWithheld: readonly string[];
  /** Phase 6's own number for the same frame. `-1` before any pose. */
  readonly visualConfidence: number;
  readonly visualUpdates: number;
  readonly imuSamples: number;
  readonly gravitySamples: number;
  /** Samples whose ‖gravity‖ was too far from g to be a gravity direction at all. */
  readonly gravityRejected: number;
  /** 1σ of the orientation error state, degrees. `-1` before the filter is initialised. */
  readonly orientationVarianceDeg: number;
  /**
   * IMU-005's answer: the twin filter's bias estimate minus this one's, °/s per axis.
   *
   * The device's own true bias is unknown and common to both, so it cancels; what is left is the
   * harness's injection, which the filter was never told about. `null` until enough visual
   * updates have accumulated for the estimate to mean anything.
   */
  readonly biasDifferenceDps: readonly number[] | null;
  readonly injectedBiasDps: readonly number[] | null;
  readonly requestedInjectionDps: number;
  readonly injectionAxis: readonly number[];
  /** IMU-006: how far double-integrating the accelerometer would have wandered, metres. */
  readonly deadReckonedPositionM: number;
  readonly deadReckonedSeconds: number;
  /**
   * How far the fused orientation sits from Phase 6's, degrees. **Zero on a pass-through, always.**
   *
   * Not an error: the filter's world frame is the one gravity defined at initialisation and
   * Phase 6's is its verification anchor, so the two quaternions are expressed in different
   * frames and the angle between them has no absolute meaning. What it *does* distinguish is the
   * one thing IMU-001's failure condition names — a fusion whose orientation is the visual
   * orientation reports exactly 0 on every frame, and nothing else does. The number that is an
   * error is `innovationDeg`, which compares two increments over the same interval.
   */
  readonly fusedVsVisualDeg: number;
  /** IMU-008: what the fusion stage spent on this frame, ms. */
  readonly fusionMs: number;
}

export interface TrackingResult {
  readonly kind: 'phase3';
  readonly detected: boolean;
  readonly count: number;
  readonly detectMs: number;
  readonly detectWidth: number;
  readonly detectHeight: number;
  readonly detectLevel: number;
  readonly meanGradient: number;
  readonly texture: SceneTexture;
  readonly maxCornerStrength: number;
  readonly candidateCount: number;
  readonly occupiedCells: number;
  readonly maxCellShare: number;
  readonly quota: number;
  readonly state: string;
  readonly contrast: TrackingContrast | null;
  readonly gridComparison: TrackingGridComparison | null;
  readonly refill: TrackingRefill | null;
  readonly recordSamples: readonly FeatureRecordSample[];
  readonly level0Calibration: { width: number; height: number; detectMs: number; features: number } | null;
  /**
   * `[x0, y0, qualityScore] × count`, in level-0 coordinates, transferred.
   *
   * §51 requires the overlay to draw *actually detected* positions rather than a fixed
   * pattern, so the renderer is given the real ones and nothing else — there is no path by
   * which it could invent them.
   */
  readonly overlay: ArrayBuffer | null;
  /**
   * Phase 4's frame, or `null` on a Phase 3 frame where nothing was tracked.
   *
   * Carried on the same message as the detection result rather than on a second one: the two
   * describe one frame, and splitting them would let the screen show a population from one
   * frame beside a state derived from another.
   */
  readonly flow: TrackingFlow | null;
  /**
   * `age` per overlay point, `Uint16Array`, aligned with `overlay`'s triples.
   *
   * The overlay's stride stays 3 so Phase 3's renderer and the overlay alignment probe read
   * it unchanged; the ages ride alongside so Phase 4's screen can draw a tracked point
   * differently from one detection has just replaced. `null` outside Phase 4.
   */
  readonly flowAge: ArrayBuffer | null;
  /**
   * Phase 5's frame, or `null` when verification is not running.
   *
   * On the same message as the flow result, because they describe one frame: the
   * correspondences verified here are the population reported there, and splitting them would
   * let the screen show an inlier ratio from one frame beside a population from another.
   */
  readonly verification: VerificationReport | null;
  /**
   * Phase 6's frame, or `null` when pose recovery is not running.
   *
   * On the same message as Phase 5's for the same reason Phase 5's rides with Phase 4's: they
   * describe one frame. A rotation reported beside an inlier ratio from a different frame would
   * be two measurements of two moments presented as one pose.
   */
  readonly pose: PoseReport | null;
}

/** Narrow the opaque payload, or return `null`. Never casts on faith. */
export function asTrackingResult(payload: unknown): TrackingResult | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as { kind?: unknown };
  return p.kind === 'phase3' ? (payload as TrackingResult) : null;
}

/** Narrow the options the worker receives, falling back to "do nothing". */
export function asTrackingOptions(payload: unknown): TrackingOptions | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Partial<TrackingOptions>;
  if (typeof p.detect !== 'boolean' || typeof p.level !== 'number') return null;
  return { ...DEFAULT_TRACKING_OPTIONS, ...p } as TrackingOptions;
}
