#!/usr/bin/env node
/**
 * Phase 3 DESKTOP_DEV leg.
 *
 * Drives feature detection in headless Chromium against the synthetic camera, long enough
 * for the contrast check and the paired grid control to accumulate samples.
 *
 * What this leg is honest about:
 *
 *  - Chromium's synthetic camera is a rolling gradient. It is neither a textured wall nor a
 *    blank one, so the texture classes FEAT-001 and FEAT-002 judge may simply not occur —
 *    and where they do not, the tests are excluded from the gate with that reason printed
 *    rather than being counted as decided.
 *  - Phase 3 is reached through the development override, because on this leg Phase 0 stops
 *    at TESTING and the lock never opens. That is recorded in the bundle.
 *  - The leg is DESKTOP_DEV, so nothing here can pass a phase (Rule 004). What it can do is
 *    catch a regression in the detector, the selector or the harness on every build.
 *  - FEAT-005 measures this machine against a budget derived for the iPhone, so it is not
 *    this leg's to decide either. Its verdict is printed and a separate, explicitly wider
 *    regression ceiling gates instead. See DESKTOP_COST_CEILING_MS below.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, launch, openApp, serve } from './lib/harness.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase3', 'evidence');

/** Long enough for the sampled contrast and grid checks to reach their minimums. */
const DETECT_MS = 30_000;

/**
 * The detection cost above which this leg calls a regression — NOT FEAT-005's criterion.
 *
 * FEAT-005 gates on §H's 8 ms, which is a budget for the iPhone's tracking worker. This runs
 * on headless Chromium with SwiftShader on a shared CPU, so a cost measured here says
 * nothing about whether the device meets that budget: the same code measured 7.98 ms and
 * 9.18 ms on consecutive runs, straddling the threshold on machine variance and on which
 * part of the synthetic camera's cycle the run caught. The test plan already draws this
 * line — FEAT-005 is advisory because it is "a property of the device", where FEAT-006 is
 * advisory because it is "a property of the code" — so FEAT-006 gates this leg and FEAT-005
 * does not.
 *
 * What is still worth catching here is a *configuration* regression, and it has room to be
 * caught in: detecting on level 0 by mistake measured 45-50 ms on this same machine. 24 ms
 * sits between the correct configuration's observed spread and the misconfiguration it would
 * catch, with more than 2x margin either side. It is a tripwire, not a budget.
 */
const DESKTOP_COST_CEILING_MS = 24.0;

console.log('[p3] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p3] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
/** Tests this leg cannot decide, each with the reason that applies to it specifically. */
const excluded = new Map();

const browser = await launch();

let snap;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  // Take the device's path, not a shortcut to it. On a phone Phase 3 is reached from a
  // PIPELINE screen whose pipeline is still running — it has to be, to have passed — so the
  // FEATURES screen inherits a live pipeline and a live camera. Entering Phase 3 cold, as
  // this leg used to, exercises a sequence no device ever takes, and it missed a bug that
  // made START DETECTION a no-op on every real run: the guard saw a running pipeline and
  // returned before the tracking options were ever sent.
  await climbTo(page, 3, { log: (n) => console.log(`[p3] phase ${n} running`) });
  // Leave Phase 2's injected load on across the transition, so the leg also covers the
  // pipeline arriving in a state Phase 3 must not measure in.
  await page.evaluate(() => window.__SPATIAL_DEBUG__.setStress(true));
  await page.waitForTimeout(1_000);
  const handover = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  console.log(
    `[p3] handing over a live pipeline: ${handover.completed} frames, ` +
      `${handover.stressPasses} stress pass(es), tier ${handover.tierLabel}`,
  );

  const entered = await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase3(true));
  if (!entered) throw new Error('could not enter Phase 3 even with the desktop override');

  // Press the control a person presses, not the debug API behind it. Calling
  // startDetection() directly is how this leg missed a defect that left START DETECTION
  // rendered as "DETECTING" and *disabled* the moment the screen opened over Phase 2's
  // running pipeline: the engine was reachable, the button was not, and a harness that
  // reaches past the DOM cannot tell the difference (Rule 002).
  await page.waitForSelector('#start-detection', { timeout: 10_000 });
  const before = await page.evaluate(() => {
    const b = document.getElementById('start-detection');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (before.disabled !== false || before.text !== 'START DETECTION') {
    throw new Error(
      `START DETECTION is not pressable on arrival: label ${JSON.stringify(before.text)}, ` +
        `disabled ${before.disabled}. The screen is reporting a detection state the engine ` +
        'is not in, and a person could not start the run at all',
    );
  }
  await page.click('#start-detection');

  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getTrackingStats().detections > 0, undefined, {
    timeout: 25_000,
  });

  const after = await page.evaluate(() => {
    const b = document.getElementById('start-detection');
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  });
  if (after.text !== 'DETECTING' || after.disabled !== true) {
    throw new Error(
      `detection is running but the control says ${JSON.stringify(after.text)} ` +
        `(disabled ${after.disabled}) — the control and the engine disagree (Rule 002)`,
    );
  }

  const afterStart = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  if (afterStart.stressPasses !== 0) {
    throw new Error(
      `detection started with ${afterStart.stressPasses} stress pass(es) still injected — ` +
        'Phase 2 stress moves the tier, which sets the resolution Phase 3 detects on',
    );
  }

  const first = await page.evaluate(() => window.__SPATIAL_DEBUG__.getTrackingStats());
  console.log(
    `[p3] detecting at level ${first.detectLevel} (${first.detectWidth}x${first.detectHeight}), ` +
      `${first.count} features, ∇ ${first.meanGradient} → ${first.texture}`,
  );

  console.log(`[p3] holding for ${DETECT_MS / 1000} s…`);
  await page.waitForTimeout(DETECT_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase3Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase3EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getTrackingStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase3State(),
  }));

  writeFileSync(join(OUT_DIR, 'phase3-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase3-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p3] ${s.detections} detections, ${s.meanDetectCostMs} ms mean ` +
      `(level 0 would have cost ${s.level0Calibration?.detectMs ?? '?'} ms for ` +
      `${s.level0Calibration?.features ?? '?'} features)`,
  );
  console.log(
    `[p3] scene: rich ${s.textureRich.frames} frames (median ${s.textureRich.medianCount}), ` +
      `poor ${s.texturePoor.frames} (median ${s.texturePoor.medianCount}), ` +
      `ambiguous ${s.textureAmbiguous.frames}`,
  );
  console.log(
    `[p3] contrast: ${s.contrastSamples} samples, ${Math.round(s.medianAboveChance * 1000) / 10}% ` +
      'above chance (50% would be a detector unrelated to the image)',
  );
  console.log(
    `[p3] grid: ${s.grid.samples} paired samples, largest cell ` +
      `${Math.round(s.grid.medianGridded * 1000) / 10}% gridded vs ` +
      `${Math.round(s.grid.medianUngridded * 1000) / 10}% ungridded, ` +
      `${s.grid.medianCellGain >= 0 ? '+' : ''}${s.grid.medianCellGain} cells`,
  );
  console.log(
    `[p3] population: ${s.refills.length} refill(s), ${s.quotaBreaches} quota breach(es), ` +
      `${s.stateMismatches} state mismatch(es), states ${JSON.stringify(s.stateFrames)}`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.stopDetection());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 3 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p3] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

// The synthetic camera is a rolling gradient: it is not a textured wall and it is not a
// blank one. Where the run produced too few frames of a class for that class to be judged,
// the test says PENDING honestly and is excluded here rather than counted as decided.
// Feeding in a video chosen to produce both would make the leg green without making it
// informative; the detector's behaviour on real texture needs a real camera.
const s = snap.stats;
if (s.textureRich.frames < 15) {
  excluded.set(
    'FEAT-001',
    `the synthetic camera produced only ${s.textureRich.frames} texture-rich frames ` +
      `(median gradient ${s.textureAmbiguous.medianGradient}); it is a rolling gradient, ` +
      'not a wall with structure in it',
  );
}
// FEAT-002 compares the two classes, so it needs both. A run with 467 blank frames and no
// textured one cannot decide it any more than a run with neither.
if (s.texturePoor.frames < 15 || s.textureRich.frames < 15) {
  excluded.set(
    'FEAT-002',
    `the comparison needs both classes and the synthetic camera produced ` +
      `${s.textureRich.frames} texture-rich and ${s.texturePoor.frames} texture-poor frames; ` +
      'it is a rolling gradient that is neither a wall with structure nor a blank one',
  );
}
if (s.grid.samples < 10) {
  excluded.set(
    'FEAT-003',
    `only ${s.grid.samples} of ${s.grid.totalSamples} grid comparisons had the quota bind — ` +
      'the synthetic camera yields too few features for any cell to crowd, so the gridded ' +
      'and ungridded selections are identical and say nothing about the grid',
  );
}
if (s.refills.length === 0) {
  excluded.set(
    'FEAT-004',
    'the population never fell below the refill threshold, because the synthetic camera ' +
      'never stops having gradient in it — the ladder needs a scene that runs out of corners',
  );
}

// FEAT-005's own verdict stays printed above and stays in the bundle; it is simply not this
// leg's to decide, for the reason given at DESKTOP_COST_CEILING_MS. The tripwire below is a
// separate check with its own name and its own number.
excluded.set(
  'FEAT-005',
  `it gates on §H's 8 ms budget for the iPhone's tracking worker, and this is headless ` +
    `Chromium with SwiftShader on a shared CPU — ${s.meanDetectCostMs} ms here measures ` +
    'this machine, not the device. The device run decides it',
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p3] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p3]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p3] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p3] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

// Rule 002, as a tripwire the leg can state in one line: the screen reports DETECTING from
// the same function this reads, so a run that claims to be detecting and has detected
// nothing is the UI and the engine disagreeing. That is the exact signature of the device
// bug this sequence now reproduces — 2190 frames preprocessed, 0 detected, button lit.
if (snap.stats.running && snap.stats.detections === 0) {
  console.error(
    `[p3] the screen reported DETECTING for the whole ${DETECT_MS / 1000} s hold and ` +
      'detection ran on 0 frames — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// The configuration tripwire that replaces FEAT-005 on this leg.
if (s.meanDetectCostMs > DESKTOP_COST_CEILING_MS) {
  console.error(
    `[p3] detection cost ${s.meanDetectCostMs} ms is over this leg's ` +
      `${DESKTOP_COST_CEILING_MS} ms regression ceiling — that is not budget variance, ` +
      `it is the shape of detecting at the wrong level (level 0 measured ` +
      `${s.level0Calibration?.detectMs ?? '?'} ms here)`,
  );
  exitCode = 1;
} else {
  console.log(
    `[p3] detection cost ${s.meanDetectCostMs} ms, under this leg's ` +
      `${DESKTOP_COST_CEILING_MS} ms regression ceiling (FEAT-005's 8 ms budget is the ` +
      `device's to answer)`,
  );
}
console.log(`[p3] evidence: ${OUT_DIR}`);
console.log(`[p3] exit ${exitCode}`);
process.exit(exitCode);
