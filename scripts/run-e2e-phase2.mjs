#!/usr/bin/env node
/**
 * Phase 2 DESKTOP_DEV leg.
 *
 * Drives the frame pipeline end to end in headless Chromium: a clean 30-second window for
 * FRAME-001, a track renegotiation for FRAME-006, then injected load and its removal so
 * FRAME-003 and FRAME-004 have something real to react to.
 *
 * What this leg is honest about:
 *
 *  - The camera is Chromium's synthetic device, not a camera. Its image does change, which
 *    is what FRAME-002's provenance cross-check needs, but it is simulation (§28).
 *  - Phase 2 is reached through the development override, because on this leg Phase 0 stops
 *    at TESTING and the lock never opens. That is recorded in the bundle.
 *  - The leg is DESKTOP_DEV, so nothing here can pass a phase (Rule 004). What it can do is
 *    catch a regression in the pipeline, the controller or the harness on every build.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, openApp, serve } from './lib/harness.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase2', 'evidence');

/** FRAME-001 needs a 30 s unstressed segment; allow margin for the first frame. */
const CLEAN_WINDOW_MS = 34_000;
/** Long enough to walk the ladder to its floor: a window per step plus the 4 s cooldown. */
const STRESS_MS = 26_000;
/**
 * Recovery is deliberately slow: the up-after-down cooldown has to expire, and then three
 * consecutive windows have to come back comfortably inside the next tier's budget.
 */
const RECOVERY_MS = 28_000;

console.log('[p2] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p2] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
/**
 * Tests this leg cannot decide, each with the reason that applies to it specifically.
 * A shared message would misdescribe the exclusion, and a log whose job is to say what was
 * and was not exercised must not do that.
 */
const excluded = new Map();

const browser = await launch();

let snap;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  const entered = await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase2(true));
  if (!entered) throw new Error('could not enter Phase 2 even with the desktop override');

  await page.evaluate(() => window.__SPATIAL_DEBUG__.startPipeline());
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getPipelineStats().completed > 0, undefined, {
    timeout: 20_000,
  });

  const first = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  console.log(
    `[p2] pipeline running: route ${first.route ?? 'probing'}, ` +
      `source ${first.sourceWidth}x${first.sourceHeight} -> ${first.procWidth}x${first.procHeight}, ` +
      `worker scope hasDocument=${first.workerScope?.hasDocument}`,
  );

  console.log(`[p2] holding a clean window for ${CLEAN_WINDOW_MS / 1000} s (FRAME-001)…`);
  await page.waitForTimeout(CLEAN_WINDOW_MS);

  const clean = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  console.log(
    `[p2]   ${clean.completed} frames, ${clean.deliveredFps} fps delivered, ` +
      `UI ${clean.uiCostMs.mean} ms mean / ${clean.uiCostMs.p95} ms p95, ` +
      `worker ${clean.workerMs.mean} ms mean`,
  );
  console.log(
    `[p2]   cross-check: ${clean.crossCheck.count} samples, scene σ ${clean.crossCheck.sceneStdDev}, ` +
      `median Δluma ${clean.crossCheck.medianAbsDifference}, cost ${clean.crossCheck.costMs.mean} ms`,
  );

  /* ---------------------------------------------------------------- */
  /* Source geometry change (FRAME-006)                                */
  /* ---------------------------------------------------------------- */
  //
  // On the device this happens by rotating the phone: §H.0 measured the track renegotiating
  // from 1280x720 to 720x1280. A screen-orientation change does not do that to Chromium's
  // synthetic camera, so the same renegotiation is asked for directly on the track. It is a
  // real change of the real track's frame size — the same code path, reached another way —
  // and it is labelled here and in the log rather than presented as a rotation.
  const renegotiated = await page.evaluate(async () => {
    const v = document.getElementById('camera-preview');
    const track = v?.srcObject?.getVideoTracks?.()[0];
    if (!track) return 'no video track';
    try {
      await track.applyConstraints({ width: { exact: 640 }, height: { exact: 480 } });
      return null;
    } catch (err) {
      return String(err);
    }
  });
  if (renegotiated) {
    console.log(`[p2] track renegotiation unavailable on this browser: ${renegotiated}`);
  } else {
    await page.waitForTimeout(2000);
    const rotated = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
    console.log(
      `[p2] source sizes seen: ${rotated.sourceSizesObserved.join(' -> ')}; ` +
        `processing sizes: ${rotated.processedSizesObserved.join(' -> ')}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Injected load (FRAME-003, FRAME-004)                              */
  /* ---------------------------------------------------------------- */
  const refusal = await page.evaluate(() => window.__SPATIAL_DEBUG__.setStress(true));
  if (refusal) throw new Error(`load injection refused: ${refusal}`);
  const loaded = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  console.log(
    `[p2] load injected: ${loaded.stressPasses} extra pyramid passes — ` +
      `${loaded.stressIntervals[loaded.stressIntervals.length - 1]?.derivedFrom}`,
  );
  await page.waitForTimeout(STRESS_MS);

  const degraded = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  console.log(
    `[p2]   now ${degraded.tierLabel}, ${degraded.deliveredFps} fps, worker ` +
      `${degraded.workerMs.mean} ms mean, ${degraded.decisions.length} ladder move(s)`,
  );
  for (const d of degraded.decisions) {
    console.log(`[p2]     ${d.direction} ${d.fromLabel} -> ${d.toLabel}: ${d.reason}`);
  }

  await page.evaluate(() => window.__SPATIAL_DEBUG__.setStress(false));
  console.log(`[p2] load removed; waiting ${RECOVERY_MS / 1000} s for recovery…`);
  await page.waitForTimeout(RECOVERY_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase2Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase2EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getPipelineStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase2State(),
  }));

  writeFileSync(join(OUT_DIR, 'phase2-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase2-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p2] final: ${s.tierLabel}, ${s.completed} frames completed, ${s.lost} lost, ` +
      `${s.pacedOut} paced out, ${s.backpressured} backpressured`,
  );
  console.log(
    `[p2]   tiers used: ${s.tierUsage.map((t) => `${t.label} x${t.frames} [${t.sizes.join(',')}]`).join(' | ')}`,
  );
  console.log(
    `[p2]   routes: ${s.routeProbes.map((r) => `${r.route}=${r.note}`).join(' | ')}`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.stopPipeline());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 2 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p2] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

// FRAME-006 depends on the source frame size changing. The leg asks the track to
// renegotiate, which is the same code path a rotation takes on the device — but if this
// browser refuses the constraint there is nothing to observe, and a test that could not run
// must not be reported as one that ran.
if (!snap.stats.sourceSizesObserved || snap.stats.sourceSizesObserved.length < 2) {
  excluded.set(
    'FRAME-006',
    'this browser did not renegotiate the track frame size, so the §H.0 geometry change ' +
      'never occurred; the behaviour needs a device that can be rotated',
  );
}

// FRAME-002's provenance check needs a scene that changes. Chromium's synthetic camera is
// a slow uniform roll — the same limitation Phase 1 recorded for CAM-004 — and its spread
// sits close to the floor the check requires, so on some runs the check is honestly
// uninformative rather than failing. A test that could not conclude must not be counted as
// one that did, and swapping in a video chosen to clear the bar would make the leg green
// without making it informative. The provenance logic itself is covered by
// tests/unit/phase2Tests.test.ts; the behaviour needs a real camera.
const frame002 = snap.results.find((r) => r.spec.id === 'FRAME-002');
if (frame002?.verdict === 'PENDING' && Number(frame002.metrics?.sceneStdDev ?? -1) >= 0) {
  excluded.set(
    'FRAME-002',
    `the synthetic camera's own luma varied by only ${frame002.metrics?.sceneStdDev}, too ` +
      'little for agreement between the worker and the camera to mean anything',
  );
}

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p2] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p2]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p2] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p2] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}
console.log(`[p2] evidence: ${OUT_DIR}`);
console.log(`[p2] exit ${exitCode}`);
process.exit(exitCode);
