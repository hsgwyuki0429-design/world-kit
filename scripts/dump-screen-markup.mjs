#!/usr/bin/env node
/**
 * Dump the markup of every phase screen's last three cards, for a before/after diff.
 *
 * Not part of the suite — a one-off instrument for the refactor that pulled `renderTests`,
 * `renderEvidence` and `renderNavigation` out of seven screens into `src/ui/phaseSections.ts`.
 * The claim being checked is that the extraction is a move, not a redesign, and the only way to
 * check that honestly is to render both versions and compare what they produced.
 *
 * Each screen is dumped **at the moment of arrival**, before its start button is pressed, so the
 * three cards are computed from an idle session and the run-to-run variation is confined to
 * counters embedded in PENDING reasons. The comparison normalises digits away for that reason;
 * what it is testing is the structure, the ids, the classes and the words.
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const CHROMIUM = '/opt/pw-browsers/chromium';
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: dump-screen-markup.mjs <output.json>');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serve(dir) {
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

execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: existsSync(CHROMIUM) ? CHROMIUM : undefined,
  args: [
    '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});

const dumps = {};
try {
  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__SPATIAL_READY__);
  await context.grantPermissions(['camera'], { origin: new URL(url).origin });

  // The last three cards on the screen are Tests, Evidence and Navigation on every phase from 1
  // onward. Taken from the live DOM rather than from a fixture, because a fixture would be a
  // second implementation of the thing under test.
  const tail = () =>
    page.evaluate(() => {
      const cards = [...document.querySelectorAll('#app .card')];
      return cards.slice(-3).map((c) => c.outerHTML);
    });

  for (const [n, enter, start] of [
    [1, 'enterPhase1', null],
    [2, 'enterPhase2', 'startPipeline'],
    [3, 'enterPhase3', '#start-detection'],
    [4, 'enterPhase4', '#start-tracking'],
    [5, 'enterPhase5', '#start-verification'],
    [6, 'enterPhase6', '#start-pose'],
    [7, 'enterPhase7', null],
  ]) {
    const ok = await page.evaluate((fn) => window.__SPATIAL_DEBUG__[fn](true), enter);
    if (!ok) throw new Error(`could not enter Phase ${n}`);
    dumps[`phase${n}`] = await tail();
    console.log(`[dump] phase ${n}: ${dumps[`phase${n}`].length} cards`);
    if (start === null) continue;
    if (start.startsWith('#')) {
      await page.waitForSelector(start, { timeout: 10_000 });
      await page.click(start);
    } else {
      await page.evaluate((fn) => window.__SPATIAL_DEBUG__[fn](), start);
    }
    await page.waitForTimeout(2500);
  }
} finally {
  await browser.close();
  server.close();
}

mkdirSync(resolve(OUT, '..'), { recursive: true });
writeFileSync(OUT, JSON.stringify(dumps, null, 2));
console.log(`[dump] wrote ${OUT}`);
