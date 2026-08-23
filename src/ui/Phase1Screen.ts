/**
 * SCAN screen (§94).
 *
 * Camera preview with an overlay of measured values only. Every number here comes from
 * `FrameIntegrityMonitor` or from the track's own `getSettings()`; nothing is estimated,
 * and nothing is displayed when there is no measurement — the field reads `—` instead.
 *
 * The preview element is removed from the DOM entirely when there is no live track, rather
 * than being left in place showing its last frame. A video element that keeps painting a
 * stale image after the camera is gone is exactly the "UI implies capability the engine
 * lacks" failure of Rule 002, and it is what CAM-002 checks for.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import type { CameraOpenResult, CameraSettingsSnapshot } from '../capture/CameraSource';
import type { FrameStats } from '../capture/FrameIntegrityMonitor';
import { REQUIRED_CAPTURE_MS } from '../capture/FrameIntegrityMonitor';
import type { LedgerEntry } from '../capture/ScenarioLedger';
// One preview element for the whole app, since Phase 2 shows the same camera (see
// `PreviewVideo.ts`). Re-exported so existing importers of this module are unaffected.
import { getPreviewVideo, isPreviewPresented } from './PreviewVideo';
import { card, el, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export { getPreviewVideo, isPreviewPresented };

export interface Phase1ViewModel {
  readonly phase1: PhaseInfo;
  readonly cameraState: CameraState;
  readonly openResult: CameraOpenResult | null;
  readonly settings: CameraSettingsSnapshot | null;
  readonly stats: FrameStats;
  readonly results: readonly TestResult[];
  readonly granted: LedgerEntry | null;
  readonly denied: LedgerEntry | null;
  readonly opening: boolean;
  readonly trackLive: boolean;
  /** Phase 2's state, so the control that leads to it can say why it is closed. */
  readonly phase2: PhaseInfo;
  readonly canEnterPhase2: boolean;
  readonly phase2Implemented: boolean;
  readonly phase2BlockedReason: string;
}

export interface Phase1Handlers {
  onStartCamera: () => void;
  onStopCamera: () => void;
  onBack: () => void;
  onEnterPhase2: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

/** A measured value, or an explicit dash. Never a plausible-looking placeholder. */

export function renderPhase1Screen(
  root: HTMLElement,
  vm: Phase1ViewModel,
  handlers: Phase1Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Scan']),
      el('p', {}, ['Phase 1 — Camera Capture. Nothing spatial is produced yet.']),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderOverlayStats(vm));
  root.append(renderScenarios(vm));
  root.append(testsSection(1, vm.phase1, vm.results));
  root.append(
    evidenceSection(1, vm.phase1, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );

  root.append(
    navigationSection(
      { index: 0, label: 'BACK TO CAPABILITY', onClick: handlers.onBack },
      {
        index: 2,
        name: 'FRAME PIPELINE',
        phase: vm.phase2,
        canEnter: vm.canEnterPhase2,
        implemented: vm.phase2Implemented,
        blockedReason: vm.phase2BlockedReason,
        onClick: handlers.onEnterPhase2,
      },
    ),
  );
}

/**
 * Phase Lock, on screen (Rule 002, Rule 005).
 *
 * The control that leads to Phase 2 is disabled unless Phase 1 has actually PASSED in this
 * session *and* Phase 2 exists in this build, and it says which of the two is missing. A
 * button that looks available for a phase the engine cannot enter is the UI implying a
 * capability the engine lacks.
 */

function renderPreview(vm: Phase1ViewModel, handlers: Phase1Handlers): HTMLElement {
  const children: (Node | string)[] = [];

  if (vm.trackLive) {
    const frame = el('div', { class: 'preview-frame' }, [getPreviewVideo()]);
    children.push(frame);
  } else {
    // No live track: no image at all, and a statement of why.
    const failure = vm.openResult?.failure ?? null;
    const message =
      vm.cameraState === CameraState.PERMISSION_DENIED
        ? 'CAMERA PERMISSION DENIED'
        : vm.cameraState === CameraState.UNAVAILABLE
          ? 'CAMERA UNAVAILABLE'
          : vm.cameraState === CameraState.ENDED
            ? 'CAMERA ENDED — the track was stopped, most likely by another app'
            : vm.opening
              ? 'REQUESTING CAMERA…'
              : 'CAMERA NOT STARTED';
    children.push(
      el('div', { class: 'preview-frame empty', id: 'preview-empty' }, [
        el('div', { class: 'preview-message' }, [message]),
      ]),
    );
    if (failure) {
      children.push(
        el('p', { class: 'locked-note' }, [`${failure.errorName}: ${failure.message}`]),
        el('p', { class: 'footnote' }, [`Recovery: ${failure.recovery}`]),
      );
    }
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-camera',
        disabled: vm.opening || vm.trackLive,
        textContent: vm.trackLive ? 'CAMERA LIVE' : vm.opening ? 'REQUESTING…' : 'START CAMERA',
        onclick: handlers.onStartCamera,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-camera',
        disabled: !vm.trackLive,
        textContent: 'STOP CAMERA',
        onclick: handlers.onStopCamera,
      } as never),
    ]),
  );

  return card('Camera', children);
}

function renderOverlayStats(vm: Phase1ViewModel): HTMLElement {
  const s = vm.stats;
  const settings = vm.settings;
  const secondsHeld = s.observedMs / 1000;
  const target = REQUIRED_CAPTURE_MS / 1000;

  const captureClass =
    s.observedMs >= REQUIRED_CAPTURE_MS ? 's-AVAILABLE' : s.frameCount > 0 ? 's-PERMISSION_REQUIRED' : '';

  return card('Measured', [
    el('div', { class: 'stat-grid' }, [
      stat('State', vm.cameraState, vm.trackLive ? 's-AVAILABLE' : 's-UNAVAILABLE'),
      stat('Resolution', settings ? `${settings.width}×${settings.height}` : null),
      stat('Facing', settings?.facingMode ?? null),
      stat('Track fps', settings && settings.frameRate > 0 ? String(settings.frameRate) : null),
      stat('Frames', s.frameCount > 0 ? String(s.frameCount) : null),
      stat('Delivered fps', s.frameCount > 1 ? String(s.meanFps) : null),
      stat('Continuous', s.frameCount > 0 ? `${secondsHeld.toFixed(1)} / ${target} s` : null, captureClass),
      stat('Longest gap', s.frameCount > 1 ? `${s.maxGapMs} ms` : null),
      stat('Image Δ max', s.sampleCount > 0 ? String(s.madMax) : null),
      stat('Noise floor', s.sampleCount > 0 ? String(s.madMedian) : null),
      stat('Luma range', s.sampleCount > 0 ? `${s.lumaMin}–${s.lumaMax}` : null),
      stat('Rotations', String(s.orientationChanges)),
    ]),
    el('p', { class: 'footnote' }, [
      s.frameCount > 0
        ? `Frame source: ${s.source}. Sampling costs ${s.sampleCostMsMean} ms per sample at ` +
          '4 Hz on a 64×48 buffer — verification instrumentation, not the Phase 2 pipeline.'
        : 'No frames observed yet. Every field above shows a dash until it has a measurement.',
    ]),
    ...(s.wasEverHidden
      ? [
          el('p', { class: 'evidence-warning' }, [
            `The page was backgrounded ${s.hiddenCount} time(s). Frame callbacks stop while ` +
              'hidden, so this run cannot demonstrate 30 s of continuous capture. Stop and ' +
              'restart the camera without leaving the app.',
          ]),
        ]
      : []),
  ]);
}

function renderScenarios(vm: Phase1ViewModel): HTMLElement {
  const row = (label: string, entry: LedgerEntry | null): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [
        entry ? (entry.observedDirectly ? 'THIS RUN' : 'CARRIED') : '',
      ]),
      el('span', { class: `cap-state ${entry ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'}` }, [
        entry ? 'OBSERVED' : 'NOT YET',
      ]),
    ]);

  return card('Permission scenarios', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      'Granted and denied cannot both happen in one session, and neither may be inferred ' +
        'from the other — so Phase 1 needs two runs.',
    ]),
    row('Permission granted (CAM-001)', vm.granted),
    row('Permission denied (CAM-002)', vm.denied),
    ...(vm.denied === null
      ? [
          el('p', { class: 'footnote' }, [
            'To exercise the denial: Safari → the ăA menu → Website Settings → Camera → Deny, ' +
              'then reload this page and press START CAMERA.',
          ]),
        ]
      : []),
    ...(vm.granted?.observedDirectly === false || vm.denied?.observedDirectly === false
      ? [
          el('p', { class: 'footnote' }, [
            'A scenario marked CARRIED was observed in an earlier run of this same build and ' +
              'origin, and is stored locally. It is a convenience for testing — the ' +
              'repository requires a committed bundle that observed it directly.',
          ]),
        ]
      : []),
  ]);
}

