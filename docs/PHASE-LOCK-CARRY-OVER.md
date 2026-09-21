# The Phase Lock across page loads

Rule 005 says a phase may be entered once its predecessor has **PASSED**. Until 2026-09-21 the
engine asked for something stricter than that without ever saying so, and the difference was
expensive enough to be worth a document.

## What was actually being asked

`PhaseRegistry` is constructed fresh on every page load. `canEnter(N)` read
`phases[N-1].state === PASSED`, and after a reload every phase's state was back to `BLOCKED`. So
the condition in force was **"the predecessor passed in this page load"** — a sentence that
appears nowhere in Rule 005, and that turned every device session into an all-or-nothing chain:

| To reach | You first had to pass, without reloading |
| --- | --- |
| Phase 7 | 0, 1, 2, 3, 4, 5, 6 |
| Phase 8 | 0 … 7 |
| Phase 9 | 0 … 8 |

About twenty minutes of held motion for Phase 9, in one sitting. A reload, a backgrounded tab, a
Safari tab discard, or a Phase 7 run that ended `TESTING` — the ordinary outcome of a run that is
diagnosing something — cost the entire chain behind it. Phase 7 was retried four times over two
days, and each retry was charged the price of re-passing six phases that had passed on the same
phone minutes earlier.

None of that cost bought any rigour. Re-passing Phase 4 for the ninth time does not make Phase 7's
evidence better; it only makes Phase 7's evidence rarer.

## What carries over now

A phase that reached PASSED **on this device, on this build, at this origin** keeps its door open
across page loads. `PhasePassLedger` stores the pass in `localStorage`; `PhaseRegistry.carryOver`
hands it to the lock on the next load.

**It carries a lock, not a verdict.** This is the whole of its safety, and it is worth being
precise about:

- No phase's state is set to PASSED by a carry-over. A carried phase reads `NOT_STARTED`, and
  once its stage starts, whatever this session measures — usually `TESTING`, because its records
  are `PENDING` until it has run for a while.
- No test result and no evidence bundle is touched. A bundle exported from a carried session
  records what *that session* measured, and `overallVerdict` still re-derives from its own
  results — which is what `tests/unit/committedEvidence.test.ts` checks on every commit.
- The carry-over is written into the `stateTransitions` of every bundle the session exports
  (§60), with the build, the origin, the age and the sentence *"this session has not re-measured
  it"*. A reviewer reading a Phase 9 bundle can see exactly which doors were opened by earlier
  runs and go find those runs' own bundles.

## What it refuses

Five refusals, each with a test in `tests/unit/phasePassLedger.test.ts`:

1. **A different build.** The pass is pinned to the commit that produced it. A deploy moves the
   commit, the doors shut, and the chain is run again — which is correct, because a pass is
   evidence about the code that produced it. This project has already paid for the opposite
   twice in one day, when a stalled Pages deploy left a phone measuring week-old instruments.
2. **A build that cannot name itself.** `buildCommit` is `unknown` where the build could not read
   a commit, and `unknown` matches `unknown` across arbitrarily different builds. Nothing is
   stored and nothing is carried. (`ScenarioLedger` had exactly this defect — it pinned
   `appVersion`, which has read `0.1.0` since Phase 0, so its build check could never fire. Fixed
   in the same change.)
3. **A different origin.**
4. **Anything that was not a real-device PASS.** Rule 004 is untouched: a `DESKTOP_DEV` run cannot
   reach PASSED, so there is nothing for it to store.
5. **A gap in the chain.** A carried pass for phase 6 opens phase 7's door only if phase 6's own
   door is open. A FAIL anywhere behind it shuts every door in front of it, carried or not.

### The one that can bite you on the phone

**A FAIL in this session drops the stored pass**, and everything behind that phase re-locks with
it. A phase that fails now did not pass earlier in any sense that should open a door.

`TESTING` does not drop it — that says this session has not finished measuring, which is not news
about an earlier run, and treating it as a contradiction would undo the carry-over the moment the
tester started the stack the next phase needs. Which is every time.

The case to watch for is a record that reaches `FAIL` on the thin data of a walk-through, when it
would have reached `PASS` given the run it was written for. That would take a tester three screens
further on and put them back at a closed door. The rule is not loosened for it — a verdict is not
made conditional on how long someone waited — so if it happens the answer is the record: it should
be reporting `PENDING` until it has the samples its criterion needs, which is what every other
record in the project does. The app logs the drop as a WARN from `PhasePassLedger` naming the
phase, the reason and the consequence, so the bundle says which record did it.

## What it does *not* save you

**Starting the stages.** The lock and the pipeline are different things. Phase 7 fuses what the
live stack produces, so the camera, the pipeline, the detector, the tracker, the verifier and the
pose solver all still have to be running when you get there. What the carry-over removes is the
requirement to make each of those phases *pass* on the way past — not the walk itself. In
practice that is one tap per screen, in order, going forward:

| Screen | Tap |
| --- | --- |
| SCAN (Phase 0) | *(runs by itself)* |
| CAMERA CAPTURE | `START CAMERA` |
| PIPELINE | `START PIPELINE` |
| FEATURES | `START DETECTION` |
| TRACKING | `START TRACKING` |
| GEOMETRIC VERIFICATION | `START VERIFICATION` |
| RELATIVE POSE | `START POSE RECOVERY` |
| IMU SUPPORT / FUSION | `START FUSION` |
| KEYFRAME SYSTEM | `START KEYFRAMES` |
| TRIANGULATION | `START TRIANGULATION` |

Go forward with the `GO TO …` buttons only. `BACK TO …` stops the stage you came from, which is
what it is for and not what you want here.

**Earning the first pass.** A carried pass has to have been a pass. Each phase still needs its own
committed real-device bundle whose verdict re-derives from its own results, and the only way to
produce one is to make that phase pass in a session and export from its screen. The carry-over
makes the *second* attempt at a phase cheap, not the first.

## Reading it on the phone

Where a door was opened by an earlier run, the control says so beside itself: *"Phase 6 is
NOT_STARTED in this run — carried over: phase 6 PASSED on a REAL_DEVICE run at …"*. That footnote
exists because an enterable button in front of a phase reading `NOT_STARTED` is otherwise
indistinguishable from a Phase Lock that has failed open — and the tester is told, in every one of
these guides, to stop and report exactly that (Rule 002, §H.5).

## Clearing it

Clear the site's data in Safari (Settings → Safari → Advanced → Website Data, or a private tab),
and every carried pass goes with it. There is no in-app control, because wanting one has not come
up: the build pin already resets the chain whenever the code changes, which is the case that
matters.

## Where the code is

- `src/core/PhasePassLedger.ts` — storage, the pins, and what it refuses to store.
- `src/core/PhaseRegistry.ts` — `carryOver`, `canEnter`'s chain walk, `lockNote`.
- `src/main.ts` — `restoreCarriedPasses` on start, `recordPassOutcome` on every verdict.
- `tests/unit/phasePassLedger.test.ts` — the refusals, demonstrated rather than described.
