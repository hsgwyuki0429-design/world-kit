# Phase 0 — Test Plan

Written **before** `src/capture/CapabilityDetector.ts` existed (§29: tests are designed
first, and pass criteria may not be relaxed after the fact).

Governing spec sections: §8 (Phase 0), §60 (evidence), §61 (record format), Rule 003,
Rule 004, Rule 005.

## Scope

Phase 0 answers exactly one question: **what can this specific device actually do?**

Out of scope, deliberately: opening the camera, any frame, feature, pose, landmark, plane,
world or collision. Those are Phases 1–16 and MUST NOT be touched here (Rule 005).

## Legs

| Leg | Environment | Automated? | Can it pass a Phase? |
| --- | --- | --- | --- |
| `DESKTOP-CHROMIUM` | headless Chromium in CI/dev container | yes | **No** (Rule 004) |
| `REAL-DEVICE` | iPhone + iOS + Safari + HTTPS | no — human taps through | **Yes** |

A Phase 0 PASS requires a `REAL-DEVICE` evidence file. The desktop leg exists to catch
regressions early and to prove the test harness itself works.

## Verdict algebra (fail closed, §1.4)

- `PASS` — observed satisfies expected.
- `FAIL` — observed contradicts expected.
- `PENDING` — cannot be evaluated yet (e.g. permission not yet granted by a tap).

Overall Phase 0 verdict:

```
if any REQUIRED test == FAIL      -> FAILED
else if any REQUIRED test == PENDING -> TESTING     (never PASSED)
else if all REQUIRED tests == PASS   -> PASSED
```

`PENDING` never rounds up. An advisory test can never fail the phase, and can never
substitute for a required one.

---

## Test records

Each record follows §61. `Observed`, `Metrics`, `Screenshot`, `Error Log` are filled at
runtime by `EvidenceRecorder`, not by hand.

### CAP-0001 — Secure context / HTTPS · REQUIRED

- **Input:** page load.
- **Expected:** `window.isSecureContext === true`.
- **Pass criteria:** secure context is true. `location.protocol` recorded for the record.
- **Failure condition:** loaded over plain `http:` on a non-localhost origin. Camera can
  never work there, so Phase 0 fails rather than deferring the problem to Phase 1.
- **Note:** `http://localhost` is a secure context by definition and passes on the desktop
  leg. It is *not* a valid real-device leg, because an iPhone reaching a dev machine by LAN
  IP is not a secure context.

### CAP-0002 — Camera API availability · REQUIRED

- **Input:** `navigator.mediaDevices`, `getUserMedia`, `getSupportedConstraints()`.
- **Expected:** capability `camera.getUserMedia` = `AVAILABLE`, and every media constraint
  Phase 1/2 depends on (`facingMode`, `width`, `height`, `frameRate`, `aspectRatio`,
  `deviceId`) reported as supported by a real `getSupportedConstraints()` call.
- **Pass criteria:** `getUserMedia` is a function **and** the page is a secure context
  **and** no required constraint is missing.
- **Failure condition:** `mediaDevices` undefined, `getUserMedia` missing, not a secure
  context, or a required constraint unsupported.
- **Explicitly NOT tested here:** whether permission is granted, and whether a stream can
  be opened. That is CAM-001/CAM-002 in Phase 1. Phase 0 must not trigger a permission
  prompt — doing so would make the capability matrix depend on a dialog.
- **Known-good non-failure:** device labels are empty strings before permission. Recorded
  as `labelsHidden: true`; not a failure.

> **Plan amendment, made before any test was implemented or run.** The first draft of this
> plan put "at least one `videoinput` enumerated" inside CAP-0002's required pass criteria.
> That is wrong for a *required* test: several browsers return an empty `enumerateDevices()`
> list until camera permission has been granted, so the criterion would fail for a reason
> that has nothing to do with the capability being tested, and Phase 0 is forbidden from
> requesting that permission. The device count is still measured and still reported — it
> moved to the advisory test **CAP-0013**. Recorded here rather than silently edited,
> because §29 forbids relaxing criteria *after* seeing a result; this change was made
> before the first run.

### CAP-0003 — WebGPU determination · REQUIRED

- **Input:** `navigator.gpu.requestAdapter()` then `adapter.requestDevice()`.
- **Expected:** the state is *determined by executing the API*, i.e. `AVAILABLE` or
  `UNAVAILABLE`, with `method === FUNCTIONAL_PROBE`.
- **Pass criteria:** state ∈ {`AVAILABLE`,`UNAVAILABLE`} **and** method is
  `FUNCTIONAL_PROBE`. `UNAVAILABLE` is a passing outcome — §8 CAP-0003 asks for a correct
  report, not for WebGPU to exist.
- **Failure condition:** state is `UNKNOWN`/`ERROR`, or the state was decided from the UA
  string instead of from `requestAdapter()`.
- **Metrics recorded:** adapter info, feature list, selected limits, probe duration.

### CAP-0004 — DeviceMotion determination · REQUIRED

- **Input:** on iOS, a user tap → `DeviceMotionEvent.requestPermission()`; then a
  2000 ms listen window on real `devicemotion` events.
- **Expected:** a determined state, and — when granted — **real event data**:
  at least 5 events received, and at least one of `accelerationIncludingGravity`,
  `acceleration`, `rotationRate` carrying finite numbers.
- **Pass criteria:** state ∈ {`AVAILABLE`,`UNAVAILABLE`,`PERMISSION_DENIED`} **and** for
  `AVAILABLE`, `eventCount ≥ 5` with finite sample values and a measured sample rate.
- **Failure condition:** state claimed `AVAILABLE` with zero events received; or any
  sample value non-finite; or permission requested outside a user gesture.
- **PENDING condition:** `PERMISSION_REQUIRED` — the tap has not happened yet. The phase
  stays at `TESTING`.
- **Rationale:** "the constructor exists" is not a capability. Only arriving sensor data is.

### CAP-0005 — DeviceOrientation determination · REQUIRED

As CAP-0004, over `deviceorientation`. Additionally records whether
`webkitCompassHeading` / `absolute` are present on the real events, since Phase 7 fusion
depends on knowing whether the orientation is absolute or relative.

### CAP-0006 — WebAssembly executes · REQUIRED

- **Input:** a 41-byte hand-assembled module exporting `add(i32,i32)->i32`, instantiated
  at runtime.
- **Expected:** `add(2,3) === 5`.
- **Pass criteria:** instantiation succeeds and the exported function returns exactly 5.
- **Failure condition:** instantiation throws, or the result is not 5.
- **Rationale:** `typeof WebAssembly === 'object'` proves nothing about compilation on a
  device that may block wasm.

### CAP-0007 — Worker round-trip · REQUIRED

- **Input:** a Blob-URL worker; post `{ping: <token>}`; 3000 ms timeout.
- **Expected:** the same token echoes back.
- **Pass criteria:** echo matches and arrives before timeout.
- **Failure condition:** timeout, error event, or token mismatch.
- **Consequence if FAIL:** §21's UI-thread rule cannot be honoured, so this is REQUIRED.

### CAP-0008 — OffscreenCanvas pixel exactness · REQUIRED

- **Input:** `new OffscreenCanvas(4,4)`, fill `rgb(10,20,30)`, `getImageData(1,1,1,1)`.
- **Expected:** exactly `[10,20,30,255]`.
- **Pass criteria:** exact byte equality (no colour-management drift).
- **Failure condition:** context unavailable, or pixel values differ.
- **PENDING/soft condition:** if `OffscreenCanvas` is entirely absent the capability is
  `UNAVAILABLE`; the test then evaluates the declared fallback path instead
  (main-thread canvas readback) and passes only if *that* is exact.

### CAP-0009 — Depth / ARKit / RoomPlan / Scale honesty · REQUIRED

This is the anti-fake test. It asserts that the app has not claimed anything the platform
cannot give.

- **Input:** the completed capability matrix.
- **Expected:**
  - `spatial.webxr` determined by a real `navigator.xr` probe;
  - `spatial.cameraDepth` = `UNAVAILABLE` unless a real depth API was found by probe;
  - `spatial.nativeBridge` determined by probing `window.webkit.messageHandlers`;
  - `spatial.arkit` and `spatial.roomplan` = `UNAVAILABLE` whenever no native bridge exists;
  - `spatial.metricScale` = `UNKNOWN`.
- **Pass criteria:** all of the above hold **and** none of these records has
  `method === 'INFERENCE'`.
- **Failure condition:** any of them reports `AVAILABLE` without a probe that found a real
  API; or metric scale is anything other than `UNKNOWN` in Phase 0.

### CAP-0010 — Matrix integrity, export and round-trip · REQUIRED

- **Input:** the capability matrix + evidence bundle.
- **Expected:**
  1. `JSON.parse(JSON.stringify(bundle))` deep-equals the bundle;
  2. no `NaN`, no `±Infinity`, no `undefined` numeric field anywhere (§84);
  3. every record has a non-empty `id`, `state`, `method`, `timestamp`;
  4. no record used as a pass criterion has `method === 'INFERENCE'`;
  5. the bundle carries `schemaVersion`, `leg`, `device`, `capabilityMatrix`,
     `testResults`, `stateTransitions`, `errorLog`.
- **Pass criteria:** all five hold.
- **Failure condition:** any violation. This is what makes §7's "Capability Matrix is
  savable" a checked property rather than a claim.

### CAP-0011 — Phase Lock · REQUIRED

- **Input:** `PhaseRegistry` after Phase 0 evaluation.
- **Expected:** while Phase 0 is not `PASSED`, `registry.canEnter(1)` is `false` and
  Phase 1's state is `BLOCKED`; the START SCAN control is disabled and states the reason.
- **Pass criteria:** the registry refuses entry, and the rendered button's `disabled`
  property agrees with the registry (UI state == engine state, §Stop Condition).
- **Failure condition:** the UI offers an action the registry forbids, in either direction.

### CAP-0013 — Video input enumeration · ADVISORY

- **Input:** `navigator.mediaDevices.enumerateDevices()`.
- **Expected:** at least one `videoinput` entry, labels possibly hidden.
- **Pass criteria:** `videoInputCount >= 1`.
- **Failure condition:** zero video inputs. Advisory only — an empty pre-permission list is
  a known browser behaviour, so this reports a fact without failing the phase. If it is
  zero here **and** Phase 1 CAM-002 then fails to open a stream, that pair is the real
  signal.

### CAP-0012 — Probe budget · ADVISORY

- **Input:** total duration of `detectAll()` (gesture-gated probes excluded).
- **Expected:** ≤ 1500 ms (§H).
- **Pass criteria:** within budget.
- **Failure condition:** exceeded. Advisory: it is recorded and surfaced but does not fail
  the phase, because a slow adapter query is a performance fact, not a correctness fact.

---

## Evidence required for a Phase 0 PASS (§60)

A `REAL-DEVICE` evidence bundle committed to `docs/phase0/evidence/` containing:

1. Device information (UA, screen, DPR, hardware concurrency, `maxTouchPoints`).
2. The full capability matrix with `method` on every record.
3. All CAP-000x results in §61 format.
4. The error log (empty is acceptable and must be shown as empty, not omitted).
5. State transitions with timestamps.
6. Probe timings.

Plus, alongside it, a screenshot of the START screen taken on the device.

## Explicit non-goals for Phase 0

- No camera permission prompt.
- No frames.
- No spatial data of any kind — `SpatialWorld` does not exist yet, and must not be
  stubbed with placeholder geometry.
