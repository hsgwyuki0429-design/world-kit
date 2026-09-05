# Phase 5 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase5-real-device-PASSED-2026-08-23T01-09-36-993Z.json` | `REAL_DEVICE` | **Yes** — 4/4 required, 2/2 advisory |
| `phase5-real-device-PASSED-2026-08-23T01-09-36-993Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase5-real-device-FAILED-2026-08-28T13-29-58-564Z.json` | `REAL_DEVICE` | No — GEO-002 and GEO-003, and both instruments were wrong. See below |
| `phase5-real-device-FAILED-2026-09-05T04-33-18-428Z.json` | `REAL_DEVICE` | No — and not a Phase 5 finding: the phone was running the build from before those corrections. See below |
| `phase5-real-device-FAILED-2026-09-05T04-33-18-428Z.jpg` | `REAL_DEVICE` | The screen from that run |
| `phase5-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase5-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

iPhone / iOS 18.7 / Safari 26.6 over HTTPS, `devEntry: false`, tier `REDUCED 640x360@20`
processing 360×640 in portrait. The transition log shows the phase moving
`TESTING → PASSED → FAILED → PASSED`, failing on **GEO-003** in between: the gate that carries
this phase could fail, and did.

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it from
the bundle's own numbers: the injected-outlier recall has to clear 0.90 *with* the untouched
rejection rate under 0.30 and the paired advantage at 3× or better, the judged frames have to
have had a real baseline behind them, every texture-poor frame has to have declined rather than
verified, both models have to have been fitted with the planar flag following from their two
counts, and no frame may carry a model beside a verdict of none. A hand-edited
`"overallVerdict": "PASSED"` is caught by disagreeing with the results it summarises.

Regenerate the desktop bundle with `npm run test:e2e:phase5`.

## What the device measured

```
1875 verified frames, 1203 judged; 293 re-anchors
median 66 inliers of 71 correspondences (ratio 0.9377), baseline 24.83 px, spread 141.64 px
states: 778 UNVERIFIED, 899 USABLE, 198 GOOD
GEO-003: 271 injected frames — 90.9% of injected outliers rejected vs 6.0% of untouched
         (15.2x advantage), 43 inliers surviving
v3 §16: 1714 frames with both models — 700 planar, 1014 non-planar; median F 68 vs H 57.5
RANSAC 3.45 ms at 71 correspondences, against §H's 6 ms; 62 frames at the iteration cap
integrity: 0 state mismatches, 0 partition faults, 0 models on an unverified frame
```

### Three things this pass does not demonstrate

**1. GEO-003 cleared its bar by 0.9 points.** 90.9 % against the 90 % the plan fixed. It is a
pass and the paired form is decisive — 15.2× the untouched rate, over 271 samples — but the
recall itself has almost no margin, and the automated leg's 100 % is not what a real scene
gives. A run that came in at 89 % would have failed, which is the point; it is also worth
knowing how close the real number sits.

**2. The texture contrast GEO-001 and GEO-002 name was never exercised.** The run recorded
**35** `TEXTURE_RICH` frames against **1140** `TEXTURE_POOR`, and the poor class carried a
median of **68 correspondences** — so GEO-001 was decided on the run-wide judged frames rather
than on a textured scene, and GEO-002's declines came from the baseline floor and from frames
below 20 correspondences rather than from a blank wall. Both tests measured something real and
passed it; neither proved the contrast its title implies. Phase 3's FEAT-001/FEAT-002 pair did
prove it, at 353 features against 61.

**3. The `VIDEO_FRAME` orientation defect is still there.** Abandoned again after 1849 frames
for `rot90`, exactly as in Phase 4; `IMAGE_BITMAP` selected and 5824/5825 successful. The final
alignment reading is `identity` at **5.41× chance**, `measurable: true`. Contained, not fixed.

### A wrong check, caught by this bundle

`committedEvidence.test.ts` asserted that **no `TEXTURE_POOR` frame may report `USABLE` or
`GOOD`**. This bundle has 655 that do, and the assertion was the thing that was wrong.

It read the class as "there is nothing here to verify". The class means
`meanGradient <= TEXTURE_POOR_CEILING`, which is a different claim — and Phase 3's own passing
bundle, committed before Phase 5 existed, records its texture-poor class at a **median of 61
detected features**. This run's poor class sits at 68 correspondences, in agreement. A frame can
be texture-poor and still carry a correspondence set worth verifying, because the class
describes what detection would find *now* while the correspondences come from the anchor tens of
frames back and survive a pan onto a plainer surface. Verifying those is correct; declining
would have been the dishonest answer.

The check now tests what GEO-002's criterion actually states — no verdict on a set below v3
§14's floors, which is a per-frame property guaranteed by the one state function and confirmed
by `stateMismatches: 0`, plus evidence that the decline path ran at all.

### The screen's alignment row is a per-frame reading

The committed screenshot shows `OVERLAY MATCHES VIDEO: NO — flipX fits 1.4× better` in red,
while the bundle's reading is `identity` at 5.41× with `flipX` at 517 against identity's 1127.
Both are true: the row shows the instantaneous frame, and on a real scene it flickers. Nothing
was abandoned on it — `isMisoriented` requires repeated readings with discrimination before it
will drop a route, which is the safeguard added at the end of Phase 4. The row is honest about
the frame it read; it is not a verdict on the run.

## What the automated leg measured

```
577 verified frames, 374 judged; 143 re-anchors
median 141 inliers of 129.5 correspondences (ratio 0.9931), baseline 34.96 px, spread 121.0 px
GEO-003: 61 injected frames — 100% of injected outliers rejected vs 0% of untouched
v3 §16: 454 frames with both models — 391 planar, 63 non-planar; median F 151 vs H 112.5
RANSAC 0.582 ms at 129.5 correspondences
```

The leg generates its own camera feed, because Phase 5's conditions are about *geometry* and a
video file can contain geometry exactly. Three segments: a single-layer pan (a plane, which a
homography explains exactly), a two-layer pan where the near layer moves 3.5× as far in the same
direction (a camera translating past two depths, which no single homography fits), and a smooth
low-gradient field (nothing to verify). Details and the reasoning are in the script's header.

## Two things the leg found, and what changed because of them

### 1. Comparing raw inlier counts hands v3 §16's decision to the degenerate model

GEO-003 came out at **0.816** against a required 0.90 on the first run. The cause reproduces in
pure Node with no camera involved, and it is not the verifier failing to find outliers:

| on a plane with 30% of targets displaced 25 px | homography | fundamental |
| --- | --- | --- |
| inliers admitted | 70 of 100 | 74 – 77 of 100 |
| injected outliers admitted | **0** | 4 – 7 |

The homography had identified every outlier. But on a planar scene the fundamental matrix is not
determined — every `[e]ₓH` fits, for any epipole `e` — so RANSAC had two free parameters that the
correct correspondences did not constrain, and spent them capturing outliers. Under
`hCount >= fCount` that reads as a non-planar scene, so the degenerate model was selected and
those outliers survived as inliers. GEO-004 was simultaneously reporting `non-planar` for frames
that are planar by construction.

`PLANAR_H_ADVANTAGE = 1.0` is withdrawn; `PLANAR_H_SHARE = 0.45` compares `H / (H + F)`, which is
ORB-SLAM's constant for this same choice. **No pass criterion moved** — the amendment is recorded
in place in [`../TEST-PLAN.md`](../TEST-PLAN.md) and the regression is
`tests/unit/verification.test.ts`. After the fix the same leg reads 100%.

### 2. The fixture's first version was tracking its own artefacts

Rebuilding the parallax segment so the depth edges stopped sweeping across the frame collapsed
the population from 77 correspondences to 18. The texture underneath had a mean gradient of
**4.67 and produced zero corners** at detection's level — below `TEXTURE_RICH_FLOOR`, so the
classifier had been calling every frame `AMBIGUOUS` and GEO-001's texture-rich class was empty
throughout.

What had been carrying the first run was the six moving stripe boundaries: strong, trackable
corners belonging to no surface. A two-view geometry measured on them measures the fixture. The
feed now uses Phase 4's texture, whose leg tracked 210 points on this same 640×480 source —
mean gradient 14.0, 467 corners.

Both of these are the same lesson from opposite directions: a number that looks healthy is not
evidence that the thing it names is working, and the only way to tell is an instrument that
cannot see what it is scoring.

## The 2026-08-28 run, which failed two records the verifier had satisfied

Kept because it corrected both instruments, and because neither defect was reachable from the
automated leg — the leg's synthetic feed offers 144 correspondences a frame, and every one of
these findings is about what happens when a real room offers far fewer.

### GEO-002 — a median asked a question about every frame

Reported: *24 texture-poor frame(s) reported USABLE or GOOD on a median of 14 correspondences,
below the 20 needed.* They had not. 570 texture-poor frames, 59 judgeable, **546 UNVERIFIED**
— and they were UNVERIFIED *because* they were under the threshold, which is exactly the
behaviour GEO-002 exists to confirm and exactly what pulled the class median to 14. The 23
USABLE and 1 GOOD each had their own counts, above the floor.

Two things in the same bundle prove it independently: `stateMismatches: 0`, so every state
agreed with the counts beside it; and `deriveVerificationState` returns UNVERIFIED
unconditionally below 20 correspondences or 30 inliers, so those verdicts could not have been
what the reason claimed. The criterion said *every frame* from the day it was written; the
check compared an average. §H.7, one phase before the section that names it.

### GEO-003 — an injection floor that made criterion 4 unmeetable

Reported: median recall **0.871** against 0.90 — while rejecting the injected outliers at
**12.4×** the rate of untouched ones. A verifier that fails to discriminate does not score 12×.

Criterion 1 admitted any frame with `MIN_CORRESPONDENCES` — 20. Criterion 4 requires the
surviving inlier count to still reach 30. Displacing 30 % of a set of `n` leaves at most
`n − round(0.3n)` untouched, which does not reach 30 until **n = 43**. Between 20 and 43 the
record was asking for something arithmetic forbids, and the samples show the cost:

| correspondences | recall | surviving inliers |
| --- | --- | --- |
| 51 | **1.000** | 36 |
| 42 | 0.923 | 26 |
| 36 | 0.727 | 25 |
| 31 | 0.778 | 20 |
| 31 | 0.667 | 19 |

On 31 correspondences with 9 displaced, drawing eight untouched points for the eight-point
minimal sample has probability (22/31)⁸ ≈ **0.06** — RANSAC spends its iteration budget hunting
a clean subset a larger set would hand it at once. A fact about sample size, not about the
verifier. The floor is computed in the code from `MIN_INLIERS` and `OUTLIER_INJECTION_FRACTION`
now; the 0.90 is untouched.

### The 2026-08-23 pass stands under both corrections

Its texture-poor median was 68 correspondences, so the median check never fired and the
per-frame count is 0 either way. Its injections ran on sets of 59 at a recall of 1.00, above
the new floor, and excluding smaller sets can only raise a median recall that was already 90.9 %.
Both changes move the verdict in one direction only, and not this one.

---

## The 2026-09-05 run, which measured a build this repository had already fixed

Kept as the record of a failure mode that is not about geometry at all, and that cost a week.

It failed GEO-002 and GEO-003 again, with GEO-002's reason reading *279 texture-poor frame(s)
reported USABLE or GOOD on a **median** of 0.5 correspondences* and GEO-003's injections running
on sets of **26, 28 and 40**. Both are the pre-correction behaviour: the median comparison was
replaced by a per-frame count on 2026-08-28, and the injection floor of 43 was derived in the
same commit to stop exactly those sets being injected. The bundle also carries neither
`verdictOnThinEvidence` nor `goodOnThinEvidence`, which the corrected suite emits on every
GEO-002 evaluation, so it cannot have been produced by this code.

### The build was never deployed

The Pages workflow runs `npm test` before it builds. The last **successful** deploy was run 19
at `8aacc93` on 2026-08-28 13:18 UTC — the commit *before* the corrections. Runs 20 (`9d4646f`,
the corrections themselves) and 21 (`37b02de`) both failed at that step and never reached the
build, so `https://hsgwyuki0429-design.github.io/world-kit/` kept serving `8aacc93` and every
device run since has been measuring it.

The failing step is one test: `verification.test.ts` → *GEO-003's injection floor* → *is where
the recall actually collapses, measured on the real verifier*. It **timed out at vitest's
5000 ms default**, having taken 6892 ms on the runner. It runs 42 seeded RANSAC fits and half of
them are deliberately on sets too small to converge — that is the measurement, and it cannot be
made cheap. On a developer machine it takes 4726 ms, which is why it passed locally and passed
in its own pull request. The runner is roughly 1.4× slower and that was the entire margin.

`testTimeout` is 30 s now, set in `vitest.config.ts` and again at the test itself, with the
measured figures written at both. `poseStage.test.ts`'s gyroscope test ran 4484 ms on the same
runner — 516 ms from being the next thing to stop the deploy without anyone reading a red X.

### What the run does say about Phase 5, none of it judged by the corrected instruments

- **GEO-002 is 0 by construction.** `deriveVerificationState` returns UNVERIFIED unconditionally
  below 20 correspondences or 30 inliers, and the run recorded `stateMismatches: 0`. The 0.5
  median is 461 declined frames doing precisely what the record exists to confirm.
- **GEO-003 is close, and the floor is the difference.** The 20 injections the bundle retains
  median **0.900** recall and 43.5 surviving inliers; dropping the three below the floor of 43
  leaves the recall at 0.900 and moves the surviving count to 47 — against run-wide figures of
  0.867 and 28, which include every set the floor now excludes. The discrimination was never in
  doubt: 86.7 % of injected outliers rejected against 9.1 % of untouched ones is a **9.6×**
  advantage over 283 samples, where a verifier returning its input scores 0.

Deciding it needs one thing that has not happened yet: a device run against a deployed build
that carries the corrections.
