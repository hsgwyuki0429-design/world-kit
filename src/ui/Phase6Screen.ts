/**
 * RELATIVE POSE screen (Phase 6, v3 §15, §16, §19, §67).
 *
 * The first screen in this project that shows a quantity with a physical unit — degrees — and
 * therefore the first one where a second instrument can be put beside it and disagree. That
 * comparison is the headline here for the same reason Phase 4's scene-shift search and Phase 5's
 * injected outliers were the headline there.
 *
 * Four things on this screen are here because of what Phase 6 can fake.
 *
 *  - **"Does the pose follow a rotation it was not told about?" is the top panel**, not the
 *    rotation itself. A stage returning the same pose on every frame has a valid rotation
 *    matrix, a unit translation, a small reprojection error and a *perfect* temporal stability.
 *    v3 §67's pass condition names exactly this — Poseが計算結果により変化 — and the injected
 *    rotation is the only number here that decides it.
 *  - **The gyroscope's angle is shown beside the camera's**, and neither is shown alone. It is
 *    a different sensor on a different thread, and the solver never reads it.
 *  - **The scale says `LOCAL UNITS` and there is no metre anywhere.** v3 §15 and v4 §18 both
 *    forbid it. `‖t‖` is 1 because it was normalised, which is not a measurement of anything.
 *  - **`INTRINSICS: ESTIMATED` is displayed with the assumed field of view and the ±20 %
 *    sensitivity beside it**, because a stated assumption whose consequences are unmeasured is
 *    a guess with a number attached.
 *
 * All four cheirality counts are shown rather than the winner alone, for the reason Phase 5
 * shows both models' inlier counts: a decision presented without the alternatives it beat is an
 * assertion.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  INJECTED_ROTATION_DEG,
  INJECTION_TOLERANCE_DEG,
  MAX_CONTROL_ROTATION_DEG,
  MIN_INJECTION_SAMPLES,
  MIN_JUDGED_FRAMES,
  MIN_ROTATION_AGREEMENT_RATE,
  POSE_PIPELINE_BUDGET_MS,
} from '../testkit/Phase6Tests';
import {
  MAX_REPROJECTION_PX,
  MIN_CHEIRALITY_FRACTION,
  PURE_ROTATION_PARALLAX_PX,
  PoseState,
} from '../geometry/pose';
import { NOMINAL_FOV_DEG } from '../geometry/intrinsics';
import {
  MIN_COMPARABLE_ROTATION_DEG,
  ROTATION_AGREEMENT_DEG,
} from '../tracking/PoseSession';
import type { PoseStats } from '../tracking/poseStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';
import { card, deg, el, pct, px, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase6ViewModel {
  readonly phase6: PhaseInfo;
  readonly phase7: PhaseInfo;
  readonly canEnterPhase7: boolean;
  readonly phase7Implemented: boolean;
  readonly phase7BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase7LockNote: string;
  readonly cameraState: CameraState;
  /** The camera is delivering — which is NOT whether pose recovery is running (§H.5). */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: pose asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: PoseStats;
  /** Phase 5's measured RANSAC cost — §H budgets it and pose recovery as one line. */
  readonly verifyMs: number;
  readonly alignment: AlignmentReading | null;
  readonly overlay: Float32Array | null;
  readonly overlayAge: Uint16Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase6Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase7: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'pose-overlay';
  }
  return overlayCanvas;
}

/**
 * The tracked population, drawn exactly as Phases 4 and 5 draw it.
 *
 * Nothing about the pose is painted on the picture. A recovered rotation and a translation
 * direction are properties of the *camera*, not of any point on screen, and drawing an arrow to
 * suggest otherwise would be inventing a spatial relationship this phase has not established.
 * There is no depth here yet — Phase 9 triangulates for keeping — so there is nothing in the
 * scene whose position this phase could honestly mark.
 */
function paintOverlay(vm: Phase6ViewModel): void {
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
      ctx.fillStyle = `rgba(48, 209, 88, ${0.35 + 0.55 * Math.min(1, age / 30)})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.75)';
      ctx.stroke();
    }
  }
}

export function renderPhase6Screen(
  root: HTMLElement,
  vm: Phase6ViewModel,
  handlers: Phase6Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['相対姿勢']),
      el('p', {}, [
        'Phase 6 — Phase 5 が検証した幾何から、カメラの回転と、動いた「向き」を分解します。' +
          '向きだけです。単眼カメラには絶対スケールがないので、ここはすべて LOCAL UNITS で、' +
          '下流のどこも 1 をメートルと読んではいけません。地図は保持しません。' +
          'ここで三角測量した点は、カメラがどちらを向いていたかを確かめるためだけに存在します。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderInjection(vm));
  root.append(renderGyro(vm));
  root.append(renderPose(vm));
  root.append(renderPlanar(vm));
  root.append(renderConfidence(vm));
  root.append(renderIntrinsics(vm));
  root.append(renderCost(vm));
  root.append(testsSection(6, vm.phase6, vm.results));
  root.append(
    evidenceSection(6, vm.phase6, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 5, label: '幾何検証へ戻る', onClick: handlers.onBack },
      {
        index: 7,
        name: 'IMU 統合',
        phase: vm.phase7,
        canEnter: vm.canEnterPhase7,
        implemented: vm.phase7Implemented,
        blockedReason: vm.phase7BlockedReason,
        lockNote: vm.phase7LockNote,
        onClick: handlers.onEnterPhase7,
      },
    ),
  );
}

function renderPreview(vm: Phase6ViewModel, handlers: Phase6Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;
  if (vm.trackLive) {
    paintOverlay(vm);
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0 ? `${vm.sourceWidth} / ${vm.sourceHeight}` : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
        getOverlayCanvas(),
      ]),
      el('p', { class: 'footnote' }, [
        s.poseFrames > 0
          ? '姿勢については何も画像の上に描いていません。回転と並進の向きはカメラのもので、' +
            '画面上のどの点のものでもありませんし、ここには印を付けるべき深度もありません。' +
            '三角測量した点は、カメラがどちらを向いていたかを決めるためだけのもので、' +
            '保持もしていません。'
          : vm.running
            ? '最初の姿勢の復元を待っています。'
            : '検証は動作中です。姿勢の復元はまだ開始されていません。',
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
              : 'POSE RECOVERY NOT STARTED';
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
        id: 'start-pose',
        // §H.5, for the fourth time and from the one predicate. Everything below this screen —
        // camera, pipeline, detector, tracker, verifier — is already live when it opens.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '復元中' : vm.opening ? '要求中…' : '姿勢復元開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-pose',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('カメラと追跡中の対応点', children);
}

/** POSE-005 — the gate. Nothing else here distinguishes a solver from a constant. */
function renderInjection(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injectionSamples >= MIN_INJECTION_SAMPLES;
  const off = Math.abs(s.medianInjectedDeg - INJECTED_ROTATION_DEG);
  const followed = enough && s.medianInjectedDeg >= 0 && off <= INJECTION_TOLERANCE_DEG;
  const controlOk = enough && s.medianControlDeg >= 0 && s.medianControlDeg <= MAX_CONTROL_ROTATION_DEG;

  return card('教えていない回転に姿勢は追従するか？', [
    el('div', { class: 'stat-grid' }, [
      stat('カメラを回した角度', `${INJECTED_ROTATION_DEG}°`),
      stat('姿勢が動いた角度', deg(s.medianInjectedDeg),
        enough ? (followed ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('対照群が動いた角度', deg(s.medianControlDeg),
        enough ? (controlOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('サンプル数', enough ? String(s.injectionSamples) : `${s.injectionSamples} / ${MIN_INJECTION_SAMPLES}`),
      stat('インライアの変動', `${pct(s.medianInjectedInlierDrift)} · 対照群 ${pct(s.medianControlInlierDrift)}`,
        s.medianInjectedInlierDrift > 0.1 ? 's-PERMISSION_DENIED' : ''),
      stat('平面判定の反転', `${s.injectionPlanarFlips} · 対照群 ${s.controlPlanarFlips}`,
        s.injectionSamples > 0 && s.injectionPlanarFlips / s.injectionSamples > 0.1
          ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `一部のフレームで、ハーネスが2つ目の視点に ${INJECTED_ROTATION_DEG}° のカメラ回転を` +
        '適用します（`K·Rⱼ·K⁻¹`。端末をその角度だけ回したら見えたはずのもの、そのものです）。' +
        'そして印を付けずに渡した集合に対して、モデルの当てはめも含めて全工程を走らせ直します。' +
        'ソルバは Rⱼ を知ることができず、この数値に合わせて最適化することもできません。',
    ]),
    el('p', { class: 'footnote' }, [
      '「対照群が動いた角度」は、同じ対応点を一切いじらず、別の種で当てはめ直したものです。' +
        '計測は2つの数値で成り立ちます。定数を返すソルバは1つ目が 0° になり、' +
        'ノイズを返すソルバは2つ目が大きくなります。',
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 6 の中で、毎フレーム同じ姿勢を返すだけのステージが作れない数値はこれだけです。' +
        'そのステージは正しい回転行列と単位並進を持ち、再投影誤差も小さく、時間的な安定性は' +
        '*完璧*です — まともなソルバより良いほどに。そしてここではちょうど 0.00° になります。' +
        'v3 §67 はその条件を一行で書いています: Poseが計算結果により変化。',
    ]),
    el('p', { class: 'footnote' }, [
      'インライアの変動と平面判定の反転に対照群の値を並べてあるのが、これを出す理由です。' +
        '*厳密な*エピポーラ幾何は画像空間の回転の下で厳密に写ります（`b′ᵀ(Hⱼ⁻ᵀF)a = bᵀFa`）。' +
        'しかしインライア判定は**画素単位の閾値**で、Sampson 距離は片方の画像の射影変換の下で' +
        '不変ではないので、1.5 px ぎりぎりにいる対応点は境界を跨ぎ得ます。対照群の変動は' +
        '「同じデータを当てはめ直すだけで生じる分」であり、注入側がそれをどれだけ超えるかが問いです。',
    ]),
    ...(s.injections.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近の注入']),
          ...s.injections.slice(-4).map((inj) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`指示 ${inj.requestedDeg}°`]),
              el('span', { class: 'cap-method' }, [
                `実測 ${deg(inj.recoveredDeg)} · 対照群 ${deg(inj.controlDeg)}`,
              ]),
              el('span', {
                class: `cap-state ${Math.abs(inj.recoveredDeg - inj.requestedDeg) <= INJECTION_TOLERANCE_DEG ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}`,
              }, [`インライア ${inj.inliersBefore} → ${inj.inliersAfter}`]),
            ]),
          ),
        ]
      : []),
  ]);
}

/** POSE-002 — the second instrument, and the reason this phase cannot pass off the device. */
function renderGyro(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.rotationSamples >= MIN_JUDGED_FRAMES;
  const agreeing =
    enough &&
    s.medianRotationDisagreementDeg >= 0 &&
    s.medianRotationDisagreementDeg <= Math.max(ROTATION_AGREEMENT_DEG, 0.3 * s.medianGyroRotationDeg);

  return card('カメラはジャイロと一致しているか？', [
    el('div', { class: 'stat-grid' }, [
      stat('カメラの言い分', deg(s.medianVisualRotationDeg)),
      stat('ジャイロの言い分', s.gyroAvailable ? deg(s.medianGyroRotationDeg) : '利用できません',
        s.gyroAvailable ? '' : 's-PERMISSION_REQUIRED'),
      stat('食い違い', deg(s.medianRotationDisagreementDeg),
        enough ? (agreeing ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('比較できたフレーム', enough
        ? `${s.rotationComparisons} 中 ${s.rotationSamples}`
        : `${s.rotationSamples} / ${MIN_JUDGED_FRAMES}`),
      stat('一致したフレームの割合', pct(s.rotationAgreementRate),
        s.rotationAgreementRate > 1
          ? 's-PERMISSION_DENIED'
          : s.rotationAgreementRate >= MIN_ROTATION_AGREEMENT_RATE ? 's-AVAILABLE' : ''),
      stat('このフレーム', s.poseFrames > 0 ? deg(s.rotationDeg) : null),
    ]),
    el('p', { class: 'footnote' }, [
      s.gyroAvailable
        ? 'ジャイロの回転は、姿勢が張るのと同じ区間（アンカーから現在まで）で積分しています。' +
          '|ω| を積分するのではなく回転ベクトルを正しく合成しています。|ω| の積分は経路長の合計に' +
          'なるので、少しでも揺れると過大に読み取ってしまいます。ソルバはこれを見ません。' +
          '別のスレッド上の別のセンサーです。'
        : s.gyroReason ||
          'ジャイロがないと、カメラが実際にどれだけ回ったかを姿勢ソルバと独立に言える計測器が' +
            'ありません。そのため POSE-002 は判定せず、その理由を添えて PENDING を報告します。' +
            'Phase 6 が実機でしか合格できないのはこのためです。',
    ]),
    el('p', { class: 'footnote' }, [
      'ここの数値はすべて**保持ウィンドウ**の範囲のものです（§56 が20分のセッションで' +
        '保持してよい量を制限しています）。「比較できたフレーム」は、そのウィンドウの値を' +
        'これまでに比較した総数と並べたものです。並べているのは、一度これが乖離したからです。' +
        '分母が 400 で止まったまま一致カウンタだけが増え続け、実機で「一致率 232.3%」を' +
        '報告しました。100% を超える比率は、比率ではありません。',
    ]),
    el('p', { class: 'footnote' }, [
      `比較するのは、ジャイロが ${MIN_COMPARABLE_ROTATION_DEG}° 以上を測ったフレームだけです。` +
        'ゼロとゼロの一致は一致ではありません。静止させた端末は両方の計測器から 0° を出し、' +
        '恒等回転を返し続けるだけのステージはそれに完璧に一致してしまいます。',
    ]),
    el('p', { class: 'footnote' }, [
      '比べるのは角度だけで、軸は比べません。`rotationRate` は端末の座標系で表されており、' +
        'カメラの座標系とは誰もまだ測っていない固定回転の分だけ違います。回転角はその基底変換の' +
        '下で不変ですが、軸はそうではありません。また v3 §19 は姿勢信頼度の入力に ' +
        '`IMU consistency` を挙げていますが、このフェーズはまさにこの比較が意味を持つように' +
        'それを保留しています。',
    ]),
  ]);
}

function renderPose(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === PoseState.POSE
      ? 's-AVAILABLE'
      : s.state === PoseState.ROTATION_ONLY
        ? 's-PERMISSION_REQUIRED'
        : 's-PERMISSION_DENIED';

  return card('このフレーム（v3 §15）', [
    el('div', { class: 'stat-grid' }, [
      stat('状態', s.poseFrames > 0 ? s.state : null, stateClass),
      stat('由来', s.source ?? (s.poseFrames > 0 ? 'なし' : null)),
      stat('回転', deg(s.rotationDeg)),
      stat('並進', vec(s.translation) ?? (s.poseFrames > 0 ? 'なし' : null)),
      stat('スケール', s.scale, s.scale === 'LOCAL_UNITS' ? 's-AVAILABLE' : 's-PERMISSION_DENIED'),
      stat('両カメラの前方にある点', s.correspondences > 0
        ? `${s.pointsInFront} / ${s.correspondences}` : null,
        s.correspondences > 0 && s.pointsInFront / s.correspondences >= MIN_CHEIRALITY_FRACTION
          ? 's-AVAILABLE' : ''),
      stat('再投影誤差', px(s.reprojectionErrorPx),
        s.reprojectionErrorPx >= 0 && s.reprojectionErrorPx <= MAX_REPROJECTION_PX ? 's-AVAILABLE' : ''),
      stat('R で説明できない視差', px(s.rotationOnlyResidualPx)),
      stat('曖昧', s.ambiguous ? 'はい' : 'いいえ', s.ambiguous ? 's-PERMISSION_REQUIRED' : ''),
      stat('フレーム数', String(s.poseFrames)),
      stat('状態の不一致', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
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
    el('p', { class: 'footnote' }, [s.stateReason || '姿勢の復元はまだ走っていません。']),
    el('p', { class: 'footnote' }, [
      '「R で説明できない視差」は、回転だけでは説明できない分です。分解の結果から読むのではなく' +
        '対応点の上で測っています。`K·R·K⁻¹` は、カメラが回っただけならそれぞれの点が' +
        'どこにあるはずかを予測し、実際の位置までの距離の中央値が、まさに並進が説明する視差です。' +
        `${PURE_ROTATION_PARALLAX_PX} px 以下 — §13 の往復誤差の許容帯 — なら、並進が説明すべき` +
        'ものは何も残っておらず、並進は報告されません。',
    ]),
    ...(s.cheirality.length > 0
      ? [
          el('p', { class: 'group-title' }, ['候補と、それぞれが前方に置いた点の数']),
          ...s.cheirality.map((c) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [
                `#${c.candidate}${c.candidate === s.chosen ? ' ← 採用' : ''}`,
              ]),
              el('span', { class: 'cap-method' }, [deg(c.rotationDeg)]),
              el('span', { class: `cap-state ${c.candidate === s.chosen ? 's-AVAILABLE' : ''}` }, [
                `両カメラの前方に ${c.inFront} 点`,
              ]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            '勝った候補だけでなく全部出しています。基本行列の分解は4つの候補を与え、' +
              'そのうちちょうど1つだけがシーンを両カメラの前方に置きます。採用したものだけを' +
              '見せると、その判断は発見ではなく主張になります。ホモグラフィは最大8つを与え、' +
              '前方性で分離できないものは3つ目の視点を要する本物の曖昧さです。' +
              '報告はしますが、こちらで勝手に決着させることはしません。',
          ]),
        ]
      : []),
  ]);
}

function renderPlanar(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const lowered = s.planarTranslationNotLowered === 0 &&
    s.medianPlanarUnseparated > s.medianNonPlanarUnseparated;

  return card('平面シーンの扱い（v3 §16）', [
    el('div', { class: 'stat-grid' }, [
      stat('姿勢が出た平面フレーム', String(s.planarPosedFrames),
        s.planarPosedFrames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('姿勢が出た非平面フレーム', String(s.nonPlanarPosedFrames),
        s.nonPlanarPosedFrames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('平面なのに基本行列経由', String(s.planarFromEssential),
        s.planarFromEssential > 0 ? 's-PERMISSION_DENIED' : 's-AVAILABLE'),
      stat('分離できない候補（平面）', s.medianPlanarUnseparated >= 0
        ? String(s.medianPlanarUnseparated) : null, lowered ? 's-AVAILABLE' : ''),
      stat('…奥行きがある場合', s.medianNonPlanarUnseparated >= 0
        ? String(s.medianNonPlanarUnseparated) : null),
      stat('下げそこねた回数', String(s.planarTranslationNotLowered),
        s.planarTranslationNotLowered > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('並進の信頼度', s.medianPlanarTranslationConfidence >= 0
        ? `平面 ${s.medianPlanarTranslationConfidence} · 奥行きあり ${s.medianNonPlanarTranslationConfidence}`
        : null),
      stat('曖昧なフレーム', String(s.ambiguousFrames)),
    ]),
    el('p', { class: 'footnote' }, [
      '平面シーンはホモグラフィから分解します。基本行列からは決して分解しません。' +
        '平面に当てはめた E は退化しています。それでも分解はできてしまい、出てくる姿勢は' +
        '一見まったく妥当に見えます。v3 §16 が防ごうとしているのがその失敗で、' +
        'この画面の他のどの数値からも見えません。',
    ]),
    el('p', { class: 'footnote' }, [
      '並進の信頼度を下げるのは**数えた結果であって、決め打ちではありません**。' +
        'ホモグラフィの分解には、2視点では解けない本物の2重の曖昧さが残ります。' +
        '前方性で k 個の候補を分離できなかった場合、並進は同じだけ支持される k 個の答えの' +
        '1つなので、その項は 1/k になります。平面では一般に 1/2 です。平面について何かを' +
        '仮定してはいません。候補を数えているだけで、その数が上の2つの数値です。',
    ]),
    el('p', { class: 'footnote' }, [
      '2つの信頼度の数値は**報告するだけで、種類をまたいで比較しません**。どちらも複数の項の' +
        '最小値です。平面では効いている項はペナルティ（毎回 1/2）で、奥行きのあるシーンでは' +
        'それ以外で一番悪かった項 — 多くは特徴点の数 — です。同一コードでの自動レグ2回が' +
        'どちらが低いかで食い違ったことがありますが、それはこの比較が平面の扱いではなく' +
        '特徴点の母数を測っていたからです。判定しているのは仕組みのほうです。' +
        'すべての平面フレームで下げたか、そして平面が生む曖昧さをちゃんと見つけたか。',
    ]),
  ]);
}

function renderConfidence(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  return card('姿勢の信頼度（v3 §19）', [
    el('div', { class: 'stat-grid' }, [
      stat('全体', s.poseFrames > 0 ? String(s.confidence) : null),
      stat('回転', s.poseFrames > 0 ? String(s.rotationConfidence) : null),
      stat('並進', s.poseFrames > 0 ? String(s.translationConfidence) : null),
      stat('実行全体の中央値', s.medianConfidence >= 0 ? String(s.medianConfidence) : null),
    ]),
    ...(s.confidenceTerms.length > 0
      ? s.confidenceTerms.map((t) =>
          el('div', { class: 'cap-row' }, [
            el('span', { class: 'cap-label' }, [t.name]),
            el('span', { class: 'cap-method' }, [t.value < 0 ? '—' : String(t.value)]),
            el('span', { class: 'cap-state' }, [t.note]),
          ]),
        )
      : [el('p', { class: 'empty' }, ['まだ姿勢がありません。'])]),
    el('p', { class: 'footnote' }, [
      '各項の平均ではなく**最小値**です。v3 §19 は禁止で終わっています — ' +
        '不確実なPoseは強制的に高confidenceにしない — そして平均こそが、不確実な姿勢が' +
        '高い信頼度を得る経路そのものです。余裕のある5つの項が悪い1つを担いで、' +
        '安心できる数字が出てしまいます。分解できるように全項を表示しています。',
    ]),
    ...(s.confidenceWithheld.length > 0
      ? [
          el('p', { class: 'group-title' }, ['保留した項と、その理由']),
          ...s.confidenceWithheld.map((w) => el('p', { class: 'footnote' }, [w])),
        ]
      : []),
  ]);
}

function renderIntrinsics(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const k = s.intrinsics;
  return card('カメラ内部パラメータ — INTRINSICS: ESTIMATED（v3 §15）', [
    el('div', { class: 'stat-grid' }, [
      stat('fx, fy', k ? `${Math.round(k.fx)}, ${Math.round(k.fy)}` : null),
      stat('cx, cy', k ? `${Math.round(k.cx)}, ${Math.round(k.cy)}` : null),
      stat('フレーム', k ? `${k.width} × ${k.height}` : null),
      stat('仮定した画角', `長辺方向 ${NOMINAL_FOV_DEG}°`, 's-PERMISSION_REQUIRED'),
      stat('±20% で回転が動く量', deg(s.medianSensitivityRotationDeg)),
      stat('…並進が動く量', deg(s.medianSensitivityTranslationDeg)),
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §15 は行列を示すと同時に、それが得られない場合どうするかも書いています — ' +
        '**INTRINSICS: ESTIMATED**。実際、得られません。Safari は焦点距離もセンサーサイズも' +
        'レンズの識別子も公開しません。端末が返すのはラベルと解像度だけで、光学については何も' +
        'ありません。ボール遊びのためにチェッカーボードを印刷する人もいません。',
    ]),
    el('p', { class: 'footnote' }, [
      'なので右の2つの数値が、そう言うことを許される代わりの、正直なほうの半分です。' +
        '同じ姿勢を `f` を ±20 % 変えて計算し直し、どれだけ動いたかを示しています。' +
        'ほとんど動かないものはこの推測に依存しておらず、動くものは依存しています。' +
        'これを添えずに公称画角だけを言うのは、数字を付けた当て推量です。',
    ]),
    el('p', { class: 'footnote' }, [
      '§H.0: K は開いたときに1回読むのではなく、毎フレーム計算し直します。端末を回すと' +
        '同じトラックのままフレームの縦横が入れ替わり（1280×720 ↔ 720×1280）、' +
        'fx, fy, cx, cy がすべてそれに伴って変わるからです。',
    ]),
  ]);
}

function renderCost(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const total = s.meanPoseMs >= 0 && vm.verifyMs >= 0 ? s.meanPoseMs + vm.verifyMs : -1;
  const within = total >= 0 && total <= POSE_PIPELINE_BUDGET_MS;
  return card('コスト（§H の予算）', [
    el('div', { class: 'stat-grid' }, [
      stat('姿勢の復元', s.meanPoseMs >= 0 ? `${s.meanPoseMs} ms` : null),
      stat('Phase 5 の RANSAC', vm.verifyMs >= 0 ? `${vm.verifyMs} ms` : null),
      stat('合計', total >= 0 ? `${Math.round(total * 1000) / 1000} ms` : null,
        total >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('予算', `${POSE_PIPELINE_BUDGET_MS} ms`),
      stat('サンプル数', String(s.poseCostSamples)),
      stat('姿勢の出たフレーム', String(s.posedFrames)),
    ]),
    el('p', { class: 'footnote' }, [
      `§H は「RANSAC (E/H) + 姿勢復元」を**1本の** ${POSE_PIPELINE_BUDGET_MS} ms として` +
        '計上しています。なのでこのフェーズが自分用の新しい枠を主張するのではなく、' +
        '合計をその予算と突き合わせます。Phase 5 の実機実行ですでに 3.45 ms を使っています。',
    ]),
    el('p', { class: 'footnote' }, [
      'POSE-006 が参考扱いなのは、§34 の理由 — 性能より正しさ — と、§H.4 が「端末の予算は' +
        '端末の外では裁定できない」と記録しているからです。判定フレームでは依然として両方の' +
        'モデルを当てはめ、両方の分解を走らせます。時間短縮のために v3 §16 を飛ばすことはしません。',
    ]),
  ]);
}

