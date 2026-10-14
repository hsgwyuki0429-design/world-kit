# Phase 13 — Spatial Game Viewer — test plan

Spec: `Safari Spatial Game v4.0` §38 (UI / AR Presentation), §39 (SCAN screen), §40 (GAME
screen), §37 (状態とUI表示は必ず一致する), Rule 002. Records `VIEW-001` … `VIEW-005`, implemented
in `src/testkit/Phase13Tests.ts`.

## What this phase has to produce

The camera image with the game drawn on it: observed surfaces, the ring, the ball, the start tee,
the aim guide, the power gauge, the tracking warning (`src/renderer/ArRenderer.ts`,
`src/ui/ArPanel.ts`). Everything drawn is read from the `SpatialWorldView` and the stage generated
from it on that frame; the renderer holds no geometry and cannot import the tracker or the map.

The HUD shows §39's figures — `TRACKING …`, `SURFACES n`, `CONFIDENCE x`, `READY AREA a`,
`COVERAGE c` — all measured, and the game's state in the engine's own words.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| VIEW-001 | ✓ | ≥ 30 frames: the worker's correspondences (tracker pixel + map position) projected through the renderer's own `projectWorld` land within a median 2.5 px of the tracker's pixels |
| VIEW-002 | ✓ | ≥ 60 frames drawn; 0 frames drawing a surface the world does not hold, a ring with no stage, a ball the game does not have, or anything with no pose |
| VIEW-003 | ✓ | ≥ 30 DOM reads: the canvas box's aspect equals the video box's within 1 % (one uniform scale from processing pixels to the screen) |
| VIEW-004 | ✓ | ≥ 30 DOM reads: the tracking label shows the world's tracking state; 0 mismatches |
| VIEW-005 | — | median draw ≤ 6 ms; median display interval ≤ 34 ms |

## Why VIEW-001 is the record that matters

An overlay can look aligned in a screenshot and be wrong by a transpose, a sign, or a frame size.
VIEW-001 is the only check that puts a *known* pixel — where the tracker saw a landmark — beside
the renderer's projection of the same landmark through the world's pose. It is measured in
processing pixels; VIEW-003 then says those map to the screen by one scale.

VIEW-004 and GAME-002 (Phase 16) read the labels back **from the DOM**, after the HUD was updated
from the engine on that frame — the arrangement CAP-0011 established in Phase 0: the grader reads
what is on the screen, not the variable that claims to describe it.
