# Phase status

**Spec version: `Safari Spatial Game v4.0` from Phase 5 on.** Phases 0–4 were built and passed
against `v3.0`; v4 leaves §11, §12 and §13 — their governing sections — identical, so nothing
already passed changed. What v4 *stopped stating* is recorded in
[`SPEC-VERSIONS.md`](SPEC-VERSIONS.md), including the four numbers v3 §14 fixed for Phase 5.

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
| 5 | Geometric Verification | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 4/4 required + 2/2 advisory. Evidence committed. |
| 6 | Relative Pose | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 5/5 required + 2/2 advisory. Evidence committed — with one criterion recorded as unexercised, see below. |
| 7 | IMU Support / Fusion | TESTING | Built. The automated leg **decides IMU-002** — v3 §68's own pass condition — plus IMU-006 and IMU-009 every build. IMU-001/003/004/005/007 are `PENDING`: headless Chromium has no IMU. Awaiting the device run. |
| 8 | Keyframe System | TESTING | Built. The automated leg **decides all six required records** — the instruments are a still segment and a metronome, and the harness makes both. Awaiting the device run. |
| 9 | Triangulation | TESTING | Built. The automated leg **decides all seven required records** — both gates are injections the harness builds. Awaiting the device run. |
| 10 | Landmark Map | TESTING | Built. The automated leg **decides all seven required records** — the instruments are the map's own memory and an injection the harness builds. Awaiting the device run. |
| 11 | Surface Understanding | BLOCKED | v4 §23 — renamed from Plane Detection |
| 12 | Spatial World | BLOCKED | |
| 13 | Spatial Game Viewer | BLOCKED | v4 — renamed from World Viewer |
| 14 | Save / Resume | BLOCKED | v4 §42 — renamed from Save / Load |
| 15 | Spatial Collision | BLOCKED | v4 — renamed from Collision Geometry |
| 16 | Game Integration | BLOCKED | |
| 17 | Stage Generator | BLOCKED | **new in v4** (§48) |
| 18 | Goal Ring System | BLOCKED | **new in v4** (§49) |
| 19 | Ball Physics | BLOCKED | **new in v4** (§50) |
| 20 | Gameplay Validation | BLOCKED | **new in v4** (§51) |
| 21 | Final Audit | BLOCKED | |

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

---

## Phase 5 — PASSED

Built against **v3 §14 and §16**, which v4 does not restate — see
[`SPEC-VERSIONS.md`](SPEC-VERSIONS.md). **Passed on the device on 2026-08-23**: iPhone /
iOS 18.7 / Safari 26.6 over HTTPS, 4/4 required and 2/2 advisory, `devEntry: false`, with the
transition log showing `TESTING → PASSED → FAILED → PASSED` — it failed on **GEO-003** in
between. The gate that carries this phase could fail, and did.

```
1875 verified frames, 1203 judged; 293 re-anchors
median 66 inliers of 71 correspondences (ratio 0.9377), baseline 24.83 px, spread 141.64 px
states: 778 UNVERIFIED, 899 USABLE, 198 GOOD
GEO-003: 271 injected frames — 90.9% of injected outliers rejected vs 6.0% of untouched
         (15.2x advantage), 43 inliers surviving
v3 §16: 1714 frames with both models — 700 planar, 1014 non-planar; median F 68 vs H 57.5
RANSAC 3.45 ms at 71 correspondences, against §H's 6 ms; 62 frames at the iteration cap
integrity: 0 state mismatches, 0 partition faults, 0 models on an unverified frame
```

Tier `REDUCED 640x360@20`, processing 360×640 in portrait.

The test plan was written and committed before any Phase 5 code existed (§29):
[`phase5/TEST-PLAN.md`](phase5/TEST-PLAN.md).

### What exists

`src/geometry/` — a new layer, and the strictest rule in the architecture audit: it may not
import from `tracking`, `capture`, `pipeline`, `debug` or `testkit`. `linalg.ts` (cyclic Jacobi
symmetric eigen-decomposition, so a null vector can be found without a general SVD), `twoView.ts`
(Hartley-normalised eight-point fundamental matrix with rank-2 enforcement, four-point DLT
homography, Sampson distance, symmetric transfer error), `ransac.ts` (adaptive termination at
`N = log(1−p)/log(1−wˢ)`, seeded, refitting on its inliers), `verify.ts` (both models on every
frame, v3 §16's comparison, v3 §14's state in one pure function).

`src/tracking/VerificationStage.ts` is the whole Phase 5 frame with no worker around it, so the
unit tests drive the exact code the worker runs. `VerificationSession` accumulates it,
`Phase5Tests` evaluates GEO-001..006, and the GEOMETRIC VERIFICATION screen shows it. 45 new unit
tests; 579 in total.

### The baseline problem, and the anchor this phase introduces

Phase 4's device run measured a median frame-to-frame displacement of **4.7 px**. Two views that
close determine nothing: every model fits, the inlier ratio comes out at 1.00, and it verifies
nothing at all. So Phase 5 does not verify consecutive frames. It holds a **verification anchor**
tens of frames back and relates the current frame to that, re-taking it when the two views drift
past 120 px and stop sharing enough scene.

**This is a stand-in for Phase 8's keyframe system and is documented as one**, in the plan and in
the code. Three of v3 §20's four keyframe conditions need a pose that Phase 6 has not produced;
the fourth — displacement — is the one Phase 5 can measure, so it is the one the anchor uses.

### The number that carries the phase, and what a fake would do to it

v3 §14 names four figures: 30 inliers, ratio 0.35, 100 inliers, ratio 0.50. **A stage that marks
every correspondence an inlier satisfies all four perfectly**, because the inlier count is then
the correspondence count and the ratio is exactly 1.00 — it scores better than a working verifier
on every one of them.

So on a sample of frames the harness takes the real correspondence set, displaces 30% of the
targets by 25 px in seeded directions, and hands the result to the verifier with no marking of
which it touched. Recall against that ground truth is the only figure in the phase a
pass-through cannot produce: it scores exactly 0.00. The untouched rejection rate is reported
beside it, because recall alone is scored perfectly by rejecting everything, and the pair is the
measurement.

`tests/unit/verification.test.ts` runs both stages through the same session and the same suite
and shows the difference. The automated leg reads **100% of injected outliers rejected against 0%
of untouched**, over 61 sampled frames.

### v3 §16 decided the phase, and the first reading of it was wrong

The leg's first run failed GEO-003 at **0.816** against 0.90, and the cause reproduces in Node
with no camera involved. On a plane with 30% of its targets displaced 25 px, the homography
admitted **exactly the untouched correspondences and not one outlier** — 70 of 100 — while the
fundamental matrix admitted 74 to 77: the same 70, plus outliers it captured with the epipole a
planar scene leaves free. On a plane `F` is not determined at all, every `[e]ₓH` fits, and RANSAC
had two free parameters that the correct data did not constrain.

Read as `hCount >= fCount`, that is a non-planar scene. So the degenerate model was selected, its
absorbed outliers survived as inliers, and GEO-004 was simultaneously reporting `non-planar` for
frames that are planar by construction. **The verifier had found every outlier and the selection
rule threw the answer away.**

`PLANAR_H_ADVANTAGE = 1.0` is withdrawn. `PLANAR_H_SHARE = 0.45` compares `H / (H + F)` —
ORB-SLAM's constant for this identical choice between the two models. No pass criterion moved:
the amendment is recorded in place in the test plan, with the measurement that forced it, and the
regression is in `tests/unit/verification.test.ts`. A clean plane scores 0.500, a plane with
outliers 0.476–0.486, a two-depth scene 0.400–0.415.

### What the automated leg can decide

Phase 3's leg had to exclude the tests carrying its meaning, because Chromium's fake camera is a
rolling gradient. Phase 4's leg generated its own feed because its conditions are about motion.
Phase 5's are about **geometry**, and a video file can contain geometry exactly — with one
requirement a single panning texture cannot meet.

A pan of one flat texture *is* a planar scene, so §16 would answer PLANAR on every frame and
GEO-004's other half would never occur. The feed therefore has two depth layers: a background
that pans slowly and a foreground that pans 3.5× faster **in the same direction**, which is what
a camera translating parallel to two fronto-parallel planes produces. Both layers' displacements
stay parallel to one direction, so a fundamental matrix explains them both; no single homography
matches two disparities. A third segment is a smooth low-gradient field, for GEO-002.

GEO-005 is excluded and gated on a wider configuration tripwire instead, for the reason §H.4
gives: a device budget cannot be adjudicated on headless Chromium with SwiftShader. Rule 004
stands regardless — nothing here passes a phase.

### The fixture was measuring its own artefacts, and only a rebuild showed it

Rebuilding the parallax segment so its depth edges stopped sweeping across the frame collapsed
the population from 77 correspondences to 18. The texture underneath had a mean gradient of
**4.67 and produced zero corners** at detection's level — below `TEXTURE_RICH_FLOOR`, so the
classifier had been calling every frame `AMBIGUOUS` and GEO-001's texture-rich class had been
empty the whole time without anything saying so.

What had been carrying the first run was six stripe boundaries sweeping across the frame at
9.5 px per frame: strong, trackable corners belonging to no surface. A two-view geometry measured
on them is a measurement of the fixture. The feed now uses Phase 4's texture, whose leg tracked
210 points on this same 640×480 source — mean gradient 14.0, 467 corners at level 1.

### Three things this pass does not demonstrate

**GEO-003 cleared its bar by 0.9 points** — 90.9 % against the 90 % the plan fixed. The paired
form is decisive (15.2× the untouched rate over 271 samples), but the recall itself has almost
no margin, and the automated leg's 100 % is not what a real scene gives. A run at 89 % would
have failed, which is the point; it is worth knowing how close the real number sits.

**The texture contrast GEO-001 and GEO-002 name was never exercised.** The run recorded **35**
`TEXTURE_RICH` frames against **1140** `TEXTURE_POOR`, and the poor class carried a median of
**68 correspondences**. So GEO-001 was decided on the run-wide judged frames rather than on a
textured scene, and GEO-002's declines came from the baseline floor and from frames below 20
correspondences rather than from a blank wall. Both tests measured something real and passed it
— GEO-002's failure condition, "a verdict on a correspondence set too small for v3 §14's
minimum", provably did not occur, per frame, via the one state function and `stateMismatches: 0`
— but neither proved the contrast its title implies. Phase 3's FEAT-001/FEAT-002 pair did, at
353 features against 61.

**The `VIDEO_FRAME` orientation defect is still there.** Abandoned again after 1849 frames for
`rot90`, exactly as in Phase 4; `IMAGE_BITMAP` selected, 5824/5825 successful, and the final
alignment reading `identity` at **5.41× chance**. Contained, not fixed — and it now has two
device runs behind it rather than one.

### An evidence check that was wrong, and the bundle that caught it

`committedEvidence.test.ts` asserted that no `TEXTURE_POOR` frame may report `USABLE` or `GOOD`.
The device bundle has **655** that do, and the assertion was the thing that was wrong.

It read the class as "there is nothing here to verify". The class means
`meanGradient <= TEXTURE_POOR_CEILING`, which is a different claim — and **Phase 3's own passing
bundle, committed before Phase 5 existed, records its texture-poor class at a median of 61
detected features.** This run's poor class sits at 68 correspondences, in agreement. A frame can
be texture-poor and still carry a correspondence set worth verifying, because the class
describes what detection would find *now* while the correspondences come from the anchor tens of
frames back and survive a pan onto a plainer surface. Verifying those is correct; declining
would have been the dishonest answer.

The check now tests what GEO-002's criterion states rather than what its title suggests. No
criterion moved, and the finding is why the paragraph above exists.

### The screen's alignment row is a per-frame reading

The committed screenshot shows `OVERLAY MATCHES VIDEO: NO — flipX fits 1.4× better` in red,
while the bundle's reading is `identity` at 5.41×, with `flipX` at 517 against identity's 1127.
Both are true: the row shows the instantaneous frame, and on a real scene it flickers. Nothing
was abandoned on it — `isMisoriented` requires repeated readings *with discrimination* before it
will drop a route, which is the safeguard added at the end of Phase 4 precisely so a brick wall
cannot cost a working route. The row is honest about the frame it read; it is not a verdict on
the run, and a reader of the screenshot alone could mistake it for one.

### Three things this phase does not do

- **No pose.** `Pose candidate` is the last step of v3 §14's chain and belongs to §15, which is
  Phase 6. Nothing here decomposes a matrix into rotation and translation.
- **No reprojection error.** An inlier's residual against a fundamental matrix is a Sampson
  distance, not a reprojection error, and calling it one would be claiming a pose that does not
  exist. §11's `reprojectionError` stays `null` through this phase, and GEO-006 checks it.
- **No intrinsics.** Which is what lets Phase 5 run before Phase 6 derives them.

§33's tracking `GOOD` therefore still cannot be reached on the TRACKING screen: it needs an
inlier ratio *and* a reprojection error, and only the first now exists. This screen's `GOOD` is
v3 §14's verification verdict and it is a different claim.

---

## Phase 6 — PASSED

Built against **v3 §15, §16, §19 and §67**, which v4 compresses into a two-line §18 — both of
whose lines are kept, one of them a prohibition. See [`SPEC-VERSIONS.md`](SPEC-VERSIONS.md).
The test plan was written and committed before `src/geometry/pose.ts` existed (§29):
[`phase6/TEST-PLAN.md`](phase6/TEST-PLAN.md).

**Passed on the device on 2026-08-23**: iPhone / iOS 18.7 / Safari 26.6 over HTTPS, 5/5 required
and 2/2 advisory, `devEntry: false`, with the transition log climbing through the conditions one
at a time rather than arriving at a verdict in one step.

```
3001 pose frames: 1137 POSE, 371 ROTATION_ONLY, 1493 NO_POSE
POSE-005: 230 injected frames — an 8° turn moved the pose 7.999° against 0.448° for the control;
          inlier drift 1.45% against the control's 1.46%, 11 planar flips against 15
POSE-002: the camera recovered 4.388° against the gyroscope's 4.568°, disagreement 0.762°
v3 §16: 104 planar posed from the homography, 0 via an Essential matrix
POSE-004: 371 frames with no parallax, 0 named a translation; 1449 declined, 0 carried a rotation
cost 0.373 ms pose + 0.865 ms RANSAC = 1.238 ms against §H's 6 ms for both together
±20% focal moves the rotation 0.64° and the translation direction 3.12°
```

### The defect the device run found, and what the verdict rests on

**POSE-002 reported `232.3 % agreeing`**, and the screen showed it in green as a pass. That is not
a percentage of anything. `PoseSession` bounds what it retains (§56) but counted agreements with
an **unbounded** counter, so past 400 comparisons the numerator kept climbing over a frozen
denominator. `FlowSession` never had this — FLOW-002 counts its agreements out of the same trimmed
window it divides by — and Phase 6 now does the same, so the mismatch is impossible by
construction rather than repaired.

**So POSE-002's fourth criterion — "at least 60 % of individual frames agree, not merely the
median" — was not exercised**: an inflated number clears a floor trivially. Its other three were
measured correctly, including the substantive one:

| criterion | measured |
| --- | --- |
| ≥ 15 comparable frames | 400 retained of 929 made |
| the gyroscope measured a non-zero rotation | 4.568° |
| median disagreement within tolerance | **0.762° against 3.0°** |
| ≥ 60 % of individual frames agree | **not evaluated** |

The verdict stands on what was measured: the physics comparison passed on real data with a wide
margin, and POSE-005's gate is untouched. A short re-run settles the fourth criterion; until one
exists the bundle is named in `committedEvidence.test.ts` as predating the fix, and the
re-derivation asserts it *is* the broken shape so the exemption cannot outlive it.

### The device settled three things the leg could not

**The gyroscope wobbled, and the net-versus-path distinction earned itself.** The recorded samples
show `gyroPathDeg 20.5` against `gyroNetDeg 4.6` — the operator turned back and forth about four
times as far as the camera ended up rotated. Had this integrated `|ω|`, as `FlowSession` does for
a different question, the instrument would have read 20.5° against the camera's 4.6° and POSE-002
would have failed a **correct** solver.

**Both amendments made before the run were necessary, and the device proves it.** Under POSE-003's
original cross-class comparison this run reports planar translation confidence **0.0909 against
0.0773** with depth — it would have **failed**, while the mechanism it meant to measure is exactly
right. Under POSE-005's original zero tolerance it shows **11 planar flips for the injection
against 15 for the control** — the control, refitting the same data with no injection at all,
flipped *more*. It would have failed too.

**The focal-length assumption matters on real optics.** ±20 % on `f` moves the recovered rotation
by 0.64° and the translation direction by **3.12°**, against 0.012° and 0.057° on the synthetic
leg. The rotation survives the guess; the translation direction depends on it, and any later phase
reading a direction from this one inherits that.

**And the confidence is bound by the population, not the geometry.** `medianConfidence` is 0, with
the terms saying why: `trackedFeatures 0.2136 — 127 against §11's 80 degraded / 300 good`. v3 §19's
confidence is the minimum over its terms, so the §11 shortfall Phase 4's device run recorded
surfaces again here — the pose is well determined and the confidence attached to it is low.

### This is the first phase the automated leg is short of an *instrument*

Rule 004 already meant a `DESKTOP_DEV` bundle could not pass. Here one of the two things the
phase is scored against — the gyroscope — **does not exist** on headless Chromium, so POSE-002
reports `PENDING` with that reason and the leg cannot reach a verdict on it at all. Rule 004
expressed as a measurement rather than as a policy.

### The two instruments, and why neither is optional

**POSE-005 — an injected rotation.** Applying `K·Rⱼ·K⁻¹` to the second view is *exactly* the
camera having turned by `Rⱼ`: if `b = π(K(RX + t))` then `π(K Rⱼ K⁻¹ b̃) = π(K(Rⱼ R X + Rⱼ t))`.
The whole chain is re-run — model fit included — on a set handed over unmarked, and the recovered
rotation must differ by `Rⱼ`. A stage returning the same pose on every frame scores **0.00°**
while having a valid rotation matrix, a unit translation, a small reprojection error and a
*perfect* temporal stability. v3 §67's pass condition for this phase is one line and it names
exactly that failure: **Poseが計算結果により変化**.

The control — the same set, unmodified, refitted — is the other half. Without it a solver
returning noise scores a large difference on the injected set and passes.

**POSE-002 — the gyroscope.** The only comparison in this phase against physics rather than
against arithmetic. Angles only: `rotationRate` is in the device's frame and the camera's differs
by a fixed rotation nobody here has measured, and an angle is invariant under a change of basis
while an axis is not.

**And v3 §19's `IMU consistency` term is deliberately withheld from pose confidence**, named in
the record as an omission rather than dropped. It is the instrument POSE-002 scores this phase
with, and a confidence that consumed the gyroscope could not then be checked against it (§H.7).
Phase 7 is where the IMU becomes an input.

### Two defects the unit tests found before any leg ran

**`svd3x3` was returning a zero third column.** `s₃` is the square root of an eigenvalue of
`MᵀM`, and squaring then rooting puts the numerical zero of a rank-deficient direction around
1e-8 rather than at 0. A threshold on `s₃` let a null direction through, `M v₃ / s₃` divided a
vector of magnitude 1e-17 by 1e-8, and the column came back as zero — leaving `U` with a
determinant of 0 and the Essential decomposition with **no translation axis to enumerate**.

One scene recovered its rotation exactly and the same scene turned by 4° came back 60° wrong,
from identical code. `U diag(s) Vᵀ` reconstructed `M` perfectly throughout, because a column
multiplied by a zero singular value cannot affect the product — **so the reconstruction test
could not have caught it, and did not.** The property that catches it is that `U` must be a
rotation whatever the rank, now asserted over 40 random Essential matrices.

**Cheirality was being asked before the question it presupposes.** Triangulation needs a
baseline, so on a camera that only turned every candidate scored zero points in front and the
frame was reported `NO_POSE` — a pose refused for having no *translation*, which is the one case
where a rotation is perfectly recoverable. "Is the data explained by rotation alone?" is
answerable without knowing which sign of `t` puts the scene in front, so it is asked first, and
from the correspondences rather than from the decomposition: what `K·R·K⁻¹` leaves unexplained
*is* the parallax a translation accounts for.

### POSE-001's direction-spread criterion was withdrawn, with the measurement

Recorded in place in the test plan (§29). It was written as "the spread exceeds 5°", narrowed to
0.5° before anything ran because a steady pan has a genuinely constant direction, and **0.5°
fails a correct solver too**. Driven over a straight-line translation the real solver reports:

```
40 frames with a full pose: median 100% in front of both cameras, reprojection 0 px,
rotation 7.18°, direction spread 0°
```

A spread of exactly zero, because the camera moved in a straight line. There is no threshold
separating that from a fixed vector — **they are the same measurement**, and the difference lies
in whether the number would have changed had the camera done something else. No statistic over
one run can see that; POSE-005 can, because it *makes* the camera do something else.

So the spread is reported and not judged, and `tests/unit/poseStage.test.ts` now asserts that the
constant-pose stage **passes POSE-001** and fails POSE-005 alone. That is Phase 5's division
exactly: GEO-001 is satisfied perfectly by a stage that accepts every correspondence, and GEO-003
separates them.

### Two criteria the leg's own variance corrected

Neither is a threshold moved to make a number pass. Both named one thing and measured another,
and the leg produced two runs that disagreed on identical code. Recorded in the plan with the
measurements (§29); the leg now runs green three times consecutively.

**POSE-003 was comparing two different constraints.** It required the median translation
confidence on planar frames to fall below the median on frames with depth. Run 1: 0.5000 against
0.5691, PASS. Run 2: 0.5000 against 0.4682, FAIL. Confidence is the **minimum** over its terms,
so on a planar frame the binding term is the §16 penalty (0.5 exactly, every time) while on a
frame with depth it is whatever else was worst — on run 2, a thinner population. The comparison
was measuring the population. §16 says 「この状態ではTranslation confidenceを低下させる」, which is
about a frame and not about an average across scenes, so the criterion is now within-frame — no
planar frame's translation confidence may exceed its own rotation confidence — plus a direct
measurement of the mechanism: the candidates cheirality could not separate, 2 on a plane against
1 with depth.

**POSE-005's criterion 4 said "to within a tolerance" and the implementation had none.** Run 1:
0 of 47 injected frames drifted. Run 2: 1 of 47, and the phase failed. The invariant is real but
not exact — the epipolar geometry maps exactly under an image-space rotation, `b′ᵀ(Hⱼ⁻ᵀF)a =
bᵀFa`, but the **pixel threshold** does not, because a Sampson distance is not invariant under a
projective map of one image. A correspondence sitting on 1.5 px can cross. The tolerance is now
10 % on the median, with the **control's own drift recorded beside it** as the noise floor of
refitting the same data with no injection at all. Both read 0 % on the leg.

### `INTRINSICS: ESTIMATED`, and the half of it that is usually left out

v3 §15 gives K and, in the same breath, what to do when it cannot be obtained. It cannot: Safari
exposes no focal length, no sensor size and no lens identifier, and the Phase 5 device run
reported `label: 背面デュアル広角カメラ`, `720×1280`, `aspectRatio 0.563` and nothing about
optics. So K comes from an assumed 67° field of view across the long edge, and every record says
so.

**And every judged frame reports how far the pose moves when `f` is scaled ±20 %.** A stated
assumption whose consequences are unmeasured is a guess with a number attached. On the automated
leg it moves the rotation by 0.012° and the translation direction by 0.057°; whether that holds
on a real lens is the device run's to say. §H.0 is why K is recomputed per frame rather than read
once: rotating the device swaps the frame dimensions on the same track, and `fx, fy, cx, cy` all
change with them.

### Three things this phase does not do

- **No metric scale.** `LOCAL_UNITS`, and ‖t‖ is 1 because it was normalised — which is not a
  measurement. v4 §18 states the prohibition and v3 §15 states it too.
- **No map.** The triangulated points exist only to run the cheirality test and the reprojection
  error; they are not retained. Phase 9 triangulates for keeping.
- **§33's `GOOD` stays unreachable**, deliberately. Phase 6 supplies the `reprojectionError`
  Phase 4 named as missing, but §33's state is computed in `FlowStage` from what Phase 4
  measures, and plumbing a Phase 6 quantity back into a passed phase's state machine is a change
  to Phase 4 rather than an addition to Phase 6. Deferred to the phase where a single fused pose
  exists to carry it; `goodBlockedBy` continues to name what is missing.

---

## Phase 7 — TESTING

Built. `docs/phase7/TEST-PLAN.md` was committed before any Phase 7 code existed (§29), and the
automated leg is green: `docs/phase7/evidence/phase7-desktop-chromium.json`.

**No device bundle yet.** Rule 004 stands — nothing passes this phase until an iPhone / Safari /
HTTPS run exists. `docs/phase7/HOW-TO-RUN-DEVICE-TEST.md` is that run.

### The first automated leg in this project that decides a required test

v3 §68's pass condition for this phase is unusual among the per-phase tables in being about
**absence**:

> PASS条件：**IMU unavailableでもVision-only modeで継続可能。**

Headless Chromium has no accelerometer and no gyroscope. That is not the leg's limitation — it is
the condition the spec asks the phase to handle, and it is permanently the case there. So IMU-002
is decided on every commit, through the real control on the real screen, alongside IMU-006 and
IMU-009 which need no sensor either. Every leg before this one was short of the instrument its
phase was scored against and could only report `PENDING`.

Rule 004 is untouched: `DESKTOP_DEV` cannot pass a phase. What changed is that one required
record is now checked continuously rather than once, by hand, on a phone.

### Two of v3 §18's five filter states, and three refusals with a number behind them

| state | Phase 7 | why |
| --- | --- | --- |
| `orientation` | estimated | observable from the gyroscope, the visual rotation and gravity |
| `gyroBias` | estimated | vision and a biased gyroscope disagree consistently in one direction |
| `position` | **refused** | the accelerometer reports m/s² and Phase 6's translation has no scale |
| `velocity` | **refused** | same reason |
| `accelBias` | **refused** | not observable without position observability |

The refusal is a unit mismatch, not a preference: fusing an acceleration with a scaleless
direction requires the scale, which is precisely the quantity a monocular camera does not have.
So **IMU-006 measures what would have happened had it been done anyway** — the accelerometer is
double-integrated over the run, for the record only, never fed to the pose, and the drift is
reported. A refusal with a number behind it is a finding; a refusal with a citation behind it is
an assertion.

`POSITION: UNAVAILABLE` is carried as a **value**, not an absent field, so Phase 9 has to remove
it deliberately rather than by forgetting.

### The instrument this phase is scored against

Phase 6's witness was the gyroscope. Phase 7 *consumes* the gyroscope, so it needs a different
one, and there is only one kind left: ground truth the harness makes and does not disclose.

**IMU-005 — an injected gyroscope bias.** Two `OrientationEkf` instances run on the same visual
poses and the same gyroscope, and one is fed every sample with a constant 3.0 °/s added before it
sees it. Neither is told which it is. The measurement is the **difference** between their bias
estimates: the phone's own bias is unknown and common to both, so it cancels — which is what
makes this decidable on a device whose real bias nobody can look up.

3.0 °/s is not arbitrary. Phase 6's POSE-002 tolerates `max(3.0°, 30 % of measured)`, and the
device's anchor intervals ran about a second, so a 3 °/s bias accumulates 3° per anchor — exactly
the smallest bias that would have shown up as a Phase 6 failure.

A fusion that returns the visual pose unchanged scores **0.0 °/s** here while passing almost
everything else: its orientation tracks the camera perfectly, its innovation is exactly zero —
*better* than a real filter's — and it never invents a position.

### The finding that corrected the test plan

The plan's table said a dead-reckoning fusion also scores 0 on the bias difference. **It does
not.** Gravity is a two-degree-of-freedom measurement, but on a device that *turns*, the body
axes move relative to it and over a minute all three body-frame bias components become observable
through gravity alone. Driving the real `FusionStage` for 60 s with **no visual updates at all**:

| | control | injected | difference |
| --- | --- | --- | --- |
| measured, gravity only | (0.400, −0.900, 0.200) | (0.400, 2.100, 0.200) | **2.9996 °/s on *y*** |

against a true bias of (0.4, −0.9, 0.2) °/s and a 3.0 °/s injection on *y*.

So IMU-005's criteria 1–3 are not by themselves evidence that vision was fused. Two things
follow, and neither relaxes anything:

1. **Criterion 4 is load-bearing** — the injected filter's own innovation must stay inside
   IMU-003's tolerance. It was already in the committed plan, and it is what separates a filter
   applying the visual correction at a gain near zero: such a filter is left disagreeing with
   vision by a margin that grows without bound.
2. **`biasDifferenceDps` is withheld until 10 *visual* updates have been applied** — not because
   the estimate is poor without them, but because a number a dead-reckoner can produce cannot be
   the gate on a fusion. A run with no vision reports `PENDING` and cannot pass the record.

The criteria are unchanged. What changed is the reasoning printed beside them, and the amendment
is recorded in place in the plan with the measurement that forced it (§29).

### A second fixture defect, found the same way

The first version of the stage fixture reported on pose frames only — so `propagatedMs` was
`now − lastPoseAt` evaluated at the instant the pose arrived, which is **exactly 0 on every
frame**, and IMU-001's third criterion (that the filter propagates between visual updates) could
not be tested at all. The app reports on every render frame and Phase 6 delivers at about 20 Hz;
the fixture now does the same. The same shape as Phase 6's withdrawn direction-spread criterion:
a run that cannot distinguish the failure from correct behaviour is measuring the fixture.

### Phase 7's confidence is a second number, not an edit to Phase 6's

Phase 6's `poseConfidence` is untouched. It describes the *visual* pose and it withholds v3 §19's
`IMU consistency` for a reason that is still true: POSE-002 scores Phase 6 against the gyroscope,
and a confidence that consumed it could not be checked against it. Phase 6 has passed on the
device with that arrangement, and changing it now would be editing a passed phase.

So Phase 7 computes a separate confidence for the *fused* pose with all seven of §19's inputs,
and both travel in the bundle. The fused terms are the visual terms plus `imuConsistency` and
`propagation`, and the combination is the **minimum** — so a minimum over a superset cannot
exceed the minimum over the subset, and **attaching a sensor can only ever lower the number**.
v3 §19's prohibition (不確実なPoseは強制的に高confidenceにしない) holds by construction rather
than by test.

`propagation` is not one of §19's seven. It is there because v3 §17 limits how long a propagated
orientation is worth anything — 短時間回転推定 — and IMU-007 requires the confidence to fall while
running open-loop. It is flat while vision is live and ramps to zero between 500 ms and 3000 ms.

**3000 ms is derived, not chosen.** With the bias uncorrected at the ~1 °/s a consumer MEMS part
drifts, the orientation error reaches Phase 6's own 3° agreement floor after three seconds — the
point at which a propagated orientation stops being as good as a measurement. Past it the pose is
`DEAD_RECKONING` with a confidence of zero and `usable: false`.

### The world frame is defined, not assumed

iOS and other platforms disagree about the sign of `accelerationIncludingGravity`, and one sample
from one device cannot settle it. So no sign convention is assumed: whatever direction the
measured gravity vector points in the body frame at initialisation **is** the world's down axis,
by definition. Every later gravity reading is checked against that definition, and `gravityDeg`
then means "has the filter drifted relative to where down was when it started" — which is the
question worth asking.

A gravity sample is used only when ‖g‖ is within ±0.5 m/s² of 9.81. Outside that the phone was
accelerating and the difference is not a gravity direction at all, so it is rejected rather than
fed in with a larger noise: a measurement of the wrong quantity is not a noisy measurement of the
right one.

### What the leg's sensor list caught

```
acceleration ABSENT, accelerationIncludingGravity ABSENT, rotationRate ABSENT,
interval ARRIVING, deviceorientation ABSENT, magnetometer ABSENT
```

Headless Chromium **fires `devicemotion` with a valid `interval` and every vector `null`** — which
is what a half-granted permission looks like on some builds. A channel counts as arriving only
when it has delivered a finite three-vector, not when the event fired; a run that had counted
events would have called this an IMU. An absent channel is carried as an empty array rather than
as zeros for the matching reason: a phone on a table reports a real `[0, 0, 0]` rotation rate.

### Three things this phase does not do

- **No position, no velocity, no scale.** See the table above; the drift is measured and reported
  so the refusal carries a number.
- **No absolute heading.** `webkitCompassHeading` exists on this platform and Phase 7 does not
  read it, so the heading is `RELATIVE` — to wherever gravity pointed when the filter started.
  The sensor inventory lists the magnetometer as a channel it declines rather than omitting it.
- **§33's `GOOD` stays unreachable**, for the fourth phase running and for the reason Phase 6
  gave: the state is computed in `FlowStage` from what Phase 4 measures, and plumbing a later
  phase's quantity into a passed phase's state machine is a change to Phase 4. `goodBlockedBy`
  continues to name what is missing.

## Phase 8 — TESTING

Built. `docs/phase8/TEST-PLAN.md` was committed before any Phase 8 code existed (§29), and the
automated leg is green: `docs/phase8/evidence/phase8-desktop-chromium.json`.

**No device bundle yet.** Rule 004 stands. `docs/phase8/HOW-TO-RUN-DEVICE-TEST.md` is that run,
and the one thing it asks of the person holding the phone is unusual: **stand still for ten
seconds**.

### The first leg in this project to decide a phase's whole required suite

Phase 7's leg decided one required record, because v3 §68's pass condition was about an absence
headless Chromium is permanently in. Phase 8's decides all six, for a different reason: the two
instruments this phase is scored against are **a camera that is not moving** and **a metronome**,
and the harness can produce both. The feed holds still for seven seconds in the middle of a pan;
the metronome runs inside the app, on the same frames, beside the real selector.

Rule 004 is untouched, and it is not a formality here. The leg's "still" is a synthetic frame
repeated exactly, and a hand-held phone is not still — Phase 4's search will often call it `SLOW`.
The leg's population runs to several hundred points; the device's ran to **41** in a dim room
(§H.8). Both change what the store holds and how fast it goes stale.

### Two of v3 §20's six numbers, and one refusal with a measurement behind it

| v3 §20 | Phase 8 | |
| --- | --- | --- |
| rotation ≥ 10° | implemented | assembled per anchor epoch — see below |
| translation ≥ 0.10 local unit | **refused** | it is a magnitude; Phase 6 gives a unit direction |
| median displacement ≥ 30 px | implemented | over the features the two views **share**, by id |
| tracking quality changed | implemented | §33's state, or v3 §14's own usable→GOOD band |
| minimum interval 0.5 s | implemented | |
| maximum interval 5 s | implemented | the heartbeat a still camera still owes the store |

The refusal is Phase 7's shape one phase along: `TRANSLATION: UNMEASURED` is carried as a
**value** in every decision record rather than as an absent field, so a later phase that acquires
a scale has to remove it deliberately. And it carries a number — the angle the translation
*direction* moved, which *is* measurable — because a refusal with a number behind it is a finding
and a refusal with a citation behind it is an assertion.

### The instrument, and what a metronome scores on everything else

| | this selector | a metronome |
| --- | --- | --- |
| v3 §20's intervals | held | held |
| the 30-keyframe bound | held | held |
| observations and intrinsics per keyframe | carried | carried |
| keyframes on a **moving** camera | well separated | well separated |
| keyframes over 377 **static** decisions | **4**, all heartbeats | **52** |

13× on the committed run. Everything above that last row is satisfied by a program that reads a
clock and nothing else.

### Four defects the leg found before any device saw the code

**A re-derivation that rounds its inputs is checking the formatter.** KEY-001's second criterion
re-derives every decision from the inputs recorded beside it — the Rule 002 check Phases 4–7 all
carry. The first version rounded `sinceLastMs` to a tenth of a millisecond on its way into the
record, `499.99999999999955` became `500`, and the re-derivation then disagreed with the stage on
**every decision that landed on v3 §20's minimum interval**: 30 of them in a 32-second unit
fixture. The recorded inputs are now the decision's inputs to the bit.

**Composing a per-frame increment over five seconds is a random walk.** The rotation since the
last keyframe was first accumulated the way `FusionStage` accumulates its visual increments,
`conj(q_prev) · q_cur` every frame. Phase 7 composes over one second and is unaffected; Phase 8
composes over up to five, and on the leg's lateral pan — where the true rotation is zero
throughout — the accumulated angle reached v3 §20's 10° and fired `ROTATION` **seven times while
Phase 4's own scene-shift search was reporting that the image was not moving at all.** It failed
KEY-002 for exactly the right reason. The rotation is now assembled per anchor epoch: one
composition however many frames have passed, and one more at each re-anchor. The same leg fires it
none, and the amendment is recorded in place in the plan (§29).

**A rotation the layer below had refused to stand behind.** The per-epoch assembly above took
`ROTATION` on a still camera from every run down to about two in six, and left the rest. Two
further findings, both measured rather than guessed, account for those. First, the re-anchor was
handled *inside* the branch that needs a pose, so a re-anchor landing on a pose-less frame left
`epochBaseQ` holding a rotation measured from the **old** anchor while the next pose to arrive was
measured from the new one — and on a still camera that is not a rare alignment but the normal
case, because the anchor is re-taken from the current frame, the two views collapse to no baseline
and Phase 6 recovers nothing until something moves. The chaining is now unconditional.

Second, and the actual cause: the leg was made to print the pose beside each violation, and every
one of them read `ambiguous true ... 2 unseparated candidate(s)` —

```
[p8] still-interval violation: ROTATION on 18.2051° / 0 px after 529 ms, 231 shared,
     0 dropped increment(s) across 0 re-anchor(s); pose POSE, ambiguous true,
     rotationConfidence 0.5693, 2 unseparated candidate(s)
```

On a static image the correspondences stop changing, cheirality stops separating the essential
matrix's four decompositions, and the recovered rotation **alternates between two of them** —
about 18° apart here, so v3 §20's 10° is crossed twice over by an artefact rather than by a
camera. Phase 6 had been reporting the pose it chose *and* saying it could not tell; Phase 8 was
reading the first field and ignoring the second. It now declines an `ambiguous` pose outright —
the accumulator holds at its last settled value, and `ambiguousPosesDeclined` (73 on the committed
run) travels in every record, because an interval spent entirely in ambiguity under-reports a real
turn and that has to be visible rather than silent. v4 §25 one layer earlier than §25 names it: a
confidence the layer below publishes is only worth publishing if the layer above acts on it. Six
consecutive legs green after the change, from about two in six failing.

**And a cost that measured the fixture rather than the platform.** Every eviction records the
retained set's median pairwise separation beside what dropping the oldest would have given — the
counterfactual KEY-003's fifth criterion reads. The first version built one observation index per
pair, 435 of them over a several-hundred-point population, and the mean keyframe cost came to
1.67 ms against this phase's own 1.0 ms ceiling. Indexing each keyframe once brings it inside.
§H.8, for the second time.

### What the store does when it is full, and why not the oldest

The bound is §H.1's 30. When it is full, what goes is a **stale** keyframe if there is one —
fewer than a quarter of its observations still tracked, which is v4 §20's *古い情報* made
measurable and is deliberately not a function of age — and otherwise the **most redundant
viewpoint**, the one whose nearest neighbour is nearest. Never the oldest: dropping the oldest
turns a store that describes the room into one that describes the last fifteen seconds, which is
the failure §56's bound would otherwise cause rather than prevent.

That policy also went through a correction. It first scored a candidate by the sum of its two
neighbour gaps — the gap its removal would leave — which on a camera panning in one direction is
the same number for every interior keyframe, because the separations add along the path. Its only
real effect was to favour the endpoints, whose missing side counted as a zero. The nearest
neighbour decides now, the merged gap breaks ties, and an unmeasurable side is `Infinity` rather
than `0`: two keyframes sharing no features are not in the same place, they are not comparable.

### Four things this phase does not do

- **No relocalisation.** v3 §21 is a later phase; a keyframe store is one of its inputs.
- **No keyframe imagery.** §H.1 budgets 30 downscaled grayscale frames at ≈16 MB for a relocaliser
  that does not exist yet. Phases 8, 9 and 10 need the observations and the pose; storing pixels
  nothing reads would be carrying data no test can check. Recorded so the phase that needs them
  adds them deliberately.
- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes and it belongs to the phase that has
  a map to adjust.
- **No change to Phase 5's anchor.** It is a documented one-slot stand-in for this phase and it is
  what Phases 5 and 6 passed on the device with. The store is a second structure beside it.

## Phase 9 — TESTING

Built. `docs/phase9/TEST-PLAN.md` was committed before any Phase 9 code existed (§29), and the
automated leg is green: `docs/phase9/evidence/phase9-desktop-chromium.json`.

**No device bundle yet.** Rule 004 stands. `docs/phase9/HOW-TO-RUN-DEVICE-TEST.md` is that run,
and what it asks for is a scene with **depth** in it and room to walk sideways — a wall is a
plane, and turning on the spot is exactly what this phase refuses to triangulate from.

### The first three-dimensional quantity in the project, and two refusals around it

A batch is two **keyframes** — the one Phase 8 has just inserted, against the one before it —
related by the observations they share, matched by the tracker's feature id rather than by
proximity. That last part is what makes a triangulated point recognisable to Phase 10.

| | |
| --- | --- |
| below `MIN_PARALLAX_DEG` = 1.0° | **refused**, per point |
| from a camera that only turned | **refused**, whole batch |
| behind either camera | refused |
| beyond v3 §33's 2.0 px reprojection | refused |

**The floor is derived, not chosen.** A triangulated depth's relative uncertainty is `σ_Z/Z ≈
σ_θ/θ`; §13's 1.5 px correspondence band over the assumed `f ≈ 967 px` is 0.089° of angular noise,
and asking for a depth good to a tenth of itself gives 0.89°. A floor in the units of the physical
quantity rather than a percentile of whatever the frame contained — §H.6, and Phase 3's corner
floor is why that rule exists.

### The pose for the pair is a fresh fit, and it has a witness

Phase 6's rule is that it decomposes the model Phase 5 selected *on that frame*, never a fresh
fit. Phase 9's pair is a **different pair of views** and no model exists for it, so one is fitted —
by the same `verifyCorrespondences` Phase 5 uses, decomposed by the same `recoverPose` Phase 6
uses, neither modified.

What that buys is TRI-006. Phase 6 already measured the rotation between these two keyframes by an
entirely different route — per-frame poses against Phase 5's moving anchor, composed by Phase 8
across anchor epochs — and the two are compared at Phase 6's own tolerance. On the leg: the fit
says 0.036°, the chain disagrees by 0.066°, tolerance 3°, 90 of 94 batches inside it. A fresh fit
with a witness is a measurement; a fresh fit without one is a second answer.

### Two gates, because two different fakes produce a full set of plausible points

| | this triangulator | a constant depth | a solver that solves anything solvable |
| --- | --- | --- | --- |
| points in front of both cameras | yes | yes | yes |
| reprojection inside 2 px | 0.036 px median | **0.05, self-reported** | yes |
| counts that add up | yes | yes | yes |
| **TRI-004** — depths the harness chose | **0** error | **0.237** — the control exactly | ok |
| **TRI-003** — a camera that only turned | **0** points | 0 points | **a full set** |

`tests/unit/triangulation.test.ts` drives the real stage with the constant-depth solver — the real
batching, the real fit, the real injections — and it fails **TRI-004 and nothing else**, while
reporting a *better* reprojection error than the real triangulator. That is the difference between
a statistic a stage computes about itself and a measurement against something it cannot see.

### What the leg measured

95 batches over 60 s: 88 triangulated, 8,011 points, median 87.5 per batch. Worst accepted
parallax 1.20° against the 1.0° floor; median depth uncertainty 0.053 against the 0.10 it was
derived to buy. 16 pure-rotation injections, **0 points from all of them**, and the pose came back
`ROTATION_ONLY` 16 times out of 16 — the refusal is attributed rather than assumed.

### The refusal to pool depths, with the number behind it

Every depth is in units of **that pair's own baseline**, which is `1` by construction. Two batches'
depths are two different units, and no record aggregates them. The number behind that refusal is
on the screen: the **batch-to-batch spread of the median depth is 0.87** on one scene with one
camera. The median depth moves by 87 % of itself between pairs, not because the room changed.

Phase 10 is where the pairs are brought into one frame by the landmarks they share.

### Two corrections the measurements forced

**"On a sampled schedule" was sampled on the wrong cadence.** The injections were requested by a
flag the composition root sets on its own option cadence — how Phases 5 and 6 do it, and those
phases sample *frames*. This phase's unit of work is a **batch**, which happens when Phase 8
inserts a keyframe, and the main thread does not know when that is. The leg measured an injection
on **64 % of batches** at 20.9 ms each; the stage samples on its own batch index now, one in six
for each, and the same leg measures 15.4 ms.

**A noiseless fixture cannot exercise TRI-006.** The unit fixture built its keyframes by exact
projection, so both routes agreed to the last decimal and the *not identically zero* criterion
fired on the fixture rather than on a defect. A fifth of §13's band is added to every observation
now, which is what a well-tracked point actually looks like.

### The cost, and the worker §B.2 has been planning since before Phase 0

15.4 ms per batch on the leg's machine against a ceiling this phase set for itself at 8.0, and
**3.0 ms amortised over every frame**. TRI-008 is advisory and excluded from the leg's gate for
the reason every cost record is (§H.4). §B.2 has had a mapping worker in the diagram since before
Phase 0 and it is not built; the argument for building it should be a measurement, and the
amortised figure is that measurement. The device's own is the one that decides it.

### Four things this phase does not do

- **No shared scale between batches.** See above. It is what a monocular camera gives.
- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes, and it belongs to the phase that
  holds a map to adjust.
- **No surfaces, no meshing, no completeness.** v4 §21 asks for *Sparse Spatial Information* and
  §16 forbids treating what cannot be observed as geometry.
- **§33's `GOOD` stays unreachable**, for the sixth phase running and for the reason Phase 6 gave.

## Phase 10 — TESTING

Built. `docs/phase10/TEST-PLAN.md` was committed before any Phase 10 code existed (§29), and the
automated leg is green: `docs/phase10/evidence/phase10-desktop-chromium.json`.

**No device bundle yet.** Rule 004 stands. `docs/phase10/HOW-TO-RUN-DEVICE-TEST.md` is that run,
and what it asks for is unusual again: **walk back the way you came**. This phase is about a point
being recognised the second and the fifth time it is seen.

### What this phase is for, in one number

Phase 9 leaves one answer per keyframe pair, each in units of that pair's own baseline. Its leg
measured the median depth moving by **87 % of itself** between consecutive batches on a scene that
never changed — not because the room moved, but because the unit did.

Phase 10's registration recovers the ratio between those units, as the scale term of a similarity
fitted in closed form over the landmarks two batches share. On the leg it came to **1.387** at a
residual of 0.0005 of a depth: the batch's baseline was 39 % longer than the world's unit. That is
a ratio between two quantities nobody has measured, and it is what makes ninety separate answers
one map. §34 fixes the origin at the initial camera pose and §A.3.1 records why it cannot be
anything else: `absolute` is `false` here and the compass reported ±24.5°.

### Two gates, and the fixture that corrected the plan about one of them

| | this map | one that keeps only the newest observation |
| --- | --- | --- |
| registers every batch | yes | yes |
| counts add up, bound holds | yes | yes |
| **MAP-002** — held-out prediction | 0.111 px | *also fine* — it predicts from the previous batch |
| **MAP-006** — convergence | 0.00048 → 0.00011 | **flat**: nothing is being averaged |
| **MAP-005** — injected corruption | recall 1.00, excess 0 | (unchanged) |

`tests/unit/landmarks.test.ts` drives the real stage with the position rule replaced, and it fails
**MAP-006 and nothing else**. The test plan's first fake claimed MAP-002 would catch it; **it does
not**, and the fixture is what showed that. MAP-002 catches a map with no position at all — one
that "predicts" by handing back the observation, which its fourth criterion refuses. MAP-006
catches a map that re-guesses. Both are needed, and they catch different things.

### Five corrections the measurements forced

All five are recorded in the plan beside the criteria they affect.

1. **The gate was not looking at what the injection corrupts.** Only the held-out prediction
   check existed — the map's position against the *observation* — and MAP-005 displaces what the
   batch *offers*. Recall **0.17** against a floor of 0.90.
2. **That comparison belongs in the image.** In world units it refused **71 %** of untouched
   points, because the dominant error in a triangulated position is radial and a half-percent
   depth error is 2.4 px of world displacement the camera cannot see.
3. **…and the registration's trimming does not.** The same lesson applied to the fit made it
   worse — clean rejections 0–12 % → 15–22 % — because a similarity's *scale* is a depth quantity.
   Same numbers, opposite conclusions.
4. **`MAX_CLEAN_CULL_RATE` measured the scene rather than the gate.** This gate refuses the tail
   of two estimates' disagreement whether or not anything was injected: 3–20 % on *uncorrupted*
   batches. The criterion is the **excess** over that baseline now, which is a stricter question —
   an absolute ceiling is passed by any sufficiently quiet scene.
5. **A rate that is not one, and an epoch that was not founded.** The sparsity read **338 %** of
   the tracked population, because the map remembers what has left the frame — the same shape as
   Phase 6's 232.3 % agreement rate, and the range check now catches the class. And a restart on a
   batch with no points reported `EPOCH_RESTART` with no registration behind it, which MAP-003
   caught as *a batch ingested without a registration*.

### What the leg measured

96 batches over 60 s: 86 registered, 1,542 landmarks of §56's 5,000, **1,098 confirmed**, 4 culled
— all for disagreeing rather than for age. Held-out prediction **0.111 px** median from landmarks
with a median of 3 observations at the moment they were asked; **none** exactly zero. Injection
recall **1.00** with a false-cull excess of **0**. Convergence 0.00048 of a depth at two
observations and 0.00011 at five.

### Confidence has four terms and none of them is a clock

Observation count, the parallax that determined the point, how well its predictions land, and how
many viewpoints have seen it — combined as the **minimum**, the arrangement Phases 6 and 7 use.
`scripts/audit-fake-data.mjs` bans a confidence computed from `Date.now`, `elapsed` or `age`, and
enforces it mechanically. A landmark seen for a long time is not thereby a good landmark.

### Three things this phase does not do

- **No bundle adjustment.** §27 puts it every ≥ 10 keyframes. The map here is a running mean per
  landmark and a chain of similarities between batches; a joint refinement is a different thing
  and is not on Prototype v1's path to a ball game.
- **No loop closure, no relocalisation.** v3 §21 is a later phase. Two visits to the same corner
  produce two sets of landmarks, and the run reports how many epochs it had rather than
  pretending they were one.
- **No surfaces and no completeness.** v4 §22's own line, carried as a value: everything between
  the landmarks is unobserved. Phase 11 is where surfaces begin, from these.

### The cost, and §B.2's worker, twice over

1.49 ms per batch and **0.23 ms amortised over every frame**, against a self-set 4.0 ms ceiling.
With Phase 9's 3.0 ms amortised, that is what a second thread would be buying. §B.2 has had a
mapping worker in the diagram since before Phase 0; the argument for building it should be a
measurement, and these are the two to watch when the device produces its own.

---

## Consolidation, 2026-08-23 — after Phase 7

Seven phases had accumulated seven copies of a good deal of code. This pass removed **3,900
lines and added 2,100**, most of the addition being the documentation on the modules that
replaced the copies. Nothing about what any phase measures changed, and that is checked rather
than asserted — see *How the numbers were held still* below.

### What was shared, and what deliberately was not

| Moved to | What it replaced |
| --- | --- |
| `src/ui/dom.ts` | `el` × 8, `card` × 8, `stat` × 7, and the formatters × 3–4, all byte-identical |
| `src/ui/phaseSections.ts` | `renderTests`, `renderEvidence`, `renderNavigation` × 7 |
| `src/core/stats.ts` | `median`, `round` and §56's `trim` × 4 sessions |
| `src/testkit/runTests.ts` | the `Evaluation` shape × 8, `PhaseNTest` × 8, and the runner loop × 8 |
| `scripts/lib/harness.mjs` | `serve` + MIME × 8, the launch arguments × 5, the phase ladder × 4 |
| `scripts/lib/feed.mjs` | the two-layer texture × 3, and the Y4M writer × 4 |
| `src/main.ts` | seven `phaseNTimer` fields, seven start/stop pairs, seven `evaluatePhaseN` tails |

Four things that look shareable were left alone, each for a reason:

- **Phase 0's tests and evidence cards.** They list `CAP-0001..CAP-00NN` with `Input` and `Fail
  if` rows, carry no phase verdict head, and include the raw-JSON panel. A different card that
  happens to share a name; folding it in would have meant a parameter ignored six times in seven.
- **`Phase2Tests`, `Phase3Tests` and `Phase4Tests` keep their own percentage formatter.** It is
  *unguarded*: it prints `-50%` where the shared one prints an em dash. The two look like the
  same function and are not, and unifying them would have silently changed what three passed
  phases print.
- **Phase 0's browser context.** No touch, no mobile flag, no console capture — it probes
  capabilities and screenshots the result, and a touch-enabled context changes what
  `CapabilityDetector` reports about the platform it is on.
- **Phase 1's second browser launch.** It must *not* carry `--use-fake-ui-for-media-stream`.
  CAM-002 is about what the app does when a user says no, and a flag that answers the prompt
  with yes would make the run measure nothing. The shared `launch()` takes `autoGrant` as a
  parameter for that one leg's sake, and the flag lists it produces are identical, argument for
  argument, to the eight hand-written ones it replaced.

### `climbTo` is the one that was worth doing for its own sake

Five legs each walked the same ladder — enter Phase 2, start the pipeline, enter Phase 3, press
`#start-detection`, and so on — because §H.5 records what skipping it cost: on a device, Phase 6
is reached from a screen whose camera, pipeline, detector, tracker and verifier are *already
running*. A leg that enters a phase cold exercises a sequence no device ever takes, and twice
that difference was a control the engine answered for while nobody could press it.

That sequence is now written down in one place, and it still presses the controls a person
presses. `expectLocked` and `pressStart` came out of the same five legs and keep the same two
checks: the door to the next phase must be shut and say why (Rule 005), and the start button must
be pressable on arrival and must change its label once the run is going (Rule 002).

### How the numbers were held still

Three checks, none of which is "the tests still pass":

1. **The screens' markup was rendered before and after and compared.** All seven phase screens
   were driven to the moment of arrival and their last three cards dumped from the live DOM.
   **21 of 21 cards came back byte-identical** — same ids, same classes, same text, same em
   dashes. `scripts/dump-screen-markup.mjs` is the instrument, kept because the next refactor of
   this kind will want it.
2. **The synthetic feeds were regenerated and hashed.** The four legs that film a scene write a
   Y4M file whose pixels the committed measurements were taken on. All four hash **identically**
   to the pre-refactor files — `2fff849d…` for Phase 4, `b461c50b…` for Phase 5, `1fe5d79f…` for
   Phase 6, `74769e88…` for Phase 7.
3. **Every leg was re-run and its bundle compared field by field** against the committed one:
   verdicts exactly, measurements against run-to-run variance.

### What check 3 found, which the other two could not

**The Phase 4 leg had stopped injecting stress, and it still exited 0.**

The original turned injected load on after starting the pipeline and left it on across both
handovers, *so the leg covers a pipeline arriving in a state neither Phase 3 nor Phase 4 may
measure in*. That step sat **between** two rungs of the ladder, and `climbTo` — which models the
ladder as a list of rungs — had nowhere to put it. The extraction swallowed it.

The leg stayed green, because the assertion it feeds (`tracking started with N stress passes
still injected`) passes vacuously when nothing was ever injected. A check that cannot fail is not
a check, and this one had quietly become one.

Nothing in the diff showed it. What showed it was running the old code and the new code **on the
same machine**, three times each:

| | `anyStressed` | `segments` | `longestCleanSegment.index` |
| --- | --- | --- | --- |
| old code, 3 runs | `true`, `true`, `true` | 3, 3, 3 | 2, 2, 2 |
| new code, 3 runs | `false`, `false`, `false` | 1, 1, 1 | 0, 0, 0 |

`climbTo` now takes an `onRung(n, page)` hook, and the injection lives in the Phase 4 leg that
wants it rather than in the shared ladder — a step only some legs take belongs to those legs. The
fixed leg reports `anyStressed=true`, 3 segments, index 2 and `stressPasses=0`, matching the old
code on every stress figure. The other legs were audited the same way: only Phase 3's had a
comparable step and it survived; a structural diff of every leg's call sequence shows nothing
else dropped.

### Why the comparison needed four corners, not two

The first pass compared the committed bundles against a post-refactor run and found 59–217 fields
moved per bundle. That comparison is **confounded**: the committed bundles were captured on a
different day, so it measures code *and* machine conditions together. Two more runs settle it:

| | old code | new code |
| --- | --- | --- |
| **earlier conditions** | the committed bundles | — |
| **same session** | run the old code again | two runs |

- new code twice, same session → the noise floor.
- old code vs new code, same session → the code, isolated.

Held that way, phases 0–3 and 5–7 sit **at** the noise floor. A field only counts as a candidate
if each version agrees with *itself* across its runs and the two disagree: at two samples per
side that gave **6 of 771 scalar summaries**, on a codebase where the old code disagrees with
itself on 25–62 fields per bundle.

**Two samples per side is not enough**, and the six are what taught that. A field with a narrow
spread passes a self-consistency filter by chance. Taking a third sample of each version:

| candidate | old code ×3 | new code ×3 | |
| --- | --- | --- | --- |
| `phase4 pipeline.anyStressed` | true, true, true | false, false | **real — the dropped stress step** |
| `phase4 longestCleanSegment.index` | 2, 2, 2 | 0, 0 | **real — same cause** |
| `phase4 overlayAlignment.best` | rot90 ×3 | rot180, rot180, flipY, rot90 | noise — 3 values in 4 runs |
| `phase5 medianDeclinedOutOfReach` | 37, 37, **38** | 38, 38, 38 | noise — ranges overlap |
| `phase5 medianDeclinedTooClose` | 275, 275, **272.5** | 272, 272, **275** | noise — ranges overlap |
| `phase7 medianReprojectionPx` | 0.051, 0.051, **0.049** | 0.052, 0.052, **0.051** | noise — ranges overlap |

Every third sample of the four noise rows landed inside the other version's range. The two real
ones are the same defect, and it is fixed above.

**With the fix in and three samples of each version: 0 of 771 scalar summaries** differ where
both versions are self-consistent. `overlayAlignment.best` is the probe's own `NOT ARMED` verdict
(best/random 1.06×) showing up as the argmax of noise — it produced three distinct values across
four runs of the same code.

Field *counts* are a poor instrument here and were nearly misleading: the movement is dominated
by list structures — the adaptive controller's decision sequence and `shiftCrossCheck`'s sliding
window — where one frame of timing offset renumbers every index. Dropping list indices and
comparing only scalar summaries is what made the six visible.

An earlier attempt to prove point 1 by comparing the *source* of the extracted functions was
abandoned: the comparison was matching multi-line chunks rather than tokens, and it reported
differences that were line wraps. A check that cannot tell a real difference from a reformat is
not a check — the same shape as the fixtures Phases 6 and 7 each had to throw away.
