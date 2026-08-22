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

---

## Amendments

Recorded in place, as §29 requires, and as Phases 2 and 3 both did. Every one of these
either **fixes a number the plan named but did not fix**, or **narrows a criterion that was
measuring the wrong frames** — none relaxes a threshold, and none was made after seeing a
verdict it would have changed. Where a run is cited, the run is what produced the argument.

### A1. `sceneShiftConfidence`'s floor is 1.10

The plan names `sceneShiftConfidence` and requires FLOW-002's frames to clear "its floor"
without saying what the floor is. Fixed here at **1.10** — the best shift must beat the
median shift tried by 10 %.

The derivation, which is in `src/tracking/SceneShift.ts` beside the constant: the residual is
a mean absolute difference over 8-bit samples, so it is quantised at one intensity level. On
the top pyramid level of a real scene the residual at the best shift runs a few levels per
pixel, so a single level of quantisation is on the order of ten per cent of it. A smaller
margin is not a measurement; a much larger one would require a scene to be strongly textured
before its motion could be spoken about at all, which would silently exclude exactly the
frames Phase 3 calls texture-poor.

A flat or featureless pair scores at or barely above 1.0 by construction — every shift matches
equally badly — and is excluded rather than reported as motionless, which is the distinction
the number exists to draw.

### A2. FLOW-003's "integrated gyro rotation" is integrated over 1000 ms

The plan asks for "≥ 15 frames with integrated gyro rotation ≥ 5°" and does not name the
window. Fixed at **1000 ms trailing**, in `src/tracking/FlowSession.ts`: long enough that 5°
describes a deliberate slow turn rather than hand shake, short enough that the frames it marks
are the frames that were actually rotating rather than a run that turned once at the start.
Phase 0 measured `rotationRate` AVAILABLE at 60 Hz, so the window holds about 60 samples, and
the integral is a trapezoid over the samples actually received rather than a rate times an
assumed interval.

### A3. §33's `inliers < 20` is Phase 5's branch, and Phase 4 does not evaluate it

§33 gives LOST two conditions: `inliers < 20`, or consecutive pose-estimation failures.
Inliers come from §14's geometric verification, which is Phase 5 and has not been written.

The first implementation reused the *number* for tracked points, on the reasoning that it is
the quantity Phase 4 actually has. **The first synthetic run said no.** On a scene yielding 20
features, survival of 19 out of 20 is a tracker working perfectly, and every frame was
nonetheless counted as a failure — so the state sat at `LOST` for a run in which nothing had
been lost, and FLOW-005 could not distinguish a covered lens from a sparse one.

A population too small to work with is what `DEGRADED` says, on the count, in §11's units.
`LOST` is about losing what you had. So Phase 4 evaluates only §33's consecutive-failure
branch, a failed frame is one where survival fell below `LOST_SURVIVAL`, and the constant is
kept named and unused so Phase 5 wires it to the quantity it actually describes.

This narrows what can reach `LOST`. It does not relax FLOW-005, which still requires `LOST`
within 1.0 s of a covered lens — and which the automated leg now reaches in 75–110 ms.

### A4. FLOW-001 and FLOW-004 count frames of their own motion class

FLOW-001 criterion 5 says the state must never be `LOST` **while the scene is static**.
FLOW-004 criterion 4 says the state must reach `DEGRADED` or `LOST` when the count falls under
fast motion. Both were first implemented against a run-wide tally of `stateFrames`.

That makes the two criteria contradict each other: FLOW-005 requires a deliberate occlusion
during which the state is `LOST` on purpose, and a run-wide tally hands those frames to
FLOW-001 as a failure. A correct implementation of both could not exist. `MotionClassStats`
now carries `lostFrames` and `degradedFrames` per measured class, and each test reads the
frames it is actually about.

### A5. A geometry change is neither a tracking failure nor a fresh start

Not a criterion change — a defect the automated leg found, recorded here because the
behaviour it defines is what FLOW-005 measures.

§53's tier ladder steps and §H.0's rotation both change the frame geometry mid-run, and a
level-0 position from a 1280×720 frame means nothing in a 640×360 one. The tracker therefore
empties its population. The first implementation also cleared `everTracked`, which put §33's
state back to `READY` — "no frame pair has been tracked yet" — in the middle of a run that had
tracked thousands, and restarted the consecutive-failure counter with it.

Measured on the leg: a tier step landed inside a covered-lens segment, the counter restarted,
and a 14-frame occlusion never reached `LOST`. **FLOW-005 caught it**, and reported it as
"tracking was maintained through a covered lens", which is what it looked like from outside.

A geometry change is a discontinuity whose cause is known. It does not count toward `LOST`
and it does not report `READY`; the population is empty and the state says `DEGRADED` until
detection rebuilds it, which is exactly true. `geometryChanges` is now counted and carried
into the evidence, so a run whose population was rebuilt a dozen times reads as one.

### A6. Detection may not hand the tracker a point its window cannot cover

Also a defect rather than a criterion, and also found by measurement.

Detection runs at pyramid level 1 and keeps a 5 px margin in *that level's* pixels — 10 in
level-0 pixels. A 21×21 tracking window at level 0 needs 11. Points in that one-pixel band are
detected, admitted to the population, and then fail to track on the very next frame, through
no fault of the tracker.

Measured: 15 % of the population on a synthetic scene, and it made FLOW-001's survival read
**84.6 % on a perfectly static image the tracker had in fact followed exactly** — against the
90 % the criterion requires. The criterion is not the thing to move: a point the solver's
window cannot cover is not a trackable feature, and `FlowTracker.merge` now declines it. The
margin is read from the solver's own configuration, so a change to §12's window cannot leave
it stale.

---

## What the automated leg turned out to be able to decide

Phase 3's leg had to exclude the three tests that carry its meaning, because Chromium's fake
camera is a rolling gradient — neither a textured wall nor a blank one. Phase 4's conditions
are about **motion**, and motion is something a video file can contain exactly.

`scripts/run-e2e-phase4.mjs` therefore generates its own feed: a texture that holds still,
pans by 4 px per frame, sweeps at 22, and goes black. Four of §65's five conditions are present
in the pixels, measured from them by the same classifier the device uses, and judged by the
same suite. **FLOW-002's cross-check is armed by that feed**, through the real
`video → VideoFrame → worker → pyramid` path, which is the one place §H.7 records that unit
tests cannot reach.

Rule 004 is unaffected: the leg is `DESKTOP_DEV` and passes nothing. What it does is fail when
the tracker stops following the image.

Two things it still cannot decide, each excluded with its own reason printed:

- **FLOW-003.** Headless Chromium delivers no `devicemotion` events, so there is no second
  instrument and the test reports `PENDING` rather than being judged.
- **FLOW-006.** It gates on §H's 14 ms budget for the iPhone's tracking worker; the leg
  measures a shared CPU under SwiftShader. Its verdict is printed and a separately named
  90 ms configuration tripwire gates instead — the same distinction §H.4 draws, and the same
  one Phase 3's leg made for FEAT-005.

And one it cannot arm, which is worth stating because the number looks alarming:
**the overlay alignment probe**. The generated feed is periodic in x by construction — it has
to be, so the pan loops — and densely textured, so every transform lands on corner-like pixels
and all seven scores fall within a factor of 1.05 of each other. The probe names a winner
(`rot90`, `rot180`, whichever) with `best/random` at 1.03. That is noise, and reading it as a
finding would be the mistake FEAT-001's ratio taught in Phase 3. `run-e2e-phase3-alignment.mjs`
is the leg that decides orientation, with a fixture built so no rotation or reflection maps its
landmarks onto themselves; it scores identity at 70× random.

The probe itself was changed as a result, and the change protects the device rather than the
leg: `isMisoriented` now requires the winning transform to beat chance by the same margin
identity is required to. Without it, pointing the phone at a brick wall or a tiled floor could
abandon a working acquisition route.
