/**
 * TRACKING screen (Phase 4, §51, §57).
 *
 * The camera with the followed corners drawn on it, and beside them the one comparison that
 * makes the drawing mean anything: what the tracker says the points did, against what an
 * independent search says the image did.
 *
 * Three things on this screen are there because of what Phase 4 can fake.
 *
 *  - **Tracked and redetected are shown as two numbers, never as one.** A population near
 *    target says nothing on its own: §11's refill ladder will hold it there while the tracker
 *    loses every point. The screen shows both because the tests judge both.
 *  - **"Points follow the image" is the headline**, not the feature count. It is the FLOW-002
 *    cross-check, and it is the only figure here a tracker returning its input cannot produce.
 *  - **`GOOD` says why it is not claimed.** §33's GOOD needs an inlier ratio and a
 *    reprojection error, and Phases 5 and 6 have not been written — so the screen names the
 *    missing terms rather than showing a state that quietly dropped two of its conditions.
 *
 * The overlay alignment probe carries over from Phase 3 unchanged and is displayed here for
 * the reason §H.5 gives: Phase 4 consumes the same positions Phase 3 drew, so if the acquired
 * buffer is rotated against the screen, every displacement in this phase is measured in the
 * wrong frame. It is a Phase 4 concern now, not a Phase 3 leftover.
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  FLOW_BUDGET_MS,
  MIN_SHIFT_SAMPLES,
  MIN_SURVIVAL_SLOW,
} from '../testkit/Phase4Tests';
import {
  FB_ACCEPTABLE_PX,
  FB_REDUCED_PX,
  LK_EPSILON,
  LK_LEVELS,
  LK_MAX_ITERATIONS,
  LK_WINDOW,
} from '../tracking/LucasKanade';
import { FAST_SHIFT_PX, STATIC_SHIFT_PX } from '../tracking/SceneShift';
import { DEGRADED_FEATURES, GOOD_FEATURES, TrackingState } from '../tracking/trackingState';
import { ROTATING_DEG, ROTATION_WINDOW_MS } from '../tracking/FlowSession';
import type { FlowStats } from '../tracking/flowStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';

export interface Phase4ViewModel {
  readonly phase4: PhaseInfo;
  readonly phase5: PhaseInfo;
  readonly canEnterPhase5: boolean;
  readonly phase5Implemented: boolean;
  readonly phase5BlockedReason: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: tracking asked for AND a pipeline running to serve it (§H.5). */
  readonly running: boolean;
  readonly stats: FlowStats;
  readonly alignment: AlignmentReading | null;
  /** `[x0, y0, quality] × count`, level-0 coordinates, straight from the worker. */
  readonly overlay: Float32Array | null;
  /** `age` per overlay point, so a tracked corner draws differently from a fresh one. */
  readonly overlayAge: Uint16Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase4Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase5: () => void;
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

function pct(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 10}%`;
}

function px(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100} px`;
}

/** Kept across renders, like the video: recreating it would blank the overlay twice a second. */
let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'flow-overlay';
  }
  return overlayCanvas;
}

/**
 * Draw the population, with a track's history visible.
 *
 * A point that has been followed for a while is drawn as a filled dot; one detection has just
 * added is drawn as a ring. That distinction is the screen's version of the two numbers below
 * it — a frame where every point is a ring is a frame where the tracker kept nothing, and it
 * looks like one, rather than looking like a healthy population because the count is high.
 *
 * As in Phase 3, the only source is the worker's own position buffer. There is no path here
 * that could produce a point the tracker did not report.
 */
function paintOverlay(vm: Phase4ViewModel): void {
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
  const ages = vm.overlayAge;

  const count = Math.floor(data.length / 3);
  ctx.lineWidth = Math.max(1, Math.round(w / 480));
  for (let i = 0; i < count; i++) {
    const x = data[i * 3] ?? 0;
    const y = data[i * 3 + 1] ?? 0;
    const q = data[i * 3 + 2] ?? 0;
    const age = ages?.[i] ?? 0;
    const r = Math.max(1.5, (w / 300) * (0.5 + q));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (age > 0) {
      // Followed. Brighter with a longer history, up to a second or so of tracking.
      const strength = Math.min(1, age / 30);
      ctx.fillStyle = `rgba(48, 209, 88, ${0.35 + 0.55 * strength})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.75)';
      ctx.stroke();
    }
  }
}

export function renderPhase4Screen(
  root: HTMLElement,
  vm: Phase4ViewModel,
  handlers: Phase4Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Tracking']),
      el('p', {}, [
        'Phase 4 — pyramidal Lucas-Kanade over the pyramid Phase 2 builds, following the ' +
          'corners Phase 3 finds. Features have a history here for the first time. Nothing ' +
          'spatial is produced: there is no pose, no depth and no geometry yet.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPopulation(vm));
  root.append(renderCrossCheck(vm));
  root.append(renderMotion(vm));
  root.append(renderCost(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));
  root.append(renderNavigation(vm, handlers));
}

function renderPreview(vm: Phase4ViewModel, handlers: Phase4Handlers): HTMLElement {
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
        s.flowFrames > 0
          ? `${s.tracked} filled dots are points carried from the previous frame; ` +
            `${s.redetected} rings are points detection added this frame because §11's ladder ` +
            'asked it to. A frame that is all rings is a frame the tracker kept nothing from, ' +
            'however high the total.'
          : 'Waiting for the first tracked frame.',
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
              : 'TRACKING NOT STARTED';
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
        id: 'start-tracking',
        // Rule 002, and the exact shape of the defect Phase 3 shipped twice: this drives the
        // label AND `disabled`, so it reads the one `running` predicate and nothing else.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'TRACKING' : vm.opening ? 'REQUESTING…' : 'START TRACKING',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-tracking',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('Camera and tracked corners', children);
}

function renderPopulation(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === TrackingState.LOST
      ? 's-PERMISSION_DENIED'
      : s.state === TrackingState.DEGRADED
        ? 's-PERMISSION_REQUIRED'
        : 's-AVAILABLE';

  return card('Population and state (§33)', [
    el('div', { class: 'stat-grid' }, [
      stat('Tracked', s.flowFrames > 0 ? String(s.tracked) : null,
        s.tracked >= DEGRADED_FEATURES ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('Redetected', s.flowFrames > 0 ? String(s.redetected) : null),
      stat('Total', s.flowFrames > 0 ? String(s.total) : null),
      stat('State', s.flowFrames > 0 ? s.state : null, stateClass),
      stat('Longest track', s.maxTrackLength > 0 ? `${s.maxTrackLength} frames` : null),
      stat('Median age', s.medianAge >= 0 ? `${s.medianAge} frames` : null),
      stat('FB error', px(s.medianFbErrorPx),
        s.medianFbErrorPx >= 0 && s.medianFbErrorPx <= FB_ACCEPTABLE_PX ? 's-AVAILABLE' : ''),
      stat('§13 bands', s.flowFrames > 0
        ? `${s.fbAcceptable} ok · ${s.fbReduced} reduced · ${s.fbRejected} rejected`
        : null),
      stat('Failed frames', String(s.consecutiveFailedFrames),
        s.consecutiveFailedFrames > 0 ? 's-PERMISSION_REQUIRED' : ''),
      stat('State mismatches', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Geometry changes', String(s.geometryChanges)),
    ]),
    el('p', { class: 'footnote' }, [
      'Tracked and redetected are separate numbers on purpose. §11’s refill ladder tops the ' +
        'population back up when it falls, so a total near target is compatible with a tracker ' +
        'that lost every point — every survival figure in this phase is computed from the ' +
        'tracked count alone.',
    ]),
    el('p', { class: 'footnote' }, [
      s.stateReason ||
        'The state is a pure function of the measured counts, computed in one place. The ' +
          'mismatch counter above re-derives it from the same inputs and counts any frame ' +
          'where the two answers differ.',
    ]),
    ...(s.goodBlockedBy.length > 0
      ? [
          el('p', { class: 'group-title' }, [`Why not ${TrackingState.GOOD}`]),
          ...s.goodBlockedBy.map((why) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, ['§33 conjunct']),
              el('span', { class: 'cap-state' }, [why]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            `§33 makes GOOD three conditions — features >= ${GOOD_FEATURES}, inlier ratio ` +
              '>= 0.50 and reprojection error <= 2.0 px. Phase 4 can measure the first. The ' +
              'other two are Phase 5’s and Phase 6’s, they have not been written, and a null ' +
              'fails its conjunct — so GOOD is unreachable here rather than being claimed on ' +
              'one condition out of three.',
          ]),
        ]
      : []),
  ]);
}

function renderCrossCheck(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.shiftCheckCount >= MIN_SHIFT_SAMPLES;
  const agreeing = enough && s.medianShiftDisagreementPx >= 0 &&
    s.medianShiftDisagreementPx <= Math.max(2.0, 0.35 * s.medianMeasuredShiftPx);

  return card('Do the points follow the image?', [
    el('div', { class: 'stat-grid' }, [
      stat('Tracker says', px(s.medianTrackedDisplacementPx)),
      stat('Image says', px(s.medianMeasuredShiftPx)),
      stat(
        'Disagreement',
        px(s.medianShiftDisagreementPx),
        enough ? (agreeing ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : '',
      ),
      stat('Cross-checks', enough ? String(s.shiftCheckCount) : `${s.shiftCheckCount} / ${MIN_SHIFT_SAMPLES}`),
      stat('Frames agreeing', pct(s.shiftAgreementRate)),
      // §51 and §H.7: the overlay must sit on the picture. Phase 4 consumes the same
      // positions, so a rotated acquisition route corrupts every displacement above.
      stat(
        'Overlay matches video',
        vm.alignment
          ? !vm.alignment.measurable
            ? 'not measurable — no local texture in this frame'
            : vm.alignment.best === 'identity'
              ? `yes · ${vm.alignment.identityOverRandom.toFixed(1)}× chance`
              : `NO · ${vm.alignment.best} fits ${vm.alignment.bestOverIdentity.toFixed(1)}× better`
          : null,
        vm.alignment
          ? !vm.alignment.measurable
            ? ''
            : vm.alignment.best === 'identity' &&
                vm.alignment.identityOverRandom >= MIN_IDENTITY_OVER_RANDOM
              ? 's-AVAILABLE'
              : 's-PERMISSION_DENIED'
          : '',
      ),
    ]),
    el('p', { class: 'footnote' }, [
      '"Image says" is measured by an integer sum-of-absolute-differences translation search ' +
        'on the pyramid’s top level. It shares no code with the Lucas-Kanade solver, it never ' +
        'reads the feature list, and it keeps its own copy of the previous frame. A tracker ' +
        'that simply returned the points it was given would report 0 here — with a *perfect* ' +
        'forward/backward error, because both directions would agree — and this comparison is ' +
        'the only thing on the screen that could tell.',
    ]),
    el('p', { class: 'footnote' }, [
      'The tolerance is max(2.0 px, 35% of the measured shift): the search is integer-valued ' +
        'on a level a quarter of level 0’s width, so its own resolution is 4 level-0 pixels, ' +
        'and requiring the tracker to match it more precisely than that would be requiring it ' +
        'to reproduce the crudeness.',
    ]),
    el('p', { class: 'footnote' }, [
      'Overlay matches video is measured on this thread from the video element itself, scored ' +
        'against each rotation, flip and transpose. If it says NO the acquisition route is ' +
        'abandoned rather than the drawing corrected — Phase 4 measures displacements in the ' +
        'buffer’s frame, so a corrected overlay over a rotated buffer would be a working-looking ' +
        'screen on wrong numbers.',
    ]),
  ]);
}

function renderMotion(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const row = (
    label: string,
    c: { frames: number; medianSurvival: number; medianDisplacementPx: number; medianFbErrorPx: number },
  ): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [c.frames > 0 ? px(c.medianDisplacementPx) : '']),
      el('span', { class: `cap-state ${c.frames > 0 ? 's-AVAILABLE' : ''}` }, [
        c.frames > 0
          ? `${c.frames} frames · ${pct(c.medianSurvival)} survive · FB ${px(c.medianFbErrorPx)}`
          : 'none yet',
      ]),
    ]);

  return card('Scene motion, measured', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      `Every frame is classified from the image, never from what the phone was asked to do: ` +
        `under ${STATIC_SHIFT_PX} level-0 px of measured shift is static, over ` +
        `${FAST_SHIFT_PX} px is fast, a dark or wholesale-changed frame is occluded. A run ` +
        'where someone believes they held the phone still and a run where the tracker ignored ' +
        'the image produce the same numbers unless the scene is measured separately.',
    ]),
    row('静止 (FLOW-001)', s.staticFrames),
    row('ゆっくり横移動 (FLOW-002)', s.slowFrames),
    row('急速移動 (FLOW-004)', s.fastFrames),
    row('Camera遮断 (FLOW-005)', s.occludedFrames),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('This frame', s.flowFrames > 0 ? s.frameMotion : null),
      stat('Measured shift', s.lastSceneShift ? px(s.lastSceneShift.magnitude0) : null),
      stat('Search confidence', s.lastSceneShift ? String(s.lastSceneShift.confidence) : null),
      stat('Indeterminate', String(s.indeterminateFrames)),
    ]),
    el('p', { class: 'group-title' }, ['ゆっくり回転 (FLOW-003)']),
    el('div', { class: 'stat-grid' }, [
      stat('Gyroscope', s.gyroAvailable ? 'delivering rotationRate' : 'not available',
        s.gyroAvailable ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('Rotating frames', s.gyroAvailable ? String(s.rotatingFrames) : null),
      stat('Median rotation', s.medianRotationDeg >= 0
        ? `${s.medianRotationDeg}° / ${ROTATION_WINDOW_MS} ms` : null),
      stat('Field spread', s.medianSpreadRotating >= 0
        ? `${px(s.medianSpreadRotating)} turning vs ${px(s.medianSpreadTranslating)} panning`
        : null),
    ]),
    el('p', { class: 'footnote' }, [
      s.gyroAvailable
        ? `A frame counts as rotating when the gyroscope integrates at least ${ROTATING_DEG}° ` +
          `over the previous ${ROTATION_WINDOW_MS} ms — a second instrument, independent of ` +
          'both the tracker and the image. A rotation moves image corners by different ' +
          'amounts and a translation does not, so the spread across the 8×6 grid is the ' +
          'measurable difference between the two.'
        : s.gyroReason ||
          'Without the gyroscope there is no independent way to know a frame was rotating ' +
            'rather than translating, so FLOW-003 reports PENDING with that reason instead of ' +
            'being judged.',
    ]),
    ...(s.occlusions.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Occlusion episodes']),
          ...s.occlusions.slice(-4).map((e) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${e.frames} frames dark`]),
              el('span', { class: 'cap-method' }, [
                e.msToLost >= 0 ? `LOST in ${e.msToLost} ms` : 'never LOST',
              ]),
              el('span', { class: `cap-state ${e.recovered ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}` }, [
                e.recovered ? `recovered after ${e.recoveredAfterMs} ms` : 'did not recover',
              ]),
            ]),
          ),
        ]
      : []),
  ]);
}

function renderCost(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanFlowMs >= 0 && s.meanFlowMs <= FLOW_BUDGET_MS;
  return card('Cost (§12’s parameters, §H’s budget)', [
    el('div', { class: 'stat-grid' }, [
      stat('LK solve', s.meanFlowMs >= 0 ? `${s.meanFlowMs} ms` : null,
        s.meanFlowMs >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Budget', `${FLOW_BUDGET_MS} ms`),
      stat('At', s.meanTrackedPoints >= 0 ? `${s.meanTrackedPoints} points` : null),
      stat('Scene search', s.meanShiftMs >= 0 ? `${s.meanShiftMs} ms` : null),
      stat('Window', `${LK_WINDOW}×${LK_WINDOW}`),
      stat('Levels', String(LK_LEVELS)),
      stat('Iterations', `max ${LK_MAX_ITERATIONS}`),
      stat('Epsilon', String(LK_EPSILON)),
    ]),
    el('p', { class: 'footnote' }, [
      `§12 fixes these four parameters and they are not reduced to fit the budget. FLOW-006 is ` +
        'advisory for exactly that reason: §34 ranks correctness above performance, so the ' +
        'measured cost of the specified configuration is reported — including when it is over ' +
        `${FLOW_BUDGET_MS} ms — rather than the configuration being changed until it fits.`,
    ]),
    el('p', { class: 'footnote' }, [
      `Survival on a slow frame must reach ${Math.round(MIN_SURVIVAL_SLOW * 100)}%, and §13 ` +
        `grades every round trip: at or under ${FB_ACCEPTABLE_PX} px acceptable, up to ` +
        `${FB_REDUCED_PX} px reduced confidence, above that rejected and dropped.`,
    ]),
  ]);
}

function renderTests(vm: Phase4ViewModel): HTMLElement {
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
  return card(`Tests — Phase 4 · ${vm.phase4.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase4.state}`, id: 'phase4-verdict' }, [
        vm.phase4.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase4.reason]),
    ...rows,
  ]);
}

function renderEvidence(vm: Phase4ViewModel, handlers: Phase4Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase4-pending-warning' }, [
        `This export would record ${vm.phase4.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p4',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase4.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p4',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}

/** Phase Lock on screen, as on every screen before it: a closed door says which lock holds it. */
function renderNavigation(vm: Phase4ViewModel, handlers: Phase4Handlers): HTMLElement {
  const open = vm.canEnterPhase5 && vm.phase5Implemented;
  const label = !vm.phase5Implemented
    ? 'GEOMETRIC VERIFICATION — NOT IMPLEMENTED'
    : !vm.canEnterPhase5
      ? 'GEOMETRIC VERIFICATION — LOCKED'
      : 'GO TO GEOMETRIC VERIFICATION';
  const note = !vm.phase5Implemented
    ? 'Phase 5 has not been written in this build.'
    : !vm.canEnterPhase5
      ? vm.phase5BlockedReason
      : `Phase 5 is ${vm.phase5.state}.`;

  return card('Navigation', [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase3',
        textContent: 'BACK TO FEATURES',
        onclick: handlers.onBack,
      } as never),
      el('button', {
        class: 'primary',
        id: 'go-to-phase5',
        disabled: !open,
        textContent: label,
        onclick: handlers.onEnterPhase5,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [note]),
  ]);
}
