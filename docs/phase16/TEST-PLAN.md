# Phase 16 — Game Integration — test plan

Spec: `Safari Spatial Game v4.0` §36 (Stage Regeneration), §37 (Game State Machine), §44.
Records `GAME-001` … `GAME-005`, implemented in `src/testkit/Phase16Tests.ts`.

## What this phase has to produce

`src/game/GameSession.ts`: §37's ten states — `SCAN`, `SPATIALIZING`, `STAGE_GENERATING`,
`READY`, `AIMING`, `THROWING`, `SUCCESS`, `RETRY`, `PAUSED`, `TRACKING_LOST` — with an explicit
table of which may follow which. Every transition is recorded with its reason; one outside the
table is counted as a violation rather than allowed quietly.

Driven once per display frame by the SpatialWorld's view and by three touches (press, release,
pause). §36 and §44 as rules of the machine:

- world not READY → no stage is generated (`SCAN` with no map, `SPATIALIZING` after);
- tracking LOST for 300 ms during play → `TRACKING_LOST`, the ball frozen mid-air; back where it
  was when tracking returns in the same epoch; back to `SCAN` if the world was redefined;
- POSE LOW CONFIDENCE → no new stage, no new throw;
- the world updated → the stage re-validated against it, regenerated if a constraint fails
  (*Goal becomes blocked → regenerate goal*).

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| GAME-001 | ✓ | ≥ 5 transitions; 0 outside §37's table |
| GAME-002 | ✓ | ≥ 30 DOM reads of the state badge; 0 differing from the engine's state |
| GAME-003 | ✓ | 0 stages generated on a non-READY world; 0 physics steps while frozen (measured across each freeze); no stale-epoch stage left standing |
| GAME-004 | ✓ | ≥ 1 complete READY → AIMING → THROWING → SUCCESS/RETRY cycle |
| GAME-005 | — | ≥ 1 TRACKING_LOST entry and recovery (informational) |
