#!/usr/bin/env node
/**
 * Phase 5 DESKTOP_DEV leg — geometric verification (v3 §14, §16, §66).
 *
 * ## What this leg can decide
 *
 * Phase 4's leg generated its own camera feed because §65's conditions are about *motion*, and
 * motion is something a video file can contain exactly. Phase 5's conditions are about
 * *geometry*, and geometry is something a video file can contain exactly too — with one extra
 * requirement that a single panning texture cannot meet.
 *
 * A pan of one flat texture is a planar scene. A homography explains it perfectly, so v3 §16's
 * comparison always answers PLANAR and GEO-004's other half never occurs. So this feed has two
 * depth layers: a background that pans slowly and a foreground that pans **4.5 times faster in
 * the same direction**, which is exactly what a camera translating parallel to two
 * fronto-parallel planes produces. Both layers' displacements stay parallel to one direction —
 * so a fundamental matrix explains them both — while no single homography can match two
 * different disparities. That is a non-planar scene in the only sense this phase can measure.
 *
 * The blank segment is the third condition: a smooth low-gradient field, classified
 * TEXTURE_POOR by the same statistic Phase 3 used, on which the population collapses and there
 * is nothing to verify. GEO-002 asks that the phase say so.
 *
 * That makes the gate this phase exists for decidable off the device:
 *
 *   > handed a correspondence set with 30% of its targets displaced 25 px by the harness and
 *   > no marking of which, does the verifier reject the harness's own outliers?
 *
 * A verifier that returns every correspondence as an inlier scores exactly 0.00 there while
 * scoring a *perfect* 1.00 inlier ratio on every count-based criterion v3 §14 names, and this
 * leg fails it. `tests/unit/verification.test.ts` proves the same thing in Node against the
 * same `VerificationStage`; this proves it through the real
 * `video → VideoFrame → worker → pyramid → tracker → RANSAC` path.
 *
 * ## What it still cannot decide
 *
 *  - **Rule 004 stands.** This is `DESKTOP_DEV`; nothing here passes a phase. What it does is
 *    catch a regression in the solvers, the state derivation or the harness on every build.
 *  - **GEO-005** measures this machine against a budget written for the iPhone, exactly as
 *    FLOW-006 and FEAT-005 did. Its verdict is printed and a separate, explicitly wider
 *    configuration tripwire gates instead — see GEO_COST_CEILING_MS.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase5', 'evidence');
const CHROMIUM = '/opt/pw-browsers/chromium';
const VIDEO = join(ROOT, 'node_modules', '.cache', 'parallax-scene.y4m');

/** Long enough for the loop to run several times over, and for each anchor to live and die. */
const VERIFY_MS = 40_000;

const W = 640;
const H = 480;

/**
 * The camera's motion, per source frame, in level-0 pixels.
 *
 * One direction, two speeds. A real camera translating sideways moves every image point along
 * a line through the focus of expansion, at a rate inversely proportional to that point's
 * depth — so two planes at different depths give two *speeds along one direction*, never two
 * directions. Getting that wrong would produce a scene no camera motion can generate, and a
 * fundamental matrix would then fail to fit it for a reason that has nothing to do with the
 * solver.
 */
const DIRECTION = { x: 2.0, y: 0.7 };
/** The foreground is 3.5× nearer in effect: same direction, 3.5× the disparity. */
const NEAR_FACTOR = 3.5;

const SEGMENTS = [
  // A single layer: one plane, and a homography explains it exactly. GEO-004's planar half.
  { name: 'planar', frames: 96, near: 0, speed: 1.5, blank: false },
  // Two layers: the near one moves 3.5× as far per frame. No homography fits both. GEO-004's
  // non-planar half, and the only segment where the fundamental matrix is the better model.
  { name: 'parallax', frames: 120, near: 0.5, speed: 1.0, blank: false },
  // A smooth field: mean gradient near zero, so the classifier calls it TEXTURE_POOR, the
  // population collapses, and there is nothing to verify. GEO-002.
  { name: 'blank', frames: 48, near: 0, speed: 1.5, blank: true },
];

/**
 * The cost above which this leg calls a regression — NOT GEO-005's criterion.
 *
 * GEO-005 gates on §H's 6 ms budget for RANSAC on the iPhone. This runs on headless Chromium
 * with SwiftShader on a shared CPU, so a cost measured here says nothing about whether the
 * device meets that budget — the same distinction §H.4 draws, and the same one Phase 3's and
 * Phase 4's legs made for FEAT-005 and FLOW-006. The number below is a configuration tripwire:
 * far enough above the observed spread to survive machine variance, and far enough below what
 * a genuine configuration error costs (a RANSAC that stopped terminating adaptively and always
 * ran its 500-iteration cap, or a fitter re-normalising the whole point set per sample) to
 * catch it. Both models are fitted on every judged frame either way — v3 §16 is not skipped to
 * save time.
 */
const GEO_COST_CEILING_MS = 60.0;

/* -------------------------------------------------------------------------- */
/* The feed                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Background texture — Phase 4's leg texture, reused rather than reinvented.
 *
 * The first version of this leg used a smoother field of the same shape at roughly a third of
 * these frequencies, on the reasoning that Phase 4 had been bitten by *too much* high-frequency
 * energy aliasing under box-halving. Measured against the real `FeatureDetector` at level 1 it
 * produced a mean gradient of **4.67 and zero corners** — below `TEXTURE_RICH_FLOOR`, so the
 * classifier called every frame AMBIGUOUS and GEO-001's texture-rich class stayed empty.
 *
 * What made the first run look healthy anyway is worth writing down, because it is the more
 * useful finding: its correspondences were coming from the *moving depth edges* of the near
 * layer, not from the scene. Six stripe boundaries sweeping across the frame at 9.5 px per
 * frame are strong, trackable corners — and they are corners that belong to no surface. A
 * two-view geometry measured on them is measuring the fixture's own artefact. Removing the
 * sweeping edges removed the population, which is how the weakness surfaced at all.
 *
 * The frequencies below are Phase 4's, whose leg tracked 210 points on this same 640×480 feed:
 * mean gradient 14.0 and 467 corners at level 1.
 */
const FAR_K = (2 * Math.PI) / 128;
function farLuma(x, y) {
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
const NEAR_K = (2 * Math.PI) / 96;
function nearLuma(x, y) {
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
function blankLuma(x, y) {
  return Math.max(0, Math.min(255, Math.round(122 + 7 * Math.sin(x * 0.004) + 5 * Math.cos(y * 0.005))));
}

/**
 * Is this pixel on the near layer?
 *
 * One boundary, fixed in image coordinates: the left `coverage` of the frame shows the near
 * layer, the rest the far one. A depth edge is where points are occluded and revealed, and the
 * first version of this leg put the edges *in the near layer's own coordinates* so that they
 * swept across the frame at the near layer's speed — six boundaries at 9.5 px per frame, each
 * destroying the tracks in the band it crossed. The near layer's points then died faster than
 * an anchor lived, the non-planar signal was carried by whatever few survived, and the two
 * models' inlier counts came out five apart where the geometry says forty.
 *
 * With one stationary edge only the points that cross it are lost, which over an anchor's life
 * is the near-layer points within about 90 px of it. That is a real occlusion and the tracker
 * should survive it; six sweeping ones were a fixture that measured its own churn.
 */
function isNear(x, coverage) {
  if (coverage <= 0) return false;
  return x < W * coverage;
}

function buildY4M() {
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420mpeg2\n`, 'ascii');
  const frameTag = Buffer.from('FRAME\n', 'ascii');
  const u = Buffer.alloc((W / 2) * (H / 2), 128);
  const v = Buffer.alloc((W / 2) * (H / 2), 128);

  const parts = [header];
  let farX = 0;
  let farY = 0;
  let count = 0;
  for (const seg of SEGMENTS) {
    for (let f = 0; f < seg.frames; f++) {
      const y = Buffer.alloc(W * H);
      const nearX = farX * NEAR_FACTOR;
      const nearY = farY * NEAR_FACTOR;
      for (let yy = 0; yy < H; yy++) {
        const row = yy * W;
        for (let xx = 0; xx < W; xx++) {
          if (seg.blank) {
            y[row + xx] = blankLuma(xx + farX, yy + farY);
          } else if (isNear(xx, seg.near)) {
            y[row + xx] = nearLuma(xx + nearX, yy + nearY);
          } else {
            y[row + xx] = farLuma(xx + farX, yy + farY);
          }
        }
      }
      parts.push(frameTag, y, u, v);
      farX += DIRECTION.x * seg.speed;
      farY += DIRECTION.y * seg.speed;
      count++;
    }
  }
  mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });
  writeFileSync(VIDEO, Buffer.concat(parts));
  const mb = Math.round((count * W * H * 1.5) / 1e5) / 10;
  console.log(
    `[p5] wrote ${W}x${H}, ${count} frames (${mb} MB): ` +
      SEGMENTS.map((s) => `${s.frames}× ${s.name}`).join(', '),
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
console.log('[p5] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p5] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
/** Tests this leg cannot decide, each with the reason that applies to it specifically. */
const excluded = new Map();

const browser = await chromium.launch({
  executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${VIDEO}`,
  ],
});

let snap;
const errors = [];

try {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await page.evaluate(() => window.__SPATIAL_READY__))) throw new Error('app failed to start');
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  // Take the device's path, all the way. On a phone Phase 5 is reached from a TRACKING screen
  // whose optical flow is running over a detector that is running over a pipeline that is
  // running — all three have to be, because that is how Phase 4 passes — so this screen
  // inherits three live stages. Entering cold exercises a sequence no device ever takes, and
  // §H.5 records at length what that cost two Phase 3 device runs.
  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase2(true)))) {
    throw new Error('could not enter Phase 2 even with the desktop override');
  }
  await page.evaluate(() => window.__SPATIAL_DEBUG__.startPipeline());
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getPipelineStats().completed > 30, undefined, {
    timeout: 25_000,
  });

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase3(true)))) {
    throw new Error('could not enter Phase 3 even with the desktop override');
  }
  await page.waitForSelector('#start-detection', { timeout: 10_000 });
  await page.click('#start-detection');
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getTrackingStats().detections > 5, undefined, {
    timeout: 25_000,
  });

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase4(true)))) {
    throw new Error('could not enter Phase 4 even with the desktop override');
  }
  await page.waitForSelector('#start-tracking', { timeout: 10_000 });
  await page.click('#start-tracking');
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getFlowStats().flowFrames > 5, undefined, {
    timeout: 25_000,
  });

  // Phase Lock, on the control a person would use. Phase 4 cannot pass on this leg (Rule 004),
  // so the door to Phase 5 must be shut and must say why.
  const gate = await page.evaluate(() => {
    const b = document.getElementById('go-to-phase5');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (gate.disabled !== true || !String(gate.text).includes('LOCKED')) {
    throw new Error(
      'GO TO GEOMETRIC VERIFICATION should be locked on this leg — Phase 4 is TESTING, not ' +
        `PASSED — but it reads ${JSON.stringify(gate.text)} (disabled ${gate.disabled}). Rule 005.`,
    );
  }
  console.log(`[p5] Phase Lock holds: ${gate.text}`);

  const handover = await page.evaluate(() => ({
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    flow: window.__SPATIAL_DEBUG__.getFlowStats(),
  }));
  console.log(
    `[p5] handing over ${handover.pipeline.completed} preprocessed frames, ` +
      `${handover.flow.flowFrames} flow frames, ${handover.flow.total} tracked points, ` +
      `tier ${handover.pipeline.tierLabel}`,
  );

  const entered = await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase5(true));
  if (!entered) throw new Error('could not enter Phase 5 even with the desktop override');

  // Press the control a person presses. There is deliberately no `startVerification()` in the
  // debug API: reaching past the DOM is how Phase 3's leg twice certified a screen whose
  // button had become unpressable while the engine behind it answered perfectly well (§H.5).
  await page.waitForSelector('#start-verification', { timeout: 10_000 });
  const before = await page.evaluate(() => {
    const b = document.getElementById('start-verification');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (before.disabled !== false || before.text !== 'START VERIFICATION') {
    throw new Error(
      `START VERIFICATION is not pressable on arrival: label ${JSON.stringify(before.text)}, ` +
        `disabled ${before.disabled}. Phase 5 arrives over a live camera, a live pipeline, a ` +
        'live detector and a live tracker — a control derived from any of those is already ' +
        'pressed, and a person could not start the run at all (Rule 002, §H.5)',
    );
  }
  await page.click('#start-verification');

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getVerificationStats().verifiedFrames > 0,
    undefined,
    { timeout: 25_000 },
  );

  const after = await page.evaluate(() => {
    const b = document.getElementById('start-verification');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (after.text !== 'VERIFYING' || after.disabled !== true) {
    throw new Error(
      `verification is running but the control says ${JSON.stringify(after.text)} ` +
        `(disabled ${after.disabled}) — the control and the engine disagree (Rule 002)`,
    );
  }

  console.log(`[p5] holding for ${VERIFY_MS / 1000} s…`);
  await page.waitForTimeout(VERIFY_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase5Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase5EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getVerificationStats(),
    flow: window.__SPATIAL_DEBUG__.getFlowStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase5State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    alignment: window.__SPATIAL_DEBUG__.getOverlayAlignment(),
  }));

  writeFileSync(join(OUT_DIR, 'phase5-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase5-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p5] ${s.verifiedFrames} verified frames, ${s.judgedFrames} judged; ` +
      `${s.reAnchors} re-anchor(s); states ${JSON.stringify(s.stateFrames)}`,
  );
  console.log(
    `[p5] median ${s.medianInliers} inliers of ${s.medianCorrespondences} correspondences ` +
      `(ratio ${s.medianInlierRatio}), baseline ${s.medianBaselinePx} px, spread ` +
      `${s.medianSpreadPx} px`,
  );
  const cls = (c) => `${c.frames} frames (${c.judged} judged, ${c.medianCorrespondences} corr)`;
  console.log(`[p5] texture: rich ${cls(s.textureRich)}, poor ${cls(s.texturePoor)}`);
  console.log(
    `[p5] v3 §16: ${s.bothModelsFitted} frames with both models — ${s.planarFrames} planar, ` +
      `${s.nonPlanarFrames} non-planar; median F ${s.medianFundamentalInliers} vs H ` +
      `${s.medianHomographyInliers}; ${s.planarMismatches} mismatch(es)`,
  );
  console.log(
    `[p5] GEO-003: ${s.injectionSamples} injected frames, ` +
      `${Math.round(s.medianInjectedRecall * 1000) / 10}% of injected outliers rejected vs ` +
      `${Math.round(s.medianCleanRejection * 1000) / 10}% of untouched, ` +
      `${s.medianSurvivingInliers} inliers surviving`,
  );
  console.log(
    `[p5] cost: ${s.meanVerifyMs} ms over ${s.verifyCostSamples} frames, ` +
      `${s.cappedFrames} at the iteration cap, tier ${snap.pipeline.tierLabel}`,
  );
  console.log(
    `[p5] integrity: ${s.stateMismatches} state mismatch(es), ${s.partitionFaults} partition ` +
      `fault(s), ${s.modelWithoutVerdict} model(s) on an unverified frame, ` +
      `${s.degenerateFrames} degenerate frame(s)`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase5());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 5 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p5] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

// Any condition the synthetic feed did not actually produce is excluded with its own count,
// rather than the leg pretending the condition occurred. The fake camera plays the generated
// file at its own rate while the pipeline samples at its own, so a segment can be sampled away.
if (s.texturePoor.frames < 15) {
  excluded.set(
    'GEO-002',
    `the feed produced only ${s.texturePoor.frames} frames the classifier called TEXTURE_POOR ` +
      '— the blank segment was sampled away',
  );
}
if (s.planarFrames === 0 || s.nonPlanarFrames === 0) {
  excluded.set(
    'GEO-004',
    `the run recorded ${s.planarFrames} planar and ${s.nonPlanarFrames} non-planar frames, so ` +
      'one half of v3 §16’s comparison never occurred',
  );
}

// GEO-005's own verdict stays printed above and stays in the bundle; it is simply not this
// leg's to decide, for the reason given at GEO_COST_CEILING_MS.
excluded.set(
  'GEO-005',
  `it gates on §H's 6 ms budget for RANSAC on the iPhone, and this is headless Chromium with ` +
    `SwiftShader on a shared CPU — ${s.meanVerifyMs} ms here measures this machine, not the ` +
    'device. The device run decides it',
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p5] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p5]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p5] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p5] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns, each with its own name and its own number   */
/* ------------------------------------------------------------------ */

// Rule 002, in one line: the screen reports VERIFYING from the same predicate this reads, so a
// run that claims to be verifying and has verified nothing is the UI and the engine disagreeing.
if (s.running && s.verifiedFrames === 0) {
  console.error(
    `[p5] the screen reported VERIFYING for the whole ${VERIFY_MS / 1000} s hold and ` +
      'verification ran on 0 frames — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// The anti-fake gate, as a tripwire the leg states in its own terms rather than inheriting
// GEO-003's verdict. This is the whole reason the harness corrupts a copy of the set: every
// other number in this phase is produced *perfectly* by a stage that accepts everything.
if (s.injectionSamples < 10) {
  console.error(
    `[p5] only ${s.injectionSamples} injected frames — the feed moves and is textured by ` +
      'design, so too few means the injection is not reaching the verifier and the gate is ' +
      'not armed',
  );
  exitCode = 1;
} else if (s.medianInjectedRecall < 0.9) {
  console.error(
    `[p5] the verifier rejected ${Math.round(s.medianInjectedRecall * 1000) / 10}% of ` +
      `correspondences the harness had displaced 25 px — sixteen times the 1.5 px inlier ` +
      'threshold, so they are outliers by construction. This is the signature of a stage that ' +
      'returns its input, and no statistic computed from its own output would show it',
  );
  exitCode = 1;
} else if (s.medianCleanRejection > 0.3) {
  console.error(
    `[p5] the verifier also rejected ${Math.round(s.medianCleanRejection * 1000) / 10}% of the ` +
      'correspondences the harness left alone — it is rejecting wholesale, not discriminating, ' +
      'and a recall measured against that means nothing',
  );
  exitCode = 1;
} else {
  console.log(
    `[p5] anti-fake gate armed and passed: ` +
      `${Math.round(s.medianInjectedRecall * 1000) / 10}% of injected outliers rejected vs ` +
      `${Math.round(s.medianCleanRejection * 1000) / 10}% of untouched, over ` +
      `${s.injectionSamples} frames`,
  );
}

// v3 §16, as a tripwire in the leg's own terms: the feed contains one segment of each kind by
// construction, so a run that reports only one outcome is the comparison not being made.
if (s.bothModelsFitted >= 15 && (s.planarFrames === 0 || s.nonPlanarFrames === 0)) {
  console.error(
    `[p5] the feed alternates a single-layer pan (planar by construction) with a two-layer ` +
      `pan at ${NEAR_FACTOR}× disparity (which no homography fits), and the run recorded ` +
      `${s.planarFrames} planar / ${s.nonPlanarFrames} non-planar — v3 §16's comparison is ` +
      'not distinguishing them',
  );
  exitCode = 1;
} else if (s.planarFrames > 0 && s.nonPlanarFrames > 0) {
  console.log(
    `[p5] v3 §16 discriminates: ${s.planarFrames} planar, ${s.nonPlanarFrames} non-planar over ` +
      `${s.bothModelsFitted} frames with both models fitted`,
  );
}

// Rule 002 again, at frame granularity: v3 §14's state and v3 §16's flag are both re-derived
// from the numbers reported beside them, on every frame.
if (s.stateMismatches > 0) {
  console.error(
    `[p5] ${s.stateMismatches} frame(s) reported a v3 §14 state that disagreed with their own ` +
      'measured inputs (Rule 002)',
  );
  exitCode = 1;
}
if (s.planarMismatches > 0) {
  console.error(
    `[p5] ${s.planarMismatches} frame(s) carried a planar flag that does not follow from the ` +
      'two inlier counts beside it — v3 §16’s decision must be auditable, not asserted',
  );
  exitCode = 1;
}

// §80, on the one product this phase makes: a frame that verified nothing has no model.
if (s.modelWithoutVerdict > 0 || s.partitionFaults > 0) {
  console.error(
    `[p5] ${s.modelWithoutVerdict} frame(s) reported UNVERIFIED while carrying a model and ` +
      `${s.partitionFaults} frame(s) lost or duplicated a correspondence between the inlier ` +
      'and outlier sets (§80, GEO-006)',
  );
  exitCode = 1;
}

// The baseline floor is the reason this phase holds an anchor rather than verifying
// consecutive frames. A run where nothing ever cleared it verified nothing, however many
// frames it processed.
if (s.verifiedFrames > 0 && s.judgedFrames === 0) {
  console.error(
    `[p5] ${s.verifiedFrames} frames verified and none judged — nothing cleared the 20 ` +
      'correspondence / 15 px baseline floor, so every verdict in this run is UNVERIFIED and ' +
      'the anchor is not doing its job',
  );
  exitCode = 1;
}

// The overlay alignment probe carries over from Phase 3 (§H.5), and this leg cannot arm it for
// the same reason Phase 4's could not: a densely textured, repetitive pan scores every
// transform alike. `scripts/run-e2e-phase3-alignment.mjs` is the leg that decides orientation,
// with a fixture built for it. Reading a verdict out of an unarmed probe would be reading noise.
if (snap.alignment) {
  const armed = snap.alignment.measurable && snap.alignment.bestOverRandom >= 2.0;
  console.log(
    `[p5] overlay alignment: best ${snap.alignment.best}, identity/random ` +
      `${snap.alignment.identityOverRandom.toFixed(2)}x, best/random ` +
      `${snap.alignment.bestOverRandom.toFixed(2)}x — ` +
      (armed
        ? 'the probe had discrimination on this feed'
        : 'NOT ARMED on this feed; run-e2e-phase3-alignment.mjs is the leg that decides orientation'),
  );
  if (armed && snap.alignment.best !== 'identity') {
    console.error(
      `[p5] the probe had discrimination and still says the acquired buffer matches the video ` +
        `under ${snap.alignment.best} rather than identity — every correspondence in this run ` +
        'is a pair of positions in that buffer',
    );
    exitCode = 1;
  }
}

// The configuration tripwire that replaces GEO-005 on this leg.
if (s.meanVerifyMs > GEO_COST_CEILING_MS) {
  console.error(
    `[p5] RANSAC cost ${s.meanVerifyMs} ms at a median of ${s.medianCorrespondences} ` +
      `correspondences, over this leg's ${GEO_COST_CEILING_MS} ms regression ceiling — that is ` +
      'not budget variance, it is the shape of a RANSAC that stopped terminating adaptively',
  );
  exitCode = 1;
} else {
  console.log(
    `[p5] RANSAC ${s.meanVerifyMs} ms at ${s.medianCorrespondences} correspondences, under ` +
      `this leg's ${GEO_COST_CEILING_MS} ms regression ceiling (GEO-005's 6 ms budget is the ` +
      "device's to answer)",
  );
}

console.log(`[p5] evidence: ${OUT_DIR}`);
console.log(`[p5] exit ${exitCode}`);
process.exit(exitCode);
