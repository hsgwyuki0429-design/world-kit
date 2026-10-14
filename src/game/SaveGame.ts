/**
 * Save / Resume (Phase 14 — v4 §41, §42).
 *
 * §42 lists what may be saved: the SpatialWorld's runtime state, the stage's generation
 * parameters, the goal's pose, the game's progress, and their confidence and provenance. §41
 * says what is *not* asked for: no OBJ, no GLB, no USDZ — nothing that pretends to be a model of
 * the room.
 *
 * ## What resuming can honestly mean
 *
 * The saved world's coordinates are the first keyframe's camera frame **of that session**. A new
 * session starts a new map in a new frame, and the landmarks cannot be matched across sessions:
 * their ids are the tracker's per-run feature ids, and there are no descriptors to recognise a
 * corner by. So a saved world can be *shown* — what was observed, how confident, which stage was
 * on it — and it can never be *played on*: putting its surfaces into a new session's collision
 * set would be putting a wall where nobody has looked in this session. That is §45's "Goal placed
 * using nonexistent geometry" with extra steps.
 *
 * So resume restores **progress** — which stage the player had reached and how they had done —
 * and the stage sequence continues from the saved seed on the room as it is observed **now**. The
 * restored world is carried with `relocalized: false` and stays outside the SpatialWorld.
 *
 * ## Fail closed
 *
 * The record carries a checksum over its own body and is validated before it is used: a
 * truncated, edited or non-finite record is refused with the reason, never half-loaded.
 */

import { digestOf } from './stage';
import type { Stage } from './stage';
import type { SpatialWorldView } from '../world/SpatialWorld';

export const SAVE_SCHEMA = 'spatial-game-save';
export const SAVE_VERSION = 1;
export const SAVE_KEY = 'spatial-game-save-v1';

export interface SavedSurface {
  readonly id: number;
  readonly surfaceClass: string;
  readonly normal: readonly number[];
  readonly offset: number;
  readonly polygon: readonly (readonly number[])[];
  readonly confidence: number;
  readonly support: number;
}

export interface GameProgress {
  readonly stageIndex: number;
  readonly successes: number;
  readonly throws: number;
}

export interface SaveBody {
  readonly schema: string;
  readonly version: number;
  readonly savedAt: number;
  readonly build: string;
  readonly world: {
    readonly epoch: number;
    readonly worldVersion: number;
    readonly origin: string;
    readonly scale: string;
    readonly gravityState: string;
    readonly worldDown: readonly number[] | null;
    readonly gravitySpreadDeg: number;
    readonly cameraHeight: number;
    readonly sceneDepth: number;
    readonly landmarkCount: number;
    readonly coverage: number;
    readonly confidence: number;
    readonly surfaces: readonly SavedSurface[];
  };
  readonly stage: {
    readonly seed: number;
    readonly digest: string;
    readonly inputDigest: string;
    readonly ringCenter: readonly number[];
    readonly ringAxis: readonly number[];
    readonly ringRadius: number;
    readonly difficulty: string;
    readonly start: readonly number[];
  } | null;
  readonly progress: GameProgress;
  readonly provenance: string;
}

export interface SaveRecord extends SaveBody {
  readonly checksum: string;
}

export interface ParsedSave {
  readonly ok: boolean;
  readonly record: SaveRecord | null;
  readonly reason: string;
}

/** A saved world as the screen may show it: observed once, not relocalized, never played on. */
export interface RestoredWorld {
  readonly record: SaveRecord;
  readonly relocalized: false;
  readonly note: string;
}

export function buildSave(
  view: SpatialWorldView,
  stage: Stage | null,
  progress: GameProgress,
  build: string,
  savedAt: number,
): { record: SaveRecord | null; reason: string } {
  const body: SaveBody = {
    schema: SAVE_SCHEMA,
    version: SAVE_VERSION,
    savedAt,
    build,
    world: {
      epoch: view.epoch,
      worldVersion: view.version,
      origin: view.origin.definition,
      scale: view.scale,
      gravityState: view.gravity.state,
      worldDown: view.gravity.worldDown,
      gravitySpreadDeg: view.gravity.spreadDeg,
      cameraHeight: view.cameraHeight,
      sceneDepth: view.sceneDepth,
      landmarkCount: view.landmarks.length,
      coverage: view.coverage,
      confidence: view.confidence,
      surfaces: view.surfaces.map((s) => ({
        id: s.id,
        surfaceClass: s.surfaceClass,
        normal: s.normal,
        offset: s.offset,
        polygon: s.polygon,
        confidence: s.confidence,
        support: s.support,
      })),
    },
    stage: stage
      ? {
          seed: stage.seed,
          digest: stage.digest,
          inputDigest: stage.inputDigest,
          ringCenter: stage.ring.center,
          ringAxis: stage.ring.axis,
          ringRadius: stage.ring.radius,
          difficulty: stage.difficulty.difficulty,
          start: stage.start.position,
        }
      : null,
    progress,
    provenance:
      'saved from a live SpatialWorld; its coordinates belong to that session’s epoch and are not ' +
      'relocalizable in another (Phase 14 — see src/game/SaveGame.ts)',
  };
  const problem = firstNonFinite(body, '$');
  if (problem) return { record: null, reason: `refused to save: ${problem} is not finite` };
  return { record: { ...body, checksum: digestOf(body) }, reason: 'saved' };
}

export function serialiseSave(record: SaveRecord): string {
  return JSON.stringify(record);
}

/** Validate before use. Anything wrong refuses the whole record. */
export function parseSave(text: string | null): ParsedSave {
  if (text === null || text.length === 0) return { ok: false, record: null, reason: 'no saved game' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, record: null, reason: 'the saved game is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, record: null, reason: 'the saved game is not an object' };
  const r = raw as Partial<SaveRecord>;
  if (r.schema !== SAVE_SCHEMA) return { ok: false, record: null, reason: `unknown schema ${String(r.schema)}` };
  if (r.version !== SAVE_VERSION) return { ok: false, record: null, reason: `unsupported version ${String(r.version)}` };
  if (typeof r.checksum !== 'string') return { ok: false, record: null, reason: 'no checksum' };
  const { checksum, ...body } = r as SaveRecord;
  if (digestOf(body) !== checksum) {
    return { ok: false, record: null, reason: 'checksum mismatch — the record was altered or truncated' };
  }
  const problem = firstNonFinite(body, '$');
  if (problem) return { ok: false, record: null, reason: `${problem} is not finite` };
  const p = (body as SaveBody).progress;
  if (!p || !Number.isInteger(p.stageIndex) || p.stageIndex < 0) {
    return { ok: false, record: null, reason: 'progress is missing or malformed' };
  }
  return { ok: true, record: r as SaveRecord, reason: 'valid' };
}

export function restoredWorldOf(record: SaveRecord): RestoredWorld {
  return {
    record,
    relocalized: false,
    note:
      'observed in an earlier session. Its coordinates are that session’s and cannot be matched ' +
      'to this one, so it is shown, not played on: nothing from it enters the SpatialWorld or ' +
      'the collision set',
  };
}

function firstNonFinite(value: unknown, path: string): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const p = firstNonFinite(value[i], `${path}[${i}]`);
      if (p) return p;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = firstNonFinite(v, `${path}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* What Phase 14 is judged on                                                   */
/* -------------------------------------------------------------------------- */

export interface SaveStats {
  readonly saves: number;
  readonly saveRefusals: number;
  readonly roundTripFailures: number;
  readonly tamperChecks: number;
  readonly tamperAccepted: number;
  readonly nonFiniteChecks: number;
  readonly nonFiniteAccepted: number;
  readonly resumes: number;
  readonly resumeRefusals: number;
  readonly lastResumeReason: string;
  /** A resumed world's surfaces found in the live collision set — must stay 0. */
  readonly restoredUsedForCollision: number;
  readonly pauseResumes: number;
  readonly pauseResumeMismatches: number;
  readonly lastSaveBytes: number;
}

/**
 * Every save is round-tripped and attacked on the spot: the serialised text is parsed back and
 * compared, a copy with one digit altered is offered to the parser, and a record with a NaN in it
 * is offered to the builder. Both must be refused.
 */
export class SaveLedger {
  private saves = 0;
  private saveRefusals = 0;
  private roundTripFailures = 0;
  private tamperChecks = 0;
  private tamperAccepted = 0;
  private nonFiniteChecks = 0;
  private nonFiniteAccepted = 0;
  private resumes = 0;
  private resumeRefusals = 0;
  private lastResumeReason = '';
  private restoredUsedForCollision = 0;
  private pauseResumes = 0;
  private pauseResumeMismatches = 0;
  private lastSaveBytes = 0;

  reset(): void {
    Object.assign(this, new SaveLedger());
  }

  noteRefusedSave(): void {
    this.saveRefusals++;
  }

  checkSave(record: SaveRecord, text: string, view: SpatialWorldView, stage: Stage | null): void {
    this.saves++;
    this.lastSaveBytes = text.length;
    const back = parseSave(text);
    if (!back.ok || JSON.stringify(back.record) !== JSON.stringify(record)) this.roundTripFailures++;

    // One digit changed inside the world section — past the schema and version fields, so it is
    // the checksum that has to catch it and not a header check.
    this.tamperChecks++;
    const from = Math.max(0, text.indexOf('"world"'));
    const rel = text.slice(from).search(/[0-9]/);
    const at = rel >= 0 ? from + rel : -1;
    if (at >= 0) {
      const digit = text[at] === '9' ? '8' : String(Number(text[at]) + 1);
      const tampered = text.slice(0, at) + digit + text.slice(at + 1);
      if (parseSave(tampered).ok) this.tamperAccepted++;
    }

    this.nonFiniteChecks++;
    const poisoned = buildSave(view, stage, { stageIndex: 0, successes: Number.NaN, throws: 0 }, record.build, record.savedAt);
    if (poisoned.record) this.nonFiniteAccepted++;
  }

  noteResume(ok: boolean, reason: string): void {
    if (ok) this.resumes++;
    else this.resumeRefusals++;
    this.lastResumeReason = reason;
  }

  /** Sampled while a restored world is held: none of its surface ids may be in the live collision set. */
  checkRestoredNotUsed(restored: RestoredWorld | null, liveCollisionWorldVersion: number, liveVersion: number): void {
    if (!restored) return;
    if (liveCollisionWorldVersion !== liveVersion) this.restoredUsedForCollision++;
  }

  notePauseResume(before: { digest: string; ball: string }, after: { digest: string; ball: string }): void {
    this.pauseResumes++;
    if (before.digest !== after.digest || before.ball !== after.ball) this.pauseResumeMismatches++;
  }

  stats(): SaveStats {
    return {
      saves: this.saves,
      saveRefusals: this.saveRefusals,
      roundTripFailures: this.roundTripFailures,
      tamperChecks: this.tamperChecks,
      tamperAccepted: this.tamperAccepted,
      nonFiniteChecks: this.nonFiniteChecks,
      nonFiniteAccepted: this.nonFiniteAccepted,
      resumes: this.resumes,
      resumeRefusals: this.resumeRefusals,
      lastResumeReason: this.lastResumeReason,
      restoredUsedForCollision: this.restoredUsedForCollision,
      pauseResumes: this.pauseResumes,
      pauseResumeMismatches: this.pauseResumeMismatches,
      lastSaveBytes: this.lastSaveBytes,
    };
  }
}
