# Phase 2 — Frame Pipeline · Test Plan

Written **before** `src/pipeline/` existed (§29). Criteria here may not be relaxed after
seeing a result.

Governing spec: §10 (Phase 2), §63 (Phase 2 Test), §52–§56 (performance architecture,
adaptive rules, targets, memory), §57 (error states), §59 (determinism), §80 (anti-fake),
Rule 004, Rule 005. Plus two measurements this repository already made:
[`§H.0`](../00-IMPLEMENTATION-PLAN.md#h0-rotation-changes-the-camera-intrinsics) (rotation
changes the frame geometry) and
[`§H.1`](../00-IMPLEMENTATION-PLAN.md#h1-a-measurement-that-puts-the-acquire-budget-in-doubt)
(main-thread `getImageData` costs 13.8 ms on the device and cannot be the acquire route).

## Objective

Supply frames from the camera to a tracking worker, continuously and at a stable rate,
with the heavy per-frame work off the UI thread — and prove that what reaches the worker is
the real camera image rather than something the pipeline made up.

**In scope:** frame scheduling, acquisition route selection, worker preprocessing
(grayscale + 3-level pyramid), backpressure, processing-resolution tiers, target-FPS
adaptation, per-frame source geometry, and the measurement of all of it.

**Out of scope, deliberately (Rule 005):** feature detection (Phase 3), optical flow
(Phase 4), pose (Phase 6). Nothing in this phase produces or stores spatial data. The
pyramid this phase builds is consumed by nothing yet, and that is stated in the UI rather
than disguised with a placeholder overlay.

## Resolving §10 against §63 (§34)

§10 states the objective, the ordering of routes (Worker → OffscreenCanvas → WebAssembly →
WebGPU), the resolution ladder (960×540 initial, 640×360 low, 1280×720 high, 4K tracking
prohibited) and the FPS ladder (30 initial, 20 low, 15 minimum). §63 names four tests —
`FRAME-001` 30-second frame supply, `FRAME-002` worker processing, `FRAME-003` resolution
fallback, `FRAME-004` FPS adaptation — and the pass condition *"frame drop is within
tolerance and supply to tracking is stable"*.

Three things §63 leaves open, resolved here rather than at judging time:

1. **"Within tolerance" is not a number.** §63 does not give one, so this plan sets the
   thresholds below and fixes them before the run. They are derived from §10 and §55, not
   chosen to be reachable: the delivered-rate floor is §10's own 15 FPS minimum, and the
   UI-thread budget is §55's 16.7 ms.
2. **What counts as a drop.** A frame the scheduler deliberately declines because the
   target rate is 20 FPS and the camera delivers 30 is *not* a drop — it is the pacing
   working. A frame admitted and then lost is. The two are counted separately and only the
   second is held against the tolerance.
3. **Four tests or six.** The union rule from Phase 1 applies again: §63's four are all
   REQUIRED here, and two ADVISORY tests are added for facts §55 and §H.0 require to be
   measured (UI-thread cost; per-frame source geometry). Nothing is removed or weakened.

## Verdict algebra

Unchanged: `PASS` / `FAIL` / `PENDING`, any required `PENDING` holds the phase at
`TESTING`, and only a `REAL_DEVICE` leg can produce `PASSED` (Rule 004).

## Two things this phase must not be allowed to fake

**A pipeline that reports throughput while processing nothing real.** Frame counters,
latency histograms and a tier ladder can all be produced by a loop that never touches a
camera pixel. So FRAME-002 does not accept "the worker returned a result"; it requires the
worker's own grayscale to agree with an independent measurement of the same video frame
taken on the main thread at the same instant (the *provenance cross-check* below).

**Adaptation that is asserted rather than caused.** A controller can be made to print
"tier: REDUCED" without any measurement behind it. So FRAME-003 and FRAME-004 require the
processing resolution and target rate to have *actually changed* — read back from the
dimensions of buffers the worker really produced — and require the change to be traceable
to a recorded latency measurement.

### The provenance cross-check

Once per second, in the same `requestVideoFrameCallback` callback that hands a frame to the
worker, the main thread also takes its own 64×48 sample of that same video frame and
records its mean luma. The worker independently reports the mean luma of its level-0
grayscale for the frame carrying the same `frameId`. Because both derive from one video
frame, area-averaging preserves the mean, and the two numbers must agree.

This costs about 13.8 ms on the device (§H.1) — which is exactly why it runs at 1 Hz and is
reported as instrumentation, excluded from the pipeline's own UI-thread cost in FRAME-005
and shown separately.

**Agreement only means something if the scene moved.** Pointed at a motionless wall, a
worker emitting a frozen image agrees with the camera perfectly. So the check also measures
the spread of the *main thread's own* readings, and that spread does two jobs: below
`MIN_SCENE_STDDEV` the test is `PENDING` rather than passing on an uninformative agreement,
and above it the tolerance becomes the tighter of a fixed ceiling and half the spread. A
frozen series sits roughly 0.8 standard deviations away from a varying one, so half a
standard deviation is a bound a frozen or stale image cannot meet *at any scale* — where a
fixed ceiling alone could be cleared by accident on a scene that barely moved. Phase 1
measured mean luma ranging over 58.7–184.4 across a single 42 s pan, so an ordinary handheld
scan clears the variation floor many times over.

### Stress injection, and why it is not simulation

FRAME-003 and FRAME-004 require the pipeline to *degrade*. A device that comfortably meets
its budget will never degrade on its own, and waiting for one that cannot is not a test.

So the harness can inject additional **real** work into the worker's per-frame path — a
declared number of extra passes over the pyramid it genuinely built. Everything downstream
is then real: the latency is measured, not asserted; the controller sees only measurements;
the resolution and rate it selects are read back from what the worker actually produced.

What is injected is a *stimulus*, not a *result* (§28). The evidence records that it was
injected, how much, and over which interval, and the tests report a stress-induced
adaptation as stress-induced. A run where the device also degraded spontaneously would be
recorded as a separate, more serious fact.

**FRAME-001 excludes stressed intervals.** Continuity is a claim about the pipeline in
normal operation, so the 30-second window must be a contiguous interval during which no
load was injected. Stressed intervals are measured and reported, never counted toward it.

## Tier ladder (§53, §10)

The ladder is a single ordered list, because §54 requires resolution to be given up before
frame rate, and one list makes that ordering structural rather than a matter of care:

| Step | Tier | Processing resolution (long × short edge) | Target FPS |
| --- | --- | --- | --- |
| 0 | HIGH | 1280 × 720 | 30 |
| 1 | BASIC | 960 × 540 | 30 |
| 2 | BASIC | 960 × 540 | 20 |
| 3 | REDUCED | 640 × 360 | 20 |
| 4 | REDUCED | 640 × 360 | 15 |

Start at step 1, which §H names as the default start. Step 4 is the floor: §10 sets 15 FPS
as the minimum and the controller may not select a target below it. Step 0 exists and is
reachable by recovery, but is never entered before the pipeline has measured itself.

Resolution is expressed as edges, not as a fixed width and height, because §H.0 measured
that rotation swaps the source dimensions. The processing size for a frame is derived from
*that frame's* source size, preserving aspect ratio and never upscaling. 4K is unreachable
by construction: the ladder's ceiling is 1280 × 720 and the derived size never exceeds the
source (§10, "4K direct tracking prohibited").

## Thresholds, fixed here

| Symbol | Value | Where it comes from |
| --- | --- | --- |
| `REQUIRED_PIPELINE_MS` | 30 000 ms | §63 FRAME-001 |
| `MIN_DELIVERED_FPS` | 15 | §10 minimum processing FPS |
| `MAX_RESULT_GAP_MS` | 2000 ms | same tolerance Phase 1 used for frame arrival |
| `MAX_LOST_RATIO` | 0.02 | of *admitted* frames; a lost frame is a defect, paced-out frames are not |
| `MIN_WORKER_SHARE` | 0.90 | §10: heavy processing may not run on the UI thread |
| `UI_BUDGET_MS` | 16.7 ms | §55 UI-thread target |
| `WORKER_TARGET_MS` | 33 ms | §55 ideal tracking-worker mean |
| `WORKER_CEILING_MS` | 50 ms | §55 hard ceiling |
| `MAX_LUMA_DISAGREEMENT` | 10 / 255 | provenance cross-check, ceiling on the median absolute difference |
| `MIN_SCENE_STDDEV` | 3.0 / 255 | below this the scene did not vary enough for the check to be informative |
| `MAX_DISAGREEMENT_SCENE_FRACTION` | 0.5 | the agreement bound also scales with the scene's own spread |
| `MIN_CROSSCHECKS` | 5 | enough for a median to mean anything |

---

## Test records

### FRAME-001 — 30 seconds of continuous frame supply · REQUIRED

- **Input:** an open camera; the pipeline running with its scheduler driven by
  `requestVideoFrameCallback`; no load injected.
- **Expected:** frames reach the worker and results return continuously for at least
  30 000 ms, at or above the delivered-rate floor, with no stall beyond tolerance.
- **Pass criteria:** the longest *unstressed* contiguous segment is ≥ 30 000 ms; within it
  the mean delivered rate (worker results per second) is ≥ 15; the longest gap between
  consecutive results is ≤ 2000 ms; lost frames are ≤ 2 % of admitted frames; the page was
  never hidden during the segment.
- **Failure condition:** any of the above unmet. Never starting the pipeline is `PENDING`,
  not `FAIL` — an absence of an attempt is not a failure of continuity.
- **Not accepted as a pass:** frames counted at the scheduler rather than at the worker's
  returned results. The claim is about supply *to tracking*, so it is measured at the far
  end of the pipeline.

### FRAME-002 — Worker processing, on real camera pixels · REQUIRED

- **Input:** the acquisition route selected by the runtime probe; the preprocessing worker;
  the 1 Hz provenance cross-check.
- **Expected:** preprocessing runs in a worker global scope, on pixels that came from the
  camera, producing a grayscale pyramid whose geometry is self-consistent.
- **Pass criteria:** all four —
  1. **Off the UI thread.** The worker reports a scope with no `document` and a real
     `WorkerGlobalScope`, and ≥ 90 % of completed frames were processed there.
  2. **Real pixels.** ≥ 5 provenance cross-checks, with median absolute mean-luma
     disagreement between the worker's level-0 grayscale and the main thread's independent
     sample of the same video frame within tolerance — the tighter of 10/255 and half the
     scene's own standard deviation.
  3. **A scene that moved.** The main thread's own luma readings varied by at least
     `MIN_SCENE_STDDEV`. Below that, criterion 2 cannot distinguish a working pipeline from
     a frozen one, so the test is `PENDING`, not `PASS`. The worker's own frame-to-frame
     difference on its strip and level-2 buffers is measured and reported alongside.
  4. **Self-consistent pyramid.** Three levels; each level's byte length equals its
     reported width × height; each level is the halving of the one above it (±1 for odd
     sizes); level 0 matches the processing size derived for that frame.
- **Failure condition:** criteria 1, 2 or 4 unmet. In particular, a cross-check median above
  tolerance fails the test outright: it means the worker's image is not the camera's image.
  Criterion 3 unmet is `PENDING`, not `FAIL` — a motionless scene is a fact about the test
  conditions, not a defect in the pipeline.
- **Not accepted as a pass:** the worker returning results at all, or a checksum that
  merely differs between frames. A frame counter and a random checksum are both trivially
  forgeable; the cross-check is not.

### FRAME-003 — Resolution fallback · REQUIRED

- **Input:** measured worker latency, rising under injected load until the controller
  steps down the ladder.
- **Expected:** the processing resolution really changes, and every frame respects the
  pixel budget of the tier in force when it was processed.
- **Pass criteria:** all four —
  1. the largest frame produced at the most-degraded tier is genuinely smaller than the
     largest produced at the least-degraded one, read from the dimensions of buffers the
     worker actually returned — not from the tier variable. Comparing the two tiers, rather
     than merely counting distinct sizes, is what makes a source rotation unable to
     manufacture a pass: rotation changes both ends together;
  2. at least one downward step is recorded with the latency measurement that caused it;
  3. no frame was ever processed above the pixel budget of its tier, and none above
     1280 × 720 (§10's 4K prohibition, enforced at the ladder ceiling);
  4. every processed size preserves its source frame's aspect ratio to within 2 % and never
     upscales.
- **Failure condition:** the tier changed but the produced buffers did not; any frame above
  its tier's budget; an aspect-ratio break; any upscale.
- **`PENDING`, not `FAIL`:** no downward step yet, or a ladder that has so far moved only
  between steps sharing a resolution. The first is a test that has not been run; the second
  is FRAME-004's subject, not this one.
- **Reported, not judged:** whether the step down was caused by injected load or by the
  device's own inability to keep up. Both pass this test; they mean very different things,
  so the metrics say which, and a spontaneous degrade is also surfaced in the phase reason.

### FRAME-004 — FPS adaptation · REQUIRED

- **Input:** the same measured latency stream; the controller's target-rate ladder.
- **Expected:** the target rate adapts to measured load, never below §10's floor, and the
  adaptation has a measurable effect rather than only a visible one.
- **Pass criteria:** all four —
  1. the target rate changed at least once, and every value the controller selected is
     ≥ 15 FPS;
  2. each change carries the measurement that caused it (median worker latency over its
     decision window, and the budget it was compared against);
  3. the adaptation had an effect: after the last downward step **that lowered the
     processing resolution**, the median worker latency over the following window is lower
     than over the window that triggered it;
  4. once load was removed, the pipeline returned to ≥ 15 FPS delivered and the controller
     recovered at least one step upward.
- **Failure condition:** a selected target below 15 FPS; a change with no measurement
  behind it; a run in which the resolution ladder never moved; no recovery after load was
  removed; oscillation of more than 4 changes per 10 s, which would mean the hysteresis is
  not doing its job.
- **Not accepted as a pass:** a target rate that changed because a timer said so. §59
  applies: the controller is a pure function of its measurement window, and it is unit
  tested as one.

> **Plan amendment, after the first automated run.** Criterion 3 originally read "after the
> last downward step", with no qualification. That is the wrong measurement for half the
> ladder: steps 1→2 and 3→4 lower the *target rate* and leave the processing resolution
> alone, and lowering the rate cannot reduce the time one frame takes — it reduces how many
> frames are asked for. On the desktop leg the ladder's last move under load was exactly
> such a step, and the criterion read 34.9 ms → 39.5 ms and called a working mechanism
> broken. The criterion now names the last step that changed the resolution, which is the
> step whose effect per-frame latency can show. This narrows nothing: a resolution step that
> fails to reduce latency still fails, and a run where the resolution ladder never moved now
> fails criterion 3 outright rather than being judged on a step that could not have helped.
> FRAME-003 requires that same resolution step independently, so the two agree about what
> must have happened.

### FRAME-005 — UI-thread budget · ADVISORY

- **Input:** the synchronous cost of the pipeline's own work inside the
  `requestVideoFrameCallback` callbacks where a frame is admitted.
- **Expected:** the UI thread keeps a 60 Hz budget while the pipeline runs.
- **Pass criteria:** mean pipeline UI cost ≤ 16.7 ms and 95th percentile ≤ 16.7 ms, over
  ≥ 100 admitted frames, *excluding* the 1 Hz provenance cross-check, whose own cost is
  reported separately and in full.
- **Measured on the admitted frames only**, deliberately. A callback that declines a frame
  costs almost nothing, and averaging those in would dilute the statistic with the cheap
  case until it said nothing about the expensive one.
- **Failure condition:** either statistic over budget.
- **Advisory because** it is a performance target (§55), and §34 ranks correctness above
  performance: a pipeline that is provably correct and slightly over the UI budget must not
  be recorded as a phase failure. Being advisory does not make it optional to *measure* —
  the numbers are in the evidence either way.

### FRAME-006 — Source geometry is per-frame · ADVISORY

- **Input:** the device rotated while the pipeline runs, changing the source frame size
  (§H.0 measured 1280×720 ↔ 720×1280 on this platform).
- **Expected:** the pipeline treats source geometry as per-frame data: the processing size
  is re-derived, and the frame record carries the geometry Phase 6 will need for intrinsics.
- **Pass criteria:** at least two distinct source sizes observed; after the change, the
  processing size matches the size derived from the new source geometry within one frame;
  every completed frame record carries its own source width, height and derived processing
  size.
- **Failure condition:** the processing size stays derived from a stale source size, or
  frame records share a single session-wide geometry.
- **Advisory because** it depends on the tester rotating the device, and because its
  consequence lands in Phase 6. `PENDING` when no rotation occurred, never an assumed pass.

---

## What a pass requires, in full

- Two device facts that cannot be produced on a desktop: a real camera, and a real iPhone
  Safari frame path. Rule 004 stands — the automated Chromium leg cannot pass this phase,
  and its bundles are labelled `DESKTOP_DEV`.
- The tester must exercise the load path at least once, or FRAME-003 and FRAME-004 stay
  `PENDING` and the phase stays at `TESTING`. This is deliberate: an adaptive pipeline
  whose adaptation has never run is not a demonstrated adaptive pipeline.
- The evidence bundle must carry the full pipeline context — route probe results, per-tier
  frame counts, latency distributions, controller decisions with their inputs, cross-check
  samples — and pass the same integrity scan every other bundle does.
