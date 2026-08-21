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

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import type { CameraOpenResult, CameraSettingsSnapshot } from '../capture/CameraSource';
import type { FrameStats } from '../capture/FrameIntegrityMonitor';
import { REQUIRED_CAPTURE_MS } from '../capture/FrameIntegrityMonitor';
import type { LedgerEntry } from '../capture/ScenarioLedger';

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
}

export interface Phase1Handlers {
  onStartCamera: () => void;
  onStopCamera: () => void;
  onBack: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

function card(title: string, children: (Node | string)[]): HTMLElement {
  return el('section', { class: 'card' }, [el('h2', {}, [title]), ...children]);
}

/** A measured value, or an explicit dash. Never a plausible-looking placeholder. */
function stat(label: string, value: string | null, cls = ''): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'k' }, [label]),
    el('div', { class: `v ${cls}` }, [value ?? '—']),
  ]);
}

/**
 * The single video element, kept across renders.
 *
 * Re-creating it would tear down and re-attach the stream on every state change, which
 * restarts frame delivery and would corrupt CAM-003's continuity measurement.
 */
let videoEl: HTMLVideoElement | null = null;

export function getPreviewVideo(): HTMLVideoElement {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.id = 'camera-preview';
    // All three are required for an inline preview on iOS; without playsInline the stream
    // takes over the screen in a native player.
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('muted', '');
  }
  return videoEl;
}

/** True when an image is actually on screen — read from the DOM, not from intent. */
export function isPreviewPresented(): boolean {
  const v = document.getElementById('camera-preview') as HTMLVideoElement | null;
  if (!v || !v.isConnected) return false;
  return v.videoWidth > 0 && v.videoHeight > 0 && !!v.srcObject;
}

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
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));

  root.append(
    card('Navigation', [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase0',
        textContent: 'BACK TO CAPABILITY',
        onclick: handlers.onBack,
      } as never),
    ]),
  );
}

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

function renderTests(vm: Phase1ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const counts = {
    pass: vm.results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: vm.results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: vm.results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  const rows = vm.results.map((r) =>
    el('details', { class: 'row' }, [
      el('summary', {}, [
        el('span', { class: 'id' }, [r.spec.id]),
        el('span', { class: 'title' }, [r.spec.title]),
        el('span', { class: 'req' }, [r.spec.required ? 'REQ' : 'ADV']),
        el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
      ]),
      el('dl', { class: 'detail-grid' }, [
        el('dt', {}, ['Expected']), el('dd', {}, [r.spec.expected]),
        el('dt', {}, ['Criteria']), el('dd', {}, [r.spec.passCriteria]),
        el('dt', {}, ['Observed']), el('dd', { class: 'mono' }, [r.observed]),
        el('dt', {}, ['Reason']), el('dd', {}, [r.reason]),
      ]),
    ]),
  );
  return card(`Tests — Phase 1 · ${vm.phase1.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase1.state}`, id: 'phase1-verdict' }, [
        vm.phase1.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase1.reason]),
    ...rows,
  ]);
}

function renderEvidence(vm: Phase1ViewModel, handlers: Phase1Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase1-pending-warning' }, [
        `This export would record ${vm.phase1.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p1',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase1.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p1',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}
