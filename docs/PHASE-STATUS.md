# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 11/11 required + 2/2 advisory. Evidence committed. |
| 1 | Camera Capture | **NOT_STARTED** | Phase Lock is open. Not yet implemented — CAM-001..005 are next. |
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

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0}`. The START SCAN control reads it, and stays disabled with the
label `PHASE 1 — NOT IMPLEMENTED` even after Phase Lock would permit entry. Nothing in the
UI implies a capability that has not been built.
