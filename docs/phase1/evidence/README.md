# Phase 1 evidence

| File | Leg | Scenario | Passes the phase? |
| --- | --- | --- | --- |
| `phase1-desktop-chromium-granted.json` | `DESKTOP_DEV` | granted, synthetic camera | No (Rule 004) |
| `phase1-desktop-chromium-denied.json` | `DESKTOP_DEV` | denied | No (Rule 004) |
| `phase1-real-device-*.json` | `REAL_DEVICE` | granted **and** denied | Yes — **not yet produced** |

Regenerate the desktop pair with `npm run test:e2e:phase1`. Produce the device pair by
following `../HOW-TO-RUN-DEVICE-TEST.md`.

## Reading the desktop pair

Two browsers, because the two permission scenarios cannot occur in one session. Both
bundles carry `phaseContext` with the constraint-ladder attempts, the frame statistics and
the scenario ledger.

The denial is induced by setting the origin's permission set to empty
(`context.grantPermissions([], { origin })`), so the request is refused without a prompt.
An earlier version used the `--deny-permission-prompts` command-line flag, which produced
`NotAllowedError` on one Chromium build and `NotSupportedError` on another — a difference
that failed CI. The permission-set route goes through CDP rather than a flag and is stable
across builds. If a browser nonetheless refuses the camera in some way other than a user
denial, the harness says so and excludes CAM-002 from its gate rather than pretending
otherwise: mapping `NotSupportedError` to "denied" would make the product report a policy
block as a user decision, which sends the user to a permission screen with nothing to
change.

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
