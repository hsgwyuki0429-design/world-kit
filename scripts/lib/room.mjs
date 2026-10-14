/**
 * A synthetic room, filmed by a camera that turns and steps sideways — the scene the spatial legs
 * (Phases 11–21) need.
 *
 * Every earlier leg filmed fronto-parallel layers sliding past: enough for flow, verification,
 * pose, keyframes, triangulation and a map, and useless for this phase, because a scene of two
 * layers facing the camera has no floor in it. This one has a floor, a back wall, two side walls
 * and a table, ray-cast per pixel from a pinhole camera with **the app's own assumed intrinsics**
 * (67° across the long edge, `src/geometry/intrinsics.ts`) — so the geometry the map recovers is
 * the geometry that was rendered, up to the one scale a monocular camera cannot see.
 *
 * ## What the camera does, and why the orientation it reports is constant
 *
 * It is pitched down by `PITCH_DEG` throughout, turns left and right about the vertical, and
 * steps sideways. Turning about the vertical does not change which way is down **in the
 * device's frame**, so the orientation sensor's reading is the same on every frame — which is
 * what lets the harness dispatch it without knowing which video frame Chrome is showing. The
 * leg cannot synchronise its sensor events with the fake camera's frames; a scene whose true
 * sensor reading does not depend on the frame is the honest way to not need to.
 *
 * Yaw alone still separates the four image layouts the gravity estimator chooses between: under
 * a wrong layout the per-frame estimates of down swing as the camera turns (`mapping/gravity.ts`).
 *
 * ## Texture
 *
 * A checkerboard of hashed greys, a different hash per surface so a corner on the floor is never
 * a corner on the wall, with a faint sinusoid inside each cell. 2×2 supersampled: the floor runs
 * from 1.3 m to the horizon, and an unfiltered checker aliases into moiré that moves non-rigidly
 * and is tracked as if it were structure.
 *
 * The camera path is periodic over the file's length, so Chrome's loop of the file is a continuous
 * motion rather than a jump the tracker would have to recover from.
 */

export const ROOM = {
  floorY: 1.4,
  ceilingY: -1.25,
  backZ: 4.2,
  leftX: -2.3,
  rightX: 2.3,
  table: { x0: 0.25, x1: 1.05, z0: 2.1, z1: 2.9, top: 0.72 },
};

export const PITCH_DEG = 15;
export const YAW_AMPLITUDE_DEG = 16;
export const STEP_AMPLITUDE_M = 0.35;
export const FOV_LONG_EDGE_DEG = 67;

function hash(i, j, seed) {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) % 1000) / 1000;
}

function checker(a, b, seed, cell) {
  const i = Math.floor(a / cell);
  const j = Math.floor(b / cell);
  const base = 45 + 170 * hash(i, j, seed);
  const fine = 12 * Math.sin(a * 41 + seed) * Math.cos(b * 37 - seed);
  return base + fine;
}

/** Pose at frame `k` of `frames`: room→camera rotation (row-major) and centre, metres. */
export function cameraAt(k, frames) {
  const phi = (2 * Math.PI * k) / frames;
  const yaw = (YAW_AMPLITUDE_DEG * Math.PI) / 180 * Math.sin(phi);
  const pitch = (PITCH_DEG * Math.PI) / 180;
  const center = [STEP_AMPLITUDE_M * Math.sin(phi + 0.6), 0, 0.1 * Math.sin(2 * phi)];
  // R = Rx(pitch) · Ry(yaw): a positive pitch looks down (y is down), as in the unit fixtures.
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let q = 0; q < 3; q++) s += rx[i * 3 + q] * ry[q * 3 + j];
    r[i * 3 + j] = s;
  }
  return { rotation: r, center, yaw, pitch };
}

/** Luma of the first surface along a room-frame ray. */
function shade(o, d) {
  let best = Infinity;
  let value = 128;
  const consider = (t, fn) => {
    if (t > 1e-6 && t < best) {
      const v = fn(t);
      if (v !== null) {
        best = t;
        value = v;
      }
    }
  };
  const at = (t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const T = ROOM.table;
  if (d[1] > 0) {
    consider((ROOM.floorY - o[1]) / d[1], (t) => {
      const p = at(t);
      return p[2] > -1 && p[2] < ROOM.backZ && p[0] > ROOM.leftX && p[0] < ROOM.rightX ? checker(p[0], p[2], 11, 0.22) : null;
    });
    consider((T.top - o[1]) / d[1], (t) => {
      const p = at(t);
      return p[0] > T.x0 && p[0] < T.x1 && p[2] > T.z0 && p[2] < T.z1 ? checker(p[0], p[2], 29, 0.12) : null;
    });
  } else if (d[1] < 0) {
    consider((ROOM.ceilingY - o[1]) / d[1], () => 104);
  }
  if (d[2] > 0) {
    consider((ROOM.backZ - o[2]) / d[2], (t) => {
      const p = at(t);
      return checker(p[0], p[1], 37, 0.26);
    });
    consider((T.z0 - o[2]) / d[2], (t) => {
      const p = at(t);
      return p[0] > T.x0 && p[0] < T.x1 && p[1] > T.top && p[1] < ROOM.floorY ? checker(p[0], p[1], 53, 0.1) : null;
    });
  }
  if (d[0] < 0) {
    consider((ROOM.leftX - o[0]) / d[0], (t) => {
      const p = at(t);
      return checker(p[2], p[1], 71, 0.24);
    });
    consider((T.x1 - o[0]) / d[0], (t) => {
      const p = at(t);
      return p[2] > T.z0 && p[2] < T.z1 && p[1] > T.top && p[1] < ROOM.floorY ? checker(p[2], p[1], 83, 0.1) : null;
    });
  } else if (d[0] > 0) {
    consider((ROOM.rightX - o[0]) / d[0], (t) => {
      const p = at(t);
      return checker(p[2], p[1], 97, 0.24);
    });
    consider((T.x0 - o[0]) / d[0], (t) => {
      const p = at(t);
      return p[2] > T.z0 && p[2] < T.z1 && p[1] > T.top && p[1] < ROOM.floorY ? checker(p[2], p[1], 101, 0.1) : null;
    });
  }
  return value;
}

/** Fill one luma plane for frame `k`. */
export function renderRoomFrame(y, width, height, k, frames) {
  const f = (0.5 * Math.max(width, height)) / Math.tan(((FOV_LONG_EDGE_DEG / 2) * Math.PI) / 180);
  const cx = width / 2;
  const cyy = height / 2;
  const { rotation: r, center } = cameraAt(k, frames);
  const offsets = [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]];
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      let sum = 0;
      for (const [du, dv] of offsets) {
        const xc = (u + 0.5 + du - cx) / f;
        const yc = (v + 0.5 + dv - cyy) / f;
        // Room-frame direction: Rᵀ · (xc, yc, 1).
        const d = [
          r[0] * xc + r[3] * yc + r[6],
          r[1] * xc + r[4] * yc + r[7],
          r[2] * xc + r[5] * yc + r[8],
        ];
        sum += shade(center, d);
      }
      y[v * width + u] = Math.max(0, Math.min(255, Math.round(sum / 4)));
    }
  }
}

/**
 * What the phone's orientation sensor would report for this camera, held in portrait.
 *
 * Pitch down by θ from upright means `beta = 90° − θ`; there is no roll, so `gamma = 0`. Constant
 * over the run, for the reason in the header.
 */
export function orientationReading() {
  return { beta: 90 - PITCH_DEG, gamma: 0 };
}

/** `accelerationIncludingGravity` in the W3C convention (the reaction, pointing up), for that pose. */
export function accelerationReading() {
  const b = ((90 - PITCH_DEG) * Math.PI) / 180;
  // up_device = (−sinγ·cosβ, sinβ, cosγ·cosβ) with γ = 0
  return { x: 0, y: 9.81 * Math.sin(b), z: 9.81 * Math.cos(b) };
}

/*
 * The rough feed: the same room, with the camera's view wiped out for a moment every few seconds.
 *
 * On a phone in a hand, tracks break — a whip of the wrist blurs a frame to nothing, a light comes
 * into view and the exposure jumps. Every point the tracker followed is lost at once, and the
 * points it finds afterwards are new ones with new ids. The smooth feed never does this, and the
 * first device run reported `TRACKING LOST` within seconds of every start while the smooth feed
 * localized 96 % of its frames. This feed is how that is reproduced on the desktop.
 */

/** A dropout starts this many frames apart (four seconds at 30 fps)... */
export const DROPOUT_EVERY = 120;
/** ...and lasts this many: about a quarter of a second, long enough for a 6 fps worker to see it. */
export const DROPOUT_FRAMES = 8;

export function isDropout(k) {
  const m = k % DROPOUT_EVERY;
  return m >= DROPOUT_EVERY / 2 && m < DROPOUT_EVERY / 2 + DROPOUT_FRAMES;
}

/** `renderRoomFrame`, with nothing trackable in the dropout frames. */
export function renderRoughRoomFrame(y, width, height, k, frames) {
  if (isDropout(k)) {
    y.fill(118);
    return;
  }
  renderRoomFrame(y, width, height, k, frames);
}
