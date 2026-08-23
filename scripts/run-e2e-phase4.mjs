#!/usr/bin/env node
/**
 * Phase 4 DESKTOP_DEV leg — optical flow tracking (§12, §13, §65).
 *
 * ## What this leg can decide, and why it is more than Phase 3's could
 *
 * Phase 3's leg had to exclude the three tests that carry its meaning, because Chromium's
 * built-in fake camera is a rolling gradient: neither a textured wall nor a blank one, so the
 * classes FEAT-001 and FEAT-002 judge simply never occurred.
 *
 * Phase 4's classes are about **motion**, and motion is something a video file can contain
 * exactly. So this leg builds its own camera feed: a texture that pans by a known number of
 * pixels per frame, holds still for a while, sweeps fast, and goes black for a moment. Each
 * of §65's five conditions except the rotation is present in the pixels, measured from them
 * by the same classifier the device uses, and judged by the same suite.
 *
 * That makes the one gate this phase exists for decidable off the device:
 *
 *   > over frames where the image demonstrably moved, does the tracker's displacement agree
 *   > with an independent measurement of the scene's motion?
 *
 * A tracker that returns its input reports zero while the search reports the real motion, and
 * this leg fails. `tests/unit/flowTracker.test.ts` proves the same thing in Node against the
 * same code; this proves it through the real `video → VideoFrame → worker → pyramid` path,
 * which §H.7 records as the one place unit tests cannot reach.
 *
 * ## What it still cannot decide
 *
 *  - **Rule 004 stands.** This is `DESKTOP_DEV`; nothing here passes a phase. What it does is
 *    catch a regression in the tracker, the state machine or the harness on every build.
 *  - **FLOW-003** needs the device's gyroscope. Headless Chromium has none, the test reports
 *    PENDING with that reason, and it is excluded here rather than counted as decided.
 *  - **FLOW-006** measures this machine against a budget written for the iPhone, exactly as
 *    FEAT-005 did. Its verdict is printed and a separate, explicitly wider configuration
 *    tripwire gates instead — see FLOW_COST_CEILING_MS.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { writeY4M } from './lib/feed.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase4', 'evidence');
const VIDEO = join(ROOT, 'node_modules', '.cache', 'flow-motion.y4m');

/** Long enough for every motion class in the loop to reach its minimum several times over. */
const TRACK_MS = 32_000;

const W = 640;
const H = 480;

/**
 * The loop, in frames. Each segment is a condition §65 names, present in the pixels.
 *
 * The texture is periodic in x with period `PERIOD`, and the slow segments pan by exactly
 * `PERIOD` in total, so the loop closes without a seam except where one is wanted: the black
 * segment, which is the covered lens, and the fast sweep, which is the motion a 21 px window
 * cannot span.
 */
const PERIOD = 128;
const SEGMENTS = [
  { name: 'static', frames: 24, panPerFrame: 0, dark: false },
  { name: 'slow-pan', frames: 16, panPerFrame: 4, dark: false },
  { name: 'fast-sweep', frames: 8, panPerFrame: 22, dark: false },
  // Twenty, not twelve: the fake camera plays the file at its own rate while the pipeline
  // samples at its own, so a twelve-frame segment reached the tracker as nine and FLOW-005's
  // ten-frame minimum was never met. The criterion is not the thing to move.
  { name: 'occluded', frames: 20, panPerFrame: 0, dark: true },
  { name: 'slow-pan', frames: 16, panPerFrame: 4, dark: false },
];

/**
 * The cost above which this leg calls a regression — NOT FLOW-006's criterion.
 *
 * FLOW-006 gates on §H's 14 ms budget for the iPhone's tracking worker. This runs on headless
 * Chromium with SwiftShader on a shared CPU, so a cost measured here says nothing about
 * whether the device meets that budget — the same distinction §H.4 draws and the same one
 * Phase 3's leg made for FEAT-005. The number below is a configuration tripwire: it sits far
 * enough above the observed spread to survive machine variance, and far enough below what a
 * genuine configuration error costs (a solver that stopped reusing the structure tensor
 * across iterations, or one that lost the pyramid and searched at level 0 alone) to catch it.
 */
const FLOW_COST_CEILING_MS = 90.0;

/** Texture with structure at every scale, periodic in x so the pan loops seamlessly. */
function luma(x, y) {
  const k = (2 * Math.PI) / PERIOD;
  const v =
    128 +
    46 * Math.sin(k * x) * Math.cos(y * 0.031 + 0.3) +
    32 * Math.sin(3 * k * x + y * 0.047) +
    26 * Math.cos(5 * k * x - y * 0.019 + 1.1) +
    20 * Math.sin(11 * k * x + 0.7) * Math.sin(y * 0.11) +
    14 * Math.cos(21 * k * x + y * 0.19);
  return Math.max(0, Math.min(255, Math.round(v)));
}

function buildY4M() {
  // The pan is a shift, so every frame is the same field read from a different origin.
  let offset = 0;
  let si = 0;
  let left = SEGMENTS[0].frames;
  const { frames, megabytes } = writeY4M(VIDEO, {
    width: W,
    height: H,
    frames: SEGMENTS.reduce((a, s) => a + s.frames, 0),
    frame: (y) => {
      const seg = SEGMENTS[si];
      if (seg.dark) {
        // FLOW-004's occlusion: a frame with no gradient anywhere, not a blurred one.
        y.fill(6);
      } else {
        for (let yy = 0; yy < H; yy++) {
          const row = yy * W;
          for (let xx = 0; xx < W; xx++) y[row + xx] = luma(xx + offset, yy);
        }
        offset += seg.panPerFrame;
      }
      if (--left === 0 && si + 1 < SEGMENTS.length) left = SEGMENTS[++si].frames;
    },
  });
  console.log(
    `[p4] wrote ${W}x${H}, ${frames} frames (${megabytes} MB): ` +
      SEGMENTS.map((s) => `${s.frames}× ${s.name}`).join(', '),
  );
}

buildY4M();
console.log('[p4] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p4] serving ${url}`);
mkdirSync(OUT_DIR, { recursive: true });

let exitCode = 0;
/** Tests this leg cannot decide, each with the reason that applies to it specifically. */
const excluded = new Map();

const browser = await launch({ video: VIDEO });

let snap;
let errors = [];

try {
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  // Take the device's path, all the way: every phase below this one is left running,
  // because that is the state a device arrives in. `climbTo` presses the same controls a
  // person presses on each rung — reaching past them is what §H.5 records at length.
  await climbTo(page, 4, (n) => console.log(`[p4] phase ${n} running`));
  // Phase Lock, on the control a person would use. Phase 3 cannot pass on this leg (Rule 004),
  // so the door to Phase 4 must be shut and must say why.
  const gate = await expectLocked(page, 4, 'GO TO TRACKING');
  console.log(`[p4] Phase Lock holds: ${gate.text}`);

  const handover = await page.evaluate(() => ({
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    detections: window.__SPATIAL_DEBUG__.getTrackingStats().detections,
  }));
  console.log(
    `[p4] handing over ${handover.pipeline.completed} preprocessed frames, ` +
      `${handover.detections} detections, ${handover.pipeline.stressPasses} stress pass(es), ` +
      `tier ${handover.pipeline.tierLabel}`,
  );

  const entered = await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase4(true));
  if (!entered) throw new Error('could not enter Phase 4 even with the desktop override');

  // Press the control a person presses. There is deliberately no `startTracking()` in the
  // debug API: reaching past the DOM is how Phase 3's leg missed a button that had become
  // *unpressable* while the engine behind it was perfectly reachable, twice.
  const confirmRunning = await pressStart(page, '#start-tracking', {
    idle: 'START TRACKING',
    busy: 'TRACKING',
  });

  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getFlowStats().flowFrames > 0, undefined, {
    timeout: 25_000,
  });

  await confirmRunning();

  const afterStart = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPipelineStats());
  if (afterStart.stressPasses !== 0) {
    throw new Error(
      `tracking started with ${afterStart.stressPasses} stress pass(es) still injected — ` +
        'stress moves the tier, and the tier sets the resolution the flow is solved at',
    );
  }

  console.log(`[p4] holding for ${TRACK_MS / 1000} s…`);
  await page.waitForTimeout(TRACK_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase4Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase4EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getFlowStats(),
    rotation: window.__SPATIAL_DEBUG__.getRotation(),
    phase: window.__SPATIAL_DEBUG__.getPhase4State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    alignment: window.__SPATIAL_DEBUG__.getOverlayAlignment(),
  }));

  writeFileSync(join(OUT_DIR, 'phase4-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase4-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p4] ${s.flowFrames} flow frames, ${s.trackedFrames} with a predecessor; ` +
      `${s.cumulativeTracked} tracked + ${s.cumulativeRedetected} redetected over the run ` +
      `(last frame ${s.tracked} + ${s.redetected} = ${s.total})`,
  );
  const cls = (c) => `${c.framesSeen} (${c.frames} judged)`;
  console.log(
    `[p4] motion classes: static ${cls(s.staticFrames)}, slow ${cls(s.slowFrames)}, ` +
      `fast ${cls(s.fastFrames)}, occluded ${cls(s.occludedFrames)}, ` +
      `indeterminate ${s.indeterminateFrames}`,
  );
  console.log(
    `[p4] refill: median ${s.medianDetectionOffered} offered — ` +
      `${s.medianDeclinedTooClose} already tracked, ` +
      `${s.medianDeclinedOutOfReach} out of the solver's reach, ` +
      `${s.medianDetectionOffered - s.medianDeclinedTooClose - s.medianDeclinedOutOfReach} admitted`,
  );
  console.log(
    `[p4] cross-check: ${s.shiftCheckCount} pairs, tracker ${s.medianTrackedDisplacementPx} px ` +
      `vs image ${s.medianMeasuredShiftPx} px, median disagreement ` +
      `${s.medianShiftDisagreementPx} px, ${Math.round(s.shiftAgreementRate * 1000) / 10}% agreeing`,
  );
  console.log(
    `[p4] §13: ${s.fbAcceptable} acceptable, ${s.fbReduced} reduced, ${s.fbRejected} rejected; ` +
      `median ${s.medianFbErrorPx} px`,
  );
  console.log(
    `[p4] §33: states ${JSON.stringify(s.stateFrames)}, ${s.stateMismatches} mismatch(es); ` +
      `longest track ${s.maxTrackLength} frames; ${s.geometryChanges} geometry change(s)`,
  );
  console.log(
    `[p4] occlusions: ${s.occlusions.length} episode(s) — ` +
      (s.occlusions.length > 0
        ? s.occlusions
            .slice(-3)
            .map((e) => `${e.frames}f LOST+${e.msToLost}ms ${e.recovered ? 'recovered' : 'STUCK'}`)
            .join(', ')
        : 'none'),
  );
  console.log(
    `[p4] cost: ${s.meanFlowMs} ms LK at ${s.meanTrackedPoints} points, ` +
      `${s.meanShiftMs} ms scene search, tier ${snap.pipeline.tierLabel}`,
  );
  console.log(`[p4] gyroscope: ${snap.rotation.source} — ${snap.rotation.detail}`);

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase4());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 4 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p4] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

// FLOW-003 needs the device's own gyroscope as a second independent instrument. Headless
// Chromium has none, so the test says PENDING with that reason and it is excluded here rather
// than counted as decided. The device run decides it.
excluded.set(
  'FLOW-003',
  `headless Chromium delivers no devicemotion events (${snap.rotation.source}: ` +
    `${snap.rotation.detail}), and FLOW-003 is defined against the device's own rotation`,
);

// Any class the synthetic feed did not actually produce is excluded with its own count,
// rather than the leg pretending the condition occurred.
for (const [id, key, label] of [
  ['FLOW-001', 'staticFrames', 'static'],
  ['FLOW-004', 'fastFrames', 'fast'],
]) {
  if (s[key].frames < 15) {
    excluded.set(
      id,
      `the feed produced only ${s[key].frames} judgeable ${label} frames — the fake camera plays the ` +
        'generated file at its own rate, so a segment can be sampled away',
    );
  }
}
if (s.fastFrames.frames >= 15 && s.slowFrames.frames < 15) {
  excluded.set('FLOW-004', 'the comparison needs slow frames to compare against, and there were none');
}
if (!s.occlusions.some((e) => e.frames >= 10)) {
  excluded.set(
    'FLOW-005',
    `no occlusion episode reached 10 frames (longest ` +
      `${Math.max(0, ...s.occlusions.map((e) => e.frames))}) — the black segment was sampled away`,
  );
}

// FLOW-006's own verdict stays printed above and stays in the bundle; it is simply not this
// leg's to decide, for the reason given at FLOW_COST_CEILING_MS. The tripwire below is a
// separate check with its own name and its own number.
excluded.set(
  'FLOW-006',
  `it gates on §H's 14 ms budget for the iPhone's tracking worker, and this is headless ` +
    `Chromium with SwiftShader on a shared CPU — ${s.meanFlowMs} ms here measures this ` +
    'machine, not the device. The device run decides it',
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p4] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p4]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p4] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p4] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns, each with its own name and its own number   */
/* ------------------------------------------------------------------ */

// Rule 002, in one line: the screen reports TRACKING from the same predicate this reads, so a
// run that claims to be tracking and has tracked nothing is the UI and the engine disagreeing.
if (s.running && s.flowFrames === 0) {
  console.error(
    `[p4] the screen reported TRACKING for the whole ${TRACK_MS / 1000} s hold and optical ` +
      'flow ran on 0 frames — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// The anti-fake gate, as a tripwire the leg states in its own terms rather than inheriting
// from FLOW-002's verdict. This is the whole reason the leg generates its own feed: the image
// demonstrably moves, and a tracker that returned its input would report zero here while the
// independent search reported the real motion.
if (s.shiftCheckCount < 10) {
  console.error(
    `[p4] only ${s.shiftCheckCount} paired cross-checks — the generated feed pans by design, ` +
      'so too few means the scene-shift search is not reading it and the gate is not armed',
  );
  exitCode = 1;
} else if (s.medianMeasuredShiftPx < 1.0) {
  console.error(
    `[p4] the independent search measured ${s.medianMeasuredShiftPx} px of motion on a feed ` +
      'that pans 4 px per frame by construction — the search, not the tracker, is wrong',
  );
  exitCode = 1;
} else if (s.medianTrackedDisplacementPx < 1.0) {
  console.error(
    `[p4] the tracker reports ${s.medianTrackedDisplacementPx} px of displacement while the ` +
      `image moved ${s.medianMeasuredShiftPx} px — this is the signature of a tracker that ` +
      'returns its input, and no statistic computed from its own output would show it',
  );
  exitCode = 1;
} else {
  console.log(
    `[p4] anti-fake gate armed and passed: tracker ${s.medianTrackedDisplacementPx} px vs ` +
      `image ${s.medianMeasuredShiftPx} px over ${s.shiftCheckCount} pairs`,
  );
}

// Rule 002 again, at frame granularity: the state and the numbers it was derived from are
// re-checked against each other on every frame.
if (s.stateMismatches > 0) {
  console.error(
    `[p4] ${s.stateMismatches} frame(s) reported a §33 state that disagreed with their own ` +
      'measured inputs (Rule 002)',
  );
  exitCode = 1;
}

// §80: GOOD needs an inlier ratio and a reprojection error, and Phases 5 and 6 do not exist.
// A run that reached GOOD reached it by dropping two of §33's three conditions.
if ((s.stateFrames.GOOD ?? 0) > 0) {
  console.error(
    `[p4] the state reached GOOD on ${s.stateFrames.GOOD} frame(s) — §33 makes GOOD three ` +
      'conjuncts and two of them are Phase 5\'s and Phase 6\'s, so this is a claim about ' +
      'measurements that do not exist (§80)',
  );
  exitCode = 1;
}

// The overlay alignment probe carries over from Phase 3 (§H.5) and Phase 4 needs its answer
// more than Phase 3 did — every displacement above is measured in the acquired buffer's frame,
// so a buffer rotated against the video corrupts all of them while every average-based check
// still passes (§H.7).
//
// **But this leg cannot arm it, and says so rather than reading its output.** The probe scores
// the detected positions against an independent read of the video under each transform, and it
// can only discriminate when the scene has landmarks a rotation would move somewhere noticeable.
// The feed generated here is periodic in x by construction — it has to be, so the pan loops
// seamlessly — and it is densely textured, so *every* transform lands on corner-like pixels and
// all seven scores fall within a factor of 1.3 of each other. Measured on the first run of this
// leg: identity 1117, rot180 1412, identity/random 0.93. Reading "rot180" out of that would be
// reading noise, and gating on it would fail a working build.
//
// `scripts/run-e2e-phase3-alignment.mjs` is the leg that decides this, with a fixture built for
// it: three bright blocks and one deliberately empty quadrant, so no rotation or reflection maps
// the set onto itself. It scored identity at 70x random.
if (snap.alignment) {
  // `bestOverRandom` is the probe's own statement of whether it could tell the transforms
  // apart at all, and it is the same field `isMisoriented` now requires before the app will
  // abandon an acquisition route.
  const armed = snap.alignment.measurable && snap.alignment.bestOverRandom >= 2.0;
  console.log(
    `[p4] overlay alignment: best ${snap.alignment.best}, identity/random ` +
      `${snap.alignment.identityOverRandom.toFixed(2)}x, best/random ` +
      `${snap.alignment.bestOverRandom.toFixed(2)}x — ` +
      (armed
        ? 'the probe had discrimination on this feed'
        : 'NOT ARMED on this feed (a periodic, densely textured pan gives every transform the ' +
          'same score); run-e2e-phase3-alignment.mjs is the leg that decides orientation'),
  );
  if (armed && snap.alignment.best !== 'identity') {
    console.error(
      `[p4] the probe had discrimination and still says the acquired buffer matches the video ` +
        `under ${snap.alignment.best} rather than identity — Phase 4's displacements are ` +
        'measured in that buffer',
    );
    exitCode = 1;
  }
}

// The configuration tripwire that replaces FLOW-006 on this leg.
if (s.meanFlowMs > FLOW_COST_CEILING_MS) {
  console.error(
    `[p4] the LK solve cost ${s.meanFlowMs} ms at ${s.meanTrackedPoints} points, over this ` +
      `leg's ${FLOW_COST_CEILING_MS} ms regression ceiling — that is not budget variance, it ` +
      'is the shape of a solver that stopped reusing the structure tensor or lost its pyramid',
  );
  exitCode = 1;
} else {
  console.log(
    `[p4] LK solve ${s.meanFlowMs} ms at ${s.meanTrackedPoints} points, under this leg's ` +
      `${FLOW_COST_CEILING_MS} ms regression ceiling (FLOW-006's 14 ms budget is the device's ` +
      'to answer)',
  );
}

console.log(`[p4] evidence: ${OUT_DIR}`);
console.log(`[p4] exit ${exitCode}`);
process.exit(exitCode);
