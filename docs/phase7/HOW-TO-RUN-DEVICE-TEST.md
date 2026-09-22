# Phase 7 — running the real-device test

One run, about four minutes, on the iPhone in Safari over HTTPS.

**Phases 1–6 have to have passed on this build — not necessarily in this session.** A phase that
reached `PASSED` on this phone, on the build the page is serving, keeps its door open across
page loads, so you do not re-run them to get here. See
[`docs/PHASE-LOCK-CARRY-OVER.md`](../PHASE-LOCK-CARRY-OVER.md) for what that carries — a lock,
not a verdict — and what it refuses. If the build has moved since, a deploy or a reload onto new
code, the doors are shut again and you do run the chain: a pass is evidence about the code that
produced it.

**The stages still have to be started, and that is the part that costs you anything.** The lock
and the pipeline are different things. Walk forward through the screens, one tap on each —
`カメラ開始`、`パイプライン開始`、`特徴点検出開始`、`追跡開始`、`幾何検証開始`、`姿勢復元開始` —
using the `… へ進む` buttons, because `… へ戻る` stops the stage you came from. The Phase Lock
in front of the 「IMU 統合」 screen stays closed until Phase 6 has `PASSED` on this device on
this build, and each screen's button says which of the two things is missing when it is
disabled.

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

1. Open the app and walk forward to the 「IMU 統合」 screen, tapping
   `カメラ開始`、`パイプライン開始`、`特徴点検出開始`、`追跡開始`、`幾何検証開始`、`姿勢復元開始`
   on the way. A phase that already passed on this build keeps its door open; one that has not
   still has to pass here, as its own guide describes.
2. From the 「相対姿勢」画面, tap **IMU 統合へ進む**. Leave pose recovery
   running — Phase 7 adopts the live solver and changes nothing about how it recovers a pose.
3. **Before tapping anything, check the button says `IMU 統合開始` and is tappable.**
   If it already reads `統合中` and is greyed out, stop and report it. Six stages are already
   live when this screen opens — camera, pipeline, detector, tracker, verifier, pose — so a
   control derived from any of them is already pressed and there is nothing you can start. That
   is the shape of the two defects Phase 3 shipped in a row (§H.5); this screen is the fifth
   written to avoid it.
4. Tap **IMU 統合開始** and grant motion access when iOS asks.
   - Under **センサー**, `acceleration`, `accelerationIncludingGravity` and `rotationRate` should
     all read `受信中`, with a *実測レート* near 60 Hz.
   - **モード** should move from `VISION_ONLY` to `FUSED` within a second or two.
   - If **モード** stays `VISION_ONLY` and **センサー** reads `来ていません`, motion access was denied.
     Reload and grant it — the run will otherwise decide only IMU-002.

5. **Turn for about four minutes, about more than one axis, and never stop moving**, staying
   pointed at the textured scene. ゆっくり回転, as Phase 6 asked, for longer, and *not only* the yaw that
   phase asked for: sweep left and right, then tilt the phone up and down, then roll it about
   the lens axis, and keep mixing the three.

   **This is not a preference, it is what the calibration can and cannot solve.** The gyroscope
   reports in the phone's frame and Phase 6's poses are in the camera's; the fixed rotation
   between them is estimated from turns seen by both. A turn about a single axis leaves that
   rotation undetermined — every further turn *about that same axis* fits the pairs equally
   well — so `AXIS_SPREAD_FLOOR` refuses a pan outright and nothing fuses. This guide asked for
   a turn on the spot until 2026-09-21, and the two device runs that reached a fit at all came
   back with an axis spread of **0.0711** and **0.0291** against a floor of **0.02** — clearing
   it by 3.6× and by 1.5×, which is as close to refused as a run can be while still being
   fitted. The third never reached the twelve pairs a fit needs at all. The instruction was the
   shape the refusal exists for.

   **Why four minutes rather than ninety seconds.** A pair is one second of turning with Phase
   5's verification anchor holding across the whole of it, and that anchor is re-taken far more
   often than once a second: the run of 2026-09-22 re-anchored **384 times in under three
   minutes**, a mean anchor life of about half a second, so most seconds are cut in half and
   thrown away. It offered **15 pairs in 128 seconds of fusion** — one per eight and a half
   seconds, against the one per second the interval would suggest — and 7 of them survived the
   angle filters, against the 12 a fit needs. At that rate twelve usable pairs takes between
   three and four minutes of continuous motion. Nothing is wrong when the count climbs slowly;
   it climbs slowly.

   **Keep each second worth about 5° to 15°.** Both filters that reject a pair are about the
   size of the turn in it, and they squeeze from opposite sides:
   - Under 1° in a second and the turn carries no axis at all — `MIN_PAIR_ROTATION_DEG`. Four of
     that run's fifteen went this way, which is what a pause looks like in this record.
   - The two halves must agree about the angle to within **25 %** — `PAIR_ANGLE_TOLERANCE`, a
     *relative* test, which is far harsher on a small turn than POSE-002's 3° floor: a 2° turn
     has to agree within half a degree, while a 10° turn is allowed two and a half. Another four
     went this way, on a run whose camera and gyroscope agreed to a median of **0.71°** — so
     they were not disagreeing instruments, they were turns too small for the fraction.

   So: continuous, unhurried, and definitely turning — not a sweep followed by a pause, and not
   a flick. A flick also costs the anchor, which costs the whole second.

   - Watch **端末 → カメラ**. It reads the pair count against the twelve a fit needs until
     there are enough of them, then the count with the residual beside it. Once it turns green
     the extrinsic is known and **モード** can leave `VISION_ONLY`.
   - If it stays refused with a message about the axis spread, mix the axes harder. If it
     refuses with a **large residual** instead, that is not something you can fix by moving
     differently — the two halves of each pair are not the same motion, which is an engine
     defect. Stop and report it with the bundle.
   - Under **教えていないバイアスをフィルタは見つけるか？**, *サンプル数* starts counting once
     ten visual updates have been applied — which takes about ten seconds of steady turning,
     because each update spans a second. **This is the panel that carries the phase.**
   - *復元できた差* should settle within 1 °/s of 3 °/s, and *仕込んだ軸からのずれ*
     under 25°.
   - Under **視覚とジャイロの突き合わせ**, *予測のずれ* should sit well inside
     *許容範囲*, and *ちょうどゼロ* should stay at **0**.

   Keep turning. The bias estimate improves with the *total time*, and a minute of steady motion
   resolves it far better than three bursts of twenty seconds — an increment cannot be formed
   across a re-anchor, so stopping and starting throws intervals away.

6. **Cover the lens with your thumb for about 4 seconds, while still turning.** Then uncover it.
   - **モード** should go to `DEAD_RECKONING` after half a second, and *外挿の継続時間* should
     count up in milliseconds.
   - The **fused confidence** should fall the whole time and never rise.
   - Past 3000 ms, **使用可能** should read `NO`.
   - When you uncover the lens, *復帰時のずれ* records how far the two instruments had drifted
     apart. A number there is the point — a filter that snapped back silently would be hiding
     the one moment its instruments disagreed most.

7. **Repeat step 6 twice more**, so IMU-007 has 15 open-loop frames and more than one interval.

8. **Turn steadily for another 60 seconds** so the bias estimate finishes converging and the
   innovation median settles.

9. When the verdict panel shows what you want, tap **エビデンス JSON をダウンロード** — the verdict is
   in the filename — and screenshot the screen.

---

## What to look at before you decide the run was good

| Panel | What it should say |
| --- | --- |
| **教えていないバイアスをフィルタは見つけるか？** | *復元できた差* within 1 °/s of 3 °/s, over 10+ samples |
| **教えていないバイアスをフィルタは見つけるか？** | *仕込んだ軸からのずれ* under 25° |
| **視覚とジャイロの突き合わせ** | *予測のずれ* inside *許容範囲*; *ちょうどゼロ* **0** |
| **視覚とジャイロの突き合わせ** | *重力の食い違い* under 10° |
| **モード** | `FUSED` for 15+ frames; *外挿の継続時間* non-zero between poses |
| **モード** | 15+ open-loop frames, *最長の途切れ* over 3000 ms, *使用可能* `NO` past it |
| **位置** | `UNAVAILABLE`, *位置を持つ記録* **0**, and a drift figure beside it |
| **信頼度（v3 §19、7つの入力すべて）** | *統合後* at or below *Phase 6's*; *最悪の項を上回った回数* **0** |
| **センサー** | all three channels `受信中`, measured rate recorded |

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
