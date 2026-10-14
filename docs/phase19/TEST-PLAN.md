# Phase 19 — Ball Physics — test plan

Spec: `Safari Spatial Game v4.0` §31 (Ball Interaction Model), §32 (Ball Physics), §50. Records
`BALL-001` … `BALL-004`, implemented in `src/testkit/Phase19Tests.ts`.

## What this phase has to produce

`src/game/physics.ts`: position, velocity, gravity, radius, restitution, friction and collision —
§32's list — on a fixed 240 Hz step, semi-implicit Euler, no randomness, no clock. At the fastest
throw the ball moves half its radius per step, so it cannot tunnel a surface between steps.

**Units (§32).** The world's scale is unknown, and §32 forbids converting to real sizes without
grounds. The one length the world *does* have, in its own units, is the camera's height above the
observed ground. Every game constant is a multiple of it, `H`: ball radius 0.04 H, gravity 7.5 H/s²,
throws 1.2–6 H/s. Nothing claims `H` is any number of metres.

**The throw (§31).** Aim is the camera's own direction lifted 14°; power charges on a 1.4 s
triangle while the screen is held and is released with the touch. The aim guide is the same
physics run ahead, shortened by difficulty.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| BALL-001 | ✓ | every throw replayed from its recorded origin, velocity and frozen collision set gives the same flight, step for step |
| BALL-002 | ✓ | ≥ 1 throw with a contact; kinetic + potential energy never higher after a contact than before (tolerance 1 % of `g·H²`, the position correction's own size) |
| BALL-003 | ✓ | the stage's unit is the measured camera height (> 0); the world reads `LOCAL_UNITS` |
| BALL-004 | — | worst physics time in a display frame ≤ 4 ms |

BALL-001 alone is passed by a canned animation; BALL-002 and COL-003 (Phase 15) are what one fails.
