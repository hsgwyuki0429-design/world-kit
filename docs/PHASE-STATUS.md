# Phase status

Rule 005 (Phase Lock): a phase may not be started until the previous one has PASSED.
Rule 004: only evidence from **iPhone + Safari + HTTPS** can pass a phase.

`PhaseRegistry` enforces both at runtime. This file is the human-readable mirror; the
authority is the registry plus the evidence files under `docs/phase0/evidence/`.

| Phase | Name | State | Notes |
| --- | --- | --- | --- |
| 0 | Environment / Capability | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 11/11 required + 2/2 advisory. Evidence committed. |
| 1 | Camera Capture | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 5/5 required + 1/1 advisory, across two runs covering both permission scenarios. |
| 2 | Frame Pipeline | **PASSED** | iPhone / iOS 18.7 / Safari 26.6 / HTTPS. 4/4 required + 2/2 advisory. Evidence committed. |
| 3 | Feature Detection | **NOT_STARTED** | Phase Lock is open. Not yet implemented — §11 is next. |
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

## Phase 2 — PASSED

**Evidence:** `docs/phase2/evidence/phase2-real-device-PASSED-2026-08-21T15-00-01-120Z.json`
plus the device screenshot from the same session.

| | |
| --- | --- |
| Device | iPhone, iOS 18.7, Safari 26.6, `https://hsgwyuki0429-design.github.io` |
| Leg | `REAL_DEVICE` — https, non-local host, `navigator.webdriver` false, 5 touch points |
| Required tests | 4 / 4 PASS, 0 PENDING, 0 FAIL |
| Advisory tests | 2 / 2 PASS |
| Route | `VIDEO_FRAME` selected, 2363/2363 round trips, **0.048 ms** mean on the UI thread |
| Throughput | 2363 frames completed, **0 lost**, 300 paced out, 233 backpressured |
| Continuity | **48.5 s unstressed at 29.65 fps**, longest gap 103 ms, against a 30 s requirement |
| UI thread | 0.07 ms mean, 1 ms p95, 2 ms max, against a 16.7 ms budget |
| Worker | 17.27 ms mean over the whole run; **10.53 ms unstressed** at 720×1280 |
| Provenance | 94 cross-checks, scene σ 15.18, **median Δluma 0.284**, max 0.625 |
| Geometry | source 720×1280 ↔ 1280×720; 0 frames over budget, 0 upscaled, aspect error 0 |
| Ladder | 6 moves, deepest `REDUCED 640x360@20`, max 3 in any 10 s window |
| Error log | empty |

Transitions recorded during the run:

```
phase[2] BLOCKED -> NOT_STARTED   phase 1 PASSED; this phase may now be started
NOT_STARTED -> IMPLEMENTING       PIPELINE screen opened
IMPLEMENTING -> TESTING           PENDING: FRAME-001, FRAME-002, FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-001, FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-003, FRAME-004
TESTING -> TESTING                PENDING: FRAME-004
TESTING -> PASSED                 all 4 required tests PASS on a real device
phase[3] BLOCKED -> NOT_STARTED   phase 2 PASSED; this phase may now be started
```

It was not passed by assertion at any point: the run sat at `TESTING` through four successive
re-evaluations as FRAME-002, then FRAME-001, then FRAME-003, then FRAME-004 each became
evaluable. The same bundle also carries Phase 0 and Phase 1 passing in the same session,
which is what opened the lock — the registry starts fresh on every page load, so Phase 2 was
reachable only because Phase 1 really passed on the device that afternoon.

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it
from the bundle's own results, and for Phase 2 additionally re-derives the provenance claim
— cross-check count, scene variation, agreement against its own scene-scaled tolerance,
worker share, worker scope — and requires every ladder move to carry the measurement it was
made on. Those four gates had been skipping for want of a device bundle; they now run.

### §H.1, answered

The measurement that dictated the architecture has its counterpart:

| Route | Cost on the UI thread |
| --- | --- |
| `VideoFrame` construction (selected) | **0.048 ms** mean over 2363 frames |
| main-thread `drawImage` + `getImageData` (rejected) | 5.81 ms mean, 11 ms p95, 15 ms max |

Two things follow, and the second corrects §H.1.

**The route ladder never needed a fallback.** `VideoFrame` worked on the first attempt and on
all 2363 of them; `IMAGE_BITMAP` and `MAIN_CANVAS` were never reached. Their cost on this
platform is therefore unmeasured, and the bundle says so rather than reporting a zero.

**The readback is not a fixed 13.8 ms.** §H.1 recorded 13.797 ms from Phase 1. The same
operation, in this run, cost **5.81 ms** mean. Both are real measurements of the same
platform; the cost simply varies with what else is in flight. The conclusion §H.1 drew is
unaffected — 5.81 ms is still 17 % of a 33 ms budget before any pixel has been looked at,
against 0.048 ms for the route actually chosen — but the specific number should not be
quoted as a constant. §H.1 has been amended to say so.

### Two things worth knowing before reading these numbers

**WebKit quantises `performance.now()` to 1 ms.** Every duration in this bundle is an
integer. "UI cost 0.07 ms mean" therefore means *zero on almost every frame, 1–2 ms
occasionally* — the pipeline's per-frame UI work is below what the platform's clock can
resolve. Averages over thousands of samples still recover sub-millisecond accuracy because
the underlying values vary; individual readings do not.

**The worker's p95 of 53 ms exceeds §55's 50 ms ceiling, and that is the injected load.**
Unstressed it ran at 10–11 ms per frame at 720×1280 — a third of the 33 ms budget. The
stressed segment deliberately drove it to roughly 6× budget, and those frames are in the
same percentile. The unstressed and stressed segments are measured separately for exactly
this reason.

### The device confirmed the FRAME-004 amendment

The amendment recorded in `docs/phase2/TEST-PLAN.md` — that a step lowering only the target
rate cannot reduce the time one frame takes, so the effect criterion must name the last step
that lowered the *resolution* — was an argument. The device turned it into a measurement:

| Ladder move | Median worker latency, before → after |
| --- | --- |
| `BASIC 960x540@30 → BASIC 960x540@20` (rate only) | 58 ms → **59 ms** |
| `BASIC 960x540@20 → REDUCED 640x360@20` (resolution) | 57 ms → **26 ms** |

The rate-only step left per-frame latency exactly where it was, and the resolution step
halved it. Under the original criterion this run would have been recorded as a failure of a
mechanism that demonstrably worked.

### Where the screenshot and the bundle differ, and why

The device screenshot was taken about three seconds after the JSON was exported, and they do
not match field for field:

| | Bundle | Screenshot |
| --- | --- | --- |
| Tier | `BASIC 960x540@30` | `HIGH 1280x720@30` |
| Ladder moves | 6 | 7 |
| Completed | 2363 | 2434 |
| Delivered / camera fps | 30.05 / 30.04 | 21.85 / 22.46 |
| Cross-checks | 94 | 97 |

Everything in the second column is the first column plus three more seconds of a running
pipeline, including one more upward step. The rate figures fall because they are a rolling
window: at `HIGH` the worker processes 720×1280 rather than 540×960, and the camera itself
delivers 22.46 fps once the page is doing that much more work per frame. The controller
correctly did not degrade — 21.85 against a reachable 22.46 is well inside its floor.

This is recorded rather than smoothed over. Phase 1's screenshot matched its bundle field
for field; this one does not, and claiming otherwise would be precisely the kind of
convenient assertion the whole project is built to refuse. The screenshot corroborates the
bundle's *shape* — pipeline running, worker output visible and tracking the preview, 6 tests
PASS, `PASSED` verdict, 0 lost, 48.5/30 s unstressed, empty error log — not its every digit.

**The screenshot image itself is not committed.** It was supplied in the working session
rather than as a file in the repository, so §60's screenshot evidence is satisfied by review
here as it was for Phases 0 and 1.

## What "implemented" means here

`IMPLEMENTED_PHASES` in `src/core/PhaseRegistry.ts` is the codebase's own statement of what
exists — currently `{0, 1, 2}`. The START SCAN control reads it alongside Phase Lock, and a
control for an unbuilt phase stays disabled with the reason in its label. Nothing in the UI
implies a capability that has not been built.
