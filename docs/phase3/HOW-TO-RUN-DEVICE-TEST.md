# Phase 3 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1 and 2 have to have passed on this build — not necessarily in this session.** A phase
that reached `PASSED` on this phone, on the build the page is serving, keeps its door open
across page loads, so you do not re-run them to get here. See
[`docs/PHASE-LOCK-CARRY-OVER.md`](../PHASE-LOCK-CARRY-OVER.md) for what that carries — a lock,
not a verdict — and what it refuses. If the build has moved since, a deploy or a reload onto new
code, the doors are shut again and you do run the chain: a pass is evidence about the code that
produced it.

**The stages still have to be started, and that is the part that costs you anything.** The lock
and the pipeline are different things. Walk forward through the screens, one tap on each —
`カメラ開始`、`パイプライン開始` — using the `… へ進む` buttons, because `… へ戻る` stops the
stage you came from. The Phase Lock in front of the 「特徴点検出」 screen stays closed until
Phase 2 has `PASSED` on this device on this build, and each screen's button says which of the
two things is missing when it is disabled.

The one thing to have ready before you start: **a surface with structure and a blank one,
both within reach**. A bookshelf, a patterned rug, a keyboard, a brick wall — anything with
detail — and a plain painted wall or a sheet of paper. The whole phase turns on pointing the
camera at each of them.

---

## The run

1. Open the app and walk forward to the 「特徴点検出」 screen, tapping
   `カメラ開始`、`パイプライン開始` on the way. A phase that already passed on this build keeps
   its door open; one that has not still has to pass here, as its own guide describes.
2. From 「フレームパイプライン」画面, tap **特徴点検出へ進む**. Leave the pipeline running —
   Phase 3 adopts it rather than reopening the camera, and turns off any injected load.
3. **Before tapping anything, check the button says `特徴点検出開始` and is tappable.**
   If it already reads `検出中` and is greyed out, stop and report it — the screen is
   claiming a state the engine is not in and there is nothing you can press. That is the
   02:35 defect on 2026-08-22; it is fixed, and this is the check that it stayed fixed.
4. Tap **特徴点検出開始**. Corners appear on the preview within a second.
   - **If *検出回数* stays at 0 while the button reads `検出中`, stop and report it.**
     That is the 01:57 defect from the same day — the button was pressable but inert.
   - **Check they land on things.** Circles should sit on edges, corners, text, the join
     between objects — not scattered evenly across a blank area. That is what FEAT-001
     measures numerically, and it is what the screenshot records.
5. **Point at the textured surface and hold, moving slowly, for about 40 seconds.**
   - *Texture-rich* under **シーン** counts up. FEAT-001 needs 15 frames and 10 contrast
     samples.
   - *偶然を上回る割合* under **これは本当にコーナーか？** should sit well above 75 %. If it
     hovers near 50 %, the detector is not finding structure and the phase should fail.
   - *特徴点* should sit in the hundreds. *使われたセル* should be most of 48.
6. **Point at the blank wall for about 20 seconds.**
   - *Texture-poor* counts up; FEAT-002 needs 15 frames.
   - *特徴点* should collapse — tens, not hundreds — and *状態* should change to
     `LOW FEATURE COUNT` and then `TRACKING DEGRADED`.
   - This also drives FEAT-004: the count falling below 500 triggers a refill, below 200 an
     emergency one. Watch *補充* climb.
7. **Point back at the textured surface** and hold for another 20 seconds, so the population
   recovers and the comparison FEAT-002 makes has both halves.
8. When the verdict panel shows what you want, tap **エビデンス JSON をダウンロード** — the verdict
   is in the filename — and screenshot the screen.

---

## Committing

```
docs/phase3/evidence/phase3-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results and re-checks the Phase 3
invariants: the contrast statistic against its chance value, the population collapsing when
the texture did, no cell over quota, and `forwardBackwardError` / `reprojectionError` still
`null` on every sampled record.

## Outcomes that look like failures but are not

| Observation | Meaning |
| --- | --- |
| Features number in the low hundreds rather than 800 | The 8×6 quota is a hard cap: with 48 cells and a quota of 17, a scene whose texture is confined to part of the frame cannot reach the target. That is the grid preventing concentration, which is what §11 asks it to do. |
| *使われたセル* below 48 on a partly blank scene | Correct — there is nothing to find in the blank cells. |
| Detection runs at level 1, not level 0 | Deliberate, and the run measures the alternative: the panel reports what level 0 would have cost on this device. |
| A refill marked *exhausted* | The relaxed pass found no further candidates, so the frame genuinely had nothing left. That is a scene with no corners in it, not a mechanism that failed. |
| FEAT-003 `PENDING` with "too sparse for the quota to bind" | The scene never crowded a cell, so the grid had nothing to do and the comparison says nothing. Point the camera at something with dense detail. |

## Outcomes that are real failures

| Observation | Meaning |
| --- | --- |
| *偶然を上回る割合* near 50 % | The detected positions are no more textured than random ones. The points are not on image structure, which is the one thing this phase exists to establish. |
| The count holding near target on a blank wall | The output does not depend on the image. |
| *状態の不一致* above zero | The state shown and the count shown disagree — the UI and engine have diverged (Rule 002). |
| *上限の超過* above zero | The 8×6 cap did not hold. |

## What Phase 3 does not do

Nothing here follows a feature from one frame to the next. Each frame is detected
independently, `age` is 0 and `trackLength` is 1 on every record, and the two error terms
§11 lists are `null` because Phase 4 and Phase 6 are what measure them. The screen says so
rather than implying a tracked point. Phase 4 is optical flow (§12).
