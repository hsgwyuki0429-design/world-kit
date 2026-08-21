# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **TESTING** | Implemented. Desktop leg green. Real-device bundle committed but exported before the sensor tap, so it reads TESTING. **Awaiting a REAL_DEVICE bundle whose own verdict is PASSED.** |
| 1 | Camera Capture | BLOCKED | Phase Lock — Phase 0 has not PASSED. |
| 2 | Frame Pipeline | BLOCKED | |
| 3 | Feature Detection | BLOCKED | |
| 4 | Optical Flow Tracking | BLOCKED | |
| 5 | Geometric Verification | BLOCKED | |
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

## Why Phase 0 is TESTING and not PASSED

Two separate reasons, and both have to clear.

**The desktop leg cannot pass a phase.** Every required test passes there and its bundle is
committed, but `determineLeg()` classifies an automated localhost run as `DESKTOP_DEV`, and
`PhaseRegistry.evaluate()` returns `TESTING` for any non-`REAL_DEVICE` leg no matter how
green the results are (Rule 004).

**The committed real-device bundle reads TESTING.** It was exported before the gesture-gated
sensor probe, so CAP-0004 and CAP-0005 are `PENDING`. A device screenshot from the same
session shows the app reaching `PASSED` with `13 PASS · 0 FAIL · 0 PENDING` after the tap —
strong evidence that the device leg does pass — but the committed file is not that run, and
a phase is not marked passed against a file that says otherwise (§2, §106).

**To close it:** on the device, tap `PROBE MOTION SENSORS`, allow Motion & Orientation
Access, move the phone during the two-second window, then export. The file will be named
`phase0-real-device-PASSED-<timestamp>.json`. Commit it with the screenshot and update this
table. Full steps: **`docs/phase0/HOW-TO-RUN-DEVICE-TEST.md`**.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0}`. The START SCAN control reads it, and stays disabled with the
label `PHASE 1 — NOT IMPLEMENTED` even after Phase Lock would permit entry. Nothing in the
UI implies a capability that has not been built.
