#!/usr/bin/env node
/**
 * Phase 8 DESKTOP_DEV leg — keyframe system (v3 §20, v4 §20).
 *
 * ## The leg decides this phase's whole required suite, and that is new
 *
 * Phase 7's was the first leg to decide a required record, because v3 §68's pass condition was
 * about an absence headless Chromium is permanently in. Phase 8's decides all six, for a
 * different reason: the instruments this phase is scored against are **a camera that is not
 * moving** and **a metronome**, and the harness can produce both. The feed holds still for seven
 * seconds in the middle of a pan, and the metronome runs inside the app beside the real selector
 * on the same frames.
 *
 * Rule 004 is untouched. `DESKTOP_DEV` cannot pass a phase, and the numbers a phone produces in
 * a real room — where "still" means a hand-held camera and the population is a tenth the size —
 * are not the numbers a synthetic pan produces. What the leg gives is six required records
 * checked on every commit rather than once, by hand, on a phone.
 *
 * ## What it checks, beyond the verdict
 *
 *  - **The metronome comparison, on the numbers rather than on KEY-002's verdict**, so a change
 *    to the test and a change to the engine cannot both slip through together.
 *  - **Every decision re-derives** from the inputs recorded beside it. A selector that inserted
 *    on a timer and labelled the record `ROTATION` satisfies every count in this phase.
 *  - **The store fills and evicts**, with the counterfactual measured on each eviction.
 *  - **v3 §20's translation condition never fires** and is carried as `UNMEASURED`.
 *  - **Phase 7 keeps running unchanged underneath.** The leg records the fusion's own figures
 *    before the store starts and again after the hold.
 *
 * ## The feed
 *
 * Two-layer parallax pan, a **static hold**, then the pan again. The hold is the instrument:
 * Phase 4's independent scene-shift search reports `STATIC` below 1 px of image motion, and that
 * classification is what KEY-002 counts over. Nothing in Phase 8 computes it or can influence it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { farLuma, isNear, nearLuma, writeY4M } from './lib/feed.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase8', 'evidence');
const VIDEO = join(ROOT, 'node_modules', '.cache', 'keyframe-motion.y4m');

/** Long enough for the store to fill, evict, and cross the static hold more than once. */
const KEEP_MS = 60_000;

const W = 640;
const H = 480;

/** Phase 6's and Phase 7's pan, verbatim, with a hold cut into the middle of it. */
const DIRECTION = { x: 2.0, y: 0.7 };
const NEAR_FACTOR = 3.5;
const SEGMENTS = [
  { name: 'parallax-pan', frames: 150, speed: 1.0 },
  { name: 'static-hold', frames: 210, speed: 0.0 },
  { name: 'parallax-pan', frames: 150, speed: 1.0 },
];
const NEAR_COVERAGE = 0.5;

function buildY4M() {
  let farX = 0;
  let farY = 0;
  let si = 0;
  let left = SEGMENTS[0].frames;
  const { frames, megabytes } = writeY4M(VIDEO, {
    width: W,
    height: H,
    frames: SEGMENTS.reduce((a, s) => a + s.frames, 0),
    frame: (y) => {
      const seg = SEGMENTS[si];
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
      farX += DIRECTION.x * seg.speed;
      farY += DIRECTION.y * seg.speed;
      if (--left === 0 && si + 1 < SEGMENTS.length) left = SEGMENTS[++si].frames;
    },
  });
  console.log(
    `[p8] wrote ${W}x${H}, ${frames} frames (${megabytes} MB): ` +
      SEGMENTS.map((s) => `${s.frames}x ${s.name}`).join(', '),
  );
}

buildY4M();
console.log('[p8] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p8] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
/** Tests this leg cannot decide, each with the reason that applies to it specifically. */
const excluded = new Map();

const browser = await launch({ video: VIDEO });

let snap;
let fusionBefore;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  // The device's path, all the way. On a phone Phase 8 is reached from an IMU SUPPORT / FUSION
  // screen with seven live stages behind it, because that is how Phase 7 passes.
  await climbTo(page, 8, { log: (n) => console.log(`[p8] phase ${n} running`) });

  const gate = await expectLocked(page, 8, 'GO TO KEYFRAME SYSTEM');
  console.log(`[p8] Phase Lock holds: ${gate.text}`);

  fusionBefore = await page.evaluate(() => window.__SPATIAL_DEBUG__.getFusionStats());
  console.log(
    `[p8] handing over ${fusionBefore.fusionFrames} fused frames in mode ${fusionBefore.mode}`,
  );

  if (!(await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase8(true)))) {
    throw new Error('could not enter Phase 8 even with the desktop override');
  }

  // Press the control a person presses. There is deliberately no `startKeyframes()` in the debug
  // API, for the reason §H.5 records at length.
  const confirmKeeping = await pressStart(page, '#start-keyframes', {
    idle: 'START KEYFRAMES',
    busy: 'KEEPING',
  });

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getKeyframeStats().decisions > 0,
    undefined,
    { timeout: 25_000 },
  );
  await confirmKeeping();

  console.log(`[p8] holding for ${KEEP_MS / 1000} s…`);
  await page.waitForTimeout(KEEP_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase8Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase8EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getKeyframeStats(),
    fusion: window.__SPATIAL_DEBUG__.getFusionStats(),
    pose: window.__SPATIAL_DEBUG__.getPoseStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase8State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
  }));

  writeFileSync(join(OUT_DIR, 'phase8-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase8-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p8] ${s.decisions} decisions, ${s.totalInserted} keyframe(s) — ` +
      `${JSON.stringify(s.insertionsByReason)}`,
  );
  console.log(
    `[p8] static: ${s.staticDecisions} decisions, selector ${s.staticSelectorInsertions} ` +
      `(${s.staticGeometricInsertions} geometric, ` +
      `${JSON.stringify(s.staticInsertionsByReason)}), metronome ` +
      `${s.staticMetronomeInsertions} — ${s.staticRatio}x`,
  );
  console.log(
    `[p8] store: ${s.keyframes}/${s.maxStoreSize} held, ${s.evictions} eviction(s), ` +
      `${s.evictionsCoverageKept} at least as well spread as dropping the oldest, ` +
      `${s.storeOverflows} overflow(s)`,
  );
  console.log(
    `[p8] integrity: ${s.reasonMismatches} decision(s) that do not follow from their inputs, ` +
      `${s.minIntervalViolations} inside the minimum, ${s.maxIntervalGaps} past the maximum ` +
      `(longest gap ${s.longestGapMs} ms)`,
  );
  console.log(
    `[p8] keyframes: median ${s.medianSharedWithLast} observation(s) shared, ` +
      `${s.intrinsicsMismatches} intrinsics mismatch(es), ${s.observationFloorViolations} below ` +
      `the floor, ${s.staleEver} stale at the most`,
  );
  console.log(
    `[p8] translation: ${s.translationCondition ? s.translationCondition.state : 'ABSENT'}, ` +
      `fired ${s.translationFired}x; direction moved ${s.medianTranslationDirectionDeg}° over ` +
      `${s.translationDirectionSamples} sample(s); scale ${s.scale}`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase8());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 8 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p8] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

// KEY-007 measures this machine against a budget written for the iPhone, exactly as GEO-005,
// FLOW-006, POSE-006 and IMU-008 did.
excluded.set(
  'KEY-007',
  `it gates on a 1.0 ms ceiling on the device, and this is headless Chromium on a shared CPU — ` +
    `${s.meanKeyframeMs} ms here measures this machine`,
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p8] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p8]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p8] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p8] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns, each with its own name and its own number   */
/* ------------------------------------------------------------------ */

// Rule 002, in one line: the screen reports KEEPING from the same predicate this reads.
if (s.running && s.decisions === 0) {
  console.error(
    `[p8] the screen reported KEEPING for the whole ${KEEP_MS / 1000} s hold and the selector ` +
      'decided nothing — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// **The record this leg exists for**, checked on the numbers rather than taken from KEY-002's
// verdict, so a change to the test and a change to the engine cannot both slip through together.
if (s.staticDecisions < 15) {
  console.error(
    `[p8] only ${s.staticDecisions} decision(s) were taken while the image was static. The feed ` +
      'holds still for seven seconds in the middle of the pan and Phase 4’s own scene-shift ' +
      'search is what classifies it — a shortfall here means the hold is not reaching the ' +
      'classifier, not that the selector is wrong',
  );
  exitCode = 1;
} else if (s.staticMetronomeInsertions < 5 * s.staticSelectorInsertions) {
  console.error(
    `[p8] over ${s.staticDecisions} static decisions the selector kept ` +
      `${s.staticSelectorInsertions} and a metronome would have kept ` +
      `${s.staticMetronomeInsertions} — ${s.staticRatio}x, short of 5x. A selector that keeps ` +
      'up with a metronome on a still camera is a metronome',
  );
  exitCode = 1;
} else {
  console.log(
    `[p8] v3 §20 holds where it matters: over ${s.staticDecisions} decisions with the image not ` +
      `moving, the selector kept ${s.staticSelectorInsertions} view(s) and a metronome would ` +
      `have kept ${s.staticMetronomeInsertions} — ${s.staticRatio}x`,
  );
}

// Rule 002 at decision granularity. A selector firing on a timer and labelling the record
// ROTATION satisfies every count above this line.
if (s.reasonMismatches > 0) {
  console.error(
    `[p8] ${s.reasonMismatches} decision(s) reported a reason the same pure function does not ` +
      'reproduce from the inputs recorded beside them — the labels and the arithmetic disagree',
  );
  exitCode = 1;
}
if (s.minIntervalViolations > 0 || s.maxIntervalGaps > 0) {
  console.error(
    `[p8] ${s.minIntervalViolations} insertion(s) inside v3 §20’s minimum interval and ` +
      `${s.maxIntervalGaps} decision(s) past its maximum (longest gap ${s.longestGapMs} ms)`,
  );
  exitCode = 1;
}

// §56 and §H.1's bound, and the policy behind it.
if (s.storeOverflows > 0 || s.evictedNewest > 0) {
  console.error(
    `[p8] the store overflowed on ${s.storeOverflows} frame(s) and evicted the comparison ` +
      `partner ${s.evictedNewest} time(s)`,
  );
  exitCode = 1;
} else if (s.evictions === 0) {
  console.error(
    `[p8] the store never filled over a ${KEEP_MS / 1000} s hold, so the eviction policy was ` +
      'never exercised — KEY-003 cannot be decided by a run that never reached the bound',
  );
  exitCode = 1;
} else {
  console.log(
    `[p8] bound holds: ${s.maxStoreSize} keyframes at the fullest, ${s.evictions} eviction(s), ` +
      `${s.evictionsCoverageKept} of them at least as well spread as dropping the oldest would ` +
      'have been',
  );
}

// KEY-005: the refusal, checked as a value rather than as an absence.
if (!s.translationCondition || s.translationCondition.state !== 'UNMEASURED') {
  console.error(
    `[p8] v3 §20’s translation condition is ` +
      `${s.translationCondition ? s.translationCondition.state : 'absent from the record'} — an ` +
      'omission that is not named reads as an oversight rather than as a decision',
  );
  exitCode = 1;
} else if (s.translationFired > 0 || s.scaleViolations > 0) {
  console.error(
    `[p8] the translation condition fired ${s.translationFired} time(s) and ${s.scaleViolations} ` +
      'record(s) claimed a scale other than LOCAL_UNITS. There is no translation magnitude in ' +
      'this build, so any is fabricated',
  );
  exitCode = 1;
} else {
  console.log(
    `[p8] refusal holds: TRANSLATION carried as UNMEASURED against v3 §20’s 0.1 local unit, ` +
      `never fired, with the direction it *can* measure at ${s.medianTranslationDirectionDeg}° ` +
      `over ${s.translationDirectionSamples} sample(s); scale ${s.scale} throughout`,
  );
}

// KEY-004: what Phase 9 will pair.
if (s.observationFloorViolations > 0 || s.intrinsicsMismatches > 0 || s.duplicateObservationIds > 0) {
  console.error(
    `[p8] ${s.observationFloorViolations} keyframe(s) below the observation floor, ` +
      `${s.intrinsicsMismatches} carrying a K that does not follow from their own geometry, and ` +
      `${s.duplicateObservationIds} repeated observation id(s)`,
  );
  exitCode = 1;
}

// Phase 7 keeps running unchanged underneath. Empirical rather than structural, as Phase 7's
// leg checked Phase 6: the leg cannot prove non-interference, but it can show the fusion kept
// reporting at the same rate and in the same mode while the store ran on top of it.
const fusionAdvanced = snap.fusion.fusionFrames - fusionBefore.fusionFrames;
if (fusionAdvanced < 30) {
  console.error(
    `[p8] Phase 7 produced only ${fusionAdvanced} further fused frames during the ` +
      `${KEEP_MS / 1000} s hold — the keyframe store is supposed to consume Phase 6’s poses, ` +
      'not to interrupt the stack under it',
  );
  exitCode = 1;
} else if (snap.fusion.mode !== fusionBefore.mode) {
  console.error(
    `[p8] Phase 7’s mode moved ${fusionBefore.mode} → ${snap.fusion.mode} while the keyframe ` +
      'store ran on top of it, on the same feed and with the same (absent) sensors',
  );
  exitCode = 1;
} else {
  console.log(
    `[p8] Phase 7 unaffected: ${fusionAdvanced} further fused frames during the hold, still ` +
      `${snap.fusion.mode}`,
  );
}

console.log(`[p8] evidence: ${OUT_DIR}`);
console.log(`[p8] exit ${exitCode}`);
process.exit(exitCode);
