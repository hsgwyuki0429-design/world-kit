/**
 * The synthetic scene the geometry legs film, and the Y4M container they put it in.
 *
 * Phases 5, 6 and 7 all needed a textured scene with two depths in it, and all three carried
 * byte-identical copies of these four functions. They are here unchanged — **every pixel these
 * produce is the pixel the legs produced before**, which matters because the numbers in the
 * committed desktop bundles were measured on exactly this texture.
 *
 * ## Why this texture and not a smoother one
 *
 * The first version of the Phase 5 leg used a smoother field of the same shape at roughly a
 * third of these frequencies, on the reasoning that Phase 4 had been bitten by *too much*
 * high-frequency energy aliasing under box-halving. Measured against the real `FeatureDetector`
 * at level 1 it produced a mean gradient of **4.67 and zero corners** — below
 * `TEXTURE_RICH_FLOOR`, so the classifier called every frame AMBIGUOUS and GEO-001's
 * texture-rich class stayed empty.
 *
 * What made that run look healthy anyway is the more useful finding: its correspondences were
 * coming from the *moving depth edges* of the near layer, not from the scene. Six stripe
 * boundaries sweeping across the frame at 9.5 px per frame are strong, trackable corners — and
 * they are corners that belong to no surface. A two-view geometry measured on them is measuring
 * the fixture's own artefact. Removing the sweeping edges removed the population, which is how
 * the weakness surfaced at all.
 *
 * These frequencies are Phase 4's, whose leg tracked 210 points on this same 640×480 feed: mean
 * gradient 14.0 and 467 corners at level 1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Background texture. */
export const FAR_K = (2 * Math.PI) / 128;
export function farLuma(x, y) {
  const v =
    128 +
    46 * Math.sin(FAR_K * x) * Math.cos(y * 0.031 + 0.3) +
    32 * Math.sin(3 * FAR_K * x + y * 0.047) +
    26 * Math.cos(5 * FAR_K * x - y * 0.019 + 1.1) +
    20 * Math.sin(11 * FAR_K * x + 0.7) * Math.sin(y * 0.11) +
    14 * Math.cos(21 * FAR_K * x + y * 0.19);
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Foreground texture: the same construction at a different period and different phases.
 *
 * Different so that a foreground corner is not a background corner — if the two layers shared a
 * texture, a point could be matched across the depth boundary and the disparity that makes this
 * scene non-planar would be smeared by mismatches.
 */
export const NEAR_K = (2 * Math.PI) / 96;
export function nearLuma(x, y) {
  const v =
    132 +
    46 * Math.cos(NEAR_K * x + 1.9) * Math.sin(y * 0.043 - 0.6) +
    32 * Math.cos(3 * NEAR_K * x - y * 0.053 + 2.4) +
    26 * Math.sin(5 * NEAR_K * x + y * 0.023 - 0.8) +
    20 * Math.cos(11 * NEAR_K * x - 1.3) * Math.cos(y * 0.097) +
    14 * Math.sin(21 * NEAR_K * x - y * 0.17);
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** A smooth field. Not dark — a dark frame is Phase 4's occlusion, which is a different thing. */
export function blankLuma(x, y) {
  return Math.max(0, Math.min(255, Math.round(122 + 7 * Math.sin(x * 0.004) + 5 * Math.cos(y * 0.005))));
}

/**
 * Is this pixel on the near layer?
 *
 * One boundary, fixed in image coordinates: the left `coverage` of the frame shows the near
 * layer, the rest the far one. A depth edge is where points are occluded and revealed, and the
 * first version of the Phase 5 leg put the edges *in the near layer's own coordinates* so that
 * they swept across the frame at the near layer's speed — six boundaries at 9.5 px per frame,
 * each destroying the tracks in the band it crossed. The near layer's points then died faster
 * than an anchor lived, and the two models' inlier counts came out five apart where the geometry
 * says forty.
 *
 * With one stationary edge only the points that cross it are lost, which over an anchor's life
 * is the near-layer points within about 90 px of it. That is a real occlusion and the tracker
 * should survive it; six sweeping ones were a fixture that measured its own churn.
 */
export function isNear(x, width, coverage) {
  if (coverage <= 0) return false;
  return x < width * coverage;
}

/**
 * Write a 30 fps 4:2:0 Y4M file, one luma plane per frame, chroma flat.
 *
 * `frame(y, width, height, index)` fills the supplied buffer. Flat chroma is what makes this a
 * greyscale feed, which is all the pipeline reads — it converts to luma on acquisition, so
 * colour here would be discarded and would only cost bandwidth through the fake camera.
 */
export function writeY4M(path, { width, height, frames, frame }) {
  const header = Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const tag = Buffer.from('FRAME\n', 'ascii');
  const u = Buffer.alloc((width / 2) * (height / 2), 128);
  const v = Buffer.alloc((width / 2) * (height / 2), 128);

  const parts = [header];
  for (let i = 0; i < frames; i++) {
    const y = Buffer.alloc(width * height);
    frame(y, width, height, i);
    parts.push(tag, y, u, v);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat(parts));
  return { frames, megabytes: Math.round((frames * width * height * 1.5) / 1e5) / 10 };
}
