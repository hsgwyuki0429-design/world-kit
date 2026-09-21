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

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import { STRIP_W, STRIP_H } from '../pipeline/pyramid';
import { REQUIRED_PIPELINE_MS, UI_BUDGET_MS } from '../testkit/Phase2Tests';
import type { PipelineStats } from '../pipeline/stats';
import { card, el, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase2ViewModel {
  readonly phase2: PhaseInfo;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly stats: PipelineStats;
  readonly strip: { data: Uint8Array; width: number; height: number } | null;
  readonly results: readonly TestResult[];
  readonly stressRefusal: string | null;
  /** Phase 3's state, so the control that leads to it can say why it is closed. */
  readonly phase3: PhaseInfo;
  readonly canEnterPhase3: boolean;
  readonly phase3Implemented: boolean;
  readonly phase3BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase3LockNote: string;
}

export interface Phase2Handlers {
  onStartCamera: () => void;
  onStopPipeline: () => void;
  onToggleStress: () => void;
  onBack: () => void;
  onEnterPhase3: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
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
      el('h1', {}, ['フレームパイプライン']),
      el('p', {}, [
        'Phase 2 — フレームを前処理ワーカーへ。グレースケールのピラミッドを作って計測します。' +
          'まだ誰もそれを使っておらず、空間的なものは何も作っていません。',
      ]),
    ]),
  );

  root.append(renderImages(vm, handlers));
  root.append(renderThroughput(vm));
  root.append(renderLatency(vm));
  root.append(renderAdaptation(vm, handlers));
  root.append(renderRoutes(vm));
  root.append(testsSection(2, vm.phase2, vm.results));
  root.append(
    evidenceSection(2, vm.phase2, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );

  root.append(
    navigationSection(
      { index: 1, label: 'カメラ取得へ戻る', onClick: handlers.onBack },
      {
        index: 3,
        name: '特徴点検出',
        phase: vm.phase3,
        canEnter: vm.canEnterPhase3,
        implemented: vm.phase3Implemented,
        blockedReason: vm.phase3BlockedReason,
        lockNote: vm.phase3LockNote,
        onClick: handlers.onEnterPhase3,
      },
    ),
  );
}

/** Phase Lock on screen, as on the Phase 1 screen: a closed door says which lock holds it. */

function renderImages(vm: Phase2ViewModel, handlers: Phase2Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;

  if (vm.trackLive) {
    children.push(el('div', { class: 'preview-frame' }, [getPreviewVideo()]));
  } else {
    const message =
      vm.cameraState === CameraState.PERMISSION_DENIED
        ? 'カメラの許可が拒否されました'
        : vm.cameraState === CameraState.UNAVAILABLE
          ? 'カメラを利用できません'
          : vm.cameraState === CameraState.ENDED
            ? 'カメラが終了しました — トラックが停止されました。別のアプリによる可能性が高いです'
            : vm.opening
              ? 'カメラを要求中…'
              : 'パイプラインは未起動です';
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
        `ワーカーの出力 — ${STRIP_W}×${STRIP_H} のグレースケール。ワーカーが自分で作った ` +
          `${s.procWidth}×${s.procHeight} の level-0 バッファから縮小したものです。` +
          'これはワーカー自身のバイト列であって、映像の2つ目のコピーではありません。',
      ]),
    );
  } else if (s.running) {
    children.push(el('p', { class: 'empty' }, ['ワーカーの出力はまだありません。']));
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-pipeline',
        disabled: vm.opening || s.running,
        textContent: s.running ? 'パイプライン動作中' : vm.opening ? '要求中…' : 'パイプライン開始',
        onclick: handlers.onStartCamera,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-pipeline',
        disabled: !s.running,
        textContent: 'パイプライン停止',
        onclick: handlers.onStopPipeline,
      } as never),
    ]),
  );

  return card('カメラとワーカーの出力', children);
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

  return card('スループット', [
    el('div', { class: 'stat-grid' }, [
      stat('入力', s.sourceWidth > 0 ? `${s.sourceWidth}×${s.sourceHeight}` : null),
      stat('処理解像度', s.procWidth > 0 ? `${s.procWidth}×${s.procHeight}` : null),
      stat('実測 fps', s.completed > 1 ? String(s.deliveredFps) : null),
      stat('カメラの fps', s.callbacks > 1 ? String(s.sourceFps) : null),
      stat('目標 fps', String(s.targetFps)),
      stat('完了', s.completed > 0 ? String(s.completed) : null),
      stat('受け入れ', s.admitted > 0 ? String(s.admitted) : null),
      stat('間引き', String(s.pacedOut)),
      stat('詰まりで見送り', String(s.backpressured)),
      stat('消失', String(s.lost), s.lost > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('消失率', s.admitted > 0 ? `${(lostRatio * 100).toFixed(2)}%` : null),
      stat(
        '負荷なしの連続',
        s.completed > 0 ? `${cleanSeconds.toFixed(1)} / ${target} s` : null,
        continuityClass,
      ),
      stat('最長の途切れ', s.completed > 1 ? `${clean?.maxGapMs ?? s.maxResultGapMs} ms` : null),
    ]),
    el('p', { class: 'footnote' }, [
      '間引き = 目標レートがカメラのレートより低いので、スケジューラがそのフレームを' +
        '見送った。詰まりで見送り = ワーカーがまだ処理中だった。どちらも「落とした」ではありません。' +
        '消失 = ワーカーに渡したまま返ってこなかったもので、FRAME-001 がパイプラインの責任と' +
        'みなすのはこれだけです。実測レートはカメラのレートを超えられないので、' +
        'コントローラは両者の低いほうを基準に判定します。',
    ]),
    ...(s.wasEverHidden
      ? [
          el('p', { class: 'evidence-warning' }, [
            `ページが ${s.hiddenCount} 回バックグラウンドに回りました。隠れている間は` +
              'フレームコールバックが止まるので、この実行では 30 秒の供給を示せません。' +
              'アプリから離れずにパイプラインを開始し直してください。',
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

  return card('遅延と出どころ', [
    el('div', { class: 'stat-grid' }, [
      stat('UI コスト 平均', shown(s.uiCostMs.mean, s.uiCostMs.count), uiClass),
      stat('UI コスト p95', shown(s.uiCostMs.p95, s.uiCostMs.count), uiClass),
      stat('取得 平均', shown(s.acquireMs.mean, s.acquireMs.count)),
      stat('ワーカー 平均', shown(s.workerMs.mean, s.workerMs.count)),
      stat('ワーカー p95', shown(s.workerMs.p95, s.workerMs.count)),
      stat('往復 p95', shown(s.roundTripMs.p95, s.roundTripMs.count)),
      stat('突き合わせ回数', s.crossCheck.count > 0 ? String(s.crossCheck.count) : null),
      stat(
        '輝度差 Δ 中央値',
        s.crossCheck.count > 0 ? String(s.crossCheck.medianAbsDifference) : null,
      ),
      stat('輝度差 Δ 最大', s.crossCheck.count > 0 ? String(s.crossCheck.maxAbsDifference) : null),
      stat('突き合わせのコスト', shown(s.crossCheck.costMs.mean, s.crossCheck.costMs.count)),
      stat('ストリップ Δ ピーク', s.stripMadSamples > 0 ? String(s.stripMadMax) : null),
      stat(
        'ピラミッド',
        s.pyramidLevels.length > 0
          ? s.pyramidLevels.map((l) => `${l.width}×${l.height}`).join(' / ')
          : null,
        s.pyramidConsistent ? 's-AVAILABLE' : '',
      ),
    ]),
    el('p', { class: 'footnote' }, [
      '輝度差 Δ は、ワーカーのグレースケールを、同じ映像フレームをこのスレッドで独立に' +
        '読み取った結果と突き合わせたものです。その読み取りは §H.1 がパイプライン用には' +
        '却下した重い経路なので、1秒に1回だけ走らせ、そのコストは UI コストに混ぜずに' +
        '上に別立てで出しています。',
    ]),
    ...(s.pyramidProblems.length > 0
      ? [el('p', { class: 'evidence-warning' }, [s.pyramidProblems.join('; ')])]
      : []),
    ...(s.workerErrors.length > 0
      ? [el('p', { class: 'evidence-warning' }, [`ワーカーのエラー: ${s.workerErrors.join(' | ')}`])]
      : []),
  ]);
}

function renderAdaptation(vm: Phase2ViewModel, handlers: Phase2Handlers): HTMLElement {
  const s = vm.stats;
  const children: (Node | string)[] = [
    el('div', { class: 'stat-grid' }, [
      stat('段', s.tierLabel, s.tierStep <= 1 ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('段の位置', String(s.tierStep)),
      stat('段の移動回数', String(s.decisions.length)),
      stat('注入した負荷', s.stressPasses > 0 ? `追加 ${s.stressPasses} パス` : 'なし'),
    ]),
  ];

  if (s.tierUsage.length > 0) {
    children.push(
      el('p', { class: 'group-title' }, ['段ごとに作られたフレーム数']),
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
      el('p', { class: 'group-title' }, ['段の移動と、その原因']),
      ...s.decisions.map((d, i) => {
        const outcome = s.decisionOutcomes.find((o) => o.decisionIndex === i);
        return el('details', { class: 'row' }, [
          el('summary', {}, [
            el('span', { class: 'id' }, [d.direction]),
            el('span', { class: 'title' }, [`${d.fromLabel} → ${d.toLabel}`]),
            el('span', { class: 'verdict' }, [`${d.medianWorkerMs} ms`]),
          ]),
          el('dl', { class: 'detail-grid' }, [
            el('dt', {}, ['理由']),
            el('dd', {}, [d.reason]),
            el('dt', {}, ['効果']),
            el('dd', { class: 'mono' }, [
              outcome
                ? `ワーカー遅延の中央値 ${outcome.beforeMedianWorkerMs} ms → ` +
                  `${outcome.afterMedianWorkerMs} ms（以降 ${outcome.samples} フレーム）`
                : 'まだ計測できていません',
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
        textContent: s.stressPasses > 0 ? '負荷の注入を止める' : '負荷を注入する',
        onclick: handlers.onToggleStress,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [
      '予算を満たしている端末は自分から性能を落としたりしないので、FRAME-003 と FRAME-004 には' +
        '負荷が要ります。この負荷は本物の仕事です — ワーカーが実際に作ったピラミッドへの' +
        '追加パスで、そのパス数はこの端末で1パスにかかる実測コストから決めています。' +
        'これは刺激であって、そのあとコントローラが見る遅延はどれも依然として計測値です。',
    ]),
  );

  if (vm.stressRefusal) {
    children.push(el('p', { class: 'evidence-warning' }, [vm.stressRefusal]));
  }
  if (s.spontaneousDegrade) {
    children.push(
      el('p', { class: 'evidence-warning' }, [
        '負荷を注入していないのに、少なくとも1回は段を下げています。この端末は自力では' +
          'その段を維持できなかったということです。これは本物の結果であり、そのまま記録されます。',
      ]),
    );
  }

  return card('適応', children);
}

function renderRoutes(vm: Phase2ViewModel): HTMLElement {
  const s = vm.stats;
  const scope = s.workerScope;
  return card('取得経路とワーカー', [
    ...s.routeProbes.map((r) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [r.route]),
        el('span', { class: 'cap-method' }, [r.attempts > 0 ? `${r.meanAcquireMs} ms` : '']),
        el('span', { class: `cap-state ${r.ok ? 's-AVAILABLE' : 's-UNKNOWN'}` }, [r.note]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      '経路は順に試し、実際に往復が成立した最初のものを採用します。最後の1つは §H.1 が' +
        'この端末で 13.8 ms と計測したメインスレッド読み戻しです。使えないと決めつけるのではなく、' +
        '明示した代替手段として、計測したまま残してあります。',
    ]),
    el('p', { class: 'group-title' }, ['ワーカーのスコープ']),
    el('p', { class: 'cap-data' }, [
      scope
        ? `document: ${scope.hasDocument} · WorkerGlobalScope: ${scope.isWorkerGlobalScope} · ` +
          `OffscreenCanvas 2D: ${scope.canvas2dAvailable} · cores: ${scope.hardwareConcurrency}`
        : 'ワーカーからの報告がありません',
    ]),
  ]);
}

