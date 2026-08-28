# Phase 8 — running the real-device test

One run, about three minutes, on the iPhone in Safari over HTTPS.

**Phases 1–7 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the KEYFRAME SYSTEM screen is closed until Phase 7 reaches
`PASSED` on this device now.

What to have ready:

- **a textured scene you can walk along** — a patterned wall, a bookshelf, a row of posters;
- **somewhere to rest the phone**, or a steady hand, because *holding still* is half of this test;
- about two minutes.

---

## What this phase is about

Which views are worth keeping. v3 §20 gives four conditions, a minimum interval and a maximum;
Phase 8 implements three of the four and **refuses the fourth**, because it asks for a translation
*magnitude* and Phase 6 recovers a unit direction with `SCALE: LOCAL_UNITS`. The refusal is on the
screen as a value with a number beside it, exactly as Phase 7's refused position is.

Phase 5's verification anchor stays exactly where it is. It is a one-slot stand-in for this phase
— the tracker says so in as many words — and it is what Phases 5 and 6 passed on the device with,
so the store is a **second** structure beside it rather than a replacement.

---

## The one thing this run has to include

**Hold the phone still for about ten seconds, in the middle of the run.**

That is not a rest; it is the measurement. A keyframe system and a fixed-interval scheduler behave
identically on a moving camera — on a moving camera *any* schedule produces separated views — and
they part company only when nothing is moving. A metronome runs inside the app beside the real
selector, on the same frames, firing as often as the real one is allowed to, and KEY-002 is the
difference between the two counts over the frames where the image was still.

Whether the image is still is **not** decided by Phase 8. It is Phase 4's own scene-shift search —
an exhaustive integer search that shares no code with the tracker — reporting `STATIC` below 1 px
of image motion. The screen shows what it currently reads.

---

## The run

1. Get Phases 1–7 to `PASSED` as their own guides describe.
2. From the IMU SUPPORT / FUSION screen, tap **GO TO KEYFRAME SYSTEM**. Leave the fusion running
   — Phase 8 adopts the live stack and changes nothing about how a pose is recovered or fused.
3. **Before tapping anything, check the button says `START KEYFRAMES` and is tappable.**
   If it already reads `KEEPING` and is greyed out, stop and report it. Seven stages are live
   when this screen opens, so a control derived from any of them is already pressed and there is
   nothing you can start. That is the shape of the two defects Phase 3 shipped in a row (§H.5);
   this screen is the sixth written to avoid it.
4. Tap **START KEYFRAMES**.
5. **Walk slowly along the scene for about forty seconds**, keeping it in frame. Under
   *v3 §20's conditions* you should see `DISPLACEMENT` firing, and the store filling.
6. **Stop and hold still for ten seconds.** Watch the top panel:
   - *Static decisions* climbs;
   - *This selector kept* should stay put, or gain a single `HEARTBEAT`;
   - *A metronome would have* climbs steadily. The ratio is the number this phase is about.
7. **Walk again for another forty seconds**, and turn through a corner if you have room — that is
   what gets `ROTATION` to fire alongside `DISPLACEMENT`.
8. Keep going until *Held* reaches **30 / 30** and *Evictions* is non-zero. KEY-003 cannot be
   decided by a run that never reached the bound.
9. Watch the tests card. When KEY-001 through KEY-006 all read `PASS` and the verdict head reads
   `PASSED`, tap **DOWNLOAD EVIDENCE JSON**.

---

## What each record needs from you

| Record | What the run has to contain |
| --- | --- |
| KEY-001 | movement, so a geometric condition fires rather than only the heartbeat |
| KEY-002 | **the still hold** — at least fifteen decisions with the image not moving |
| KEY-003 | long enough to fill thirty keyframes and evict |
| KEY-004 | nothing special; it inspects what the other steps produced |
| KEY-005 | nothing special; it is about the shape of the record |
| KEY-006 | enough movement that some keyframes lose their features — a corner does it |
| KEY-007 | advisory: ten decisions |
| KEY-008 | advisory: nothing special |

---

## If something reads wrong

**`START KEYFRAMES` is greyed out on arrival.** Report it; do not work around it. See step 3.

**Nothing is inserted at all.** Check *Shared with the last* on the conditions card. Below 20 the
view cannot be half of a pair and the selector refuses it — that is `TOO_FEW_OBSERVATIONS`, and it
means the tracker has lost its population rather than that the selector is wrong.

**The static ratio stays at `—`.** *Static decisions* is still short of fifteen. Hold the phone
against something; a hand-held "still" often reads `SLOW`, which is Phase 4 telling you the truth
about your hand rather than a fault.

**`HEARTBEAT` every five seconds while you hold still.** That is correct and it is v3 §20's
maximum interval. A still camera still owes the store a view every five seconds.

**The translation row reads `UNMEASURED`.** That is the correct and permanent state of that row
in this build. See KEY-005 and the panel beneath it.

---

## Exporting

**DOWNLOAD EVIDENCE JSON** writes `phase8-real-device-<verdict>-<timestamp>.json`. Commit it under
`docs/phase8/evidence/` together with a screenshot of the screen at the moment of export.

A `TESTING` export is worth committing too. It records what was still `PENDING` and why, and the
project keeps those: `docs/phase1/evidence/` holds a `FAILED` bundle on purpose.
