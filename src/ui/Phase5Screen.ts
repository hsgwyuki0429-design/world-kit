/**
 * GEOMETRIC VERIFICATION screen (Phase 5, v3 §14, §16, §66).
 *
 * The camera with the tracked corners on it, split into the two sets RANSAC just decided:
 * points a single two-view geometry explains, and points it does not. Beside them, the one
 * comparison that makes the split mean anything.
 *
 * Three things on this screen are here because of what Phase 5 can fake.
 *
 *  - **The injected-outlier recall is the headline**, not the inlier ratio. v3 §14 names four
 *    figures — 30 inliers, ratio 0.35, 100 inliers, ratio 0.50 — and a stage that accepts
 *    every correspondence satisfies all four *perfectly*, because then the inlier count is the
 *    correspondence count and the ratio is exactly 1.00. Recall against outliers the harness
 *    made and never marked is the only number here that such a stage cannot produce.
 *  - **The clean rejection rate is shown beside it, always.** Recall alone is satisfied by
 *    rejecting everything. The pair is the measurement; either number alone is not.
 *  - **Both models' inlier counts are shown, never just the chosen one.** v3 §16's planar
 *    decision is the comparison between them, so showing only the winner would make the
 *    decision unauditable — and GEO-004 requires it to be auditable.
 *
 * `GOOD` again says why it is not claimed where it is not. §33 makes GOOD three conditions and
 * Phase 5 can now measure two of them; the reprojection error is Phase 6's and does not exist,
 * so the screen names the missing term rather than showing a state that dropped a condition.
 *
 * The overlay alignment probe carries over from Phases 3 and 4 for the reason §H.5 gives, and
 * it matters more here, not less: a correspondence is two positions in the acquired buffer's
 * frame, and a buffer rotated against the screen makes every baseline and every residual on
 * this screen a measurement of the wrong thing.
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  GEO_BUDGET_MS,
  INJECTION_ADVANTAGE,
  MAX_CLEAN_REJECTION,
  MIN_COST_SAMPLES,
  MIN_INJECTION_SAMPLES,
  MIN_JUDGED_FRAMES,
  MIN_OUTLIER_RECALL,
} from '../testkit/Phase5Tests';
import {
  DEGENERATE_SPREAD_PX,
  GOOD_INLIERS,
  GOOD_INLIER_RATIO,
  MIN_BASELINE_PX,
  MIN_CORRESPONDENCES,
  MIN_INLIERS,
  RANSAC_THRESHOLD_PX,
  USABLE_INLIER_RATIO,
  VerificationState,
} from '../geometry/verify';
import {
  MAX_BASELINE_PX,
  OUTLIER_INJECTION_FRACTION,
  OUTLIER_INJECTION_PX,
} from '../tracking/VerificationStage';
import type { VerificationClassStats, VerificationStats } from '../tracking/verificationStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';

export interface Phase5ViewModel {
  readonly phase5: PhaseInfo;
  readonly phase6: PhaseInfo;
  readonly canEnterPhase6: boolean;
  readonly phase6Implemented: boolean;
  readonly phase6BlockedReason: string;
  readonly cameraState: CameraState;
  /**
   * Whether the camera is delivering — which is NOT whether verification is running.
   *
   * The preview reads this and the START control reads `running`, and the two are kept apart
   * on purpose: Phase 5 is entered over a live camera, so binding the preview to `running`
   * would blank the picture until the operator pressed a button, and binding the control to
   * the camera would render it already pressed. Each reads the predicate that is actually
   * about it.
   */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: verification asked for AND a pipeline running to serve it (§H.5). */
  readonly running: boolean;
  readonly stats: VerificationStats;
  readonly alignment: AlignmentReading | null;
  /** `[x0, y0, quality] × count`, level-0 coordinates, straight from the worker. */
  readonly overlay: Float32Array | null;
  readonly overlayAge: Uint16Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase5Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase6: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (v !== undefined) (node as unknown as Record<string, unknown>)[k] = v;
  }
  for (const c of children) node.append(c);
  return node;
}

function card(title: string, children: (Node | string)[]): HTMLElement {
  return el('section', { class: 'card' }, [el('h2', {}, [title]), ...children]);
}

function stat(label: string, value: string | null, cls = ''): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'k' }, [label]),
    el('div', { class: `v ${cls}` }, [value ?? '—']),
  ]);
}

function pct(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 10}%`;
}

function px(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100} px`;
}

function num(n: number): string | null {
  return n < 0 ? null : String(n);
}

/** Kept across renders, as in Phase 4: recreating it would blank the overlay twice a second. */
let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'verify-overlay';
  }
  return overlayCanvas;
}

/**
 * Draw the tracked population.
 *
 * Phase 4's drawing, unchanged, and deliberately so: the overlay's source is still the
 * worker's own position buffer and there is no path here that could produce a point the
 * tracker did not report. Phase 5's own result is not painted on the picture, because the
 * inlier partition is over *correspondences* — pairs spanning the anchor frame and this one —
 * and drawing one end of a pair on the current frame would suggest a per-point verdict on
 * positions the verifier never judged in isolation. The counts are reported as counts.
 */
function paintOverlay(vm: Phase5ViewModel): void {
  const canvas = getOverlayCanvas();
  const w = Math.max(1, vm.overlayWidth);
  const h = Math.max(1, vm.overlayHeight);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const data = vm.overlay;
  if (!data || data.length < 3) return;
  const ages = vm.overlayAge;

  const count = Math.floor(data.length / 3);
  ctx.lineWidth = Math.max(1, Math.round(w / 480));
  for (let i = 0; i < count; i++) {
    const x = data[i * 3] ?? 0;
    const y = data[i * 3 + 1] ?? 0;
    const q = data[i * 3 + 2] ?? 0;
    const age = ages?.[i] ?? 0;
    const r = Math.max(1.5, (w / 300) * (0.5 + q));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (age > 0) {
      const strength = Math.min(1, age / 30);
      ctx.fillStyle = `rgba(48, 209, 88, ${0.35 + 0.55 * strength})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.75)';
      ctx.stroke();
    }
  }
}

export function renderPhase5Screen(
  root: HTMLElement,
  vm: Phase5ViewModel,
  handlers: Phase5Handlers,
): void {
  root.replaceChildren();

  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Geometric Verification']),
      el('p', {}, [
        'Phase 5 — a fundamental matrix and a homography fitted by RANSAC over the ' +
          'correspondences Phase 4 tracks, and the inlier set that survives. Still nothing ' +
          'spatial: no pose is decomposed, no depth is triangulated, no metric scale exists. ' +
          'What this phase produces is a verdict on whether a two-view geometry explains the ' +
          'motion at all.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderVerdict(vm));
  root.append(renderInjection(vm));
  root.append(renderTexture(vm));
  root.append(renderPlanar(vm));
  root.append(renderCost(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));
  root.append(renderNavigation(vm, handlers));
}

function renderPreview(vm: Phase5ViewModel, handlers: Phase5Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;

  if (vm.trackLive) {
    paintOverlay(vm);
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0
        ? `${vm.sourceWidth} / ${vm.sourceHeight}`
        : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
        getOverlayCanvas(),
      ]),
      el('p', { class: 'footnote' }, [
        s.verifiedFrames > 0
          ? `${s.correspondences} of these points also survive in the anchor frame ` +
            `${s.anchorAge >= 0 ? `${s.anchorAge} frames back` : 'not yet taken'}, and it is ` +
            'those pairs — not the points on screen — that RANSAC judged.'
          : vm.running
            ? 'Waiting for the first verified frame.'
            : 'Tracking is live. Verification has not been started.',
      ]),
    );
  } else {
    const message =
      vm.cameraState === CameraState.PERMISSION_DENIED
        ? 'CAMERA PERMISSION DENIED'
        : vm.cameraState === CameraState.UNAVAILABLE
          ? 'CAMERA UNAVAILABLE'
          : vm.cameraState === CameraState.ENDED
            ? 'CAMERA ENDED — the track was stopped, most likely by another app'
            : vm.opening
              ? 'REQUESTING CAMERA…'
              : 'VERIFICATION NOT STARTED';
    children.push(
      el('div', { class: 'preview-frame empty', id: 'preview-empty' }, [
        el('div', { class: 'preview-message' }, [message]),
      ]),
    );
  }

  children.push(
    el('div', { class: 'button-row', style: 'margin-top:12px' } as never, [
      el('button', {
        class: 'primary',
        id: 'start-verification',
        // §H.5 again, and for the third time the same defect is not repeated: this drives the
        // label AND `disabled` from the one `running` predicate. Phase 5 is reached from a
        // screen whose pipeline, detection and tracking are all already live, so any predicate
        // built from those would render this control as pressed before anyone pressed it.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'VERIFYING' : vm.opening ? 'REQUESTING…' : 'START VERIFICATION',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-verification',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );

  return card('Camera and tracked correspondences', children);
}

function renderVerdict(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === VerificationState.GOOD
      ? 's-AVAILABLE'
      : s.state === VerificationState.USABLE
        ? 's-PERMISSION_REQUIRED'
        : 's-PERMISSION_DENIED';

  return card('This frame (v3 §14)', [
    el('div', { class: 'stat-grid' }, [
      stat('State', s.verifiedFrames > 0 ? s.state : null, stateClass),
      stat('Model', s.model ?? (s.verifiedFrames > 0 ? 'none' : null)),
      stat('Correspondences', s.verifiedFrames > 0 ? String(s.correspondences) : null,
        s.correspondences >= MIN_CORRESPONDENCES ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('Inliers', s.verifiedFrames > 0 ? String(s.inliers) : null,
        s.inliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('Inlier ratio', pct(s.inlierRatio),
        s.inlierRatio >= USABLE_INLIER_RATIO ? 's-AVAILABLE' : ''),
      stat('Baseline', px(s.baselinePx),
        s.baselinePx >= MIN_BASELINE_PX ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
      stat('Anchor age', s.anchorAge >= 0 ? `${s.anchorAge} frames` : null),
      stat('Re-anchors', String(s.reAnchors)),
      stat('Verified frames', `${s.judgedFrames} judged / ${s.verifiedFrames}`),
      stat('State mismatches', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Degenerate', String(s.degenerateFrames)),
      stat('Partition faults', String(s.partitionFaults),
        s.partitionFaults > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Model without verdict', String(s.modelWithoutVerdict),
        s.modelWithoutVerdict > 0 ? 's-PERMISSION_DENIED' : ''),
      // §51 and §H.7: a correspondence is two positions in the acquired buffer's frame.
      stat(
        'Overlay matches video',
        vm.alignment
          ? !vm.alignment.measurable
            ? 'not measurable — no local texture in this frame'
            : vm.alignment.best === 'identity'
              ? `yes · ${vm.alignment.identityOverRandom.toFixed(1)}× chance`
              : `NO · ${vm.alignment.best} fits ${vm.alignment.bestOverIdentity.toFixed(1)}× better`
          : null,
        vm.alignment
          ? !vm.alignment.measurable
            ? ''
            : vm.alignment.best === 'identity' &&
                vm.alignment.identityOverRandom >= MIN_IDENTITY_OVER_RANDOM
              ? 's-AVAILABLE'
              : 's-PERMISSION_DENIED'
          : '',
      ),
    ]),
    el('p', { class: 'footnote' }, [
      s.stateReason ||
        'The state is a pure function of the five measured inputs beside it, computed in one ' +
          'place. The mismatch counter re-derives it from the same numbers and counts any ' +
          'frame where the two answers differ.',
    ]),
    el('p', { class: 'footnote' }, [
      `A frame is judged only once it clears ${MIN_CORRESPONDENCES} correspondences and ` +
        `${MIN_BASELINE_PX} px of baseline. Below the baseline floor the two views are very ` +
        'nearly the same view: every model fits, the inlier ratio is near 1.00, and it means ' +
        'nothing. That is why this phase holds a verification anchor tens of frames back ' +
        'rather than verifying consecutive frames — frame to frame the camera moves a few ' +
        `pixels, and the anchor is re-taken when the two views drift past ${MAX_BASELINE_PX} px ` +
        'and stop sharing enough scene to be one geometry.',
    ]),
    ...(s.goodBlockedBy.length > 0
      ? [
          el('p', { class: 'group-title' }, [`Why not ${VerificationState.GOOD}`]),
          ...s.goodBlockedBy.map((why) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, ['v3 §14 conjunct']),
              el('span', { class: 'cap-state' }, [why]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            `v3 §14 makes GOOD two conditions here — inliers >= ${GOOD_INLIERS} and ratio >= ` +
              `${GOOD_INLIER_RATIO} — and §33 adds a third, a reprojection error <= 2.0 px, ` +
              'which needs the pose Phase 6 has not been written to produce. So the tracking ' +
              'state on the previous screen still cannot reach GOOD; this screen’s GOOD is v3 ' +
              '§14’s verification verdict and it is not the same claim.',
          ]),
        ]
      : []),
  ]);
}

/** GEO-003 — the gate. Nothing else on this screen distinguishes a verifier from a pass-through. */
function renderInjection(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injectionSamples >= MIN_INJECTION_SAMPLES;
  const recallOk = enough && s.medianInjectedRecall >= MIN_OUTLIER_RECALL;
  const cleanOk = enough && s.medianCleanRejection >= 0 &&
    s.medianCleanRejection <= MAX_CLEAN_REJECTION;
  const advantage =
    s.medianCleanRejection > 0 ? s.medianInjectedRecall / s.medianCleanRejection : Infinity;

  return card('Does RANSAC actually reject outliers?', [
    el('div', { class: 'stat-grid' }, [
      stat('Injected outliers rejected', pct(s.medianInjectedRecall),
        enough ? (recallOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Untouched rejected', pct(s.medianCleanRejection),
        enough ? (cleanOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Advantage', enough
        ? (Number.isFinite(advantage) ? `${advantage.toFixed(1)}×` : 'no untouched rejected')
        : null,
        enough ? (advantage >= INJECTION_ADVANTAGE ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Inliers surviving', num(s.medianSurvivingInliers),
        s.medianSurvivingInliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('Samples', enough
        ? String(s.injectionSamples)
        : `${s.injectionSamples} / ${MIN_INJECTION_SAMPLES}`),
      stat('Displacement', `${OUTLIER_INJECTION_PX} px`),
    ]),
    el('p', { class: 'footnote' }, [
      `On a sample of frames the harness takes the real correspondence set, displaces ` +
        `${Math.round(OUTLIER_INJECTION_FRACTION * 100)}% of the targets by ` +
        `${OUTLIER_INJECTION_PX} px in seeded directions, and hands the result to the verifier ` +
        'with no marking of which it touched. "Injected outliers rejected" is how many of its ' +
        'own outliers came back rejected. The verifier never sees this number and cannot ' +
        'optimise against it.',
    ]),
    el('p', { class: 'footnote' }, [
      `${OUTLIER_INJECTION_PX} px is ` +
        `${Math.round(OUTLIER_INJECTION_PX / RANSAC_THRESHOLD_PX)}× the ` +
        `${RANSAC_THRESHOLD_PX} px inlier threshold, so the injected points are outliers by ` +
        'construction: no correct two-view model can accept them. And the second number is ' +
        'shown beside the first because recall alone is satisfied perfectly by rejecting ' +
        'everything — the pair is the measurement, either one alone is not.',
    ]),
    el('p', { class: 'footnote' }, [
      'This is the only figure in Phase 5 a stage that returned every correspondence as an ' +
        `inlier could not produce. v3 §14’s four thresholds — ${MIN_INLIERS} inliers, ratio ` +
        `${USABLE_INLIER_RATIO}, ${GOOD_INLIERS} inliers, ratio ${GOOD_INLIER_RATIO} — are all ` +
        'satisfied *perfectly* by accepting everything, because the inlier count is then the ' +
        'correspondence count and the ratio is exactly 1.00. That stage scores 0.0% here.',
    ]),
    ...(s.injections.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recent injections']),
          ...s.injections.slice(-4).map((inj) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${inj.injected} injected`]),
              el('span', { class: 'cap-method' }, [
                `${inj.injectedRejected} rejected · ${inj.cleanRejected}/${inj.clean} clean`,
              ]),
              el('span', {
                class: `cap-state ${inj.injectedRecall >= MIN_OUTLIER_RECALL ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}`,
              }, [
                `${pct(inj.injectedRecall)} recall · ${inj.survivingInliers} survive · ${inj.state}`,
              ]),
            ]),
          ),
        ]
      : []),
  ]);
}

function renderTexture(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const row = (label: string, c: VerificationClassStats): HTMLElement =>
    el('div', { class: 'cap-row' }, [
      el('span', { class: 'cap-label' }, [label]),
      el('span', { class: 'cap-method' }, [
        c.frames > 0 ? `${c.medianCorrespondences} corr · ${c.medianInliers} in` : '',
      ]),
      el('span', { class: `cap-state ${c.frames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''}` }, [
        c.frames > 0
          ? `${c.frames} frames (${c.judged} judged) · ${c.unverified} UNVERIFIED, ` +
            `${c.usable} USABLE, ${c.good} GOOD`
          : 'none yet',
      ]),
    ]);

  return card('By scene texture (GEO-001, GEO-002)', [
    el('p', { class: 'footnote', style: 'margin-bottom:8px' } as never, [
      'The class comes from the frame’s own mean gradient magnitude, measured by the same ' +
        'classifier Phase 3 used — never from what the camera was pointed at. GEO-001 asks ' +
        'that a rich scene produce a large consistent inlier set; GEO-002 asks that a poor one ' +
        'produce UNVERIFIED rather than a ratio computed over four points.',
    ]),
    row('TEXTURE_RICH (GEO-001)', s.textureRich),
    row('TEXTURE_POOR (GEO-002)', s.texturePoor),
    el('div', { class: 'stat-grid', style: 'margin-top:10px' } as never, [
      stat('Median inliers', num(s.medianInliers),
        s.medianInliers >= MIN_INLIERS ? 's-AVAILABLE' : ''),
      stat('Median ratio', pct(s.medianInlierRatio),
        s.medianInlierRatio >= USABLE_INLIER_RATIO ? 's-AVAILABLE' : ''),
      stat('Median baseline', px(s.medianBaselinePx)),
      stat('Median spread', px(s.medianSpreadPx),
        s.medianSpreadPx >= DEGENERATE_SPREAD_PX ? 's-AVAILABLE' : 's-PERMISSION_REQUIRED'),
    ]),
    el('p', { class: 'footnote' }, [
      `Spread is the inlier set’s own spatial extent, and it is here because a ratio can clear ` +
        `every bar on a set too clustered to determine a model. Under ${DEGENERATE_SPREAD_PX} px ` +
        'the configuration is reported degenerate rather than verified.',
    ]),
  ]);
}

function renderPlanar(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Planar scene handling (v3 §16)', [
    el('div', { class: 'stat-grid' }, [
      stat('Both models fitted', s.bothModelsFitted > 0
        ? `${s.bothModelsFitted} frames` : null,
        s.bothModelsFitted >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('Planar', String(s.planarFrames), s.planarFrames > 0 ? 's-AVAILABLE' : ''),
      stat('Non-planar', String(s.nonPlanarFrames), s.nonPlanarFrames > 0 ? 's-AVAILABLE' : ''),
      stat('Median F inliers', num(s.medianFundamentalInliers)),
      stat('Median H inliers', num(s.medianHomographyInliers)),
      stat('Planar mismatches', String(s.planarMismatches),
        s.planarMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      'Both models are fitted on every judged frame, never one skipped as an optimisation. ' +
        'The fundamental matrix is the weaker constraint and normally admits at least as many ' +
        'points, so the homography reaching it is the signal that the scene is a plane. Both ' +
        'counts are shown because the decision is the comparison between them: showing only ' +
        'the winner would make PLANAR an assertion rather than a finding.',
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §16 requires this because an Essential matrix decomposed from a planar scene is ' +
        'degenerate and yields a pose that looks entirely reasonable. Phase 6 lowers ' +
        'translation confidence on these frames; this phase’s job is to identify them ' +
        'honestly, including saying when a run never produced one of the two cases.',
    ]),
  ]);
}

function renderCost(vm: Phase5ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanVerifyMs >= 0 && s.meanVerifyMs <= GEO_BUDGET_MS;
  return card('Cost (§H’s budget)', [
    el('div', { class: 'stat-grid' }, [
      stat('RANSAC', s.meanVerifyMs >= 0 ? `${s.meanVerifyMs} ms` : null,
        s.meanVerifyMs >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Budget', `${GEO_BUDGET_MS} ms`),
      stat('Samples', s.verifyCostSamples >= MIN_COST_SAMPLES
        ? String(s.verifyCostSamples)
        : `${s.verifyCostSamples} / ${MIN_COST_SAMPLES}`),
      stat('At', num(s.medianCorrespondences)),
      stat('Capped frames', String(s.cappedFrames),
        s.cappedFrames > 0 ? 's-PERMISSION_REQUIRED' : ''),
      stat('Inlier threshold', `${RANSAC_THRESHOLD_PX} px`),
    ]),
    el('p', { class: 'footnote' }, [
      'A capped frame is one where RANSAC exhausted its iteration limit before reaching its ' +
        'confidence target — the reported ratio there is whatever the last sample gave rather ' +
        'than an estimate with a probability behind it. The count is shown rather than the cap ' +
        'being raised until it disappears, because how often it binds is a property of the ' +
        'scene worth knowing.',
    ]),
    el('p', { class: 'footnote' }, [
      `GEO-005 is advisory: §34 ranks correctness above performance, so both models are still ` +
        `fitted on every judged frame even when the mean is over ${GEO_BUDGET_MS} ms, and the ` +
        'measured cost of doing the specified work is reported rather than the work being ' +
        'reduced until it fits.',
    ]),
  ]);
}

function renderTests(vm: Phase5ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const counts = {
    pass: vm.results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: vm.results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: vm.results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  const rows = vm.results.map((r) =>
    el('details', { class: 'row' }, [
      el('summary', {}, [
        el('span', { class: 'id' }, [r.spec.id]),
        el('span', { class: 'title' }, [r.spec.title]),
        el('span', { class: 'req' }, [r.spec.required ? 'REQ' : 'ADV']),
        el('span', { class: `verdict v-${r.verdict}` }, [r.verdict]),
      ]),
      el('dl', { class: 'detail-grid' }, [
        el('dt', {}, ['Expected']), el('dd', {}, [r.spec.expected]),
        el('dt', {}, ['Criteria']), el('dd', {}, [r.spec.passCriteria]),
        el('dt', {}, ['Observed']), el('dd', { class: 'mono' }, [r.observed]),
        el('dt', {}, ['Reason']), el('dd', {}, [r.reason]),
      ]),
    ]),
  );
  return card(`Tests — Phase 5 · ${vm.phase5.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase5.state}`, id: 'phase5-verdict' }, [
        vm.phase5.state,
      ]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase5.reason]),
    ...rows,
  ]);
}

function renderEvidence(vm: Phase5ViewModel, handlers: Phase5Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase5-pending-warning' }, [
        `This export would record ${vm.phase5.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p5',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase5.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p5',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}

/** Phase Lock on screen, as on every screen before it: a closed door says which lock holds it. */
function renderNavigation(vm: Phase5ViewModel, handlers: Phase5Handlers): HTMLElement {
  const open = vm.canEnterPhase6 && vm.phase6Implemented;
  const label = !vm.phase6Implemented
    ? 'RELATIVE POSE — NOT IMPLEMENTED'
    : !vm.canEnterPhase6
      ? 'RELATIVE POSE — LOCKED'
      : 'GO TO RELATIVE POSE';
  const note = !vm.phase6Implemented
    ? 'Phase 6 has not been written in this build.'
    : !vm.canEnterPhase6
      ? vm.phase6BlockedReason
      : `Phase 6 is ${vm.phase6.state}.`;

  return card('Navigation', [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase4',
        textContent: 'BACK TO TRACKING',
        onclick: handlers.onBack,
      } as never),
      el('button', {
        class: 'primary',
        id: 'go-to-phase6',
        disabled: !open,
        textContent: label,
        onclick: handlers.onEnterPhase6,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [note]),
  ]);
}
