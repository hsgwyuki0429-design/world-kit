/**
 * The camera-overlay renderer (Phase 13 — v4 §38, §40).
 *
 * Draws what the SpatialWorld holds and what the game generated from it, over the live camera
 * image, through the world's own camera pose. It holds no geometry: every polygon, ring and ball
 * it draws is read from the view it is handed on that frame, and the architecture audit keeps it
 * from reaching the tracker or the map for anything else.
 *
 * ## One projection, checked against the tracker
 *
 * `projectWorld` is the only path from a world point to a pixel. The worker ships, with each
 * pose, a sample of the correspondences it solved from — where the tracker saw a landmark, and
 * where the map holds it — and `alignment` sends those world positions through this same function
 * and measures how far they land from the tracker's pixels (VIEW-001). A renderer whose
 * projection disagreed with the pose by a transpose, a sign or a frame size would draw a ring
 * that floats beside where it belongs while every number elsewhere looked fine.
 *
 * ## Coordinates
 *
 * The canvas's internal size is the processing frame's, scaled by `PIXEL_SCALE`, and CSS
 * stretches it over the video in the same aspect-locked box the earlier phases use — so a
 * processing pixel and a canvas pixel differ by one uniform factor and nothing is cropped.
 */

import type { GameView } from '../game/GameSession';
import { SurfaceClass } from '../world/SpatialWorld';
import type { SpatialWorldView, WorldPose } from '../world/SpatialWorld';

/** Canvas pixels per processing pixel — enough for a crisp line on a 3× screen, cheap enough to clear. */
export const PIXEL_SCALE = 1.5;
/** Nothing nearer the camera than this fraction of the scene depth is drawn. */
const NEAR_FRACTION = 0.03;
/** A ring whose centre projects within this many processing pixels of the frame's edge, or outside it, gets an edge arrow. */
const EDGE_MARGIN_PX = 18;

const CLASS_COLOURS: Record<string, string> = {
  [SurfaceClass.GROUND]: '48, 209, 88',
  [SurfaceClass.PLATFORM]: '100, 210, 255',
  [SurfaceClass.WALL]: '94, 92, 230',
  [SurfaceClass.OBSTACLE_SURFACE]: '255, 159, 10',
  [SurfaceClass.UNKNOWN]: '142, 142, 147',
};

export interface Projected {
  readonly x: number;
  readonly y: number;
  readonly depth: number;
}

export interface DrawReport {
  readonly surfacesDrawn: number;
  readonly surfaceIds: readonly number[];
  readonly ringDrawn: boolean;
  readonly ballDrawn: boolean;
  readonly startDrawn: boolean;
  /** The ring was off the frame and an arrow at the edge pointed the way to it. */
  readonly ringIndicated: boolean;
  readonly guidePoints: number;
  readonly landmarksDrawn: number;
  readonly ms: number;
  readonly poseUsed: boolean;
}

export interface AlignmentReading {
  readonly samples: number;
  readonly medianPx: number;
  readonly maxPx: number;
}

/** World point → processing-frame pixel, through the world's camera pose. `null` behind the camera. */
export function projectWorld(pose: WorldPose, p: readonly number[]): Projected | null {
  const r = pose.rotation;
  const t = pose.translation;
  const x = (r[0] ?? 0) * (p[0] ?? 0) + (r[1] ?? 0) * (p[1] ?? 0) + (r[2] ?? 0) * (p[2] ?? 0) + (t[0] ?? 0);
  const y = (r[3] ?? 0) * (p[0] ?? 0) + (r[4] ?? 0) * (p[1] ?? 0) + (r[5] ?? 0) * (p[2] ?? 0) + (t[1] ?? 0);
  const z = (r[6] ?? 0) * (p[0] ?? 0) + (r[7] ?? 0) * (p[1] ?? 0) + (r[8] ?? 0) * (p[2] ?? 0) + (t[2] ?? 0);
  if (!(z > 1e-6)) return null;
  const k = pose.intrinsics;
  return { x: k.fx * (x / z) + k.cx, y: k.fy * (y / z) + k.cy, depth: z };
}

/** VIEW-001: the tracker's pixels against this module's projection of the map's positions. */
export function alignment(
  pose: WorldPose,
  samples: readonly { readonly x: number; readonly y: number; readonly world: readonly number[] }[],
): AlignmentReading {
  const errors: number[] = [];
  for (const s of samples) {
    const p = projectWorld(pose, s.world);
    if (!p) continue;
    errors.push(Math.hypot(p.x - s.x, p.y - s.y));
  }
  if (errors.length === 0) return { samples: 0, medianPx: -1, maxPx: -1 };
  errors.sort((a, b) => a - b);
  return {
    samples: errors.length,
    medianPx: round(errors[errors.length >> 1] ?? 0, 4),
    maxPx: round(errors[errors.length - 1] ?? 0, 4),
  };
}

export interface RenderOptions {
  readonly surfaces: boolean;
  readonly landmarks: boolean;
}

export class ArRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d');
  }

  /** Draw one frame. The caller times it; `ms` is left for the caller to fill. */
  draw(world: SpatialWorldView, game: GameView | null, options: RenderOptions): DrawReport {
    const empty: DrawReport = {
      surfacesDrawn: 0, surfaceIds: [], ringDrawn: false, ballDrawn: false, startDrawn: false,
      ringIndicated: false, guidePoints: 0, landmarksDrawn: 0, ms: 0, poseUsed: false,
    };
    const ctx = this.ctx;
    const pose = world.cameraPose;
    if (!ctx) return empty;
    if (!pose) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return empty;
    }
    const w = Math.round(pose.intrinsics.width * PIXEL_SCALE);
    const h = Math.round(pose.intrinsics.height * PIXEL_SCALE);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(PIXEL_SCALE, PIXEL_SCALE);
    const near = Math.max(1e-4, NEAR_FRACTION * (world.sceneDepth > 0 ? world.sceneDepth : 1));
    const unit = world.cameraHeight > 0 ? world.cameraHeight : 1;

    const surfaceIds: number[] = [];
    if (options.surfaces) {
      for (const s of world.surfaces) {
        const pts = projectPolygon(pose, s.polygon, near);
        if (pts.length < 3) continue;
        surfaceIds.push(s.id);
        const rgb = CLASS_COLOURS[s.surfaceClass] ?? CLASS_COLOURS[SurfaceClass.UNKNOWN];
        const alpha = 0.12 + 0.25 * Math.max(0, Math.min(1, s.confidence));
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = `rgba(${rgb}, ${alpha * 0.6})`;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.setLineDash(s.surfaceClass === SurfaceClass.UNKNOWN ? [4, 4] : []);
        ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, alpha + 0.4)})`;
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    let landmarksDrawn = 0;
    if (options.landmarks) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      for (const l of world.landmarks) {
        if (!l.confirmed) continue;
        const p = projectWorld(pose, l.position);
        if (!p || p.depth < near) continue;
        ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        landmarksDrawn++;
      }
    }

    let ringDrawn = false;
    let ballDrawn = false;
    let startDrawn = false;
    let ringIndicated = false;
    let guidePoints = 0;
    const stage = game?.stage ?? null;
    if (stage && game) {
      // The aim guide first, so the ring and the ball sit on top of it.
      for (let i = 0; i < game.aimGuide.length; i += 2) {
        const p = projectWorld(pose, game.aimGuide[i] ?? []);
        if (!p || p.depth < near) continue;
        const fade = 1 - i / Math.max(1, game.aimGuide.length);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.2, (pose.intrinsics.fx * 0.012 * unit) / p.depth), 0, Math.PI * 2);
        ctx.fillStyle = game.aimWouldScore && stage.difficulty.difficulty === 'EASY'
          ? `rgba(48, 209, 88, ${0.35 + 0.55 * fade})`
          : `rgba(255, 255, 255, ${0.25 + 0.6 * fade})`;
        ctx.fill();
        guidePoints++;
      }

      ringDrawn = this.drawRing(ctx, pose, stage.ring.center, stage.ring.axis, stage.ring.radius, near, game.state === 'SUCCESS');
      ringIndicated = this.drawRingIndicator(ctx, pose, stage.ring.center, near);

      const tee = projectWorld(pose, stage.start.position);
      if (tee && tee.depth > near && game.state !== 'THROWING') {
        const r = (pose.intrinsics.fx * game.ballRadius * 1.6) / tee.depth;
        ctx.beginPath();
        ctx.setLineDash([3, 3]);
        ctx.arc(tee.x, tee.y, Math.max(4, r), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        startDrawn = true;
      }

      if (game.ball) {
        ballDrawn = this.drawBall(ctx, world, pose, game.ball, game.ballRadius, near);
      }
    }
    ctx.restore();
    return {
      surfacesDrawn: surfaceIds.length,
      surfaceIds,
      ringDrawn,
      ballDrawn,
      startDrawn,
      ringIndicated,
      guidePoints,
      landmarksDrawn,
      ms: 0,
      poseUsed: true,
    };
  }

  private drawRing(
    ctx: CanvasRenderingContext2D,
    pose: WorldPose,
    center: readonly number[],
    axis: readonly number[],
    radius: number,
    near: number,
    scored: boolean,
  ): boolean {
    const [a, b] = perpendiculars(axis);
    const pts: (Projected | null)[] = [];
    const n = 48;
    for (let k = 0; k <= n; k++) {
      const t = (k / n) * Math.PI * 2;
      const p = center.map((x, i) => x + radius * (Math.cos(t) * (a[i] ?? 0) + Math.sin(t) * (b[i] ?? 0)));
      const q = projectWorld(pose, p);
      pts.push(q && q.depth > near ? q : null);
    }
    const c = projectWorld(pose, center);
    if (!c || c.depth <= near) return false;
    const thickness = Math.max(2.5, (pose.intrinsics.fx * radius * 0.18) / c.depth);
    const stroke = (width: number, colour: string): void => {
      ctx.beginPath();
      let pen = false;
      for (const p of pts) {
        if (!p) {
          pen = false;
          continue;
        }
        if (!pen) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        pen = true;
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = colour;
      ctx.stroke();
    };
    stroke(thickness + 3, 'rgba(0, 0, 0, 0.35)');
    stroke(thickness, scored ? 'rgba(48, 209, 88, 1)' : 'rgba(255, 196, 0, 1)');
    stroke(Math.max(1, thickness * 0.35), 'rgba(255, 244, 200, 0.9)');
    return true;
  }

  /**
   * A stage may put its ring up to 55° off the view it was made from (§28), which is past the edge
   * of a portrait phone's frame. When the ring's centre is off the frame — or behind the camera —
   * an arrow on the edge points the way to turn. Its direction is the ring's own, through the same
   * pose: from the frame's centre toward the ring's projection, or, behind the camera, toward the
   * side the ring is on.
   */
  private drawRingIndicator(ctx: CanvasRenderingContext2D, pose: WorldPose, center: readonly number[], near: number): boolean {
    const k = pose.intrinsics;
    const c = toCamera(pose, center);
    const z = c[2] ?? 0;
    let dx: number;
    let dy: number;
    if (z > near) {
      const x = k.fx * ((c[0] ?? 0) / z) + k.cx;
      const y = k.fy * ((c[1] ?? 0) / z) + k.cy;
      const onFrame = x >= EDGE_MARGIN_PX && x <= k.width - EDGE_MARGIN_PX && y >= EDGE_MARGIN_PX && y <= k.height - EDGE_MARGIN_PX;
      if (onFrame) return false;
      dx = x - k.cx;
      dy = y - k.cy;
    } else {
      dx = c[0] ?? 0;
      dy = c[1] ?? 0;
    }
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-9 ? dx / len : 0;
    const uy = len > 1e-9 ? dy / len : 1;
    const hw = k.width / 2 - EDGE_MARGIN_PX;
    const hh = k.height / 2 - EDGE_MARGIN_PX;
    const reach = Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity);
    const px = k.width / 2 + ux * reach;
    const py = k.height / 2 + uy * reach;
    const size = 13;
    ctx.beginPath();
    ctx.moveTo(px + ux * size, py + uy * size);
    ctx.lineTo(px - ux * size * 0.6 - uy * size * 0.8, py - uy * size * 0.6 + ux * size * 0.8);
    ctx.lineTo(px - ux * size * 0.6 + uy * size * 0.8, py - uy * size * 0.6 - ux * size * 0.8);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 196, 0, 0.95)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.stroke();
    return true;
  }

  private drawBall(
    ctx: CanvasRenderingContext2D,
    world: SpatialWorldView,
    pose: WorldPose,
    position: readonly number[],
    radius: number,
    near: number,
  ): boolean {
    const down = world.gravity.worldDown;
    // A shadow on the observed ground straight below the ball, if there is ground there — the
    // only depth cue a flat overlay has. None where nothing was observed: a shadow on an
    // unobserved floor would be a floor drawn by the renderer.
    if (down) {
      const ground = world.surfaces.filter((s) => s.surfaceClass === SurfaceClass.GROUND || s.surfaceClass === SurfaceClass.PLATFORM);
      let best: { point: number[]; dist: number } | null = null;
      for (const s of ground) {
        const denom = dot(s.normal, down);
        if (Math.abs(denom) < 1e-6) continue;
        const dist = (s.offset - dot(s.normal, position)) / denom;
        if (dist < 0) continue;
        const point = position.map((x, i) => x + (down[i] ?? 0) * dist);
        if (!insidePolygon3d(s, point)) continue;
        if (!best || dist < best.dist) best = { point, dist };
      }
      if (best) {
        const [a, b] = perpendiculars(down);
        ctx.beginPath();
        let started = false;
        for (let k = 0; k <= 24; k++) {
          const t = (k / 24) * Math.PI * 2;
          const p = projectWorld(pose, best.point.map((x, i) => x + radius * (Math.cos(t) * (a[i] ?? 0) + Math.sin(t) * (b[i] ?? 0))));
          if (!p || p.depth < near) continue;
          if (!started) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
          started = true;
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fill();
      }
    }
    const c = projectWorld(pose, position);
    if (!c || c.depth < near) return false;
    const r = Math.max(2, (pose.intrinsics.fx * radius) / c.depth);
    const g = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.35, r * 0.1, c.x, c.y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, '#ff7a45');
    g.addColorStop(1, '#a1260a');
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    return true;
  }
}

/** A world polygon, clipped to the near plane in camera space, then projected. */
export function projectPolygon(pose: WorldPose, polygon: readonly (readonly number[])[], near: number): Projected[] {
  const cam = polygon.map((p) => toCamera(pose, p));
  const clipped: number[][] = [];
  for (let i = 0; i < cam.length; i++) {
    const a = cam[i] ?? [0, 0, 0];
    const b = cam[(i + 1) % cam.length] ?? [0, 0, 0];
    const ina = (a[2] ?? 0) >= near;
    const inb = (b[2] ?? 0) >= near;
    if (ina) clipped.push(a);
    if (ina !== inb) {
      const t = (near - (a[2] ?? 0)) / ((b[2] ?? 0) - (a[2] ?? 0));
      clipped.push(a.map((x, k) => x + t * ((b[k] ?? 0) - x)));
    }
  }
  const k = pose.intrinsics;
  return clipped.map((c) => ({
    x: k.fx * ((c[0] ?? 0) / (c[2] ?? 1)) + k.cx,
    y: k.fy * ((c[1] ?? 0) / (c[2] ?? 1)) + k.cy,
    depth: c[2] ?? 0,
  }));
}

function toCamera(pose: WorldPose, p: readonly number[]): number[] {
  const r = pose.rotation;
  const t = pose.translation;
  return [0, 1, 2].map(
    (i) => (r[i * 3] ?? 0) * (p[0] ?? 0) + (r[i * 3 + 1] ?? 0) * (p[1] ?? 0) + (r[i * 3 + 2] ?? 0) * (p[2] ?? 0) + (t[i] ?? 0),
  );
}

function insidePolygon3d(
  s: { readonly centroid: readonly number[]; readonly basisU: readonly number[]; readonly basisV: readonly number[]; readonly polygon: readonly (readonly number[])[] },
  p: readonly number[],
): boolean {
  const to2d = (q: readonly number[]): [number, number] => {
    const d = q.map((x, i) => x - (s.centroid[i] ?? 0));
    return [dot(d, s.basisU), dot(d, s.basisV)];
  };
  const [x, y] = to2d(p);
  const poly = s.polygon.map(to2d);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] ?? [0, 0];
    const b = poly[(i + 1) % poly.length] ?? [0, 0];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return poly.length >= 3;
}

function perpendiculars(axis: readonly number[]): [number[], number[]] {
  const helper = Math.abs(axis[0] ?? 0) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a0 = cross(axis, helper);
  const la = Math.hypot(a0[0] ?? 0, a0[1] ?? 0, a0[2] ?? 0) || 1;
  const a = a0.map((x) => x / la);
  return [a, cross(axis, a)];
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0),
    (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0),
  ];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Number.isFinite(x) ? Math.round(x * f) / f : x;
}
