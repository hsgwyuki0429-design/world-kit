# Phase 9 — running the real-device test

One run, about three minutes, on the iPhone in Safari over HTTPS.

**Phases 1–8 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the TRIANGULATION screen is closed until Phase 8 reaches
`PASSED` on this device now.

What to have ready:

- **a scene with depth in it** — this is the one that matters. A textured wall alone will not do:
  a wall is a plane, the homography wins, and a plane gives a pose but very little to triangulate
  that is not degenerate. A bookshelf with objects at different distances, a table with things on
  it and a wall behind, a corridor — anything where near and far are both in frame.
- **room to walk sideways** for a metre or two. Turning on the spot is exactly what this phase
  refuses to triangulate from, and the run needs the camera to actually *move*.

---

## What this phase is about

The first three-dimensional quantity in this project: where a point **is**, not merely where it
appears. Two keyframes, related by the features they share, and a depth for every point whose two
viewing rays meet at enough of an angle to determine one.

And a refusal, twice over:

- **below 1° of parallax nothing is triangulated.** The floor is derived — §13's 1.5 px
  correspondence band over the assumed focal length is 0.089° of angular noise, and a depth good
  to a tenth of itself needs 0.89° of parallax.
- **from a camera that only turned, nothing at all.** A pure rotation produces large,
  well-conditioned image motion and no parallax whatever. It is what a phone does when someone
  stands still and turns, which is most of a room scan.

Every depth is in units of **that pair's own baseline**, which is 1 by construction. There is no
distance here and there is no shared scale between pairs; Phase 10 is where the pairs are brought
into one frame.

---

## The run

1. Get Phases 1–8 to `PASSED` as their own guides describe.
2. From the KEYFRAME SYSTEM screen, tap **GO TO TRIANGULATION**. Leave the store running — Phase 9
   relates each new keyframe to the one before it and changes nothing about how they are chosen.
3. **Before tapping anything, check the button says `START TRIANGULATION` and is tappable.**
   If it already reads `TRIANGULATING` and is greyed out, stop and report it (§H.5).
4. Tap **START TRIANGULATION**.
5. **Walk sideways past the scene**, slowly, keeping both the near things and the far things in
   frame. Watch *The last pair*: `TRIANGULATED`, with a point count that is a fraction of the
   shared observations rather than all of them.
6. **Stand still and turn** for a few seconds. The pairs should come back `REFUSED` with
   *a camera that only turned determines no depth* — that is the phase working, not failing.
7. Walk again. Keep going for a minute or so, so both injections run several times each: they are
   sampled one batch in six.
8. Watch the tests card. When TRI-001 through TRI-007 all read `PASS` and the verdict head reads
   `PASSED`, tap **DOWNLOAD EVIDENCE JSON**.

---

## What each record needs from you

| Record | What the run has to contain |
| --- | --- |
| TRI-001 | fifteen keyframe pairs — a minute of walking |
| TRI-002 | depth in the scene, so some points have parallax and some do not |
| TRI-003 | nothing from you; the harness builds the pure rotation |
| TRI-004 | nothing from you; the harness picks the depths |
| TRI-005 | nothing special |
| TRI-006 | fifteen pairs where both routes gave a rotation |
| TRI-007 | nothing special; it is about the shape of the record |
| TRI-008/009 | advisory |

---

## If something reads wrong

**Every pair comes back `REFUSED — the pair verified nothing`.** The two keyframes are too close
together for a two-view geometry (under 15 px of median displacement). That should not happen
while Phase 8 is inserting on 30 px, so it means the store is inserting on the heartbeat rather
than on displacement — check the KEYFRAME SYSTEM screen.

**Every pair comes back `ROTATION_ONLY`.** The camera is turning rather than moving. That is the
correct refusal and it is what TRI-003 is about, but a whole run of it decides nothing else —
walk sideways.

**Points are accepted but the count is tiny.** Look at *What was refused, and why*. A large
`LOW_PARALLAX` count on a scene with depth means the camera is barely moving; a large
`HIGH_REPROJECTION` count means the correspondences are being matched across something that moved.

**The depth injection's error reads `0`.** That is correct and expected. The injected pair is
synthesised exactly — the harness picks the depths and projects them — so a linear solve on it is
exact to numerical precision. The number to read beside it is the **control**: what the best
possible constant depth would have scored on the same set. On the automated leg that is 0.234.

---

## Exporting

**DOWNLOAD EVIDENCE JSON** writes `phase9-real-device-<verdict>-<timestamp>.json`. Commit it under
`docs/phase9/evidence/` together with a screenshot of the screen at the moment of export.
