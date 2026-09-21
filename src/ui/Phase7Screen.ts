/**
 * IMU SUPPORT / FUSION screen (Phase 7, v3 §17, §18, §19, §68).
 *
 * The first screen in this project whose headline is a **refusal**, and the first whose spec
 * pass condition is about absence: v3 §68 asks for *IMU unavailableでもVision-only modeで継続可能*
 * and nothing else. So the mode is the first thing on the screen, and it says `VISION ONLY` in
 * plain letters when there are no sensors rather than hiding an unavailable IMU behind a fused
 * number that came from vision alone.
 *
 * Four things are here because of what Phase 7 can fake.
 *
 *  - **"Does the filter find a bias it was not told about?" is the top panel.** A fusion that
 *    returns the visual pose unchanged tracks the camera perfectly, has innovations of exactly
 *    zero — *better* than a real filter's — and never invents a position. It scores 0.0 °/s
 *    here, and this is the only number in the phase it cannot produce.
 *  - **`POSITION: UNAVAILABLE` is displayed as a value, with the drift beside it.** Not an
 *    absent field: a value a later phase has to remove deliberately. And the accelerometer *is*
 *    double-integrated, for the record only, so the refusal carries a number rather than a
 *    citation.
 *  - **The fused confidence is shown beside Phase 6's**, and the fused one may never be higher.
 *    Adding a sensor is evidence, and evidence can only lower a minimum.
 *  - **The propagation clock is shown while vision is out.** v3 §17 gives the gyroscope
 *    短時間回転推定 without saying how short; three seconds is where the number reaches zero and
 *    the pose stops being offered, and the screen counts towards it in the open.
 *
 * Both filters' bias estimates are shown rather than the difference alone, for the reason Phase
 * 5 shows both models' inlier counts and Phase 6 shows all four cheirality candidates: a
 * measurement presented without what it was measured against is an assertion.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  BIAS_AXIS_TOLERANCE_DEG,
  BIAS_TOLERANCE_DPS,
  FUSION_BUDGET_MS,
  GRAVITY_AGREEMENT_DEG,
  MIN_BIAS_SAMPLES_JUDGED,
  MIN_JUDGED_FRAMES,
} from '../testkit/Phase7Tests';
import {
  DEAD_RECKONING_AFTER_MS,
  FusionMode,
  GRAVITY_TOLERANCE_MS2,
  GYRO_BIAS_INJECTION_DPS,
  MAX_PROPAGATION_MS,
  VISUAL_UPDATE_INTERVAL_MS,
} from '../tracking/FusionStage';
import type { FusionStats } from '../tracking/fusionStats';
import { BAD, OK, card, deg, el, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase7ViewModel {
  readonly phase7: PhaseInfo;
  readonly phase8: PhaseInfo;
  readonly canEnterPhase8: boolean;
  readonly phase8Implemented: boolean;
  readonly phase8BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase8LockNote: string;
  readonly cameraState: CameraState;
  /** The camera is delivering — which is NOT whether fusion is running (§H.5). */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: fusion asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: FusionStats;
  /** The acquired frame's dimensions, so the preview is not stretched (`object-fit: fill`). */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase7Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase8: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

function dps(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 1000} °/s`;
}

export function renderPhase7Screen(
  root: HTMLElement,
  vm: Phase7ViewModel,
  handlers: Phase7Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['IMU 統合']),
      el('p', {}, [
        'Phase 7 — 端末自身のモーションセンシングを、視覚による姿勢の**補助**として使います。' +
          '置き換えとしては決して使いません。v3 §18 の5つのフィルタ状態のうち2つ — 姿勢と' +
          'ジャイロのバイアス — を推定します。位置・速度・加速度計バイアスは拒否します。' +
          '加速度計は m/s² を返し、Phase 6 の並進はスケールのない単位ベクトルなので、' +
          'その換算を作り出すことこそ Rule 001 の言う捏造だからです。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderInjection(vm));
  root.append(renderMode(vm));
  root.append(renderSensors(vm));
  root.append(renderConsistency(vm));
  root.append(renderPosition(vm));
  root.append(renderConfidence(vm));
  root.append(renderCost(vm));
  root.append(testsSection(7, vm.phase7, vm.results));
  root.append(
    evidenceSection(7, vm.phase7, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 6, label: '相対姿勢へ戻る', onClick: handlers.onBack },
      {
        index: 8,
        name: 'キーフレーム',
        phase: vm.phase8,
        canEnter: vm.canEnterPhase8,
        implemented: vm.phase8Implemented,
        blockedReason: vm.phase8BlockedReason,
        lockNote: vm.phase8LockNote,
        onClick: handlers.onEnterPhase8,
      },
    ),
  );
}

function renderPreview(vm: Phase7ViewModel, handlers: Phase7Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;
  if (vm.trackLive) {
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0 ? `${vm.sourceWidth} / ${vm.sourceHeight}` : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
      ]),
      el('p', { class: 'footnote' }, [
        s.fusionFrames > 0
          ? '統合後の姿勢についても、Phase 6 と同じ理由で何も画像の上に描いていません。' +
            '姿勢は端末のもので、画面上のどの点のものでもありませんし、' +
            'ここにもまだ印を付けるべき深度がありません。'
          : vm.running
            ? '最初の統合フレームを待っています。'
            : '姿勢の復元は動作中です。統合はまだ開始されていません。',
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
              : '統合は未起動です';
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
        id: 'start-fusion',
        // §H.5, for the fifth time and from the one predicate. Six stages are already live when
        // this screen opens; a predicate assembled from any of them cannot be pressed.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '統合中' : vm.opening ? '要求中…' : 'IMU 統合開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-fusion',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('カメラ', children);
}

/** IMU-005 — the gate. Nothing else here distinguishes a filter from a pass-through. */
function renderInjection(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.biasSamples >= MIN_BIAS_SAMPLES_JUDGED;
  const off = Math.abs(s.medianBiasDifferenceDps - s.requestedInjectionDps);
  const found = enough && off <= BIAS_TOLERANCE_DPS;
  const onAxis =
    enough && s.medianBiasAxisErrorDeg >= 0 && s.medianBiasAxisErrorDeg <= BIAS_AXIS_TOLERANCE_DEG;

  return card('教えていないバイアスをフィルタは見つけるか？', [
    el('div', { class: 'stat-grid' }, [
      stat('仕込んだバイアス', `${GYRO_BIAS_INJECTION_DPS} °/s`),
      stat('復元できた差', dps(s.medianBiasDifferenceDps), enough ? (found ? OK : BAD) : ''),
      stat('仕込んだ軸からのずれ', deg(s.medianBiasAxisErrorDeg), enough ? (onAxis ? OK : BAD) : ''),
      stat('サンプル数', enough ? String(s.biasSamples) : `${s.biasSamples} / ${MIN_BIAS_SAMPLES_JUDGED}`),
      stat('この端末自身のバイアス', vec(s.gyroBiasDps)),
      stat('仕込んだ方向', vec(s.injectionAxis)),
      stat(
        '端末 → カメラ',
        s.handEye.calibrated ? `${s.handEye.pairs} 組 · ${deg(s.handEye.residualDeg)}` : null,
        s.handEye.calibrated ? OK : BAD,
      ),
    ]),
    el('p', { class: 'footnote' }, [
      s.handEye.calibrated
        ? 'ジャイロは**端末**の座標系で報告し、Phase 6 の姿勢は**カメラ**の座標系にあります。' +
          '両者は固定の回転だけ違っていて、それをこのフェーズが測るまで誰も測っていませんでした。' +
          `いまは ${s.handEye.pairs} 組の回転 — 両方の計測器が見た同じ1回の回転 — から推定して` +
          `おり、軸の残差の中央値は ${deg(s.handEye.residualDeg)}、軸の広がりは ` +
          `${s.handEye.axisSpread} です。これが判るまで、何も統合しません。`
        : `**統合していません。** ${s.handEye.reason}。ジャイロは端末の座標系で報告し、` +
          'Phase 6 の姿勢はカメラの座標系にあります。両者のあいだの回転を測るまで、' +
          'それらを正直に合成する方法はありません。恒等回転は中立な既定値ではなく、' +
          '「センサーとレンズは軸を共有している」という未計測の主張です。' +
          `較正のために読んだサンプルは ${s.handEye.uncalibratedSamples} 件で、` +
          'いずれも姿勢には使っていません。',
    ]),
    el('p', { class: 'footnote' }, [
      `同じ視覚姿勢と同じジャイロの上で、2つのフィルタを走らせます。片方には、見せる前に` +
        `すべてのサンプルに一定の ${GYRO_BIAS_INJECTION_DPS} °/s を足しておきます。` +
        'どちらのフィルタも自分がどちらかを知りません。計測するのは両者のバイアス推定の' +
        '**差**です。この端末自身のバイアスは未知ですが両者に共通なので、差を取ると' +
        '打ち消えます。実際のバイアスを誰も調べられない端末の上で、これが判定可能になる理由です。',
    ]),
    el('p', { class: 'footnote' }, [
      '「この端末自身のバイアス」は対照側フィルタの推定値です。これはまさにこのジャイロの' +
        'バイアスであり、知る価値があるので表示しています。テストが判定に' +
        '使っているのはこちらではありません。',
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 7 の中で、視覚姿勢をそのまま返すだけの統合が作れない数値はこれだけです。' +
        'そういう統合はカメラを完璧に追い、イノベーションはちょうどゼロ — 本物のフィルタより' +
        '良いほどに — で、位置を捏造することもありません。そしてここでは 0.0 °/s になります。' +
        'v3 §68 が求めているのはまったく別のことで、それは下の IMU-002 で判定します。',
    ]),
    el('p', { class: 'footnote' }, [
      `この差は、視覚更新が ${MIN_BIAS_SAMPLES_JUDGED} 回適用されるまで伏せられます。` +
        '推定にそれだけ要るからではありません。回転している端末では重力だけでもバイアスは' +
        'かなり良く推定でき、それは単体テストのフィクスチャで計測済みです。伏せるのは、' +
        '自律航法だけでも出せる数値を、統合の関門にはできないからです。',
    ]),
    ...(s.biasDifferences.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近の計測']),
          ...s.biasDifferences.slice(-4).map((b) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`更新 ${b.visualUpdates} 回`]),
              el('span', { class: 'cap-method' }, [
                `${dps(b.magnitudeDps)} · 軸のずれ ${deg(b.axisErrorDeg)}`,
              ]),
              el('span', {
                class: `cap-state ${
                  Math.abs(b.magnitudeDps - s.requestedInjectionDps) <= BIAS_TOLERANCE_DPS ? OK : BAD
                }`,
              }, [vec(b.differenceDps) ?? '—']),
            ]),
          ),
        ]
      : []),
  ]);
}

/** IMU-002 and IMU-007 — the mode, which is the spec's own pass condition and its dropout. */
function renderMode(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const propagating = s.mode === FusionMode.DEAD_RECKONING;
  return card('モード', [
    el('div', { class: 'stat-grid' }, [
      stat('現在', s.mode, s.mode === FusionMode.FUSED ? OK : ''),
      stat('使用可能', s.usable ? 'はい' : 'いいえ', s.usable ? OK : BAD),
      stat('外挿の継続時間', s.propagatedMs < 0 ? null : `${Math.round(s.propagatedMs)} ms`,
        propagating ? (s.propagatedMs > MAX_PROPAGATION_MS ? BAD : '') : ''),
      stat('フレーム', `統合 ${s.fusedFrames} · 開ループ ${s.dropoutFrames}`),
      stat('最長の途切れ', s.longestPropagatedMs < 0 ? null : `${Math.round(s.longestPropagatedMs)} ms`),
      stat('復帰時のずれ', deg(s.medianReconvergenceInnovationDeg)),
    ]),
    el('p', { class: 'footnote' }, [
      `${FusionMode.VISION_ONLY} は、IMU が何も報告しておらず、統合後の姿勢が視覚の姿勢` +
        '**そのもの**であることを意味します。これは劣化状態ではありません。v3 §68 の合格条件' +
        'そのままです: IMU unavailableでもVision-only modeで継続可能。' +
        '存在しないセンサーから何かを作り出すことはせず、バイアスはゼロではなく null になります。',
    ]),
    el('p', { class: 'footnote' }, [
      `${FusionMode.DEAD_RECKONING} は、視覚が ${DEAD_RECKONING_AFTER_MS} ms 以上前に止まり、` +
        `ジャイロだけで姿勢を保っている状態です。${MAX_PROPAGATION_MS} ms を超えると、その姿勢は` +
        '「使用可能」として提供しなくなります。v3 §17 はジャイロに 短時間回転推定 を認めていますが' +
        '「どれくらい短時間か」は書いていません。3秒というのは、民生品でよくある約 1 °/s の' +
        'バイアスが Phase 6 自身の一致基準である 3° を積み上げてしまう時点 — 外挿した姿勢が' +
        '計測値と同等ではなくなる時点 — です。',
    ]),
    el('p', { class: 'footnote' }, [
      '外挿のあいだ信頼度は下がり続け、視覚が戻ったときの飛びは、吸収せずに上へ記録します。' +
        '黙って元に戻るフィルタは、2つの計測器が最も食い違ったその瞬間を隠していることになります。',
    ]),
  ]);
}

/** IMU-001 — what is actually arriving, never what the platform advertised. */
function renderSensors(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  return card('センサー', [
    el('div', { class: 'stat-grid' }, [
      stat('IMU', s.imuAvailable ? '受信中' : '利用できません', s.imuAvailable ? OK : ''),
      stat('実測レート', s.measuredImuHz < 0 ? null : `${s.measuredImuHz} Hz`),
      stat('プラットフォームの公称', s.reportedImuHz < 0 ? null : `${s.reportedImuHz} Hz`),
      stat('サンプル数', String(s.imuSamples)),
      stat('採用した重力', `${s.gravitySamples} · 棄却 ${s.gravityRejected}`),
      stat('外挿したフレーム', `${s.propagatingFrames} / ${MIN_JUDGED_FRAMES}`,
        s.propagatingFrames >= MIN_JUDGED_FRAMES ? OK : ''),
    ]),
    ...s.sensors.map((c) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [c.name]),
        el('span', { class: 'cap-method' }, [c.detail]),
        el('span', { class: `cap-state ${c.arriving ? OK : ''}` }, [
          c.arriving ? '受信中' : '来ていません',
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [s.imuReason]),
    el('p', { class: 'footnote' }, [
      `重力のサンプルを使うのは、‖a+g − a‖ が 9.81 の ±${GRAVITY_TOLERANCE_MS2} m/s² 以内に` +
        'あるときだけです。そこから外れていれば端末は加速しており、その差はそもそも重力の' +
        '向きではありません。なのでノイズを大きくして取り込むのではなく、棄却します。' +
        '別の量を測ってしまったものは、正しい量をノイズ混じりに測ったものではありません。',
    ]),
    el('p', { class: 'footnote' }, [
      'ワールド座標系は、符号の慣習から仮定するのではなく、最初に採用した重力の読みで' +
        '*定義*します。`accelerationIncludingGravity` の符号はプラットフォームごとに食い違って' +
        'おり、1台の端末の1サンプルでは決着しません。なので符号は仮定しません。' +
        '初期化時に重力が指していた向きが、そのまま「下」です。',
    ]),
  ]);
}

/** IMU-003 and IMU-004 — the two instruments, and how far apart they are. */
function renderConsistency(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.innovationSamples >= MIN_JUDGED_FRAMES;
  const within = enough && s.medianInnovationDeg >= 0 && s.medianInnovationDeg <= s.toleranceDeg;
  const copying = enough && s.zeroInnovationSamples === s.innovationSamples;
  return card('視覚とジャイロの突き合わせ', [
    el('div', { class: 'stat-grid' }, [
      stat('カメラが回った角度', deg(s.medianVisualIncrementDeg)),
      stat('予測のずれ', deg(s.medianInnovationDeg), enough ? (within ? OK : BAD) : ''),
      stat('許容範囲', deg(s.toleranceDeg)),
      stat('更新回数', enough ? String(s.innovationSamples) : `${s.innovationSamples} / ${MIN_JUDGED_FRAMES}`),
      stat('ちょうどゼロ', String(s.zeroInnovationSamples), copying ? BAD : ''),
      stat('重力の食い違い', deg(s.medianGravityDeg),
        s.gravityDegSamples > 0 && s.medianGravityDeg > GRAVITY_AGREEMENT_DEG ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `1回の更新はおよそ ${VISUAL_UPDATE_INTERVAL_MS} ms を張ります。その区間でジャイロを積分して` +
        'カメラがどこに到達するはずかを予測し、視覚の増分が実際にどこへ到達したかを言います。' +
        'その差がイノベーションで、予測とコピーを分ける数値です。予測が常に計測値と' +
        'ぴったり一致する「統合」は、何も予測していません。',
    ]),
    el('p', { class: 'footnote' }, [
      '区間が1フレームではなく1秒なのは、その実行がバイアスについて集められる情報量が' +
        '区間長に比例するからです。半分にすれば学べる量も半分になり、1フレームごとの更新では' +
        '3 °/s の注入を許容範囲の中で「何もなし」と区別できません。',
    ]),
    el('p', { class: 'footnote' }, [
      '許容範囲は Phase 6 のものをそのまま流用しています: max(3°, 実測値の 30 %)。' +
        'POSE-002 が比べたのと同じ2つの計測器なので、ここで新しい許容範囲を作れば、' +
        '「カメラとジャイロが一致しているとはどういうことか」について2つのフェーズが' +
        '食い違うことになります。',
    ]),
  ]);
}

/** IMU-006 — the refusal, with the number behind it. */
function renderPosition(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  return card('位置', [
    el('div', { class: 'stat-grid' }, [
      stat('位置', 'UNAVAILABLE', s.positionsReported > 0 ? BAD : OK),
      stat('スケール', s.scale, s.scaleViolations > 0 ? BAD : OK),
      stat('方位', s.heading),
      stat('位置を持つ記録', String(s.positionsReported), s.positionsReported > 0 ? BAD : OK),
      stat('もし積分していたら', s.deadReckonedPositionM < 0 ? null : `${s.deadReckonedPositionM} m`),
      stat('…その経過時間', s.deadReckonedSeconds < 0 ? null : `${s.deadReckonedSeconds} s`),
    ]),
    el('p', { class: 'footnote' }, [s.positionReason]),
    el('p', { class: 'footnote' }, [s.velocityReason]),
    el('p', { class: 'footnote' }, [s.accelBiasReason]),
    el('p', { class: 'footnote' }, [
      '最後の2つは、この実行で加速度計を二重積分していたら*出ていたはず*の値です。' +
        '計算はしていますが、姿勢に渡すことは決してありません。拒否が引用ではなく数値を' +
        '伴うようにするために存在します。v3 §17 は2度そう言っています: Acceleration: ' +
        '長時間の絶対位置推定には直接使用しない、および IMUだけを積分して絶対位置を生成してはならない。',
    ]),
    el('p', { class: 'footnote' }, [
      'UNAVAILABLE は欄が無いのではなく、**値**です。Phase 9 は三角測量し、Phase 11 は平面を' +
        '当てはめ、Phase 19 はボールを落とします。どれも下のフェーズが渡したものを読むので、' +
        '後のフェーズはこれを、忘れることによってではなく、意図的に取り除く必要があります。',
    ]),
  ]);
}

/** IMU-004 — v3 §19's seventh term, and the prohibition that governs it. */
function renderConfidence(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const raised = s.fusedAboveVisual > 0;
  return card('信頼度（v3 §19、7つの入力すべて）', [
    el('div', { class: 'stat-grid' }, [
      stat('統合後', s.confidence < 0 ? null : String(s.confidence), raised ? BAD : OK),
      stat('Phase 6（視覚のみ）', s.visualConfidence < 0 ? null : String(s.visualConfidence)),
      stat('IMU consistency', s.imuConsistency < 0 ? '保留' : String(s.imuConsistency)),
      stat('最低まで下がった値', s.minImuConsistency < 0 ? null : String(s.minImuConsistency)),
      stat('1 を下回ったフレーム', String(s.imuConsistencyBelowOne)),
      stat('最悪の項を上回った回数', String(s.confidenceAboveWorstTerm),
        s.confidenceAboveWorstTerm > 0 ? BAD : OK),
    ]),
    el('p', { class: 'group-title' }, ['各項']),
    ...s.confidenceTerms.map((t) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [t.name]),
        el('span', { class: 'cap-method' }, [t.note]),
        el('span', { class: `cap-state ${t.value < 0 ? '' : t.value >= 0.75 ? OK : ''}` }, [
          t.value < 0 ? '保留' : String(t.value),
        ]),
      ]),
    ),
    ...s.confidenceWithheld.map((w) => el('p', { class: 'footnote' }, [w])),
    el('p', { class: 'footnote' }, [
      'これは Phase 6 の値を書き換えたものではなく、**別の**数値です。Phase 6 の信頼度は' +
        '視覚による姿勢を表すもので、`IMU consistency` を意図的に保留しています。' +
        'それは POSE-002 がそのフェーズを採点するのに使った計測器だからです。Phase 6 は' +
        'その構成のまま実機で合格しており、いま変えることは合格済みのフェーズを書き換えることです。',
    ]),
    el('p', { class: 'footnote' }, [
      '統合後の数値は各項の**最小値**なので、視覚のみの値を上回ることは決してありません。' +
        '統合側の項は視覚側の項に2つ加えたものであり、上位集合の最小値が部分集合の最小値を' +
        '超えることはないからです。センサーを足すことは信頼度を下げ得ても、上げることは' +
        'あり得ません — v3 §19: 不確実なPoseは強制的に高confidenceにしない。',
    ]),
    el('p', { class: 'footnote' }, [
      '`propagation` は §19 の7項には入っていません。ここにあるのは、§17 が外挿した姿勢の' +
        '有効な長さを制限しているからです。開ループで走っているあいだ下がりようのない信頼度は、' +
        'その制限が無いと主張しているのと同じになってしまいます。',
    ]),
  ]);
}

function renderCost(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanFusionMs >= 0 && s.meanFusionMs <= FUSION_BUDGET_MS;
  return card('コスト（§H にこの項目はない）', [
    el('div', { class: 'stat-grid' }, [
      stat('統合', s.meanFusionMs >= 0 ? `${s.meanFusionMs} ms` : null,
        s.meanFusionMs >= 0 ? (within ? OK : BAD) : ''),
      stat('予算', `${FUSION_BUDGET_MS} ms`),
      stat('サンプル数', String(s.fusionCostSamples)),
      stat('センサーのレート', s.measuredImuHz < 0 ? null : `${s.measuredImuHz} Hz`),
    ]),
    el('p', { class: 'footnote' }, [
      '§H は持っているミリ秒をすべて割り当てています — 取得 6、Shi-Tomasi 償却 8、LK 14、' +
        '往復 4、RANSAC と姿勢 6 — そして統合の項目はありません。つまりここでかかる分は' +
        `紙の上には存在しない余白から出ています。上の ${FUSION_BUDGET_MS} ms は、` +
        '与えられた上限ではなく、このフェーズが自分に課した上限です。',
    ]),
    el('p', { class: 'footnote' }, [
      '姿勢の誤差状態フィルタは、1サンプルあたり 3×3 の演算がいくつかあるだけです。' +
        '60 Hz で 1 ms に近づくとすれば、それはプラットフォームの事実ではなく実装の誤りです。' +
        'IMU-008 が参考扱いで別に判定されるのはそのためです（§34、§H.4）。',
    ]),
  ]);
}

