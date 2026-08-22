# Phase 3 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase3-real-device-TESTING-2026-08-22T01-57-31-596Z.json` | `REAL_DEVICE` | No — `TESTING`. Kept deliberately: it is the record of a defect only a device could find |
| `phase3-real-device-TESTING-2026-08-22T01-57-31-596Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase3-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase3-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

**There is no Phase 3 pass yet.** Rule 004 stands: only a `REAL_DEVICE` bundle from
iPhone + Safari + HTTPS can pass a phase, and the three required tests that carry this
phase's meaning cannot be decided by the leg below at all. Produce one by following
`../HOW-TO-RUN-DEVICE-TEST.md`. Regenerate the desktop bundle with `npm run test:e2e:phase3`.

## The device run of 2026-08-22, and the defect it found

iPhone / iOS 18.7 / Safari 26.6 over HTTPS. Phases 0, 1 and 2 passed in the same session, so
the lock opened honestly and `devEntry` is `false`. The pipeline ran, preprocessed **2190
frames**, lost none, and held `HIGH 1280×720@30` at 29.55 fps.

**Detection ran on zero of them.** The screen said `DETECTING`. The error log was empty.

| | |
| --- | --- |
| Pipeline | running, 2190 completed, 0 lost, route `VIDEO_FRAME` |
| Detections | **0** |
| Everything downstream | 0 features, 0 contrast samples, 0 refills, no gradient histogram |
| Verdict | `TESTING` — FEAT-001..004 all `PENDING` |

### Why

Phase 3 is reached from a PIPELINE screen whose pipeline is still running — it has to be
still running, because that is how Phase 2 passes. `onStartPhase3` opened with

```ts
if (this.cameraOpening || this.pipeline.isRunning()) return;
```

which reads as "already started" but on this path means "Phase 2 is still going". So
START DETECTION returned immediately, `setTrackingOptions` was never called, the worker was
never asked to detect, and the per-frame tick that refreshes the options was never started.
The pipeline went on preprocessing 2190 frames for a stage that had never been switched on.

The screen showed `DETECTING` because its running flag was `pipeline.isRunning()` too — the
same wrong idea in the other place it mattered. That is a Rule 002 violation in its own
right, and it is what made the defect look like a rendering bug: a lit control over an
engine doing nothing.

### The fix

- Detection's own state (`trackingRequested`) is what the guard tests, not the pipeline's.
- A running pipeline is **adopted** rather than treated as an obstacle: the camera and worker
  stay as they are and only the tracking options change. Starting a pipeline is now the
  fallback for when there is none.
- If `pipeline.start` refuses, the options are taken back rather than left standing for a
  worker that will never see them.
- One `isDetecting()` — both halves, detection asked for *and* a pipeline running — is read
  by the screen, the tests and the evidence, so the three cannot drift apart again.
- Phase 2's injected load is turned off when the pipeline is adopted. Stress inflates worker
  latency, which moves the tier, which sets the resolution Phase 3 detects on; it has no
  business in a measurement of the detector. The handover in that device run happened to
  have stress already off, so it changed nothing there — but it would have on another run.

### Why the automated leg missed it, and does not any more

The leg entered Phase 3 cold, through the development override, with no pipeline running —
a sequence no device ever takes. It now walks the device's path: enter Phase 2, start the
pipeline, **turn stress on**, hand a live and stressed pipeline over to Phase 3, then start
detection. Run against the old code that sequence times out waiting for the first detection,
which is what it should do.

The leg also carries the Rule 002 tripwire in one line: a run that reports `DETECTING` for
the whole hold and has detected nothing fails, whatever the tests say. That is the exact
signature of this defect — 2190 frames preprocessed, 0 detected, button lit.

### What the device run still tells us

Not nothing. The bundle records Phases 0–2 passing on the device in the same session,
`devEntry: false`, `previewPresented: true`, an empty error log, and a pipeline that held the
top tier at 29.55 fps for 91 seconds while Phase 3's screen was open. The Phase 3 evidence
path — bundle shape, verdict derivation, `PENDING` reporting, the download naming itself
`TESTING` rather than a pass — all worked. The phase correctly refused to claim anything.

It is kept for the same reason Phase 1 keeps its `FAILED` bundle: the record of a defect is
evidence too, and deleting it would leave the fix looking like a change with no cause.

## What the desktop leg exercises

One browser, one continuous 30-second detection run against Chromium's synthetic camera,
entered through the development override (`phaseContext.devEntry: true`, gated on the leg
being `DESKTOP_DEV`, exactly as in Phase 2).

| | Measured |
| --- | --- |
| Detections | 565 frames, all at level 1 (480×270) of a 960×540 base |
| Detection cost | **7.49 ms** mean against the §H budget of 8 ms; see below on why this leg does not gate on it |
| Level 0 calibration | 960×540 would have cost **83.7 ms** for 114 features |
| Scene | 565 frames `TEXTURE_POOR` (median gradient ~0.7), 0 rich, 0 ambiguous |
| Population | median 45 features; `TRACKING_DEGRADED` throughout |
| Contrast | 67 samples, **97.2 % above chance** (50 % would be a detector unrelated to the image) |
| Grid | 67 comparisons taken, **0 binding** — no cell ever came near its quota of 17 |
| Refills | 200, all `EMERGENCY`, 128 of them finding the frame exhausted |
| Quota breaches | 0 |
| State mismatches | 0 (Rule 002) |
| Metadata | 8 records sampled; `forwardBackwardError` and `reprojectionError` `null` throughout |
| Error log | empty |

Verdict: `TESTING` — `PENDING: FEAT-001, FEAT-002, FEAT-003`. The leg exits 0 because the
tests it cannot decide are excluded from its gate with their reasons printed, not because
they passed.

### The one number here that is not free

**95.9 % above chance.** The rest of the table could be produced by a loop that never looked
at a pixel: a count, a cost, a state name. The rank statistic cannot — it is the probability
that a position the detector chose out-textures a position drawn at random from the same
frame, and a detector emitting coordinates unrelated to the image scores 0.5 by construction,
whatever the scene. On a rolling gradient whose median gradient magnitude is under 1 — barely
above sensor noise — the detector still picked structure over chance 24 times out of 25.

FEAT-001 is excluded from this leg regardless, because that gradient never reaches the
texture-rich floor. The statistic is reported anyway: it is the one piece of provenance the
synthetic camera can still supply.

## Three tests this leg cannot decide, and why

The synthetic camera is a rolling gradient. It is neither a textured wall nor a blank one,
and three of Phase 3's four required tests are defined against those two scenes. Where the
run produced too few frames of a class, the test reports `PENDING` honestly and the leg
excludes it with that reason printed, rather than counting an undecided test as decided.
Feeding in a video chosen to clear the bars would make the leg green without making it
informative.

| Test | Why the leg cannot decide it |
| --- | --- |
| **FEAT-001** | 0 texture-rich frames of the 15 required. The scene's median gradient is 0.689 against a rich floor of 8.0. |
| **FEAT-002** | The comparison needs *both* classes; this run had 565 poor frames and 0 rich ones. A run with only blank frames cannot decide it any more than a run with neither. |
| **FEAT-003** | 0 of 67 comparisons had the quota bind. With 45 features across 48 cells the gridded and ungridded selections are byte-identical, and comparing them says nothing about the grid. |

FEAT-004 *is* decidable here, and passes for a reason worth stating: the synthetic camera is
so sparse that the population sat below the emergency threshold for the whole run, so the
refill ladder ran 200 times and 128 of those found nothing left to add. That is a scene with
no corners in it, not a mechanism that failed — the relaxed pass genuinely exhausted the
frame.

### And a fourth, for a different reason

**FEAT-005 is excluded too, whichever way it lands.** It read `FAIL` at 9.36 ms and `PASS` at
7.49 ms on consecutive runs of identical code. Not because either measurement is wrong — both
are right, and both stay printed and stay in the bundle
— but because §H's 8 ms is a budget for the iPhone's tracking worker, and this is headless
Chromium with SwiftShader on a shared CPU. Consecutive runs of identical code measured
**7.49 ms, 7.98 ms and 9.36 ms**, straddling the threshold on machine contention and on which part of
the synthetic camera's cycle the run happened to catch. A number that flips a verdict without
the code changing is not deciding anything about the code.

The line is the test plan's own, not one drawn after seeing a result: FEAT-005 is advisory
because it is "a property of the device rather than of the code", where FEAT-006 is advisory
because it is a property of the code. FEAT-006 gates this leg. FEAT-005 does not, and the
device run decides it.

What replaces it is a named tripwire with its own number: **24 ms**, which the leg checks and
prints on every run. That is not a relaxed budget — it sits between the correct
configuration's observed spread (7.5–9.4 ms) and the misconfiguration it exists to catch,
since detecting on level 0 by mistake measured 45–84 ms on this same machine. It catches a
regression in *what the code does*; it makes no claim about what the device affords.

Phase 2's leg still gates on both its advisory tests, because neither has failed and
rewriting a passed phase's harness without cause is its own kind of dishonesty. If FRAME-005
— also a device property — ever flakes the same way, the same distinction applies to it.

## Three more defects, found before any device saw the code

**The detector reported corners in the wrong place.** A checkerboard corner at (10, 10) came
back as (7, 7), and `localVariance` at the chosen positions was **0** — features landing on
flat regions. The cause is that a single box-filter pass makes the λ₂ response a flat
plateau across the whole corner neighbourhood, and non-maximum suppression keeps whichever
point the scan reached first, which is the top-left edge of the plateau every time. Two box
passes (a triangular kernel) give the response a single peak. After the fix the peak sits at
(9, 9)–(10, 10), variance at the chosen positions is 9011, and over 95 % of features land on
structure. A positional bias of three pixels would have been invisible in Phase 3's own
counts and fatal to Phase 5's geometry.

**The contrast statistic measured the scene, not the detector.** The check originally gated
on the ratio of mean corner strength at detected positions to that at random ones, at ≥ 4.0.
A working detector scored **1.87** on a checkerboard — because on a dense pattern the random
control is itself highly textured. A brick wall or a carpet would have failed FEAT-001 with
nothing wrong. Replaced by the rank statistic, whose chance value is exactly 0.5 whatever the
scene. Recorded as an amendment in `../TEST-PLAN.md`; it is a change of statistic, not a
relaxation — the fabricated-lattice control still fails, and now fails on scenes where the
ratio would have passed it.

**FEAT-003 failed a selector that was working.** The first run of this leg reported 34
features across 48 cells, quota 17, and an identical 22 % largest-cell share gridded and
ungridded — recorded as `FAIL`. The quota never bound, so the two selections were the same
selection. Comparisons are now counted only when the ungridded control actually overfilled a
cell; sparse scenes report `PENDING`. Also an amendment, and also a narrowing: a binding
frame where the grid fails to spread still fails, and a run that never produced a binding
frame can no longer pass by accident either.

## One measurement that settled a design choice

`../TEST-PLAN.md` chose to detect on pyramid level 1 rather than level 0, arguing from the
§H budget of 8 ms for Shi-Tomasi. The leg measures the alternative on every run rather than
leaving the argument unchecked:

| Level | Size | Cost | Features found |
| --- | --- | --- | --- |
| 1 (selected) | 480×270 | **7.49 ms** mean over 565 detections | median 45 |
| 0 (calibration) | 960×540 | **83.7 ms** | 114 |

Level 0 costs over 10× the budget for about 2.5× the features on this machine. The
calibration figure moves a lot between runs (45–84 ms measured) because it is a single
detection on a shared CPU; the ratio is the durable part, not the millisecond. The device run will
report its own pair, and that is the number that matters — but the shape of the trade is not
in doubt.

## What every bundle is checked for

`tests/unit/committedEvidence.test.ts` runs on every `npm test` and, for this file as for
Phases 0–2, re-derives the verdict from the bundle's own test results using the same
`PhaseRegistry.evaluate` the app uses, verifies the leg against its own recorded signals, and
rejects any NaN, infinity, `undefined` or reference cycle. For Phase 3 it additionally
re-checks the phase's own invariants: the contrast statistic against its chance value of 0.5,
the population collapsing when the measured texture did, no cell over quota, no state/count
mismatch, and `forwardBackwardError` / `reprojectionError` still `null` on every sampled
record. Four of those gates skip for want of a device bundle and will run once one is
committed — the same arrangement Phase 2 had before its pass.
