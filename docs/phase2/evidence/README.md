# Phase 2 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase2-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |

No real-device bundle yet. Phase 2 is `IMPLEMENTING` until one exists; see
`../HOW-TO-RUN-DEVICE-TEST.md`.

Regenerate the desktop bundle with `npm run test:e2e:phase2`.

## What the desktop leg exercises

One browser, one continuous run of about 90 seconds:

1. a clean 30-second window with no injected load (FRAME-001);
2. the 1 Hz provenance cross-check throughout (FRAME-002);
3. a track renegotiation from 1280×720 to 640×480 (FRAME-006);
4. injected load, held long enough for the ladder to walk to its floor
   (FRAME-003, FRAME-004);
5. the load removed, and the controller climbing back.

Two things in it are simulation, and both are recorded rather than hidden.

**The camera is Chromium's synthetic device.** A rolling test pattern, not a camera (§28
permits simulation for development provided it is kept separate from the device leg — the
`leg` field does that).

**Phase 2 was entered through the desktop development override**, recorded as
`phaseContext.devEntry: true`. On this leg Phase 0 correctly stops at `TESTING`, so Phase
Lock never opens and Phase 2 would be unreachable. The override is gated on the leg being
`DESKTOP_DEV` — derived from `navigator.webdriver` and a local origin — so it cannot be
taken on a device, and a `DESKTOP_DEV` bundle cannot pass a phase in any case.
`tests/unit/committedEvidence.test.ts` asserts that no `REAL_DEVICE` Phase 2 bundle has
`devEntry: true`.

One thing in it is *not* simulation, and is worth being clear about: **the injected load is
real work.** It is extra passes over the pyramid the worker genuinely built, and the number
of passes is computed from the measured cost of one pass on the machine running the test.
The latencies the controller reacts to are measurements; the resolutions it selects are read
back from the buffers the worker returned. The stimulus is artificial; nothing downstream
of it is.

## FRAME-006 and FRAME-002 can be excluded, and the leg says when

**FRAME-006** needs the source frame size to change. On the device that is a rotation, which
§H.0 measured renegotiating the track from 1280×720 to 720×1280. A screen-orientation change
does not do that to Chromium's synthetic camera, so the leg asks the track to renegotiate
directly — the same code path, reached another way. If the browser refuses the constraint,
there is nothing to observe and the test is excluded from the gate with that reason printed.

**FRAME-002** needs the scene itself to vary, or agreement between the worker and the camera
means nothing. The synthetic camera is the same slow uniform roll that made Phase 1 exclude
CAM-004, and its luma spread sits close to the floor the check requires — 2.99 and 3.91 have
both been measured in the same run at different points. When it lands below the floor the
test reports `PENDING`, honestly, and the leg excludes it rather than counting a test that
could not conclude as one that did. Feeding in a video chosen to clear the bar would make
the leg green without making it informative. The provenance logic itself is covered by
`tests/unit/phase2Tests.test.ts`; the behaviour needs a real camera.

## What the first green run measured

From `phase2-desktop-chromium.json`, headless Chromium with SwiftShader:

| | |
| --- | --- |
| Route | `VIDEO_FRAME` selected, 1659/1659 round trips, 0.069 ms mean on the UI thread |
| Throughput | 1659 frames completed, **0 lost**, 12 paced out, 125 backpressured |
| Clean window | 36.1 s unstressed, 700 frames at 19.35 fps, longest gap 110.7 ms |
| UI thread | 0.13 ms mean / 0.3 ms p95 / 2.2 ms max against a 16.7 ms budget |
| Worker | 20.36 ms mean, 13.5 ms median, 111.6 ms max (the peak is under injected load) |
| Cross-check | 87 samples, scene σ 3.906, **median Δluma 0.08**, max 0.162, 3.94 ms per sample |
| Geometry | source 1280×720 → 640×480; processing 960×540 → 1280×720 → 640×480 → 480×360 |
| Budget | 0 frames over their tier budget, 0 upscaled, worst aspect error 0 |
| Ladder | 9 moves, deepest `REDUCED 640x360@20`, max 3 in any 10 s window |
| Error log | empty |

The last resolution step took the median worker latency from 64.7 ms to 36.7 ms — the
measured effect FRAME-004 asks for, rather than the fact that a variable changed.

## Three defects this leg found before any device saw the code

Recorded because each was a real bug in the pipeline, not a quirk of the harness.

**The pacer aliased against the camera rate.** Pacing was measured from the last admission
against a fixed minimum interval. With a 30 fps camera and a 33.3 ms interval, roughly half
the frames land a hair early, each is declined, and the next arrives a full interval later —
so the pipeline settled at **12.88 fps while believing it was pacing to 30**. The deadline
now accumulates on an ideal grid instead, and the same run delivers 20 fps from a 20 fps
camera with 3 frames paced out instead of 443.

**The controller degraded for something a ladder step cannot fix.** It compared the
delivered rate against the *target* rate. Chromium's synthetic camera runs at 20 fps, so at
a 30 fps target it read 20 as under-delivery, stepped down, found the worker idling, stepped
back up, and repeated — 13 ladder moves in one run. Delivery is now judged against whichever
of the target and the measured camera rate is lower, and only when the worker is using at
least half its budget: §54's remedies all reduce *processing* cost, so a constraint upstream
of the worker is not this ladder's to solve.

**Recovery had no flap damping.** A load the ladder can partly escape produced a limit
cycle: degrade, discover the vacated tier is now affordable, climb back, overload again —
five moves in one ten-second window. An upward step now waits eight seconds after a
downward one. The leg's injected load was also raised to six times the tier budget, because
descending the whole ladder cuts the work about fourfold while relaxing the budget about
1.5× — a load worth twice the budget where it was applied is affordable two steps down, and
the cycle is the arithmetic, not the controller.

A fourth finding changed a test rather than the code: FRAME-004's effect criterion is now
judged on the last downward step that lowered the *resolution*. See the amendment in
`../TEST-PLAN.md`.

## What every bundle is checked for

`tests/unit/committedEvidence.test.ts` runs on every `npm test` and, for these files as for
Phase 0's and Phase 1's, re-derives the verdict from the bundle's own test results, verifies
the leg against its own recorded signals, and rejects any NaN, infinity, `undefined` or
reference cycle. For Phase 2 it additionally re-derives the provenance claim — cross-check
count, scene variation, agreement against its own scene-scaled tolerance, worker share and
worker scope — and requires every ladder move in a claimed pass to carry the measurement it
was made on.
