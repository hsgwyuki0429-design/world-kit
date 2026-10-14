# Phase 15 — Spatial Collision — test plan

Spec: `Safari Spatial Game v4.0` §33 (Collision Policy), §44, §45. Records `COL-001` …
`COL-004`, implemented in `src/testkit/Phase15Tests.ts`.

## What this phase has to produce

`src/game/collision.ts`: the only surfaces a ball can touch. A world surface becomes a collision
surface when it is classified (`GROUND`, `PLATFORM`, `WALL`, `OBSTACLE_SURFACE`) at confidence
≥ 0.4. `UNKNOWN` never collides (§44: SURFACE UNKNOWN → do not use for collision). A collision
surface is its world surface's **convex hull of observed landmarks**, not an infinite plane: a ball
that rolls off the observed floor falls, because past that edge nobody observed a floor.

Every collision surface carries its provenance — world surface id, epoch, world version, class,
support, confidence — and every contact the physics records names the collision surface it
touched. That chain is §33's *Collision Provenance Logged*.

Materials (restitution and friction per class) are game constants, stated as such; they are not
claimed to be measurements of the room.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| COL-001 | ✓ | ≥ 1 throw; every contact names a surface in the collision set frozen at release |
| COL-002 | ✓ | ≥ 30 per-tick samples of the live collision set: 0 UNKNOWN, 0 below 0.4, 0 from another world version, nothing when the world has no classified surface |
| COL-003 | ✓ | ≥ 1 throw with a contact; re-flown with the collision set emptied, every such throw flies differently |
| COL-004 | — | at least one contact with an observed surface (informational) |

COL-003 is the record a fake cannot pass: a "bounce" animated over a fixed curve flies the same
whether or not the surfaces are there.
