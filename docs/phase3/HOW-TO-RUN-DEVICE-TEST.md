# Phase 3 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1 and 2 have to pass first, in this same session.** The registry starts fresh on
every page load, so the Phase Lock in front of the FEATURES screen is closed until Phase 2
reaches `PASSED` on this device now. In practice: Phase 1's granted run, then Phase 2's
pipeline run, then this. Each screen's button says which of the two things is missing when
it is disabled.

The one thing to have ready before you start: **a surface with structure and a blank one,
both within reach**. A bookshelf, a patterned rug, a keyboard, a brick wall — anything with
detail — and a plain painted wall or a sheet of paper. The whole phase turns on pointing the
camera at each of them.

---

## The run

1. Get Phase 1 and Phase 2 to `PASSED` as their own guides describe.
2. From the pipeline screen, tap **GO TO FEATURE DETECTION**. Leave the pipeline running —
   Phase 3 adopts it rather than reopening the camera, and turns off any injected load.
3. **Before tapping anything, check the button says `START DETECTION` and is tappable.**
   If it already reads `DETECTING` and is greyed out, stop and report it — the screen is
   claiming a state the engine is not in and there is nothing you can press. That is the
   02:35 defect on 2026-08-22; it is fixed, and this is the check that it stayed fixed.
4. Tap **START DETECTION**. Corners appear on the preview within a second.
   - **If *Detections* stays at 0 while the button reads DETECTING, stop and report it.**
     That is the 01:57 defect from the same day — the button was pressable but inert.
   - **Check they land on things.** Circles should sit on edges, corners, text, the join
     between objects — not scattered evenly across a blank area. That is what FEAT-001
     measures numerically, and it is what the screenshot records.
5. **Point at the textured surface and hold, moving slowly, for about 40 seconds.**
   - *Texture-rich* under **Scene** counts up. FEAT-001 needs 15 frames and 10 contrast
     samples.
   - *Above chance* under **Are these real corners?** should sit well above 75 %. If it
     hovers near 50 %, the detector is not finding structure and the phase should fail.
   - *Features* should sit in the hundreds. *Cells occupied* should be most of 48.
6. **Point at the blank wall for about 20 seconds.**
   - *Texture-poor* counts up; FEAT-002 needs 15 frames.
   - *Features* should collapse — tens, not hundreds — and *State* should change to
     `LOW FEATURE COUNT` and then `TRACKING DEGRADED`.
   - This also drives FEAT-004: the count falling below 500 triggers a refill, below 200 an
     emergency one. Watch *Refills* climb.
7. **Point back at the textured surface** and hold for another 20 seconds, so the population
   recovers and the comparison FEAT-002 makes has both halves.
8. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict
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
| *Cells occupied* below 48 on a partly blank scene | Correct — there is nothing to find in the blank cells. |
| Detection runs at level 1, not level 0 | Deliberate, and the run measures the alternative: the panel reports what level 0 would have cost on this device. |
| A refill marked *exhausted* | The relaxed pass found no further candidates, so the frame genuinely had nothing left. That is a scene with no corners in it, not a mechanism that failed. |
| FEAT-003 `PENDING` with "too sparse for the quota to bind" | The scene never crowded a cell, so the grid had nothing to do and the comparison says nothing. Point the camera at something with dense detail. |

## Outcomes that are real failures

| Observation | Meaning |
| --- | --- |
| *Above chance* near 50 % | The detected positions are no more textured than random ones. The points are not on image structure, which is the one thing this phase exists to establish. |
| The count holding near target on a blank wall | The output does not depend on the image. |
| *State mismatches* above zero | The state shown and the count shown disagree — the UI and engine have diverged (Rule 002). |
| *Quota breaches* above zero | The 8×6 cap did not hold. |

## What Phase 3 does not do

Nothing here follows a feature from one frame to the next. Each frame is detected
independently, `age` is 0 and `trackLength` is 1 on every record, and the two error terms
§11 lists are `null` because Phase 4 and Phase 6 are what measure them. The screen says so
rather than implying a tracked point. Phase 4 is optical flow (§12).
