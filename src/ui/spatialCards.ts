/**
 * What each of Phases 11–21 shows beside the camera: its own measurements, in its own card.
 *
 * Every figure is read from the same `SpatialContext` the phase's tests are graded from, so the
 * screen and the verdict cannot be looking at two different runs. `-1` prints as a dash, as
 * everywhere else in this project: not measured is not zero.
 */

import type { SpatialContext } from '../testkit/spatialContext';
import { BAD, OK, deg, num, pct, px } from './dom';
import type { StatCard } from './SpatialScreens';

export const SPATIAL_INTROS: Readonly<Record<number, string>> = {
  11: 'ランドマーク地図から、床・壁・台などの「面」を取り出し、実測した重力の向きで分類します。重力が測れていない間は、どの面も UNKNOWN のままです。',
  12: '地図・カメラ姿勢・面・重力をひとつの SpatialWorld にまとめます。ゲームが読むのはここだけです。READY は4つの条件がすべて実測で揃ったときだけ立ちます。',
  13: 'ワールドのカメラ姿勢で、面・リング・ボールをカメラ映像に重ねます。描いた位置が追跡器の見ている位置と一致するかを毎フレーム測ります。',
  14: '進行と観測結果を保存し、再開できます。ただし前回のワールドの座標は今回のセッションでは誰も観測していないので、表示はしても当たり判定には使いません。',
  15: 'ボールが当たれるのは、ワールドが観測し分類した面だけです。見えない壁も、偽の床もありません。接触はすべて、どの観測面だったかを記録します。',
  16: 'SCAN から SUCCESS までの状態遷移と、トラッキング喪失時の停止・再開を、宣言された遷移表どおりに動かします。',
  17: '観測されたワールドからスタート地点とゴールを自動生成します。同じワールド・同じシードなら同じステージになり、部屋が変わればステージも変わります。',
  18: 'リングの位置・向き・大きさを、観測面と立ち位置から決めます。物体の内側や観測していない場所への配置は拒否します。難易度は部屋の形から計算します。',
  19: '重力・速度・反発・摩擦・衝突を固定ステップで計算します。同じ入力は必ず同じ軌道になり、跳ねるたびにエネルギーは減るだけです。',
  20: 'スキャン → ステージ生成 → 投球 → 観測面での跳ね返り → リング通過、を実機の実際の部屋で一続きに検証します。',
  21: 'このセッション全体で、すべてのフェーズの合格と、決して起きてはならないことが一度も起きなかったことを確認します。',
};

export function spatialCards(index: number, ctx: SpatialContext): StatCard[] {
  switch (index) {
    case 11: return surfaceCards(ctx);
    case 12: return worldCards(ctx);
    case 13: return viewCards(ctx);
    case 14: return saveCards(ctx);
    case 15: return collisionCards(ctx);
    case 16: return gameCards(ctx);
    case 17: return stageCards(ctx);
    case 18: return ringCards(ctx);
    case 19: return ballCards(ctx);
    case 20: return [...gameCards(ctx), ...ringCards(ctx)];
    case 21: return auditCards(ctx);
    default: return [];
  }
}

function surfaceCards(ctx: SpatialContext): StatCard[] {
  const w = ctx.world;
  const g = w.gravity;
  return [
    {
      title: '重力（下はどちらか）',
      stats: [
        ['状態', g.state, g.state === 'ESTIMATED' ? OK : ''],
        ['ばらつき', deg(g.spreadDeg), g.state === 'ESTIMATED' ? OK : ''],
        ['次点のばらつき', deg(g.runnerUpSpreadDeg)],
        ['画像の向き', g.candidateDeg < 0 ? null : `${g.candidateDeg}°`],
        ['視線の振れ幅', deg(g.diversityDeg)],
        ['ペア数', `${w.pairings}`],
        ['センサー', ctx.gravitySource, ctx.gravitySource === 'LIVE' ? OK : BAD],
        ['加速度計との差', deg(ctx.acceleration.medianDeg)],
      ],
      notes: [g.reason],
    },
    {
      title: '面',
      stats: [
        ['面の数', String(w.surfaces)],
        ['分類', JSON.stringify(w.surfacesByClass)],
        ['使ったランドマーク', `${w.lastSupport} / ${w.lastCandidates}`],
        ['残差の中央値', w.medianResidual < 0 ? null : String(w.medianResidual)],
        ['再発見率', w.persistenceOffered > 0 ? pct(w.persistenceFound / w.persistenceOffered) : null],
        ['対照（ずらした点）の比', pct(w.medianControlRatio)],
        ['カメラの高さ', w.cameraHeight < 0 ? null : String(w.cameraHeight)],
        ['抽出コスト', w.medianExtractionMs < 0 ? null : `${w.medianExtractionMs} ms`],
      ],
      notes: [
        '面は、3視点以上から確認されたランドマークが同じ平面上に、つながって並んでいる所だけです。広さは観測した点の凸包までで、その先へは伸ばしません。',
      ],
    },
  ];
}

function worldCards(ctx: SpatialContext): StatCard[] {
  const w = ctx.world;
  const v = ctx.view;
  return [
    {
      title: 'SpatialWorld',
      stats: [
        ['WORLD', v.worldState, v.worldState === 'READY' ? OK : ''],
        ['TRACKING', v.trackingState, v.trackingState === 'GOOD' ? OK : v.trackingState === 'LOST' ? BAD : ''],
        ['MAPPING', v.mappingState],
        ['CONFIDENCE', v.confidence.toFixed(2)],
        ['ランドマーク', String(v.landmarks.length)],
        ['COVERAGE', String(v.coverage)],
        ['世代', String(v.epoch)],
        ['スケール', v.scale],
      ],
      notes: v.worldReasons.length > 0 ? [`READY まで: ${v.worldReasons.join(' / ')}`] : ['READY: すべての条件が実測で揃っています。'],
    },
    {
      title: 'このフレームのカメラ姿勢',
      stats: [
        ['位置推定できたフレーム', `${w.localized} / ${w.reports}`],
        ['再投影誤差', px(w.medianErrorPx)],
        ['取り置き点での誤差', px(w.medianHeldOutPx)],
        ['キーフレーム姿勢との差', deg(w.medianAgreementDeg)],
        ['…位置の差（深度比）', w.medianAgreementCenter < 0 ? null : String(w.medianAgreementCenter)],
        ['コスト', w.medianLocalizationMs < 0 ? null : `${w.medianLocalizationMs} ms`],
      ],
      notes: [`状態の内訳: ${JSON.stringify(w.byState)}`],
    },
  ];
}

function viewCards(ctx: SpatialContext): StatCard[] {
  const r = ctx.render;
  return [
    {
      title: '描画',
      stats: [
        ['描画フレーム', String(r.framesDrawn)],
        ['追跡器との位置ずれ', px(r.medianAlignmentPx), r.alignmentReadings > 0 ? (r.medianAlignmentPx <= 2.5 ? OK : BAD) : ''],
        ['最悪', px(r.worstAlignmentPx)],
        ['キャンバスと映像の縦横比の差', r.worstAspectError < 0 ? null : pct(r.worstAspectError)],
        ['描画コスト', r.medianDrawMs < 0 ? null : `${r.medianDrawMs} ms`],
        ['フレーム間隔', r.medianFrameIntervalMs < 0 ? null : `${r.medianFrameIntervalMs} ms`],
        ['描画の違反', String(r.drawViolations), r.drawViolations > 0 ? BAD : OK],
        ['表示と内部状態の不一致', String(r.stateMismatches + r.trackingMismatches), r.stateMismatches + r.trackingMismatches > 0 ? BAD : OK],
      ],
      notes: ['リング・ボール・面は、ワールドとそこから生成したステージにあるものだけを描いています。'],
    },
  ];
}

function saveCards(ctx: SpatialContext): StatCard[] {
  const s = ctx.save;
  return [
    {
      title: '保存と再開',
      stats: [
        ['保存', String(s.saves)],
        ['往復の不一致', String(s.roundTripFailures), s.roundTripFailures > 0 ? BAD : ''],
        ['改ざんを受け入れた', `${s.tamperAccepted} / ${s.tamperChecks}`, s.tamperAccepted > 0 ? BAD : ''],
        ['非有限値を受け入れた', `${s.nonFiniteAccepted} / ${s.nonFiniteChecks}`, s.nonFiniteAccepted > 0 ? BAD : ''],
        ['再開', String(s.resumes)],
        ['復元ワールドを当たり判定に使用', String(s.restoredUsedForCollision), s.restoredUsedForCollision > 0 ? BAD : ''],
        ['一時停止→再開', String(s.pauseResumes)],
        ['…変化した回数', String(s.pauseResumeMismatches), s.pauseResumeMismatches > 0 ? BAD : ''],
      ],
      notes: [s.lastResumeReason ? `最後の再開: ${s.lastResumeReason}` : '「保存」→ ページを再読み込み →「前回の続きから」で再開を試せます。'],
    },
  ];
}

function collisionCards(ctx: SpatialContext): StatCard[] {
  const g = ctx.game;
  return [
    {
      title: '当たり判定',
      stats: [
        ['サンプル', String(ctx.collisionSamples)],
        ['違反', String(ctx.collisionViolations), ctx.collisionViolations > 0 ? BAD : OK],
        ['投球', String(g.throwCount)],
        ['由来不明の接触', String(g.untracedContacts), g.untracedContacts > 0 ? BAD : ''],
        ['面を消すと変わった投球', `${g.controlChecks - g.controlFailures} / ${g.controlChecks}`],
      ],
      notes: [ctx.collisionViolationDetail || '当たり判定に入るのは、GROUND / PLATFORM / WALL / OBSTACLE_SURFACE で信頼度 0.4 以上の観測面だけです。'],
    },
  ];
}

function gameCards(ctx: SpatialContext): StatCard[] {
  const g = ctx.game;
  return [
    {
      title: 'ゲーム',
      stats: [
        ['状態', g.state],
        ['遷移', String(g.transitionCount)],
        ['不正な遷移', String(g.illegalTransitions), g.illegalTransitions > 0 ? BAD : OK],
        ['1周', String(g.cycles)],
        ['成功 / 失敗', `${g.successes} / ${g.misses}`],
        ['トラッキング喪失 / 復帰', `${g.lostEntries} / ${g.lostRecoveries}`],
        ['停止中に進んだ物理ステップ', String(g.stepsWhileFrozen), g.stepsWhileFrozen > 0 ? BAD : OK],
      ],
      notes: [`通った状態: ${g.visited.join(' → ')}`],
    },
  ];
}

function stageCards(ctx: SpatialContext): StatCard[] {
  const g = ctx.game;
  const s = g.lastStage;
  return [
    {
      title: 'ステージ',
      stats: [
        ['生成数', String(g.stagesGenerated)],
        ['失敗', String(g.generationFailures)],
        ['再現性の不一致', `${g.reproductionMismatches} / ${g.reproductions}`, g.reproductionMismatches > 0 ? BAD : ''],
        ['自分の解が入らない', `${g.solutionFailures} / ${g.solutionChecks}`, g.solutionFailures > 0 ? BAD : ''],
        ['部屋をずらしても同じ', `${g.stageControlFailures} / ${g.stageControls}`, g.stageControlFailures > 0 ? BAD : ''],
        ['生成コスト', g.medianGenerationMs < 0 ? null : `${g.medianGenerationMs} ms`],
        ['digest', s ? s.digest : null],
        ['seed', s ? String(s.seed) : null],
      ],
      notes: [g.lastGenerationReason || 'ワールドが READY になると生成します。', g.lastStageControl],
    },
  ];
}

function ringCards(ctx: SpatialContext): StatCard[] {
  const s = ctx.game.lastStage;
  const gen = ctx.gameView.lastGeneration;
  return [
    {
      title: 'ゴールリング',
      stats: [
        ['種類', s ? s.ring.kind : null],
        ['乗っている面', s ? `#${s.ring.supportSurfaceId} ${s.ring.supportClass}` : null],
        ['難易度', s ? s.difficulty.difficulty : null],
        ['距離（カメラ高さ単位）', s ? String(s.difficulty.distanceH) : null],
        ['高低差', s ? String(s.difficulty.riseH) : null],
        ['必要なバウンド', s ? num(s.difficulty.minBounces) : null],
        ['入る投げ方の数', s ? String(s.difficulty.solutions) : null],
        ['無効なリングの拒否漏れ', `${ctx.game.rejectionAccepted.length} / ${ctx.game.rejectionOffered}`, ctx.game.rejectionAccepted.length > 0 ? BAD : ''],
      ],
      notes: [
        s ? s.difficulty.reason : '',
        gen ? `候補 ${gen.candidates} 個のうち ${gen.examined} 個を検証。却下: ${JSON.stringify(gen.rejections)}` : '',
      ].filter((x) => x.length > 0),
    },
  ];
}

function ballCards(ctx: SpatialContext): StatCard[] {
  const g = ctx.game;
  const last = g.throws[g.throws.length - 1];
  return [
    {
      title: 'ボール',
      stats: [
        ['投球', String(g.throwCount)],
        ['再生の不一致', String(g.replayMismatches), g.replayMismatches > 0 ? BAD : ''],
        ['エネルギーが増えたバウンド', String(g.energyViolations), g.energyViolations > 0 ? BAD : ''],
        ['物理コスト（最悪）', `${g.worstPhysicsMs} ms`],
        ['直前の結果', last ? last.outcome : null],
        ['直前の速さ（高さ/秒）', last ? String(last.speedH) : null],
        ['直前の接触', last ? String(last.contacts.length) : null],
        ['単位', g.lastStage ? `1 = カメラの高さ ${g.lastStage.unit}` : null],
      ],
      notes: ['ボールの半径・重力・投げる速さは、すべて実測したカメラの高さの倍数です。メートルへの換算はしていません。'],
    },
  ];
}

function auditCards(ctx: SpatialContext): StatCard[] {
  const counters: [string, number][] = [
    ['ワールドの整合性', ctx.world.integrityIssues],
    ['READY の違反', ctx.world.readyViolations],
    ['不正な遷移', ctx.game.illegalTransitions],
    ['再生の不一致', ctx.game.replayMismatches],
    ['当たり判定の違反', ctx.collisionViolations],
    ['表示の不一致', ctx.render.stateMismatches + ctx.render.trackingMismatches],
    ['描画の違反', ctx.render.drawViolations],
  ];
  return [
    {
      title: 'セッション全体の不変条件',
      stats: counters.map(([k, v]) => [k, String(v), v > 0 ? BAD : OK] as const),
      notes: [
        `フェーズ: ${ctx.phases.filter((p) => p.index <= 20).map((p) => `${p.index}:${p.state}`).join(' ')}`,
      ],
    },
  ];
}
