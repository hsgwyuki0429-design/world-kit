/**
 * Core type system.
 *
 * Two ideas carry most of the weight of the v3.0 spec here:
 *
 *  1. `DetectionMethod` — every capability record has to say *how* it knows what it
 *     claims. A record that only checked for a symbol cannot masquerade as one that
 *     executed the API, and a record derived from the UA string is marked as the guess
 *     it is (Rule 003 / §A.1 of the implementation plan).
 *
 *  2. `Verdict` has a third value, `PENDING`. Anything that cannot be evaluated yet
 *     stays PENDING and holds the whole phase at TESTING. PENDING never rounds up to
 *     PASS (§1.4 Fail Closed).
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Fail-closed capability states. `UNKNOWN` is the default, not `AVAILABLE`. */
export const CapabilityState = {
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  UNKNOWN: 'UNKNOWN',
  ERROR: 'ERROR',
} as const;
export type CapabilityState = (typeof CapabilityState)[keyof typeof CapabilityState];

/**
 * How a capability record reached its conclusion.
 *
 * `INFERENCE` records are never allowed to back a phase pass criterion; see
 * `assertNoInferenceInPassCriteria`.
 */
export const DetectionMethod = {
  /** The API was actually called and a real result observed. */
  FUNCTIONAL_PROBE: 'FUNCTIONAL_PROBE',
  /** Only symbol existence was checked. Proves availability of a name, not behaviour. */
  PRESENCE_CHECK: 'PRESENCE_CHECK',
  /** Derived from another signal (UA string, heuristics). Explicitly a guess. */
  INFERENCE: 'INFERENCE',
  /** Deliberately not probed in this phase (e.g. needs a user gesture first). */
  NOT_ATTEMPTED: 'NOT_ATTEMPTED',
} as const;
export type DetectionMethod = (typeof DetectionMethod)[keyof typeof DetectionMethod];

export type CapabilityGroup =
  | 'platform'
  | 'camera'
  | 'motion'
  | 'compute'
  | 'graphics'
  | 'media'
  | 'storage'
  | 'spatial';

export interface CapabilityRecord {
  /** Stable dotted id, e.g. `camera.getUserMedia`. Used by tests and by the UI. */
  readonly id: string;
  readonly group: CapabilityGroup;
  readonly label: string;
  readonly state: CapabilityState;
  readonly method: DetectionMethod;
  /** Human-readable, precise. "no events received in 2000 ms", not "not working". */
  readonly detail: string;
  /** Measured facts backing the state. Must be JSON-safe and finite. */
  readonly data: Record<string, JsonValue>;
  /** Present only when the probe threw. A throw yields ERROR, never UNAVAILABLE. */
  readonly error?: string;
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface CapabilityMatrix {
  readonly records: readonly CapabilityRecord[];
  readonly startedAt: number;
  readonly completedAt: number;
  readonly totalDurationMs: number;
}

/* ------------------------------------------------------------------------- */
/* Phase model (Rule 005)                                                     */
/* ------------------------------------------------------------------------- */

export const PhaseState = {
  NOT_STARTED: 'NOT_STARTED',
  IMPLEMENTING: 'IMPLEMENTING',
  TESTING: 'TESTING',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  PASSED: 'PASSED',
} as const;
export type PhaseState = (typeof PhaseState)[keyof typeof PhaseState];

export interface PhaseInfo {
  readonly index: number;
  readonly name: string;
  readonly state: PhaseState;
  /** Why the phase is in this state. Always populated for BLOCKED/FAILED. */
  readonly reason: string;
  readonly updatedAt: number;
}

/* ------------------------------------------------------------------------- */
/* Test model (§29, §61)                                                      */
/* ------------------------------------------------------------------------- */

export const Verdict = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  /** Cannot be evaluated yet. Holds the phase at TESTING; never rounds up. */
  PENDING: 'PENDING',
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/**
 * A test's fixed contract, declared before it runs (§29 — criteria may not be
 * rewritten after seeing the result).
 */
export interface TestSpec {
  readonly id: string;
  readonly title: string;
  readonly required: boolean;
  readonly input: string;
  readonly expected: string;
  readonly passCriteria: string;
  readonly failureCondition: string;
}

/** §61 record format. `observed` and `metrics` are runtime output only. */
export interface TestResult {
  readonly spec: TestSpec;
  readonly verdict: Verdict;
  readonly observed: string;
  readonly reason: string;
  readonly metrics: Record<string, JsonValue>;
  readonly timestamp: number;
}

/* ------------------------------------------------------------------------- */
/* Logging (§27)                                                              */
/* ------------------------------------------------------------------------- */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly phase: number;
  readonly source: string;
  readonly message: string;
  readonly data?: Record<string, JsonValue>;
  /** Populated for ERROR entries: what the system did about it. */
  readonly recovery?: string;
}

export interface StateTransition {
  readonly timestamp: number;
  readonly subject: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/* ------------------------------------------------------------------------- */
/* Evidence (§60)                                                             */
/* ------------------------------------------------------------------------- */

/**
 * Which environment produced an evidence bundle. Rule 004: only `REAL_DEVICE`
 * evidence can pass a phase. `DESKTOP_DEV` is a development signal and is labelled
 * as such everywhere it appears, so it can never be mistaken for a device result.
 */
export const EvidenceLeg = {
  REAL_DEVICE: 'REAL_DEVICE',
  DESKTOP_DEV: 'DESKTOP_DEV',
} as const;
export type EvidenceLeg = (typeof EvidenceLeg)[keyof typeof EvidenceLeg];

export interface DeviceInfo {
  readonly userAgent: string;
  readonly platformHint: string;
  readonly osGuess: string;
  readonly browserGuess: string;
  readonly isLikelyIOS: boolean;
  readonly maxTouchPoints: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
  readonly hardwareConcurrency: number;
  readonly languages: readonly string[];
  readonly timezone: string;
}

export interface EvidenceBundle {
  readonly schemaVersion: number;
  readonly leg: EvidenceLeg;
  readonly phase: number;
  readonly phaseName: string;
  readonly createdAt: string;
  readonly appVersion: string;
  /**
   * The commit the app was built from, or `unknown` where the build could not name one.
   *
   * `appVersion` is `package.json`'s and has read `0.1.0` since Phase 0, so it cannot tell one
   * build from another — and that is twice now the question a bundle could not answer: a Phase 5
   * run judged on week-old instruments because a failing deploy had left the phone behind, and a
   * Phase 7 fix whose presence on the device could not be established at all.
   */
  readonly buildCommit: string;
  readonly origin: string;
  readonly secureContext: boolean;
  readonly device: DeviceInfo;
  readonly capabilityMatrix: CapabilityMatrix;
  readonly testResults: readonly TestResult[];
  readonly overallVerdict: PhaseState;
  readonly overallReason: string;
  readonly stateTransitions: readonly StateTransition[];
  readonly errorLog: readonly LogEntry[];
  readonly fullLog: readonly LogEntry[];
}
