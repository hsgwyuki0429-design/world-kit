# Phase 20 — Gameplay Validation — test plan

Spec: `Safari Spatial Game v4.0` §51 (Gameplay Validation), §52 (Golden Gameplay Test), §53
(Golden Gameplay Success), §54 (Testing Evidence). Records `PLAY-001` … `PLAY-003`, implemented in
`src/testkit/Phase20Tests.ts`.

## What this phase has to show

§52's sequence, in a real room, on the device, in one session:

> Safari起動 → Capability Check → Camera Permission → 部屋をゆっくり観測 → Tracking成立 →
> Surface取得 → SpatialWorld READY → Stage Generation → Ring生成 → Ball AIM → THROW →
> Spatial Collision → Ring Hit → SUCCESS

and every condition of §53 under it. Both are read off the session's own record — the game's
transitions, the throws, the collision record, and Phases 11–19's records evaluated from the same
context on this screen.

## Records

| ID | Req | Pass criteria |
| --- | --- | --- |
| PLAY-001 | ✓ | `STAGE_GENERATING → READY → AIMING → THROWING → SUCCESS` appears as a contiguous run of transitions, and the session scanned first |
| PLAY-002 | ✓ | every required record of Phases 11–19 PASS in this session; ≥ 1 goal; ≥ 1 throw with a contact on an observed surface; 0 collision violations |
| PLAY-003 | ✓ | every scoring throw, re-flown at the same ring moved 2.5 radii off its axis, misses |

PLAY-003 is §53's *Success depends on entering the generated goal*, as a measurement.

## Evidence (§54)

The Phase 20 bundle carries the screenshot-able state, the metrics of every stage, the throws with
their contacts and crossings, the state transitions, and the collision provenance. The real-device
recording §54 asks for is the tester's screen recording of the run, committed beside the bundle.
