# Phase 9 — Triangulation · test plan

Written before any Phase 9 code exists (§29). No criterion here may be relaxed after a result is
seen. A *narrowing* is allowed where a criterion turns out to measure the wrong thing, and must be
recorded in place with the measurement that forced it — as Phases 6, 7 and 8's amendments are.

**Governing sections: v4 §21, and v3 §15/§16 for the geometry it stands on.** v4 gives the phase
three lines, and two of them are limits:

> 十分な視差がある観測だけからSparse Spatial Informationを取得する。
> **低視差から無理に大量の3D点を生成しない。**
> Sparse informationは空間理解と追跡を補助するために利用する。

## Objective

Recover the first three-dimensional quantity in this project — where a point **is**, not merely
where it appears — from two views that are far enough apart to determine one, and refuse it
everywhere else.

The pair is two **keyframes**. Phase 8 chose them, on v3 §20's conditions, precisely so that two
views exist that are far enough apart; the verification anchor Phases 5 and 6 use is one slot
re-taken on displacement, and it is not what a triangulation should be built on now that the
store exists.

**The pose is fitted for the pair, and that is not a second opinion on Phase 6's.** Phase 6's rule
is that it decomposes the model Phase 5 selected *on that frame*, never a fresh fit, so that the
pose belongs to the geometry the screen showed. Phase 9's pair is a **different pair of views** —
keyframe *i* against keyframe *j*, not the anchor against the current frame — and no model exists
for it. So one is fitted, by the same `verifyCorrespondences` Phase 5 uses and decomposed by the
same `recoverPose` Phase 6 uses, neither of them modified. What that buys is a check: the rotation
from this fit and the rotation Phase 6's own increments accumulated between the same two keyframes
are two independent routes to one quantity, and TRI-006 compares them.

## What this phase must not be allowed to fake

### 1. A depth that is a constant

Return the same depth for every point. Every point is then in front of both cameras, the
structure looks plausible on any screen that draws it, the counts are all correct, and the mean
reprojection error is small — because a two-view reprojection is dominated by the ray direction,
which is right, rather than by the depth, which is not. **A run cannot tell the difference from
its own output.** So the harness makes a pair with depths it chose and did not disclose, and the
measurement is the error against them (TRI-004).

### 2. Points from a camera that only turned

A pure rotation gives large, well-conditioned image motion and **no parallax at all**: every ray
pair meets at infinity. A triangulator that solves the linear system anyway gets an answer — a
badly conditioned one, at whatever depth the noise implies — and reports a full set of points from
a camera that never moved. This is not a corner case; it is what a phone does when someone stands
still and turns, which is most of a room scan. TRI-003 injects exactly that pair and requires
**zero** accepted points.

### 3. A great many points from very little parallax

v4 §21's own prohibition. Accepting everything maximises the point count, and the point count is
what a screen shows. The gate is a floor in **degrees of parallax**, derived from the
correspondence noise this project already measured, not a percentile of whatever the frame
happened to contain (§H.6).

### 4. A distance

The pair's translation is a unit direction. Every depth this phase produces is therefore in units
of *that pair's own baseline*, and the baseline has no metric value — v3 §15 and v4 §18 again. A
depth reported without that is a number that will be read as metres by the next phase that
touches it.

---

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `MIN_PARALLAX_DEG` | 1.0 | derived below from §13's 1.5 px and a 10 % depth uncertainty |
| `DEPTH_UNCERTAINTY_LIMIT` | 0.10 | what "sufficient parallax" is being asked to buy |
| `MAX_TRIANGULATION_REPROJECTION_PX` | 2.0 | **v3 §33**'s GOOD condition, reused rather than re-derived |
| `MIN_PAIR_CORRESPONDENCES` | 20 | `MIN_CORRESPONDENCES`, reused: below it a pair is not a geometry |
| `INJECTED_DEPTH_RANGE` | 2.0–8.0 | TRI-004's ground truth, in units of the injected baseline |
| `DEPTH_ERROR_TOLERANCE` | 0.02 | TRI-004: 2 % of the true depth, on a noiseless synthetic pair |
| `INJECTED_ROTATION_DEG` | 8.0 | TRI-003's pure rotation — **Phase 6's POSE-005 number**, reused |
| `MIN_JUDGED_BATCHES` | 15 | per condition, as Phases 3–8 used |
| `ROTATION_AGREEMENT_DEG` | 3.0 | **Phase 6's**, reused: the tolerance between two rotation routes |
| `ROTATION_AGREEMENT_FRACTION` | 0.30 | ...and its proportional part |
| `TRIANGULATION_BUDGET_MS` | 8.0 | per keyframe insert — see below |

**`MIN_PARALLAX_DEG` = 1.0, and it is derived rather than chosen.** A triangulated depth's
relative uncertainty is `σ_Z/Z ≈ σ_θ / θ`, where `θ` is the parallax angle and `σ_θ` is the
angular uncertainty of a correspondence. This project already has that: §13's forward/backward
band is 1.5 px, which Phase 5 reused as `RANSAC_THRESHOLD_PX`. At the assumed 67° field of view a
1280-long-edge frame gives `f ≈ 967 px`, so `σ_θ ≈ 1.5/967 = 1.55 mrad = 0.089°`. Asking for
`σ_Z/Z ≤ 0.10` gives `θ ≥ 0.089/0.10 = 0.89°`. One degree.

That figure is a floor in the units of the physical quantity — degrees of parallax — rather than a
percentile of the frame's own distribution, which is §H.6's rule and the reason Phase 3's corner
floor had to be rewritten.

**`DEPTH_ERROR_TOLERANCE` = 2 %, on a pair with no noise in it.** TRI-004's injected pair is
synthesised exactly: the harness picks depths, projects them through a known `(R, t)`, and hands
over the correspondences. A linear DLT on exact data is exact to numerical precision, so the
tolerance is a numerical-conditioning allowance and not a measurement allowance. It is set at 2 %
rather than at 10⁻⁶ because the pair is built from the *frame's own* intrinsics and geometry,
which vary, and because a criterion that fails on double-precision rounding is a criterion about
floating point. **The control is reported beside it**: what returning the set's mean depth for
every point would have scored. Fake 1 scores that number, and the two are far enough apart that
the tolerance is not what separates them.

**`INJECTED_ROTATION_DEG` = 8.0 is Phase 6's POSE-005 number**, reused because it is the same
construction: `K R K⁻¹` applied to the second view *is* the camera having additionally rotated by
`R`, and `tests/unit/pose.test.ts` asserts that identity already. Here the whole second view is
replaced by a rotation of the first, so the pair has **no translation at all** — which is the
condition TRI-003 is about.

**`TRIANGULATION_BUDGET_MS` = 8.0 per keyframe insert, and it is not a per-frame line.** §H's
table allocates ≤ 6 ms to *RANSAC + pose recovery* per frame and puts mapping off the tracking
cadence explicitly: *triangulation on keyframe insert only*. Phase 8's leg inserted about one
keyframe a second, so the cost lands on roughly one frame in thirty. 8 ms is §H's RANSAC line plus
a third, because this fit is over a pair with a longer baseline and more correspondences than the
anchor pair, and it is spent on a frame that is otherwise doing the same work as any other. **The
amortised per-frame figure is reported beside it**, because that is the number that says whether
a second worker is needed, and the answer is deferred rather than assumed: §B.2 puts a mapping
worker in the plan from this phase, and the measurement is what should decide it.

---

## What Phase 9 measures, per batch

A **batch** is one keyframe pair: the keyframe Phase 8 just inserted, against the one before it.

| Field | Meaning |
| --- | --- |
| `state` | `TRIANGULATED` / `REFUSED`, and the reason for a refusal |
| `correspondences` | shared observations between the two keyframes, by feature id |
| `inliers` | ...that the pair's own fit verified |
| `accepted` | points that survived every gate |
| `refusals` | `LOW_PARALLAX` / `BEHIND_CAMERA` / `HIGH_REPROJECTION`, counted separately |
| `medianParallaxDeg` | of the accepted set, and of the whole candidate set |
| `medianDepth` | in units of the pair's baseline, which is `1` by construction |
| `medianDepthUncertainty` | `σ_θ / θ` per point, from the parallax actually measured |
| `medianReprojectionPx` | worst of the two views, per point |
| `rotationDeg` | the pair fit's rotation... |
| `keyframeRotationDeg` | ...and Phase 6's own, accumulated between the same two keyframes |
| `scale` | `LOCAL_UNITS`, and `baselineUnits: 1` beside it |

---

## Test records

### TRI-001 — Structure from a keyframe pair · REQUIRED

v4 §21's first line.

- **Input:** a run where Phase 8 is inserting keyframes and the camera is translating.
- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_BATCHES` batches were attempted;
  2. at least one batch produced points, and the run reports the fraction that did;
  3. every accepted point carries a position, a parallax, a depth uncertainty and a
     reprojection error — no point is accepted without all four measured;
  4. every accepted point is identified by the **feature id** it was triangulated from, so
     Phase 10 can recognise it again.
- **Failure condition:** batches that report points with no parallax measured, or points with no
  identity — a 3D point that cannot be matched to the observation it came from is a point no
  later phase can update.

### TRI-002 — Parallax gating · REQUIRED

v4 §21's prohibition: *低視差から無理に大量の3D点を生成しない*.

- **Pass criteria:** all of —
  1. no accepted point has parallax below `MIN_PARALLAX_DEG`;
  2. the refusals are counted by reason and reported, so the ratio of what was offered to what
     was kept is visible rather than implied;
  3. the median depth uncertainty of the accepted set is within `DEPTH_UNCERTAINTY_LIMIT`;
  4. at least one point was refused for low parallax over the run, **or** the run reports that
     every candidate had enough — an unexercised gate is reported as unexercised, not as passed.
- **Failure condition:** an accepted point below the floor; or a batch whose acceptance rate is
  1.00 with a median parallax at the floor, which is a gate that is not gating.

### TRI-003 — A camera that only turned · REQUIRED · **a gate**

- **Input:** on a sampled schedule, the pair's second view replaced by `K R K⁻¹` applied to its
  **first** view, with `R` a seeded rotation of `INJECTED_ROTATION_DEG`. The pair then has a real
  rotation and **no translation whatever**. It is handed over unmarked.
- **Expected:** nothing is triangulated from it.
- **Pass criteria:** all of —
  1. ≥ 3 injections ran;
  2. **zero** points accepted from any of them;
  3. the refusal is attributed — either the pose came back `ROTATION_ONLY` (no translation to
     recover) or every point was refused for parallax; the run says which;
  4. the same batch's untouched pair produced points, so the refusal is not a stage that refuses
     everything.
- **Failure condition:** any point accepted from a pure rotation. There is no tolerance on this:
  a pure rotation determines no depth, and a number produced from it was invented.

### TRI-004 — Depths the harness chose · REQUIRED · **the gate**

Not in v3's or v4's list. It is here because every other number in this phase is produced, and
produced *well*, by a triangulator that returns a constant depth.

- **Input:** on a sampled schedule, a synthetic pair — the harness picks depths in
  `INJECTED_DEPTH_RANGE`, projects them through a known `(R, t)` with `‖t‖ = 1` using **the
  frame's own intrinsics**, and hands over the correspondences with no marking.
- **Expected:** the recovered depths are the depths the harness chose.
- **Pass criteria:** all of —
  1. ≥ 3 injections ran, each over ≥ `MIN_PAIR_CORRESPONDENCES` points;
  2. the median relative depth error is within `DEPTH_ERROR_TOLERANCE`;
  3. the **control** is reported beside it — the error a constant depth would have scored on the
     same set — and the measured error is at least ten times smaller;
  4. the recovered depths are *ordered* like the true ones: the rank correlation over the set is
     positive and near 1, so a triangulator that got the mean right and the structure wrong is
     separated from one that recovered the structure.
- **Failure condition:** a median error at or near the control's. **A constant-depth stage scores
  the control exactly**, while satisfying every count, every reprojection and every cheirality
  criterion in this phase.

### TRI-005 — In front, and consistent · REQUIRED

- **Pass criteria:** all of —
  1. every accepted point has positive depth in **both** views;
  2. every accepted point reprojects within `MAX_TRIANGULATION_REPROJECTION_PX` into both views;
  3. points failing either are refused and counted by reason, not silently dropped;
  4. the median reprojection error of the accepted set is reported.
- **Failure condition:** an accepted point behind either camera, or beyond the reprojection
  ceiling.

### TRI-006 — Two routes to one rotation · REQUIRED

The pair fit is a fresh fit, so it needs a witness, and one exists that costs nothing: Phase 6
already measured the rotation between these two views by an entirely different path — per-frame
poses against Phase 5's anchor, composed by Phase 8 across anchor epochs.

- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_BATCHES` batches where both rotations could be formed;
  2. the median disagreement within
     `max(ROTATION_AGREEMENT_DEG, ROTATION_AGREEMENT_FRACTION × measured)` — Phase 6's own
     tolerance, reused, because these are the same two quantities POSE-002 compared;
  3. the disagreement is **not identically zero**, which would mean one number is the other.
- **Failure condition:** a median disagreement outside the tolerance — the pair's fit and the
  chain of poses that led to it describe different camera motions, and at most one of them can be
  right.

### TRI-007 — No distance · REQUIRED

v3 §15, v4 §18 and v4 §21's third line.

- **Pass criteria:** all of —
  1. every record carries `SCALE: LOCAL_UNITS`;
  2. every depth is accompanied by the statement that it is in units of **that pair's own
     baseline**, and the baseline is reported as `1` by construction rather than as a length;
  3. no record converts a depth into a distance, and no record aggregates depths **across
     batches**, because two batches' baselines are two different units — this phase does not
     have the shared scale that would make them comparable, and Phase 10 is where that is
     obtained;
  4. the sparsity is a number: points per batch and points per keyframe are reported, so
     *Sparse Spatial Information* is a measurement rather than an adjective.
- **Failure condition:** a metre anywhere; or a depth statistic pooled across pairs, which would
  be an average over incommensurable units.

### TRI-008 — Triangulation cost · ADVISORY

- **Pass criteria:** mean cost per keyframe insert ≤ `TRIANGULATION_BUDGET_MS` over ≥ 5 batches,
  with the amortised per-frame figure reported beside it.
- **Failure condition:** over budget. Advisory for §34's and §H.4's reasons, and because the
  answer to a genuine overrun here is §B.2's mapping worker rather than a smaller number.

### TRI-009 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. every rate reported is in `0..1`;
  2. no Euler angle triple is emitted anywhere (§18);
  3. the accepted count plus the refusals equals the candidates, on every batch;
  4. a refused batch carries a reason and no points.
- **Failure condition:** any of the above unmet.

---

## What a pass requires, in full

TRI-001 through TRI-007 PASS on a `REAL_DEVICE` bundle.

**The automated leg can decide all seven.** Both gates are injections the harness builds — a pure
rotation, and a pair with chosen depths — and the leg's parallax pan produces real structure at
two depths for the rest. As in Phase 8, Rule 004 is untouched and is not a formality: the leg's
scene is two fronto-parallel layers at a fixed ratio, and a room is not.

The number that carries the phase is **TRI-004 criterion 2 against criterion 3**: the depths come
back as the harness set them, and a constant depth — which satisfies every other criterion here —
scores the control.

## What this phase does not do, and says so

- **No shared scale between batches.** Each pair's depths are in units of its own baseline. That
  is not an oversight; it is what a monocular camera gives, and Phase 10 is where the batches are
  brought into one frame by the landmarks they share.
- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes, and it belongs to the phase that
  holds a map to adjust.
- **No surfaces, no meshing, no completeness.** v4 §21 asks for *Sparse Spatial Information* and
  §16 forbids treating what cannot be observed as geometry. Phase 11 is where surfaces begin.
- **No second worker yet.** §B.2 puts a mapping worker in the plan from this phase. The
  measurement is what should decide it, so the cost per insert and the amortised per-frame figure
  are both on the record, and the decision is deferred to the number rather than taken on the
  diagram.
- **§33's `GOOD` stays unreachable**, for the sixth phase running and for the reason Phase 6 gave.
