# Phase 10 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1–9 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the LANDMARK MAP screen is closed until Phase 9 reaches
`PASSED` on this device now.

What to have ready:

- **the same scene with depth in it** Phase 9 needed — near things and far things in frame;
- **room to walk a few metres and come back**, slowly. This phase is about a point being
  recognised the *second* and *fifth* time it is seen, so the run needs the camera to keep
  returning to the same part of the room rather than sweeping past it once.

---

## What this phase is about

Phase 9 leaves one answer per keyframe pair, each in units of that pair's own baseline. On the
automated leg the median depth moved by 87 % of itself between consecutive batches on a scene that
never changed — not because the room moved, but because the unit did.

This is where that stops being true. The landmarks two batches share fix the ratio between their
scales, recovered as the scale term of a similarity fitted in closed form. **The world has one
consistent unit and no known one**: §34 fixes the origin at the initial camera pose, and §A.3.1
records why it cannot be anything else — `absolute` is `false` on this platform and the compass
reported ±24.5°, so there is no global datum to align to.

---

## The run

1. Get Phases 1–9 to `PASSED` as their own guides describe.
2. From the TRIANGULATION screen, tap **GO TO LANDMARK MAP**. Leave triangulation running.
3. **Before tapping anything, check the button says `START LANDMARK MAP` and is tappable.**
   If it already reads `MAPPING` and is greyed out, stop and report it (§H.5).
4. Tap **START LANDMARK MAP**.
5. **Walk slowly along the scene**, as for Phase 9. Watch *The map*: landmarks appear as
   candidates and turn confirmed once three views have seen them.
6. **Walk back the way you came**, slowly. This is the part that matters: it is what gets a
   landmark seen five times, which is what *Convergence* needs, and it is what fills the held-out
   prediction panel.
7. Keep going for two or three minutes, so the injection runs several times — it is sampled one
   batch in four, and only over points the map already holds.
8. Watch the tests card. When MAP-001 through MAP-007 all read `PASS` and the verdict head reads
   `PASSED`, tap **DOWNLOAD EVIDENCE JSON**.

---

## What each record needs from you

| Record | What the run has to contain |
| --- | --- |
| MAP-001 | fifteen batches, and landmarks seen three times |
| MAP-002 | landmarks seen again from a **new** keyframe — walking back does it |
| MAP-003 | nothing special; every batch reports its registration |
| MAP-004 | nothing special |
| MAP-005 | nothing from you; the harness builds the injection |
| MAP-006 | landmarks seen **five** times — the same part of the room, revisited |
| MAP-007 | nothing special; it is about the shape of the record |
| MAP-008/009 | advisory |

---

## If something reads wrong

**Most batches read `UNREGISTERED — the batch shares N landmarks with the map`.** The camera is
moving too fast for the tracker to carry features across two keyframes. Slow down; the number to
watch is *Shared* on the map panel.

**`Epochs` keeps rising.** The map is losing its world and starting again — five consecutive
batches it could not place. That is the honest outcome of a run where tracking keeps breaking, and
it is reported rather than hidden, but a run with several epochs will not satisfy MAP-006 because
nothing survives long enough to be seen five times.

**The held-out panel stays at `0 / 15`.** Nothing has been seen from a keyframe it was not
computed from. Walk back over ground you have already covered.

**`Untouched, rejected` is high but the `Excess` is small.** That is the expected shape. The gate
compares two estimates of one point and refuses the tail of their disagreement whether or not
anything was injected; what MAP-005 judges is the *excess* over that baseline.

---

## Exporting

**DOWNLOAD EVIDENCE JSON** writes `phase10-real-device-<verdict>-<timestamp>.json`. Commit it
under `docs/phase10/evidence/` with a screenshot of the screen at the moment of export.
