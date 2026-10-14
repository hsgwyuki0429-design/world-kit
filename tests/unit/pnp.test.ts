/**
 * Phase 12's per-frame pose — the refinement that puts the camera into the map's world.
 *
 * Driven against scenes whose answer is known by construction, including the one a DLT cannot
 * solve: every point on one plane.
 */

import { describe, expect, it } from 'vitest';

import { Rng } from '../../src/core/Rng';
import { intrinsicsFor } from '../../src/geometry/intrinsics';
import { fromAxisAngle, rotationAngleDeg } from '../../src/geometry/rotation';
import { multiply3x3, transpose3x3 } from '../../src/geometry/linalg';
import {
  INLIER_PX,
  MIN_PNP_POINTS,
  cameraCenter,
  projectPoint,
  refinePose,
} from '../../src/geometry/pnp';
import type { CameraPose, PnpCorrespondence } from '../../src/geometry/pnp';

const K = intrinsicsFor(640, 480);
if (!K) throw new Error('intrinsics fixture');
const INTRINSICS = K;

function poseFrom(axis: number[], angleDeg: number, center: number[]): CameraPose {
  const r = fromAxisAngle(axis, angleDeg);
  const t = [0, 1, 2].map(
    (i) => -((r[i * 3] ?? 0) * (center[0] ?? 0) + (r[i * 3 + 1] ?? 0) * (center[1] ?? 0) + (r[i * 3 + 2] ?? 0) * (center[2] ?? 0)),
  );
  return { rotation: r, translation: t };
}

function scene(rng: Rng, planar: boolean, n = 120): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = (rng.next() - 0.5) * 8;
    const y = (rng.next() - 0.5) * 6;
    const z = planar ? 10 : 8 + rng.next() * 6;
    out.push([x, y, z]);
  }
  return out;
}

function observe(pose: CameraPose, points: number[][], rng: Rng, noisePx: number): PnpCorrespondence[] {
  const out: PnpCorrespondence[] = [];
  points.forEach((p, id) => {
    const q = projectPoint(INTRINSICS, pose, p);
    if (!q) return;
    out.push({
      id,
      x: q.x + (rng.next() - 0.5) * 2 * noisePx,
      y: q.y + (rng.next() - 0.5) * 2 * noisePx,
      world: p,
    });
  });
  return out;
}

function rotationErrorDeg(a: CameraPose, b: CameraPose): number {
  return rotationAngleDeg(multiply3x3(a.rotation, transpose3x3(b.rotation)));
}

describe('refinePose', () => {
  it('recovers the pose from a start ten degrees and half a unit away', () => {
    const rng = new Rng(7);
    const truth = poseFrom([0.2, 1, 0.1], 12, [0.5, -0.3, 0.2]);
    const corr = observe(truth, scene(rng, false), rng, 0.5);
    const start = poseFrom([0.2, 1, 0.1], 2, [0.0, 0.0, 0.0]);
    const r = refinePose(INTRINSICS, corr, start);
    expect(r.pose).not.toBeNull();
    if (!r.pose) return;
    expect(rotationErrorDeg(r.pose, truth)).toBeLessThan(0.2);
    const c = cameraCenter(r.pose);
    expect(Math.hypot((c[0] ?? 0) - 0.5, (c[1] ?? 0) + 0.3, (c[2] ?? 0) - 0.2)).toBeLessThan(0.05);
    expect(r.medianErrorPx).toBeLessThan(0.6);
    expect(r.inliers).toBe(corr.length);
  });

  it('solves a scene that is a single plane — the case a DLT is degenerate on', () => {
    const rng = new Rng(11);
    const truth = poseFrom([1, 0.3, 0], 8, [0.3, 0.4, -0.5]);
    const corr = observe(truth, scene(rng, true), rng, 0.5);
    const start = poseFrom([1, 0.3, 0], 0, [0, 0, 0]);
    const r = refinePose(INTRINSICS, corr, start);
    expect(r.pose).not.toBeNull();
    if (!r.pose) return;
    expect(rotationErrorDeg(r.pose, truth)).toBeLessThan(0.3);
    expect(r.medianErrorPx).toBeLessThan(0.6);
  });

  it('is not pulled by a fifth of the correspondences being wrong by 40 px', () => {
    const rng = new Rng(3);
    const truth = poseFrom([0, 1, 0], -9, [-0.4, 0.1, 0.3]);
    const clean = observe(truth, scene(rng, false), rng, 0.4);
    const corrupt = clean.map((c, i) =>
      i % 5 === 0 ? { ...c, x: c.x + 40 * Math.cos(i), y: c.y + 40 * Math.sin(i) } : c,
    );
    const r = refinePose(INTRINSICS, corrupt, poseFrom([0, 1, 0], 0, [0, 0, 0]));
    expect(r.pose).not.toBeNull();
    if (!r.pose) return;
    expect(rotationErrorDeg(r.pose, truth)).toBeLessThan(0.3);
    const outliers = r.residualsPx.filter((v, i) => i % 5 === 0 && v > INLIER_PX).length;
    expect(outliers).toBe(corrupt.filter((_, i) => i % 5 === 0).length);
  });

  it('refuses to answer below the minimum rather than returning the start', () => {
    const rng = new Rng(5);
    const truth = poseFrom([0, 1, 0], 5, [0, 0, 0]);
    const corr = observe(truth, scene(rng, false, MIN_PNP_POINTS - 1), rng, 0);
    const r = refinePose(INTRINSICS, corr, truth);
    expect(r.pose).toBeNull();
    expect(r.medianErrorPx).toBe(-1);
  });

  it('reports a large error rather than inventing agreement for correspondences of another scene', () => {
    const rng = new Rng(9);
    const truth = poseFrom([0, 1, 0], 5, [0, 0, 0]);
    const corr = observe(truth, scene(rng, false), rng, 0.3);
    // The same pixels, attached to an unrelated set of world points.
    const other = scene(new Rng(99), false);
    const shuffled = corr.map((c, i) => ({ ...c, world: other[i] ?? c.world }));
    const r = refinePose(INTRINSICS, shuffled, truth);
    expect(r.inliers).toBeLessThan(shuffled.length * 0.5);
  });
});
