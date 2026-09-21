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
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase2LockNote: string;
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
      el('h1', {}, ['スキャン']),
      el('p', {}, ['Phase 1 — カメラ取得。まだ空間的なものは何も作っていません。']),
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
      { index: 0, label: '環境チェックへ戻る', onClick: handlers.onBack },
      {
        index: 2,
        name: 'フレームパイプライン',
        phase: vm.phase2,
        canEnter: vm.canEnterPhase2,
        implemented: vm.phase2Implemented,
        blockedReason: vm.phase2BlockedReason,
        lockNote: vm.phase2LockNote,
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
        ? 'カメラの許可が拒否されました'
        : vm.cameraState === CameraState.UNAVAILABLE
          ? 'カメラを利用できません'
          : vm.cameraState === CameraState.ENDED
            ? 'カメラが終了しました — トラックが停止されました。別のアプリによる可能性が高いです'
            : vm.opening
              ? 'カメラを要求中…'
              : 'カメラは未起動です';
    children.push(
      el('div', { class: 'preview-frame empty', id: 'preview-empty' }, [
        el('div', { class: 'preview-message' }, [message]),
      ]),
    );
    if (failure) {
      children.push(
        el('p', { class: 'locked-note' }, [`${failure.errorName}: ${failure.message}`]),
        el('p', { class: 'footnote' }, [`復旧: ${failure.recovery}`]),
      );
    }
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-camera',
        disabled: vm.opening || vm.trackLive,
        textContent: vm.trackLive ? 'カメラ動作中' : vm.opening ? '要求中…' : 'カメラ開始',
        onclick: handlers.onStartCamera,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-camera',
        disabled: !vm.trackLive,
        textContent: 'カメラ停止',
        onclick: handlers.onStopCamera,
      } as never),
    ]),
  );

  return card('カメラ', children);
}

function renderOverlayStats(vm: Phase1ViewModel): HTMLElement {
  const s = vm.stats;
  const settings = vm.settings;
  const secondsHeld = s.observedMs / 1000;
  const target = REQUIRED_CAPTURE_MS / 1000;

  const captureClass =
    s.observedMs >= REQUIRED_CAPTURE_MS ? 's-AVAILABLE' : s.frameCount > 0 ? 's-PERMISSION_REQUIRED' : '';

  return card('計測値', [
    el('div', { class: 'stat-grid' }, [
      stat('状態', vm.cameraState, vm.trackLive ? 's-AVAILABLE' : 's-UNAVAILABLE'),
      stat('解像度', settings ? `${settings.width}×${settings.height}` : null),
      stat('向き', settings?.facingMode ?? null),
      stat('トラックの fps', settings && settings.frameRate > 0 ? String(settings.frameRate) : null),
      stat('フレーム数', s.frameCount > 0 ? String(s.frameCount) : null),
      stat('実測 fps', s.frameCount > 1 ? String(s.meanFps) : null),
      stat('連続', s.frameCount > 0 ? `${secondsHeld.toFixed(1)} / ${target} s` : null, captureClass),
      stat('最長の途切れ', s.frameCount > 1 ? `${s.maxGapMs} ms` : null),
      stat('画像変化 Δ 最大', s.sampleCount > 0 ? String(s.madMax) : null),
      stat('ノイズ下限', s.sampleCount > 0 ? String(s.madMedian) : null),
      stat('輝度の範囲', s.sampleCount > 0 ? `${s.lumaMin}–${s.lumaMax}` : null),
      stat('回転回数', String(s.orientationChanges)),
    ]),
    el('p', { class: 'footnote' }, [
      s.frameCount > 0
        ? `フレームの供給元: ${s.source}。サンプリングは 64×48 のバッファに 4 Hz で` +
          `1 サンプルあたり ${s.sampleCostMsMean} ms。これは検証用の計測であって、` +
          'Phase 2 のパイプラインではありません。'
        : 'まだフレームを観測していません。上の各項目は、計測できるまでダッシュのままです。',
    ]),
    ...(s.wasEverHidden
      ? [
          el('p', { class: 'evidence-warning' }, [
            `ページが ${s.hiddenCount} 回バックグラウンドに回りました。隠れている間は` +
              'フレームコールバックが止まるので、この実行では 30 秒の連続取得を示せません。' +
              'アプリから離れずに、カメラを止めて開始し直してください。',
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
        entry ? (entry.observedDirectly ? 'この実行' : '前回から引き継ぎ') : '',
      ]),
      el('span', { class: `cap-state ${entry ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'}` }, [
        entry ? '観測済み' : 'まだ',
      ]),
    ]);

  return card('許可のシナリオ', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      '「許可」と「拒否」は1回のセッションで両方は起こせず、一方から他方を推測することも' +
        'できません。そのため Phase 1 には2回の実行が必要です。',
    ]),
    row('許可した場合（CAM-001）', vm.granted),
    row('拒否した場合（CAM-002）', vm.denied),
    ...(vm.denied === null
      ? [
          el('p', { class: 'footnote' }, [
            '拒否のほうを試すには、Safari の ăA メニュー → Web サイトの設定 → カメラ → 拒否、' +
              'としてからこのページを再読み込みし、「カメラ開始」を押してください。',
          ]),
        ]
      : []),
    ...(vm.granted?.observedDirectly === false || vm.denied?.observedDirectly === false
      ? [
          el('p', { class: 'footnote' }, [
            '「前回から引き継ぎ」と付いたシナリオは、同じビルド・同じオリジンでの以前の実行で' +
              '観測されたもので、端末内に保存されています。これはテストを楽にするためのもので、' +
              'リポジトリ側は、そのシナリオを直接観測したバンドルのコミットを要求します。',
          ]),
        ]
      : []),
  ]);
}

