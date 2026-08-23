/**
 * Phase 6's pure geometry, against scenes whose pose is known by construction.
 *
 * Every fixture here builds its correspondences **forward** from a chosen `(R, t)` and a chosen
 * set of 3D points, so the answer is known before the solver runs. The convention is fixed once
 * and stated, because getting it wrong silently is exactly what happened in Phase 5:
 *
 *     camera 1:  a = π(K X)              — the world is expressed in camera 1's frame
 *     camera 2:  b = π(K (R X + t))
 *     therefore  E = [t]ₓ R  and  F = K⁻ᵀ E K⁻¹
 *
 * Phase 5's `trueFundamental` helper was written as `Rᵀ[t]ₓ` and the *test* was wrong while the
 * solver was right. So the closed forms are asserted against the projections before anything is
 * built on them — the first three tests below do nothing else.
 */

import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/Rng';
import {
  apply3x3,
  determinant3x3,
  invert3x3,
  multiply3x3,
  normalise3,
  svd3x3,
  transpose3x3,
} from '../../src/geometry/linalg';
import { intrinsicsFor, matrixOf, projectRay } from '../../src/geometry/intrinsics';
import type { Intrinsics } from '../../src/geometry/intrinsics';
import {
  angleBetweenDeg,
  fromAxisAngle,
  isRotation,
  rotationAngleDeg,
  toAxisAngle,
  toQuaternion,
} from '../../src/geometry/rotation';
import {
  MIN_CHEIRALITY_FRACTION,
  PURE_ROTATION_PARALLAX_PX,
  PoseState,
  SCALE_LOCAL_UNITS,
  decomposeEssential,
  decomposeHomography,
  essentialFromFundamental,
  recoverPose,
  rotationHomography,
  rotationOnlyResidual,
  triangulate,
} from '../../src/geometry/pose';
import { GeometricModel } from '../../src/geometry/twoView';
import type { Correspondence } from '../../src/geometry/twoView';
import { sampsonDistanceSq } from '../../src/geometry/twoView';

const K = intrinsicsFor(1280, 720) as Intrinsics;

function skew(t: readonly number[]): number[] {
  const [x, y, z] = [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0];
  return [0, -z, y, z, 0, -x, -y, x, 0];
}

/** `E = [t]ₓ R`, and `F = K⁻ᵀ E K⁻¹`. Asserted against the projections before it is used. */
function trueEssential(r: readonly number[], t: readonly number[]): number[] {
  return multiply3x3(skew(t), r);
}
function trueFundamental(r: readonly number[], t: readonly number[], k: Intrinsics): number[] {
  const ki = invert3x3(matrixOf(k)) as number[];
  return multiply3x3(multiply3x3(transpose3x3(ki), trueEssential(r, t)), ki);
}

interface SceneOptions {
  readonly count?: number;
  readonly seed?: number;
  readonly rotation?: number[];
  readonly translation?: number[];
  /** All points on one plane at `z = planeZ`, for the v3 §16 half. */
  readonly planeZ?: number;
  readonly noisePx?: number;
}

interface Scene {
  readonly points: Correspondence[];
  readonly rotation: number[];
  readonly translation: number[];
  readonly world: number[][];
}

/**
 * Project a **given** world set under a given pose.
 *
 * The injection tests need the same 3D points seen under two poses, and calling `scene()` twice
 * does not give that: its visibility filter keeps whichever points happen to land in frame, so
 * a different pose keeps a different subset and index `i` stops meaning the same point. That is
 * a fixture bug of exactly the shape Phase 5's `trueFundamental` was — the comparison looks
 * wrong while the solver is right — so the world is fixed once and reprojected here.
 */
function reproject(world: readonly number[][], r: readonly number[], t: readonly number[]): Correspondence[] {
  const out: Correspondence[] = [];
  for (const X of world) {
    const a = projectRay(K, X);
    const xc = apply3x3(r, X);
    const b = projectRay(K, [
      (xc[0] ?? 0) + (t[0] ?? 0),
      (xc[1] ?? 0) + (t[1] ?? 0),
      (xc[2] ?? 0) + (t[2] ?? 0),
    ]);
    if (!a || !b) continue;
    out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  return out;
}

function scene(o: SceneOptions = {}): Scene {
  const {
    count = 80,
    seed = 0x5eed,
    rotation = fromAxisAngle([0, 1, 0], 3),
    translation = [0.35, 0.05, 0.06],
    planeZ,
    noisePx = 0,
  } = o;
  const rng = new Rng(seed);
  const points: Correspondence[] = [];
  const world: number[][] = [];
  let guard = 0;
  while (points.length < count && guard++ < count * 60) {
    const z = planeZ ?? 3 + rng.next() * 6;
    const X = [(rng.next() - 0.5) * 4, (rng.next() - 0.5) * 3, z];
    const a = projectRay(K, X);
    const xc = apply3x3(rotation, X);
    const b = projectRay(K, [
      (xc[0] ?? 0) + (translation[0] ?? 0),
      (xc[1] ?? 0) + (translation[1] ?? 0),
      (xc[2] ?? 0) + (translation[2] ?? 0),
    ]);
    if (!a || !b) continue;
    if (a.x < 0 || a.x > K.width || a.y < 0 || a.y > K.height) continue;
    if (b.x < 0 || b.x > K.width || b.y < 0 || b.y > K.height) continue;
    const n = () => (noisePx > 0 ? (rng.next() - 0.5) * 2 * noisePx : 0);
    points.push({ ax: a.x + n(), ay: a.y + n(), bx: b.x + n(), by: b.y + n() });
    world.push(X);
  }
  return { points, rotation, translation, world };
}

const allIndices = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/* -------------------------------------------------------------------------- */

describe('the closed forms this file rests on', () => {
  it('E = [t]ₓR satisfies the epipolar constraint on the projections themselves', () => {
    const s = scene();
    const f = trueFundamental(s.rotation, s.translation, K);
    for (const c of s.points) {
      // Sampson distance, not the raw algebraic residual: it is the pixel-space quantity the
      // rest of the project uses, so a failure here reads in the same units as everything else.
      expect(Math.sqrt(sampsonDistanceSq(f, c))).toBeLessThan(1e-6);
    }
  });

  it('and Rᵀ[t]ₓ — the shape Phase 5 got wrong — does not', () => {
    const s = scene();
    const ki = invert3x3(matrixOf(K)) as number[];
    const wrongE = multiply3x3(transpose3x3(s.rotation), skew(s.translation));
    const wrongF = multiply3x3(multiply3x3(transpose3x3(ki), wrongE), ki);
    const worst = Math.max(...s.points.map((c) => Math.sqrt(sampsonDistanceSq(wrongF, c))));
    expect(worst).toBeGreaterThan(1);
  });

  it('K Rⱼ K⁻¹ applied to the second view is exactly the camera having turned by Rⱼ', () => {
    // POSE-005's ground truth is this identity and nothing else. If it does not hold, the gate
    // is measuring an arbitrary image warp rather than a camera rotation.
    const s = scene();
    const rj = fromAxisAngle([0.3, 0.9, 0.2], 8);
    const h = rotationHomography(K, rj) as number[];
    const turned = reproject(s.world, multiply3x3(rj, s.rotation), apply3x3(rj, s.translation));
    expect(turned.length).toBe(s.points.length);
    for (let i = 0; i < s.points.length; i++) {
      const c = s.points[i] as Correspondence;
      const q = apply3x3(h, [c.bx, c.by, 1]);
      const w = q[2] ?? 0;
      const t = turned[i] as Correspondence;
      expect(Math.abs((q[0] ?? 0) / w - t.bx)).toBeLessThan(1e-6);
      expect(Math.abs((q[1] ?? 0) / w - t.by)).toBeLessThan(1e-6);
    }
  });
});

describe('svd3x3', () => {
  it('reconstructs the matrix it decomposed', () => {
    const m = [4, 1, -2, 0.5, 3, 1, -1, 2, 5];
    const s = svd3x3(m) as { u: number[]; s: number[]; v: number[] };
    const d = [s.s[0] ?? 0, 0, 0, 0, s.s[1] ?? 0, 0, 0, 0, s.s[2] ?? 0];
    const back = multiply3x3(multiply3x3(s.u, d), transpose3x3(s.v));
    for (let i = 0; i < 9; i++) expect(back[i] ?? 0).toBeCloseTo(m[i] ?? 0, 8);
  });

  it('returns singular values in descending order', () => {
    const s = svd3x3([4, 1, -2, 0.5, 3, 1, -1, 2, 5]) as { s: number[] };
    expect(s.s[0]).toBeGreaterThanOrEqual(s.s[1] as number);
    expect(s.s[1]).toBeGreaterThanOrEqual(s.s[2] as number);
  });

  /**
   * The rank-2 case, over many matrices rather than one.
   *
   * A single fixture passed this while `svd3x3` was returning a **zero third column** for other
   * Essential matrices: `s₃` is `sqrt` of an eigenvalue of `MᵀM`, so the numerical zero of a
   * null direction lands around 1e-8 rather than at 0, and whether it fell either side of the
   * threshold depended on the matrix. `U diag(s) Vᵀ` reconstructed `M` perfectly the whole time,
   * because a column multiplied by a zero singular value cannot affect the product — so the
   * reconstruction test above could not have caught it, and did not.
   *
   * The property that does catch it is that `U` must be a **rotation**, whatever the rank.
   */
  it('returns an orthonormal U on the rank-2 case an Essential matrix always is', () => {
    const rng = new Rng(0xf00d);
    for (let trial = 0; trial < 40; trial++) {
      const axis = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) as number[];
      const t = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) as number[];
      const e = trueEssential(fromAxisAngle(axis, 1 + rng.next() * 40), t);
      const s = svd3x3(e) as { s: number[]; u: number[]; v: number[] };
      expect(s.s[0]).toBeCloseTo(s.s[1] as number, 6);
      expect(s.s[2]).toBeLessThan(1e-6 * (s.s[0] as number));
      expect(determinant3x3(s.u)).toBeCloseTo(1, 6);
      expect(determinant3x3(s.v)).toBeCloseTo(1, 6);
      // ...and the third column is the left null vector, which is the translation direction.
      const u3 = normalise3([s.u[2] ?? 0, s.u[5] ?? 0, s.u[8] ?? 0]) as number[];
      const dot = Math.abs(
        (u3[0] ?? 0) * (t[0] ?? 0) + (u3[1] ?? 0) * (t[1] ?? 0) + (u3[2] ?? 0) * (t[2] ?? 0),
      );
      expect(dot).toBeCloseTo(1, 6);
    }
  });

  it('decomposes every Essential matrix back into the rotation it was built from', () => {
    // The end-to-end form of the same property, and the one that failed: one scene recovered
    // exactly and the same scene turned by 4° came back 60° wrong, from identical code.
    const rng = new Rng(0xc0ffee);
    for (let trial = 0; trial < 40; trial++) {
      const axis = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) as number[];
      const r = fromAxisAngle(axis, 1 + rng.next() * 30);
      const t = normalise3([rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5]) as number[];
      const candidates = decomposeEssential(trueEssential(r, t));
      expect(candidates).toHaveLength(4);
      const best = Math.min(...candidates.map((c) => angleBetweenDeg(c.rotation, r)));
      // 1e-3 degrees, and the figure is what the method warrants rather than a round number:
      // `svd3x3` forms `MᵀM`, and squaring costs half the available digits, so a singular value
      // that should be zero returns at about `sqrt(eps)` ≈ 1e-8 relative. The rotation inherits
      // that as roughly 1e-8 rad ≈ 6e-7 degrees. Measured across these 40 matrices: 1.7e-6.
      // A tighter bound would be asserting a precision the arithmetic cannot deliver.
      expect(best).toBeLessThan(1e-3);
    }
  });

  it('declines a matrix with nothing in it rather than returning zeros', () => {
    expect(svd3x3([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });
});

describe('rotations', () => {
  it('round-trips axis-angle through the matrix', () => {
    for (const deg of [0.5, 8, 45, 120, 179]) {
      const axis = normalise3([0.3, -0.5, 0.81]) as number[];
      const r = fromAxisAngle(axis, deg);
      expect(isRotation(r)).toBe(true);
      const back = toAxisAngle(r);
      expect(back.angleDeg).toBeCloseTo(deg, 6);
      // The axis sign follows the quaternion's `w >= 0` convention; compare up to it.
      const dotAbs = Math.abs(
        (back.axis[0] ?? 0) * (axis[0] ?? 0) +
          (back.axis[1] ?? 0) * (axis[1] ?? 0) +
          (back.axis[2] ?? 0) * (axis[2] ?? 0),
      );
      expect(dotAbs).toBeCloseTo(1, 6);
    }
  });

  it('keeps its precision near a half turn, where the naive formula loses it', () => {
    const r = fromAxisAngle([0, 0, 1], 179.9);
    const q = toQuaternion(r);
    // w ~ 0 here; Shepperd's method picks another denominator and the axis survives.
    expect(Math.abs(q[0])).toBeLessThan(0.01);
    expect(Math.abs(q[3])).toBeCloseTo(1, 3);
    expect(rotationAngleDeg(r)).toBeCloseTo(179.9, 3);
  });

  it('gives one representation for a rotation, not two', () => {
    const q = toQuaternion(fromAxisAngle([0, 0, 1], 200));
    expect(q[0]).toBeGreaterThanOrEqual(0);
  });

  it('measures the angle between two rotations', () => {
    const a = fromAxisAngle([0, 1, 0], 10);
    const b = multiply3x3(fromAxisAngle([1, 0, 0], 7), a);
    expect(angleBetweenDeg(a, b)).toBeCloseTo(7, 6);
    expect(angleBetweenDeg(a, a)).toBeCloseTo(0, 9);
  });

  it('survives a trace that rounding pushed past 3 instead of returning NaN', () => {
    expect(rotationAngleDeg([1.0000000004, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(0);
  });
});

describe('the Essential path — a scene with depth', () => {
  const s = scene();
  const f = trueFundamental(s.rotation, s.translation, K);

  it('recovers the rotation the scene was built from', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: f,
      planar: false,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.POSE);
    expect(angleBetweenDeg(out.rotation as number[], s.rotation)).toBeLessThan(0.05);
  });

  it('recovers the translation direction, and only the direction', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: f,
      planar: false,
      intrinsics: K,
    });
    const want = normalise3(s.translation) as number[];
    const got = out.translation as number[];
    const dot = (got[0] ?? 0) * (want[0] ?? 0) + (got[1] ?? 0) * (want[1] ?? 0) + (got[2] ?? 0) * (want[2] ?? 0);
    expect(dot).toBeGreaterThan(0.999);
    // Unit, by construction — never a distance.
    expect(Math.hypot(...got)).toBeCloseTo(1, 9);
    expect(out.scale).toBe(SCALE_LOCAL_UNITS);
  });

  it('puts the points in front of both cameras, and records all four counts', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: f,
      planar: false,
      intrinsics: K,
    });
    expect(out.cheirality).toHaveLength(4);
    expect(out.pointsInFront / out.correspondences).toBeGreaterThanOrEqual(MIN_CHEIRALITY_FRACTION);
    // The decomposition's other candidates must not be equally good, or the choice was luck.
    const others = out.cheirality.filter((c) => c.candidate !== out.chosen);
    for (const o of others) expect(o.inFront).toBeLessThan(out.pointsInFront);
    expect(out.ambiguous).toBe(false);
  });

  it('reports a reprojection error inside §33’s 2 px on a noiseless scene', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: f,
      planar: false,
      intrinsics: K,
    });
    expect(out.reprojectionErrorPx).toBeGreaterThanOrEqual(0);
    expect(out.reprojectionErrorPx).toBeLessThan(0.01);
  });

  it('decomposes into exactly four candidates', () => {
    const e = essentialFromFundamental(f, K) as number[];
    const candidates = decomposeEssential(e);
    expect(candidates).toHaveLength(4);
    for (const c of candidates) expect(isRotation(c.rotation, 1e-6)).toBe(true);
  });

  it('forces the Essential singular structure rather than assuming it', () => {
    const e = essentialFromFundamental(f, K) as number[];
    const sv = svd3x3(e) as { s: number[] };
    expect(sv.s[0]).toBeCloseTo(sv.s[1] as number, 9);
    // Relative to σ₁, for the reason above: `MᵀM` puts the numerical zero at about `sqrt(eps)`,
    // so an absolute bound of 1e-9 would be asserting more precision than the method has. This
    // is the same mistake that hid the zero-third-column defect — a threshold on a quantity
    // whose numerical floor nobody had worked out.
    expect(sv.s[2]).toBeLessThan(1e-6 * (sv.s[0] as number));
  });
});

describe('the homography path — v3 §16’s planar half', () => {
  const s = scene({ planeZ: 5, translation: [0.4, 0.05, 0.0], rotation: fromAxisAngle([0, 1, 0], 2) });

  function planarHomography(): number[] {
    // H = K (R + t nᵀ/d) K⁻¹ for the plane z = d with normal [0,0,1] in camera 1's frame.
    const d = 5;
    const n = [0, 0, 1];
    const outer = [
      (s.translation[0] ?? 0) * (n[0] ?? 0), (s.translation[0] ?? 0) * (n[1] ?? 0), (s.translation[0] ?? 0) * (n[2] ?? 0),
      (s.translation[1] ?? 0) * (n[0] ?? 0), (s.translation[1] ?? 0) * (n[1] ?? 0), (s.translation[1] ?? 0) * (n[2] ?? 0),
      (s.translation[2] ?? 0) * (n[0] ?? 0), (s.translation[2] ?? 0) * (n[1] ?? 0), (s.translation[2] ?? 0) * (n[2] ?? 0),
    ];
    const inner = s.rotation.map((x, i) => x + (outer[i] ?? 0) / d);
    const ki = invert3x3(matrixOf(K)) as number[];
    return multiply3x3(multiply3x3(matrixOf(K), inner), ki);
  }

  it('the fixture’s homography maps the first view onto the second exactly', () => {
    const h = planarHomography();
    for (const c of s.points) {
      const q = apply3x3(h, [c.ax, c.ay, 1]);
      const w = q[2] ?? 0;
      expect(Math.abs((q[0] ?? 0) / w - c.bx)).toBeLessThan(1e-6);
      expect(Math.abs((q[1] ?? 0) / w - c.by)).toBeLessThan(1e-6);
    }
  });

  it('recovers the rotation and the translation direction from the plane', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.HOMOGRAPHY,
      matrix: planarHomography(),
      planar: true,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.POSE);
    expect(out.source).toBe(GeometricModel.HOMOGRAPHY);
    expect(angleBetweenDeg(out.rotation as number[], s.rotation)).toBeLessThan(0.5);
    const want = normalise3(s.translation) as number[];
    const got = out.translation as number[];
    const dot = (got[0] ?? 0) * (want[0] ?? 0) + (got[1] ?? 0) * (want[1] ?? 0) + (got[2] ?? 0) * (want[2] ?? 0);
    expect(dot).toBeGreaterThan(0.99);
  });

  it('recovers the plane’s normal', () => {
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.HOMOGRAPHY,
      matrix: planarHomography(),
      planar: true,
      intrinsics: K,
    });
    const n = out.planeNormal as number[];
    expect(Math.abs(n[2] ?? 0)).toBeGreaterThan(0.98);
  });

  it('keeps only candidates with the plane in front of the camera', () => {
    const candidates = decomposeHomography(planarHomography(), K);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.planeNormal?.[2] ?? 0).toBeGreaterThan(0);
      expect(isRotation(c.rotation, 1e-6)).toBe(true);
    }
  });
});

describe('a camera that only turned', () => {
  // The trap POSE-004 exists for: large, well-conditioned image motion and no translation at
  // all. Every test Phase 5 applies passes on this — baseline, inlier count, spread.
  const rot = fromAxisAngle([0, 1, 0], 4);
  const s = scene({ rotation: rot, translation: [0, 0, 0], planeZ: undefined });

  it('the image motion is large enough to look like a baseline', () => {
    const median = rotationOnlyResidual(s.points, [1, 0, 0, 0, 1, 0, 0, 0, 1], K);
    expect(median).toBeGreaterThan(15);
  });

  it('recovers the rotation and refuses to name a translation', () => {
    const h = rotationHomography(K, rot) as number[];
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.HOMOGRAPHY,
      matrix: h,
      planar: true,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.ROTATION_ONLY);
    expect(out.translation).toBeNull();
    expect(angleBetweenDeg(out.rotation as number[], rot)).toBeLessThan(0.05);
    expect(out.rotationOnlyResidualPx).toBeLessThanOrEqual(PURE_ROTATION_PARALLAX_PX);
    expect(out.reason).toContain('no parallax');
  });

  it('and the residual is what decides it, measured on the correspondences', () => {
    expect(rotationOnlyResidual(s.points, rot, K)).toBeLessThan(1e-6);
  });
});

describe('triangulation', () => {
  it('recovers the points the scene was built from, up to the translation’s scale', () => {
    const s = scene({ count: 30 });
    for (let i = 0; i < s.points.length; i++) {
      const c = s.points[i] as Correspondence;
      const x = triangulate({ x: c.ax, y: c.ay }, { x: c.bx, y: c.by }, K, s.rotation, s.translation) as number[];
      const want = s.world[i] as number[];
      for (let j = 0; j < 3; j++) expect(x[j] ?? 0).toBeCloseTo(want[j] ?? 0, 5);
    }
  });

  it('puts nothing behind the camera on a scene that is entirely in front of it', () => {
    const s = scene({ count: 40 });
    for (const c of s.points) {
      const x = triangulate({ x: c.ax, y: c.ay }, { x: c.bx, y: c.by }, K, s.rotation, s.translation) as number[];
      expect(x[2] ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('fail closed', () => {
  it('refuses a set too small for any two-view pose', () => {
    const s = scene({ count: 4 });
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: trueFundamental(s.rotation, s.translation, K),
      planar: false,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.NO_POSE);
    expect(out.rotation).toBeNull();
    expect(out.translation).toBeNull();
    expect(out.reason).toContain('too few');
  });

  it('refuses a matrix that decomposes into nothing', () => {
    const s = scene();
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      planar: false,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.NO_POSE);
  });

  it('reports NO_POSE — with the counts — when no candidate puts the scene in front', () => {
    // A fundamental matrix from an unrelated motion: it is a valid F, it decomposes, and none of
    // its four candidates explains where these points actually are.
    const s = scene();
    const wrong = trueFundamental(fromAxisAngle([1, 0, 0], 60), [0, 0.6, -0.4], K);
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: wrong,
      planar: false,
      intrinsics: K,
    });
    expect(out.state).toBe(PoseState.NO_POSE);
    expect(out.cheirality.length).toBeGreaterThan(0);
    expect(out.reason).toContain('in front of both cameras');
  });

  it('carries LOCAL_UNITS even when it recovered nothing', () => {
    const s = scene({ count: 4 });
    const out = recoverPose({
      points: s.points,
      inliers: allIndices(s.points.length),
      model: GeometricModel.FUNDAMENTAL,
      matrix: trueFundamental(s.rotation, s.translation, K),
      planar: false,
      intrinsics: K,
    });
    expect(out.scale).toBe(SCALE_LOCAL_UNITS);
  });
});

describe('POSE-005’s injection, on the solver alone', () => {
  const s = scene();
  const f = trueFundamental(s.rotation, s.translation, K);
  const base = recoverPose({
    points: s.points,
    inliers: allIndices(s.points.length),
    model: GeometricModel.FUNDAMENTAL,
    matrix: f,
    planar: false,
    intrinsics: K,
  });

  it('a rotation applied to the second view comes back as that rotation', () => {
    for (const deg of [4, 8, 15]) {
      const rj = fromAxisAngle([0.2, 0.95, 0.24], deg);
      const r2 = multiply3x3(rj, s.rotation);
      const t2 = apply3x3(rj, s.translation);
      const turned = reproject(s.world, r2, t2);
      const out = recoverPose({
        points: turned,
        inliers: allIndices(turned.length),
        model: GeometricModel.FUNDAMENTAL,
        matrix: trueFundamental(r2, t2, K),
        planar: false,
        intrinsics: K,
      });
      expect(angleBetweenDeg(base.rotation as number[], out.rotation as number[])).toBeCloseTo(deg, 1);
    }
  });

  it('a stage returning a constant pose scores 0° on the same measurement', () => {
    // What the gate is for, stated as a test rather than as a comment.
    const constant = fromAxisAngle([0, 1, 0], 3);
    expect(angleBetweenDeg(constant, constant)).toBeCloseTo(0, 9);
  });
});
