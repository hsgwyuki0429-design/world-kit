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
import { PhaseRegistry, PHASE_NAMES } from './core/PhaseRegistry';
import { CapabilityDetector, collectDeviceInfo } from './capture/CapabilityDetector';
import { probeMotionSensors } from './capture/MotionCapabilityProbe';
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
const PROBE_BUDGET_MS = 1500;

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

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
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
      logger.transition(`phase[${PHASE}]`, previous, next, settled.reason);
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

  private onDownloadEvidence(): void {
    if (!this.bundle) return;
    const json = serialiseEvidence(this.bundle);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = evidenceFilename(this.bundle);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logger.info(PHASE, 'Evidence', 'evidence download started', { file: a.download });
  }

  private async onCopyEvidence(): Promise<void> {
    if (!this.bundle) return;
    const json = serialiseEvidence(this.bundle);
    try {
      await navigator.clipboard.writeText(json);
      logger.info(PHASE, 'Evidence', 'evidence copied to clipboard', { bytes: json.length });
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
    renderPhase0Screen(this.root, this.viewModel(), {
      onProbeSensors: () => void this.onProbeSensors(),
      onDownloadEvidence: () => this.onDownloadEvidence(),
      onCopyEvidence: () => void this.onCopyEvidence(),
      onRerun: () => void this.detect(),
    });
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
