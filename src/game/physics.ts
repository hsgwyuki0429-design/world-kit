/**
 * Ball physics (Phase 19, v4 §32, §50).
 *
 * Position, velocity, gravity, radius, restitution, friction and collision — §32's list — on a
 * fixed time step, with no randomness and no clock. §50's test is that the same throw into the
 * same world produces the same flight, and that is true here by construction: `simulateThrow` is
 * a pure function of its arguments, and the game replays every throw it records to prove it.
 *
 * ## Units: the camera's height, never a metre
 *
 * §32: when the world's scale is unknown, keep the ball and the world in one consistent local unit
 * and do not convert to real sizes without grounds. The world is in units of a keyframe pair's
 * baseline, which has no length. What it *does* have is the camera's height above the observed
 * ground, measured in those same units — so every game constant here is a multiple of that
 * height, `H`. A ball of radius `0.04 H`, gravity of `7.5 H/s²`, a throw of up to `6 H/s`. Nothing
 * claims `H` is any particular number of metres; the constants were chosen so that a phone held
 * at a person's chest gives a ball the size of a fist that falls the way a ball does.
 *
 * ## The step
 *
 * Semi-implicit Euler at 240 Hz. At the fastest throw the ball moves `0.025 H` per step, half its
 * own radius, so it cannot tunnel through a surface between two steps; the plane-crossing test
 * catches the remaining case of a ball already inside the band.
 */

import { dot, insideHull, planeDistance } from './collision';
import type { CollisionSet, CollisionSurface } from './collision';

/* -------------------------------------------------------------------------- */
/* Constants — in multiples of the camera height H                              */
/* -------------------------------------------------------------------------- */

export const STEP_S = 1 / 240;
export const BALL_RADIUS_H = 0.04;
export const GRAVITY_H = 7.5;
export const MIN_SPEED_H = 1.2;
export const MAX_SPEED_H = 6.0;
/** A flight is over after this long, whatever it is doing. */
export const MAX_FLIGHT_S = 6;
/** Slower than this along the contact normal after a bounce, the ball stays in contact rather than hopping. */
const REST_NORMAL_SPEED_H = 0.12;
/** Deceleration while rolling on a surface, H/s². */
const ROLLING_DECEL_H = 0.9;
/** Slower than this for `REST_TIME_S`, the ball has stopped. */
const REST_SPEED_H = 0.04;
const REST_TIME_S = 0.3;
/** Further below the lowest observed surface than this, the ball has fallen out of the known world. */
const FALL_LIMIT_H = 1.5;
/** Further from where it started than this, it has left the room as observed. */
const RANGE_LIMIT_H = 14;

export interface PhysicsWorld {
  /** The camera height `H`, world units — the game's unit. */
  readonly unit: number;
  /** Unit vector toward the ground, world frame. */
  readonly down: readonly number[];
  readonly collision: CollisionSet;
}

export interface BallState {
  readonly position: readonly number[];
  readonly velocity: readonly number[];
  readonly time: number;
}

export interface Contact {
  readonly step: number;
  readonly time: number;
  readonly surfaceId: number;
  readonly surfaceClass: string;
  readonly point: readonly number[];
  /** Speed into the surface before the response, units/s. */
  readonly normalSpeed: number;
  readonly speedBefore: number;
  readonly speedAfter: number;
}

/** A goal volume, as the physics sees it: a disc the ball's centre must pass through. */
export interface GoalDisc {
  readonly center: readonly number[];
  /** The direction the ball must be travelling through it. */
  readonly axis: readonly number[];
  readonly radius: number;
}

export const FlightOutcome = {
  GOAL: 'GOAL',
  /** Came to rest without passing the goal. */
  REST: 'REST',
  /** Left the observed world downward — rolled off the edge of what was seen. */
  FELL: 'FELL',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  TIMEOUT: 'TIMEOUT',
} as const;
export type FlightOutcome = (typeof FlightOutcome)[keyof typeof FlightOutcome];

export interface GoalCrossing {
  readonly step: number;
  readonly time: number;
  readonly point: readonly number[];
  /** Distance from the ring's centre where the ball's centre crossed its plane. */
  readonly offAxis: number;
}

export interface Flight {
  readonly outcome: FlightOutcome;
  readonly steps: number;
  readonly duration: number;
  /** Every 4th step's position (60 Hz), for drawing and for the aim guide. */
  readonly path: readonly (readonly number[])[];
  readonly contacts: readonly Contact[];
  readonly crossing: GoalCrossing | null;
  readonly final: BallState;
  /** Kinetic + potential energy per unit mass at the start and at every contact — BALL-002. */
  readonly energyStart: number;
  readonly energyAfterContacts: readonly number[];
}

export interface StepOutcome {
  readonly state: BallState;
  readonly contact: Contact | null;
}

export class BallSimulator {
  private state: BallState;
  private step = 0;
  private restTime = 0;
  private readonly contacts: Contact[] = [];
  private readonly path: number[][] = [];
  private readonly energies: number[] = [];
  private crossing: GoalCrossing | null = null;
  private outcome: FlightOutcome | null = null;
  private readonly lowest: number;
  private readonly energyStart: number;

  constructor(
    private readonly world: PhysicsWorld,
    origin: readonly number[],
    velocity: readonly number[],
    private readonly goal: GoalDisc | null,
  ) {
    this.state = { position: [...origin], velocity: [...velocity], time: 0 };
    this.path.push([...origin]);
    const up = world.down.map((v) => -v);
    let lowest = dot(up, origin);
    for (const s of world.collision.surfaces) {
      for (const p of s.polygon2d) {
        const w = [0, 1, 2].map((i) => (s.origin[i] ?? 0) + (p[0] ?? 0) * (s.basisU[i] ?? 0) + (p[1] ?? 0) * (s.basisV[i] ?? 0));
        lowest = Math.min(lowest, dot(up, w));
      }
    }
    this.lowest = lowest;
    this.energyStart = this.energy(this.state);
  }

  radius(): number {
    return BALL_RADIUS_H * this.world.unit;
  }

  current(): BallState {
    return this.state;
  }

  steps(): number {
    return this.step;
  }

  done(): FlightOutcome | null {
    return this.outcome;
  }

  /** Advance one fixed step. Returns the contact made on this step, if any. */
  advance(): StepOutcome {
    if (this.outcome) return { state: this.state, contact: null };
    const u = this.world.unit;
    const g = GRAVITY_H * u;
    const r = this.radius();
    const prev = this.state.position;
    const v = this.state.velocity.map((x, i) => x + (this.world.down[i] ?? 0) * g * STEP_S);
    let p = prev.map((x, i) => x + (v[i] ?? 0) * STEP_S);
    let vel = v;
    let contact: Contact | null = null;

    for (const s of this.world.collision.surfaces) {
      const d0 = planeDistance(s, prev);
      const d1 = planeDistance(s, p);
      const side = d0 >= 0 ? 1 : -1;
      // Touching (within the radius on the side it came from) or crossed the plane this step.
      const touching = Math.abs(d1) < r && Math.sign(d1 || side) === side;
      const crossed = (d0 >= 0) !== (d1 >= 0);
      if (!touching && !crossed) continue;
      if (!insideHull(s, p) && !insideHull(s, prev)) continue;
      const n = s.normal.map((x) => x * side);
      const vn = dot(vel, n);
      if (vn >= 0 && !crossed) continue;
      const speedBefore = norm(vel);
      // Put the ball back on the side it came from, one radius off the plane.
      const push = r - side * d1;
      p = p.map((x, i) => x + (n[i] ?? 0) * push);
      vel = respond(vel, n, vn, s, u, this.world.down);
      contact = {
        step: this.step + 1,
        time: this.state.time + STEP_S,
        surfaceId: s.id,
        surfaceClass: s.surfaceClass,
        point: p.map((x, i) => x - (n[i] ?? 0) * r),
        normalSpeed: -vn,
        speedBefore,
        speedAfter: norm(vel),
      };
    }

    this.step++;
    const next: BallState = { position: p, velocity: vel, time: this.state.time + STEP_S };
    if (contact) {
      // Hops below a few mm/s are resting contact, not bounces worth recording.
      if (contact.normalSpeed > REST_NORMAL_SPEED_H * u) {
        this.contacts.push(contact);
        this.energies.push(this.energy(next));
      }
    }
    if (this.goal && !this.crossing) this.crossing = goalCrossing(prev, p, this.goal, this.step, next.time);
    this.state = next;
    if (this.step % 4 === 0) this.path.push([...p]);

    if (this.crossing) this.outcome = FlightOutcome.GOAL;
    else if (norm(vel) < REST_SPEED_H * u) {
      this.restTime += STEP_S;
      if (this.restTime >= REST_TIME_S) this.outcome = FlightOutcome.REST;
    } else this.restTime = 0;
    if (!this.outcome) {
      const up = this.world.down.map((x) => -x);
      if (dot(up, p) < this.lowest - FALL_LIMIT_H * u) this.outcome = FlightOutcome.FELL;
      else if (norm(p.map((x, i) => x - (this.path[0]?.[i] ?? 0))) > RANGE_LIMIT_H * u) this.outcome = FlightOutcome.OUT_OF_RANGE;
      else if (next.time >= MAX_FLIGHT_S) this.outcome = FlightOutcome.TIMEOUT;
    }
    return { state: next, contact: contact && contact.normalSpeed > REST_NORMAL_SPEED_H * u ? contact : null };
  }

  /** Run to the end. */
  finish(): Flight {
    const limit = Math.ceil(MAX_FLIGHT_S / STEP_S) + 2;
    for (let i = 0; i < limit && !this.outcome; i++) this.advance();
    return this.flight();
  }

  flight(): Flight {
    if (this.path[this.path.length - 1] !== this.state.position) this.path.push([...this.state.position]);
    return {
      outcome: this.outcome ?? FlightOutcome.TIMEOUT,
      steps: this.step,
      duration: this.state.time,
      path: this.path.slice(),
      contacts: this.contacts.slice(),
      crossing: this.crossing,
      final: this.state,
      energyStart: this.energyStart,
      energyAfterContacts: this.energies.slice(),
    };
  }

  private energy(s: BallState): number {
    const up = this.world.down.map((v) => -v);
    const g = GRAVITY_H * this.world.unit;
    const v = norm(s.velocity);
    return 0.5 * v * v + g * dot(up, s.position);
  }
}

/** One throw, start to end. Pure: the same arguments always give the same flight. */
export function simulateThrow(
  world: PhysicsWorld,
  origin: readonly number[],
  velocity: readonly number[],
  goal: GoalDisc | null,
): Flight {
  return new BallSimulator(world, origin, velocity, goal).finish();
}

/**
 * Bounce: the normal component reversed and scaled by restitution, the tangential component
 * slowed by friction. Never adds energy — restitution and friction are both below one.
 */
function respond(
  v: readonly number[],
  n: readonly number[],
  vn: number,
  s: CollisionSurface,
  unit: number,
  down: readonly number[],
): number[] {
  const normal = n.map((x) => x * vn);
  const tangent = v.map((x, i) => x - (normal[i] ?? 0));
  const bouncing = -vn > REST_NORMAL_SPEED_H * unit;
  const outN = bouncing ? -s.restitution * vn : 0;
  let t = tangent.map((x) => x * (bouncing ? 1 - s.friction : 1));
  if (!bouncing) {
    // Rolling: decelerate along the surface. Only on a surface that holds the ball up.
    const supports = -dot(n, down) > 0.5;
    if (supports) {
      const speed = norm(t);
      const dv = ROLLING_DECEL_H * unit * STEP_S;
      t = speed > dv ? t.map((x) => x * (1 - dv / speed)) : [0, 0, 0];
    }
  }
  return t.map((x, i) => x + (n[i] ?? 0) * Math.max(0, outN));
}

/** Did the centre pass through the disc, travelling along its axis, fully inside the rim? */
export function goalCrossing(
  a: readonly number[],
  b: readonly number[],
  goal: GoalDisc,
  step: number,
  time: number,
): GoalCrossing | null {
  const da = dot(goal.axis, a.map((x, i) => x - (goal.center[i] ?? 0)));
  const db = dot(goal.axis, b.map((x, i) => x - (goal.center[i] ?? 0)));
  // Entering against the axis is not a goal: the ball must go through the way the ring faces.
  if (!(da < 0 && db >= 0)) return null;
  const t = da / (da - db);
  const p = a.map((x, i) => x + t * ((b[i] ?? 0) - x));
  const off = norm(p.map((x, i) => x - (goal.center[i] ?? 0)));
  if (off > goal.radius) return null;
  return { step, time, point: p, offAxis: off };
}

export function norm(v: readonly number[]): number {
  return Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
}
