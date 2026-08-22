# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 11/11 required + 2/2 advisory. Evidence committed. |
| 1 | Camera Capture | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 5/5 required + 1/1 advisory, across two runs covering both permission scenarios. |
| 2 | Frame Pipeline | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 4/4 required + 2/2 advisory. Evidence committed. |
| 3 | Feature Detection | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 4/4 required + 2/2 advisory. Evidence committed. |
| 4 | Optical Flow Tracking | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 5/5 required + 2/2 advisory. Evidence committed. |
| 5 | Geometric Verification | NOT_STARTED | Phase Lock is open. v3 §14 is next; v4 §17 restates it without the numbers. |
| 6 | Relative Pose | BLOCKED | |
| 7 | IMU Support / Fusion | BLOCKED | |
| 8 | Keyframe System | BLOCKED | |
| 9 | Triangulation | BLOCKED | |
| 10 | Landmark Map | BLOCKED | |
| 11 | Plane Detection | BLOCKED | |
| 12 | Spatial World | BLOCKED | |
| 13 | World Viewer | BLOCKED | |
| 14 | Save / Load | BLOCKED | |
| 15 | Collision Geometry | BLOCKED | |
| 16 | Game Integration | BLOCKED | |
| 17 | Golden Test | BLOCKED | |
| 18 | Performance / Stress | BLOCKED | |
| 19 | Final Audit | BLOCKED | |

## Phase 0 — PASSED

**Evidence:** `docs/phase0/evidence/phase0-real-device-PASSED-2026-08-21T08-05-07-305Z.json`
plus the device screenshot from the same session.

| | |
| --- | --- |
| Device | iPhone, iOS 18.7, Safari 26.6, `https://hsgwyuki0429-design.github.io` |
| Leg | `REAL_DEVICE` — https, non-local host, `navigator.webdriver` false, 5 touch points |
| Required tests | 11 / 11 PASS, 0 PENDING, 0 FAIL |
| Advisory tests | 2 / 2 PASS |
| Capabilities | 31 records, 0 integrity issues |
| Probe time | 51 ms against a 1500 ms budget |
| Error log | empty |

Transitions recorded during the run:

```
NOT_STARTED -> IMPLEMENTING   capability detection starting
IMPLEMENTING -> TESTING       PENDING: CAP-0004, CAP-0005 — not yet evaluable
TESTING -> PASSED             all 11 required tests PASS on a real device
phase[1] BLOCKED -> NOT_STARTED   phase 0 PASSED; this phase may now be started
```

The middle step matters: the run really did sit at `TESTING` with the two gesture-gated
tests `PENDING`, and only reached `PASSED` once the sensors delivered data. The phase was
not passed by assertion at any point.

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it
from the bundle's own test results using the same `PhaseRegistry.evaluate` the app uses,
and re-checks the anti-fake invariants — that no `INFERENCE` record backs a criterion, that
ARKit/RoomPlan are not claimed without a bridge, that metric scale is `UNKNOWN`, and that an
`AVAILABLE` sensor carries real finite samples. It runs in `npm test`, so a hand-edited
`"overallVerdict": "PASSED"` would be caught by disagreeing with the results it summarises.

### Code changed after the pass

The pass attests to `appVersion 0.1.0` at commit `59cd379`. Two evidence-path defects found
by reading that bundle have since been fixed:

1. `motion.deviceOrientation` did not record which of alpha/beta/gamma carried data (the
   motion record did). Adds a field; changes no verdict.
2. `stateTransitions` was merged from two sources unsorted, so the bundle contained a
   duplicate `IMPLEMENTING -> TESTING` entry positioned after `TESTING -> PASSED`. Now
   deduplicated at source and sorted chronologically.

Neither touches a probe result or a pass criterion, and the committed bundle is still
re-derived to `PASSED` by the current code on every test run. If you want the record to
correspond exactly to HEAD, one more export from the device takes about thirty seconds.

## Phase 1 — PASSED

**Evidence:** three `REAL_DEVICE` bundles under `docs/phase1/evidence/`, all from
iPhone / iOS 18.7 / Safari 26.6 over HTTPS.

| Bundle | Verdict | What it contributes |
| --- | --- | --- |
| `…PASSED-2026-08-21T10-07-53-690Z.json` | **PASSED** | CAM-001, CAM-003, CAM-004, CAM-005 observed directly |
| `…TESTING-2026-08-21T09-50-49-632Z.json` | TESTING | CAM-002 observed directly — the denial |
| `…FAILED-2026-08-21T09-48-59-133Z.json` | FAILED | the record of a harness defect, kept deliberately |

From the passing run:

| | |
| --- | --- |
| Stream | rung 1 of the ladder, `facingMode: environment`, 1280×720 @ 30 fps, opened in 705 ms |
| Capture | **1263 frames over 42.3 s at 29.84 fps**, longest gap 128 ms, via `requestVideoFrameCallback` |
| Image change | 158 samples; MAD min 15.92 / median 38.62 / **peak 68.81** against a floor of 8.0 |
| Rotation | 2 changes, next frame 38 ms later, 1043 frames after |
| Denial | `NotAllowedError` → `CAMERA_PERMISSION_DENIED`, no stream, no preview element |
| Error log | empty |

The transition history shows it was not passed by assertion: the run sat at `TESTING`
through five successive re-evaluations as CAM-001, then CAM-005, then CAM-004, then CAM-003
each became evaluable, and reached `PASSED` only when the 30 s window filled.

**Two runs, because two scenarios.** The passing bundle carries CAM-002 as a carry-over
(`observedDirectly: false`) from the denied run 894 s earlier. The repository gate ignores
that carry-over: `tests/unit/committedEvidence.test.ts` requires the committed set to
contain a direct observation of *each* scenario, and it does — CAM-001 in the passing
bundle, CAM-002 in the denied one.

### Code changed after the pass

The pass attests to `appVersion 0.1.0`. One reporting defect found by reading the bundle
has since been fixed: CAM-001 reported `element 1280x1280` for a 1280×720 camera, because
the observed size was kept as a per-axis maximum and rotation had produced both 1280×720
and 720×1280. The pair is now taken from the largest frame by area, so the reported size is
one the element genuinely had, and every distinct size is listed. No probe result or pass
criterion is affected — both axes were ≥ 1 either way.

### What rotation does to the frame, and why Phase 6 needs to know

That defect exposed a real platform behaviour: **rotating the device swaps the video frame
dimensions**, 1280×720 ↔ 720×1280. Phase 6 derives camera intrinsics (`fx`, `fy`, `cx`,
`cy`) from the frame dimensions, so a rotation mid-scan is an intrinsics change, not a
cosmetic one. The monitor now records every distinct size seen so the change is visible in
evidence rather than having to be inferred.

## Phase 2 — PASSED

**Evidence:** `docs/phase2/evidence/phase2-real-device-PASSED-2026-08-21T15-00-01-120Z.json`
plus the device screenshot from the same session.

| | |
| --- | --- |
| Device | iPhone, iOS 18.7, Safari 26.6, `https://hsgwyuki0429-design.github.io` |
| Leg | `REAL_DEVICE` — https, non-local host, `navigator.webdriver` false, 5 touch points |
| Required tests | 4 / 4 PASS, 0 PENDING, 0 FAIL |
| Advisory tests | 2 / 2 PASS |
| Route | `VIDEO_FRAME` selected, 2363/2363 round trips, **0.048 ms** mean on the UI thread |
| Throughput | 2363 frames completed, **0 lost**, 300 paced out, 233 backpressured |
| Continuity | **48.5 s unstressed at 29.65 fps**, longest gap 103 ms, against a 30 s requirement |
| UI thread | 0.07 ms mean, 1 ms p95, 2 ms max, against a 16.7 ms budget |
| Worker | 17.27 ms mean over the whole run; **10.53 ms unstressed** at 720×1280 |
| Provenance | 94 cross-checks, scene σ 15.18, **median Δluma 0.284**, max 0.625 |
| Geometry | source 720×1280 ↔ 1280×720; 0 frames over budget, 0 upscaled, aspect error 0 |
| Ladder | 6 moves, deepest `REDUCED 640x360@20`, max 3 in any 10 s window |
| Error log | empty |

Transitions recorded during the run:

```
phase[2] BLOCKED -> NOT_STARTED   phase 1 PASSED; this phase may now be started
NOT_STARTED -> IMPLEMENTING       PIPELINE screen opened
IMPLEMENTING -> TESTING           PENDING: FRAME-001, FRAME-002, FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-001, FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-004
TESTING -> PASSED                 all 4 required tests PASS on a real device
phase[3] BLOCKED -> NOT_STARTED   phase 2 PASSED; this phase may now be started
```

It was not passed by assertion at any point: the run sat at `TESTING` through four successive
re-evaluations as FRAME-002, then FRAME-001, then FRAME-003, then FRAME-004 each became
evaluable. The same bundle also carries Phase 0 and Phase 1 passing in the same session,
which is what opened the lock — the registry starts fresh on every page load, so Phase 2 was
reachable only because Phase 1 really passed on the device that afternoon.

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it
from the bundle's own results, and for Phase 2 additionally re-derives the provenance claim
— cross-check count, scene variation, agreement against its own scene-scaled tolerance,
worker share, worker scope — and requires every ladder move to carry the measurement it was
made on. Those four gates had been skipping for want of a device bundle; they now run.

### §H.1, answered

The measurement that dictated the architecture has its counterpart:

| Route | Cost on the UI thread |
| --- | --- |
| `VideoFrame` construction (selected) | **0.048 ms** mean over 2363 frames |
| main-thread `drawImage` + `getImageData` (rejected) | 5.81 ms mean, 11 ms p95, 15 ms max |

Two things follow, and the second corrects §H.1.

**The route ladder never needed a fallback.** `VideoFrame` worked on the first attempt and on
all 2363 of them; `IMAGE_BITMAP` and `MAIN_CANVAS` were never reached. Their cost on this
platform is therefore unmeasured, and the bundle says so rather than reporting a zero.

**The readback is not a fixed 13.8 ms.** §H.1 recorded 13.797 ms from Phase 1. The same
operation, in this run, cost **5.81 ms** mean. Both are real measurements of the same
platform; the cost simply varies with what else is in flight. The conclusion §H.1 drew is
unaffected — 5.81 ms is still 17 % of a 33 ms budget before any pixel has been looked at,
against 0.048 ms for the route actually chosen — but the specific number should not be
quoted as a constant. §H.1 has been amended to say so.

### Two things worth knowing before reading these numbers

**WebKit quantises `performance.now()` to 1 ms.** Every duration in this bundle is an
integer. "UI cost 0.07 ms mean" therefore means *zero on almost every frame, 1–2 ms
occasionally* — the pipeline's per-frame UI work is below what the platform's clock can
resolve. Averages over thousands of samples still recover sub-millisecond accuracy because
the underlying values vary; individual readings do not.

**The worker's p95 of 53 ms exceeds §55's 50 ms ceiling, and that is the injected load.**
Unstressed it ran at 10–11 ms per frame at 720×1280 — a third of the 33 ms budget. The
stressed segment deliberately drove it to roughly 6× budget, and those frames are in the
same percentile. The unstressed and stressed segments are measured separately for exactly
this reason.

### The device confirmed the FRAME-004 amendment

The amendment recorded in `docs/phase2/TEST-PLAN.md` — that a step lowering only the target
rate cannot reduce the time one frame takes, so the effect criterion must name the last step
that lowered the *resolution* — was an argument. The device turned it into a measurement:

| Ladder move | Median worker latency, before → after |
| --- | --- |
| `BASIC 960x540@30 → BASIC 960x540@20` (rate only) | 58 ms → **59 ms** |
| `BASIC 960x540@20 → REDUCED 640x360@20` (resolution) | 57 ms → **26 ms** |

The rate-only step left per-frame latency exactly where it was, and the resolution step
halved it. Under the original criterion this run would have been recorded as a failure of a
mechanism that demonstrably worked.

### Where the screenshot and the bundle differ, and why

The device screenshot was taken about three seconds after the JSON was exported, and they do
not match field for field:

| | Bundle | Screenshot |
| --- | --- | --- |
| Tier | `BASIC 960x540@30` | `HIGH 1280x720@30` |
| Ladder moves | 6 | 7 |
| Completed | 2363 | 2434 |
| Delivered / camera fps | 30.05 / 30.04 | 21.85 / 22.46 |
| Cross-checks | 94 | 97 |

Everything in the second column is the first column plus three more seconds of a running
pipeline, including one more upward step. The rate figures fall because they are a rolling
window: at `HIGH` the worker processes 720×1280 rather than 540×960, and the camera itself
delivers 22.46 fps once the page is doing that much more work per frame. The controller
correctly did not degrade — 21.85 against a reachable 22.46 is well inside its floor.

This is recorded rather than smoothed over. Phase 1's screenshot matched its bundle field
for field; this one does not, and claiming otherwise would be precisely the kind of
convenient assertion the whole project is built to refuse. The screenshot corroborates the
bundle's *shape* — pipeline running, worker output visible and tracking the preview, 6 tests
PASS, `PASSED` verdict, 0 lost, 48.5/30 s unstressed, empty error log — not its every digit.

**The screenshot is committed**, as
`docs/phase2/evidence/phase2-real-device-PASSED-2026-08-21T15-00-01-120Z.jpg`, beside the
bundle it belongs to — so §60's screenshot evidence is a file in the repository for this
phase, where for Phases 0 and 1 it was supplied in the working session and reviewed there.

## Phase 3 — IMPLEMENTING

**Not passed, and cannot be from what is committed.** The only Phase 3 bundle in the
repository is `docs/phase3/evidence/phase3-desktop-chromium.json`, leg `DESKTOP_DEV`. Rule
004 stands. `docs/phase3/HOW-TO-RUN-DEVICE-TEST.md` describes the run that would settle it.

What exists: Shi-Tomasi detection on pyramid level 1, the 8×6 grid quota selector, the
refill ladder of §11, the six-test Phase 3 suite, the FEATURES screen with an overlay drawn
from the worker's own detected positions, 49 new unit tests, and the automated leg.

What the automated leg establishes and what it cannot is set out in
`docs/phase3/evidence/README.md`. In short: the mechanism holds its quota, never disagrees
with its own state, and picks image structure over chance **97.3 %** of the time — but the
synthetic camera is neither a textured wall nor a blank one, so FEAT-001, FEAT-002 and
FEAT-003, which are the three tests that carry this phase's meaning, all report `PENDING`
and are excluded from that gate with their reasons printed. FEAT-005 is excluded too, and
for a reason worth reading: it measures this machine against a budget written for the
iPhone, and consecutive runs of identical code straddled the threshold at 7.98 ms and
9.36 ms.

Three defects were found before any device saw the code — a three-pixel positional bias from
a plateaued corner response, a contrast statistic that measured the scene rather than the
detector, and a grid comparison that failed a selector which was working correctly. The
first was a code fix; the other two are amendments recorded in `docs/phase3/TEST-PLAN.md`,
both narrowing the test rather than relaxing it.

### The first device run found a defect, and it is committed

`docs/phase3/evidence/phase3-real-device-TESTING-2026-08-22T01-57-31-596Z.json`, iPhone /
iOS 18.7 / Safari 26.6 over HTTPS, `devEntry: false`. The pipeline ran and preprocessed
**2190 frames without losing one. Detection ran on zero of them**, while the screen said
`DETECTING` and the error log stayed empty.

Phase 3 is reached from a PIPELINE screen whose pipeline is still running — it has to be, to
have passed. `onStartPhase3` guarded on `pipeline.isRunning()`, which on that path means
"Phase 2 is still going" rather than "detection already started", so the handler returned
before the tracking options were ever sent to the worker. The screen's own running flag was
the same expression, so the control reported a state the engine was not in (Rule 002), which
is what made a dead stage look like a rendering bug.

Fixed: detection has its own state, a running pipeline is adopted rather than treated as an
obstacle, Phase 2's injected load is cleared on adoption, and one `isDetecting()` is read by
the screen, the tests and the evidence so they cannot drift apart again. The automated leg
now walks the device's path — enter Phase 2, start the pipeline, turn stress on, hand it
over, then start detection — and against the old code that sequence times out waiting for
the first detection. Full account in `docs/phase3/evidence/README.md`.

The bundle is kept for the reason Phase 1 keeps its `FAILED` one: the record of a defect is
evidence, and removing it would leave the fix looking like a change with no cause.

### The second device run found that the fix was incomplete

`docs/phase3/evidence/phase3-real-device-TESTING-2026-08-22T02-35-08-088Z.json`, same
session shape, 1662 frames preprocessed, 0 lost — **and 0 detections again.**

The first fix routed the screen's stats, the tests and the evidence through one
`isDetecting()` predicate and missed the one prop that drives the button:
`running: this.pipeline.isRunning()` in the Phase 3 view model. `vm.running` sets both the
label and `disabled`, so arriving at FEATURES over Phase 2's still-running pipeline the
button rendered **`DETECTING`, disabled, before anyone touched it** — the user could not
start the run at all. Strictly worse than the bug it replaced: unpressable rather than inert.

The bundle proves it was that and not a stale deploy: `createdAt` sits 2 ms after the screen
opened while the Phase 3 tick rebuilds it every 500 ms, and the adoption log line the fix
emits unconditionally is absent — yet the screenshot shows `DETECTING`. Those cannot coexist
unless the control never read `trackingRequested`.

The leg missed it because it called `startDetection()` through the debug API: the engine was
reachable, the button was not. It now presses the real control and asserts the label and
`disabled` state either side of the click. Against the broken code it fails with the user's
own experience — *"START DETECTION is not pressable on arrival: label "DETECTING", disabled
true"*.

## Phase 3 — PASSED

**Evidence:** `docs/phase3/evidence/phase3-real-device-PASSED-2026-08-22T06-19-56-644Z.json`
plus the device screenshot from the same session.

| | |
| --- | --- |
| Device | iPhone, iOS 18.7, Safari 26.6, `https://hsgwyuki0429-design.github.io` |
| Leg | `REAL_DEVICE`, `devEntry: false` — the lock opened because Phases 0–2 passed in the same session |
| Required tests | 4 / 4 PASS, 0 PENDING, 0 FAIL |
| Advisory tests | 2 / 2 PASS |
| Detections | 2494, detection at level 1 (360×640) for **3.793 ms** against an 8 ms budget |
| Contrast | **91.1 %** above chance over 288 samples, against a 75 % threshold and a 50 % chance value |
| Texture-rich | 79 frames at mean gradient 8.398, median **353** features |
| Texture-poor | 1113 frames at mean gradient 2.531, median **64** features |
| Grid | 185 binding comparisons, 7.6 % vs 10.6 % largest-cell share |
| Refills | 200, quota breaches 0, state mismatches 0 |
| Level 0 calibration | 720×1280 would have cost 27 ms for 221 features |

The number that carries the phase is the pair **353 → 64**: the population fell to 18 % of its
textured value when the camera was pointed at a blank wall, having failed exactly this
comparison one run earlier. That is the behaviour §11 asks for, and it is what the absolute
corner floor bought.

**91.1 % above chance** is the anti-fake claim: a detector emitting coordinates unrelated to
the image scores 0.5 by construction, whatever the scene.

### It took four device runs, and each failure was a real defect

| Run | Verdict | What it found |
| --- | --- | --- |
| 01:57 | `TESTING` | START DETECTION was a no-op — the guard read Phase 2's running pipeline as "already detecting" |
| 02:35 | `TESTING` | the fix left the button *unpressable* — three of four readers consolidated, the view model missed |
| 03:00 | `FAILED` | FEAT-002: the corner floor was relative to each frame, so a blank wall still yielded 800 features |
| 06:19 | **`PASSED`** | — |

### Known defect, carried into Phase 4: the overlay rotates in portrait

The user reports that on the device the drawn corners line up in landscape and are rotated in
portrait. **Phase 3's own tests cannot see this**, and neither can any other check in the
repository, because every one of them is invariant to the transform: the detector's unit
tests never cross the video → `VideoFrame` → canvas → pyramid path, Phase 2's provenance
cross-check compares *mean* luma, and FEAT-001's contrast statistic is computed inside the
worker on the same buffer the detector used.

So the app now measures it. `src/debug/OverlayAlignmentProbe.ts` has the main thread take its
own reading of the video element and score the detected positions against it under identity,
each rotation, each flip and the transpose; the winner is shown on screen and recorded in
every Phase 3 bundle. On the desktop leg identity wins at 17–19× chance with every other
transform far below.

**The drawing is not corrected when it disagrees.** Phase 4 consumes the same positions, so a
corrected overlay over rotated data would be a working-looking screen on wrong data. The
acquisition route is abandoned instead — `VideoFrame` carries the sensor's orientation, while
`createImageBitmap` on the element and the main-thread readback are both defined on what the
element displays.

This could not be reproduced on the desktop leg: Chromium's fake capture rescales a portrait
file to square, so the orientation relationship iOS creates does not arise. The next device
run reports the probe's verdict directly rather than requiring the eye.

### The third device run detected, and failed on its own merits

`docs/phase3/evidence/phase3-real-device-FAILED-2026-08-22T03-00-47-526Z.json`. 2325
detections, 556 features drawn, five of six tests PASS — and **FEAT-002 FAILED**, which is
the first Phase 3 failure that is about feature detection rather than about plumbing.

A blank surface (mean gradient 3.14 over 1127 frames) still produced a median of 429 features
and reached the full 800 target. §11 requires the population to follow the image; it did not.
The cause is that the corner-strength floor was `maxScore * 0.01` — a fraction of the frame's
own strongest response and nothing else — so on a blank wall the floor becomes 1 % of noise
and the detector fills its target with sensor noise. The same cause explains the contrast
statistic sagging to 76.3 % (against 97 % on the desktop leg) and the user's report that the
drawn points did not correspond to the camera image: most of them were on nothing.

An absolute floor now applies alongside it, in intensity levels per pixel — the units `gx`
is already in — set to `TEXTURE_POOR_CEILING`, the value the phase already uses to call a
frame blank. No constant was invented and none was tuned against the failing test.

**FEAT-002 itself was not touched.** The test was right, it failed, the code changed.

### The overlay geometry was suspected and cleared

`scripts/run-e2e-phase3-alignment.mjs` was written to settle it, because nothing in the
repository could: the detector's unit tests never cross the video→worker path, Phase 2's
provenance check compares a *mean* luma and is invariant to rotation, flip and transpose, and
the synthetic camera has no landmark to disagree with. The leg feeds Chromium a video with
bright blocks at known asymmetric positions and asserts the canvas covers the video's box,
that their aspects agree, and that corners land on the blocks: **12 of 12, 4 per block, none
in the empty quadrant.** Scoring the overlay against the main thread's own read of the video
across seven transforms put the identity at 70× the random baseline and every rotation and
reflection at zero. The overlay was drawing exactly where the detector found things.

### Code changed after the Phase 2 pass

Phase 2's pass attests to `appVersion 0.1.0` at commit `f6a1b55`. One structural change has
been made since, and it changes no Phase 2 behaviour:

**The frame worker moved from `src/pipeline/frameWorker.ts` to
`src/tracking/trackingWorker.ts`** (a `git mv`; the preprocessing code is unchanged).
Feature detection has to run in the same worker as preprocessing — shipping the pyramid back
to the main thread to detect on it would undo the reason Phase 2 exists — but §83 forbids
`pipeline` from importing `tracking`. Resolving that the other way round keeps the layering:
the worker now belongs to `tracking`, `WorkerFramePipeline` takes a `WorkerFactory` injected
by `src/main.ts` (the composition root, which belongs to no audited layer), and the two
message types carry an opaque `tracking?: unknown` field that `pipeline` passes through
without ever naming its shape. The architecture audit passes unchanged.

The committed Phase 2 device bundle is still re-derived to `PASSED` by the current code on
every test run.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0, 1, 2, 3}`. The START SCAN control reads it alongside Phase Lock, and a
control for an unbuilt phase stays disabled with the reason in its label. Nothing in the UI
implies a capability that has not been built.

## Phase 4 — PASSED

**Evidence:** `docs/phase4/evidence/phase4-real-device-PASSED-2026-08-22T14-47-06-539Z.json`
plus the device screenshot from the same session.

| | |
| --- | --- |
| Device | iPhone, iOS 18.7, Safari 26.6, `https://hsgwyuki0429-design.github.io` |
| Leg | `REAL_DEVICE`, `devEntry: false` — the lock opened because Phases 0–3 passed in the same session |
| Required tests | 5 / 5 PASS, 0 PENDING, 0 FAIL |
| Advisory tests | 2 / 2 PASS |
| Flow frames | 2717, of which 1941 had a predecessor to track from |
| **FLOW-002** | **400 cross-checks: tracker 4.741 px against image 4 px, median disagreement 0.95 px inside a 2 px tolerance, 90.5 % of frames agreeing** |
| FLOW-001 | 400 static frames, median displacement **0.025 px**, FB 0.001 px, survival 100 % |
| FLOW-003 | 400 rotating frames at a median 5.57°/s: survival 96.3 %, grid spread **0.813 px turning against 0.464 px panning** |
| FLOW-004 | 329 fast frames: survival 87.5 % against 97.2 % slow, §13 rejecting 7.1 % against 0 % |
| FLOW-005 | 3 occlusions, `LOST` reached in 64–94 ms, all recovered, **0 tracks claimed a good round trip through the dark** |
| §13 over the run | 164 202 acceptable, 362 reduced, 2 511 rejected; median 0.006 px |
| §33 | 746 TRACKING, 1211 DEGRADED, 759 LOST, 1 READY — **0 state mismatches** |
| Longest track | **467 frames** |
| Geometry changes | 12 — the tier ladder stepping, and the device rotating (720×1280 ↔ 1280×720) |
| LK solve | 2.668 ms at 41 points, against §H's 14 ms |

The number that carries the phase is **4.741 against 4.000**: what the tracker says the points
did, beside what an integer SAD translation search — sharing no code with the solver, never
reading the feature list, keeping its own copy of the previous frame — says the image did.

**It was not passed by assertion.** The transition log records the phase moving
`FAILED → PASSED → FAILED → PASSED` as the operator worked through the conditions: FLOW-001 and
FLOW-005 failed first, then FLOW-002 failed once more after that, and the pass came only when
every required test held at the same time.

### The Phase 3 defect reproduced, and the probe caught it

This is the answer to the question Phase 3 left open, and it is the most important thing in
the bundle.

```
routeRejectedFor: "rot90"
routeProbes[0]: VIDEO_FRAME — 5265/5265 successes, "abandoned"
routeProbes[1]: IMAGE_BITMAP — 4772/4773 successes, "selected"
```

The `VIDEO_FRAME` route — the one that carries the sensor's orientation rather than what the
element displays — produced a buffer **turned 90° against the video**, for 5265 frames. The
alignment probe measured it, three readings in a row, and the app abandoned the route rather
than correcting the drawing. After the fallback the probe reads `best: identity` at
**10.1× chance**, with `rot90` at 12.5 against identity's 369.9.

So: the report was real, the mechanism §H.7 called for works, and the defect is contained
rather than fixed — the platform still produces a misoriented buffer on that route, and what
the app does is decline to use it. The error log carries the rejection with its reason.

**One consequence to hold on to**: the run spans the route change, so its early frames were
measured in a rotated buffer. That does not invalidate FLOW-002 — the tracker and the
independent search read the *same* buffer, so their agreement is unaffected by a shared
rotation — but Phase 6 derives intrinsics from the frame geometry, and a phase that mixes two
acquisition routes must know it did.

### Three things this pass does not demonstrate

Recorded because the tests as written are satisfied and the run is still narrower than it
looks:

**The population never reached §11's minimum.** It sat at a median of 74 tracked points on
static frames and 41 on slow ones, against §11's minimum of 200 and DEGRADED threshold of 80 —
so the state read `DEGRADED` on 1211 of 2717 frames. FLOW-001's fifth criterion ("never LOST
while static *and the count is above 80*") was therefore vacuous, and FLOW-004's fourth
("reaches DEGRADED when the count falls") was already true before the fast motion started.
Both criteria are met; neither was exercised.

**The bundle could not say why**, which is the defect this found. Phase 4 routes its results
to `FlowSession` rather than `FeaturePopulation`, so it carried no detection statistics at
all: a reader cannot tell a detector that found 90 corners in a dim room from a merge step
declining 700. That is fixed — the flow record now reports what §11's refill offered and why
each point was declined, split into *already being tracked* (the healthy case) and *outside
the solver's reach*. On the automated leg it reads **353 offered — 319 already tracked, 14 out
of reach, 20 admitted**, which is a tracker holding what it has rather than one losing it. The
next device run answers the same question directly.

**FLOW-006 passed at 41 points, not at §H's ~700.** 2.668 ms is comfortably inside the 14 ms
budget, but the budget was written for a population an order of magnitude larger and the run
never had one. Worth pairing with the other half of that measurement: **the independent
scene-shift search cost 7.648 ms, nearly three times the solver it checks.** On the automated
leg the ratio is the other way round. §H.8 records both.

### What exists

What exists: pyramidal Lucas-Kanade at §12's parameters, §13's forward/backward bands, an
independent scene-motion measurement that shares no code with the solver, frame-to-frame
population tracking with `age` and `trackLength`, §33's state as one pure function, the
seven-test Phase 4 suite, the TRACKING screen, a live `rotationRate` feed for FLOW-003, 63 new
unit tests, and an automated leg that generates its own camera feed.

### What the automated leg can decide, and it is more than Phase 3's could

Phase 3's leg had to exclude the three tests that carry its meaning, because Chromium's fake
camera is a rolling gradient. Phase 4's conditions are about **motion**, and a video file can
contain motion exactly — so `scripts/run-e2e-phase4.mjs` builds a feed that holds still, pans
at 4 px per frame, sweeps at 22, and goes black, and every frame is classified from the pixels
by the same code the device runs.

That arms **the one gate this phase exists for**, through the real
`video → VideoFrame → worker → pyramid` path:

| | Measured on the leg |
| --- | --- |
| FLOW-002 cross-check | **309 pairs: tracker 6 px vs image 4 px, median disagreement 0 px, 93.9 % agreeing** |
| Motion classes | 133 static, 135 slow, 41 fast, 10 occluded |
| §33 | 279 TRACKING, 47 DEGRADED, 120 LOST — **0 state mismatches** |
| Occlusions | 11 episodes, `LOST` in 0–112 ms, every one recovered |
| §13 | 77 232 acceptable, 985 reduced, 8 115 rejected |
| LK solve | 22.5 ms at 165 points, at §12's parameters |

FLOW-001, 002, 004, 005 and 007 PASS there. FLOW-003 is `PENDING` — headless Chromium has no
gyroscope — and FLOW-006 is `FAIL` at 22.5 ms against §H's 14 ms, printed and excluded because
a device budget cannot be adjudicated off the device (§H.4).

### The number that carries the phase, and what a fake would do to it

Everything else in Phase 4 can be produced by a tracker that never looked at the second frame.
A tracker returning its input reports every point surviving, `age` and `trackLength` climbing
honestly, and a forward/backward error of **exactly 0.0** — §13's best band. On a static scene
it is indistinguishable from a working tracker, and **no statistic computed from its own output
can tell.**

So `tests/unit/flowTracker.test.ts` drives the real `FlowStage` with exactly that tracker over
a run whose motion is known by construction, and asserts the whole shape of it: the fake passes
FLOW-001, passes FLOW-007, scores a perfect §13 round trip, keeps 100 % of its population — and
**fails FLOW-002**, because an integer SAD translation search on the pyramid's top level, which
shares no code with the solver and never sees the feature list, says the image moved 4 px while
the tracker says 0.

### Four defects found before any device saw the code

| Found by | Defect |
| --- | --- |
| The synthetic run | §33's `inliers < 20` reused for tracked points made a 20-feature scene permanently `LOST` — survival of 19/20 is a tracker working perfectly |
| FLOW-005, on the leg | A tier step inside an occlusion cleared `everTracked`, put the state back to `READY` mid-run, and left a 14-frame covered lens never reaching `LOST` |
| FLOW-001, on the leg | Detection handed the tracker points its 21×21 window cannot cover — 15 % of the population, making survival read 84.6 % on an image the tracker had followed exactly |
| The evidence recorder | A covered lens put `Infinity` into every bundle: the alignment probe divided by a local variance that is legitimately zero on a black frame |

All four are recorded as amendments in `docs/phase4/TEST-PLAN.md`. **No criterion was
relaxed.** Two thresholds the plan named but left unnumbered were fixed with their derivations
(the scene-shift confidence floor, and FLOW-003's integration window), and two criteria were
narrowed to the frames they were always about.

### One measurement that is about the implementation, not the platform

The first version of the solver cost **65 ms per frame**, because it called a shared bilinear
helper 441 times per iteration and recomputed the interpolation weights each time. The whole
window shares one sub-pixel offset, so they are computed once and the loop walks consecutive
indices: **22.5 ms**, at identical results — the accuracy tests hold to 0.05 px either way.
Reporting the first number as what the device affords would have been reporting an inefficiency
as a platform fact.

### The Phase 3 defect carried in, and where it stands

Phase 3 ended with an unresolved report: the overlay's points line up in landscape and are
rotated in portrait. `src/debug/OverlayAlignmentProbe.ts` was added to measure it, and it runs
in Phase 4 too — it has to, because Phase 4 measures every displacement in the acquired
buffer's frame, so a buffer turned against the screen makes every number in this phase wrong
while every average-based check still passes (§H.7).

**It is still not confirmed fixed**, and the next device run is what would confirm it. What
changed here is that the probe learned to say when it cannot tell:

- on the Phase 4 leg's generated feed — periodic in x so the pan loops, and densely textured —
  every transform lands on corner-like pixels and all seven scores fall within a factor of 1.05
  of each other. The probe names a winner with `best/random` at **1.03**, which is noise;
- `isMisoriented` now requires the winning transform to beat chance by the same margin identity
  is required to. Without that, pointing the phone at a brick wall or a tiled floor could
  abandon a working acquisition route;
- and a black frame reports `measurable: false` rather than `Infinity`.

`scripts/run-e2e-phase3-alignment.mjs` remains the leg that decides orientation, on a fixture
built so no rotation or reflection maps its landmarks onto themselves. It scores identity at
17.7× chance.

