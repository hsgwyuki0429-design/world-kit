/**
 * The stage generator (Phase 17, v4 §27, §30, §35, §48).
 *
 * Takes the SpatialWorld as it stands and produces a start point and a goal ring that fit **this
 * room**: §27's rule is that a stage is never shaped to a fixed room, only to the space that was
 * actually observed. §48's test is that the same space and the same inputs produce the same stage,
 * and that is true by construction here — the function is pure, its only randomness is a seeded
 * `Rng`, and the stage carries a digest of the inputs it was made from so the claim can be checked
 * by regenerating it.
 *
 * ## The start (§30)
 *
 * A virtual tee floating in front of the player: 0.3 of the camera height below their eye line
 * and 0.65 of it ahead along the horizontal. It is labelled `VIRTUAL` because it is a game
 * object and §33 forbids passing a game object off as part of the room — nothing collides with it
 * and it is not a surface. It must have free space around it and a clear line to the goal.
 *
 * ## The goal (§28)
 *
 * Candidates are laid out on a grid over every confident GROUND, PLATFORM and WALL surface,
 * inside what was observed of each; a seeded shuffle picks which to examine; each is validated
 * against all of §28's constraints and searched for a scoring throw (`ring.ts`). The first that
 * passes is the stage. A world with no candidate that passes produces **no stage**, with the
 * rejection counts saying why — §35: an obviously unreachable goal is rejected, not shipped.
 */

import { Rng } from '../core/Rng';
import { SurfaceClass } from '../world/SpatialWorld';
import type { SpatialWorldView, Surface } from '../world/SpatialWorld';
import { buildCollisionSet, collisionFromSurfaces, dot, insideHull, segmentBlocked } from './collision';
import type { CollisionSet } from './collision';
import { norm } from './physics';
import type { PhysicsWorld } from './physics';
import {
  RING_RADIUS_H,
  RingKind,
  MIN_SUPPORT_CONFIDENCE,
  validateRing,
} from './ring';
import type { DifficultyAssessment, GoalRing, RingContext, ThrowSolution } from './ring';

/** How far ahead of the player the tee floats, and how far below the eye line, in H. */
export const START_AHEAD_H = 0.65;
export const START_BELOW_H = 0.3;
/** Free space the tee needs around it, H. */
export const START_CLEARANCE_H = 0.15;
/** Candidate grid spacing over a surface, H. */
export const CANDIDATE_SPACING_H = 0.3;
/** Hoop heights above their surface, H. */
export const HOOP_HEIGHTS_H = [0.3, 0.55] as const;
/** Wall targets: how far off the wall, and at which heights above the ground, H. */
export const WALL_STANDOFF_H = 0.3;
export const WALL_HEIGHTS_H = [0.45, 0.8] as const;
/** Candidates that get the full validation, at most — each one runs a throw search. */
export const MAX_EXAMINED = 18;

export interface StagePoint {
  readonly position: readonly number[];
  readonly kind: 'VIRTUAL';
  readonly note: string;
}

export interface Stage {
  readonly seed: number;
  readonly epoch: number;
  readonly worldVersion: number;
  /** Digest of everything the stage was made from — STAGE-001 regenerates and compares. */
  readonly inputDigest: string;
  readonly digest: string;
  readonly unit: number;
  readonly down: readonly number[];
  readonly start: StagePoint;
  readonly viewer: readonly number[];
  readonly viewerForward: readonly number[];
  readonly ring: GoalRing;
  readonly difficulty: DifficultyAssessment;
  readonly solution: ThrowSolution;
  readonly solutions: number;
  /** The world surfaces this stage depends on — its own support, and everything it collides with. */
  readonly surfaceIds: readonly number[];
}

export interface StageResult {
  readonly stage: Stage | null;
  readonly reason: string;
  readonly candidates: number;
  readonly examined: number;
  readonly rejections: Record<string, number>;
  readonly inputDigest: string;
  readonly ms: number;
}

/** What the generator needs from the world, and nothing more — what the digest is taken over. */
export interface StageInputs {
  readonly epoch: number;
  readonly worldVersion: number;
  readonly unit: number;
  readonly down: readonly number[];
  readonly viewer: readonly number[];
  readonly viewerForward: readonly number[];
  readonly surfaces: readonly Surface[];
  readonly landmarks: readonly (readonly number[])[];
}

export function stageInputsFrom(view: SpatialWorldView): StageInputs | null {
  if (!view.cameraPose || !view.gravity.worldDown || !(view.cameraHeight > 0)) return null;
  return {
    epoch: view.epoch,
    worldVersion: view.version,
    unit: view.cameraHeight,
    down: view.gravity.worldDown,
    viewer: view.cameraPose.center,
    viewerForward: view.cameraPose.forward,
    surfaces: view.surfaces,
    landmarks: view.landmarks.filter((l) => l.confirmed).map((l) => l.position),
  };
}

export function physicsWorldFor(inputs: StageInputs, collision: CollisionSet): PhysicsWorld {
  return { unit: inputs.unit, down: inputs.down, collision };
}

/** Generate from the live world. */
export function generateStage(view: SpatialWorldView, seed: number, now: () => number = () => 0): StageResult {
  const inputs = stageInputsFrom(view);
  if (!inputs) {
    return {
      stage: null,
      reason: 'the world has no camera pose, no gravity or no camera height — a stage needs all three (v4 §44)',
      candidates: 0,
      examined: 0,
      rejections: {},
      inputDigest: '',
      ms: 0,
    };
  }
  return generateFromInputs(inputs, buildCollisionSet(view), seed, now);
}

export function generateFromInputs(
  inputs: StageInputs,
  collision: CollisionSet,
  seed: number,
  now: () => number = () => 0,
): StageResult {
  const t0 = now();
  const inputDigest = digestOf({ inputs, collision: collision.surfaces.map((s) => s.id), seed });
  const u = inputs.unit;
  const up = inputs.down.map((v) => -v);
  const physics = physicsWorldFor(inputs, collision);
  const rejections: Record<string, number> = {};
  const reject = (why: string): void => {
    rejections[why] = (rejections[why] ?? 0) + 1;
  };

  // §30: the tee.
  const flatForward = inputs.viewerForward.map((x, i) => x - dot(inputs.viewerForward, up) * (up[i] ?? 0));
  const ff = norm(flatForward);
  if (ff < 0.2) {
    return failure('the player is looking straight up or down — there is no "ahead" to put the start in', inputDigest, t0, now);
  }
  const ahead = flatForward.map((x) => x / ff);
  const start = inputs.viewer.map((x, i) => x + (ahead[i] ?? 0) * START_AHEAD_H * u - (up[i] ?? 0) * START_BELOW_H * u);
  for (const s of collision.surfaces) {
    const d = dot(s.normal, start) - s.offset;
    if (Math.abs(d) < START_CLEARANCE_H * u && insideHull(s, start)) {
      return failure(`the start would be within ${START_CLEARANCE_H} H of surface ${s.id} — not enough free space (§30)`, inputDigest, t0, now);
    }
  }

  const candidates = candidateRings(inputs, collision);
  if (candidates.length === 0) {
    return failure('no confident GROUND, PLATFORM or WALL surface has room for a ring', inputDigest, t0, now, 0);
  }

  // A seeded shuffle decides the order candidates are examined in — the only thing the seed does.
  const rng = new Rng(seed);
  const order = candidates.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = order[i] ?? 0;
    order[i] = order[j] ?? 0;
    order[j] = tmp;
  }

  const ctx: RingContext = {
    physics,
    start,
    viewer: inputs.viewer,
    viewerForward: inputs.viewerForward,
    surfaces: inputs.surfaces.map((s) => ({ id: s.id, confidence: s.confidence, surfaceClass: s.surfaceClass })),
    landmarks: inputs.landmarks,
  };

  let examined = 0;
  for (const index of order) {
    if (examined >= MAX_EXAMINED) break;
    const ring = candidates[index];
    if (!ring) continue;
    // The line from the start must be clear too, not only the one from the eye.
    if (segmentBlocked(collision, start, ring.center, new Set([ring.supportSurfaceId]))) {
      reject('START_BLOCKED');
      continue;
    }
    examined++;
    const v = validateRing(ring, ctx);
    if (!v.valid || !v.assessment) {
      for (const f of v.failures) reject(f);
      continue;
    }
    // Of the scoring throws, the slowest direct one is the stage's reference solution.
    const solution = [...v.solutions].sort((a, b) => a.bounces - b.bounces || a.speed - b.speed)[0];
    if (!solution) {
      reject('REACH');
      continue;
    }
    const surfaceIds = [...new Set([ring.supportSurfaceId, ...collision.surfaces.map((s) => s.id)])].sort((a, b) => a - b);
    const body = {
      seed,
      epoch: inputs.epoch,
      worldVersion: inputs.worldVersion,
      inputDigest,
      unit: round(u, 6),
      down: inputs.down,
      start: {
        position: start.map((x) => round(x, 6)),
        kind: 'VIRTUAL' as const,
        note: 'a game object floating in front of the player, not part of the room and not a collision surface (§33)',
      },
      viewer: inputs.viewer,
      viewerForward: inputs.viewerForward,
      ring,
      difficulty: v.assessment,
      solution,
      solutions: v.solutions.length,
      surfaceIds,
    };
    return {
      stage: { ...body, digest: digestOf(body) },
      reason: `ring on surface ${ring.supportSurfaceId} (${ring.supportClass}), ${v.assessment.difficulty}: ${v.assessment.reason}`,
      candidates: candidates.length,
      examined,
      rejections,
      inputDigest,
      ms: round(now() - t0, 3),
    };
  }
  return {
    stage: null,
    reason: `none of ${examined} examined candidate(s) out of ${candidates.length} satisfied every constraint: ${JSON.stringify(rejections)}`,
    candidates: candidates.length,
    examined,
    rejections,
    inputDigest,
    ms: round(now() - t0, 3),
  };
}

/** Rings laid out over every confident surface that can hold one, inside what was observed of it. */
export function candidateRings(inputs: StageInputs, collision: CollisionSet): GoalRing[] {
  const u = inputs.unit;
  const up = inputs.down.map((v) => -v);
  const radius = RING_RADIUS_H * u;
  const out: GoalRing[] = [];
  const ground = collision.surfaces.filter((s) => s.surfaceClass === SurfaceClass.GROUND);
  const groundLevel = ground.length > 0 ? Math.min(...ground.map((s) => dot(up, s.origin))) : null;

  for (const s of collision.surfaces) {
    const record = inputs.surfaces.find((x) => x.id === s.id);
    if (!record || record.confidence < MIN_SUPPORT_CONFIDENCE) continue;
    const spacing = CANDIDATE_SPACING_H * u;
    const xs = s.polygon2d.map((p) => p[0] ?? 0);
    const ys = s.polygon2d.map((p) => p[1] ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    for (let gx = Math.ceil(minX / spacing) * spacing; gx <= maxX; gx += spacing) {
      for (let gy = Math.ceil(minY / spacing) * spacing; gy <= maxY; gy += spacing) {
        const onPlane = s.origin.map((o, i) => o + gx * (s.basisU[i] ?? 0) + gy * (s.basisV[i] ?? 0));
        if (s.surfaceClass === SurfaceClass.GROUND || s.surfaceClass === SurfaceClass.PLATFORM) {
          if (!insideHull(s, onPlane, radius)) continue;
          for (const h of HOOP_HEIGHTS_H) {
            out.push({
              kind: RingKind.HOOP,
              center: onPlane.map((x, i) => round(x + (up[i] ?? 0) * h * u, 6)),
              axis: inputs.down.map((x) => round(x, 6)),
              radius: round(radius, 6),
              supportSurfaceId: s.id,
              supportClass: s.surfaceClass,
              standoff: round(h * u, 6),
            });
          }
        } else if (s.surfaceClass === SurfaceClass.WALL && groundLevel !== null) {
          if (!insideHull(s, onPlane, radius * 0.5)) continue;
          const height = dot(up, onPlane) - groundLevel;
          if (!WALL_HEIGHTS_H.some((h) => Math.abs(height - h * u) < spacing / 2)) continue;
          const center = onPlane.map((x, i) => x + (s.normal[i] ?? 0) * WALL_STANDOFF_H * u);
          out.push({
            kind: RingKind.WALL_TARGET,
            center: center.map((x) => round(x, 6)),
            axis: s.normal.map((x) => round(-x, 6)),
            radius: round(radius, 6),
            supportSurfaceId: s.id,
            supportClass: s.surfaceClass,
            standoff: round(WALL_STANDOFF_H * u, 6),
          });
        }
      }
    }
  }
  return out;
}

/**
 * Is a stage still valid in a world that has moved on (§36)?
 *
 * Its support surface must still exist in the same epoch, and the ring must still satisfy every
 * constraint against the *new* collision set — a surface found since may now be in the way.
 */
export function revalidateStage(stage: Stage, view: SpatialWorldView): { valid: boolean; reason: string } {
  if (view.epoch !== stage.epoch) return { valid: false, reason: `the world was redefined (epoch ${stage.epoch} → ${view.epoch})` };
  const support = view.surfaces.find((s) => s.id === stage.ring.supportSurfaceId);
  if (!support) return { valid: false, reason: `support surface ${stage.ring.supportSurfaceId} is no longer observed` };
  const collision = buildCollisionSet(view);
  const physics: PhysicsWorld = { unit: stage.unit, down: stage.down, collision };
  const v = validateRing(
    stage.ring,
    {
      physics,
      start: stage.start.position,
      viewer: stage.viewer,
      viewerForward: stage.viewerForward,
      surfaces: view.surfaces.map((s) => ({ id: s.id, confidence: s.confidence, surfaceClass: s.surfaceClass })),
      landmarks: view.landmarks.filter((l) => l.confirmed).map((l) => l.position),
    },
    40,
  );
  return v.valid
    ? { valid: true, reason: 'every constraint still holds against the current world' }
    : { valid: false, reason: `${v.failures.join(', ')}: ${v.detail.join('; ')}` };
}

function failure(reason: string, inputDigest: string, t0: number, now: () => number, candidates = 0): StageResult {
  return { stage: null, reason, candidates, examined: 0, rejections: {}, inputDigest, ms: round(now() - t0, 3) };
}

/** FNV-1a over the canonical JSON — enough to tell two inputs apart, never used for security. */
export function digestOf(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}


/* -------------------------------------------------------------------------- */
/* The generator's controls — what STAGE-004 and RING-002 are measured with     */
/* -------------------------------------------------------------------------- */

/**
 * STAGE-004: the same inputs with every surface and landmark moved by `shift`, the player left
 * where they stand. A generator that depends on the room produces a different stage; one that
 * placed rings from a template would not notice.
 */
export function shiftedInputs(inputs: StageInputs, shift: readonly number[]): StageInputs {
  const move = (p: readonly number[]): number[] => p.map((x, i) => x + (shift[i] ?? 0));
  return {
    ...inputs,
    surfaces: inputs.surfaces.map((s) => ({
      ...s,
      centroid: move(s.centroid),
      polygon: s.polygon.map(move),
      offset: s.offset + dot(s.normal, shift),
    })),
    landmarks: inputs.landmarks.map(move),
  };
}

export interface StageControl {
  /** The shifted room produced a different stage — or none, which is also a difference. */
  readonly differs: boolean;
  readonly shiftH: number;
  readonly ringMovedH: number;
  readonly detail: string;
}

export function stageControl(inputs: StageInputs, stage: Stage, seed: number): StageControl {
  const up = inputs.down.map((v) => -v);
  // Horizontal, along the player's view: half the camera height.
  const flat = inputs.viewerForward.map((x, i) => x - dot(inputs.viewerForward, up) * (up[i] ?? 0));
  const n = norm(flat) || 1;
  const shift = flat.map((x) => (x / n) * 0.5 * inputs.unit);
  const moved = shiftedInputs(inputs, shift);
  const result = generateFromInputs(moved, collisionFromSurfaces(moved.surfaces, inputs.epoch, inputs.worldVersion), seed);
  if (!result.stage) {
    return { differs: true, shiftH: 0.5, ringMovedH: -1, detail: `the shifted room produced no stage: ${result.reason}` };
  }
  const moveH = norm(result.stage.ring.center.map((x, i) => x - (stage.ring.center[i] ?? 0))) / inputs.unit;
  return {
    differs: result.stage.digest !== stage.digest,
    shiftH: 0.5,
    ringMovedH: round(moveH, 4),
    detail: `the ring moved ${round(moveH, 3)} H when the room moved 0.5 H`,
  };
}

export interface RejectionControl {
  readonly offered: number;
  /** Each synthetic invalid ring the validator accepted, by kind — must be empty. */
  readonly accepted: readonly string[];
  readonly detail: readonly string[];
}

/**
 * RING-002: rings that break §28 by construction, offered to the same validator the generator
 * uses. One inside its support surface, one over ground nobody observed, one in the middle of the
 * landmarks a real object left. Each must be refused for the reason it was built to fail.
 */
export function rejectionControl(inputs: StageInputs, stage: Stage): RejectionControl {
  const collision = collisionFromSurfaces(inputs.surfaces, inputs.epoch, inputs.worldVersion);
  const physics = physicsWorldFor(inputs, collision);
  const ctx: RingContext = {
    physics,
    start: stage.start.position,
    viewer: inputs.viewer,
    viewerForward: inputs.viewerForward,
    surfaces: inputs.surfaces.map((s) => ({ id: s.id, confidence: s.confidence, surfaceClass: s.surfaceClass })),
    landmarks: inputs.landmarks,
  };
  const support = collision.surfaces.find((s) => s.id === stage.ring.supportSurfaceId);
  const accepted: string[] = [];
  const detail: string[] = [];
  let offered = 0;
  const offer = (kind: string, ring: GoalRing, expected: string): void => {
    offered++;
    const v = validateRing(ring, ctx, 20);
    if (v.valid || !v.failures.includes(expected)) {
      accepted.push(kind);
      detail.push(`${kind}: expected ${expected}, got ${v.valid ? 'VALID' : v.failures.join('+')}`);
    }
  };
  if (support) {
    const onPlane = stage.ring.center.map((x, i) => x - (support.normal[i] ?? 0) * (dot(support.normal, stage.ring.center) - support.offset));
    offer('EMBEDDED', { ...stage.ring, center: onPlane, axis: support.normal.map((x) => -x) }, 'EMBEDDED');
    const away = stage.ring.center.map((x, i) => x + (support.basisU[i] ?? 0) * 40 * inputs.unit);
    offer('UNOBSERVED', { ...stage.ring, center: away }, 'SUPPORT');
  }
  // The densest landmark neighbourhood: where something real certainly is.
  let best: readonly number[] | null = null;
  let bestCount = 0;
  const r = stage.ring.radius;
  for (let i = 0; i < inputs.landmarks.length; i += Math.max(1, Math.floor(inputs.landmarks.length / 60))) {
    const p = inputs.landmarks[i];
    if (!p) continue;
    let count = 0;
    for (const q of inputs.landmarks) if (norm(q.map((x, k) => x - (p[k] ?? 0))) < r) count++;
    if (count > bestCount) {
      bestCount = count;
      best = p;
    }
  }
  if (best && bestCount > 0) offer('OCCUPIED', { ...stage.ring, center: best }, 'OCCUPIED');
  return { offered, accepted, detail };
}
