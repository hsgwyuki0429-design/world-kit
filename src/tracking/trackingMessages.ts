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
  /**
   * Whether to keep keyframes (Phase 8, v3 §20).
   *
   * `false` in Phases 4–7. When `true` the worker also maintains the keyframe store, which is a
   * **second** long-lived structure beside Phase 5's verification anchor rather than a
   * replacement for it — Phases 5 and 6 passed on the device with that anchor and editing a
   * passed phase is not a fix. See `docs/phase8/TEST-PLAN.md`.
   */
  readonly keyframes: boolean;
  /**
   * Whether to triangulate each new keyframe against the one before it (Phase 9, v4 §21).
   *
   * `false` in Phases 4–8. When `true` the worker fits a pose for the **pair** — a different two
   * views from Phase 5's anchor pair, for which no model exists — and triangulates its verified
   * subset. Off the frame cadence by construction: it runs on keyframe inserts only, which is
   * where §27 puts mapping work.
   */
  readonly triangulate: boolean;
  /**
   * Whether Phase 9's two injections run at all.
   *
   * **Which batches they run on is the stage's to decide, not this option's**, and that is a
   * correction the leg forced: a batch happens when Phase 8 inserts a keyframe, which only the
   * worker knows about, so a flag sampled on the main thread's option cadence lands on whatever
   * fraction of batches the two rates happen to intersect on. Measured at **64 % of batches**
   * where the plan says *on a sampled schedule*, and each injection costs a full extra fit and
   * solve. The stage samples on its own batch index instead.
   */
  readonly wantInjections: boolean;
  /**
   * Whether to maintain the landmark map (Phase 10, v4 §22).
   *
   * `false` in Phases 4–9. When `true` the worker brings each Phase 9 batch into one frame by
   * the landmarks it shares with the map, which is the only mechanism a monocular camera has for
   * relating two pairs' baselines to each other.
   */
  readonly landmarks: boolean;
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
  keyframes: false,
  triangulate: false,
  wantInjections: false,
  landmarks: false,
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
  /** The size of the set the injection was built from — GEO-003's recall depends on it. */
  readonly correspondences: number;
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

/* -------------------------------------------------------------------------- */
/* Phase 8 — keyframe system                                                    */
/* -------------------------------------------------------------------------- */

/** One of v3 §20's conditions, as it crosses the boundary. */
export interface KeyframeConditionRecord {
  readonly name: string;
  readonly value: number;
  readonly threshold: number;
  readonly unit: string;
  /** `MEASURED` / `UNMEASURED` / `UNAVAILABLE`. An `UNMEASURED` condition never fires. */
  readonly state: string;
  readonly fired: boolean;
  readonly note: string;
}

/**
 * The decision's inputs, carried verbatim beside its answer.
 *
 * Rule 002, for the fifth phase running: `KeyframeSession` calls the same `decideKeyframe` on
 * this and compares. A selector that inserted on a timer and labelled the record `ROTATION`
 * would satisfy every count in Phase 8 and be caught here — which only works if the inputs
 * travel with the answer rather than being summarised into it.
 */
export interface KeyframeDecisionRecord {
  readonly at: number;
  readonly observations: number;
  readonly hasPrevious: boolean;
  readonly sinceLastMs: number;
  readonly rotationDeg: number;
  readonly displacementPx: number;
  readonly inlierRatio: number;
  readonly previousInlierRatio: number;
  readonly trackingState: string;
  readonly previousTrackingState: string;
}

/** A stored keyframe, summarised for the boundary — the observations stay in the worker. */
export interface KeyframeRecord {
  readonly id: number;
  readonly at: number;
  readonly frameIndex: number;
  readonly reason: string;
  readonly observations: number;
  readonly intrinsics: IntrinsicsRecord;
  readonly rotationFromPreviousDeg: number;
  readonly displacementFromPreviousPx: number;
  readonly translationDirectionDeg: number;
  readonly droppedIncrements: number;
  readonly inlierRatio: number;
  readonly trackedFeatures: number;
  readonly trackingState: string;
  readonly poseConfidence: number;
  /** Fraction of this keyframe's observations still being tracked. Never a function of age. */
  readonly survivingFraction: number;
  readonly stale: boolean;
}

export interface KeyframeEvictionRecord {
  readonly keyframeId: number;
  readonly reason: string;
  readonly detail: string;
  readonly survivingFraction: number;
  /** Median pairwise separation of the set this policy kept, px... */
  readonly retainedSeparationPx: number;
  /** ...and of the set dropping the oldest would have kept. KEY-003's counterfactual. */
  readonly oldestFirstSeparationPx: number;
}

/**
 * One frame of Phase 8: what was decided, from what, and what the store holds now.
 *
 * `metronomeInserted` is the twin's answer on the same frame. On a moving camera the two
 * selectors agree often enough to look alike; on a camera that is not moving they do not, and
 * KEY-002 is exactly that difference.
 */
export interface KeyframeReport {
  readonly frames: number;
  readonly decisions: number;
  readonly inserted: boolean;
  /** `FIRST` / `ROTATION` / `DISPLACEMENT` / `QUALITY` / `HEARTBEAT`, or a refusal. */
  readonly reason: string;
  readonly detail: string;
  readonly conditions: readonly KeyframeConditionRecord[];
  readonly input: KeyframeDecisionRecord;
  /** Features in this view, and how many of them the last usable keyframe also holds. */
  readonly observations: number;
  readonly sharedWithLast: number;
  /** Which keyframe this decision was measured against. `-1` where there is none. */
  readonly partnerKeyframeId: number;
  /**
   * Whether that partner is stale — KEY-006's second criterion, as a value rather than a promise.
   *
   * The stage takes the newest **usable** keyframe rather than the newest, so this should be
   * `false` whenever a partner exists. It is reported so that "a stale keyframe is not used as
   * the comparison partner" is something the evidence says rather than something the code claims.
   */
  readonly partnerStale: boolean;
  /** Observation ids that repeated within one keyframe. Must be 0 — the ids are run-unique. */
  readonly duplicateObservationIds: number;
  /** Phase 4's own independent classification of this frame's motion — KEY-002's instrument. */
  readonly frameMotion: string;
  /**
   * Whether **every** decision since the last keyframe reported `STATIC`.
   *
   * KEY-002 is about a camera that is not moving, and the quantity a geometric condition fires on
   * is accumulated over the *interval*, not measured on the frame. A view 30 px from the last
   * keyframe is 30 px from it whether or not the image happens to be still at the instant the
   * minimum interval elapses — so a per-frame classification cannot say whether a condition was
   * honestly met. This can: nothing moved between these two views.
   */
  readonly intervalStatic: boolean;
  /** Phase 6's own verdict on the pose this decision's rotation was accumulated from. */
  readonly poseState: string;
  readonly poseAmbiguous: boolean;
  readonly poseRotationConfidence: number;
  readonly poseUnseparatedCandidates: number;
  readonly keyframes: number;
  readonly totalInserted: number;
  readonly totalEvictions: number;
  readonly evicted: KeyframeEvictionRecord | null;
  readonly staleKeyframes: number;
  /** Increments dropped across a Phase 5 re-anchor since the last keyframe — a named gap. */
  readonly droppedIncrements: number;
  /**
   * Poses declined because Phase 6 marked them `ambiguous` — a second named gap.
   *
   * Cheirality did not separate the decomposition's candidates, so the pose Phase 6 reported is
   * one of two it could not choose between. On a static image the recovered rotation alternates
   * between them; accumulating that is how a pure lateral pan reports having rotated 18°.
   */
  readonly ambiguousPosesDeclined: number;
  readonly reAnchorsSinceKeyframe: number;
  /** v4 §18, carried as a value a later phase has to remove deliberately. */
  readonly scale: string;
  readonly metronomeInserted: boolean;
  readonly metronomeKeyframes: number;
  readonly recent: readonly KeyframeRecord[];
  readonly keyframeMs: number;
}

/* -------------------------------------------------------------------------- */
/* Phase 9 — triangulation                                                      */
/* -------------------------------------------------------------------------- */

/** One triangulated point, as a sample crossing the boundary. */
export interface TriangulatedPointRecord {
  readonly id: number;
  /** First view's camera frame, in units of that pair's baseline. Never a distance. */
  readonly position: readonly number[];
  readonly depth: number;
  readonly parallaxDeg: number;
  readonly depthUncertainty: number;
  readonly reprojectionPx: number;
}

/**
 * TRI-004's measurement: depths the harness chose and did not disclose.
 *
 * `controlRelativeError` is what the best possible **constant** depth would have scored on the
 * same set — the number fake 1 produces. Reported beside the measurement so the tolerance is not
 * what separates the two.
 */
export interface DepthInjectionRecord {
  readonly points: number;
  readonly accepted: number;
  readonly medianRelativeError: number;
  readonly controlRelativeError: number;
  /** Spearman rank correlation between the chosen depths and the recovered ones. */
  readonly rankCorrelation: number;
  readonly medianTrueDepth: number;
  readonly medianRecoveredDepth: number;
  readonly recoveredRotationDeg: number;
  readonly requestedRotationDeg: number;
  readonly seed: number;
}

/**
 * TRI-003's measurement: a camera that turned and did not move.
 *
 * `cleanAccepted` is the same batch's untouched pair, because a refusal without it is satisfied
 * by a stage that refuses everything.
 */
export interface RotationInjectionRecord {
  readonly requestedDeg: number;
  readonly correspondences: number;
  /** Points accepted from a pure rotation. Must be 0 — there is no tolerance on this. */
  readonly accepted: number;
  readonly cleanAccepted: number;
  /** `NO_POSE` / `ROTATION_ONLY` / `POSE` — which of the two ways the refusal happened. */
  readonly poseState: string;
  readonly lowParallaxRefusals: number;
  readonly seed: number;
}

/** One batch of Phase 9: one keyframe pair, or the frames in between. */
export interface TriangulationReport {
  readonly frames: number;
  readonly batches: number;
  /** `TRIANGULATED` / `REFUSED` / `IDLE`. */
  readonly state: string;
  readonly stateReason: string;
  /** The two keyframe ids this batch related. `null` on an idle frame. */
  readonly keyframePair: readonly number[] | null;
  readonly correspondences: number;
  readonly inliers: number;
  readonly inlierRatio: number;
  readonly candidates: number;
  readonly accepted: number;
  readonly refusals: Record<string, number>;
  readonly medianParallaxDeg: number;
  readonly medianAcceptedParallaxDeg: number;
  /** The worst accepted point on each gate, so a gate that let one through is visible exactly. */
  readonly minAcceptedParallaxDeg: number;
  readonly maxAcceptedReprojectionPx: number;
  readonly minAcceptedDepth: number;
  readonly medianDepth: number;
  readonly medianDepthUncertainty: number;
  readonly medianReprojectionPx: number;
  /** The pair fit's rotation... */
  readonly rotationDeg: number;
  /** ...and Phase 6's own, accumulated between the same two keyframes. TRI-006 compares them. */
  readonly keyframeRotationDeg: number;
  readonly rotationDisagreementDeg: number;
  readonly model: string | null;
  readonly planar: boolean;
  readonly poseState: string;
  /** v4 §18. The depths are in units of this pair's baseline, which is 1 by construction. */
  readonly scale: string;
  readonly baselineUnits: number;
  readonly baselineNote: string;
  readonly samples: readonly TriangulatedPointRecord[];
  readonly depthInjection: DepthInjectionRecord | null;
  readonly rotationInjection: RotationInjectionRecord | null;
  /** What this batch cost, ms. `-1` on an idle frame. */
  readonly triangulationMs: number;
}

/* -------------------------------------------------------------------------- */
/* Phase 10 — landmark map                                                      */
/* -------------------------------------------------------------------------- */

/** One landmark, as a sample crossing the boundary. */
export interface LandmarkRecord {
  readonly id: number;
  /** In the world frame — the first registered keyframe's, in its batch's baseline units. */
  readonly position: readonly number[];
  readonly observations: number;
  readonly keyframes: number;
  readonly maxParallaxDeg: number;
  readonly meanPredictionPx: number;
  readonly predictions: number;
  readonly lastMoveRelative: number;
  readonly confidence: number;
  readonly state: string;
}

export interface LandmarkCullRecord {
  readonly id: number;
  readonly reason: string;
  readonly detail: string;
}

/**
 * MAP-005's measurement: positions the harness displaced and did not disclose.
 *
 * `cleanRejectionRate` is beside `recall` for GEO-003's reason: recall alone is scored perfectly
 * by a map that rejects everything, and the false-cull rate alone by one that rejects nothing.
 */
export interface LandmarkInjectionRecord {
  readonly injected: number;
  readonly clean: number;
  readonly injectedRejected: number;
  readonly cleanRejected: number;
  readonly recall: number;
  readonly cleanRejectionRate: number;
  /**
   * ...and the rate the gate refuses those same untouched points on the **uncorrupted** batch.
   *
   * The baseline. An absolute ceiling on `cleanRejectionRate` measures how noisy the scene is;
   * the *excess* over this measures whether the injection made the gate suspicious of the
   * innocent, which is what MAP-005's companion figure is for.
   */
  readonly baselineRejectionRate: number;
  /** How far the displacement moved each point's projection, px — an outlier by construction. */
  readonly displacementPx: number;
  readonly fraction: number;
  readonly seed: number;
}

/** One batch of Phase 10, or the frames in between. */
export interface LandmarkReport {
  readonly frames: number;
  readonly batches: number;
  /** `REGISTERED` / `UNREGISTERED` / `EPOCH_RESTART` / `IDLE`. */
  readonly state: string;
  readonly stateReason: string;
  readonly keyframePair: readonly number[] | null;
  readonly points: number;
  readonly shared: number;
  readonly admitted: number;
  readonly merged: number;
  readonly rejected: number;
  /** The ratio the registration recovered between this batch's baseline and the world's. */
  readonly registrationScale: number;
  readonly registrationResidual: number;
  readonly registrationUsed: number;
  readonly registrationOutliers: number;
  /* ---- MAP-002 ---- */
  readonly heldOut: number;
  readonly medianHeldOutPx: number;
  readonly maxHeldOutPx: number;
  readonly zeroHeldOut: number;
  readonly medianObservationsAtPrediction: number;
  /* ---- the map ---- */
  readonly landmarks: number;
  readonly confirmed: number;
  readonly culled: readonly LandmarkCullRecord[];
  readonly epoch: number;
  readonly epochRestarted: boolean;
  readonly medianConfidence: number;
  readonly medianMoveRelative: number;
  /** Median relative move at exactly two observations, and at five or more — MAP-006. */
  readonly moveAtTwo: number;
  readonly moveAtFive: number;
  readonly moveAtTwoSamples: number;
  readonly moveAtFiveSamples: number;
  /** v4 §22: this is not a model, and the record says so as a value. */
  readonly scale: string;
  readonly modelClaim: string;
  readonly landmarksPerKeyframe: number;
  readonly samples: readonly LandmarkRecord[];
  readonly injection: LandmarkInjectionRecord | null;
  readonly landmarkMs: number;
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
  /**
   * Phase 8's frame, or `null` when the keyframe store is not running.
   *
   * On the same message as Phases 4, 5 and 6's, for the reason each of those rides with the one
   * before it: they describe one frame. A keyframe decision reported beside a pose from a
   * different frame would be a decision about a view nobody took.
   */
  readonly keyframe: KeyframeReport | null;
  /**
   * Phase 9's frame, or `null` when triangulation is not running.
   *
   * Carried on every frame rather than only on the frames that batch, with `state: IDLE` in
   * between: the screen and the session need the cumulative counters, and a message that
   * appeared only on keyframe inserts would leave the screen frozen at the last batch with no
   * way to tell that from a stage that had stopped.
   */
  readonly triangulation: TriangulationReport | null;
  /**
   * Phase 10's frame, or `null` when the map is not running.
   *
   * Carried on every frame with `state: IDLE` in between, as Phase 9's is and for the same
   * reason: the screen needs the cumulative state, and a message that appeared only on batches
   * would leave it unable to tell "no batch this frame" from "the map has stopped".
   */
  readonly landmarks: LandmarkReport | null;
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
