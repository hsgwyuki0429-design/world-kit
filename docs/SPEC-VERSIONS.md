# Spec versions, and the numbers v4.0 stopped stating

The project was built to `Safari Spatial Mapping Prototype v3.0`. On 2026-08-22, after Phase 4
passed on the device, the spec was replaced by `Safari Spatial Game — Version 4.0`.

## The rule

Stated by the spec's author on 2026-08-22, and it settles every question this file was written
to raise:

> **基本的なことはバージョン3に則って、方針だけ変えたい。**
> — follow v3 for the fundamentals; v4 changes the direction only.

So the division is explicit rather than inferred:

| | Authority |
| --- | --- |
| **Technical detail** — thresholds, algorithms, parameters, state conditions, test identifiers | **v3.0** |
| **Direction** — what the product is for, the phase roadmap, what counts as done | **v4.0** |

v4's silences are therefore not withdrawals. Where v4 says less than v3 about *how* something
works, v3 still governs and the code cites "v3 §N". Where v4 sets a new destination — a ball
game generated from observed surfaces rather than a reusable Spatial World — v4 governs.

The rest of this file is the inventory: every number v3 fixed that v4 does not restate, so none
of them can be lost by the document getting shorter. §29 requires a phase's thresholds to be
written down before its code and not relaxed after a result is seen, and a threshold that
vanishes when the document is rewritten is a threshold relaxed by omission.

---

## What changed, and why it matters

v3's goal was a reusable Spatial World; the game layer was the thing that proved it.
**v4 inverts that**: the Spatial World is now an internal substrate, and the deliverable is a
ball game generated from the surfaces actually observed in the room.

> 「部屋をスキャンすること」自体は目的ではなく、「その部屋で遊べるゲームを生成すること」が目的である。
> — v4 §14

Consequences that reach the code:

- **§41 removes the 3D export requirement.** OBJ / GLB / USDZ are out of Prototype v1. What is
  saved is what a game needs to resume (v4 §42).
- **§16 redefines the Spatial World** as "the set of observed spatial information the game
  needs", not a complete 3D reconstruction. 観測できない形状を推測して完全なGeometryとして扱わない。
- **§45's prohibitions grew** two entries that are about the game rather than the map:
  *goal placed using nonexistent geometry*, and *game success based on data unrelated to
  observed space*. Both are Phase 17–20's to enforce, and both are the same idea as §80's fake
  data one layer up.
- **§44 Fail Closed** now names game-level degradations: `TRACKING LOST → pause or rescan`,
  `SURFACE UNKNOWN → do not use for collision`, `GOAL INVALID → regenerate`,
  `POSE LOW CONFIDENCE → do not commit new stage state`.

### The phase list

22 phases rather than 20. **Phases 0–4 are untouched** — the ones already passed on a device,
so no committed bundle names a phase that no longer exists. `PHASE_NAMES` carries the v4 list
and `tests/unit/phaseRegistry.test.ts` pins it.

| Index | v3.0 | v4.0 |
| --- | --- | --- |
| 11 | Plane Detection | Surface Understanding |
| 13 | World Viewer | Spatial Game Viewer |
| 14 | Save / Load | Save / Resume |
| 15 | Collision Geometry | Spatial Collision |
| 17 | Golden Test | **Stage Generator** |
| 18 | Performance / Stress | **Goal Ring System** |
| 19 | Final Audit | **Ball Physics** |
| 20 | — | **Gameplay Validation** |
| 21 | — | Final Audit |

Performance / Stress is no longer a phase of its own; v4 §43 states it as an architectural
requirement instead. The golden test became v4 §52's **Golden Gameplay Test**, which runs the
whole chain from capability check to a ball entering a generated ring.

---

## Numbers v3 fixed that v4 does not restate

**These are still in force.** Each was fixed before the thing it governs was measured, which is
exactly the property §29 asks for; re-deriving them now, with Phase 4's data in hand, would be
choosing thresholds against known results.

### v3 §14 — Phase 5, Geometric Verification

v4 §17 says only: *Outlierが十分除外され、Pose計算へ利用可能なInlierが安定して得られること*. No
numbers at all. v3 gave four:

| Threshold | v3 §14 |
| --- | --- |
| Minimum inliers | **30** |
| GOOD candidate | **> 100** |
| Usable inlier ratio | **> 0.35** |
| GOOD inlier ratio | **> 0.50** |

Phase 4's device run makes the first of these the live question rather than a formality: it
delivered a **median of 41 tracked correspondences** in a dim room. 30 inliers out of 41
correspondences is a demanding bar, and >100 is unreachable there. Phase 5 measures the
correspondence count it actually receives and reports when the scene cannot supply what the
threshold needs — it does not lower the threshold, and it does not verify a pose on a handful
of points and call it good. §H.8 records the measurement.

### v3 §33 — Tracking State

v4 §25 lists "Tracking State" as a field of the Spatial World runtime state and does not
enumerate the states or their conditions. v3 §33 did:

| | v3 §33 |
| --- | --- |
| States | `READY`, `TRACKING`, `GOOD`, `DEGRADED`, `LOST`, `RELOCALIZING` |
| GOOD candidate | features ≥ 300 **AND** inlierRatio ≥ 0.50 **AND** reprojectionError ≤ 2.0 px |
| LOST | inliers < 20, or consecutive pose-estimation failures |
| | 1 Frame失敗だけでLOSTにしない — 初期: 3 consecutive failed frames → LOST |

`src/tracking/trackingState.ts` implements these and cites §33 throughout. Those citations mean
**v3 §33**. Phase 4 already passed against them on the device, so dropping a conjunct because
the newer document is quieter would be relaxing a criterion after a result — the thing §29
exists to prevent.

Note that v4 §25 does add a requirement in the same area: 低Confidenceの情報は、ゲーム生成や
Collisionで重要度を下げるか使用禁止にする. That is Phase 11 onward, and it is consistent with
§33 rather than a replacement for it.

### v3 §15, §16, §17, §18, §19 — pose, planar scenes, IMU, EKF, pose confidence

v4 compresses all five into three short sections (§18, §19). What v3 stated and v4 does not:

- **§15** the intrinsics matrix K and its form, and `INTRINSICS: ESTIMATED` when it cannot be
  obtained accurately. v4 §18 keeps only the LOCAL UNITS rule.
- **§16 Planar Scene Handling** — evaluate both Essential matrix and Homography, and where the
  Homography wins, mark `PLANAR SCENE` and lower translation confidence. **Absent from v4
  entirely.** It is not optional: a room scan is largely planar, and using an Essential matrix
  on a planar scene produces a degenerate pose that looks fine. Phase 6 implements it.
- **§17 IMU Usage** — *Gyroscope: 短時間回転推定*, *Acceleration: 長時間の絶対位置推定には直接
  使用しない*, *IMUだけを積分して絶対位置を生成してはならない*, and *IMUはVisionの代替ではない*.
  v4 §19 keeps the second prohibition in one line and drops the rest. Phase 7 implements all
  four, and **measures the one it refuses**: the accelerometer is double-integrated over the run
  for the record only, so the refusal carries a number rather than a citation (IMU-006).
- **§18 EKF** — the fused state (position, velocity, orientation, gyroBias, accelBias) and
  "Quaternion優先, Euler角だけで長時間Pose管理しない". **Phase 7 estimates two of the five** —
  `orientation` and `gyroBias` — and refuses `position`, `velocity` and `accelBias`, because the
  accelerometer reports m/s² and Phase 6's translation is a unit direction in `LOCAL_UNITS`: the
  two are not in comparable units and the conversion factor does not exist. The quaternion
  preference is met by there being **no Euler conversion in the codebase at all**, so nothing
  could emit a triple by accident.
- **§19 Pose Confidence** — **seven** candidate inputs, quoted here because Phase 6 implements
  six of them and has to be able to say which one it left out: `inlier ratio`,
  `reprojection error`, `tracked feature count`, `feature distribution`, `IMU consistency`,
  `temporal stability`, `model consistency`. Plus the prohibition 不確実なPoseは強制的に高
  confidenceにしない. (An earlier revision of this file said "eight"; v3 §19 lists seven.)
  Phase 6 withholds `IMU consistency` on purpose — it is the instrument POSE-002 scores the
  phase with, and a confidence that consumed it could not then be checked against it.
  **Phase 7 adds the seventh, to a second number.** Phase 6's confidence is untouched — editing
  a passed phase is not a fix — so the fused pose gets its own confidence with all seven inputs,
  and both travel in the bundle. The prohibition applies to the new one as it did to the old:
  the combination is the minimum over its terms, and since the fused terms are a superset of the
  visual ones, attaching a sensor can only ever lower the number.

### v3 §20 — Keyframe conditions

v4 §20 says keyframes should be kept and updated, without conditions. v3 gave them:
rotation ≥ 10°, **or** relative translation ≥ 0.10 local unit, **or** median feature
displacement ≥ 30 px, **or** a significant change in tracking quality; minimum interval 0.5 s,
maximum 5 s.

### v3 §20's keyframe conditions, as Phase 8 implemented them

Listed above; what Phase 8 measured is that **one of the four cannot be evaluated at all**.
*Relative translation ≥ 0.10 local unit* is a magnitude, and Phase 6 recovers a unit direction with
`SCALE: LOCAL_UNITS`. It is carried in every decision record as `UNMEASURED` with the missing scale
named — the shape Phase 7 established for `POSITION: UNAVAILABLE` — and v3 §20's own third
condition, the median displacement of the features two views share, is what fires in its place.
The refusal carries a number: the angle the translation *direction* moved, which is measurable.

*A significant change in tracking quality* has no number in v3 either. Phase 8 fixed 0.15, which is
the width of v3 §14's own usable→GOOD band: a change that size moves the frame from one of the
spec's quality classes to the other.

### v4 §21 and §22 — Phases 9 and 10, where v3 stated nothing at all

v3's roadmap named Triangulation and Landmark Map; it fixed no thresholds for either. Everything
those phases turn on is therefore derived from numbers this project already had, and each
derivation is recorded in the phase's test plan:

- **`MIN_PARALLAX_DEG` = 1.0** from `σ_Z/Z ≈ σ_θ/θ`, with `σ_θ` being §13's 1.5 px over the assumed
  focal length and a target of a depth good to a tenth of itself.
- **`MAX_TRIANGULATION_REPROJECTION_PX` and `MAX_LANDMARK_REPROJECTION_PX` = 2.0** are **v3 §33's**
  GOOD condition, reused rather than re-derived.
- **`MAX_DISAGREEMENT_PX` = 4.0** is twice that, because the gate compares two estimates that each
  carry their own error — §13's two-band shape, reused.
- **`MAX_REGISTRATION_RESIDUAL` = 0.05** is half Phase 9's depth-uncertainty limit.
- **`MAX_KEYFRAMES` = 30** and **`MAX_LANDMARKS` = 5000** are §56's and §H.1's, fixed before Phase 0.
- **`INJECTION_RECALL_FLOOR` = 0.90** is **GEO-003's**, reused. Its companion was not: an absolute
  false-cull ceiling measured how quiet the scene was, so MAP-005 judges the *excess* over what the
  same gate refuses on the uncorrupted batch.

### v3 §68 — Phase 7's pass condition

v4 §19 gives Phase 7 two lines and no pass condition. v3 §68 gives one, and it is unusual among
the per-phase tables in being about **absence**:

> PASS条件：**IMU unavailableでもVision-only modeで継続可能。**

That inverts every leg before it. Headless Chromium has no accelerometer and no gyroscope, so the
automated leg is permanently in the case the spec asks the phase to handle — and IMU-002 is
therefore the first required test in this project that the automated leg decides, on every
commit. Rule 004 still holds: `DESKTOP_DEV` cannot pass a phase, and the device decides the other
seven records.

### v3 §65, §66… — the per-phase test tables

v3 named the tests for every phase (`CAM-001`, `FRAME-001`, `FEAT-001`, `FLOW-001`, `GEO-001`…).
v4 keeps only short `テスト：` lines for Phases 17–19 and the Golden Gameplay Test.

The four phases already passed keep their v3 test IDs, because the committed evidence names
them. Phase 5 onward keeps the same convention for the same reason: an evidence bundle has to
name the test that produced its verdict, and a phase whose tests have no identifiers cannot do
that.

---

## Where the two would conflict

Nowhere, so far — and the rule above means a conflict would be resolved by *kind* rather than
by date: a disagreement about a threshold or an algorithm goes to v3, a disagreement about what
the product is trying to be goes to v4. Anything that cannot be sorted into one of those two is
a question for the spec's author, and this file records it as an open question rather than
picking a side. v4 §11, §12 and §13 — Phase 3's feature parameters, Phase
4's Lucas-Kanade parameters and the forward/backward bands — are **identical to v3's**, which is
why Phases 3 and 4 needed no change when the spec version moved.
