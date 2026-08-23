#!/usr/bin/env node
/**
 * Phase 6 DESKTOP_DEV leg — relative pose (v3 §15, §16, §19, §67).
 *
 * ## What this leg can decide, and what it explicitly cannot
 *
 * Phase 6 has two instruments and this leg has exactly one of them.
 *
 * **POSE-005 it can decide, completely.** The harness applies `K·Rⱼ·K⁻¹` to the second view of
 * the verified correspondence set — which is exactly the camera having turned by `Rⱼ` — and
 * checks that the recovered pose moved by that much. It is ground truth, it needs no sensor, and
 * a stage returning the same pose on every frame scores 0.00° against it while satisfying every
 * other numeric criterion in the phase. That is the gate, and it is armed here.
 *
 * **POSE-002 it cannot decide at all.** Headless Chromium has no gyroscope, so the one
 * comparison against *physics* reports PENDING with that reason. This is Rule 004 expressed as a
 * measurement rather than as a policy: the device is not merely the place the verdict is
 * stamped, it is the only place one of the two instruments exists.
 *
 * ## The feed
 *
 * Phase 5's leg needed geometry in the pixels; Phase 6 needs *camera motion* in them, and one
 * kind of motion in particular that no amount of translation can stand in for.
 *
 *  - **A camera roll.** Rotating the image about its centre is *exactly* `K·R_z·K⁻¹` for a
 *    camera rolling about its optical axis — with the principal point at the centre and square
 *    pixels, the two are the same transformation. It is depth-independent, so it produces large,
 *    well-conditioned image motion with **no translation whatsoever**: the configuration
 *    POSE-004 exists for, and the one that passes every check Phase 5 applies.
 *  - **A two-layer pan**, as in Phase 5's leg: a background and a foreground moving 3.5× faster
 *    in the same direction, which is what a camera translating past two depths produces. A
 *    fundamental matrix explains both; no homography explains two disparities. POSE-001.
 *  - **A single-layer pan** — a plane, translating. v3 §16's case, where the pose must come from
 *    the homography and not from a degenerate Essential matrix. POSE-003.
 *  - **A blank field**, for the other half of POSE-004: a frame Phase 5 declines gets no pose.
 *
 * ## What it still cannot decide
 *
 *  - **Rule 004 stands.** This is `DESKTOP_DEV`; nothing here passes a phase.
 *  - **POSE-006** measures this machine against a budget written for the iPhone, exactly as
 *    GEO-005 and FLOW-006 did. Printed, and gated on a wider configuration tripwire instead.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { climbTo, expectLocked, launch, openApp, pressStart, serve } from './lib/harness.mjs';
import { blankLuma, farLuma, isNear, nearLuma, writeY4M } from './lib/feed.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'docs', 'phase6', 'evidence');
const VIDEO = join(ROOT, 'node_modules', '.cache', 'pose-motion.y4m');

/** Long enough for the loop to run several times over, and for each anchor to live and die. */
const VERIFY_MS = 40_000;

const W = 640;
const H = 480;

/**
 * The camera's motion, per source frame, in level-0 pixels.
 *
 * One direction, two speeds. A real camera translating sideways moves every image point along
 * a line through the focus of expansion, at a rate inversely proportional to that point's
 * depth — so two planes at different depths give two *speeds along one direction*, never two
 * directions. Getting that wrong would produce a scene no camera motion can generate, and a
 * fundamental matrix would then fail to fit it for a reason that has nothing to do with the
 * solver.
 */
const DIRECTION = { x: 2.0, y: 0.7 };
/** The foreground is 3.5× nearer in effect: same direction, 3.5× the disparity. */
const NEAR_FACTOR = 3.5;

/**
 * The camera roll, in degrees per source frame.
 *
 * 0.55°/frame moves a point 400 px from the centre by about 3.8 px — comfortably above §13's
 * band, comfortably inside the 21 px tracking window, and small enough that the rotation *within*
 * a 21×21 window is negligible (Lucas-Kanade is not rotation-invariant). Over the segment the
 * camera turns about 46°, and the verification anchor re-takes several times inside that.
 */
const ROLL_PER_FRAME_DEG = 0.55;

const SEGMENTS = [
  // A single layer, translating: one plane, and a homography explains it exactly. The pose must
  // come from that homography and not from a degenerate Essential matrix — POSE-003.
  { name: 'planar-pan', frames: 84, near: 0, speed: 1.5, blank: false, roll: 0 },
  // Two layers, the near one moving 3.5× as far per frame. No homography fits two disparities,
  // so this is where the fundamental matrix is the model and a translation is recoverable —
  // POSE-001.
  { name: 'parallax-pan', frames: 108, near: 0.5, speed: 1.0, blank: false, roll: 0 },
  // A camera roll and nothing else. Rotating the image about its centre *is* K·R_z·K⁻¹ for a
  // camera rolling about its optical axis, so this is a real rotation with no translation at
  // all: large, well-conditioned image motion that passes every check Phase 5 applies and
  // contains no baseline whatsoever — POSE-004.
  { name: 'roll', frames: 96, near: 0, speed: 0, blank: false, roll: ROLL_PER_FRAME_DEG },
  // A smooth field: the population collapses, Phase 5 declines, and Phase 6 must report no pose
  // at all — not even a rotation. POSE-004's other half.
  { name: 'blank', frames: 36, near: 0, speed: 1.5, blank: true, roll: 0 },
];

/**
 * The cost above which this leg calls a regression — NOT POSE-006's criterion.
 *
 * POSE-006 gates on §H's 6 ms budget for RANSAC *and* pose recovery together on the iPhone.
 * This runs on headless Chromium
 * with SwiftShader on a shared CPU, so a cost measured here says nothing about whether the
 * device meets that budget — the same distinction §H.4 draws, and the same one Phase 3's and
 * Phase 4's legs made for FEAT-005 and FLOW-006. The number below is a configuration tripwire:
 * far enough above the observed spread to survive machine variance, and far enough below what
 * a genuine configuration error costs (a RANSAC that stopped terminating adaptively and always
 * ran its 500-iteration cap, or a fitter re-normalising the whole point set per sample) to
 * catch it. Both models are fitted on every judged frame either way — v3 §16 is not skipped to
 * save time.
 */
const POSE_COST_CEILING_MS = 60.0;

/* -------------------------------------------------------------------------- */
/* The feed                                                                     */
/* -------------------------------------------------------------------------- */

function buildY4M() {
  let farX = 0;
  let farY = 0;
  let rollDeg = 0;
  let si = 0;
  let left = SEGMENTS[0].frames;
  const cx = W / 2;
  const cy = H / 2;
  const { frames, megabytes } = writeY4M(VIDEO, {
    width: W,
    height: H,
    frames: SEGMENTS.reduce((a, s) => a + s.frames, 0),
    frame: (y) => {
      const seg = SEGMENTS[si];
      const nearX = farX * NEAR_FACTOR;
      const nearY = farY * NEAR_FACTOR;
      // The roll is applied as a rotation of the sampling coordinate about the image centre,
      // which is the same transformation as `K·R_z·K⁻¹` when the principal point is at the
      // centre and the pixels are square. Sampling the texture at the rotated coordinate *is*
      // the rotated image; no resampling of a rendered frame is involved, so there is no
      // interpolation blur to soften the corners the tracker needs.
      const t = (rollDeg * Math.PI) / 180;
      const cosR = Math.cos(t);
      const sinR = Math.sin(t);
      for (let yy = 0; yy < H; yy++) {
        const row = yy * W;
        const dy = yy - cy;
        for (let xx = 0; xx < W; xx++) {
          const dx = xx - cx;
          const sx = seg.roll ? cosR * dx - sinR * dy + cx : xx;
          const sy = seg.roll ? sinR * dx + cosR * dy + cy : yy;
          if (seg.blank) {
            y[row + xx] = blankLuma(sx + farX, sy + farY);
          } else if (isNear(sx, W, seg.near)) {
            y[row + xx] = nearLuma(sx + nearX, sy + nearY);
          } else {
            y[row + xx] = farLuma(sx + farX, sy + farY);
          }
        }
      }
      farX += DIRECTION.x * seg.speed;
      farY += DIRECTION.y * seg.speed;
      rollDeg += seg.roll;
      if (--left === 0 && si + 1 < SEGMENTS.length) left = SEGMENTS[++si].frames;
    },
  });
  console.log(
    `[p6] wrote ${W}x${H}, ${frames} frames (${megabytes} MB): ` +
      SEGMENTS.map((s) => `${s.frames}× ${s.name}`).join(', '),
  );
}

buildY4M();
console.log('[p6] building…');
execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });

const server = await serve(DIST);
const url = `http://localhost:${server.address().port}/`;
console.log(`[p6] serving ${url}`);
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
  await climbTo(page, 6, (n) => console.log(`[p6] phase ${n} running`));
  // Phase Lock, on the control a person would use. Phase 5 cannot pass on this leg (Rule 004),
  // so the door to Phase 6 must be shut and must say why.
  const gate = await expectLocked(page, 6, 'GO TO RELATIVE POSE');
  console.log(`[p6] Phase Lock holds: ${gate.text}`);

  const handover = await page.evaluate(() => ({
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    flow: window.__SPATIAL_DEBUG__.getFlowStats(),
    verification: window.__SPATIAL_DEBUG__.getVerificationStats(),
  }));
  console.log(
    `[p6] handing over ${handover.pipeline.completed} preprocessed frames, ` +
      `${handover.flow.total} tracked points, ${handover.verification.verifiedFrames} verified ` +
      `frames, tier ${handover.pipeline.tierLabel}`,
  );

  const entered = await page.evaluate(() => window.__SPATIAL_DEBUG__.enterPhase6(true));
  if (!entered) throw new Error('could not enter Phase 6 even with the desktop override');

  // Press the control a person presses. There is deliberately no `startPose()` in the debug
  // API: reaching past the DOM is how Phase 3's leg twice certified a screen whose button had
  // become unpressable while the engine behind it answered perfectly well (§H.5).
  const confirmRunning = await pressStart(page, '#start-pose', {
    idle: 'START POSE RECOVERY',
    busy: 'RECOVERING',
  });

  await page.waitForFunction(
    () => window.__SPATIAL_DEBUG__.getPoseStats().poseFrames > 0,
    undefined,
    { timeout: 25_000 },
  );

  await confirmRunning();

  console.log(`[p6] holding for ${VERIFY_MS / 1000} s…`);
  await page.waitForTimeout(VERIFY_MS);

  snap = await page.evaluate(() => ({
    results: window.__SPATIAL_DEBUG__.getPhase6Results(),
    evidence: window.__SPATIAL_DEBUG__.getPhase6EvidenceJson(),
    stats: window.__SPATIAL_DEBUG__.getPoseStats(),
    verification: window.__SPATIAL_DEBUG__.getVerificationStats(),
    flow: window.__SPATIAL_DEBUG__.getFlowStats(),
    phase: window.__SPATIAL_DEBUG__.getPhase6State(),
    pipeline: window.__SPATIAL_DEBUG__.getPipelineStats(),
    alignment: window.__SPATIAL_DEBUG__.getOverlayAlignment(),
  }));

  writeFileSync(join(OUT_DIR, 'phase6-desktop-chromium.json'), snap.evidence);
  await page.screenshot({ path: join(OUT_DIR, 'phase6-desktop-chromium.png'), fullPage: true });

  const s = snap.stats;
  console.log(
    `[p6] ${s.poseFrames} pose frames; states ${JSON.stringify(s.stateFrames)}; ` +
      `${s.posedFrames} with a full pose, ${s.lowParallaxFrames} rotation-only`,
  );
  console.log(
    `[p6] median rotation ${s.medianRotationDeg}°, reprojection ${s.medianReprojectionPx} px, ` +
      `${Math.round(s.medianCheiralityFraction * 1000) / 10}% in front of both cameras; ` +
      `direction spread ${s.translationSpreadDeg}° (reported, not judged)`,
  );
  console.log(
    `[p6] POSE-005: ${s.injectionSamples} injected frames — a ${s.requestedInjectionDeg}° turn ` +
      `moved the pose ${s.medianInjectedDeg}° against ${s.medianControlDeg}° for the control; ` +
      `inlier drift ${Math.round(s.medianInjectedInlierDrift * 1000) / 10}% against the ` +
      `control's ${Math.round(s.medianControlInlierDrift * 1000) / 10}%, ` +
      `${s.injectionPlanarFlips} planar flip(s) against ${s.controlPlanarFlips}`,
  );
  console.log(
    `[p6] v3 §16: ${s.planarPosedFrames} planar / ${s.nonPlanarPosedFrames} non-planar posed; ` +
      `${s.planarFromEssential} planar frame(s) via an Essential matrix; translation ` +
      `confidence ${s.medianPlanarTranslationConfidence} vs ${s.medianNonPlanarTranslationConfidence}`,
  );
  console.log(
    `[p6] POSE-004: ${s.lowParallaxFrames} frames with no parallax, ` +
      `${s.lowParallaxWithTranslation} of which named a translation; ${s.unverifiedFrames} ` +
      `frames Phase 5 declined, ${s.unverifiedWithRotation} of which carried a rotation`,
  );
  console.log(
    `[p6] gyroscope: ${s.gyroAvailable ? 'delivering' : 'not available'}` +
      `${s.gyroReason ? ` — ${s.gyroReason}` : ''}; ${s.rotationSamples} comparable frame(s)`,
  );
  console.log(
    `[p6] intrinsics: ESTIMATED at ${s.intrinsics?.assumedFovDeg}° FOV, f=` +
      `${Math.round(s.intrinsics?.fx ?? 0)} on ${s.intrinsics?.width}×${s.intrinsics?.height}; ` +
      `±20% moves rotation ${s.medianSensitivityRotationDeg}° and translation ` +
      `${s.medianSensitivityTranslationDeg}°`,
  );
  console.log(
    `[p6] cost: ${s.meanPoseMs} ms pose + ${snap.verification.meanVerifyMs} ms RANSAC over ` +
      `${s.poseCostSamples} frames, tier ${snap.pipeline.tierLabel}`,
  );
  console.log(
    `[p6] integrity: ${s.stateMismatches} state mismatch(es), ${s.scaleViolations} scale ` +
      `violation(s), ${s.poseWithoutVerdict} pose(s) on a frame that recovered none, ` +
      `${s.confidenceAboveWorstTerm} confidence(s) above their own worst term`,
  );

  await page.evaluate(() => window.__SPATIAL_DEBUG__.leavePhase6());
} finally {
  await browser.close();
  server.close();
}

/* ------------------------------------------------------------------ */

console.log('\n=== PHASE 6 — DESKTOP_DEV LEG =========================================');
for (const r of snap.results) {
  console.log(`${r.verdict.padEnd(7)} ${r.spec.required ? 'REQ' : 'ADV'} ${r.spec.id}  ${r.spec.title}`);
  console.log(`             ${r.observed}`);
  if (r.verdict !== 'PASS') console.log(`             ${r.reason}`);
}
console.log(`phase verdict: ${snap.phase.state} — ${snap.phase.reason}`);
console.log('=======================================================================\n');

if (errors.length) {
  console.error(`[p6] console errors: ${errors.join(' | ')}`);
  exitCode = 1;
}

const s = snap.stats;

// POSE-002 needs the device's own gyroscope as a second instrument. Headless Chromium has
// none, so the test says PENDING with that reason and it is excluded here rather than counted
// as decided. **This is the one that makes the device necessary rather than merely required.**
excluded.set(
  'POSE-002',
  `headless Chromium delivers no devicemotion events (${s.gyroReason || 'no gyroscope'}), and ` +
    "POSE-002 is defined against the device's own rotation. It is the only comparison in this " +
    'phase against physics rather than against arithmetic, and it exists nowhere but the device',
);

// Any condition the synthetic feed did not actually produce is excluded with its own count,
// rather than the leg pretending the condition occurred. The fake camera plays the generated
// file at its own rate while the pipeline samples at its own, so a segment can be sampled away.
if (s.lowParallaxFrames < 15) {
  excluded.set(
    'POSE-004',
    `the feed produced only ${s.lowParallaxFrames} frames with no measurable parallax — the ` +
      'roll segment was sampled away, or the tracker did not survive the rotation',
  );
}
if (s.planarPosedFrames < 15 || s.nonPlanarPosedFrames < 15) {
  excluded.set(
    'POSE-003',
    `the run posed ${s.planarPosedFrames} planar and ${s.nonPlanarPosedFrames} non-planar ` +
      "frames, and v3 §16's confidence comparison needs both",
  );
}
if (s.posedFrames < 15) {
  excluded.set(
    'POSE-001',
    `only ${s.posedFrames} frames reached a full pose — the parallax segment was sampled away`,
  );
}

// POSE-006's own verdict stays printed above and stays in the bundle; it is simply not this
// leg's to decide, for the reason given at POSE_COST_CEILING_MS.
excluded.set(
  'POSE-006',
  `it gates on §H's 6 ms budget for RANSAC and pose recovery together on the iPhone, and this ` +
    `is headless Chromium with SwiftShader on a shared CPU — ${s.meanPoseMs} ms here measures ` +
    'this machine, not the device. The device run decides it',
);

const decided = new Map();
for (const r of snap.results) {
  if (r.verdict !== 'PENDING') decided.set(r.spec.id, r.verdict);
}

for (const [id, reason] of excluded) {
  const r = snap.results.find((x) => x.spec.id === id);
  console.log(`[p6] ${id} excluded from the gate — ${reason}`);
  if (r) console.log(`[p6]     ${r.verdict} (${r.observed})`);
}

const required = snap.results
  .filter((r) => r.spec.required && !excluded.has(r.spec.id))
  .map((r) => r.spec.id);
const undecided = required.filter((id) => !decided.has(id));
const failed = [...decided.entries()]
  .filter(([id, v]) => v === 'FAIL' && !excluded.has(id))
  .map(([id]) => id);

if (undecided.length) {
  console.error(`[p6] never decided: ${undecided.join(', ')}`);
  exitCode = 1;
}
if (failed.length) {
  console.error(`[p6] FAILED: ${failed.join(', ')}`);
  exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* Tripwires this leg owns, each with its own name and its own number   */
/* ------------------------------------------------------------------ */

// Rule 002, in one line: the screen reports RECOVERING from the same predicate this reads, so a
// run that claims to be recovering and has recovered nothing is the UI and the engine disagreeing.
if (s.running && s.poseFrames === 0) {
  console.error(
    `[p6] the screen reported RECOVERING for the whole ${VERIFY_MS / 1000} s hold and pose ` +
      'recovery ran on 0 frames — the control and the engine disagree (Rule 002)',
  );
  exitCode = 1;
}

// The anti-fake gate, in the leg's own terms rather than inherited from POSE-005's verdict.
// This is the whole reason the harness turns the camera behind the solver's back: every other
// number in this phase is produced, and produced *well*, by a stage returning a constant pose.
const injectedOff = Math.abs(s.medianInjectedDeg - s.requestedInjectionDeg);
if (s.injectionSamples < 10) {
  console.error(
    `[p6] only ${s.injectionSamples} injected frames — the feed moves and is textured by ` +
      'design, so too few means the injection is not reaching the solver and the gate is not armed',
  );
  exitCode = 1;
} else if (s.medianInjectedDeg < 0 || injectedOff > 2.0) {
  console.error(
    `[p6] the harness turned the camera ${s.requestedInjectionDeg}° and the recovered pose ` +
      `moved ${s.medianInjectedDeg}° — off by ${Math.round(injectedOff * 100) / 100}°. A stage ` +
      'returning the same pose on every frame scores exactly 0.00° here, and no statistic ' +
      'computed from the pose’s own output would show it',
  );
  exitCode = 1;
} else if (s.medianControlDeg > 1.5) {
  console.error(
    `[p6] the control — the same correspondences, unmodified, refitted — moved ` +
      `${s.medianControlDeg}°. A pose that moves that much without being asked to is not ` +
      'tracking the injection, it is noise, and a recall measured against it means nothing',
  );
  exitCode = 1;
} else {
  console.log(
    `[p6] anti-fake gate armed and passed: a ${s.requestedInjectionDeg}° turn moved the pose ` +
      `${s.medianInjectedDeg}° against ${s.medianControlDeg}° for the control, over ` +
      `${s.injectionSamples} frames`,
  );
}

// The injection's own invariants, against the control as a noise floor. The *exact* epipolar
// geometry maps exactly under an image-space rotation; the pixel threshold the inlier test
// applies does not, so a correspondence sitting on 1.5 px can cross. What matters is whether the
// injection costs more than refitting the same data does.
const flipRate = s.injectionSamples > 0 ? s.injectionPlanarFlips / s.injectionSamples : 0;
if (s.medianInjectedInlierDrift > 0.1 || flipRate > 0.1) {
  console.error(
    `[p6] injecting a rotation moved the inlier count by a median of ` +
      `${Math.round(s.medianInjectedInlierDrift * 1000) / 10}% (control: ` +
      `${Math.round(s.medianControlInlierDrift * 1000) / 10}%) and flipped v3 §16's planar flag ` +
      `on ${Math.round(flipRate * 1000) / 10}% of frames (control: ${s.controlPlanarFlips}). A ` +
      'rotation of the image plane can do neither to this extent — the fit is responding to ' +
      'something other than the geometry',
  );
  exitCode = 1;
}

// POSE-004, as a tripwire the leg can state because it built the motion: the roll segment is a
// camera rotation about the optical axis and contains no translation by construction.
if (s.lowParallaxFrames === 0) {
  console.error(
    `[p6] the feed contains a ${ROLL_PER_FRAME_DEG}°/frame camera roll — large image motion, no ` +
      'translation whatsoever — and the run recorded no frame without measurable parallax. ' +
      'Either the roll is not reaching the tracker, or every frame is being handed a translation',
  );
  exitCode = 1;
} else if (s.lowParallaxWithTranslation > 0) {
  console.error(
    `[p6] ${s.lowParallaxWithTranslation} frame(s) named a translation direction while rotation ` +
      'alone already explained the image. It will look like a direction, it will be stable ' +
      'enough to plot, and it will be noise (POSE-004)',
  );
  exitCode = 1;
} else {
  console.log(
    `[p6] fail-closed holds: ${s.lowParallaxFrames} frames with no parallax, none of which ` +
      `named a translation; ${s.unverifiedFrames} frames Phase 5 declined, ` +
      `${s.unverifiedWithRotation} of which carried a rotation`,
  );
}

// v3 §16, in the leg's own terms: the feed contains a single-layer pan (planar by construction)
// and a two-layer pan (which no homography fits), so a run that decomposed an Essential matrix
// on a planar frame is the failure §16 exists to prevent.
if (s.planarFromEssential > 0) {
  console.error(
    `[p6] ${s.planarFromEssential} planar frame(s) had their pose taken from an Essential ` +
      'matrix. An E decomposed from a plane is degenerate and yields a pose that looks entirely ' +
      "reasonable — which is exactly why v3 §16 exists, and why v4 dropping it is recorded",
  );
  exitCode = 1;
} else if (s.planarPosedFrames > 0 && s.nonPlanarPosedFrames > 0) {
  console.log(
    `[p6] v3 §16 holds: ${s.planarPosedFrames} planar frames posed from the homography, ` +
      `translation confidence ${s.medianPlanarTranslationConfidence} against ` +
      `${s.medianNonPlanarTranslationConfidence} on ${s.nonPlanarPosedFrames} frames with depth`,
  );
}

// Rule 002 at frame granularity: the state is re-derived from the numbers reported beside it.
if (s.stateMismatches > 0) {
  console.error(
    `[p6] ${s.stateMismatches} frame(s) reported a pose state that disagreed with their own ` +
      'measured inputs (Rule 002)',
  );
  exitCode = 1;
}

// §80 and v4 §18, on the two things this phase must never claim.
if (s.scaleViolations > 0 || s.intrinsicsUnmarked > 0) {
  console.error(
    `[p6] ${s.scaleViolations} record(s) carried a scale other than LOCAL_UNITS and ` +
      `${s.intrinsicsUnmarked} carried a K without INTRINSICS: ESTIMATED beside it. A monocular ` +
      'camera has no absolute scale and this platform reports no focal length',
  );
  exitCode = 1;
}
if (s.poseWithoutVerdict > 0 || s.pointsInFrontOverflow > 0 || s.confidenceAboveWorstTerm > 0) {
  console.error(
    `[p6] ${s.poseWithoutVerdict} frame(s) reported NO_POSE while carrying a pose, ` +
      `${s.pointsInFrontOverflow} placed more points in front than there were correspondences, ` +
      `and ${s.confidenceAboveWorstTerm} reported a confidence above their own worst term ` +
      '(§80, v3 §19)',
  );
  exitCode = 1;
}

// The sensitivity report is the other half of being allowed to say INTRINSICS: ESTIMATED. It is
// printed rather than gated — what it measures is a property of the assumption, not a defect.
console.log(
  `[p6] focal-length assumption: ±20% moves the rotation ${s.medianSensitivityRotationDeg}° and ` +
    `the translation direction ${s.medianSensitivityTranslationDeg}°, at an assumed ` +
    `${s.intrinsics?.assumedFovDeg}° field of view`,
);

// The overlay alignment probe carries over from Phase 3 (§H.5), and this leg cannot arm it for
// the same reason Phase 4's could not: a densely textured, repetitive pan scores every
// transform alike. `scripts/run-e2e-phase3-alignment.mjs` is the leg that decides orientation,
// with a fixture built for it. Reading a verdict out of an unarmed probe would be reading noise.
if (snap.alignment) {
  const armed = snap.alignment.measurable && snap.alignment.bestOverRandom >= 2.0;
  console.log(
    `[p6] overlay alignment: best ${snap.alignment.best}, identity/random ` +
      `${snap.alignment.identityOverRandom.toFixed(2)}x, best/random ` +
      `${snap.alignment.bestOverRandom.toFixed(2)}x — ` +
      (armed
        ? 'the probe had discrimination on this feed'
        : 'NOT ARMED on this feed; run-e2e-phase3-alignment.mjs is the leg that decides orientation'),
  );
  if (armed && snap.alignment.best !== 'identity') {
    console.error(
      `[p6] the probe had discrimination and still says the acquired buffer matches the video ` +
        `under ${snap.alignment.best} rather than identity — every correspondence in this run ` +
        'is a pair of positions in that buffer',
    );
    exitCode = 1;
  }
}

// The configuration tripwire that replaces POSE-006 on this leg.
const combinedMs = s.meanPoseMs + snap.verification.meanVerifyMs;
if (combinedMs > POSE_COST_CEILING_MS) {
  console.error(
    `[p6] pose recovery ${s.meanPoseMs} ms plus RANSAC ${snap.verification.meanVerifyMs} ms = ` +
      `${Math.round(combinedMs * 1000) / 1000} ms, over this leg's ${POSE_COST_CEILING_MS} ms ` +
      'regression ceiling — that is not budget variance, it is the shape of a decomposition ' +
      'triangulating every correspondence against every candidate more than once',
  );
  exitCode = 1;
} else {
  console.log(
    `[p6] pose ${s.meanPoseMs} ms + RANSAC ${snap.verification.meanVerifyMs} ms = ` +
      `${Math.round(combinedMs * 1000) / 1000} ms, under this leg's ${POSE_COST_CEILING_MS} ms ` +
      "regression ceiling (POSE-006's 6 ms budget is the device's to answer)",
  );
}

console.log(`[p6] evidence: ${OUT_DIR}`);
console.log(`[p6] exit ${exitCode}`);
process.exit(exitCode);
