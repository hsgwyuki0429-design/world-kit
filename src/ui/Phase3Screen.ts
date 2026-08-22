/**
 * FEATURES screen (Phase 3, §51).
 *
 * The camera with the detected corners drawn on it. §51 is explicit that feature points
 * **must not be drawn at fixed positions** — they have to be the ones actually detected —
 * so the overlay is fed the worker's own position buffer and has no other source. There is
 * no code path here that could produce a point the detector did not find; if detection
 * returns nothing, the overlay draws nothing.
 *
 * The video and the overlay share one aspect-locked box so the two align exactly. A point
 * drawn a few pixels from the corner it belongs to would look like a working detector with
 * a calibration problem, which is precisely the kind of thing a screenshot should not be
 * able to hide.
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import { DETECT_BUDGET_MS, MIN_CONTRAST_ABOVE_CHANCE } from '../testkit/Phase3Tests';
import {
  FEATURE_MIN,
  FEATURE_TARGET,
  GRID_COLS,
  GRID_ROWS,
  TEXTURE_POOR_CEILING,
  TEXTURE_RICH_FLOOR,
} from '../tracking/featureTypes';
import type { TrackingStats } from '../tracking/trackingStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';

export interface Phase3ViewModel {
  readonly phase3: PhaseInfo;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly running: boolean;
  readonly stats: TrackingStats;
  /** `[x0, y0, quality] × count`, in processing-level coordinates, straight from the worker. */
  readonly alignment: AlignmentReading | null;
  readonly overlay: Float32Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase3Handlers {
  onStart: () => void;
  onStop: () => void;
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

/** Kept across renders, like the video: recreating it would blank the overlay twice a second. */
let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'feature-overlay';
  }
  return overlayCanvas;
}

/**
 * Draw the detected corners.
 *
 * Reads only `overlay`, which is the worker's own buffer of positions. Quality modulates
 * the radius so a screenshot shows which corners the detector rated highest — that is a
 * rendering of a measured value, not a decoration.
 */
function paintOverlay(vm: Phase3ViewModel): void {
  const canvas = getOverlayCanvas();
  const w = Math.max(1, vm.overlayWidth);
  const h = Math.max(1, vm.overlayHeight);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const data = vm.overlay;
  if (!data || data.length < 3) return;

  const count = Math.floor(data.length / 3);
  ctx.lineWidth = Math.max(1, Math.round(w / 480));
  for (let i = 0; i < count; i++) {
    const x = data[i * 3] ?? 0;
    const y = data[i * 3 + 1] ?? 0;
    const q = data[i * 3 + 2] ?? 0;
    const r = Math.max(1.5, (w / 260) * (0.5 + q));
    // Strong corners green, weak ones amber: the same measured quality the record carries.
    ctx.strokeStyle = q > 0.35 ? 'rgba(48, 209, 88, 0.9)' : 'rgba(255, 184, 0, 0.75)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

export function renderPhase3Screen(
  root: HTMLElement,
  vm: Phase3ViewModel,
  handlers: Phase3Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Features']),
      el('p', {}, [
        'Phase 3 — Shi-Tomasi corners on the pyramid Phase 2 builds. Each point is one ' +
          'corner in one image; nothing follows a point from frame to frame yet, and nothing ' +
          'spatial is produced.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPopulation(vm));
  root.append(renderScene(vm));
  root.append(renderProvenance(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));

  root.append(
    card('Navigation', [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase2',
        textContent: 'BACK TO PIPELINE',
        onclick: handlers.onBack,
      } as never),
    ]),
  );
}

function renderPreview(vm: Phase3ViewModel, handlers: Phase3Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;

  if (vm.trackLive) {
    paintOverlay(vm);
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0
        ? `${vm.sourceWidth} / ${vm.sourceHeight}`
        : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
        getOverlayCanvas(),
      ]),
      el('p', { class: 'footnote' }, [
        s.detections > 0
          ? `${s.count} corners drawn at the positions the detector reported, on the ` +
            `${s.detectWidth}×${s.detectHeight} level-${s.detectLevel} image. Radius and ` +
            'colour follow each corner’s measured quality; §51 forbids drawing points ' +
            'anywhere but where they were found.'
          : 'Waiting for the first detection.',
      ]),
    );
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
              : 'DETECTION NOT STARTED';
    children.push(
      el('div', { class: 'preview-frame empty', id: 'preview-empty' }, [
        el('div', { class: 'preview-message' }, [message]),
      ]),
    );
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-detection',
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'DETECTING' : vm.opening ? 'REQUESTING…' : 'START DETECTION',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-detection',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('Camera and detected corners', children);
}

function renderPopulation(vm: Phase3ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === 'TRACKING_DEGRADED'
      ? 's-PERMISSION_DENIED'
      : s.state === 'LOW_FEATURE_COUNT'
        ? 's-PERMISSION_REQUIRED'
        : 's-AVAILABLE';
  const countClass = s.count >= FEATURE_MIN ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED';

  return card('Population', [
    el('div', { class: 'stat-grid' }, [
      stat('Features', s.detections > 0 ? String(s.count) : null, countClass),
      stat('State', s.detections > 0 ? s.state.replace(/_/g, ' ') : null, stateClass),
      stat('Target', String(FEATURE_TARGET)),
      stat('Cell quota', s.quota > 0 ? String(s.quota) : null),
      stat('Cells occupied', s.detections > 0 ? `${s.occupiedCells} / ${GRID_COLS * GRID_ROWS}` : null),
      stat('Largest cell', s.detections > 0 ? `${Math.round(s.maxCellShare * 1000) / 10}%` : null),
      stat('Detections', String(s.detections)),
      stat('Detect cost', s.detections > 0 ? `${s.meanDetectCostMs} ms` : null,
        s.meanDetectCostMs >= 0 && s.meanDetectCostMs <= DETECT_BUDGET_MS ? 's-AVAILABLE' : ''),
      stat('Refills', String(s.refills.length)),
      stat('Quota breaches', String(s.quotaBreaches), s.quotaBreaches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Over maximum', String(s.overMaxFrames), s.overMaxFrames > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('State mismatches', String(s.stateMismatches), s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `§11's ladder: below 500 top up, below 200 urgently, below ${FEATURE_MIN} report LOW ` +
        'FEATURE COUNT, below 80 TRACKING DEGRADED. The state shown is a function of the ' +
        'count shown — they cannot disagree, and a frame where they did would be counted above.',
    ]),
    ...(s.refills.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recent refills']),
          ...s.refills.slice(-5).map((r) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${r.urgency} · ${r.texture}`]),
              el('span', { class: 'cap-method' }, [r.exhausted ? 'exhausted' : 'recovered']),
              el('span', { class: 'cap-state' }, [`${r.countBefore} → ${r.countAfter}`]),
            ]),
          ),
        ]
      : []),
  ]);
}

function renderScene(vm: Phase3ViewModel): HTMLElement {
  const s = vm.stats;
  const row = (label: string, c: { frames: number; medianCount: number; medianGradient: number }): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [c.frames > 0 ? `∇ ${c.medianGradient}` : '']),
      el('span', { class: `cap-state ${c.frames > 0 ? 's-AVAILABLE' : ''}` }, [
        c.frames > 0 ? `${c.frames} frames · median ${c.medianCount}` : 'none yet',
      ]),
    ]);

  return card('Scene', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      `Each frame is classified by its own mean gradient magnitude: at or above ` +
        `${TEXTURE_RICH_FLOOR} it has structure, at or below ${TEXTURE_POOR_CEILING} it is ` +
        'blank, and between the two it is judged by neither test. That is measured from the ' +
        'image — pointing the camera somewhere is not the same as saying what it saw.',
    ]),
    row('Texture-rich (FEAT-001)', s.textureRich),
    row('Texture-poor (FEAT-002)', s.texturePoor),
    row('Ambiguous', s.textureAmbiguous),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('Current ∇', s.detections > 0 ? String(s.meanGradient) : null),
      stat('Class', s.detections > 0 ? s.texture.replace('TEXTURE_', '') : null),
      stat('Detect level', s.detections > 0 ? String(s.detectLevel) : null),
      stat('Detect size', s.detectWidth > 0 ? `${s.detectWidth}×${s.detectHeight}` : null),
    ]),
    ...(s.texturePoor.frames === 0
      ? [
          el('p', { class: 'footnote' }, [
            'FEAT-002 needs a blank surface. Point the camera at one for a couple of seconds ' +
              'and back — the same movement makes FEAT-004 exercise the refill ladder.',
          ]),
        ]
      : []),
  ]);
}

function renderProvenance(vm: Phase3ViewModel): HTMLElement {
  const s = vm.stats;
  const ok = s.medianAboveChance >= MIN_CONTRAST_ABOVE_CHANCE;
  const cal = s.level0Calibration;
  return card('Are these real corners?', [
    el('div', { class: 'stat-grid' }, [
      stat(
        'Above chance',
        s.contrastSamples > 0 ? `${Math.round(s.medianAboveChance * 1000) / 10}%` : null,
        s.contrastSamples > 0 ? (ok ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : '',
      ),
      stat('Samples', s.contrastSamples > 0 ? String(s.contrastSamples) : null),
      stat('Grid comparisons', s.grid.samples > 0 ? String(s.grid.samples) : null),
      // §51: the overlay must sit on the picture, and on a phone that is not the same claim
      // as the contrast statistic above — which is computed in the worker on the worker's
      // own buffer and so cannot see a rotated one.
      stat(
        'Overlay matches video',
        vm.alignment
          ? vm.alignment.best === 'identity'
            ? `yes · ${vm.alignment.identityOverRandom.toFixed(1)}× chance`
            : `NO · ${vm.alignment.best} fits ${vm.alignment.bestOverIdentity.toFixed(1)}× better`
          : null,
        vm.alignment
          ? vm.alignment.best === 'identity' &&
            vm.alignment.identityOverRandom >= MIN_IDENTITY_OVER_RANDOM
            ? 's-AVAILABLE'
            : 's-PERMISSION_DENIED'
          : '',
      ),
      stat(
        'Clustering',
        s.grid.samples > 0
          ? `${Math.round(s.grid.medianGridded * 1000) / 10}% vs ${Math.round(s.grid.medianUngridded * 1000) / 10}%`
          : null,
      ),
    ]),
    el('p', { class: 'footnote' }, [
      'Above chance is the probability that a detected position has more local texture than ' +
        'a seeded-random position in the same frame. A detector emitting coordinates ' +
        'unrelated to the image scores 50% exactly, by construction — so the distance from ' +
        `50% measures the detector rather than the scene. FEAT-001 needs ${Math.round(MIN_CONTRAST_ABOVE_CHANCE * 100)}%.`,
    ]),
    el('p', { class: 'footnote' }, [
      'Overlay matches video is measured on this thread, from this element: the page reads ' +
        'the video itself and scores the drawn positions against each rotation, flip and ' +
        'transpose. Identity has to win. The check above it cannot see this — it runs in ' +
        'the worker on the worker’s own buffer, so a buffer rotated against the screen ' +
        'scores just as well. If this says NO the acquisition route is abandoned rather ' +
        'than the drawing corrected, because Phase 4 reads the same positions.',
    ]),
    el('p', { class: 'footnote' }, [
      'Clustering compares the largest single-cell share with the 8×6 quota against an ' +
        'ungridded selection over the same candidates on the same frame. A scene that would ' +
        'have spread evenly anyway shows no difference, which is the point.',
    ]),
    ...(cal
      ? [
          el('p', { class: 'footnote' }, [
            `Level-0 calibration: detecting at ${cal.width}×${cal.height} would have cost ` +
              `${cal.detectMs} ms and found ${cal.features} features, measured once on this ` +
              `device. Detection runs at level ${s.detectLevel} for ${s.meanDetectCostMs} ms.`,
          ]),
        ]
      : []),
  ]);
}

function renderTests(vm: Phase3ViewModel): HTMLElement {
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
  return card(`Tests — Phase 3 · ${vm.phase3.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase3.state}`, id: 'phase3-verdict' }, [
        vm.phase3.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase3.reason]),
    ...rows,
  ]);
}

function renderEvidence(vm: Phase3ViewModel, handlers: Phase3Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase3-pending-warning' }, [
        `This export would record ${vm.phase3.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p3',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase3.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p3',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}
