#!/usr/bin/env node
/**
 * Phases 11–21 DESKTOP_DEV leg — from a landmark map to a ball through a ring (v4 §23–§53).
 *
 * ## What this leg films, and what it plays the part of
 *
 * A synthetic room (`lib/room.mjs`): floor, back wall, side walls and a table, ray-cast with the
 * app's own assumed intrinsics, filmed by a camera that turns and steps sideways. Headless Chromium
 * has no orientation sensor, so the harness dispatches the reading that camera would produce —
 * constant, because the camera only turns about the vertical (see `room.mjs` for why that is what
 * makes it honest to dispatch without knowing which frame Chrome is showing). Both are stimuli.
 * Everything downstream — the tracker, the map, the localization, gravity, the surfaces, the world,
 * the stage, the ring, the physics — is the real code measuring them.
 *
 * Rule 004 is untouched: this leg is `DESKTOP_DEV`, and no phase it visits can leave `TESTING`.
 *
 * ## The sequence
 *
 *  1. **Play, then save.** The play screen — the product, outside the Phase Lock — scans the room
 *     to READY and saves. Then the page is reloaded, which is the only honest test of a resume.
 *  2. **The ladder.** Phases 2–10 are climbed as every leg climbs them, and the lock in front of
 *     Phase 11 is checked on the control a person would use.
 *  3. **Phases 11–21**, each entered through its own gate with the desktop override and started
 *     with its own button. On Phase 14 the earlier save is resumed and a pause is taken; from Phase
 *     16 on, the harness throws the way a player does — press, watch the guide, release.
 *
 * ## The tripwires this leg owns
 *
 *  - World READY reached; gravity found under the layout Chrome actually delivers (0°).
 *  - Localization and the renderer's projection inside their bands, on the numbers.
 *  - Zero of everything that must never happen: illegal transitions, replay mismatches,
 *    collision violations, UI mismatches, draw violations, READY violations.
 *  - At least one goal, scored through the AR panel's own press and release.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, injectOrientation, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { writeY4M } from './lib/feed.mjs';
import { accelerationReading, orientationReading, renderRoomFrame } from './lib/room.mjs';
import { SPATIAL_LABELS } from './lib/spatialLabels.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const W = 480;
const H = 640;
const FRAMES = 240;
const VIDEO = join(ROOT, 'node_modules', '.cache', `room-v1-${W}x${H}-${FRAMES}.y4m`);
const READY_TIMEOUT_MS = 180_000;
const PHASE_HOLD_MS = 4_000;
const SETTLE_MS = 45_000;
/**
 * Records that cannot leave PENDING on this leg, by construction: AUDIT-001 needs every phase
 * PASSED, which Rule 004 forbids a desktop leg. Anything else still PENDING after the settle bound
 * is printed as PENDING with its reason.
 */
const EXPECTED_PENDING = new Set(['AUDIT-001']);

if (!existsSync(VIDEO)) {
  const t0 = Date.now();
  const { megabytes } = writeY4M(VIDEO, {
    width: W,
    height: H,
    frames: FRAMES,
    frame: (y, w, h, k) => renderRoomFrame(y, w, h, k, FRAMES),
  });
  console.log(`[spatial] rendered the room: ${W}x${H}, ${FRAMES} frames (${megabytes} MB) in ${Date.now() - t0} ms`);
} else {
  console.log(`[spatial] using the cached room ${VIDEO}`);
}
console.log('[spatial] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[spatial] serving ${url}`);

const orientation = orientationReading();
const acceleration = accelerationReading();
const problems = [];
const snapshots = new Map();
let errors = [];

const browser = await launch({ video: VIDEO });

async function worldReady(page, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    const s = await page.evaluate(() => {
      const v = window.__SPATIAL_DEBUG__.getWorldView();
      return { state: v.worldState, reasons: v.worldReasons };
    });
    if (s.state === 'READY') {
      console.log(`[spatial] ${label}: WORLD READY after ${Math.round((Date.now() - t0) / 1000)} s`);
      return true;
    }
    await page.waitForTimeout(2000);
  }
  const last = await page.evaluate(() => window.__SPATIAL_DEBUG__.getWorldView().worldReasons);
  console.log(`[spatial] ${label}: WORLD never READY — ${JSON.stringify(last)}`);
  return false;
}

/**
 * One throw, the way a player makes it: press on the camera view, watch the guide, release.
 * `wait` holds out for the moment the aim would score (for `waitMs`); otherwise the gauge is
 * released early.
 */
async function throwBall(page, wait, waitMs = 8000) {
  // A player waits for the ball to be on the tee; so does the harness — tracking can drop for a
  // moment, a stage can be regenerating.
  const ready = await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getGameView().state === 'READY',
    undefined,
    { timeout: 20_000 },
  ).then(() => true, () => false);
  if (!ready) return null;
  // The camera view has to be on screen to be pressed: pressing a start button below it scrolls
  // it up, and the first version of this leg pressed above the viewport and threw nothing at all.
  const stack = page.locator('#ar-stack');
  await stack.scrollIntoViewIfNeeded();
  const box = await stack.boundingBox();
  if (!box) return null;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const t0 = Date.now();
  let aimed = false;
  while (Date.now() - t0 < (wait ? waitMs : 700)) {
    if (await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameView().aimWouldScore)) {
      aimed = true;
      break;
    }
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForFunction(
    () => ['SUCCESS', 'RETRY'].includes(window.__SPATIAL_DEBUG__.getGameView().state),
    undefined,
    { timeout: 15_000 },
  ).catch(() => {});
  const result = await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameView().lastThrow);
  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getGameView().state === 'READY',
    undefined,
    { timeout: 8_000 },
  ).catch(() => {});
  return { aimed, result };
}

try {
  for (let n = 11; n <= 21; n++) mkdirSync(join(ROOT, 'docs', `phase${n}`, 'evidence'), { recursive: true });
  const app = await openApp(browser, url);
  const { context, page } = app;
  errors = app.errors;
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });
  await injectOrientation(page, orientation, acceleration);

  /* ---------------------------------------------------------------- 1. play, save, reload */
  await page.waitForFunction(() => !document.getElementById('open-play')?.disabled, undefined, { timeout: 20_000 });
  await page.click('#open-play');
  const confirmPlay = await pressStart(page, '#start-play', { idle: 'ゲーム開始', busy: 'プレイ中' });
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getWorldStats().reports > 0, undefined, { timeout: 30_000 });
  await confirmPlay();
  if (await worldReady(page, 'play')) {
    await page.waitForFunction(() => !document.getElementById('game-save')?.disabled, undefined, { timeout: 30_000 });
    await page.click('#game-save');
    const saved = await page.evaluate(() => localStorage.getItem('spatial-game-save-v1')?.length ?? 0);
    console.log(`[spatial] play: saved ${saved} bytes; reloading`);
    if (!(saved > 0)) problems.push('the play screen did not save');
  } else {
    problems.push('the play screen never reached WORLD READY');
  }
  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePlay());
  await page.reload({ waitUntil: 'domcontentloaded' });
  if (!(await page.evaluate(() => window.__SPATIAL_READY__))) throw new Error('app failed to restart after the reload');
  await injectOrientation(page, orientation, acceleration);

  /* ---------------------------------------------------------------- 2. the ladder */
  await climbTo(page, 11, { log: (n) => console.log(`[spatial] phase ${n} running`) });
  const gate = await expectLocked(page, 11, SPATIAL_LABELS[11].name);
  console.log(`[spatial] Phase Lock holds: ${gate.text}`);

  /* ---------------------------------------------------------------- 3. Phases 11–21 */
  for (let n = 11; n <= 21; n++) {
    if (n > 11) {
      const g = await expectLocked(page, n, SPATIAL_LABELS[n].name);
      console.log(`[spatial] Phase Lock holds in front of ${n}: ${g.text}`);
    }
    if (!(await page.evaluate((k) => window.__SPATIAL_DEBUG__[`enterPhase${k}`](true), n))) {
      throw new Error(`could not enter Phase ${n} even with the desktop override`);
    }
    const label = SPATIAL_LABELS[n];
    const confirm = await pressStart(page, label.start, { idle: label.idle, busy: label.busy });
    await page.waitForTimeout(800);
    await confirm();

    if (n === 11 && !(await worldReady(page, `phase ${n}`))) problems.push('Phase 11 never reached WORLD READY');

    if (n === 14) {
      // Resume the save the play screen made before the reload — before the first throw, which
      // is the only time a resume is allowed — then pause and resume in place, then save again.
      await page.waitForFunction(() => !document.getElementById('game-resume')?.disabled, undefined, { timeout: 15_000 })
        .catch(() => problems.push('the resume control never became pressable'));
      await page.click('#game-resume').catch(() => {});
      await worldReady(page, 'phase 14');
      await page.waitForTimeout(1500);
      await page.click('#game-pause');
      await page.waitForTimeout(1200);
      await page.click('#game-pause');
      await page.waitForTimeout(500);
      // Pressed until a save is recorded: the control is enabled only while there is something to
      // save, and the world can drop out of READY between the check and the press.
      for (let i = 0; i < 20; i++) {
        if ((await page.evaluate(() => window.__SPATIAL_DEBUG__.getSaveStats().saves)) > 0) break;
        await page.click('#game-save', { timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
      if ((await page.evaluate(() => window.__SPATIAL_DEBUG__.getSaveStats().saves)) === 0) {
        problems.push('no save was recorded on Phase 14');
      }
    }

    if (n >= 15 && n <= 20) {
      // Throw until this session has both a goal and a bounce — and at least twice on each screen.
      for (let attempt = 0; attempt < 14; attempt++) {
        const g = await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameStats());
        const bounced = g.throws.some((t) => t.contacts.length > 0);
        if (attempt >= 2 && g.successes > 0 && bounced) break;
        const t = await throwBall(page, !(g.successes > 0) || attempt % 3 !== 2);
        if (t?.result) console.log(`[spatial] phase ${n} throw: ${t.result.outcome}, ${t.result.contacts.length} contact(s)${t.aimed ? ', aimed by the guide' : ''}`);
        if (attempt === 6 && g.successes === 0) await page.click('#game-new-stage').catch(() => {});
      }
    }

    if (n === 20) {
      // §52's golden sequence has to run unbroken: a fresh stage, then ready → aim → throw →
      // success with nothing in between. The earlier goal may sit behind a pause or a tracking
      // drop, so ask for new stages until one is scored straight through.
      //
      // The feed's camera looks 15° down and never tilts up, so a launch along it — 14° above the
      // camera's forward — leaves the tee about level, and a wall target above the tee is out of
      // its reach (a player tilts the phone up). Those stages are passed over without a throw.
      for (let s = 0; s < 16; s++) {
        const pending = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPhase20Results()
          .some((r) => r.spec.id === 'PLAY-001' && r.verdict === 'PENDING'));
        if (!pending) break;
        await page.waitForFunction(() => !document.getElementById('game-new-stage')?.disabled, undefined, { timeout: 20_000 })
          .catch(() => {});
        await page.click('#game-new-stage').catch(() => {});
        const kind = await page.waitForFunction(() => {
          const v = window.__SPATIAL_DEBUG__.getGameView();
          return v.state === 'READY' && v.stage ? v.stage.ring.kind : null;
        }, undefined, { timeout: 20_000 }).then((h) => h.jsonValue(), () => null);
        if (kind !== 'HOOP') {
          console.log(`[spatial] phase 20 golden attempt ${s + 1}: ${kind ?? 'no stage'} — passed over`);
          continue;
        }
        const t = await throwBall(page, true, 20_000);
        if (t?.result) console.log(`[spatial] phase 20 golden attempt ${s + 1}: ${t.result.outcome}${t.aimed ? ', aimed by the guide' : ''}`);
        await page.waitForTimeout(1200);
      }
    }

    // Hold until the screen's required records have settled — or the bound runs out, in which case
    // whatever is still PENDING is reported as PENDING, never rounded up.
    await page.waitForTimeout(PHASE_HOLD_MS);
    const settleBy = Date.now() + SETTLE_MS;
    while (Date.now() < settleBy) {
      const pendingIds = await page.evaluate((k) => window.__SPATIAL_DEBUG__[`getPhase${k}Results`]()
        .filter((r) => r.spec.required && r.verdict === 'PENDING').map((r) => r.spec.id), n);
      if (pendingIds.every((id) => EXPECTED_PENDING.has(id))) break;
      await page.waitForTimeout(1000);
    }
    const snap = await page.evaluate((k) => ({
      results: window.__SPATIAL_DEBUG__[`getPhase${k}Results`](),
      evidence: window.__SPATIAL_DEBUG__[`getPhase${k}EvidenceJson`](),
      phase: window.__SPATIAL_DEBUG__[`getPhase${k}State`](),
    }), n);
    snapshots.set(n, snap);
    const dir = join(ROOT, 'docs', `phase${n}`, 'evidence');
    mkdirSync(dir, { recursive: true });
    if (snap.evidence) writeFileSync(join(dir, `phase${n}-desktop-chromium.json`), snap.evidence);
    await page.screenshot({ path: join(dir, `phase${n}-desktop-chromium.png`), fullPage: n === 11 || n === 20 });
    console.log(`[spatial] phase ${n}: ${snap.phase.state} — ${snap.phase.reason}`);
  }

  /* ---------------------------------------------------------------- the numbers */
  const final = await page.evaluate(() => ({
    world: window.__SPATIAL_DEBUG__.getWorldStats(),
    game: window.__SPATIAL_DEBUG__.getGameStats(),
    view: window.__SPATIAL_DEBUG__.getViewStats(),
    save: window.__SPATIAL_DEBUG__.getSaveStats(),
  }));
  const w = final.world;
  const g = final.game;
  const v = final.view;
  const s = final.save;
  console.log(`[spatial] localization: ${w.localized}/${w.reports} frames, median ${w.medianErrorPx} px, held-out ${w.medianHeldOutPx} px, keyframe agreement ${w.medianAgreementDeg}° / ${w.medianAgreementCenter}`);
  console.log(`[spatial] gravity: ${w.gravity.state} under ${w.gravity.candidateDeg}°, spread ${w.gravity.spreadDeg}° (runner-up ${w.gravity.runnerUpSpreadDeg}°) over ${w.gravity.diversityDeg}°`);
  console.log(`[spatial] surfaces: ${JSON.stringify(w.surfacesByClass)}; persistence ${w.persistenceFound}/${w.persistenceOffered}; control ${w.medianControlRatio}; camera height ${w.cameraHeight} of a depth ${w.sceneDepth}`);
  console.log(`[spatial] view: alignment ${v.medianAlignmentPx} px over ${v.alignmentReadings}; draw ${v.medianDrawMs} ms; ${v.drawViolations} draw / ${v.stateMismatches + v.trackingMismatches} UI violation(s)`);
  console.log(`[spatial] game: ${g.stagesGenerated} stage(s) ${JSON.stringify(g.difficulties)}, ${g.throwCount} throw(s), ${g.successes} goal(s), ${g.cycles} cycle(s); transitions ${g.transitionCount} (${g.illegalTransitions} illegal)`);
  console.log(`[spatial] save: ${s.saves} save(s), ${s.resumes} resume(s), ${s.pauseResumes} pause(s); ${s.lastResumeReason}`);

  if (w.gravity.state !== 'ESTIMATED') problems.push(`gravity ${w.gravity.state}`);
  else if (w.gravity.candidateDeg !== 0) problems.push(`gravity chose the ${w.gravity.candidateDeg}° layout; Chrome delivers the file unrotated`);
  else if (w.gravity.spreadDeg > 2) problems.push(`gravity spread ${w.gravity.spreadDeg}° on a synthetic sensor`);
  if (!(w.medianErrorPx >= 0 && w.medianErrorPx <= 1.5)) problems.push(`localization median ${w.medianErrorPx} px`);
  if (!(w.medianHeldOutPx >= 0 && w.medianHeldOutPx <= 2)) problems.push(`held-out median ${w.medianHeldOutPx} px`);
  if (!(v.medianAlignmentPx >= 0 && v.medianAlignmentPx <= 2)) problems.push(`renderer alignment ${v.medianAlignmentPx} px`);
  if (!w.surfacesByClass.GROUND) problems.push('no GROUND surface at the end of the run');
  for (const [k, val] of Object.entries({
    illegalTransitions: g.illegalTransitions, replayMismatches: g.replayMismatches, energyViolations: g.energyViolations,
    untracedContacts: g.untracedContacts, stepsWhileFrozen: g.stepsWhileFrozen, reproductionMismatches: g.reproductionMismatches,
    solutionFailures: g.solutionFailures, stageControlFailures: g.stageControlFailures, goalControlFailures: g.goalControlFailures,
    controlFailures: g.controlFailures, drawViolations: v.drawViolations, stateMismatches: v.stateMismatches,
    trackingMismatches: v.trackingMismatches, readyViolations: w.readyViolations, integrityIssues: w.integrityIssues,
    tamperAccepted: s.tamperAccepted, nonFiniteAccepted: s.nonFiniteAccepted, restoredUsedForCollision: s.restoredUsedForCollision,
    pauseResumeMismatches: s.pauseResumeMismatches,
  })) {
    if (val !== 0) problems.push(`${k} = ${val}`);
  }
  if (g.rejectionAccepted.length > 0) problems.push(`invalid rings accepted: ${g.rejectionAccepted.join('; ')}`);
  if (g.successes === 0) problems.push('no goal was scored');
  const golden = snapshots.get(20)?.results.find((r) => r.spec.id === 'PLAY-001');
  if (golden?.verdict !== 'PASS') problems.push(`§52's golden sequence was not played straight through: PLAY-001 ${golden?.verdict}`);
  if (s.resumes === 0) problems.push(`no resume: ${s.lastResumeReason}`);
  if (errors.length > 0) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}

/* -------------------------------------------------------------------- the verdicts */

console.log('\n=== PHASES 11–21 — DESKTOP_DEV LEG =====================================');
for (const [n, snap] of snapshots) {
  console.log(`--- Phase ${n}: ${snap.phase.state}`);
  for (const r of snap.results) {
    console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
    console.log(`             ${r.observed}`);
    if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
    if (r.spec.required && r.verdict === 'FAIL') problems.push(`${r.spec.id} FAIL: ${r.reason}`);
  }
  if (snap.phase.state === 'PASSED') problems.push(`Phase ${n} PASSED on a desktop leg — Rule 004 is broken`);
}

if (problems.length > 0) {
  console.error('\n[spatial] FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n[spatial] every tripwire held. Rule 004: these phases stay TESTING until a device runs them.');
