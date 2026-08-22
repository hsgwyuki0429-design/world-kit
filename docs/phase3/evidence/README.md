# Phase 3 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase3-real-device-TESTING-2026-08-22T01-57-31-596Z.json` | `REAL_DEVICE` | No — `TESTING`. The record of the first defect only a device could find |
| `phase3-real-device-TESTING-2026-08-22T01-57-31-596Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase3-real-device-TESTING-2026-08-22T02-35-08-088Z.json` | `REAL_DEVICE` | No — `TESTING`. The record of the **second** defect: the first fix was incomplete |
| `phase3-real-device-TESTING-2026-08-22T02-35-08-088Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase3-real-device-FAILED-2026-08-22T03-00-47-526Z.json` | `REAL_DEVICE` | No — **`FAILED`**. Detection finally ran; FEAT-002 caught the detector admitting noise |
| `phase3-real-device-FAILED-2026-08-22T03-00-47-526Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase3-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase3-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

**There is no Phase 3 pass yet.** Rule 004 stands: only a `REAL_DEVICE` bundle from
iPhone + Safari + HTTPS can pass a phase, and the three required tests that carry this
phase's meaning cannot be decided by the leg below at all. Produce one by following
`../HOW-TO-RUN-DEVICE-TEST.md`. Regenerate the desktop bundle with `npm run test:e2e:phase3`.

## The device run of 2026-08-22, and the defect it found

iPhone / iOS 18.7 / Safari 26.6 over HTTPS. Phases 0, 1 and 2 passed in the same session, so
the lock opened honestly and `devEntry` is `false`. The pipeline ran, preprocessed **2190
frames**, lost none, and held `HIGH 1280×720@30` at 29.55 fps.

**Detection ran on zero of them.** The screen said `DETECTING`. The error log was empty.

| | |
| --- | --- |
| Pipeline | running, 2190 completed, 0 lost, route `VIDEO_FRAME` |
| Detections | **0** |
| Everything downstream | 0 features, 0 contrast samples, 0 refills, no gradient histogram |
| Verdict | `TESTING` — FEAT-001..004 all `PENDING` |

### Why

Phase 3 is reached from a PIPELINE screen whose pipeline is still running — it has to be
still running, because that is how Phase 2 passes. `onStartPhase3` opened with

```ts
if (this.cameraOpening || this.pipeline.isRunning()) return;
```

which reads as "already started" but on this path means "Phase 2 is still going". So
START DETECTION returned immediately, `setTrackingOptions` was never called, the worker was
never asked to detect, and the per-frame tick that refreshes the options was never started.
The pipeline went on preprocessing 2190 frames for a stage that had never been switched on.

The screen showed `DETECTING` because its running flag was `pipeline.isRunning()` too — the
same wrong idea in the other place it mattered. That is a Rule 002 violation in its own
right, and it is what made the defect look like a rendering bug: a lit control over an
engine doing nothing.

### The fix

- Detection's own state (`trackingRequested`) is what the guard tests, not the pipeline's.
- A running pipeline is **adopted** rather than treated as an obstacle: the camera and worker
  stay as they are and only the tracking options change. Starting a pipeline is now the
  fallback for when there is none.
- If `pipeline.start` refuses, the options are taken back rather than left standing for a
  worker that will never see them.
- One `isDetecting()` — both halves, detection asked for *and* a pipeline running — is read
  by the screen, the tests and the evidence, so the three cannot drift apart again.
- Phase 2's injected load is turned off when the pipeline is adopted. Stress inflates worker
  latency, which moves the tier, which sets the resolution Phase 3 detects on; it has no
  business in a measurement of the detector. The handover in that device run happened to
  have stress already off, so it changed nothing there — but it would have on another run.

### Why the automated leg missed it, and does not any more

The leg entered Phase 3 cold, through the development override, with no pipeline running —
a sequence no device ever takes. It now walks the device's path: enter Phase 2, start the
pipeline, **turn stress on**, hand a live and stressed pipeline over to Phase 3, then start
detection. Run against the old code that sequence times out waiting for the first detection,
which is what it should do.

The leg also carries the Rule 002 tripwire in one line: a run that reports `DETECTING` for
the whole hold and has detected nothing fails, whatever the tests say. That is the exact
signature of this defect — 2190 frames preprocessed, 0 detected, button lit.

### What the device run still tells us

Not nothing. The bundle records Phases 0–2 passing on the device in the same session,
`devEntry: false`, `previewPresented: true`, an empty error log, and a pipeline that held the
top tier at 29.55 fps for 91 seconds while Phase 3's screen was open. The Phase 3 evidence
path — bundle shape, verdict derivation, `PENDING` reporting, the download naming itself
`TESTING` rather than a pass — all worked. The phase correctly refused to claim anything.

It is kept for the same reason Phase 1 keeps its `FAILED` bundle: the record of a defect is
evidence too, and deleting it would leave the fix looking like a change with no cause.

## The device run of 02:35, and the defect the first fix left behind

Same session shape as before: Phases 0, 1 and 2 all `PASSED` on the device, `devEntry: false`,
pipeline live at `HIGH 1280×720@30`, 1662 frames preprocessed, 0 lost, empty error log.
**Detections: 0 again.**

But for a different — and worse — reason, and the bundle proves which one.

### The proof, from the evidence alone

| Fact in the bundle | What it rules out |
| --- | --- |
| The last log line is `phase 3: IMPLEMENTING -> TESTING` at the moment the screen opened | Nothing ran afterwards |
| `createdAt` is **2 ms after** that transition, and the Phase 3 tick rebuilds the bundle every 500 ms | The tick never started |
| No `adopted the running Phase 2 pipeline` line, which the fix logs unconditionally | `onStartPhase3` was never entered |
| The screenshot nonetheless shows **DETECTING**, greyed, with STOP enabled | The control was in a detecting state the engine was never in |

The last two together are decisive. `trackingRequested` is set and the tick is started in the
same block, immediately followed by `evaluatePhase3()`; any render showing `DETECTING` must
come after that. A frozen `createdAt` and a lit `DETECTING` cannot both happen — unless the
control was never reading `trackingRequested` at all.

### The defect

The previous fix routed the screen's *stats*, the tests and the evidence through one
`isDetecting()` predicate — and left the one prop that actually drives the button behind:

```ts
running: this.pipeline.isRunning(),   // in the Phase 3 view model
```

`vm.running` sets both the label and `disabled`. So arriving at FEATURES over Phase 2's
still-running pipeline, the button rendered **`DETECTING`, disabled, before anyone touched
it**. The user could not start the run at all.

That is strictly worse than the bug it replaced. Before, the button was pressable and did
nothing. After, it was not pressable. Both are the same underlying error — "the pipeline is
running" read as "detection is running" — and fixing it in three places out of four fixed
nothing a person could see.

```ts
running: this.isDetecting(),
```

### Why the leg still missed it

Because the leg called `startDetection()` through the debug API. **The engine was reachable;
the button was not**, and a harness that reaches past the DOM cannot tell those apart.

The leg now presses the control a person presses. Before clicking it asserts the button reads
`START DETECTION` and is enabled; after detections begin it asserts the button reads
`DETECTING` and is disabled. Run against the broken code it fails with exactly the user's
experience:

```
Error: START DETECTION is not pressable on arrival: label "DETECTING", disabled true.
The screen is reporting a detection state the engine is not in, and a person could not
start the run at all
```

Two device runs found two faces of one error, and the second was introduced by the fix for
the first. The lesson recorded in §H.5 stands and gains a clause: **one predicate is only one
predicate if every reader uses it — including the view model.** A consolidation that misses
the reader the user can see is not a consolidation.

## The device run of 03:00 — detection ran, and the phase FAILED correctly

The first run in which detection actually worked: 2325 detections, 556 features on screen,
FEAT-001, 003, 004, 005 and 006 all PASS. **FEAT-002 FAILED**, and it was right to.

| | Measured on the device |
| --- | --- |
| Blank surface | 1127 frames, mean gradient **3.14**, median **429** features, max **800** |
| Textured surface | 39 frames, mean gradient 10.65, median 800 features |
| Contrast above chance | **76.3 %** — against 97 % on the desktop leg, and a 75 % threshold |
| States | `FEATURES_OK` 2290, `LOW_FEATURE_COUNT` 111, `TRACKING_DEGRADED` 5 |

FEAT-002 requires the population to fall on a blank wall. It did not: 429 against 800, where
the test asks for at most 400, and **blank frames still reached the full 800 target**.

The user's report was that the points on screen did not correspond to the camera image at
all. Both observations have one cause.

### The cause

```ts
const threshold = maxScore * this.config.qualityLevel;   // qualityLevel = 0.01
```

The corner-strength floor was **a fraction of the frame's own strongest response, and
nothing else**. On a blank wall the strongest response is noise, so the floor becomes 1 % of
noise, every noise local-maximum clears it, and the detector fills to its 800 target with
whatever the sensor happened to produce. That is why the count did not fall, why the contrast
statistic sagged to 76 % — most points were on nothing, diluting the ones that were on
corners — and why the overlay looked unrelated to the scene: **it was drawing hundreds of
points that were not on anything a person could see.**

A relative floor cannot express "this frame contains no corners", because it is defined
relative to the best corner in the frame. It always finds one.

### The fix, and why this constant

```ts
const threshold = Math.max(maxScore * this.config.qualityLevel, this.absoluteScoreFloor());
```

`gx` is a central difference halved, so it is exactly **intensity levels per pixel** — the
same units as `TEXTURE_POOR_CEILING`, the value this phase already uses to call a whole frame
blank. A corner is now required to be locally at least as strong as the boundary the phase
already draws between "blank" and "ambiguous". No new number was invented, and none was
chosen by trying values until FEAT-002 passed: it reuses a constant fixed in the test plan
before any of this was measured.

The floor is derived from the config rather than written down, because the box filter is a
running *sum*: applied separably `blurPasses` times with radius r, a flat field of v leaves
`(2r+1)^(2·blurPasses)·v` behind. At r=2 and 2 passes that is 625, so the floor is
625 × 4² = 10 000. A unit test pins that arithmetic against the config rather than trusting
the comment.

**FEAT-002 was not touched.** The test was correct, it failed, and the code changed. That is
the arrangement working.

## The overlay geometry was investigated and is not the defect

Worth recording, because the obvious reading of "the points do not match the image" is that
the overlay is rotated or mis-scaled, and it is not.

Nothing in the repository could previously have told the difference, and that is arithmetic
rather than an oversight:

- the detector's unit tests run on a Float32 image built in memory, never crossing the
  video → `VideoFrame` → canvas → `getImageData` → pyramid path where an orientation error
  would live;
- Phase 2's provenance cross-check compares the **mean** luma of the worker's grayscale
  against an independent read of the same frame — and a mean is invariant to a rotation, a
  flip and a transpose, so a scrambled buffer passes it perfectly;
- FEAT-001's contrast statistic is computed inside the worker on the same buffer the detector
  used, so it scores just as well on a buffer unrelated to what the camera is pointing at;
- and the synthetic camera the other legs use is a smooth rolling gradient with no landmark
  whose position could disagree with anything.

So `scripts/run-e2e-phase3-alignment.mjs` now feeds Chromium a video whose bright blocks sit
at known, deliberately asymmetric positions — three blocks and one empty quadrant, so that no
rotation or reflection maps the set onto itself — and asserts three things: that the overlay
canvas covers exactly the video's box, that their aspects agree, and that the corners land on
the blocks.

It passes **12 of 12 points on the three blocks, 4 per block, 0 in the empty quadrant**. A
direct scoring of the overlay positions against the main thread's own read of the video, over
seven candidate transforms, put the identity at 70× the random baseline and every rotation,
flip and transpose at zero.

The overlay draws where the detector found things. The problem was what the detector was
finding.

## What the desktop leg exercises

One browser, one continuous 30-second detection run against Chromium's synthetic camera,
entered through the development override (`phaseContext.devEntry: true`, gated on the leg
being `DESKTOP_DEV`, exactly as in Phase 2).

| | Measured |
| --- | --- |
| Detections | 568 frames, all at level 1 (480×270) of a 960×540 base |
| Detection cost | **7.98 ms** mean against the §H budget of 8 ms; see below on why this leg does not gate on it |
| Level 0 calibration | 960×540 would have cost **83.2 ms** for 90 features |
| Scene | 565 frames `TEXTURE_POOR` (median gradient ~0.7), 0 rich, 0 ambiguous |
| Population | median 45 features; `TRACKING_DEGRADED` throughout |
| Contrast | 67 samples, **97.2 % above chance** (50 % would be a detector unrelated to the image) |
| Grid | 67 comparisons taken, **0 binding** — no cell ever came near its quota of 17 |
| Refills | 200, all `EMERGENCY`, 128 of them finding the frame exhausted |
| Quota breaches | 0 |
| State mismatches | 0 (Rule 002) |
| Metadata | 8 records sampled; `forwardBackwardError` and `reprojectionError` `null` throughout |
| Error log | empty |

Verdict: `TESTING` — `PENDING: FEAT-001, FEAT-002, FEAT-003`. The leg exits 0 because the
tests it cannot decide are excluded from its gate with their reasons printed, not because
they passed.

### The one number here that is not free

**95.9 % above chance.** The rest of the table could be produced by a loop that never looked
at a pixel: a count, a cost, a state name. The rank statistic cannot — it is the probability
that a position the detector chose out-textures a position drawn at random from the same
frame, and a detector emitting coordinates unrelated to the image scores 0.5 by construction,
whatever the scene. On a rolling gradient whose median gradient magnitude is under 1 — barely
above sensor noise — the detector still picked structure over chance 24 times out of 25.

FEAT-001 is excluded from this leg regardless, because that gradient never reaches the
texture-rich floor. The statistic is reported anyway: it is the one piece of provenance the
synthetic camera can still supply.

## Three tests this leg cannot decide, and why

The synthetic camera is a rolling gradient. It is neither a textured wall nor a blank one,
and three of Phase 3's four required tests are defined against those two scenes. Where the
run produced too few frames of a class, the test reports `PENDING` honestly and the leg
excludes it with that reason printed, rather than counting an undecided test as decided.
Feeding in a video chosen to clear the bars would make the leg green without making it
informative.

| Test | Why the leg cannot decide it |
| --- | --- |
| **FEAT-001** | 0 texture-rich frames of the 15 required. The scene's median gradient is 0.689 against a rich floor of 8.0. |
| **FEAT-002** | The comparison needs *both* classes; this run had 565 poor frames and 0 rich ones. A run with only blank frames cannot decide it any more than a run with neither. |
| **FEAT-003** | 0 of 67 comparisons had the quota bind. With 45 features across 48 cells the gridded and ungridded selections are byte-identical, and comparing them says nothing about the grid. |

FEAT-004 *is* decidable here, and passes for a reason worth stating: the synthetic camera is
so sparse that the population sat below the emergency threshold for the whole run, so the
refill ladder ran 200 times and 128 of those found nothing left to add. That is a scene with
no corners in it, not a mechanism that failed — the relaxed pass genuinely exhausted the
frame.

### And a fourth, for a different reason

**FEAT-005 is excluded too, whichever way it lands.** It read `FAIL` at 9.36 ms and `PASS` at
7.49 ms on consecutive runs of identical code. Not because either measurement is wrong — both
are right, and both stay printed and stay in the bundle
— but because §H's 8 ms is a budget for the iPhone's tracking worker, and this is headless
Chromium with SwiftShader on a shared CPU. Consecutive runs of identical code measured
**7.49 ms, 7.98 ms and 9.36 ms**, straddling the threshold on machine contention and on which part of
the synthetic camera's cycle the run happened to catch. A number that flips a verdict without
the code changing is not deciding anything about the code.

The line is the test plan's own, not one drawn after seeing a result: FEAT-005 is advisory
because it is "a property of the device rather than of the code", where FEAT-006 is advisory
because it is a property of the code. FEAT-006 gates this leg. FEAT-005 does not, and the
device run decides it.

What replaces it is a named tripwire with its own number: **24 ms**, which the leg checks and
prints on every run. That is not a relaxed budget — it sits between the correct
configuration's observed spread (7.5–9.4 ms) and the misconfiguration it exists to catch,
since detecting on level 0 by mistake measured 45–84 ms on this same machine. It catches a
regression in *what the code does*; it makes no claim about what the device affords.

Phase 2's leg still gates on both its advisory tests, because neither has failed and
rewriting a passed phase's harness without cause is its own kind of dishonesty. If FRAME-005
— also a device property — ever flakes the same way, the same distinction applies to it.

## Three more defects, found before any device saw the code

**The detector reported corners in the wrong place.** A checkerboard corner at (10, 10) came
back as (7, 7), and `localVariance` at the chosen positions was **0** — features landing on
flat regions. The cause is that a single box-filter pass makes the λ₂ response a flat
plateau across the whole corner neighbourhood, and non-maximum suppression keeps whichever
point the scan reached first, which is the top-left edge of the plateau every time. Two box
passes (a triangular kernel) give the response a single peak. After the fix the peak sits at
(9, 9)–(10, 10), variance at the chosen positions is 9011, and over 95 % of features land on
structure. A positional bias of three pixels would have been invisible in Phase 3's own
counts and fatal to Phase 5's geometry.

**The contrast statistic measured the scene, not the detector.** The check originally gated
on the ratio of mean corner strength at detected positions to that at random ones, at ≥ 4.0.
A working detector scored **1.87** on a checkerboard — because on a dense pattern the random
control is itself highly textured. A brick wall or a carpet would have failed FEAT-001 with
nothing wrong. Replaced by the rank statistic, whose chance value is exactly 0.5 whatever the
scene. Recorded as an amendment in `../TEST-PLAN.md`; it is a change of statistic, not a
relaxation — the fabricated-lattice control still fails, and now fails on scenes where the
ratio would have passed it.

**FEAT-003 failed a selector that was working.** The first run of this leg reported 34
features across 48 cells, quota 17, and an identical 22 % largest-cell share gridded and
ungridded — recorded as `FAIL`. The quota never bound, so the two selections were the same
selection. Comparisons are now counted only when the ungridded control actually overfilled a
cell; sparse scenes report `PENDING`. Also an amendment, and also a narrowing: a binding
frame where the grid fails to spread still fails, and a run that never produced a binding
frame can no longer pass by accident either.

## One measurement that settled a design choice

`../TEST-PLAN.md` chose to detect on pyramid level 1 rather than level 0, arguing from the
§H budget of 8 ms for Shi-Tomasi. The leg measures the alternative on every run rather than
leaving the argument unchecked:

| Level | Size | Cost | Features found |
| --- | --- | --- | --- |
| 1 (selected) | 480×270 | **7.49 ms** mean over 565 detections | median 45 |
| 0 (calibration) | 960×540 | **83.7 ms** | 114 |

Level 0 costs over 10× the budget for about 2.5× the features on this machine. The
calibration figure moves a lot between runs (45–84 ms measured) because it is a single
detection on a shared CPU; the ratio is the durable part, not the millisecond. The device run will
report its own pair, and that is the number that matters — but the shape of the trade is not
in doubt.

## What every bundle is checked for

`tests/unit/committedEvidence.test.ts` runs on every `npm test` and, for this file as for
Phases 0–2, re-derives the verdict from the bundle's own test results using the same
`PhaseRegistry.evaluate` the app uses, verifies the leg against its own recorded signals, and
rejects any NaN, infinity, `undefined` or reference cycle. For Phase 3 it additionally
re-checks the phase's own invariants: the contrast statistic against its chance value of 0.5,
the population collapsing when the measured texture did, no cell over quota, no state/count
mismatch, and `forwardBackwardError` / `reprojectionError` still `null` on every sampled
record. Four of those gates skip for want of a device bundle and will run once one is
committed — the same arrangement Phase 2 had before its pass.
