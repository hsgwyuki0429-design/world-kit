/**
 * KEYFRAME SYSTEM screen (Phase 8, v3 §20, v4 §20).
 *
 * Four things are here because of what Phase 8 can fake.
 *
 *  - **"What would a metronome have kept?" is the top panel.** A selector firing on a schedule
 *    satisfies every interval, every bound and every record in this phase, and on a moving
 *    camera its keyframes are as well separated as anyone's. The two counts are shown side by
 *    side over the frames where Phase 4's own scene-shift search said the image was not moving,
 *    because that is the only place the two programs differ.
 *  - **Every one of v3 §20's conditions is listed with its measured value beside its
 *    threshold**, including the one that never fires. `TRANSLATION: UNMEASURED` is displayed as
 *    a value, with the missing scale named and with the angle the translation *direction* moved
 *    printed beside it — a refusal with a number behind it is a finding; a refusal with a
 *    citation behind it is an assertion.
 *  - **The eviction is shown with its counterfactual.** What the retained set's spread came to,
 *    and what dropping the oldest would have given. Dropping the oldest is the obvious policy
 *    and it is the wrong one, and the screen shows the number rather than the argument.
 *  - **Staleness is a surviving-observation fraction, never an age.** v4 §20 forbids using old
 *    information blindly; it does not say old information is bad.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  KEYFRAME_BUDGET_MS,
  KEYFRAME_DISPLACEMENT_PX,
  KEYFRAME_ROTATION_DEG,
  KEYFRAME_TRANSLATION_UNITS,
  MAX_KEYFRAMES,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_JUDGED_DECISIONS,
  MIN_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  MIN_STATIC_METRONOME_RATIO,
  STALE_SURVIVAL_FRACTION,
} from '../testkit/Phase8Tests';
import type { KeyframeStats } from '../tracking/keyframeStats';
import { BAD, OK, card, deg, el, num, pct, px, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase8ViewModel {
  readonly phase8: PhaseInfo;
  readonly phase9: PhaseInfo;
  readonly canEnterPhase9: boolean;
  readonly phase9Implemented: boolean;
  readonly phase9BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase9LockNote: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: the store asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: KeyframeStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase8Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase9: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase8Screen(
  root: HTMLElement,
  vm: Phase8ViewModel,
  handlers: Phase8Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['キーフレーム']),
      el('p', {}, [
        'Phase 8 — どの視点を残す価値があるか。v3 §20 は4つの条件と、最小・最大の間隔を' +
          '定めています。4つのうち3つはここで計測できますが、4つ目は並進の**大きさ**を' +
          '求めており、このプラットフォームではそれを出せません。Phase 5 の検証アンカーは' +
          'そのままの位置に留まります。Phases 5 と 6 が実機で合格したのはそれを使ってであり、' +
          'この保管庫はその置き換えではなく、横に並ぶ2つ目の構造です。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderMetronome(vm));
  root.append(renderConditions(vm));
  root.append(renderStore(vm));
  root.append(renderKeyframes(vm));
  root.append(renderRefusal(vm));
  root.append(renderCost(vm));
  root.append(testsSection(8, vm.phase8, vm.results));
  root.append(
    evidenceSection(8, vm.phase8, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 7, label: 'IMU 統合へ戻る', onClick: handlers.onBack },
      {
        index: 9,
        name: '三角測量',
        phase: vm.phase9,
        canEnter: vm.canEnterPhase9,
        implemented: vm.phase9Implemented,
        blockedReason: vm.phase9BlockedReason,
        lockNote: vm.phase9LockNote,
        onClick: handlers.onEnterPhase9,
      },
    ),
  );
}

function renderPreview(vm: Phase8ViewModel, handlers: Phase8Handlers): HTMLElement {
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
        s.decisions > 0
          ? 'キーフレームの保管庫については何も画像の上に描いていません。キーフレームは' +
            '*視点*であって、このフレームの中の場所ではありません。いまの画像の上に印を' +
            '付ければ、そこに無いものを描くことになります。'
          : vm.running
            ? '最初の判断を待っています。'
            : '統合は動作中です。キーフレームの保管庫はまだ開始されていません。',
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
              : 'キーフレームは未起動です';
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
        id: 'start-keyframes',
        // §H.5, for the sixth time and from the one predicate. Seven stages are already live
        // when this screen opens; a predicate assembled from any of them cannot be pressed.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '保管中' : vm.opening ? '要求中…' : 'キーフレーム開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-keyframes',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('カメラ', children);
}

/** KEY-002 — the gate. Nothing else here distinguishes a selector from a schedule. */
function renderMetronome(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.staticDecisions >= MIN_JUDGED_DECISIONS;
  const ahead =
    enough && s.staticMetronomeInsertions >= MIN_STATIC_METRONOME_RATIO * s.staticSelectorInsertions;
  return card('メトロノームなら何を残したか？', [
    el('div', { class: 'stat-grid' }, [
      stat('静止時の判断', enough ? String(s.staticDecisions) : `${s.staticDecisions} / ${MIN_JUDGED_DECISIONS}`),
      stat('この選択器が残した数', String(s.staticSelectorInsertions), enough ? (ahead ? OK : BAD) : ''),
      stat('メトロノームなら残した数', String(s.staticMetronomeInsertions)),
      stat('比', s.staticRatio < 0 ? null : `${s.staticRatio} 倍`, enough ? (ahead ? OK : BAD) : ''),
      stat('…必要な比', `${MIN_STATIC_METRONOME_RATIO} 倍`),
      stat('何も動いていないのに幾何条件で挿入', String(s.stillIntervalGeometricInsertions),
        s.stillIntervalGeometricInsertions > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      `同じフレームの上で2つ目の選択器が走り、${MIN_KEYFRAME_INTERVAL_MS} ms ごとに発火します。` +
        'こちらが*許されている*のと同じ頻度です。動いているカメラでは両者は似て見えます。' +
        '動いているカメラなら、どんなスケジュールでも離れた視点が得られるからです。' +
        '動いていないカメラで両者は分かれます。キーフレーム機構とスケジュールが違う場所は' +
        'そこだけです。',
    ]),
    el('p', { class: 'footnote' }, [
      '画像が動いているかどうかを決めているのは**ここではありません**。Phase 4 の独立した' +
        'シーンシフト探索 — 追跡器とコードを共有せず、特徴点リストを一切見ない全探索の' +
        '整数探索 — が、画像の動きが 1 px 未満のときに `STATIC` と報告します。' +
        '自分のテスト条件を自分で分類するフェーズは、自分の答案を自分で採点していることになります。',
    ]),
    el('p', { class: 'footnote' }, [
      '選択器の落ち度として数えるのは、**その区間で何も動いていない**のに幾何条件で挿入した' +
        '場合です。たまたま静止フレームに当たっただけのものは数えません。条件は前のキーフレーム' +
        'からの区間で積み上がるので、そこから 30 px 離れた視点は、最小間隔が経過した瞬間に' +
        '画像がたまたま静止していようといまいと、30 px 離れています。' +
        `静止フレームに当たった挿入は ${s.staticGeometricInsertions} 件、そのうち区間全体で` +
        `何も動いていなかったものが ${s.stillIntervalGeometricInsertions} 件です。`,
    ]),
    el('p', { class: 'footnote' }, [
      `いまのフレームの判定は ${s.frameMotion || '—'} です。`,
    ]),
  ]);
}

/** KEY-001 and KEY-005 — v3 §20's conditions, every one of them, with the one that cannot fire. */
function renderConditions(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  return card('v3 §20 の条件（このフレーム）', [
    el('div', { class: 'stat-grid' }, [
      stat('判断', s.reason || '—', s.inserted ? OK : ''),
      stat('前回からの経過', s.sinceLastMs < 0 ? null : `${Math.round(s.sinceLastMs)} ms`),
      stat('許される間隔', `${MIN_KEYFRAME_INTERVAL_MS}–${MAX_KEYFRAME_INTERVAL_MS} ms`),
      stat('回転', deg(s.rotationDeg)),
      stat('変位', px(s.displacementPx)),
      stat('前回と共有している点', `${s.sharedWithLast} / ${s.observations}`),
    ]),
    ...s.conditions.map((c) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [c.name]),
        el('span', { class: 'cap-method' }, [c.note]),
        el('span', { class: `cap-state ${c.fired ? OK : ''}` }, [
          c.state === 'UNMEASURED'
            ? '計測不能'
            : c.value < 0
              ? '—'
              : `${c.value} / ${c.threshold} ${c.unit}`,
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [s.detail]),
    el('p', { class: 'footnote' }, [
      '回転は、Phase 6 の報告から読むのではなく、フレームごとの増分を積み上げています。' +
        'Phase 6 の回転は Phase 5 のアンカー基準で測られており、再アンカーをまたぐと' +
        '2つの回転は原点が違うので、その差はカメラの回転ではなくなるからです。' +
        `前のキーフレーム以降、まさにその理由で ${s.droppedIncrements} 件の増分を捨てています。` +
        'この件数を出しているのは、何件も捨てた実行では回転の値が過小になるからです。',
    ]),
    el('p', { class: 'footnote' }, [
      '変位は、この視点と前のキーフレームが**共有している**特徴点について、特徴点 id で' +
        '対応を取った上での中央値です。まさにその2つの視点のあいだの正味の変位であり、' +
        `アンカーを必要としません。v3 §20 は ${KEYFRAME_DISPLACEMENT_PX} px と ` +
        `${KEYFRAME_ROTATION_DEG}° を求めています。`,
    ]),
  ]);
}

/** KEY-001 and KEY-003 — what the store did, and what it let go of. */
function renderStore(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const clean =
    s.reasonMismatches === 0 && s.minIntervalViolations === 0 && s.maxIntervalGaps === 0;
  return card('保管庫', [
    el('div', { class: 'stat-grid' }, [
      stat('保持中', `${s.keyframes} / ${MAX_KEYFRAMES}`, s.storeOverflows > 0 ? BAD : OK),
      stat('挿入', String(s.totalInserted)),
      stat('幾何条件による挿入', String(s.geometricInsertions),
        s.totalInserted > 0 && s.geometricInsertions === 0 ? BAD : ''),
      stat('定期挿入', String(s.heartbeatInsertions)),
      stat('破棄', String(s.evictions)),
      stat('判断の回数', String(s.decisions)),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('入力から導けない理由', String(s.reasonMismatches), clean ? OK : BAD),
      stat('最小間隔より早い挿入', String(s.minIntervalViolations),
        s.minIntervalViolations > 0 ? BAD : ''),
      stat('最大間隔を超えた放置', String(s.maxIntervalGaps), s.maxIntervalGaps > 0 ? BAD : ''),
      stat('最長の間隔', s.longestGapMs < 0 ? null : `${Math.round(s.longestGapMs)} ms`),
      stat('視点の広がりを保てた破棄', `${s.evictionsCoverageKept} / ${s.evictions}`),
      stat('最新のものを破棄した回数', String(s.evictedNewest), s.evictedNewest > 0 ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      'どの判断も、その横に記録された入力から同じ純粋関数で導き直し、食い違いを数えています。' +
        'タイマーで挿入して ROTATION というラベルを貼るだけの選択器は、上の数値をすべて' +
        '満たしてしまいますが、この1つの数値で捕まります。',
    ]),
    ...(s.recentEvictions.length > 0
      ? [
          el('p', { class: 'group-title' }, ['最近の破棄']),
          ...s.recentEvictions.slice(-4).map((e) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`#${e.keyframeId} ${e.reason}`]),
              el('span', { class: 'cap-method' }, [e.detail]),
              el('span', {
                class: `cap-state ${e.retainedSeparationPx >= e.oldestFirstSeparationPx ? OK : BAD}`,
              }, [
                `${px(e.retainedSeparationPx)} / 古い順なら ${px(e.oldestFirstSeparationPx)}`,
              ]),
            ]),
          ),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      '保管庫が一杯になったとき、出ていくのは最も冗長な視点であって、最も古いものでは' +
        'ありません。古い順に捨てるのは分かりやすい方針ですが、間違った方針です。' +
        '部屋を記述する保管庫を、直近15秒を記述する保管庫に変えてしまいます。' +
        '「古い順だったらどうだったか」は、議論ではなく、破棄のたびに計測しています。',
    ]),
  ]);
}

/** KEY-004 and KEY-006 — what each keyframe carries, and whether it still describes anything. */
function renderKeyframes(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  return card('キーフレーム一覧', [
    el('div', { class: 'stat-grid' }, [
      stat('共有観測数の中央値', num(s.medianSharedWithLast)),
      stat('下限', String(MIN_KEYFRAME_OBSERVATIONS)),
      stat('下限を割った回数', String(s.observationFloorViolations),
        s.observationFloorViolations > 0 ? BAD : OK),
      stat('内部パラメータの不一致', String(s.intrinsicsMismatches),
        s.intrinsicsMismatches > 0 ? BAD : OK),
      stat('いま陳腐化している数', `${s.staleKeyframes} / ${s.keyframes}`),
      stat('生存率の中央値', pct(s.medianSurvivingFraction)),
    ]),
    ...s.recent.map((kf) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${kf.id} ${kf.reason}`]),
        el('span', { class: 'cap-method' }, [
          `観測 ${kf.observations} · ${deg(kf.rotationFromPreviousDeg)} · ` +
            `${px(kf.displacementFromPreviousPx)} · ${kf.intrinsics.width}×${kf.intrinsics.height}`,
        ]),
        el('span', { class: `cap-state ${kf.stale ? BAD : OK}` }, [
          kf.stale ? '陳腐化' : pct(kf.survivingFraction),
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      `キーフレームが陳腐化するのは、その観測点のうち追跡が続いているものが ` +
        `${Math.round(STALE_SURVIVAL_FRACTION * 100)}% を下回ったときです。生き残っている観測数` +
        'だけで決まり、他の何にも依存しません。v4 §20 が禁じているのは古い情報を*盲目的に*' +
        '使うことであって、古い情報が悪いとは言っていません。点がすべてまだ見えている' +
        'キーフレームは、撮った時と同じだけ有用です。陳腐化したものは比較相手に使いません。',
    ]),
    el('p', { class: 'footnote' }, [
      '各キーフレームは**自分自身の**内部パラメータを持ちます（§H.0）。端末の回転は同じ' +
        'トラックのままフレームの縦横を入れ替え、fx, fy, cx, cy のすべてがそれに伴って' +
        '変わります。なので現在の K を借りるキーフレームは、回転より前に撮ったすべての視点に' +
        'ついて誤りになります。Phase 9 はここから三角測量します。値は信用するのではなく、' +
        '各キーフレーム自身が記録した幾何から導き直しています。',
    ]),
    el('p', { class: 'footnote' }, [
      '画像そのものは保存しません。§H.1 はまだ存在しない再局在化器のために縮小グレースケール' +
        '30枚分を見込んでいますが、Phases 8・9・10 に必要なのは観測と姿勢です。誰も読まない' +
        '画素を持ち続けるのは、どのテストも確かめられないデータを抱えることになります。',
    ]),
  ]);
}

/** KEY-005 — the refusal, with the number behind it. */
function renderRefusal(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const c = s.translationCondition;
  return card('このフェーズが拒否する条件', [
    el('div', { class: 'stat-grid' }, [
      stat('並進', c ? c.state : 'ABSENT', c?.state === 'UNMEASURED' ? OK : BAD),
      stat('v3 §20 が求める値', `ローカル単位で ${KEYFRAME_TRANSLATION_UNITS}`),
      stat('発火した回数', String(s.translationFired), s.translationFired > 0 ? BAD : OK),
      stat('向きが動いた角度', deg(s.translationDirectionDeg)),
      stat('…サンプル数', `${s.translationDirectionSamples} 件`),
      stat('スケール', s.scale, s.scaleViolations > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §20 は並進の**大きさ**を求めています。Phase 6 が復元するのは SCALE: LOCAL_UNITS の' +
        '単位方向ベクトルです。v3 §15 と v4 §18 のどちらも、単眼カメラが距離を主張することを' +
        '禁じているからです。Phase 7 が位置を拒否したのも同じ理由です。このビルドにその' +
        '大きさは存在しないので、この条件は「欄が無い」のではなく「決して発火しない値」として' +
        '保持しています。',
    ]),
    el('p', { class: 'footnote' }, [
      '横の数値は*測れるほうの*量です。前のキーフレーム以降、並進の向きがどれだけ動いたか。' +
        'これを大きさとして提示してはいませんし、条件としても使っていません。拒否が引用ではなく' +
        '計測を伴うように置いてあります。',
    ]),
    el('p', { class: 'footnote' }, [
      '代わりに発火するのは v3 §20 自身の3つ目の条件 — 2つの視点が共有する特徴点の変位の' +
        '中央値 — で、これはこのプラットフォームが出せる単位で表した同じ量です。',
    ]),
  ]);
}

function renderCost(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanKeyframeMs >= 0 && s.meanKeyframeMs <= KEYFRAME_BUDGET_MS;
  return card('コスト（§H にこの項目はない）', [
    el('div', { class: 'stat-grid' }, [
      stat('キーフレームの維持', s.meanKeyframeMs >= 0 ? `${s.meanKeyframeMs} ms` : null,
        s.meanKeyframeMs >= 0 ? (within ? OK : BAD) : ''),
      stat('予算', `${KEYFRAME_BUDGET_MS} ms`),
      stat('サンプル数', String(s.costSamples)),
      stat('保管庫のサイズ', `${s.keyframes} / ${MAX_KEYFRAMES}`),
    ]),
    el('p', { class: 'footnote' }, [
      '§H は持っているミリ秒をすべて割り当てています — 取得 6、Shi-Tomasi 償却 8、LK 14、' +
        '往復 4、RANSAC と姿勢 6 — そして統合と同様、キーフレームの維持にも項目がありません。' +
        `つまり上の ${KEYFRAME_BUDGET_MS} ms は、与えられた上限ではなく、このフェーズが` +
        '自分に課した上限です。',
    ]),
    el('p', { class: 'footnote' }, [
      'ほとんどの判断は数回の比較で済みます。重いのは破棄が起きるフレームで、そこでは' +
        '保持集合の対ごとの隔たりを2回測ります — 方針のために1回、それを採点する対照の' +
        'ために1回 — が、そういうフレームは構造上まれです。',
    ]),
  ]);
}
