# Phase 17 — Stage Generator — test plan

Spec: `Safari Spatial Game v4.0` §27 (Game Stage Generator), §30 (Start Point), §35 (Procedural
Stage Validation), §48. Records `STAGE-001` … `STAGE-004`, implemented in
`src/testkit/Phase17Tests.ts`.

## What this phase has to produce

`src/game/stage.ts`: from the SpatialWorld as it stands, a start point and a goal that fit **this
room**. Pure: the same view and seed give the same stage; the only randomness is a seeded `Rng`
deciding the order candidates are examined in.

- **Start (§30).** A virtual tee 0.65 camera-heights ahead of the player and 0.3 below the eye
  line, labelled `VIRTUAL` — a game object, not part of the room, not a collision surface (§33
  forbids passing one off as the other). It must have free space around it and a clear line to
  the goal.
- **Goal.** Candidates laid on a grid over every confident GROUND, PLATFORM and WALL surface,
  inside what was observed of each; each validated against §28 and searched for a scoring throw
  (Phase 18). The first that passes is the stage. None passing means no stage, with the rejection
  counts saying why (§35).
- **Units.** Everything is in multiples of the measured camera height above the ground (Phase 19).

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| STAGE-001 | ✓ | every stage regenerated immediately from the same view and seed: identical digest |
| STAGE-002 | ✓ | the held stage's epoch is the world's; its ring stands on a surface the world holds |
| STAGE-003 | ✓ | every stage's reference throw, re-flown against the collision set of the world it was made from, scores |
| STAGE-004 | ✓ | every stage regenerated with every surface and landmark moved 0.5 camera-heights (player in place) gives a different stage |

STAGE-001 alone is passed by a template; STAGE-004 is what a template fails.
