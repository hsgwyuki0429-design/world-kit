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
  TestResult,
} from './core/types';
import { PhaseRegistry, PHASE_NAMES, isPhaseImplemented } from './core/PhaseRegistry';
import { CapabilityDetector, collectDeviceInfo } from './capture/CapabilityDetector';
import { probeMotionSensors } from './capture/MotionCapabilityProbe';
import { CameraSource, CameraState } from './capture/CameraSource';
import { FrameIntegrityMonitor } from './capture/FrameIntegrityMonitor';
import { ScenarioLedger } from './capture/ScenarioLedger';
import { runPhase1Tests, PHASE1_SPECS } from './testkit/Phase1Tests';
import { runPhase2Tests, PHASE2_SPECS } from './testkit/Phase2Tests';
import { runPhase3Tests, PHASE3_SPECS } from './testkit/Phase3Tests';
import { FeaturePopulation } from './tracking/FeaturePopulation';
import { asTrackingResult, DEFAULT_TRACKING_OPTIONS } from './tracking/trackingMessages';
import type { TrackingOptions } from './tracking/trackingMessages';
import { renderPhase3Screen } from './ui/Phase3Screen';
import { WorkerFramePipeline } from './pipeline/WorkerFramePipeline';
import { renderPhase1Screen } from './ui/Phase1Screen';
import { renderPhase2Screen } from './ui/Phase2Screen';
import { getPreviewVideo, isPreviewPresented } from './ui/PreviewVideo';
import { logger } from './debug/Logger';
import {
  buildEvidenceBundle,
  determineLeg,
  evidenceFilename,
  serialiseEvidence,
} from './debug/EvidenceRecorder';
import type { LegDetermination } from './debug/EvidenceRecorder';
import { runPhase0Tests, PHASE0_SPECS } from './testkit/Phase0Tests';
import { findIntegrityIssues } from './core/validate';
import { renderPhase0Screen, readUiSnapshot } from './ui/Phase0Screen';
import type { Phase0ViewModel } from './ui/Phase0Screen';

const APP_VERSION = __APP_VERSION__;
const PHASE = 0;
const PHASE1 = 1;
const PHASE2 = 2;
const PHASE3 = 3;
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

type Screen = 'phase0' | 'phase1' | 'phase2' | 'phase3';

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

  private screen: Screen = 'phase0';
  private readonly camera = new CameraSource();
  private readonly monitor = new FrameIntegrityMonitor();
  private readonly ledger = new ScenarioLedger(APP_VERSION);
  private phase1Results: TestResult[] = [];
  private phase1Bundle: EvidenceBundle | null = null;
  private cameraOpening = false;
  private phase1Timer: number | null = null;
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
  private phase3Timer: number | null = null;
  private phase3DevEntry = false;
  private detectionEverRan = false;
  private trackingFrames = 0;
  private lastOverlay: Float32Array | null = null;
  private lastOverlayWidth = 0;
  private lastOverlayHeight = 0;
  private phase2Results: TestResult[] = [];
  private phase2Bundle: EvidenceBundle | null = null;
  private phase2Timer: number | null = null;
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
    if (this.screen === 'phase3') {
      const stats = this.features.stats(this.pipeline.isRunning());
      const p = this.pipeline.getStats();
      renderPhase3Screen(
        this.root,
        {
          phase3: this.registry.get(PHASE3),
          cameraState: this.camera.getState(),
          trackLive: this.camera.isLive(),
          opening: this.cameraOpening,
          running: this.pipeline.isRunning(),
          stats,
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
    this.stopPhase1Ticking();
    // Re-render on a timer so the measured values stay live. The preview element is
    // re-appended synchronously inside the same render call, which the HTML spec's
    // "await a stable state" rule makes a no-op for playback — and CAM-003 measures the
    // longest frame gap, so if that reasoning were wrong the test would say so.
    this.phase1Timer = window.setInterval(() => {
      this.evaluatePhase1();
      this.render();
    }, PHASE1_TICK_MS);
  }

  private stopPhase1Ticking(): void {
    if (this.phase1Timer !== null) {
      clearInterval(this.phase1Timer);
      this.phase1Timer = null;
    }
  }

  private evaluatePhase1(): void {
    const video = getPreviewVideo();
    const previous = this.registry.get(PHASE1).state;

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

    const leg = this.leg?.leg ?? EvidenceLeg.DESKTOP_DEV;
    const evaluation = PhaseRegistry.evaluate(this.phase1Results, leg);
    this.registry.applyEvaluation(PHASE1, evaluation);
    const next = this.registry.get(PHASE1).state;
    if (previous !== next) {
      logger.info(PHASE1, 'App', `phase ${PHASE1}: ${previous} -> ${next}`, {
        reason: evaluation.reason,
      });
    }
    this.buildPhase1Evidence(evaluation.state, evaluation.reason);
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
    this.phase1Bundle = built.bundle;
    if (built.integrityIssues.length > 0) {
      logger.error(
        PHASE1, 'EvidenceRecorder',
        `Phase 1 evidence has ${built.integrityIssues.length} integrity issue(s)`,
        'the bundle is still offered for download so the problem is inspectable',
        undefined,
        { issues: built.integrityIssues.slice(0, 10) },
      );
    }
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
      this.screen === 'phase3' ? PHASE3 : this.screen === 'phase2' ? PHASE2 : PHASE1,
      'CameraSource',
      `camera track ended: ${reason}`,
      'the preview is removed and the state reported as CAMERA_ENDED; no last frame is ' +
        'left on screen',
    );
    if (this.screen === 'phase3') this.onStopPhase3(reason);
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
    this.stopPhase2Ticking();
    this.phase2Timer = window.setInterval(() => {
      this.evaluatePhase2();
      this.render();
    }, PHASE2_TICK_MS);
  }

  private stopPhase2Ticking(): void {
    if (this.phase2Timer !== null) {
      clearInterval(this.phase2Timer);
      this.phase2Timer = null;
    }
  }

  private evaluatePhase2(): void {
    const previous = this.registry.get(PHASE2).state;
    this.phase2Results = runPhase2Tests({
      cameraState: this.camera.getState(),
      cameraEverOpened: this.cameraEverOpened,
      pipelineEverStarted: this.pipelineEverStarted,
      stats: this.pipeline.getStats(),
    });

    const leg = this.leg?.leg ?? EvidenceLeg.DESKTOP_DEV;
    const evaluation = PhaseRegistry.evaluate(this.phase2Results, leg);
    this.registry.applyEvaluation(PHASE2, evaluation);
    const next = this.registry.get(PHASE2).state;
    if (previous !== next) {
      logger.info(PHASE2, 'App', `phase ${PHASE2}: ${previous} -> ${next}`, {
        reason: evaluation.reason,
      });
    }
    this.buildPhase2Evidence(evaluation.state, evaluation.reason);
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
    this.phase2Bundle = built.bundle;
    if (built.integrityIssues.length > 0) {
      logger.error(
        PHASE2, 'EvidenceRecorder',
        `Phase 2 evidence has ${built.integrityIssues.length} integrity issue(s)`,
        'the bundle is still offered for download so the problem is inspectable',
        undefined,
        { issues: built.integrityIssues.slice(0, 10) },
      );
    }
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
    this.features.record(result);
    if (result.overlay) {
      this.lastOverlay = new Float32Array(result.overlay);
      this.lastOverlayWidth = result.detectWidth * 2 ** result.detectLevel;
      this.lastOverlayHeight = result.detectHeight * 2 ** result.detectLevel;
    }
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
      wantContrast: sample,
      wantGridComparison: sample,
      wantLevel0Calibration: this.features.getLevel0Calibration() === null,
    };
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
    if (this.cameraOpening || this.pipeline.isRunning()) return;
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

    // The options are recomputed per frame by the pipeline calling back into the seam; this
    // sets the first set and the tick refreshes them.
    this.pipeline.setTrackingOptions(this.trackingOptions());
    if (this.pipeline.start(video)) {
      this.pipelineEverStarted = true;
      this.detectionEverRan = true;
      this.startPhase3Ticking();
    }
    this.evaluatePhase3();
    this.render();
  }

  private onStopPhase3(reason: string): void {
    this.stopPhase3Ticking();
    this.pipeline.stop(reason);
    this.pipeline.setTrackingOptions(undefined);
    const video = getPreviewVideo();
    video.srcObject = null;
    this.camera.close(reason);
    this.evaluatePhase3();
    this.render();
  }

  private startPhase3Ticking(): void {
    this.stopPhase3Ticking();
    this.phase3Timer = window.setInterval(() => {
      this.pipeline.setTrackingOptions(this.trackingOptions());
      this.evaluatePhase3();
      this.render();
    }, PHASE3_TICK_MS);
  }

  private stopPhase3Ticking(): void {
    if (this.phase3Timer !== null) {
      clearInterval(this.phase3Timer);
      this.phase3Timer = null;
    }
  }

  private evaluatePhase3(): void {
    const previous = this.registry.get(PHASE3).state;
    this.phase3Results = runPhase3Tests({
      cameraState: this.camera.getState(),
      pipelineEverStarted: this.pipelineEverStarted,
      detectionEverRan: this.detectionEverRan,
      stats: this.features.stats(this.pipeline.isRunning()),
    });

    const leg = this.leg?.leg ?? EvidenceLeg.DESKTOP_DEV;
    const evaluation = PhaseRegistry.evaluate(this.phase3Results, leg);
    this.registry.applyEvaluation(PHASE3, evaluation);
    const next = this.registry.get(PHASE3).state;
    if (previous !== next) {
      logger.info(PHASE3, 'App', `phase ${PHASE3}: ${previous} -> ${next}`, {
        reason: evaluation.reason,
      });
    }
    this.buildPhase3Evidence(evaluation.state, evaluation.reason);
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
      },
    });
    this.phase3Bundle = built.bundle;
    if (built.integrityIssues.length > 0) {
      logger.error(
        PHASE3, 'EvidenceRecorder',
        `Phase 3 evidence has ${built.integrityIssues.length} integrity issue(s)`,
        'the bundle is still offered for download so the problem is inspectable',
        undefined,
        { issues: built.integrityIssues.slice(0, 10) },
      );
    }
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
      getTrackingStats: () => this.features.stats(this.pipeline.isRunning()),
      getPhase3Results: () => this.phase3Results,
      getPhase3Evidence: () => this.phase3Bundle,
      getPhase3EvidenceJson: () => (this.phase3Bundle ? serialiseEvidence(this.phase3Bundle) : null),
      getPhase3State: () => this.registry.get(PHASE3),
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
