/**
 * Down, in the world — measured, not assumed (Phase 11, v4 §23–§24).
 *
 * The world's axes are the first registered keyframe's camera axes, tilted however the phone was
 * tilted then. `GravityMonitor` measures down in the **device** frame. Between the two sits the
 * rotation from device to camera, and that is the quantity this project has repeatedly refused to
 * assume: Phase 7's hand-eye calibration exists because assuming it put the visual pose into the
 * filter inverted.
 *
 * ## What is actually unknown, and how small a set it is
 *
 * The rear camera looks out of the back of the phone, so its optical axis is the device's −z.
 * What is *not* fixed is how the image is laid out on the sensor's readout: Safari delivers the
 * frame rotated to match the screen (Phase 1 measured 1280×720 ↔ 720×1280 on one track), so the
 * image's x axis is the device's x, −y, −x or y. Four candidates, each a rotation about the
 * optical axis applied to the portrait mapping `diag(1, −1, −1)`.
 *
 * ## How the right one is found
 *
 * For a candidate `X`, each localized frame gives an estimate of down in the world:
 *
 * ```
 *   ŵ_k = R_kᵀ · X · d_k
 * ```
 *
 * where `R_k` is that frame's world→camera rotation (Phase 12's pose, from the map) and `d_k` the
 * device-frame down. The true down is **one fixed direction**, so under the right `X` every
 * frame gives the same answer, and under a wrong one the answers swing as the camera turns. The
 * candidate whose estimates agree is the measurement; the spread of the agreement is its error
 * bar; and how much worse the runner-up does is what says the data could tell them apart at all.
 *
 * A camera that never turned cannot discriminate — every candidate is constant then — so the
 * estimate stays `UNKNOWN` until the frames span `MIN_DIVERSITY_DEG` of viewing direction. That
 * is this module's version of the hand-eye's axis-spread floor: a missing quantity carried as an
 * absence, never as the identity.
 *
 * Pure arithmetic over arrays, as the architecture audit requires of this layer.
 */

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase11/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** Frames before an estimate is attempted. */
export const MIN_GRAVITY_SAMPLES = 30;
/** How far the camera must have turned across those frames for the candidates to separate. */
export const MIN_DIVERSITY_DEG = 15;
/**
 * The agreement the winning candidate must reach, degrees.
 *
 * Phase 6's rotation agreed with the gyroscope to 0.762° on the device; the platform's attitude
 * is good to a degree or two; pairing a frame with a sensor reading up to 60 ms away adds a
 * little more while the phone moves. Six degrees is three times the sum.
 */
export const MAX_SPREAD_DEG = 6;
/**
 * ...and the runner-up must do at least this much worse, in ratio and in degrees, for an estimate
 * to be **made**.
 *
 * The ratio was 2 and became 1.6 when a hand-held feed — poses ±4° noisy, motion yaw-only — gave
 * the right layout 4.2° against 7.1° for the runner-up and the estimate sat at UNKNOWN for over a
 * minute. The two spreads are variances of a few hundred frames, and a 1.7 ratio in spread (2.9 in
 * variance) is well past what chance gives at that size.
 */
export const MIN_DISCRIMINATION_RATIO = 1.6;
export const MIN_DISCRIMINATION_DEG = 2;
/**
 * ...and to be **kept** once made: the same layout still best, its spread still within the bar,
 * and the runner-up still this much worse. Which way is down does not change because one noisy
 * minute made the layouts look alike; an estimate that flipped with every update flickered READY
 * on and off and took the stage with it.
 */
export const KEEP_DISCRIMINATION_RATIO = 1.25;
export const KEEP_DISCRIMINATION_DEG = 1;
/** Bound on the samples kept. Newest kept. */
export const MAX_GRAVITY_SAMPLES = 600;

/** The four in-plane layouts, by the angle the image is turned about the optical axis. */
export const CANDIDATE_ANGLES = [0, 90, 180, 270] as const;

export const GravityState = {
  UNKNOWN: 'UNKNOWN',
  ESTIMATED: 'ESTIMATED',
} as const;
export type GravityState = (typeof GravityState)[keyof typeof GravityState];

export interface GravityPairing {
  /** World→camera rotation of a localized frame, row-major. */
  readonly rotation: readonly number[];
  /** Device-frame unit down vector paired with that frame. */
  readonly deviceDown: readonly number[];
  /** The screen orientation the frame was taken in — samples are solved per orientation. */
  readonly screenAngle: number;
}

export interface CandidateScore {
  readonly angleDeg: number;
  readonly spreadDeg: number;
  readonly down: readonly number[];
}

export interface GravityEstimate {
  readonly state: GravityState;
  readonly reason: string;
  /** Unit vector toward the ground, world frame. `null` while UNKNOWN. */
  readonly worldDown: readonly number[] | null;
  readonly spreadDeg: number;
  readonly runnerUpSpreadDeg: number;
  /** The in-plane layout that won, for the orientation group that decided. `-1` while UNKNOWN. */
  readonly candidateDeg: number;
  readonly samples: number;
  readonly diversityDeg: number;
  readonly candidates: readonly CandidateScore[];
}

export const UNKNOWN_GRAVITY: GravityEstimate = {
  state: GravityState.UNKNOWN,
  reason: 'no localized frame has been paired with a gravity reading yet',
  worldDown: null,
  spreadDeg: -1,
  runnerUpSpreadDeg: -1,
  candidateDeg: -1,
  samples: 0,
  diversityDeg: -1,
  candidates: [],
};

export class GravityAligner {
  private readonly samples: GravityPairing[] = [];
  /** The layout and screen orientation the standing estimate was made under, for the keep bar. */
  private standing: { angleDeg: number; screenAngle: number } | null = null;

  reset(): void {
    this.samples.length = 0;
    this.standing = null;
  }

  size(): number {
    return this.samples.length;
  }

  add(pairing: GravityPairing): void {
    if (pairing.rotation.length !== 9 || pairing.deviceDown.length !== 3) return;
    if (!pairing.rotation.every(Number.isFinite) || !pairing.deviceDown.every(Number.isFinite)) return;
    this.samples.push(pairing);
    if (this.samples.length > MAX_GRAVITY_SAMPLES) this.samples.shift();
  }

  /**
   * Solve each screen orientation separately — a rotation of the phone mid-run changes the image
   * layout — and report the group with the most samples that decided.
   */
  estimate(): GravityEstimate {
    if (this.samples.length < MIN_GRAVITY_SAMPLES) {
      return {
        ...UNKNOWN_GRAVITY,
        reason: `${this.samples.length}/${MIN_GRAVITY_SAMPLES} localized frames paired with a gravity reading`,
        samples: this.samples.length,
      };
    }
    const groups = new Map<number, GravityPairing[]>();
    for (const s of this.samples) {
      const g = groups.get(s.screenAngle) ?? [];
      g.push(s);
      groups.set(s.screenAngle, g);
    }
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length);
    let lastRefusal: GravityEstimate | null = null;
    for (const group of ordered) {
      const screenAngle = group[0]?.screenAngle ?? 0;
      const keep = this.standing && this.standing.screenAngle === screenAngle ? this.standing.angleDeg : null;
      const e = solveGroup(group, keep);
      if (e.state === GravityState.ESTIMATED) {
        this.standing = { angleDeg: e.candidateDeg, screenAngle };
        return { ...e, samples: this.samples.length };
      }
      lastRefusal ??= e;
    }
    // Nothing decided: whatever was standing no longer is.
    this.standing = null;
    return { ...(lastRefusal ?? UNKNOWN_GRAVITY), samples: this.samples.length };
  }
}

/**
 * @param standing the layout an estimate already stands under for this group, or `null`. It is held
 *   to the looser keep bar rather than the one for making an estimate.
 */
export function solveGroup(group: readonly GravityPairing[], standing: number | null = null): GravityEstimate {
  if (group.length < MIN_GRAVITY_SAMPLES) {
    return {
      ...UNKNOWN_GRAVITY,
      reason: `${group.length}/${MIN_GRAVITY_SAMPLES} frames in the largest screen orientation`,
      samples: group.length,
    };
  }
  const diversity = viewingDiversityDeg(group);
  const scores = CANDIDATE_ANGLES.map((angle) => scoreCandidate(group, angle)).sort(
    (a, b) => a.spreadDeg - b.spreadDeg,
  );
  const best = scores[0];
  const runnerUp = scores[1];
  const base = {
    spreadDeg: best ? round(best.spreadDeg, 3) : -1,
    runnerUpSpreadDeg: runnerUp ? round(runnerUp.spreadDeg, 3) : -1,
    samples: group.length,
    diversityDeg: round(diversity, 2),
    candidates: scores.map((s) => ({ ...s, spreadDeg: round(s.spreadDeg, 3), down: s.down.map((v) => round(v, 6)) })),
  };
  if (!best || !runnerUp) return { ...UNKNOWN_GRAVITY, ...base };
  if (diversity < MIN_DIVERSITY_DEG) {
    return {
      ...UNKNOWN_GRAVITY,
      ...base,
      reason:
        `the camera has turned through ${round(diversity, 1)}° of viewing direction, below the ` +
        `${MIN_DIVERSITY_DEG}° at which the four image layouts give different answers — look around more`,
    };
  }
  if (best.spreadDeg > MAX_SPREAD_DEG) {
    return {
      ...UNKNOWN_GRAVITY,
      ...base,
      reason:
        `the best layout still leaves the frames' estimates of down ${round(best.spreadDeg, 2)}° apart, ` +
        `past ${MAX_SPREAD_DEG}° — the pose and the sensor do not agree about which way is down`,
    };
  }
  const keeping = standing !== null && best.angleDeg === standing;
  const ratio = keeping ? KEEP_DISCRIMINATION_RATIO : MIN_DISCRIMINATION_RATIO;
  const margin = keeping ? KEEP_DISCRIMINATION_DEG : MIN_DISCRIMINATION_DEG;
  if (runnerUp.spreadDeg < best.spreadDeg * ratio || runnerUp.spreadDeg - best.spreadDeg < margin) {
    return {
      ...UNKNOWN_GRAVITY,
      ...base,
      reason:
        `the best layout (${best.angleDeg}°, ${round(best.spreadDeg, 2)}°) is not separated from the ` +
        `runner-up (${runnerUp.angleDeg}°, ${round(runnerUp.spreadDeg, 2)}°) — the motion so far ` +
        'cannot tell them apart. Tilt the phone up and down as well as turning it',
    };
  }
  return {
    state: GravityState.ESTIMATED,
    reason:
      `${group.length} frames agree on down to ${round(best.spreadDeg, 2)}° under the ${best.angleDeg}° ` +
      `image layout; the runner-up spreads ${round(runnerUp.spreadDeg, 2)}°`,
    worldDown: best.down.map((v) => round(v, 6)),
    candidateDeg: best.angleDeg,
    ...base,
  };
}

/** `X_φ = Rz(φ) · diag(1, −1, −1)`: device → camera for an image turned by φ about the optical axis. */
export function deviceToCamera(angleDeg: number): number[] {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.round(Math.cos(a));
  const s = Math.round(Math.sin(a));
  // Rz(φ) · diag(1, −1, −1)
  return [c, s, 0, s, -c, 0, 0, 0, -1];
}

export function scoreCandidate(group: readonly GravityPairing[], angleDeg: number): CandidateScore {
  const x = deviceToCamera(angleDeg);
  const estimates = group.map((s) => {
    const cam = apply(x, s.deviceDown);
    return unit(applyTransposed(s.rotation, cam));
  });
  const sum = [0, 0, 0];
  for (const e of estimates) for (let i = 0; i < 3; i++) sum[i] = (sum[i] ?? 0) + (e[i] ?? 0);
  const mean = unit(sum);
  const angles = estimates.map((e) => angleBetween(e, mean));
  return { angleDeg, spreadDeg: median(angles), down: mean };
}

/** The largest angle any frame's optical axis makes with their mean. */
export function viewingDiversityDeg(group: readonly GravityPairing[]): number {
  const axes = group.map((s) => [s.rotation[6] ?? 0, s.rotation[7] ?? 0, s.rotation[8] ?? 0]);
  const sum = [0, 0, 0];
  for (const a of axes) for (let i = 0; i < 3; i++) sum[i] = (sum[i] ?? 0) + (a[i] ?? 0);
  const mean = unit(sum);
  let worst = 0;
  for (const a of axes) worst = Math.max(worst, angleBetween(unit(a), mean));
  return 2 * worst;
}

function apply(m: readonly number[], v: readonly number[]): number[] {
  return [0, 1, 2].map(
    (i) => (m[i * 3] ?? 0) * (v[0] ?? 0) + (m[i * 3 + 1] ?? 0) * (v[1] ?? 0) + (m[i * 3 + 2] ?? 0) * (v[2] ?? 0),
  );
}

function applyTransposed(m: readonly number[], v: readonly number[]): number[] {
  return [0, 1, 2].map(
    (i) => (m[i] ?? 0) * (v[0] ?? 0) + (m[3 + i] ?? 0) * (v[1] ?? 0) + (m[6 + i] ?? 0) * (v[2] ?? 0),
  );
}

function unit(v: readonly number[]): number[] {
  const n = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
  return n > 1e-12 ? v.map((x) => x / n) : [0, 0, 0];
}

function angleBetween(a: readonly number[], b: readonly number[]): number {
  const d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Infinity;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
