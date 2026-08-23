# Phase 5 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase5-real-device-PASSED-2026-08-23T01-09-36-993Z.json` | `REAL_DEVICE` | **Yes** — 4/4 required, 2/2 advisory |
| `phase5-real-device-PASSED-2026-08-23T01-09-36-993Z.jpg` | `REAL_DEVICE` | The screen from that run |
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
