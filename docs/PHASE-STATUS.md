# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 11/11 required + 2/2 advisory. Evidence committed. |
| 1 | Camera Capture | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 5/5 required + 1/1 advisory, across two runs covering both permission scenarios. |
| 2 | Frame Pipeline | **NOT_STARTED** | Phase Lock is open. Not yet implemented — §10 is next. |
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

## Phase 1 — PASSED

**Evidence:** three `REAL_DEVICE` bundles under `docs/phase1/evidence/`, all from
iPhone / iOS 18.7 / Safari 26.6 over HTTPS.

| Bundle | Verdict | What it contributes |
| --- | --- | --- |
| `…PASSED-2026-08-21T10-07-53-690Z.json` | **PASSED** | CAM-001, CAM-003, CAM-004, CAM-005 observed directly |
| `…TESTING-2026-08-21T09-50-49-632Z.json` | TESTING | CAM-002 observed directly — the denial |
| `…FAILED-2026-08-21T09-48-59-133Z.json` | FAILED | the record of a harness defect, kept deliberately |

From the passing run:

| | |
| --- | --- |
| Stream | rung 1 of the ladder, `facingMode: environment`, 1280×720 @ 30 fps, opened in 705 ms |
| Capture | **1263 frames over 42.3 s at 29.84 fps**, longest gap 128 ms, via `requestVideoFrameCallback` |
| Image change | 158 samples; MAD min 15.92 / median 38.62 / **peak 68.81** against a floor of 8.0 |
| Rotation | 2 changes, next frame 38 ms later, 1043 frames after |
| Denial | `NotAllowedError` → `CAMERA_PERMISSION_DENIED`, no stream, no preview element |
| Error log | empty |

The transition history shows it was not passed by assertion: the run sat at `TESTING`
through five successive re-evaluations as CAM-001, then CAM-005, then CAM-004, then CAM-003
each became evaluable, and reached `PASSED` only when the 30 s window filled.

**Two runs, because two scenarios.** The passing bundle carries CAM-002 as a carry-over
(`observedDirectly: false`) from the denied run 894 s earlier. The repository gate ignores
that carry-over: `tests/unit/committedEvidence.test.ts` requires the committed set to
contain a direct observation of *each* scenario, and it does — CAM-001 in the passing
bundle, CAM-002 in the denied one.

### Code changed after the pass

The pass attests to `appVersion 0.1.0`. One reporting defect found by reading the bundle
has since been fixed: CAM-001 reported `element 1280x1280` for a 1280×720 camera, because
the observed size was kept as a per-axis maximum and rotation had produced both 1280×720
and 720×1280. The pair is now taken from the largest frame by area, so the reported size is
one the element genuinely had, and every distinct size is listed. No probe result or pass
criterion is affected — both axes were ≥ 1 either way.

### What rotation does to the frame, and why Phase 6 needs to know

That defect exposed a real platform behaviour: **rotating the device swaps the video frame
dimensions**, 1280×720 ↔ 720×1280. Phase 6 derives camera intrinsics (`fx`, `fy`, `cx`,
`cy`) from the frame dimensions, so a rotation mid-scan is an intrinsics change, not a
cosmetic one. The monitor now records every distinct size seen so the change is visible in
evidence rather than having to be inferred.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0, 1}`. The START SCAN control reads it alongside Phase Lock, and a
control for an unbuilt phase stays disabled with the reason in its label. Nothing in the UI
implies a capability that has not been built.
