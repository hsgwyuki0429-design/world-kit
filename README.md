# Safari Spatial Mapping Engine

Turning what an iPhone's Safari can actually observe — camera frames and motion — into a
reusable **Spatial World**, and letting a game layer collide with the geometry that was
reconstructed from the real room.

Built strictly to spec, phase by phase — `Safari Spatial Mapping Prototype v3.0` through
Phase 4, and `Safari Spatial Game v4.0` from Phase 5 on. v4 re-scopes the product: the Spatial
World stops being the deliverable and becomes the substrate for a ball game played against the
surfaces actually observed in the room. It is also shorter, and several numbers v3 fixed are
simply absent from it — [`docs/SPEC-VERSIONS.md`](docs/SPEC-VERSIONS.md) records each one,
because a threshold that vanishes when the document is rewritten is a threshold relaxed by
omission. The governing
constraint is that no number is displayed that was not measured, and no phase is declared
passed on anything but real-device evidence.

**Current state: Phases 0–6 `PASSED` on iPhone / iOS 18.7 / Safari 26.6 over HTTPS, with
committed, machine-checked evidence. Phase 3 took four device runs and each failure was a
real defect; the passing run detected 2494 frames, scored **91.1 %** above chance, and saw
the population fall from a median of 353 features on a textured wall to 64 on a blank one.
**Phase 4's device run settled the defect Phase 3 carried forward**: the `VIDEO_FRAME`
acquisition route really does produce a buffer turned 90° against the video on this device, the
alignment probe measured it after 5265 frames, and the app abandoned the route rather than
correcting the drawing. It also passed the cross-check that separates a working tracker from
one that returns its input — 4.741 px against an independently measured 4.000 px. **Phase 5
passed on the device on 2026-08-23** — 4/4 required and 2/2 advisory, with the run failing on
GEO-003 and recovering before it passed; RANSAC rejected **90.9 %** of outliers the harness
injected without telling it, against **6.0 %** of the correspondences it left alone. **Phase 6
passed on 2026-08-23**: an 8° camera rotation the harness applied and never disclosed moved the
recovered pose by **7.999°**, against 0.448° for the control, and the camera's rotation agreed
with the gyroscope to 0.762°. **Phase 7 (IMU Support / Fusion) is built and its automated leg
is the first in this project to decide a required test**: v3 §68's pass condition for the phase
is about *absence* — IMU unavailableでもVision-only modeで継続可能 — and headless Chromium is
permanently in that case, so IMU-002 is checked on every commit rather than once by hand. The
device run is still owed. See [`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md).**

## Quick start

```bash
npm install
npm test          # anti-fake audits + typecheck + unit tests, incl. evidence re-derivation
npm run test:e2e  # automated DESKTOP_DEV legs for Phases 0-7, with evidence and screenshots
npm run dev       # HTTPS dev server (required for camera and motion on a phone)
```

To pass Phase 0, run the device test: [`docs/phase0/HOW-TO-RUN-DEVICE-TEST.md`](docs/phase0/HOW-TO-RUN-DEVICE-TEST.md).

## What Phase 3 does

Finds the corners in each frame that are worth tracking — Shi-Tomasi on the smaller
eigenvalue of the structure tensor — spreads them across an 8×6 grid so they cannot clump
into one textured corner of the image, and refills the population as it falls, with the
urgency §11 specifies.

**The check that matters is whether the points are on the image at all.** A count, a state
name and a cost can all be produced without a camera. So for every frame it detects on, the
worker also samples an equal number of positions **at random from the same frame**, using
the seeded `Rng`, and scores them the same way. The gate is the rank statistic — how often a
detected position out-textures a random one, ties counted as half. Chance is exactly 0.5
whatever the scene is, so the distance from 0.5 measures the detector rather than the
wallpaper. On the automated leg it reads **97.3 %** against a rolling gradient barely above
sensor noise.

**Whether the scene is textured is measured, not asserted by the tester.** A frame counts as
rich or poor by its own mean gradient magnitude, and the run reports the histogram of where
it actually sat — so FEAT-002's claim that the population collapses on a blank wall is a
comparison between two classes the image put frames into, not two moments a human labelled.

**The grid is judged against its own control.** On the same frame, an ungridded top-N
selection is run beside the gridded one, and the comparison counts only when the quota
actually bound. On a sparse frame the two selections are identical and the test reports
`PENDING` — measuring the grid, not the scene.

Nothing here follows a feature between frames: `age` is 0, `trackLength` is 1, and the two
error terms §11 lists are `null` because Phase 4 and Phase 6 are what measure them. The
screen says so rather than implying a tracked point.

## What Phase 2 does

Supplies frames from the camera to a preprocessing worker, continuously and at a stable
rate, with the expensive per-frame work off the UI thread — and proves that what reaches the
worker is the real camera image rather than something the pipeline made up.

The architecture is dictated by a measurement, not a preference. §H.1 recorded a main-thread
`drawImage` + `getImageData` at **13.8 ms on the device**, which is 40 % of a 30 Hz budget
spent before a single pixel has been looked at. So the pipeline probes three acquisition
routes at run time — `VideoFrame` transferred into the worker, `createImageBitmap` with a
resize, and last the main-thread readback itself — and keeps the first that completes real
round trips. On the automated leg the first cost 0.069 ms on the UI thread.

**The check that matters is the provenance cross-check.** Frame counters, latency histograms
and a tier ladder can all be produced by a loop that never touches a camera pixel. So once a
second, in the same callback that hands a frame to the worker, the main thread takes its own
independent reading of that same video frame; the worker reports the mean of the grayscale
it built; and the two must agree — within the tighter of a fixed ceiling and half the
scene's own variation, so a frozen image cannot slip through on a scene that barely moved.
If the scene did not vary at all, the test reports `PENDING` rather than passing on an
agreement that proves nothing.

**Adaptation is caused, not asserted.** A single tier ladder makes §54's ordering structural
— a step gives up resolution before it gives up rate — and the controller is a pure function
of its measurement window with no clock of its own. Every ladder move carries the median
worker latency and the budget it was compared against, and the resolution it selected is
read back from the dimensions of buffers the worker actually returned.

Because a device that meets its budget never degrades on its own, the harness can inject
**real** extra work — more passes over the pyramid the worker genuinely built, with the pass
count computed from the measured cost of one pass on that device. That is a stimulus, not a
result: everything downstream of it is still measured.

## What Phase 1 does

Opens a real camera and then proves the stream is genuine, which a picture on screen does
not: a frozen frame, a still photo, and a black stream from a camera another app holds all
look like "a camera works".

- **Constraint ladder** — rear camera at 1280×720, loosening a rung at a time on
  `OverconstrainedError`/`NotFoundError` only. A denial stops it immediately rather than
  re-prompting. The rung used and the *achieved* facing mode are recorded as achieved,
  never as requested.
- **Continuity** — frames counted through `requestVideoFrameCallback` for a full 30 s, with
  the longest inter-frame gap measured. Backgrounding is a failure, not an excluded
  interval: frame callbacks stop while hidden, so a run interrupted by an app switch has
  not demonstrated anything.
- **Liveness** — frames sampled at 4 Hz into a 64×48 grayscale buffer, and the peak
  frame-to-frame difference compared against a floor of 8.0. Downsampling attenuates sensor
  noise by ~17×, so a static scene cannot reach that floor however noisy, while camera
  movement reaches 20–60.
- **Denial** — every `DOMException` name maps to a declared state with a recovery action,
  and an unrecognised name fails closed to `CAMERA_UNAVAILABLE` while saying it was
  unrecognised. On a denial the preview element leaves the DOM entirely rather than holding
  its last frame.

Phase 1 needs **two device runs**, granted and denied, because neither scenario can be
inferred from the other. An in-app ledger carries an observation between runs for the
tester's benefit; the repository gate ignores it and requires a committed bundle that
observed each scenario directly.

## What Phase 0 does

Phase 0 is the environment/capability phase. It probes the platform — 31 capabilities —
and produces a signed-off view of what this specific device can really do. It deliberately
does **not** open the camera; that is Phase 1.

The probes execute the APIs rather than sniffing for them. WebAssembly is proven by
compiling a 41-byte module and checking `add(2,3) === 5`. Workers are proven by a
round-trip. OffscreenCanvas is proven by drawing a pixel and reading back the exact bytes,
including across a transfer into a worker. WebGPU is proven by obtaining an adapter *and* a
device. Motion sensors are proven by counting events that carry finite values — because a
constructor that exists on a device with no accelerometer is not a capability.

Every record states **how** it knows what it claims:

| method | meaning |
| --- | --- |
| `FUNCTIONAL_PROBE` | the API was executed and a real result observed |
| `PRESENCE_CHECK` | only the symbol was checked |
| `INFERENCE` | a guess from the user-agent string — barred from backing any pass criterion |
| `NOT_ATTEMPTED` | deliberately not probed in this phase |

## Things the platform cannot do, reported as measured absences

| | |
| --- | --- |
| `DEPTH: UNAVAILABLE` | no Web API exposes iPhone depth or LiDAR to Safari |
| `ARKit: UNAVAILABLE` | no JavaScript API; probed for the only possible surface, a native bridge |
| `RoomPlan: UNAVAILABLE` | same |
| `SCALE: UNKNOWN` | a monocular camera carries no absolute scale; the world will be in local units |

These are results, not pending work, and they are not softened anywhere in the UI.

## How honesty is enforced rather than promised

- **`PENDING` is a real verdict.** A test that cannot be evaluated yet holds the phase at
  `TESTING`. It never rounds up to `PASS`.
- **The desktop leg cannot pass a phase.** `determineLeg()` classifies an automated or
  non-HTTPS or non-iOS run as `DESKTOP_DEV`, and `PhaseRegistry.evaluate()` returns
  `TESTING` for it however green the results are. This is why CI going green does not move
  the phase.
- **Phase Lock is code.** `PhaseRegistry` refuses entry to phase N+1 until N has `PASSED`,
  and a regression re-locks everything downstream.
- **The UI cannot outrun the engine.** START SCAN is disabled and states *which* of the two
  reasons applies — Phase Lock, or Phase 1 simply not being written yet. `CAP-0011` reads
  the live DOM and fails if the control and the registry disagree.
- **`Math.random` is banned in `src/`** and enforced by `scripts/audit-fake-data.mjs`, along
  with time-driven coverage, time-driven confidence and hard-coded floor/wall geometry. A
  seeded `Rng` exists for the sampling RANSAC will legitimately need.
- **The layer graph is enforced** by `scripts/audit-architecture.mjs`, already in place for
  the `game/` and `renderer/` directories that later phases will fill, so the "SpatialWorld
  is the only source of truth" rule holds from the first line written there.
- **Evidence is validated before it is saved.** A bundle containing `NaN`, infinity,
  `undefined` or a reference cycle forces the phase to `FAILED`.
- **The tests are themselves tested.** `tests/unit/phase0Tests.test.ts` feeds the harness
  the exact fabrications §80 prohibits — ARKit claimed with no bridge, a sensor reporting
  `AVAILABLE` with no arriving data, metric scale asserted in Phase 0, a UA guess standing
  behind a pass criterion — and asserts each is rejected.

## Layout

```
docs/
  00-IMPLEMENTATION-PLAN.md      capability matrix, architecture, phase plan, budgets (§36 A–H)
  PHASE-STATUS.md                live phase table
  phase0/TEST-PLAN.md            CAP-0001..0013, written before the code
  phase0/HOW-TO-RUN-DEVICE-TEST.md
  phase0/evidence/               evidence bundles + screenshots
  phase1/TEST-PLAN.md            CAM-001..006, written before the code
  phase1/HOW-TO-RUN-DEVICE-TEST.md
  phase1/evidence/
  phase2/TEST-PLAN.md            FRAME-001..006, written before the code
  phase2/HOW-TO-RUN-DEVICE-TEST.md
  phase2/evidence/
  phase3/TEST-PLAN.md            FEAT-001..006, written before the code
  phase3/HOW-TO-RUN-DEVICE-TEST.md
  phase3/evidence/
  phase4/TEST-PLAN.md            FLOW-001..007, written before the code
  phase4/HOW-TO-RUN-DEVICE-TEST.md
  phase4/evidence/
  phase5/TEST-PLAN.md            GEO-001..006, written before the code
  phase5/HOW-TO-RUN-DEVICE-TEST.md
  phase5/evidence/
  phase6/TEST-PLAN.md            POSE-001..007, written before the code
  phase6/HOW-TO-RUN-DEVICE-TEST.md
  phase6/evidence/
  phase7/TEST-PLAN.md            IMU-001..009, written before the code
  phase7/HOW-TO-RUN-DEVICE-TEST.md
  phase7/evidence/
src/
  core/          types, seeded Rng, validators, PhaseRegistry (Phase Lock),
                 stats (median/round/§56's trim, shared by every session)
  capture/       CapabilityDetector, MotionCapabilityProbe, RotationRateMonitor,
                 CameraSource, FrameIntegrityMonitor, ScenarioLedger, probe plumbing
  debug/         Logger, EvidenceRecorder, OverlayAlignmentProbe
  pipeline/      tiers, pyramid maths, AdaptiveController, PipelineMetrics,
                 WorkerFramePipeline
  geometry/      linalg (Jacobi eigen + SVD), twoView (F and H), ransac, verify,
                 rotation, intrinsics, pose (E/H decomposition, cheirality) —
                 pure array arithmetic; may import nothing but core (audited)
  fusion/        quat (no Euler conversion exists), orientationEkf (6-state ESKF:
                 orientation + gyro bias) — same rule as geometry: numbers in,
                 state out, may import nothing but core (audited)
  tracking/      trackingWorker (preprocessing + detection + flow + verification),
                 FeatureDetector, FeaturePopulation, LucasKanade, SceneShift,
                 FlowTracker, FlowStage, FlowSession, trackingState,
                 VerificationStage, VerificationSession, PoseStage, PoseSession,
                 poseConfidence, gyroRotation, FusionStage, FusionSession,
                 fusionConfidence, KeyframeStage, KeyframeSession,
                 TriangulationStage, TriangulationSession, LandmarkStage,
                 LandmarkSession, types and messages
  mapping/       keyframes (v3 §20's selector, the bounded store and the metronome it is
                 scored against), triangulation (the parallax gate and the solve),
                 landmarks (the map, the similarity that registers a batch into it,
                 and the gate) — same rule as geometry and fusion: numbers in,
                 structures out, may import nothing but core and geometry (audited)
  testkit/       Phase0Tests..Phase10Tests, runTests (the shape all eleven share)
  ui/            Phase0Screen..Phase10Screen, dom (el/card/stat/formatters),
                 phaseSections (the tests/evidence/navigation cards), PreviewVideo, styles
  world/ renderer/ game/   empty — later phases
scripts/         audit-fake-data, audit-architecture, run-e2e*,
                 lib/ (the leg harness: serve, launch, the phase ladder, the Y4M feed)
```

## What the device actually reported

From the passing run (full matrix in the evidence bundle):

| | |
| --- | --- |
| WebGPU | AVAILABLE — adapter and device both created; `shader-f16`, `timestamp-query` |
| WebGL2 | AVAILABLE — Apple GPU unmasked, `maxTextureSize` 16384 |
| IMU | 60 Hz, gravity-removed acceleration present, `absolute` false, compass ±24.5° |
| Cores | `hardwareConcurrency` 4 |
| Storage | 38.4 GB quota |
| Depth / ARKit / RoomPlan | UNAVAILABLE, each by probe |
| Scale | UNKNOWN |

## Measurements that shaped Phase 2

The first two are from the device, and were what the design had to answer:

- **A main-thread `getImageData` costs 13.8 ms** (0.4 ms in headless Chromium) for a 3 kB
  result. That is a GPU→CPU readback stall. Phase 1 samples at 4 Hz and can afford it;
  Phase 2 at 30 Hz cannot, so frames must reach the worker as `VideoFrame` or stay on the
  GPU. (§H.1)
- **Rotating the device swaps the frame dimensions**, 1280×720 ↔ 720×1280, on the same
  track — so frame size is per-frame data, and a rotation mid-scan changes the camera
  intrinsics. (§H.0)

**Both were answered by Phase 2's device run.** `VideoFrame` construction cost **0.048 ms**
on the UI thread across 2363 frames and the fallback routes were never needed; the readback
it replaced cost 5.81 ms in the same run — real, but not the 13.797 ms Phase 1 measured, so
§H.1 now records that the figure varies rather than quoting one sample as a constant. The
rotation showed up as 720×1280 ↔ 1280×720 with the processing size re-derived within a
frame, 0 frames over budget and 0 upscaled.

Three more came out of Phase 2's own automated leg, each from a test failing rather than
from review, and each recorded in §H.2:

- **Pacing measured from the last admission aliases against the camera rate**, delivering
  12.88 fps against a 30 fps target. The deadline has to accumulate on an ideal grid.
- **A shortfall against the target rate is not always this ladder's problem**: the camera
  may not be offering that many frames, and degrading cannot conjure one.
- **Recovery needs flap damping**, because the ladder's own arithmetic — four times fewer
  pixels against a 1.5× budget relaxation — means any load worth less than about six times
  the budget becomes affordable partway down, and the pipeline cycles.

And one the device settled, recorded in §H.2 and in the Phase 2 evidence README: a ladder
step that lowers only the target rate does not reduce per-frame latency. Measured at
58 ms → 59 ms for a rate step against 57 ms → 26 ms for the resolution step beside it, which
is why FRAME-004 judges the effect of adaptation on the last step that changed the
resolution.

## What the device afforded

From Phase 2's passing run — the first numbers in this project that describe the engine
rather than the platform:

| | Measured |
| --- | --- |
| Full preprocessing at 720×1280 (readback, grayscale, 3-level pyramid) | 10–11 ms per frame |
| Sustained delivery at that size | 29.65 fps over 48.5 s, **0 frames lost** |
| UI thread per admitted frame | below WebKit's 1 ms clock resolution |
| Worker's grayscale vs an independent read of the same frame | median Δluma **0.284** / 255 |
| Tier the controller settled on | `HIGH 1280×720@30`, the top of the ladder |

That leaves roughly 22 ms per frame at 30 Hz for Phases 3–6, against the 32 ms §H budgets
them — the first sign that the per-frame budget is tight rather than generous.

## What Phase 3's device run found

**The pipeline preprocessed 2190 frames on the phone and detection ran on none of them**,
while the screen said `DETECTING` and the error log stayed empty. Phase 3 is reached from a
PIPELINE screen whose pipeline is still running — it has to be, to have passed — and
`onStartPhase3` guarded on `pipeline.isRunning()`, which on that path means "Phase 2 is still
going", not "detection already started". So the handler returned before the tracking options
were ever sent to the worker. The screen's running flag was the same expression, so a lit
control sat over a stage that had never been switched on (Rule 002), which is what made a
dead stage look like a rendering bug.

Detection now has its own state, a running pipeline is adopted rather than treated as an
obstacle, and one `isDetecting()` is read by the screen, the tests and the evidence. The
automated leg missed this because it entered Phase 3 cold — a sequence no device takes — and
now walks the device's path instead; against the old code it times out waiting for the first
detection.

**The second device run showed that fix was incomplete, and the leg missed that too.** Three
of the four readers were consolidated onto `isDetecting()`; the fourth — the view-model prop
that sets the button's label *and* its `disabled` flag — still read `pipeline.isRunning()`.
So the button rendered `DETECTING`, greyed out, the instant the screen opened over Phase 2's
pipeline: the user could not press it at all. Strictly worse than the bug it replaced. The
leg had been calling `startDetection()` through the debug API — the engine was reachable, the
button was not — and now presses the real control, asserting what it says either side of the
click. Against the broken code it fails with the user's own experience: *"START DETECTION is
not pressable on arrival: label "DETECTING", disabled true."*

## What Phase 3's own leg found

Three more defects, each from a test failing rather than from review, and each recorded in
[`docs/phase3/evidence/README.md`](docs/phase3/evidence/README.md):

- **A single box-filter pass makes the corner response a plateau**, so suppression keeps the
  first point scanned and every feature lands up-left of the corner it found. A checkerboard
  corner at (10, 10) came back at (7, 7), with zero local variance at the chosen positions.
  Two passes give the response a peak. Invisible in Phase 3's counts, fatal to Phase 5.
- **The contrast ratio measured the scene, not the detector.** A working detector scored
  1.87 on a checkerboard against a threshold of 4.0, because on a dense pattern the random
  control is textured too. Replaced by the rank statistic, whose chance value does not move.
- **A grid comparison on a sparse frame says nothing**, and failed a selector that was
  working. It is now counted only when the quota bound.

The last two are amendments to the test plan, written with their reasons; both narrow the
test rather than relax it.

The leg also measures the alternative to its own design choice on every run: detection at
pyramid level 1 costs **7.5 ms** on that machine, where level 0 would cost **83.7 ms**.

FEAT-005 gates on §H's 8 ms, and the leg prints its verdict and then declines to gate on it —
because §H's budget is the iPhone's, and consecutive runs of identical code measured 7.49,
7.98 and 9.36 ms on a shared CPU, landing on both sides of the line. A number that flips a
verdict without the code changing decides nothing about the code. A named 24 ms tripwire
gates instead, sitting between that spread and the 45–84 ms that detecting at the wrong level
costs; the device run decides the budget.

## What Phase 4 does

Phase 4 — Optical Flow Tracking (§12, §13, §65) — **passed on the device on 2026-08-22**:
5/5 required and 2/2 advisory, `devEntry: false`, with the transition log showing the phase
moving `FAILED → PASSED → FAILED → PASSED` as the operator worked through §65's five
conditions. It was not passed by assertion.

Pyramidal Lucas-Kanade at §12's parameters — 21×21 window, 3 levels, 30 iterations, epsilon
0.01 — follows the corners Phase 3 finds, and §13 grades every round trip: 1.5 px acceptable,
3.0 px reduced, above that rejected and dropped. Features have a history for the first time.

### The one number that carries it

**Everything else in this phase can be produced by a tracker that never looked at the second
frame.** A tracker that returns the points it was given reports every point surviving, `age`
and `trackLength` climbing honestly, and a forward/backward error of *exactly* 0.0 — §13's
best band, because both directions are the same short circuit and they agree perfectly. On a
static scene it is indistinguishable from a working tracker, and no statistic computed from
its own output can tell.

So the harness measures the scene's motion with a second instrument that shares nothing with
the first: an integer sum-of-absolute-differences translation search on the pyramid's top
level. It calls no part of the solver, duplicates none of its arithmetic, never reads the
feature list, and keeps its own copy of the previous frame so it does not even share a buffer
with what it checks. FLOW-002 gates on the two agreeing.

`tests/unit/flowTracker.test.ts` drives the real frame stage with exactly that fake over a run
whose motion is known by construction, and asserts the whole shape: the fake passes FLOW-001,
passes the metadata test, scores a perfect §13 round trip, keeps 100 % of its population —
**and fails FLOW-002**, because the search says the image moved 4 px while the tracker says 0.

### The automated leg decides more than Phase 3's could

Phase 3's leg had to exclude the three tests that carry its meaning: Chromium's fake camera is
a rolling gradient, neither a textured wall nor a blank one. Phase 4's conditions are about
*motion*, and a video file can contain motion exactly — so the leg generates its own feed that
holds still, pans at 4 px per frame, sweeps at 22, and goes black. Every frame is classified
from the pixels by the same code the device runs; the harness never tells the tracker what to
expect.

That arms the FLOW-002 cross-check through the real `video → VideoFrame → worker → pyramid`
path, which §H.7 records as the one place unit tests cannot reach: **309 pairs, tracker 6 px
against image 4 px, 93.9 % of frames agreeing**, with 0 §33 state mismatches and 11 occlusion
episodes that all reached `LOST` and recovered.

Rule 004 is unaffected — the leg is `DESKTOP_DEV` and passes nothing. FLOW-003 needs the
device's gyroscope and reports `PENDING`; FLOW-006's 14 ms budget is the device's to answer and
a separately named 90 ms tripwire gates instead.

### §33's GOOD is unreachable here, and says so

§33 makes `GOOD` three conjuncts: features ≥ 300, inlier ratio ≥ 0.50, reprojection error
≤ 2.0 px. Phase 4 can measure the first. The other two are Phase 5's and Phase 6's, neither has
been written, and a `null` fails its conjunct — so `GOOD` cannot be reached, and the state
carries `goodBlockedBy` naming the missing terms rather than quietly dropping two conditions
out of three.

### What the device settled, and what it did not

The `VIDEO_FRAME` route produced a buffer **turned 90° against the video** for 5265 frames.
The probe measured it, the app abandoned the route, and after the fallback identity wins at
10.1× chance. The report Phase 3 could not reproduce is real; the mechanism §H.7 called for
works; the defect is contained rather than fixed.

Three things the pass does not demonstrate, recorded because the tests are satisfied and the
run is narrower than it looks: the population never reached §11's 200 minimum (median 41–74,
so `DEGRADED` on 1211 of 2717 frames, and two criteria were met without being exercised); the
bundle could not say **why**, which was an evidence gap and is now fixed; and FLOW-006's
2.668 ms was measured at 41 points, not at the ~700 the budget was written for. The
independent scene-shift search cost **7.648 ms — nearly three times the solver it checks**.

### Four defects found before any device saw the code

A tier step inside an occlusion that left a 14-frame covered lens never reaching `LOST` —
caught by FLOW-005, and described exactly as it looked from outside. Detection handing the
tracker points its 21×21 window cannot cover, which made survival read 84.6 % on an image the
tracker had followed exactly. §33's `inliers < 20` reused for tracked points, which made a
20-feature scene permanently `LOST`. And a covered lens putting `Infinity` into every evidence
bundle. All four are recorded as amendments in
[`docs/phase4/TEST-PLAN.md`](docs/phase4/TEST-PLAN.md); no criterion was relaxed.

One more measurement worth stating: the first solver cost **65 ms per frame** because it
recomputed the bilinear weights 441 times per iteration when the whole window shares one
sub-pixel offset. **22.5 ms** at identical results. Reporting the first number as what the
device affords would have been reporting an inefficiency as a platform fact.

## What Phase 5 does

Phase 5 — Geometric Verification (**v3 §14 and §16**, which v4 does not restate) — fits a
fundamental matrix and a homography by RANSAC over the correspondences Phase 4 tracks, and
reports which of them one geometry explains. No pose is decomposed, no depth is triangulated, no
intrinsics are used. Green on the automated leg; `PASSED` needs the device.

### The one number that carries it

v3 §14 names four figures — 30 inliers, ratio 0.35, 100 inliers, ratio 0.50. **A stage that marks
every correspondence an inlier satisfies all four perfectly**: the inlier count becomes the
correspondence count and the ratio becomes exactly 1.00, better than a working verifier on every
one of them.

So on a sample of frames the harness displaces 30 % of the targets by 25 px in seeded directions
and hands the set to the verifier unmarked. Recall against that ground truth is the only figure
in the phase a pass-through cannot produce — it scores exactly 0.00. The untouched rejection rate
sits beside it, because recall alone is scored perfectly by rejecting everything. The automated
leg reads 100 % against 0 % over 61 frames; **the device read 90.9 % against 6.0 % over 271** —
a 15.2× advantage, and 0.9 points above the bar the plan fixed before any of this was written.

### Frame-to-frame is not a baseline

The device measured a median displacement of **4.7 px** between consecutive frames. At that
separation every model fits and the ratio is 1.00 without verifying anything, so Phase 5 holds a
**verification anchor** tens of frames back and relates the current frame to that. It is an
explicit stand-in for Phase 8's keyframe system: three of v3 §20's four keyframe conditions need
a pose Phase 6 has not produced, and displacement is the one Phase 5 can measure.

### v3 §16 decided the phase, and the first reading of it was wrong

The leg failed GEO-003 at 0.816 against 0.90 on its first run, and the cause reproduces in Node
with no camera. On a plane with 30 % of its targets displaced 25 px, the homography admitted
**exactly the untouched correspondences and not one outlier**; the fundamental matrix admitted
those plus four to seven of the outliers, captured with the epipole a planar scene leaves free —
on a plane `F` is not determined at all. Read as `hCount >= fCount` that is a non-planar scene,
so the degenerate model was selected and its outliers survived. The verifier had found every
outlier and the selection rule threw the answer away.

`PLANAR_H_SHARE = 0.45` compares `H / (H + F)` — ORB-SLAM's constant for this identical choice.
No pass criterion moved; the amendment is recorded in place in
[`docs/phase5/TEST-PLAN.md`](docs/phase5/TEST-PLAN.md) with the measurement that forced it.

### And the fixture was measuring its own artefacts

Rebuilding the leg's parallax segment so its depth edges stopped sweeping collapsed the
population from 77 correspondences to 18. The texture underneath produced **zero corners** at
detection's level; what had been carrying the run was six stripe boundaries moving at 9.5 px per
frame — strong, trackable corners belonging to no surface. Both findings are the same lesson from
opposite directions: a healthy-looking number is not evidence that the thing it names works.

### What the device pass does not show

Three things, recorded rather than glossed. GEO-003 cleared 90 % by **0.9 points**. The texture
contrast GEO-001 and GEO-002 name was **never exercised** — 35 `TEXTURE_RICH` frames against
1140 `TEXTURE_POOR`, with the poor class carrying 68 correspondences, so GEO-001 was decided
run-wide and GEO-002's declines came from the baseline floor rather than from a blank wall. And
`VIDEO_FRAME` produced a `rot90` buffer again, abandoned after 1849 frames.

The third finding is one of this project's own checks being wrong: `committedEvidence` asserted
that no texture-poor frame may verify, and the device bundle has 655 that do. Phase 3's passing
bundle records *its* texture-poor class at a median of **61 detected features** — the class means
low gradient, not an empty scene, and correspondences carried from the anchor survive a pan onto
a plainer surface. The check tested the title rather than the criterion, and now tests the
criterion.

## What Phase 6 does

Phase 6 — Relative Pose (**v3 §15, §16, §19, §67**, which v4 compresses into a two-line §18) —
recovers the camera's rotation and the *direction* it moved in, by decomposing whichever model
Phase 5 verified. No distance: `LOCAL_UNITS`, always, and ‖t‖ is 1 because it was normalised.
Green on the automated leg at `TESTING`; `PASSED` needs the device.

### The first phase where the automated leg is short of an instrument

Rule 004 already meant a desktop bundle could not pass. Here one of the two things the phase is
scored against — **the gyroscope** — does not exist on headless Chromium, so POSE-002 cannot be
decided anywhere but the device. Rule 004 expressed as a measurement rather than as a policy.

### The number that carries it

Applying `K·Rⱼ·K⁻¹` to the second view is *exactly* the camera having turned by `Rⱼ`. The
harness does that with a known 8°, hands the set over unmarked, re-runs the whole chain, and
checks the recovered rotation moved by that much. **A stage returning the same pose on every
frame scores 0.00°** — while having a valid rotation matrix, a unit translation, a small
reprojection error and a *perfect* temporal stability. v3 §67's pass condition names exactly
that: Poseが計算結果により変化. The leg reads **8.000° against 0.003° for the control**.

### Two defects the unit tests found before any leg ran

`svd3x3` returned a **zero third column** — `s₃` is the square root of an eigenvalue of `MᵀM`, so
the numerical zero of a null direction lands near 1e-8, and `M v₃ / s₃` divided 1e-17 by 1e-8.
The Essential decomposition then had no translation axis: one scene recovered exactly, the same
scene turned by 4° came back 60° wrong. `U diag(s) Vᵀ` reconstructed the matrix perfectly
throughout, so the reconstruction test could not have caught it.

And **cheirality was asked before the question it presupposes**: triangulation needs a baseline,
so a camera that only turned scored zero points in front on every candidate and was reported
`NO_POSE` — a pose refused for having no translation, which is the one case where a rotation is
perfectly recoverable.

### What the device pass does not show

**POSE-002 reported `232.3 % agreeing`** — not a percentage of anything. The session bounded what
it retained (§56) but counted agreements with an unbounded counter, so past 400 comparisons the
numerator climbed over a frozen denominator. Its fourth criterion ("at least 60 % of individual
frames agree, not merely the median") was therefore **not exercised**; its other three were,
including the substantive one — 0.762° median disagreement against a 3° tolerance, on a
gyroscope-measured 4.568°. Fixed by construction, with the bundle named in the evidence checks
so the exemption cannot outlive it.

Two things the device settled that the leg could not. The gyroscope recorded a **path of 20.5°
for a net of 4.6°** — the operator turned back and forth — so integrating |ω| would have failed a
correct solver, which is why this integrates the rotation vector. And **±20 % on the focal length
moves the translation direction by 3.12°** on real optics, against 0.057° on the synthetic feed:
the rotation survives the guess, the direction does not.

Both amendments made before the run were necessary, and the device proves it: under POSE-003's
original criterion this run's planar confidence (0.0909) exceeded its non-planar one (0.0773) and
would have failed, and under POSE-005's original zero tolerance the **control flipped more often
than the injection did** (15 against 11).

### POSE-001's spread criterion was withdrawn, with the measurement

Driven over a straight-line translation the real solver reports 100% cheirality, 0 px
reprojection and a direction spread of **exactly 0°** — because the camera moved in a straight
line. There is no threshold separating that from a fixed vector; they are the same measurement.
The spread is reported and not judged, and the tests now assert that the constant-pose stage
**passes POSE-001** and fails POSE-005 alone.

## What Phase 7 does

Phase 7 — IMU Support / Fusion (**v3 §17, §18, §19, §68**, which v4 compresses into a two-line
§19) — fuses the device's own motion sensing with Phase 6's visual pose, **as an auxiliary to it
and never as a replacement**, and refuses the part of it this platform cannot support.

v3 §18 names five filter states. **Phase 7 estimates two**: `orientation` and `gyroBias`, both
observable without a scale. `position`, `velocity` and `accelBias` are refused, because the
accelerometer reports m/s² and Phase 6's translation is a unit direction in `LOCAL_UNITS` — and
inventing the conversion factor between them is exactly the fabrication Rule 001 lists. **IMU-006
measures what would have happened had it been done anyway**: the accelerometer is
double-integrated over the run, for the record only, and the drift is reported. A refusal with a
number behind it is a finding.

The anti-fake gate is **IMU-005**, and it is needed because a "fusion" that returns the visual
pose unchanged passes almost everything else in the phase — its orientation tracks the camera
perfectly, its innovation is exactly zero (*better* than a real filter's), and it never invents a
position. So two filters run on the same visual poses and the same gyroscope, one of them fed
every sample with a constant 3.0 °/s added before it sees it, and neither told which it is. The
measurement is the **difference** between their bias estimates: the phone's own bias is unknown
and common to both, so it cancels.

`tests/unit/fusion.test.ts` drives the real `FusionStage` over synthetic sensors and grades it
with the real `runPhase7Tests`, beside a hand-written pass-through that **fails** IMU-005,
IMU-001 and IMU-003 while passing IMU-004, IMU-006 and IMU-008 — the plan's claim, executed
rather than asserted.

That fixture also corrected the plan. It says a dead-reckoner scores 0 on the bias difference;
**it does not.** Gravity is two degrees of freedom, but on a device that *turns* the body axes
move relative to it and all three bias components become observable through gravity alone — with
no visual updates at all, a true (0.4, −0.9, 0.2) °/s came back as (0.400, −0.900, 0.200) and the
injected twin's difference as 2.9996 °/s on the injected axis. The criteria did not change; what
changed is the reasoning printed beside them, recorded in place with the measurement (§29).

## What Phase 8 does

Phase 8 — Keyframe System (**v3 §20**, which v4 §20 compresses into two lines and no conditions)
— decides which views are worth keeping, keeps at most thirty of them, and lets go of the ones
that have stopped describing anything.

v3 §20 gives four conditions, a minimum interval and a maximum. **Phase 8 implements three of the
four and refuses the second**, because *relative translation ≥ 0.10 local unit* is a **magnitude**
and Phase 6 recovers a unit direction with `SCALE: LOCAL_UNITS`. It is carried in every decision
record as `UNMEASURED` with the missing scale named — a value a later phase has to remove
deliberately, exactly as Phase 7 carries `POSITION: UNAVAILABLE` — and the refusal carries a
number: the angle the translation *direction* moved, which is measurable. What fires in its place
is v3 §20's own third condition, the median displacement of the features the two views share.

The anti-fake gate is **KEY-002**, and it is needed because a **metronome** passes almost
everything else in the phase: its intervals are legal, its store stays bounded, its keyframes
carry observations and intrinsics, and on a moving camera its views are as well separated as
anyone's — because on a moving camera *any* schedule produces separated views. So a metronome runs
inside the app beside the real selector, on the same frames, firing as often as the real one is
allowed to, and the measurement is the difference between the two counts **over the frames where
the camera is not moving**.

Whether the camera is moving is not decided by Phase 8. It is Phase 4's own scene-shift search —
an exhaustive integer search that shares no code with the tracker and never sees the feature list
— reporting `STATIC` below 1 px of image motion. A phase that classified its own test conditions
would be marking its own paper.

### The leg decides the whole required suite, which is new

Phase 7's leg was the first to decide one required record. Phase 8's decides all six, because the
instruments are a still segment and a metronome and the harness can produce both: the feed holds
for seven seconds in the middle of a pan. On the committed run the selector kept **4** views over
377 static decisions, all of them the five-second heartbeat, where a metronome would have kept
**52** — 13×. Rule 004 is untouched and means what it always meant.

### Four defects the leg found before any device saw the code

**A re-derivation that rounds its inputs is checking the formatter.** `sinceLastMs` was rounded to
a tenth of a millisecond on its way into the record, `499.99999999999955` became `500`, and Rule
002's re-derivation then disagreed with the stage on every decision that landed on v3 §20's
minimum interval — 30 of them in a 32-second fixture.

**Composing a per-frame increment over five seconds is a random walk.** The rotation since the last
keyframe was first accumulated the way `FusionStage` accumulates its visual increments. Phase 7
composes over one second and is unaffected; Phase 8 composes over up to five, and on the leg's
lateral pan — true rotation zero throughout — the accumulated angle reached 10° and fired
`ROTATION` **seven times while the image was not moving**. It is now assembled per anchor epoch,
one composition per re-anchor rather than per frame.

**A rotation the layer below had already refused to stand behind.** Per-epoch assembly took
`ROTATION` on a still camera from every run down to about two runs in six, and the rest had a
different cause. The leg was made to print Phase 6's pose beside each violation, and every one of
them read `ambiguous true` with `2 unseparated candidate(s)`: on a static image the
correspondences stop changing, cheirality stops separating the essential matrix's four
decompositions, and the recovered rotation **alternates between two of them** — about 18° apart,
so 10° is crossed twice over by an artefact rather than by a camera. Phase 6 had been saying it
could not tell; Phase 8 was reading the pose and ignoring the flag. It now declines an `ambiguous`
pose, holds the accumulator at its last settled value, and carries `ambiguousPosesDeclined` (73 on
the committed run) so an under-reported turn is visible rather than silent. Six consecutive legs
green afterwards. This is v4 §25 applied one layer earlier than §25 names it.

**And a cost that measured the fixture.** The eviction record carries the retained set's spread
beside the counterfactual, and the first version built one observation index per pair — 435 of
them — putting the mean at 1.67 ms against this phase's own 1.0 ms ceiling. §H.8, again.

## What Phase 9 does

Phase 9 — Triangulation (**v4 §21**, on v3 §15 and §16's geometry) — recovers the first
three-dimensional quantity in this project: where a point **is**, not merely where it appears.
Two keyframes, related by the features they share, and a depth for every point whose two viewing
rays meet at enough of an angle to determine one.

**The floor is an angle, and it is derived.** A triangulated depth's relative uncertainty is
`σ_Z/Z ≈ σ_θ/θ`; §13's 1.5 px correspondence band over the assumed `f ≈ 967 px` is 0.089° of
angular noise, and asking for a depth good to a tenth of itself gives 0.89°. One degree. A
percentile of whatever the frame contained could not express *there is not enough parallax here* —
§H.6, which Phase 3's corner floor is the reason for.

**Two gates, because two different fakes produce a full set of plausible points.** A triangulator
returning one constant depth puts every point in front of both cameras, reports a small
reprojection error, and adds up perfectly; a solver that solves anything solvable produces a full
set from a camera that turned and never moved, which is what a phone does when someone stands
still and turns.

- **TRI-004** synthesises a pair from depths the stage picked and never disclosed. Measured error
  **0**; the best possible constant depth scores **0.234**, printed beside it so the tolerance is
  not what separates them.
- **TRI-003** replaces the pair's second view with `K R K⁻¹` applied to its first — a real
  rotation and no baseline at all. **0 points from 16 injections**, and the pose came back
  `ROTATION_ONLY` 16 times out of 16.

`tests/unit/triangulation.test.ts` drives the real stage with a constant-depth solver and it fails
**TRI-004 and nothing else** — while reporting a *better* reprojection error than the real one.

**The pose for the pair is a fresh fit, and it has a witness.** No model exists for a keyframe
pair, so one is fitted with Phase 5's verifier and Phase 6's decomposition, unmodified. TRI-006
then compares it against the rotation Phase 6 measured by an entirely different route — per-frame
poses against a moving anchor, composed by Phase 8 across anchor epochs. The fit says 0.047°, the
chain disagrees by 0.048°, tolerance 3°.

**And no distance.** Every depth is in units of that pair's own baseline, which is 1 by
construction. Two batches' depths are two different units and no record pools them; the number
behind that refusal is the batch-to-batch spread of the median depth, **0.96 on one scene with one
camera**. Phase 10 is where the pairs come into one frame.

## What Phase 10 does

Phase 10 — Landmark Map (**v4 §22**, with §56's bound and §34's origin) — brings Phase 9's batches
into **one frame**.

Phase 9 leaves one answer per keyframe pair, each in units of that pair's own baseline; its leg
measured the median depth moving by **96 % of itself** between consecutive batches on a scene that
never changed. The landmarks two batches share fix the ratio between their scales, recovered as the
scale term of a similarity fitted in closed form — **1.208** on the committed run, at a residual of
0.0004 of a depth. That is a ratio between two quantities nobody has measured, and it is what makes
ninety separate answers one map. The world has a consistent unit and no known one.

**Two gates, and one of them corrected the plan.**

- **MAP-002** — a landmark's position, as the map held it *before* this batch, projected into the
  keyframe the batch has just added, and compared against where the tracker saw it: **0.106 px**
  median, none exactly zero, from landmarks with a median of three observations at the moment they
  were asked.
- **MAP-005** — GEO-003's shape one layer up: a known subset of the incoming positions displaced
  perpendicular to their viewing rays by 5 % of their depth, which moves the projection by 24 px
  whatever the depth. Recall **1.00**, with a false-cull **excess over the batch's own baseline**
  of **0**.

`tests/unit/landmarks.test.ts` drives the real stage with the position rule replaced by one that
keeps only the newest observation, and it fails **MAP-006 and nothing else** — *not* MAP-002, which
the plan predicted. A map with no memory still predicts, from the previous batch; what it cannot do
is settle. The two records catch different fakes and the fixture is what established which.

**Five corrections the measurements forced**, each recorded beside the criterion it affects: a gate
that was not looking at what the injection corrupts (recall 0.17); the same comparison in world
units refusing 71 % of untouched points, because a triangulated position's dominant error is radial
and invisible; the same lesson applied to the registration's trimming making it *worse*, because a
similarity's scale is a depth quantity; an absolute false-cull ceiling that measured the scene
rather than the gate; and a sparsity figure that read **338 %** — the same shape as Phase 6's
232.3 % agreement rate, and the reason every rate here is checked against `0..1`.

**Confidence has four measured terms and none of them is a clock**: observation count, parallax,
prediction agreement, viewpoint spread, combined as the minimum. `audit-fake-data.mjs` enforces the
absence of the alternative mechanically.

## Next

Phase 11 — Surface Understanding (v4 §23), once Phase 10 has a device run behind it.

The open defect from Phase 3 is still open: the overlay rotates in portrait on the device.
It matters more in Phase 4 than it did in Phase 3, because Phase 4 measures every displacement
in the acquired buffer's frame — a buffer turned against the screen makes every number in the
phase wrong while every average-based check still passes. The probe runs on the Phase 4 screen
and in every Phase 4 bundle, and the acquisition route is abandoned rather than the drawing
corrected. What changed in Phase 4 is that the probe learned to say when it *cannot tell*: on a
dense repetitive scene every transform scores alike, and it now refuses to condemn a route on
that rather than naming the argmax.
