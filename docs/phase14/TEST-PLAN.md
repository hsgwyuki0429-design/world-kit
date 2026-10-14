# Phase 14 — Save / Resume — test plan

Spec: `Safari Spatial Game v4.0` §41 (No 3D Export Requirement), §42 (Save / Resume), §45.
Records `SAVE-001` … `SAVE-004`, implemented in `src/testkit/Phase14Tests.ts`.

## What resuming can honestly mean

§42 lets the SpatialWorld runtime state, the stage parameters, the goal pose, the game progress
and their confidence and provenance be saved. It does **not** say a saved world can be played on
in a later session, and it cannot be: the world's coordinates are the first keyframe's camera
frame *of that session*, and the landmarks cannot be recognised again — their ids are the
tracker's per-run feature ids, and there are no descriptors. A saved surface placed into a new
session's collision set would be a wall where nobody has looked in this session: §45's "Goal
placed using nonexistent geometry".

So (`src/game/SaveGame.ts`):

- **Saved:** the world's surfaces, gravity, camera height, coverage and confidence; the stage's
  seed, digest, ring and difficulty; the progress (stage index, goals, throws); a provenance
  sentence; a checksum over all of it. Nothing that pretends to be a model (§41).
- **Resumed:** the progress, before the first throw of the new session. The stage sequence
  continues from the saved index **on the room as observed now**. The saved world is carried as
  `relocalized: false` and shown, never ingested into the SpatialWorld or the collision set.
- **Paused in place:** within a session, a pause freezes the ball and keeps the stage.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| SAVE-001 | ✓ | ≥ 1 save; each serialised record parses back identical |
| SAVE-002 | ✓ | on each save, a copy with one digit altered in the world section is refused, and a record carrying a NaN is refused at build |
| SAVE-003 | ✓ | ≥ 1 resume; 0 samples with the restored world in the live collision set; any stage held is of the live epoch |
| SAVE-004 | ✓ | ≥ 1 pause/resume; stage digest and ball identical across it |
