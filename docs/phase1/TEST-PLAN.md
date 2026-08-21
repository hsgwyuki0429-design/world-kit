# Phase 1 — Camera Capture · Test Plan

Written **before** `src/capture/CameraSource.ts` existed (§29). Criteria here may not be
relaxed after seeing a result.

Governing spec: §9 (Phase 1), §62 (Phase 1 Test), §57 (error states), Rule 004, Rule 005.

## Objective

Obtain a genuine video stream from the real camera and prove it is genuine — that frames
keep arriving for 30 seconds and that the image actually changes when the camera moves.

**In scope:** `getUserMedia`, rear-camera preference, resolution target with fallback,
permission handling, error states, frame-arrival verification, image-change verification,
orientation change.

**Out of scope, deliberately (Rule 005):** the worker/OffscreenCanvas frame pipeline,
adaptive resolution, preprocessing — all Phase 2. Feature detection — Phase 3. Nothing in
this phase produces or stores spatial data of any kind.

## Resolving a contradiction in the spec (§34)

§9 lists four tests under the prefix `CAM-`. §62 lists five under `CAP-`, adding
*Orientation Change*, and states `PASS条件：全テストPASS`.

Two conflicts, resolved without inventing anything:

1. **Four tests or five.** §34 ranks *Phase Pass Criteria* above *Architecture* and
   *Performance*, and Fail Closed (§1.4) says the uncertain case must not resolve to the
   easier one. The union is taken: **five tests**, including Orientation Change.
2. **`CAM-` or `CAP-`.** §62's `CAP-001..005` collide with Phase 0's `CAP-0001..0013`, and
   two different tests sharing an ID makes evidence ambiguous — which §85 (provenance) and
   §61 (record format) both depend on. The prefix from §9, `CAM-`, is used. This is a
   naming decision only; no test is added, removed or weakened.

## Verdict algebra

Unchanged from Phase 0: `PASS` / `FAIL` / `PENDING`, any required `PENDING` holds the phase
at `TESTING`, and only a `REAL_DEVICE` leg can produce `PASSED` (Rule 004).

## Two scenarios are required

CAM-001 (granted) and CAM-002 (denied) cannot both be observed in one run: a session in
which permission was granted contains no evidence about the denial path, and vice versa.
Neither may be inferred from the other.

So **Phase 1 requires two device runs**, and each run reports honestly which scenario it
observed, leaving the other `PENDING`. Two mechanisms, deliberately separate:

- **In-app**, an observation ledger in `localStorage` (measured AVAILABLE on the device)
  carries a scenario observed in an earlier run into the current one, so the second run can
  reach `PASSED`. Every carried-over result is flagged `observedDirectly: false` and shown
  with the age and origin of the observation it rests on.
- **In the repository**, `tests/unit/committedEvidence.test.ts` ignores the ledger entirely
  and requires committed `REAL_DEVICE` bundles that between them cover both scenarios with
  `observedDirectly: true`. This is the authoritative gate; the ledger is a convenience and
  is not trusted by it.

---

## Test records

### CAM-001 — Camera permission granted, real stream opens · REQUIRED

- **Input:** user tap → `getUserMedia` with the constraint ladder below.
- **Expected:** a `MediaStream` carrying at least one video track with
  `readyState === 'live'`, and `getSettings()` reporting real width, height and frameRate.
- **Pass criteria:** a stream opened with settings reporting finite width ≥ 1 and
  height ≥ 1, **and** the video element reported a non-zero size while frames were
  arriving; the achieved `facingMode` is recorded.

> **Plan amendment, after the first device run.** The criteria originally read "a *live*
> video track exists … the element reports `videoWidth`/`videoHeight`", both evaluated
> against the state at the moment of judging. That is wrong for a test whose subject is an
> event: on the device, a 40.6 s session at 1280×720 that survived two rotations flipped
> from PASS to FAIL the instant the tester pressed STOP CAMERA before exporting, because
> the track had gone null and the detached element reported 0×0. The criteria now read
> what was *demonstrated* — the stream opened, and the element rendered while frames were
> arriving — which is what the test always meant. CAM-005 had the same defect and the same
> fix; CAM-003 already worked this way. This narrows nothing: a stream that never opens,
> or never renders, still fails.
- **Failure condition:** `getUserMedia` throws while permission was granted; no live track;
  zero-size settings.
- **PENDING when:** permission was denied in this run (that is CAM-002's scenario).
- **Not a failure:** landing on a lower rung of the constraint ladder, or on a front camera
  where no rear camera exists. Both are recorded, and the achieved `facingMode` is reported
  rather than assumed.

#### Constraint ladder (§9 "nearest fallback")

Tried in order, stopping at the first that succeeds; the rung used is recorded.

| # | Constraints |
| --- | --- |
| 1 | `facingMode: {exact:'environment'}`, `width {ideal:1280}`, `height {ideal:720}`, `frameRate {ideal:30}` |
| 2 | `facingMode: 'environment'`, `width {ideal:1280}`, `height {ideal:720}` |
| 3 | `facingMode: 'environment'` |
| 4 | `video: true` |

A rung is only retried at the next level for `OverconstrainedError` / `NotFoundError`.
`NotAllowedError` stops the ladder immediately — retrying a denial would be pointless and
would re-prompt.

### CAM-002 — Camera permission denied, handled without a fake stream · REQUIRED

- **Input:** `getUserMedia` rejected by the user or by site settings.
- **Expected:** state `CAMERA_PERMISSION_DENIED`; no stream; the UI says so explicitly.
- **Pass criteria:** the rejection is mapped to `CAMERA_PERMISSION_DENIED`; no video track
  is held; the preview presents no image; the error is logged with a recovery action.
- **Failure condition:** the denial is swallowed; any placeholder or previously captured
  image is presented; the state is reported as anything other than denied.
- **PENDING when:** permission was granted in this run.
- **How to produce it on an iPhone:** Safari → the "ăA" menu → *Website Settings* →
  *Camera* → *Deny*, then reload. (Or *Ask*, then decline the prompt.)

The mapping from every relevant `DOMException` name to a state is additionally verified
deterministically by unit tests, so the device run confirms behaviour rather than
discovering it.

### CAM-003 — 30 seconds of continuous frame capture · REQUIRED

- **Input:** an open stream, observed via `requestVideoFrameCallback` (measured AVAILABLE
  on the target) with `requestAnimationFrame` as the declared fallback.
- **Expected:** frames arrive continuously for at least 30 s.
- **Pass criteria:** all of —
  - continuous observation ≥ 30 000 ms;
  - mean delivered frame rate ≥ 15 fps (the §10 floor);
  - longest gap between consecutive frames ≤ 2000 ms;
  - the video track never leaves `readyState === 'live'`;
  - the page was never hidden during the window.
- **Failure condition:** any of the above unmet.
- **PENDING when:** fewer than 30 s have been observed so far. The test becomes evaluable
  when the window fills, exactly as CAP-0004 did in Phase 0.
- **Backgrounding is a FAIL, not an exclusion.** `requestVideoFrameCallback` stops while the
  page is hidden, so a run interrupted by an app switch has not demonstrated 30 s of
  capture. Visibility transitions are recorded and the run must be repeated. Excluding the
  hidden interval instead would let any stall be explained away.

### CAM-004 — Moving the camera changes the image · REQUIRED

This is the anti-fake test of the phase: it distinguishes a live camera from a frozen
frame, a black stream, or a still image.

- **Input:** frames sampled at ~4 Hz into a 64×48 grayscale buffer; per sample, the mean
  absolute difference (MAD, 0–255) against the previous sample, plus mean luma.
- **Expected:** while the camera moves, MAD rises far above the sensor-noise floor.
- **Pass criteria:** all of —
  - at least 20 samples taken;
  - `maxMad >= 8.0` — a level a static scene cannot reach (see the floor's justification
    below);
  - `maxMeanLuma > 2.0`, ruling out an all-black stream from a camera held by another app.

#### Why 8.0

Sampling box-downsamples 1280×720 to 64×48, averaging about 300 source pixels per cell,
which attenuates uncorrelated sensor noise by roughly √300 ≈ 17×. Producing a mean absolute
difference of 8 from noise alone would take a per-pixel σ near 140 on a 0–255 scale — not a
camera. So the floor separates "the image genuinely changed" from every static case:
a frozen frame and a still photo sit near zero, and a live camera pointed at a motionless
wall reaches only 1–3.

> **Plan amendment, made before any device run, after the automated desktop leg.** This
> criterion originally also required `maxMad >= 4 × medianMad`, intended to make motion
> stand out from the noise floor. It is wrong, and the reason has nothing to do with the
> leg that revealed it: a tester who pans the phone *continuously* through the whole
> 30 s window — the clearest possible demonstration of a live camera, and exactly what §9
> describes — raises the median along with the peak, collapsing the ratio and failing the
> test. The ratio gate produced a false negative on the very behaviour under test.
>
> The absolute floor alone is sound for the reason above, so the ratio requirement is
> removed as a *gate*. `madMin`, `madMedian` and the peak-to-median ratio are still
> recorded and displayed, so the separation between noise floor and motion stays visible.
> This narrows what the test rejects; it does not lower the bar for passing it, which
> remains the same absolute floor. Recorded here rather than silently edited (§29).
- **Failure condition:** MAD stays at the noise floor (a frozen or still image), or the
  frame is uniformly black.
- **PENDING when:** fewer than 20 samples so far.
- **Recorded regardless:** min / median / mean / max MAD and the luma range, so the
  separation between noise floor and motion is visible rather than asserted.

### CAM-005 — Orientation change · REQUIRED

- **Input:** the device is rotated; `screen.orientation` and/or `orientationchange`.
- **Expected:** the app observes the change, capture continues across it, and the recorded
  preview geometry follows the new orientation.
- **Pass criteria:** at least one orientation change observed with a changed angle; frames
  continue within 2000 ms of the change; the track does not end **on its own** during the
  session. Deliberately stopping the camera afterwards is not a failure — see the CAM-001
  amendment above.
- **Failure condition:** capture stalls or the track ends on rotation.
- **PENDING when:** no orientation change has been observed. Rotation lock must be off.

### CAM-006 — Error-state completeness · ADVISORY

- **Input:** the mapping table from `DOMException` name to engine state.
- **Expected:** every name in the mapping resolves to one of the §57 states, with a
  non-empty recovery action.
- **Pass criteria:** no unmapped name; no state without a recovery string.
- **Failure condition:** any gap. Advisory because it is a property of the code rather than
  of the device, and is fully covered by unit tests.

---

## Evidence required for a Phase 1 PASS

Two `REAL_DEVICE` bundles committed under `docs/phase1/evidence/`:

1. a **granted** run in which CAM-001, CAM-003, CAM-004 and CAM-005 were observed directly;
2. a **denied** run in which CAM-002 was observed directly.

Plus a device screenshot for each. `tests/unit/committedEvidence.test.ts` enforces the
coverage requirement and re-derives each verdict from the bundle's own results.
