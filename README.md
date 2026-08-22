# Safari Spatial Mapping Engine

Turning what an iPhone's Safari can actually observe — camera frames and motion — into a
reusable **Spatial World**, and letting a game layer collide with the geometry that was
reconstructed from the real room.

Built strictly to `Safari Spatial Mapping Prototype v3.0`, phase by phase. The governing
constraint is that no number is displayed that was not measured, and no phase is declared
passed on anything but real-device evidence.

**Current state: Phases 0, 1 and 2 `PASSED` on iPhone / iOS 18.7 / Safari 26.6 over HTTPS,
with committed, machine-checked evidence. Phase 3 (Feature Detection) is `IMPLEMENTING` — its
first device run recorded `TESTING` and found a defect that stopped detection from ever
starting on a phone; that is fixed and reproduced by the automated leg, and a second device
run is what the phase now waits on. See [`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md).**

## Quick start

```bash
npm install
npm test          # anti-fake audits + typecheck + unit tests, incl. evidence re-derivation
npm run test:e2e  # automated DESKTOP_DEV legs for all four phases, with evidence and screenshots
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
src/
  core/          types, seeded Rng, validators, PhaseRegistry (Phase Lock)
  capture/       CapabilityDetector, MotionCapabilityProbe, CameraSource,
                 FrameIntegrityMonitor, ScenarioLedger, probe plumbing
  debug/         Logger, EvidenceRecorder
  pipeline/      tiers, pyramid maths, AdaptiveController, PipelineMetrics,
                 WorkerFramePipeline
  tracking/      trackingWorker (preprocessing + detection), FeatureDetector,
                 FeaturePopulation, feature types and messages
  testkit/       Phase0Tests, Phase1Tests, Phase2Tests, Phase3Tests
  ui/            Phase0Screen..Phase3Screen, PreviewVideo, styles
  mapping/ world/ renderer/ game/   empty — later phases
scripts/         audit-fake-data, audit-architecture, run-e2e
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

## Next

The Phase 3 device run — [`docs/phase3/HOW-TO-RUN-DEVICE-TEST.md`](docs/phase3/HOW-TO-RUN-DEVICE-TEST.md).
Then Phase 4 — Optical Flow Tracking (§12).
