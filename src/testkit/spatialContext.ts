/**
 * The one context Phases 11–21 are graded from.
 *
 * Those phases share one running stack — localization, the world, the stage, the ball — and each
 * grades a different slice of it, so they read one structure rather than eleven. Each suite still
 * has its own entry point and its own specs, so a screen cannot grade itself against another
 * phase's records.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import type { CameraState } from '../capture/CameraSource';
import type { GameStats, GameView } from '../game/GameSession';
import type { SaveStats } from '../game/SaveGame';
import type { ViewStats } from '../renderer/ViewStats';
import type { SpatialWorldView } from '../world/SpatialWorld';
import type { WorldBuilderStats } from '../world/WorldBuilder';
import { Verdict } from '../core/types';
import type { JsonValue } from '../core/types';
import type { Evaluation } from './runTests';

export interface SpatialContext {
  readonly cameraState: CameraState;
  /** The localization stack was asked for and has produced at least one report. */
  readonly stackEverRan: boolean;
  readonly gravitySource: string;
  readonly gravityDetail: string;
  readonly acceleration: { readonly sign: number; readonly medianDeg: number; readonly samples: number };
  readonly world: WorldBuilderStats;
  readonly view: SpatialWorldView;
  readonly game: GameStats;
  readonly gameView: GameView;
  readonly render: ViewStats;
  readonly save: SaveStats;
  /** Frames on which the collision set held a surface it should not have — sampled every tick. */
  readonly collisionSamples: number;
  readonly collisionViolations: number;
  readonly collisionViolationDetail: string;
  readonly phases: readonly PhaseInfo[];
  /** Phases whose door is open on a pass carried from an earlier load (`PhaseRegistry`). */
  readonly carried: readonly number[];
  /** This session's results for the earlier phases of the stack — PLAY-002 reads 11–19. */
  readonly results: ReadonlyMap<number, readonly TestResult[]>;
  /** The capability matrix's spatial records, by id — AUDIT-003. */
  readonly capabilities: Readonly<Record<string, string>>;
}

/** PENDING while the stack has not produced anything to grade. */
export function notRunning(ctx: SpatialContext, metrics: Record<string, JsonValue>): Evaluation | null {
  if (ctx.stackEverRan && ctx.world.reports > 0) return null;
  return {
    verdict: Verdict.PENDING,
    observed: `the spatial stack has produced no localization report (camera ${ctx.cameraState})`,
    reason:
      'this phase is graded on the running stack — camera, tracker, map and localization. Start ' +
      'it and look around the room slowly',
    metrics,
  };
}

export function pending(observed: string, reason: string, metrics: Record<string, JsonValue>): Evaluation {
  return { verdict: Verdict.PENDING, observed, reason, metrics };
}

export function judged(problems: readonly string[], observed: string, okReason: string, metrics: Record<string, JsonValue>): Evaluation {
  return {
    verdict: problems.length === 0 ? Verdict.PASS : Verdict.FAIL,
    observed,
    reason: problems.length === 0 ? okReason : problems.join('; '),
    metrics,
  };
}
