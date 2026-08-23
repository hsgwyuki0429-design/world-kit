# Phase 7 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1–6 have to pass first, in this same session.** The registry starts fresh on every page
load, so the Phase Lock in front of the IMU SUPPORT / FUSION screen is closed until Phase 6
reaches `PASSED` on this device now.

**Grant motion access when iOS asks.** Unlike Phase 6, a refusal here does not merely hold the
phase at `TESTING` — it puts the run into the case v3 §68's pass condition is *about*, and
IMU-002 will pass while everything else reports `PENDING`. That is a real and correct outcome,
and it is the one the automated leg produces on every commit. **It is not the device run you
came for.** The device run is the only place the other seven records can be decided.

What to have ready:

- **a textured scene you can turn in front of** — a patterned wall, a bookshelf, a poster;
- **room to turn on the spot** for a couple of minutes without stepping;
- **something to cover the lens with** — a thumb will do.

---

## What this phase is about, and what it refuses to do

Phase 6 recovered a rotation and a direction from the camera alone. Phase 7 adds the device's own
motion sensing **as an auxiliary to that**, and refuses the part of v3 §18 this platform cannot
support:

| v3 §18's filter state | Phase 7 | why |
| --- | --- | --- |
| `orientation` | estimated | observable from the gyroscope, the visual rotation and gravity |
| `gyroBias` | estimated | vision and a biased gyroscope disagree consistently in one direction |
| `position` | **refused** | the accelerometer reports m/s² and Phase 6's translation has no scale |
| `velocity` | **refused** | same reason |
| `accelBias` | **refused** | not observable without position observability |

The refusal is not a shortcut. **IMU-006 measures what would have happened had it been done
anyway** — the accelerometer is double-integrated over the run, for the record only, and the
resulting drift is on the screen. A refusal with a number behind it is a finding.

---

## The run

1. Get Phases 1–6 to `PASSED` as their own guides describe.
2. From the RELATIVE POSE screen, tap **GO TO IMU SUPPORT / FUSION**. Leave pose recovery
   running — Phase 7 adopts the live solver and changes nothing about how it recovers a pose.
3. **Before tapping anything, check the button says `START FUSION` and is tappable.**
   If it already reads `FUSING` and is greyed out, stop and report it. Six stages are already
   live when this screen opens — camera, pipeline, detector, tracker, verifier, pose — so a
   control derived from any of them is already pressed and there is nothing you can start. That
   is the shape of the two defects Phase 3 shipped in a row (§H.5); this screen is the fifth
   written to avoid it.
4. Tap **START FUSION** and grant motion access when iOS asks.
   - Under **Sensors**, `acceleration`, `accelerationIncludingGravity` and `rotationRate` should
     all read `ARRIVING`, with a *Measured rate* near 60 Hz.
   - **Mode** should move from `VISION_ONLY` to `FUSED` within a second or two.
   - If **Mode** stays `VISION_ONLY` and Sensors reads `ABSENT`, motion access was denied.
     Reload and grant it — the run will otherwise decide only IMU-002.

5. **Turn slowly on the spot for about 90 seconds**, staying pointed at the textured scene.
   ゆっくり回転, as Phase 6 asked, and for longer.
   - Under **Does the filter find a bias it was not told about?**, *Samples* starts counting once
     ten visual updates have been applied — which takes about ten seconds of steady turning,
     because each update spans a second. **This is the panel that carries the phase.**
   - *Difference recovered* should settle within 1 °/s of 3 °/s, and *Off the injected axis*
     under 25°.
   - Under **Vision against the gyroscope**, *Prediction was off by* should sit well inside
     *Tolerance*, and *Exactly zero* should stay at **0**.

   Keep turning. The bias estimate improves with the *total time*, and a minute of steady motion
   resolves it far better than three bursts of twenty seconds — an increment cannot be formed
   across a re-anchor, so stopping and starting throws intervals away.

6. **Cover the lens with your thumb for about 4 seconds, while still turning.** Then uncover it.
   - **Mode** should go to `DEAD_RECKONING` after half a second, and *Propagated for* should
     count up in milliseconds.
   - The **fused confidence** should fall the whole time and never rise.
   - Past 3000 ms, **Usable** should read `NO`.
   - When you uncover the lens, *Reconvergence* records how far the two instruments had drifted
     apart. A number there is the point — a filter that snapped back silently would be hiding
     the one moment its instruments disagreed most.

7. **Repeat step 6 twice more**, so IMU-007 has 15 open-loop frames and more than one interval.

8. **Turn steadily for another 60 seconds** so the bias estimate finishes converging and the
   innovation median settles.

9. When the verdict panel shows what you want, tap **DOWNLOAD EVIDENCE JSON** — the verdict is
   in the filename — and screenshot the screen.

---

## What to look at before you decide the run was good

| Panel | What it should say |
| --- | --- |
| **Does the filter find a bias it was not told about?** | *Difference recovered* within 1 °/s of 3 °/s, over 10+ samples |
| **Does the filter find a bias it was not told about?** | *Off the injected axis* under 25° |
| **Vision against the gyroscope** | *Prediction was off by* inside *Tolerance*; *Exactly zero* **0** |
| **Vision against the gyroscope** | *Gravity disagreement* under 10° |
| **Mode** | `FUSED` for 15+ frames; *Propagated for* non-zero between poses |
| **Mode** | 15+ open-loop frames, *Longest gap* over 3000 ms, *Usable* `NO` past it |
| **Position** | `UNAVAILABLE`, *Records with a position* **0**, and a drift figure beside it |
| **Confidence** | *Fused* at or below *Phase 6's*; *Above its worst term* **0** |
| **Sensors** | all three channels `ARRIVING`, measured rate recorded |

### The number that carries the phase

**"Difference recovered", against the 3 °/s that was injected.** Two filters run on the same
visual poses and the same gyroscope, and one of them is fed every sample with a constant 3 °/s
added before it sees it. Neither is told which it is. The measurement is the *difference* between
their bias estimates, because this phone's own bias is unknown and common to both — so it
cancels, and what is left is the harness's.

A fusion that returns the visual pose unchanged scores **0.0 °/s** here, and passes almost
everything else in the phase: its orientation tracks the camera perfectly, its innovation is
exactly zero — *better* than a real filter's — and it never invents a position.

**The difference alone is not enough, and the plan records why.** Gravity, on a device that
turns, observes all three bias components by itself: driving the filter with no visual updates at
all recovered a 3 °/s injection to within 0.0004 °/s. So the panel's other two figures are
load-bearing, not decoration — the direction has to match, and the injected filter's *own*
innovation has to stay inside the tolerance, which a fusion that ignored vision cannot manage.

### What this phase will not tell you, by design

- **No position, no velocity, no scale.** The screen says `UNAVAILABLE` as a value, with the
  reason and the measured drift beside it. Phase 9 triangulates; nothing before it has a metre.
- **No absolute heading.** `webkitCompassHeading` exists on this platform and Phase 7 does not
  read it, so the heading is `RELATIVE` — to wherever gravity pointed when the filter started.
- **No change to Phase 6.** Its confidence still withholds `IMU consistency`, its POSE-002 still
  scores it against the gyroscope, and its numbers are the same with Phase 7 running or not.

---

## Committing

```
docs/phase7/evidence/phase7-real-device-<VERDICT>-<timestamp>.json
```

plus the screenshot, in `docs/phase7/evidence/`. Then update `docs/PHASE-STATUS.md`.

`npm test` re-derives the verdict from the bundle's own results using the same
`PhaseRegistry.evaluate` the app uses, so a hand-edited `"overallVerdict": "PASSED"` is caught by
disagreeing with the results it summarises. It also re-derives IMU-005's gate, IMU-006's refusal
and IMU-009's honesty checks from the bundle's own numbers.

**A run that does not pass is still worth committing.** Phase 1 keeps its `FAILED` bundle and
Phase 3 keeps three, because the record of a defect is evidence and deleting it leaves the fix
looking like a change with no cause.
