# Safari Spatial Mapping Engine

Turning what an iPhone's Safari can actually observe — camera frames and motion — into a
reusable **Spatial World**, and letting a game layer collide with the geometry that was
reconstructed from the real room.

Built strictly to `Safari Spatial Mapping Prototype v3.0`, phase by phase. The governing
constraint is that no number is displayed that was not measured, and no phase is declared
passed on anything but real-device evidence.

**Current state: Phase 0 of 20 implemented. Phase 0 is `TESTING`, awaiting real-device
evidence — see [`docs/PHASE-STATUS.md`](docs/PHASE-STATUS.md).**

## Quick start

```bash
npm install
npm test          # anti-fake audits + typecheck + 69 unit tests
npm run test:e2e  # automated DESKTOP_DEV leg: real browser, real evidence, real screenshot
npm run dev       # HTTPS dev server (required for camera and motion on a phone)
```

To pass Phase 0, run the device test: [`docs/phase0/HOW-TO-RUN-DEVICE-TEST.md`](docs/phase0/HOW-TO-RUN-DEVICE-TEST.md).

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
src/
  core/          types, seeded Rng, validators, PhaseRegistry (Phase Lock)
  capture/       CapabilityDetector, MotionCapabilityProbe, probe plumbing
  debug/         Logger, EvidenceRecorder
  testkit/       Phase0Tests
  ui/            Phase0Screen, styles
  pipeline/ tracking/ mapping/ world/ renderer/ game/   empty — later phases
scripts/         audit-fake-data, audit-architecture, run-e2e
```

## Next

Phase 1 (Camera Capture, CAM-001..005) begins only after a committed `REAL_DEVICE` bundle
reads `"overallVerdict": "PASSED"`.
