/**
 * One Phase 5 frame, end to end, with no worker around it (v3 §14, §16, §66).
 *
 * The worker calls this and adds nothing, for the same reason `FlowStage` exists: the Phase 5
 * test plan requires a verifier that returns its input to be *shown* to fail, and a unit test
 * that reimplemented the frame loop to prove that would be proving something about the
 * reimplementation. So the loop lives here, and `tests/unit/verification.test.ts` drives this
 * exact code.
 *
 * ## What happens on a frame
 *
 *  1. **Re-anchor if the anchor no longer supports a two-view geometry** — too few survivors,
 *     or the two views have drifted so far apart that they share little. The anchor is
 *     `FlowTracker`'s and the rule is here, because the rule is Phase 5's.
 *  2. **Verify the real correspondence set.** That is the frame's actual result.
 *  3. **On sampled frames, verify a deliberately corrupted copy** — GEO-003. The harness
 *     displaces a known fraction of the targets by a known amount and records which ones; the
 *     verifier is handed the set with no marking, and its recall against that ground truth is
 *     the one number that separates a verifier from a stage that returns its input.
 *
 * Step 3 is this phase's counterpart to Phase 2's provenance cross-check, Phase 3's contrast
 * statistic and Phase 4's independent scene-shift search, and it is here for the same reason
 * (§H.7): a statistic computed from one side of a comparison cannot verify the comparison.
 * Every count-based criterion v3 §14 names — 30 inliers, ratio 0.35, 100, 0.50 — is satisfied
 * *perfectly* by accepting everything, because then the inlier count is the correspondence
 * count and the ratio is exactly 1.00.
 *
 * No DOM and no worker globals — only `performance.now()`, which exists in both.
 */

import { Rng } from '../core/Rng';
import { verifyCorrespondences, MIN_CORRESPONDENCES, MIN_INLIERS } from '../geometry/verify';
import type { VerificationResult } from '../geometry/verify';
import { medianBaseline } from '../geometry/verify';
import type { Correspondence } from '../geometry/twoView';
import type { FlowTracker } from './FlowTracker';
import type { VerificationInjection, VerificationReport } from './trackingMessages';

/**
 * What Phase 5 produced, in both the shape that crosses to the main thread and the shape the
 * next stage in the same worker needs.
 *
 * The report is the message; the raw result carries the **inlier indices and the fitted matrix**,
 * which do not cross — they would be a per-frame array of hundreds of integers on every message
 * — and which Phase 6 needs, because a pose is recovered from the verified subset and no other.
 * Re-running the fit in Phase 6 to get them back would give a *different* RANSAC answer and the
 * pose would then belong to a model the screen never showed.
 */
export interface VerificationOutcome {
  readonly report: VerificationReport;
  readonly result: VerificationResult;
  readonly correspondences: readonly Correspondence[];
}

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase5/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/**
 * Beyond this median displacement the two views share too little to be one geometry.
 *
 * The anchor is re-taken rather than allowed to drift indefinitely: as the camera moves away
 * from the reference view the surviving correspondences become the few points visible from
 * both, which is a biased sample of the scene and an increasingly ill-posed problem.
 */
export const MAX_BASELINE_PX = 120.0;

/** GEO-003's corruption rate — the fraction of targets the harness displaces. */
export const OUTLIER_INJECTION_FRACTION = 0.3;

/**
 * ...and how far it displaces them, in level-0 pixels.
 *
 * Over sixteen times the inlier threshold, so the injected points are outliers *by
 * construction*: no correct model can accept them, and they are far enough out not to be
 * merely a large but plausible motion. A verifier that fails to reject a 25 px displacement is
 * not rejecting anything.
 */
export const OUTLIER_INJECTION_PX = 25.0;

/** How often the corrupted copy is verified. It costs a second RANSAC pass. */
export const INJECTION_SAMPLE_EVERY = 6;

/**
 * The smallest correspondence set worth injecting into — **derived, not chosen**.
 *
 * GEO-003 asks three things of one corrupted frame at once: that the injected outliers be
 * rejected, that the untouched ones survive, and that *the surviving inlier count still reach*
 * `MIN_INLIERS`. Displacing `OUTLIER_INJECTION_FRACTION` of a set of `n` leaves at most
 * `n - round(n · fraction)` untouched points, so below the `n` where that reaches `MIN_INLIERS`
 * the third criterion cannot be met **however well RANSAC performs** — the points simply are
 * not there. At the constants in this file that floor is 43.
 *
 * The device run of 2026-08-28 found this by failing on it. The injection ran wherever there
 * were `MIN_CORRESPONDENCES` — 20 — and on the sets between 20 and 43 the recall fell to
 * 0.67–0.78 while the corrupted frame came back `UNVERIFIED` every time. On a set of 31 with 9
 * displaced, drawing eight untouched points for the minimal sample has probability
 * (22/31)^8 ≈ 0.06, so RANSAC spends its whole iteration budget looking for a clean subset
 * that a larger set would hand it immediately. Both facts are about the size of the sample, not
 * about the verifier, and neither is what GEO-003 exists to measure.
 *
 * Computed with the same rounding `measureInjection` uses, so changing either constant moves
 * this floor with it rather than leaving it stale.
 */
export const MIN_INJECTABLE_CORRESPONDENCES = ((): number => {
  for (let n = MIN_CORRESPONDENCES; n < 1000; n++) {
    if (n - Math.max(1, Math.round(n * OUTLIER_INJECTION_FRACTION)) >= MIN_INLIERS) return n;
  }
  return MIN_CORRESPONDENCES;
})();

export class VerificationStage {
  private frames = 0;
  /** Seeds every verification and every injection, so a run replays exactly (§59). */
  private readonly seedRng: Rng;

  constructor(seed = 0x9e37_79b9) {
    this.seedRng = new Rng(seed);
  }

  reset(): void {
    this.frames = 0;
    this.seedRng.reset();
  }

  /**
   * Verify this frame's correspondences, re-anchoring first if the anchor no longer holds.
   *
   * `tracker` is the live Phase 4 population — Phase 5 inherits it rather than rebuilding one,
   * as §H.5 requires, and what it does with it is written here rather than assumed.
   */
  process(tracker: FlowTracker, wantInjection: boolean): VerificationOutcome {
    this.frames++;

    // 1. Re-anchor. Done before verifying, so the frame that re-anchors reports the honest
    //    "no baseline yet" rather than a stale geometry's numbers.
    let reAnchored = false;
    let reAnchorReason = '';
    const anchored = tracker.anchoredCount();
    if (tracker.getAnchorFrame() < 0) {
      reAnchorReason = 'no anchor yet';
      reAnchored = true;
    } else if (anchored < MIN_CORRESPONDENCES) {
      reAnchorReason =
        `${anchored} of the anchor's points survive, below the ${MIN_CORRESPONDENCES} a ` +
        'two-view model needs';
      reAnchored = true;
    } else {
      const baseline = medianBaseline(tracker.getCorrespondences());
      if (baseline > MAX_BASELINE_PX) {
        reAnchorReason =
          `the two views are ${Math.round(baseline)} px apart, past the ` +
          `${MAX_BASELINE_PX} px beyond which they share too little`;
        reAnchored = true;
      }
    }
    if (reAnchored) tracker.takeAnchor();

    const correspondences = tracker.getCorrespondences();
    const t0 = performance.now();
    const seed = seedFrom(this.seedRng);
    const result = verifyCorrespondences(correspondences, seed);
    const verifyMs = performance.now() - t0;

    // 3. GEO-003, on a sample of frames. The injection is built here — outside the verifier,
    //    which never learns which correspondences were touched.
    let injection: VerificationInjection | null = null;
    if (wantInjection && correspondences.length >= MIN_INJECTABLE_CORRESPONDENCES) {
      injection = this.measureInjection(correspondences);
    }

    const report: VerificationReport = {
      frames: this.frames,
      correspondences: correspondences.length,
      anchorAge: tracker.anchorAge(),
      reAnchored,
      reAnchorReason,
      state: result.state,
      stateReason: result.reason,
      goodBlockedBy: result.goodBlockedBy,
      baselinePx: result.baselinePx,
      model: result.model,
      inliers: result.inlierCount,
      outliers: result.outliers.length,
      inlierRatio: result.inlierRatio,
      fundamentalInliers: result.fundamentalInliers,
      homographyInliers: result.homographyInliers,
      planar: result.planar,
      spreadPx: result.spreadPx,
      degenerate: result.degenerate,
      meanErrorPx: result.meanErrorPx,
      iterations: result.iterations,
      terminatedEarly: result.terminatedEarly,
      verifyMs: round(verifyMs, 3),
      seed,
      injection,
    };
    return { report, result, correspondences };
  }

  /**
   * GEO-003: corrupt a known subset, verify, and score the rejection against ground truth.
   *
   * The harness makes the outliers, so it knows exactly which they are. Two numbers come back
   * and both are needed: the fraction of *injected* correspondences rejected, and the fraction
   * of *untouched* ones rejected. A verifier that rejects everything scores a perfect recall
   * and is caught by the second; one that accepts everything scores zero on the first.
   */
  private measureInjection(clean: readonly Correspondence[]): VerificationInjection {
    const seed = seedFrom(this.seedRng);
    const rng = new Rng(seed);
    const n = clean.length;
    const target = Math.max(1, Math.round(n * OUTLIER_INJECTION_FRACTION));
    const chosen = new Set(rng.sampleDistinct(Math.min(target, n), n));

    const corrupted = clean.map((c, i) => {
      if (!chosen.has(i)) return c;
      // A displacement of fixed magnitude in a seeded direction: the magnitude is what makes
      // it an outlier by construction, and the direction stops every injected point moving
      // the same way, which a model could otherwise absorb as a translation.
      const angle = rng.next() * Math.PI * 2;
      return {
        ...c,
        bx: c.bx + Math.cos(angle) * OUTLIER_INJECTION_PX,
        by: c.by + Math.sin(angle) * OUTLIER_INJECTION_PX,
      };
    });

    const verifySeed = seedFrom(this.seedRng);
    const result: VerificationResult = verifyCorrespondences(corrupted, verifySeed);
    const rejected = new Set(result.outliers);

    let injectedRejected = 0;
    for (const i of chosen) if (rejected.has(i)) injectedRejected++;
    let cleanRejected = 0;
    for (const i of rejected) if (!chosen.has(i)) cleanRejected++;
    const cleanCount = n - chosen.size;

    return {
      correspondences: n,
      injected: chosen.size,
      clean: cleanCount,
      injectedRejected,
      cleanRejected,
      injectedRecall: chosen.size > 0 ? round(injectedRejected / chosen.size, 4) : -1,
      cleanRejectionRate: cleanCount > 0 ? round(cleanRejected / cleanCount, 4) : -1,
      survivingInliers: result.inlierCount,
      state: result.state,
      displacementPx: OUTLIER_INJECTION_PX,
      seed,
    };
  }
}

/** A fresh 32-bit seed, drawn from the stage's own generator so the run stays replayable. */
function seedFrom(rng: Rng): number {
  return Math.floor(rng.next() * 0xffff_ffff) >>> 0;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(n) ? Math.round(n * f) / f : n;
}
