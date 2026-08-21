# Phase 1 — running the real-device test

Phase 1 needs **two runs**, because the granted and denied permission paths cannot both
happen in one session and neither may be inferred from the other. Together they take about
three minutes.

Open the published site on the iPhone in Safari, exactly as for Phase 0. Phase 0 must
already read `PASSED` on the device, or the START SCAN control stays locked.

---

## Run 1 — permission granted (CAM-001, CAM-003, CAM-004, CAM-005)

1. On the capability screen, tap **START SCAN**. It is enabled only because Phase 0 passed.
2. Tap **START CAMERA** and allow camera access.
3. **Hold the camera open for at least 35 seconds without leaving Safari.**
   - The *Continuous* field counts up to 30.0 s. CAM-003 stays `PENDING` until it fills.
   - Switching apps stops frame callbacks. If you do, the run reports the backgrounding and
     must be repeated — it is a failure, not an interruption to be excused.
4. **Move the phone around** while it counts. Pan across the room slowly.
   - Watch *Image Δ max* rise. CAM-004 needs it above **8.0**; pointing at a motionless
     wall only reaches 1–3, which is why the test asks you to move.
   - *Noise floor* shows the median for comparison.
5. **Rotate the phone** once, then back.
   - CAM-005 stays `PENDING` until a rotation is observed. If nothing happens, rotation
     lock is on — turn it off in Control Centre.
6. When the verdict panel shows what you want, tap
   **DOWNLOAD EVIDENCE JSON**. The verdict is in the filename.
   - Stopping the camera first is fine. CAM-001, CAM-003 and CAM-005 judge what was
     demonstrated during the session, not whether the stream is still open at the moment
     you export.
7. Screenshot the screen.

## Run 2 — permission denied (CAM-002)

1. In Safari, tap the **ăA** menu in the address bar → **Website Settings** → **Camera** →
   **Deny**.
2. Reload the page, go to the SCAN screen, and tap **START CAMERA**.
3. Expect: `CAMERA PERMISSION DENIED`, no image at all, and the error with its recovery
   action. CAM-002 turns `PASS`.
4. Export the evidence and screenshot again.
5. Set the camera permission back to **Ask** afterwards.

The screen will show CAM-001 as `CARRIED` in run 2 (and CAM-002 as `CARRIED` if you go back
to run 1). That is a convenience so you can see the whole picture; the repository requires
one committed bundle per scenario with `observedDirectly: true`, and
`tests/unit/committedEvidence.test.ts` enforces exactly that.

---

## Committing

```
docs/phase1/evidence/phase1-real-device-<VERDICT>-<timestamp>.json   (granted run)
docs/phase1/evidence/phase1-real-device-<VERDICT>-<timestamp>.json   (denied run)
```

plus a screenshot for each. Then update `docs/PHASE-STATUS.md`.

## Outcomes that look like failures but are not

| Observation | Meaning |
| --- | --- |
| `facingMode` is `unreported` | Some devices do not expose it. The value is recorded as achieved, never as requested. |
| Ladder rung 2 or 3 rather than 1 | `facingMode: {exact:'environment'}` was refused and the looser rung succeeded. This is the fallback in §9 working. |
| Delivered fps around 20 rather than 30 | Above the 15 fps floor. The camera negotiated what it could. |
| CAM-002 shows `CARRIED` in the granted run | The denial was observed in the other run. Both bundles still have to be committed. |

## What Phase 1 does not do

No frame pipeline, no feature detection, no pose, no spatial data. The SCAN screen shows a
camera preview and measurements of that camera, and nothing else exists yet. Phase 2 is the
frame pipeline (§10).
