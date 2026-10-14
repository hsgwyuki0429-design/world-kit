/**
 * Spatial collision — the only surfaces a ball can touch (Phase 15, v4 §33).
 *
 * §33 in one line: **the only source of collision geometry is the SpatialWorld's observed
 * surfaces.** No fixed invisible wall, no fake floor, no random surface — and the architecture
 * audit makes the first two structural: this module cannot import the tracker or the map, so the
 * only geometry it can build from is the `SpatialWorldView` it is handed.
 *
 * ## What becomes a collision surface
 *
 * A surface of a known class — GROUND, PLATFORM, WALL or OBSTACLE_SURFACE — at
 * `MIN_COLLISION_CONFIDENCE` or better. `UNKNOWN` surfaces never collide (§44: SURFACE UNKNOWN →
 * do not use for collision), and every surface left out is listed with the reason, so a ball
 * passing through something visible on screen can be traced to the decision that let it.
 *
 * ## Exactly as large as what was seen
 *
 * A collision surface is its surface's convex hull, not a plane. A ball that rolls off the edge of
 * the observed floor falls — because past that edge nobody observed a floor, and continuing it
 * would be the fake floor §33 forbids.
 *
 * ## Provenance
 *
 * Every collision surface carries the world surface it came from, the epoch and world version,
 * how many landmarks it rests on and its confidence. Every contact the physics records names the
 * collision surface it touched. That chain — contact → collision surface → world surface →
 * landmarks — is §33's "Collision Provenance Logged".
 */

import { SurfaceClass } from '../world/SpatialWorld';
import type { SpatialWorldView, Surface } from '../world/SpatialWorld';

/** Below this a surface is too uncertain to bounce a ball off. Matches the classifier's own floor plus margin. */
export const MIN_COLLISION_CONFIDENCE = 0.4;

/** How bouncy and how grippy each class is. Game constants, stated as such — not measurements of the room. */
export const MATERIAL: Record<string, { restitution: number; friction: number }> = {
  [SurfaceClass.GROUND]: { restitution: 0.55, friction: 0.25 },
  [SurfaceClass.PLATFORM]: { restitution: 0.5, friction: 0.3 },
  [SurfaceClass.WALL]: { restitution: 0.65, friction: 0.15 },
  [SurfaceClass.OBSTACLE_SURFACE]: { restitution: 0.5, friction: 0.25 },
};

export interface CollisionProvenance {
  readonly surfaceId: number;
  readonly epoch: number;
  readonly worldVersion: number;
  readonly surfaceClass: string;
  readonly support: number;
  readonly confidence: number;
}

export interface CollisionSurface {
  readonly id: number;
  readonly surfaceClass: string;
  readonly normal: readonly number[];
  readonly offset: number;
  readonly origin: readonly number[];
  readonly basisU: readonly number[];
  readonly basisV: readonly number[];
  /** The hull in the plane's own 2-D coordinates about `origin`, counter-clockwise. */
  readonly polygon2d: readonly (readonly number[])[];
  readonly restitution: number;
  readonly friction: number;
  readonly provenance: CollisionProvenance;
}

export interface CollisionSet {
  readonly epoch: number;
  readonly worldVersion: number;
  readonly surfaces: readonly CollisionSurface[];
  readonly excluded: readonly { readonly surfaceId: number; readonly reason: string }[];
}

export function buildCollisionSet(view: SpatialWorldView): CollisionSet {
  return collisionFromSurfaces(view.surfaces, view.epoch, view.version);
}

/** The same construction over a list of surfaces — what the stage generator's controls build from. */
export function collisionFromSurfaces(
  list: readonly Surface[],
  epoch: number,
  worldVersion: number,
): CollisionSet {
  const surfaces: CollisionSurface[] = [];
  const excluded: { surfaceId: number; reason: string }[] = [];
  for (const s of list) {
    const why = exclusionReason(s);
    if (why) {
      excluded.push({ surfaceId: s.id, reason: why });
      continue;
    }
    const material = MATERIAL[s.surfaceClass] ?? { restitution: 0.5, friction: 0.25 };
    surfaces.push({
      id: s.id,
      surfaceClass: s.surfaceClass,
      normal: s.normal,
      offset: s.offset,
      origin: s.centroid,
      basisU: s.basisU,
      basisV: s.basisV,
      polygon2d: s.polygon.map((p) => {
        const d = sub(p, s.centroid);
        return [dot(d, s.basisU), dot(d, s.basisV)];
      }),
      restitution: material.restitution,
      friction: material.friction,
      provenance: {
        surfaceId: s.id,
        epoch,
        worldVersion,
        surfaceClass: s.surfaceClass,
        support: s.support,
        confidence: s.confidence,
      },
    });
  }
  return { epoch, worldVersion, surfaces, excluded };
}

export function exclusionReason(s: Surface): string | null {
  if (s.surfaceClass === SurfaceClass.UNKNOWN) return `UNKNOWN surface — ${s.classReason}`;
  if (s.confidence < MIN_COLLISION_CONFIDENCE) {
    return `confidence ${s.confidence} below the ${MIN_COLLISION_CONFIDENCE} collision requires`;
  }
  if (s.polygon.length < 3) return 'its hull has no area';
  return null;
}

/** Signed distance from the plane, positive on the observed side. */
export function planeDistance(s: CollisionSurface, p: readonly number[]): number {
  return dot(s.normal, p) - s.offset;
}

/** Is the projection of `p` onto the plane inside the observed hull? */
export function insideHull(s: CollisionSurface, p: readonly number[], margin = 0): boolean {
  const d = sub(p, s.origin);
  const x = dot(d, s.basisU);
  const y = dot(d, s.basisV);
  return insideConvex(s.polygon2d, x, y, margin);
}

/** Point in a counter-clockwise convex polygon, with `margin` (positive shrinks it). */
export function insideConvex(poly: readonly (readonly number[])[], x: number, y: number, margin = 0): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] ?? [0, 0];
    const b = poly[(i + 1) % poly.length] ?? [0, 0];
    const ex = (b[0] ?? 0) - (a[0] ?? 0);
    const ey = (b[1] ?? 0) - (a[1] ?? 0);
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    // Left of every edge for a CCW polygon: the cross product's sign, as a distance.
    const side = (ex * (y - (a[1] ?? 0)) - ey * (x - (a[0] ?? 0))) / len;
    if (side < margin) return false;
  }
  return true;
}

/**
 * Does the segment `a → b` pass through any collision surface other than those in `ignore`?
 * Line of sight, and the stage generator's "not blocked" test.
 */
export function segmentBlocked(
  set: CollisionSet,
  a: readonly number[],
  b: readonly number[],
  ignore: ReadonlySet<number> = new Set(),
): CollisionSurface | null {
  for (const s of set.surfaces) {
    if (ignore.has(s.id)) continue;
    const da = planeDistance(s, a);
    const db = planeDistance(s, b);
    if ((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
    const denom = da - db;
    if (Math.abs(denom) < 1e-12) continue;
    const t = da / denom;
    const p = [0, 1, 2].map((i) => (a[i] ?? 0) + t * ((b[i] ?? 0) - (a[i] ?? 0)));
    if (insideHull(s, p)) return s;
  }
  return null;
}

export function sub(a: readonly number[], b: readonly number[]): number[] {
  return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
}

export function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}
