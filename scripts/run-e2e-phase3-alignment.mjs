#!/usr/bin/env node
/**
 * Phase 3 overlay alignment leg — §51.
 *
 * The one thing no other check in this repository can establish: that a corner is drawn
 * where the image's corner actually is.
 *
 * Everything else is blind to it, and that is not an accident of coverage but of arithmetic:
 *
 *  - the detector's unit tests run on a Float32 image built in memory, so they never cross
 *    the video -> VideoFrame -> canvas -> getImageData -> pyramid path where an orientation
 *    error lives;
 *  - Phase 2's provenance cross-check compares the *mean* luma of the worker's grayscale
 *    against an independent read of the same frame. A mean is invariant to a rotation, a
 *    flip and a transpose — a scrambled buffer passes it perfectly;
 *  - FEAT-001's contrast statistic is computed inside the worker on the same buffer the
 *    detector used, so it scores just as well on a buffer that has nothing to do with what
 *    the camera is pointing at;
 *  - and the synthetic camera the other legs use is a smooth rolling gradient, which has no
 *    landmark whose position could disagree with anything.
 *
 * So this leg feeds Chromium a video file whose bright blocks sit at known, deliberately
 * asymmetric positions and asserts the detected corners land on them. The asymmetry is the
 * point: three blocks and one empty quadrant means a 90/180/270 rotation, a horizontal or
 * vertical flip, and a transpose each move the features somewhere the assertion notices.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase3', 'evidence');
const CHROMIUM = '/opt/pw-browsers/chromium';
const VIDEO = join(ROOT, 'node_modules', '.cache', 'alignment-pattern.y4m');

/**
 * Orientation is a parameter because the device's camera is portrait and rotates, and
 * landscape alone proved nothing about that: the first run of this leg passed 12/12 on a
 * 1280x720 pattern while the phone was drawing points nowhere near the image.
 */
const PORTRAIT = process.argv.includes('--portrait');
const W = PORTRAIT ? 720 : 1280;
const H = PORTRAIT ? 1280 : 720;

/**
 * Bright blocks on a dark field, at normalised centres. Asymmetric by construction:
 * the bottom-right quadrant is deliberately empty, so no rotation or reflection maps this
 * set onto itself.
 */
const BLOCKS = [
  { name: 'top-left', cx: 0.20, cy: 0.22, w: 0.10, h: 0.14 },
  { name: 'top-right', cx: 0.78, cy: 0.18, w: 0.08, h: 0.10 },
  { name: 'bottom-left', cx: 0.26, cy: 0.76, w: 0.12, h: 0.12 },
];
/** Nothing is drawn here; features landing in it are the signature of a flipped buffer. */
const EMPTY_QUADRANT = { x0: 0.55, y0: 0.55, x1: 1.0, y1: 1.0 };

/** How far from a block's edge a corner may sit and still count as "on" it. */
const TOLERANCE = 0.06;

function buildY4M() {
  const frames = 8;
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const y = Buffer.alloc(W * H, 20);
  for (const b of BLOCKS) {
    const x0 = Math.round((b.cx - b.w / 2) * W);
    const x1 = Math.round((b.cx + b.w / 2) * W);
    const y0 = Math.round((b.cy - b.h / 2) * H);
    const y1 = Math.round((b.cy + b.h / 2) * H);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) y[yy * W + xx] = 235;
    }
  }
  // Neutral chroma: the pattern is pure luma, which is what the grayscale pyramid reads.
  const u = Buffer.alloc((W / 2) * (H / 2), 128);
  const v = Buffer.alloc((W / 2) * (H / 2), 128);
  const frameTag = Buffer.from('FRAME\n', 'ascii');
  const parts = [header];
  for (let i = 0; i < frames; i++) parts.push(frameTag, y, u, v);
  mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(VIDEO, Buffer.concat(parts));
  console.log(
    `[align] wrote ${W}x${H} ${PORTRAIT ? 'PORTRAIT' : 'LANDSCAPE'} pattern, ` +
      `${BLOCKS.length} blocks, ${frames} frames`,
  );
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serve(dir) {
  return new Promise((res) => {
    const server = createServer((req, r) => {
      const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let f = join(dir, p === '/' ? 'index.html' : p);
      if (!existsSync(f)) f = join(dir, 'index.html');
      r.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
      createReadStream(f).pipe(r);
    });
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

buildY4M();
console.log('[align] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${VIDEO}`,
  ],
});

let exitCode = 0;
let report;

try {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await page.evaluate(() => window.__SPATIAL_READY__))) throw new Error('app failed to start');
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase2(true));
  await page.evaluate(() => window.__SPATIAL_DEBUG__.startPipeline());
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getPipelineStats().completed > 30, undefined, {
    timeout: 25_000,
  });
  await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase3(true));
  await page.waitForSelector('#start-detection');
  await page.click('#start-detection');
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getTrackingStats().detections > 5, undefined, {
    timeout: 25_000,
  });
  await page.waitForTimeout(3_000);

  report = await page.evaluate(() => ({
    overlay: window.__SPATIAL_DEBUG__.getOverlayPositions(),
    geometry: window.__SPATIAL_DEBUG__.getPreviewGeometry(),
    stats: window.__SPATIAL_DEBUG__.getTrackingStats(),
  }));
  await page.screenshot({
    path: join(OUT_DIR, `phase3-alignment-${PORTRAIT ? 'portrait' : 'landscape'}.png`),
    fullPage: true,
  });
  await page.evaluate(() => window.__SPATIAL_DEBUG__.stopDetection());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

const { overlay, geometry, stats } = report;
console.log(
  `\n[align] overlay space ${overlay.width}x${overlay.height}, ` +
    `${overlay.points.length / 3} point(s); detect ${stats.detectWidth}x${stats.detectHeight} ` +
    `at level ${stats.detectLevel}`,
);
console.log(`[align] video element ${JSON.stringify(geometry.video)}`);
console.log(`[align] video intrinsic ${JSON.stringify(geometry.videoIntrinsic)}`);
console.log(`[align] canvas element ${JSON.stringify(geometry.canvas)}`);
console.log(`[align] canvas internal ${JSON.stringify(geometry.canvasInternal)}`);

function fail(msg) {
  console.error(`[align] FAIL ${msg}`);
  exitCode = 1;
}

// 1. The canvas must cover exactly the same screen box as the video. If it does not, every
//    point is displaced by the difference no matter how correct the detection was.
const v = geometry.video;
const c = geometry.canvas;
if (!v || !c) {
  fail('the preview video or the overlay canvas is not in the DOM');
} else {
  const slack = 1.0;
  const dx = Math.abs(v.x - c.x);
  const dy = Math.abs(v.y - c.y);
  const dw = Math.abs(v.width - c.width);
  const dh = Math.abs(v.height - c.height);
  if (dx > slack || dy > slack || dw > slack || dh > slack) {
    fail(
      `the overlay canvas does not cover the video box: video ${v.width}x${v.height} at ` +
        `(${v.x}, ${v.y}), canvas ${c.width}x${c.height} at (${c.x}, ${c.y}) — ` +
        `offset by (${dx.toFixed(1)}, ${dy.toFixed(1)}), size differs by ` +
        `(${dw.toFixed(1)}, ${dh.toFixed(1)}) CSS px`,
    );
  } else {
    console.log('[align] PASS canvas and video occupy the same box');
  }
}

// 2. The canvas's internal aspect must match the video's intrinsic aspect, or the stretch
//    onto the shared box scales x and y differently and the points shear.
const vi = geometry.videoIntrinsic;
const ci = geometry.canvasInternal;
if (vi && ci && vi.width > 0 && ci.width > 0) {
  const va = vi.width / vi.height;
  const ca = ci.width / ci.height;
  const err = Math.abs(ca - va) / va;
  if (err > 0.02) {
    fail(
      `the overlay's coordinate space is ${ci.width}x${ci.height} (aspect ${ca.toFixed(3)}) ` +
        `while the video is ${vi.width}x${vi.height} (aspect ${va.toFixed(3)}) — ` +
        `${(err * 100).toFixed(1)}% apart, so the points are stretched against the image`,
    );
  } else {
    console.log(`[align] PASS overlay aspect ${ca.toFixed(3)} matches video ${va.toFixed(3)}`);
  }
}

// 3. The points themselves must sit on the blocks the video actually contains.
const n = Math.floor(overlay.points.length / 3);
if (n === 0) {
  fail('no overlay points to check');
} else if (!overlay.width || !overlay.height) {
  fail('the overlay has no coordinate space');
} else {
  const onBlock = new Map(BLOCKS.map((b) => [b.name, 0]));
  let stray = 0;
  let inEmpty = 0;
  for (let i = 0; i < n; i++) {
    const nx = overlay.points[i * 3] / overlay.width;
    const ny = overlay.points[i * 3 + 1] / overlay.height;
    let hit = null;
    for (const b of BLOCKS) {
      if (
        Math.abs(nx - b.cx) <= b.w / 2 + TOLERANCE &&
        Math.abs(ny - b.cy) <= b.h / 2 + TOLERANCE
      ) {
        hit = b.name;
        break;
      }
    }
    if (hit) onBlock.set(hit, onBlock.get(hit) + 1);
    else {
      stray++;
      if (
        nx >= EMPTY_QUADRANT.x0 && nx <= EMPTY_QUADRANT.x1 &&
        ny >= EMPTY_QUADRANT.y0 && ny <= EMPTY_QUADRANT.y1
      ) inEmpty++;
    }
  }
  const onAny = n - stray;
  console.log(
    `[align] ${onAny}/${n} point(s) on a block ` +
      `${JSON.stringify(Object.fromEntries(onBlock))}, ${stray} elsewhere, ` +
      `${inEmpty} in the empty quadrant`,
  );

  if (onAny / n < 0.7) {
    fail(
      `only ${((onAny / n) * 100).toFixed(1)}% of corners landed on the three blocks the ` +
        'video contains. The detector is finding structure somewhere the image has none, ' +
        'which is what a rotated, flipped or mis-scaled buffer looks like',
    );
  }
  for (const [name, hits] of onBlock) {
    if (hits === 0) {
      fail(`no corner landed on the ${name} block, which is the brightest thing in that part of the frame`);
    }
  }
  if (inEmpty / n > 0.1) {
    fail(
      `${inEmpty} of ${n} corners sit in the deliberately empty quadrant — the buffer is ` +
        'reflected or rotated relative to the image',
    );
  }
  if (exitCode === 0) console.log('[align] PASS corners land on the blocks the video contains');
}

console.log(`[align] exit ${exitCode}`);
process.exit(exitCode);
