# Phase 21 — Final Audit — test plan

Spec: `Safari Spatial Game v4.0` §6 (Stop Condition), §45 (Absolute Prohibitions), §53, §59
(AIへの実装指示), §60. Records `AUDIT-001` … `AUDIT-003`, implemented in
`src/testkit/Phase21Tests.ts`.

## Two halves, and only one runs on a phone

**The repository half** runs in `npm test` on every commit:

- `scripts/audit-fake-data.mjs` — no `Math.random` in `src/`, no time-driven coverage or
  confidence, no fixed floor/wall/room geometry;
- `scripts/audit-architecture.mjs` — `game/` and `renderer/` cannot import the camera, the
  pipeline, the tracker or the map; `world/` cannot import its consumers;
- `tests/unit/committedEvidence.test.ts` — every committed bundle re-derives its own verdict;
- the unit suites that drive each fake the phases were written to refuse — a template stage
  generator, a validator that accepts everything, a bounce that changes nothing.

**The session half** is this suite.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| AUDIT-001 | ✓ | Phases 0–20 PASSED in this session or carried from an earlier load of this build; none FAILED |
| AUDIT-002 | ✓ | after ≥ 1 throw, every never-counter of the session is zero: integrity issues, READY violations, illegal transitions, replay mismatches, collision violations, UI mismatches, untraced contacts, draw violations, energy violations, steps while frozen |
| AUDIT-003 | ✓ | depth, ARKit and RoomPlan not AVAILABLE; metric scale not AVAILABLE; the world in `LOCAL_UNITS` |
