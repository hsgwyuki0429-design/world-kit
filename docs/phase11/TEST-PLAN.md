# Phase 11 — Surface Understanding — test plan

Spec: `Safari Spatial Game v4.0` §23 (Surface Understanding), §24 (Spatial Object
Classification), §1.4 (PLANE: UNKNOWN). Records `SURF-001` … `SURF-009`, implemented in
`src/testkit/Phase11Tests.ts`.

## What this phase has to produce

The landmark map (Phase 10) is a few hundred places the tracker could follow, in a world whose
axes are the first registered keyframe's camera axes and whose unit is a keyframe pair's
baseline. A game needs §23's *当たり面・支え面・遮蔽面*: where a ball can land, what it bounces
off, what is in the way. This phase turns landmarks into **surfaces** and classifies them into
§24's five game categories — `GROUND`, `WALL`, `PLATFORM`, `OBSTACLE_SURFACE`, `UNKNOWN` — and
names nothing else (§24: furniture names are not required, and guessing one would be inventing a
fact).

Two quantities are needed, and they come from different instruments:

| Quantity | Instrument | Module |
| --- | --- | --- |
| Planes | sequential RANSAC over **confirmed** landmarks (≥ 3 views), seeded | `src/mapping/surfaces.ts` |
| Down | the orientation sensor's down vector, paired with Phase 12's per-frame pose | `src/capture/GravityMonitor.ts`, `src/mapping/gravity.ts` |

### Why down has to be measured, and how

Horizontal and vertical mean nothing in a world tilted however the first keyframe was tilted.
`deviceorientation`'s `beta`/`gamma` give down in the **device** frame without sign ambiguity
(W3C-defined; the Phase 0 device bundle's simultaneous orientation and motion samples confirm
`accelerationIncludingGravity` points *down* on iOS, opposite to W3C — which is why it is only a
cross-check here). What relates the device frame to the camera frame is the image layout Safari
delivers — rotated with the screen (Phase 1 measured 1280×720 ↔ 720×1280 on one track). Four
candidates, each a rotation about the optical axis of `diag(1, −1, −1)`.

Under the right candidate, every localized frame's estimate of world down, `R_kᵀ · X · d_k`,
is the same direction; under a wrong one it swings as the camera turns. The candidate whose
estimates agree is chosen, **if** the motion separated them. That is the hand-eye argument of
Phase 7 reduced to a four-way choice — and it refuses for the same reason the hand-eye does:
a camera that has not turned cannot discriminate, and the estimate stays `UNKNOWN`.

## Thresholds (fixed before the code)

| Name | Value | Why |
| --- | --- | --- |
| `PLANE_INLIER_FRACTION` | 0.03 of the median scene depth | relative, because the unit is a baseline nobody measured |
| `MIN_SURFACE_SUPPORT` | 20 connected landmarks | a plane on fewer is a coincidence of three points and a few more |
| `CLUSTER_LINK_FRACTION` | 0.2 of depth | two tables at one height are two surfaces |
| `ORIENTATION_TOLERANCE_DEG` | 12° | horizontal within 12° of level; vertical within 12° of plumb |
| `MIN_GRAVITY_SAMPLES` / `MIN_DIVERSITY_DEG` | 30 frames / 15° | below this the four layouts are not separated by the data |
| `MAX_SPREAD_DEG` | 6° | three times the sum of Phase 6's 0.76° visual agreement and the platform's attitude error |
| discrimination | runner-up ≥ 2× and ≥ 2° worse | the motion must have *told* the layouts apart |
| `MIN_GROUND_CONFIDENCE` | 0.5 | a floor the game may stand a stage on |

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| SURF-001 | ✓ | ≥ 8 extractions; ≥ 1 surface; 0 surfaces naming landmarks the map did not hold; 0 surfaces from a map with no confirmed landmark (Rule 002: no planes at startup) |
| SURF-002 | ✓ | median plane residual ≤ 0.015 of a depth (half the band; uniform filling of the band sits near 0.58 of it) |
| SURF-003 | ✓ | ≥ 8 surfaces offered for re-finding; ≥ 70 % found again in the next extraction |
| SURF-004 | ✓ | ≥ 3 control runs: the same landmarks moved ten inlier bands in a seeded direction; median ratio of largest-surface support ≤ 0.3 |
| SURF-005 | ✓ | 0 surfaces classified while gravity is UNKNOWN; 0 classes inconsistent with their tilt |
| SURF-006 | ✓ | gravity ESTIMATED under the thresholds above |
| SURF-007 | ✓ | a GROUND surface at confidence ≥ 0.5 and the camera height above it measured |
| SURF-008 | — | median extraction ≤ 12 ms (main thread, about once a second) |
| SURF-009 | — | `accelerationIncludingGravity` agrees with the orientation-derived down within 15°, sign measured |

## Amendments, with the measurement that forced each (§29)

1. **SURF-004 compares the *largest* surfaces, not the totals.** The first criterion summed the
   support of every surface the control produced. On the 630-point unit room the control yielded
   several slices of ~25 points each before the sequential search stopped — 30 % of the real
   total — while its largest slice was 17–24 % of the real floor. The total measured how many
   slices `MAX_SURFACES` allowed, not whether the detector invents planes.
2. **The control moves every landmark by exactly ten bands**, not by a random amount up to it.
   With the distance drawn uniformly a third of the points barely move and a third of each plane
   survives in place.
3. **Surface confidence is confidence-weighted support and planarity — the median landmark
   confidence is no longer a third term.** The spatial leg found the floor flat to 0.3° of
   gravity on 97 landmarks whose median confidence was 0.31, and the median capped the surface at
   0.31, under the ground bar. A plane resting on a hundred moderate landmarks is better
   established than any one of them; support now counts each landmark at its own confidence and
   saturates at 40.

## What the desktop leg can and cannot establish

`scripts/run-e2e-spatial.mjs` films a ray-cast room with a harness-dispatched orientation sensor.
It decides every record — including gravity, because the sensor reading is a stimulus the harness
supplies — and cannot pass the phase (Rule 004). On the device, the open questions are the ones a
render cannot answer: how noisy real floors are at the 3 % band, and whether real users turn the
phone enough for SURF-006 without being asked.
