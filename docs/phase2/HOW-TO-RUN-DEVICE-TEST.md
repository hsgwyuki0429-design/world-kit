# Phase 2 — running the real-device test

One run, about three minutes, on the iPhone in Safari over HTTPS.

**Phase 1 has to pass first, in this same session.** The registry starts fresh on every
page load, so the Phase Lock that gates the PIPELINE screen is closed until Phase 1 reaches
`PASSED` on this device now — not because it passed yesterday. In practice that means doing
the Phase 1 granted run first (the denial carries over from your earlier denied run through
the in-app ledger). The button on the SCAN screen says which of the two things is missing
if it is disabled.

---

## The run

1. Complete the Phase 1 granted run: **START SCAN → START CAMERA**, hold it 35 s while
   moving the phone, rotate once. Wait for the Phase 1 verdict to read `PASSED`.
2. Tap **GO TO FRAME PIPELINE**.
3. Tap **START PIPELINE**. The camera opens again and frames begin flowing to the worker.
   - Within a second the *Worker output* panel appears below the preview, showing the
     grayscale the worker built. **Check that it moves when the preview moves.** That is
     the same thing FRAME-002 measures numerically, and it is what the screenshot records.
4. **Hold it for at least 35 seconds, moving the phone, without leaving Safari.**
   - *Unstressed run* counts up to 30.0 s. FRAME-001 stays `PENDING` until it fills.
   - Leaving the app stops frame callbacks and fails the window. Repeat rather than excuse.
   - Keep moving: FRAME-002 needs the scene itself to vary, or agreement between the worker
     and the camera proves nothing. *Δ luma median* should stay near zero while the scene
     changes — that pairing is the whole point.
5. **Rotate the phone** once, then back (FRAME-006).
   - *Source* should change, e.g. 1280×720 → 720×1280, and *Processing* should follow it
     within a frame.
6. Tap **INJECT LOAD** (FRAME-003, FRAME-004).
   - The button is refused with a message until the pipeline has measured its own baseline
     — a few seconds of normal running. That is deliberate: the load level is computed from
     the measured cost of one pyramid build on *this* device rather than being a number
     written into the source.
   - Watch *Tier* step down: 960×540@30 → 960×540@20 → 640×360@20, each move listed under
     *Adaptation* with the latency that caused it and the effect it had.
   - Give it about **25 seconds**. FRAME-003 needs a step that lowers the resolution, not
     only the rate.
7. Tap **STOP INJECTED LOAD** and wait about **30 seconds**.
   - The controller climbs back one step or more. Recovery is deliberately slow — it waits
     out an eight-second cooldown after the last downward step and then needs three
     consecutive windows comfortably inside the next tier's budget.
   - FRAME-004 stays `PENDING` until this half has happened. An adaptation that only
     degrades is half a mechanism.
8. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict
   is in the filename — and screenshot the screen.

---

## Committing

```
docs/phase2/evidence/phase2-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results and re-checks the Phase 2
invariants: the cross-check ran on a scene that varied and agreed within its own stated
tolerance, at least 90 % of per-frame processing time was in the worker, every ladder move
carries the measurement that caused it, and no frame was processed above its tier budget or
upscaled.

## Outcomes that look like failures but are not

| Observation | Meaning |
| --- | --- |
| *Paced out* is large | The target rate is below the camera rate, so the scheduler declined those frames. That is the pacing working, not a drop. |
| *Backpressured* is non-zero | The worker was still busy with the previous frame. Also by design; only *Lost* counts against FRAME-001. |
| Delivered fps sits at the target rather than the camera rate | Correct. The pipeline paces to the tier, and the controller judges delivery against whichever of target and camera rate is lower. |
| Route reads `VIDEO_FRAME` and the other two say "not reached" | The first route worked, so the ladder stopped there. The others are the declared fallbacks. |
| The tier climbs to `HIGH 1280x720@30` on its own | The device measured itself comfortably inside the budget. `HIGH` is reachable by recovery; it is never entered before the pipeline has measured itself. |
| Delivery collapses while load is injected | Expected. The load targets six times the tier budget so the ladder is exercised to its floor rather than settling halfway and oscillating. |

## Outcomes that are real failures

| Observation | Meaning |
| --- | --- |
| *Δ luma median* is not near zero | The worker's image is not the camera's image. This is the one measurement Phase 2 exists to make, and it fails the phase. |
| *Lost* is more than 2 % of admitted | Frames were handed to the worker and never came back. |
| A downward step with no load injected | The device could not hold its tier unaided. It still passes FRAME-003 — degrading is what the ladder is for — but it is surfaced separately because it means something quite different from a stress-induced step. |
| The pyramid panel shows a problem | A level's byte length does not match the image it claims to hold. |

## What Phase 2 does not do

No feature detection, no tracking, no pose, no spatial data. The pyramid the worker builds
is consumed by nothing — Phase 3 is where it starts being used (§11). The screen says so
rather than showing an overlay of points that would imply otherwise.
