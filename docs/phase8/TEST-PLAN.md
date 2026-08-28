# Phase 8 — Keyframe System · test plan

Written before any Phase 8 code exists (§29). No criterion here may be relaxed after a result is
seen. A *narrowing* is allowed where a criterion turns out to measure the wrong thing, and must
be recorded in place with the measurement that forced it — as Phase 6's three amendments and
Phase 7's one are.

**Governing sections: v3 §20 and v4 §20.** v4 gives the phase two lines, and the second is a
prohibition:

> 空間理解に有効な視点をKeyframeとして保持し、カメラ移動による観測情報を時系列で安定させる。
> **Keyframeはゲーム開始後も必要に応じて更新し、古い情報を盲目的に永久利用しない。**

v4 states no conditions. v3 §20 does, and by the rule in `SPEC-VERSIONS.md` — *follow v3 for the
fundamentals; v4 changes the direction only* — they are still in force:

| v3 §20 | |
| --- | --- |
| rotation | ≥ **10°** |
| relative translation | ≥ **0.10 local unit** |
| median feature displacement | ≥ **30 px** |
| tracking quality | a significant change |
| minimum interval | **0.5 s** |
| maximum interval | **5 s** |

## Objective

Choose which views are worth keeping, keep them bounded, and keep them honest — so that Phase 9
has two views far enough apart to triangulate from and Phase 10 has a set of viewpoints that
describes the room rather than the last few seconds of it.

**Phases 5, 6 and 7 have been running on a stand-in for this.** `FlowTracker`'s verification
anchor is a one-slot keyframe re-taken on displacement alone, and both the Phase 5 test plan and
the tracker itself say so in as many words: three of v3 §20's four conditions need a pose, and
Phase 6 had not produced one. Phase 8 replaces it with the real thing — and does **not** remove
the anchor, because Phase 5 and Phase 6 passed on the device with it and editing a passed phase
is not a fix. The anchor keeps serving Phase 5; the keyframe store is a second, longer-lived
structure with its own conditions.

## What this phase must not be allowed to fake

### 1. A metronome

Insert a keyframe every N milliseconds. It satisfies "keyframes exist", it satisfies the minimum
and maximum interval trivially, it never crashes, and on a moving camera it produces a set that
looks entirely reasonable — because on a moving camera *any* schedule produces separated views.
It gives itself away in one place only: **a camera that is not moving**. There the metronome
keeps inserting and a keyframe system does not.

So the phase runs a metronome beside the real selector, on the same stream, firing as often as
the real one is *allowed* to fire (`MIN_KEYFRAME_INTERVAL_MS`), and the measurement is the
**difference between the two counts over a segment where nothing moved**. This is Phase 7's
injected-bias twin in a different phase: two selectors, the same inputs, one difference.

### 2. A selector whose reasons are decoration

Insert on a timer, then attach the label `ROTATION` to the record. Every count is then correct
and every reason is a lie. The check is Rule 002's, which Phases 4–7 all carry: **the reason is
re-derived from the inputs recorded beside it**, on every decision, and a record whose reason its
own numbers do not support is counted as a mismatch.

### 3. A store that only grows

§56 bounds the session and §H.1 fixes the number at 30 keyframes. An unbounded store passes every
selection criterion in this plan and fails in the twentieth minute of a scan, on a device with
4 cores and no `performance.memory` to warn anyone.

### 4. A store that never lets go

The opposite, and it is v4 §20's own prohibition: *古い情報を盲目的に永久利用しない*. A keyframe
whose observations have all been lost describes a view nothing in the current frame can be
related to. Keeping it is not conservatism, it is carrying a measurement that can no longer be
checked against anything.

---

## The condition this phase cannot evaluate, and says so

**v3 §20's second condition — relative translation ≥ 0.10 local unit — is not evaluable in this
build, and Phase 8 refuses it rather than approximating it.**

Phase 6 recovers a translation *direction*, unit length, with `SCALE: LOCAL_UNITS`; v3 §15 and
v4 §18 both forbid a monocular camera claiming a magnitude, and Phase 7 refused position for the
same reason and measured the drift that refusing it avoids. "0.10 local unit" is a magnitude.
There is nothing in the pipeline that can produce one.

What Phase 8 does instead is exactly what v3 §20 already lists as its *third* condition: the
**median displacement of the features the two views share**, in pixels, which is the same
quantity expressed in the units this platform can actually measure. So the translation condition
is carried in every decision record as `TRANSLATION: UNMEASURED` with that reason, and the
displacement condition is the one that fires.

And the refusal carries a number, as IMU-006's does: the **angle between the current translation
direction and the last keyframe's** is measured and reported on every decision. It is a real
quantity, it is not a magnitude, and printing it beside the refusal is what stops "we cannot
measure the translation" from being a sentence with nothing behind it. KEY-005 is that record.

---

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `KEYFRAME_ROTATION_DEG` | 10.0 | **v3 §20** |
| `KEYFRAME_TRANSLATION_UNITS` | 0.10 | **v3 §20** — carried, never evaluated; see above |
| `KEYFRAME_DISPLACEMENT_PX` | 30.0 | **v3 §20** |
| `MIN_KEYFRAME_INTERVAL_MS` | 500 | **v3 §20** |
| `MAX_KEYFRAME_INTERVAL_MS` | 5000 | **v3 §20** |
| `MAX_KEYFRAMES` | 30 | **§56 / §H.1** — the memory ceiling the plan fixed before Phase 0 |
| `KEYFRAME_QUALITY_DELTA` | 0.15 | v3 §14's own usable→GOOD band — see below |
| `MIN_KEYFRAME_OBSERVATIONS` | 20 | `MIN_CORRESPONDENCES`, reused: below it a pair is not a two-view geometry |
| `STALE_SURVIVAL_FRACTION` | 0.25 | when a keyframe stops describing the current view — see below |
| `MIN_JUDGED_DECISIONS` | 15 | per condition, as Phases 3–7 used |
| `KEYFRAME_BUDGET_MS` | 1.0 | §H allocates no line to keyframe upkeep — as Phase 7's fusion budget |

**`KEYFRAME_QUALITY_DELTA` = 0.15.** v3 §20's fourth condition is *a significant change in
tracking quality* and gives no number, so one has to be fixed here. It is not invented: v3 §14
separates a **usable** inlier ratio (> 0.35) from a **GOOD** one (> 0.50), and the width of that
band is 0.15. A change of that size moves the frame from one of the spec's own quality classes to
the other, which is what "significant" can be made to mean without choosing a number. A change of
§33's tracking *state* also fires the condition, and that needs no threshold at all.

**`STALE_SURVIVAL_FRACTION` = 0.25.** A keyframe is stale when fewer than a quarter of the
features it recorded are still being tracked. Below that, a pair formed with it carries fewer
than `MIN_KEYFRAME_OBSERVATIONS` correspondences from any keyframe holding the 80-odd points
Phase 4's device run kept — so the keyframe can no longer be related to the present, which is
v4 §20's *古い情報* made measurable. It is a floor on what the keyframe can still be *used for*,
not on how old it is: age is not a defect and this project does not treat it as one.

**Why the displacement is measured over shared features and not from Phase 5's baseline.**
`VerificationReport.baselinePx` is the median displacement from the *verification anchor*, which
is a different view from the last keyframe and is re-taken on its own schedule. Phase 8 keeps
each keyframe's observations by feature id — the ids `FlowTracker` assigns are unique for the
life of the run — and measures the median displacement of the ids the two views share. That is a
net displacement between exactly the two views in question, and it needs no anchor.

**Why the rotation is assembled rather than read.** Phase 6's rotation is measured from Phase
5's anchor, and across a re-anchor two such rotations have different origins and their difference
means nothing — the same problem `FusionStage` documents for its visual increments. So the total
is assembled **per anchor epoch**: within one epoch it is `conj(q_at_keyframe) · q_now`, one
composition however many frames have passed, and the epochs are chained by one composition each
at the re-anchor. What crossing a re-anchor loses is the turn between the last view of the old
epoch and the first of the new, which no report measures; those are counted and reported, because
a run that dropped many has a rotation figure that understates. On a **still** camera that gap is
most of the epoch — the anchor is re-taken from the current frame, the two views collapse to no
baseline, and Phase 6 recovers nothing until something moves — so the chaining is done on frames
with no pose as well as on frames with one, and a pose Phase 6 flags `ambiguous` is declined
rather than accumulated. Both of those are amendments; both are recorded under KEY-002, with the
measurements that forced them.

> **Amendment, 2026-08-28 — recorded before the device leg ran, with the measurement that forced
> it.** The paragraph above first said *per-frame increments composed into a rotation since the
> last keyframe*, copying `FusionStage`. **That is wrong over this phase's interval**, and the
> automated leg found it: composing noisy increments is a random walk, and on the leg's lateral
> pan — where the true rotation is zero throughout — the accumulated angle reached v3 §20's 10°
> and fired `ROTATION` **seven times while Phase 4's own scene-shift search was reporting that
> the image was not moving at all**. It failed KEY-002 for the right reason.
>
> Phase 7 composes over one second and is unaffected. Phase 8 composes over up to five, and the
> difference is the length of the interval rather than the correctness of the arithmetic. The
> per-epoch assembly above composes once per re-anchor instead of once per frame; the same leg
> now fires `ROTATION` none, and KEY-002's static ratio came to 12.75×.
>
> **No criterion changed.** KEY-002's second criterion said no geometric insertion on a still
> camera before the measurement and says it after. What changed is the implementation it was
> measuring, which is the outcome a test plan written first is for.

---

## What Phase 8 measures, per decision

| Field | Meaning |
| --- | --- |
| `insert` | whether this frame became a keyframe |
| `reason` | `FIRST` / `ROTATION` / `DISPLACEMENT` / `QUALITY` / `HEARTBEAT`, or a refusal |
| `conditions` | every one of v3 §20's, with its measured value, its threshold and whether it fired |
| `rotationDeg` | accumulated rotation since the last keyframe, from composed increments |
| `displacementPx` | median displacement over the features this view and the last keyframe share |
| `translationDirectionDeg` | how far the translation *direction* has moved — the refusal's number |
| `sinceLastMs` | for the minimum and maximum interval |
| `keyframes` | the store's size, its evictions, and each eviction's reason |
| `staleKeyframes` | keyframes whose observations no longer reach `STALE_SURVIVAL_FRACTION` |
| `intervalStatic` | whether *every* frame since the last keyframe was still — KEY-002's subject |
| `poseState`, `poseAmbiguous`, `poseRotationConfidence`, `poseUnseparatedCandidates` | what Phase 6 said about the pose this decision was taken beside |
| `droppedIncrements`, `ambiguousPosesDeclined` | rotation the accumulator could not take: lost across a re-anchor, and refused because Phase 6 flagged it |
| `metronome` | what a fixed-interval selector would have inserted from the same stream |

---

## Test records

### KEY-001 — Selection on v3 §20's conditions · REQUIRED

- **Input:** a run where the camera moves, with the whole Phase 4–7 stack live beneath it.
- **Expected:** keyframes inserted when one of v3 §20's conditions is met and not otherwise.
- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_DECISIONS` decisions were judged;
  2. **every** insertion's recorded reason is re-derivable from the inputs recorded beside it —
     zero mismatches (Rule 002);
  3. no keyframe was inserted less than `MIN_KEYFRAME_INTERVAL_MS` after the previous one;
  4. no gap longer than `MAX_KEYFRAME_INTERVAL_MS` while the selector was running;
  5. at least one insertion fired on a **geometric** condition — rotation, displacement or
     quality — rather than every insertion being the maximum-interval heartbeat.
- **Failure condition:** an insertion whose reason its own numbers do not support; or a run in
  which every insertion is a heartbeat, which is a metronome wearing this phase's labels.

### KEY-002 — The stationary case · REQUIRED · **the gate**

v4 §20's *有効な視点*, tested from the side that separates a selector from a schedule.

- **Input:** a segment during which the camera does not move — the image is static, the median
  shared displacement stays below `KEYFRAME_DISPLACEMENT_PX` and the rotation below
  `KEYFRAME_ROTATION_DEG`.
- **Expected:** the selector inserts nothing but the maximum-interval heartbeat, while a
  metronome firing at `MIN_KEYFRAME_INTERVAL_MS` inserts one every half second.
- **Pass criteria:** all of —
  1. ≥ `MIN_JUDGED_DECISIONS` decisions were taken while the scene was static;
  2. **no** insertion fired on a geometric condition over an interval in which nothing moved;
  3. the metronome twin inserted at least **5×** as many keyframes over the same decisions —
     which is what `MAX_KEYFRAME_INTERVAL_MS / MIN_KEYFRAME_INTERVAL_MS = 10` allows, halved so
     the criterion is met by a selector that is right rather than by one that is lucky;
  4. the two selectors saw the same inputs, and the record says so by carrying both counts.
- **Failure condition:** a keyframe inserted for a geometric reason when nothing moved between it
  and the previous one; or a count equal to the metronome's, which is a metronome.
- **Excluded if:** the run contains no static segment. Reported `PENDING` with that reason.

> **Amendment, 2026-08-28 — narrowed, with the measurement that forced it and before any device
> leg ran.** Criterion 2 first read *no insertion **during that segment** carried a geometric
> reason*, counted per frame. That is too literal, and the automated leg found it: on one run in
> five it failed with **two `ROTATION` insertions on frames Phase 4 classified `STATIC`**.
>
> They were correct insertions. A geometric condition is accumulated over the **interval** since
> the last keyframe, not measured on the frame it fires on — a view 30 px from the last keyframe
> is 30 px from it whether or not the image happens to be still at the instant v3 §20's minimum
> interval elapses, and a rotation that accumulated while the camera turned does not un-accumulate
> when it stops. Firing at that boundary is the selector doing its job.
>
> What cannot honestly happen is a geometric condition firing when **nothing moved between the two
> views at all**, and that is what the criterion asks now. The record carries both counts, so the
> boundary insertions stay visible rather than being defined away: on the failing run, 2 landed on
> a still frame and 0 had a still interval behind them.
>
> This does not weaken what KEY-002 is for. A metronome inserting through a sustained still
> segment is caught by it exactly as before — `tests/unit/keyframes.test.ts` drives one and it
> still fails this record — and criterion 3's ratio is untouched.
>
> **It also leaves a residual**, which the amendment below measures. Narrowing the criterion did
> not make the leg green, and the cause was not what this paragraph first guessed.

> **Second amendment, 2026-08-28 — the residual, measured. The criterion did not change; the
> stage did.** With criterion 2 narrowed to the interval, the automated leg still failed about two
> runs in six — now with `ROTATION` firing over intervals in which **nothing moved at all**, which
> is precisely what this record exists to forbid. The paragraph above guessed the residual was
> accumulated noise. Guessing is not what this project does about a failing test, so the record was
> given the pose context beside each violation and the leg was run until it failed again:
>
> ```
> [p8] still-interval violation: ROTATION on 18.2051° / 0 px after 529 ms, 231 shared,
>      0 dropped increment(s) across 0 re-anchor(s); pose POSE, ambiguous true,
>      rotationConfidence 0.5693, 2 unseparated candidate(s)
> ```
>
> 18.2051° accumulated over 529 ms, on a lateral pan where the true rotation is zero, with the
> image still and 231 features shared between the two views. **No re-anchor was crossed**, so
> nothing was dropped and no epoch was chained — neither of the two amendments above is the
> explanation. And **every** violation, on every failing run, carried `ambiguous: true` with two
> unseparated candidates.
>
> That flag is Phase 6 saying it could not tell. On a static image the correspondences stop
> changing, cheirality stops separating the essential matrix's four decompositions, and the
> recovered rotation **alternates between two of them** — here about 18° apart, which is v3
> §20's 10° threshold crossed twice over by an artefact rather than by a camera. Phase 6 reports
> the pose it picked *and* flags the ambiguity in the same message; Phase 8 was reading the first
> field and ignoring the second.
>
> **The fix is in the stage, not in this plan.** `KeyframeStage.advanceRotation` now declines a
> pose flagged `ambiguous`: the accumulator holds at its last settled value, which is what
> "nothing new is known" looks like, and `ambiguousPosesDeclined` travels in every record so a
> reader can see how much of a run was declined rather than measured. This is v4 §25 —
> 低Confidenceの情報は、ゲーム生成やCollisionで重要度を下げるか使用禁止にする — applied one layer
> earlier than §25 names it: a confidence the layer below publishes is only worth publishing if
> the layer above acts on it.
>
> Six consecutive legs then passed, where the same leg had been failing about two in six. The
> committed evidence carries the numbers: 377 static decisions, 128 of them over intervals in which
> nothing moved, **0** geometric insertions over those intervals, 73 poses declined, and a
> metronome ratio of 13×.
>
> **This is the criterion holding, not the criterion being loosened to fit.** Criterion 2 is
> unchanged from the amendment above, and it is what caught this: a stage that accumulates a
> rotation the layer below refused to stand behind fails KEY-002, which is the right verdict.
> Declining is not free either, and the record says so — an interval spent entirely in ambiguity
> accumulates no rotation, so a real turn taken during one is under-reported by that much, and
> `ambiguousPosesDeclined` is what makes that visible instead of silent.

### KEY-003 — Bounded, and able to let go · REQUIRED

§56, §H.1, and v4 §20's *古い情報を盲目的に永久利用しない*.

- **Pass criteria:** all of —
  1. the store never exceeded `MAX_KEYFRAMES`;
  2. every eviction carries a reason naming which keyframe went and why;
  3. the most recent keyframe is never the one evicted;
  4. either an eviction occurred, or the run reports that the store never filled;
  5. eviction preserves viewpoint coverage at least as well as dropping the oldest would have:
     the retained set's median pairwise separation is recorded beside the counterfactual, and the
     policy is not worse on the majority of evictions.
- **Failure condition:** a store above the bound; an eviction with no reason; or the current
  keyframe evicted, which would leave the selector comparing against a view it has discarded.

### KEY-004 — What travels with a keyframe · REQUIRED

- **Pass criteria:** all of —
  1. every keyframe carries ≥ `MIN_KEYFRAME_OBSERVATIONS` observations, each with the feature id
     `FlowTracker` assigned, unique within the keyframe;
  2. every keyframe carries **its own** intrinsics, matching the frame geometry it was taken at.
     §H.0: a device rotation swaps the frame dimensions on the same track and every one of
     `fx, fy, cx, cy` changes with it, so a keyframe that borrowed the *current* `K` would be
     wrong for every view taken before the rotation — and Phase 9 triangulates from these;
  3. consecutive keyframes share ≥ `MIN_KEYFRAME_OBSERVATIONS` observations, or the record says
     why not;
  4. `SCALE: LOCAL_UNITS` on every record, and no position claimed anywhere.
- **Failure condition:** a keyframe with no observations, or one whose intrinsics belong to a
  different frame geometry than the one it was taken at.

### KEY-005 — The condition this phase refuses · REQUIRED

v3 §20's translation condition, and the reason it cannot be evaluated, as a value rather than an
omission — the shape IMU-006 established.

- **Pass criteria:** all of —
  1. `KEYFRAME_TRANSLATION_UNITS` appears in every decision record with its threshold and the
     state `UNMEASURED`, and the reason names the missing scale;
  2. **no** insertion cites it as its reason;
  3. the refusal carries a number: the angle between the current translation direction and the
     last keyframe's is measured and reported on every decision where both exist;
  4. `scale` reads `LOCAL_UNITS` throughout, and no record converts a direction into a distance.
- **Failure condition:** a decision that fired on a translation magnitude — there is no such
  magnitude in this build, so any is fabricated.

### KEY-006 — Staleness · REQUIRED

v4 §20's second line, made measurable.

- **Pass criteria:** all of —
  1. every retained keyframe's surviving-observation fraction is measured on every decision;
  2. a keyframe below `STALE_SURVIVAL_FRACTION` is marked stale and is **not** used as the
     partner for the displacement measurement;
  3. either at least one keyframe became stale during the run, or the run reports that none did
     — a run where nothing went stale is a legitimate result, an *unmeasured* staleness is not;
  4. staleness is a function of surviving observations only, never of age.
- **Failure condition:** a stale keyframe used as the comparison partner; or a keyframe retired
  because it was old rather than because it stopped describing anything.

### KEY-007 — Keyframe cost · ADVISORY

- **Pass criteria:** mean keyframe upkeep ≤ `KEYFRAME_BUDGET_MS` over ≥ 10 decisions.
- **Failure condition:** over budget. Advisory for §34 and §H.4's reason, and because §H has no
  line for this at all: whatever it costs is spent from margin that does not exist on paper.

### KEY-008 — Metadata honesty · ADVISORY

- **Pass criteria:** all of —
  1. every rate reported is in `0..1`;
  2. no Euler angle triple is emitted anywhere (§18);
  3. the store's size equals the number of keyframes it says it holds, on every decision;
  4. every decision's reason re-derives from its own inputs;
  5. no keyframe carries a position or a metric distance.
- **Failure condition:** any of the above unmet.

---

## What a pass requires, in full

KEY-001 through KEY-006 PASS on a `REAL_DEVICE` bundle.

**The automated leg can decide all six**, which is new: the instruments this phase is scored
against are a static segment and a metronome, and the harness can produce both. Phase 7's leg was
the first to decide one required record; Phase 8's decides its whole required suite. Rule 004 is
untouched and means exactly what it always meant — `DESKTOP_DEV` cannot pass a phase, and the
numbers a phone produces in a real room are not the numbers a synthetic pan produces.

The number that carries the phase is **KEY-002 criterion 3**: on a camera that is not moving, a
keyframe system and a metronome are the same program except for the one thing this phase is for.

## What this phase does not do, and says so

- **No relocalisation.** v3 §21 is a later phase; a keyframe store is one of its inputs, not its
  implementation. Nothing here searches for a previously seen view.
- **No keyframe imagery.** §H.1 budgets 30 downscaled grayscale frames at ≈16 MB for a
  relocaliser that does not exist yet. Phases 8, 9 and 10 need the observations and the pose, and
  storing pixels nothing reads would be carrying data no test can check. The decision is recorded
  here so the phase that needs them adds them deliberately.
- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes and it belongs to the phase that has
  a map to adjust. Phase 10 holds the map; the adjustment is not in Prototype v1's path to a ball
  game and is not implemented on speculation.
- **No change to Phase 5's anchor.** It stays exactly as it is, serving the phase that passed
  with it.
- **§33's `GOOD` stays unreachable**, for the fifth phase running and for the reason Phase 6
  gave: the state is computed in `FlowStage` from what Phase 4 measures, and plumbing a later
  phase's quantity into a passed phase's state machine is a change to Phase 4.
