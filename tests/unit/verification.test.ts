/**
 * Phase 5, driven end to end in Node — and the one test the phase is built around.
 *
 * `VerificationStage` is the exact code the tracking worker runs on a Phase 5 frame. These
 * tests drive it over synthetic scenes whose geometry is known by construction, fold the
 * results into the same `VerificationSession` the app uses, and evaluate the same
 * `Phase5Tests` suite the screen and the evidence read.
 *
 * ## The stage that returns its input
 *
 * v3 §14 names four figures — 30 inliers, ratio 0.35, 100 inliers, ratio 0.50 — and a verifier
 * that marks **every correspondence an inlier** satisfies all four at once, because then the
 * inlier count *is* the correspondence count and the ratio is exactly 1.00. It looks better
 * than a working verifier on every one of them.
 *
 * GEO-003 is what separates them, and it does so with ground truth the verifier never sees:
 * the harness displaces a known 30 % of the targets by 25 px and asks which ones came back as
 * outliers. A verifier that accepts everything scores a recall of exactly zero.
 */

import { describe, expect, it } from 'vitest';
import { CameraState } from '../../src/capture/CameraSource';
import { Verdict } from '../../src/core/types';
import { Rng } from '../../src/core/Rng';
import { SceneTexture } from '../../src/tracking/featureTypes';
import {
  MIN_BASELINE_PX,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  PLANAR_H_SHARE,
  VerificationState,
  deriveVerificationState,
  isPlanarByCounts,
  verifyCorrespondences,
} from '../../src/geometry/verify';
import { GeometricModel } from '../../src/geometry/twoView';
import type { Correspondence } from '../../src/geometry/twoView';
import { VerificationSession } from '../../src/tracking/VerificationSession';
import { runPhase5Tests } from '../../src/testkit/Phase5Tests';
import type { TrackingResult, VerificationReport } from '../../src/tracking/trackingMessages';
import type { VerificationStats } from '../../src/tracking/verificationStats';

/* -------------------------------------------------------------------------- */
/* Synthetic scenes, with the geometry known by construction                   */
/* -------------------------------------------------------------------------- */

const K = [600, 0, 320, 0, 600, 240, 0, 0, 1];

function rotY(a: number): number[] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

function apply3(m: readonly number[], v: readonly number[]): number[] {
  return [
    (m[0] ?? 0) * (v[0] ?? 0) + (m[1] ?? 0) * (v[1] ?? 0) + (m[2] ?? 0) * (v[2] ?? 0),
    (m[3] ?? 0) * (v[0] ?? 0) + (m[4] ?? 0) * (v[1] ?? 0) + (m[5] ?? 0) * (v[2] ?? 0),
    (m[6] ?? 0) * (v[0] ?? 0) + (m[7] ?? 0) * (v[1] ?? 0) + (m[8] ?? 0) * (v[2] ?? 0),
  ];
}

function project(p: readonly number[]): { x: number; y: number } | null {
  const z = p[2] ?? 0;
  if (z <= 0.1) return null;
  const u = apply3(K, [(p[0] ?? 0) / z, (p[1] ?? 0) / z, 1]);
  const x = u[0] ?? 0;
  const y = u[1] ?? 0;
  if (x < 0 || x > 640 || y < 0 || y > 480) return null;
  return { x, y };
}

interface SceneOptions {
  readonly count?: number;
  readonly seed?: number;
  /** `true` puts every point on one plane — the case v3 §16 exists for. */
  readonly planar?: boolean;
  /** Camera translation between the two views, in scene units. */
  readonly translation?: number;
  readonly rotation?: number;
}

function scene(o: SceneOptions = {}): Correspondence[] {
  // 0.9, not 0.4: the first version put the two views 13 px apart, just under
  // `MIN_BASELINE_PX`, so every frame was correctly refused and nothing was ever judged. The
  // floor is the plan's and is not the thing to move — the fixture is, and a scene the camera
  // barely moved through is a separate test below rather than the default.
  const { count = 70, seed = 0xc0de, planar = false, translation = 0.9, rotation = 0.05 } = o;
  const rng = new Rng(seed);
  const r = rotY(rotation);
  const t = [translation, 0, 0];
  const out: Correspondence[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 60) {
    const z = planar ? 5 : 3 + rng.next() * 5;
    const X = [rng.next() * 4 - 2, rng.next() * 3 - 1.5, z];
    const a = project(X);
    const b = project(
      apply3(r, [(X[0] ?? 0) - (t[0] ?? 0), (X[1] ?? 0) - (t[1] ?? 0), (X[2] ?? 0) - (t[2] ?? 0)]),
    );
    if (!a || !b) continue;
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* A run harness, over the real session and the real suite                     */
/* -------------------------------------------------------------------------- */

/**
 * A verifier that marks every correspondence an inlier.
 *
 * Shaped exactly like the real result so nothing downstream can tell by the shape. This is
 * what "not verifying" looks like, and it is the failure GEO-003 exists to catch.
 */
function acceptEverything(points: readonly Correspondence[], seed: number): VerificationReport {
  const n = points.length;
  const baseline = medianOf(points.map((c) => Math.hypot(c.bx - c.ax, c.by - c.ay)));
  const spread = spreadOf(points);
  const state = deriveVerificationState({
    correspondences: n,
    baselinePx: baseline,
    inliers: n,
    inlierRatio: 1,
    spreadPx: spread,
  });
  return {
    frames: 0,
    correspondences: n,
    anchorAge: 10,
    reAnchored: false,
    reAnchorReason: '',
    state: state.state,
    stateReason: state.reason,
    goodBlockedBy: state.goodBlockedBy,
    baselinePx: baseline,
    model: 'FUNDAMENTAL',
    inliers: n,
    outliers: 0,
    inlierRatio: 1,
    fundamentalInliers: n,
    homographyInliers: n,
    planar: true,
    spreadPx: spread,
    degenerate: false,
    meanErrorPx: 0,
    iterations: 1,
    terminatedEarly: true,
    verifyMs: 0.1,
    seed,
    injection: null,
  };
}

function reportFor(points: readonly Correspondence[], seed: number): VerificationReport {
  const r = verifyCorrespondences(points, seed);
  return {
    frames: 0,
    correspondences: r.correspondences,
    anchorAge: 10,
    reAnchored: false,
    reAnchorReason: '',
    state: r.state,
    stateReason: r.reason,
    goodBlockedBy: r.goodBlockedBy,
    baselinePx: r.baselinePx,
    model: r.model,
    inliers: r.inlierCount,
    outliers: r.outliers.length,
    inlierRatio: r.inlierRatio,
    fundamentalInliers: r.fundamentalInliers,
    homographyInliers: r.homographyInliers,
    planar: r.planar,
    spreadPx: r.spreadPx,
    degenerate: r.degenerate,
    meanErrorPx: r.meanErrorPx,
    iterations: r.iterations,
    terminatedEarly: r.terminatedEarly,
    verifyMs: 0.5,
    seed,
    injection: null,
  };
}

/** The GEO-003 injection, applied by the harness exactly as `VerificationStage` does. */
function withInjection(
  report: VerificationReport,
  points: readonly Correspondence[],
  seed: number,
  verify: (pts: readonly Correspondence[], s: number) => VerificationReport,
): VerificationReport {
  const rng = new Rng(seed);
  const n = points.length;
  const chosen = new Set(rng.sampleDistinct(Math.max(1, Math.round(n * 0.3)), n));
  const corrupted = points.map((c, i) => {
    if (!chosen.has(i)) return c;
    const angle = rng.next() * Math.PI * 2;
    return { ...c, bx: c.bx + Math.cos(angle) * 25, by: c.by + Math.sin(angle) * 25 };
  });
  const result = verify(corrupted, seed ^ 0x1234);
  // The harness re-derives the outlier set from the verifier's own report shape.
  const outlierSet = outliersOf(corrupted, result);
  let injectedRejected = 0;
  for (const i of chosen) if (outlierSet.has(i)) injectedRejected++;
  let cleanRejected = 0;
  for (const i of outlierSet) if (!chosen.has(i)) cleanRejected++;
  const cleanCount = n - chosen.size;
  return {
    ...report,
    injection: {
      injected: chosen.size,
      clean: cleanCount,
      injectedRejected,
      cleanRejected,
      injectedRecall: chosen.size > 0 ? injectedRejected / chosen.size : -1,
      cleanRejectionRate: cleanCount > 0 ? cleanRejected / cleanCount : -1,
      survivingInliers: result.inliers,
      state: result.state,
      displacementPx: 25,
      seed,
    },
  };
}

/** Which indices the verifier rejected. `acceptEverything` rejects none, by construction. */
function outliersOf(points: readonly Correspondence[], report: VerificationReport): Set<number> {
  if (report.outliers === 0) return new Set();
  const r = verifyCorrespondences(points, report.seed);
  return new Set(r.outliers);
}

function frameFor(report: VerificationReport, texture: SceneTexture): TrackingResult {
  return {
    kind: 'phase3',
    detected: true,
    count: report.correspondences,
    detectMs: 1,
    detectWidth: 320,
    detectHeight: 240,
    detectLevel: 1,
    meanGradient: texture === SceneTexture.RICH ? 12 : 2,
    texture,
    maxCornerStrength: 100,
    candidateCount: report.correspondences,
    occupiedCells: 20,
    maxCellShare: 0.1,
    quota: 17,
    state: 'FEATURES_OK',
    contrast: null,
    gridComparison: null,
    refill: null,
    recordSamples: [],
    level0Calibration: null,
    overlay: null,
    flow: null,
    flowAge: null,
    verification: report,
    pose: null,
  };
}

interface Outcome {
  readonly stats: VerificationStats;
  readonly results: ReturnType<typeof runPhase5Tests>;
}

function run(
  verify: (pts: readonly Correspondence[], s: number) => VerificationReport,
  opts: { frames?: number; planar?: boolean; texture?: SceneTexture; count?: number } = {},
): Outcome {
  const { frames = 40, planar = false, texture = SceneTexture.RICH, count = 70 } = opts;
  const session = new VerificationSession();
  for (let i = 0; i < frames; i++) {
    const pts = scene({ seed: 0x1000 + i, planar, count });
    const report = verify(pts, 0xabc0 + i);
    // Every third frame carries the GEO-003 measurement, as the stage samples it.
    const withInj = i % 3 === 0 ? withInjection(report, pts, 0x5000 + i, verify) : report;
    session.record(frameFor(withInj, texture), i * 33);
  }
  const stats = session.stats(true);
  return {
    stats,
    results: runPhase5Tests({
      cameraState: CameraState.LIVE,
      pipelineEverStarted: true,
      verificationEverRan: true,
      stats,
    }),
  };
}

function verdictOf(results: ReturnType<typeof runPhase5Tests>, id: string): Verdict {
  return results.find((r) => r.spec.id === id)?.verdict ?? Verdict.PENDING;
}

function reasonOf(results: ReturnType<typeof runPhase5Tests>, id: string): string {
  return results.find((r) => r.spec.id === id)?.reason ?? '';
}

function medianOf(v: number[]): number {
  if (v.length === 0) return -1;
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function spreadOf(points: readonly Correspondence[]): number {
  if (points.length === 0) return 0;
  const cx = points.reduce((a, c) => a + c.ax, 0) / points.length;
  const cy = points.reduce((a, c) => a + c.ay, 0) / points.length;
  return points.reduce((a, c) => a + Math.hypot(c.ax - cx, c.ay - cy), 0) / points.length;
}

/* ========================================================================== */

describe('a working verifier on a scene with depth', () => {
  const outcome = run(reportFor);

  it('reaches v3 §14’s usable figures', () => {
    expect(outcome.stats.judgedFrames).toBeGreaterThanOrEqual(15);
    expect(outcome.stats.medianInliers).toBeGreaterThanOrEqual(MIN_INLIERS);
    expect(outcome.stats.medianInlierRatio).toBeGreaterThanOrEqual(0.35);
    expect(verdictOf(outcome.results, 'GEO-001')).toBe(Verdict.PASS);
  });

  it('rejects outliers it was never told about — the gate', () => {
    expect(outcome.stats.injectionSamples).toBeGreaterThanOrEqual(10);
    expect(outcome.stats.medianInjectedRecall).toBeGreaterThanOrEqual(0.9);
    expect(outcome.stats.medianCleanRejection).toBeLessThanOrEqual(0.3);
    expect(verdictOf(outcome.results, 'GEO-003')).toBe(Verdict.PASS);
  });

  it('fits both models on every judged frame (v3 §16)', () => {
    expect(outcome.stats.bothModelsFitted).toBeGreaterThanOrEqual(15);
    expect(outcome.stats.planarMismatches).toBe(0);
    // A scene with real depth: the fundamental matrix should have the advantage.
    expect(outcome.stats.medianFundamentalInliers).toBeGreaterThan(
      outcome.stats.medianHomographyInliers,
    );
    expect(outcome.stats.nonPlanarFrames).toBeGreaterThan(0);
  });

  it('keeps the partition intact and claims no model it did not verify', () => {
    expect(outcome.stats.partitionFaults).toBe(0);
    expect(outcome.stats.modelWithoutVerdict).toBe(0);
    expect(outcome.stats.stateMismatches).toBe(0);
    expect(verdictOf(outcome.results, 'GEO-006')).toBe(Verdict.PASS);
  });
});

describe('a verifier that returns its input', () => {
  const fake = run(acceptEverything);

  it('looks perfect on every figure v3 §14 names', () => {
    // This is the point. Each of these is a *pass* for the fake, and its inlier ratio is
    // better than any real verifier's can be.
    expect(fake.stats.medianInlierRatio).toBe(1);
    expect(fake.stats.medianInliers).toBeGreaterThanOrEqual(MIN_INLIERS);
    expect(
      (fake.stats.stateFrames['USABLE'] ?? 0) + (fake.stats.stateFrames['GOOD'] ?? 0),
    ).toBeGreaterThan(0);
    expect(verdictOf(fake.results, 'GEO-001')).toBe(Verdict.PASS);
  });

  it('reaches v3 §14’s GOOD figures outright when the scene supplies enough points', () => {
    // 140 correspondences, all accepted: 140 inliers at ratio 1.00 clears both of §14's GOOD
    // conditions. A stage doing no work at all reports the best verdict this phase has.
    const rich = run(acceptEverything, { count: 140 });
    expect(rich.stats.stateFrames['GOOD'] ?? 0).toBeGreaterThan(0);
    expect(verdictOf(rich.results, 'GEO-001')).toBe(Verdict.PASS);
    expect(verdictOf(rich.results, 'GEO-003')).toBe(Verdict.FAIL);
  });

  it('FAILS GEO-003, and the reason names the displacement it accepted', () => {
    expect(fake.stats.medianInjectedRecall).toBe(0);
    expect(verdictOf(fake.results, 'GEO-003')).toBe(Verdict.FAIL);
    expect(reasonOf(fake.results, 'GEO-003')).toContain('not verifying');
  });

  it('and so the phase as a whole does not pass', () => {
    const required = fake.results.filter((r) => r.spec.required);
    expect(required.some((r) => r.verdict === Verdict.FAIL)).toBe(true);
  });
});

describe('a planar scene — v3 §16', () => {
  const outcome = run(reportFor, { planar: true });

  it('is flagged planar, from the two inlier counts', () => {
    expect(outcome.stats.planarFrames).toBeGreaterThan(0);
    expect(outcome.stats.medianHomographyInliers).toBeGreaterThanOrEqual(
      outcome.stats.medianFundamentalInliers,
    );
    expect(outcome.stats.planarMismatches).toBe(0);
  });

  it('reports the untested half rather than passing GEO-004 on one outcome', () => {
    // A run that only ever saw planes cannot decide the non-planar half, and says so.
    expect(outcome.stats.nonPlanarFrames).toBe(0);
    expect(verdictOf(outcome.results, 'GEO-004')).toBe(Verdict.PENDING);
    expect(reasonOf(outcome.results, 'GEO-004')).toContain('non-planar');
  });
});

/**
 * The defect this phase's own gate found, pinned so it cannot come back.
 *
 * The first `verify.ts` read v3 §16's "where the Homography wins" as `hCount >= fCount`, and
 * that reading is wrong in exactly the case §16 exists for. On a plane the fundamental matrix
 * is not determined — every `[e]ₓH` is consistent with the correspondences, for any epipole
 * `e` — so RANSAC has two free parameters that the correct data does not constrain, and it
 * spends them on whatever else is in the set. Handed a plane with injected outliers it
 * therefore *out-counts* the homography, wins the comparison, and is selected. The outliers it
 * absorbed then survive as inliers.
 *
 * The measurement below is the one recorded in `docs/phase5/TEST-PLAN.md`'s amendment. Read the
 * two numbers in the first test in order: the homography finds every injected outlier and the
 * fundamental matrix does not, and *the fundamental matrix still has more inliers*. Counting is
 * the wrong comparison between a model that pins both of a correspondence's degrees of freedom
 * and one that pins a single one.
 */
describe('a plane with outliers — the case that broke the count comparison', () => {
  /** A plane, 30 % of its targets displaced 25 px, exactly as `VerificationStage` corrupts. */
  function corruptedPlane(seed: number): {
    points: Correspondence[];
    injected: Set<number>;
  } {
    const clean = scene({ planar: true, count: 100, seed });
    const rng = new Rng(seed ^ 0x51de);
    const injected = new Set(rng.sampleDistinct(Math.round(clean.length * 0.3), clean.length));
    const points = clean.map((c, i) => {
      if (!injected.has(i)) return c;
      const angle = rng.next() * Math.PI * 2;
      return { ...c, bx: c.bx + Math.cos(angle) * 25, by: c.by + Math.sin(angle) * 25 };
    });
    return { points, injected };
  }

  it('the homography rejects every injected outlier and the fundamental matrix does not', () => {
    for (const seed of [0xc0de, 0xbeef, 0x1234]) {
      const { points, injected } = corruptedPlane(seed);
      const r = verifyCorrespondences(points, seed);
      const clean = points.length - injected.size;

      // The homography's support is the untouched set, to the point. Not "about" it.
      expect(r.homographyInliers).toBe(clean);
      // ...and the fundamental matrix's is larger, because it captured some of the outliers
      // with the epipole a planar scene leaves free. This is the trap: on raw counts, the
      // degenerate model wins on a plane whenever there is anything in the set to absorb.
      expect(r.fundamentalInliers).toBeGreaterThan(r.homographyInliers);
    }
  });

  it('is still called planar, and still selects the homography', () => {
    for (const seed of [0xc0de, 0xbeef, 0x1234]) {
      const { points } = corruptedPlane(seed);
      const r = verifyCorrespondences(points, seed);
      expect(r.planar).toBe(true);
      expect(r.model).toBe(GeometricModel.HOMOGRAPHY);
    }
  });

  it('and so rejects every outlier the harness injected', () => {
    for (const seed of [0xc0de, 0xbeef, 0x1234]) {
      const { points, injected } = corruptedPlane(seed);
      const r = verifyCorrespondences(points, seed);
      const rejected = new Set(r.outliers);
      let found = 0;
      for (const i of injected) if (rejected.has(i)) found++;
      // 1.00, not 0.77–0.87. Under the withdrawn rule this run selected the fundamental
      // matrix and GEO-003 read the recall of a model that had absorbed the outliers.
      expect(found / injected.size).toBe(1);
      // ...without rejecting anything it should have kept.
      expect(r.outliers.length).toBe(injected.size);
    }
  });

  it('separates a plane from a two-depth scene with room on both sides', () => {
    const share = (f: number, h: number): number => h / (h + f);
    const planar = verifyCorrespondences(corruptedPlane(0xc0de).points, 0xc0de);
    const depth = verifyCorrespondences(scene({ count: 100, seed: 0xc0de }), 0xc0de);
    const planarShare = share(planar.fundamentalInliers, planar.homographyInliers);
    const depthShare = share(depth.fundamentalInliers, depth.homographyInliers);

    expect(planarShare).toBeGreaterThan(PLANAR_H_SHARE);
    expect(depthShare).toBeLessThan(PLANAR_H_SHARE);
    // The margin is the point. A rule that separated these by a hundredth would be a rule
    // that decides on noise, and the withdrawn one separated them by a single inlier.
    expect(planarShare - PLANAR_H_SHARE).toBeGreaterThan(0.015);
    expect(PLANAR_H_SHARE - depthShare).toBeGreaterThan(0.015);
  });

  it('exposes the rule as one function, so the three places that need it cannot drift', () => {
    // `verify.ts` decides it, `VerificationSession` re-derives it to check the flag against
    // its own inputs (GEO-004), and these tests assert on it.
    expect(isPlanarByCounts(100, 100)).toBe(true);
    expect(isPlanarByCounts(77, 70)).toBe(true);
    expect(isPlanarByCounts(72, 48)).toBe(false);
    // A homography that fitted nothing is not evidence of a plane, whatever the arithmetic.
    expect(isPlanarByCounts(0, 0)).toBe(false);
    expect(isPlanarByCounts(50, 0)).toBe(false);
  });
});

describe('a scene the camera barely moved through', () => {
  const still = run((pts, s) => reportFor(pts, s), { count: 70 });

  it('refuses to verify a frame pair with no baseline', () => {
    // Built directly rather than through the run harness: this is about one frame.
    const pts = scene({ translation: 0.001, rotation: 0.0002 });
    const r = verifyCorrespondences(pts, 1);
    expect(r.baselinePx).toBeLessThan(MIN_BASELINE_PX);
    expect(r.state).toBe(VerificationState.UNVERIFIED);
    expect(r.reason).toContain('verify nothing');
    // ...and it is not because it found no inliers. Every model fits a motionless pair.
    expect(still.stats.judgedFrames).toBeGreaterThan(0);
  });

  it('says so rather than reporting the ratio of 1.00 that a still pair produces', () => {
    const pts = scene({ translation: 0.0005, rotation: 0 });
    const r = verifyCorrespondences(pts, 2);
    expect(r.state).toBe(VerificationState.UNVERIFIED);
    expect(r.model).toBeNull();
  });
});

describe('a scene with too few correspondences', () => {
  it('declines rather than fitting a model to a handful', () => {
    const pts = scene({ count: MIN_CORRESPONDENCES - 5 });
    const r = verifyCorrespondences(pts, 3);
    expect(r.state).toBe(VerificationState.UNVERIFIED);
    expect(r.model).toBeNull();
    expect(r.inlierCount).toBe(0);
    // GEO-006: a frame that verified nothing carries no model.
    expect(r.outliers.length).toBe(pts.length);
  });

  it('fails GEO-002 when a stage claims a verdict on a set too small for one', () => {
    // `acceptEverything` still routes its state through the shared function, so on 15
    // correspondences it declines like the real verifier does — which is worth knowing: the
    // count-based fake cannot fail GEO-002. The failure GEO-002 exists for is a stage that
    // reports the *state* regardless of its inputs, so that is what is built here.
    const claimUsable = (pts: readonly Correspondence[], seed: number): VerificationReport => ({
      ...acceptEverything(pts, seed),
      state: VerificationState.USABLE,
      stateReason: 'claimed without reference to the inputs',
      goodBlockedBy: [],
    });
    const outcome = run(claimUsable, {
      texture: SceneTexture.POOR,
      count: MIN_CORRESPONDENCES - 5,
    });
    expect(outcome.stats.texturePoor.usable + outcome.stats.texturePoor.good).toBeGreaterThan(0);
    expect(verdictOf(outcome.results, 'GEO-002')).toBe(Verdict.FAIL);
    // ...and the mismatch counter sees it too, because the session re-derives the state from
    // the inputs the stage reported (Rule 002).
    expect(outcome.stats.stateMismatches).toBeGreaterThan(0);
  });

  it('passes GEO-002 when the verifier declines, as it should', () => {
    const outcome = run(reportFor, {
      texture: SceneTexture.POOR,
      count: MIN_CORRESPONDENCES - 5,
    });
    expect(outcome.stats.texturePoor.usable + outcome.stats.texturePoor.good).toBe(0);
    expect(verdictOf(outcome.results, 'GEO-002')).toBe(Verdict.PASS);
  });
});

describe('v3 §14’s state function', () => {
  const base = {
    correspondences: 200,
    baselinePx: 40,
    inliers: 150,
    inlierRatio: 0.75,
    spreadPx: 90,
  };

  it('is GOOD only above both of v3 §14’s GOOD figures', () => {
    expect(deriveVerificationState(base).state).toBe(VerificationState.GOOD);
    expect(deriveVerificationState({ ...base, inliers: 80 }).state).toBe(
      VerificationState.USABLE,
    );
    expect(deriveVerificationState({ ...base, inlierRatio: 0.45 }).state).toBe(
      VerificationState.USABLE,
    );
  });

  it('is UNVERIFIED below v3 §14’s minimum inliers, whatever the ratio', () => {
    // 29 inliers out of 30 correspondences is a ratio of 0.97 and still under the floor.
    const d = deriveVerificationState({
      ...base,
      correspondences: 30,
      inliers: 29,
      inlierRatio: 0.967,
    });
    expect(d.state).toBe(VerificationState.UNVERIFIED);
    expect(d.reason).toContain('30');
  });

  it('is UNVERIFIED on a tight cluster, whatever the count', () => {
    const d = deriveVerificationState({ ...base, spreadPx: 5 });
    expect(d.state).toBe(VerificationState.UNVERIFIED);
    expect(d.reason).toContain('centroid');
  });

  it('names what a USABLE verdict is missing rather than only reporting the state', () => {
    const d = deriveVerificationState({ ...base, inliers: 80, inlierRatio: 0.4 });
    expect(d.state).toBe(VerificationState.USABLE);
    expect(d.goodBlockedBy).toHaveLength(2);
  });
});
