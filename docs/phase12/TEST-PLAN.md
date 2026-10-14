# Phase 12 — Spatial World — test plan

Spec: `Safari Spatial Game v4.0` §1.2 (Single Source of Truth), §1.3 (Observable State), §16,
§25 (Runtime State), §44 (Fail Closed). Records `WORLD-001` … `WORLD-007`, implemented in
`src/testkit/Phase12Tests.ts`.

## What this phase has to produce

One structure — `src/world/SpatialWorld.ts` — that the game, the collision system and the renderer
read, and nothing else. It holds §25's list: world origin, camera pose (and a bounded history),
the landmarks, the keyframe poses, the surfaces, gravity, tracking and mapping state, confidence
and last-updated times. Consumers get a frozen `SpatialWorldView`; the architecture audit forbids
`game/` and `renderer/` from importing the tracker or the map, so there is no other door.

### The pose of *this* frame

Phase 10 has a world and the poses of the keyframes registered into it, about once a second. A
ring drawn over the live image needs the pose of the frame being shown. The tracker's feature ids
**are** the map's landmark ids, so the 2-D/3-D correspondences are exact by construction, and the
pose is a perspective-n-point refinement (`src/geometry/pnp.ts`, Levenberg–Marquardt with Huber
weights) started from the previous frame's pose and from the newest registered keyframe's. The
DLT is not used: it is degenerate on coplanar points, and a room is mostly planes.

### READY is a conjunction

`WORLD READY` holds only while all of these do, re-derived on every read:

- tracking `GOOD` — localized, at pose confidence ≥ 0.4 (below it: `DEGRADED`, §1.4's POSE: LOW
  CONFIDENCE), and a pose no older than 600 ms;
- gravity `ESTIMATED` (Phase 11);
- a `GROUND` surface at confidence ≥ 0.5;
- nothing non-finite ever admitted.

## Thresholds

| Name | Value | Why |
| --- | --- | --- |
| `MIN_LOCALIZATION_INLIERS` | 12 | twice the six unknowns |
| `MIN_INLIER_SHARE` | 0.5 | a pose most tracked landmarks disagree with is not this frame's |
| `MAX_LOCALIZATION_MEDIAN_PX` | 2.0 px | v3 §33's GOOD band, which every reprojection figure here is held to |
| `MAX_HELD_OUT_PX` | 3.0 px | half the points are missing from the held-out solve |
| `POSE_STALE_MS` | 600 ms | about eighteen frames without a pose is a loss, not a hiccup |
| `MAX_POSE_HISTORY` | 240 | §56: everything is bounded |

## Amendment, with the measurement that forced it (§29)

**The reprojection median is taken over the correspondences the solve rests on (within 6 px),
not over all of them.** The spatial leg's long run builds a map that is never bundle-adjusted, so a
share of its landmarks drift. A pose with 162 of 247 landmarks inside 3 px reported a median of
2.1–2.3 px over all of them — the median sat on the boundary between the agreeing and the drifted
populations — and was refused every few seconds, flickering the game into `TRACKING_LOST`. How
many landmarks disagree is held separately, by `MIN_INLIER_SHARE`; the median says how well the
pose fits the ones that agree. The all-points median is still reported beside it.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| WORLD-001 | ✓ | ≥ 60 localized frames; median reprojection ≤ 2 px |
| WORLD-002 | ✓ | ≥ 10 held-out measurements (pose re-solved on even ids, odd ids projected); median ≤ 3 px |
| WORLD-003 | ✓ | ≥ 5 frames where the map registered a keyframe: the solved pose agrees with the map's registration — median ≤ 2° and ≤ 0.05 of a depth |
| WORLD-004 | ✓ | ≥ 30 READY frames; 0 frames READY with any condition false, checked from outside the world |
| WORLD-005 | ✓ | 0 non-finite ingests; history ≤ 240; landmarks ≤ 5000; coverage changes only with the map; §25's fields present |
| WORLD-006 | — | median localization ≤ 6 ms in the worker |
| WORLD-007 | — | no surface in the view rests on a landmark the current map does not hold (one epoch at a time) |

## Why each record is the one a fake fails

- Serving the keyframe pose for every frame scores a small in-sample error near keyframes and a
  large one between them; WORLD-002's held-out half is where it shows.
- A pose computed independently of the map would disagree with the map's own registration of the
  same view; WORLD-003 compares the two routes.
- A READY that a timer or a button sets is caught by WORLD-004's outside check on every frame.
- Coverage that grows with time (Rule 002) is caught by WORLD-005: coverage is the count of occupied
  cells over confirmed landmarks and may only move when the map does.
