/**
 * TRIANGULATION screen (Phase 9, v4 §21, v3 §15, §16).
 *
 * The first screen in this project that shows a **three-dimensional** quantity, and four things
 * are here because of what that quantity can be faked into.
 *
 *  - **"Are these the depths the harness chose?" is the top panel.** A triangulator returning one
 *    constant depth puts every point in front of both cameras, reprojects beautifully into both
 *    views — a two-view reprojection is dominated by the ray direction, which is right — and adds
 *    up perfectly. The control is printed beside the measurement, so what separates them is a
 *    factor of hundreds rather than a tolerance.
 *  - **The pure-rotation injection is beside it.** A camera that turns produces large,
 *    well-conditioned image motion and no parallax at all, which is what a phone does when
 *    someone stands still and turns. The count that matters is zero.
 *  - **The parallax gate is shown as an angle with its derivation**, not as a percentage of
 *    whatever the frame contained. §H.6.
 *  - **Depths are shown per batch, never pooled**, with the batch-to-batch spread printed as the
 *    number behind that refusal: on one scene with one camera the median depth moves that much
 *    between pairs purely because each baseline is a different unit.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  DEPTH_ERROR_TOLERANCE,
  DEPTH_UNCERTAINTY_LIMIT,
  INJECTED_ROTATION_DEG,
  MAX_TRIANGULATION_REPROJECTION_PX,
  MIN_CONTROL_ADVANTAGE,
  MIN_INJECTIONS,
  MIN_JUDGED_BATCHES,
  MIN_PARALLAX_DEG,
  MIN_RANK_CORRELATION,
  TRIANGULATION_BUDGET_MS,
} from '../testkit/Phase9Tests';
import type { TriangulationStats } from '../tracking/triangulationStats';
import { BAD, OK, card, deg, el, num, pct, px, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase9ViewModel {
  readonly phase9: PhaseInfo;
  readonly phase10: PhaseInfo;
  readonly canEnterPhase10: boolean;
  readonly phase10Implemented: boolean;
  readonly phase10BlockedReason: string;
  /** Why an open lock is open, when an earlier page load opened it (`PhaseRegistry.lockNote`). */
  readonly phase10LockNote: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly running: boolean;
  readonly stats: TriangulationStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase9Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase10: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase9Screen(
  root: HTMLElement,
  vm: Phase9ViewModel,
  handlers: Phase9Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['三角測量']),
      el('p', {}, [
        'Phase 9 — 点が「どこに見えるか」ではなく「どこに**ある**か」を、それを決められるだけ' +
          '離れた2つのキーフレームから求めます。v4 §21 は十分な視差からの疎な情報を求め、' +
          'わずかな情報から大量の点をひねり出すことを禁じています。ここではその両方が数値に' +
          'なっています。すべての深度は、その組自身の基線を単位とした値で、基線は構造上 1 であり、' +
          '現実世界での長さを持ちません。',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderDepthInjection(vm));
  root.append(renderRotationInjection(vm));
  root.append(renderBatch(vm));
  root.append(renderGates(vm));
  root.append(renderRotationCheck(vm));
  root.append(renderScale(vm));
  root.append(renderCost(vm));
  root.append(testsSection(9, vm.phase9, vm.results));
  root.append(
    evidenceSection(9, vm.phase9, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 8, label: 'キーフレームへ戻る', onClick: handlers.onBack },
      {
        index: 10,
        name: 'ランドマーク地図',
        phase: vm.phase10,
        canEnter: vm.canEnterPhase10,
        implemented: vm.phase10Implemented,
        blockedReason: vm.phase10BlockedReason,
        lockNote: vm.phase10LockNote,
        onClick: handlers.onEnterPhase10,
      },
    ),
  );
}

function renderPreview(vm: Phase9ViewModel, handlers: Phase9Handlers): HTMLElement {
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
          ? '三角測量した点は画像の上に描いていません。それらはキーフレームの「組」に属して' +
            'いて、このフレームのものではありませんし、各組の深度はその組独自の単位です。' +
            'ライブ画像に重ねて描けば、複数の異なるスケールを一度に描いた絵になってしまいます。' +
            'それらが1つの座標系に入るのは Phase 10 です。'
          : vm.running
            ? '2枚目のキーフレームを待っています。バッチには組が要ります。'
            : 'キーフレームの保管庫は動作中です。三角測量はまだ開始されていません。',
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
              : '三角測量は未起動です';
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
        id: 'start-triangulation',
        // §H.5, for the seventh time and from the one predicate.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? '三角測量中' : vm.opening ? '要求中…' : '三角測量開始',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-triangulation',
        disabled: !vm.running,
        textContent: '停止',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('カメラ', children);
}

/** TRI-004 — the gate. Nothing else here separates a triangulator from one constant. */
function renderDepthInjection(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.depthInjections >= MIN_INJECTIONS;
  const close = enough && s.medianDepthError <= DEPTH_ERROR_TOLERANCE;
  const ahead = enough && s.medianDepthError * MIN_CONTROL_ADVANTAGE <= s.medianControlError;
  const ordered = enough && s.medianRankCorrelation >= MIN_RANK_CORRELATION;

  return card('これはハーネスが選んだ深度か？', [
    el('div', { class: 'stat-grid' }, [
      stat('相対誤差', s.medianDepthError < 0 ? null : String(s.medianDepthError),
        enough ? (close ? OK : BAD) : ''),
      stat('許容範囲', String(DEPTH_ERROR_TOLERANCE)),
      stat('深度一定なら', s.medianControlError < 0 ? null : String(s.medianControlError),
        enough ? (ahead ? OK : BAD) : ''),
      stat('順位相関', s.medianRankCorrelation < -1 ? null : String(s.medianRankCorrelation),
        enough ? (ordered ? OK : BAD) : ''),
      stat('注入回数', enough ? String(s.depthInjections) : `${s.depthInjections} / ${MIN_INJECTIONS}`),
      stat('最悪の誤差', s.worstDepthError < 0 ? null : String(s.worstDepthError)),
    ]),
    el('p', { class: 'footnote' }, [
      'ハーネスがすべての点に深度を決め、これも自分で決めた回転と単位並進を通して' +
        '（このフレーム自身の内部パラメータを使って）投影し、印を付けずに対応点を渡します。' +
        'それに対して**全工程**が走ります。当てはめ、分解、三角測量。三角測量器の側から' +
        '「いまどちらの集合を持っているか」は見えません。',
    ]),
    el('p', { class: 'footnote' }, [
      '「深度一定なら」は、同じ集合に対して最良の単一の数値が出していたはずの誤差です。' +
        'これを併記するのは、許容範囲だけでは何も証明できないからです。すべてに同じ深度を' +
        '返すステージは、このフェーズの他の基準をすべて通ります — 全点が両カメラの前方、' +
        '再投影誤差は小さく、個数の勘定も合う — そしてここでちょうどその数値を出します。',
    ]),
    ...(s.lastDepthInjection
      ? [
          el('p', { class: 'group-title' }, ['直近の注入']),
          el('div', { class: 'cap-row' }, [
            el('span', { class: 'cap-label' }, [`${s.lastDepthInjection.points} 点`]),
            el('span', { class: 'cap-method' }, [
              `与えた深度の中央値 ${s.lastDepthInjection.medianTrueDepth}、復元値 ` +
                `${s.lastDepthInjection.medianRecoveredDepth}。回転の指示 ` +
                `${deg(s.lastDepthInjection.requestedRotationDeg)}、復元のずれ ` +
                `${deg(s.lastDepthInjection.recoveredRotationDeg)}`,
            ]),
            el('span', { class: `cap-state ${close ? OK : BAD}` }, [
              String(s.lastDepthInjection.medianRelativeError),
            ]),
          ]),
        ]
      : []),
  ]);
}

/** TRI-003 — the other gate: a camera that turned and did not move. */
function renderRotationInjection(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.rotationInjections >= MIN_INJECTIONS;
  return card('カメラが回っただけのときは？', [
    el('div', { class: 'stat-grid' }, [
      stat('純回転から出た点', String(s.rotationInjectionAccepted),
        enough ? (s.rotationInjectionAccepted === 0 ? OK : BAD) : ''),
      stat('…手を加えていない組から', String(s.rotationInjectionCleanAccepted),
        enough ? (s.rotationInjectionCleanAccepted > 0 ? OK : BAD) : ''),
      stat('適用した回転', `${INJECTED_ROTATION_DEG}°`),
      stat('注入回数', enough ? String(s.rotationInjections) : `${s.rotationInjections} / ${MIN_INJECTIONS}`),
      stat('返ってきた姿勢', Object.keys(s.rotationInjectionPoseStates).join(', ') || null),
      stat('視差不足で拒否', String(s.lastRotationInjection?.lowParallaxRefusals ?? 0)),
    ]),
    el('p', { class: 'footnote' }, [
      'その組の2枚目の視点を、**1枚目**に `K R K⁻¹` を適用したもので置き換えます。' +
        'これはまさに、同じ場所から R だけ回ったカメラの2枚目の視点です。本物の回転があり、' +
        '大きく条件の良い画像運動があり、そして基線がまったくありません。' +
        'どの光線の組も無限遠で交わります。',
    ]),
    el('p', { class: 'footnote' }, [
      'これは例外的な状況ではありません。人がその場に立って体を回したときに端末が' +
        'することそのもので、部屋のスキャンの大半がそれです。それでも線形方程式を解く' +
        '三角測量器は答えを得てしまい — ノイズが示唆したどこかの深度で — 一度も動いていない' +
        'カメラから、点の集合をまるごと報告します。',
    ]),
    el('p', { class: 'footnote' }, [
      '手を加えていない組の数を隣に出しているのは、拒否だけを見るなら「全部拒否する」' +
        'ステージが満点を取ってしまうからです。',
    ]),
  ]);
}

/** TRI-001 — what the last batch did, and what the run has done. */
function renderBatch(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  return card('直近の組', [
    el('div', { class: 'stat-grid' }, [
      stat('状態', s.state, s.state === 'TRIANGULATED' ? OK : ''),
      stat('キーフレーム', s.keyframePair ? `#${s.keyframePair[0]} → #${s.keyframePair[1]}` : null),
      stat('共有している観測', String(s.correspondences)),
      stat('検証を通った点', String(s.inliers)),
      stat('採用した点', String(s.accepted)),
      stat('モデル', s.model ?? null),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('バッチ数', enoughLabel(s.batches, MIN_JUDGED_BATCHES)),
      stat('三角測量できた', `${s.batchesTriangulated} / ${s.batches}`),
      stat('合計の点数', String(s.totalAccepted)),
      stat('バッチあたりの中央値', num(s.medianAcceptedPerBatch)),
      stat('キーフレームあたり', num(s.pointsPerKeyframe)),
      stat('拒否したバッチ', String(s.batchesRefused)),
    ]),
    el('p', { class: 'footnote' }, [s.stateReason]),
    ...(Object.keys(s.batchRefusalsByReason).length > 0
      ? [
          el('p', { class: 'footnote' }, [
            `バッチの拒否理由: ${JSON.stringify(s.batchRefusalsByReason)}。何も検証できなかった組、` +
              'または回転しか復元できなかった組は、丸ごと拒否します。幾何が出なかったバッチからは' +
              '点も出ません。',
          ]),
        ]
      : []),
    ...s.samples.map((p) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${p.id}`]),
        el('span', { class: 'cap-method' }, [
          `${vec(p.position)} · 深度 ${p.depth} · 視差 ${deg(p.parallaxDeg)} · ` +
            `σ/Z ${p.depthUncertainty} · ${px(p.reprojectionPx)}`,
        ]),
        el('span', { class: 'cap-state' }, [String(p.depth)]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      '2つのキーフレームのあいだの対応は**特徴点 id** で取り、近さでは取りません。' +
        'id は追跡器が付けるもので、実行の全期間を通じて一意です。なのでここでの対応は' +
        '「たまたま近くにある2点」ではなく、その間ずっと追い続けた同一の物理的な点です。' +
        'これが、三角測量した点を Phase 10 が識別できる理由でもあります。',
    ]),
  ]);
}

/** TRI-002 and TRI-005 — the gates, and what they refused. */
function renderGates(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const belowFloor = s.worstAcceptedParallaxDeg >= 0 && s.worstAcceptedParallaxDeg < MIN_PARALLAX_DEG;
  const overCeiling = s.worstAcceptedReprojectionPx > MAX_TRIANGULATION_REPROJECTION_PX;
  return card('何を、なぜ拒否したか', [
    el('div', { class: 'stat-grid' }, [
      stat('視差の下限', `${MIN_PARALLAX_DEG}°`),
      stat('視差の中央値', deg(s.medianParallaxDeg)),
      stat('…採用した点の中央値', deg(s.medianAcceptedParallaxDeg)),
      stat('採用した中で最悪', deg(s.worstAcceptedParallaxDeg), belowFloor ? BAD : OK),
      stat('深度の不確かさ', s.medianDepthUncertainty < 0 ? null : String(s.medianDepthUncertainty),
        s.medianDepthUncertainty > DEPTH_UNCERTAINTY_LIMIT ? BAD : OK),
      stat('採用率', pct(s.acceptanceRate)),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('再投影誤差の上限', `${MAX_TRIANGULATION_REPROJECTION_PX} px`),
      stat('再投影誤差の中央値', px(s.medianReprojectionPx)),
      stat('採用した中で最悪', px(s.worstAcceptedReprojectionPx), overCeiling ? BAD : OK),
      stat('視差不足で拒否', String(s.lowParallaxRefusals)),
      stat('カメラの後方で拒否', String(s.behindCameraRefusals)),
      stat('再投影誤差が大きく拒否', String(s.highReprojectionRefusals)),
    ]),
    el('p', { class: 'footnote' }, [
      '下限は**角度**であり、選んだのではなく導いた値です。三角測量した深度の相対不確かさは' +
        'σ_θ/θ です。§13 の 1.5 px の対応点の帯を、仮定した焦点距離で割ると 0.089° の角度' +
        `ノイズになり、自身の ${DEPTH_UNCERTAINTY_LIMIT} の精度の深度を求めると 0.89° に` +
        'なります。そのフレームにたまたま入っていたものの百分位では、「ここには視差が足りない」' +
        'を表現できません — §H.6。',
    ]),
    el('p', { class: 'footnote' }, [
      '関門は、そこで落ちると後続が無意味になる順に並べています。線形方程式が解けなかった点には' +
        '符号を調べるべき深度がありませんし、視差が足りない点の再投影誤差は何も語りません。' +
        '条件の悪い解は両方の視点に見事に再投影されるからで、再投影の検査を関門にできない' +
        '理由はまさにそこです。',
    ]),
  ]);
}

/** TRI-006 — the fresh fit, and the witness it needs. */
function renderRotationCheck(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const within =
    s.rotationSamples > 0 && s.medianRotationDisagreementDeg <= s.rotationToleranceDeg;
  return card('1つの回転への2つの経路', [
    el('div', { class: 'stat-grid' }, [
      stat('組の当てはめの言い分', deg(s.medianRotationDeg)),
      stat('Phase 6 の連鎖との食い違い', deg(s.medianRotationDisagreementDeg),
        s.rotationSamples > 0 ? (within ? OK : BAD) : ''),
      stat('許容範囲', deg(s.rotationToleranceDeg)),
      stat('許容内', `${s.rotationsWithinTolerance} / ${s.rotationSamples}`),
      stat('バッチ数', enoughLabel(s.rotationSamples, MIN_JUDGED_BATCHES)),
      stat('ちょうどゼロ', String(s.zeroDisagreements),
        s.rotationSamples > 0 && s.zeroDisagreements === s.rotationSamples ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      'この組の姿勢は**新たな当てはめ**です。そのためのモデルが存在しないからです。' +
        'Phase 5 と Phase 6 はアンカーと現在フレームを結びますが、ここで結ぶのはキーフレーム' +
        '同士です。新たな当てはめには証人が要りますが、ただで手に入る証人がいます。' +
        'Phase 6 がこの2つの視点のあいだの回転をまったく別の経路で既に測っています — ' +
        '動くアンカーに対するフレームごとの姿勢を、Phase 8 がアンカーの世代をまたいで合成したものです。',
    ]),
    el('p', { class: 'footnote' }, [
      '許容範囲は Phase 6 のもの — max(3°, 実測値の 30 %) — をそのまま流用しています。' +
        'POSE-002 が比べたのと同じ2つの量だからです。ここで新しい許容範囲を作れば、' +
        '「2つの回転が一致しているとはどういうことか」について2つのフェーズが食い違うことになります。',
    ]),
  ]);
}

/** TRI-007 — no distance, with the number behind the refusal to pool. */
function renderScale(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  return card('スケール', [
    el('div', { class: 'stat-grid' }, [
      stat('スケール', s.scale, s.scaleViolations > 0 ? BAD : OK),
      stat('基線', `構造上 ${s.baselineUnits}`),
      stat('バッチ深度の中央値', num(s.medianBatchDepth)),
      stat('バッチ間のばらつき', s.batchDepthSpread < 0 ? null : String(s.batchDepthSpread)),
      stat('バッチあたりの点数', num(s.medianAcceptedPerBatch)),
      stat('キーフレームあたりの点数', num(s.pointsPerKeyframe)),
    ]),
    el('p', { class: 'footnote' }, [s.baselineNote]),
    el('p', { class: 'footnote' }, [
      'このばらつきが、拒否の裏にある数値です。同じシーンを同じカメラで見ていても、' +
        '深度の中央値はバッチ間でこれだけ動きます。部屋が変わったからではなく、' +
        '各組の基線が別々の単位だからです。これらを平均するのは、通約できない量を平均する' +
        'ことになり、ここのどの記録もそれをしていません。バッチが共有するランドマークによって' +
        '1つの座標系に入るのは Phase 10 です。',
    ]),
    el('p', { class: 'footnote' }, [
      '最後の2つの数値が、*Sparse Spatial Information* を形容詞ではなく計測値にしています。',
    ]),
  ]);
}

function renderCost(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanTriangulationMs >= 0 && s.meanTriangulationMs <= TRIANGULATION_BUDGET_MS;
  return card('コスト（§27 はこれをフレーム周期の外に置く）', [
    el('div', { class: 'stat-grid' }, [
      stat('キーフレーム挿入あたり', s.meanTriangulationMs >= 0 ? `${s.meanTriangulationMs} ms` : null,
        s.meanTriangulationMs >= 0 ? (within ? OK : BAD) : ''),
      stat('予算', `${TRIANGULATION_BUDGET_MS} ms`),
      stat('フレームあたりに均すと', s.amortisedMsPerFrame < 0 ? null : `${s.amortisedMsPerFrame} ms`),
      stat('計測したバッチ数', String(s.costSamples)),
    ]),
    el('p', { class: 'footnote' }, [
      '§27 はマッピングを追跡の周期から明示的に外しています — *triangulation on keyframe ' +
        'insert only* — なのでこのコストが乗るのは、毎フレームではなく概ね30フレームに1回です。' +
        '予算は §H の RANSAC 枠に3分の1を足したものです。この当てはめは、アンカーの組より' +
        '基線が長く対応点も多い組に対して行うからです。',
    ]),
    el('p', { class: 'footnote' }, [
      '§B.2 はこのフェーズから**マッピング用ワーカー**を計画に入れています。まだ作っていません。' +
        'その判断の根拠にすべきなのは図ではなく、上の「均した」数値です。余白に消えるコストに' +
        '2本目のスレッドは要りませんし、消えないならそれが作る理由になります。',
    ]),
  ]);
}

function enoughLabel(have: number, need: number): string {
  return have >= need ? String(have) : `${have} / ${need}`;
}
