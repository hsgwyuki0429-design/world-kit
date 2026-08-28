#!/usr/bin/env node
/**
 * Phase 10 DESKTOP_DEV leg — landmark map (v4 §22, §56, §34).
 *
 * ## What this leg decides
 *
 * All seven required records, as Phases 8's and 9's legs do. The instruments are the map's own
 * memory and an injection the harness builds, and neither needs a room, a phone or a person:
 * MAP-002 asks the map to predict a landmark into a keyframe its position was not computed from,
 * and MAP-005 displaces a known subset of the incoming positions and asks the map's gate to find
 * them.
 *
 * Rule 004 is untouched. This leg's scene is two fronto-parallel layers, its "landmarks" are
 * corners of a synthetic texture, and the device's population ran to 41 points in a dim room
 * (§H.8) where this one runs to hundreds.
 *
 * ## The tripwires this leg owns
 *
 *  - **The two gates, on the numbers rather than on the verdicts**, so a change to the test and a
 *    change to the engine cannot both slip through together.
 *  - **The injection's baseline beside its false-cull rate.** The criterion is the *excess* over
 *    what the same gate refuses on the uncorrupted batch — an absolute rate is passed by any
 *    sufficiently quiet scene.
 *  - **The registration's scale is a ratio and never a length**, and the run reports how many
 *    batches could not be registered and how many epochs that cost.
 *  - **Phase 9 keeps running unchanged underneath**, as Phase 9's leg checked Phase 8.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { farLuma, isNear, nearLuma, writeY4M } from './lib/feed.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase10', 'evidence');
const VIDEO = join(ROOT, 'node_modules', '.cache', 'landmark-motion.y4m');

/** Long enough for landmarks to be seen five times over, which MAP-006 needs. */
const MAP_MS = 60_000;

const W = 640;
const H = 480;

/** Phases 6–9's pan, verbatim. */
const DIRECTION = { x: 2.0, y: 0.7 };
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
  console.log(`[p10] wrote ${W}x${H}, ${frames} frames (${megabytes} MB): parallax pan`);
}

buildY4M();
console.log('[p10] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p10] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
const excluded = new Map();

const browser = await launch({ video: VIDEO });

let snap;
let triangulationBefore;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  await climbTo(page, 10, { log: (n) => console.log(`[p10] phase ${n} running`) });

  const gate = await expectLocked(page, 10, 'GO TO LANDMARK MAP');
  console.log(`[p10] Phase Lock holds: ${gate.text}`);

  triangulationBefore = await page.evaluate(() =>
    window.__SPATIAL_DEBUG__.getTriangulationStats(),
  );
  console.log(
    `[p10] handing over ${triangulationBefore.batches} batch(es), ` +
      `${triangulationBefore.totalAccepted} triangulated point(s)`,
  );

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase10(true)))) {
    throw new Error('could not enter Phase 10 even with the desktop override');
  }

  const confirmMapping = await pressStart(page, '#start-landmarks', {
    idle: 'START LANDMARK MAP',
    busy: 'MAPPING',
  });

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getLandmarkStats().frames > 0,
    undefined,
    { timeout: 25_000 },
  );
  await confirmMapping();

  console.log(`[p10] holding for ${MAP_MS / 1000} s…`);
  await page.waitForTimeout(MAP_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase10Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase10EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getLandmarkStats(),
    triangulation: window.__SPATIAL_DEBUG__.getTriangulationStats(),
    keyframes: window.__SPATIAL_DEBUG__.getKeyframeStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase10State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
  }));

  writeFileSync(join(OUT_DIR, 'phase10-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase10-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p10] ${s.batches} batch(es): ${s.registeredBatches} registered, ` +
      `${s.unregisteredBatches} not — ${JSON.stringify(s.unregisteredReasons)}`,
  );
  console.log(
    `[p10] map: ${s.landmarks}/${s.maxLandmarks} held (most ${s.peakLandmarks}), ` +
      `${s.confirmed} confirmed (most ${s.peakConfirmed}), ${s.culled} culled ` +
      `${JSON.stringify(s.cullsByReason)}; median confidence ${s.medianConfidence}`,
  );
  console.log(
    `[p10] held-out prediction: median ${s.medianHeldOutPx} px, worst ${s.worstHeldOutPx} px over ` +
      `${s.heldOutBatches} batch(es); ${s.zeroHeldOut} exactly zero; the landmarks had a median ` +
      `of ${s.medianObservationsAtPrediction} observations when they were asked`,
  );
  console.log(
    `[p10] injection: ${s.injections} run(s), recall ${s.medianRecall}, untouched ` +
      `${s.medianCleanRejectionRate} against a baseline of ${s.medianBaselineRejectionRate} — ` +
      `excess ${s.medianCleanExcess} (worst ${s.worstCleanExcess}), displacing ` +
      `${s.injectionDisplacementPx} px`,
  );
  console.log(
    `[p10] registration: median scale ${s.medianRegistrationScale}, residual ` +
      `${s.medianRegistrationResidual} (worst ${s.worstRegistrationResidual}), ` +
      `${s.registrationOutliers} outlier(s) trimmed; ${s.epochs} epoch(s), ` +
      `${s.epochRestarts} restart(s)`,
  );
  console.log(
    `[p10] convergence: ${s.moveAtTwo} of a depth at two observations ` +
      `(${s.moveAtTwoSamples} sample(s)), ${s.moveAtFive} at five or more ` +
      `(${s.moveAtFiveSamples})`,
  );
  console.log(
    `[p10] sparsity: ${s.landmarksPerKeyframe} landmark(s) per keyframe and ` +
      `${s.landmarksPerTrackedFeature} for every feature the tracker is following; ` +
      `${s.confirmedShare} of the map confirmed; scale ${s.scale}`,
  );
  console.log(
    `[p10] cost: ${s.meanLandmarkMs} ms per batch, ${s.amortisedMsPerFrame} ms amortised`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase10());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 10 — DESKTOP_DEV LEG ========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p10] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

excluded.set(
  'MAP-008',
  `it gates on a 4.0 ms per-batch ceiling on the device, and this is headless Chromium on a ` +
    `shared CPU — ${s.meanLandmarkMs} ms here measures this machine`,
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p10] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p10]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p10] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p10] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns                                              */
/* ------------------------------------------------------------------ */

if (s.running && s.batches === 0) {
  console.error(
    `[p10] the screen reported MAPPING for the whole ${MAP_MS / 1000} s hold and no batch ever ` +
      'reached the map — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// **MAP-002, on the numbers.** The one figure a map with no memory has nothing to produce.
if (s.heldOutBatches < 15) {
  console.error(`[p10] only ${s.heldOutBatches} batch(es) produced a held-out prediction`);
  exitCode = 1;
} else if (s.medianHeldOutPx > 2.0) {
  console.error(
    `[p10] the map's predictions land ${s.medianHeldOutPx} px from where the tracker sees the ` +
      "points, past v3 §33's 2.0 px",
  );
  exitCode = 1;
} else if (s.zeroHeldOut === s.heldOutSamples) {
  console.error(
    '[p10] every prediction was exactly right, which is not what a prediction is — the position ' +
      'being predicted from is the observation being predicted',
  );
  exitCode = 1;
} else {
  console.log(
    `[p10] MAP-002 holds: ${s.medianHeldOutPx} px median over ${s.heldOutBatches} batches, from ` +
      `landmarks with a median of ${s.medianObservationsAtPrediction} observations at the moment ` +
      'they were asked',
  );
}

// **MAP-005, on the numbers, with its baseline.**
if (s.injections < 3) {
  console.error(`[p10] only ${s.injections} injection(s) ran`);
  exitCode = 1;
} else if (s.medianRecall < 0.9) {
  console.error(
    `[p10] the map found ${s.medianRecall} of the positions the harness displaced by ` +
      `${s.injectionDisplacementPx} px, below the 0.90 floor`,
  );
  exitCode = 1;
} else if (s.medianCleanExcess > 0.1) {
  console.error(
    `[p10] it refused ${s.medianCleanRejectionRate} of the untouched points where the same gate ` +
      `refuses ${s.medianBaselineRejectionRate} on the uncorrupted batch — an excess of ` +
      `${s.medianCleanExcess}, above 0.10`,
  );
  exitCode = 1;
} else {
  console.log(
    `[p10] MAP-005 holds: recall ${s.medianRecall}, untouched ${s.medianCleanRejectionRate} ` +
      `against a baseline of ${s.medianBaselineRejectionRate} — excess ${s.medianCleanExcess}`,
  );
}

// MAP-003: the scale is a ratio, and nothing is ingested unregistered.
if (s.ingestedUnregistered > 0 || s.unregisteredAdmissions > 0 || s.scaleViolations > 0) {
  console.error(
    `[p10] ${s.ingestedUnregistered} batch(es) ingested without a registration, ` +
      `${s.unregisteredAdmissions} unregistered batch(es) admitted something, ` +
      `${s.scaleViolations} scale violation(s)`,
  );
  exitCode = 1;
} else {
  console.log(
    `[p10] one frame holds: median scale ${s.medianRegistrationScale} at a residual of ` +
      `${s.medianRegistrationResidual}, ${s.epochs} epoch(s) with ${s.epochRestarts} restart(s), ` +
      `scale ${s.scale} throughout`,
  );
}

// MAP-004 and MAP-006.
if (s.boundBreaches > 0 || s.cullsWithoutReason > 0 || s.confidenceOutOfRange > 0) {
  console.error(
    `[p10] ${s.boundBreaches} bound breach(es), ${s.cullsWithoutReason} cull(s) with no reason, ` +
      `${s.confidenceOutOfRange} confidence(s) outside 0..1`,
  );
  exitCode = 1;
}
if (s.moveAtTwoSamples > 0 && s.moveAtFiveSamples > 0 && s.moveAtFive > s.moveAtTwo) {
  console.error(
    `[p10] a landmark moves ${s.moveAtFive} of its depth on its fifth observation and ` +
      `${s.moveAtTwo} on its second — the position is not settling`,
  );
  exitCode = 1;
}

// MAP-009's accounting.
if (s.accountingMismatches > 0 || s.rateOutOfRange > 0 || s.sizeMismatches > 0) {
  console.error(
    `[p10] ${s.accountingMismatches} batch(es) whose counts do not add up, ${s.rateOutOfRange} ` +
      `rate(s) outside 0..1, ${s.sizeMismatches} size mismatch(es)`,
  );
  exitCode = 1;
}

// Phase 9 keeps running unchanged underneath.
const batchesAdvanced = snap.triangulation.batches - triangulationBefore.batches;
if (batchesAdvanced < 10) {
  console.error(
    `[p10] Phase 9 produced only ${batchesAdvanced} further batch(es) during the ` +
      `${MAP_MS / 1000} s hold — Phase 10 consumes what Phase 9 makes, and a triangulator that ` +
      'stopped is one this phase interfered with',
  );
  exitCode = 1;
} else if (snap.triangulation.rotationInjectionAccepted > 0) {
  console.error(
    `[p10] Phase 9 began accepting points from a pure rotation while Phase 10 ran on top of it`,
  );
  exitCode = 1;
} else {
  console.log(
    `[p10] Phase 9 unaffected: ${batchesAdvanced} further batch(es) during the hold, still 0 ` +
      'points from a pure rotation',
  );
}

console.log(`[p10] evidence: ${OUT_DIR}`);
console.log(`[p10] exit ${exitCode}`);
process.exit(exitCode);
