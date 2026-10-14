#!/usr/bin/env node
/**
 * The play screen, end to end — the product, outside the Phase Lock (v4 §52 as a player sees it).
 *
 * Its own browser and its own page: the first screen's `空間ボールゲームを開く`, then `ゲーム開始`,
 * the synthetic room (`lib/room.mjs`) and the harness-dispatched orientation sensor the spatial
 * leg uses. It scans to READY, throws the way a player does — press the camera view, watch the
 * guide, release — until it scores, and checks the HUD, the save and the invariants on the way.
 *
 * It evaluates no phase, and that is checked too: playing must not move any phase's state.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { injectOrientation, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { writeY4M } from './lib/feed.mjs';
import { accelerationReading, orientationReading, renderRoomFrame } from './lib/room.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'docs', 'phase20', 'evidence');
const W = 480;
const H = 640;
const FRAMES = 240;
const VIDEO = join(ROOT, 'node_modules', '.cache', `room-v1-${W}x${H}-${FRAMES}.y4m`);

if (!existsSync(VIDEO)) {
  writeY4M(VIDEO, { width: W, height: H, frames: FRAMES, frame: (y, w, h, k) => renderRoomFrame(y, w, h, k, FRAMES) });
}
if (!existsSync(join(DIST, 'index.html')) || process.argv.includes('--build')) {
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
}
mkdirSync(OUT, { recursive: true });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
const browser = await launch({ video: VIDEO });
const problems = [];
try {
  const { context, page, errors } = await openApp(browser, url);
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });
  await injectOrientation(page, orientationReading(), accelerationReading());
  await page.waitForFunction(() => !document.getElementById('open-play')?.disabled, undefined, { timeout: 20_000 });
  const phasesBefore = await page.evaluate(() => window.__SPATIAL_DEBUG__.getPhases().map((p) => p.state));
  await page.click('#open-play');
  const confirm = await pressStart(page, '#start-play', { idle: 'ゲーム開始', busy: 'プレイ中' });
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getWorldStats().reports > 0, undefined, { timeout: 30_000 });
  await confirm();

  const t0 = Date.now();
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getGameView().state === 'READY', undefined, { timeout: 180_000 })
    .catch(() => problems.push('the game never reached READY'));
  console.log(`[play] READY after ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.screenshot({ path: join(OUT, 'play-ready-desktop-chromium.png') });

  // The feed's camera looks 15° down and never tilts up, so a launch along it leaves the tee about
  // level and a wall target above the tee is out of its reach — a player would tilt the phone up.
  // Until the first goal, such stages are swapped with 別のステージ, as a player stuck on one would.
  let thrown = 0;
  for (let attempt = 0; attempt < 24 && thrown < 12; attempt++) {
    const g = await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameStats());
    if (g.successes > 0 && g.throws.some((t) => t.contacts.length > 0) && thrown >= 2) break;
    const v = await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameView());
    if (v.state !== 'READY') {
      await page.waitForTimeout(1000);
      continue;
    }
    if (g.successes === 0 && v.stage && v.stage.ring.kind !== 'HOOP') {
      console.log(`[play] stage ${v.stageIndex}: ${v.stage.ring.kind} — out of the feed's reach; 別のステージ`);
      await page.click('#game-new-stage').catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }
    const stack = page.locator('#ar-stack');
    await stack.scrollIntoViewIfNeeded();
    const box = await stack.boundingBox();
    if (!box) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const start = Date.now();
    const patient = g.successes === 0 && thrown % 3 !== 2;
    let aimed = false;
    while (Date.now() - start < (patient ? 20_000 : 600)) {
      if (await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameView().aimWouldScore)) {
        aimed = true;
        break;
      }
      await page.waitForTimeout(12);
    }
    await page.mouse.up();
    thrown++;
    if (thrown === 1) {
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(OUT, 'play-throw-desktop-chromium.png') });
    }
    await page.waitForFunction(() => ['SUCCESS', 'RETRY'].includes(window.__SPATIAL_DEBUG__.getGameView().state), undefined, { timeout: 15_000 }).catch(() => {});
    const last = await page.evaluate(() => window.__SPATIAL_DEBUG__.getGameView().lastThrow);
    console.log(`[play] throw ${thrown}: ${last?.outcome}, ${last?.contacts.length ?? 0} contact(s)${aimed ? ', aimed by the guide' : ''}`);
    if (last?.outcome === 'GOAL') await page.screenshot({ path: join(OUT, 'play-success-desktop-chromium.png') });
    await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getGameView().state === 'READY', undefined, { timeout: 10_000 }).catch(() => {});
    // A patient throw the guide never lined up: this stage's ring is where the feed's sweep does
    // not look. Swap it, as a player would.
    if (patient && !aimed && last?.outcome !== 'GOAL') await page.click('#game-new-stage').catch(() => {});
  }

  await page.click('#game-save').catch(() => problems.push('save not pressable'));
  const s = await page.evaluate(() => ({
    game: window.__SPATIAL_DEBUG__.getGameStats(),
    view: window.__SPATIAL_DEBUG__.getViewStats(),
    world: window.__SPATIAL_DEBUG__.getWorldStats(),
    save: window.__SPATIAL_DEBUG__.getSaveStats(),
    phases: window.__SPATIAL_DEBUG__.getPhases().map((p) => p.state),
  }));
  console.log(`[play] ${s.game.throwCount} throw(s), ${s.game.successes} goal(s); states ${s.game.visited.join(' → ')}`);
  console.log(`[play] world: localization ${s.world.medianErrorPx} px; gravity ${s.world.gravity.state} ${s.world.gravity.spreadDeg}°; surfaces ${JSON.stringify(s.world.surfacesByClass)}`);
  console.log(`[play] view: alignment ${s.view.medianAlignmentPx} px; ${s.view.stateMismatches + s.view.trackingMismatches} UI mismatch(es); ${s.view.drawViolations} draw violation(s)`);
  if (s.game.successes === 0) problems.push('no goal scored');
  if (s.game.illegalTransitions > 0) problems.push(`${s.game.illegalTransitions} illegal transition(s)`);
  if (s.game.replayMismatches > 0) problems.push(`${s.game.replayMismatches} replay mismatch(es)`);
  if (s.view.stateMismatches + s.view.trackingMismatches > 0) problems.push(`HUD mismatches: ${s.view.uiMismatchDetail}`);
  if (s.view.drawViolations > 0) problems.push(`draw violations: ${s.view.drawViolationDetail}`);
  if (s.save.saves === 0 || s.save.roundTripFailures > 0 || s.save.tamperAccepted > 0) problems.push(`save: ${JSON.stringify(s.save)}`);
  if (JSON.stringify(s.phases) !== JSON.stringify(phasesBefore)) problems.push('playing moved a phase state — the play screen must evaluate no phase');
  if (errors.length > 0) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}
if (problems.length > 0) {
  console.error('[play] FAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('[play] the game was played end to end on the real stack; no phase was evaluated by it.');
