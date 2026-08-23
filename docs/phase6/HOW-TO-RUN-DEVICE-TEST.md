# Phase 6 — running the real-device test

One run, about five minutes, on the iPhone in Safari over HTTPS.

**Phases 1–5 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the RELATIVE POSE screen is closed until Phase 5 reaches
`PASSED` on this device now.

**Grant motion access when iOS asks.** Phase 6 cannot pass without it, and the reason is worth
knowing before you start rather than after: **POSE-002 is the only test in this phase that
compares the engine against physics instead of against arithmetic.** Everything else here is a
comparison the code makes with itself. Without the gyroscope, POSE-002 reports `PENDING` with
that reason and the phase stays at `TESTING` — it will not fail, because an absent instrument is
not a failed test, but it will not pass either.

What to have ready:

- **a scene with real depth** — a corner of the room, a doorway with the next room visible
  through it, a table with objects at clearly different distances;
- **a flat textured surface** — a patterned wall, a poster, a rug photographed straight on;
- **room to move sideways**, about a metre;
- **room to turn on the spot**, without stepping.

---

## The two motions this phase is about, and why they are different

Phase 5 asked you to move sideways, because two views only determine a geometry when they are
actually different views. Phase 6 asks for that **and** for something Phase 5 never needed: a
turn with no step.

A camera that turns on the spot produces large, well-conditioned image motion and **no
translation at all**. Every check Phase 5 applies passes on it — the baseline, the inlier count,
the spread — and the translation direction fitted to it is noise with a unit length attached.
It is the one configuration in this project that looks like success from every angle except the
right one, and step 7 below is what produces it deliberately.

So the run has two halves. Walking gives POSE-001 and POSE-003 their translations; turning gives
POSE-002 its rotation and POSE-004 its trap.

---

## The run

1. Get Phases 1–5 to `PASSED` as their own guides describe.
2. From the GEOMETRIC VERIFICATION screen, tap **GO TO RELATIVE POSE**. Leave verification
   running — Phase 6 adopts the live verifier and its anchor rather than restarting anything.
3. **Before tapping anything, check the button says `START POSE RECOVERY` and is tappable.**
   If it already reads `RECOVERING` and is greyed out, stop and report it. Five stages are
   already live when this screen opens — camera, pipeline, detector, tracker, verifier — so a
   control derived from any of them is already pressed and there is nothing you can start. That
   is the shape of the two defects Phase 3 shipped in a row (§H.5); this screen is the fourth
   written to avoid it.
4. Tap **START POSE RECOVERY** and grant motion access when iOS asks.
   - Under **Does the pose follow a rotation it was not told about?**, *Samples* starts counting.
     **This is the panel that carries the phase.**
   - If **Gyroscope says** reads "not available", motion access was denied. Reload and grant it.

5. **Point into the depth in the room and walk slowly sideways for about 45 seconds.** A corner
   where two walls meet, or a doorway with something well beyond it. You want things at clearly
   different distances in the same frame.
   - *State* reads `POSE` and *Translation* shows a unit vector.
   - Under **Planar scene handling**, *Non-planar frames posed* counts up. It needs 15.
   - *In front of both* should stay near 100%, and *Reprojection* under 2 px.

6. **Point at the flat textured surface and walk sideways past it for about 45 seconds.**
   - *Planar frames posed* counts up. It needs 15.
   - *From* should read `HOMOGRAPHY` on these frames — **never `FUNDAMENTAL`**. An Essential
     matrix decomposed from a plane is degenerate and gives a pose that looks entirely
     reasonable, which is the whole reason v3 §16 exists.
   - *Translation confidence, planar* should be **below** *...and with depth*. A half is the
     usual value, and it is not a fudge: a homography leaves two equally supported answers that
     two views cannot separate, so the translation is worth one of two.
   - *Ambiguous* frames are expected here and are not an error — they are that ambiguity, said
     out loud rather than tie-broken.

7. **ゆっくり回転 — turn slowly on the spot for about 45 seconds**, staying pointed at the
   textured scene. **Turning, not stepping.** Pivot around the phone as best you can.
   - *State* should read `ROTATION_ONLY` and *Translation* should read `none`.
   - **If a translation vector appears while you are turning on the spot, that is the failure
     POSE-004 exists for.** Report it.
   - *Comparable frames* under the gyroscope panel counts up — it needs 15 — and *Camera says*
     and *Gyroscope says* should track each other.

8. **Point at a blank wall for about 15 seconds** and keep moving.
   - *State* reads `NO_POSE`. Phase 5 declines these frames and Phase 6 must decline them too —
     not even a rotation.

9. **Go back to the depth scene and walk sideways for another 30 seconds**, so the injection
   sampler collects enough measurements on frames that have a full pose.

10. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict is
    in the filename — and screenshot the screen.

---

## What to look at before you decide the run was good

| Panel | What it should say |
| --- | --- |
| **Does the pose follow a rotation it was not told about?** | *Pose moved by* within 2° of 8°, *Control moved by* under 1.5°, over 10+ samples |
| **Does the pose follow a rotation it was not told about?** | *Inlier drift* and *Planar flips* both **0** |
| **Does the camera agree with the gyroscope?** | *Disagreement* small and green over 15+ comparable frames, ≥ 60% agreeing |
| **This frame** | *Scale* reads `LOCAL_UNITS`; *State mismatches* **0** |
| **Planar scene handling** | *Planar via Essential* **0**; planar translation confidence below non-planar |
| **Camera intrinsics** | `INTRINSICS: ESTIMATED`, with the ±20% sensitivity beside it |
| **Cost** | *Together* against the 6 ms §H budgets for RANSAC **and** pose recovery as one line |
| **This frame** | *Overlay matches video* — as in Phases 3–5 |

### The two numbers that carry the phase

**"Pose moved by", against "Control moved by".** On a sample of frames the harness applies an 8°
camera rotation to the second view — `K·Rⱼ·K⁻¹`, which is exactly what the camera would have
seen had it turned that far — and re-runs the whole chain on a set handed over with no marking.
A stage returning the same pose on every frame moves **0.00°** and has a valid rotation matrix, a
unit translation, a small reprojection error and a *perfect* temporal stability while doing it.
The control is the same set unmodified: without it, a solver returning noise would pass.

**The gyroscope's angle, against the camera's.** A different sensor, a different thread, and the
solver never reads it — v3 §19 lists `IMU consistency` among the pose confidence inputs and this
phase withholds it precisely so this comparison means something. Angles only: `rotationRate` is
in the device's frame and the camera's differs by a fixed rotation nobody has measured, and an
angle survives that change of basis while an axis does not.

### What this phase will not tell you, by design

- **No distance.** `LOCAL_UNITS`, and ‖t‖ is 1 because it was normalised — that is not a
  measurement of anything. v3 §15 and v4 §18 both forbid assuming a metre, and Phase 7 is the
  earliest anything could supply one.
- **No map.** The points triangulated here exist only to decide which way the camera was facing.
  They are not kept. Phase 9 triangulates for keeping.
- **No fused pose.** The gyroscope is a witness here, not an input. Phase 7 fuses.

---

## Committing

```
docs/phase6/evidence/phase6-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot, in `docs/phase6/evidence/`. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results using the same
`PhaseRegistry.evaluate` the app uses, so a hand-edited `"overallVerdict": "PASSED"` is caught by
disagreeing with the results it summarises.

**A run that does not pass is still worth committing.** Phase 1 keeps its `FAILED` bundle and
Phase 3 keeps three, because the record of a defect is evidence and deleting it leaves the fix
looking like a change with no cause.
