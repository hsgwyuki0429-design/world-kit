# Phase 4 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase4-real-device-PASSED-2026-08-22T14-47-06-539Z.json` | `REAL_DEVICE` | **Yes** — 5/5 required, 2/2 advisory |
| `phase4-real-device-PASSED-2026-08-22T14-47-06-539Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase4-real-device-FAILED-2026-08-28T12-55-51-029Z.json` | `REAL_DEVICE` | No — FLOW-005, and the instrument was wrong. See below |
| `phase4-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase4-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it
from the bundle's own numbers: FLOW-002's agreement has to hold with the tracker having moved
at all and the image demonstrably moving, survival has to fall under fast motion with §13
doing the rejecting, every occlusion has to reach `LOST` and recover with nothing claiming a
good round trip through the dark, no record may carry an error term it could not have
measured, and no frame may have reached §33's `GOOD`, which needs Phases 5 and 6. A
hand-edited `"overallVerdict": "PASSED"` is caught by disagreeing with the results it
summarises.

Regenerate the desktop bundle with `npm run test:e2e:phase4`.

## The 2026-08-28 run, which failed a test the tracker had passed

Kept because it is the measurement that corrected FLOW-005's accounting, and because the shape
of it is worth recognising again: **every criterion the record states was met, and the record
said `FAIL`.**

The lens was covered for **229 frames**. `msToLost: 0` — the state went `LOST` on the first dark
frame. `survivedWithGoodFb: 0` — nothing claimed to have tracked across the dark. And the
tracker was tracking again 207 ms after the image came back. The reported reason was *the state
did not leave `LOST` after an occlusion of 229 frames ended*.

Two things were true at once, and on a phone both usually are. The first frame back was still
`LOST`, because 229 dark frames leave nothing to track and detection needs a few frames to
refill. And one frame later the classifier reported `OCCLUDED` again — correctly: *a wholesale
change no shift explains* is what this phase means by occlusion, and a finger lifting off the
glass is exactly that.

The session held **one** pending recovery. Ending that one-frame episode overwrote it, so the
229-frame episode could never be credited, and its recovery was filed against the flicker —
which is the `recoveredAfterMs: 207` sitting on a one-frame episode in this bundle. Recovery is
now recorded per episode, each from the end of its own darkness. `docs/phase4/TEST-PLAN.md`
A7 records the amendment; `tests/unit/flowTracker.test.ts` replays the sequence and shows the
verdict flipping on the accounting alone, with the flicker-free run passing either way.

**The 2026-08-22 pass is untouched.** Its three episodes were already `recovered: true` — its
occlusions were followed by clear frames and it recovered in 35–42 ms — and the new accounting
only ever credits more episodes, never fewer.

## The device run of 2026-08-22, and what it settled

Full account in [`../../PHASE-STATUS.md`](../../PHASE-STATUS.md). Two things belong here.

### The Phase 3 orientation defect reproduced, and the probe caught it

```
routeRejectedFor: "rot90"
VIDEO_FRAME   5265/5265 successes — abandoned
IMAGE_BITMAP  4772/4773 successes — selected
```

`VIDEO_FRAME` carries the sensor's orientation rather than what the element displays, and on
this device it produced a buffer turned 90° against the video for 5265 frames. The alignment
probe measured it three readings running and the app abandoned the route. After the fallback:
`best: identity` at **10.1× chance** — identity 369.9 against rot90's 12.5.

The report was real. The mechanism §H.7 called for works. The defect is *contained*, not
fixed: the platform still produces a misoriented buffer on that route, and what the app does
is decline to use it and say so in the error log.

The run therefore spans a route change. FLOW-002 is unaffected — the tracker and the
independent search read the same buffer, so a shared rotation cancels in their agreement — but
Phase 6 derives intrinsics from the frame geometry, and it needs to know this run used two
routes.

### The population never reached §11's minimum, and the bundle could not say why

Median 74 tracked points on static frames, 41 on slow ones, against §11's minimum of 200. The
state read `DEGRADED` on 1211 of 2717 frames, which made FLOW-001's "never LOST while the
count is above 80" vacuous and FLOW-004's "reaches DEGRADED when the count falls" already true
before the fast motion began. Both criteria hold; neither was exercised.

**Why could not be answered from the bundle**, because Phase 4 routes its results to
`FlowSession` rather than `FeaturePopulation` and carried no detection statistics at all. Fixed:
the flow record now reports what §11's refill offered each frame and why each point was
declined, split into *already being tracked* — the healthy case — and *outside the solver's
reach*. On the automated leg it reads **353 offered — 319 already tracked, 14 out of reach, 20
admitted**, which describes a tracker holding what it has. The next device run answers it
directly.

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
