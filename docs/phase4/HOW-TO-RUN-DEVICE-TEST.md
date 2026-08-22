# Phase 4 — running the real-device test

One run, about five minutes, on the iPhone in Safari over HTTPS.

**Phases 1, 2 and 3 have to pass first, in this same session.** The registry starts fresh on
every page load, so the Phase Lock in front of the TRACKING screen is closed until Phase 3
reaches `PASSED` on this device now. Each screen's button says which phase is missing when it
is disabled.

Two things to have ready before you start:

- **a surface with structure**, within arm's reach and lit well enough to hold a few hundred
  corners — a bookshelf, a patterned rug, a keyboard, a brick wall;
- **a free finger**, for the occlusion in step 8.

You will also be asked for **motion access** when you press START TRACKING. Grant it: FLOW-003
is defined against the gyroscope, and without it that test reports `PENDING` and the phase
cannot pass. (It will not fail — an absent instrument is not a failed test — but it will hold
the phase at `TESTING`.)

---

## The run

1. Get Phases 1, 2 and 3 to `PASSED` as their own guides describe.
2. From the FEATURES screen, tap **GO TO TRACKING**. Leave detection running — Phase 4 adopts
   the live pipeline rather than reopening the camera, and turns off any injected load.
3. **Before tapping anything, check the button says `START TRACKING` and is tappable.**
   If it already reads `TRACKING` and is greyed out, stop and report it — the screen is
   claiming a state the engine is not in and there is nothing you can press. That is the shape
   of the two defects Phase 3 shipped in a row (§H.5); this is the check that it stayed fixed.
4. Tap **START TRACKING** and grant motion access when iOS asks.
   - Points appear on the preview within a second. **Filled green dots are points being
     followed; amber rings are points detection has just replaced.** A screen that is all
     rings is a screen where the tracker is keeping nothing, however high the total.
   - **If *Tracked* stays at 0 while the button reads TRACKING, stop and report it.**

5. **静止 — hold the phone as still as you can for about 15 seconds**, pointed at the textured
   surface. Rest it on something if you can.
   - *静止 (FLOW-001)* under **Scene motion** counts up. It needs 15 frames.
   - The frames are classified from the image, not from your intention: a frame counts as
     static when the independent scene-shift search measures under 1 px of motion. If the
     count is not rising, you are moving more than you think.
   - *Tracked* should stay near its value and *State* should read `TRACKING`.

6. **ゆっくり横移動 — pan slowly sideways for about 20 seconds**, keeping the same distance
   from the surface. Slowly: a comfortable, deliberate slide, not a sweep.
   - *ゆっくり横移動 (FLOW-002)* counts up, and so does *Cross-checks* under **Do the points
     follow the image?**
   - **This is the panel that carries the phase.** *Tracker says* and *Image says* should
     track each other, and *Disagreement* should stay small and green. If *Tracker says* sits
     near 0 while *Image says* does not, the tracker is not following the picture and the run
     should fail — that is the whole point of the comparison.

7. **ゆっくり回転 — turn the phone slowly about its own axis for about 20 seconds**, staying
   pointed at the surface. Turning, not sliding: the two are different measurements and the
   gyroscope tells them apart.
   - *Rotating frames* counts up; it needs 15. *Median rotation* should read a few degrees.
   - *Field spread* should show a larger number while turning than while panning. A rotation
     moves the corners of the image by different amounts and a translation does not.
   - If **Gyroscope** reads "not available", motion access was denied. Reload and grant it.

8. **急速移動 — sweep the phone quickly across the scene, three or four times.**
   - *急速移動 (FLOW-004)* needs 15 frames. Fast means more than 12 px of image motion in one
     frame, which is over half the 21 px tracking window.
   - *Tracked* should fall sharply and *State* should reach `DEGRADED`. **That is the pass**:
     §65 asks for the transition, not for success. A survival figure that does not budge under
     motion the window cannot span means the numbers are not coming from the image.

9. **Camera遮断 — cover the lens completely with a finger for about two seconds, then
   uncover it.** Do it twice.
   - *State* must reach `LOST` within a second, and the population must come back afterwards.
   - **Occlusion episodes** appears under **Scene motion** with the time to `LOST` and the
     recovery for each one.

10. **Point back at the textured surface** and hold for another 15 seconds so the population
    recovers fully.

11. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict is
    in the filename — and screenshot the screen.

---

## What to look at before you decide the run was good

| Panel | What it should say |
| --- | --- |
| **Do the points follow the image?** | *Disagreement* small and green, over 10+ cross-checks |
| **Population and state** | *Tracked* and *Redetected* both shown; *State mismatches* **0** |
| **Population and state** | *Why not GOOD* naming `inlierRatio` and `reprojectionError` — those are Phases 5 and 6, and a run that reached `GOOD` reached it by dropping two of §33's three conditions |
| **Scene motion** | all four classes with frames in them, and at least one occlusion episode that recovered |
| **Do the points follow the image?** | *Overlay matches video* — see below |
| **Cost** | *LK solve* against the 14 ms budget, with the point count beside it |

### The overlay orientation, carried over from Phase 3

*Overlay matches video* is the probe added at the end of Phase 3, after the report that the
drawn corners lined up in landscape and were rotated in portrait. It matters more here than it
did there: Phase 4 measures every displacement in the acquired buffer's frame, so a buffer
turned against the screen makes every number on this screen wrong while every average-based
check still passes (§H.7).

**Please check it in both orientations.** Hold the phone in portrait for part of the run and
landscape for the rest, and look at what it says each time.

- `yes · N× chance` with N comfortably above 2 is what it should say.
- `NO · <transform> fits N× better` means the acquisition route is producing a buffer that is
  not oriented like the picture. The app abandons the route rather than correcting the drawing,
  and logs it. Report it with the bundle.
- `not measurable` is normal while the lens is covered — a black frame has no texture to score.

This has never been reproduced off the device: Chromium's fake camera rescales a portrait file
to square, so the orientation relationship iOS creates does not arise.

---

## Committing

```
docs/phase4/evidence/phase4-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot, in `docs/phase4/evidence/`. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results using the same
`PhaseRegistry.evaluate` the app uses, so a hand-edited `"overallVerdict": "PASSED"` is caught
by disagreeing with the results it summarises.

**A run that does not pass is still worth committing.** Phase 1 keeps its `FAILED` bundle and
Phase 3 keeps three, because the record of a defect is evidence and deleting it leaves the fix
looking like a change with no cause.
