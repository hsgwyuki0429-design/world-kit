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

**Phase 0's own budget:** full capability detection ≤ 1500 ms wall clock, excluding the
gesture-gated motion probes (each of which uses a 2000 ms listen window by design, because
it waits for real sensor events rather than guessing).

---

## Phase status

Live status is tracked in `docs/PHASE-STATUS.md` and, at runtime, by `PhaseRegistry`.
No phase is marked PASSED in either place without real-device evidence JSON committed
under `docs/phase0/evidence/`.
