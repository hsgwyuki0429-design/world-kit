#!/usr/bin/env node
/**
 * The play screen on a feed a phone in a hand would film — the failures the smooth feed cannot
 * show, watched from the first frame.
 *
 *  - `--feed=rough` (default): the room with its view wiped out for a quarter of a second every
 *    four seconds (`lib/room.mjs`, `renderRoughRoomFrame`), which is how a blur breaks every track
 *    at once.
 *  - `--feed=handheld`: sweeps through thirty degrees each way, shakes at three and five hertz,
 *    whips the phone away and back (smearing the frames between), loses whole frames to blur, and
 *    flickers in exposure with sensor noise on top (`renderHandheldFrame`). A harsher feed than
 *    the rough one, and the nearest the desktop gets to the first two device reports.
 *
 * It scans, watches for `OBSERVE_S` seconds and counts what a player would have seen: how long
 * tracking was `LOST` and for how long at a stretch, how often the world was redefined (which
 * drops the stage), and how often the camera was found again.
 *
 * `--report-only` prints the numbers without judging them.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { injectOrientation, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { writeY4M } from './lib/feed.mjs';
import {
  DROPOUT_EVERY,
  accelerationReading,
  orientationReading,
  renderHandheldFrame,
  renderRoughRoomFrame,
} from './lib/room.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const W = 480;
const H = 640;
const FRAMES = 240;
const FEED = (process.argv.find((a) => a.startsWith('--feed=')) ?? '--feed=rough').slice('--feed='.length);
/**
 * What each feed is held to. The bounds are set from measurement, with room: on the handheld feed
 * the first version of the stage was in `LOST` for a third of a minute and redefined the world twice.
 */
const FEEDS = {
  rough: {
    render: renderRoughRoomFrame,
    maxLostShare: 0.1,
    maxLostStretchS: 1.5,
    maxRedefinitions: 0,
    minGoodShare: 0.5,
    needRecovered: true,
    needReady: true,
    readyWaitS: 240,
  },
  handheld: {
    render: renderHandheldFrame,
    // Judged on what is the same from run to run: how long the camera was lost, and whether the
    // world was redefined. Whether the stage appears is not — the feed's wall-clock loop makes each
    // run build a different map, and on this feed the estimate of down is the slow part (the motion
    // is yaw-only, so the four image layouts are told apart by how far the camera turned, and the
    // map drifts as it is built); it is reported, not gated.
    maxLostShare: 0.1,
    maxLostStretchS: 3,
    maxRedefinitions: 0,
    minGoodShare: 0,
    needRecovered: false,
    needReady: false,
    readyWaitS: 20,
  },
};
const FEED_SPEC = FEEDS[FEED];
if (!FEED_SPEC) throw new Error(`unknown feed "${FEED}" — expected rough or handheld`);
const VIDEO = join(ROOT, 'node_modules', '.cache', `room-${FEED}-v1-${W}x${H}-${FRAMES}.y4m`);
const OBSERVE_S = 60;
const REPORT_ONLY = process.argv.includes('--report-only');

if (!existsSync(VIDEO)) {
  writeY4M(VIDEO, { width: W, height: H, frames: FRAMES, frame: (y, w, h, k) => FEED_SPEC.render(y, w, h, k, FRAMES) });
}
if (!existsSync(join(DIST, 'index.html')) || process.argv.includes('--build')) {
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
const browser = await launch({ video: VIDEO });
const problems = [];
let summary = null;
try {
  const { context, page, errors } = await openApp(browser, url);
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });
  await injectOrientation(page, orientationReading(), accelerationReading());
  await page.waitForFunction(() => !document.getElementById('open-play')?.disabled, undefined, { timeout: 20_000 });
  await page.click('#open-play');
  const confirm = await pressStart(page, '#start-play', { idle: 'ゲーム開始', busy: 'プレイ中' });
  await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getWorldStats().reports > 0, undefined, { timeout: 30_000 });
  await confirm();

  const t0 = Date.now();
  // Watched from the first frame: the world is most fragile while it is young, and the first
  // version of this leg looked only after READY and missed four redefinitions before it.
  const ready = await page.waitForFunction(() => window.__SPATIAL_DEBUG__.getGameView().state === 'READY', undefined, { timeout: FEED_SPEC.readyWaitS * 1000 })
    .then(() => true, () => false);
  console.log(`[${FEED}] ${ready ? `READY after ${Math.round((Date.now() - t0) / 1000)} s` : 'never READY'}`);
  if (!ready && FEED_SPEC.needReady) problems.push(`the game never reached READY on the ${FEED} feed`);

  const before = await page.evaluate(() => ({ game: window.__SPATIAL_DEBUG__.getGameStats(), world: window.__SPATIAL_DEBUG__.getWorldStats() }));
  const tracking = {};
  const game = {};
  const end = Date.now() + OBSERVE_S * 1000;
  while (Date.now() < end) {
    const s = await page.evaluate(() => {
      const v = window.__SPATIAL_DEBUG__.getWorldView();
      return { tracking: v.trackingState, game: window.__SPATIAL_DEBUG__.getGameView().state };
    });
    tracking[s.tracking] = (tracking[s.tracking] ?? 0) + 1;
    game[s.game] = (game[s.game] ?? 0) + 1;
    await page.waitForTimeout(250);
  }
  const after = await page.evaluate(() => ({ game: window.__SPATIAL_DEBUG__.getGameStats(), world: window.__SPATIAL_DEBUG__.getWorldStats() }));
  const diag = await page.evaluate(() => window.__SPATIAL_DEBUG__.getDiagnostics().report);
  const d = (k, from = 'game') => (after[from][k] ?? 0) - (before[from][k] ?? 0);
  summary = {
    observedS: OBSERVE_S,
    dropouts: Math.floor((OBSERVE_S * 30) / DROPOUT_EVERY),
    lostEntries: d('lostEntries'),
    lostRecoveries: d('lostRecoveries'),
    worldRedefinedUnderStage: d('epochInvalidations'),
    epochChanges: d('epochChanges', 'world'),
    reports: d('reports', 'world'),
    localized: d('localized', 'world'),
    recovered: after.world.recovered === undefined ? 'n/a (build has no re-linking)' : d('recovered', 'world'),
    relinked: after.world.relinked === undefined ? 'n/a' : d('relinked', 'world'),
    longestUnlocalizedRun: after.world.longestUnlocalizedRun ?? 'n/a',
    trackingSamples: tracking,
    gameSamples: game,
    sessionLostS: diag.session.lostS,
    sessionLongestLostS: diag.session.longestLostS,
    sessionGoodS: diag.session.goodS,
    sessionTotalS: diag.session.totalS,
    worldRedefinitions: diag.map.epochChanges,
  };
  console.log(`[${FEED}] ${JSON.stringify(summary)}`);
  if (errors.length > 0) problems.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  server.close();
}

if (!REPORT_ONLY && summary) {
  if (summary.lostEntries > 0) problems.push(`play froze on TRACKING LOST ${summary.lostEntries} time(s) in ${OBSERVE_S} s`);
  if (summary.worldRedefinedUnderStage > 0) problems.push(`the world was redefined under the stage ${summary.worldRedefinedUnderStage} time(s)`);
  // The whole session, from the first frame: a camera that is lost for seconds at a time while
  // the map is young is the report this leg exists for.
  const spec = FEED_SPEC;
  if (summary.worldRedefinitions > spec.maxRedefinitions) problems.push(`the world was redefined ${summary.worldRedefinitions} time(s) in ${summary.sessionTotalS} s`);
  if (summary.sessionLongestLostS > spec.maxLostStretchS) problems.push(`tracking was LOST for ${summary.sessionLongestLostS} s at a stretch`);
  if (summary.sessionLostS > spec.maxLostShare * summary.sessionTotalS) problems.push(`tracking was LOST for ${summary.sessionLostS} of ${summary.sessionTotalS} s`);
  if (summary.sessionGoodS < spec.minGoodShare * summary.sessionTotalS) problems.push(`tracking was GOOD for only ${summary.sessionGoodS} of ${summary.sessionTotalS} s`);
  if (spec.needRecovered && !(summary.recovered > 0)) problems.push('no frame was recovered by re-linking — the dropouts were not exercised');
  if (FEED === 'rough' && !(summary.localized / summary.reports >= 0.8)) problems.push(`only ${summary.localized}/${summary.reports} frames localized`);
}
if (problems.length > 0) {
  console.error(`[${FEED}] FAILED:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(REPORT_ONLY ? `[${FEED}] measured (report only).` : `[${FEED}] tracking held on the ${FEED} feed.`);
