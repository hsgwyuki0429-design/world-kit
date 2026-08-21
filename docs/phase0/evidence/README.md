# Phase 0 evidence

## Files

| File | Leg | Can it pass a phase? |
| --- | --- | --- |
| `phase0-desktop-chromium.json` | `DESKTOP_DEV` | **No** (Rule 004) |
| `phase0-desktop-chromium.png` | `DESKTOP_DEV` | — |
| `phase0-desktop-chromium.summary.txt` | `DESKTOP_DEV` | — |
| `phase0-real-device-*.json` | `REAL_DEVICE` | Yes — not yet produced |

Regenerate the desktop leg with `npm run test:e2e`. Produce the real-device leg by
following `../HOW-TO-RUN-DEVICE-TEST.md`.

## Reading the desktop bundle

`overallVerdict` is `TESTING`, with the reason spelling out that all required tests passed
but the leg was `DESKTOP_DEV`. That is the intended outcome, and it is produced by the app,
not written by hand: `determineLeg()` sees `navigator.webdriver === true` and a localhost
origin and refuses to classify the run as a device.

Two results in that bundle are worth understanding, because both look like failures and
neither is:

**`CAP-0004` / `CAP-0005` report `UNAVAILABLE`.** Headless Chromium fires exactly one
`devicemotion` event whose `acceleration`, `accelerationIncludingGravity` and `rotationRate`
are all null. The probe counts events *carrying finite values*, sees zero, and reports the
sensor as unavailable. An implementation that checked `'DeviceMotionEvent' in window`, or
that counted raw events, would have reported a working IMU on a machine that has none —
which is the `Fake Tracking State` failure in §80, reached by accident rather than by
intent. The test passes because the capability was correctly *determined*, and the recorded
detail says exactly what was seen: `1 events arrived but only 0 carried finite values`.

**`CAP-0013` FAILs.** There is no camera in the container, so `enumerateDevices()` returns
no `videoinput`. It is advisory, so it does not fail the phase — see the plan amendment in
`../TEST-PLAN.md` for why that criterion is advisory rather than required.

## What a bundle contains (§60)

- `leg` and `legDetermination` — every signal behind the leg classification, including
  which one is an inference rather than a measurement.
- `device` — UA, screen, DPR, `hardwareConcurrency`, `maxTouchPoints`, timezone.
- `capabilityMatrix` — every record with its `state`, its `method`, a precise `detail`
  string, the measured data behind it, and the probe's duration in milliseconds.
- `testResults` — each in §61 format: the declared input, expectation, pass criteria and
  failure condition, plus what was observed and why the verdict came out that way.
- `stateTransitions` — every phase-state change with a timestamp and a reason.
- `errorLog` / `fullLog` — structured entries; error entries carry a `recovery` field.

The bundle is validated before it is offered for download. If it contains a `NaN`, an
infinity, an `undefined` or a genuine reference cycle, the app forces Phase 0 to `FAILED`
and records why — a verdict is not allowed to rest on a corrupt evidence file.
