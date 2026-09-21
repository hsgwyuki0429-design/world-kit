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
import { LOCKED_LABEL, NOT_IMPLEMENTED_LABEL } from '../core/controlLabels';
import { card, el } from './dom';

export interface Phase0ViewModel {
  readonly appVersion: string;
  readonly phase0: PhaseInfo;
  readonly phase1: PhaseInfo;
  readonly canEnterPhase1: boolean;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase1LockNote: string;
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
  onStartScan: () => void;
  onProbeSensors: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
  onRerun: () => void;
}

const GROUP_LABELS: Record<CapabilityGroup, string> = {
  platform: 'プラットフォーム',
  camera: 'カメラ',
  motion: 'モーションセンサー',
  compute: '演算',
  graphics: 'グラフィックス',
  media: 'メディア',
  storage: 'ストレージ',
  spatial: '空間（深度 / ネイティブ機能）',
};

const GROUP_ORDER: CapabilityGroup[] = [
  'platform', 'camera', 'motion', 'compute', 'graphics', 'media', 'storage', 'spatial',
];

/** What the START SCAN control must say, derived from engine state only. */
export function startScanState(
  canEnterPhase1: boolean,
  phase0: PhaseInfo,
  lockNote = '',
): { disabled: boolean; label: string; note: string } {
  const implemented = isPhaseImplemented(1);
  if (!canEnterPhase1) {
    return {
      disabled: true,
      label: `スキャン開始 — ${LOCKED_LABEL}`,
      note:
        `Phase Lock（Rule 005）: Phase 0 は ${phase0.state} です。${phase0.reason}。` +
        'Phase 0 が実機で PASSED になるまで Phase 1 には入れません。',
    };
  }
  if (!implemented) {
    return {
      disabled: true,
      label: `スキャン開始 — Phase 1 は${NOT_IMPLEMENTED_LABEL}`,
      note:
        'Phase 0 は合格したので Phase Lock は Phase 1 を許可していますが、Phase 1' +
        '（カメラ取得）がまだ書かれていません。何もできない画面を開くより、' +
        'ボタンを無効のままにしています。',
    };
  }
  // Open, and normally with nothing to add. The exception is a lock opened by a pass this
  // device recorded in an earlier page load: Phase 0 then reads TESTING beside an enterable
  // control, which is what a Phase Lock failing open would also look like (Rule 002).
  return { disabled: false, label: 'スキャン開始', note: lockNote };
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
      el('p', {}, ['身のまわりの空間を、そのまま Spatial World にする。']),
      el('div', { class: 'build-line' }, [
        `v${vm.appVersion} · phase 0 / 20 · ${vm.device?.osGuess ?? '端末不明'}`,
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
  const scan = startScanState(vm.canEnterPhase1, vm.phase0, vm.phase1LockNote);
  const button = el('button', {
    class: 'primary',
    id: 'start-scan',
    disabled: scan.disabled,
    textContent: scan.label,
    onclick: handlers.onStartScan,
  } as never);

  const children: (Node | string)[] = [button];
  if (scan.note) children.push(el('p', { class: 'locked-note' }, [scan.note]));

  const sensorLabel = vm.sensorProbeRunning
    ? 'センサーを確認中…'
    : vm.sensorProbeDone
      ? 'モーションセンサーを再確認'
      : 'モーションセンサーを確認（必須）';

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
        textContent: '環境チェックをやり直す',
        onclick: handlers.onRerun,
      } as never),
    ]),
  );

  if (!vm.sensorProbeDone) {
    children.push(
      el('p', { class: 'footnote' }, [
        'iOS はモーションセンサーの要求の前にタップを求めるので、タップするまで ' +
          'CAP-0004 と CAP-0005 は PENDING のままです。PENDING はフェーズを TESTING に' +
          '留め置きます。合格として扱われることはありません。',
      ]),
    );
  }

  return card('Phase 1 への入口', children);
}

function chip(key: string, value: string, state?: string): HTMLElement {
  return el('div', { class: 'chip' }, [
    el('div', { class: 'k' }, [key]),
    el('div', { class: `v ${state ? `s-${state}` : ''}` }, [value]),
  ]);
}

function renderStatusStrip(vm: Phase0ViewModel): HTMLElement {
  if (!vm.matrix) {
    return card('環境', [el('p', { class: 'empty' }, ['確認中…'])]);
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

  return card('環境', [
    el('div', { class: 'status-strip' }, [
      chip('カメラ', camera?.state ?? 'UNKNOWN', camera?.state),
      chip('モーション', motion?.state ?? 'UNKNOWN', motion?.state),
      chip('GPU', gpuValue, gpuState),
    ]),
    el('div', { class: 'status-strip', style: 'margin-top:8px' } as never, [
      chip('深度', depth?.state ?? 'UNKNOWN', depth?.state),
      chip('スケール', String(scale?.data['scaleStatus'] ?? 'UNKNOWN'), scale?.state),
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
        `未決のため保留: ${requiredPending.map((r) => r.spec.id).join(', ')}。`,
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
  return card('Phase 0 の判定', children);
}

function detailRow(label: string, value: string, mono = false): (Node | string)[] {
  return [el('dt', {}, [label]), el('dd', { class: mono ? 'mono' : '' }, [value])];
}

function renderTests(vm: Phase0ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('テスト', [el('p', { class: 'empty' }, ['まだ実行していません。'])]);
  }
  const rows = vm.results.map((r) => {
    const summary = el('summary', {}, [
      el('span', { class: 'id' }, [r.spec.id]),
      el('span', { class: 'title' }, [r.spec.title]),
      el('span', { class: 'req' }, [r.spec.required ? '必須' : '参考']),
      el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
    ]);
    const grid = el('dl', { class: 'detail-grid' }, [
      ...detailRow('入力', r.spec.input),
      ...detailRow('期待される結果', r.spec.expected),
      ...detailRow('合格条件', r.spec.passCriteria),
      ...detailRow('不合格の条件', r.spec.failureCondition),
      ...detailRow('観測値', r.observed, true),
      ...detailRow('理由', r.reason),
      ...detailRow('計測値', JSON.stringify(r.metrics), true),
    ]);
    return el('details', { class: 'row' }, [summary, grid]);
  });
  return card(`テスト — CAP-0001..CAP-${String(vm.results.length).padStart(4, '0')}`, rows);
}

function renderMatrix(vm: Phase0ViewModel): HTMLElement {
  if (!vm.matrix) return card('環境の一覧', [el('p', { class: 'empty' }, ['確認中…'])]);

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
      if (r.error) body.push(el('p', { class: 'cap-detail s-ERROR' }, [`エラー: ${r.error}`]));
      if (Object.keys(r.data).length > 0) {
        body.push(el('pre', { class: 'cap-data' }, [JSON.stringify(r.data, null, 1)]));
      }
      body.push(
        el('p', { class: 'cap-data' }, [`id: ${r.id} · 確認にかかった時間: ${r.durationMs} ms`]),
      );
      children.push(el('details', { class: 'row' }, [summary, ...body]));
    }
  }
  children.push(
    el('p', { class: 'footnote' }, [
      `${vm.matrix.records.length} 項目 · 確認にかかった時間 ${vm.matrix.totalDurationMs} ms。` +
        'PROBE = API を実際に実行した。PRESENCE = シンボルの有無だけを見た。' +
        'INFER = user-agent 文字列からの推測で、合格条件の根拠にはできない。' +
        'NOT-RUN = このフェーズでは意図的に試していない。',
    ]),
  );
  return card('環境の一覧', children);
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
  // The export is allowed at any verdict — a failing bundle is exactly what you want to
  // send when diagnosing — but the control has to say what it is about to hand you.
  // A TESTING bundle downloaded by mistake and filed as proof of a pass is a real failure
  // mode, and it is silent unless the button names the verdict.
  const pending = vm.results.filter(
    (r) => r.spec.required && r.verdict === Verdict.PENDING,
  );
  const verdictSuffix = vm.bundle ? ` — ${vm.bundle.overallVerdict}` : '';

  const children: (Node | string)[] = [];

  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'evidence-pending-warning' }, [
        `この書き出しは ${vm.bundle?.overallVerdict ?? 'TESTING'} として記録されます。` +
          `合格ではありません — ${pending.map((r) => r.spec.id).join('と')} が` +
          'まだ PENDING です。先に上の「モーションセンサーを確認」を押してから書き出してください。',
      ]),
    );
  }

  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence',
        disabled: !vm.bundle,
        textContent: `エビデンス JSON をダウンロード${verdictSuffix}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence',
        disabled: !vm.bundle,
        textContent: `エビデンス JSON をコピー${verdictSuffix}`,
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 0 が PASSED になれるのは、iPhone の Safari を HTTPS で動かした実機の' +
        'エビデンスだけです（Rule 004）。このファイルを端末から書き出し、' +
        'docs/phase0/evidence/ にコミットして、この画面のスクリーンショットを添えてください。' +
        '判定はファイル名に入るので、TESTING の書き出しを合格と取り違えることはありません。',
    ]),
  );
  if (vm.bundle) {
    const json = JSON.stringify(vm.bundle, null, 2);
    children.push(
      el('details', { class: 'row' }, [
        el('summary', {}, [
          el('span', { class: 'title' }, ['エビデンス JSON を表示']),
          el('span', { class: 'cap-method' }, [`${Math.round(json.length / 1024)} KB`]),
        ]),
        el('pre', { class: 'json', id: 'evidence-json' }, [json]),
      ]),
    );
  }
  return card('エビデンス', children);
}

function renderLog(vm: Phase0ViewModel): HTMLElement {
  const errors = vm.log.filter((e) => e.level === 'ERROR' || e.level === 'WARN');
  if (errors.length === 0) {
    return card('エラーログ', [
      el('p', { class: 'empty' }, ['警告もエラーも記録されていません。' +
        '（空であることを明示しています。空のログは結果であって、省略ではありません。）']),
    ]);
  }
  return card(
    'エラーログ',
    errors.map((e) =>
      el('div', { class: 'log-line' }, [
        el('span', { class: `lvl-${e.level}` }, [`[${e.level}] `]),
        `${e.source}: ${e.message}${e.recovery ? ` → 復旧: ${e.recovery}` : ''}`,
      ]),
    ),
  );
}

function renderLimitations(): HTMLElement {
  return card('このプラットフォームの限界', [
    el('p', { class: 'footnote' }, [
      '深度: UNAVAILABLE — iPhone の深度や LiDAR を Safari に渡す Web API は存在しません。' +
        'ARKit: UNAVAILABLE。RoomPlan: UNAVAILABLE — どちらにも JavaScript API がありません。' +
        'スケール: UNKNOWN — 単眼カメラは絶対スケールを持たないので、何かが実際に測るまで' +
        '世界はローカル単位で組み立てられます。' +
        'これらは計測された不在であって、未着手の作業ではありません。',
    ]),
  ]);
}

/** Read the live DOM so a test can compare UI state against engine state, not a mirror of it. */
export function readUiSnapshot(): { startScanDisabled: boolean; startScanLabel: string } {
  const btn = document.getElementById('start-scan') as HTMLButtonElement | null;
  return {
    startScanDisabled: btn ? btn.disabled : true,
    startScanLabel: btn ? (btn.textContent ?? '') : 'スキャン開始ボタンが描画されていません',
  };
}

export { PhaseState, Verdict };
