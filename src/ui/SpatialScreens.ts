/**
 * The screens for Phases 11–21 and the game itself (v4 §23–§53).
 *
 * Phases 11–21 share one running stack — localization, the world, the stage, the ball — and one
 * camera view. So they share one screen layout: the AR panel at the top (kept across renders by
 * `ArPanel`), then the cards that are each phase's own measurements, then the same tests,
 * evidence and navigation cards every screen before them ends with.
 *
 * The **play** screen is the product: the same panel, no test cards, reachable from the first
 * screen. It runs the real stack — nothing it shows is staged — and it says plainly that playing
 * passes no phase: the phases pass on their own screens, on a device, under the Phase Lock.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import type { ArPanel } from './ArPanel';
import { card, el, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

/** Japanese names, as the navigation cards print them. Phase 10's screen already names 11 this way. */
export const SPATIAL_PHASE_NAMES: Readonly<Record<number, string>> = {
  11: '面の認識',
  12: '空間ワールド',
  13: 'ゲームビューア',
  14: '保存と再開',
  15: '空間コリジョン',
  16: 'ゲーム統合',
  17: 'ステージ生成',
  18: 'ゴールリング',
  19: 'ボール物理',
  20: 'ゲームプレイ検証',
  21: '最終監査',
};

/** Each phase's start control: its id, its idle label and its busy label. */
export const SPATIAL_START: Readonly<Record<number, { id: string; idle: string; busy: string }>> = {
  11: { id: 'start-surfaces', idle: '面の認識開始', busy: '面を認識中' },
  12: { id: 'start-world', idle: '空間ワールド開始', busy: 'ワールドを構築中' },
  13: { id: 'start-viewer', idle: 'ビューア開始', busy: '表示中' },
  14: { id: 'start-save', idle: '保存と再開を開始', busy: '計測中' },
  15: { id: 'start-collision', idle: 'コリジョン開始', busy: '計測中' },
  16: { id: 'start-game', idle: 'ゲーム統合開始', busy: 'ゲーム実行中' },
  17: { id: 'start-stage', idle: 'ステージ生成開始', busy: '生成中' },
  18: { id: 'start-ring', idle: 'ゴールリング開始', busy: '計測中' },
  19: { id: 'start-ball', idle: 'ボール物理開始', busy: '計測中' },
  20: { id: 'start-gameplay', idle: 'ゲームプレイ検証開始', busy: 'プレイ中' },
  21: { id: 'start-audit', idle: '最終監査開始', busy: '監査中' },
};

export interface StatCard {
  readonly title: string;
  readonly stats: readonly (readonly [string, string | null, string?])[];
  readonly notes: readonly string[];
}

export interface SpatialPhaseViewModel {
  readonly index: number;
  readonly intro: string;
  readonly phase: PhaseInfo;
  readonly results: readonly TestResult[];
  readonly cameraState: CameraState;
  readonly opening: boolean;
  readonly running: boolean;
  readonly cards: readonly StatCard[];
  readonly backLabel: string;
  readonly next: {
    readonly index: number;
    readonly phase: PhaseInfo;
    readonly canEnter: boolean;
    readonly implemented: boolean;
    readonly blockedReason: string;
    readonly lockNote: string;
  } | null;
}

export interface SpatialPhaseHandlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterNext: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderSpatialPhaseScreen(
  root: HTMLElement,
  vm: SpatialPhaseViewModel,
  panel: ArPanel,
  handlers: SpatialPhaseHandlers,
): void {
  root.replaceChildren();
  const start = SPATIAL_START[vm.index] ?? { id: `start-phase${vm.index}`, idle: '開始', busy: '実行中' };
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, [SPATIAL_PHASE_NAMES[vm.index] ?? `Phase ${vm.index}`]),
      el('p', {}, [`Phase ${vm.index} — ${vm.intro}`]),
    ]),
  );
  root.append(
    card('カメラ', [
      panel.root,
      cameraNote(vm.cameraState, vm.opening, vm.running),
      el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
        el('button', {
          class: 'primary',
          id: start.id,
          disabled: vm.opening || vm.running,
          textContent: vm.running ? start.busy : vm.opening ? '要求中…' : start.idle,
          onclick: handlers.onStart,
        } as never),
        el('button', {
          class: 'secondary',
          id: `stop-phase${vm.index}`,
          disabled: !vm.running,
          textContent: '停止',
          onclick: handlers.onStop,
        } as never),
      ]),
    ]),
  );
  panel.attachVideo();
  for (const c of vm.cards) root.append(statCard(c));
  root.append(testsSection(vm.index, vm.phase, vm.results));
  root.append(
    evidenceSection(vm.index, vm.phase, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  if (vm.next) {
    root.append(
      navigationSection(
        { index: vm.index - 1, label: vm.backLabel, onClick: handlers.onBack },
        {
          index: vm.next.index,
          name: SPATIAL_PHASE_NAMES[vm.next.index] ?? `Phase ${vm.next.index}`,
          phase: vm.next.phase,
          canEnter: vm.next.canEnter,
          implemented: vm.next.implemented,
          blockedReason: vm.next.blockedReason,
          lockNote: vm.next.lockNote,
          onClick: handlers.onEnterNext,
        },
      ),
    );
  } else {
    root.append(
      card('ナビゲーション', [
        el('div', { class: 'button-row' }, [
          el('button', {
            class: 'secondary',
            id: `back-to-phase${vm.index - 1}`,
            textContent: vm.backLabel,
            onclick: handlers.onBack,
          } as never),
        ]),
        el('p', { class: 'footnote' }, ['Phase 21 が最後のフェーズです。']),
      ]),
    );
  }
}

export interface PlayViewModel {
  readonly cameraState: CameraState;
  readonly opening: boolean;
  readonly running: boolean;
  readonly restoredNote: string | null;
  readonly gravityNote: string;
}

export interface PlayHandlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
}

export function renderPlayScreen(root: HTMLElement, vm: PlayViewModel, panel: ArPanel, handlers: PlayHandlers): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['空間ボールゲーム']),
      el('p', {}, [
        '部屋をゆっくり見回すと、カメラが実際に観測した床・壁・机からステージが生まれます。' +
          'リングを狙って画面を長押しし、離して投げてください。',
      ]),
    ]),
  );
  root.append(
    card('プレイ', [
      panel.root,
      cameraNote(vm.cameraState, vm.opening, vm.running),
      el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
        el('button', {
          class: 'primary',
          id: 'start-play',
          disabled: vm.opening || vm.running,
          textContent: vm.running ? 'プレイ中' : vm.opening ? '要求中…' : 'ゲーム開始',
          onclick: handlers.onStart,
        } as never),
        el('button', {
          class: 'secondary',
          id: 'stop-play',
          disabled: !vm.running,
          textContent: '停止',
          onclick: handlers.onStop,
        } as never),
      ]),
      el('p', { class: 'footnote' }, [vm.gravityNote]),
      ...(vm.restoredNote ? [el('p', { class: 'footnote', id: 'restored-note' }, [vm.restoredNote])] : []),
    ]),
  );
  panel.attachVideo();
  root.append(
    card('遊び方', [
      el('ol', { class: 'howto' }, [
        el('li', {}, ['「ゲーム開始」を押し、カメラとモーションセンサーを許可します。']),
        el('li', {}, ['床が映るようにスマホを少し下に向け、ゆっくり左右に動かしながら見回します。上下にも少し傾けると重力の向きが決まります。']),
        el('li', {}, ['TRACKING GOOD・SURFACES・CONFIDENCE が揃うと、観測した面の上にリングが生成されます（READY）。']),
        el('li', {}, ['スマホを向けて狙い、画面を長押しでパワーをため、離して投げます。白い点線が予測軌道です。']),
        el('li', {}, ['ボールは観測された床や壁でだけ跳ね返ります。観測していない場所には床がないので、落ちます。']),
      ]),
      el('p', { class: 'footnote' }, [
        'このモードで遊んでもフェーズは合格になりません。各フェーズの合格判定は、それぞれのフェーズ画面で、' +
          '実機の HTTPS 上で、Phase Lock に従って行われます（Rule 004・Rule 005）。表示される数値は' +
          'すべて実測値で、計測できないものは UNKNOWN と表示されます。',
      ]),
    ]),
  );
  root.append(
    card('ナビゲーション', [
      el('div', { class: 'button-row' }, [
        el('button', { class: 'secondary', id: 'leave-play', textContent: '環境チェックへ戻る', onclick: handlers.onBack } as never),
      ]),
    ]),
  );
}

function statCard(c: StatCard): HTMLElement {
  return card(c.title, [
    el('div', { class: 'stat-grid' }, c.stats.map(([k, v, cls]) => stat(k, v, cls ?? ''))),
    ...c.notes.map((n) => el('p', { class: 'footnote' }, [n])),
  ]);
}

function cameraNote(state: CameraState, opening: boolean, running: boolean): HTMLElement {
  const text =
    state === CameraState.PERMISSION_DENIED
      ? 'カメラの許可が拒否されました'
      : state === CameraState.UNAVAILABLE
        ? 'カメラを利用できません'
        : state === CameraState.ENDED
          ? 'カメラが終了しました — 別のアプリが使用している可能性があります'
          : opening
            ? 'カメラを要求中…'
            : running
              ? ''
              : '未起動です';
  return el('p', { class: 'footnote', id: 'camera-note' }, [text]);
}
