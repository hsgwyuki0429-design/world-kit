# Safari Spatial Mapping Engine — Implementation Plan

Governing document: **Safari Spatial Mapping Prototype v3.0** (統合技術仕様書).
This file is the response to §36 of the統括プロンプト: the eight artefacts that MUST be
produced **before any code is written**.

Status of this document: written before `src/` existed. Sections marked
`MEASURED` are filled in by the running application, not by the author.

---

## A. Current Capability Matrix

### A.1 Rule

Per Rule 003 and §7, the Capability Matrix is **runtime output, not authored text**.
Nothing in this section may be treated as the matrix. The matrix is produced by
`src/capture/CapabilityDetector.ts` on the target device and exported as evidence JSON.

Every capability record carries a `method` field, and the honesty of the matrix rests on it:

| method | meaning |
| --- | --- |
| `FUNCTIONAL_PROBE` | The API was actually executed and a real result was observed. |
| `PRESENCE_CHECK` | Only symbol existence was checked. Cannot prove the API works. |
| `INFERENCE` | Derived from another signal (e.g. the UA string). **Not measured.** |
| `NOT_ATTEMPTED` | Deliberately not probed in this phase (e.g. needs a user gesture). |

A capability whose `method` is `INFERENCE` MUST NOT be used as a Phase pass criterion.
This is enforced by test `CAP-0010` and by `assertNoInferenceInPassCriteria()`.

### A.2 Capability states

`AVAILABLE | UNAVAILABLE | PERMISSION_REQUIRED | PERMISSION_DENIED | UNKNOWN | ERROR`

Default is `UNKNOWN` (fail closed, §1.4). A probe that throws yields `ERROR`, never
`UNAVAILABLE` — "we could not tell" and "it is not there" are different facts.

### A.3 Prior expectation vs. measurement

Expectations were recorded before the first device run so that a *discrepancy* would be
visible rather than invisible. Measured column is from **iPhone / iOS 18.7 / Safari 26.6 /
HTTPS**, 2026-08-21. Where the two disagree, **measurement wins and the expectation was
wrong** — that is the point of writing it down.

| Capability | Expected | Measured on device | |
| --- | --- | --- | --- |
| Secure context (HTTPS) | AVAILABLE | AVAILABLE | ✓ |
| MediaDevices / getUserMedia | AVAILABLE | AVAILABLE | ✓ |
| `enumerateDevices` labels pre-permission | hidden | hidden (1 videoinput, ids also hidden) | ✓ |
| `MediaStreamTrack.getCapabilities` | AVAILABLE | AVAILABLE (+ getSettings, applyConstraints) | ✓ |
| DeviceMotion | PERMISSION_REQUIRED → AVAILABLE | AVAILABLE after tap — 119 events / 2 s, **59.96 Hz** measured | ✓ |
| DeviceOrientation | PERMISSION_REQUIRED → AVAILABLE | AVAILABLE after tap — 119 events / 2 s, 59.96 Hz | ✓ |
| `webkitCompassHeading` | AVAILABLE | AVAILABLE, but `compassAccuracy` **±24.5°** | ✓ (with a caveat, below) |
| WebAssembly | AVAILABLE | AVAILABLE — `add(2,3)===5`, streaming + Memory present | ✓ |
| Web Worker | AVAILABLE | AVAILABLE — 2 ms round-trip | ✓ |
| OffscreenCanvas | AVAILABLE | AVAILABLE — byte-exact readback | ✓ |
| `transferControlToOffscreen` | AVAILABLE | AVAILABLE, and exact **inside a worker** | ✓ |
| WebGL2 | AVAILABLE | AVAILABLE — Apple GPU, unmasked, maxTexture 16384, `EXT_color_buffer_float` yes | ✓ |
| WebGPU | AVAILABLE | **AVAILABLE** — adapter *and* device created | ✓ |
| WebCodecs (`VideoFrame`) | AVAILABLE | AVAILABLE (+ VideoDecoder, VideoEncoder) | ✓ |
| `requestVideoFrameCallback` | AVAILABLE | AVAILABLE (`playsInline` present) | ✓ |
| `createImageBitmap` | AVAILABLE | AVAILABLE | ✓ |
| SharedArrayBuffer | UNAVAILABLE without COOP/COEP | UNAVAILABLE (`crossOriginIsolated: false`) | ✓ |
| **ImageCapture** | **UNAVAILABLE** ("not implemented in WebKit") | **AVAILABLE** | ✗ **expectation was wrong** |
| `performance.memory` | UNAVAILABLE | UNAVAILABLE (`deviceMemory` also null) | ✓ |
| WebXR (`navigator.xr`) | UNAVAILABLE | UNAVAILABLE | ✓ |
| Camera Depth | UNAVAILABLE | UNAVAILABLE — no depth constraint key, no XR route | ✓ |
| Native ARKit | UNAVAILABLE | UNAVAILABLE — no `webkit.messageHandlers` bridge | ✓ |
| RoomPlan | UNAVAILABLE | UNAVAILABLE — same | ✓ |
| Metric scale | UNKNOWN | UNKNOWN (LOCAL_UNITS) | ✓ |

**The one miss: `ImageCapture` is available on Safari 26.6.** The Fallback table in §F still
routes frame acquisition through `VideoFrame` → `createImageBitmap` → `drawImage`, which
remains correct: `ImageCapture.grabFrame()` is a still-capture API, not a per-frame path,
and Phase 2 needs a frame every 33 ms. `takePhoto()` may become useful later for a
high-resolution keyframe, so this is recorded as an opportunity, not a plan change. Any
such change goes through §33.

### A.3.1 What the IMU measurement means for Phase 7

The sensor probe returned more than a yes. Four facts from it constrain the fusion design:

- **60 Hz, with `interval` = 0.01667 s.** At a 20–30 Hz tracking cadence that is 2–3 IMU
  samples per frame — enough to integrate gyro between keyframes, which is what §17 wants
  the IMU for.
- **`acceleration` and `accelerationIncludingGravity` are both present.** iOS is already
  running its own fusion, so gravity is recoverable as their difference. That matters well
  beyond Phase 7: §29 lists gravity as an input to plane classification, and this is where
  it comes from. It is a measured vector, not an assumed "down".
- **`absolute` is `false`.** Orientation is relative, not world-referenced. Yaw has no
  reliable global datum.
- **`webkitCompassHeading` exists but reported ±24.5° accuracy.** So there *is* a magnetic
  heading, and it is far too coarse to anchor a world. It may seed a relocalization search;
  it must not define the world origin. §34 already fixes the origin at the initial camera
  pose, and this measurement is the reason not to revisit that.

Combined: the IMU is good for short-horizon rotation, usable for a gravity vector, and
useless for absolute position or heading — exactly the split §17 assumes, now measured
rather than assumed.

Device facts worth carrying into later phases:

| | |
| --- | --- |
| `hardwareConcurrency` | **4** — the worker budget in §B.2 must fit 4 cores, not 8 |
| Storage quota | 38.4 GB (1.1 MB used) — Phase 14 save/load is not quota-constrained |
| WebGPU limits | `maxComputeInvocationsPerWorkgroup` 256, `maxComputeWorkgroupSizeX` 256, `maxTextureDimension2D` 8192, `maxStorageBufferBindingSize` 128 MB |
| WebGPU features | includes `shader-f16`, `float32-filterable`, `timestamp-query` |
| WebGL2 | `maxTextureSize` 16384 — larger than WebGPU's 8192, relevant if the GL path handles pyramids |
| Viewport | 393×852 CSS px at DPR 3 |
| Media constraints | 17 supported; all six Phase 1/2 needs present |

### A.4 Measured matrices

- **REAL_DEVICE leg** — `docs/phase0/evidence/phase0-real-device-PASSED-2026-08-21T08-05-07-305Z.json`.
  31 records, **51 ms** of non-gesture probe time (budget 1500 ms); Phase 0 **PASSED**.
  Note that many `durationMs` values read `0`: iOS clamps `performance.now()` to ~1 ms for
  privacy, so a sub-millisecond probe is indistinguishable from an instant one. The probes
  did run — each carries its measured `data`.
- **DESKTOP_CHROMIUM leg** — `docs/phase0/evidence/phase0-desktop-chromium.json`, produced
  by `npm run test:e2e`. Development signal only; per Rule 004 it can never pass a phase.

---

## B. Architecture Plan

### B.1 Layering (§82, §83)

```
                      +---------------------+
   capture/  ───────► |  pipeline/          |
   (camera, motion,   |  frame scheduling   |
    capability)       +----------+----------+
                                 │ frames
                                 ▼
                      +---------------------+
                      |  tracking/          |  features, flow, RANSAC, pose, IMU
                      +----------+----------+
                                 │ poses + correspondences
                                 ▼
                      +---------------------+
                      |  mapping/           |  triangulation, landmarks, BA, planes
                      +----------+----------+
                                 │ spatial objects
                                 ▼
                 ┌───────────────────────────────┐
                 │        world/SpatialWorld      │  ◄── SINGLE SOURCE OF TRUTH
                 └───┬───────────┬────────────┬───┘
                     │           │            │
                 renderer/     game/       debug/       (read-only consumers)
```

Hard rules, enforced by `scripts/audit-architecture.mjs` (import-graph check):

- `game/` MUST NOT import from `capture/`, `pipeline/`, `tracking/`, `mapping/`.
- `renderer/` MUST NOT import from `capture/`, `pipeline/`, `tracking/`, `mapping/`.
- `renderer/` and `game/` MUST NOT construct spatial geometry of their own.
- Only `mapping/` may mutate `SpatialWorld`; everyone else gets read-only views.

### B.2 Threading

| Thread | Owns |
| --- | --- |
| UI thread | rendering, DOM, input, `SpatialWorld` read views |
| Tracking worker | preprocessing, Shi-Tomasi, pyramidal LK, RANSAC, pose |
| Mapping worker (from Phase 9) | triangulation, landmark upkeep, bundle adjustment, plane RANSAC |
| GPU (WebGPU→WebGL2→CPU) | image pyramid / gradients, point rendering |

Frames cross the worker boundary as transferables (`ImageBitmap`, `VideoFrame`, or a
transferred `ArrayBuffer` of grayscale bytes) — never as structured-cloned copies of
`ImageData` when a transfer is possible.

### B.3 Determinism (§59)

`Math.random` is **banned repo-wide inside `src/`** and enforced by
`scripts/audit-fake-data.mjs`. RANSAC and any other sampling algorithm uses
`src/core/Rng.ts` (seeded mulberry32), so the same input frames produce the same map.

### B.4 State ownership

- `PhaseRegistry` owns phase state and is the only thing allowed to say a phase PASSED.
- The UI reads phase state; it can never set it. This makes "Scan Complete" buttons and
  UI-only completion (§Rule 002) structurally impossible.

---

## C. Phase 0 Implementation Plan

**Objective (§8):** know the real capability of the real device before anything else runs.
Phase 0 deliberately does **not** open the camera — that is Phase 1 (CAM-001..004).

| # | Deliverable | File |
| --- | --- | --- |
| C1 | Capability/phase type system, fail-closed defaults | `src/core/types.ts` |
| C2 | Seeded RNG + numeric validators (`isFiniteNumber`, NaN/Inf rejection) | `src/core/Rng.ts`, `src/core/validate.ts` |
| C3 | Phase registry implementing Rule 005 Phase Lock | `src/core/PhaseRegistry.ts` |
| C4 | Capability detector: ~30 probes, each timed, each labelled with a `method` | `src/capture/CapabilityDetector.ts` |
| C5 | Gesture-gated motion/orientation probes that verify **real event data arrives** | `src/capture/MotionCapabilityProbe.ts` |
| C6 | Structured logger with levels, phases and error records (§27) | `src/debug/Logger.ts` |
| C7 | Evidence recorder producing the §61 test-record format as JSON | `src/debug/EvidenceRecorder.ts` |
| C8 | Phase 0 test runner: CAP-0001..CAP-0011, criteria fixed before implementation | `src/testkit/Phase0Tests.ts` |
| C9 | START screen (§93) with capability panel, phase panel, evidence export | `src/ui/*` |
| C10 | Anti-fake + architecture audit scripts wired into `npm test` | `scripts/*.mjs` |

Explicitly **out of scope for Phase 0**: `getUserMedia`, any frame, any feature, any pose,
any landmark, any plane, any world, any game. The START SCAN button exists but is
**disabled and labelled `PHASE 1 — NOT IMPLEMENTED`**, because §Rule 002 forbids UI that
implies capability the engine does not have.

### C.1 Probe inventory

Grouped as `platform`, `camera`, `motion`, `compute`, `graphics`, `media`, `storage`,
`spatial`. The `spatial` group is the honesty group: WebXR, camera depth, native bridge
(`window.webkit.messageHandlers`), ARKit, RoomPlan, metric scale. Each is *probed*, not
asserted, so that "UNAVAILABLE" is a measurement rather than an opinion.

---

## D. Phase 0 Test Plan

Full plan with Input / Expected / Pass Criteria / Failure Condition, written before
implementation: **`docs/phase0/TEST-PLAN.md`**. Summary:

| ID | Subject | Required? |
| --- | --- | --- |
| CAP-0001 | Secure context / HTTPS | REQUIRED |
| CAP-0002 | Camera API availability (API only — not permission) | REQUIRED |
| CAP-0003 | WebGPU determined by functional probe | REQUIRED |
| CAP-0004 | DeviceMotion determined after user gesture | REQUIRED |
| CAP-0005 | DeviceOrientation determined after user gesture | REQUIRED |
| CAP-0006 | WebAssembly executes real module (`add(2,3)===5`) | REQUIRED |
| CAP-0007 | Worker round-trip | REQUIRED |
| CAP-0008 | OffscreenCanvas pixel readback exactness | REQUIRED |
| CAP-0009 | Depth / ARKit / RoomPlan / Scale honesty | REQUIRED |
| CAP-0010 | Matrix integrity + save/round-trip + no-inference rule | REQUIRED |
| CAP-0011 | Phase Lock blocks Phase 1 while Phase 0 is unpassed | REQUIRED |
| CAP-0012 | Probe budget (total detect time) | ADVISORY |

Fail-closed: a test that cannot be evaluated is `PENDING`, and **any** `PENDING` keeps the
overall verdict at `TESTING`. `PENDING` never rounds up to `PASS`.

---

## E. Known Browser Limitations (target: iPhone / Safari / HTTPS)

1. **No camera depth.** No Web API exposes iPhone depth/LiDAR to Safari. → `DEPTH: UNAVAILABLE`.
2. **No ARKit / RoomPlan from JavaScript.** No bridge exists in mobile Safari. → `UNAVAILABLE`.
3. **No WebXR** on iOS Safari, so not even the standards-track depth-sensing path exists.
4. **Motion sensors are gesture-gated** (`DeviceMotionEvent.requestPermission`) and the call
   throws outside a user gesture. Phase 0 therefore reports `PERMISSION_REQUIRED` until tapped.
5. **No `ImageCapture`** — frame grabs must go through `<video>` + canvas/`VideoFrame`.
6. **No `performance.memory`, no `navigator.deviceMemory`** — §50's "Memory" row will be
   `UNAVAILABLE` on Safari rather than a fabricated number. `navigator.storage.estimate()`
   is available and is reported instead, clearly labelled as storage, not heap.
7. **SharedArrayBuffer requires COOP+COEP**; GitHub Pages cannot set those headers, so
   WASM threads must not be assumed. The engine must work single-threaded per worker.
8. **Autoplay/inline video**: `playsinline` + `muted` are mandatory or the stream will not
   render inline on iOS.
9. **Backgrounding kills the pipeline**: `visibilitychange` suspends rAF and the camera
   track. Must be handled as `TRACKING LOST` + relocalization, never silently.
10. **No absolute scale from a monocular camera** — §90. `SCALE: UNKNOWN`.
11. **Thermal throttling** on sustained camera + compute is real and unobservable from JS;
    only its effect (frame time) is measurable, so the perf tier must be reactive, not predictive.
12. **iPadOS reports a desktop UA** — OS detection by UA is unreliable, hence `method: INFERENCE`
    and `maxTouchPoints` is recorded alongside it.

---

## F. Fallback Strategy

| Preferred | Fallback 1 | Fallback 2 | Terminal state |
| --- | --- | --- | --- |
| WebGPU compute | WebGL2 | CPU in worker | never fake: report `GPU: CPU` |
| OffscreenCanvas in worker | main-thread canvas readback | — | report `OFFSCREEN: UNAVAILABLE` |
| `VideoFrame` (WebCodecs) | `createImageBitmap(video)` | `drawImage` + `getImageData` | — |
| `requestVideoFrameCallback` | `requestAnimationFrame` + `currentTime` change detection | fixed-interval timer | — |
| Visual-inertial pose | vision-only pose | — | `IMU: UNAVAILABLE`, keep tracking |
| Native depth | *(no fallback claimed in v1)* | — | `DEPTH: UNAVAILABLE` |
| Metric scale | *(none in v1)* | — | `SCALE: UNKNOWN`, world in LOCAL UNITS |
| SIFT relocalization | ORB | — | `RELOCALIZATION QUALITY: REDUCED` |

Rule: a fallback is only announced when it is actually implemented and running. An
unimplemented fallback leaves the terminal state (§107).

---

## G. Dependency Plan

Phase 0 ships with **zero runtime dependencies**. Everything is hand-written TypeScript,
because Phase 0's whole job is to observe the platform and any library would sit between
the measurement and the truth.

| Package | Scope | Why | Safari relevance |
| --- | --- | --- | --- |
| `vite` | dev | build/dev server, ES2020 output Safari can run | — |
| `typescript` | dev | type safety on the data schemas | — |
| `@vitejs/plugin-basic-ssl` | dev | HTTPS dev server so an iPhone on the LAN gets a secure context | required for getUserMedia |
| `vitest` | dev | unit tests for pure logic | — |
| `playwright` | dev | headless Chromium leg (development signal only) | cannot test Safari |
| *(runtime)* | — | **none** | — |

Deferred, to be re-evaluated with §24 criteria at the phase that needs them:

- Phase 3–6: hand-written Shi-Tomasi / pyramidal LK / RANSAC first. OpenCV.js
  (~8 MB wasm) is a candidate only if the hand-written path fails its perf budget;
  its size is a serious Safari-on-cellular problem and it is not adopted speculatively.
- Phase 27 (BA): a small hand-written Levenberg–Marquardt over a sparse Schur complement;
  Ceres-style libraries have no viable Web build.
- Phase 13: hand-written WebGL2/WebGPU point renderer rather than three.js, to keep
  §12 (renderer owns no spatial data) mechanically obvious.

Any future dependency must be recorded here with the seven §24 criteria answered.

---

## H. Expected Performance Budget

Derived from §53–§56. These are **targets to measure against**, not claims.

| Tier | Tracking res | Tracking FPS | Features | Mapping |
| --- | --- | --- | --- | --- |
| HIGH | 1280×720 | 30 | 1000–1200 | full BA |
| BASIC (default start) | 960×540 | 20–30 | 600–800 | reduced BA |
| REDUCED | 640×360 | 15–20 | 300 | minimal |

### H.0 Rotation changes the camera intrinsics

Measured in Phase 1: rotating the device swaps the video frame dimensions, 1280×720 ↔
720×1280, on the same track. §15 derives the intrinsics matrix K from the frame geometry,
so this is not a display concern — **a rotation mid-scan changes `fx`, `fy`, `cx`, `cy`**.

Consequences for later phases, recorded now rather than discovered later:

- Phase 2's frame pipeline must treat frame size as per-frame data, not a constant read
  once at open.
- Phase 6 must carry intrinsics per keyframe, and Phase 27's bundle adjustment must not
  assume a single shared K across the session.
- A keyframe's intrinsics must travel with it into `SpatialWorld` (§20 already lists
  `intrinsics` in the keyframe schema; this is why it matters).

### H.1 A measurement that puts the acquire budget in doubt

Phase 1's frame sampler measured **13.8 ms per sample** on the device for
`drawImage(video → 64×48)` followed by `getImageData(64×48)` — recorded as
`sampleCostMsMean` in the Phase 1 evidence. The same operation costs 0.4 ms in headless
Chromium on the dev machine.

The output is 3 kB, so the cost is not the pixels. It is the readback: `getImageData`
forces a GPU→CPU synchronisation, and on the iPhone that stalls for most of a frame
interval. **Phase 1 can afford it at 4 Hz; Phase 2 cannot afford it at 30 Hz**, where it
would consume 40% of the entire 33 ms budget before any feature has been detected.

So the "frame acquire" line below is not achievable through a main-thread canvas readback,
and Phase 2 must take one of the routes Phase 0 measured as available:

- `VideoFrame` (WebCodecs, measured AVAILABLE) transferred into the tracking worker, with
  `copyTo()` performed there rather than on the UI thread;
- or keeping the frame on the GPU — upload to a WebGL2/WebGPU texture and compute the
  grayscale pyramid in a shader, reading back only the feature list.

This is exactly the kind of assumption §H exists to expose. It is recorded here rather
than discovered in Phase 2.

**What Phase 2 did with it.** The pipeline probes three acquisition routes in order and
keeps the first that completes real round trips: `VideoFrame` transferred into the worker,
`createImageBitmap` with a resize, and last the main-thread readback above — kept as a
declared fallback, and kept *measured*, so the comparison that ruled it out is in the
evidence rather than only in this section.

**Measured on the device, Phase 2's passing run:**

| Route | Cost on the UI thread |
| --- | --- |
| `VideoFrame` construction (selected, 2363/2363 round trips) | **0.048 ms** mean |
| main-thread `drawImage` + `getImageData` at 64×48 (rejected) | 5.81 ms mean, 11 ms p95 |

`IMAGE_BITMAP` and `MAIN_CANVAS` were never reached, so their cost on this platform remains
unmeasured and the bundle reports that rather than a zero.

**Amendment: the readback is not a constant 13.8 ms.** The 13.797 ms above came from one
Phase 1 session. In Phase 2's passing run the same operation — the provenance cross-check,
which deliberately uses this exact route — measured **5.81 ms** mean, 11 ms p95, 15 ms max
over 94 samples. Both are real measurements of the same platform; the cost varies with what
else is in flight, and quoting either as *the* figure would be a guess about a distribution
from one sample. The argument is unchanged, because it never depended on the precise value:
at 5.81 ms the readback is still 17 % of a 33 ms budget spent before a pixel has been looked
at, against 0.048 ms for the route actually chosen — a ratio of roughly 120×.

**A measurement caveat that applies to every duration in Phase 2's evidence.** WebKit
quantises `performance.now()` to 1 ms. Every timing in the device bundle is an integer, so
"0.07 ms mean UI cost" means *zero on almost every frame, 1–2 ms occasionally* — the
per-frame UI work is below what the platform's clock can resolve. Means over thousands of
varying samples still recover sub-millisecond accuracy; individual readings do not, and no
sub-millisecond claim should rest on one.

Per-frame budget at BASIC (960×540), tracking worker, target ≤ 33 ms:

| Stage | Budget |
| --- | --- |
| frame acquire + grayscale + pyramid (3 levels) | ≤ 6 ms — **not reachable via main-thread `getImageData`; see §H.1** |
| Shi-Tomasi (only on refill frames) | ≤ 8 ms amortised |
| pyramidal LK, ~700 points, 21×21, 3 levels | ≤ 14 ms |
| forward/backward validation | ≤ 4 ms |
| RANSAC (E/H) + pose recovery | ≤ 6 ms |
| **total** | **≤ 33 ms (30 Hz), hard ceiling 50 ms (20 Hz)** |

UI thread: ≤ 16.7 ms/frame. Mapping runs off the tracking cadence: triangulation on
keyframe insert only; BA every ≥ 10 keyframes (§27).

Memory: ≤ 30 keyframes, ≤ 5000 landmarks (§56). Keyframes store downscaled grayscale +
features, never full-resolution RGBA. Estimated ceiling ≈ 30 × (960×540 grayscale ≈ 0.52 MB)
≈ 16 MB for keyframe imagery, plus ≈ 5000 × ~200 B ≈ 1 MB of landmark records.

### H.2 Three things Phase 2 measured that the budget above did not anticipate

Recorded here for the same reason §H.0 and §H.1 are: so the next phase inherits them rather
than rediscovering them.

**Pacing cannot be measured from the last admission.** A scheduler that admits a frame when
`now - lastAdmitted >= 1000/targetFps` aliases catastrophically when the camera rate is
close to the target rate: roughly half the frames land a hair early, each is declined, and
the next arrives a full interval later. Measured at **12.88 fps against a 30 fps target**.
The deadline has to accumulate on an ideal grid. Any later phase that paces work — mapping
updates, bundle adjustment every N keyframes (§27) — has the same trap.

**The delivered rate is capped by the camera, not by the target.** §53's tiers name target
rates, and it is tempting to treat a shortfall against the target as a signal to degrade.
It is not: the camera may simply not be offering that many frames, and no amount of
degrading conjures one. The controller now compares delivery against the lower of the two,
and only blames itself when the worker is using at least half its budget — every remedy
§54 lists reduces *processing* cost.

**Recovery needs damping, and the ladder's own arithmetic says how much load escapes it.**
Descending the full ladder cuts pixels per frame about fourfold (1280×720 → 640×360) while
relaxing the worker budget about 1.5× (33.3 ms → 50 ms). So any fixed extra cost worth less
than about 6× the budget where it appeared becomes affordable partway down, and a controller
without flap damping cycles indefinitely. Measured as five ladder moves in one ten-second
window. Phase 18's stress work should expect this shape.

**A rate-only ladder step does not reduce per-frame latency, and the device proved it.**
Steps 1→2 and 3→4 lower the target rate and leave the resolution alone. Phase 2's passing run
measured a rate-only step at 58 ms → 59 ms and the resolution step immediately after it at
57 ms → 26 ms. Anything later that asks "did degrading help?" has to ask it of the quantity
the step actually controls: a rate step buys wall-clock time between frames, not time within
one. §27's bundle-adjustment frequency is the next knob with this shape.

### H.3 What the device turned out to afford

Phase 2's passing run, for calibrating the budgets above against something measured rather
than targeted. iPhone / iOS 18.7 / Safari 26.6, `hardwareConcurrency` 4.

| | Measured |
| --- | --- |
| Full preprocessing at 720×1280 — readback, grayscale, 3-level pyramid | **10–11 ms** per frame, unstressed |
| Sustained delivery at that size | **29.65 fps** over 48.5 s, 0 frames lost |
| UI thread, per admitted frame | below the platform's 1 ms clock resolution |
| Tier the controller settled on | `HIGH 1280×720@30` — the top of the ladder |

The budget table above allows ≤ 6 ms for acquire + grayscale + pyramid at 960×540. The
device did the same work at **1.8× that pixel count in 10–11 ms**, so per pixel it is close
to the estimate and comfortably inside the 33 ms frame budget as a whole. What that leaves
for Phases 3–6 is roughly 22 ms per frame at 30 Hz, against the 32 ms those stages are
budgeted — which is the first sign that the per-frame budget is tight rather than generous,
and worth remembering before Phase 4 adds pyramidal LK on 700 points.

### H.4 What Phase 3 measured about the detection budget

The budget table above allows **≤ 8 ms amortised** for Shi-Tomasi. Phase 3 chose to detect
on pyramid level 1 rather than level 0 for that reason, and measures the rejected option on
every automated run rather than leaving the argument unchecked. Headless Chromium, synthetic
camera, 451 detections:

| Level | Size | Cost per detection | Features |
| --- | --- | --- | --- |
| 1 (selected) | 480×270 | **7.5–9.4 ms** | median 45 |
| 0 (calibration) | 960×540 | **45–84 ms** | 56–114 |

Four times the pixels cost 6–10× the time for 1.3–2.5× the features; the spread is a shared
CPU and a single calibration detection, so the ratio is the durable part. Three things follow
for later phases.

**Detection level is a per-phase decision, not a global one.** Phase 4's optical flow is
pyramidal and runs on levels 0–2; Phase 3's detection runs on level 1 and reports positions
scaled back to level 0 (`x0`, `y0` in every record). Nothing downstream should assume one
"the" working resolution — the record carries both.

**§H.3's remaining 22 ms is now roughly 14 ms.** Phase 2 left about 22 ms per frame at 30 Hz
for Phases 3–6 after its measured 10–11 ms of preprocessing. Detection at level 1 took
7.5–9.4 ms of that on a desktop; the device figure will differ and the device run will report it. What
does not depend on the device is the shape: pyramidal LK on ~700 points (§H's 14 ms line) has
to fit in what is left, and the first budget line to come under real pressure is Phase 4's,
not Phase 3's.

**A budget written for the device cannot be adjudicated off the device.** Consecutive runs of
identical Phase 3 code measured 7.49, 7.98 and 9.36 ms on the same headless machine — both
sides of the 8 ms line — because the CPU is shared and the synthetic camera's texture varies
through its cycle. The automated leg therefore prints FEAT-005's verdict and declines to gate
on it, gating instead on a separately named 24 ms configuration tripwire that sits between
that spread and the 45–84 ms a wrong-level regression would cost. Every later phase with a
device budget in this section — Phase 4's 14 ms, Phase 5's 6 ms, §27's BA cadence — inherits
the distinction: an off-device leg can catch a regression in what the code *does*, and cannot
answer what the device *affords*.

**A corner response built from one box-filter pass is a plateau, and plateaus have no
maximum.** Non-maximum suppression keeps whichever point the scan reached first, so every
feature lands at the top-left edge of its corner's neighbourhood — measured as a three-pixel
offset on a synthetic checkerboard, with zero local variance at the chosen positions. Two
box passes (a triangular kernel) restore a single peak. Recorded here because every later
stage that separably smooths a response map — the plane-fitting of §17, any score map
Phase 5 suppresses over — has the same failure mode, and its symptom is a systematic
positional bias that no count-based test can see.

### H.5 A phase inherits the previous phase's live machinery, and must say what it does with it

Phase 3's first device run preprocessed 2190 frames and detected on none of them, because
the FEATURES screen is reached from a PIPELINE screen whose pipeline is still running — it
has to be still running, since that is how Phase 2 passes. The start handler guarded on
`pipeline.isRunning()`, which on that path means "the previous phase is still going", and
returned before ever asking the worker to detect.

Every phase from here on inherits something live from the one before it: Phase 4 inherits
Phase 3's feature population, Phase 6 inherits Phase 5's verified correspondences, Phase 9
inherits keyframes that are still being inserted. Three rules follow, and they cost nothing
to apply in advance:

- **A stage's own "am I running" state is not the state of the stage below it.** Deriving one
  from the other reads correctly on the path where nothing is running yet, and silently
  inverts on the path a device actually takes.
- **Inherited machinery is adopted, not restarted and not treated as an obstacle** — and what
  is adopted must be brought to a defined state. Phase 2's injected load survives into Phase
  3 unless it is cleared, and it moves the tier, which sets the resolution Phase 3 detects
  at; a measurement of the detector would have been a measurement of the stress.
- **One predicate, read by the screen, the tests and the evidence — every reader, including
  the view model.** Phase 3 had the same wrong expression in the control and in the harness,
  so the button said `DETECTING` over a stage that had never started and no test disagreed.
  The first fix consolidated three of the four readers and left the fourth — the prop that
  sets the button's label and its `disabled` flag — so the next device run found the control
  not merely wrong but *unpressable*. A consolidation that misses the reader the user can see
  is not a consolidation. §57's UI states and Rule 002 are only worth anything if there is a
  single place the answer comes from and nothing reads around it.

The automated leg missed it because it entered the phase cold, through the development
override, with nothing running — a sequence no device ever takes. **A leg that reaches a
phase differently from the way a device reaches it is not testing the path that matters.**
Phase 3's leg now enters Phase 2, starts the pipeline, turns stress on and hands it over;
every later leg should reach its phase the way the device does.

It then missed the follow-on defect for the neighbouring reason: it drove the engine through
the debug API rather than the DOM, so a control that had become *unpressable* was invisible
to it — the engine was reachable, the button was not. **A leg must press the control a person
presses, and assert what that control says either side of the press.** Every later phase's
screen has a start control with the same shape; reaching past it tests everything except the
thing the user touches.

### H.6 A threshold relative to the frame cannot say the frame is empty

Phase 3's corner floor was `maxScore × 0.01` — a fraction of the strongest response *in that
frame*. On a blank wall the strongest response is sensor noise, so the floor becomes 1 % of
noise and the detector fills its target with it. Measured on the device: a surface at mean
gradient 3.14 still produced 800 features, and the points drawn on screen sat on nothing.

The general form, which every later phase has a version of: **a criterion normalised by the
data it is judging cannot express "there is nothing here."** It always finds a best candidate
and grades relative to it. Phase 5's inlier ratio, Phase 9's triangulation angle and Phase 11's
plane-support count are all in this family — each needs a floor in the units of the physical
quantity, not a percentile of whatever the frame happened to contain.

Where such a floor is needed, prefer a constant the plan has **already fixed for another
purpose** over a new one. Phase 3's is `TEXTURE_POOR_CEILING`: `gx` is a central difference
halved, so it is intensity levels per pixel, the same units the texture classifier uses, and
requiring a corner to be locally at least as strong as the boundary between "blank" and
"ambiguous" needs no new number and cannot be tuned against the failing test.

And derive the conversion from the config rather than writing the product down: the box
filter is a running sum applied separably `blurPasses` times at radius r, so a flat field of
v leaves `(2r+1)^(2·blurPasses)·v`. A unit test pins that arithmetic against the config so
the constant stays right if the window changes.

### H.7 Some errors are invisible to every check that averages

The overlay was suspected of being rotated or mis-scaled, and clearing it took a new kind of
test, because **nothing in the repository could have detected that class of error**:

- unit tests on an in-memory image never cross the video → `VideoFrame` → canvas →
  `getImageData` → pyramid path, which is where an orientation error lives;
- Phase 2's provenance cross-check compares the **mean** luma of the worker's grayscale
  against an independent read of the same frame — and a mean is invariant to a rotation, a
  flip and a transpose, so a scrambled buffer passes it perfectly;
- FEAT-001's contrast statistic is computed inside the worker on the buffer the detector
  used, so it scores as well on a buffer unrelated to what the camera is pointing at;
- and a synthetic camera that is a smooth gradient has no landmark whose position could
  disagree with anything.

The rule for every later phase: **an invariant that averages cannot verify a geometry.**
Phase 6's pose and Phase 9's triangulation will need the same treatment — a fixture with
known, asymmetric landmarks, and an assertion about *where* things are rather than how much
of them there is. `scripts/run-e2e-phase3-alignment.mjs` is the pattern: three blocks and one
deliberately empty quadrant, so no rotation or reflection maps the set onto itself.

### H.8 What Phase 4 measured, and the shapes of mistake it exposed

Phase 4 is the first stage whose output can be produced without looking at the data, so most
of what it taught is about *checking*, not about optical flow. Recorded here for the phases
that inherit the same problem — Phase 5's inlier ratio, Phase 6's pose, Phase 9's
triangulation are all quantities a plausible-looking implementation can invent.

**The budget line came under real pressure, and about a third of the pressure was mine.**
§H's table allows ≤ 14 ms for pyramidal LK on ~700 points. The first implementation measured
**65 ms per frame at 165 points** on the automated leg, which would have been reported as what
the platform affords. It was not: the solver called a shared `sample(x, y)` helper 441 times
per iteration, recomputing two `Math.floor`s and four interpolation weights each time, when
the whole 21×21 window shares one sub-pixel offset. Computing them once and walking consecutive
indices gives **22.5 ms** at identical results — the accuracy tests hold to 0.05 px either way.

Two things follow. **A cost measured before the obvious inefficiency is removed is not a
measurement of the platform**, and §34's "correctness before performance" is not a licence to
skip that step — it is a licence to *report* the remaining gap rather than closing it by
changing what the code computes. And the gap is real: 22.5 ms on a desktop against a 14 ms
device budget means Phase 4 is the first stage where §12's specified parameters may genuinely
not fit, and FLOW-006 is advisory so that the device can say so rather than the parameters
being quietly reduced until they fit. §H.3's remaining budget is now the thing to watch.

**A threshold borrowed from a later phase measures the wrong quantity, even when the number is
right.** §33 gives LOST two branches: `inliers < 20`, or consecutive failures. Inliers are
§14's, which is Phase 5. Reusing the *number* for tracked points — the quantity Phase 4
actually has — made every frame of a 20-feature scene a failure, because survival of 19 out of
20 is a tracker working perfectly, and the state sat at LOST for a run in which nothing had been
lost. The general form: **a criterion from a later phase is not available early by
substituting a quantity with the same units.** A population too small to work with is what
DEGRADED says; LOST is about losing what you had. Phase 5 has the same trap waiting with
`inlierRatio`, and Phase 6 with `reprojectionError` — both appear in §33's GOOD condition, both
are `null` in Phase 4, and a null must fail its conjunct rather than be dropped from it.
`GOOD` is unreachable in Phase 4 *by construction* as a result, and the state carries
`goodBlockedBy` naming the missing terms, so the absence is visible instead of looking like a
tracker that never got good enough.

**Two criteria about different conditions cannot share one run-wide tally.** FLOW-001 requires
the state never to be LOST *while the scene is static*. FLOW-005 requires a deliberate
occlusion during which it certainly is. Implemented against a single `stateFrames` count, the
two contradict each other and no correct implementation exists. Every later phase with
per-condition tests — Phase 5's high- and low-texture scenes, Phase 18's stress segments — has
to accumulate per condition, not per run, or it will write a suite that cannot be satisfied.

**A discontinuity whose cause is known is neither a failure nor a fresh start.** §53's tier
ladder steps and §H.0's rotation both change the frame geometry mid-run, and a level-0 position
from a 1280×720 frame means nothing in a 640×360 one. The tracker empties its population — it
has to. The first version also cleared its "has anything ever been tracked" flag, which put
§33's state back to READY in the middle of a run that had tracked thousands and restarted the
consecutive-failure counter with it; a tier step that landed inside a covered-lens segment then
left a 14-frame occlusion never reaching LOST. FLOW-005 caught it and described it exactly as
it looked from outside: *"tracking was maintained through a covered lens."* Every later stage
that holds state across frames — Phase 8's keyframes, Phase 10's landmark map — needs the same
three-way distinction: failed, restarted, and *interrupted for a reason we can name*. The count
of interruptions goes into the evidence, because a run whose population was rebuilt a dozen
times is not the same run as one that was not.

**A stage must not be handed data its own machinery cannot use.** Detection runs at pyramid
level 1 with a 5 px margin in that level's pixels — 10 in level-0 pixels. A 21×21 tracking
window at level 0 needs 11. Points in that one-pixel band were detected, admitted, and lost on
the next frame through no fault of the tracker: 15 % of the population, and FLOW-001's survival
read **84.6 % on a perfectly static image the tracker had followed exactly**. The consumer
declines them now, and reads the margin from the solver's own configuration rather than writing
the number down — the same rule §H.6 gives for deriving a constant from the config.

**Measured on the device (2026-08-22), and two numbers that change what later phases should
expect.**

| | Measured on iPhone / iOS 18.7 / Safari 26.6 |
| --- | --- |
| Pyramidal LK, 21×21, 3 levels, 30 iterations | **2.668 ms at 41 points** |
| The independent scene-shift search that checks it | **7.648 ms** |
| Worker total, per frame | 16.41 ms mean, 33 ms p95 |
| Tracked population | median **74** static, **41** slow |
| Longest track | 467 frames |

The first surprise is the ratio: **the check costs three times the thing it checks.** An
exhaustive integer SAD over 289 shifts on the top pyramid level is cheap in operations but
touches the whole level 289 times, where LK touches a 21×21 window per point and the
population was small. On the desktop leg, with 165 points, the ratio inverts (17.8 ms against
2.4 ms). So neither figure is "the" cost — the two scale with different things, and any later
stage that adds an independent cross-check should expect it to cost like a full-frame pass
rather than like the estimator it validates.

The second is the population, and it is a warning for Phase 5. §H's budget line assumed ~700
points; the device delivered **41**. Nothing was wrong with the tracker — survival was 97 % and
the longest track ran 467 frames — the detector simply found that many corners in a dim room
(mean luma 52.5), which is Phase 3's absolute corner floor working as §H.6 intended. But v3
§14 asks Phase 5 for **at least 30 inliers** and calls **>100** a GOOD candidate. A median of
41 correspondences makes the first marginal and the second unreachable in that room. Phase 5
must measure the correspondence count it actually receives and report when the scene cannot
supply what the threshold needs — rather than lowering the threshold, and rather than passing
on a handful of points and calling the pose verified.

**And an evidence gap is a defect, even when every test passes.** That device run could not
answer "why is the population 41", because Phase 4 routed its results away from
`FeaturePopulation` and carried no detection statistics. Every later phase that hands one
stage's output to another needs the *handover* in its evidence, not just the outcome: what was
offered, what was taken, and why the rest was not. The flow record now splits the declines into
"already being tracked" — the healthy case — and "outside the solver's reach", and the two
mean opposite things about the tracker's health.

**And a check that cannot discriminate must say so rather than name a winner.** The overlay
alignment probe scores the detected positions against an independent read of the video under
each rotation, flip and transpose. On a scene that is dense and repetitive — a brick wall, a
tiled floor, the periodic pan Phase 4's leg generates — *every* transform lands on corner-like
pixels, all seven scores fall within a factor of 1.05, and the ordering between them is noise.
The probe named `rot180`. Acting on that would have abandoned a working acquisition route.
It now requires the winning transform to beat chance by the same margin identity is required
to, and reports `measurable: false` on a frame with no texture at all — which a covered lens
produces on purpose, and which used to put `Infinity` into every bundle and an integrity error
into every log. This is the same lesson as Phase 3's contrast *ratio*, in a different place:
**a statistic normalised against a baseline that is itself saturated says nothing, and the
honest output is "cannot tell", not the argmax.**

---

**Phase 0's own budget:** full capability detection ≤ 1500 ms wall clock, excluding the
gesture-gated motion probes (each of which uses a 2000 ms listen window by design, because
it waits for real sensor events rather than guessing).

---

## Phase status

Live status is tracked in `docs/PHASE-STATUS.md` and, at runtime, by `PhaseRegistry`.
No phase is marked PASSED in either place without real-device evidence JSON committed
under the phase's own `docs/phase*/evidence/` directory.
