# Phase 6 — Relative Pose · test plan

Written before any Phase 6 code exists (§29). No criterion in this document may be relaxed
after a result is seen. A *narrowing* is allowed where a criterion turns out to measure the
wrong thing, and must be recorded in place, with the measurement that forced it — as Phase 5's
`PLANAR_H_SHARE` amendment is.

**Governing sections: v3 §15, §16, §19 and §67**, which v4 compresses into a two-line §18. v4's
two lines are kept in full — they are the part v4 chose to restate, and one of them is a
prohibition:

> Cameraの相対的な移動と回転を推定する。ゲーム空間の基準座標を保つために利用する。
> **Absolute scaleを保証できない場合はLOCAL UNITSとして扱い、無条件に1 unit = 1 meterと仮定しない。**

Everything numeric comes from v3. See [`../SPEC-VERSIONS.md`](../SPEC-VERSIONS.md).

## Objective

Recover the camera's rotation and translation *direction* between the verification anchor and
the current frame, from the correspondences Phase 5 verified.

Three things this phase produces that no earlier phase could, and one it must not:

- **A rotation.** The first quantity in this project with a physical unit that an independent
  instrument can also measure. That is what makes Phase 6 checkable.
- **A translation direction.** Direction only. Never a distance.
- **A reprojection error**, from the triangulation the cheirality test needs — the term §33's
  `GOOD` has been missing since Phase 4 named it.
- **Never a scale.** v3 §15 and v4 §18 both say it: a monocular camera has none. `LOCAL UNITS`,
  `‖t‖ = 1`, and no phase downstream may read that 1 as a metre.

## What this phase must not be allowed to fake

### 1. A pose that is plausible and unrelated to the motion

v3 §67's pass condition for this phase is one line, and it is the anti-fake condition stated by
the spec itself:

> PASS条件：**Poseが計算結果により変化。**

A stage that returns identity rotation and a fixed translation direction satisfies almost
everything else this phase could measure. It has a valid rotation matrix. Its translation is a
unit vector. It is perfectly temporally stable — *more* stable than a working implementation.
Its reprojection error can be made small by triangulating under its own pose. On a phone panned
slowly across a room it looks entirely reasonable, and every summary statistic computed from its
own output agrees with it.

So this phase needs ground truth from outside itself, twice, and neither is optional.

### 2. A pose recovered from a degenerate configuration

Two configurations give a wrong pose that looks right, and both are ordinary in a room:

- **A planar scene.** An Essential matrix decomposed from a plane is degenerate. Phase 5 already
  identifies these frames (v3 §16, `PLANAR_H_SHARE`); Phase 6 has to *act* on it rather than
  note it.
- **A pure rotation.** Turning the phone on the spot produces large, well-conditioned image
  motion and no translation at all. The correspondences pass every test Phase 5 applies —
  baseline, inlier count, spread — and the translation direction recovered from them is noise
  presented as a direction. This is the failure v4 §18's LOCAL UNITS rule cannot catch, because
  the problem is not the scale of the translation but that there is no translation.

### 3. A scale that arrives by implication

`‖t‖ = 1` is a normalisation, not a measurement. The risk is not that Phase 6 writes
"1 metre" — it is that Phase 9 triangulates in those units, Phase 11 fits planes to those
points, and Phase 19's ball falls at 9.8 of *something*. Every record this phase emits carries
`LOCAL_UNITS` explicitly so that a later phase has to remove it deliberately.

---

## The two instruments this phase is scored against

Neither shares code or data with the pose solver. This is §H.7's rule — a statistic computed
from one side of a comparison cannot verify the comparison — applied to a quantity that finally
has a physical unit.

### The gyroscope (POSE-002) — physics, on the device

`rotationRate` integrated over the anchor interval is an independent measurement of how far the
camera turned. The pose solver never sees it.

**It is used only to score, never as an input.** IMU fusion is Phase 7's, and v3 §19 lists
`IMU consistency` among the candidate inputs to pose confidence — *this phase deliberately does
not use it*, because a confidence that consumed the gyroscope could not then be checked against
it. That exclusion is recorded here so it reads as a decision rather than an omission.

Headless Chromium has no gyroscope, so POSE-002 reports `PENDING` with that reason on the
automated leg, exactly as FLOW-003 does. **This is the test that makes the device the only place
Phase 6 can pass**, which is Rule 004 restated as a measurement.

### An injected rotation (POSE-005) — ground truth, everywhere

The harness takes the verified correspondence set and applies a known camera rotation `R_j` to
the second view, in image space:

```
b'ᵢ = π( K R_j K⁻¹ b̃ᵢ )
```

That transformation is *exactly* what would have been observed had the camera additionally
rotated by `R_j`: if `b = π(K(RX + t))` then `π(K R_j K⁻¹ b̃) = π(K(R_j R X + R_j t))`. The whole
chain — model fit, decomposition, cheirality — is re-run on the modified set, which is handed
over with no marking. The recovered rotation must differ from the original by `R_j`.

A stage returning a constant pose reports a difference of **0°**. A stage returning noise reports
a large difference on the *control* as well, which is why the control is half of the
measurement:

| | injected set | control set |
| --- | --- | --- |
| a working solver | ≈ `INJECTED_ROTATION_DEG` | ≈ 0° |
| a constant pose | 0° | 0° |
| noise | large | large |

Two invariants come free and are checked: an image-space rotation is a bijection that preserves
incidence, so the injected set must keep **the same inlier count** and **the same planar flag**.
If injecting a rotation changes either, the fit is responding to something other than the
geometry.

---

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `MIN_INLIERS` | 30 | **v3 §14**, reused — a pose needs a verified set, not a new floor |
| `MAX_REPROJECTION_PX` | 2.0 | **v3 §33**'s GOOD condition, reused |
| `NOMINAL_FOV_DEG` | 67.0 | the assumed long-edge field of view — see below |
| `INTRINSICS_SENSITIVITY` | 0.20 | `fx` perturbed ±20 % so what depends on the guess is visible |
| `CHEIRALITY_MARGIN` | 1.5 | the winning `(R,t)` must beat the runner-up by this, or the decomposition is reported ambiguous |
| `MIN_CHEIRALITY_FRACTION` | 0.70 | ...and must place this fraction of inliers in front of both cameras |
| `PURE_ROTATION_PARALLAX_PX` | 1.5 | = `RANSAC_THRESHOLD_PX` — see below |
| `ROTATION_AGREEMENT_DEG` | 3.0 | the gyroscope cross-check's tolerance floor |
| `ROTATION_AGREEMENT_FRACTION` | 0.30 | ...and its proportional part |
| `INJECTED_ROTATION_DEG` | 8.0 | POSE-005's ground truth |
| `INJECTION_TOLERANCE_DEG` | 2.0 | how close the recovered difference must come to it |
| `MAX_CONTROL_ROTATION_DEG` | 1.5 | ...while an uninjected control stays this near zero |
| `POSE_PIPELINE_BUDGET_MS` | 6.0 | **§H**'s "RANSAC (E/H) + pose recovery" line, verbatim |
| `MIN_JUDGED_FRAMES` | 15 | per condition, as Phases 3–5 used |
| `MIN_INJECTION_SAMPLES` | 10 | as GEO-003 used |

Four need their derivation stated.

**`NOMINAL_FOV_DEG` = 67.0, and `INTRINSICS: ESTIMATED`.** v3 §15 gives K's form and says
plainly what to do when it cannot be obtained accurately. It cannot: Safari exposes no focal
length. The device's own track reports `label: 背面デュアル広角カメラ`, `720×1280`,
`aspectRatio 0.563` and nothing about optics. So `f = 0.5 · max(w,h) / tan(FOV/2)`, `cx,cy` at
the image centre, square pixels — and the record carries `INTRINSICS: ESTIMATED` on every frame,
never a bare K. 67° is the long-edge field of view of an iPhone rear wide camera in video mode;
it is a **stated assumption, not a measurement**, and §H.0 applies: a rotation swaps `w` and `h`,
so K is recomputed per frame rather than read once.

**`INTRINSICS_SENSITIVITY` = 0.20 is the honest half of that.** An assumption whose consequences
are unmeasured is a guess with a number attached. Every judged frame recomputes the pose with
`f` scaled by 0.8 and 1.2 and reports how far the rotation and the translation direction move.
That says which of this phase's outputs actually depend on the guess — and the expectation, to be
confirmed on the device rather than asserted here, is that rotation barely moves and translation
direction does.

**`PURE_ROTATION_PARALLAX_PX` = `RANSAC_THRESHOLD_PX` = 1.5.** A homography decomposes into
`R + t nᵀ/d`, giving translation in units of the plane's distance. The parallax that translation
induces is about `f · ‖t‖/d` pixels. When that is below the positional noise §13 already
quantifies — 1.5 px, the acceptable forward/backward band — the translation is not distinguishable
from zero, and the honest output is `TRANSLATION: UNDETERMINED` rather than a unit vector.
§H.6's rule again: prefer a constant the project has already fixed.

**`CHEIRALITY_MARGIN` = 1.5.** Decomposing E gives four candidates — `(R₁,t)`, `(R₁,−t)`,
`(R₂,t)`, `(R₂,−t)` — of which exactly one places the points in front of both cameras. The
textbook structure is that the correct candidate takes nearly all the points, two take roughly
half, and one takes almost none. 1.5× separates "nearly all" from "roughly half" without
requiring the clean-data ideal. Below it the decomposition is **reported ambiguous**, not
resolved by picking the maximum. All four counts are recorded, so the choice is auditable —
the same reason Phase 5 records both models' inlier counts.

---

## What Phase 6 measures, per judged frame

| Field | Meaning |
| --- | --- |
| `state` | `NO_POSE` / `ROTATION_ONLY` / `POSE` — see below |
| `source` | `ESSENTIAL` / `HOMOGRAPHY`, following Phase 5's selected model |
| `rotationDeg`, `axis`, `quaternion` | the recovered rotation (§18: quaternion preferred) |
| `translation` | unit direction, or `null` when undetermined |
| `scale` | always `LOCAL_UNITS` |
| `intrinsics` | `fx, fy, cx, cy, width, height` + `ESTIMATED` + the assumed FOV |
| `cheirality` | all four (or eight) candidate counts, and the chosen one |
| `ambiguous` | the margin did not separate the candidates |
| `reprojectionErrorPx` | RMS over the triangulated inliers, under the chosen pose |
| `pointsInFront` | how many inliers triangulated to positive depth in both views |
| `confidence` | v3 §19, from six of its seven inputs — see below |
| `confidenceInputs` | each term, named and valued, so the number is auditable |
| `sensitivity` | how far R and t move when `f` is scaled ±20 % |
| `planar` | carried from Phase 5, and what lowered translation confidence |
| `poseMs` | this phase's own cost; the bundle also reports it summed with Phase 5's |

`state` is a pure function of the measurements, computed in one place, and re-derived by the
session on every frame — the Rule 002 check Phases 4 and 5 both carry:

- **`NO_POSE`** — Phase 5 did not verify the frame, or fewer than `MIN_INLIERS` survived, or no
  candidate cleared `MIN_CHEIRALITY_FRACTION`.
- **`ROTATION_ONLY`** — a rotation was recovered but the parallax is under
  `PURE_ROTATION_PARALLAX_PX`. `translation` is `null` and the reason says so.
- **`POSE`** — both recovered.

### Pose confidence (v3 §19)

v3 lists seven candidate inputs. Six are used: `inlier ratio`, `reprojection error`,
`tracked feature count`, `feature distribution`, `temporal stability`, `model consistency`.

**`IMU consistency` is deliberately not used**, and its absence is reported alongside the six
that are. It is the instrument POSE-002 scores this phase with; feeding it into the phase's own
confidence would leave the phase grading its own homework (§H.7). Phase 7 is where the IMU
becomes an input rather than a witness.

v3's closing line on confidence is a prohibition and is implemented as one: 不確実なPoseは強制的に
高confidenceにしない. Confidence is the **minimum** over its terms, not an average — an average
lets five good terms carry one bad one, which is exactly how an uncertain pose acquires a high
confidence.

---

## Test records

### POSE-001 — Translation · REQUIRED

v3 §67. The camera translates through a scene with depth in it.

- **Input:** judged frames whose scene is non-planar, so the Essential matrix is the model.
- **Expected:** a translation direction is recovered, the rotation is small, and the recovered
  direction is *not constant* across the run.
- **Pass criteria:** all of —
  1. ≥ 15 judged frames reached `POSE`;
  2. the chosen candidate placed ≥ `MIN_CHEIRALITY_FRACTION` of inliers in front of both
     cameras, and beat the runner-up by ≥ `CHEIRALITY_MARGIN`;
  3. median reprojection error ≤ `MAX_REPROJECTION_PX`;
  4. no frame reported `POSE` while carrying a `null` translation.

  The direction's spread across the run is **reported but not judged** — see the amendment.
- **Failure condition:** a pose reported on a set that failed cheirality; or a translation
  direction identical on every frame of a run in which the camera moved.

> **Amendment: the direction-spread criterion is withdrawn.** Recorded in place, with the
> measurement that forced it (§29). **No other criterion moved, and nothing this phase rejects is
> now accepted** — see the last paragraph.
>
> It was first written as "the spread exceeds 5°", on the reasoning that a constant vector cannot
> pass. Before running anything it was narrowed to 0.5°, because between two re-anchors a camera
> panning steadily has a genuinely constant direction and 5° would fail a correct solver on an
> ordinary motion. **0.5° fails one too.** `tests/unit/poseStage.test.ts` drives the real solver
> over a straight-line camera translation and it recovers, on every frame:
>
> ```
> 40 frames with a full pose: median 100% in front of both cameras, reprojection 0 px,
> rotation 7.18°, direction spread 0°
> ```
>
> A spread of exactly zero, because the camera moved in a straight line and the direction really
> was the same every frame. There is no threshold that separates that from a fixed vector, because
> **they are the same measurement** — the difference lies in whether the number would have changed
> had the camera done something else, and no statistic over one run can see that.
>
> So the spread is reported and not judged. POSE-005 is what asks the question the spread was
> reaching for, and it asks it properly: it *makes* the camera do something else, by a known
> amount, without telling the solver. This is the same division Phase 5 settled on — GEO-001 is
> satisfied perfectly by a stage that accepts every correspondence, and GEO-003 is what separates
> them — and the plan already says so above: *every other number in this plan is produced, and
> produced well, by a stage that returns the same pose on every frame*. POSE-001 asks whether a
> translation was recovered and is geometrically sound; asking it to also detect a constant, with
> a weaker instrument than the one built for it, is what produced this.

### POSE-002 — Rotation · REQUIRED · device-decided

v3 §67, scored against the gyroscope.

- **Input:** frames where the device's own `rotationRate` integrates to a measurable turn over
  the anchor interval.
- **Expected:** the visually recovered rotation angle agrees with the integrated gyroscope.
- **Pass criteria:** all of —
  1. ≥ 15 frames with a gyroscope-measured rotation over the anchor interval;
  2. the median disagreement is within
     `max(ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION × measured)`;
  3. the gyroscope measured a non-zero rotation — an agreement between two zeros is not an
     agreement (this is FLOW-002's criterion 3, one phase along);
  4. ≥ 60 % of the individual frames agree, not merely the median.
- **Failure condition:** the recovered rotation near zero while the gyroscope reports a turn.
  That is the signature of a stage returning a constant, and no statistic computed from the
  pose's own output would show it.
- **Excluded if:** no gyroscope. Reported `PENDING` with that reason, never as decided. The
  automated leg is always in this case.

### POSE-003 — Planar scene · REQUIRED

v3 §16, which v4 dropped entirely. The failure it prevents is invisible: an Essential matrix
decomposed from a plane yields a pose that looks entirely reasonable.

- **Input:** judged frames Phase 5 flagged `PLANAR`.
- **Expected:** the pose comes from the homography, not from a degenerate Essential matrix, and
  translation confidence is lower than on non-planar frames.
- **Pass criteria:** all of —
  1. ≥ 15 planar judged frames;
  2. **every** one of them reports `source: HOMOGRAPHY` — none decomposed E;
  3. the median translation-confidence term on planar frames is strictly below the median on
     non-planar frames, which is v3 §16's "Translation confidenceを低下させる" made measurable;
  4. the homography decomposition's remaining two-fold ambiguity is *reported* where it is not
     resolved, rather than picked.
- **Failure condition:** an Essential matrix decomposed on a planar frame; or planar and
  non-planar frames carrying the same translation confidence.

### POSE-004 — Low parallax · REQUIRED

v3 §67. Fail closed (§44, v4 §1.4).

- **Input:** frames where the camera turned without moving, and frames Phase 5 declined.
- **Expected:** no translation is invented.
- **Pass criteria:** all of —
  1. ≥ 15 frames in which the plane-induced parallax fell below `PURE_ROTATION_PARALLAX_PX`,
     **or** the run reports that the condition never occurred;
  2. every one of them reports `ROTATION_ONLY` with `translation: null`;
  3. every frame Phase 5 left `UNVERIFIED` reports `NO_POSE` — no rotation either;
  4. no frame carries a `scale` other than `LOCAL_UNITS`.
- **Failure condition:** a unit translation vector on a frame with no measurable parallax. It
  will look like a direction, it will be stable enough to plot, and it will be noise.

### POSE-005 — Recovered rotation tracks an injected one · REQUIRED · **the gate**

Not in v3's list. It is here because v3 §67's pass condition — *Poseが計算結果により変化* —
is not decidable from the pose's own output, and this is what makes it decidable.

- **Input:** on sampled frames, the verified correspondence set with a known `INJECTED_ROTATION_DEG`
  camera rotation applied to the second view, handed to the solver unmarked.
- **Expected:** the recovered rotation differs from the original by the injected rotation.
- **Pass criteria:** all of —
  1. ≥ `MIN_INJECTION_SAMPLES` injected frames;
  2. the median recovered difference is within `INJECTION_TOLERANCE_DEG` of
     `INJECTED_ROTATION_DEG`;
  3. the median difference on the **control** — the same set, uninjected, refitted — stays under
     `MAX_CONTROL_ROTATION_DEG`;
  4. the injected set keeps the same inlier count and the same planar flag, to within a
     tolerance, since an image-space rotation preserves incidence.
- **Failure condition:** a recovered difference near 0° — a pose that did not respond to the
  camera being turned. **A stage returning a constant scores exactly 0.00° here while satisfying
  every other numeric criterion in this phase.**

### POSE-006 — Pose cost · ADVISORY

- **Input:** the measured cost of decomposition, cheirality and triangulation per judged frame.
- **Pass criteria:** Phase 5's RANSAC plus this phase's recovery ≤ `POSE_PIPELINE_BUDGET_MS`
  over ≥ 10 frames. §H budgets the two together as one 6 ms line; Phase 5's device run already
  spent **3.45 ms** of it, and this test reports the sum rather than inventing a fresh allowance.
- **Failure condition:** over budget. Advisory because §34 ranks correctness above performance
  and because §H.4 records that a device budget cannot be adjudicated off the device.

### POSE-007 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. every record carries `LOCAL_UNITS`; none carries a metric scale, and `‖t‖` is 1 or `null`;
  2. every record carries `INTRINSICS: ESTIMATED` with the assumed FOV beside it, never a bare K;
  3. `reprojectionErrorPx` is present exactly where points were triangulated, and `null` where
     they were not;
  4. `pointsInFront` never exceeds the inlier count;
  5. a frame reporting `NO_POSE` carries no rotation and no translation — the Phase 5 rule
     ("a frame that verified nothing has no model") one phase along;
  6. confidence is never higher than its lowest input term.
- **Failure condition:** any of the above unmet.

---

## What a pass requires, in full

POSE-001 through POSE-005 PASS on a `REAL_DEVICE` bundle. POSE-002 cannot be decided anywhere
else, so the automated leg reaches `TESTING` at best — which is Rule 004 expressed as a
measurement rather than as a policy.

The number that carries the phase is **POSE-005 criterion 2**: the recovered rotation must move
by the amount the camera was turned, where "turned" is something the harness did and never
disclosed. Every other number in this plan is produced, and produced *well*, by a stage that
returns the same pose on every frame.

## What this phase does not do, and says so

- **No metric scale.** `LOCAL_UNITS`, always. Phase 7 is where the IMU might supply one, and even
  then v3 §17 forbids integrating acceleration for absolute position.
- **No fused pose.** The gyroscope is a witness here, not an input. Phase 7 fuses.
- **No map.** The triangulated points exist only to run the cheirality test and the reprojection
  error; they are not retained, not accumulated, and not a landmark map. Phase 9 triangulates for
  keeping, from keyframes Phase 8 selects.
- **§33's `GOOD` stays unreachable**, and this is deliberate. Phase 6 supplies the
  `reprojectionError` that Phase 4 named as missing, but §33's state is computed in `FlowStage`
  from what Phase 4 measures, and plumbing a Phase 6 quantity back into a passed phase's state
  machine is a change to Phase 4, not an addition to Phase 6. It is deferred to the phase where a
  single fused pose exists to carry it, and `goodBlockedBy` continues to name what is missing.
