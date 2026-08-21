# Phase 0 — running the real-device test

Phase 0 cannot pass without this. Everything else is already done and committed; this is
the one step that requires a physical iPhone, and it takes about two minutes.

## Why it can't be automated here

`getUserMedia` and `DeviceMotionEvent.requestPermission()` both require a secure context,
and iOS additionally requires a real user gesture before it will even ask about motion
sensors. Headless Chromium can satisfy neither the "is Safari" nor the "is a phone"
condition, so Rule 004 makes the device leg a human step by design. The app enforces this
itself rather than trusting a claim: an automated run is detected
(`navigator.webdriver`, localhost origin) and classified `DESKTOP_DEV`, and a `DESKTOP_DEV`
leg cannot produce `PASSED` no matter how green its results are.

## Option A — GitHub Pages (recommended: real HTTPS, nothing to install)

1. In the repository: **Settings → Pages → Source → GitHub Actions**.
2. Push this branch. The `Deploy to GitHub Pages` workflow builds and publishes.
3. On the iPhone, open the published URL in **Safari** (not Chrome — on iOS every browser
   uses WebKit, but the goal is the actual Safari target).

## Option B — local HTTPS dev server

```bash
npm install
npm run dev        # vite with @vitejs/plugin-basic-ssl, bound to all interfaces
```

Open `https://<your-machine-LAN-IP>:5173` on the iPhone and accept the self-signed
certificate warning once. Plain `http://<LAN-IP>` will **not** work: it is not a secure
context, and CAP-0001 will correctly fail.

## What to do on the device

1. Let the capability sweep finish (about half a second).
2. Tap **PROBE MOTION SENSORS (REQUIRED)** and allow "Motion & Orientation Access" when
   iOS asks. Then **move the phone around for the two-second listen window** — the probe
   counts events that carry finite sensor values, so a phone lying flat and perfectly still
   may legitimately report fewer events.
   - Until you tap, CAP-0004 and CAP-0005 are `PENDING`, and the phase stays at `TESTING`.
     `PENDING` is never rounded up to `PASS`.
   - If you deny permission, that is still a determined capability: the tests pass and the
     engine records that it must run vision-only.
3. Read the **PHASE 0 VERDICT** panel. It will show `PASSED`, `TESTING` or `FAILED`, and
   the reason.
4. Tap **DOWNLOAD EVIDENCE JSON** (or **COPY EVIDENCE JSON**, or expand *Show evidence
   JSON* and select it by hand).
5. Take a screenshot of the screen.

## Committing the evidence (§60)

```
docs/phase0/evidence/phase0-real-device-<date>.json
docs/phase0/evidence/phase0-real-device-<date>.png
```

Then update `docs/PHASE-STATUS.md`. Phase 1 work may begin only once the committed bundle
reads:

```json
"leg": "REAL_DEVICE",
"overallVerdict": "PASSED"
```

## If it does not pass

The verdict panel and the per-test rows carry the specific reason — each test shows its
declared input, expectation, pass criteria, what was actually observed, and why the verdict
came out that way. Send the JSON; it contains the full capability matrix, every probe
duration, the error log and the state transitions.

Some outcomes look like failures but are not:

| Observation | Meaning |
| --- | --- |
| `DEPTH: UNAVAILABLE` | Correct. No Web API exposes iPhone depth to Safari. |
| `ARKit / RoomPlan: UNAVAILABLE` | Correct. Neither has a JavaScript API. |
| `SCALE: UNKNOWN` | Correct. A monocular camera has no absolute scale (§18, §90). |
| `WebGPU: UNAVAILABLE` | A passing result — CAP-0003 asks for a correct report, not for WebGPU to exist. The engine falls back to WebGL2/CPU and says so. |
| `SharedArrayBuffer: UNAVAILABLE` | Expected on Pages, which cannot send COOP/COEP headers. |
| `CAP-0013 FAIL` | Advisory only. Browsers commonly hide the device list until camera permission is granted, and Phase 0 must not request it. |
