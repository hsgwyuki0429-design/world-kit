# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 11/11 required + 2/2 advisory. Evidence committed. |
| 1 | Camera Capture | **TESTING** | Implemented. Desktop leg exercises both permission scenarios; **awaiting two real-device bundles** (granted and denied). |
| 2 | Frame Pipeline | BLOCKED | Phase Lock — Phase 1 has not PASSED. |
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

## Phase 1 — TESTING

Implemented and exercised end to end on the automated DESKTOP_DEV leg, which drives two
browsers: one with a synthetic camera and permission granted, one with permission refused.
Between them CAM-001, CAM-002, CAM-003, CAM-005 and CAM-006 are decided.

| Measured on the desktop leg | |
| --- | --- |
| Stream | 1280×720, constraint ladder rung 2 (`facingMode: {exact:'environment'}` refused, looser rung succeeded) |
| Capture | ~808 frames over 40.4 s at ~20 fps, longest gap 69–273 ms across runs, via `requestVideoFrameCallback` |
| Rotation | 2 orientation changes, next frame 21 ms later |
| Denial | `NotAllowedError` → `CAMERA_PERMISSION_DENIED`, no stream held, no preview element in the DOM |

**CAM-004 cannot be decided on that leg.** Chromium's synthetic camera is not a moving
camera, and its peak frame-to-frame difference straddles the 8.0 floor between runs — 6.79
and 9.70 both observed. The harness therefore excludes CAM-004 from the gate rather than
letting a meaningless verdict flap, and prints the measured values. Feeding in a video file
chosen to clear the bar would make the leg green without making it informative. The
threshold logic is covered by unit tests; the behaviour needs the device.

### First device runs — one clean, one that found a bug in the harness

Both are committed under `docs/phase1/evidence/`.

**The denied run is valid and complete.** `NotAllowedError` → `CAMERA_PERMISSION_DENIED`,
no stream held, no preview element, recovery recorded. CAM-002 PASS, `observedDirectly`.

**The granted run reported FAILED, and was wrong to.** The camera worked: rung 1 of the
ladder, `facingMode: environment`, 1280×720 at 30 fps, 1213 frames over 40.6 s at 29.83 fps
with a longest gap of 151 ms, two rotations survived with the next frame 40 ms later, and
a peak image difference of 75.2 against a floor of 12.2. CAM-003 and CAM-004 passed on that
data. CAM-001 and CAM-005 failed — because the tester pressed STOP CAMERA before exporting,
and both were reading *is the track live now* rather than *what was demonstrated*. Fixed;
see the amendment in `docs/phase1/TEST-PLAN.md`.

That run also validated the earlier CAM-004 correction with real data: median 45.31, peak
75.18, a ratio of 1.66. The `maxMad >= 4 × medianMad` gate removed before any device run
would have failed a perfect capture.

**To pass Phase 1:** one more granted run on the fixed build, since the committed granted
bundle predates the fix. The denied run stands. See
`docs/phase1/HOW-TO-RUN-DEVICE-TEST.md`. `tests/unit/committedEvidence.test.ts` requires a
committed bundle for each scenario with `observedDirectly: true`, ignoring the in-app
carry-over ledger.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0, 1}`. The START SCAN control reads it alongside Phase Lock, and a
control for an unbuilt phase stays disabled with the reason in its label. Nothing in the UI
implies a capability that has not been built.
