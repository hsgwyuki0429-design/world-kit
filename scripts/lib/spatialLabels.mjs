/**
 * The Phase 11–21 controls the spatial leg presses, as the screens render them.
 *
 * Duplicated from `src/ui/SpatialScreens.ts` because this is a plain .mjs script outside the
 * TypeScript build; `tests/unit/spatialLabels.test.ts` pins the two together so they cannot drift.
 */
export const SPATIAL_LABELS = {
  11: { name: '面の認識', start: '#start-surfaces', idle: '面の認識開始', busy: '面を認識中' },
  12: { name: '空間ワールド', start: '#start-world', idle: '空間ワールド開始', busy: 'ワールドを構築中' },
  13: { name: 'ゲームビューア', start: '#start-viewer', idle: 'ビューア開始', busy: '表示中' },
  14: { name: '保存と再開', start: '#start-save', idle: '保存と再開を開始', busy: '計測中' },
  15: { name: '空間コリジョン', start: '#start-collision', idle: 'コリジョン開始', busy: '計測中' },
  16: { name: 'ゲーム統合', start: '#start-game', idle: 'ゲーム統合開始', busy: 'ゲーム実行中' },
  17: { name: 'ステージ生成', start: '#start-stage', idle: 'ステージ生成開始', busy: '生成中' },
  18: { name: 'ゴールリング', start: '#start-ring', idle: 'ゴールリング開始', busy: '計測中' },
  19: { name: 'ボール物理', start: '#start-ball', idle: 'ボール物理開始', busy: '計測中' },
  20: { name: 'ゲームプレイ検証', start: '#start-gameplay', idle: 'ゲームプレイ検証開始', busy: 'プレイ中' },
  21: { name: '最終監査', start: '#start-audit', idle: '最終監査開始', busy: '監査中' },
};
