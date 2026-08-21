/**
 * Phase 0 START screen (§93).
 *
 * The screen is a pure function of engine state: it renders what the registry, the
 * capability matrix and the test results actually say, and it owns no state of its own.
 * The START SCAN control is disabled and labelled with the real reason, because Rule 002
 * forbids a UI that implies capability the engine does not have.
 */

import { CapabilityState, PhaseState, Verdict } from '../core/types';
import type {
  CapabilityGroup,
  CapabilityMatrix,
  CapabilityRecord,
  DeviceInfo,
  EvidenceBundle,
  LogEntry,
  PhaseInfo,
  TestResult,
} from '../core/types';
import { isPhaseImplemented } from '../core/PhaseRegistry';
import type { LegDetermination } from '../debug/EvidenceRecorder';

export interface Phase0ViewModel {
  readonly appVersion: string;
  readonly phase0: PhaseInfo;
  readonly phase1: PhaseInfo;
  readonly canEnterPhase1: boolean;
  readonly matrix: CapabilityMatrix | null;
  readonly results: readonly TestResult[];
  readonly device: DeviceInfo | null;
  readonly leg: LegDetermination | null;
  readonly bundle: EvidenceBundle | null;
  readonly log: readonly LogEntry[];
  readonly detecting: boolean;
  readonly sensorProbeRunning: boolean;
  readonly sensorProbeDone: boolean;
}

export interface Phase0Handlers {
  onProbeSensors: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
  onRerun: () => void;
}

const GROUP_LABELS: Record<CapabilityGroup, string> = {
  platform: 'Platform',
  camera: 'Camera',
  motion: 'Motion sensors',
  compute: 'Compute',
  graphics: 'Graphics',
  media: 'Media',
  storage: 'Storage',
  spatial: 'Spatial (depth / native frameworks)',
};

const GROUP_ORDER: CapabilityGroup[] = [
  'platform', 'camera', 'motion', 'compute', 'graphics', 'media', 'storage', 'spatial',
];

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

/** What the START SCAN control must say, derived from engine state only. */
export function startScanState(
  canEnterPhase1: boolean,
  phase0: PhaseInfo,
): { disabled: boolean; label: string; note: string } {
  const implemented = isPhaseImplemented(1);
  if (!canEnterPhase1) {
    return {
      disabled: true,
      label: 'START SCAN — LOCKED',
      note:
        `Phase Lock (Rule 005): Phase 0 is ${phase0.state}. ${phase0.reason}. ` +
        'Phase 1 cannot be entered until Phase 0 PASSES on a real device.',
    };
  }
  if (!implemented) {
    return {
      disabled: true,
      label: 'START SCAN — PHASE 1 NOT IMPLEMENTED',
      note:
        'Phase 0 has passed, so Phase Lock now permits Phase 1 — but Phase 1 (Camera ' +
        'Capture) has not been written yet. The control stays disabled rather than ' +
        'opening a screen that cannot do anything.',
    };
  }
  return { disabled: false, label: 'START SCAN', note: '' };
}

export function renderPhase0Screen(
  root: HTMLElement,
  vm: Phase0ViewModel,
  handlers: Phase0Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Safari Spatial Mapping']),
      el('p', {}, ['Transform your surroundings into a Spatial World.']),
      el('div', { class: 'build-line' }, [
        `v${vm.appVersion} · phase 0 of 20 · ${vm.device?.osGuess ?? 'device unknown'}`,
      ]),
    ]),
  );

  root.append(renderPrimary(vm, handlers));
  root.append(renderStatusStrip(vm));
  root.append(renderVerdict(vm, handlers));
  root.append(renderTests(vm));
  root.append(renderMatrix(vm));
  root.append(renderEvidence(vm, handlers));
  root.append(renderLog(vm));
  root.append(renderLimitations());
}

function renderPrimary(vm: Phase0ViewModel, handlers: Phase0Handlers): HTMLElement {
  const scan = startScanState(vm.canEnterPhase1, vm.phase0);
  const button = el('button', {
    class: 'primary',
    id: 'start-scan',
    disabled: scan.disabled,
    textContent: scan.label,
  });

  const children: (Node | string)[] = [button];
  if (scan.note) children.push(el('p', { class: 'locked-note' }, [scan.note]));

  const sensorLabel = vm.sensorProbeRunning
    ? 'PROBING SENSORS…'
    : vm.sensorProbeDone
      ? 'RE-PROBE MOTION SENSORS'
      : 'PROBE MOTION SENSORS (REQUIRED)';

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:10px' } as never, [
      el('button', {
        class: 'secondary',
        id: 'probe-sensors',
        disabled: vm.sensorProbeRunning || vm.detecting,
        textContent: sensorLabel,
        onclick: handlers.onProbeSensors,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'rerun-tests',
        disabled: vm.detecting,
        textContent: 'RE-RUN CAPABILITY DETECTION',
        onclick: handlers.onRerun,
      } as never),
    ]),
  );

  if (!vm.sensorProbeDone) {
    children.push(
      el('p', { class: 'footnote' }, [
        'iOS requires a user tap before motion sensors can be requested, so CAP-0004 and ' +
          'CAP-0005 stay PENDING until you tap. PENDING holds the phase at TESTING — it is ' +
          'never treated as a pass.',
      ]),
    );
  }

  return card('Phase 1 entry', children);
}

function chip(key: string, value: string, state?: string): HTMLElement {
  return el('div', { class: 'chip' }, [
    el('div', { class: 'k' }, [key]),
    el('div', { class: `v ${state ? `s-${state}` : ''}` }, [value]),
  ]);
}

function renderStatusStrip(vm: Phase0ViewModel): HTMLElement {
  if (!vm.matrix) {
    return card('Capability', [el('p', { class: 'empty' }, ['Detecting…'])]);
  }
  const find = (id: string): CapabilityRecord | undefined =>
    vm.matrix?.records.find((r) => r.id === id);

  const camera = find('camera.getUserMedia');
  const motion = find('motion.deviceMotion');
  const gpu = find('graphics.webgpu');
  const gl = find('graphics.webgl2');
  const depth = find('spatial.cameraDepth');
  const scale = find('spatial.metricScale');

  const gpuValue =
    gpu?.state === CapabilityState.AVAILABLE
      ? 'WEBGPU'
      : gl?.state === CapabilityState.AVAILABLE
        ? 'WEBGL2'
        : 'CPU';
  const gpuState = gpu?.state === CapabilityState.AVAILABLE
    ? CapabilityState.AVAILABLE
    : gl?.state ?? CapabilityState.UNKNOWN;

  return card('Capability', [
    el('div', { class: 'status-strip' }, [
      chip('Camera', camera?.state ?? 'UNKNOWN', camera?.state),
      chip('Motion', motion?.state ?? 'UNKNOWN', motion?.state),
      chip('GPU', gpuValue, gpuState),
    ]),
    el('div', { class: 'status-strip', style: 'margin-top:8px' } as never, [
      chip('Depth', depth?.state ?? 'UNKNOWN', depth?.state),
      chip('Scale', String(scale?.data['scaleStatus'] ?? 'UNKNOWN'), scale?.state),
      chip('ARKit / RoomPlan', 'UNAVAILABLE', CapabilityState.UNAVAILABLE),
    ]),
  ]);
}

function renderVerdict(vm: Phase0ViewModel, handlers: Phase0Handlers): HTMLElement {
  void handlers;
  const counts = {
    pass: vm.results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: vm.results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: vm.results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  const requiredPending = vm.results.filter(
    (r) => r.spec.required && r.verdict === Verdict.PENDING,
  );

  const children: (Node | string)[] = [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase0.state}`, id: 'phase0-verdict' }, [
        vm.phase0.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase0.reason]),
  ];

  if (requiredPending.length > 0) {
    children.push(
      el('p', { class: 'footnote' }, [
        `Blocked on: ${requiredPending.map((r) => r.spec.id).join(', ')}.`,
      ]),
    );
  }
  if (vm.leg) {
    children.push(
      el('div', { style: 'margin-top:10px' } as never, [
        el('span', { class: `leg-badge ${vm.leg.leg}` }, [`LEG: ${vm.leg.leg}`]),
      ]),
      el('p', { class: 'footnote' }, [vm.leg.explanation]),
    );
  }
  return card('Phase 0 verdict', children);
}

function detailRow(label: string, value: string, mono = false): (Node | string)[] {
  return [el('dt', {}, [label]), el('dd', { class: mono ? 'mono' : '' }, [value])];
}

function renderTests(vm: Phase0ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const rows = vm.results.map((r) => {
    const summary = el('summary', {}, [
      el('span', { class: 'id' }, [r.spec.id]),
      el('span', { class: 'title' }, [r.spec.title]),
      el('span', { class: 'req' }, [r.spec.required ? 'REQ' : 'ADV']),
      el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
    ]);
    const grid = el('dl', { class: 'detail-grid' }, [
      ...detailRow('Input', r.spec.input),
      ...detailRow('Expected', r.spec.expected),
      ...detailRow('Criteria', r.spec.passCriteria),
      ...detailRow('Fail if', r.spec.failureCondition),
      ...detailRow('Observed', r.observed, true),
      ...detailRow('Reason', r.reason),
      ...detailRow('Metrics', JSON.stringify(r.metrics), true),
    ]);
    return el('details', { class: 'row' }, [summary, grid]);
  });
  return card(`Tests — CAP-0001..CAP-${String(vm.results.length).padStart(4, '0')}`, rows);
}

function renderMatrix(vm: Phase0ViewModel): HTMLElement {
  if (!vm.matrix) return card('Capability matrix', [el('p', { class: 'empty' }, ['Detecting…'])]);

  const children: (Node | string)[] = [];
  for (const group of GROUP_ORDER) {
    const records = vm.matrix.records.filter((r) => r.group === group);
    if (records.length === 0) continue;
    children.push(el('div', { class: 'group-title' }, [GROUP_LABELS[group]]));
    for (const r of records) {
      const summary = el('summary', {}, [
        el('span', { class: 'title' }, [r.label]),
        el('span', { class: 'cap-method' }, [shortMethod(r.method)]),
        el('span', { class: `verdict s-${r.state}` }, [r.state]),
      ]);
      const body: (Node | string)[] = [el('p', { class: 'cap-detail' }, [r.detail])];
      if (r.error) body.push(el('p', { class: 'cap-detail s-ERROR' }, [`error: ${r.error}`]));
      if (Object.keys(r.data).length > 0) {
        body.push(el('pre', { class: 'cap-data' }, [JSON.stringify(r.data, null, 1)]));
      }
      body.push(
        el('p', { class: 'cap-data' }, [`id: ${r.id} · probe: ${r.durationMs} ms`]),
      );
      children.push(el('details', { class: 'row' }, [summary, ...body]));
    }
  }
  children.push(
    el('p', { class: 'footnote' }, [
      `${vm.matrix.records.length} capabilities · ${vm.matrix.totalDurationMs} ms of probing. ` +
        'PROBE = the API was executed. PRESENCE = only the symbol was checked. ' +
        'INFER = a guess from the user-agent string, which may not back a pass criterion. ' +
        'NOT-RUN = deliberately not attempted in this phase.',
    ]),
  );
  return card('Capability matrix', children);
}

function shortMethod(method: string): string {
  switch (method) {
    case 'FUNCTIONAL_PROBE': return 'PROBE';
    case 'PRESENCE_CHECK': return 'PRESENCE';
    case 'INFERENCE': return 'INFER';
    default: return 'NOT-RUN';
  }
}

function renderEvidence(vm: Phase0ViewModel, handlers: Phase0Handlers): HTMLElement {
  const children: (Node | string)[] = [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence',
        disabled: !vm.bundle,
        textContent: 'DOWNLOAD EVIDENCE JSON',
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence',
        disabled: !vm.bundle,
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 0 can only PASS on evidence from an iPhone running Safari over HTTPS ' +
        '(Rule 004). Export this file from the device, commit it under ' +
        'docs/phase0/evidence/, and attach a screenshot of this screen.',
    ]),
  ];
  if (vm.bundle) {
    const json = JSON.stringify(vm.bundle, null, 2);
    children.push(
      el('details', { class: 'row' }, [
        el('summary', {}, [
          el('span', { class: 'title' }, ['Show evidence JSON']),
          el('span', { class: 'cap-method' }, [`${Math.round(json.length / 1024)} KB`]),
        ]),
        el('pre', { class: 'json', id: 'evidence-json' }, [json]),
      ]),
    );
  }
  return card('Evidence', children);
}

function renderLog(vm: Phase0ViewModel): HTMLElement {
  const errors = vm.log.filter((e) => e.level === 'ERROR' || e.level === 'WARN');
  if (errors.length === 0) {
    return card('Error log', [
      el('p', { class: 'empty' }, ['No warnings or errors recorded. (Shown explicitly — an ' +
        'empty log is a result, not an omission.)']),
    ]);
  }
  return card(
    'Error log',
    errors.map((e) =>
      el('div', { class: 'log-line' }, [
        el('span', { class: `lvl-${e.level}` }, [`[${e.level}] `]),
        `${e.source}: ${e.message}${e.recovery ? ` → recovery: ${e.recovery}` : ''}`,
      ]),
    ),
  );
}

function renderLimitations(): HTMLElement {
  return card('Known platform limits', [
    el('p', { class: 'footnote' }, [
      'DEPTH: UNAVAILABLE — no Web API exposes iPhone depth or LiDAR to Safari. ' +
        'ARKit: UNAVAILABLE. RoomPlan: UNAVAILABLE — neither has a JavaScript API. ' +
        'SCALE: UNKNOWN — a monocular camera carries no absolute scale, so the world will ' +
        'be built in local units until something actually measures one. ' +
        'These are measured absences, not pending work.',
    ]),
  ]);
}

/** Read the live DOM so a test can compare UI state against engine state, not a mirror of it. */
export function readUiSnapshot(): { startScanDisabled: boolean; startScanLabel: string } {
  const btn = document.getElementById('start-scan') as HTMLButtonElement | null;
  return {
    startScanDisabled: btn ? btn.disabled : true,
    startScanLabel: btn ? (btn.textContent ?? '') : 'START SCAN button not rendered',
  };
}

export { PhaseState, Verdict };
