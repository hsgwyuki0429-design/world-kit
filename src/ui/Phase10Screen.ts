/**
 * LANDMARK MAP screen (Phase 10, v4 §22, §56, §34).
 *
 * The first screen with a **world** on it, and four things are here because of what a world can
 * be faked into.
 *
 *  - **"Does the map predict what has not happened yet?" is the top panel.** A map that
 *    overwrites each landmark with the newest triangulation agrees with every observation
 *    exactly, is never inconsistent, and has nothing to predict *with*. The held-out error is the
 *    only figure it cannot produce.
 *  - **The injection is beside it**, with the false-cull rate printed next to the recall, because
 *    a map that rejects everything scores a perfect recall and one that rejects nothing scores a
 *    perfect false-cull rate. GEO-003's pair, one layer up.
 *  - **The registration's scale is shown as a ratio, never as a length.** It is the number this
 *    phase exists to recover, and it is what makes Phase 9's ninety separate answers one map.
 *  - **The sparsity is a number.** v4 §22 forbids treating this as a model; a screen full of
 *    points implies otherwise unless it says how few of them there are and what lies between.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  INJECTION_RECALL_FLOOR,
  LANDMARK_BUDGET_MS,
  LANDMARK_INJECTION_FRACTION,
  MAX_CLEAN_CULL_EXCESS,
  MAX_LANDMARKS,
  MAX_LANDMARK_REPROJECTION_PX,
  MAX_REGISTRATION_RESIDUAL,
  MIN_INJECTIONS,
  MIN_JUDGED_BATCHES,
  MIN_OBSERVATIONS_CONFIRMED,
  MIN_REGISTRATION_POINTS,
} from '../testkit/Phase10Tests';
import type { LandmarkStats } from '../tracking/landmarkStats';
import { BAD, OK, card, deg, el, num, pct, px, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase10ViewModel {
  readonly phase10: PhaseInfo;
  readonly phase11: PhaseInfo;
  readonly canEnterPhase11: boolean;
  readonly phase11Implemented: boolean;
  readonly phase11BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase11LockNote: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly running: boolean;
  readonly stats: LandmarkStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase10Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase11: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase10Screen(
  root: HTMLElement,
  vm: Phase10ViewModel,
  handlers: Phase10Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['ランドマーク地図']),
      el('p', {}, [
        'Phase 10 — Phase 9 が90個ばらばらの答えとして残したものを、1つの座標系にまとめます。' +
          '各バッチはその組自身の基線を単位としており、2つのバッチが共有するランドマークが' +
          '両者の比を決めます。単眼カメラに使える仕組みはこれだけです。この世界は' +
          '一貫した単位を持ちますが、その単位が何メートルなのかは分かりません。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPrediction(vm));
  root.append(renderInjection(vm));
  root.append(renderRegistration(vm));
  root.append(renderMap(vm));
  root.append(renderConvergence(vm));
  root.append(renderNotAModel(vm));
  root.append(renderCost(vm));
  root.append(testsSection(10, vm.phase10, vm.results));
  root.append(
    evidenceSection(10, vm.phase10, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 9, label: '三角測量へ戻る', onClick: handlers.onBack },
      {
        index: 11,
        name: '面の認識',
        phase: vm.phase11,
        canEnter: vm.canEnterPhase11,
        implemented: vm.phase11Implemented,
        blockedReason: vm.phase11BlockedReason,
        lockNote: vm.phase11LockNote,
        onClick: handlers.onEnterPhase11,
      },
    ),
  );
}

function renderPreview(vm: Phase10ViewModel, handlers: Phase10Handlers): HTMLElement {
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
        s.batches > 0
          ? 'ランドマークは画像の上に描いていません。カメラ映像の上に数百個の点が乗ると' +
            '「再構成」に見えてしまいますが、v4 §22 は一行で「これは再構成ではない」と' +
            '言っています。なので、それを見せることを仕事とするフェーズができるまで、' +
            '地図は数値として報告します。'
          : vm.running
            ? '最初のバッチを待っています。地図には、Phase 9 が三角測量できたキーフレームの組が要ります。'
            : '三角測量は動作中です。地図はまだ開始されていません。',
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
              : 'ランドマーク地図は未起動です';
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
        id: 'start-landmarks',
        // §H.5, for the eighth time and from the one predicate.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '地図を作成中' : vm.opening ? '要求中…' : 'ランドマーク地図開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-landmarks',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('カメラ', children);
}

/** MAP-002 — the gate. Nothing else here separates a map from a list of the last batch. */
function renderPrediction(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.heldOutBatches >= MIN_JUDGED_BATCHES;
  const within = enough && s.medianHeldOutPx <= MAX_LANDMARK_REPROJECTION_PX;
  const copying = enough && s.heldOutSamples > 0 && s.zeroHeldOut === s.heldOutSamples;
  return card('地図は、見ていないものを予測できるか？', [
    el('div', { class: 'stat-grid' }, [
      stat('取り置いた視点での誤差', px(s.medianHeldOutPx), enough ? (within ? OK : BAD) : ''),
      stat('上限', `${MAX_LANDMARK_REPROJECTION_PX} px`),
      stat('最悪', px(s.worstHeldOutPx)),
      stat('バッチ数', enough ? String(s.heldOutBatches) : `${s.heldOutBatches} / ${MIN_JUDGED_BATCHES}`),
      stat('ちょうどゼロ', String(s.zeroHeldOut), copying ? BAD : ''),
      stat('尋ねた時点の観測数', num(s.medianObservationsAtPrediction)),
    ]),
    el('p', { class: 'footnote' }, [
      'ランドマークの位置を、**このバッチの前に地図が保持していた状態のまま**、' +
        'バッチがいま追加したキーフレーム — その位置の計算には使われていない視点 — へ投影し、' +
        '追跡器が実際に見た場所と比べます。各ランドマークがその時点で持っていた観測数も' +
        '記録と一緒に残るので、「前の状態」はコードの主張ではなくエビデンスが語る事実になります。',
    ]),
    el('p', { class: 'footnote' }, [
      '記憶を持たない地図が作れない数値はこれだけです。各ランドマークを最新の三角測量で' +
        '上書きすれば、すべての観測とぴったり一致し、矛盾も起こさず、個数の勘定も合います。' +
        'そして予測に使えるものが何ひとつありません。',
    ]),
  ]);
}

/** MAP-005 — the second gate, with GEO-003's pair of numbers. */
function renderInjection(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injections >= MIN_INJECTIONS;
  const found = enough && s.medianRecall >= INJECTION_RECALL_FLOOR;
  const spared = enough && s.medianCleanExcess <= MAX_CLEAN_CULL_EXCESS;
  return card('地図は、教えられていないものを見つけるか？', [
    el('div', { class: 'stat-grid' }, [
      stat('検出率', pct(s.medianRecall), enough ? (found ? OK : BAD) : ''),
      stat('下限', pct(INJECTION_RECALL_FLOOR)),
      stat('無傷の点の棄却率', pct(s.medianCleanRejectionRate)),
      stat('…何も仕込まない時の同じ関門の棄却率', pct(s.medianBaselineRejectionRate)),
      stat('超過分', pct(s.medianCleanExcess), enough ? (spared ? OK : BAD) : ''),
      stat('上限', pct(MAX_CLEAN_CULL_EXCESS)),
      stat('注入回数', enough ? String(s.injections) : `${s.injections} / ${MIN_INJECTIONS}`),
      stat('ずらした量', px(s.injectionDisplacementPx)),
    ]),
    el('p', { class: 'footnote' }, [
      `バッチの位置のうち既知の一部を、**視線に垂直な向き**へ、その点の深度の ` +
        `${LANDMARK_INJECTION_FRACTION} だけずらし、印を付けずに渡します。点を視線に*沿って*` +
        '動かすと深度は変わりますが画像上ではほとんど動きません。横に動かすと投影は ' +
        '`f · Δ/Z` だけ動き、`Δ = 0.05 Z` では深度が打ち消えます。つまり近い点でも遠い点でも' +
        '画素上のずれが同じになります。',
    ]),
    el('p', { class: 'footnote' }, [
      '地図には、実際にやらせるのではなく「どうする*はず*か」を尋ねています。' +
        'そうすれば、関門が働くかを調べる行為が、計測対象そのものを汚さずに済みます。' +
        'GEO-003 が対応点集合そのものではなく写しを検証しているのも同じ理由です。',
    ]),
    el('p', { class: 'footnote' }, [
      'どの数値も全部報告しています。1つだけならどれも、何かしら退化した地図が満点を' +
        '取れてしまうからです。検出率は「全部棄却する」地図が、無傷の棄却率は「何も棄却しない」' +
        '地図が、そして無傷の棄却率の*絶対値*は、何も起きていないシーンが満点にします。',
    ]),
    el('p', { class: 'footnote' }, [
      '判定に使うのは**超過分**です。この関門は1つの点についての2つの推定を比べるので、' +
        '何も仕込まなくても、両者の食い違いの裾をある程度は棄却します。同じバッチに対して' +
        '何も仕込まずに同じ関門を通した結果が、上に出ている基準値です。基準が問うているのは、' +
        'バッチの3分の1を汚したことで、関門が無実の点まで疑うようになったかどうかです。',
    ]),
  ]);
}

/** MAP-003 — the scale, which is the whole point of the phase. */
function renderRegistration(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.medianRegistrationResidual >= 0 && s.medianRegistrationResidual <= MAX_REGISTRATION_RESIDUAL;
  return card('1つの座標系', [
    el('div', { class: 'stat-grid' }, [
      stat('位置合わせできたバッチ', `${s.registeredBatches} / ${s.batches}`),
      stat('復元したスケール', num(s.medianRegistrationScale)),
      stat('残差', s.medianRegistrationResidual < 0 ? null : String(s.medianRegistrationResidual),
        s.registeredBatches > 0 ? (within ? OK : BAD) : ''),
      stat('上限', String(MAX_REGISTRATION_RESIDUAL)),
      stat('世代', `${s.epochs}（うち再起動 ${s.epochRestarts} 回）`),
      stat('スケール', s.scale, s.scaleViolations > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      `相似変換 — 自由度7、閉形式 — を、各バッチの座標系からワールドへ、両者が共有する` +
        `ランドマーク（最低 ${MIN_REGISTRATION_POINTS} 個）の上で当てはめます。` +
        '**そのスケール項が、そのバッチの基線とワールドの基線の比**であり、単眼カメラが' +
        'それ以外の方法では得られない量です。これは比であって、長さでは決してありません。',
    ]),
    el('p', { class: 'footnote' }, [
      '残差は深度に対する相対値です。ワールドの単位は、誰もその長さを測っていない基線だから' +
        'です。上限は Phase 9 の深度不確かさの上限の半分にしてあります。その値まで来た' +
        '位置合わせは、深度がもともと抱えている誤差と同じだけの誤差を足したことになります。',
    ]),
    ...(Object.keys(s.unregisteredReasons).length > 0
      ? [
          el('p', { class: 'footnote' }, [
            `地図が位置合わせできなかったバッチ: ${JSON.stringify(s.unregisteredReasons)}。` +
              'これらは取り込みません。置き場所を決められないバッチは、その点が任意の場所に' +
              '行ってしまうバッチだからです。',
          ]),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      '5バッチ連続で位置合わせできないと、ワールドを定義し直し、世代の数が増えます。' +
        '§H.8 の3分類 — 失敗した、再起動した、名前の付けられる理由で中断した — であり、' +
        '世代が何度も変わった実行は、一度も変わらなかった実行と同じ実行ではありません。',
    ]),
  ]);
}

/** MAP-001 and MAP-004 — what the map holds, and what it let go of. */
function renderMap(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  return card('地図', [
    el('div', { class: 'stat-grid' }, [
      stat('ランドマーク', `${s.landmarks} / ${MAX_LANDMARKS}`, s.boundBreaches > 0 ? BAD : OK),
      stat('確定', `${s.confirmed}（最大 ${s.peakConfirmed}）`),
      stat('…確定の条件', `観測 ${MIN_OBSERVATIONS_CONFIRMED} 回`),
      stat('信頼度の中央値', num(s.medianConfidence)),
      stat('除去', String(s.culled)),
      stat('直近のバッチ', `新規 ${s.admitted} · 統合 ${s.merged} · 拒否 ${s.rejected}`),
    ]),
    ...s.samples.map((l) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${l.id}`]),
        el('span', { class: 'cap-method' }, [
          `${vec(l.position)} · ${l.keyframes} 視点から観測 ${l.observations} 回 · ` +
            `視差 ${deg(l.maxParallaxDeg)} · 予測誤差 ${px(l.meanPredictionPx)} 以内`,
        ]),
        el('span', { class: `cap-state ${l.state === 'CONFIRMED' ? OK : ''}` }, [
          String(l.confidence),
        ]),
      ]),
    ),
    ...(s.recentCulls.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近除去したもの']),
          ...s.recentCulls.slice(-4).map((c) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`#${c.id}`]),
              el('span', { class: 'cap-method' }, [c.detail]),
              el('span', { class: 'cap-state' }, [c.reason]),
            ]),
          ),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      '信頼度は、実測した4つの項の**最小値**です — 観測回数、その点を決めた視差、' +
        '予測がどれだけ当たるか、いくつの視点から見えたか。どれも時計ではありません。' +
        '長く見えているというだけでは良いランドマークにはならないので、' +
        '`audit-fake-data.mjs` が「時間に依存しないこと」をレビュー任せにせず機械的に強制しています。',
    ]),
  ]);
}

/** MAP-006 — does a position settle, or does it wander? */
function renderConvergence(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const settling =
    s.moveAtTwoSamples > 0 && s.moveAtFiveSamples > 0 && s.moveAtFive <= s.moveAtTwo;
  return card('収束', [
    el('div', { class: 'stat-grid' }, [
      stat('観測2回目での移動量', s.moveAtTwo < 0 ? null : String(s.moveAtTwo)),
      stat('…5回目以降', s.moveAtFive < 0 ? null : String(s.moveAtFive),
        s.moveAtFiveSamples > 0 ? (settling ? OK : BAD) : ''),
      stat('サンプル数', `${s.moveAtTwoSamples} · ${s.moveAtFiveSamples}`),
      stat('移動量の中央値', s.medianMoveRelative < 0 ? null : String(s.medianMoveRelative)),
    ]),
    el('p', { class: 'footnote' }, [
      'ランドマークの位置はその観測の逐次平均なので、新しい観測1つが動かす量は 1/n で' +
        '小さくなります。数値はそのランドマーク自身の深度に対する相対値です。ワールドの単位に' +
        '長さがない以上、絶対値での移動量は任意のスケールでの移動量にしかならないからです。',
    ]),
    el('p', { class: 'footnote' }, [
      '毎回推定し直す地図は、代わりにランダムウォークします。両者を区別できるのはまさに' +
        'この数値です。ランダムウォークの歩幅は、歩数が増えても小さくなりません。',
    ]),
  ]);
}

/** MAP-007 — v4 §22's second line, as a value. */
function renderNotAModel(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  return card('これが何ではないか', [
    el('div', { class: 'stat-grid' }, [
      stat('面', 'なし', OK),
      stat('メッシュ', 'なし', OK),
      stat('網羅性', '主張しない', OK),
      stat('キーフレームあたりのランドマーク', num(s.landmarksPerKeyframe)),
      stat('…追跡中の特徴点あたり', num(s.landmarksPerTrackedFeature)),
      stat('確定', `${s.confirmed} · 地図の ${pct(s.confirmedShare)}`),
    ]),
    el('p', { class: 'footnote' }, [s.modelClaim]),
    el('p', { class: 'footnote' }, [
      '密度の数値が、「疎である」ことを計測値にしています。画面いっぱいの点は再構成に' +
        '見えますが、1視点あたり十数か所を、部屋がそれと矛盾しないあいだだけ保持している' +
        'ものは、ありのままに見えます。面が始まるのは Phase 11 で、その材料がこれです。',
    ]),
    el('p', { class: 'footnote' }, [
      '「追跡中の特徴点あたり」は**比であって割合ではなく**、日常的に 1 を超えます。' +
        '地図はフレームから出ていった点も覚えていますが、追跡中の母数はそうではないからです。' +
        '最初これを母数に対する百分率として報告したところ 338 % と出ました — Phase 6 の実機実行が' +
        '一致率 232.3 % を報告したのと同じ形で、このプロジェクトのすべての比率が 0..1 に対して' +
        '検査される理由です。',
    ]),
  ]);
}

function renderCost(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanLandmarkMs >= 0 && s.meanLandmarkMs <= LANDMARK_BUDGET_MS;
  return card('コスト（§27 はこれをフレーム周期の外に置く）', [
    el('div', { class: 'stat-grid' }, [
      stat('バッチあたり', s.meanLandmarkMs >= 0 ? `${s.meanLandmarkMs} ms` : null,
        s.meanLandmarkMs >= 0 ? (within ? OK : BAD) : ''),
      stat('予算', `${LANDMARK_BUDGET_MS} ms`),
      stat('フレームあたりに均すと', s.amortisedMsPerFrame < 0 ? null : `${s.amortisedMsPerFrame} ms`),
      stat('計測したバッチ数', String(s.costSamples)),
    ]),
    el('p', { class: 'footnote' }, [
      'Phase 9 のバッチあたりの上限の半分です。このステージは2視点モデルを当てはめないからです。' +
        '数十点に対する閉形式の相似変換、共有ランドマーク1つにつき1回の投影、あとは帳簿付けだけです。',
    ]),
    el('p', { class: 'footnote' }, [
      '均した数値が、Phase 9 と同じく §B.2 のマッピング用ワーカーの判断の根拠にすべき値です。' +
        '2つを合わせたものが、2本目のスレッドで買えるものです。',
    ]),
  ]);
}
