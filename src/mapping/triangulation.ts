/**
 * Sparse structure from two views (Phase 9 — v4 §21, v3 §15, §16).
 *
 * Pure arithmetic over the arrays it is handed. No DOM, no worker, no camera, no clock, and — as
 * the architecture audit enforces for this layer — no import from `tracking` or `testkit`, so the
 * triangulator cannot see the ground truth TRI-004 scores it against. The rule Phase 5 put on
 * `geometry`, Phase 7 put on `fusion` and Phase 8 put on this layer, for the same reason each
 * time.
 *
 * ## What it produces, and what it refuses to
 *
 *   - **A position**, in the **first view's camera frame**, in units of that pair's own
 *     translation — which is a unit vector, so the depths are in units of a baseline whose
 *     length nobody knows. v3 §15 and v4 §18: never a distance.
 *   - **Nothing at all** where the configuration cannot determine one. Two of those are ordinary
 *     in a room and both give an answer that looks entirely reasonable:
 *     a **pure rotation**, where the image motion is large and well conditioned and every ray
 *     pair meets at infinity, and **low parallax**, where the linear system is solvable and its
 *     answer is noise scaled by a very large number.
 *
 * ## Why the gate is an angle
 *
 * A triangulated depth's relative uncertainty is `σ_Z/Z ≈ σ_θ/θ`: the angular error of a
 * correspondence divided by the parallax angle. Both are available here — `σ_θ` is §13's 1.5 px
 * over the focal length, and `θ` is measured per point — so the gate is stated in the units of
 * the physical quantity rather than as a percentile of whatever the frame contained. §H.6 is the
 * rule; Phase 3's corner floor is the reason it exists.
 */

import { RANSAC_THRESHOLD_PX } from '../geometry/verify';
import { apply3x3, dot3, normalise3, transpose3x3 } from '../geometry/linalg';
import { projectRay } from '../geometry/intrinsics';
import type { Intrinsics } from '../geometry/intrinsics';
import { MAX_REPROJECTION_PX, triangulate } from '../geometry/pose';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase9/TEST-PLAN.md before this file existed      */
/* -------------------------------------------------------------------------- */

/**
 * The angular uncertainty of one correspondence, in pixels.
 *
 * §13's forward/backward band, which Phase 5 already reused as `RANSAC_THRESHOLD_PX`. §H.6:
 * prefer a constant the plan has already fixed for another purpose over a new one.
 */
export const CORRESPONDENCE_NOISE_PX = RANSAC_THRESHOLD_PX;

/** What "sufficient parallax" is being asked to buy: a depth good to a tenth of itself. */
export const DEPTH_UNCERTAINTY_LIMIT = 0.1;

/**
 * Below this parallax a depth is not determined — v4 §21's 低視差, as a number.
 *
 * Derived, not chosen: `σ_Z/Z ≈ σ_θ/θ`, and at the assumed 67° field of view a 1280-long-edge
 * frame gives `f ≈ 967 px`, so `σ_θ ≈ 1.5/967 = 0.089°`. Asking for `σ_Z/Z ≤ 0.10` gives
 * `θ ≥ 0.89°`. The arithmetic is pinned in `tests/unit/triangulation.test.ts` so the constant
 * cannot drift away from what derived it.
 */
export const MIN_PARALLAX_DEG = 1.0;

/** v3 §33's GOOD condition, reused rather than re-derived. */
export const MAX_TRIANGULATION_REPROJECTION_PX = MAX_REPROJECTION_PX;

/** Below this a pair is not a two-view geometry. `MIN_CORRESPONDENCES`, reused. */
export const MIN_PAIR_CORRESPONDENCES = 20;

/** v4 §18, carried on every record so a later phase has to remove it deliberately. */
export const SCALE_LOCAL_UNITS = 'LOCAL_UNITS';

export const TriangulationRefusal = {
  /** The linear system had no solution — a point on the baseline, or a degenerate pair. */
  DEGENERATE: 'DEGENERATE',
  /** Behind one camera or the other. A point a camera did not see was not seen by it. */
  BEHIND_CAMERA: 'BEHIND_CAMERA',
  /** v4 §21's prohibition, per point. */
  LOW_PARALLAX: 'LOW_PARALLAX',
  HIGH_REPROJECTION: 'HIGH_REPROJECTION',
} as const;
export type TriangulationRefusal =
  (typeof TriangulationRefusal)[keyof typeof TriangulationRefusal];

/** One correspondence between two keyframes, carrying the feature id both views agree on. */
export interface PairObservation {
  /** `FlowTracker`'s id — what makes a triangulated point recognisable to Phase 10. */
  readonly id: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface TriangulatedPoint {
  readonly id: number;
  /**
   * In the **first** view's camera frame, in units of that pair's baseline.
   *
   * The baseline is `‖t‖ = 1` by construction, and its length in the world is unknown — so these
   * are three numbers with a direction and a ratio, and no distance. Pooling them with another
   * pair's would be averaging over two different units; TRI-007 forbids exactly that, and
   * Phase 10 is where a shared scale is obtained.
   */
  readonly position: readonly number[];
  readonly depth: number;
  readonly parallaxDeg: number;
  /** `σ_θ/θ` — the relative depth uncertainty this parallax actually bought. */
  readonly depthUncertainty: number;
  /** The worse of the two views' reprojection errors, px. */
  readonly reprojectionPx: number;
}

export interface TriangulationOutcome {
  readonly points: readonly TriangulatedPoint[];
  readonly candidates: number;
  readonly refusals: Record<string, number>;
  /** Over every candidate, accepted or not — so the gate's effect is visible. */
  readonly medianParallaxDeg: number;
  readonly medianAcceptedParallaxDeg: number;
  /** The worst accepted point on each gate, so a gate that let one through is visible exactly. */
  readonly minAcceptedParallaxDeg: number;
  readonly maxAcceptedReprojectionPx: number;
  readonly minAcceptedDepth: number;
  readonly medianDepth: number;
  readonly medianDepthUncertainty: number;
  readonly medianReprojectionPx: number;
}

export interface TriangulationInput {
  readonly observations: readonly PairObservation[];
  /** Indices into `observations` that the pair's own fit verified. */
  readonly inliers: readonly number[];
  /** Row-major, first view → second. */
  readonly rotation: readonly number[];
  /** Unit direction, first view → second. Never a distance. */
  readonly translation: readonly number[];
  readonly intrinsics: Intrinsics;
}

/**
 * Triangulate a verified pair, refusing every point the geometry does not determine.
 *
 * The gates run in the order in which a failure makes the later ones meaningless: a point the
 * linear system could not solve has no depth to check the sign of, a point behind a camera has no
 * parallax worth measuring, and a point with too little parallax has a reprojection error that
 * says nothing — a badly conditioned solution reprojects beautifully into both views, which is
 * precisely why the reprojection check cannot be the gate.
 */
export function triangulatePair(input: TriangulationInput): TriangulationOutcome {
  const { observations, inliers, rotation, translation, intrinsics } = input;
  const points: TriangulatedPoint[] = [];
  const refusals: Record<string, number> = {
    [TriangulationRefusal.DEGENERATE]: 0,
    [TriangulationRefusal.BEHIND_CAMERA]: 0,
    [TriangulationRefusal.LOW_PARALLAX]: 0,
    [TriangulationRefusal.HIGH_REPROJECTION]: 0,
  };
  const allParallax: number[] = [];

  // The second camera's centre, expressed in the first camera's frame. `X_b = R X_a + t`, so the
  // centre — where `X_b = 0` — sits at `-Rᵀt`. The parallax is the angle those two rays make at
  // the point, which is what the depth's conditioning actually depends on.
  const centreB = apply3x3(transpose3x3(rotation), translation).map((v) => -v);
  const sigmaThetaRad = CORRESPONDENCE_NOISE_PX / Math.max(1e-6, intrinsics.fx);

  for (const index of inliers) {
    const o = observations[index];
    if (!o) continue;
    const x = triangulate({ x: o.ax, y: o.ay }, { x: o.bx, y: o.by }, intrinsics, rotation, translation);
    if (!x || !x.every((v) => Number.isFinite(v))) {
      refusals[TriangulationRefusal.DEGENERATE] = (refusals[TriangulationRefusal.DEGENERATE] ?? 0) + 1;
      continue;
    }

    const inB = apply3x3(rotation, x).map((v, i) => v + (translation[i] ?? 0));
    const z1 = x[2] ?? 0;
    const z2 = inB[2] ?? 0;
    if (!(z1 > 0) || !(z2 > 0)) {
      refusals[TriangulationRefusal.BEHIND_CAMERA] =
        (refusals[TriangulationRefusal.BEHIND_CAMERA] ?? 0) + 1;
      continue;
    }

    const parallax = parallaxDeg(x, centreB);
    allParallax.push(parallax);
    if (!(parallax >= MIN_PARALLAX_DEG)) {
      refusals[TriangulationRefusal.LOW_PARALLAX] =
        (refusals[TriangulationRefusal.LOW_PARALLAX] ?? 0) + 1;
      continue;
    }

    const pa = projectRay(intrinsics, x);
    const pb = projectRay(intrinsics, inB);
    if (!pa || !pb) {
      refusals[TriangulationRefusal.DEGENERATE] = (refusals[TriangulationRefusal.DEGENERATE] ?? 0) + 1;
      continue;
    }
    const reprojection = Math.max(
      Math.hypot(pa.x - o.ax, pa.y - o.ay),
      Math.hypot(pb.x - o.bx, pb.y - o.by),
    );
    if (!(reprojection <= MAX_TRIANGULATION_REPROJECTION_PX)) {
      refusals[TriangulationRefusal.HIGH_REPROJECTION] =
        (refusals[TriangulationRefusal.HIGH_REPROJECTION] ?? 0) + 1;
      continue;
    }

    points.push({
      id: o.id,
      position: [x[0] ?? 0, x[1] ?? 0, x[2] ?? 0],
      depth: z1,
      parallaxDeg: parallax,
      depthUncertainty: sigmaThetaRad / Math.max(1e-9, (parallax * Math.PI) / 180),
      reprojectionPx: reprojection,
    });
  }

  return {
    points,
    candidates: inliers.length,
    refusals,
    medianParallaxDeg: median(allParallax),
    medianAcceptedParallaxDeg: median(points.map((p) => p.parallaxDeg)),
    minAcceptedParallaxDeg: points.length > 0 ? Math.min(...points.map((p) => p.parallaxDeg)) : -1,
    maxAcceptedReprojectionPx:
      points.length > 0 ? Math.max(...points.map((p) => p.reprojectionPx)) : -1,
    minAcceptedDepth: points.length > 0 ? Math.min(...points.map((p) => p.depth)) : -1,
    medianDepth: median(points.map((p) => p.depth)),
    medianDepthUncertainty: median(points.map((p) => p.depthUncertainty)),
    medianReprojectionPx: median(points.map((p) => p.reprojectionPx)),
  };
}

/**
 * The angle the two viewing rays make at the point, in degrees.
 *
 * `x` is in the first camera's frame, so the first ray is `x` itself and the second is `x`
 * measured from the second camera's centre. This is the quantity the depth's conditioning
 * depends on — not the image displacement, which a rotation also produces and which says nothing
 * about depth.
 */
export function parallaxDeg(x: readonly number[], centreB: readonly number[]): number {
  const a = normalise3(x);
  const b = normalise3([
    (x[0] ?? 0) - (centreB[0] ?? 0),
    (x[1] ?? 0) - (centreB[1] ?? 0),
    (x[2] ?? 0) - (centreB[2] ?? 0),
  ]);
  if (!a || !b) return 0;
  const c = Math.max(-1, Math.min(1, dot3(a, b)));
  return (Math.acos(c) * 180) / Math.PI;
}

/**
 * The parallax at which a depth reaches a given relative uncertainty, in degrees.
 *
 * Exported so `MIN_PARALLAX_DEG` can be checked against the arithmetic that produced it rather
 * than against a comment — `tests/unit/triangulation.test.ts` does that.
 */
export function parallaxForUncertainty(focalPx: number, uncertainty: number): number {
  if (!(focalPx > 0) || !(uncertainty > 0)) return -1;
  return ((CORRESPONDENCE_NOISE_PX / focalPx / uncertainty) * 180) / Math.PI;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}
