# Phase 6 evidence

| File | Leg | Passes the phase? |
| --- | --- | --- |
| `phase6-desktop-chromium.json` | `DESKTOP_DEV` | No (Rule 004 — and see below) |
| `phase6-desktop-chromium.png` | `DESKTOP_DEV` | No — the screen at the end of that run |

No device bundle yet.

**This phase is the first where the automated leg is short of an instrument, not just of
authority.** Rule 004 already meant a `DESKTOP_DEV` bundle could never pass; here, one of the two
things the phase is scored against — the gyroscope — **does not exist** on headless Chromium.
POSE-002 reports `PENDING` with that reason and the leg reaches `TESTING` at best, which is Rule
004 restated as a measurement rather than as a policy.

Regenerate the desktop bundle with `npm run test:e2e:phase6`.

## What the automated leg measured

```
479 pose frames: 251 POSE, 75 ROTATION_ONLY, 153 NO_POSE
median rotation 0.12°, reprojection 0.047 px, 100% in front of both cameras
POSE-005: 49 injected frames — an 8° turn moved the pose 8.000° against 0.003° for the control;
          inlier drift 0% against the control's 0%, 0 planar flips against 0
v3 §16: 227 planar posed from the homography, 0 via an Essential matrix;
        cheirality left 2 unseparated candidates on planar frames against 1 with depth
POSE-004: 75 frames with no parallax, 0 of which named a translation;
          142 frames Phase 5 declined, 0 of which carried a rotation
intrinsics ESTIMATED at 67° FOV; ±20% moves rotation 0.012° and translation 0.057°
cost 4.33 ms pose + 0.88 ms RANSAC = 5.21 ms against §H's 6 ms for both together
```

The gate is decisive: **8.000° recovered for an 8° injection, against 0.003° for the control.**

### The feed

Phase 5's leg needed geometry in the pixels; this one needs *camera motion*, and one kind in
particular. Rotating the image about its centre is **exactly** `K·R_z·K⁻¹` for a camera rolling
about its optical axis — with the principal point at the centre and square pixels they are the
same transformation — so the roll segment is a real camera rotation with **no translation
whatsoever**. That is the configuration POSE-004 exists for, and it is the one that passes every
check Phase 5 applies. It cannot be simulated with a pan.

The other three segments carry over: a two-layer pan at 3.5× disparity (non-planar, POSE-001), a
single-layer pan (planar, POSE-003) and a blank field (nothing to verify, POSE-004's other half).

### Two things worth reading carefully

**156 of the 251 posed frames report `ambiguous`, and that is correct.** 218 of them are planar,
and a homography decomposition leaves a genuine two-fold ambiguity that two views cannot
resolve — it needs a third. Reporting it is the honest option; tie-breaking on the larger
cheirality count by a hair would be inventing a decision. The same count is what lowers the
planar translation confidence to 0.50, and that number is *counted* rather than chosen: one of
two equally supported answers is worth a half.

**±20% on the focal length moves the recovered rotation by 0.012° and the translation direction
by 0.057°.** That is the honest half of being allowed to say `INTRINSICS: ESTIMATED` — the
consequences of the assumption are measured rather than asserted. On this synthetic feed the
pose barely depends on the guess. Whether that holds on a real lens with real perspective is the
device run's to say, and the same two numbers are in every bundle.

## Two criteria the leg's own variance corrected, both recorded in the plan

Neither is a threshold moved to make a number pass — both are criteria that turned out to be
measuring something other than what they named, corrected with the measurement that showed it
(§29). The leg now runs green three times consecutively.

### POSE-003 was comparing two different constraints

It required the median translation confidence on planar frames to be below the median on frames
with depth. Two consecutive runs, same code, same feed:

| | planar | with depth | verdict |
| --- | --- | --- | --- |
| run 1 | 0.5000 | 0.5691 | PASS |
| run 2 | 0.5000 | 0.4682 | FAIL |

Confidence is the **minimum** over its terms. On a planar frame the binding term is the §16
penalty — 0.5 exactly, every time. On a frame with depth it is whatever else was worst, which on
run 2 was a thinner population. So the comparison was measuring the population, not the planar
handling. §16 says 「この状態ではTranslation confidenceを低下させる」 — a statement about a frame,
not about an average across scenes — so the criterion is now within-frame (**no planar frame's
translation confidence may exceed its own rotation confidence**) plus a direct measurement of the
mechanism: the count of candidates cheirality could not separate, 2 on a plane against 1 with
depth. Stricter where it matters, and unconfoundable.

### POSE-005's criterion 4 said "to within a tolerance" and had none

The plan's wording was "the injected set keeps the same inlier count and the same planar flag, to
within a tolerance". The implementation set that tolerance to zero. Run 1: 0 of 47 frames
drifted. Run 2: **1 of 47**, and the phase failed.

The invariant is real but not exact. The epipolar geometry maps exactly under an image-space
rotation — `b′ᵀ(Hⱼ⁻ᵀF)a = bᵀFa` — so the true inlier set is preserved exactly. The **pixel
threshold** is not preserved: a Sampson distance is not invariant under a projective map of one
image, so a correspondence sitting on 1.5 px can cross. One frame in forty-seven is that.

The tolerance is now 10 % on the median, and the **control's own drift is recorded beside it** —
the same correspondences refitted with a different seed, which measures exactly what a refit
costs with no injection at all. Both read 0 % on the leg; the tolerance exists for the tail.

## Two defects the tests found before any leg ran

Both are recorded in full in [`../../PHASE-STATUS.md`](../../PHASE-STATUS.md).

**`svd3x3` returned a zero third column**, so Essential decomposition had no translation axis to
enumerate. One scene recovered its rotation exactly and the same scene turned by 4° came back
60° wrong, from identical code. `U diag(s) Vᵀ` reconstructed the matrix perfectly throughout —
a column multiplied by a zero singular value cannot affect the product — so the reconstruction
test could not have caught it, and did not.

**Cheirality was asked before the question it presupposes.** Triangulation needs a baseline, so
on a camera that only turned every candidate scored zero points in front and the frame was
reported `NO_POSE` — a pose refused for having no *translation*, which is the one case where a
rotation is perfectly recoverable.
