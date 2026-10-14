/**
 * The goal ring (Phase 18, v4 §28, §29, §34, §49).
 *
 * §28: the ring is **not** put anywhere convenient in the air. Its position, orientation, size and
 * difficulty come from the SpatialWorld's observed surfaces and from where the player stands, and
 * §49's test is that a ring inside a real object, or in a region the world is not confident
 * about, is rejected. Every check below is one of §28's five constraints, and every rejection
 * names which.
 *
 * ## Two kinds of ring
 *
 *  - **HOOP** — horizontal, floating above a GROUND or PLATFORM surface. The ball must pass down
 *    through it, the way a basket is scored.
 *  - **WALL_TARGET** — vertical, standing just off a WALL and facing the player. The ball must
 *    pass through toward the wall.
 *
 * ## Difficulty is a consequence, not a dial (§29)
 *
 * The validator searches for throws that score, with the same physics and the same collision set
 * the game will use. Difficulty is read off what it found: how far, how much height to make up,
 * and whether every throw that scores needed a bounce off an observed surface. A seed cannot make
 * a ring HARD; only the room can.
 */

import { dot, insideHull, planeDistance, segmentBlocked, sub } from './collision';
import type { CollisionSurface } from './collision';
import {
  BALL_RADIUS_H,
  FlightOutcome,
  GRAVITY_H,
  MAX_SPEED_H,
  MIN_SPEED_H,
  norm,
  simulateThrow,
} from './physics';
import type { Flight, GoalDisc, PhysicsWorld } from './physics';

/* -------------------------------------------------------------------------- */
/* Constraints — fixed in docs/phase18/TEST-PLAN.md before this file existed    */
/* -------------------------------------------------------------------------- */

export const RING_RADIUS_H = 0.14;
/** A ring's support surface must be at least this confident (§28: 十分なConfidenceのある空間内). */
export const MIN_SUPPORT_CONFIDENCE = 0.5;
/** Clearance the ring must keep from every observed surface, beyond the ball's radius, in H. */
export const CLEARANCE_H = 0.04;
/** Horizontal distance from the start the ring may be placed at, H. */
export const MIN_DISTANCE_H = 0.8;
export const MAX_DISTANCE_H = 4.0;
/** How far off the player's view the ring may be at generation, degrees (§28: 視認可能な位置). */
export const MAX_VIEW_ANGLE_DEG = 55;
/** Confirmed landmarks inside the ring's opening mean something real is there. */
export const MAX_LANDMARKS_IN_OPENING = 0;

export const RingKind = {
  HOOP: 'HOOP',
  WALL_TARGET: 'WALL_TARGET',
} as const;
export type RingKind = (typeof RingKind)[keyof typeof RingKind];

export const Difficulty = {
  EASY: 'EASY',
  NORMAL: 'NORMAL',
  HARD: 'HARD',
  EXPERT: 'EXPERT',
} as const;
export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

export interface GoalRing {
  readonly kind: RingKind;
  readonly center: readonly number[];
  /** The direction the ball must travel through the ring. */
  readonly axis: readonly number[];
  readonly radius: number;
  /** The world surface it stands on or off. */
  readonly supportSurfaceId: number;
  readonly supportClass: string;
  /** Height of the ring's centre above the surface it stands on (hoop) or off the wall (target), world units. */
  readonly standoff: number;
}

export interface ThrowSolution {
  readonly velocity: readonly number[];
  readonly speed: number;
  readonly bounces: number;
  readonly bounceSurfaces: readonly number[];
  readonly flightTime: number;
}

export interface DifficultyAssessment {
  readonly difficulty: Difficulty;
  readonly reason: string;
  readonly distanceH: number;
  readonly riseH: number;
  readonly minBounces: number;
  readonly solutions: number;
}

export interface RingValidation {
  readonly valid: boolean;
  /** Each failed constraint by name — SUPPORT, EMBEDDED, OCCUPIED, DISTANCE, VISIBILITY, LINE_OF_SIGHT, REACH. */
  readonly failures: readonly string[];
  readonly detail: readonly string[];
  readonly solutions: readonly ThrowSolution[];
  readonly assessment: DifficultyAssessment | null;
}

export interface RingContext {
  readonly physics: PhysicsWorld;
  readonly start: readonly number[];
  /** Where the player's camera was, and where it looked, when the stage was generated. */
  readonly viewer: readonly number[];
  readonly viewerForward: readonly number[];
  readonly surfaces: readonly { readonly id: number; readonly confidence: number; readonly surfaceClass: string }[];
  /** Confirmed landmark positions — the occupancy check (§28: 現実物体内部へ埋め込まない). */
  readonly landmarks: readonly (readonly number[])[];
}

/** The disc the physics checks: the ring's opening, less the ball's radius so the ball fits through. */
export function goalDiscOf(ring: GoalRing, unit: number): GoalDisc {
  return { center: ring.center, axis: ring.axis, radius: Math.max(0, ring.radius - BALL_RADIUS_H * unit) };
}

/**
 * Every §28 constraint, then the reach search. Cheap checks first, so the search — the one
 * expensive step — only runs on a ring that could be valid.
 */
export function validateRing(ring: GoalRing, ctx: RingContext, searchBudget = SEARCH_BUDGET): RingValidation {
  const failures: string[] = [];
  const detail: string[] = [];
  const u = ctx.physics.unit;
  const up = ctx.physics.down.map((v) => -v);
  const collision = ctx.physics.collision;

  // SUPPORT — on a surface the world is confident about, inside what was observed of it.
  const support = collision.surfaces.find((s) => s.id === ring.supportSurfaceId);
  const supportRecord = ctx.surfaces.find((s) => s.id === ring.supportSurfaceId);
  if (!support || !supportRecord || supportRecord.confidence < MIN_SUPPORT_CONFIDENCE) {
    failures.push('SUPPORT');
    detail.push(
      `support surface ${ring.supportSurfaceId} is ${support ? `at confidence ${supportRecord?.confidence ?? '?'}` : 'not a collision surface in this world'}, below ${MIN_SUPPORT_CONFIDENCE}`,
    );
  } else if (!insideHull(support, ring.center, ring.kind === RingKind.HOOP ? ring.radius * 0.5 : 0)) {
    failures.push('SUPPORT');
    detail.push('the ring does not stand over the observed part of its support surface');
  }

  // EMBEDDED — the ring's rim keeps its clearance from every observed surface.
  const clearance = BALL_RADIUS_H * u + CLEARANCE_H * u;
  for (const s of collision.surfaces) {
    if (ringTouches(ring, s, clearance)) {
      failures.push('EMBEDDED');
      detail.push(`the ring passes within ${round(clearance / u, 3)} H of surface ${s.id} (${s.surfaceClass})`);
      break;
    }
  }

  // OCCUPIED — no confirmed landmark inside the opening or just behind it.
  const occupants = ctx.landmarks.filter((p) => {
    const d = sub(p, ring.center);
    const along = dot(d, ring.axis);
    if (Math.abs(along) > ring.radius) return false;
    const radial = norm(d.map((x, i) => x - along * (ring.axis[i] ?? 0)));
    return radial < ring.radius;
  }).length;
  if (occupants > MAX_LANDMARKS_IN_OPENING) {
    failures.push('OCCUPIED');
    detail.push(`${occupants} observed landmark(s) lie inside the ring's volume — something real is there`);
  }

  // DISTANCE — aimable from the start.
  const offset = sub(ring.center, ctx.start);
  const horizontal = norm(offset.map((x, i) => x - dot(offset, up) * (up[i] ?? 0)));
  if (horizontal < MIN_DISTANCE_H * u || horizontal > MAX_DISTANCE_H * u) {
    failures.push('DISTANCE');
    detail.push(`${round(horizontal / u, 2)} H from the start, outside ${MIN_DISTANCE_H}–${MAX_DISTANCE_H} H`);
  }

  // VISIBILITY — in front of the player when the stage was made.
  const toRing = sub(ring.center, ctx.viewer);
  const cos = dot(toRing, ctx.viewerForward) / Math.max(1e-12, norm(toRing) * norm(ctx.viewerForward));
  const viewAngle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  if (viewAngle > MAX_VIEW_ANGLE_DEG) {
    failures.push('VISIBILITY');
    detail.push(`${round(viewAngle, 1)}° off the player's view, past ${MAX_VIEW_ANGLE_DEG}°`);
  }

  // LINE_OF_SIGHT — nothing observed between the player and the ring.
  const blocker = segmentBlocked(collision, ctx.viewer, ring.center, new Set([ring.supportSurfaceId]));
  if (blocker) {
    failures.push('LINE_OF_SIGHT');
    detail.push(`surface ${blocker.id} (${blocker.surfaceClass}) stands between the player and the ring`);
  }

  if (failures.length > 0) return { valid: false, failures, detail, solutions: [], assessment: null };

  // REACH — at least one throw within the speed range scores (§35: plausible trajectory).
  const solutions = searchThrows(ring, ctx, searchBudget);
  if (solutions.length === 0) {
    return {
      valid: false,
      failures: ['REACH'],
      detail: [`no throw from the start between ${MIN_SPEED_H} and ${MAX_SPEED_H} H/s passes through the ring`],
      solutions,
      assessment: null,
    };
  }
  return { valid: true, failures: [], detail: [], solutions, assessment: assessDifficulty(ring, ctx, solutions) };
}

const SEARCH_BUDGET = 160;

/**
 * Throws that score: aim at the ring directly, and at its mirror image in each nearby wall for a
 * one-bounce shot, over a ladder of speeds — each launch angle solved in closed form for the
 * ballistic arc, then *simulated* with the real collision set, because the closed form knows
 * nothing about what is in the way.
 */
export function searchThrows(ring: GoalRing, ctx: RingContext, budget = SEARCH_BUDGET): ThrowSolution[] {
  const u = ctx.physics.unit;
  const g = GRAVITY_H * u;
  const down = ctx.physics.down;
  const up = down.map((v) => -v);
  const disc = goalDiscOf(ring, u);
  // Aim a little before the ring along its axis, so the arc arrives travelling through it.
  const aim = ring.center.map((x, i) => x - (ring.axis[i] ?? 0) * ring.radius * 0.3);
  const targets: { point: number[]; mirror: CollisionSurface | null }[] = [{ point: aim, mirror: null }];
  for (const s of ctx.physics.collision.surfaces) {
    if (s.surfaceClass !== 'WALL' && s.surfaceClass !== 'OBSTACLE_SURFACE') continue;
    const d = planeDistance(s, aim);
    if (d <= 0) continue;
    targets.push({ point: aim.map((x, i) => x - 2 * d * (s.normal[i] ?? 0)), mirror: s });
  }

  const solutions: ThrowSolution[] = [];
  let tried = 0;
  const speeds = 10;
  for (const target of targets) {
    const delta = sub(target.point, ctx.start);
    const rise = dot(delta, up);
    const flat = delta.map((x, i) => x - rise * (up[i] ?? 0));
    const range = norm(flat);
    if (range < 1e-9) continue;
    const heading = flat.map((x) => x / range);
    for (let k = 0; k < speeds && tried < budget; k++) {
      const speed = (MIN_SPEED_H + ((MAX_SPEED_H - MIN_SPEED_H) * k) / (speeds - 1)) * u;
      // tan θ = (v² ± √(v⁴ − g(g x² + 2 y v²))) / (g x)
      const disc2 = speed ** 4 - g * (g * range * range + 2 * rise * speed * speed);
      if (disc2 < 0) continue;
      for (const sign of [-1, 1]) {
        if (tried >= budget) break;
        const tan = (speed * speed + sign * Math.sqrt(disc2)) / (g * range);
        const theta = Math.atan(tan);
        const velocity = heading.map((x, i) => (x * Math.cos(theta) + (up[i] ?? 0) * Math.sin(theta)) * speed);
        tried++;
        const flight = simulateThrow(ctx.physics, ctx.start, velocity, disc);
        if (flight.outcome !== FlightOutcome.GOAL) continue;
        solutions.push(solutionOf(velocity, speed, flight));
      }
    }
  }
  return solutions;
}

function solutionOf(velocity: readonly number[], speed: number, flight: Flight): ThrowSolution {
  const crossingStep = flight.crossing?.step ?? flight.steps;
  const before = flight.contacts.filter((c) => c.step <= crossingStep);
  return {
    velocity: velocity.map((v) => round(v, 6)),
    speed: round(speed, 6),
    bounces: before.length,
    bounceSurfaces: before.map((c) => c.surfaceId),
    flightTime: round(flight.crossing?.time ?? flight.duration, 4),
  };
}

/** §29, from what the search found. */
export function assessDifficulty(
  ring: GoalRing,
  ctx: RingContext,
  solutions: readonly ThrowSolution[],
): DifficultyAssessment {
  const u = ctx.physics.unit;
  const up = ctx.physics.down.map((v) => -v);
  const offset = sub(ring.center, ctx.start);
  const rise = dot(offset, up) / u;
  const distance = norm(offset.map((x, i) => x - dot(offset, up) * (up[i] ?? 0))) / u;
  const minBounces = Math.min(...solutions.map((s) => s.bounces));
  let difficulty: Difficulty;
  let reason: string;
  if (minBounces >= 2) {
    difficulty = Difficulty.EXPERT;
    reason = `every scoring throw found uses ${minBounces} or more bounces off observed surfaces`;
  } else if (minBounces === 1) {
    difficulty = Difficulty.HARD;
    reason = 'every scoring throw found bounces off an observed surface first';
  } else if (ring.supportClass === 'PLATFORM' || Math.abs(rise) > 0.6 || distance > 2.6 || solutions.length <= 2) {
    difficulty = Difficulty.NORMAL;
    reason =
      `a direct throw scores, but ${ring.supportClass === 'PLATFORM' ? 'on a raised surface' : ''}` +
      `${Math.abs(rise) > 0.6 ? ` ${round(rise, 2)} H of height to make up` : ''}` +
      `${distance > 2.6 ? ` at ${round(distance, 2)} H` : ''}` +
      `${solutions.length <= 2 ? ` with only ${solutions.length} scoring throw(s) found` : ''}`;
  } else {
    difficulty = Difficulty.EASY;
    reason =
      `${ring.kind === RingKind.HOOP ? 'a hoop on the ground' : 'a target on the wall'} ` +
      `${round(distance, 2)} H away; ${solutions.length} direct throws score`;
  }
  return {
    difficulty,
    reason: reason.replace(/\s+/g, ' ').trim(),
    distanceH: round(distance, 3),
    riseH: round(rise, 3),
    minBounces,
    solutions: solutions.length,
  };
}

/** Does the ring's rim come within `clearance` of the observed part of `s`? */
function ringTouches(ring: GoalRing, s: CollisionSurface, clearance: number): boolean {
  const d = planeDistance(s, ring.center);
  const cosine = Math.abs(dot(ring.axis, s.normal));
  const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  // Nearest the rim gets to the plane, measured along the plane's normal.
  if (Math.abs(d) - ring.radius * sine > clearance) return false;
  // Close to the plane: does it come close over the observed hull? Sample the rim.
  const [a, b] = perpendiculars(ring.axis);
  for (let k = 0; k < 16; k++) {
    const t = (k / 16) * Math.PI * 2;
    const p = ring.center.map((x, i) => x + ring.radius * (Math.cos(t) * (a[i] ?? 0) + Math.sin(t) * (b[i] ?? 0)));
    if (Math.abs(planeDistance(s, p)) <= clearance && insideHull(s, p)) return true;
  }
  return Math.abs(d) <= clearance && insideHull(s, ring.center);
}

export function perpendiculars(axis: readonly number[]): [number[], number[]] {
  const helper = Math.abs(axis[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a0 = cross(axis, helper);
  const la = norm(a0) || 1;
  const a = a0.map((x) => x / la);
  const b = cross(axis, a);
  return [a, b];
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
