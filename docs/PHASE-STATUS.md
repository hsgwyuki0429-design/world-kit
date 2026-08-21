# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **TESTING** | Implemented. Desktop leg green; **awaiting real-device evidence**. |
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

Every required test (CAP-0001 … CAP-0011) passes on the automated DESKTOP_DEV leg, and the
evidence bundle for that run is committed. That is not a pass, and the code will not report
one: `determineLeg()` classifies an automated localhost run as `DESKTOP_DEV`, and
`PhaseRegistry.evaluate()` returns `TESTING` for any non-`REAL_DEVICE` leg no matter how
green the results are.

To move Phase 0 to PASSED, see **`docs/phase0/HOW-TO-RUN-DEVICE-TEST.md`**.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0}`. The START SCAN control reads it, and stays disabled with the
label `PHASE 1 — NOT IMPLEMENTED` even after Phase Lock would permit entry. Nothing in the
UI implies a capability that has not been built.
