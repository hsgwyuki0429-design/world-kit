# Phase 18 — Goal Ring System — test plan

Spec: `Safari Spatial Game v4.0` §28 (Goal Ring Generation), §29 (Goal Difficulty), §34 (Goal
Collision / Success), §49. Records `RING-001` … `RING-004`, implemented in
`src/testkit/Phase18Tests.ts`.

## What this phase has to produce

`src/game/ring.ts`. Two kinds of ring: a horizontal **HOOP** floating above a GROUND or PLATFORM
surface, scored by passing down through it; a vertical **WALL_TARGET** standing 0.3 camera-heights
off a WALL, scored by passing through toward the wall. Ring radius 0.14 H; the opening the ball's
centre must cross is that less the ball's radius.

§28's constraints, each named in every rejection:

| Name | Rule |
| --- | --- |
| `SUPPORT` | the support surface is a collision surface at confidence ≥ 0.5, and the ring stands over the observed part of it |
| `EMBEDDED` | the rim keeps ball radius + 0.04 H from every observed surface |
| `OCCUPIED` | no confirmed landmark inside the ring's volume — something real is there |
| `DISTANCE` | 0.8–4.0 H horizontally from the start |
| `VISIBILITY` | within 55° of the player's view when generated |
| `LINE_OF_SIGHT` | no observed surface between the player and the ring |
| `REACH` | a throw between 1.2 and 6 H/s, simulated with the real physics and collision set, scores (§35) |

**Difficulty (§29) is read off what the reach search found**, never drawn: EXPERT when every
scoring throw needs ≥ 2 bounces off observed surfaces, HARD when every one needs a bounce, NORMAL
for a raised surface, > 0.6 H of rise, > 2.6 H of distance or ≤ 2 scoring throws, EASY otherwise.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| RING-001 | ✓ | the chosen ring passed every constraint; the rejected candidates are counted by reason |
| RING-002 | ✓ | on every stage, three rings built to fail — embedded in the support, over unobserved ground, inside the densest landmarks — are each refused for that reason |
| RING-003 | ✓ | the held stage's difficulty is the one the rule gives for its recorded distance, rise, bounces and solutions |
| RING-004 | ✓ | ≥ 1 goal; every GOAL has a crossing inside the opening; no other outcome has one |

RING-002 is the record a permissive validator fails: it is offered rings it must refuse.
