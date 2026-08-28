/**
 * Phase 0 application shell.
 *
 * Wiring only: it runs capability detection, evaluates the Phase 0 suite against the
 * result, hands the verdict to the PhaseRegistry, and renders whatever the registry says.
 * It never decides a verdict itself, and it holds no spatial state — there is no spatial
 * state in Phase 0, and stubbing some would be exactly the fake completion §2 forbids.
 */

import './ui/styles.css';

import { EvidenceLeg, PhaseState } from './core/types';
import type {
  CapabilityMatrix,
  DeviceInfo,
  EvidenceBundle,
  JsonValue,
  TestResult,
} from './core/types';
import { PhaseRegistry, PHASE_NAMES, isPhaseImplemented } from './core/PhaseRegistry';
import { Rng } from './core/Rng';
import { CapabilityDetector, collectDeviceInfo } from './capture/CapabilityDetector';
import { probeMotionSensors } from './capture/MotionCapabilityProbe';
import { CameraSource, CameraState } from './capture/CameraSource';
import { FrameIntegrityMonitor } from './capture/FrameIntegrityMonitor';
import { ScenarioLedger } from './capture/ScenarioLedger';
import { runPhase1Tests, PHASE1_SPECS } from './testkit/Phase1Tests';
import { runPhase2Tests, PHASE2_SPECS } from './testkit/Phase2Tests';
import { runPhase3Tests, PHASE3_SPECS } from './testkit/Phase3Tests';
import { runPhase4Tests, PHASE4_SPECS } from './testkit/Phase4Tests';
import { runPhase5Tests, PHASE5_SPECS } from './testkit/Phase5Tests';
import { runPhase6Tests, PHASE6_SPECS } from './testkit/Phase6Tests';
import { runPhase7Tests, PHASE7_SPECS } from './testkit/Phase7Tests';
import { runPhase8Tests, PHASE8_SPECS } from './testkit/Phase8Tests';
import { FeaturePopulation } from './tracking/FeaturePopulation';
import { FlowSession } from './tracking/FlowSession';
import { VerificationSession } from './tracking/VerificationSession';
import { INJECTION_SAMPLE_EVERY } from './tracking/VerificationStage';
import { PoseSession } from './tracking/PoseSession';
import { POSE_INJECTION_SAMPLE_EVERY } from './tracking/PoseStage';
import { RotationRateMonitor } from './capture/RotationRateMonitor';
import { asTrackingResult, DEFAULT_TRACKING_OPTIONS } from './tracking/trackingMessages';
import type { TrackingOptions } from './tracking/trackingMessages';
import { renderPhase3Screen } from './ui/Phase3Screen';
import { renderPhase4Screen } from './ui/Phase4Screen';
import { renderPhase5Screen } from './ui/Phase5Screen';
import { renderPhase6Screen } from './ui/Phase6Screen';
import { renderPhase7Screen } from './ui/Phase7Screen';
import { renderPhase8Screen } from './ui/Phase8Screen';
import { FusionStage } from './tracking/FusionStage';
import { FusionSession } from './tracking/FusionSession';
import { KeyframeSession } from './tracking/KeyframeSession';
import { WorkerFramePipeline } from './pipeline/WorkerFramePipeline';
import { renderPhase1Screen } from './ui/Phase1Screen';
import { renderPhase2Screen } from './ui/Phase2Screen';
import { getPreviewVideo, isPreviewPresented } from './ui/PreviewVideo';
import {
  isMisoriented,
  scoreAlignment,
  MIN_IDENTITY_OVER_RANDOM,
} from './debug/OverlayAlignmentProbe';
import type { AlignmentReading } from './debug/OverlayAlignmentProbe';
import { logger } from './debug/Logger';
import {
  buildEvidenceBundle,
  determineLeg,
  evidenceFilename,
  serialiseEvidence,
} from './debug/EvidenceRecorder';
import type { LegDetermination } from './debug/EvidenceRecorder';
import { runPhase0Tests, PHASE0_SPECS } from './testkit/Phase0Tests';
import { findIntegrityIssues, toJsonSafe } from './core/validate';
import { renderPhase0Screen, readUiSnapshot } from './ui/Phase0Screen';
import type { Phase0ViewModel } from './ui/Phase0Screen';

const APP_VERSION = __APP_VERSION__;
const PHASE = 0;
const PHASE1 = 1;
const PHASE2 = 2;
const PHASE3 = 3;
const PHASE4 = 4;
const PHASE5 = 5;
const PHASE6 = 6;
const PHASE7 = 7;
const PHASE8 = 8;
const PHASE9 = 9;
const PROBE_BUDGET_MS = 1500;
/** How often the SCAN screen re-evaluates while the camera is live. */
const PHASE1_TICK_MS = 500;
/**
 * How often the PIPELINE screen re-evaluates.
 *
 * Not per frame: the pipeline reports state changes 30 times a second, and re-rendering
 * the DOM at that rate would put the UI cost FRAME-005 measures into the measurement
 * itself. Twice a second is enough for a human and cheap enough not to distort the run.
 */
const PHASE2_TICK_MS = 500;
/** Same reasoning as Phase 2's: re-render for a human, not for every frame. */
const PHASE3_TICK_MS = 500;
/** How often the contrast check and the paired grid control are asked for. */
const PHASE3_SAMPLE_EVERY = 8;
/** Same again for the TRACKING screen. */
const PHASE4_TICK_MS = 500;
/** ...and for the GEOMETRIC VERIFICATION screen. */
const PHASE5_TICK_MS = 500;
/** ...and for the RELATIVE POSE screen. */
const PHASE6_TICK_MS = 500;
/** Same reasoning as every screen before it: re-render for a human, not for every frame. */
const PHASE7_TICK_MS = 500;
/** ...and for the KEYFRAME SYSTEM screen. */
const PHASE8_TICK_MS = 500;

type Screen =
  | 'phase0' | 'phase1' | 'phase2' | 'phase3' | 'phase4' | 'phase5' | 'phase6' | 'phase7'
  | 'phase8';

class Phase0App {
  private readonly root: HTMLElement;
  private readonly registry = new PhaseRegistry();
  private detector = new CapabilityDetector();

  private matrix: CapabilityMatrix | null = null;
  private results: TestResult[] = [];
  private device: DeviceInfo | null = null;
  private leg: LegDetermination | null = null;
  private bundle: EvidenceBundle | null = null;
  private detecting = false;
  private sensorProbeRunning = false;
  private sensorProbeDone = false;
  private integrityIssues: readonly { path: string; problem: string }[] = [];

  /**
   * One re-evaluation timer per phase screen, keyed by phase index.
   *
   * Seven `phaseNTimer` fields with seven identical start/stop pairs became this. The pairs were
   * where a phase could have leaked a timer by clearing the wrong field, and a map keyed by the
   * index makes that impossible rather than merely unlikely.
   */
  private readonly tickers = new Map<number, number>();

  private screen: Screen = 'phase0';
  private readonly camera = new CameraSource();
  private readonly monitor = new FrameIntegrityMonitor();
  private readonly ledger = new ScenarioLedger(APP_VERSION);
  private phase1Results: TestResult[] = [];
  private phase1Bundle: EvidenceBundle | null = null;
  private cameraOpening = false;
  /**
   * The composition root supplies the worker.
   *
   * `main.ts` belongs to no layer, which is what lets it name both sides: the pipeline that
   * schedules frames and the tracking worker that consumes them. Neither module can see the
   * other (§83, and the architecture audit that enforces it).
   */
  private readonly pipeline = new WorkerFramePipeline(
    () =>
      new Worker(new URL('./tracking/trackingWorker.ts', import.meta.url), {
        type: 'module',
        name: 'tracking-worker',
      }),
    { onTracking: (payload) => this.onTracking(payload) },
  );
  private readonly features = new FeaturePopulation();
  private phase3Results: TestResult[] = [];
  private phase3Bundle: EvidenceBundle | null = null;
  private phase3DevEntry = false;
  private detectionEverRan = false;
  /**
   * Whether detection has been asked for — which is NOT the same as the pipeline running.
   *
   * Phase 3 is reached from a Phase 2 screen whose pipeline is still live, and it adopts
   * that pipeline rather than restarting the camera. So `pipeline.isRunning()` says nothing
   * about whether anything is detecting, and using it as if it did is what made
   * START DETECTION a no-op on the device: the guard saw a running pipeline, returned early,
   * and the tracking options were never sent to the worker while the screen said DETECTING.
   */
  private trackingRequested = false;
  private trackingFrames = 0;
  /**
   * Phase 4's own "am I running", which is NOT Phase 3's and NOT the pipeline's (§H.5).
   *
   * Phase 4 is reached from a FEATURES screen whose detection is still running — it has to
   * be, because that is how Phase 3 passes — so both `pipeline.isRunning()` and
   * `trackingRequested` are already true on arrival. Deriving Phase 4's state from either
   * would render START TRACKING as "TRACKING", disabled, before anyone touched it. That is
   * the defect Phase 3 shipped twice; it is written down in §H.5 and it is not repeated here.
   */
  private flowRequested = false;
  private flowEverRan = false;
  private phase4Results: TestResult[] = [];
  private phase4Bundle: EvidenceBundle | null = null;
  private phase4DevEntry = false;
  private readonly flow = new FlowSession();
  /**
   * Phase 5's own "am I running", for the third time and for the same reason (§H.5).
   *
   * The GEOMETRIC VERIFICATION screen is reached from a TRACKING screen whose pipeline,
   * detection and optical flow are all live — it has to be, because that is how Phase 4
   * passes — so `pipeline.isRunning()`, `trackingRequested` and `flowRequested` are all
   * already true on arrival. A predicate built from any of them renders START VERIFICATION as
   * "VERIFYING", disabled, before anyone touches it. That is the defect Phase 3 shipped twice
   * and Phase 4 was written to avoid; it is not repeated here either.
   */
  private verifyRequested = false;
  private verifyEverRan = false;
  private phase5Results: TestResult[] = [];
  private phase5Bundle: EvidenceBundle | null = null;
  private phase5DevEntry = false;
  /** Counts frames offered to the worker while verifying, so GEO-003 is sampled, not constant. */
  private verifyFrames = 0;
  private readonly verification = new VerificationSession();
  /**
   * Phase 6's own "am I running", for the fourth time and for the same reason (§H.5).
   *
   * The RELATIVE POSE screen is reached from a GEOMETRIC VERIFICATION screen whose camera,
   * pipeline, detector, tracker and verifier are all live — they have to be, because that is how
   * Phase 5 passes — so every predicate below this one is already true on arrival. Four screens
   * in, this is no longer a hypothetical: it is the defect Phase 3 shipped twice.
   */
  private poseRequested = false;
  private poseEverRan = false;
  private phase6Results: TestResult[] = [];
  private phase6Bundle: EvidenceBundle | null = null;
  private phase6DevEntry = false;
  private poseFrames = 0;
  private readonly pose = new PoseSession();
  private readonly rotation = new RotationRateMonitor();
  /**
   * Phase 7's own "am I running", for the fifth time and for the same reason (§H.5).
   *
   * Six stages are live when the IMU SUPPORT / FUSION screen opens — camera, pipeline,
   * detector, tracker, verifier, pose — because that is how Phase 6 passes. A predicate
   * assembled from any of them says "fusing" before fusion has started.
   */
  private fusionRequested = false;
  private fusionEverRan = false;
  private phase7Results: TestResult[] = [];
  private phase7Bundle: EvidenceBundle | null = null;
  private phase7DevEntry = false;
  /**
   * The stage and its accumulator.
   *
   * Seeded from the app's start time so the injected bias does not land on the same axis on
   * every run — POSE-005's rule, one phase along: a run that is right about one axis by luck
   * must not be able to be right about it twice.
   */
  private readonly fusionStage = new FusionStage(Date.now());
  private readonly fusion = new FusionSession();
  /**
   * Phase 8's own "am I running", for the sixth time and for the same reason (§H.5).
   *
   * Seven stages are live when the KEYFRAME SYSTEM screen opens — camera, pipeline, detector,
   * tracker, verifier, pose, fusion — because that is how Phase 7 passes. A predicate assembled
   * from any of them says "keeping" before the store has been started.
   */
  private keyframesRequested = false;
  private keyframesEverRan = false;
  private phase8Results: TestResult[] = [];
  private phase8Bundle: EvidenceBundle | null = null;
  private phase8DevEntry = false;
  /**
   * The accumulator. The store itself lives in the worker, beside the population it observes —
   * a keyframe is a set of feature positions, and shipping them to the main thread to decide
   * about them would put a structured clone of the population on every frame's message.
   */
  private readonly keyframes = new KeyframeSession();
  private lastOverlayAge: Uint16Array | null = null;
  private lastOverlay: Float32Array | null = null;
  private alignment: AlignmentReading | null = null;
  private misorientedProbes = 0;
  private routeRejectedForOrientation: string | null = null;
  private alignmentCanvas: HTMLCanvasElement | null = null;
  private readonly alignmentRng = new Rng(0xa11a_11ed);
  private lastOverlayWidth = 0;
  private lastOverlayHeight = 0;
  private phase2Results: TestResult[] = [];
  private phase2Bundle: EvidenceBundle | null = null;
  private phase2DevEntry = false;
  private pipelineEverStarted = false;
  /** Why the last request to inject load was refused, shown verbatim on the screen. */
  private stressRefusal: string | null = null;
  /**
   * Set only when Phase 1 was opened through the desktop development override. It is
   * recorded in the evidence bundle, and it is unreachable on a device: the override is
   * gated on the leg being DESKTOP_DEV, which is itself derived from navigator.webdriver
   * and a local origin. A DESKTOP_DEV bundle cannot pass a phase in any case (Rule 004).
   */
  private phase1DevEntry = false;
  private cameraEverOpened = false;
  /** Set by the track's own 'ended' event, never by the user pressing stop. */
  private cameraEndedUnexpectedly = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    // Registered once, on the source rather than on a track: `CameraSource` keeps its
    // listener set across opens, so subscribing per open would add a listener every time
    // the camera was started and fire the Phase 1 handler from a Phase 2 session.
    this.camera.onEnded((reason) => this.onCameraEnded(reason));
    this.registry.setState(PHASE, PhaseState.IMPLEMENTING, 'capability detection starting');
    this.device = collectDeviceInfo();
    this.leg = determineLeg(this.device);
    logger.info(PHASE, 'App', 'Phase 0 starting', {
      appVersion: APP_VERSION,
      leg: this.leg.leg,
      origin: location.origin,
    });
    this.render();
    await this.detect();
  }

  private async detect(): Promise<void> {
    this.detecting = true;
    this.render();
    this.detector = new CapabilityDetector();
    try {
      this.matrix = await this.detector.detectAll();
      logger.info(PHASE, 'CapabilityDetector', 'capability detection complete', {
        records: this.matrix.records.length,
        totalProbeMs: this.matrix.totalDurationMs,
      });
      for (const r of this.matrix.records) {
        if (r.error) {
          logger.error(
            PHASE,
            `probe:${r.id}`,
            `probe failed: ${r.detail}`,
            'recorded as ERROR in the matrix; the capability is treated as undetermined, ' +
              'not as available',
            r.error,
          );
        }
      }
    } catch (err) {
      logger.error(
        PHASE, 'CapabilityDetector', 'capability detection threw',
        'Phase 0 is marked FAILED; no capability may be assumed', err,
      );
      this.registry.setState(PHASE, PhaseState.FAILED, 'capability detection threw');
    } finally {
      this.detecting = false;
    }
    this.evaluate();
  }

  /**
   * Render first, then evaluate.
   *
   * CAP-0011 compares the live DOM control against the registry, so the DOM has to exist
   * before the tests read it. Rendering twice is cheap and keeps the check honest: the
   * test reads the actual button, not a variable that claims to describe it.
   */
  private evaluate(): void {
    if (!this.matrix) {
      this.render();
      return;
    }
    this.render();

    const previous = this.registry.get(PHASE).state;
    const leg = this.leg?.leg ?? EvidenceLeg.DESKTOP_DEV;

    this.results = this.runTests(readUiSnapshot());
    this.registry.applyEvaluation(PHASE, PhaseRegistry.evaluate(this.results, leg));

    // The UI can change when the phase verdict changes (the control's label depends on the
    // phase state), so re-render and re-read the control before freezing the evidence.
    // Otherwise the bundle would record a UI snapshot the final screen no longer matches,
    // which is exactly the UI/engine divergence CAP-0011 exists to catch.
    this.render();
    this.results = this.runTests(readUiSnapshot());
    let settled = PhaseRegistry.evaluate(this.results, leg);
    this.registry.applyEvaluation(PHASE, settled);

    this.buildEvidence(settled.state, settled.reason);

    // Final gate: the phase verdict rests on the evidence file, so a corrupt file must
    // fail the phase rather than accompany a green one. Rebuilt so the saved bundle
    // records the verdict it actually caused.
    if (this.integrityIssues.length > 0) {
      const reason =
        `evidence bundle failed its integrity check with ${this.integrityIssues.length} ` +
        `issue(s): ${this.integrityIssues.slice(0, 3).map((i) => `${i.path}=${i.problem}`).join(', ')}`;
      settled = { ...settled, state: PhaseState.FAILED, reason };
      this.registry.setState(PHASE, PhaseState.FAILED, reason);
      this.buildEvidence(PhaseState.FAILED, reason);
    }

    const next = this.registry.get(PHASE).state;
    if (previous !== next) {
      // Narrative only. The registry already recorded this transition and is the single
      // authority for it; calling logger.transition() here would put a second, differently
      // labelled copy into the evidence bundle's stateTransitions array.
      logger.info(PHASE, 'App', `phase ${PHASE}: ${previous} -> ${next}`, {
        reason: settled.reason,
      });
    }
    this.render();
  }

  /**
   * The draft is everything that will be saved except the test results themselves, so
   * CAP-0010 can validate what is really going to be written to disk without validating a
   * structure that contains its own verdict.
   */
  private evidenceDraft(): unknown {
    return {
      device: this.device,
      capabilityMatrix: this.matrix,
      legSignals: this.leg?.signals ?? null,
      stateTransitions: [...this.registry.getTransitions(), ...logger.getTransitions()],
      log: logger.getEntries(),
    };
  }

  private runTests(ui: ReturnType<typeof readUiSnapshot>): TestResult[] {
    if (!this.matrix) return [];
    return runPhase0Tests({
      matrix: this.matrix,
      registry: this.registry,
      ui,
      probeBudgetMs: PROBE_BUDGET_MS,
      evidenceDraft: this.evidenceDraft(),
    });
  }

  private buildEvidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE,
      phaseName: PHASE_NAMES[PHASE] ?? 'Environment / Capability',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: [...this.registry.getTransitions(), ...logger.getTransitions()],
      log: logger.getEntries(),
    });
    this.bundle = built.bundle;
    this.leg = built.leg;
    this.integrityIssues = built.integrityIssues;
    if (built.integrityIssues.length > 0) {
      logger.error(
        PHASE, 'EvidenceRecorder',
        `evidence bundle has ${built.integrityIssues.length} integrity issue(s)`,
        'Phase 0 is forced to FAILED — a verdict may not rest on a corrupt evidence file. ' +
          'The bundle is still offered for download so the problem is inspectable.',
        undefined,
        { issues: built.integrityIssues.slice(0, 10) },
      );
    }
  }

  /** Independent re-check of the assembled bundle, used by the automated leg. */
  private currentIntegrityIssues(): readonly { path: string; problem: string }[] {
    if (!this.bundle) return [];
    return findIntegrityIssues(this.bundle, '$').map((i) => ({ path: i.path, problem: i.problem }));
  }

  private async onProbeSensors(): Promise<void> {
    if (this.sensorProbeRunning) return;
    this.sensorProbeRunning = true;
    this.render();
    try {
      // Called synchronously from the click handler so the iOS gesture requirement holds.
      const { motion, orientation } = await probeMotionSensors();
      this.detector.upsert(motion);
      this.detector.upsert(orientation);
      this.matrix = this.detector.getMatrix();
      this.sensorProbeDone = true;
      logger.info(PHASE, 'MotionProbe', 'sensor probe finished', {
        motion: motion.state,
        orientation: orientation.state,
        motionEvents: motion.data['eventsWithFiniteData'] ?? null,
        orientationEvents: orientation.data['eventsWithFiniteData'] ?? null,
      });
    } catch (err) {
      logger.error(
        PHASE, 'MotionProbe', 'motion sensor probe threw',
        'the motion capability stays undetermined, so CAP-0004/0005 remain PENDING or FAIL ' +
          'rather than being assumed available',
        err,
      );
    } finally {
      this.sensorProbeRunning = false;
    }
    this.evaluate();
  }

  private onDownloadEvidence(bundle: EvidenceBundle | null): void {
    if (!bundle) return;
    const json = serialiseEvidence(bundle);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = evidenceFilename(bundle);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logger.info(bundle.phase, 'Evidence', 'evidence download started', { file: a.download });
  }

  private async onCopyEvidence(bundle: EvidenceBundle | null): Promise<void> {
    if (!bundle) return;
    const json = serialiseEvidence(bundle);
    try {
      await navigator.clipboard.writeText(json);
      logger.info(bundle.phase, 'Evidence', 'evidence copied to clipboard', { bytes: json.length });
    } catch (err) {
      logger.error(
        PHASE, 'Evidence', 'clipboard write failed',
        'the JSON is still shown in the "Show evidence JSON" panel for manual selection',
        err,
      );
      this.render();
    }
  }

  private viewModel(): Phase0ViewModel {
    return {
      appVersion: APP_VERSION,
      phase0: this.registry.get(0),
      phase1: this.registry.get(1),
      canEnterPhase1: this.registry.canEnter(1),
      matrix: this.matrix,
      results: this.results,
      device: this.device,
      leg: this.leg,
      bundle: this.bundle,
      log: logger.getEntries(),
      detecting: this.detecting,
      sensorProbeRunning: this.sensorProbeRunning,
      sensorProbeDone: this.sensorProbeDone,
    };
  }

  private render(): void {
    if (this.screen === 'phase8') {
      const p = this.pipeline.getStats();
      renderPhase8Screen(
        this.root,
        {
          phase8: this.registry.get(PHASE8),
          phase9: this.registry.get(PHASE9),
          canEnterPhase9: this.registry.canEnter(PHASE9),
          phase9Implemented: isPhaseImplemented(PHASE9),
          phase9BlockedReason: this.registry.blockedReason(PHASE9),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // The one predicate, read by the control, the tests and the evidence alike (§H.5).
          running: this.isKeepingKeyframes(),
          stats: this.keyframes.stats(this.isKeepingKeyframes()),
          sourceWidth: p.sourceWidth,
          sourceHeight: p.sourceHeight,
          results: this.phase8Results,
        },
        {
          onStart: () => void this.onStartPhase8(),
          onStop: () => this.onStopPhase8('user stopped the keyframe store'),
          onBack: () => this.leavePhase8(),
          onEnterPhase9: () => this.enterPhase9(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase8Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase8Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase7') {
      renderPhase7Screen(
        this.root,
        {
          phase7: this.registry.get(PHASE7),
          phase8: this.registry.get(PHASE8),
          canEnterPhase8: this.registry.canEnter(PHASE8),
          phase8Implemented: isPhaseImplemented(PHASE8),
          phase8BlockedReason: this.registry.blockedReason(PHASE8),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // The one predicate, read by the control, the tests and the evidence alike (§H.5).
          running: this.isFusing(),
          stats: this.fusion.stats(this.isFusing()),
          sourceWidth: this.pipeline.getStats().sourceWidth,
          sourceHeight: this.pipeline.getStats().sourceHeight,
          results: this.phase7Results,
        },
        {
          onStart: () => void this.onStartPhase7(),
          onStop: () => this.onStopPhase7('user stopped fusion'),
          onBack: () => this.leavePhase7(),
          onEnterPhase8: () => this.enterPhase8(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase7Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase7Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase6') {
      const p = this.pipeline.getStats();
      renderPhase6Screen(
        this.root,
        {
          phase6: this.registry.get(PHASE6),
          phase7: this.registry.get(PHASE7),
          canEnterPhase7: this.registry.canEnter(PHASE7),
          phase7Implemented: isPhaseImplemented(PHASE7),
          phase7BlockedReason: this.registry.blockedReason(PHASE7),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // The one predicate, read by the control, the tests and the evidence alike (§H.5).
          running: this.isPosing(),
          stats: this.pose.stats(this.isPosing()),
          // §H budgets RANSAC and pose recovery as one line, so the screen shows both halves.
          verifyMs: this.verification.stats(this.isPosing()).meanVerifyMs,
          alignment: this.alignment,
          overlay: this.lastOverlay,
          overlayAge: this.lastOverlayAge,
          overlayWidth: this.lastOverlayWidth,
          overlayHeight: this.lastOverlayHeight,
          sourceWidth: p.sourceWidth,
          sourceHeight: p.sourceHeight,
          results: this.phase6Results,
        },
        {
          onStart: () => void this.onStartPhase6(),
          onStop: () => this.onStopPhase6('user stopped pose recovery'),
          onBack: () => this.leavePhase6(),
          onEnterPhase7: () => this.enterPhase7(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase6Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase6Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase5') {
      const p = this.pipeline.getStats();
      renderPhase5Screen(
        this.root,
        {
          phase5: this.registry.get(PHASE5),
          phase6: this.registry.get(PHASE6),
          canEnterPhase6: this.registry.canEnter(PHASE6),
          phase6Implemented: isPhaseImplemented(PHASE6),
          phase6BlockedReason: this.registry.blockedReason(PHASE6),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // The one predicate, read by the control, the tests and the evidence alike (§H.5).
          running: this.isVerifying(),
          stats: this.verification.stats(this.isVerifying()),
          alignment: this.alignment,
          overlay: this.lastOverlay,
          overlayAge: this.lastOverlayAge,
          overlayWidth: this.lastOverlayWidth,
          overlayHeight: this.lastOverlayHeight,
          sourceWidth: p.sourceWidth,
          sourceHeight: p.sourceHeight,
          results: this.phase5Results,
        },
        {
          onStart: () => void this.onStartPhase5(),
          onStop: () => this.onStopPhase5('user stopped verification'),
          onBack: () => this.leavePhase5(),
          onEnterPhase6: () => this.enterPhase6(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase5Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase5Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase4') {
      const p = this.pipeline.getStats();
      renderPhase4Screen(
        this.root,
        {
          phase4: this.registry.get(PHASE4),
          phase5: this.registry.get(PHASE5),
          canEnterPhase5: this.registry.canEnter(PHASE5),
          phase5Implemented: isPhaseImplemented(PHASE5),
          phase5BlockedReason: this.registry.blockedReason(PHASE5),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // The one predicate, read by the control, the tests and the evidence alike (§H.5).
          running: this.isTracking(),
          stats: this.flow.stats(this.isTracking()),
          alignment: this.alignment,
          overlay: this.lastOverlay,
          overlayAge: this.lastOverlayAge,
          overlayWidth: this.lastOverlayWidth,
          overlayHeight: this.lastOverlayHeight,
          sourceWidth: p.sourceWidth,
          sourceHeight: p.sourceHeight,
          results: this.phase4Results,
        },
        {
          onStart: () => void this.onStartPhase4(),
          onStop: () => this.onStopPhase4('user stopped tracking'),
          onBack: () => this.leavePhase4(),
          onEnterPhase5: () => this.enterPhase5(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase4Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase4Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase3') {
      const stats = this.features.stats(this.isDetecting());
      const p = this.pipeline.getStats();
      renderPhase3Screen(
        this.root,
        {
          phase3: this.registry.get(PHASE3),
          phase4: this.registry.get(PHASE4),
          canEnterPhase4: this.registry.canEnter(PHASE4),
          phase4Implemented: isPhaseImplemented(PHASE4),
          phase4BlockedReason: this.registry.blockedReason(PHASE4),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          // Rule 002, and the reason START DETECTION was unpressable on the device: this
          // drives the button's label AND its disabled state, so a bare `pipeline.isRunning()`
          // here renders DETECTING — disabled — the instant the screen opens over Phase 2's
          // still-running pipeline. Every reading of "is anything detecting" goes through the
          // one predicate, this one included.
          running: this.isDetecting(),
          stats,
          alignment: this.alignment,
          overlay: this.lastOverlay,
          overlayWidth: this.lastOverlayWidth,
          overlayHeight: this.lastOverlayHeight,
          sourceWidth: p.sourceWidth,
          sourceHeight: p.sourceHeight,
          results: this.phase3Results,
        },
        {
          onStart: () => void this.onStartPhase3(),
          onStop: () => this.onStopPhase3('user stopped detection'),
          onBack: () => this.leavePhase3(),
          onEnterPhase4: () => this.enterPhase4(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase3Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase3Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase2') {
      renderPhase2Screen(
        this.root,
        {
          phase2: this.registry.get(PHASE2),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          stats: this.pipeline.getStats(),
          strip: this.pipeline.getLastStrip(),
          results: this.phase2Results,
          stressRefusal: this.stressRefusal,
          phase3: this.registry.get(PHASE3),
          canEnterPhase3: this.registry.canEnter(PHASE3),
          phase3Implemented: isPhaseImplemented(PHASE3),
          phase3BlockedReason: this.registry.blockedReason(PHASE3),
        },
        {
          onStartCamera: () => void this.onStartPipeline(),
          onStopPipeline: () => this.onStopPipeline('user stopped the pipeline'),
          onToggleStress: () => this.onToggleStress(),
          onBack: () => this.leavePhase2(),
          onEnterPhase3: () => this.enterPhase3(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase2Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase2Bundle),
        },
      );
      return;
    }
    if (this.screen === 'phase1') {
      renderPhase1Screen(
        this.root,
        {
          phase1: this.registry.get(PHASE1),
          cameraState: this.camera.getState(),
          openResult: this.camera.getLastResult(),
          settings: this.camera.currentSettings(),
          stats: this.monitor.getStats(),
          results: this.phase1Results,
          granted: this.ledger.get('GRANTED'),
          denied: this.ledger.get('DENIED'),
          opening: this.cameraOpening,
          trackLive: this.camera.isLive(),
          phase2: this.registry.get(PHASE2),
          canEnterPhase2: this.registry.canEnter(PHASE2),
          phase2Implemented: isPhaseImplemented(PHASE2),
          phase2BlockedReason: this.registry.blockedReason(PHASE2),
        },
        {
          onStartCamera: () => void this.onStartCamera(),
          onStopCamera: () => this.onStopCamera('user stopped the camera'),
          onBack: () => this.leavePhase1(),
          onEnterPhase2: () => this.enterPhase2(),
          onDownloadEvidence: () => this.onDownloadEvidence(this.phase1Bundle),
          onCopyEvidence: () => void this.onCopyEvidence(this.phase1Bundle),
        },
      );
      return;
    }
    renderPhase0Screen(this.root, this.viewModel(), {
      onStartScan: () => this.enterPhase1(),
      onProbeSensors: () => void this.onProbeSensors(),
      onDownloadEvidence: () => this.onDownloadEvidence(this.bundle),
      onCopyEvidence: () => void this.onCopyEvidence(this.bundle),
      onRerun: () => void this.detect(),
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 1 — Camera Capture                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Enter the SCAN screen.
   *
   * Refused unless Phase Lock permits it. `devOverride` exists so the automated desktop
   * leg can exercise Phase 1 at all — on that leg Phase 0 correctly stops at TESTING, so
   * the lock never opens. It is gated on the leg being DESKTOP_DEV and is recorded in the
   * evidence, and a DESKTOP_DEV bundle cannot pass a phase regardless.
   */
  private enterPhase1(devOverride = false): boolean {
    if (!this.registry.canEnter(PHASE1)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE1, 'App', 'refused entry to Phase 1', {
          reason: this.registry.blockedReason(PHASE1),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase1DevEntry = true;
      logger.warn(
        PHASE1, 'App',
        'Phase 1 opened through the desktop development override',
        {
          note: 'this path is unreachable on a real device and the resulting bundle is ' +
            'DESKTOP_DEV, which cannot pass a phase',
        },
      );
    }
    this.screen = 'phase1';
    if (this.registry.get(PHASE1).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE1, PhaseState.IMPLEMENTING, 'SCAN screen opened');
    }
    this.evaluatePhase1();
    this.render();
    return true;
  }

  private leavePhase1(): void {
    this.onStopCamera('left the SCAN screen');
    this.screen = 'phase0';
    this.render();
  }

  /** MUST be reached from the click handler: getUserMedia needs the user gesture. */
  private async onStartCamera(): Promise<void> {
    if (this.cameraOpening || this.camera.isLive()) return;
    this.cameraOpening = true;
    this.render();

    const result = await this.camera.open();
    this.cameraOpening = false;

    if (result.state === CameraState.LIVE && result.stream) {
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      const video = getPreviewVideo();
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE1, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and the frame monitor still runs; if no frames arrive, ' +
            'CAM-003 fails rather than the stall being hidden',
          err,
        );
      }
      this.monitor.start(video);
      this.ledger.observe(
        'GRANTED',
        `${result.settings?.width}x${result.settings?.height} @ ` +
          `${result.settings?.frameRate}fps, facingMode=${result.settings?.facingMode}, ` +
          `ladder rung ${result.rungUsed}`,
      );
      logger.info(PHASE1, 'CameraSource', 'camera opened', {
        rung: result.rungUsed,
        settings: result.settings as unknown as Record<string, never>,
      });
      this.startPhase1Ticking();
    } else if (result.state === CameraState.PERMISSION_DENIED) {
      this.ledger.observe(
        'DENIED',
        `${result.failure?.errorName ?? 'unknown'} — no stream held, no image presented`,
      );
      logger.error(
        PHASE1, 'CameraSource', 'camera permission denied',
        result.failure?.recovery ?? 'no stream is held',
        undefined,
        { errorName: result.failure?.errorName ?? null },
      );
    } else {
      logger.error(
        PHASE1, 'CameraSource', `camera unavailable: ${result.failure?.errorName ?? 'unknown'}`,
        result.failure?.recovery ?? 'the camera is reported unavailable',
        undefined,
        { attempts: result.attempts as unknown as Record<string, never> },
      );
    }

    this.evaluatePhase1();
    this.render();
  }

  private onStopCamera(reason: string): void {
    this.stopPhase1Ticking();
    this.monitor.stop();
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase1();
    this.render();
  }

  private startPhase1Ticking(): void {
    // Re-render on a timer so the measured values stay live. The preview element is
    // re-appended synchronously inside the same render call, which the HTML spec's
    // "await a stable state" rule makes a no-op for playback — and CAM-003 measures the
    // longest frame gap, so if that reasoning were wrong the test would say so.
    this.startTicking(PHASE1, PHASE1_TICK_MS, () => {
      this.evaluatePhase1();
      this.render();
    });
  }

  private stopPhase1Ticking(): void {
    this.stopTicking(PHASE1);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-phase lifecycle, written once                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Re-evaluate a phase screen on a timer, replacing whatever was running for it.
   *
   * Not per frame: a screen's numbers change 30 times a second and re-rendering the DOM at that
   * rate would put the UI's own cost inside the measurement it is displaying. Twice a second is
   * enough for a human and cheap enough not to distort the run — the reasoning Phase 2 wrote
   * down and every screen since has followed.
   */
  private startTicking(index: number, intervalMs: number, tick: () => void): void {
    this.stopTicking(index);
    this.tickers.set(index, window.setInterval(tick, intervalMs));
  }

  private stopTicking(index: number): void {
    const id = this.tickers.get(index);
    if (id !== undefined) {
      clearInterval(id);
      this.tickers.delete(index);
    }
  }

  /**
   * Keep a freshly built bundle, and say so loudly if it does not describe itself.
   *
   * `findIntegrityIssues` walks the bundle for values that cannot be true of a real run — a
   * verdict that its own results do not support, a rate outside 0..1, a NaN where a measurement
   * should be. The bundle is still offered for download when it finds something, because a
   * broken bundle is evidence of the break and withholding it would leave the defect
   * undiagnosable (§80).
   */
  private keepBundle(index: number, built: { bundle: EvidenceBundle; integrityIssues: readonly unknown[] }): EvidenceBundle {
    if (built.integrityIssues.length > 0) {
      logger.error(
        index, 'EvidenceRecorder',
        `Phase ${index} evidence has ${built.integrityIssues.length} integrity issue(s)`,
        'the bundle is still offered for download so the problem is inspectable',
        undefined,
        { issues: built.integrityIssues.slice(0, 10) },
      );
    }
    return built.bundle;
  }

  /**
   * Grade a phase's results, record the verdict, and rebuild its evidence bundle.
   *
   * Seven copies of this said the same thing. **Nothing here decides anything**: the verdict
   * comes from `PhaseRegistry.evaluate` over the results the suite produced, and the leg comes
   * from `LegDetermination`. That is what lets `tests/unit/committedEvidence.test.ts` re-derive
   * a committed bundle's verdict from its own results and catch a hand-edited one.
   *
   * The leg defaults to `DESKTOP_DEV` where none has been determined, which is the conservative
   * direction: Rule 004 says a desktop leg cannot pass a phase, so an undetermined leg cannot
   * either.
   */
  private applyPhase(
    index: number,
    results: readonly TestResult[],
    buildEvidence: (verdict: PhaseState, reason: string) => void,
  ): void {
    const previous = this.registry.get(index).state;
    const leg = this.leg?.leg ?? EvidenceLeg.DESKTOP_DEV;
    const evaluation = PhaseRegistry.evaluate(results, leg);
    this.registry.applyEvaluation(index, evaluation);
    const next = this.registry.get(index).state;
    if (previous !== next) {
      logger.info(index, 'App', `phase ${index}: ${previous} -> ${next}`, {
        reason: evaluation.reason,
      });
    }
    buildEvidence(evaluation.state, evaluation.reason);
  }

  private evaluatePhase1(): void {
    const video = getPreviewVideo();
    this.phase1Results = runPhase1Tests({
      cameraState: this.camera.getState(),
      openResult: this.camera.getLastResult(),
      trackLive: this.camera.isLive(),
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      stats: this.monitor.getStats(),
      granted: this.ledger.get('GRANTED'),
      denied: this.ledger.get('DENIED'),
      previewPresented: isPreviewPresented(),
      cameraEverOpened: this.cameraEverOpened,
      cameraEndedUnexpectedly: this.cameraEndedUnexpectedly,
    });

    this.applyPhase(PHASE1, this.phase1Results, (verdict, reason) =>
      this.buildPhase1Evidence(verdict, reason),
    );
  }

  private buildPhase1Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE1,
      phaseName: PHASE_NAMES[PHASE1] ?? 'Camera Capture',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase1Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        frames: this.monitor.describe(),
        scenarioLedger: this.ledger.describe(),
        devEntry: this.phase1DevEntry,
        previewPresented: isPreviewPresented(),
      },
    });
    this.phase1Bundle = this.keepBundle(PHASE1, built);
  }

  /**
   * The camera track ended on its own — another app took it, or the OS revoked access.
   *
   * Handled centrally because both Phase 1 and Phase 2 hold the same camera, and each has
   * something different to shut down. The flag itself is shared: it records that the track
   * ended without the user asking, which is what CAM-003 and CAM-005 read.
   */
  private onCameraEnded(reason: string): void {
    this.cameraEndedUnexpectedly = true;
    logger.error(
      this.screen === 'phase6'
        ? PHASE6
        : this.screen === 'phase5'
        ? PHASE5
        : this.screen === 'phase4'
        ? PHASE4
        : this.screen === 'phase3'
          ? PHASE3
          : this.screen === 'phase2'
            ? PHASE2
            : PHASE1,
      'CameraSource',
      `camera track ended: ${reason}`,
      'the preview is removed and the state reported as CAMERA_ENDED; no last frame is ' +
        'left on screen',
    );
    if (this.screen === 'phase6') this.onStopPhase6(reason);
    else if (this.screen === 'phase5') this.onStopPhase5(reason);
    else if (this.screen === 'phase4') this.onStopPhase4(reason);
    else if (this.screen === 'phase3') this.onStopPhase3(reason);
    else if (this.screen === 'phase2') this.onStopPipeline(reason);
    else this.onStopCamera(reason);
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 2 — Frame Pipeline                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Enter the PIPELINE screen.
   *
   * Same gate as Phase 1, one phase along: Phase Lock must have opened, which on a device
   * means Phase 1 really passed in this session. `devOverride` exists for the automated
   * desktop leg, is gated on the DESKTOP_DEV leg, and is recorded in the bundle — and a
   * DESKTOP_DEV bundle cannot pass a phase regardless (Rule 004).
   */
  private enterPhase2(devOverride = false): boolean {
    if (!this.registry.canEnter(PHASE2)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE2, 'App', 'refused entry to Phase 2', {
          reason: this.registry.blockedReason(PHASE2),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase2DevEntry = true;
      logger.warn(PHASE2, 'App', 'Phase 2 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 1's monitor and Phase 2's pipeline would otherwise both be driving frame
    // callbacks on the same element. Phase 1's measurements are already made and are not
    // reset by stopping it.
    this.stopPhase1Ticking();
    this.monitor.stop();
    this.screen = 'phase2';
    if (this.registry.get(PHASE2).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE2, PhaseState.IMPLEMENTING, 'PIPELINE screen opened');
    }
    this.evaluatePhase2();
    this.render();
    return true;
  }

  private leavePhase2(): void {
    this.onStopPipeline('left the PIPELINE screen');
    this.screen = 'phase1';
    this.render();
  }

  /** MUST be reached from the click handler: getUserMedia needs the user gesture. */
  private async onStartPipeline(): Promise<void> {
    if (this.cameraOpening || this.pipeline.isRunning()) return;
    const video = getPreviewVideo();

    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE2, 'CameraSource', `the pipeline could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and the pipeline does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase2();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      this.ledger.observe(
        'GRANTED',
        `${result.settings?.width}x${result.settings?.height} @ ` +
          `${result.settings?.frameRate}fps, opened for the Phase 2 pipeline`,
      );
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE2, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and the pipeline still starts; if no frames arrive, ' +
            'FRAME-001 fails rather than the stall being hidden',
          err,
        );
      }
    }

    if (this.pipeline.start(video)) {
      this.pipelineEverStarted = true;
      this.stressRefusal = null;
      this.startPhase2Ticking();
    }
    this.evaluatePhase2();
    this.render();
  }

  private onStopPipeline(reason: string): void {
    this.stopPhase2Ticking();
    this.pipeline.stop(reason);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase2();
    this.render();
  }

  private onToggleStress(): void {
    this.stressRefusal = this.pipeline.setStress(!this.pipeline.isStressed());
    this.evaluatePhase2();
    this.render();
  }

  private startPhase2Ticking(): void {
    this.startTicking(PHASE2, PHASE2_TICK_MS, () => {
      this.evaluatePhase2();
      this.render();
    });
  }

  private stopPhase2Ticking(): void {
    this.stopTicking(PHASE2);
  }

  private evaluatePhase2(): void {
    this.phase2Results = runPhase2Tests({
      cameraState: this.camera.getState(),
      cameraEverOpened: this.cameraEverOpened,
      pipelineEverStarted: this.pipelineEverStarted,
      stats: this.pipeline.getStats(),
    });

    this.applyPhase(PHASE2, this.phase2Results, (verdict, reason) =>
      this.buildPhase2Evidence(verdict, reason),
    );
  }

  private buildPhase2Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE2,
      phaseName: PHASE_NAMES[PHASE2] ?? 'Frame Pipeline',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase2Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        devEntry: this.phase2DevEntry,
        previewPresented: isPreviewPresented(),
      },
    });
    this.phase2Bundle = this.keepBundle(PHASE2, built);
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 3 — Feature Detection                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * One frame's detection result, arriving through the pipeline's opaque seam.
   *
   * Narrowed rather than cast: the pipeline forwards whatever the worker attached, and a
   * payload that is not a Phase 3 result is dropped and counted rather than assumed.
   */
  private onTracking(payload: unknown): void {
    const result = asTrackingResult(payload);
    if (!result) return;
    // A Phase 4 frame carries `flow`; a Phase 3 frame does not. They are accumulated by
    // different sessions rather than one: Phase 3's statistics describe a detector run
    // independently on every frame, and folding Phase 4's refill-only detections into them
    // would quietly change what the committed Phase 3 evidence means.
    const now = performance.now();
    if (result.flow) this.flow.record(result, now);
    else this.features.record(result);
    // Phase 5's frame rides on the same message as Phase 4's, because they describe one frame.
    // It is accumulated by its own session for the same reason Phase 4's is separate from
    // Phase 3's: folding it in would change what the committed Phase 4 evidence means.
    if (result.verification) this.verification.record(result, now);
    if (result.pose) this.pose.record(result, now);
    // Phase 7 is driven from here rather than from its tick, because `propagatedMs` is measured
    // from the last frame vision produced a pose and a 500 ms tick could not see the gaps
    // between them. `notePose` filters NO_POSE frames itself, so every frame reaches the stage
    // and only the ones that recovered something advance the visual clock.
    if (this.isFusing() && result.pose) {
      this.fusionStage.notePose(result.pose, result.verification?.reAnchored ?? false, now);
      this.fusion.record(this.fusionStage.report(now, result.pose), now);
    }
    // Phase 8's decision is taken in the worker, where the population is. What arrives here is
    // the decision and the inputs it was taken from, so the session can re-derive it.
    if (result.keyframe) this.keyframes.record(result.keyframe);
    if (result.overlay) {
      this.lastOverlay = new Float32Array(result.overlay);
      this.lastOverlayWidth = result.detectWidth * 2 ** result.detectLevel;
      this.lastOverlayHeight = result.detectHeight * 2 ** result.detectLevel;
    }
    this.lastOverlayAge = result.flowAge ? new Uint16Array(result.flowAge) : null;
  }

  /**
   * Whether anything is actually detecting.
   *
   * Rule 002: the screen, the tests and the evidence all read this one function, so the
   * control cannot say DETECTING while the engine detects nothing. It takes both halves —
   * detection asked for, and a pipeline running to serve it — because in Phase 3 they come
   * apart: the pipeline is inherited from Phase 2 and is running before detection starts.
   */
  /**
   * Measure whether the overlay is drawing on the picture the camera is showing.
   *
   * The main thread takes its *own* reading of the video element — the same independent-read
   * idea as Phase 2's provenance cross-check — and scores the detected positions against it
   * under each candidate transform. Phase 2's check compares means, which a rotation leaves
   * untouched; this compares positions, which it does not.
   *
   * When the reading says another transform fits the image better, the buffer the worker
   * measured is not the picture on screen. The overlay is not corrected to compensate: the
   * same positions go to Phase 4, so a corrected drawing over rotated data would be a lie
   * with a working-looking screen. The acquisition route is abandoned instead, and the
   * ladder's next rung is defined on what the element displays rather than on what the
   * sensor produced.
   */
  private probeAlignment(): void {
    const points = this.lastOverlay;
    if (!points || this.lastOverlayWidth < 1 || this.lastOverlayHeight < 1) return;
    const video = getPreviewVideo();
    if (video.videoWidth < 8 || video.videoHeight < 8) return;

    // Small: this runs on the UI thread, and the statistic needs structure, not resolution.
    const w = 160;
    const h = Math.max(8, Math.round((w * video.videoHeight) / video.videoWidth));
    let canvas = this.alignmentCanvas;
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.alignmentCanvas = canvas;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, w, h);
    } catch {
      // The element is not painting yet. Nothing to measure, and nothing to report.
      return;
    }
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = (rgba[i * 4] ?? 0) * 0.299 + (rgba[i * 4 + 1] ?? 0) * 0.587 +
        (rgba[i * 4 + 2] ?? 0) * 0.114;
    }

    // The overlay buffer is (x, y, quality) triples; the probe wants (x, y) pairs.
    const xy: number[] = [];
    for (let i = 0; i < points.length; i += 3) {
      xy.push(points[i] ?? 0, points[i + 1] ?? 0);
    }
    const reading = scoreAlignment(
      gray, w, h, xy, this.lastOverlayWidth, this.lastOverlayHeight,
      () => this.alignmentRng.next(),
    );
    if (!reading) return;
    this.alignment = reading;

    if (isMisoriented(reading)) {
      this.misorientedProbes++;
      // Three in a row, so one blurred or moving frame cannot condemn a working route.
      if (this.misorientedProbes >= 3 && this.routeRejectedForOrientation === null) {
        const reason =
          `the acquired buffer matches the video under ${reading.best} rather than ` +
          `identity (${reading.bestOverIdentity.toFixed(2)}x), so the frames the worker ` +
          'measured are not oriented like the picture on screen';
        this.routeRejectedForOrientation = reading.best;
        logger.error(
          PHASE3, 'OverlayAlignment', 'the acquisition route produced a misoriented buffer',
          'the route is abandoned and the next rung, which is defined on what the video ' +
            'element displays, is tried; the overlay is not corrected because Phase 4 ' +
            'consumes the same positions',
          undefined,
          { best: reading.best, scores: reading.scores, samples: reading.samples },
        );
        this.pipeline.rejectRoute(reason);
      }
    } else {
      this.misorientedProbes = 0;
    }
  }

  private isDetecting(): boolean {
    return this.trackingRequested && this.pipeline.isRunning();
  }

  /**
   * What the tracking stage is asked to do on the next frames.
   *
   * The contrast check and the paired grid control each cost an extra pass, so they are
   * sampled rather than run every frame — the same reasoning as Phase 2's 1 Hz cross-check.
   * The level-0 calibration is requested once and the worker ignores it thereafter.
   */
  private trackingOptions(): TrackingOptions {
    this.trackingFrames++;
    const sample = this.trackingFrames % PHASE3_SAMPLE_EVERY === 0;
    return {
      ...DEFAULT_TRACKING_OPTIONS,
      detect: true,
      track: false,
      wantContrast: sample,
      wantGridComparison: sample,
      wantLevel0Calibration: this.features.getLevel0Calibration() === null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 4 — Optical Flow Tracking                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether anything is actually tracking.
   *
   * §H.5, in one function: Phase 4's own state (`flowRequested`) AND a pipeline running to
   * serve it. Both halves are needed and neither is a substitute for the other — the pipeline
   * and Phase 3's detection are both already running when this screen opens, so a predicate
   * built from either of them says "tracking" before tracking has started, and a control
   * built from that predicate cannot be pressed at all. The screen, the tests and the
   * evidence all read this and nothing else.
   */
  private isTracking(): boolean {
    return this.flowRequested && this.pipeline.isRunning();
  }

  /**
   * What the tracking stage is asked to do while Phase 4 is running.
   *
   * `track: true` is the difference, and it changes what `detect` means in the worker:
   * detection stops running every frame and becomes §11's refill, asked for only when the
   * tracked population has fallen. The contrast and grid samples are Phase 3's measurements
   * of a detector, not of a tracker, and they are not requested here — they would cost a
   * second selection on a frame whose budget already carries the LK solve.
   */
  private flowOptions(): TrackingOptions {
    return {
      ...DEFAULT_TRACKING_OPTIONS,
      detect: true,
      track: true,
      wantContrast: false,
      wantGridComparison: false,
      wantLevel0Calibration: false,
      recordSamples: 12,
    };
  }

  /** Enter the TRACKING screen. Same gate as the phases before it (Rule 005), one along. */
  private enterPhase4(devOverride = false): boolean {
    if (!this.registry.canEnter(PHASE4)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE4, 'App', 'refused entry to Phase 4', {
          reason: this.registry.blockedReason(PHASE4),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase4DevEntry = true;
      logger.warn(PHASE4, 'App', 'Phase 4 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 3's tick refreshes the tracking options twice a second with `track: false`. Left
    // running it would switch optical flow off again between every pair of frames.
    this.stopPhase3Ticking();
    this.screen = 'phase4';
    if (this.registry.get(PHASE4).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE4, PhaseState.IMPLEMENTING, 'TRACKING screen opened');
    }
    this.evaluatePhase4();
    this.render();
    return true;
  }

  private leavePhase4(): void {
    this.onStopPhase4('left the TRACKING screen');
    this.screen = 'phase3';
    this.render();
  }

  /** Enter the GEOMETRIC VERIFICATION screen. Same gate as the phases before it (Rule 005). */
  private enterPhase5(devOverride = false): boolean {
    if (!isPhaseImplemented(PHASE5)) {
      logger.warn(PHASE5, 'App', 'refused entry to Phase 5', {
        reason: 'Phase 5 has not been written in this build',
      });
      return false;
    }
    if (!this.registry.canEnter(PHASE5)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE5, 'App', 'refused entry to Phase 5', {
          reason: this.registry.blockedReason(PHASE5),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase5DevEntry = true;
      logger.warn(PHASE5, 'App', 'Phase 5 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 4's tick refreshes the tracking options twice a second with `verify: false`. Left
    // running it would switch verification off again between every pair of frames — the exact
    // shape of the bug Phase 4's own entry had to fix against Phase 3's tick.
    this.stopPhase4Ticking();
    this.screen = 'phase5';
    if (this.registry.get(PHASE5).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE5, PhaseState.IMPLEMENTING, 'GEOMETRIC VERIFICATION screen opened');
    }
    this.evaluatePhase5();
    this.render();
    return true;
  }

  /**
   * MUST be reached from the click handler: `getUserMedia` and `DeviceMotionEvent.requestPermission`
   * both need the user gesture, and the gyroscope request has to be the first thing that
   * happens — an `await` before it puts it outside the gesture and iOS throws.
   */
  private async onStartPhase4(): Promise<void> {
    if (this.cameraOpening || this.flowRequested) return;

    // First, synchronously, inside the gesture. FLOW-003 needs the device's own rotation as a
    // second independent instrument; without it the test reports PENDING with the reason
    // rather than being judged, so a refusal here degrades the phase honestly.
    void this.rotation
      .start((reading) => this.flow.noteRotation({ at: reading.at, degPerSecond: reading.degPerSecond }))
      .then((source) => {
        if (!this.rotation.isLive()) this.flow.noteGyroUnavailable(this.rotation.getDetail());
        logger.info(PHASE4, 'RotationRateMonitor', `gyroscope: ${source}`, {
          detail: this.rotation.getDetail(),
        });
      });

    const video = getPreviewVideo();
    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE4, 'CameraSource', `tracking could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and tracking does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase4();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE4, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and tracking still starts; if no frames arrive the ' +
            'tests stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    // §H.5: the machinery below is inherited live and is adopted, not restarted — and what is
    // adopted is brought to a defined state. Phase 3 hands over a running pipeline and a
    // running detector; Phase 2's injected load must not be running under a measurement of
    // the tracker, for the same reason it must not run under a measurement of the detector.
    const adopted = this.pipeline.isRunning();
    if (adopted) {
      if (this.pipeline.isStressed()) {
        this.pipeline.setStress(false);
        logger.info(PHASE4, 'App', 'injected load turned off for tracking', {
          why: 'stress moves the tier, and the tier sets the resolution the flow is solved at',
        });
      }
      logger.info(PHASE4, 'App', 'adopted the running Phase 3 pipeline', {
        note: 'the camera, worker and detected population stay as they are; only the ' +
          'tracking options change',
      });
    }

    this.pipeline.setTrackingOptions(this.flowOptions());
    if (adopted || this.pipeline.start(video)) {
      this.flowRequested = true;
      this.pipelineEverStarted = true;
      this.flowEverRan = true;
      this.startPhase4Ticking();
    } else {
      // Nothing will consume the options. Take them back rather than leaving a request
      // standing that no worker will ever see.
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase4();
    this.render();
  }

  private onStopPhase4(reason: string): void {
    this.stopPhase4Ticking();
    this.flowRequested = false;
    this.rotation.stop();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase4();
    this.render();
  }

  private startPhase4Ticking(): void {
    this.startTicking(PHASE4, PHASE4_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.flowOptions());
      // Carried over from Phase 3 deliberately (§H.5): Phase 4 measures displacements in the
      // acquired buffer's frame, so a buffer rotated against the screen makes every number on
      // this screen wrong in a way no average can see (§H.7).
      this.probeAlignment();
      this.evaluatePhase4();
      this.render();
    });
  }

  private stopPhase4Ticking(): void {
    this.stopTicking(PHASE4);
  }

  private evaluatePhase4(): void {
    this.phase4Results = runPhase4Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      trackingEverRan: this.flowEverRan,
      stats: this.flow.stats(this.isTracking()),
    });

    this.applyPhase(PHASE4, this.phase4Results, (verdict, reason) =>
      this.buildPhase4Evidence(verdict, reason),
    );
  }

  private buildPhase4Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE4,
      phaseName: PHASE_NAMES[PHASE4] ?? 'Optical Flow Tracking',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase4Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        flow: this.flow.describe(),
        rotation: toJsonSafe(this.rotation.describe()) as JsonValue,
        devEntry: this.phase4DevEntry,
        previewPresented: isPreviewPresented(),
        overlayAlignment: this.alignment
          ? {
              ...this.alignment,
              scores: { ...this.alignment.scores },
              routeRejectedFor: this.routeRejectedForOrientation,
              minIdentityOverRandom: MIN_IDENTITY_OVER_RANDOM,
              note:
                'Carried into Phase 4 from Phase 3 because Phase 4 consumes the same ' +
                'positions: every displacement in this bundle is measured in the acquired ' +
                'buffer\'s frame, so a buffer rotated against the video makes them all wrong ' +
                'while every average-based check still passes (§H.7).',
            }
          : null,
      },
    });
    this.phase4Bundle = this.keepBundle(PHASE4, built);
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 6 — Relative Pose                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether anything is actually recovering a pose.
   *
   * §H.5 for the fourth time. Five stages are already live when this screen opens — camera,
   * pipeline, detector, tracker, verifier — so a predicate assembled from any of them says
   * "recovering" before recovery has started, and the control built from it cannot be pressed.
   * The screen, the tests and the evidence read this and nothing else.
   */
  private isPosing(): boolean {
    return this.poseRequested && this.pipeline.isRunning();
  }

  /**
   * What the tracking stage is asked to do while Phase 6 is running.
   *
   * `pose: true` on top of Phase 5's whole configuration, unchanged. Phase 6 decomposes the
   * model Phase 5 selected on that frame, so changing the verifier's parameters here would mean
   * the pose belongs to a geometry the screen never showed.
   *
   * The two injections are sampled on **different frames**. Each costs a second full fit, and
   * running both on the same frame would put two extra RANSAC passes inside one frame's budget
   * — which is the budget POSE-006 is measuring. Offsetting them by one keeps each measurement
   * out of the other's cost.
   */
  private poseOptions(): TrackingOptions {
    this.poseFrames++;
    return {
      ...this.verifyOptions(),
      pose: true,
      wantPoseInjection: this.poseFrames % POSE_INJECTION_SAMPLE_EVERY === 1,
    };
  }

  /**
   * MUST be reached from the click handler: the camera needs the user gesture, and the
   * gyroscope's permission request has to be the first thing that happens — an `await` before
   * it puts it outside the gesture and iOS throws.
   */
  private async onStartPhase6(): Promise<void> {
    if (this.cameraOpening || this.poseRequested) return;

    // First, synchronously, inside the gesture. POSE-002 is the instrument this phase is scored
    // against; without it the test reports PENDING with the reason and the phase cannot pass, so
    // a refusal here degrades the phase honestly rather than hiding it.
    void this.rotation
      .start((reading) => {
        this.flow.noteRotation({ at: reading.at, degPerSecond: reading.degPerSecond });
        // Phase 6 needs the rotation *vector*, not its magnitude: a phone turned 10° and back
        // has a path of 20° and a net rotation of 0°, and a two-view pose can only report net.
        this.pose.noteGyro({
          at: reading.at,
          x: reading.beta,
          y: reading.gamma,
          z: reading.alpha,
        });
      })
      .then((source) => {
        if (!this.rotation.isLive()) {
          const detail = this.rotation.getDetail();
          this.flow.noteGyroUnavailable(detail);
          this.pose.noteGyroUnavailable(detail);
        }
        logger.info(PHASE6, 'RotationRateMonitor', `gyroscope: ${source}`, {
          detail: this.rotation.getDetail(),
          why: 'POSE-002 compares the recovered rotation against this and nothing else reads it',
        });
      });

    const video = getPreviewVideo();
    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE6, 'CameraSource', `pose recovery could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and pose recovery does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase6();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE6, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and pose recovery still starts; if no frames arrive the ' +
            'tests stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    const adopted = this.pipeline.isRunning();
    if (adopted) {
      if (this.pipeline.isStressed()) {
        this.pipeline.setStress(false);
        logger.info(PHASE6, 'App', 'injected load turned off for pose recovery', {
          why: 'stress moves the tier, the tier sets the frame size, and §H.0 makes K a function ' +
            'of the frame size — so a tier step mid-measurement changes the intrinsics',
        });
      }
      logger.info(PHASE6, 'App', 'adopted the running Phase 5 verifier', {
        note: 'the camera, worker, population and verification anchor stay as they are; only ' +
          'the tracking options change. Phase 6 decomposes the model Phase 5 selected',
      });
    }

    this.pipeline.setTrackingOptions(this.poseOptions());
    if (adopted || this.pipeline.start(video)) {
      this.poseRequested = true;
      this.verifyRequested = true;
      this.flowRequested = true;
      this.pipelineEverStarted = true;
      this.flowEverRan = true;
      this.verifyEverRan = true;
      this.poseEverRan = true;
      this.startPhase6Ticking();
    } else {
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase6();
    this.render();
  }

  private onStopPhase6(reason: string): void {
    this.stopPhase6Ticking();
    this.poseRequested = false;
    this.verifyRequested = false;
    this.flowRequested = false;
    this.rotation.stop();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase6();
    this.render();
  }

  private leavePhase6(): void {
    this.onStopPhase6('left the RELATIVE POSE screen');
    this.screen = 'phase5';
    this.render();
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 7 — IMU Support / Fusion                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether anything is actually fusing.
   *
   * §H.5 for the fifth time, and from one predicate: fusion asked for AND a pipeline running to
   * serve it. Six stages are already live when this screen opens — camera, pipeline, detector,
   * tracker, verifier, pose — so a predicate assembled from any of them says "fusing" before
   * fusion has started, and the control built from it cannot be pressed. The screen, the tests
   * and the evidence read this and nothing else.
   *
   * Note what it does **not** include: whether the IMU is delivering. A run with no sensors is
   * still fusing — it is reporting `VISION_ONLY`, which is v3 §68's own pass condition, and
   * gating the predicate on the IMU would make IMU-002 undecidable by making its own case look
   * like "not started".
   */
  private isFusing(): boolean {
    return this.fusionRequested && this.pipeline.isRunning();
  }

  /** Enter the IMU SUPPORT / FUSION screen. Same gate as the phases before it (Rule 005). */
  private enterPhase7(devOverride = false): boolean {
    if (!isPhaseImplemented(PHASE7)) {
      logger.warn(PHASE7, 'App', 'refused entry to Phase 7', {
        reason: 'Phase 7 has not been written in this build',
      });
      return false;
    }
    if (!this.registry.canEnter(PHASE7)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE7, 'App', 'refused entry to Phase 7', {
          reason: this.registry.blockedReason(PHASE7),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase7DevEntry = true;
      logger.warn(PHASE7, 'App', 'Phase 7 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 6's tick refreshes the tracking options twice a second; left running it would keep
    // resetting the injection schedule under Phase 7's feet.
    this.stopPhase6Ticking();
    this.screen = 'phase7';
    if (this.registry.get(PHASE7).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE7, PhaseState.IMPLEMENTING, 'IMU SUPPORT / FUSION screen opened');
    }
    this.evaluatePhase7();
    this.render();
    return true;
  }

  /**
   * MUST be reached from the click handler: the motion permission has to be requested inside
   * the user's gesture, and an `await` before it puts it outside and iOS throws.
   *
   * The camera is normally already open — this screen is reached from Phase 6's, which cannot
   * pass without it — so the usual path here is: ask for motion, adopt the running pipeline,
   * start fusing. A refusal of the motion permission is not a failure of this method: the run
   * continues on vision alone, and that is the case v3 §68 asks this phase to handle.
   */
  private async onStartPhase7(): Promise<void> {
    if (this.cameraOpening || this.fusionRequested) return;

    this.fusionStage.reset();
    this.fusion.reset();

    // First, synchronously, inside the gesture. `RotationRateMonitor` already owns the one
    // listener and the one permission call; Phase 7 takes the second callback rather than
    // attaching a listener of its own — two `requestPermission()` calls in one gesture is a
    // second prompt on some builds and a rejection on others.
    void this.rotation
      .start(
        (reading) => {
          this.flow.noteRotation({ at: reading.at, degPerSecond: reading.degPerSecond });
          this.pose.noteGyro({
            at: reading.at,
            x: reading.beta,
            y: reading.gamma,
            z: reading.alpha,
          });
        },
        (sample) => {
          this.fusionStage.noteImu(sample);
          this.fusion.noteImu(sample);
        },
      )
      .then((source) => {
        if (!this.rotation.isLive()) {
          const detail = this.rotation.getDetail();
          this.flow.noteGyroUnavailable(detail);
          this.pose.noteGyroUnavailable(detail);
          this.fusion.noteImuUnavailable(detail);
        }
        logger.info(PHASE7, 'RotationRateMonitor', `motion sensors: ${source}`, {
          detail: this.rotation.getDetail(),
          why: 'IMU-002 is decided on what actually arrives, and v3 §68 asks for the run to ' +
            'continue when nothing does',
        });
        this.evaluatePhase7();
        this.render();
      });

    const video = getPreviewVideo();
    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE7, 'CameraSource', `fusion could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and fusion does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase7();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE7, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and fusion still starts; if no frames arrive the tests ' +
            'stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    const adopted = this.pipeline.isRunning();
    if (adopted) {
      logger.info(PHASE7, 'App', 'adopted the running Phase 6 pose recovery', {
        note: 'the camera, worker, population, anchor and pose options stay as they are. ' +
          'Phase 7 fuses the poses Phase 6 recovers and changes nothing about how they are ' +
          'recovered — editing the solver here would mean fusing a pose Phase 6 never passed with',
      });
    }

    this.pipeline.setTrackingOptions(this.poseOptions());
    if (adopted || this.pipeline.start(video)) {
      this.fusionRequested = true;
      this.poseRequested = true;
      this.verifyRequested = true;
      this.flowRequested = true;
      this.pipelineEverStarted = true;
      this.flowEverRan = true;
      this.verifyEverRan = true;
      this.poseEverRan = true;
      this.fusionEverRan = true;
      this.startPhase7Ticking();
    } else {
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase7();
    this.render();
  }

  private onStopPhase7(reason: string): void {
    this.stopPhase7Ticking();
    this.fusionRequested = false;
    this.poseRequested = false;
    this.verifyRequested = false;
    this.flowRequested = false;
    this.rotation.stop();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase7();
    this.render();
  }

  private leavePhase7(): void {
    this.onStopPhase7('left the IMU SUPPORT / FUSION screen');
    this.screen = 'phase6';
    this.render();
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 8 — Keyframe System                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether the keyframe store is actually running.
   *
   * §H.5 for the sixth time, and from one predicate: the store asked for AND a pipeline running
   * to serve it. Seven stages are already live when this screen opens, so a predicate assembled
   * from any of them says "keeping" before the store has been started, and the control built
   * from it cannot be pressed.
   */
  private isKeepingKeyframes(): boolean {
    return this.keyframesRequested && this.pipeline.isRunning();
  }

  /**
   * What the tracking stage is asked to do while Phase 8 is running.
   *
   * `keyframes: true` on top of Phase 6's whole configuration, unchanged — including the two
   * injections, which keep running because Phase 8's decisions are taken from the pose and the
   * verification those injections are measuring. Turning them off here would change the numbers
   * Phase 8 is deciding on relative to the ones Phases 5 and 6 passed with.
   */
  private keyframeOptions(): TrackingOptions {
    return { ...this.poseOptions(), keyframes: true };
  }

  /** Enter the KEYFRAME SYSTEM screen. Same gate as the phases before it (Rule 005). */
  private enterPhase8(devOverride = false): boolean {
    if (!isPhaseImplemented(PHASE8)) {
      logger.warn(PHASE8, 'App', 'refused entry to Phase 8', {
        reason: 'Phase 8 has not been written in this build',
      });
      return false;
    }
    if (!this.registry.canEnter(PHASE8)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE8, 'App', 'refused entry to Phase 8', {
          reason: this.registry.blockedReason(PHASE8),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase8DevEntry = true;
      logger.warn(PHASE8, 'App', 'Phase 8 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 7's tick refreshes the tracking options twice a second; left running it would keep
    // clearing `keyframes` from under Phase 8.
    this.stopPhase7Ticking();
    this.screen = 'phase8';
    if (this.registry.get(PHASE8).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE8, PhaseState.IMPLEMENTING, 'KEYFRAME SYSTEM screen opened');
    }
    this.evaluatePhase8();
    this.render();
    return true;
  }

  /**
   * MUST be reached from the click handler: the camera needs the user gesture.
   *
   * The camera is normally already open — this screen is reached from Phase 7's, which cannot
   * pass without it. The IMU is left exactly as Phase 7 arranged it: Phase 8 consumes no
   * sensor, and re-requesting the motion permission here would be a second prompt for nothing.
   */
  private async onStartPhase8(): Promise<void> {
    if (this.cameraOpening || this.keyframesRequested) return;

    this.keyframes.reset();

    const video = getPreviewVideo();
    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE8, 'CameraSource', `the keyframe store could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and the store does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase8();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE8, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and the store still starts; if no frames arrive the tests ' +
            'stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    const adopted = this.pipeline.isRunning();
    if (adopted) {
      logger.info(PHASE8, 'App', 'adopted the running Phase 7 stack', {
        note: 'the camera, worker, population, anchor, pose options and filter stay as they ' +
          'are. Phase 8 decides which of the views Phase 6 recovers are worth keeping and ' +
          'changes nothing about how they are recovered',
      });
    }

    this.pipeline.setTrackingOptions(this.keyframeOptions());
    if (adopted || this.pipeline.start(video)) {
      this.keyframesRequested = true;
      this.poseRequested = true;
      this.verifyRequested = true;
      this.flowRequested = true;
      this.pipelineEverStarted = true;
      this.flowEverRan = true;
      this.verifyEverRan = true;
      this.poseEverRan = true;
      this.keyframesEverRan = true;
      this.startPhase8Ticking();
    } else {
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase8();
    this.render();
  }

  private onStopPhase8(reason: string): void {
    this.stopPhase8Ticking();
    this.keyframesRequested = false;
    this.poseRequested = false;
    this.verifyRequested = false;
    this.flowRequested = false;
    this.fusionRequested = false;
    this.rotation.stop();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase8();
    this.render();
  }

  private leavePhase8(): void {
    this.onStopPhase8('left the KEYFRAME SYSTEM screen');
    this.screen = 'phase7';
    this.render();
  }

  /** Phase 9 does not exist yet; the control says so and this refuses rather than pretending. */
  private enterPhase9(): boolean {
    logger.warn(PHASE9, 'App', 'refused entry to Phase 9', {
      reason: isPhaseImplemented(PHASE9)
        ? this.registry.blockedReason(PHASE9)
        : 'Phase 9 has not been written in this build',
    });
    return false;
  }

  private startPhase8Ticking(): void {
    this.startTicking(PHASE8, PHASE8_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.keyframeOptions());
      this.probeAlignment();
      this.evaluatePhase8();
      this.render();
    });
  }

  private stopPhase8Ticking(): void {
    this.stopTicking(PHASE8);
  }

  private evaluatePhase8(): void {
    this.phase8Results = runPhase8Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      keyframesEverRan: this.keyframesEverRan,
      stats: this.keyframes.stats(this.isKeepingKeyframes()),
    });

    this.applyPhase(PHASE8, this.phase8Results, (verdict, reason) =>
      this.buildPhase8Evidence(verdict, reason),
    );
  }

  private buildPhase8Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE8,
      phaseName: PHASE_NAMES[PHASE8] ?? 'Keyframe System',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase8Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        // Phases 4, 5, 6 and 7 travel in the Phase 8 bundle because Phase 8's inputs are their
        // outputs: a keyframe decision means nothing without the pose it was taken on and the
        // verified model that pose was decomposed from.
        flow: this.flow.describe(),
        verification: this.verification.describe(),
        pose: this.pose.describe(),
        fusion: this.fusion.describe(),
        keyframes: this.keyframes.describe(),
        devEntry: this.phase8DevEntry,
        previewPresented: isPreviewPresented(),
      },
    });
    this.phase8Bundle = this.keepBundle(PHASE8, built);
  }


  private startPhase7Ticking(): void {
    this.startTicking(PHASE7, PHASE7_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.poseOptions());
      this.probeAlignment();
      // A frame with no tracking result still advances the propagation clock, so the report is
      // refreshed here as well as from `onTracking`: a run where the worker has stopped
      // answering is exactly the dropout IMU-007 is about, and it must not freeze the screen at
      // the last frame that worked.
      if (this.isFusing()) {
        const now = performance.now();
        this.fusion.record(this.fusionStage.report(now, this.pose.getLast()), now);
      }
      this.evaluatePhase7();
      this.render();
    });
  }

  private stopPhase7Ticking(): void {
    this.stopTicking(PHASE7);
  }

  private evaluatePhase7(): void {
    this.phase7Results = runPhase7Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      fusionEverRan: this.fusionEverRan,
      stats: this.fusion.stats(this.isFusing()),
    });

    this.applyPhase(PHASE7, this.phase7Results, (verdict, reason) =>
      this.buildPhase7Evidence(verdict, reason),
    );
  }

  private buildPhase7Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE7,
      phaseName: PHASE_NAMES[PHASE7] ?? 'IMU Support / Fusion',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase7Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        // Phases 4, 5 and 6 travel in the Phase 7 bundle because Phase 7's input is their
        // output: a fused orientation means nothing without the visual pose it corrected and
        // the verified model that pose was decomposed from.
        flow: this.flow.describe(),
        verification: this.verification.describe(),
        pose: this.pose.describe(),
        fusion: this.fusion.describe(),
        rotation: toJsonSafe(this.rotation.describe()) as JsonValue,
        devEntry: this.phase7DevEntry,
        previewPresented: isPreviewPresented(),
      },
    });
    this.phase7Bundle = this.keepBundle(PHASE7, built);
  }

  private startPhase6Ticking(): void {
    this.startTicking(PHASE6, PHASE6_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.poseOptions());
      this.probeAlignment();
      this.evaluatePhase6();
      this.render();
    });
  }

  private stopPhase6Ticking(): void {
    this.stopTicking(PHASE6);
  }

  private evaluatePhase6(): void {
    this.phase6Results = runPhase6Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      poseEverRan: this.poseEverRan,
      stats: this.pose.stats(this.isPosing()),
      // §H budgets RANSAC and pose recovery as one line, so POSE-006 reads Phase 5's cost too.
      verifyMs: this.verification.stats(this.isPosing()).meanVerifyMs,
    });

    this.applyPhase(PHASE6, this.phase6Results, (verdict, reason) =>
      this.buildPhase6Evidence(verdict, reason),
    );
  }

  private buildPhase6Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE6,
      phaseName: PHASE_NAMES[PHASE6] ?? 'Relative Pose',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase6Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        // Phases 4 and 5 travel in the Phase 6 bundle because Phase 6's inputs are their
        // outputs: a rotation means nothing without the correspondences and the verified model
        // it was decomposed from.
        flow: this.flow.describe(),
        verification: this.verification.describe(),
        pose: this.pose.describe(),
        rotation: toJsonSafe(this.rotation.describe()) as JsonValue,
        devEntry: this.phase6DevEntry,
        previewPresented: isPreviewPresented(),
        overlayAlignment: this.alignment
          ? {
              ...this.alignment,
              scores: { ...this.alignment.scores },
              routeRejectedFor: this.routeRejectedForOrientation,
              minIdentityOverRandom: MIN_IDENTITY_OVER_RANDOM,
              note:
                'Carried into Phase 6 from Phase 3. It binds hardest here: the pose is ' +
                'recovered from correspondences expressed in the acquired buffer\'s frame and ' +
                'K is derived from that buffer\'s dimensions, so a buffer rotated against the ' +
                'video would make the recovered rotation a rotation of the wrong thing — while ' +
                'every count-based criterion in the phase still passes (§H.7).',
            }
          : null,
      },
    });
    this.phase6Bundle = this.keepBundle(PHASE6, built);
  }

  /* ---------------------------------------------------------------------- */
  /* Phase 5 — Geometric Verification                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Whether anything is actually verifying.
   *
   * §H.5 for the third time: Phase 5's own state (`verifyRequested`) AND a pipeline running
   * to serve it. Everything below Phase 5 is already live when this screen opens — the
   * camera, the worker, detection and the optical flow — so a predicate assembled from any of
   * them says "verifying" before verification has started, and a control built from that
   * predicate cannot be pressed at all. The screen, the tests and the evidence read this and
   * nothing else.
   */
  private isVerifying(): boolean {
    return this.verifyRequested && this.pipeline.isRunning();
  }

  /**
   * What the tracking stage is asked to do while Phase 5 is running.
   *
   * `verify: true` is the difference, and Phase 4's whole configuration is kept underneath it
   * unchanged: Phase 5 verifies the population Phase 4 tracks, so changing the tracker's
   * parameters here would mean the correspondences being verified are not the ones Phase 4
   * passed with.
   *
   * `wantInjection` is sampled rather than set on every frame. GEO-003 costs a second full
   * RANSAC pass, and running it every frame would put the cost of the measurement inside
   * GEO-005's measurement of the cost — the same reasoning as Phase 2's 1 Hz cross-check and
   * Phase 3's sampled contrast check.
   */
  private verifyOptions(): TrackingOptions {
    this.verifyFrames++;
    return {
      ...this.flowOptions(),
      verify: true,
      wantInjection: this.verifyFrames % INJECTION_SAMPLE_EVERY === 0,
    };
  }

  /**
   * MUST be reached from the click handler, for the same reason Phase 4's is: `getUserMedia`
   * needs the user gesture. In practice the camera is already live — Phase 5 is reached from a
   * running TRACKING screen — but the path where it is not has to work, because a reload on
   * this screen is a normal thing for an operator to do.
   */
  private async onStartPhase5(): Promise<void> {
    if (this.cameraOpening || this.verifyRequested) return;

    const video = getPreviewVideo();
    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE5, 'CameraSource', `verification could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and verification does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase5();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE5, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and verification still starts; if no frames arrive the ' +
            'tests stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    // §H.5: adopted, not restarted — and what is adopted is brought to a defined state, for
    // the same reason as in Phase 4. Injected load moves the tier, the tier sets the
    // resolution the flow is solved at, and the flow produces the correspondences being
    // verified here.
    const adopted = this.pipeline.isRunning();
    if (adopted) {
      if (this.pipeline.isStressed()) {
        this.pipeline.setStress(false);
        logger.info(PHASE5, 'App', 'injected load turned off for verification', {
          why: 'stress moves the tier, and the tier sets the scale every baseline is measured in',
        });
      }
      logger.info(PHASE5, 'App', 'adopted the running Phase 4 tracker', {
        note: 'the camera, worker and tracked population stay as they are; only the tracking ' +
          'options change. Phase 5 verifies the population Phase 4 passed with, not a new one',
      });
    }

    this.pipeline.setTrackingOptions(this.verifyOptions());
    if (adopted || this.pipeline.start(video)) {
      this.verifyRequested = true;
      this.flowRequested = true;
      this.pipelineEverStarted = true;
      this.flowEverRan = true;
      this.verifyEverRan = true;
      this.startPhase5Ticking();
    } else {
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase5();
    this.render();
  }

  private onStopPhase5(reason: string): void {
    this.stopPhase5Ticking();
    this.verifyRequested = false;
    this.flowRequested = false;
    this.rotation.stop();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase5();
    this.render();
  }

  private leavePhase5(): void {
    this.onStopPhase5('left the GEOMETRIC VERIFICATION screen');
    this.screen = 'phase4';
    this.render();
  }

  /** Enter the RELATIVE POSE screen. Same gate as the phases before it (Rule 005). */
  private enterPhase6(devOverride = false): boolean {
    if (!isPhaseImplemented(PHASE6)) {
      logger.warn(PHASE6, 'App', 'refused entry to Phase 6', {
        reason: 'Phase 6 has not been written in this build',
      });
      return false;
    }
    if (!this.registry.canEnter(PHASE6)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE6, 'App', 'refused entry to Phase 6', {
          reason: this.registry.blockedReason(PHASE6),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase6DevEntry = true;
      logger.warn(PHASE6, 'App', 'Phase 6 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    // Phase 5's tick refreshes the tracking options twice a second with `pose: false`; left
    // running it would switch pose recovery off again between every pair of frames.
    this.stopPhase5Ticking();
    this.screen = 'phase6';
    if (this.registry.get(PHASE6).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE6, PhaseState.IMPLEMENTING, 'RELATIVE POSE screen opened');
    }
    this.evaluatePhase6();
    this.render();
    return true;
  }

  private startPhase5Ticking(): void {
    this.startTicking(PHASE5, PHASE5_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.verifyOptions());
      // Carried over from Phases 3 and 4, and it matters more here rather than less (§H.5): a
      // correspondence is two positions in the acquired buffer's frame, so a buffer rotated
      // against the screen makes every baseline and every residual a measurement of the wrong
      // thing while every count-based check still passes (§H.7).
      this.probeAlignment();
      this.evaluatePhase5();
      this.render();
    });
  }

  private stopPhase5Ticking(): void {
    this.stopTicking(PHASE5);
  }

  private evaluatePhase5(): void {
    this.phase5Results = runPhase5Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      verificationEverRan: this.verifyEverRan,
      stats: this.verification.stats(this.isVerifying()),
    });

    this.applyPhase(PHASE5, this.phase5Results, (verdict, reason) =>
      this.buildPhase5Evidence(verdict, reason),
    );
  }

  private buildPhase5Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE5,
      phaseName: PHASE_NAMES[PHASE5] ?? 'Geometric Verification',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase5Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        // Phase 4's own record travels in the Phase 5 bundle, because Phase 5's inputs are
        // Phase 4's outputs: an inlier ratio means nothing without the population and the
        // survival rate that produced the correspondences it was computed over.
        flow: this.flow.describe(),
        verification: this.verification.describe(),
        devEntry: this.phase5DevEntry,
        previewPresented: isPreviewPresented(),
        overlayAlignment: this.alignment
          ? {
              ...this.alignment,
              scores: { ...this.alignment.scores },
              routeRejectedFor: this.routeRejectedForOrientation,
              minIdentityOverRandom: MIN_IDENTITY_OVER_RANDOM,
              note:
                'Carried into Phase 5 from Phase 3 for the same reason, and it binds harder ' +
                'here: a correspondence is two positions in the acquired buffer\'s frame, so ' +
                'a buffer rotated against the video makes every baseline and every residual ' +
                'in this bundle a measurement of the wrong thing, while every count-based ' +
                'criterion v3 §14 names still passes (§H.7).',
            }
          : null,
      },
    });
    this.phase5Bundle = this.keepBundle(PHASE5, built);
  }

  /**
   * Enter the FEATURES screen. Same gate as the phases before it (Rule 005), one along.
   */
  private enterPhase3(devOverride = false): boolean {
    if (!this.registry.canEnter(PHASE3)) {
      const desktop = this.leg?.leg === EvidenceLeg.DESKTOP_DEV;
      if (!devOverride || !desktop) {
        logger.warn(PHASE3, 'App', 'refused entry to Phase 3', {
          reason: this.registry.blockedReason(PHASE3),
          devOverrideRequested: devOverride,
          leg: this.leg?.leg ?? null,
        });
        return false;
      }
      this.phase3DevEntry = true;
      logger.warn(PHASE3, 'App', 'Phase 3 opened through the desktop development override', {
        note: 'this path is unreachable on a real device and the resulting bundle is ' +
          'DESKTOP_DEV, which cannot pass a phase',
      });
    }
    this.stopPhase2Ticking();
    this.screen = 'phase3';
    if (this.registry.get(PHASE3).state === PhaseState.NOT_STARTED) {
      this.registry.setState(PHASE3, PhaseState.IMPLEMENTING, 'FEATURES screen opened');
    }
    this.evaluatePhase3();
    this.render();
    return true;
  }

  private leavePhase3(): void {
    this.onStopPhase3('left the FEATURES screen');
    this.screen = 'phase2';
    this.render();
  }

  /** MUST be reached from the click handler: getUserMedia needs the user gesture. */
  private async onStartPhase3(): Promise<void> {
    if (this.cameraOpening || this.trackingRequested) return;
    const video = getPreviewVideo();

    if (!this.camera.isLive()) {
      this.cameraOpening = true;
      this.render();
      const result = await this.camera.open();
      this.cameraOpening = false;
      if (result.state !== CameraState.LIVE || !result.stream) {
        logger.error(
          PHASE3, 'CameraSource', `detection could not open the camera: ${result.state}`,
          result.failure?.recovery ?? 'no stream is held and detection does not start',
          undefined,
          { errorName: result.failure?.errorName ?? null },
        );
        this.evaluatePhase3();
        this.render();
        return;
      }
      this.cameraEverOpened = true;
      this.cameraEndedUnexpectedly = false;
      video.srcObject = result.stream;
      try {
        await video.play();
      } catch (err) {
        logger.error(
          PHASE3, 'CameraPreview', 'video.play() was rejected',
          'the stream stays attached and detection still starts; if no frames arrive the ' +
            'tests stay PENDING rather than the stall being hidden',
          err,
        );
      }
    }

    // Phase 2's pipeline may still be running — the user gets here from a PIPELINE screen
    // that had to stay live to pass. Adopt it rather than restarting the camera; only start
    // one if there is none. A running pipeline with no tracking options is a pipeline that
    // preprocesses and detects nothing, which is exactly the state this screen used to sit
    // in while claiming to detect.
    const adopted = this.pipeline.isRunning();
    if (adopted) {
      // Stress is Phase 2's stimulus and it inflates worker latency, which moves the tier,
      // which changes the resolution Phase 3 detects on. It does not belong in a run whose
      // numbers describe the detector.
      if (this.pipeline.isStressed()) {
        this.pipeline.setStress(false);
        logger.info(PHASE3, 'App', 'injected load turned off for detection', {
          why: 'Phase 2 stress moves the tier, and the tier sets the detection resolution',
        });
      }
      logger.info(PHASE3, 'App', 'adopted the running Phase 2 pipeline', {
        note: 'the camera and worker stay as they are; only the tracking options change',
      });
    }

    // The options are recomputed per frame by the pipeline calling back into the seam; this
    // sets the first set and the tick refreshes them.
    this.pipeline.setTrackingOptions(this.trackingOptions());
    if (adopted || this.pipeline.start(video)) {
      this.trackingRequested = true;
      this.pipelineEverStarted = true;
      this.detectionEverRan = true;
      this.startPhase3Ticking();
    } else {
      // The pipeline refused to start, so nothing will consume the options. Take them back
      // rather than leaving a request standing that no worker will ever see.
      this.pipeline.setTrackingOptions(undefined);
    }
    this.evaluatePhase3();
    this.render();
  }

  private onStopPhase3(reason: string): void {
    this.stopPhase3Ticking();
    this.trackingRequested = false;
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase3();
    this.render();
  }

  private startPhase3Ticking(): void {
    this.startTicking(PHASE3, PHASE3_TICK_MS, () => {
      this.pipeline.setTrackingOptions(this.trackingOptions());
      this.probeAlignment();
      this.evaluatePhase3();
      this.render();
    });
  }

  private stopPhase3Ticking(): void {
    this.stopTicking(PHASE3);
  }

  private evaluatePhase3(): void {
    this.phase3Results = runPhase3Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      detectionEverRan: this.detectionEverRan,
      stats: this.features.stats(this.isDetecting()),
    });

    this.applyPhase(PHASE3, this.phase3Results, (verdict, reason) =>
      this.buildPhase3Evidence(verdict, reason),
    );
  }

  private buildPhase3Evidence(verdict: PhaseState, reason: string): void {
    if (!this.matrix || !this.device) return;
    const built = buildEvidenceBundle({
      phase: PHASE3,
      phaseName: PHASE_NAMES[PHASE3] ?? 'Feature Detection',
      appVersion: APP_VERSION,
      device: this.device,
      matrix: this.matrix,
      testResults: this.phase3Results,
      overallVerdict: verdict,
      overallReason: reason,
      transitions: this.registry.getTransitions(),
      log: logger.getEntries(),
      context: {
        camera: this.camera.describe(),
        pipeline: this.pipeline.describe(),
        features: this.features.describe(),
        devEntry: this.phase3DevEntry,
        previewPresented: isPreviewPresented(),
        overlayAlignment: this.alignment
          ? {
              ...this.alignment,
              scores: { ...this.alignment.scores },
              routeRejectedFor: this.routeRejectedForOrientation,
              minIdentityOverRandom: MIN_IDENTITY_OVER_RANDOM,
              note:
                'The main thread reads the video element itself and scores the detected ' +
                'positions against it under each transform. Identity winning is the only ' +
                'result meaning the overlay and the tracking data describe the same ' +
                'picture; Phase 2\'s cross-check compares means and cannot see a rotation.',
            }
          : null,
      },
    });
    this.phase3Bundle = this.keepBundle(PHASE3, built);
  }

  /**
   * Read-only debug surface, used by the automated desktop leg to pull the same evidence a
   * human would export. It exposes state; it cannot set a verdict.
   */
  debugApi(): Record<string, unknown> {
    return {
      version: APP_VERSION,
      phase: PHASE,
      specs: PHASE0_SPECS,
      getMatrix: () => this.matrix,
      getResults: () => this.results,
      getEvidence: () => this.bundle,
      getEvidenceJson: () => (this.bundle ? serialiseEvidence(this.bundle) : null),
      getPhaseState: () => this.registry.get(PHASE),
      getPhases: () => this.registry.all(),
      getUiSnapshot: () => readUiSnapshot(),
      getIntegrityIssues: () => this.currentIntegrityIssues(),
      phase1Specs: PHASE1_SPECS,
      getScreen: () => this.screen,
      enterPhase1: (devOverride = false) => this.enterPhase1(devOverride),
      leavePhase1: () => this.leavePhase1(),
      startCamera: () => this.onStartCamera(),
      stopCamera: () => this.onStopCamera('debug API'),
      getPhase1Results: () => this.phase1Results,
      getPhase1Evidence: () => this.phase1Bundle,
      getPhase1EvidenceJson: () => (this.phase1Bundle ? serialiseEvidence(this.phase1Bundle) : null),
      getPhase1State: () => this.registry.get(PHASE1),
      getFrameStats: () => this.monitor.getStats(),
      getCamera: () => this.camera.describe(),
      phase2Specs: PHASE2_SPECS,
      enterPhase2: (devOverride = false) => this.enterPhase2(devOverride),
      leavePhase2: () => this.leavePhase2(),
      startPipeline: () => this.onStartPipeline(),
      stopPipeline: () => this.onStopPipeline('debug API'),
      setStress: (on: boolean) => {
        this.stressRefusal = this.pipeline.setStress(on);
        this.evaluatePhase2();
        this.render();
        return this.stressRefusal;
      },
      getPipelineStats: () => this.pipeline.getStats(),
      getPhase2Results: () => this.phase2Results,
      getPhase2Evidence: () => this.phase2Bundle,
      getPhase2EvidenceJson: () => (this.phase2Bundle ? serialiseEvidence(this.phase2Bundle) : null),
      getPhase2State: () => this.registry.get(PHASE2),
      phase3Specs: PHASE3_SPECS,
      enterPhase3: (devOverride = false) => this.enterPhase3(devOverride),
      leavePhase3: () => this.leavePhase3(),
      startDetection: () => this.onStartPhase3(),
      stopDetection: () => this.onStopPhase3('debug API'),
      getTrackingStats: () => this.features.stats(this.isDetecting()),
      /**
       * What the overlay would draw, in the coordinate space it draws into.
       *
       * Exposed for the alignment leg, which is the only thing that can establish that a
       * corner is drawn where the image's corner actually is: every check before it —
       * the detector's unit tests, Phase 2's mean-luma cross-check, the contrast statistic —
       * is invariant to a rotation, a flip or a transpose of the buffer.
       */
      getOverlayAlignment: () => this.alignment,
      getOverlayPositions: () => ({
        width: this.lastOverlayWidth,
        height: this.lastOverlayHeight,
        points: this.lastOverlay ? Array.from(this.lastOverlay) : [],
      }),
      getPreviewGeometry: () => {
        const v = document.getElementById('camera-preview');
        const c = document.getElementById('feature-overlay');
        const vr = v?.getBoundingClientRect() ?? null;
        const cr = c?.getBoundingClientRect() ?? null;
        return {
          video: vr ? { x: vr.x, y: vr.y, width: vr.width, height: vr.height } : null,
          videoIntrinsic:
            v instanceof HTMLVideoElement ? { width: v.videoWidth, height: v.videoHeight } : null,
          canvas: cr ? { x: cr.x, y: cr.y, width: cr.width, height: cr.height } : null,
          canvasInternal:
            c instanceof HTMLCanvasElement ? { width: c.width, height: c.height } : null,
        };
      },
      getPhase3Results: () => this.phase3Results,
      getPhase3Evidence: () => this.phase3Bundle,
      getPhase3EvidenceJson: () => (this.phase3Bundle ? serialiseEvidence(this.phase3Bundle) : null),
      getPhase3State: () => this.registry.get(PHASE3),

      phase4Specs: PHASE4_SPECS,
      enterPhase4: (devOverride = false) => this.enterPhase4(devOverride),
      leavePhase4: () => this.leavePhase4(),
      /**
       * Exposed so the leg can *read* the tracking state, never drive it.
       *
       * There is deliberately no `startTracking()` here. The automated leg presses
       * `#start-tracking` in the DOM, because reaching past the control is how Phase 3's leg
       * missed a button that had become unpressable while the engine behind it was reachable
       * (§H.5). A debug entry point for starting would put that hole straight back.
       */
      getFlowStats: () => this.flow.stats(this.isTracking()),
      getRotation: () => this.rotation.describe(),
      getPhase4Results: () => this.phase4Results,
      getPhase4Evidence: () => this.phase4Bundle,
      getPhase4EvidenceJson: () => (this.phase4Bundle ? serialiseEvidence(this.phase4Bundle) : null),
      getPhase4State: () => this.registry.get(PHASE4),

      phase5Specs: PHASE5_SPECS,
      enterPhase5: (devOverride = false) => this.enterPhase5(devOverride),
      leavePhase5: () => this.leavePhase5(),
      /**
       * Read-only, exactly as for Phase 4 and for the same reason.
       *
       * There is no `startVerification()` here either. The automated leg presses
       * `#start-verification` in the DOM, because reaching past the control is how the
       * Phase 3 leg twice certified a screen whose button could not be pressed while the
       * engine behind it answered perfectly well (§H.5).
       */
      getVerificationStats: () => this.verification.stats(this.isVerifying()),
      getPhase5Results: () => this.phase5Results,
      getPhase5Evidence: () => this.phase5Bundle,
      getPhase5EvidenceJson: () => (this.phase5Bundle ? serialiseEvidence(this.phase5Bundle) : null),
      getPhase5State: () => this.registry.get(PHASE5),

      phase6Specs: PHASE6_SPECS,
      enterPhase6: (devOverride = false) => this.enterPhase6(devOverride),
      leavePhase6: () => this.leavePhase6(),
      /** Read-only, as for Phases 4 and 5: the leg presses `#start-pose` in the DOM. */
      getPoseStats: () => this.pose.stats(this.isPosing()),
      getPhase6Results: () => this.phase6Results,
      getPhase6Evidence: () => this.phase6Bundle,
      getPhase6EvidenceJson: () => (this.phase6Bundle ? serialiseEvidence(this.phase6Bundle) : null),
      getPhase6State: () => this.registry.get(PHASE6),

      phase7Specs: PHASE7_SPECS,
      enterPhase7: (devOverride = false) => this.enterPhase7(devOverride),
      leavePhase7: () => this.leavePhase7(),
      /** Read-only, as for Phases 4, 5 and 6: the leg presses `#start-fusion` in the DOM. */
      getFusionStats: () => this.fusion.stats(this.isFusing()),
      getPhase7Results: () => this.phase7Results,
      getPhase7Evidence: () => this.phase7Bundle,
      getPhase7EvidenceJson: () => (this.phase7Bundle ? serialiseEvidence(this.phase7Bundle) : null),
      getPhase7State: () => this.registry.get(PHASE7),

      phase8Specs: PHASE8_SPECS,
      enterPhase8: (devOverride = false) => this.enterPhase8(devOverride),
      leavePhase8: () => this.leavePhase8(),
      /** Read-only, as for Phases 4–7: the leg presses `#start-keyframes` in the DOM. */
      getKeyframeStats: () => this.keyframes.stats(this.isKeepingKeyframes()),
      getPhase8Results: () => this.phase8Results,
      getPhase8Evidence: () => this.phase8Bundle,
      getPhase8EvidenceJson: () => (this.phase8Bundle ? serialiseEvidence(this.phase8Bundle) : null),
      getPhase8State: () => this.registry.get(PHASE8),
      getLog: () => logger.getEntries(),
      probeSensors: () => this.onProbeSensors(),
      rerun: () => this.detect(),
    };
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing');

const app = new Phase0App(root);
(window as unknown as Record<string, unknown>)['__SPATIAL_DEBUG__'] = app.debugApi();
(window as unknown as Record<string, unknown>)['__SPATIAL_READY__'] = app
  .start()
  .then(() => true)
  .catch((err: unknown) => {
    logger.error(
      PHASE, 'bootstrap', 'Phase 0 failed to start',
      'nothing is reported as available; the screen shows the failure',
      err,
    );
    return false;
  });
