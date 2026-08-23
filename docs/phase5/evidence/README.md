# Phase 5 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase5-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004) |
| `phase5-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

No device bundle yet. The automated leg reaches `TESTING` with all four required tests passing,
which is the most a `DESKTOP_DEV` bundle can reach; the registry refuses `PASSED` on anything
but iPhone Safari over HTTPS.

**The verdict is not taken on trust.** `tests/unit/committedEvidence.test.ts` re-derives it from
the bundle's own numbers: the injected-outlier recall has to clear 0.90 *with* the untouched
rejection rate under 0.30 and the paired advantage at 3× or better, the judged frames have to
have had a real baseline behind them, every texture-poor frame has to have declined rather than
verified, both models have to have been fitted with the planar flag following from their two
counts, and no frame may carry a model beside a verdict of none. A hand-edited
`"overallVerdict": "PASSED"` is caught by disagreeing with the results it summarises.

Regenerate the desktop bundle with `npm run test:e2e:phase5`.

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
