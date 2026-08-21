# Phase 1 evidence

| File | Leg | Scenario | Passes the phase? |
| --- | --- | --- | --- |
| `phase1-desktop-chromium-granted.json` | `DESKTOP_DEV` | granted, synthetic camera | No (Rule 004) |
| `phase1-desktop-chromium-denied.json` | `DESKTOP_DEV` | denied | No (Rule 004) |
| `phase1-real-device-TESTING-2026-08-21T09-50-49-632Z.json` | `REAL_DEVICE` | denied | Valid; CAM-002 `observedDirectly` |
| `phase1-real-device-FAILED-2026-08-21T09-48-59-133Z.json` | `REAL_DEVICE` | granted | **No** — a harness bug, see below |

Regenerate the desktop pair with `npm run test:e2e:phase1`. Produce the device pair by
following `../HOW-TO-RUN-DEVICE-TEST.md`.

## Reading the desktop pair

Two browsers, because the two permission scenarios cannot occur in one session. Both
bundles carry `phaseContext` with the constraint-ladder attempts, the frame statistics and
the scenario ledger.

### How the denial is induced, and why it takes two attempts

Which `DOMException` a Chromium build raises for a refused camera permission is not stable.
The `--deny-permission-prompts` flag produced `NotAllowedError` in the dev container and
`NotSupportedError` on the GitHub runner; setting the origin's permission set to empty
(`context.grantPermissions([], { origin })`) works in the dev container and still does not
produce a user denial on the runner.

So the harness tries the browser first and falls back:

1. **Browser refusal.** Empty permission set for the origin, no prompt. When this yields
   `NotAllowedError`, CAM-002 is exercised against the real platform and `deniedVia` reads
   `browser permission refusal`.
2. **Injected rejection.** If the browser refused in some other way, `getUserMedia` is
   replaced with one that rejects with a genuine `NotAllowedError`, and the app's own path
   runs end to end from there. `deniedVia` records this, along with what the browser
   actually produced, and the failure message in the bundle says the rejection was injected.

The native attempt comes first on purpose: it is what surfaced the `NotSupportedError`
difference in the first place, and going straight to injection would have hidden it.

`NotSupportedError` was **not** remapped to `CAMERA_PERMISSION_DENIED` to make this easier.
It means the request was refused by policy, not by a person; reporting it as a denial would
send the user to a permission screen with nothing on it to change. It is mapped to
`CAMERA_UNAVAILABLE` with a recovery that names the real cause.

Two things in them are simulation, and both are recorded rather than hidden:

**The camera is Chromium's synthetic device.** It is a moving test pattern, not a camera
(§28 permits simulation for development provided it is kept separate from the device leg —
here the leg field does that). Its `facingMode` reads `unreported` and rung 1 of the
constraint ladder is refused, so the run also happens to demonstrate the §9 fallback.

**Phase 1 was entered through the desktop development override**, recorded as
`phaseContext.devEntry: true`. On this leg Phase 0 correctly stops at `TESTING`, so Phase
Lock never opens and Phase 1 would be unreachable. The override is gated on the leg being
`DESKTOP_DEV` — derived from `navigator.webdriver` and a local origin — so it cannot be
taken on a device, and a `DESKTOP_DEV` bundle cannot pass a phase in any case.
`tests/unit/committedEvidence.test.ts` asserts that no `REAL_DEVICE` Phase 1 bundle has
`devEntry: true`.

## CAM-004 is not decided by the desktop leg

The synthetic source sits close to CAM-004's floor of 8.0 and crosses it unpredictably.
Two consecutive runs of the same harness measured:

| run | MAD min | median | max | verdict |
| --- | --- | --- | --- | --- |
| 1 | 4.48 | 5.48 | **6.79** | FAIL |
| 2 | 4.50 | 5.49 | **9.70** | PASS |

So the leg's CAM-004 verdict is not meaningful in either direction, and the harness excludes
it from the pass/fail gate rather than letting it flap. The alternative — feeding in a video
file chosen to clear the bar — would turn the leg green without making it informative.

> An earlier version of this file claimed the synthetic source "measures 6.79 and correctly
> fails". That was written from a single run and the next run contradicted it. Corrected
> here rather than left standing: a measurement quoted from one sample is a guess about the
> distribution.

Why it straddles: the source is a rolling gradient with a changing frame counter, and the
harness rotates the emulated device mid-run. Neither is camera movement, and both produce
deltas near the threshold. Real camera motion reaches 20–60, far above it; a frozen frame
sits near zero, far below. The floor discriminates cleanly at both ends — this source just
happens to land in the middle.

The threshold logic is covered by `tests/unit/phase1Tests.test.ts`; the behaviour needs a
real camera.

## What every bundle is checked for

`tests/unit/committedEvidence.test.ts` runs on every `npm test` and, for these files as for
Phase 0's, re-derives the verdict from the bundle's own test results, verifies the leg
against its own recorded signals, and rejects any NaN, infinity, `undefined` or reference
cycle.


## The first two device runs

**Denied run — valid.** `NotAllowedError` → `CAMERA_PERMISSION_DENIED`, `stream=none`,
`preview=false`, recovery recorded, `errorLog` carrying the failure with its recovery
action. CAM-002 PASS with `observedDirectly: true`. This bundle stands as the denied half
of Phase 1's evidence.

**Granted run — reported FAILED, and was wrong.** What the run actually measured:

| | |
| --- | --- |
| Stream | rung 1, `facingMode: environment`, 1280×720 @ 30 fps, `背面デュアル広角カメラ`, opened in 746 ms |
| Capture | 1213 frames over 40.6 s at 29.83 fps, longest gap 151 ms |
| Image change | 152 samples; MAD min 12.19 / median 45.31 / **max 75.18**; luma 118–186 |
| Rotation | 2 changes, next frame 40 ms later, 941 frames after |

CAM-003 and CAM-004 passed on that. CAM-001 and CAM-005 failed with
"the video track is not live; the video element reports 0x0" and "the video track ended
across the rotation" — the second directly contradicted by its own metric of 941 frames
after the rotation.

The cause was the tester pressing STOP CAMERA before exporting. `camera.close()` nulls the
track and `srcObject = null` leaves the detached element at 0×0, and both evaluators were
reading the state at the moment of judging rather than what had been demonstrated. CAM-003
already had this right — it grew `cameraEverOpened` and `cameraEndedUnexpectedly` for
exactly this reason — and the same treatment simply had not been applied to its two
siblings.

Fixed, with regression tests that reproduce the sequence. The bundle is kept because it is
the record of a real defect and of a camera session that worked.

### It also validated the CAM-004 correction

Real camera motion measured median 45.31 and peak 75.18 — a ratio of **1.66**. The
`maxMad >= 4 × medianMad` gate, removed before any device run on the argument that it
would reject a continuously panned camera, would have failed this capture. The argument was
right and the device proved it.

### One measurement for Phase 2

`sampleCostMsMean` was **13.797 ms** on the device, against 0.4 ms in headless Chromium, for
a `drawImage` + `getImageData` producing 3 kB. That is a GPU→CPU readback stall, not pixel
work. Phase 1 samples at 4 Hz and can afford it; Phase 2 at 30 Hz cannot. Recorded in
§H.1 of the implementation plan.
