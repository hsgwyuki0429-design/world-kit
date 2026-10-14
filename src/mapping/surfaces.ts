/**
 * Surfaces from landmarks (Phase 11 — v4 §23, §24).
 *
 * The landmark map is a few hundred places the tracker could follow, in a world with a consistent
 * unit and no metre. A game needs something else: **where a ball can land, what it will bounce
 * off, and what is in the way** — §23's 当たり面, 支え面 and 遮蔽面. This is where the points
 * become those, and the whole rule is v4 §16's: nothing is a surface that was not observed as
 * one, and nothing observed is extended into geometry it was not seen to have.
 *
 * ## What a surface is here
 *
 * A set of **confirmed** landmarks (seen from at least three views) that lie on one plane within
 * `PLANE_INLIER_FRACTION` of the scene's depth, and that are **spatially connected** — two tables
 * at the same height are two surfaces, not one plane with nothing in between. Its extent is the
 * convex hull of its own landmarks in the plane: it does not reach past the outermost point that
 * was seen on it.
 *
 * ## Found by sequential RANSAC, seeded
 *
 * The best-supported plane is found, refined by least squares on its inliers, cut to its largest
 * connected piece, and removed; then the next. The sampling uses `core/Rng` with a seed, so the
 * same map yields the same surfaces (v4 §59's reproducibility, and §48's for the stage built on
 * them). Thresholds are fractions of the scene's median depth because the world's unit is a
 * baseline nobody measured — an absolute threshold would be a threshold on an arbitrary scale.
 *
 * ## Classified only against measured gravity
 *
 * Horizontal and vertical mean nothing in a world tilted however the first keyframe was tilted.
 * With no gravity estimate every surface is `UNKNOWN` (v4 §1.4: PLANE: UNKNOWN), and §44 keeps
 * an `UNKNOWN` surface out of collision. With one:
 *
 *  - **GROUND** — horizontal, below the camera, and the lowest such surface.
 *  - **PLATFORM** — horizontal, below the camera, above the ground.
 *  - **WALL** — vertical and large.
 *  - **OBSTACLE_SURFACE** — vertical and small, or slanted: real, in the way, not a floor.
 *  - **UNKNOWN** — horizontal *above* the camera (nothing to play on), or not confident enough.
 *
 * Nothing names furniture. §24 says object names are not required, and a classifier that guessed
 * "table" from one plane would be inventing a fact.
 *
 * Pure arithmetic over arrays, as the architecture audit requires of this layer.
 */

import { Rng } from '../core/Rng';
import { symmetricEigen } from '../geometry/linalg';

/* -------------------------------------------------------------------------- */
/* Thresholds — fixed in docs/phase11/TEST-PLAN.md before this file existed     */
/* -------------------------------------------------------------------------- */

/** Distance from the plane an inlier may sit, as a fraction of the median scene depth. */
export const PLANE_INLIER_FRACTION = 0.03;
/** Landmarks a surface must rest on. */
export const MIN_SURFACE_SUPPORT = 20;
/** How far apart two landmarks of one surface may be and still be connected, fraction of depth. */
export const CLUSTER_LINK_FRACTION = 0.2;
/** Surfaces extracted per map at most. */
export const MAX_SURFACES = 10;
/** RANSAC hypotheses per surface, at most. */
export const MAX_HYPOTHESES = 300;
/** Points a hypothesis is scored on, at most — the rest are only touched in the refinement. */
const SCORING_SAMPLE = 1500;
/** Within this tilt of level a plane is horizontal; within it of plumb, vertical. Degrees. */
export const ORIENTATION_TOLERANCE_DEG = 12;
/** A surface below this confidence is classified UNKNOWN whatever its orientation. */
export const MIN_CLASSIFY_CONFIDENCE = 0.3;
/** How far below the camera a horizontal surface must sit to be something to play on, fraction of depth. */
export const BELOW_CAMERA_FRACTION = 0.1;
/** Horizontal surfaces within this of the lowest are part of the ground too, fraction of depth. */
export const GROUND_BAND_FRACTION = 0.06;
/** Confidence-weighted support at which a surface's support term saturates: twice the minimum. */
export const SUPPORT_SATURATION = 2 * MIN_SURFACE_SUPPORT;
/** A vertical surface with this much support or more is a wall. */
export const WALL_SUPPORT = 40;

export const SurfaceOrientation = {
  HORIZONTAL: 'HORIZONTAL',
  VERTICAL: 'VERTICAL',
  SLANTED: 'SLANTED',
  /** No gravity estimate: the plane has a normal and no up. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type SurfaceOrientation = (typeof SurfaceOrientation)[keyof typeof SurfaceOrientation];

/** v4 §24's game categories, verbatim. */
export const SurfaceClass = {
  GROUND: 'GROUND',
  WALL: 'WALL',
  PLATFORM: 'PLATFORM',
  OBSTACLE_SURFACE: 'OBSTACLE_SURFACE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type SurfaceClass = (typeof SurfaceClass)[keyof typeof SurfaceClass];

export interface SurfaceLandmark {
  readonly id: number;
  readonly position: readonly number[];
  readonly confidence: number;
  readonly confirmed: boolean;
}

export interface SurfaceInput {
  readonly landmarks: readonly SurfaceLandmark[];
  /** Keyframe camera centres in the world — which side of a plane was observed, and how high the camera is. */
  readonly cameraCenters: readonly (readonly number[])[];
  /** Unit vector toward the ground, world frame, or `null` when gravity is not measured. */
  readonly worldDown: readonly number[] | null;
  readonly seed: number;
}

export interface ConfidenceTerm {
  readonly name: string;
  readonly value: number;
  readonly note: string;
}

export interface Surface {
  /** Stable across extractions when the same plane is found again — see `assignSurfaceIds`. */
  readonly id: number;
  /** Unit normal, pointing to the side the cameras saw it from. */
  readonly normal: readonly number[];
  /** Plane: `normal · X = offset`. */
  readonly offset: number;
  readonly centroid: readonly number[];
  /** In-plane orthonormal basis, so the polygon can be read in 2-D. */
  readonly basisU: readonly number[];
  readonly basisV: readonly number[];
  /** Convex hull of its landmarks, world frame, counter-clockwise about `normal`. */
  readonly polygon: readonly (readonly number[])[];
  readonly area: number;
  /** RMS distance of its landmarks from the plane, as a fraction of the scene depth. */
  readonly residual: number;
  readonly support: number;
  readonly landmarkIds: readonly number[];
  readonly orientation: SurfaceOrientation;
  readonly surfaceClass: SurfaceClass;
  readonly classReason: string;
  /** Degrees from level (0 = horizontal plane). `-1` without gravity. */
  readonly tiltDeg: number;
  /** Height above the ground along gravity, in world units; `-1` without gravity or ground. */
  readonly heightAboveGround: number;
  readonly confidence: number;
  readonly confidenceTerms: readonly ConfidenceTerm[];
}

export interface SurfaceExtraction {
  readonly surfaces: readonly Surface[];
  /** Median distance from the landmarks to the nearest camera: the unit every threshold is a fraction of. */
  readonly sceneDepth: number;
  readonly inlierDistance: number;
  readonly candidates: number;
  readonly used: number;
  readonly hypotheses: number;
  /** Camera height above the ground along gravity, world units. `-1` without both. */
  readonly cameraHeight: number;
  readonly reason: string;
}

const EMPTY: SurfaceExtraction = {
  surfaces: [],
  sceneDepth: -1,
  inlierDistance: -1,
  candidates: 0,
  used: 0,
  hypotheses: 0,
  cameraHeight: -1,
  reason: 'no confirmed landmarks',
};

/** Extract and classify. Ids are provisional (0..n-1) until `assignSurfaceIds` maps them. */
export function extractSurfaces(input: SurfaceInput): SurfaceExtraction {
  const points = input.landmarks.filter(
    (l) => l.confirmed && l.position.length === 3 && l.position.every(Number.isFinite),
  );
  if (points.length < MIN_SURFACE_SUPPORT) {
    return {
      ...EMPTY,
      candidates: points.length,
      reason: `${points.length} confirmed landmark(s), below the ${MIN_SURFACE_SUPPORT} one surface must rest on`,
    };
  }
  if (input.cameraCenters.length === 0) {
    return { ...EMPTY, candidates: points.length, reason: 'no camera position to measure depth from' };
  }

  const sceneDepth = medianDepth(points, input.cameraCenters);
  if (!(sceneDepth > 0)) return { ...EMPTY, candidates: points.length, reason: 'the scene has no depth' };
  const inlierDistance = PLANE_INLIER_FRACTION * sceneDepth;
  const link = CLUSTER_LINK_FRACTION * sceneDepth;
  const rng = new Rng(input.seed);
  const cameraMean = mean(input.cameraCenters);

  let remaining = points.slice();
  const raw: RawSurface[] = [];
  let hypotheses = 0;
  for (let s = 0; s < MAX_SURFACES && remaining.length >= MIN_SURFACE_SUPPORT; s++) {
    const found = bestPlane(remaining, inlierDistance, rng);
    hypotheses += found.hypotheses;
    if (!found.plane) break;
    let plane = found.plane;
    let inliers = remaining.filter((p) => Math.abs(signedDistance(plane, p.position)) <= inlierDistance);
    // Two refinements: the least-squares plane through the inliers moves the band, and the band
    // decides the inliers.
    for (let r = 0; r < 2; r++) {
      const refined = fitPlane(inliers.map((p) => p.position));
      if (!refined) break;
      plane = refined;
      inliers = remaining.filter((p) => Math.abs(signedDistance(plane, p.position)) <= inlierDistance);
    }
    if (inliers.length < MIN_SURFACE_SUPPORT) break;
    const component = largestComponent(inliers, plane, link);
    if (component.length < MIN_SURFACE_SUPPORT) {
      // The best plane left is coplanar points scattered across the room, not a surface. Nothing
      // better remains: every later hypothesis has less support than this one had.
      break;
    }
    const final = fitPlane(component.map((p) => p.position)) ?? plane;
    raw.push(describe(final, component, cameraMean, sceneDepth, inlierDistance));
    const taken = new Set(component.map((p) => p.id));
    remaining = remaining.filter((p) => !taken.has(p.id));
  }

  const classified = classify(raw, input.worldDown, input.cameraCenters, sceneDepth);
  const cameraHeight = classified.cameraHeight;
  return {
    surfaces: classified.surfaces,
    sceneDepth: round(sceneDepth, 6),
    inlierDistance: round(inlierDistance, 6),
    candidates: points.length,
    used: points.length - remaining.length,
    hypotheses,
    cameraHeight,
    reason:
      classified.surfaces.length > 0
        ? `${classified.surfaces.length} surface(s) over ${points.length - remaining.length} of ` +
          `${points.length} confirmed landmark(s)`
        : `no plane among ${points.length} confirmed landmark(s) has ${MIN_SURFACE_SUPPORT} connected supporters`,
  };
}

/**
 * Carry ids across extractions: a surface found again keeps the id it had.
 *
 * "Again" means the same plane — normals within `MATCH_NORMAL_DEG`, offsets within
 * `MATCH_OFFSET_FRACTION` of the depth — **and** a shared landmark, so a second table at the
 * height of the first does not inherit its identity. Returns the surfaces with ids assigned and the
 * count of previous surfaces that were found again, which is SURF-003's persistence.
 */
export function assignSurfaceIds(
  previous: readonly Surface[],
  current: readonly Surface[],
  sceneDepth: number,
  nextId: number,
): { surfaces: Surface[]; persisted: number; nextId: number } {
  const used = new Set<number>();
  let id = nextId;
  let persisted = 0;
  const out: Surface[] = [];
  for (const s of current) {
    let match: Surface | null = null;
    let bestShared = 0;
    const ids = new Set(s.landmarkIds);
    for (const p of previous) {
      if (used.has(p.id)) continue;
      if (angleDeg(p.normal, s.normal) > MATCH_NORMAL_DEG) continue;
      if (Math.abs(p.offset - s.offset) > MATCH_OFFSET_FRACTION * sceneDepth) continue;
      let shared = 0;
      for (const l of p.landmarkIds) if (ids.has(l)) shared++;
      if (shared > bestShared) {
        bestShared = shared;
        match = p;
      }
    }
    if (match) {
      used.add(match.id);
      persisted++;
      out.push({ ...s, id: match.id });
    } else {
      out.push({ ...s, id: id++ });
    }
  }
  return { surfaces: out, persisted, nextId: id };
}

export const MATCH_NORMAL_DEG = 10;
export const MATCH_OFFSET_FRACTION = 0.05;

/**
 * SURF-004's control: the same landmarks, each moved by exactly `CONTROL_JITTER_FRACTION` of the
 * depth in a seeded direction.
 *
 * Not spatial data — nothing downstream ever sees it. It keeps the cloud's count, extent and
 * density and destroys exactly one thing, the coplanarity at the inlier scale, so a detector that
 * finds as much structure in it as in the real map is finding its own thresholds.
 *
 * A fixed distance rather than a random one up to it: with the distance drawn uniformly a third
 * of the points barely move, a third of each plane survives, and the control measures how much
 * of the plane was left in place rather than whether the detector invents planes.
 */
export function jitteredControl(
  landmarks: readonly SurfaceLandmark[],
  sceneDepth: number,
  seed: number,
): SurfaceLandmark[] {
  const rng = new Rng(seed);
  const amount = CONTROL_JITTER_FRACTION * sceneDepth;
  return landmarks.map((l) => {
    const z = rng.next() * 2 - 1;
    const phi = rng.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const d = amount;
    return {
      ...l,
      position: [
        (l.position[0] ?? 0) + d * r * Math.cos(phi),
        (l.position[1] ?? 0) + d * r * Math.sin(phi),
        (l.position[2] ?? 0) + d * z,
      ],
    };
  });
}

/** How far the control moves a landmark at most: ten inlier bands. */
export const CONTROL_JITTER_FRACTION = 10 * PLANE_INLIER_FRACTION;

/* -------------------------------------------------------------------------- */

interface Plane {
  readonly normal: readonly number[];
  readonly offset: number;
}

interface RawSurface {
  readonly plane: Plane;
  readonly points: readonly SurfaceLandmark[];
  readonly centroid: readonly number[];
  readonly basisU: readonly number[];
  readonly basisV: readonly number[];
  readonly polygon: readonly (readonly number[])[];
  readonly area: number;
  readonly residual: number;
  readonly confidence: number;
  readonly confidenceTerms: readonly ConfidenceTerm[];
}

function bestPlane(
  points: readonly SurfaceLandmark[],
  inlierDistance: number,
  rng: Rng,
): { plane: Plane | null; hypotheses: number } {
  const scoring =
    points.length <= SCORING_SAMPLE
      ? points
      : rng.sampleDistinct(SCORING_SAMPLE, points.length).map((i) => points[i] as SurfaceLandmark);
  let best: Plane | null = null;
  let bestCount = 0;
  let needed = MAX_HYPOTHESES;
  let h = 0;
  for (; h < needed && h < MAX_HYPOTHESES; h++) {
    const [i, j, k] = rng.sampleDistinct(3, scoring.length);
    const a = scoring[i ?? 0]?.position;
    const b = scoring[j ?? 0]?.position;
    const c = scoring[k ?? 0]?.position;
    if (!a || !b || !c) continue;
    const plane = planeThrough(a, b, c, inlierDistance);
    if (!plane) continue;
    let count = 0;
    for (const p of scoring) if (Math.abs(signedDistance(plane, p.position)) <= inlierDistance) count++;
    if (count > bestCount) {
      bestCount = count;
      best = plane;
      // The adaptive stopping rule: enough hypotheses that a better plane would have been drawn
      // with 99 % probability, given the best inlier share seen so far.
      const w = count / scoring.length;
      const p3 = w * w * w;
      needed = p3 >= 1 ? 1 : Math.min(MAX_HYPOTHESES, Math.ceil(Math.log(0.01) / Math.log(1 - p3)) + 10);
    }
  }
  const scaled = (bestCount * points.length) / scoring.length;
  return { plane: scaled >= MIN_SURFACE_SUPPORT ? best : null, hypotheses: h };
}

function planeThrough(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  minSpan: number,
): Plane | null {
  const u = sub(b, a);
  const v = sub(c, a);
  const n = cross(u, v);
  const len = norm(n);
  // A sliver triangle defines its plane badly: the cross product's length is twice its area.
  if (!(len > minSpan * minSpan)) return null;
  const normal = n.map((x) => x / len);
  return { normal, offset: dot(normal, a) };
}

function fitPlane(points: readonly (readonly number[])[]): Plane | null {
  if (points.length < 3) return null;
  const c = mean(points);
  const cov = new Array<number>(9).fill(0);
  for (const p of points) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] = (cov[i * 3 + j] ?? 0) + (d[i] ?? 0) * (d[j] ?? 0);
  }
  const { values, vectors } = symmetricEigen(cov, 3);
  const normal = vectors[0];
  if (!normal || !((values[1] ?? 0) > 0)) return null;
  const n = normal.map((x) => x / (norm(normal) || 1));
  return { normal: n, offset: dot(n, c) };
}

function largestComponent(
  points: readonly SurfaceLandmark[],
  plane: Plane,
  link: number,
): SurfaceLandmark[] {
  const [u, v] = basisFor(plane.normal);
  const coords = points.map((p) => [dot(p.position, u), dot(p.position, v)]);
  const cell = (x: number): number => Math.floor(x / link);
  const grid = new Map<string, number[]>();
  coords.forEach((c, i) => {
    const key = `${cell(c[0] ?? 0)},${cell(c[1] ?? 0)}`;
    const list = grid.get(key) ?? [];
    list.push(i);
    grid.set(key, list);
  });
  const seen = new Array<boolean>(points.length).fill(false);
  let best: number[] = [];
  for (let start = 0; start < points.length; start++) {
    if (seen[start]) continue;
    const component: number[] = [];
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const i = queue.pop() as number;
      component.push(i);
      const ci = coords[i] ?? [0, 0];
      const gx = cell(ci[0] ?? 0);
      const gy = cell(ci[1] ?? 0);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
            if (seen[j]) continue;
            const cj = coords[j] ?? [0, 0];
            if (Math.hypot((ci[0] ?? 0) - (cj[0] ?? 0), (ci[1] ?? 0) - (cj[1] ?? 0)) > link) continue;
            seen[j] = true;
            queue.push(j);
          }
        }
      }
    }
    if (component.length > best.length) best = component;
  }
  return best.map((i) => points[i] as SurfaceLandmark);
}

function describe(
  plane: Plane,
  points: readonly SurfaceLandmark[],
  cameraMean: readonly number[],
  sceneDepth: number,
  inlierDistance: number,
): RawSurface {
  // Point the normal at the side that was observed.
  const centroid = mean(points.map((p) => p.position));
  const facing = dot(plane.normal, sub(cameraMean, centroid));
  const normal = facing >= 0 ? [...plane.normal] : plane.normal.map((x) => -x);
  const offset = dot(normal, centroid);
  const [u, v] = basisFor(normal);
  const coords = points.map((p) => [dot(sub(p.position, centroid), u), dot(sub(p.position, centroid), v)]);
  const hull2 = convexHull(coords);
  const polygon = hull2.map(([a, b]) => [0, 1, 2].map((i) => (centroid[i] ?? 0) + (a ?? 0) * (u[i] ?? 0) + (b ?? 0) * (v[i] ?? 0)));
  const area = polygonArea(hull2);
  const distances = points.map((p) => dot(normal, p.position) - offset);
  const rms = Math.sqrt(distances.reduce((s, d) => s + d * d, 0) / distances.length);
  // Support is counted in *confidence*, not in landmarks: each landmark contributes what Phase 10
  // vouches for it (observations, parallax, prediction, viewpoint spread — never a clock).
  //
  // The first version took the **median** landmark confidence as a third term of the minimum. The
  // spatial leg measured what that does: a floor of 97 landmarks at a median confidence of 0.31,
  // flat to 0.3° of gravity, capped at 0.31 — below the ground bar — while a plane resting on a
  // hundred moderately-confident points is far stronger evidence than any one of them. A median
  // says how good a typical landmark is; the question here is how well the *surface* is
  // established, and that is an aggregate.
  const effective = points.reduce((a, p) => a + Math.max(0, Math.min(1, p.confidence)), 0);
  const terms: ConfidenceTerm[] = [
    {
      name: 'support',
      value: round(Math.min(1, effective / SUPPORT_SATURATION), 4),
      note:
        `${points.length} landmark(s) worth ${round(effective, 1)} in confidence (median ` +
        `${round(median(points.map((p) => p.confidence)), 3)}) against ${SUPPORT_SATURATION}`,
    },
    {
      name: 'planarity',
      value: round(Math.max(0, 1 - rms / inlierDistance), 4),
      note: `RMS ${round(rms / sceneDepth, 5)} of a depth against a band of ${PLANE_INLIER_FRACTION}`,
    },
  ];
  return {
    plane: { normal, offset },
    points,
    centroid,
    basisU: u,
    basisV: v,
    polygon,
    area,
    residual: rms / sceneDepth,
    confidence: Math.min(...terms.map((t) => t.value)),
    confidenceTerms: terms,
  };
}

function classify(
  raw: readonly RawSurface[],
  worldDown: readonly number[] | null,
  cameraCenters: readonly (readonly number[])[],
  sceneDepth: number,
): { surfaces: Surface[]; cameraHeight: number } {
  const base = (r: RawSurface, i: number): Omit<Surface, 'orientation' | 'surfaceClass' | 'classReason' | 'tiltDeg' | 'heightAboveGround'> => ({
    id: i,
    normal: r.plane.normal.map((v) => round(v, 6)),
    offset: round(r.plane.offset, 6),
    centroid: r.centroid.map((v) => round(v, 6)),
    basisU: r.basisU.map((v) => round(v, 6)),
    basisV: r.basisV.map((v) => round(v, 6)),
    polygon: r.polygon.map((p) => p.map((v) => round(v, 6))),
    area: round(r.area, 6),
    residual: round(r.residual, 6),
    support: r.points.length,
    landmarkIds: r.points.map((p) => p.id).sort((a, b) => a - b),
    confidence: round(r.confidence, 4),
    confidenceTerms: r.confidenceTerms,
  });

  if (!worldDown || worldDown.length !== 3) {
    return {
      surfaces: raw.map((r, i) => ({
        ...base(r, i),
        orientation: SurfaceOrientation.UNKNOWN,
        surfaceClass: SurfaceClass.UNKNOWN,
        classReason: 'gravity is not measured, so this plane has a normal and no up — PLANE: UNKNOWN (v4 §1.4)',
        tiltDeg: -1,
        heightAboveGround: -1,
      })),
      cameraHeight: -1,
    };
  }

  const up = worldDown.map((v) => -v);
  const heightOf = (p: readonly number[]): number => dot(up, p);
  const cameraLevel = median(cameraCenters.map(heightOf));
  const tilts = raw.map((r) => {
    const c = Math.abs(dot(r.plane.normal, up));
    return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
  });
  const orientations = tilts.map((t) =>
    t <= ORIENTATION_TOLERANCE_DEG
      ? SurfaceOrientation.HORIZONTAL
      : t >= 90 - ORIENTATION_TOLERANCE_DEG
        ? SurfaceOrientation.VERTICAL
        : SurfaceOrientation.SLANTED,
  );
  const below = raw.map(
    (r, i) =>
      orientations[i] === SurfaceOrientation.HORIZONTAL &&
      heightOf(r.centroid) < cameraLevel - BELOW_CAMERA_FRACTION * sceneDepth &&
      r.confidence >= MIN_CLASSIFY_CONFIDENCE,
  );
  let groundLevel = Infinity;
  raw.forEach((r, i) => {
    if (below[i]) groundLevel = Math.min(groundLevel, heightOf(r.centroid));
  });
  const hasGround = Number.isFinite(groundLevel);

  const surfaces = raw.map((r, i): Surface => {
    const orientation = orientations[i] ?? SurfaceOrientation.SLANTED;
    const tilt = tilts[i] ?? 90;
    const h = heightOf(r.centroid);
    const heightAboveGround = hasGround ? round(h - groundLevel, 6) : -1;
    let surfaceClass: SurfaceClass = SurfaceClass.UNKNOWN;
    let classReason: string;
    if (r.confidence < MIN_CLASSIFY_CONFIDENCE) {
      classReason = `confidence ${round(r.confidence, 3)} is below ${MIN_CLASSIFY_CONFIDENCE} — kept as an observation, not used for play`;
    } else if (orientation === SurfaceOrientation.HORIZONTAL) {
      if (below[i] && h - groundLevel <= GROUND_BAND_FRACTION * sceneDepth) {
        surfaceClass = SurfaceClass.GROUND;
        classReason = `horizontal within ${round(tilt, 1)}°, the lowest observed level, below the camera`;
      } else if (below[i]) {
        surfaceClass = SurfaceClass.PLATFORM;
        classReason = `horizontal within ${round(tilt, 1)}°, ${round(h - groundLevel, 3)} units above the ground and below the camera`;
      } else {
        classReason = 'horizontal but not below the camera — overhead, nothing a ball can be played onto';
      }
    } else if (orientation === SurfaceOrientation.VERTICAL) {
      surfaceClass = r.points.length >= WALL_SUPPORT ? SurfaceClass.WALL : SurfaceClass.OBSTACLE_SURFACE;
      classReason =
        `vertical within ${round(90 - tilt, 1)}° of plumb, ${r.points.length} landmark(s)` +
        (surfaceClass === SurfaceClass.WALL ? '' : ` — fewer than the ${WALL_SUPPORT} a wall is held to`);
    } else {
      surfaceClass = SurfaceClass.OBSTACLE_SURFACE;
      classReason = `slanted ${round(tilt, 1)}° from level — a real surface in the way, neither floor nor wall`;
    }
    // Horizontal play surfaces face up whatever side the camera saw — a ball rests on top.
    let normal = r.plane.normal;
    let offset = r.plane.offset;
    if ((surfaceClass === SurfaceClass.GROUND || surfaceClass === SurfaceClass.PLATFORM) && dot(normal, up) < 0) {
      normal = normal.map((v) => -v);
      offset = -offset;
    }
    return {
      ...base(r, i),
      normal: normal.map((v) => round(v, 6)),
      offset: round(offset, 6),
      orientation,
      surfaceClass,
      classReason,
      tiltDeg: round(tilt, 3),
      heightAboveGround,
    };
  });
  return {
    surfaces,
    cameraHeight: hasGround ? round(cameraLevel - groundLevel, 6) : -1,
  };
}

function medianDepth(points: readonly SurfaceLandmark[], cameras: readonly (readonly number[])[]): number {
  const depths = points.map((p) => {
    let best = Infinity;
    for (const c of cameras) best = Math.min(best, norm(sub(p.position, c)));
    return best;
  });
  return median(depths);
}

/** Andrew's monotone chain. Counter-clockwise, no collinear points. */
export function convexHull(points: readonly (readonly number[])[]): number[][] {
  const pts = points
    .map((p) => [p[0] ?? 0, p[1] ?? 0])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
  if (pts.length < 3) return pts;
  const crossZ = (o: number[], a: number[], b: number[]): number =>
    ((a[0] ?? 0) - (o[0] ?? 0)) * ((b[1] ?? 0) - (o[1] ?? 0)) - ((a[1] ?? 0) - (o[1] ?? 0)) * ((b[0] ?? 0) - (o[0] ?? 0));
  const lower: number[][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2] as number[], lower[lower.length - 1] as number[], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: number[][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as number[];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2] as number[], upper[upper.length - 1] as number[], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: readonly (readonly number[])[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] ?? [0, 0];
    const q = poly[(i + 1) % poly.length] ?? [0, 0];
    a += (p[0] ?? 0) * (q[1] ?? 0) - (q[0] ?? 0) * (p[1] ?? 0);
  }
  return Math.abs(a) / 2;
}

/** A right-handed in-plane basis: `u × v = normal`. Deterministic for a given normal. */
export function basisFor(normal: readonly number[]): [number[], number[]] {
  const n = normal;
  const helper = Math.abs(n[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0 = cross(helper, n);
  const lu = norm(u0) || 1;
  const u = u0.map((x) => x / lu);
  const v = cross(n, u);
  return [u, v];
}

function signedDistance(plane: Plane, p: readonly number[]): number {
  return dot(plane.normal, p) - plane.offset;
}

function mean(points: readonly (readonly number[])[]): number[] {
  const s = [0, 0, 0];
  for (const p of points) for (let i = 0; i < 3; i++) s[i] = (s[i] ?? 0) + (p[i] ?? 0);
  return s.map((x) => x / Math.max(1, points.length));
}

function sub(a: readonly number[], b: readonly number[]): number[] {
  return [(a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0)];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function norm(a: readonly number[]): number {
  return Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
