# Phase 0 evidence

## Files

| File | Leg | Verdict | Passes the phase? |
| --- | --- | --- | --- |
| `phase0-real-device-PASSED-2026-08-21T08-05-07-305Z.json` | `REAL_DEVICE` | **PASSED** | **Yes — this is the Phase 0 pass** |
| `phase0-desktop-chromium.json` | `DESKTOP_DEV` | TESTING | No (Rule 004) |
| `phase0-desktop-chromium.png` | `DESKTOP_DEV` | — | — |
| `phase0-desktop-chromium.summary.txt` | `DESKTOP_DEV` | — | — |

Regenerate the desktop leg with `npm run test:e2e`. Reproduce the device leg by following
`../HOW-TO-RUN-DEVICE-TEST.md`.

## The Phase 0 pass

iPhone / iOS 18.7 / Safari 26.6, served over HTTPS from GitHub Pages. 11/11 required tests
PASS, 2/2 advisory PASS, 31 capability records, 0 integrity issues, empty error log, 51 ms
of non-gesture probing against a 1500 ms budget.

Its own transition history shows the phase was not passed by assertion: it sat at `TESTING`
with CAP-0004 and CAP-0005 `PENDING`, and reached `PASSED` only once the sensors delivered
data — 119 `devicemotion` events in 2000 ms at 59.96 Hz, all carrying finite values across
`acceleration`, `accelerationIncludingGravity`, `rotationRate` and `interval`.

The bundle is machine-checked, not merely filed. `tests/unit/committedEvidence.test.ts`
re-derives the verdict from the bundle's own test results with the same
`PhaseRegistry.evaluate` the app uses, so `overallVerdict` is never an input to deciding
whether the phase passed, and re-asserts the §80 invariants on every `npm test`.

### An earlier bundle from the same session is not committed

A first export, taken before the sensor-probe tap, read `TESTING` with CAP-0004/0005
`PENDING`. It was briefly committed and then removed once the passing bundle arrived, to
avoid two similar-looking device files where only one is the pass. What it left behind are
two fixes: the verdict is now part of the filename, and the evidence card warns (and the
download button names the verdict) while any required test is `PENDING`.

### Two defects found by reading the passing bundle

Both were in the evidence path, so they would have affected every later phase:

1. `motion.deviceOrientation` did not record which of alpha/beta/gamma carried data, while
   the motion record did — visible as `"fields": null` in CAP-0005's metrics. Phase 7 needs
   that distinction. Fixed.
2. `stateTransitions` was merged from the registry and the logger without sorting, so the
   bundle held a duplicate `IMPLEMENTING -> TESTING` entry positioned *after*
   `TESTING -> PASSED`. The registry is now the sole authority for phase transitions and
   the list is sorted chronologically. Fixed, with a regression test.

Neither changes a probe result or a pass criterion, and the committed bundle still
re-derives to `PASSED` under the current code.

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
