#!/usr/bin/env node
/**
 * Phase 7 DESKTOP_DEV leg — IMU support / fusion (v3 §17, §18, §19, §68).
 *
 * ## This is the first leg in the project that decides a required test
 *
 * Every leg before it was short of the instrument its phase was scored against, and said so.
 * Phase 4's had no gyroscope for FLOW-003; Phase 5's could decide GEO-003 but nothing about a
 * real scene; Phase 6's could not decide POSE-002 at all. Phase 7 inverts that, because v3 §68's
 * pass condition for this phase is unusual among the per-phase tables in being about **absence**:
 *
 * > PASS条件：**IMU unavailableでもVision-only modeで継続可能。**
 *
 * Headless Chromium has no accelerometer and no gyroscope. That is not this leg's limitation —
 * **it is the condition the spec asks the phase to handle**, and it is permanently the case
 * here. So IMU-002 is decided every build, on the real screen, through the real control, and
 * the rest report PENDING with the sensor named.
 *
 * Rule 004 is untouched: this is `DESKTOP_DEV` and nothing here passes a phase. What the leg
 * gives is the one required record that can be checked on every commit rather than once, on a
 * phone, by hand.
 *
 * ## What it checks, beyond the verdict
 *
 *  - **The mode is `VISION_ONLY` on every frame**, and never `FUSED`. A fusion that reported a
 *    fused state with nothing to fuse would be inventing filter state from absent sensors.
 *  - **The bias is `null`, not `0`.** An unmeasured quantity is absent; a zero is a claim that
 *    it was estimated and found to be nothing. This is the shape of §80's prohibition applied to
 *    a number rather than to a verdict.
 *  - **`imuConsistency` is withheld by name.** v3 §19 lists it, this run cannot measure it, and
 *    a term scored 1 because nothing disagreed would be the fourth fake the plan names.
 *  - **Phase 6 keeps running unchanged underneath.** IMU-002's fifth criterion. The leg records
 *    Phase 6's own figures before fusion starts and again after the hold, and checks the pose
 *    is still being recovered at the same rate and to the same numbers.
 *  - **No position, no scale, no Euler triple**, on every record. IMU-006 and IMU-009 do not
 *    need a sensor, so this leg decides them too.
 *
 * ## The feed
 *
 * A two-layer parallax pan and nothing else. Phase 7 does not care what kind of scene it is —
 * it needs Phase 6 to be *recovering poses*, so that "vision alone" is a live state rather than
 * a stalled one. A run where nothing was recovered would satisfy `VISION_ONLY` trivially and
 * prove nothing about continuing on vision.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase7', 'evidence');
const CHROMIUM = '/opt/pw-browsers/chromium';
const VIDEO = join(ROOT, 'node_modules', '.cache', 'fusion-motion.y4m');

/** Long enough for several anchors to live and die under a fusion that has nothing to fuse. */
const FUSE_MS = 30_000;

const W = 640;
const H = 480;

/** One direction, two speeds — a camera translating past two depths. Phase 6's leg, verbatim. */
const DIRECTION = { x: 2.0, y: 0.7 };
const NEAR_FACTOR = 3.5;
const SEGMENTS = [
  { name: 'parallax-pan', frames: 240, near: 0.5, speed: 1.0 },
];

/** Phase 4's leg texture, reused: mean gradient 14.0 and 467 corners at level 1 on this feed. */
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

/** A different period and different phases, so a foreground corner is not a background corner. */
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

/** One boundary, fixed in image coordinates — see the note in Phase 6's leg about sweeping edges. */
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
          y[row + xx] = isNear(xx, seg.near)
            ? nearLuma(xx + nearX, yy + nearY)
            : farLuma(xx + farX, yy + farY);
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
  console.log(`[p7] wrote ${W}x${H}, ${count} frames (${mb} MB): parallax pan`);
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
console.log('[p7] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p7] serving ${url}`);
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
let poseBefore;
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

  // Take the device's path, all the way. On a phone Phase 7 is reached from a RELATIVE POSE
  // screen with six live stages behind it, because that is how Phase 6 passes. Entering cold
  // exercises a sequence no device ever takes, and §H.5 records at length what that cost two
  // Phase 3 device runs.
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

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase5(true)))) {
    throw new Error('could not enter Phase 5 even with the desktop override');
  }
  await page.waitForSelector('#start-verification', { timeout: 10_000 });
  await page.click('#start-verification');
  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getVerificationStats().verifiedFrames > 3,
    undefined,
    { timeout: 25_000 },
  );

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase6(true)))) {
    throw new Error('could not enter Phase 6 even with the desktop override');
  }
  await page.waitForSelector('#start-pose', { timeout: 10_000 });
  await page.click('#start-pose');
  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getPoseStats().poseFrames > 0,
    undefined,
    { timeout: 25_000 },
  );

  // Phase Lock, on the control a person would use. Phase 6 cannot pass on this leg (Rule 004),
  // so the door to Phase 7 must be shut and must say why.
  const gate = await page.evaluate(() => {
    const b = document.getElementById('go-to-phase7');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (gate.disabled !== true || !String(gate.text).includes('LOCKED')) {
    throw new Error(
      'GO TO IMU SUPPORT / FUSION should be locked on this leg — Phase 6 is TESTING, not ' +
        `PASSED — but it reads ${JSON.stringify(gate.text)} (disabled ${gate.disabled}). Rule 005.`,
    );
  }
  console.log(`[p7] Phase Lock holds: ${gate.text}`);

  // IMU-002's fifth criterion needs a *before*: Phase 6's own figures with Phase 7 not running
  // at all. Taken here, compared after the hold.
  poseBefore = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPoseStats());
  console.log(
    `[p7] handing over ${poseBefore.poseFrames} pose frames, median rotation ` +
      `${poseBefore.medianRotationDeg}°, ${poseBefore.posedFrames} with a full pose`,
  );

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase7(true)))) {
    throw new Error('could not enter Phase 7 even with the desktop override');
  }

  // Press the control a person presses. There is deliberately no `startFusion()` in the debug
  // API: reaching past the DOM is how Phase 3's leg twice certified a screen whose button had
  // become unpressable while the engine behind it answered perfectly well (§H.5).
  await page.waitForSelector('#start-fusion', { timeout: 10_000 });
  const before = await page.evaluate(() => {
    const b = document.getElementById('start-fusion');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (before.disabled !== false || before.text !== 'START FUSION') {
    throw new Error(
      `START FUSION is not pressable on arrival: label ${JSON.stringify(before.text)}, ` +
        `disabled ${before.disabled}. Phase 7 arrives over six live stages — camera, pipeline, ` +
        'detector, tracker, verifier and pose — so a control derived from any of them is ' +
        'already pressed, and a person could not start the run at all (Rule 002, §H.5)',
    );
  }
  await page.click('#start-fusion');

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getFusionStats().fusionFrames > 0,
    undefined,
    { timeout: 25_000 },
  );

  const after = await page.evaluate(() => {
    const b = document.getElementById('start-fusion');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (after.text !== 'FUSING' || after.disabled !== true) {
    throw new Error(
      `fusion is running but the control says ${JSON.stringify(after.text)} ` +
        `(disabled ${after.disabled}) — the control and the engine disagree (Rule 002)`,
    );
  }

  console.log(`[p7] holding for ${FUSE_MS / 1000} s…`);
  await page.waitForTimeout(FUSE_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase7Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase7EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getFusionStats(),
    pose: window.__SPATIAL_DEBUG__.getPoseStats(),
    verification: window.__SPATIAL_DEBUG__.getVerificationStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase7State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
  }));

  writeFileSync(join(OUT_DIR, 'phase7-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase7-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p7] ${s.fusionFrames} fused frames; modes ${JSON.stringify(s.modeFrames)}; ` +
      `IMU ${s.imuAvailable ? 'delivering' : 'not available'}${s.imuReason ? ` — ${s.imuReason}` : ''}`,
  );
  console.log(
    `[p7] bias ${s.gyroBiasDps === null ? 'null (absent, not zero)' : JSON.stringify(s.gyroBiasDps)}; ` +
      `imuConsistency ${s.imuConsistency === -1 ? 'WITHHELD' : s.imuConsistency}; ` +
      `${s.confidenceWithheld.length} term(s) withheld by name`,
  );
  console.log(
    `[p7] position ${s.position === null ? 'null' : JSON.stringify(s.position)}, scale ${s.scale}, ` +
      `heading ${s.heading}; ${s.positionsReported} record(s) with a position, ` +
      `${s.scaleViolations} scale violation(s), ${s.eulerEmitted} Euler triple(s)`,
  );
  console.log(
    `[p7] sensors: ` +
      s.sensors.map((c) => `${c.name} ${c.arriving ? 'ARRIVING' : 'ABSENT'}`).join(', '),
  );
  console.log(
    `[p7] integrity: ${s.modeMismatches} mode mismatch(es), ${s.rateOutOfRange} rate(s) outside ` +
      `0..1, ${s.confidenceAboveWorstTerm} confidence(s) above their own worst term, ` +
      `${s.biasZeroWithoutGyro} bias(es) reported with no gyroscope`,
  );
  console.log(
    `[p7] Phase 6 underneath: ${poseBefore.poseFrames} → ${snap.pose.poseFrames} pose frames, ` +
      `median rotation ${poseBefore.medianRotationDeg}° → ${snap.pose.medianRotationDeg}°`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase7());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 7 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p7] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

// Everything that needs a sensor. Headless Chromium has none, which is not a limitation of this
// leg so much as the subject of the phase — see the header. Each is named individually rather
// than swept up together, so a future build that acquires a sensor loses the exclusion for that
// record alone.
for (const id of ['IMU-001', 'IMU-003', 'IMU-004', 'IMU-005', 'IMU-007']) {
  excluded.set(
    id,
    `headless Chromium delivers no devicemotion events (${s.imuReason || 'no IMU'}), and this ` +
      'record is about what the fusion does with the sensors. The device decides it',
  );
}
// IMU-008 measures this machine against a budget written for the iPhone, exactly as GEO-005,
// FLOW-006 and POSE-006 did — and with no IMU there is barely a filter running to measure.
excluded.set(
  'IMU-008',
  `it gates on a ${1.0} ms ceiling on the device, and this is headless Chromium on a shared ` +
    `CPU with no sensors — ${s.meanFusionMs} ms here measures this machine's vision-only path`,
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p7] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p7]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p7] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p7] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns, each with its own name and its own number   */
/* ------------------------------------------------------------------ */

// Rule 002, in one line: the screen reports FUSING from the same predicate this reads.
if (s.running && s.fusionFrames === 0) {
  console.error(
    `[p7] the screen reported FUSING for the whole ${FUSE_MS / 1000} s hold and the fusion ran ` +
      'on 0 frames — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// **The record this leg exists for.** v3 §68's pass condition, checked on the numbers rather
// than taken from IMU-002's verdict, so a change to the test and a change to the engine cannot
// both slip through together.
const fusedFrames = (s.modeFrames.FUSED ?? 0) + (s.modeFrames.DEAD_RECKONING ?? 0);
if (s.imuAvailable) {
  console.error(
    `[p7] the IMU is reporting on a headless leg (${s.imuReason}) — IMU-002 is about the case ` +
      'where it is not, and this leg is supposed to be permanently in that case. Either ' +
      'Chromium has acquired a sensor or something is fabricating one',
  );
  exitCode = 1;
} else if (fusedFrames > 0) {
  console.error(
    `[p7] ${fusedFrames} frame(s) reported a fused mode with no sensors reporting. That is ` +
      'filter state invented from instruments that are not there — the failure condition ' +
      'IMU-002 names in one line',
  );
  exitCode = 1;
} else if (s.fusionFrames < 30) {
  console.error(
    `[p7] only ${s.fusionFrames} fused frames over a ${FUSE_MS / 1000} s hold — v3 §68 asks for ` +
      'the run to *continue* on vision alone, and a run that barely ran cannot show that',
  );
  exitCode = 1;
} else {
  console.log(
    `[p7] v3 §68 holds: ${s.fusionFrames} frames, all VISION_ONLY, over ${FUSE_MS / 1000} s ` +
      'with no motion sensors of any kind — IMU unavailableでもVision-only modeで継続可能',
  );
}

// An unmeasured quantity is absent, not zero. §80 applied to a number rather than to a verdict.
if (s.gyroBiasDps !== null || s.biasZeroWithoutGyro > 0) {
  console.error(
    `[p7] a gyroscope bias was reported with no gyroscope: ${JSON.stringify(s.gyroBiasDps)}, ` +
      `${s.biasZeroWithoutGyro} record(s). A zero is a claim that the bias was estimated and ` +
      'found to be nothing; there is nothing here that could have estimated it',
  );
  exitCode = 1;
}

// v3 §19's seventh term, withheld by name rather than scored as good — the fourth fake the plan
// names is a confidence that improves because a sensor was switched on.
if (s.imuConsistency !== -1) {
  console.error(
    `[p7] imuConsistency was scored ${s.imuConsistency} with nothing to be consistent with`,
  );
  exitCode = 1;
} else if (!s.confidenceWithheld.some((w) => w.includes('IMUConsistency'))) {
  console.error(
    '[p7] imuConsistency is absent from the confidence and absent from the withheld list — an ' +
      'omission that is not named reads as an oversight rather than as a decision',
  );
  exitCode = 1;
}

// IMU-006 and IMU-009 need no sensor, so this leg decides them and states them in its own terms.
if (s.positionsReported > 0 || s.scaleViolations > 0 || s.eulerEmitted > 0) {
  console.error(
    `[p7] ${s.positionsReported} record(s) carried a position, ${s.scaleViolations} claimed a ` +
      `scale other than UNKNOWN, and ${s.eulerEmitted} carried a three-component orientation. ` +
      'v3 §17 forbids the first, v4 §18 the second, §18 the third — and there is no tolerance ' +
      'on any of them',
  );
  exitCode = 1;
} else {
  console.log(
    `[p7] refusals hold: no position in ${s.fusionFrames} records, scale ${s.scale} throughout, ` +
      `heading ${s.heading} because no magnetometer is read, no Euler triple anywhere`,
  );
}

// Rule 002 at frame granularity, and the check that a rate is a rate — Phase 6's device run
// reported an agreement rate of 232.3%, and this is the shape of the check that came out of it.
if (s.modeMismatches > 0 || s.rateOutOfRange > 0 || s.confidenceAboveWorstTerm > 0) {
  console.error(
    `[p7] ${s.modeMismatches} record(s) reported a mode their own inputs do not imply, ` +
      `${s.rateOutOfRange} rate(s) fell outside 0..1, and ${s.confidenceAboveWorstTerm} ` +
      'reported a confidence above their own lowest measured term',
  );
  exitCode = 1;
}

// IMU-002's fifth criterion: Phase 6 keeps running unchanged underneath. Empirical rather than
// structural — the leg cannot prove non-interference, but it can show that the pose kept being
// recovered at the same rate and to the same numbers while the fusion ran on top of it.
const poseAdvanced = snap.pose.poseFrames - poseBefore.poseFrames;
const rotationDrift = Math.abs(snap.pose.medianRotationDeg - poseBefore.medianRotationDeg);
if (poseAdvanced < 30) {
  console.error(
    `[p7] Phase 6 recovered only ${poseAdvanced} further pose frames during the ` +
      `${FUSE_MS / 1000} s fusion hold. IMU-002's fifth criterion asks that the visual pose be ` +
      'unaffected, and a pose that stopped being recovered is affected',
  );
  exitCode = 1;
} else if (rotationDrift > 1.0) {
  console.error(
    `[p7] Phase 6's median recovered rotation moved from ${poseBefore.medianRotationDeg}° to ` +
      `${snap.pose.medianRotationDeg}° while the fusion ran on top of it — on the same feed, ` +
      'which is not a change the feed can account for',
  );
  exitCode = 1;
} else {
  console.log(
    `[p7] Phase 6 unaffected: ${poseAdvanced} further pose frames during the hold, median ` +
      `rotation ${poseBefore.medianRotationDeg}° → ${snap.pose.medianRotationDeg}°`,
  );
}

console.log(`[p7] evidence: ${OUT_DIR}`);
console.log(`[p7] exit ${exitCode}`);
process.exit(exitCode);
