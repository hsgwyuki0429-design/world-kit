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
import type { FlowStats, MotionClassStats } from '../tracking/flowStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';
import { card, el, pct, px, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase4ViewModel {
  readonly phase4: PhaseInfo;
  readonly phase5: PhaseInfo;
  readonly canEnterPhase5: boolean;
  readonly phase5Implemented: boolean;
  readonly phase5BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase5LockNote: string;
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
      el('h1', {}, ['追跡']),
      el('p', {}, [
        'Phase 4 — Phase 2 が作るピラミッド上でのピラミッド型 Lucas-Kanade。Phase 3 が見つけた' +
          'コーナーを追います。ここで初めて特徴点が履歴を持ちます。空間的なものはまだ何も' +
          '作っていません。姿勢も、深度も、幾何もありません。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPopulation(vm));
  root.append(renderCrossCheck(vm));
  root.append(renderMotion(vm));
  root.append(renderCost(vm));
  root.append(testsSection(4, vm.phase4, vm.results));
  root.append(
    evidenceSection(4, vm.phase4, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 3, label: '特徴点検出へ戻る', onClick: handlers.onBack },
      {
        index: 5,
        name: '幾何検証',
        phase: vm.phase5,
        canEnter: vm.canEnterPhase5,
        implemented: vm.phase5Implemented,
        blockedReason: vm.phase5BlockedReason,
        lockNote: vm.phase5LockNote,
        onClick: handlers.onEnterPhase5,
      },
    ),
  );
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
          ? `塗りつぶしの点 ${s.tracked} 個は前のフレームから引き継いだ点です。` +
            `輪だけの点 ${s.redetected} 個は、§11 の段階が求めたのでこのフレームで検出が` +
            '追加した点です。すべてが輪のフレームは、合計がいくら多くても、' +
            '追跡が何も保てなかったフレームです。'
          : '最初の追跡フレームを待っています。',
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
              : '追跡は未起動です';
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
        textContent: vm.running ? '追跡中' : vm.opening ? '要求中…' : '追跡開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-tracking',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('カメラと追跡中のコーナー', children);
}

function renderPopulation(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === TrackingState.LOST
      ? 's-PERMISSION_DENIED'
      : s.state === TrackingState.DEGRADED
        ? 's-PERMISSION_REQUIRED'
        : 's-AVAILABLE';

  return card('特徴点の数と状態（§33）', [
    el('div', { class: 'stat-grid' }, [
      stat('追跡中', s.flowFrames > 0 ? String(s.tracked) : null,
        s.tracked >= DEGRADED_FEATURES ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('再検出', s.flowFrames > 0 ? String(s.redetected) : null),
      stat('合計', s.flowFrames > 0 ? String(s.total) : null),
      stat('状態', s.flowFrames > 0 ? s.state : null, stateClass),
      stat('最長の軌跡', s.maxTrackLength > 0 ? `${s.maxTrackLength} フレーム` : null),
      stat('追跡年齢の中央値', s.medianAge >= 0 ? `${s.medianAge} フレーム` : null),
      stat('往復誤差', px(s.medianFbErrorPx),
        s.medianFbErrorPx >= 0 && s.medianFbErrorPx <= FB_ACCEPTABLE_PX ? 's-AVAILABLE' : ''),
      stat('§13 の区分', s.flowFrames > 0
        ? `許容 ${s.fbAcceptable} · 信頼度低下 ${s.fbReduced} · 棄却 ${s.fbRejected}`
        : null),
      stat('連続失敗フレーム', String(s.consecutiveFailedFrames),
        s.consecutiveFailedFrames > 0 ? 's-PERMISSION_REQUIRED' : ''),
      stat('状態の不一致', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('解像度の変更', String(s.geometryChanges)),
      stat('補充の候補', s.medianDetectionOffered >= 0
        ? `${s.medianDetectionOffered} − 既に追跡中 ${s.medianDeclinedTooClose}` : null),
      stat('ソルバの届かない位置', s.medianDeclinedOutOfReach >= 0
        ? String(s.medianDeclinedOutOfReach) : null),
    ]),
    el('p', { class: 'footnote' }, [
      '「追跡中」と「再検出」を分けてあるのは意図的です。§11 の補充の段階は数が減ると' +
        '母数を戻すので、合計が目標付近でも、追跡がすべての点を失っている状態と両立します。' +
        'このフェーズの生存率はどれも「追跡中」の数だけから計算しています。',
    ]),
    el('p', { class: 'footnote' }, [
      s.stateReason ||
        '状態は実測の個数だけから決まり、1か所で計算されます。上の「状態の不一致」は' +
          '同じ入力から状態を導き直し、答えが食い違ったフレームを数えています。',
    ]),
    ...(s.goodBlockedBy.length > 0
      ? [
          el('p', { class: 'group-title' }, [`${TrackingState.GOOD} にならない理由`]),
          ...s.goodBlockedBy.map((why) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, ['§33 の条件']),
              el('span', { class: 'cap-state' }, [why]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            `§33 は GOOD を3つの条件で定めています — 特徴点 ${GOOD_FEATURES} 以上、` +
              'インライア比 0.50 以上、再投影誤差 2.0 px 以下。Phase 4 が測れるのは最初の1つ' +
              'だけです。残りの2つは Phase 5 と Phase 6 のもので、未実装のあいだ null は' +
              'その条件を満たしません。3つのうち1つだけで GOOD を名乗るのではなく、' +
              'ここでは GOOD に到達できないようにしてあります。',
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

  return card('点は本当に画像を追っているか？', [
    el('div', { class: 'stat-grid' }, [
      stat('追跡器の言い分', px(s.medianTrackedDisplacementPx)),
      stat('画像の言い分', px(s.medianMeasuredShiftPx)),
      stat(
        '食い違い',
        px(s.medianShiftDisagreementPx),
        enough ? (agreeing ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : '',
      ),
      stat('突き合わせ回数', enough ? String(s.shiftCheckCount) : `${s.shiftCheckCount} / ${MIN_SHIFT_SAMPLES}`),
      stat('一致したフレームの割合', pct(s.shiftAgreementRate)),
      // §51 and §H.7: the overlay must sit on the picture. Phase 4 consumes the same
      // positions, so a rotated acquisition route corrupts every displacement above.
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
    ]),
    el('p', { class: 'footnote' }, [
      '「画像の言い分」は、ピラミッド最上位での整数値の差分絶対値和による平行移動探索で' +
        '測っています。Lucas-Kanade ソルバとコードを共有せず、特徴点のリストを一切読まず、' +
        '前フレームのコピーを自分で持っています。渡された点をそのまま返すだけの追跡器は' +
        'ここで 0 を報告します。しかも往復誤差は*完璧*になります（両方向が一致するので）。' +
        'それを見抜けるのは、この画面ではこの比較だけです。',
    ]),
    el('p', { class: 'footnote' }, [
      '許容範囲は max(2.0 px, 実測シフトの 35%) です。探索は level 0 の 1/4 の幅の階層で' +
        '整数値で行うため、探索自身の分解能が level 0 換算で 4 px あります。それより細かく' +
        '一致しろと追跡器に求めるのは、粗さのほうを再現しろと求めることになります。',
    ]),
    el('p', { class: 'footnote' }, [
      '「重ね描きと映像の一致」は、このスレッドで映像要素そのものから計測し、回転・反転・' +
        '転置のそれぞれと突き合わせて採点します。「不一致」なら、描画を直すのではなく取得経路を' +
        '捨てます。Phase 4 は変位をバッファの座標系で測るので、回転したバッファの上に' +
        '直した重ね描きを載せると、画面は正常に見えるのに数値だけが誤っている状態になります。',
    ]),
  ]);
}

function renderMotion(vm: Phase4ViewModel): HTMLElement {
  const s = vm.stats;
  const row = (label: string, c: MotionClassStats): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [c.frames > 0 ? px(c.medianDisplacementPx) : '']),
      el('span', { class: `cap-state ${c.framesSeen > 0 ? 's-AVAILABLE' : ''}` }, [
        c.frames > 0
          ? `${c.framesSeen} フレーム（判定 ${c.frames}）· 生存 ${pct(c.medianSurvival)} · ` +
            `往復誤差 ${px(c.medianFbErrorPx)}`
          : c.framesSeen > 0
            ? `${c.framesSeen} フレーム。追える点のあるものはなし`
            : 'まだなし',
      ]),
    ]);

  return card('シーンの動き（実測）', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      `各フレームは、端末に何をするよう指示したかではなく、画像から分類されます。` +
        `実測シフトが level-0 換算で ${STATIC_SHIFT_PX} px 未満なら静止、${FAST_SHIFT_PX} px を` +
        '超えれば急速移動、暗いか全面が入れ替わったフレームは遮断です。「静止させたつもり」の' +
        '実行と、追跡器が画像を無視した実行は、シーンを別に計測しないかぎり同じ数値になります。',
    ]),
    row('静止（FLOW-001）', s.staticFrames),
    row('ゆっくり横移動（FLOW-002）', s.slowFrames),
    row('急速移動（FLOW-004）', s.fastFrames),
    row('カメラ遮断（FLOW-005）', s.occludedFrames),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('このフレーム', s.flowFrames > 0 ? s.frameMotion : null),
      stat('実測シフト', s.lastSceneShift ? px(s.lastSceneShift.magnitude0) : null),
      stat('探索の確度', s.lastSceneShift ? String(s.lastSceneShift.confidence) : null),
      stat('判定不能', String(s.indeterminateFrames)),
    ]),
    el('p', { class: 'group-title' }, ['ゆっくり回転（FLOW-003）']),
    el('div', { class: 'stat-grid' }, [
      stat('ジャイロ', s.gyroAvailable ? 'rotationRate を受信中' : '利用できません',
        s.gyroAvailable ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('回転中のフレーム', s.gyroAvailable ? String(s.rotatingFrames) : null),
      stat('回転量の中央値', s.medianRotationDeg >= 0
        ? `${s.medianRotationDeg}° / ${ROTATION_WINDOW_MS} ms` : null),
      stat('動きのばらつき', s.medianSpreadRotating >= 0
        ? `回転時 ${px(s.medianSpreadRotating)} / 平行移動時 ${px(s.medianSpreadTranslating)}`
        : null),
    ]),
    el('p', { class: 'footnote' }, [
      s.gyroAvailable
        ? `直前の ${ROTATION_WINDOW_MS} ms でジャイロの積分が ${ROTATING_DEG}° 以上になった` +
          'フレームを回転中とみなします。追跡器とも画像とも独立した、2つ目の計測器です。' +
          '回転は画像のコーナーを場所ごとに異なる量だけ動かし、平行移動はそうしません。' +
          'だから 8×6 グリッド上のばらつきが、両者の計測可能な差になります。'
        : s.gyroReason ||
          'ジャイロがないと、そのフレームが平行移動ではなく回転だったことを独立に知る手段が' +
            'ありません。そのため FLOW-003 は判定せず、その理由を添えて PENDING を報告します。',
    ]),
    ...(s.occlusions.length > 0
      ? [
          el('p', { class: 'group-title' }, ['遮断のエピソード']),
          ...s.occlusions.slice(-4).map((e) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`暗転 ${e.frames} フレーム`]),
              el('span', { class: 'cap-method' }, [
                e.msToLost >= 0 ? `${e.msToLost} ms で LOST` : 'LOST にならず',
              ]),
              el('span', { class: `cap-state ${e.recovered ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}` }, [
                e.recovered ? `${e.recoveredAfterMs} ms 後に回復` : '回復せず',
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
  return card('コスト（§12 のパラメータ、§H の予算）', [
    el('div', { class: 'stat-grid' }, [
      stat('LK の求解', s.meanFlowMs >= 0 ? `${s.meanFlowMs} ms` : null,
        s.meanFlowMs >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('予算', `${FLOW_BUDGET_MS} ms`),
      stat('その時の点数', s.meanTrackedPoints >= 0 ? `${s.meanTrackedPoints} 点` : null),
      stat('シーン探索', s.meanShiftMs >= 0 ? `${s.meanShiftMs} ms` : null),
      stat('窓サイズ', `${LK_WINDOW}×${LK_WINDOW}`),
      stat('階層数', String(LK_LEVELS)),
      stat('反復回数', `最大 ${LK_MAX_ITERATIONS}`),
      stat('収束閾値', String(LK_EPSILON)),
    ]),
    el('p', { class: 'footnote' }, [
      `§12 はこの4つのパラメータを固定しており、予算に合わせて削ることはしません。` +
        'FLOW-006 が参考扱いなのはまさにそのためです。§34 は性能より正しさを上に置くので、' +
        `指定どおりの構成の実測コストを — ${FLOW_BUDGET_MS} ms を超えていても — そのまま` +
        '報告します。収まるまで構成をいじることはしません。',
    ]),
    el('p', { class: 'footnote' }, [
      `ゆっくりの動きでの生存率は ${Math.round(MIN_SURVIVAL_SLOW * 100)}% に達する必要があります。` +
        `§13 は往復ごとに等級を付けます: ${FB_ACCEPTABLE_PX} px 以下なら許容、` +
        `${FB_REDUCED_PX} px までは信頼度低下、それを超えると棄却して捨てます。`,
    ]),
  ]);
}

/** Phase Lock on screen, as on every screen before it: a closed door says which lock holds it. */
