/**
 * PIPELINE screen (Phase 2).
 *
 * Two images side by side, and that pairing is the point: on the left the camera preview,
 * on the right the grayscale the *worker* produced, painted from the proof strip it sent
 * back. If the right-hand image ever stops following the left-hand one, the pipeline is not
 * delivering the camera — which is what FRAME-002 checks numerically, and what this lets a
 * human see at a glance in the device screenshot §60 requires.
 *
 * Every figure below is measured. Nothing here estimates, and a field with no measurement
 * shows a dash rather than a plausible number (Rule 002).
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import { STRIP_W, STRIP_H } from '../pipeline/pyramid';
import { REQUIRED_PIPELINE_MS, UI_BUDGET_MS } from '../testkit/Phase2Tests';
import type { PipelineStats } from '../pipeline/stats';

export interface Phase2ViewModel {
  readonly phase2: PhaseInfo;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly stats: PipelineStats;
  readonly strip: { data: Uint8Array; width: number; height: number } | null;
  readonly results: readonly TestResult[];
  readonly stressRefusal: string | null;
}

export interface Phase2Handlers {
  onStartCamera: () => void;
  onStopPipeline: () => void;
  onToggleStress: () => void;
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

function stat(label: string, value: string | null, cls = ''): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'k' }, [label]),
    el('div', { class: `v ${cls}` }, [value ?? '—']),
  ]);
}

/**
 * The worker-output canvas, kept across renders for the same reason the video element is:
 * re-creating it would blank the image on every re-render, and this screen re-renders twice
 * a second.
 */
let stripCanvas: HTMLCanvasElement | null = null;

function getStripCanvas(): HTMLCanvasElement {
  if (!stripCanvas) {
    stripCanvas = document.createElement('canvas');
    stripCanvas.id = 'worker-output';
    stripCanvas.width = STRIP_W;
    stripCanvas.height = STRIP_H;
  }
  return stripCanvas;
}

/** Paint the worker's grayscale. These are the worker's bytes, expanded to RGBA to show. */
function paintStrip(strip: { data: Uint8Array; width: number; height: number }): void {
  const canvas = getStripCanvas();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(strip.width, strip.height);
  for (let i = 0, p = 0; i < strip.data.length; i++, p += 4) {
    const v = strip.data[i] ?? 0;
    image.data[p] = v;
    image.data[p + 1] = v;
    image.data[p + 2] = v;
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function renderPhase2Screen(
  root: HTMLElement,
  vm: Phase2ViewModel,
  handlers: Phase2Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Frame pipeline']),
      el('p', {}, [
        'Phase 2 — frames to a preprocessing worker. A grayscale pyramid is built and ' +
          'measured; nothing consumes it yet, and nothing spatial is produced.',
      ]),
    ]),
  );

  root.append(renderImages(vm, handlers));
  root.append(renderThroughput(vm));
  root.append(renderLatency(vm));
  root.append(renderAdaptation(vm, handlers));
  root.append(renderRoutes(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));

  root.append(
    card('Navigation', [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase1',
        textContent: 'BACK TO CAMERA',
        onclick: handlers.onBack,
      } as never),
    ]),
  );
}

function renderImages(vm: Phase2ViewModel, handlers: Phase2Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;

  if (vm.trackLive) {
    children.push(el('div', { class: 'preview-frame' }, [getPreviewVideo()]));
  } else {
    const message =
      vm.cameraState === CameraState.PERMISSION_DENIED
        ? 'CAMERA PERMISSION DENIED'
        : vm.cameraState === CameraState.UNAVAILABLE
          ? 'CAMERA UNAVAILABLE'
          : vm.cameraState === CameraState.ENDED
            ? 'CAMERA ENDED — the track was stopped, most likely by another app'
            : vm.opening
              ? 'REQUESTING CAMERA…'
              : 'PIPELINE NOT STARTED';
    children.push(
      el('div', { class: 'preview-frame empty', id: 'preview-empty' }, [
        el('div', { class: 'preview-message' }, [message]),
      ]),
    );
  }

  if (vm.strip) {
    paintStrip(vm.strip);
    children.push(
      el('div', { class: 'worker-output-frame' }, [getStripCanvas()]),
      el('p', { class: 'footnote' }, [
        `Worker output — ${STRIP_W}×${STRIP_H} grayscale, downsampled in the worker from the ` +
          `${s.procWidth}×${s.procHeight} level-0 buffer it built. These are the worker's own ` +
          'bytes, not a second copy of the video.',
      ]),
    );
  } else if (s.running) {
    children.push(el('p', { class: 'empty' }, ['No worker output yet.']));
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-pipeline',
        disabled: vm.opening || s.running,
        textContent: s.running ? 'PIPELINE RUNNING' : vm.opening ? 'REQUESTING…' : 'START PIPELINE',
        onclick: handlers.onStartCamera,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-pipeline',
        disabled: !s.running,
        textContent: 'STOP PIPELINE',
        onclick: handlers.onStopPipeline,
      } as never),
    ]),
  );

  return card('Camera and worker output', children);
}

function renderThroughput(vm: Phase2ViewModel): HTMLElement {
  const s = vm.stats;
  const clean = s.longestCleanSegment;
  const target = REQUIRED_PIPELINE_MS / 1000;
  const cleanSeconds = (clean?.observedMs ?? 0) / 1000;
  const continuityClass =
    (clean?.observedMs ?? 0) >= REQUIRED_PIPELINE_MS
      ? 's-AVAILABLE'
      : s.completed > 0
        ? 's-PERMISSION_REQUIRED'
        : '';
  const lostRatio = s.admitted > 0 ? s.lost / s.admitted : 0;

  return card('Throughput', [
    el('div', { class: 'stat-grid' }, [
      stat('Source', s.sourceWidth > 0 ? `${s.sourceWidth}×${s.sourceHeight}` : null),
      stat('Processing', s.procWidth > 0 ? `${s.procWidth}×${s.procHeight}` : null),
      stat('Delivered fps', s.completed > 1 ? String(s.deliveredFps) : null),
      stat('Camera fps', s.callbacks > 1 ? String(s.sourceFps) : null),
      stat('Target fps', String(s.targetFps)),
      stat('Completed', s.completed > 0 ? String(s.completed) : null),
      stat('Admitted', s.admitted > 0 ? String(s.admitted) : null),
      stat('Paced out', String(s.pacedOut)),
      stat('Backpressured', String(s.backpressured)),
      stat('Lost', String(s.lost), s.lost > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Loss rate', s.admitted > 0 ? `${(lostRatio * 100).toFixed(2)}%` : null),
      stat(
        'Unstressed run',
        s.completed > 0 ? `${cleanSeconds.toFixed(1)} / ${target} s` : null,
        continuityClass,
      ),
      stat('Longest gap', s.completed > 1 ? `${clean?.maxGapMs ?? s.maxResultGapMs} ms` : null),
    ]),
    el('p', { class: 'footnote' }, [
      'Paced out = the target rate is below the camera rate, so the scheduler declined the ' +
        'frame. Backpressured = the worker was still busy. Neither is a drop. Lost = handed ' +
        'to the worker and never returned, which is the only one FRAME-001 holds against the ' +
        'pipeline. The delivered rate cannot exceed the camera rate, so the controller ' +
        'judges delivery against whichever of the two is lower.',
    ]),
    ...(s.wasEverHidden
      ? [
          el('p', { class: 'evidence-warning' }, [
            `The page was backgrounded ${s.hiddenCount} time(s). Frame callbacks stop while ` +
              'hidden, so this run cannot demonstrate 30 s of supply. Restart the pipeline ' +
              'without leaving the app.',
          ]),
        ]
      : []),
  ]);
}

function renderLatency(vm: Phase2ViewModel): HTMLElement {
  const s = vm.stats;
  const shown = (n: number, count: number): string | null => (count > 0 ? `${n} ms` : null);
  const uiClass =
    s.uiCostMs.count === 0 ? '' : s.uiCostMs.p95 <= UI_BUDGET_MS ? 's-AVAILABLE' : 's-PERMISSION_DENIED';

  return card('Latency and provenance', [
    el('div', { class: 'stat-grid' }, [
      stat('UI cost mean', shown(s.uiCostMs.mean, s.uiCostMs.count), uiClass),
      stat('UI cost p95', shown(s.uiCostMs.p95, s.uiCostMs.count), uiClass),
      stat('Acquire mean', shown(s.acquireMs.mean, s.acquireMs.count)),
      stat('Worker mean', shown(s.workerMs.mean, s.workerMs.count)),
      stat('Worker p95', shown(s.workerMs.p95, s.workerMs.count)),
      stat('Round trip p95', shown(s.roundTripMs.p95, s.roundTripMs.count)),
      stat('Cross-checks', s.crossCheck.count > 0 ? String(s.crossCheck.count) : null),
      stat(
        'Δ luma median',
        s.crossCheck.count > 0 ? String(s.crossCheck.medianAbsDifference) : null,
      ),
      stat('Δ luma max', s.crossCheck.count > 0 ? String(s.crossCheck.maxAbsDifference) : null),
      stat('Cross-check cost', shown(s.crossCheck.costMs.mean, s.crossCheck.costMs.count)),
      stat('Strip Δ peak', s.stripMadSamples > 0 ? String(s.stripMadMax) : null),
      stat(
        'Pyramid',
        s.pyramidLevels.length > 0
          ? s.pyramidLevels.map((l) => `${l.width}×${l.height}`).join(' / ')
          : null,
        s.pyramidConsistent ? 's-AVAILABLE' : '',
      ),
    ]),
    el('p', { class: 'footnote' }, [
      'Δ luma compares the worker’s grayscale against an independent reading of the same ' +
        'video frame taken on this thread. That reading is the expensive route §H.1 ruled ' +
        'out for the pipeline, which is why it runs once a second, and its cost is shown ' +
        'above rather than folded into the UI cost.',
    ]),
    ...(s.pyramidProblems.length > 0
      ? [el('p', { class: 'evidence-warning' }, [s.pyramidProblems.join('; ')])]
      : []),
    ...(s.workerErrors.length > 0
      ? [el('p', { class: 'evidence-warning' }, [`Worker errors: ${s.workerErrors.join(' | ')}`])]
      : []),
  ]);
}

function renderAdaptation(vm: Phase2ViewModel, handlers: Phase2Handlers): HTMLElement {
  const s = vm.stats;
  const children: (Node | string)[] = [
    el('div', { class: 'stat-grid' }, [
      stat('Tier', s.tierLabel, s.tierStep <= 1 ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('Ladder step', String(s.tierStep)),
      stat('Ladder moves', String(s.decisions.length)),
      stat('Injected load', s.stressPasses > 0 ? `${s.stressPasses} extra passes` : 'none'),
    ]),
  ];

  if (s.tierUsage.length > 0) {
    children.push(
      el('p', { class: 'group-title' }, ['Frames produced per tier']),
      ...s.tierUsage.map((t) =>
        el('div', { class: 'cap-row' }, [
          el('span', { class: 'cap-label' }, [t.label]),
          el('span', { class: 'cap-method' }, [t.sizes.join(', ')]),
          el('span', { class: 'cap-state' }, [`${t.frames}`]),
        ]),
      ),
    );
  }

  if (s.decisions.length > 0) {
    children.push(
      el('p', { class: 'group-title' }, ['Ladder moves, with what caused each']),
      ...s.decisions.map((d, i) => {
        const outcome = s.decisionOutcomes.find((o) => o.decisionIndex === i);
        return el('details', { class: 'row' }, [
          el('summary', {}, [
            el('span', { class: 'id' }, [d.direction]),
            el('span', { class: 'title' }, [`${d.fromLabel} → ${d.toLabel}`]),
            el('span', { class: 'verdict' }, [`${d.medianWorkerMs} ms`]),
          ]),
          el('dl', { class: 'detail-grid' }, [
            el('dt', {}, ['Reason']),
            el('dd', {}, [d.reason]),
            el('dt', {}, ['Effect']),
            el('dd', { class: 'mono' }, [
              outcome
                ? `median worker latency ${outcome.beforeMedianWorkerMs} ms → ` +
                  `${outcome.afterMedianWorkerMs} ms over the next ${outcome.samples} frames`
                : 'not yet measured',
            ]),
          ]),
        ]);
      }),
    );
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'secondary',
        id: 'toggle-stress',
        disabled: !s.running,
        textContent: s.stressPasses > 0 ? 'STOP INJECTED LOAD' : 'INJECT LOAD',
        onclick: handlers.onToggleStress,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [
      'A device that meets its budget never degrades on its own, so FRAME-003 and FRAME-004 ' +
        'need load. The load is real work — extra passes over the pyramid the worker actually ' +
        'built — and the number of passes is computed from the measured cost of one pass on ' +
        'this device. It is a stimulus; every latency the controller then sees is still a ' +
        'measurement.',
    ]),
  );

  if (vm.stressRefusal) {
    children.push(el('p', { class: 'evidence-warning' }, [vm.stressRefusal]));
  }
  if (s.spontaneousDegrade) {
    children.push(
      el('p', { class: 'evidence-warning' }, [
        'At least one downward step was taken with no load injected: this device could not ' +
          'hold its tier unaided. That is a real result and is recorded as such.',
      ]),
    );
  }

  return card('Adaptation', children);
}

function renderRoutes(vm: Phase2ViewModel): HTMLElement {
  const s = vm.stats;
  const scope = s.workerScope;
  return card('Acquisition route and worker', [
    ...s.routeProbes.map((r) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [r.route]),
        el('span', { class: 'cap-method' }, [r.attempts > 0 ? `${r.meanAcquireMs} ms` : '']),
        el('span', { class: `cap-state ${r.ok ? 's-AVAILABLE' : 's-UNKNOWN'}` }, [r.note]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      'Routes are tried in order and the first that completes real round trips is kept. The ' +
        'last one is the main-thread readback §H.1 measured at 13.8 ms on this device — it is ' +
        'kept as a declared fallback, and kept measured, rather than assumed unusable.',
    ]),
    el('p', { class: 'group-title' }, ['Worker scope']),
    el('p', { class: 'cap-data' }, [
      scope
        ? `document: ${scope.hasDocument} · WorkerGlobalScope: ${scope.isWorkerGlobalScope} · ` +
          `OffscreenCanvas 2D: ${scope.canvas2dAvailable} · cores: ${scope.hardwareConcurrency}`
        : 'the worker has not reported in',
    ]),
  ]);
}

function renderTests(vm: Phase2ViewModel): HTMLElement {
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
  return card(`Tests — Phase 2 · ${vm.phase2.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase2.state}`, id: 'phase2-verdict' }, [
        vm.phase2.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase2.reason]),
    ...rows,
  ]);
}

function renderEvidence(vm: Phase2ViewModel, handlers: Phase2Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase2-pending-warning' }, [
        `This export would record ${vm.phase2.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p2',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase2.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p2',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}
