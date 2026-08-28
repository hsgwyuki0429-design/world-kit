# Phase 10 — Landmark Map · test plan

Written before any Phase 10 code exists (§29). No criterion here may be relaxed after a result is
seen. A *narrowing* is allowed where a criterion turns out to measure the wrong thing, and must be
recorded in place with the measurement that forced it — as Phases 6 through 9's amendments are.

**Governing sections: v4 §22, with §56's bound and §34's origin.** v4 gives the phase two lines,
and the second is a prohibition:

> 観測されたLandmarkを時系列で管理し、Camera PoseとSpatial Worldの安定性を支える。
> **Landmark Map自体を最終的な3Dモデルとして扱わない。**

## Objective

Bring Phase 9's batches into **one frame**, keep the landmarks in it across time, and let go of the
ones the room stops agreeing with.

Phase 9 leaves nine hundred separate answers. Each batch's depths are in units of *that pair's own
baseline*, which is 1 by construction and has no length — the leg measured the median depth moving
by 87 % of itself between consecutive batches on a scene that never changed. Phase 10 is where
that stops being true, and the mechanism is the only one a monocular camera has: **the landmarks
two batches share fix the ratio between their scales.**

The world's origin is the first registered keyframe's camera frame, and its unit is that batch's
baseline. §34 already fixes the origin at the initial camera pose and §A.3.1 records why it cannot
be anything else: `absolute` is `false` on this platform and `webkitCompassHeading` reported
±24.5°, so there is no global datum to align to and inventing one would be inventing a heading.

## What this phase must not be allowed to fake

### 1. A map that is the last batch

Overwrite each landmark with whatever the newest triangulation said. It looks perfect from inside:
every landmark agrees with the most recent observation exactly, the reprojection error is the
triangulator's own, and the map is always "consistent". It has no memory, so it cannot be wrong
about the past — and it cannot be *right* about it either. A map like this predicts nothing.

**MAP-002 is the separation**: a landmark's position, as the map held it **before** this batch was
folded in, is projected into the keyframe the batch has just added — a view that landmark's
position was not computed from — and compared against where the tracker actually saw it. A map
that copies the newest batch has nothing to predict with.

### 2. A map that grows without bound

§56 bounds the session and §H.1 fixes the number at 5000 landmarks. An unbounded map passes every
geometric criterion here and fails in the twentieth minute on a device with four cores and no
`performance.memory` to warn anyone.

### 3. A map that never lets anything go

Landmarks whose position the room has stopped agreeing with — a point tracked onto a moving
object, a match that survived §13 and was wrong, a depth from a pair that was worse conditioned
than it looked. Keeping them is what makes a map slowly stop describing the room while every
count still rises. **MAP-005 is the separation**: the harness displaces a known subset of the
incoming positions and the map's own gate has to find them, with the false-cull rate on the
untouched ones reported beside the recall — because a map that rejects everything scores a perfect
recall.

### 4. A confidence that is an age

A landmark seen for a long time is not thereby a good landmark. `audit-fake-data.mjs` already
bans a confidence computed from `Date.now`, `elapsed` or `age`; this phase's confidence comes from
observation count, the parallax that determined it, the agreement of its observations, and the
spread of the viewpoints that saw it — all of them measured, none of them a clock.

### 5. A 3D model

v4 §22's own prohibition. A cloud of points drawn on a screen looks like a reconstruction; it is a
few hundred places the tracker could follow, and everything between them is unobserved. §16:
観測できない形状を推測して完全なGeometryとして扱わない.

---

## How a batch is brought into the world

Phase 9 hands over, per batch: the two keyframes, the points in the **first** keyframe's camera
frame with `‖t‖ = 1`, the rotation and unit translation between them, and where each point was
observed in the second view.

1. **Find the landmarks this batch shares with the map**, by feature id. The ids are
   `FlowTracker`'s and are unique for the life of the run, so a shared id is the same physical
   point rather than two points that happen to be near each other.
2. **Predict, before merging.** For every shared landmark whose position was computed without the
   batch's *new* keyframe, project the map's existing world position into that keyframe and record
   the pixel distance to where it was actually observed. That is MAP-002, and it has to happen
   before the merge or it is not held out.
3. **Fit a similarity** from the batch's frame to the world over the shared landmarks — 7 degrees
   of freedom, solved in closed form (Umeyama), with one robust re-fit that drops residuals beyond
   `REGISTRATION_OUTLIER_FACTOR` times the median. The scale it recovers *is* the ratio between
   this batch's baseline and the world's, which is the quantity a monocular camera has no other
   way to obtain.
4. **Reject what the map disagrees with**, admit the rest, update the shared ones, cull what has
   stopped agreeing, and stay inside the bound.

**When there is nothing to register against.** The first batch defines the world. A later batch
that shares fewer than `MIN_REGISTRATION_POINTS` landmarks with the map, or whose fit leaves a
residual above `MAX_REGISTRATION_RESIDUAL`, is **not ingested** and is counted. After
`EPOCH_RESTART_AFTER` consecutive such batches the map starts a new **epoch**: the world is
redefined from the current batch and the epoch count goes into the record. That is §H.8's
three-way distinction — failed, restarted, and *interrupted for a reason we can name* — and a run
with several epochs is not the same run as one with none.

---

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `MAX_LANDMARKS` | 5000 | **§56 / §H.1** — the memory ceiling fixed before Phase 0 |
| `MIN_OBSERVATIONS_CONFIRMED` | 3 | a point seen from three views is a landmark; from two it is a triangulation |
| `MAX_LANDMARK_REPROJECTION_PX` | 2.0 | **v3 §33**'s GOOD condition, reused rather than re-derived |
| `MIN_REGISTRATION_POINTS` | 6 | a similarity has 7 DOF; 3 points is the algebraic minimum, 6 gives double redundancy |
| `MAX_REGISTRATION_RESIDUAL` | 0.05 | half Phase 9's `DEPTH_UNCERTAINTY_LIMIT` — see below |
| `REGISTRATION_OUTLIER_FACTOR` | 2.5 | the robust re-fit's band, in medians |
| `LANDMARK_INJECTION_FRACTION` | 0.05 | MAP-005's displacement, as a fraction of depth — see below |
| `INJECTION_RECALL_FLOOR` | 0.90 | **GEO-003's**, reused: the same shape of measurement |
| `MAX_CLEAN_CULL_RATE` | 0.10 | ...and its companion, for the same reason |
| `EPOCH_RESTART_AFTER` | 5 | consecutive unregisterable batches before the world is redefined |
| `MAX_KEYFRAME_POSES` | 64 | §56 again: the poses are bounded like everything else |
| `MIN_JUDGED_BATCHES` | 15 | per condition, as Phases 3–9 used |
| `LANDMARK_BUDGET_MS` | 4.0 | per batch — see below |

**`MAX_REGISTRATION_RESIDUAL` = 0.05, as a fraction of the median depth.** Phase 9 accepts a point
only when its parallax buys a depth good to `DEPTH_UNCERTAINTY_LIMIT = 0.10` of itself. A
registration whose residual is at that figure has added as much error as the depths already carry;
half of it is the point below which the registration is not the dominant term. It is expressed
relative to the depth rather than in absolute units because the world's unit is a baseline whose
length nobody knows, and an absolute threshold on it would be a threshold on an arbitrary scale.

**`LANDMARK_INJECTION_FRACTION` = 0.05, displaced perpendicular to the viewing ray.** A
displacement of `0.05 × Z` perpendicular to the ray moves the point's projection by `0.05 × f`
pixels **regardless of its depth** — about 24 px at the leg's focal length, which is over sixteen
times §13's 1.5 px correspondence band. An outlier by construction, and the same magnitude
GEO-003's 25 px injection is, arrived at from the geometry rather than copied.

**`LANDMARK_BUDGET_MS` = 4.0 per batch.** Half Phase 9's per-batch ceiling, because this stage
does no fitting of a two-view model: a closed-form similarity over a few dozen points, a
projection per shared landmark, and bookkeeping. It runs on the same schedule Phase 9 does —
keyframe inserts only — so the amortised figure is reported beside it, as Phase 9's is, and for
the same reason: §B.2's mapping worker should be decided by a measurement.

---

## What Phase 10 measures, per batch

| Field | Meaning |
| --- | --- |
| `state` | `REGISTERED` / `UNREGISTERED` / `EPOCH_RESTART` / `IDLE`, with the reason |
| `shared` | landmarks this batch and the map have in common, by feature id |
| `heldOut` | shared landmarks predicted into a keyframe they were not computed from |
| `medianHeldOutPx` | ...and how far those predictions landed from the observations |
| `scale` | the ratio the registration recovered between this batch's baseline and the world's |
| `registrationResidual` | after the robust re-fit, relative to the median depth |
| `admitted` / `merged` / `rejected` | what happened to the batch's points |
| `landmarks` | the map's size, its confirmed count, and its evictions |
| `epochs` | how many times the world has had to be redefined |
| `injection` | MAP-005's recall and its companion false-cull rate |

---

## Test records

### MAP-001 — A map that persists · REQUIRED

- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_BATCHES` batches were offered to the map;
  2. landmarks accumulate across batches — the count of landmarks with more than one observation
     is non-zero and grows;
  3. every landmark carries its feature id, its observation count, the keyframes that saw it, its
     confidence and its state;
  4. a landmark's id is stable: the same feature id refers to the same landmark for the life of an
     epoch.
- **Failure condition:** a map whose landmarks all have exactly one observation — that is a list
  of the last batch, not a map.

### MAP-002 — Held-out prediction · REQUIRED · **the gate**

- **Input:** every shared landmark whose position was computed without the keyframe this batch has
  just added.
- **Expected:** the map predicts where it will be seen, and it is seen there.
- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_BATCHES` batches produced at least one held-out prediction;
  2. the median held-out error is within `MAX_LANDMARK_REPROJECTION_PX`;
  3. the prediction is taken **before** the batch is merged, and the record says so by carrying
     the observation count the landmark had at prediction time;
  4. the errors are **not identically zero** — a zero throughout means the position being
     predicted from is the observation being predicted.
- **Failure condition:** a median outside the ceiling; or an error of exactly zero throughout,
  which is fake 1.

### MAP-003 — One frame, and what it cost to get there · REQUIRED

- **Pass criteria:** all of —
  1. every registered batch reports the **scale** its registration recovered, and that scale is
     the ratio between the batch's baseline and the world's rather than a metre;
  2. the median registration residual is within `MAX_REGISTRATION_RESIDUAL`;
  3. batches that could not be registered are counted, with the reason, and **not ingested**;
  4. epochs are counted; a run with none says so, and a run with several says how many and why;
  5. `SCALE: LOCAL_UNITS` throughout — the world has a consistent unit, not a known one.
- **Failure condition:** a batch ingested without a registration; or a metre anywhere.

### MAP-004 — Bounded, and able to let go · REQUIRED

§56, §H.1 and v4 §22's second line.

- **Pass criteria:** all of —
  1. the map never exceeded `MAX_LANDMARKS`;
  2. every cull carries a reason;
  3. a landmark whose observations stop agreeing with its position is culled, and the run reports
     how many were;
  4. confidence is a function of observation count, parallax, agreement and viewpoint spread —
     **never of age or elapsed time**, which `audit-fake-data.mjs` enforces mechanically;
  5. every confidence is in `0..1`.
- **Failure condition:** a map above the bound; a cull with no reason; or a confidence that rises
  with nothing but time.

### MAP-005 — Injected corruption · REQUIRED · **the second gate**

The shape GEO-003 established, one layer up.

- **Input:** on a sampled schedule, a known subset of the batch's positions displaced
  perpendicular to their viewing rays by `LANDMARK_INJECTION_FRACTION` of their depth, handed over
  unmarked.
- **Pass criteria:** all of —
  1. ≥ 3 injections ran, each over ≥ `MIN_REGISTRATION_POINTS` displaced points;
  2. the recall against the harness's own outliers is at least `INJECTION_RECALL_FLOOR`;
  3. the rate at which **untouched** points were rejected is at most `MAX_CLEAN_CULL_RATE`;
  4. both numbers are reported, always, because either alone is scored perfectly by a degenerate
     map — recall by one that rejects everything, the false-cull rate by one that rejects nothing.
- **Failure condition:** a recall below the floor, or a false-cull rate above its ceiling.

### MAP-006 — Convergence · REQUIRED

A landmark's position must settle as it is seen again, not wander.

- **Pass criteria:** all of —
  1. the movement a new observation causes is recorded per landmark, relative to its depth;
  2. that movement **falls** with the observation count — the median move at five or more
     observations is at or below the median move at two;
  3. the run reports the count at each, so a criterion met on three samples is visible as such.
- **Failure condition:** a movement that does not fall — a map whose landmarks random-walk is a
  map that is re-guessing rather than accumulating.

### MAP-007 — Not a 3D model · REQUIRED

v4 §22's second line, and §16's.

- **Pass criteria:** all of —
  1. the record carries no surface, no mesh, no volume and no completeness figure;
  2. the **density** is a number: landmarks per keyframe, and the fraction of the tracked
     population that ever became a confirmed landmark;
  3. the record states that everything between the landmarks is unobserved, as a value rather
     than as an omission.
- **Failure condition:** any claim of completeness, or a geometry the observations do not support.

### MAP-008 — Landmark cost · ADVISORY

- **Pass criteria:** mean cost ≤ `LANDMARK_BUDGET_MS` per batch over ≥ 5 batches, with the
  amortised per-frame figure beside it.
- **Failure condition:** over budget.

### MAP-009 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. every rate reported is in `0..1`;
  2. `admitted + merged + rejected` equals the batch's point count, on every batch;
  3. an unregistered batch admits nothing;
  4. the reported map size equals the number of landmarks it holds.
- **Failure condition:** any of the above unmet.

---

## What a pass requires, in full

MAP-001 through MAP-007 PASS on a `REAL_DEVICE` bundle.

**The automated leg can decide all seven**, as Phase 8's and Phase 9's could, and for the same
reason: the instruments are the map's own memory and an injection the harness builds. Rule 004 is
untouched, and the device is where the map meets a scene that is not two flat layers.

The number that carries the phase is **MAP-002**: a position the map held before this batch,
projected into a view it was not computed from, landing where the tracker saw it.

## What this phase does not do, and says so

- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes. The map here is a running estimate
  per landmark and a chain of similarities between batches; a joint refinement of poses and
  points is a different thing, it is not on Prototype v1's path to a ball game, and building it on
  speculation is what §2 forbids.
- **No loop closure, no relocalisation.** v3 §21 is a later phase. Two visits to the same corner
  of a room produce two sets of landmarks here, and the run says how many epochs it had rather
  than pretending they were one.
- **No metric scale.** The world has one consistent unit and no known one. §A.3.1's measurement is
  why: `absolute` is `false` and the compass reported ±24.5°.
- **No surfaces.** Phase 11 is where those begin, from these landmarks.
- **§33's `GOOD` stays unreachable**, for the seventh phase running and for the reason Phase 6
  gave.
