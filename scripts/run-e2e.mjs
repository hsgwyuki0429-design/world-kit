#!/usr/bin/env node
/**
 * DESKTOP_DEV leg runner.
 *
 * Builds the app, serves it over http://localhost (a secure context, so CAP-0001 is
 * meaningful), drives it in headless Chromium, taps the sensor probe, and writes out the
 * same evidence bundle a human would export from a phone, plus a screenshot.
 *
 * Rule 004 is enforced by the app itself, not by this script: `determineLeg()` sees
 * `navigator.webdriver === true` and a localhost origin, classifies the run as DESKTOP_DEV,
 * and `PhaseRegistry.evaluate` then refuses to return PASSED regardless of results. This
 * runner exists to catch regressions early and to prove the harness works — never to pass
 * a phase.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, serve } from './lib/harness.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase0', 'evidence');

console.log('[e2e] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const port = server.address().port;
const url = `http://localhost:${port}/`;
console.log(`[e2e] serving ${DIST} at ${url}`);

// Phase 0 never opens a camera: it probes capabilities and stops. No synthetic
// device, and no flag answering a prompt that is never raised.
const browser = await launch({ device: false, autoGrant: false });
// Phase 0 keeps its own context: no touch, no mobile flag, no console capture. It
// probes capabilities and screenshots the result, and a touch-enabled context would
// change what `CapabilityDetector` reports about the platform it is on.
const context = await browser.newContext({
  viewport: { width: 430, height: 932 }, // iPhone-sized viewport for a readable screenshot
  deviceScaleFactor: 2,
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

let exitCode = 0;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const started = await page.evaluate(() => window.__SPATIAL_READY__);
  if (!started) throw new Error('app failed to start');

  // The boot-failure notice in index.html is replaced by the app's first render. If it is
  // still on the page, the shell loaded but the engine did not — the silent black-page
  // failure this check exists to make loud.
  const bootNoticeVisible = await page.evaluate(() =>
    document.body.textContent?.includes('The application did not start') ?? false,
  );
  if (bootNoticeVisible) throw new Error('boot-failure notice still present after start');

  // Before the gesture, CAP-0004/0005 are PENDING, so the evidence card must warn that an
  // export would record TESTING rather than a pass, and the download button must name that
  // verdict. This is the guard for a bundle exported too early being filed as proof.
  const beforeProbe = await page.evaluate(() => ({
    warning: document.getElementById('evidence-pending-warning')?.textContent ?? null,
    downloadLabel: document.getElementById('download-evidence')?.textContent ?? null,
  }));
  if (!beforeProbe.warning) {
    throw new Error('no PENDING warning shown while required tests are PENDING');
  }
  if (!beforeProbe.downloadLabel?.includes('TESTING')) {
    throw new Error(`download button does not name the verdict: ${beforeProbe.downloadLabel}`);
  }
  console.log(`[e2e] pre-probe export guard: "${beforeProbe.downloadLabel}"`);

  console.log('[e2e] tapping the sensor probe (CAP-0004 / CAP-0005)…');
  await page.click('#probe-sensors');
  await page.waitForFunction(
    () => document.getElementById('probe-sensors')?.textContent?.includes('RE-PROBE'),
    undefined,
    { timeout: 20000 },
  );
  // Let the post-probe re-evaluation and re-render settle.
  await page.waitForFunction(() => !!window.__SPATIAL_DEBUG__.getEvidence(), undefined, {
    timeout: 10000,
  });

  const afterProbe = await page.evaluate(() => ({
    warning: document.getElementById('evidence-pending-warning')?.textContent ?? null,
    downloadLabel: document.getElementById('download-evidence')?.textContent ?? null,
  }));
  if (afterProbe.warning) {
    throw new Error('PENDING warning still shown after every required test was determined');
  }
  console.log(`[e2e] post-probe export label: "${afterProbe.downloadLabel}"`);

  const snapshot = await page.evaluate(() => ({
    evidence: window.__SPATIAL_DEBUG__.getEvidenceJson(),
    phase: window.__SPATIAL_DEBUG__.getPhaseState(),
    results: window.__SPATIAL_DEBUG__.getResults(),
    ui: window.__SPATIAL_DEBUG__.getUiSnapshot(),
    integrityIssues: window.__SPATIAL_DEBUG__.getIntegrityIssues(),
    log: window.__SPATIAL_DEBUG__.getLog(),
  }));

  mkdirSync(OUT_DIR, { recursive: true });
  const evidencePath = join(OUT_DIR, 'phase0-desktop-chromium.json');
  writeFileSync(evidencePath, snapshot.evidence);
  const shotPath = join(OUT_DIR, 'phase0-desktop-chromium.png');
  await page.screenshot({ path: shotPath, fullPage: true });

  const bundle = JSON.parse(snapshot.evidence);

  console.log('\n=== PHASE 0 — DESKTOP_DEV LEG =========================================');
  console.log(`leg              : ${bundle.leg}`);
  console.log(`verdict          : ${bundle.overallVerdict}`);
  console.log(`reason           : ${bundle.overallReason}`);
  console.log(`capabilities     : ${bundle.capabilityMatrix.records.length} records, ` +
    `${bundle.capabilityMatrix.totalDurationMs} ms of probing`);
  console.log(`start scan       : disabled=${snapshot.ui.startScanDisabled} ` +
    `"${snapshot.ui.startScanLabel}"`);
  console.log('-----------------------------------------------------------------------');
  for (const r of snapshot.results) {
    const tag = r.spec.required ? 'REQ' : 'ADV';
    console.log(`${r.verdict.padEnd(7)} ${tag} ${r.spec.id}  ${r.spec.title}`);
    console.log(`             observed: ${r.observed}`);
  }
  console.log('-----------------------------------------------------------------------');
  console.log('CAPABILITY MATRIX');
  for (const rec of bundle.capabilityMatrix.records) {
    const method = { FUNCTIONAL_PROBE: 'PROBE', PRESENCE_CHECK: 'PRESENCE', INFERENCE: 'INFER' }[rec.method] ?? 'NOT-RUN';
    console.log(`  ${rec.id.padEnd(36)} ${rec.state.padEnd(20)} ${method.padEnd(9)} ${String(rec.durationMs).padStart(7)} ms`);
  }
  console.log('=======================================================================\n');

  const requiredFailures = snapshot.results.filter((r) => r.spec.required && r.verdict === 'FAIL');
  const advisoryFailures = snapshot.results.filter((r) => !r.spec.required && r.verdict === 'FAIL');
  const requiredPending = snapshot.results.filter((r) => r.spec.required && r.verdict === 'PENDING');

  if (advisoryFailures.length) {
    console.log(`[e2e] advisory failures (do not fail the phase): ` +
      advisoryFailures.map((r) => r.spec.id).join(', '));
  }
  if (requiredPending.length) {
    console.log(`[e2e] required tests still PENDING: ${requiredPending.map((r) => r.spec.id).join(', ')}`);
  }
  const loggedErrors = snapshot.log.filter((e) => e.level === 'ERROR');
  if (loggedErrors.length) {
    console.error('[e2e] engine ERROR log entries:');
    for (const e of loggedErrors) console.error(`  ${e.source}: ${e.message} -> ${e.recovery ?? ''}`);
    exitCode = 1;
  }
  if (snapshot.integrityIssues.length) {
    console.error(`[e2e] evidence bundle integrity issues: ` +
      snapshot.integrityIssues.map((i) => `${i.path}=${i.problem}`).join(', '));
    exitCode = 1;
  }
  if (consoleErrors.length) {
    console.error('[e2e] console errors:');
    for (const e of consoleErrors) console.error(`  ${e}`);
    exitCode = 1;
  }
  if (requiredFailures.length) {
    console.error(`[e2e] REQUIRED FAILURES: ${requiredFailures.map((r) => r.spec.id).join(', ')}`);
    exitCode = 1;
  }
  if (bundle.leg !== 'DESKTOP_DEV') {
    console.error(`[e2e] leg misclassified as ${bundle.leg}; an automated run must never be REAL_DEVICE`);
    exitCode = 1;
  }
  if (bundle.overallVerdict === 'PASSED') {
    console.error('[e2e] the desktop leg reported PASSED — Rule 004 must prevent this');
    exitCode = 1;
  }

  console.log(`[e2e] evidence  : ${evidencePath}`);
  console.log(`[e2e] screenshot: ${shotPath}`);
  console.log(`[e2e] exit ${exitCode}`);
} catch (err) {
  console.error('[e2e] failed:', err);
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

// Make the summary readable by anything that wants to diff runs.
if (existsSync(join(OUT_DIR, 'phase0-desktop-chromium.json'))) {
  const b = JSON.parse(readFileSync(join(OUT_DIR, 'phase0-desktop-chromium.json'), 'utf-8'));
  writeFileSync(
    join(OUT_DIR, 'phase0-desktop-chromium.summary.txt'),
    [
      `leg: ${b.leg}`,
      `verdict: ${b.overallVerdict}`,
      `reason: ${b.overallReason}`,
      '',
      ...b.testResults.map((r) => `${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id} ${r.spec.title}`),
      '',
      ...b.capabilityMatrix.records.map((r) => `${r.state.padEnd(20)} ${r.method.padEnd(17)} ${r.id}`),
      '',
    ].join('\n'),
  );
}

process.exit(exitCode);
