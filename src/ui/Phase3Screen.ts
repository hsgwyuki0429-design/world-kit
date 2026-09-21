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
import { card, el, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase3ViewModel {
  readonly phase3: PhaseInfo;
  readonly phase4: PhaseInfo;
  readonly canEnterPhase4: boolean;
  readonly phase4Implemented: boolean;
  readonly phase4BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase4LockNote: string;
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
  onEnterPhase4: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
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
      el('h1', {}, ['特徴点']),
      el('p', {}, [
        'Phase 3 — Phase 2 が作るピラミッド上の Shi-Tomasi コーナー。各点は1枚の画像の中の' +
          '1つのコーナーです。まだ点をフレーム間で追ってはおらず、空間的なものも作っていません。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPopulation(vm));
  root.append(renderScene(vm));
  root.append(renderProvenance(vm));
  root.append(testsSection(3, vm.phase3, vm.results));
  root.append(
    evidenceSection(3, vm.phase3, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );

  root.append(
    navigationSection(
      { index: 2, label: 'フレームパイプラインへ戻る', onClick: handlers.onBack },
      {
        index: 4,
        name: 'オプティカルフロー追跡',
        phase: vm.phase4,
        canEnter: vm.canEnterPhase4,
        implemented: vm.phase4Implemented,
        blockedReason: vm.phase4BlockedReason,
        lockNote: vm.phase4LockNote,
        onClick: handlers.onEnterPhase4,
      },
    ),
  );
}

/** Phase Lock on screen, as on the screens before it: a closed door says which lock holds it. */

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
          ? `${s.detectWidth}×${s.detectHeight} の level-${s.detectLevel} 画像上に、` +
            `検出器が報告した位置そのままで ${s.count} 個のコーナーを描いています。` +
            '半径と色は各コーナーの実測品質に従います。§51 は、見つかった場所以外に' +
            '点を描くことを禁じています。'
          : '最初の検出を待っています。',
      ]),
    );
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
              : '検出は未起動です';
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
        textContent: vm.running ? '検出中' : vm.opening ? '要求中…' : '特徴点検出開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-detection',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('カメラと検出されたコーナー', children);
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

  return card('特徴点の数', [
    el('div', { class: 'stat-grid' }, [
      stat('特徴点', s.detections > 0 ? String(s.count) : null, countClass),
      stat('状態', s.detections > 0 ? s.state.replace(/_/g, ' ') : null, stateClass),
      stat('目標', String(FEATURE_TARGET)),
      stat('セルあたりの上限', s.quota > 0 ? String(s.quota) : null),
      stat('使われたセル', s.detections > 0 ? `${s.occupiedCells} / ${GRID_COLS * GRID_ROWS}` : null),
      stat('最大のセル', s.detections > 0 ? `${Math.round(s.maxCellShare * 1000) / 10}%` : null),
      stat('検出回数', String(s.detections)),
      stat('検出コスト', s.detections > 0 ? `${s.meanDetectCostMs} ms` : null,
        s.meanDetectCostMs >= 0 && s.meanDetectCostMs <= DETECT_BUDGET_MS ? 's-AVAILABLE' : ''),
      stat('補充', String(s.refills.length)),
      stat('上限の超過', String(s.quotaBreaches), s.quotaBreaches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('最大数の超過', String(s.overMaxFrames), s.overMaxFrames > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('状態の不一致', String(s.stateMismatches), s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `§11 の段階: 500 未満で補充、200 未満で緊急に補充、${FEATURE_MIN} 未満で LOW ` +
        'FEATURE COUNT、80 未満で TRACKING DEGRADED。上に出ている状態は、上に出ている' +
        '個数から導かれます。両者が食い違うことはあり得ず、食い違ったフレームがあれば' +
        '「状態の不一致」に数えられます。',
    ]),
    ...(s.refills.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近の補充']),
          ...s.refills.slice(-5).map((r) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${r.urgency} · ${r.texture}`]),
              el('span', { class: 'cap-method' }, [r.exhausted ? '候補が尽きた' : '回復した']),
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
        c.frames > 0 ? `${c.frames} フレーム · 中央値 ${c.medianCount}` : 'まだなし',
      ]),
    ]);

  return card('シーン', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      `各フレームは自分の平均勾配の大きさで分類されます。${TEXTURE_RICH_FLOOR} 以上なら` +
        `構造あり、${TEXTURE_POOR_CEILING} 以下なら平坦、その中間はどちらのテストでも` +
        '判定しません。これは画像から計測しています。カメラをどこに向けたかと、' +
        'カメラが何を見たかは別のことです。',
    ]),
    row('構造のある面（FEAT-001）', s.textureRich),
    row('平坦な面（FEAT-002）', s.texturePoor),
    row('どちらとも言えない', s.textureAmbiguous),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('いまの ∇', s.detections > 0 ? String(s.meanGradient) : null),
      stat('分類', s.detections > 0 ? s.texture.replace('TEXTURE_', '') : null),
      stat('検出レベル', s.detections > 0 ? String(s.detectLevel) : null),
      stat('検出サイズ', s.detectWidth > 0 ? `${s.detectWidth}×${s.detectHeight}` : null),
    ]),
    ...(s.texturePoor.frames === 0
      ? [
          el('p', { class: 'footnote' }, [
            'FEAT-002 には平坦な面が必要です。2秒ほどそちらに向けてから戻してください。' +
              '同じ動きが FEAT-004 の補充の段階も動かします。',
          ]),
        ]
      : []),
  ]);
}

function renderProvenance(vm: Phase3ViewModel): HTMLElement {
  const s = vm.stats;
  const ok = s.medianAboveChance >= MIN_CONTRAST_ABOVE_CHANCE;
  const cal = s.level0Calibration;
  return card('これは本当にコーナーか？', [
    el('div', { class: 'stat-grid' }, [
      stat(
        '偶然を上回る割合',
        s.contrastSamples > 0 ? `${Math.round(s.medianAboveChance * 1000) / 10}%` : null,
        s.contrastSamples > 0 ? (ok ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : '',
      ),
      stat('サンプル数', s.contrastSamples > 0 ? String(s.contrastSamples) : null),
      stat('グリッドの比較回数', s.grid.samples > 0 ? String(s.grid.samples) : null),
      // §51: the overlay must sit on the picture, and on a phone that is not the same claim
      // as the contrast statistic above — which is computed in the worker on the worker's
      // own buffer and so cannot see a rotated one.
      stat(
        '重ね描きと映像の一致',
        vm.alignment
          ? !vm.alignment.measurable
            ? '計測不能 — このフレームには局所的な模様がありません'
            : vm.alignment.best === 'identity'
              ? `一致 · 偶然の ${vm.alignment.identityOverRandom.toFixed(1)} 倍`
              : `不一致 · ${vm.alignment.best} のほうが ${vm.alignment.bestOverIdentity.toFixed(1)} 倍よく合う`
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
      stat(
        '偏り',
        s.grid.samples > 0
          ? `${Math.round(s.grid.medianGridded * 1000) / 10}% vs ${Math.round(s.grid.medianUngridded * 1000) / 10}%`
          : null,
      ),
    ]),
    el('p', { class: 'footnote' }, [
      '「偶然を上回る割合」は、検出された位置が、同じフレーム内の乱数で選んだ位置より' +
        '局所的な模様を多く持っている確率です。画像と無関係な座標を出す検出器は、' +
        '構造上ちょうど 50% になります。つまり 50% からの隔たりが、シーンではなく' +
        `検出器を測っていることになります。FEAT-001 は ${Math.round(MIN_CONTRAST_ABOVE_CHANCE * 100)}% を要求します。`,
    ]),
    el('p', { class: 'footnote' }, [
      '「重ね描きと映像の一致」は、このスレッドで、この要素から計測しています。' +
        'ページが映像そのものを読み、描かれた位置を回転・反転・転置のそれぞれと突き合わせて' +
        '採点します。恒等変換が勝たなければいけません。1つ上の検査はこれを見られません。' +
        'あちらはワーカーが自分のバッファ上で走らせるので、画面に対して回転したバッファでも' +
        '同じ点が取れてしまうからです。ここが「不一致」なら、描画を直すのではなく取得経路を' +
        '捨てます。Phase 4 が同じ位置を読むからです。',
    ]),
    el('p', { class: 'footnote' }, [
      '「偏り」は、8×6 の上限を課したときの最大セル占有率を、同じフレームの同じ候補から' +
        '上限なしで選んだ場合と比べたものです。もともと均等に散らばるシーンでは差が出ません。' +
        'それがこの比較の狙いです。',
    ]),
    ...(cal
      ? [
          el('p', { class: 'footnote' }, [
            `level-0 での較正: ${cal.width}×${cal.height} で検出すると ${cal.detectMs} ms かかり、` +
              `${cal.features} 個の特徴点が見つかっていました（この端末で1回だけ計測）。` +
              `実際の検出は level ${s.detectLevel} で ${s.meanDetectCostMs} ms です。`,
          ]),
        ]
      : []),
  ]);
}

