/**
 * What every automated leg does before it can measure anything.
 *
 * Eight legs each carried a byte-identical `serve` and MIME table, six built the same phone
 * context, and five walked the same ladder of screens to reach the phase under test. All of it
 * is here, moved rather than rewritten.
 *
 * The launch arguments were spelled out eight times in four combinations, and **the differences
 * between them are load-bearing in exactly one place**: Phase 1's denial run must not carry
 * `--use-fake-ui-for-media-stream`, because CAM-002 is about a refusal and a flag that answers
 * the prompt with yes would make it measure nothing. So `launch` takes the differences as
 * parameters, and the argument lists it produces are identical, argument for argument, to the
 * eight it replaced.
 *
 * ## The ladder is the important one
 *
 * `climbTo` is not convenience. §H.5 records what it cost to skip it: on a device, Phase 6 is
 * reached from a screen whose camera, pipeline, detector, tracker and verifier are all *already
 * running*, because that is how Phase 5 passes. A leg that enters a phase cold exercises a
 * sequence no device ever takes — and twice, that difference was a control the engine answered
 * for while nobody could press it. So each leg climbs the same rungs a person climbs, pressing
 * the same buttons, and this function is the one place that sequence is written down.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

export const CHROMIUM = '/opt/pw-browsers/chromium';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Serve `dir` on an ephemeral port, falling back to `index.html` for unknown paths.
 *
 * The fallback is what makes a single-page app work under a plain file server; it is not a
 * routing feature and nothing in this project depends on it beyond that.
 */
export function serve(dir) {
  return new Promise((res) => {
    const server = createServer((req, r) => {
      const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
      let f = join(dir, p === '/' ? 'index.html' : p);
      if (!existsSync(f)) f = join(dir, 'index.html');
      r.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
      createReadStream(f).pipe(r);
    });
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

/**
 * Launch Chromium, optionally playing a Y4M file through the synthetic camera.
 *
 * `autoGrant` adds `--use-fake-ui-for-media-stream`, which answers the permission prompt with
 * yes. **Phase 1's denial run must not have it**, and that is not a detail: CAM-002 is about
 * what the app does when a user says no, and a flag that says yes for them would make the run
 * measure nothing. It is a parameter rather than a default for that one leg's sake.
 *
 * The pre-installed binary is used when it is there and Playwright's own is used otherwise, so
 * the legs run both in this container and on a developer's machine.
 */
export function launch({ video = null, autoGrant = true, device = true, args = [] } = {}) {
  return chromium.launch({
    executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined,
    args: [
      '--enable-unsafe-swiftshader',
      ...(device ? ['--use-fake-device-for-media-stream'] : []),
      ...(autoGrant ? ['--use-fake-ui-for-media-stream'] : []),
      ...(video ? [`--use-file-for-fake-video-capture=${video}`] : []),
      ...args,
    ],
  });
}

/**
 * A phone-shaped context with the app loaded and its console piped into `errors`.
 *
 * The viewport is a real iPhone's, in portrait, with `isMobile` and `hasTouch` set — not for
 * looks: §H.0 makes the intrinsics a function of the frame dimensions, and a desktop-shaped
 * viewport would exercise a geometry the device never sees.
 */
export async function openApp(browser, url, { mobile = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const ok = await page.evaluate(() => window.__SPATIAL_READY__);
  if (!ok) throw new Error('app failed to start');
  return { context, page, errors };
}

/**
 * One rung of the ladder: enter the phase, start it, wait for it to be doing something.
 *
 * `start` is a DOM selector wherever the screen has a button, because pressing the control a
 * person presses is the whole point — reaching past it into the debug API is how Phase 3's leg
 * twice certified a screen whose button could not be pressed while the engine behind it
 * answered perfectly well (§H.5). Phase 2 is the exception and says so: its pipeline is started
 * through `startPipeline()`, which is what that leg has always done.
 */
const RUNGS = [
  null,
  null,
  { enter: 'enterPhase2', start: { api: 'startPipeline' },
    ready: () => window.__SPATIAL_DEBUG__.getPipelineStats().completed > 30 },
  { enter: 'enterPhase3', start: { dom: '#start-detection' },
    ready: () => window.__SPATIAL_DEBUG__.getTrackingStats().detections > 5 },
  { enter: 'enterPhase4', start: { dom: '#start-tracking' },
    ready: () => window.__SPATIAL_DEBUG__.getFlowStats().flowFrames > 5 },
  { enter: 'enterPhase5', start: { dom: '#start-verification' },
    ready: () => window.__SPATIAL_DEBUG__.getVerificationStats().verifiedFrames > 3 },
  { enter: 'enterPhase6', start: { dom: '#start-pose' },
    ready: () => window.__SPATIAL_DEBUG__.getPoseStats().poseFrames > 0 },
];

/**
 * Climb from the capability screen to `target`, leaving every phase below it **running**.
 *
 * `target` is the phase the leg is about to test, and it is *not* entered here: the leg enters
 * it itself, because what it does on arrival — checking the Phase Lock, checking its start
 * button is pressable, logging the handover — is the part that differs and the part that
 * matters.
 */
export async function climbTo(page, target, log = () => {}) {
  for (let n = 2; n < target; n++) {
    const rung = RUNGS[n];
    if (!rung) continue;
    const entered = await page.evaluate((fn) => window.__SPATIAL_DEBUG__[fn](true), rung.enter);
    if (!entered) throw new Error(`could not enter Phase ${n} even with the desktop override`);
    if (rung.start.dom) {
      await page.waitForSelector(rung.start.dom, { timeout: 10_000 });
      await page.click(rung.start.dom);
    } else {
      await page.evaluate((fn) => window.__SPATIAL_DEBUG__[fn](), rung.start.api);
    }
    await page.waitForFunction(rung.ready, undefined, { timeout: 25_000 });
    log(n);
  }
}

/**
 * The Phase Lock, checked on the control a person would use (Rule 005).
 *
 * A leg is `DESKTOP_DEV` and cannot pass a phase (Rule 004), so the door to the next one must be
 * shut on every leg and must say why. Checking the button rather than the registry is the point:
 * the registry could be right while the screen offered the door anyway.
 */
export async function expectLocked(page, nextPhase, label) {
  const gate = await page.evaluate((n) => {
    const b = document.getElementById(`go-to-phase${n}`);
    return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
  }, nextPhase);
  if (gate.disabled !== true || !String(gate.text).includes('LOCKED')) {
    throw new Error(
      `${label} should be locked on this leg — the previous phase is TESTING, not PASSED — but ` +
        `it reads ${JSON.stringify(gate.text)} (disabled ${gate.disabled}). Rule 005.`,
    );
  }
  return gate;
}

/**
 * The start control, checked before and after pressing it (Rule 002, §H.5).
 *
 * Both halves are needed. Before: a phase arrived at over several live stages must still offer a
 * pressable button, or a person could not start the run at all. After: the label must change,
 * or the screen and the engine disagree about whether anything is happening.
 */
export async function pressStart(page, selector, { idle, busy }) {
  await page.waitForSelector(selector, { timeout: 10_000 });
  const read = () =>
    page.evaluate((sel) => {
      const b = document.getElementById(sel.slice(1));
      return { text: b?.textContent ?? null, disabled: b?.disabled ?? null };
    }, selector);

  const before = await read();
  if (before.disabled !== false || before.text !== idle) {
    throw new Error(
      `${idle} is not pressable on arrival: label ${JSON.stringify(before.text)}, disabled ` +
        `${before.disabled}. This screen arrives over several live stages, so a control derived ` +
        'from any of them is already pressed and a person could not start the run (Rule 002, §H.5)',
    );
  }
  await page.click(selector);
  return async () => {
    const after = await read();
    if (after.text !== busy || after.disabled !== true) {
      throw new Error(
        `the run is going but the control says ${JSON.stringify(after.text)} (disabled ` +
          `${after.disabled}) — the control and the engine disagree (Rule 002)`,
      );
    }
    return after;
  };
}
