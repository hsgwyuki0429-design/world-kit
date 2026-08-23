# Phase 7 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase7-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) — but see below, it decides a required record |
| `phase7-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

**No real-device bundle yet.** `docs/phase7/HOW-TO-RUN-DEVICE-TEST.md` is the run that produces
one, and Rule 004 means nothing here passes the phase until it exists.

## This is the first leg in the project that decides a required test

Every automated leg before it was short of the instrument its phase was scored against, and said
so: Phase 4's had no gyroscope for FLOW-003, Phase 5's could decide GEO-003 but nothing about a
real scene, Phase 6's could not decide POSE-002 at all.

Phase 7 inverts that, because v3 §68's pass condition for this phase is unusual among the
per-phase tables in being about **absence**:

> PASS条件：**IMU unavailableでもVision-only modeで継続可能。**

Headless Chromium has no accelerometer and no gyroscope. That is not the leg's limitation — it is
the condition the spec asks the phase to handle, and it is permanently the case here. So
**IMU-002 is decided on every commit**, on the real screen, through the real control, alongside
IMU-006 and IMU-009 which need no sensor either.

Rule 004 is untouched: this is `DESKTOP_DEV` and it cannot pass the phase. What it gives is three
required-or-advisory records checked continuously rather than once, by hand, on a phone.

## What the leg measured

```
418 fused frames, modes {"VISION_ONLY": 418} over a 30 s hold
IMU not available — listening for devicemotion; no event with rotationRate has arrived yet
bias null (absent, not zero); imuConsistency WITHHELD; 1 term withheld by name
position null, scale UNKNOWN, heading RELATIVE
0 records with a position, 0 scale violations, 0 Euler triples
0 mode mismatches, 0 rates outside 0..1, 0 confidences above their own worst term
Phase 6 underneath: 1 → 359 pose frames while the fusion ran on top of it
mean fusion cost 0.019 ms over 400 frames
```

Verdicts: `IMU-002 PASS`, `IMU-006 PASS`, `IMU-008 PASS` (advisory), `IMU-009 PASS`;
`IMU-001, 003, 004, 005, 007 PENDING` with the sensor named. Phase verdict `TESTING`.

### One finding worth reading off the sensor list

```
acceleration ABSENT, accelerationIncludingGravity ABSENT, rotationRate ABSENT,
interval ARRIVING, deviceorientation ABSENT, magnetometer ABSENT
```

Headless Chromium **fires `devicemotion` events with a valid `interval` and every vector `null`.**
That is exactly what a half-granted permission looks like on some builds, and it is why the
sensor inventory records a channel as arriving only when it has delivered a finite *three-vector*
rather than when the event fired. A run that had counted events would have called this an IMU.

It is also why an absent channel is carried as an **empty array** rather than as zeros: a phone
lying on a table reports a real `[0, 0, 0]` rotation rate, and collapsing the two would make a
stationary phone indistinguishable from a phone with no gyroscope.

## What the leg cannot decide, and why each one specifically

| Record | Why |
| --- | --- |
| `IMU-001` | it is about what the fusion does with the sensors, and there are none |
| `IMU-003` | the innovation needs a gyroscope to predict with |
| `IMU-004` | v3 §19's seventh term needs something to be consistent *with* |
| `IMU-005` | the gate injects a bias into a gyroscope; there is no gyroscope to inject into |
| `IMU-007` | dead reckoning needs something to reckon with |
| `IMU-008` | it gates on a 1 ms ceiling on the device; this is a shared CPU with no sensors |

Each is excluded by name rather than swept up together, so a future build that acquires a sensor
loses the exclusion for that record alone.

## The gate this leg cannot arm

IMU-005 is Phase 7's anti-fake measurement, and it is the one number in the phase a fusion that
returns the visual pose unchanged cannot produce — such a fusion tracks the camera perfectly,
reports an innovation of exactly zero, and never invents a position. It needs a real gyroscope,
so it is the device's to decide.

**The unit fixture arms it instead**, on synthetic sensors, in `tests/unit/fusion.test.ts`: the
real `FusionStage` recovers a 3 °/s injection it was never told about, and a hand-written
pass-through driven through the same `runPhase7Tests` **fails** IMU-005, IMU-001 and IMU-003
while passing IMU-004, IMU-006 and IMU-008. That is the claim the plan makes, executed rather
than asserted.

That fixture also produced the measurement that corrected the test plan: **gravity alone, on a
device that turns, observes all three gyroscope bias components.** With no visual updates at all,
a true bias of (0.4, −0.9, 0.2) °/s came back as (0.400, −0.900, 0.200) and the injected twin's
difference as 2.9996 °/s along the injected axis. The plan's table had said a dead-reckoner
scores 0 there. The criteria did not change; the amendment is recorded in place in
`docs/phase7/TEST-PLAN.md`, and it names what actually separates a dead-reckoner: criterion 4,
and the gate withholding the bias difference until visual updates have been applied.
