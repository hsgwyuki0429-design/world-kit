# Phase 7 — IMU Support / Fusion · test plan

Written before any Phase 7 code exists (§29). No criterion here may be relaxed after a result is
seen. A *narrowing* is allowed where a criterion turns out to measure the wrong thing, and must
be recorded in place with the measurement that forced it — as Phase 6's three amendments are.

**Governing sections: v3 §17, §18, §19 and §68.** v4 compresses them into a two-line §19, and
both lines are kept — one of them is a prohibition:

> Visual Poseを中心に、利用可能なMotion / Orientation情報を**補助として**利用する。
> **IMU単独で長時間の絶対位置を生成しない。**

And v3 §68 gives this phase's pass condition in one line, which is unusual among the per-phase
tables in being about *absence*:

> PASS条件：**IMU unavailableでもVision-only modeで継続可能。**

That inverts Phase 6's situation. There, the automated leg was short of an instrument and could
decide almost nothing. Here the leg — which has no IMU at all — is the natural place to decide
the spec's own stated condition, and the device decides everything else.

## Objective

Fuse the device's own motion sensing with the visual pose Phase 6 recovers, **as an auxiliary to
it and never as a replacement**, and refuse the parts of that which this platform cannot support.

v3 §18 names five EKF states — `position`, `velocity`, `orientation`, `gyroBias`, `accelBias`.
**Phase 7 estimates two of them.** That is the central decision in this phase and it is not a
convenience:

| state | Phase 7 | why |
| --- | --- | --- |
| `orientation` | **estimated** | observable from the gyroscope, the visual rotation and gravity, none of which need a scale |
| `gyroBias` | **estimated** | observable because vision and the gyroscope disagree consistently in one direction |
| `position` | **refused** | see below |
| `velocity` | **refused** | same reason |
| `accelBias` | **refused** | not observable without position observability |

**Why position is refused, and why that is a measurement rather than a preference.** The
accelerometer reports metres per second squared. Phase 6's translation is a unit direction in
`LOCAL_UNITS` with no scale, because v3 §15 and v4 §18 both forbid a monocular camera claiming
one. Fusing an acceleration with a scaleless direction requires the scale — which is precisely
the quantity that does not exist. It is not that position fusion is hard here; it is that the
two inputs are not in comparable units, and inventing the conversion factor is exactly the
fabrication Rule 001 lists.

v3 §17 says the same thing from the other side, twice: *Acceleration: 長時間の絶対位置推定には直接
使用しない* and *IMUだけを積分して絶対位置を生成してはならない*. **IMU-006 measures what would
happen if it were done anyway**, so the refusal carries a number rather than a citation.

## What this phase must not be allowed to fake

### 1. A "fusion" that is a pass-through

The easiest fake in this phase, and the most convincing. Set the fused orientation equal to the
visual orientation. It tracks the camera perfectly. It agrees with the gyroscope exactly as well
as Phase 6 did. Its innovations are zero by construction — *better* than a real filter's. It is
smooth, stable, and every statistic computed from its own output endorses it. And it has added
nothing at all: switch the IMU off and it behaves identically, which is the one thing that would
give it away and the one thing a run with the IMU on cannot see.

### 2. A "fusion" that is dead reckoning with a camera attached

The opposite fake. Propagate the gyroscope and apply the visual correction with a gain near
zero. Over a few seconds it looks excellent — a gyroscope is very good over a few seconds, which
is exactly what v3 §17 means by *Gyroscope: 短時間回転推定*. Over a minute it has drifted away
from the room and the drift is smooth, so nothing looks wrong on screen.

### 3. A position that arrives by implication

Not by writing "metres". By emitting a `position` field at all, in any unit, computed from
anything the accelerometer touched. Phase 9 triangulates, Phase 11 fits planes, Phase 19 drops a
ball — and each reads what the phase below it hands over. `POSITION: UNAVAILABLE` has to be a
value that a later phase must remove deliberately, not a field that happens to be absent.

### 4. A confidence that improves because a sensor was switched on

v3 §19 lists `IMU consistency` among the pose confidence inputs, and Phase 6 **withheld it on
purpose** because it was the instrument POSE-002 scored that phase with. Phase 7 adds it. The
risk is that adding an input raises the number: a fused pose must not be more confident than the
visual pose merely because a second sensor agreed with it — agreement is evidence, and
disagreement must be able to *lower* it.

---

## The instrument this phase is scored against

Phase 6's witness was the gyroscope. Phase 7 consumes the gyroscope, so it needs a different one,
and there is only one kind left: **ground truth the harness makes and does not disclose.**

### IMU-005 — an injected gyroscope bias

The harness adds a constant `GYRO_BIAS_INJECTION_DPS` to every gyroscope sample **before the
filter sees it**, and runs a second filter on the untouched samples at the same time. Neither
filter is told which it is.

A real filter estimates the bias, because vision disagrees with a biased gyroscope *consistently
in one direction* and that is what makes the bias observable at all. So:

| | injected filter | control filter |
| --- | --- | --- |
| a working fusion | `b_true + 3.0 °/s` | `b_true` |
| a pass-through | 0 | 0 |
| dead reckoning | 0, and its visual innovation grows without bound | 0 |

**The measurement is the difference between the two**, not either estimate alone. Both filters
see the same device, so the device's own unknown bias `b_true` cancels — which is necessary,
because `b_true` is exactly the quantity nobody here can look up. The control's estimate is
reported as well, because it *is* this phone's gyroscope bias and that is worth knowing.

This is decidable wherever the IMU exists, which is the device. On the automated leg there is no
gyroscope to bias, and IMU-005 reports `PENDING` with that reason.

### And what the leg decides instead

v3 §68's own pass condition — *IMU unavailableでもVision-only modeで継続可能* — is about the
case the leg is permanently in. **IMU-002 is therefore the one required test of this phase that
the automated leg can decide, and it decides it every build.** The unit tests carry the rest:
`tests/unit/fusion.test.ts` drives the real `FusionStage` over synthetic sensors, including the
injected bias and both fakes above.

---

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `GYRO_BIAS_INJECTION_DPS` | 3.0 | the smallest bias that visibly breaks Phase 6 — see below |
| `BIAS_TOLERANCE_DPS` | 1.0 | a third of the injection; also the scale of a real consumer bias |
| `MAX_PROPAGATION_MS` | 3000 | how long *短時間* is, derived — see below |
| `ROTATION_AGREEMENT_DEG` | 3.0 | **Phase 6's**, reused: the visual/inertial tolerance floor |
| `ROTATION_AGREEMENT_FRACTION` | 0.30 | ...and its proportional part |
| `GRAVITY_TOLERANCE_MS2` | 0.5 | how far ‖g‖ may sit from 9.81 before the sample is not a gravity reference |
| `MIN_JUDGED_FRAMES` | 15 | per condition, as Phases 3–6 used |
| `MIN_BIAS_SAMPLES` | 10 | as GEO-003 and POSE-005 used |
| `FUSION_BUDGET_MS` | 1.0 | §H allocates no line to fusion — see below |
| `MAX_IMU_ONLY_POSITION_M` | — | **no threshold: any value at all is a failure** (IMU-006) |

Four need their derivation stated.

**`GYRO_BIAS_INJECTION_DPS` = 3.0.** Phase 6's POSE-002 tolerates a visual/inertial disagreement
of `max(3.0°, 30 % of measured)`. The device's anchor intervals ran about a second, so a bias of
3 °/s accumulates 3° of orientation error per anchor — **exactly the smallest bias that would
have shown up as a Phase 6 failure.** Injecting less would be asking the filter to find something
that does not matter; injecting more would be making the test easy. It is also comfortably above
a real consumer MEMS bias, so the injected component is separable from the true one.

**`MAX_PROPAGATION_MS` = 3000, which is what "short-term" means here.** v3 §17 says the
gyroscope is for *短時間回転推定* without saying how short. Derive it from what breaks: with the
bias uncorrected at the ~1 °/s a consumer MEMS part drifts, the orientation error reaches Phase
6's 3° agreement floor after three seconds. So three seconds is the point at which propagated
orientation stops being as good as a visual measurement, and past it the fused pose is
`DEAD_RECKONING` with falling confidence rather than a pose.

**`GRAVITY_TOLERANCE_MS2` = 0.5.** The device reports `acceleration` and
`accelerationIncludingGravity` separately, so gravity is their difference and its magnitude
should be 9.81. The Phase 6 device bundle's first sample gives ‖a+g‖ = 10.3 m/s² while the phone
was being held — so the tolerance covers sensor noise and the small mismatch iOS's own gravity
separation leaves, and rejects samples taken during real acceleration, where the difference is
not a gravity direction at all.

**`FUSION_BUDGET_MS` = 1.0, and it is not a line from §H.** §H's table allocates every
millisecond it has — acquire 6, Shi-Tomasi 8 amortised, LK 14, forward/backward 4, RANSAC and
pose 6 — and names no line for fusion. So whatever Phase 7 costs comes out of margin that does
not exist on paper. An orientation error-state filter is a handful of 3×3 operations per sample;
anything approaching a millisecond at 60 Hz is an implementation error rather than a platform
fact, which is why this is advisory and gated separately.

---

## What Phase 7 measures, per fused frame

| Field | Meaning |
| --- | --- |
| `mode` | `VISION_ONLY` / `FUSED` / `DEAD_RECKONING` — a pure function of what arrived |
| `orientation` | the fused quaternion (§18: quaternion preferred; no Euler angles are produced) |
| `gyroBiasDps` | the estimated bias, per axis, and its magnitude |
| `position` | **always `null`**, with `positionReason` saying why |
| `scale` | `UNKNOWN` — carried from Phase 6's `LOCAL_UNITS` and made explicit |
| `innovationDeg` | the visual measurement minus the propagated prediction, before the update |
| `propagatedMs` | how long the filter has been running on the gyroscope alone |
| `gravityDeg` | disagreement between the filter's own gravity direction and the accelerometer's |
| `imuConsistency` | v3 §19's seventh term, which Phase 6 withheld |
| `confidence` | the fused pose's, which is **not** Phase 6's — see below |
| `sensors` | which of §17's six fields are actually arriving |

`mode` is derived in one place and re-derived by the session on every frame — the Rule 002 check
Phases 4, 5 and 6 all carry, and the one that caught Phase 6's impossible rate.

### Confidence is Phase 7's own number, not an edit to Phase 6's

Phase 6's `poseConfidence` is untouched. It describes the **visual** pose and it withholds v3
§19's `IMU consistency` term for a reason that is still true: POSE-002 scores Phase 6 against the
gyroscope, and a confidence that consumed it could not be checked against it. Phase 6 has passed
on the device with that arrangement and changing it now would be editing a passed phase.

Phase 7 computes a **separate** confidence for the *fused* pose, with all seven of v3 §19's
inputs. Both travel in the bundle. And v3 §19's prohibition applies to the new one as it did to
the old: 不確実なPoseは強制的に高confidenceにしない — the combination is the **minimum** over its
terms, so a disagreeing IMU can only lower it.

---

## Test records

### IMU-001 — Motion permission granted · REQUIRED

v3 §68. The sensors are available and the fusion is actually using them.

- **Input:** a run where `DeviceMotion` was granted and is delivering.
- **Expected:** all of §17's fields are present, and the filter's output differs from the visual
  pose in the way a filter's should.
- **Pass criteria:** all of —
  1. `rotationRate`, `acceleration` and `accelerationIncludingGravity` all arriving, at a
     measured rate the bundle records;
  2. ≥ 15 frames reported `FUSED`;
  3. the filter **propagated between visual updates** — `propagatedMs` is non-zero on frames
     between poses, so the gyroscope is doing work rather than being carried by vision;
  4. a non-zero gyroscope bias estimate, or a recorded reason why the run could not observe one.
- **Failure condition:** `FUSED` reported on a run where the fused orientation is identical to
  the visual orientation on every frame. That is a pass-through, and it is what "not fusing"
  looks like.

### IMU-002 — Motion permission denied · REQUIRED · **the leg decides this one**

v3 §68's own pass condition, verbatim: *IMU unavailableでもVision-only modeで継続可能*.

- **Input:** a run where `DeviceMotion` is absent, denied, or silent.
- **Expected:** the system continues on vision alone and says so.
- **Pass criteria:** all of —
  1. `mode` reports `VISION_ONLY` on every frame, never `FUSED`;
  2. the fused orientation equals the visual orientation exactly — no filter state is invented
     from sensors that are not reporting;
  3. `gyroBiasDps` is `null`, not zero. **An unmeasured quantity is absent, not zero** — a zero
     is a claim that the bias was estimated and found to be nothing;
  4. `imuConsistency` is withheld from the confidence rather than scored as good, and the
     confidence reports it as withheld by name;
  5. Phase 6's visual pose is unaffected: the same rotation figures it reported without Phase 7
     running at all.
- **Failure condition:** any fused state produced from absent sensors; or a run that stops.

### IMU-003 — Camera rotation · REQUIRED

v3 §68. The device turns, and the fused orientation follows it.

- **Input:** frames where the camera demonstrably rotated.
- **Pass criteria:** all of —
  1. ≥ 15 frames where the visual rotation and the propagated prediction could both be formed;
  2. the median `innovationDeg` within
     `max(ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION × measured)`;
  3. the innovation is **not identically zero** — a filter whose prediction always matches its
     measurement exactly is not predicting, it is copying;
  4. the fused orientation tracks the rotation over the run rather than the mean of it.
- **Failure condition:** an innovation of exactly zero throughout — the signature of fake 1.

### IMU-004 — Visual + IMU consistency · REQUIRED

v3 §68, and v3 §19's seventh confidence input.

- **Pass criteria:** all of —
  1. `imuConsistency` is present in the fused confidence terms, valued, and named;
  2. it is **able to fall**: the run records at least one frame where it is below 1, or reports
     that the two instruments never disagreed enough to lower it;
  3. the fused confidence is the minimum over its terms — never above its own worst one;
  4. gravity agrees: the median `gravityDeg` is within the tolerance, over ≥ 15 samples where
     ‖g‖ was within `GRAVITY_TOLERANCE_MS2` of 9.81, or the run reports that no such sample
     occurred.
- **Failure condition:** an `imuConsistency` term pinned at 1 whatever the sensors did; or a
  fused confidence above the visual confidence purely because a second sensor was present.

### IMU-005 — Injected gyroscope bias · REQUIRED · **the gate**

Not in v3's list. It is here because every other number in this phase is produced, and produced
*well*, by a fusion that ignores the IMU entirely.

- **Input:** on a sampled schedule, a second filter fed the same visual poses and gyroscope
  samples offset by a known `GYRO_BIAS_INJECTION_DPS`, handed over unmarked.
- **Expected:** the injected filter's bias estimate exceeds the control's by the injected amount.
- **Pass criteria:** all of —
  1. ≥ `MIN_BIAS_SAMPLES` frames where both filters had converged enough to report;
  2. `|b_injected − b_control|` within `BIAS_TOLERANCE_DPS` of `GYRO_BIAS_INJECTION_DPS`;
  3. the **direction** matches too — the difference lies along the injected axis, not merely
     the magnitude;
  4. the injected filter's median innovation stays inside the same tolerance IMU-003 applies,
     because a filter that estimated the bias correctly is not left disagreeing with vision.
- **Failure condition:** a difference near zero. **A pass-through and a dead-reckoner both score
  0.0 °/s here**, while satisfying every other numeric criterion in this phase.
- **Excluded if:** no gyroscope. Reported `PENDING` with that reason; the automated leg is
  always in this case.

> **Amendment, 2026-08-23 — recorded before the device leg ran, with the measurement that forced
> it.** The table above says a dead-reckoning fusion scores `0` in both columns. **That is
> wrong**, and the unit fixture found it: gravity is a two-degree-of-freedom measurement, but on
> a device that *turns*, the body axes move relative to it and over a minute all three body-frame
> bias components become observable through gravity alone. Driving `FusionStage` for 60 s with
> **no visual updates at all**, a true bias of (0.4, −0.9, 0.2) °/s and the 3 °/s injection on
> the *y* axis:
>
> | | control | injected | difference |
> | --- | --- | --- | --- |
> | measured, gravity only | (0.400, −0.900, 0.200) | (0.400, 2.100, 0.200) | **2.9996 °/s on *y*** |
>
> So criteria 1–3 are **not by themselves evidence that vision was fused**; a dead-reckoner with
> the accelerometer switched on satisfies all three. Two things follow, and neither relaxes
> anything:
>
> 1. **Criterion 4 is load-bearing, not a rounding-out.** It was already in this plan before the
>    measurement, and it is what separates fake 2: a filter applying the visual correction at a
>    gain near zero is left disagreeing with vision by a margin that grows without bound, which
>    is exactly what criterion 4 refuses.
> 2. **`biasDifferenceDps` is withheld until `MIN_BIAS_SAMPLES` *visual* updates have been
>    applied** — not because the estimate is poor without them, but because a number a
>    dead-reckoner can produce cannot be the gate on a fusion. A run with no vision therefore
>    reports `PENDING` here rather than a difference, and cannot pass this record at all.
>
> The criteria themselves are unchanged. What changed is the reasoning printed beside them, which
> claimed a separation that the fixture showed does not hold on its own.

### IMU-006 — No absolute position from the IMU · REQUIRED

v3 §17's two prohibitions, and v4 §19's one, made measurable rather than cited.

- **Pass criteria:** all of —
  1. **no record in the bundle carries a position, in any unit, from any source.** `position` is
     `null` and `positionReason` states the unit mismatch;
  2. `scale` reads `UNKNOWN` throughout;
  3. `accelBias` and `velocity` are absent for the same reason and say so, rather than being
     reported as zero;
  4. and the phase **measures what it declined to do**: the accelerometer is double-integrated
     over the run *for the record only*, never fed to the pose, and the resulting drift is
     reported. A refusal with a number behind it is a finding; a refusal with a citation behind
     it is an assertion.
- **Failure condition:** any position field with a value. There is no tolerance on this one.

### IMU-007 — Vision dropout · REQUIRED

v3 §17's *IMUはVisionの代替ではない*, tested from the side that matters.

- **Input:** intervals where the visual pose stops arriving — Phase 5 declining frames, the
  camera covered, or the tracker losing its population.
- **Pass criteria:** all of —
  1. ≥ 15 frames of propagation without a visual update occurred, or the run reports that they
     never did;
  2. the fused orientation **continues** through them — this is what the IMU is for;
  3. `mode` becomes `DEAD_RECKONING` and the fused confidence **falls monotonically** with
     `propagatedMs`;
  4. past `MAX_PROPAGATION_MS` the pose is no longer offered as usable;
  5. when vision returns, the filter reconverges — the innovation on the first corrected frame
     is recorded, and the run does not simply snap without noting the jump.
- **Failure condition:** a confidence that does not fall while running open-loop; or a fused
  pose still offered as usable after three seconds without a measurement.

### IMU-008 — Fusion cost · ADVISORY

- **Pass criteria:** mean fusion cost ≤ `FUSION_BUDGET_MS` over ≥ 10 frames, with the sensor
  rate recorded beside it.
- **Failure condition:** over budget. Advisory because §34 ranks correctness above performance
  and because §H.4 records that a device budget cannot be adjudicated off the device — but note
  that §H has no line for this at all, so any cost here is spent from margin.

### IMU-009 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. every record carries `SCALE: UNKNOWN` and a `null` position;
  2. `gyroBiasDps` is `null` where no gyroscope reported, never zero;
  3. orientation is carried as a quaternion; **no Euler angle triple is emitted anywhere** (§18);
  4. `mode` never disagrees with the inputs it was derived from;
  5. the fused confidence is never above its lowest measured term;
  6. every rate reported is in `0..1` — Phase 6's device run reported `232.3 % agreeing`, and
     this is the check that a rate is a rate, applied to every rate this phase emits.
- **Failure condition:** any of the above unmet.

---

## What a pass requires, in full

IMU-001 through IMU-007 PASS on a `REAL_DEVICE` bundle. IMU-002 is decidable on the automated
leg and is decided there every build; the rest need the sensors, so the leg reaches `TESTING` at
best — Rule 004, again as a measurement rather than as a policy.

The number that carries the phase is **IMU-005 criterion 2**: the estimated gyroscope bias must
move by the amount the harness added to the samples, where the harness added it without telling
anyone. Every other number in this plan is produced by a fusion that ignores the IMU and returns
the visual pose unchanged — which is what "not fusing" looks like, and which would otherwise
pass this phase looking better than a real filter on every statistic it reports about itself.

## What this phase does not do, and says so

- **No position, no velocity, no scale.** The reason is a unit mismatch, not a preference, and
  IMU-006 measures the drift that refusing it avoids.
- **No magnetometer.** The device reports `absolute: false` with `webkitCompassHeading` present,
  so a heading is available but is not a rotation this phase can check against anything. Yaw is
  observable from vision; gravity fixes roll and pitch. Adding an unvalidated heading would add
  an input no test in this plan could score.
- **No change to Phase 6.** Its confidence still withholds `IMU consistency`, its POSE-002 still
  scores it against the gyroscope, and its committed device evidence still means what it said.
- **§33's `GOOD` stays unreachable**, for the third phase running and for the same reason: the
  tracking state is computed in `FlowStage` from what Phase 4 measures, and plumbing a later
  phase's quantity into a passed phase's state machine is a change to Phase 4. Deferred to the
  phase where a single fused pose is the thing the tracking state is *about*.
