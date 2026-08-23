# Phase 5 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1–4 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the GEOMETRIC VERIFICATION screen is closed until Phase 4
reaches `PASSED` on this device now. Each screen's button says which phase is missing when it is
disabled.

What Phase 5 needs from the room is different from what Phase 4 needed, and it is the reason
this run has a shape of its own:

- **a flat, textured surface** — a patterned wall, a poster, a rug, a bookshelf photographed
  straight on. This is the planar half of v3 §16.
- **a scene with real depth in it** — a corner of the room, a doorway with the next room
  visible through it, a table with objects at clearly different distances. This is the
  non-planar half, and a run that never sees one cannot decide GEO-004.
- **a blank surface** — a plain painted wall, a closed door. For GEO-002.
- **room to move sideways**, about a metre. This is the important one: see below.

No motion permission is needed. Phase 5 uses no gyroscope; it works entirely on the
correspondences Phase 4 is already tracking.

---

## Why this run is about *moving*, not holding still

Phase 4 asked you to hold the phone still for its first condition. Phase 5 cannot use a still
frame at all, and it is worth knowing why before you start.

Two views of a scene determine a geometry only when the two views are actually different. Frame
to frame the phone moves a few pixels — the device run of Phase 4 measured a median of 4.7 px —
and at that separation *every* model fits: the inlier ratio comes out at 1.00 and it verifies
nothing. So this phase does not compare consecutive frames. It holds a **verification anchor**
some tens of frames back and relates the current frame to that, re-taking the anchor when the
two views drift too far apart to share enough scene.

The consequence for you: **the phone has to travel**. Sideways translation, a slow deliberate
walk-past of the surface, is what builds the baseline. Turning on the spot does not — a rotation
changes what the camera sees without changing where it sees it from, and no amount of it makes a
two-view geometry recoverable.

*Baseline* on screen tells you whether you are giving it enough. Under 15 px the frame is
refused and says so.

---

## The run

1. Get Phases 1–4 to `PASSED` as their own guides describe.
2. From the TRACKING screen, tap **GO TO GEOMETRIC VERIFICATION**. Leave tracking running —
   Phase 5 adopts the live tracker rather than restarting anything, and turns off any injected
   load.
3. **Before tapping anything, check the button says `START VERIFICATION` and is tappable.**
   If it already reads `VERIFYING` and is greyed out, stop and report it. Everything underneath
   this screen is already running when it opens — the camera, the pipeline, the detector and the
   tracker — so a control derived from any of them is already pressed and there is nothing you
   can start. That is the shape of the two defects Phase 3 shipped in a row (§H.5), and this
   screen is the third one written to avoid it.
4. Tap **START VERIFICATION**.
   - *Verified frames* starts counting immediately. *Judged* counts the subset that cleared the
     correspondence and baseline floors — it will sit at 0 until you move.

5. **Point at the flat textured surface and walk slowly sideways past it for about 30 seconds**,
   keeping roughly the same distance. A deliberate slide, not a sweep.
   - *Baseline* climbs past 15 px and *State* starts reporting `USABLE`, then `GOOD` if the
     surface is rich enough.
   - Under **Planar scene handling**, *Planar* counts up. A flat wall is a plane and the
     homography should be winning.
   - Under **Does RANSAC actually reject outliers?**, *Samples* counts up. **This is the panel
     that carries the phase** — see below.

6. **Point into the depth in the room and walk sideways again for about 30 seconds.** A corner
   where two walls meet, or a doorway with something visible well beyond it. You want things at
   clearly different distances in the same frame.
   - *Non-planar* counts up under **Planar scene handling**. It needs frames of both kinds:
     GEO-004 reports `PENDING` rather than passing if the run only ever saw one.
   - *Median F inliers* should now be visibly above *Median H inliers*. On the flat wall they
     were close together.

7. **Point at the blank wall for about 15 seconds** and move as before.
   - Under **By scene texture**, *TEXTURE_POOR* counts up. It needs 15 frames.
   - Every one of those frames should report `UNVERIFIED`. **A `USABLE` on a blank wall is a
     failure**, not a nice surprise: there is nothing there to verify.

8. **Go back to the depth scene and move for another 15 seconds**, so the injection sampler
   collects enough measurements on a scene worth verifying.

9. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict is
   in the filename — and screenshot the screen.

---

## What to look at before you decide the run was good

| Panel | What it should say |
| --- | --- |
| **Does RANSAC actually reject outliers?** | *Injected outliers rejected* ≥ 90%, *Untouched rejected* ≤ 30%, over 10+ samples |
| **Does RANSAC actually reject outliers?** | *Advantage* ≥ 3× — the paired form, so rejecting at random cannot pass |
| **This frame** | *State mismatches* **0**, *Partition faults* **0**, *Model without verdict* **0** |
| **This frame** | *Baseline* comfortably over 15 px while you are moving |
| **Planar scene handling** | both *Planar* and *Non-planar* non-zero; *Planar mismatches* **0** |
| **By scene texture** | *TEXTURE_POOR* frames present and all of them `UNVERIFIED` |
| **Cost** | *RANSAC* against the 6 ms budget, with the correspondence count beside it |
| **This frame** | *Overlay matches video* — see below |

### The one number that carries the phase

**Injected outliers rejected.** Everything else on this screen is produced *perfectly* by a
stage that accepts every correspondence: the inlier count becomes the correspondence count and
the ratio becomes exactly 1.00, which clears all four figures v3 §14 names and looks better
than a working verifier on every one of them.

So on a sample of frames the harness takes the real correspondence set, displaces 30% of the
targets by 25 px in seeded directions, and hands the result to the verifier with no marking of
which it touched. The recall against that ground truth is the only figure here a pass-through
cannot produce — it scores 0.0%.

The rate for *untouched* correspondences is shown beside it and is equally necessary: recall
alone is satisfied perfectly by rejecting everything.

### The overlay orientation, carried over from Phase 3

Same probe as Phases 3 and 4, and it binds harder here rather than less. A correspondence is
**two positions in the acquired buffer's frame**. If that buffer is turned against the picture
on screen, every baseline and every residual in the bundle is a measurement of the wrong thing —
while every count-based criterion v3 §14 names still passes, because a rotation leaves counts
alone (§H.7).

The Phase 4 device run of 2026-08-22 found this for real: `VIDEO_FRAME` was producing a buffer
rotated 90° against the video, the app abandoned that route after 5265 frames and selected
`IMAGE_BITMAP`, and identity then scored 10.1× chance. Check it in both orientations again here.

- `yes · N× chance` with N comfortably above 2 is what it should say.
- `NO · <transform> fits N× better` means the route is producing a misoriented buffer. The app
  abandons the route rather than correcting the drawing. Report it with the bundle.
- `not measurable` is normal on a blank wall — a smooth frame has no texture to score, and the
  probe says so instead of guessing.

---

## Committing

```
docs/phase5/evidence/phase5-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot, in `docs/phase5/evidence/`. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results using the same
`PhaseRegistry.evaluate` the app uses, so a hand-edited `"overallVerdict": "PASSED"` is caught by
disagreeing with the results it summarises.

**A run that does not pass is still worth committing.** Phase 1 keeps its `FAILED` bundle and
Phase 3 keeps three, because the record of a defect is evidence and deleting it leaves the fix
looking like a change with no cause.
