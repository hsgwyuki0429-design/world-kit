/**
 * GEOMETRIC VERIFICATION screen (Phase 5, v3 §14, §16, §66).
 *
 * The camera with the tracked corners on it, split into the two sets RANSAC just decided:
 * points a single two-view geometry explains, and points it does not. Beside them, the one
 * comparison that makes the split mean anything.
 *
 * Three things on this screen are here because of what Phase 5 can fake.
 *
 *  - **The injected-outlier recall is the headline**, not the inlier ratio. v3 §14 names four
 *    figures — 30 inliers, ratio 0.35, 100 inliers, ratio 0.50 — and a stage that accepts
 *    every correspondence satisfies all four *perfectly*, because then the inlier count is the
 *    correspondence count and the ratio is exactly 1.00. Recall against outliers the harness
 *    made and never marked is the only number here that such a stage cannot produce.
 *  - **The clean rejection rate is shown beside it, always.** Recall alone is satisfied by
 *    rejecting everything. The pair is the measurement; either number alone is not.
 *  - **Both models' inlier counts are shown, never just the chosen one.** v3 §16's planar
 *    decision is the comparison between them, so showing only the winner would make the
 *    decision unauditable — and GEO-004 requires it to be auditable.
 *
 * `GOOD` again says why it is not claimed where it is not. §33 makes GOOD three conditions and
 * Phase 5 can now measure two of them; the reprojection error is Phase 6's and does not exist,
 * so the screen names the missing term rather than showing a state that dropped a condition.
 *
 * The overlay alignment probe carries over from Phases 3 and 4 for the reason §H.5 gives, and
 * it matters more here, not less: a correspondence is two positions in the acquired buffer's
 * frame, and a buffer rotated against the screen makes every baseline and every residual on
 * this screen a measurement of the wrong thing.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  GEO_BUDGET_MS,
  INJECTION_ADVANTAGE,
  MAX_CLEAN_REJECTION,
  MIN_COST_SAMPLES,
  MIN_INJECTION_SAMPLES,
  MIN_JUDGED_FRAMES,
  MIN_OUTLIER_RECALL,
} from '../testkit/Phase5Tests';
import {
  DEGENERATE_SPREAD_PX,
  GOOD_INLIERS,
  GOOD_INLIER_RATIO,
  MIN_BASELINE_PX,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  RANSAC_THRESHOLD_PX,
  USABLE_INLIER_RATIO,
  VerificationState,
} from '../geometry/verify';
import {
  MAX_BASELINE_PX,
  OUTLIER_INJECTION_FRACTION,
  OUTLIER_INJECTION_PX,
} from '../tracking/VerificationStage';
import type { VerificationClassStats, VerificationStats } from '../tracking/verificationStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';
import { card, el, num, pct, px, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase5ViewModel {
  readonly phase5: PhaseInfo;
  readonly phase6: PhaseInfo;
  readonly canEnterPhase6: boolean;
  readonly phase6Implemented: boolean;
  readonly phase6BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase6LockNote: string;
  readonly cameraState: CameraState;
  /**
   * Whether the camera is delivering — which is NOT whether verification is running.
   *
   * The preview reads this and the START control reads `running`, and the two are kept apart
   * on purpose: Phase 5 is entered over a live camera, so binding the preview to `running`
   * would blank the picture until the operator pressed a button, and binding the control to
   * the camera would render it already pressed. Each reads the predicate that is actually
   * about it.
   */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: verification asked for AND a pipeline running to serve it (§H.5). */
  readonly running: boolean;
  readonly stats: VerificationStats;
  readonly alignment: AlignmentReading | null;
  /** `[x0, y0, quality] × count`, level-0 coordinates, straight from the worker. */
  readonly overlay: Float32Array | null;
  readonly overlayAge: Uint16Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase5Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase6: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

/** Kept across renders, as in Phase 4: recreating it would blank the overlay twice a second. */
let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'verify-overlay';
  }
  return overlayCanvas;
}

/**
 * Draw the tracked population.
 *
 * Phase 4's drawing, unchanged, and deliberately so: the overlay's source is still the
 * worker's own position buffer and there is no path here that could produce a point the
 * tracker did not report. Phase 5's own result is not painted on the picture, because the
 * inlier partition is over *correspondences* — pairs spanning the anchor frame and this one —
 * and drawing one end of a pair on the current frame would suggest a per-point verdict on
 * positions the verifier never judged in isolation. The counts are reported as counts.
 */
function paintOverlay(vm: Phase5ViewModel): void {
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
      const strength = Math.min(1, age / 30);
      ctx.fillStyle = `rgba(48, 209, 88, ${0.35 + 0.55 * strength})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.75)';
      ctx.stroke();
    }
  }
}

export function renderPhase5Screen(
  root: HTMLElement,
  vm: Phase5ViewModel,
  handlers: Phase5Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['幾何検証']),
      el('p', {}, [
        'Phase 5 — Phase 4 が追った対応点に対して RANSAC で基礎行列とホモグラフィを当てはめ、' +
          '生き残ったインライア集合を出します。まだ空間的なものはありません。姿勢は分解せず、' +
          '深度も三角測量せず、メートル単位のスケールも存在しません。このフェーズが出すのは、' +
          '「そもそも2視点の幾何でこの動きを説明できるのか」という判定です。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderVerdict(vm));
  root.append(renderInjection(vm));
  root.append(renderTexture(vm));
  root.append(renderPlanar(vm));
  root.append(renderCost(vm));
  root.append(testsSection(5, vm.phase5, vm.results));
  root.append(
    evidenceSection(5, vm.phase5, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 4, label: 'オプティカルフロー追跡へ戻る', onClick: handlers.onBack },
      {
        index: 6,
        name: '相対姿勢',
        phase: vm.phase6,
        canEnter: vm.canEnterPhase6,
        implemented: vm.phase6Implemented,
        blockedReason: vm.phase6BlockedReason,
        lockNote: vm.phase6LockNote,
        onClick: handlers.onEnterPhase6,
      },
    ),
  );
}

function renderPreview(vm: Phase5ViewModel, handlers: Phase5Handlers): HTMLElement {
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
        s.verifiedFrames > 0
          ? `これらの点のうち ${s.correspondences} 個は、` +
            `${s.anchorAge >= 0 ? `${s.anchorAge} フレーム前の` : 'まだ取られていない'}` +
            'アンカーフレームにも残っています。RANSAC が判定したのは、画面上の点ではなく' +
            'その対応の組のほうです。'
          : vm.running
            ? '最初の検証フレームを待っています。'
            : '追跡は動作中です。検証はまだ開始されていません。',
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
              : '検証は未起動です';
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
        id: 'start-verification',
        // §H.5 again, and for the third time the same defect is not repeated: this drives the
        // label AND `disabled` from the one `running` predicate. Phase 5 is reached from a
        // screen whose pipeline, detection and tracking are all already live, so any predicate
        // built from those would render this control as pressed before anyone pressed it.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '検証中' : vm.opening ? '要求中…' : '幾何検証開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-verification',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('カメラと追跡中の対応点', children);
}

function renderVerdict(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === VerificationState.GOOD
      ? 's-AVAILABLE'
      : s.state === VerificationState.USABLE
        ? 's-PERMISSION_REQUIRED'
        : 's-PERMISSION_DENIED';

  return card('このフレーム（v3 §14）', [
    el('div', { class: 'stat-grid' }, [
      stat('状態', s.verifiedFrames > 0 ? s.state : null, stateClass),
      stat('モデル', s.model ?? (s.verifiedFrames > 0 ? 'なし' : null)),
      stat('対応点', s.verifiedFrames > 0 ? String(s.correspondences) : null,
        s.correspondences >= MIN_CORRESPONDENCES ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('インライア', s.verifiedFrames > 0 ? String(s.inliers) : null,
        s.inliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('インライア比', pct(s.inlierRatio),
        s.inlierRatio >= USABLE_INLIER_RATIO ? 's-AVAILABLE' : ''),
      stat('基線長', px(s.baselinePx),
        s.baselinePx >= MIN_BASELINE_PX ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('アンカーの古さ', s.anchorAge >= 0 ? `${s.anchorAge} フレーム` : null),
      stat('再アンカー', String(s.reAnchors)),
      stat('検証フレーム', `判定 ${s.judgedFrames} / ${s.verifiedFrames}`),
      stat('状態の不一致', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('退化', String(s.degenerateFrames)),
      stat('分割の不整合', String(s.partitionFaults),
        s.partitionFaults > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('判定なしのモデル', String(s.modelWithoutVerdict),
        s.modelWithoutVerdict > 0 ? 's-PERMISSION_DENIED' : ''),
      // §51 and §H.7: a correspondence is two positions in the acquired buffer's frame.
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
      s.stateReason ||
        '状態は、隣にある5つの実測値だけから決まり、1か所で計算されます。' +
          '「状態の不一致」は同じ数値から状態を導き直し、答えが食い違ったフレームを数えます。',
    ]),
    el('p', { class: 'footnote' }, [
      `フレームが判定されるのは、対応点 ${MIN_CORRESPONDENCES} 個と基線長 ${MIN_BASELINE_PX} px を` +
        '満たしてからです。基線長がその下限を下回ると、2つの視点はほとんど同じ視点になります。' +
        'どんなモデルでも当てはまり、インライア比は 1.00 近くになり、そして何の意味もありません。' +
        'このフェーズが連続フレームではなく数十フレーム前の検証アンカーを保持しているのは' +
        'そのためです。フレーム間ではカメラは数 px しか動かないので、2つの視点が' +
        `${MAX_BASELINE_PX} px を超えて離れ、1つの幾何と言えるだけの共通部分を失った時点で` +
        'アンカーを取り直します。',
    ]),
    ...(s.goodBlockedBy.length > 0
      ? [
          el('p', { class: 'group-title' }, [`${VerificationState.GOOD} にならない理由`]),
          ...s.goodBlockedBy.map((why) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, ['v3 §14 の条件']),
              el('span', { class: 'cap-state' }, [why]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            `ここでの GOOD は v3 §14 の2条件 — インライア ${GOOD_INLIERS} 以上、比 ` +
              `${GOOD_INLIER_RATIO} 以上 — です。§33 はさらに3つ目として再投影誤差 2.0 px 以下を` +
              '課しますが、それには Phase 6 が出す姿勢が要ります。なので前の画面の追跡状態は' +
              'まだ GOOD に到達できません。この画面の GOOD は v3 §14 の検証判定であって、' +
              '同じ主張ではありません。',
          ]),
        ]
      : []),
  ]);
}

/** GEO-003 — the gate. Nothing else on this screen distinguishes a verifier from a pass-through. */
function renderInjection(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injectionSamples >= MIN_INJECTION_SAMPLES;
  const recallOk = enough && s.medianInjectedRecall >= MIN_OUTLIER_RECALL;
  const cleanOk = enough && s.medianCleanRejection >= 0 &&
    s.medianCleanRejection <= MAX_CLEAN_REJECTION;
  const advantage =
    s.medianCleanRejection > 0 ? s.medianInjectedRecall / s.medianCleanRejection : Infinity;

  return card('RANSAC は本当に外れ値を弾いているか？', [
    el('div', { class: 'stat-grid' }, [
      stat('仕込んだ外れ値の棄却率', pct(s.medianInjectedRecall),
        enough ? (recallOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('無傷の点の棄却率', pct(s.medianCleanRejection),
        enough ? (cleanOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('差', enough
        ? (Number.isFinite(advantage) ? `${advantage.toFixed(1)} 倍` : '無傷の棄却はゼロ')
        : null,
        enough ? (advantage >= INJECTION_ADVANTAGE ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('残ったインライア', num(s.medianSurvivingInliers),
        s.medianSurvivingInliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('サンプル数', enough
        ? String(s.injectionSamples)
        : `${s.injectionSamples} / ${MIN_INJECTION_SAMPLES}`),
      stat('ずらした量', `${OUTLIER_INJECTION_PX} px`),
    ]),
    el('p', { class: 'footnote' }, [
      `一部のフレームで、ハーネスが本物の対応点の集合を取り、そのうち ` +
        `${Math.round(OUTLIER_INJECTION_FRACTION * 100)}% の行き先を、種を固定した方向へ ` +
        `${OUTLIER_INJECTION_PX} px ずらし、どれをいじったかを伏せたまま検証器に渡します。` +
        '「仕込んだ外れ値の棄却率」は、そのうち何割が棄却されて返ってきたかです。' +
        '検証器はこの数値を見ることができず、これに合わせて最適化することもできません。',
    ]),
    el('p', { class: 'footnote' }, [
      `${OUTLIER_INJECTION_PX} px はインライア閾値 ${RANSAC_THRESHOLD_PX} px の ` +
        `${Math.round(OUTLIER_INJECTION_PX / RANSAC_THRESHOLD_PX)} 倍なので、仕込んだ点は` +
        '構造上かならず外れ値です。正しい2視点モデルがそれを受け入れることはあり得ません。' +
        '2つ目の数値を隣に並べているのは、棄却率だけなら「全部棄却する」で満点になるからです。' +
        '2つ揃って初めて計測になり、片方だけでは計測になりません。',
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 5 の中で、すべての対応点をインライアとして返すだけのステージが作れない数値は' +
        `これだけです。v3 §14 の4つの閾値 — インライア ${MIN_INLIERS}、比 ${USABLE_INLIER_RATIO}、` +
        `インライア ${GOOD_INLIERS}、比 ${GOOD_INLIER_RATIO} — は、全部受け入れれば*完璧に*` +
        '満たされます。インライア数が対応点数と等しくなり、比はちょうど 1.00 になるからです。' +
        'そのステージはここで 0.0% を取ります。',
    ]),
    ...(s.injections.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近の注入']),
          ...s.injections.slice(-4).map((inj) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`仕込み ${inj.injected}`]),
              el('span', { class: 'cap-method' }, [
                `棄却 ${inj.injectedRejected} · 無傷 ${inj.cleanRejected}/${inj.clean}`,
              ]),
              el('span', {
                class: `cap-state ${inj.injectedRecall >= MIN_OUTLIER_RECALL ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}`,
              }, [
                `棄却率 ${pct(inj.injectedRecall)} · 残存 ${inj.survivingInliers} · ${inj.state}`,
              ]),
            ]),
          ),
        ]
      : []),
  ]);
}

function renderTexture(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const row = (label: string, c: VerificationClassStats): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [
        c.frames > 0 ? `対応 ${c.medianCorrespondences} · インライア ${c.medianInliers}` : '',
      ]),
      el('span', { class: `cap-state ${c.frames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''}` }, [
        c.frames > 0
          ? `${c.frames} フレーム（判定 ${c.judged}）· UNVERIFIED ${c.unverified}、` +
            `USABLE ${c.usable}、GOOD ${c.good}`
          : 'まだなし',
      ]),
    ]);

  return card('シーンの模様ごと（GEO-001、GEO-002）', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      '分類はフレーム自身の平均勾配の大きさから決まり、Phase 3 と同じ分類器で測っています。' +
        'カメラをどこに向けたかは関係しません。GEO-001 は、模様のあるシーンで大きく一貫した' +
        'インライア集合が出ることを求めます。GEO-002 は、平坦なシーンで、4点から計算した比では' +
        'なく UNVERIFIED が出ることを求めます。',
    ]),
    row('TEXTURE_RICH（GEO-001）', s.textureRich),
    row('TEXTURE_POOR（GEO-002）', s.texturePoor),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('インライア中央値', num(s.medianInliers),
        s.medianInliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('比の中央値', pct(s.medianInlierRatio),
        s.medianInlierRatio >= USABLE_INLIER_RATIO ? 's-AVAILABLE' : ''),
      stat('基線長の中央値', px(s.medianBaselinePx)),
      stat('広がりの中央値', px(s.medianSpreadPx),
        s.medianSpreadPx >= DEGENERATE_SPREAD_PX ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
    ]),
    el('p', { class: 'footnote' }, [
      `「広がり」はインライア集合自身の空間的な広がりです。これを出しているのは、` +
        'モデルを決められないほど1か所に固まった集合でも、比のほうはすべての基準を' +
        `通過してしまえるからです。${DEGENERATE_SPREAD_PX} px 未満のときは、検証済みではなく` +
        '退化として報告します。',
    ]),
  ]);
}

function renderPlanar(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  return card('平面シーンの扱い（v3 §16）', [
    el('div', { class: 'stat-grid' }, [
      stat('両モデルを当てはめた', s.bothModelsFitted > 0
        ? `${s.bothModelsFitted} フレーム` : null,
        s.bothModelsFitted >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('平面', String(s.planarFrames), s.planarFrames > 0 ? 's-AVAILABLE' : ''),
      stat('非平面', String(s.nonPlanarFrames), s.nonPlanarFrames > 0 ? 's-AVAILABLE' : ''),
      stat('F のインライア中央値', num(s.medianFundamentalInliers)),
      stat('H のインライア中央値', num(s.medianHomographyInliers)),
      stat('平面判定の不一致', String(s.planarMismatches),
        s.planarMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      '判定するフレームでは必ず両方のモデルを当てはめます。最適化と称して片方を飛ばすことは' +
        'しません。基礎行列のほうが制約が弱く、普通は少なくとも同じだけの点を受け入れるので、' +
        'ホモグラフィがそこに追いついたことが「このシーンは平面だ」という合図になります。' +
        '両方の数を出しているのは、判断が両者の比較そのものだからです。勝ったほうだけを' +
        '見せると、PLANAR は発見ではなく主張になってしまいます。',
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §16 がこれを求めるのは、平面シーンから分解した基本行列が退化していて、しかも' +
        '一見まったく妥当に見える姿勢を出してしまうからです。Phase 6 はそういうフレームで' +
        '並進の信頼度を下げます。このフェーズの仕事は、それを正直に見分けることです。' +
        '一方の場合が一度も出なかった実行については、出なかったと言うことも含めて。',
    ]),
  ]);
}

function renderCost(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanVerifyMs >= 0 && s.meanVerifyMs <= GEO_BUDGET_MS;
  return card('コスト（§H の予算）', [
    el('div', { class: 'stat-grid' }, [
      stat('RANSAC', s.meanVerifyMs >= 0 ? `${s.meanVerifyMs} ms` : null,
        s.meanVerifyMs >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('予算', `${GEO_BUDGET_MS} ms`),
      stat('サンプル数', s.verifyCostSamples >= MIN_COST_SAMPLES
        ? String(s.verifyCostSamples)
        : `${s.verifyCostSamples} / ${MIN_COST_SAMPLES}`),
      stat('その時の対応点数', num(s.medianCorrespondences)),
      stat('反復上限に達したフレーム', String(s.cappedFrames),
        s.cappedFrames > 0 ? 's-PERMISSION_REQUIRED' : ''),
      stat('インライア閾値', `${RANSAC_THRESHOLD_PX} px`),
    ]),
    el('p', { class: 'footnote' }, [
      '「反復上限に達したフレーム」とは、RANSAC が目標の確度に届く前に反復回数を使い切った' +
        'フレームです。そこで報告される比は、確率的な裏付けのある推定ではなく、最後のサンプルが' +
        'たまたま返した値です。上限を消えるまで引き上げるのではなく回数を表示しているのは、' +
        'それがどれだけ頻繁に効いているかがシーンの性質として知る価値があるからです。',
    ]),
    el('p', { class: 'footnote' }, [
      `GEO-005 は参考扱いです。§34 は性能より正しさを上に置くので、平均が ${GEO_BUDGET_MS} ms を` +
        '超えていても判定フレームでは両方のモデルを当てはめ続け、指定どおりの作業の実測コストを' +
        'そのまま報告します。収まるまで作業を削ることはしません。',
    ]),
  ]);
}

/** Phase Lock on screen, as on every screen before it: a closed door says which lock holds it. */
