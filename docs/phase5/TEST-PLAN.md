# Phase 5 — Geometric Verification (v3 §14, §16, §66)

Written before the code, as §29 requires. Thresholds are fixed here and are not to be relaxed
after seeing a result; a criterion that turns out to measure the wrong thing may be *narrowed*
with the reasoning recorded in place, as Phases 2, 3 and 4 all did.

**Spec authority.** v3.0 for the technical detail, v4.0 for the direction, as the spec's author
set out on 2026-08-22 (`docs/SPEC-VERSIONS.md`). v4 §17 restates this phase in two sentences and
no numbers; v3 §14's four figures therefore stand, and are used below.

## Objective

v3 §14 opens with a prohibition rather than a goal:

> **Feature correspondenceをそのままPoseへ利用してはならない。**

and gives the order the work has to happen in:

```
Feature Correspondence → RANSAC → Inlier Selection → Geometric Model → Pose candidate
```

Phase 4 produced correspondences that survived §13's round trip. That is not the same as
correspondences that are consistent with *one rigid camera motion*: a point tracked perfectly
onto a moving object, or onto a repeating texture one period over, passes §13 and is still
wrong for pose. Phase 5's job is to find the largest subset that agrees on a single geometric
model, and to say honestly when no such subset exists.

**Phase 5 produces no pose.** The `Pose candidate` at the end of §14's chain is §15's, which is
Phase 6. This phase ends at a verified correspondence set, a model, and a confidence.

## What this phase must not be allowed to fake

### 1. A verifier that verifies nothing

The single most dangerous failure, and it is the exact shape of Phase 4's:

- return every correspondence as an inlier;
- the inlier count is then the correspondence count, which is as high as it can be;
- the inlier **ratio is 1.00**, which is above every threshold v3 §14 names;
- and on a well-tracked scene it is indistinguishable from a verifier that worked.

Every count-based criterion in v3 §14 is satisfied by doing nothing at all. So the gate is
ground truth the verifier cannot see:

> **The harness corrupts a known subset of the correspondences by a known displacement, and
> requires the verifier to put those specific ones — and not the others — in the outlier set.**

The harness makes the outliers, so it knows exactly which they are. The verifier is handed the
corrupted set with no marking. This is Phase 5's counterpart to Phase 2's provenance
cross-check, Phase 3's contrast statistic and Phase 4's independent scene-shift search, and it
is here for the same reason (§H.7): **a statistic computed from one side of a comparison cannot
verify the comparison.**

### 2. A model that fits because it cannot fail

A homography has eight degrees of freedom and four correspondences determine it. A fundamental
matrix has seven. Given few enough points, or points in a degenerate configuration — all on one
plane, all on one line, or all with the same displacement — a model can explain everything
while describing nothing.

Two consequences, both tested:

- the **configuration** of the inliers is measured, not assumed: a set that is degenerate is
  reported as degenerate rather than as a verification;
- and v3 §16's comparison is made — **both** the fundamental matrix and the homography are
  fitted, and where the homography explains the scene as well or better, the frame pair is
  marked `PLANAR SCENE`. A room scan is mostly planes, so this is the common case, not the
  exception. §16 requires translation confidence to be lowered there; acting on that is Phase
  6's, and Phase 5's job is to hand it the fact.

### 3. Verification of a motion that did not happen

Any model fits a static scene perfectly: with zero displacement, every correspondence has zero
residual under every model, and the inlier ratio is 1.00. A verifier reporting "41 inliers,
ratio 1.00" on a phone lying on a desk has verified nothing.

So a frame pair is only judged when it has a **measured baseline**, and a run that never
produced one reports that rather than reporting success. This is the same shape as FLOW-002's
third criterion, which exists so that agreement on a scene that never moved cannot pass.

## The baseline problem, and the anchor this phase introduces

Phase 4 tracks frame to frame. The device run measured a median displacement of **4.7 px**
between consecutive frames, against a positional uncertainty §13 puts at up to 1.5 px. A
two-view geometry estimated from a 4.7 px baseline is ill-conditioned to the point of
meaninglessness — the epipole is at infinity, and the residuals are dominated by noise.

Two-view geometry needs two views that are actually apart. It also needs all the
correspondences to relate **the same two views**: points born at different moments do not, so a
track's own birth position cannot be used as the reference.

So Phase 5 takes a **verification anchor**: a snapshot of the population's positions at one
frame, against which every subsequent frame's correspondences are formed. Tracks alive since
the anchor supply the correspondence set; tracks born after it do not, until the next anchor.

The anchor is re-taken when any of:

- the tracks surviving from it fall below `MIN_CORRESPONDENCES`;
- the median anchor displacement exceeds `MAX_BASELINE_PX`, beyond which the two views have
  little overlap and the surviving set is no longer representative;
- the frame geometry changes (§H.0: a tier step or a device rotation makes level-0 positions
  from the two views incomparable).

**This is a deliberate stand-in for Phase 8's keyframe system**, and it is written down as one.
v3 §20 gives keyframes their own conditions — rotation ≥ 10°, translation ≥ 0.10 local unit,
median feature displacement ≥ 30 px, minimum interval 0.5 s, maximum 5 s — and three of those
need a pose, which Phase 6 has not produced. What Phase 5 can measure is the displacement, so
that is what its anchor uses. Phase 8 replaces this with the real thing.

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `MIN_INLIERS` | 30 | **v3 §14** — 最低inliers |
| `GOOD_INLIERS` | 100 | **v3 §14** — GOOD candidate > 100 |
| `USABLE_INLIER_RATIO` | 0.35 | **v3 §14** — usable inlier ratio > 0.35 |
| `GOOD_INLIER_RATIO` | 0.50 | **v3 §14** — GOOD inlier ratio > 0.50 |
| `RANSAC_THRESHOLD_PX` | 1.5 | §13's acceptable forward/backward band, reused |
| `MIN_BASELINE_PX` | 15.0 | 10 × §13's band — see below |
| `MAX_BASELINE_PX` | 120.0 | beyond this the two views share too little; re-anchor |
| `MIN_CORRESPONDENCES` | 20 | below this an 8-point model has almost no redundancy |
| `RANSAC_CONFIDENCE` | 0.99 | the standard adaptive-termination target |
| `MAX_RANSAC_ITERATIONS` | 500 | the cap that keeps §H's 6 ms line reachable |
| ~~`PLANAR_H_ADVANTAGE`~~ | ~~1.0~~ | ~~homography inliers ≥ fundamental inliers → `PLANAR SCENE`~~ — **withdrawn, see below** |
| `PLANAR_H_SHARE` | 0.45 | `H / (H + F) > 0.45` → `PLANAR SCENE`; ORB-SLAM's constant for this same choice |
| `DEGENERATE_SPREAD_PX` | 20.0 | inliers whose spatial spread is below this describe a point, not a scene |
| `MIN_JUDGED_FRAMES` | 15 | per condition, as Phases 3 and 4 used |
| `OUTLIER_INJECTION_FRACTION` | 0.30 | GEO-003's corruption rate |
| `OUTLIER_INJECTION_PX` | 25.0 | how far a corrupted target is displaced |
| `MIN_OUTLIER_RECALL` | 0.90 | of the corrupted correspondences, this many must be rejected |
| `MAX_CLEAN_REJECTION` | 0.30 | ...while untouched ones are not rejected wholesale |
| `GEO_BUDGET_MS` | 6.0 | §H's line for RANSAC (E/H) + pose recovery |

Three of these need their derivation stated, because the spec does not give them.

**`RANSAC_THRESHOLD_PX` = 1.5.** A correspondence's own positional uncertainty is what §13
already quantifies: at or under 1.5 px the round trip is *acceptable*, above it confidence is
reduced. A geometric residual smaller than the positional noise cannot be distinguished from
it, so the inlier threshold is set at the noise §13 tolerates rather than at a new number.
§H.6's rule: prefer a constant the plan has already fixed for another purpose.

**`MIN_BASELINE_PX` = 15.0 = 10 × `RANSAC_THRESHOLD_PX`.** A two-view model can only be
recovered when the signal — the displacement between the views — is well above the noise in
each measurement. Ten times is the conventional margin for treating a measurement as
signal-dominated, and expressing it as a multiple of §13's band ties it to the one number this
project has for correspondence uncertainty rather than to a guess about scenes.

**`OUTLIER_INJECTION_PX` = 25.0.** The injected outliers have to be outliers *by construction*
— far enough outside `RANSAC_THRESHOLD_PX` that no correct model could accept them, and far
enough outside `MIN_BASELINE_PX` that they are not merely a large-but-plausible motion. 25 px
is over 16× the inlier threshold. A verifier that fails to reject a 25 px displacement is not
rejecting anything.

### Amendment — `PLANAR_H_ADVANTAGE` withdrawn, `PLANAR_H_SHARE` in its place

Recorded here, in place, at the point the change was made (§29). **No pass criterion moved.**
GEO-003's 0.90 recall, GEO-004's four conditions and v3 §14's four figures are exactly as this
plan committed them; what changed is an engine constant that this plan's own test proved wrong.

The withdrawn rule read v3 §16's "where the Homography wins" as `hCount >= fCount`. That is
wrong in precisely the case §16 exists for. On a planar scene the fundamental matrix is not
determined — every `[e]ₓH` fits, for any epipole `e` — so RANSAC has two free parameters the
correct correspondences do not constrain, and it spends them capturing whatever else is in the
set. Measured on a synthetic plane with 30% of its targets displaced 25 px:

| | homography | fundamental |
| --- | --- | --- |
| inliers admitted | 70 of 100 | 74 – 77 of 100 |
| injected outliers admitted | **0** | 4 – 7 |

The homography admitted the untouched correspondences and not one outlier. The fundamental
matrix admitted the same 70 plus the outliers its free epipole reached — and so "won" on count,
the degenerate model was selected, and GEO-003's recall came out at 0.77–0.87 against a
verifier that had in fact identified every outlier under the right model. GEO-004 was
simultaneously reporting `non-planar` for frames that are planar by construction.

`PLANAR_H_SHARE = 0.45` compares the share of combined support, `H / (H + F)`, which is
ORB-SLAM's constant (Mur-Artal, Montiel & Tardós 2015) for this identical choice between the
two models. That work compares robust score sums where this compares inlier counts — the
coarser statistic — and uses the ratio to select an initialisation method where §16 uses it to
lower Phase 6's translation confidence; what carries over is the shape of the comparison and
its reason, which is that a model with a free dimension per point cannot be judged against one
without it by counting. On the measurements above the cases separate with room on both sides: a
clean plane scores 0.500, a plane with outliers 0.476–0.486, a two-depth scene 0.400–0.415.

`tests/unit/verification.test.ts` holds the regression.

## What Phase 5 measures, per frame pair

- `correspondences` — tracks alive since the anchor.
- `baselinePx` — median anchor-to-current displacement, level-0 px.
- `inliers`, `inlierRatio` — from the selected model.
- `model` — `FUNDAMENTAL` or `HOMOGRAPHY`, and both inlier counts, so the comparison is visible.
- `planar` — v3 §16's flag, for Phase 6 to lower translation confidence on.
- `degenerate` — the inlier configuration's spatial spread, and whether it clears
  `DEGENERATE_SPREAD_PX`.
- `iterations`, `terminatedEarly` — whether RANSAC's adaptive termination converged or the cap
  bound.
- `verifyMs` — the cost, against §H's 6 ms.
- `state` — `UNVERIFIED` / `USABLE` / `GOOD`, a pure function of the measured quantities,
  computed in one place, exactly as §33's tracking state is.

---

## Test records

### GEO-001 — High inlier scene · REQUIRED

v3 §66's first test.

- **Input:** frame pairs with a measured baseline over `MIN_BASELINE_PX`, on a scene Phase 3
  classified texture-rich.
- **Expected:** a large, consistent inlier set that satisfies v3 §14's usable figures.
- **Pass criteria:** all of —
  1. ≥ 15 judged frames;
  2. median inliers ≥ 30 (**v3 §14**);
  3. median inlier ratio ≥ 0.35 (**v3 §14**);
  4. the inlier set is not degenerate — its spatial spread clears `DEGENERATE_SPREAD_PX`;
  5. RANSAC terminated by its own confidence criterion on the median frame, rather than by
     hitting the iteration cap.
- **Failure condition:** an inlier ratio that clears the bar on a set too small or too clustered
  to determine a model; or a run where the cap always bound, which means the confidence target
  was never met and the reported ratio is whatever the last sample happened to give.
- **Not accepted as a pass:** this test alone. Criterion 2 and 3 are satisfied perfectly by a
  verifier that accepts everything; GEO-003 is what separates them, and neither passes without
  the other.

### GEO-002 — Low texture scene · REQUIRED

v3 §66's second test.

- **Input:** frame pairs on a surface Phase 3 classified texture-poor, where Phase 4 has few
  correspondences to offer.
- **Expected:** the phase declines to verify, and says so. It does **not** report a high ratio
  on four points.
- **Pass criteria:** all of —
  1. ≥ 15 judged frames on texture-poor input;
  2. where correspondences fall below `MIN_CORRESPONDENCES`, the state is `UNVERIFIED` on
     every one of those frames — never `USABLE`, never `GOOD`;
  3. where the inlier count falls below 30, the state is `UNVERIFIED` (**v3 §14**'s minimum
     read as the floor it is);
  4. the state never disagrees with the counts reported beside it.
- **Failure condition:** a `USABLE` or `GOOD` verdict reached on a correspondence set too small
  for v3 §14's minimum. §44's fail-closed rule in the v4 direction says the same thing: when
  the information is not there, lower the state rather than making the result convenient.

> **Amendment, 2026-08-28 — the implementation, not the criteria. Found by a device run that
> failed on it.** Criteria 2 and 3 say *every one of those frames*, and they said so before any
> Phase 5 code existed. The implementation compared the texture-poor class's **median**
> correspondence count against the threshold and, if it was below, blamed however many frames
> had reported `USABLE` or `GOOD`.
>
> Those are different statements, and the device found the gap. It saw 570 texture-poor frames,
> 59 of them judgeable, a median of **14** correspondences, and 23 `USABLE` + 1 `GOOD`. The
> reported failure was *24 texture-poor frame(s) reported USABLE or GOOD on a median of 14
> correspondences*. They had done nothing of the kind. **546 of those frames were `UNVERIFIED`
> precisely because they were under the threshold** — which is the behaviour this record exists
> to confirm — and that is what pulled the median down. `stateMismatches` was **0**, and
> `deriveVerificationState` returns `UNVERIFIED` unconditionally below 20 correspondences or 30
> inliers, so the 24 verdicts were structurally incapable of being what the reason said.
>
> The count is per frame now: a frame violates this record when its state is not `UNVERIFIED`
> **and** its own correspondences or inliers are under the floor. §H.7 — an invariant that
> averages cannot verify a geometry — one phase earlier than the section that names it.
>
> Nothing is weakened. `tests/unit/verification.test.ts` still drives a stage that reports
> `USABLE` regardless of its inputs and it still fails this record; a new fixture replays the
> device's shape — four frames in five genuinely too thin and declined, one in five verified —
> and shows `FAIL` under the median and `PASS` under the count.

### GEO-003 — Outlier-heavy scene · REQUIRED

v3 §66's third test, v3 §66's PASS condition verbatim — *RANSACでOutlierが除外される* — and this
phase's anti-fake gate.

- **Input:** the real correspondence set from a frame pair, with a randomly chosen
  `OUTLIER_INJECTION_FRACTION` of its targets displaced by `OUTLIER_INJECTION_PX` in a seeded
  pseudo-random direction. The harness records which ones it corrupted; the verifier is handed
  the set with no marking.
- **Expected:** RANSAC rejects the corrupted correspondences and keeps the rest.
- **Pass criteria:** all of —
  1. ≥ 15 frames with injection applied and ≥ `MIN_INJECTABLE_CORRESPONDENCES` correspondences
     — the floor below which criterion 4 cannot be met at all; see the amendment below;
  2. **≥ 0.90 of the injected outliers land in the outlier set** (recall against ground truth
     the verifier never saw);
  3. ≤ 0.30 of the untouched correspondences are rejected — the model is not simply rejecting
     everything;
  4. the surviving inlier count still reaches 30 (**v3 §14**), so the rejection did not cost
     the frame its usability;
  5. the injected rejection rate is at least three times the untouched rejection rate — the
     paired form, so a verifier that rejects at random cannot pass by rejecting enough.
- **Failure condition:** injected outliers accepted as inliers. In particular a verifier that
  returns everything scores a recall of 0.00 here while satisfying every criterion in GEO-001.
- **Why the injection is seeded:** §59 bans `Math.random` in `src/`, and a corruption that
  cannot be reproduced cannot be re-examined when the run is questioned. The seed is recorded
  in the evidence with the frame it applied to.

> **Amendment, 2026-08-28 — criterion 1's floor, derived from criterion 4. Found by the same
> device run.** Criterion 1 named `MIN_CORRESPONDENCES` — 20 — as the set size worth injecting
> into. **Criterion 4 makes that unmeetable.** Displacing 30 % of a set of `n` leaves at most
> `n − round(0.3n)` untouched points, so the surviving inlier count cannot reach v3 §14's 30
> until `n` is **43**, however perfectly RANSAC performs. Between 20 and 43 this record was
> asking for something arithmetic forbids.
>
> The device measured what that costs. Median recall **0.871** against the 0.90 required — while
> rejecting the injected outliers at **12.4×** the rate of the untouched ones, which is not a
> verifier that fails to discriminate. The per-frame samples show where it went:
>
> | correspondences | injected | recall | surviving inliers | state after injection |
> | --- | --- | --- | --- | --- |
> | 51 | 15 | **1.000** | 36 | UNVERIFIED |
> | 42 | 13 | 0.923 | 26 | UNVERIFIED |
> | 36 | 11 | 0.727 | 25 | UNVERIFIED |
> | 31 | 9 | 0.778 | 20 | UNVERIFIED |
> | 31 | 9 | 0.667 | 19 | UNVERIFIED |
>
> The recall tracks the size of the set, and it breaks at about the floor above. It is not
> mysterious: on 31 correspondences with 9 displaced, drawing eight untouched points for the
> eight-point minimal sample has probability (22/31)⁸ ≈ **0.06**, so RANSAC spends its whole
> iteration budget hunting a clean subset that a larger set hands it at once. That is a fact
> about sample size, not about this verifier, and it is not what v3 §66's condition asks.
>
> Criterion 1's floor is now `MIN_INJECTABLE_CORRESPONDENCES`, **computed in the code from
> `MIN_INLIERS` and `OUTLIER_INJECTION_FRACTION` with the same rounding the injection uses**, so
> changing either constant moves it rather than leaving it stale. Criterion 2's 0.90 is
> untouched, and so are 3, 4 and 5. What changed is that the injection now runs only where all
> five can hold at once.
>
> `tests/unit/verification.test.ts` measures the relationship on the real verifier rather than
> asserting it: median recall above the floor clears 0.90, and at 31 correspondences it does
> not. The automated leg never saw any of this — its synthetic feed offers 144 correspondences a
> frame, so it was never near the floor. That is the device's contribution, and it is the second
> time in this project that a leg passed a record the device could not.

### GEO-004 — Planar scene handling · REQUIRED

v3 §16. Not in v3 §66's list, and it is required here because a room scan is mostly planes and
because the failure it prevents is invisible: an Essential matrix fitted to a planar scene is
degenerate and yields a pose that looks entirely reasonable.

- **Input:** every judged frame pair. Both models are fitted on all of them.
- **Expected:** both models are always evaluated, and the comparison decides the flag.
- **Pass criteria:** all of —
  1. both a fundamental matrix and a homography were fitted on ≥ 15 frames — neither is skipped
     as an optimisation;
  2. `PLANAR SCENE` is set exactly when the homography's inlier count reaches the fundamental
     matrix's, and not otherwise;
  3. the two inlier counts are both recorded per frame, so the decision is auditable rather
     than asserted;
  4. at least one frame in the run reached each outcome — planar and non-planar — or the run
     reports which it never saw.
- **Failure condition:** a run that fitted only one model; or a `PLANAR` flag that does not
  follow from the two counts beside it.
- **Excluded if:** the run genuinely never produced one of the two outcomes. Recorded as
  `PENDING` with that reason rather than judged, as Phase 1 did for CAM-004.

### GEO-005 — Verification cost · ADVISORY

- **Input:** the measured cost of the RANSAC pass per frame.
- **Pass criteria:** mean ≤ 6.0 ms over ≥ 10 judged frames, with the correspondence count
  recorded alongside.
- **Failure condition:** over budget. Advisory because §34 ranks correctness above performance
  and because, as §H.4 records, a device budget cannot be adjudicated off the device. The
  automated leg prints the verdict and gates on a wider configuration tripwire instead.

### GEO-006 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. `reprojectionError` on a §11 record is **still `null`** — §15's pose is Phase 6's, and an
     inlier's residual against a fundamental matrix is not a reprojection error;
  2. no correspondence appears in both the inlier and the outlier set;
  3. `inliers + outliers` equals the correspondence count on every frame;
  4. a frame reporting `UNVERIFIED` carries no model, rather than a model with a note attached.
- **Failure condition:** any of the above unmet. Advisory because it is a property of the code
  and is covered by unit tests as well.

---

## What a pass requires, in full

GEO-001, GEO-002, GEO-003 and GEO-004 PASS on a `REAL_DEVICE` bundle, with GEO-004 excluded
only for a measured absence of one of its two outcomes. Rule 004 stands: the automated leg
cannot pass this phase.

The one number that carries the phase is **GEO-003 criterion 2** — the fraction of
harness-injected outliers the verifier rejected without being told which they were. Every other
number in this plan can be produced by a stage that returns its input unchanged, and returning
its input is what "not verifying" looks like.
