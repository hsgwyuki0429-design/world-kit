# Safari Spatial Mapping Engine

Turning what an iPhone's Safari can actually observe — camera frames and motion — into a
reusable **Spatial World**, and letting a game layer collide with the geometry that was
reconstructed from the real room.

Built strictly to `Safari Spatial Mapping Prototype v3.0`, phase by phase. The governing
constraint is that no number is displayed that was not measured, and no phase is declared
passed on anything but real-device evidence.

**Current state: Phase 0 `PASSED` on iPhone / iOS 18.7 / Safari 26.6 over HTTPS.
Phase 1 (Camera Capture) implemented and `TESTING` — the automated leg exercises both
permission scenarios; awaiting two device runs. See
[`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md).**

## Quick start

```bash
npm install
npm test          # anti-fake audits + typecheck + 154 unit tests, incl. evidence re-derivation
npm run test:e2e  # automated DESKTOP_DEV legs for both phases, with evidence and screenshots
npm run dev       # HTTPS dev server (required for camera and motion on a phone)
```

To pass Phase 0, run the device test: [`docs/phase0/HOW-TO-RUN-DEVICE-TEST.md`](docs/phase0/HOW-TO-RUN-DEVICE-TEST.md).

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
src/
  core/          types, seeded Rng, validators, PhaseRegistry (Phase Lock)
  capture/       CapabilityDetector, MotionCapabilityProbe, CameraSource,
                 FrameIntegrityMonitor, ScenarioLedger, probe plumbing
  debug/         Logger, EvidenceRecorder
  testkit/       Phase0Tests, Phase1Tests
  ui/            Phase0Screen, Phase1Screen, styles
  pipeline/ tracking/ mapping/ world/ renderer/ game/   empty — later phases
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

## Next

Phase 2 — Frame Pipeline (§10). Blocked until Phase 1 passes on a device.
