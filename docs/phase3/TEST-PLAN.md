# Phase 3 — Feature Detection · Test Plan

Written **before** `src/tracking/FeatureDetector.ts` existed (§29). Criteria here may not be
relaxed after seeing a result.

Governing spec: §11 (Phase 3), §64 (Phase 3 Test), §51 (camera overlay), §52 (what runs in
the worker), §53–§55 (tiers and budgets), §57 (error states), §59 (determinism), §80
(absolute prohibitions), §82–§83 (architecture and dependencies), Rule 004, Rule 005. Plus
what Phase 2 measured on the device:
[`§H.2`](../00-IMPLEMENTATION-PLAN.md) and
[`§H.3`](../00-IMPLEMENTATION-PLAN.md) — in particular that full preprocessing at 720×1280
costs 10–11 ms per frame, leaving roughly 22 ms of the 33 ms budget for everything after it.

## Objective

Find real corners in the real camera image, distribute them across the frame so they do not
clump, keep the population topped up as it is consumed — and prove that the points are
image structure rather than coordinates the code made up.

**In scope:** Shi-Tomasi corner detection on the pyramid Phase 2 builds, the 8×6 grid, the
feature record of §11, the regeneration thresholds, and the measurement of all of it.

**Out of scope, deliberately (Rule 005):** optical flow (Phase 4) — nothing here follows a
feature from one frame to the next; geometric verification (Phase 5); pose (Phase 6).
Nothing in this phase produces or stores spatial data. A feature in Phase 3 is a 2-D point in
one image, and the UI says so rather than implying a tracked point.

## §64's four tests, and what they leave open

§64 names `FEAT-001` texture-rich wall, `FEAT-002` texture-poor wall, `FEAT-003` feature
grid distribution, `FEAT-004` feature regeneration, with the pass condition *"real image
features are detected"*. Four things it leaves open, resolved here rather than at judging
time:

1. **"Real image features" is the whole claim and has no stated test.** A detector that
   returns 800 plausible-looking coordinates per frame satisfies every count-based check
   §11 implies. §80 lists *Fake Feature Point* among the absolute prohibitions, so the
   burden is on this plan to make the claim falsifiable. It is: see **the contrast check**.
2. **Texture-rich and texture-poor are properties of the scene, not of the run.** Whether
   the tester pointed at a brick wall or a blank one cannot be asserted by the harness. It
   is measured from the image — see **classifying the scene** — so FEAT-001 and FEAT-002
   judge frames the pipeline itself identified, and both can occur in one run.
3. **Which pyramid level detection runs on.** §11 does not say. The choice is made below by
   arithmetic and then verified by measurement, and the evidence carries both.
4. **Four tests or six.** The union rule from Phases 1 and 2 applies again: §64's four are
   all REQUIRED, and two ADVISORY tests are added for facts §H and §80 require to be
   measured (detection cost; metadata that must stay unknown). Nothing is removed or
   weakened.

## Verdict algebra

Unchanged: `PASS` / `FAIL` / `PENDING`, any required `PENDING` holds the phase at `TESTING`,
and only a `REAL_DEVICE` leg can produce `PASSED` (Rule 004).

---

## Three things this phase must not be allowed to fake

### The contrast check — are these points image structure?

For every frame that is detected on, the worker also samples an equal number of positions
**at random from the same frame**, using the seeded `Rng` (§59 — the sampling is reproducible
and `Math.random` is banned in `src/` by an audit), and computes the same corner strength
there. It reports the mean at detected positions and the mean at random positions.

A working detector selects the strongest corners in the image; a detector emitting
coordinates unrelated to the pixels — from a table, a lattice, a previous frame, anything —
scores the same as chance. The check costs one extra evaluation per sampled point, not per
pixel.

> **Plan amendment, before the first run.** This section originally gated on the *ratio* of
> the two means, at ≥ 4.0. Unit testing against images with known corners showed that
> statistic measures the scene as much as the detector: on a dense pattern where nearly
> every pixel sits near an edge, the random control is itself highly textured, and a
> perfectly working detector scores **1.87** on a checkerboard. A brick wall or a carpet
> would have failed FEAT-001 with nothing wrong. The gate is now the **rank statistic** —
> the probability that a detected position out-textures a random one, ties counted as half.
> Chance is exactly 0.5 whatever the scene, by construction, so the distance from 0.5
> measures the detector rather than the wallpaper. The ratio is still recorded, because it
> is informative about the scene; it is simply not the criterion. This is a change of
> statistic, not a relaxation: the fabricated-lattice control that motivated the check still
> fails, and it now fails on scenes where the ratio would have passed it.

This is Phase 3's counterpart to Phase 2's provenance cross-check, and it is required for
the same reason: everything else about a feature set can be produced without a camera.

### Classifying the scene, from the image rather than from the tester

The worker reports the **mean gradient magnitude** of each detected frame over the whole
detection level. A blank wall produces sensor noise; a textured surface produces structure,
and the two are separated by nearly an order of magnitude. Frames are classified:

| Class | Mean gradient magnitude | What it is |
| --- | --- | --- |
| `TEXTURE_RICH` | ≥ 8.0 | something with structure in it |
| `TEXTURE_POOR` | ≤ 4.0 | a blank surface, or a lens against something featureless |
| `AMBIGUOUS` | between | judged by neither test |

The gap is deliberate. A single threshold would put borderline frames into whichever test
they happened to fall in; leaving a band that belongs to neither means both tests judge
frames that are clearly one thing or the other, and the count in each band is reported so a
run that produced only ambiguous frames is visible as such rather than as a pass.

**These two numbers are the least certain thing in this plan.** They are set from the
physics — a downsampled blank wall cannot produce a mean gradient of 8 without a sensor far
noisier than this one — but unlike Phase 1's MAD floor they have not yet been measured
against a real blank wall. The evidence records the full distribution of the measure, so if
the band turns out to sit in the wrong place the run says so instead of quietly passing.

### Metadata that Phase 3 cannot know stays unknown

§11 lists eight fields per feature. Four of them are Phase 3's to fill: `id`, `position`,
`cornerStrength`, `qualityScore`. `age` and `trackLength` are meaningful but trivial at
detection — a newly detected feature has age 0 and has been seen once. The remaining two,
`forwardBackwardError` and `reprojectionError`, **cannot exist before Phase 4 and Phase 6**,
and are `null`.

Not `0`. Zero is a value, and for an error term it is the *best possible* value — a feature
record carrying `forwardBackwardError: 0` reads as a perfectly tracked point, which is §80's
*Fake Confidence* written into a data structure. `null` says "not measured", which is true.
FEAT-006 checks it, because this is exactly the kind of thing that is easy to fix now and
impossible to find later.

The same rule governs `qualityScore`: at detection it is a function of corner strength and
nothing else, and it must not be inflated by terms whose inputs do not exist yet.

---

## Where the code lives, and one thing that moves

§82 places `FeatureDetector` in `tracking/`. §52 puts preprocessing *and* feature detection
in the worker. Phase 2 put the worker in `pipeline/`, and the architecture audit forbids
`pipeline` from importing `tracking` — so as written, the worker could not call the detector.

The audit rule is right and the worker's placement was wrong. §10's own diagram ends at
"Tracking Worker": the worker is not a pipeline component that happens to be off-thread, it
is the tracking stage, and preprocessing is merely the first thing it does. So:

- `pipeline/frameWorker.ts` becomes `tracking/trackingWorker.ts`, and imports the pyramid
  and message definitions from `pipeline/` (`tracking → pipeline` is permitted).
- `WorkerFramePipeline` no longer names a worker file. It receives a factory, and
  `src/main.ts` — the composition root, which belongs to no layer — supplies one.

`pipeline/` therefore still knows nothing about `tracking/`, which is what the rule protects.
This is a change to code that has already passed Phase 2, and is recorded as one in
`docs/PHASE-STATUS.md`; it moves no logic and changes no Phase 2 measurement.

## Which pyramid level detection runs on

Detection runs on **level 1** by default — half resolution — and the choice is arithmetic
before it is preference:

- §H budgets Shi-Tomasi at **≤ 8 ms amortised**, on refill frames only.
- Phase 2 measured the whole of preprocessing at 720×1280 (921 600 px) at **10–11 ms** on
  the device. Detection is materially more work per pixel than a grayscale conversion and a
  pyramid: gradients, three products, a windowed sum of each, and an eigenvalue.
- Level 1 is a quarter of the pixels (230 400), which is the difference between plausibly
  fitting the budget and certainly not.

The cost of that decision is position precision: a corner located to ±0.5 px at level 1 is
±1 px at level 0. Phase 4's pyramidal LK refines from an initial guess and is specified with
3 levels itself, so a level-1 seed is the resolution its own coarsest stages work at.

**The arithmetic is not accepted as the answer.** Once per run the pipeline also detects on
level 0 and records what it cost, so the evidence answers "could level 0 have been afforded
on this device?" with a measurement rather than the estimate above. The configured level and
both costs are in the bundle; if level 0 turns out to fit, the default is wrong and the
evidence will say so.

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `FEATURE_TARGET` | 800 | §11 initial |
| `FEATURE_MAX` | 1200 | §11 maximum |
| `FEATURE_MIN` | 200 | §11 minimum |
| `FEATURE_CRITICAL` | 80 | §11 critical |
| `REFILL_BELOW` | 500 | §11 regeneration |
| `EMERGENCY_BELOW` | 200 | §11 emergency regeneration |
| `DEGRADED_BELOW` | 80 | §11 → `TRACKING DEGRADED` (§57) |
| `GRID_COLS` × `GRID_ROWS` | 8 × 6 | §11 |
| `MIN_CONTRAST_ABOVE_CHANCE` | 0.75 | rank statistic, detected vs random positions; chance is 0.5 |
| `MIN_CONTRAST_SAMPLES` | 10 | enough frames for a median to mean anything |
| `TEXTURE_RICH_FLOOR` | 8.0 | mean gradient magnitude, 0–255 scale |
| `TEXTURE_POOR_CEILING` | 4.0 | as above; the gap between them is judged by neither test |
| `MIN_SCENE_FRAMES` | 15 | per class, before that class is judged |
| `DETECT_BUDGET_MS` | 8.0 | §H, amortised over frames since the last detection |
| `MIN_SEPARATION_PX` | 8 | non-maximum suppression radius at the detection level |

`MIN_CONTRAST_ABOVE_CHANCE` deserves its derivation. A detector emitting positions unrelated
to the image scores 0.5 exactly, by construction — the two samples come from the same
distribution. With 240 sampled positions the standard error of the statistic is about 0.02,
so 0.75 sits more than ten standard errors above chance and cannot be reached by sampling
noise. Measured against images with known corners it runs above 0.9; measured against a
fabricated lattice of evenly spaced coordinates on the same image it stays below 0.6. The
threshold sits in the wide gap between them, which is the same shape of argument Phase 1
used for its MAD floor.

---

## Test records

### FEAT-001 — Texture-rich wall · REQUIRED

- **Input:** the camera pointed at a surface with structure; frames the worker classified
  `TEXTURE_RICH`.
- **Expected:** features are found in useful numbers, and they are on real image structure.
- **Pass criteria:** all three —
  1. ≥ 15 `TEXTURE_RICH` frames observed;
  2. the median feature count over those frames is ≥ `FEATURE_MIN` (200), and no frame
     exceeded `FEATURE_MAX` (1200);
  3. **the contrast check holds**: over ≥ 10 sampled frames, the median probability that a
     detected position out-textures a seeded-random position in the same frame is ≥ 0.75,
     against a chance value of 0.5.
- **Failure condition:** counts inside the band but a contrast statistic at chance — that is
  a detector producing coordinates rather than finding corners, and it fails outright.
- **`PENDING`, not `FAIL`:** fewer than 15 texture-rich frames, or fewer than 10 contrast
  samples. Not having pointed the camera at anything is not a detector defect.

### FEAT-002 — Texture-poor wall · REQUIRED

- **Input:** the camera pointed at a blank surface; frames the worker classified
  `TEXTURE_POOR`.
- **Expected:** the feature count falls, the system says so, and it invents nothing.
- **Pass criteria:** all three —
  1. ≥ 15 `TEXTURE_POOR` frames observed;
  2. the median feature count over those frames is **materially below** the median over the
     `TEXTURE_RICH` frames — at most half — and no frame there reached `FEATURE_TARGET`;
  3. the engine reported `LOW FEATURE COUNT` (§57) on at least one frame where the count fell
     below `FEATURE_MIN`, and the reported state matches the count on every frame — the UI
     and the engine may not disagree (Rule 002).
- **Failure condition:** the count holding near target on a blank wall. A detector whose
  output does not depend on the image is the thing §80 prohibits, and this is the test that
  sees it from the other side: FEAT-001 shows the points are on structure, FEAT-002 shows
  they disappear when the structure does.
- **`PENDING`, not `FAIL`:** fewer than 15 texture-poor frames. Point the camera at a blank
  wall; it is a two-second thing and it is the whole test.

### FEAT-003 — Feature grid distribution · REQUIRED

- **Input:** the 8×6 grid quota selector, on `TEXTURE_RICH` frames.
- **Expected:** the grid demonstrably prevents the clumping §11 asks it to prevent.
- **Pass criteria:** all three —
  1. no cell ever held more than its quota, computed from the target and the cell count;
  2. over ≥ 10 comparison samples, the gridded selection's largest single-cell share of the
     total is **lower** than that of an ungridded top-N selection run on the very same frame,
     in the median case;
  3. the number of occupied cells is reported, and the gridded selection occupies at least
     as many cells as the ungridded one in the median case.
- **Failure condition:** any cell over quota; a grid that does not measurably reduce
  clustering against its own ungridded control.
- **Not accepted as a pass:** an even distribution on a scene that was evenly textured
  anyway. Criterion 2 is a paired comparison on the same frame, so a scene that would have
  been evenly distributed regardless produces no difference and no pass — the test measures
  the grid, not the wallpaper.

### FEAT-004 — Feature regeneration · REQUIRED

- **Input:** the feature population as the scene changes; §11's thresholds.
- **Expected:** the population is topped up when it is consumed, at the levels §11 names, and
  the state reported matches.
- **Pass criteria:** all four —
  1. at least one refill was triggered by the count falling below `REFILL_BELOW` (500), with
     the count before and after recorded;
  2. every refill measurably raised the count, or the frame's own candidate supply is
     recorded as exhausted — a refill that achieved nothing on a frame that had corners
     available is a broken mechanism;
  3. every threshold crossing §11 names that actually occurred is recorded with the state it
     produced: < 500 refill, < 200 emergency refill, < 80 `TRACKING DEGRADED`;
  4. the count never exceeded `FEATURE_MAX` after a refill.
- **Failure condition:** a threshold crossed with no response; a refill that raised nothing
  where candidates existed; a count above the maximum.
- **`PENDING`, not `FAIL`:** no crossing of `REFILL_BELOW` observed at all. On a
  well-textured scene held still, the population may simply never fall — which is the
  mechanism not being exercised rather than failing. Pointing the camera at a blank wall and
  back exercises it, and is the same movement FEAT-002 needs.

### FEAT-005 — Detection cost · ADVISORY

- **Input:** the measured cost of each detection, and the frames between detections.
- **Expected:** detection fits §H's amortised budget, and the level chosen for it is
  justified by measurement rather than by the estimate in this plan.
- **Pass criteria:** mean detection cost amortised over the frames since the previous
  detection is ≤ 8.0 ms, over ≥ 10 detections.
- **Also required to be recorded, whatever the verdict:** the one-off level-0 calibration
  cost, so the level choice is answerable from the evidence.
- **Failure condition:** over budget. Advisory because §34 ranks correctness above
  performance — but being advisory does not make it optional to measure.

### FEAT-006 — Metadata honesty · ADVISORY

- **Input:** the feature records themselves.
- **Expected:** every field §11 lists is present, and the fields Phase 3 cannot know are
  `null` rather than a number.
- **Pass criteria:** all four —
  1. every record carries all eight §11 fields;
  2. `forwardBackwardError` and `reprojectionError` are `null` on every record — Phase 4 and
     Phase 6 fill them, and until then a number would be invented;
  3. `id` is unique within a frame, and `position` lies inside the frame;
  4. `cornerStrength` and `qualityScore` are finite, and `qualityScore` is a monotone
     function of `cornerStrength` alone — nothing else is known yet to put into it.
- **Failure condition:** any of the above unmet. Advisory only because it is a property of
  the code rather than of the device, and is covered by unit tests as well.

---

## What a pass requires, in full

- A real camera and a real iPhone Safari frame path (Rule 004). The automated Chromium leg
  cannot pass this phase; its synthetic camera is a rolling gradient, which is neither a
  textured wall nor a blank one.
- The tester must point the camera at **both** a textured surface and a blank one, or
  FEAT-001, FEAT-002 and FEAT-004 stay `PENDING` and the phase stays at `TESTING`. This is
  the same shape as Phase 1 needing two permission scenarios, except that both can be
  observed in a single run by moving the camera.
- The evidence bundle must carry the full detection context — per-class frame counts and the
  gradient-magnitude distribution behind them, contrast samples, grid comparisons, refill
  events with counts either side, detection costs and the level-0 calibration — and pass the
  same integrity scan every other bundle does.
