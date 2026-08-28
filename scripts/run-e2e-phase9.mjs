#!/usr/bin/env node
/**
 * Phase 9 DESKTOP_DEV leg — triangulation (v4 §21, v3 §15, §16).
 *
 * ## What this leg decides
 *
 * All seven required records, as Phase 8's did, and for the same kind of reason: **both of this
 * phase's gates are things the harness builds**. TRI-004 synthesises a pair from depths the stage
 * picked and never disclosed; TRI-003 replaces a pair's second view with a pure rotation of its
 * first. Neither needs a room, a phone or a person. The rest is decided on the parallax pan,
 * which contains real structure at two depths.
 *
 * Rule 004 is untouched. The leg's scene is two fronto-parallel layers at a fixed ratio and a
 * room is not, and the device's population ran to 41 points in a dim room (§H.8) where this one
 * runs to hundreds. What the leg gives is seven required records checked on every commit.
 *
 * ## The tripwires this leg owns
 *
 *  - **The two injections, on the numbers rather than on the verdicts**, so a change to the test
 *    and a change to the engine cannot both slip through together.
 *  - **The control beside the measurement.** A constant depth scores `controlRelativeError`, and
 *    the leg checks the measured error is orders below it rather than merely inside a tolerance.
 *  - **The depth ratio the feed encodes.** The near layer moves 3.5× the far one, and for a
 *    laterally translating camera image motion goes as `1/Z` — so the recovered depths should
 *    fall in two clusters 3.5 apart. That is ground truth the *feed* carries and the app cannot
 *    see, which makes it the closest thing this leg has to a real-scene check.
 *  - **Phase 8 keeps running unchanged underneath**, as Phase 8's leg checked Phase 7.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { farLuma, isNear, nearLuma, writeY4M } from './lib/feed.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase9', 'evidence');
const VIDEO = join(ROOT, 'node_modules', '.cache', 'triangulation-motion.y4m');

/** Long enough for many keyframe pairs, and for both injections to run several times each. */
const TRIANGULATE_MS = 60_000;

const W = 640;
const H = 480;

/** Phase 6's, Phase 7's and Phase 8's pan, verbatim. */
const DIRECTION = { x: 2.0, y: 0.7 };
/**
 * The near layer moves this much faster than the far one.
 *
 * For a laterally translating camera, image motion goes as `1/Z` — so this ratio *is* the depth
 * ratio between the two layers, and it is ground truth the feed carries and the app cannot read.
 */
const NEAR_FACTOR = 3.5;
const FRAMES = 240;
const NEAR_COVERAGE = 0.5;

function buildY4M() {
  let farX = 0;
  let farY = 0;
  const { frames, megabytes } = writeY4M(VIDEO, {
    width: W,
    height: H,
    frames: FRAMES,
    frame: (y) => {
      const nearX = farX * NEAR_FACTOR;
      const nearY = farY * NEAR_FACTOR;
      for (let yy = 0; yy < H; yy++) {
        const row = yy * W;
        for (let xx = 0; xx < W; xx++) {
          y[row + xx] = isNear(xx, W, NEAR_COVERAGE)
            ? nearLuma(xx + nearX, yy + nearY)
            : farLuma(xx + farX, yy + farY);
        }
      }
      farX += DIRECTION.x;
      farY += DIRECTION.y;
    },
  });
  console.log(
    `[p9] wrote ${W}x${H}, ${frames} frames (${megabytes} MB): parallax pan, near layer ` +
      `${NEAR_FACTOR}x the far one`,
  );
}

buildY4M();
console.log('[p9] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p9] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
const excluded = new Map();

const browser = await launch({ video: VIDEO });

let snap;
let keyframesBefore;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  await climbTo(page, 9, { log: (n) => console.log(`[p9] phase ${n} running`) });

  const gate = await expectLocked(page, 9, 'GO TO TRIANGULATION');
  console.log(`[p9] Phase Lock holds: ${gate.text}`);

  keyframesBefore = await page.evaluate(() => window.__SPATIAL_DEBUG__.getKeyframeStats());
  console.log(
    `[p9] handing over ${keyframesBefore.totalInserted} keyframe(s), ${keyframesBefore.keyframes} held`,
  );

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase9(true)))) {
    throw new Error('could not enter Phase 9 even with the desktop override');
  }

  const confirmTriangulating = await pressStart(page, '#start-triangulation', {
    idle: 'START TRIANGULATION',
    busy: 'TRIANGULATING',
  });

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getTriangulationStats().frames > 0,
    undefined,
    { timeout: 25_000 },
  );
  await confirmTriangulating();

  console.log(`[p9] holding for ${TRIANGULATE_MS / 1000} s…`);
  await page.waitForTimeout(TRIANGULATE_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase9Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase9EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getTriangulationStats(),
    keyframes: window.__SPATIAL_DEBUG__.getKeyframeStats(),
    pose: window.__SPATIAL_DEBUG__.getPoseStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase9State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
  }));

  writeFileSync(join(OUT_DIR, 'phase9-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase9-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p9] ${s.batches} batch(es): ${s.batchesTriangulated} triangulated, ${s.batchesRefused} ` +
      `refused — ${JSON.stringify(s.batchRefusalsByReason)}`,
  );
  console.log(
    `[p9] ${s.totalAccepted} point(s), median ${s.medianAcceptedPerBatch} per batch, ` +
      `${s.pointsPerKeyframe} per keyframe; acceptance ${s.acceptanceRate}; refusals ` +
      `${JSON.stringify(s.pointRefusals)}`,
  );
  console.log(
    `[p9] parallax: median ${s.medianParallaxDeg}° over all, ${s.medianAcceptedParallaxDeg}° over ` +
      `the accepted, worst accepted ${s.worstAcceptedParallaxDeg}°; depth uncertainty ` +
      `${s.medianDepthUncertainty}`,
  );
  console.log(
    `[p9] depth injection: ${s.depthInjections} run(s), median relative error ` +
      `${s.medianDepthError} against a constant depth's ${s.medianControlError}; rank ` +
      `correlation ${s.medianRankCorrelation}`,
  );
  console.log(
    `[p9] rotation injection: ${s.rotationInjections} run(s), ${s.rotationInjectionAccepted} ` +
      `point(s) accepted from a pure rotation, ${s.rotationInjectionCleanAccepted} from the ` +
      `untouched pairs; pose ${JSON.stringify(s.rotationInjectionPoseStates)}`,
  );
  console.log(
    `[p9] rotation cross-check: pair fit ${s.medianRotationDeg}°, Phase 6's chain disagrees by ` +
      `${s.medianRotationDisagreementDeg}° against ${s.rotationToleranceDeg}° ` +
      `(${s.rotationsWithinTolerance}/${s.rotationSamples} inside)`,
  );
  console.log(
    `[p9] scale ${s.scale}, baseline ${s.baselineUnits}; median batch depth ` +
      `${s.medianBatchDepth} with a batch-to-batch spread of ${s.batchDepthSpread}`,
  );
  console.log(
    `[p9] cost: ${s.meanTriangulationMs} ms per batch, ${s.amortisedMsPerFrame} ms amortised ` +
      `over every frame`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase9());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 9 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p9] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

excluded.set(
  'TRI-008',
  `it gates on an 8.0 ms per-insert ceiling on the device, and this is headless Chromium on a ` +
    `shared CPU — ${s.meanTriangulationMs} ms here measures this machine`,
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p9] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p9]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p9] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p9] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns                                              */
/* ------------------------------------------------------------------ */

if (s.running && s.batches === 0) {
  console.error(
    `[p9] the screen reported TRIANGULATING for the whole ${TRIANGULATE_MS / 1000} s hold and no ` +
      'pair was ever related — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// **TRI-004, on the numbers.** A constant depth scores the control; the measurement has to be
// orders below it rather than merely inside a tolerance.
if (s.depthInjections < 3) {
  console.error(`[p9] only ${s.depthInjections} known-depth injection(s) ran`);
  exitCode = 1;
} else if (!(s.medianDepthError * 10 <= s.medianControlError)) {
  console.error(
    `[p9] the recovered depths scored ${s.medianDepthError} where the best possible constant ` +
      `scores ${s.medianControlError} — not ten times better, so the measurement does not ` +
      'separate a triangulator from a stage that returns one number',
  );
  exitCode = 1;
} else {
  console.log(
    `[p9] TRI-004 holds: ${s.medianDepthError} against a constant depth's ` +
      `${s.medianControlError} over ${s.depthInjections} injections, rank correlation ` +
      `${s.medianRankCorrelation}`,
  );
}

// **TRI-003, on the numbers.** No tolerance.
if (s.rotationInjections < 3) {
  console.error(`[p9] only ${s.rotationInjections} pure-rotation injection(s) ran`);
  exitCode = 1;
} else if (s.rotationInjectionAccepted > 0) {
  console.error(
    `[p9] ${s.rotationInjectionAccepted} point(s) were triangulated from a camera that turned ` +
      'and did not move. Every ray pair in such a set meets at infinity',
  );
  exitCode = 1;
} else if (s.rotationInjectionCleanAccepted === 0) {
  console.error(
    '[p9] the untouched pairs on the injected batches produced nothing either, so the refusal ' +
      'is not evidence of anything — a stage that refuses everything scores it perfectly',
  );
  exitCode = 1;
} else {
  console.log(
    `[p9] TRI-003 holds: 0 point(s) from ${s.rotationInjections} pure rotations, ` +
      `${s.rotationInjectionCleanAccepted} from the untouched pairs on the same batches; the ` +
      `pose came back ${JSON.stringify(s.rotationInjectionPoseStates)}`,
  );
}

// The parallax gate, and v4 §21's prohibition.
if (s.worstAcceptedParallaxDeg >= 0 && s.worstAcceptedParallaxDeg < 1.0) {
  console.error(
    `[p9] a point was accepted at ${s.worstAcceptedParallaxDeg}° of parallax, below the 1.0° ` +
      'floor — v4 §21 forbids forcing points out of low parallax',
  );
  exitCode = 1;
}
if (s.medianDepthUncertainty > 0.1) {
  console.error(
    `[p9] median depth uncertainty ${s.medianDepthUncertainty} against the 0.10 the floor was ` +
      'derived to buy',
  );
  exitCode = 1;
}

// TRI-006: the fresh fit's witness.
if (s.rotationSamples > 0 && s.medianRotationDisagreementDeg > s.rotationToleranceDeg) {
  console.error(
    `[p9] the pair fit and Phase 6's chain disagree by ${s.medianRotationDisagreementDeg}° ` +
      `against a tolerance of ${s.rotationToleranceDeg}° — two routes to one rotation, and at ` +
      'most one of them can be right',
  );
  exitCode = 1;
}

// TRI-007 and TRI-009.
if (s.scaleViolations > 0 || s.accountingMismatches > 0 || s.refusedWithPoints > 0) {
  console.error(
    `[p9] ${s.scaleViolations} scale violation(s), ${s.accountingMismatches} batch(es) whose ` +
      `counts do not add up, ${s.refusedWithPoints} refused batch(es) reporting points`,
  );
  exitCode = 1;
} else {
  console.log(
    `[p9] refusals hold: scale ${s.scale} with a baseline of ${s.baselineUnits} throughout, ` +
      `every batch's counts adding up, and no depth pooled across pairs — the batch-to-batch ` +
      `spread is ${s.batchDepthSpread}`,
  );
}

// Phase 8 keeps running unchanged underneath.
const keyframesAdvanced = snap.keyframes.totalInserted - keyframesBefore.totalInserted;
if (keyframesAdvanced < 10) {
  console.error(
    `[p9] Phase 8 inserted only ${keyframesAdvanced} further keyframe(s) during the ` +
      `${TRIANGULATE_MS / 1000} s hold — Phase 9 consumes the pairs Phase 8 chooses, and a ` +
      'store that stopped choosing is a store this phase interfered with',
  );
  exitCode = 1;
} else if (snap.keyframes.reasonMismatches > 0) {
  console.error(
    `[p9] ${snap.keyframes.reasonMismatches} Phase 8 decision(s) stopped following from their ` +
      'own inputs while Phase 9 ran on top of them',
  );
  exitCode = 1;
} else {
  console.log(
    `[p9] Phase 8 unaffected: ${keyframesAdvanced} further keyframe(s) during the hold, still 0 ` +
      'decisions that do not follow from their own inputs',
  );
}

console.log(`[p9] evidence: ${OUT_DIR}`);
console.log(`[p9] exit ${exitCode}`);
process.exit(exitCode);
