/**
 * Evidence recorder (§60, §61).
 *
 * Assembles the bundle that a phase verdict rests on. Two design points matter:
 *
 *  - **The leg is derived from recorded signals, not asserted.** Whether a run counts as
 *    REAL_DEVICE decides whether a phase can pass at all (Rule 004), so every signal that
 *    fed the decision is written into the bundle for a reviewer to check, and the one
 *    inferred signal (the UA guess) is named as inferred.
 *
 *  - **The bundle is validated before it is offered for download.** An evidence file
 *    containing NaN would be evidence of nothing.
 */

import { EvidenceLeg, PhaseState } from '../core/types';
import type {
  CapabilityMatrix,
  DeviceInfo,
  EvidenceBundle,
  JsonValue,
  LogEntry,
  StateTransition,
  TestResult,
} from '../core/types';
import { findIntegrityIssues } from '../core/validate';

export const EVIDENCE_SCHEMA_VERSION = 1;

/**
 * The commit this build came from, read once.
 *
 * Through `typeof` because vite's `define` does not run in Node, where this module is imported
 * by the unit tests — there the answer is `unknown`, which is the true one.
 */
export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__.length > 0
    ? __BUILD_COMMIT__
    : 'unknown';

export interface LegDetermination {
  readonly leg: EvidenceLeg;
  readonly signals: Record<string, JsonValue>;
  readonly explanation: string;
}

/**
 * Decide which leg produced this run.
 *
 * REAL_DEVICE requires all of: an iOS-family UA guess, real touch points, https, a
 * non-local host, and no automation flag. Any one missing means DESKTOP_DEV, because the
 * consequence of wrongly claiming REAL_DEVICE is a phase passing on evidence that does not
 * exist — so the ambiguous case must fall to the side that cannot pass a phase.
 */
export function determineLeg(device: DeviceInfo): LegDetermination {
  const isHttps = location.protocol === 'https:';
  const host = location.hostname;
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  const automated = (navigator as unknown as { webdriver?: boolean }).webdriver === true;
  const hasTouch = device.maxTouchPoints > 0;

  const signals: Record<string, JsonValue> = {
    uaSuggestsIOS: device.isLikelyIOS,
    uaSuggestsIOS_method: 'INFERENCE — user-agent string, not a measurement',
    maxTouchPoints: device.maxTouchPoints,
    protocol: location.protocol,
    hostname: host,
    isLocalHost,
    navigatorWebdriver: automated,
    hardwareConcurrency: device.hardwareConcurrency,
    devicePixelRatio: device.devicePixelRatio,
    screen: `${device.screenWidth}x${device.screenHeight}`,
  };

  const failed: string[] = [];
  if (!device.isLikelyIOS) failed.push('UA does not look like iOS/iPadOS');
  if (!hasTouch) failed.push('maxTouchPoints is 0');
  if (!isHttps) failed.push(`protocol is ${location.protocol}, not https:`);
  if (isLocalHost) failed.push('host is local, so this is not a device reaching a real origin');
  if (automated) failed.push('navigator.webdriver is true (automated browser)');

  if (failed.length === 0) {
    return {
      leg: EvidenceLeg.REAL_DEVICE,
      signals,
      explanation:
        'All real-device signals hold. Note that the iOS check is a user-agent inference; ' +
        'a reviewer should confirm with the device screenshot required by §60 before ' +
        'treating this bundle as proof.',
    };
  }
  return {
    leg: EvidenceLeg.DESKTOP_DEV,
    signals: { ...signals, failedChecks: failed },
    explanation:
      'Classified as DESKTOP_DEV because: ' +
      failed.join('; ') +
      '. Rule 004 means this run cannot pass a phase, only catch regressions.',
  };
}

export interface BuildBundleInput {
  readonly phase: number;
  readonly phaseName: string;
  readonly appVersion: string;
  readonly device: DeviceInfo;
  readonly matrix: CapabilityMatrix;
  readonly testResults: readonly TestResult[];
  readonly overallVerdict: PhaseState;
  readonly overallReason: string;
  readonly transitions: readonly StateTransition[];
  readonly log: readonly LogEntry[];
  /**
   * Phase-specific measurements — the camera ladder and frame statistics for Phase 1, and
   * whatever later phases need. Kept out of the fixed schema so each phase can record what
   * it actually measured without every other phase carrying empty fields.
   */
  readonly context?: Record<string, JsonValue>;
}

export interface BuiltEvidence {
  readonly bundle: EvidenceBundle;
  readonly leg: LegDetermination;
  readonly integrityIssues: readonly { path: string; problem: string }[];
}

export function buildEvidenceBundle(input: BuildBundleInput): BuiltEvidence {
  const leg = determineLeg(input.device);

  const bundle: EvidenceBundle = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    leg: leg.leg,
    phase: input.phase,
    phaseName: input.phaseName,
    createdAt: new Date().toISOString(),
    appVersion: input.appVersion,
    // Not taken from the caller: every one of the eight call sites would have to remember, and
    // the one that forgot would produce a bundle that looked like every other one.
    buildCommit: BUILD_COMMIT,
    origin: location.origin,
    secureContext: window.isSecureContext === true,
    device: input.device,
    capabilityMatrix: input.matrix,
    testResults: [...input.testResults],
    overallVerdict: input.overallVerdict,
    overallReason: input.overallReason,
    // Chronological. The array is merged from more than one source, and an out-of-order
    // history is worse than no history: a reader reconstructing how a verdict was reached
    // would see a phase move to PASSED before the step that made it evaluable.
    stateTransitions: [...input.transitions].sort((a, b) => a.timestamp - b.timestamp),
    errorLog: input.log.filter((e) => e.level === 'ERROR'),
    fullLog: [...input.log],
  };

  // The leg reasoning travels with the bundle rather than only in the UI, so a file
  // reviewed months later still explains why it was or was not device evidence.
  const withLeg = {
    ...bundle,
    legDetermination: { signals: leg.signals, explanation: leg.explanation },
    ...(input.context ? { phaseContext: input.context } : {}),
  } as EvidenceBundle & { legDetermination: unknown };

  const issues = findIntegrityIssues(withLeg, '$');
  return {
    bundle: withLeg,
    leg,
    integrityIssues: issues.map((i) => ({ path: i.path, problem: i.problem })),
  };
}

export function serialiseEvidence(bundle: EvidenceBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Filename carries the verdict, not just the leg and the timestamp.
 *
 * The evidence file is exportable at any point, including while required tests are still
 * PENDING — which is useful for diagnosis and impossible to forbid without hiding the
 * button when it is most needed. But a `TESTING` bundle and a `PASSED` bundle look almost
 * identical at a glance, and mistaking one for the other means recording a phase pass that
 * did not happen. Putting the verdict in the name makes them impossible to confuse in a
 * downloads folder or a file picker.
 */
export function evidenceFilename(bundle: EvidenceBundle): string {
  const stamp = bundle.createdAt.replace(/[:.]/g, '-');
  const leg = bundle.leg.toLowerCase().replace(/_/g, '-');
  return `phase${bundle.phase}-${leg}-${bundle.overallVerdict}-${stamp}.json`;
}
