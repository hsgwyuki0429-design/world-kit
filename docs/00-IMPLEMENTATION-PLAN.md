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

### A.3 Prior expectation (NOT the matrix — to be confirmed or refuted by measurement)

Recorded here only so that a *discrepancy* between expectation and measurement is
visible and investigable. If measurement disagrees, **measurement wins** and the
expectation below is wrong.

| Capability | Expected on iPhone / Safari 26 | Basis |
| --- | --- | --- |
| Secure context (HTTPS) | AVAILABLE | deployment requirement |
| MediaDevices / getUserMedia | AVAILABLE | long-standing Safari support |
| `enumerateDevices` labels pre-permission | hidden (empty strings) | privacy behaviour |
| `MediaStreamTrack.getCapabilities` | AVAILABLE | Safari 15.4+ |
| DeviceMotion | PERMISSION_REQUIRED → then AVAILABLE | iOS 13+ gate |
| DeviceOrientation | PERMISSION_REQUIRED → then AVAILABLE | iOS 13+ gate |
| `webkitCompassHeading` | AVAILABLE | WebKit-only field |
| WebAssembly | AVAILABLE | universal |
| Web Worker | AVAILABLE | universal |
| OffscreenCanvas | AVAILABLE | Safari 16.4+ |
| `transferControlToOffscreen` | AVAILABLE | Safari 16.4+ |
| WebGL2 | AVAILABLE | Safari 15+ |
| WebGPU | AVAILABLE | Safari 26 ships WebGPU |
| WebCodecs (`VideoFrame`) | AVAILABLE | Safari 16.4+ |
| `requestVideoFrameCallback` | AVAILABLE | Safari 15.4+ |
| `createImageBitmap` | AVAILABLE | Safari 15+ |
| SharedArrayBuffer | UNAVAILABLE unless COOP/COEP | needs cross-origin isolation |
| ImageCapture | **UNAVAILABLE** | not implemented in WebKit |
| `performance.memory` | **UNAVAILABLE** | Chromium-only |
| `navigator.deviceMemory` | **UNAVAILABLE** | Chromium-only |
| WebXR (`navigator.xr`) | **UNAVAILABLE** | not implemented in iOS Safari |
| Camera Depth | **UNAVAILABLE** | no Web API exists on this platform |
| Native ARKit | **UNAVAILABLE** | no JavaScript API exists |
| RoomPlan | **UNAVAILABLE** | no JavaScript API exists |
| Metric scale | **UNKNOWN** | monocular; §90 |

### A.4 Measured matrices

`MEASURED` — see `docs/phase0/evidence/`. Two independent legs are recorded:

- **DESKTOP-CHROMIUM leg** — automated, produced by `npm run test:e2e`. Development
  signal only. Per Rule 004 this can never constitute a Phase pass.
- **REAL-DEVICE leg** — iPhone / iOS / Safari / HTTPS. Produced by a human tapping
  through the app and exporting evidence JSON. This is the only leg that can pass a Phase.

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

Per-frame budget at BASIC (960×540), tracking worker, target ≤ 33 ms:

| Stage | Budget |
| --- | --- |
| frame acquire + grayscale + pyramid (3 levels) | ≤ 6 ms |
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
