# Phase 4 — Optical Flow Tracking (§12, §13, §65)

Written before the code, as §29 requires. Thresholds are fixed here and are not to be
relaxed after seeing a result; a criterion that turns out to measure the wrong thing may be
*narrowed* with the reasoning recorded in place, as Phases 2 and 3 both did.

## Objective

Follow the corners Phase 3 finds from one frame to the next, and know when that has stopped
working.

Phase 3 detects independently on every frame: `age` is 0 and `trackLength` is 1 on every
record. Phase 4 is the first phase in which a feature has a *history* — and the first whose
output can be convincingly faked, because a list of points that never moves is exactly what a
perfectly tracked static scene looks like.

## §12's parameters, fixed

| | Value | Source |
| --- | --- | --- |
| Window | 21×21 | §12 |
| Pyramid levels | 3 | §12 (4 at high performance — not the default) |
| Max iterations | 30 | §12 |
| Epsilon | 0.01 | §12 |

## §13's forward/backward bands, fixed

Track A→B, then track the result B→A, and measure how far the round trip lands from where it
started.

| FB error | Meaning |
| --- | --- |
| ≤ 1.5 px | acceptable |
| 1.5–3.0 px | reduced confidence |
| > 3.0 px | reject |

These are §13's numbers verbatim. `forwardBackwardError` on the §11 record stops being
`null` in this phase — it is the first of the two error terms Phase 3 deliberately left
unmeasured.

## §65's five tests, and what they leave open

§65 names FLOW-001 静止, FLOW-002 ゆっくり横移動, FLOW-003 ゆっくり回転, FLOW-004 急速移動,
FLOW-005 Camera遮断, and asks for: *正常時Tracking、異常時DEGRADED/LOSTへ遷移.*

That is a statement about behaviour under five conditions. It does not say how the harness
knows which condition it is in, and this is the whole difficulty: **the tester's intention is
not evidence.** A run where someone believes they held the phone still, and a run where the
tracker ignored the image, produce the same numbers unless the scene motion is measured
independently of the tracker.

So every test below is defined against a **measured** property of the image, never against
what the operator meant to do — the same discipline that made Phase 3 classify texture from
the frame's own gradient rather than from a button the tester pressed.

## Three things this phase must not be allowed to fake

### 1. A tracker that returns its input

The single most dangerous failure. If `track(A→B)` returns the points it was given:

- every point survives, so the count is perfect;
- **the forward/backward error is exactly 0**, so §13's own check passes at its best band;
- `age` and `trackLength` climb honestly;
- and on a static scene it is indistinguishable from a working tracker.

**Forward/backward validation cannot detect this, and neither can any statistic computed only
from the tracker's output.** So the gate is a cross-check against an independent measurement
of how far the image actually moved:

> Over frames where the image demonstrably moved, the median tracked displacement must agree
> with an independent estimate of the scene's motion.

The independent estimate is a **coarse translation search on the pyramid's top level**, run
by the harness rather than the tracker: the shift, over a small integer search range, that
minimises the sum of absolute differences between consecutive top-level images. It shares no
code with the LK solver, it is not iterative, and it does not use the feature list at all.
A tracker returning its input reports zero displacement while the coarse search reports the
real one, and the disagreement is the failure.

This is Phase 4's counterpart to Phase 2's provenance cross-check and Phase 3's contrast
statistic, and it is required for the same reason: everything else about a track can be
produced without ever looking at frame B.

### 2. A state that is asserted rather than caused

§33 lists `READY`, `TRACKING`, `GOOD`, `DEGRADED`, `LOST`, `RELOCALIZING`. Phase 4 owns the
first five (relocalisation is §21, Phase 8 and beyond). The state must be a **pure function of
the measured quantities**, computed in one place, so that it cannot disagree with the numbers
displayed beside it — the same rule Phase 3's `stateMismatches` counter enforces, and which
caught nothing there only because it was obeyed.

### 3. Survivors invented to keep the count up

Phase 3's refill ladder tops the population back up when it falls. In Phase 4 that ladder is
still present, and it would let a tracker lose every point and hide it: the count stays near
target because detection replaced them. So tracked and redetected features are counted
**separately**, and every test below that speaks of survival speaks of the tracked ones.

## Measuring the scene's motion, from the image

Each frame the worker already builds a 3-level pyramid. The harness adds one measurement on
the smallest level (the cheapest, and the one least sensitive to noise):

- **`sceneShift`** — the (dx, dy) minimising SAD over an integer search of ±8 px on the top
  level, scaled to level-0 pixels; and the residual at that shift.
- **`sceneShiftConfidence`** — how much better the best shift is than the median shift tried.
  Near 1 the search found nothing distinctive and the frame pair says nothing about motion.

A frame is classified from these, not from the operator:

| Class | Condition |
| --- | --- |
| `STATIC` | measured shift < 1.0 px at level 0 |
| `SLOW` | 1.0–12 px |
| `FAST` | > 12 px |
| `OCCLUDED` | mean luma below 12, or top-level MAD against the previous frame above 60 with no shift explaining it |

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `LK_WINDOW` | 21 | §12 |
| `LK_LEVELS` | 3 | §12 |
| `LK_MAX_ITERATIONS` | 30 | §12 |
| `LK_EPSILON` | 0.01 | §12 |
| `FB_ACCEPTABLE_PX` | 1.5 | §13 |
| `FB_REDUCED_PX` | 3.0 | §13 |
| `STATIC_SHIFT_PX` | 1.0 | below the level-2 quantisation, so it cannot resolve motion |
| `FAST_SHIFT_PX` | 12.0 | over half the 21 px window; LK's linearisation is past its range |
| `MIN_CLASS_FRAMES` | 15 | per class, as Phase 3 used, before that class is judged |
| `MIN_SHIFT_SAMPLES` | 10 | paired cross-checks before the agreement is judged |
| `SHIFT_AGREEMENT_PX` | 2.0 | absolute tolerance … |
| `SHIFT_AGREEMENT_FRACTION` | 0.35 | … or this fraction of the measured shift, whichever is larger |
| `STATIC_DRIFT_PX` | 1.0 | median displacement allowed on a static scene |
| `MIN_SURVIVAL_SLOW` | 0.70 | fraction of tracked points surviving one slow frame |
| `LOST_SURVIVAL` | 0.20 | below this, tracking is `LOST` |
| `DEGRADED_FEATURES` | 80 | §11's `TRACKING DEGRADED` threshold, reused |
| `GOOD_FEATURES` | 300 | §33's `GOOD` candidate condition |
| `FLOW_BUDGET_MS` | 14.0 | §H's line for pyramidal LK on ~700 points |

`SHIFT_AGREEMENT_FRACTION` deserves its derivation. The coarse search is integer-valued on
level 2, so its own quantisation is 4 level-0 pixels; LK is sub-pixel. Requiring agreement to
better than the coarse search's own resolution would be requiring the tracker to match a
cruder instrument exactly. 35 % of the shift, or 2 px, is comfortably inside "these describe
the same motion" and comfortably outside "one of them is reporting zero" — the same shape of
argument Phase 1 used for its MAD floor and Phase 3 for its contrast gate.

---

## Test records

### FLOW-001 — 静止 · REQUIRED

- **Input:** frames the harness measured as `STATIC`.
- **Expected:** the tracker holds its points where they are, and says `TRACKING`/`GOOD`.
- **Pass criteria:** all of —
  1. ≥ 15 `STATIC` frames;
  2. median tracked displacement ≤ 1.0 px;
  3. median forward/backward error ≤ 1.5 px;
  4. tracked survival ≥ 0.90 across those frames;
  5. the state is never `LOST` while the scene is static and the count is above 80.
- **Failure condition:** points drifting on a still scene, or the state degrading with nothing
  degrading in the image.
- **Not accepted as a pass:** this test alone. Criterion 2 is satisfied perfectly by a tracker
  that returns its input; FLOW-002 is what separates them, and neither passes without the other.

### FLOW-002 — ゆっくり横移動 · REQUIRED

The phase's central test, and its anti-fake gate.

- **Input:** frames the harness measured as `SLOW`, with `sceneShiftConfidence` clearing its floor.
- **Expected:** points follow the image, by the amount the image actually moved.
- **Pass criteria:** all of —
  1. ≥ 15 `SLOW` frames and ≥ 10 paired shift cross-checks;
  2. **the median absolute difference between the tracked median displacement and the
     independently measured scene shift is within `max(2.0 px, 0.35 × shift)`**;
  3. the tracked median displacement is itself ≥ 1.0 px — the tracker moved at all;
  4. tracked survival ≥ 0.70 per frame;
  5. median forward/backward error ≤ 1.5 px.
- **Failure condition:** displacement disagreeing with the measured motion; in particular a
  tracker reporting ~0 while the image demonstrably moved.
- **Not accepted as a pass:** agreement on a scene that never moved. Criterion 3 exists so
  that a run with no motion cannot satisfy criterion 2 trivially.

### FLOW-003 — ゆっくり回転 · REQUIRED

- **Input:** `SLOW` frames during which the device's own gyroscope reported rotation — Phase 0
  measured `rotationRate` AVAILABLE at 60 Hz, so this is a second independent instrument.
- **Expected:** tracking survives rotation, and the flow field is not a pure translation.
- **Pass criteria:** all of —
  1. ≥ 15 frames with integrated gyro rotation ≥ 5°;
  2. tracked survival ≥ 0.70;
  3. median forward/backward error ≤ 1.5 px;
  4. the displacement field's spread across the 8×6 grid is measurably larger during rotation
     than during pure translation — a rotation moves image corners by different amounts, a
     translation does not.
- **Failure condition:** losing the population on a slow rotation; or a flow field identical in
  every cell, which is a translation-only model rather than a measurement.
- **Excluded if:** the gyroscope is unavailable. Recorded as `PENDING` with that reason rather
  than judged, as Phase 1 did for CAM-004.

### FLOW-004 — 急速移動 · REQUIRED

- **Input:** frames measured `FAST` (> 12 px at level 0).
- **Expected:** the tracker fails *honestly* — §65 asks for the transition, not for success.
- **Pass criteria:** all of —
  1. ≥ 15 `FAST` frames;
  2. survival there is measurably lower than during `SLOW` frames;
  3. rejected points are rejected by the §13 band — the fraction with FB error > 3.0 px rises;
  4. the state reaches `DEGRADED` or `LOST` when the tracked count falls below §11's
     thresholds, and the state never disagrees with the count that is displayed beside it.
- **Failure condition:** survival unchanged under motion the window cannot span — which means
  the numbers are not coming from the image; or a count that collapses with the state still
  reporting `GOOD`.

### FLOW-005 — Camera遮断 · REQUIRED

- **Input:** frames measured `OCCLUDED` — the lens covered.
- **Expected:** `LOST`, promptly, and recovery once the lens is uncovered.
- **Pass criteria:** all of —
  1. ≥ 10 `OCCLUDED` frames;
  2. the state reaches `LOST` within 1.0 s of the occlusion beginning;
  3. no track survives with a *good* FB error through the occlusion — a point that "tracks"
     across a black frame is a point that was never tracked;
  4. after the lens is uncovered, detection refills and the state leaves `LOST`.
- **Failure condition:** `TRACKING` maintained through a black frame; or never recovering.

### FLOW-006 — Cost · ADVISORY

- **Input:** the measured cost of the LK solve per frame.
- **Pass criteria:** mean ≤ 14.0 ms over ≥ 10 frames, at §12's parameters, with the point count
  recorded alongside.
- **Failure condition:** over budget. Advisory because §34 ranks correctness above performance
  — and, as §H.6 records, because a device budget cannot be adjudicated off the device. The
  automated leg prints the verdict and gates on a wider configuration tripwire instead.

### FLOW-007 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. `forwardBackwardError` is now a number on every tracked record, and `null` on records that
     were freshly detected this frame and have no round trip yet;
  2. `reprojectionError` is **still `null`** — Phase 6 measures it, and a number here would be
     invented;
  3. `age` and `trackLength` increase only for points that actually survived, and reset on
     redetection;
  4. no record claims a `trackLength` longer than the number of frames since it appeared.
- **Failure condition:** any of the above unmet. Advisory because it is a property of the code
  and is covered by unit tests as well.

---

## What a pass requires, in full

FLOW-001, 002, 004 and 005 PASS on a `REAL_DEVICE` bundle, with FLOW-003 PASS or excluded for
a measured absence of the gyroscope. Rule 004 stands: the automated leg cannot pass this phase.

The one number that carries the phase is **FLOW-002 criterion 2** — the agreement between what
the tracker says the points did and what an independent search says the image did. Every other
number in this plan can be produced by a tracker that never looked at frame B.
