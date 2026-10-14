# Phases 11–21 — running the real-device test

One session, about ten minutes, on the iPhone in Safari over HTTPS, in a real room.

Phases 11–21 share one running stack — the localization against the landmark map, the
SpatialWorld, the stage and the ball — and one camera view. So they are run in one walk: each
screen adopts the stack the one before it started, and you press that screen's own start button
on the way through.

**Phases 1–10 have to have passed on this build — not necessarily in this session.** See
[`docs/PHASE-LOCK-CARRY-OVER.md`](../PHASE-LOCK-CARRY-OVER.md). The stages still have to be
started: walk forward through the screens tapping
`カメラ開始`、`パイプライン開始`、`特徴点検出開始`、`追跡開始`、`幾何検証開始`、`姿勢復元開始`、`IMU 統合開始`、`キーフレーム開始`、`三角測量開始`、`ランドマーク地図開始`
using the `… へ進む` buttons, because `… へ戻る` stops the stage you came from.

> **Just want to play?** The first screen has a separate button, **空間ボールゲームを開く**. It
> runs the same real stack and evaluates no phase. See [`docs/HOW-TO-PLAY.md`](../HOW-TO-PLAY.md).

What to have ready:

- **a room with a textured floor in it** — a rug, floorboards, tiles with grout, things lying on
  the floor. A glossy blank floor gives the tracker nothing, and without a floor there is no
  ground, no stage and no game (that is the correct outcome, not a fault);
- **a wall or a large piece of furniture with some texture**, two or three metres away;
- **room to step a metre left and right**;
- **motion & orientation access** — Safari asks when you press the first start on these screens.
  If you refuse it, every surface stays `UNKNOWN`; that is the fail-closed path, and it is worth
  one run to see it, but not the run that passes the phases.

---

## The run

1. From the 「ランドマーク地図」 screen, tap **面の認識へ進む**. Leave the map running.
2. **Before tapping anything, check the button says `面の認識開始` and is tappable.** If it already
   reads `面を認識中` and is greyed out, stop and report it (§H.5).
3. Tap **面の認識開始** and allow motion & orientation access.
4. **Hold the phone so the floor fills the lower half of the picture**, and step slowly a metre to
   one side and back while turning a little left and right. Then tilt the phone up toward the wall
   and back down. The tilt is what lets gravity be measured: the four ways the image can be laid
   out only give different answers once the camera has turned (`重力（下はどちらか）` card).
5. Watch the camera view: a green outline appears on the floor once it is found as `GROUND`, blue
   on walls. The HUD reads `TRACKING GOOD` and `SURFACES n`.
6. When the screen's verdict reads `TESTING` with every record `PASS` or `PENDING` only for
   advisory ones, tap **空間ワールドへ進む**, then **空間ワールド開始**. Keep looking around for
   a minute — WORLD-003 needs the map to register several keyframes while localized.
7. **ゲームビューアへ進む** → **ビューア開始**. A ring appears on an observed surface once the
   world is `READY`. Check it sits *on* the floor or wall you see, not floating beside it.
8. **保存と再開へ進む** → **保存と再開を開始**. Tap **保存**. Then **reload the page**, walk
   back to this screen the same way (the carried passes keep the doors open), start it, and tap
   **前回の続きから** before throwing anything. Then tap **一時停止**, wait a second, and tap
   it again to resume.
9. **空間コリジョンへ進む** → **コリジョン開始**, **ゲーム統合へ進む** → **ゲーム統合開始**.
   Now play: **hold** anywhere on the camera view (the gauge fills), point the phone toward the
   ring — if it is off the screen, a gold arrow on the edge shows which way to turn — and
   **release** to throw. The white dotted line is the predicted path; on an EASY stage it turns
   green while that aim and power would score. Throw once so the ball
   hits the floor or a wall — COL-003 needs a bounce — and keep going until you score.
10. **ステージ生成へ進む** → **ステージ生成開始**, **ゴールリングへ進む** → **ゴールリング開始**,
    **ボール物理へ進む** → **ボール物理開始**: one throw on each screen is enough; the records are
    taken from the whole session.
11. **ゲームプレイ検証へ進む** → **ゲームプレイ検証開始**. Score once more on a fresh stage — tap
    **別のステージ** first if the current ring is out of reach. PLAY-001 needs the whole chain,
    stage generation to success, in order — don't pause or lose tracking between the new stage and
    the goal; if you do, tap **別のステージ** and score again.
12. **最終監査へ進む** → **最終監査開始**.
13. On each screen, tap **エビデンス JSON をダウンロード** once its records have settled, and take a
    screenshot. Record the screen during steps 9–11 (§54's real-device recording).

### Things to stop and report

- A start button that is greyed out on arrival (§H.5).
- `TRACKING GOOD` on the HUD while the camera is obviously pointed at something new and unmapped.
- A ring drawn inside a wall, under the floor, or in the middle of a table.
- A ball that bounces off empty space, or passes through the floor where a green outline is drawn.
- `SUCCESS` without the ball visibly passing through the ring.

### If it does not reach READY

The HUD's message line says which condition is missing, in order:

| HUD says | What to do |
| --- | --- |
| `GRAVITY UNKNOWN` … *look around* | turn **and** tilt the phone; a pure left-right pan is not enough |
| `SURFACE UNKNOWN` | get more floor in view and step sideways; a textured floor is needed |
| `TRACKING LOST` | point back at what the camera saw a moment ago, and move more slowly |

---

## What the desktop leg already established

`npm run test:e2e:spatial` films a ray-cast room with a harness-dispatched orientation sensor and
walks this exact sequence, pressing these exact buttons. It cannot pass a phase (Rule 004) — the
render's floor is a perfect plane, its texture is ideal and its sensor never jitters. What only
this run can show is whether a real floor, a real hand and a real gyroscope do as well.
