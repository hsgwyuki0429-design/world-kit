/**
 * The game — its state machine, the throw, and the record of everything it did (Phases 16, 20;
 * v4 §31, §36, §37, §44).
 *
 * §37 lists ten states and requires the screen to show the one the game is in. They are here as
 * one enum with an explicit table of which may follow which; every transition is recorded with
 * its reason, and one outside the table is counted as a violation rather than allowed quietly.
 *
 * ## What drives it
 *
 * `update(view)` once per animation frame, with the SpatialWorld's current view — the only thing
 * this module knows about the room — and three touch events. The game holds no spatial state of
 * its own (§1.2): the stage it plays is generated from a view and carries that view's epoch and
 * version; the collision set a throw flies through is built from the view at the moment of
 * release and frozen into the throw's record so the throw can be replayed.
 *
 * ## Fail closed (§36, §44)
 *
 *  - World not READY → no stage is generated. SCAN while there is no map, SPATIALIZING after.
 *  - Tracking LOST during play → TRACKING_LOST, the ball frozen mid-air. Back where it was when
 *    tracking returns in the same epoch; back to SCAN if the world was redefined meanwhile.
 *  - POSE LOW CONFIDENCE (DEGRADED) → no new stage and no new throw, but nothing is torn down.
 *  - The world moves on → the stage is re-validated against it, and regenerated if a constraint
 *    no longer holds — a surface found since may be in the way of the ring.
 *
 * ## Every throw is evidence
 *
 * On landing, each throw is replayed from its recorded inputs and compared bit for bit (BALL-001),
 * re-flown with the collision set emptied to show the surfaces it touched mattered (COL-004),
 * and checked never to have gained energy at a bounce (BALL-002).
 */

import { buildCollisionSet } from './collision';
import type { CollisionSet } from './collision';
import {
  BALL_RADIUS_H,
  BallSimulator,
  FlightOutcome,
  GRAVITY_H,
  MAX_SPEED_H,
  MIN_SPEED_H,
  STEP_S,
  simulateThrow,
} from './physics';
import type { Flight, PhysicsWorld } from './physics';
import { goalDiscOf, perpendiculars as perpendicularsOf } from './ring';
import type { GameProgress } from './SaveGame';
import {
  digestOf,
  generateStage,
  rejectionControl,
  revalidateStage,
  stageControl,
  stageInputsFrom,
} from './stage';
import type { Stage, StageResult } from './stage';
import { TrackingState, WorldState } from '../world/SpatialWorld';
import type { SpatialWorldView } from '../world/SpatialWorld';

export const GameState = {
  SCAN: 'SCAN',
  SPATIALIZING: 'SPATIALIZING',
  STAGE_GENERATING: 'STAGE_GENERATING',
  READY: 'READY',
  AIMING: 'AIMING',
  THROWING: 'THROWING',
  SUCCESS: 'SUCCESS',
  RETRY: 'RETRY',
  PAUSED: 'PAUSED',
  TRACKING_LOST: 'TRACKING_LOST',
} as const;
export type GameState = (typeof GameState)[keyof typeof GameState];

const G = GameState;
/** §37's states, and which may follow which. Anything else is a violation, counted and logged. */
export const ALLOWED_TRANSITIONS: Readonly<Record<GameState, readonly GameState[]>> = {
  [G.SCAN]: [G.SPATIALIZING, G.STAGE_GENERATING, G.PAUSED],
  [G.SPATIALIZING]: [G.SCAN, G.STAGE_GENERATING, G.PAUSED],
  [G.STAGE_GENERATING]: [G.READY, G.SCAN, G.SPATIALIZING, G.PAUSED],
  [G.READY]: [G.AIMING, G.STAGE_GENERATING, G.TRACKING_LOST, G.SCAN, G.SPATIALIZING, G.PAUSED],
  [G.AIMING]: [G.THROWING, G.READY, G.TRACKING_LOST, G.PAUSED],
  [G.THROWING]: [G.SUCCESS, G.RETRY, G.TRACKING_LOST, G.PAUSED],
  [G.SUCCESS]: [G.STAGE_GENERATING, G.SCAN, G.PAUSED],
  [G.RETRY]: [G.READY, G.STAGE_GENERATING, G.SCAN, G.PAUSED],
  [G.PAUSED]: [G.SCAN, G.SPATIALIZING, G.STAGE_GENERATING, G.READY, G.THROWING, G.TRACKING_LOST],
  [G.TRACKING_LOST]: [G.READY, G.THROWING, G.SCAN, G.PAUSED],
};

/** The aim: the camera's own direction, lifted by this much so a level phone throws an arc. */
export const LAUNCH_ELEVATION_DEG = 14;
/** One full sweep of the power gauge, 0 → 1 → 0, seconds. */
export const POWER_PERIOD_S = 1.4;
/** Tracking must stay LOST this long before play freezes — one refused frame is not a loss. */
export const LOST_DEBOUNCE_MS = 300;
const SUCCESS_HOLD_MS = 2200;
const RETRY_HOLD_MS = 1300;
const GENERATION_RETRY_MS = 900;
const REVALIDATE_EVERY_MS = 1500;
/** How much of the predicted flight the aim guide shows, by difficulty. */
export const GUIDE_FRACTION: Record<string, number> = { EASY: 1, NORMAL: 0.6, HARD: 0.4, EXPERT: 0.25 };
const MAX_CATCH_UP_S = 0.1;
const MAX_RECORDS = 60;

export interface TransitionRecord {
  readonly at: number;
  readonly from: GameState;
  readonly to: GameState;
  readonly reason: string;
  readonly allowed: boolean;
}

export interface ThrowRecord {
  readonly index: number;
  readonly stageDigest: string;
  readonly stageSeed: number;
  readonly worldVersion: number;
  readonly epoch: number;
  readonly origin: readonly number[];
  readonly velocity: readonly number[];
  readonly power: number;
  readonly speedH: number;
  readonly collisionSurfaceIds: readonly number[];
  readonly collisionDigest: string;
  readonly outcome: FlightOutcome;
  readonly contacts: readonly { readonly surfaceId: number; readonly surfaceClass: string; readonly time: number; readonly point: readonly number[] }[];
  readonly crossing: { readonly point: readonly number[]; readonly offAxis: number; readonly time: number } | null;
  readonly steps: number;
  readonly duration: number;
  /** BALL-001: replaying the recorded inputs gave the same flight. */
  readonly replayMatched: boolean;
  /** COL-004: with the collision set emptied the flight differs — only meaningful when it touched something. */
  readonly controlDiffers: boolean | null;
  /** BALL-002: no bounce gained energy. */
  readonly energyOk: boolean;
  /** COL-003: every surface touched was in the world when the throw was released. */
  readonly contactsTraced: boolean;
  readonly frozenMs: number;
}

export interface GameView {
  readonly state: GameState;
  readonly reason: string;
  readonly stage: Stage | null;
  readonly stageIndex: number;
  readonly ball: readonly number[] | null;
  readonly ballRadius: number;
  readonly power: number;
  readonly aimGuide: readonly (readonly number[])[];
  /**
   * Whether a throw released now, at the power the gauge shows, would score. The full flight is
   * simulated for it; the screen only shows it on EASY, where the guide shows the whole arc anyway.
   */
  readonly aimWouldScore: boolean;
  readonly lastThrow: ThrowRecord | null;
  readonly successes: number;
  readonly throws: number;
  readonly lastGeneration: StageResult | null;
}

export interface GameStats {
  readonly state: GameState;
  readonly transitions: readonly TransitionRecord[];
  readonly transitionCount: number;
  readonly illegalTransitions: number;
  readonly visited: readonly GameState[];
  readonly stagesGenerated: number;
  readonly generationFailures: number;
  readonly lastGenerationReason: string;
  readonly medianGenerationMs: number;
  readonly reproductions: number;
  readonly reproductionMismatches: number;
  readonly generatedWhileNotReady: number;
  readonly stageInvalidations: readonly string[];
  readonly epochInvalidations: number;
  readonly throws: readonly ThrowRecord[];
  readonly throwCount: number;
  readonly successes: number;
  readonly misses: number;
  readonly replayMismatches: number;
  readonly energyViolations: number;
  readonly controlChecks: number;
  readonly controlFailures: number;
  readonly untracedContacts: number;
  readonly stepsWhileFrozen: number;
  readonly lostEntries: number;
  readonly lostRecoveries: number;
  readonly pressesRefused: Record<string, number>;
  readonly worstPhysicsMs: number;
  readonly difficulties: Record<string, number>;
  readonly cycles: number;
  readonly lastStage: Stage | null;
  /** STAGE-003: each stage's own reference throw, re-flown against the world it was made from. */
  readonly solutionChecks: number;
  readonly solutionFailures: number;
  /** STAGE-004: the same room moved by half a camera height must give a different stage. */
  readonly stageControls: number;
  readonly stageControlFailures: number;
  readonly lastStageControl: string;
  /** RING-002: synthetic invalid rings offered to the validator, and how many it let through. */
  readonly rejectionOffered: number;
  readonly rejectionAccepted: readonly string[];
  /** PLAY-003: each scoring throw re-flown at a ring moved off its axis must not score. */
  readonly goalControls: number;
  readonly goalControlFailures: number;
  /** Stage held in a world of a different epoch, sampled each frame — must stay 0. */
  readonly staleStageFrames: number;
}

export class GameSession {
  private state: GameState = G.SCAN;
  private reason = 'looking for the room';
  private stage: Stage | null = null;
  private stageIndex = 0;
  private stageSeedBase = 1;
  private sim: BallSimulator | null = null;
  private simWorld: PhysicsWorld | null = null;
  private simCollision: CollisionSet | null = null;
  private throwInputs: { origin: number[]; velocity: number[]; power: number } | null = null;
  private throwFrozenMs = 0;
  private aimStartedAt = -1;
  private power = 0;
  private aimGuide: number[][] = [];
  private aimWouldScore = false;
  private frozenStepMark = -1;
  private lastFrame = -1;
  private accumulator = 0;
  private holdUntil = -1;
  private lostSince = -1;
  private resumeState: GameState | null = null;
  private pausedFrom: GameState | null = null;
  private lastGenerationAt = -Infinity;
  private lastGenerationVersion = -1;
  private lastRevalidateAt = -Infinity;
  private lastRevalidateVersion = -1;
  private lastGeneration: StageResult | null = null;
  private lastView: SpatialWorldView | null = null;
  private carried: { successes: number; throws: number } = { successes: 0, throws: 0 };
  private restoredFrom: GameProgress | null = null;

  private readonly transitions: TransitionRecord[] = [];
  private transitionCount = 0;
  private illegalTransitions = 0;
  private readonly visited = new Set<GameState>([G.SCAN]);
  private stagesGenerated = 0;
  private generationFailures = 0;
  private generationMs: number[] = [];
  private reproductions = 0;
  private reproductionMismatches = 0;
  private generatedWhileNotReady = 0;
  private readonly stageInvalidations: string[] = [];
  private epochInvalidations = 0;
  private readonly throws: ThrowRecord[] = [];
  private throwCount = 0;
  private successes = 0;
  private misses = 0;
  private replayMismatches = 0;
  private energyViolations = 0;
  private controlChecks = 0;
  private controlFailures = 0;
  private untracedContacts = 0;
  private stepsWhileFrozen = 0;
  private lostEntries = 0;
  private lostRecoveries = 0;
  private readonly pressesRefused: Record<string, number> = {};
  private worstPhysicsMs = 0;
  private readonly difficulties: Record<string, number> = {};
  private cycles = 0;
  private cycleArmed = false;
  private solutionChecks = 0;
  private solutionFailures = 0;
  private stageControls = 0;
  private stageControlFailures = 0;
  private lastStageControl = '';
  private rejectionOffered = 0;
  private readonly rejectionAccepted: string[] = [];
  private goalControls = 0;
  private goalControlFailures = 0;
  private staleStageFrames = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  reset(): void {
    const fresh = new GameSession(this.now);
    Object.assign(this, fresh);
  }

  /** One animation frame. */
  update(view: SpatialWorldView): void {
    const t = this.now();
    const dt = this.lastFrame < 0 ? 0 : Math.min(MAX_CATCH_UP_S, Math.max(0, (t - this.lastFrame) / 1000));
    this.lastFrame = t;
    this.lastView = view;

    if (this.state === G.PAUSED) {
      this.noteFrozenStep(dt);
      return;
    }

    // The world was redefined under the stage: nothing about it holds any more.
    if (this.stage && view.epoch !== this.stage.epoch) {
      this.staleStageFrames++;
      this.epochInvalidations++;
      this.dropStage(`the world was redefined (epoch ${this.stage.epoch} → ${view.epoch}); scan again`);
      this.go(G.SCAN, 'the stage belonged to a world that no longer exists');
    }

    const playing = this.state === G.READY || this.state === G.AIMING || this.state === G.THROWING;
    if (view.trackingState === TrackingState.LOST) {
      if (this.lostSince < 0) this.lostSince = t;
    } else {
      this.lostSince = -1;
    }

    if (this.state === G.TRACKING_LOST) {
      this.noteFrozenStep(dt);
      if (view.trackingState === TrackingState.GOOD || view.trackingState === TrackingState.DEGRADED) {
        this.lostRecoveries++;
        const back = this.resumeState === G.THROWING ? G.THROWING : G.READY;
        this.resumeState = null;
        this.go(back, `tracking recovered: ${view.trackingReason}`);
      }
      return;
    }
    if (playing && this.lostSince >= 0 && t - this.lostSince >= LOST_DEBOUNCE_MS) {
      this.lostEntries++;
      this.resumeState = this.state;
      this.go(G.TRACKING_LOST, `TRACKING LOST — ${view.trackingReason}. Play is frozen until the camera finds the room again`);
      return;
    }

    switch (this.state) {
      case G.SCAN:
      case G.SPATIALIZING:
      case G.STAGE_GENERATING:
        this.prepare(view, t);
        break;
      case G.READY:
        this.revalidate(view, t);
        if (this.state === G.READY) this.updateGuide(view);
        break;
      case G.AIMING:
        this.power = triangle((t - this.aimStartedAt) / 1000 / POWER_PERIOD_S);
        this.updateGuide(view);
        break;
      case G.THROWING:
        this.advanceThrow(dt);
        break;
      case G.SUCCESS:
        if (t >= this.holdUntil) {
          this.stageIndex++;
          this.dropStage('next stage');
          this.go(G.STAGE_GENERATING, 'a new stage for the same room');
        }
        break;
      case G.RETRY:
        if (t >= this.holdUntil) {
          this.sim = null;
          this.go(G.READY, 'the ball is back on the tee');
        }
        break;
      default:
        break;
    }
  }

  /** Touch down: start charging. Refused, with a reason, unless the game is READY. */
  press(): boolean {
    const view = this.lastView;
    if (this.state !== G.READY || !this.stage) return this.refuse(`not READY (${this.state})`);
    if (!view || view.trackingState !== TrackingState.GOOD) return this.refuse('POSE LOW CONFIDENCE — no throw is committed on it (§44)');
    this.aimStartedAt = this.now();
    this.power = 0;
    this.go(G.AIMING, 'charging');
    return true;
  }

  /** Touch up: throw with the power reached, along where the camera is pointing. */
  release(): boolean {
    const view = this.lastView;
    if (this.state !== G.AIMING || !this.stage || !view?.cameraPose) {
      if (this.state === G.AIMING) this.go(G.READY, 'released without a pose to aim from');
      return false;
    }
    this.power = triangle((this.now() - this.aimStartedAt) / 1000 / POWER_PERIOD_S);
    const velocity = this.aimVelocity(view, this.power);
    const collision = buildCollisionSet(view);
    const world: PhysicsWorld = { unit: this.stage.unit, down: this.stage.down, collision };
    this.simWorld = world;
    this.simCollision = collision;
    this.throwInputs = { origin: [...this.stage.start.position], velocity, power: this.power };
    this.throwFrozenMs = 0;
    this.sim = new BallSimulator(world, this.stage.start.position, velocity, goalDiscOf(this.stage.ring, this.stage.unit));
    this.accumulator = 0;
    this.throwCount++;
    this.go(G.THROWING, `thrown at ${round(this.power * 100, 0)}% power`);
    return true;
  }

  /** After a miss, put the ball back on the tee now rather than after the hold. */
  retryNow(): void {
    if (this.state !== G.RETRY) return;
    this.sim = null;
    this.go(G.READY, 'the ball is back on the tee');
  }

  /** Cancel a charge without throwing. */
  cancelAim(): void {
    if (this.state === G.AIMING) this.go(G.READY, 'aim cancelled');
  }

  pause(): void {
    if (this.state === G.PAUSED) return;
    this.pausedFrom = this.state;
    this.go(G.PAUSED, 'paused');
  }

  resume(): void {
    if (this.state !== G.PAUSED) return;
    const back = this.pausedFrom ?? G.SCAN;
    this.pausedFrom = null;
    this.lastFrame = -1;
    // A charge does not survive a pause; a flight does, frozen where it was.
    this.go(back === G.AIMING ? G.READY : back, 'resumed');
  }

  /** What a save carries of the game: where the player had got to, never where anything was. */
  progress(): GameProgress {
    return {
      stageIndex: this.stageIndex,
      successes: this.successes + this.carried.successes,
      throws: this.throwCount + this.carried.throws,
    };
  }

  /**
   * Resume from a save: the stage sequence continues from its index, on the room as it is
   * observed **now**. Allowed only before the first throw of this session — a resume after play
   * had begun would merge two sessions' scores. A stage already generated here is dropped and
   * regenerated at the saved index from the live world, which is the only world there is.
   */
  restoreProgress(p: GameProgress): boolean {
    if (this.throwCount > 0 || this.restoredFrom) return false;
    if (this.state === G.AIMING || this.state === G.THROWING || this.state === G.TRACKING_LOST) return false;
    this.stageIndex = p.stageIndex;
    this.carried = { successes: p.successes, throws: p.throws };
    this.restoredFrom = p;
    if (this.stage) {
      this.dropStage('resumed from a save — regenerating at the saved stage on the room as observed now');
      this.go(G.STAGE_GENERATING, 'resumed from a save');
    }
    return true;
  }

  restored(): GameProgress | null {
    return this.restoredFrom;
  }

  /** The player asked for a different stage in the same room. */
  newStage(): void {
    if (this.state !== G.READY && this.state !== G.RETRY) return;
    this.stageIndex++;
    this.dropStage('the player asked for a new stage');
    this.go(G.STAGE_GENERATING, 'a new stage was requested');
  }

  view(): GameView {
    return {
      state: this.state,
      reason: this.reason,
      stage: this.stage,
      stageIndex: this.stageIndex,
      ball: this.ballPosition(),
      ballRadius: this.stage ? BALL_RADIUS_H * this.stage.unit : 0,
      power: this.power,
      aimGuide: this.aimGuide,
      aimWouldScore: this.aimWouldScore,
      lastThrow: this.throws[this.throws.length - 1] ?? null,
      successes: this.successes + this.carried.successes,
      throws: this.throwCount + this.carried.throws,
      lastGeneration: this.lastGeneration,
    };
  }

  stats(): GameStats {
    return {
      state: this.state,
      transitions: this.transitions.slice(),
      transitionCount: this.transitionCount,
      illegalTransitions: this.illegalTransitions,
      visited: [...this.visited],
      stagesGenerated: this.stagesGenerated,
      generationFailures: this.generationFailures,
      lastGenerationReason: this.lastGeneration?.reason ?? '',
      medianGenerationMs: round(median(this.generationMs), 2),
      reproductions: this.reproductions,
      reproductionMismatches: this.reproductionMismatches,
      generatedWhileNotReady: this.generatedWhileNotReady,
      stageInvalidations: this.stageInvalidations.slice(-10),
      epochInvalidations: this.epochInvalidations,
      throws: this.throws.slice(),
      throwCount: this.throwCount,
      successes: this.successes,
      misses: this.misses,
      replayMismatches: this.replayMismatches,
      energyViolations: this.energyViolations,
      controlChecks: this.controlChecks,
      controlFailures: this.controlFailures,
      untracedContacts: this.untracedContacts,
      stepsWhileFrozen: this.stepsWhileFrozen,
      lostEntries: this.lostEntries,
      lostRecoveries: this.lostRecoveries,
      pressesRefused: { ...this.pressesRefused },
      worstPhysicsMs: round(this.worstPhysicsMs, 3),
      difficulties: { ...this.difficulties },
      cycles: this.cycles,
      lastStage: this.stage,
      solutionChecks: this.solutionChecks,
      solutionFailures: this.solutionFailures,
      stageControls: this.stageControls,
      stageControlFailures: this.stageControlFailures,
      lastStageControl: this.lastStageControl,
      rejectionOffered: this.rejectionOffered,
      rejectionAccepted: this.rejectionAccepted.slice(-10),
      goalControls: this.goalControls,
      goalControlFailures: this.goalControlFailures,
      staleStageFrames: this.staleStageFrames,
    };
  }

  /* ---------------------------------------------------------------------- */

  private prepare(view: SpatialWorldView, t: number): void {
    if (view.worldState !== WorldState.READY) {
      const scanning = view.mappingState === 'NO_MAP' || view.trackingState === TrackingState.INITIALIZING;
      const target = scanning ? G.SCAN : G.SPATIALIZING;
      const why = view.worldReasons[0] ?? 'the world is not READY';
      if (this.state !== target) this.go(target, why);
      else this.reason = why;
      return;
    }
    if (this.state !== G.STAGE_GENERATING) this.go(G.STAGE_GENERATING, 'WORLD READY — generating a stage from it');
    if (view.version === this.lastGenerationVersion && t - this.lastGenerationAt < GENERATION_RETRY_MS) return;
    this.lastGenerationAt = t;
    this.lastGenerationVersion = view.version;

    const seed = this.stageSeedBase + this.stageIndex;
    const result = generateStage(view, seed, this.now);
    this.lastGeneration = result;
    this.generationMs.push(result.ms);
    if (this.generationMs.length > 100) this.generationMs.shift();
    if (view.worldState !== WorldState.READY) this.generatedWhileNotReady++;
    if (!result.stage) {
      this.generationFailures++;
      this.reason = `no valid stage yet — ${result.reason}`;
      return;
    }
    // STAGE-001, on every stage: regenerate from the same view and seed, and compare.
    const again = generateStage(view, seed);
    this.reproductions++;
    if (again.stage?.digest !== result.stage.digest) this.reproductionMismatches++;
    this.checkStage(view, result.stage, seed);

    this.stage = result.stage;
    this.stagesGenerated++;
    const d = result.stage.difficulty.difficulty;
    this.difficulties[d] = (this.difficulties[d] ?? 0) + 1;
    this.lastRevalidateAt = t;
    this.lastRevalidateVersion = view.version;
    this.cycleArmed = true;
    this.go(G.READY, `stage ${this.stageIndex + 1}: ${result.reason}`);
  }

  /** STAGE-003, STAGE-004 and RING-002, on every stage the moment it is made. */
  private checkStage(view: SpatialWorldView, stage: Stage, seed: number): void {
    const world: PhysicsWorld = { unit: stage.unit, down: stage.down, collision: buildCollisionSet(view) };
    const replay = simulateThrow(world, stage.start.position, stage.solution.velocity, goalDiscOf(stage.ring, stage.unit));
    this.solutionChecks++;
    if (replay.outcome !== FlightOutcome.GOAL) this.solutionFailures++;

    const inputs = stageInputsFrom(view);
    if (!inputs) return;
    const control = stageControl(inputs, stage, seed);
    this.stageControls++;
    this.lastStageControl = control.detail;
    if (!control.differs) this.stageControlFailures++;

    const rejection = rejectionControl(inputs, stage);
    this.rejectionOffered += rejection.offered;
    for (const d of rejection.detail) this.rejectionAccepted.push(d);
  }

  private revalidate(view: SpatialWorldView, t: number): void {
    if (!this.stage) {
      this.go(G.STAGE_GENERATING, 'no stage');
      return;
    }
    if (view.version === this.lastRevalidateVersion || t - this.lastRevalidateAt < REVALIDATE_EVERY_MS) return;
    if (view.worldState !== WorldState.READY) return;
    this.lastRevalidateAt = t;
    this.lastRevalidateVersion = view.version;
    const r = revalidateStage(this.stage, view);
    if (!r.valid) {
      this.stageInvalidations.push(r.reason);
      this.dropStage(r.reason);
      this.go(G.STAGE_GENERATING, `GOAL INVALID — ${r.reason}; regenerating (§36)`);
    }
  }

  private advanceThrow(dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    const t0 = this.now();
    this.accumulator += dt;
    while (this.accumulator >= STEP_S && !sim.done()) {
      sim.advance();
      this.accumulator -= STEP_S;
    }
    this.worstPhysicsMs = Math.max(this.worstPhysicsMs, this.now() - t0);
    const outcome = sim.done();
    if (!outcome) return;
    const record = this.recordThrow(sim.flight());
    if (outcome === FlightOutcome.GOAL) {
      this.successes++;
      if (this.cycleArmed) this.cycles++;
      this.cycleArmed = false;
      this.holdUntil = this.now() + SUCCESS_HOLD_MS;
      this.go(G.SUCCESS, `SUCCESS — through the ring ${round(record.crossing?.offAxis ?? 0, 3)} from its centre`);
    } else {
      this.misses++;
      if (this.cycleArmed) this.cycles++;
      this.cycleArmed = false;
      this.holdUntil = this.now() + RETRY_HOLD_MS;
      this.go(G.RETRY, `missed (${outcome}) — try again`);
    }
  }

  private recordThrow(flight: Flight): ThrowRecord {
    const stage = this.stage;
    const world = this.simWorld;
    const inputs = this.throwInputs;
    const collision = this.simCollision;
    if (!stage || !world || !inputs || !collision) throw new Error('throw recorded without its inputs');
    const disc = goalDiscOf(stage.ring, stage.unit);

    const replay = simulateThrow(world, inputs.origin, inputs.velocity, disc);
    const replayMatched =
      replay.outcome === flight.outcome &&
      replay.steps === flight.steps &&
      JSON.stringify(replay.final) === JSON.stringify(flight.final) &&
      JSON.stringify(replay.contacts) === JSON.stringify(flight.contacts);
    if (!replayMatched) this.replayMismatches++;

    let controlDiffers: boolean | null = null;
    if (flight.contacts.length > 0) {
      const empty: PhysicsWorld = { ...world, collision: { ...collision, surfaces: [] } };
      const control = simulateThrow(empty, inputs.origin, inputs.velocity, disc);
      controlDiffers = control.outcome !== flight.outcome || JSON.stringify(control.final) !== JSON.stringify(flight.final);
      this.controlChecks++;
      if (!controlDiffers) this.controlFailures++;
    }

    const tolerance = 0.01 * GRAVITY_H * stage.unit * stage.unit;
    let energyOk = true;
    let previous = flight.energyStart;
    for (const e of flight.energyAfterContacts) {
      if (e > previous + tolerance) energyOk = false;
      previous = e;
    }
    if (!energyOk) this.energyViolations++;

    if (flight.outcome === FlightOutcome.GOAL) {
      // The success must have depended on the ring being where it was: the same throw at a ring
      // moved two and a half radii across its own axis does not score.
      const [a] = perpendicularsOf(stage.ring.axis);
      const moved = { ...disc, center: disc.center.map((x, i) => x + (a[i] ?? 0) * stage.ring.radius * 2.5) };
      const control = simulateThrow(world, inputs.origin, inputs.velocity, moved);
      this.goalControls++;
      if (control.outcome === FlightOutcome.GOAL) this.goalControlFailures++;
    }

    const known = new Set(collision.surfaces.map((s) => s.id));
    const contactsTraced = flight.contacts.every((c) => known.has(c.surfaceId));
    if (!contactsTraced) this.untracedContacts++;

    const record: ThrowRecord = {
      index: this.throwCount,
      stageDigest: stage.digest,
      stageSeed: stage.seed,
      worldVersion: collision.worldVersion,
      epoch: collision.epoch,
      origin: inputs.origin.map((v) => round(v, 6)),
      velocity: inputs.velocity.map((v) => round(v, 6)),
      power: round(inputs.power, 4),
      speedH: round(Math.hypot(...inputs.velocity) / stage.unit, 4),
      collisionSurfaceIds: collision.surfaces.map((s) => s.id),
      collisionDigest: digestOf(collision.surfaces.map((s) => [s.id, s.normal, s.offset, s.polygon2d])),
      outcome: flight.outcome,
      contacts: flight.contacts.map((c) => ({
        surfaceId: c.surfaceId,
        surfaceClass: c.surfaceClass,
        time: round(c.time, 4),
        point: c.point.map((v) => round(v, 5)),
      })),
      crossing: flight.crossing
        ? { point: flight.crossing.point.map((v) => round(v, 5)), offAxis: round(flight.crossing.offAxis, 5), time: round(flight.crossing.time, 4) }
        : null,
      steps: flight.steps,
      duration: round(flight.duration, 4),
      replayMatched,
      controlDiffers,
      energyOk,
      contactsTraced,
      frozenMs: round(this.throwFrozenMs, 1),
    };
    this.throws.push(record);
    if (this.throws.length > MAX_RECORDS) this.throws.shift();
    return record;
  }

  private updateGuide(view: SpatialWorldView): void {
    const stage = this.stage;
    if (!stage || !view.cameraPose) {
      this.aimGuide = [];
      return;
    }
    const power = this.state === G.AIMING ? this.power : 0.5;
    const velocity = this.aimVelocity(view, power);
    const world: PhysicsWorld = { unit: stage.unit, down: stage.down, collision: buildCollisionSet(view) };
    const sim = new BallSimulator(world, stage.start.position, velocity, goalDiscOf(stage.ring, stage.unit));
    const fraction = GUIDE_FRACTION[stage.difficulty.difficulty] ?? 0.5;
    const steps = Math.round((1.5 * fraction) / STEP_S);
    for (let i = 0; i < steps && !sim.done(); i++) sim.advance();
    this.aimGuide = sim.flight().path.map((p) => [...p]);
    this.aimWouldScore = sim.finish().outcome === FlightOutcome.GOAL;
  }

  /** Along the camera's forward, lifted by `LAUNCH_ELEVATION_DEG` toward the camera's up. */
  private aimVelocity(view: SpatialWorldView, power: number): number[] {
    const pose = view.cameraPose;
    const stage = this.stage;
    if (!pose || !stage) return [0, 0, 0];
    const r = pose.rotation;
    const forward = [r[6] ?? 0, r[7] ?? 0, r[8] ?? 0];
    const cameraUp = [-(r[3] ?? 0), -(r[4] ?? 0), -(r[5] ?? 0)];
    const e = (LAUNCH_ELEVATION_DEG * Math.PI) / 180;
    const dir = forward.map((f, i) => f * Math.cos(e) + (cameraUp[i] ?? 0) * Math.sin(e));
    const speed = (MIN_SPEED_H + (MAX_SPEED_H - MIN_SPEED_H) * power) * stage.unit;
    const n = Math.hypot(...dir) || 1;
    return dir.map((d) => (d / n) * speed);
  }

  private ballPosition(): readonly number[] | null {
    if (this.sim && (this.state === G.THROWING || this.state === G.SUCCESS || this.state === G.RETRY || this.state === G.TRACKING_LOST || this.state === G.PAUSED)) {
      return this.sim.current().position;
    }
    return this.stage ? this.stage.start.position : null;
  }

  private noteFrozenStep(dt: number): void {
    if (this.sim && !this.sim.done()) this.throwFrozenMs += dt * 1000;
  }

  private dropStage(reason: string): void {
    if (this.stage) this.reason = reason;
    this.stage = null;
    this.sim = null;
    this.aimGuide = [];
    this.aimWouldScore = false;
    this.lastGenerationVersion = -1;
    this.lastGenerationAt = -Infinity;
  }

  private refuse(why: string): boolean {
    this.pressesRefused[why] = (this.pressesRefused[why] ?? 0) + 1;
    return false;
  }

  private go(to: GameState, reason: string): void {
    const from = this.state;
    this.reason = reason;
    if (from === to) return;
    const allowed = ALLOWED_TRANSITIONS[from].includes(to);
    if (!allowed) this.illegalTransitions++;
    this.transitionCount++;
    this.transitions.push({ at: round(this.now(), 1), from, to, reason, allowed });
    if (this.transitions.length > 200) this.transitions.shift();
    this.visited.add(to);
    // GAME-002: a frozen flight must not move. Measured across the freeze rather than assumed
    // from the fact that nothing calls `advance` in these states.
    const frozen = (x: GameState): boolean => x === G.TRACKING_LOST || x === G.PAUSED;
    if (frozen(to) && !frozen(from)) this.frozenStepMark = this.sim ? this.sim.steps() : -1;
    if (frozen(from) && !frozen(to) && this.sim && this.frozenStepMark >= 0) {
      this.stepsWhileFrozen += Math.max(0, this.sim.steps() - this.frozenStepMark);
      this.frozenStepMark = -1;
    }
    this.state = to;
  }
}

/** 0 → 1 → 0 over one period. */
function triangle(x: number): number {
  const f = x - Math.floor(x);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
