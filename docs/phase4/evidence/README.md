# Phase 4 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase4-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase4-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

**There is no Phase 4 pass, and there cannot be one from what is committed here.** Rule 004
stands: only a `REAL_DEVICE` bundle from iPhone + Safari + HTTPS can pass a phase. Produce one
by following [`../HOW-TO-RUN-DEVICE-TEST.md`](../HOW-TO-RUN-DEVICE-TEST.md). Regenerate the
desktop bundle with `npm run test:e2e:phase4`.

## What the automated leg establishes, and what it cannot

Phase 3's leg had to exclude the three tests that carry its meaning, because Chromium's fake
camera is a rolling gradient. Phase 4's conditions are about **motion**, and motion is
something a video file can contain exactly — so this leg generates its own feed:

| Segment | Frames | What it produces |
| --- | --- | --- |
| static | 24 | `STATIC` frames — FLOW-001 |
| slow pan, 4 px/frame | 16 + 16 | `SLOW` frames and the paired cross-checks — FLOW-002 |
| fast sweep, 22 px/frame | 8 | `FAST` frames — FLOW-004 |
| black | 20 | `OCCLUDED` frames — FLOW-005 |

Every frame is classified from the pixels by the same code the device runs, not from the
segment it came from. The harness never tells the tracker what to expect.

**The gate this leg exists for is FLOW-002's**, and the generated feed arms it:

> over frames where the image demonstrably moved, does the tracker's displacement agree with an
> independent measurement of the scene's motion?

A tracker that returned its input would report 0 px while the independent search reported the
real motion, and the leg fails with that sentence. `tests/unit/flowTracker.test.ts` shows the
same thing in Node against the same `FlowStage`; this shows it through the real
`video → VideoFrame → worker → pyramid` path, which §H.7 records as the one place unit tests
cannot reach.

Representative run (2026-08-22, headless Chromium, SwiftShader):

| | Measured |
| --- | --- |
| Flow frames | 447, of which 319 had a predecessor to track from |
| Population over the run | 78 217 tracked, 16 243 redetected — counted separately throughout |
| Motion classes | 133 static, 135 slow, 41 fast, 10 occluded, 2 indeterminate |
| **FLOW-002 cross-check** | **309 pairs: tracker 6 px vs image 4 px, median disagreement 0 px, 93.9 % agreeing** |
| §13 bands | 77 232 acceptable, 985 reduced, 8 115 rejected |
| §33 | 279 TRACKING, 47 DEGRADED, 120 LOST, 1 READY — **0 state mismatches** |
| Occlusions | 11 episodes, `LOST` reached in 0–112 ms, every one recovered |
| Longest track | 35 frames |
| Geometry changes | 3 (the tier ladder stepping under the LK load) |
| LK solve | 22.5 ms at 165 points, 21×21, 3 levels, 30 iterations, ε 0.01 |
| Scene-shift search | 2.9 ms |

### Excluded from the gate, with the reason each time

- **FLOW-003** — headless Chromium delivers no `devicemotion` events. The test is defined
  against the device's own rotation as a second independent instrument, so without it there is
  no way to know a frame was rotating rather than translating. `PENDING`, not judged.
- **FLOW-006** — 22.5 ms is measured on a shared CPU under SwiftShader against a budget
  written for the iPhone's tracking worker. Its verdict is printed and a separately named
  90 ms configuration tripwire gates instead. Same distinction §H.4 draws, same one Phase 3's
  leg made for FEAT-005.

### And one the leg reports without reading: the overlay alignment probe

The probe names `rot90` or `rot270` as the best-fitting transform on this feed, with
`best/random` at **1.03** and `identity/random` at **0.83**. All seven transforms score within
a few per cent of one another.

**That is not a finding, it is the absence of one.** The generated feed is periodic in x by
construction — it has to be, so the pan loops seamlessly — and densely textured, so every
transform lands on corner-like pixels and the probe has no discrimination at all. Reading a
winner out of it would be the mistake FEAT-001's contrast *ratio* taught in Phase 3.

`scripts/run-e2e-phase3-alignment.mjs` is the leg that decides orientation, with a fixture
built for it: three bright blocks and one deliberately empty quadrant, so no rotation or
reflection maps the set onto itself. It scores identity at **17.7× chance** and puts every
rotation and reflection far below.

The probe itself changed as a result, and the change protects the device rather than the leg:
`isMisoriented` now also requires the winning transform to beat chance by the margin identity
is required to. Without that, pointing the phone at a brick wall or a tiled floor could abandon
a working acquisition route on noise.

## Defects this leg found before any device saw the code

Three, each recorded as an amendment in [`../TEST-PLAN.md`](../TEST-PLAN.md):

1. **A tier step inside an occlusion made a 14-frame covered lens never reach `LOST`** (A5).
   Clearing `everTracked` on a geometry change put §33's state back to `READY` mid-run and
   restarted the consecutive-failure counter. FLOW-005 caught it and described it exactly as it
   looked from outside: "tracking was maintained through a covered lens".
2. **Detection handed the tracker points its 21×21 window could not cover** (A6) — a one-pixel
   band at the frame border, 15 % of the population, which made FLOW-001's survival read
   **84.6 % on a perfectly static image the tracker had followed exactly**.
3. **A covered lens put `Infinity` into the evidence.** The alignment probe divided by a local
   variance that is legitimately zero on a black frame, so every Phase 4 bundle carried a
   non-finite number and an `EvidenceRecorder` integrity error on a run where nothing was
   wrong. Both ratios are now floored at one intensity level of variance and a `measurable`
   flag separates "no texture to read" from "the points are on nothing".

And one measurement that is about this implementation rather than the platform: the first
version of the solver cost **65 ms per frame**, because it called a shared bilinear helper 441
times per iteration and recomputed the interpolation weights each time. The whole window shares
one sub-pixel offset, so the weights are computed once and the loop walks consecutive indices.
**22.5 ms** at identical results. Reporting the first number as what the device affords would
have been reporting an inefficiency as a platform fact.
