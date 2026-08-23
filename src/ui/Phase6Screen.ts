/**
 * RELATIVE POSE screen (Phase 6, v3 §15, §16, §19, §67).
 *
 * The first screen in this project that shows a quantity with a physical unit — degrees — and
 * therefore the first one where a second instrument can be put beside it and disagree. That
 * comparison is the headline here for the same reason Phase 4's scene-shift search and Phase 5's
 * injected outliers were the headline there.
 *
 * Four things on this screen are here because of what Phase 6 can fake.
 *
 *  - **"Does the pose follow a rotation it was not told about?" is the top panel**, not the
 *    rotation itself. A stage returning the same pose on every frame has a valid rotation
 *    matrix, a unit translation, a small reprojection error and a *perfect* temporal stability.
 *    v3 §67's pass condition names exactly this — Poseが計算結果により変化 — and the injected
 *    rotation is the only number here that decides it.
 *  - **The gyroscope's angle is shown beside the camera's**, and neither is shown alone. It is
 *    a different sensor on a different thread, and the solver never reads it.
 *  - **The scale says `LOCAL UNITS` and there is no metre anywhere.** v3 §15 and v4 §18 both
 *    forbid it. `‖t‖` is 1 because it was normalised, which is not a measurement of anything.
 *  - **`INTRINSICS: ESTIMATED` is displayed with the assumed field of view and the ±20 %
 *    sensitivity beside it**, because a stated assumption whose consequences are unmeasured is
 *    a guess with a number attached.
 *
 * All four cheirality counts are shown rather than the winner alone, for the reason Phase 5
 * shows both models' inlier counts: a decision presented without the alternatives it beat is an
 * assertion.
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  INJECTED_ROTATION_DEG,
  INJECTION_TOLERANCE_DEG,
  MAX_CONTROL_ROTATION_DEG,
  MIN_INJECTION_SAMPLES,
  MIN_JUDGED_FRAMES,
  MIN_ROTATION_AGREEMENT_RATE,
  POSE_PIPELINE_BUDGET_MS,
} from '../testkit/Phase6Tests';
import {
  MAX_REPROJECTION_PX,
  MIN_CHEIRALITY_FRACTION,
  PURE_ROTATION_PARALLAX_PX,
  PoseState,
} from '../geometry/pose';
import { NOMINAL_FOV_DEG } from '../geometry/intrinsics';
import {
  MIN_COMPARABLE_ROTATION_DEG,
  ROTATION_AGREEMENT_DEG,
} from '../tracking/PoseSession';
import type { PoseStats } from '../tracking/poseStats';
import { MIN_IDENTITY_OVER_RANDOM } from '../debug/OverlayAlignmentProbe';
import type { AlignmentReading } from '../debug/OverlayAlignmentProbe';

export interface Phase6ViewModel {
  readonly phase6: PhaseInfo;
  readonly phase7: PhaseInfo;
  readonly canEnterPhase7: boolean;
  readonly phase7Implemented: boolean;
  readonly phase7BlockedReason: string;
  readonly cameraState: CameraState;
  /** The camera is delivering — which is NOT whether pose recovery is running (§H.5). */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: pose asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: PoseStats;
  /** Phase 5's measured RANSAC cost — §H budgets it and pose recovery as one line. */
  readonly verifyMs: number;
  readonly alignment: AlignmentReading | null;
  readonly overlay: Float32Array | null;
  readonly overlayAge: Uint16Array | null;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase6Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase7: () => void;
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

function deg(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100}°`;
}

function px(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100} px`;
}

function vec(v: readonly number[] | null): string | null {
  if (!v) return null;
  return `[${v.map((x) => (Math.round(x * 1000) / 1000).toFixed(3)).join(', ')}]`;
}

let overlayCanvas: HTMLCanvasElement | null = null;

function getOverlayCanvas(): HTMLCanvasElement {
  if (!overlayCanvas) {
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'pose-overlay';
  }
  return overlayCanvas;
}

/**
 * The tracked population, drawn exactly as Phases 4 and 5 draw it.
 *
 * Nothing about the pose is painted on the picture. A recovered rotation and a translation
 * direction are properties of the *camera*, not of any point on screen, and drawing an arrow to
 * suggest otherwise would be inventing a spatial relationship this phase has not established.
 * There is no depth here yet — Phase 9 triangulates for keeping — so there is nothing in the
 * scene whose position this phase could honestly mark.
 */
function paintOverlay(vm: Phase6ViewModel): void {
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
      ctx.fillStyle = `rgba(48, 209, 88, ${0.35 + 0.55 * Math.min(1, age / 30)})`;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255, 184, 0, 0.75)';
      ctx.stroke();
    }
  }
}

export function renderPhase6Screen(
  root: HTMLElement,
  vm: Phase6ViewModel,
  handlers: Phase6Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Relative Pose']),
      el('p', {}, [
        'Phase 6 — the camera’s rotation and the direction it moved in, decomposed from the ' +
          'geometry Phase 5 verified. Direction only: a monocular camera has no absolute scale, ' +
          'so everything here is in LOCAL UNITS and nothing downstream may read 1 as a metre. ' +
          'No map is kept — the points triangulated here exist only to check which way the ' +
          'camera was facing.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderInjection(vm));
  root.append(renderGyro(vm));
  root.append(renderPose(vm));
  root.append(renderPlanar(vm));
  root.append(renderConfidence(vm));
  root.append(renderIntrinsics(vm));
  root.append(renderCost(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));
  root.append(renderNavigation(vm, handlers));
}

function renderPreview(vm: Phase6ViewModel, handlers: Phase6Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;
  if (vm.trackLive) {
    paintOverlay(vm);
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0 ? `${vm.sourceWidth} / ${vm.sourceHeight}` : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
        getOverlayCanvas(),
      ]),
      el('p', { class: 'footnote' }, [
        s.poseFrames > 0
          ? 'Nothing about the pose is drawn on the picture. A rotation and a translation ' +
            'direction belong to the camera, not to any point on screen, and there is no depth ' +
            'here to mark — the triangulated points exist only to decide which way the camera ' +
            'was facing and are not kept.'
          : vm.running
            ? 'Waiting for the first recovered pose.'
            : 'Verification is live. Pose recovery has not been started.',
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
              : 'POSE RECOVERY NOT STARTED';
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
        id: 'start-pose',
        // §H.5, for the fourth time and from the one predicate. Everything below this screen —
        // camera, pipeline, detector, tracker, verifier — is already live when it opens.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'RECOVERING' : vm.opening ? 'REQUESTING…' : 'START POSE RECOVERY',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-pose',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('Camera and tracked correspondences', children);
}

/** POSE-005 — the gate. Nothing else here distinguishes a solver from a constant. */
function renderInjection(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injectionSamples >= MIN_INJECTION_SAMPLES;
  const off = Math.abs(s.medianInjectedDeg - INJECTED_ROTATION_DEG);
  const followed = enough && s.medianInjectedDeg >= 0 && off <= INJECTION_TOLERANCE_DEG;
  const controlOk = enough && s.medianControlDeg >= 0 && s.medianControlDeg <= MAX_CONTROL_ROTATION_DEG;

  return card('Does the pose follow a rotation it was not told about?', [
    el('div', { class: 'stat-grid' }, [
      stat('Camera turned by', `${INJECTED_ROTATION_DEG}°`),
      stat('Pose moved by', deg(s.medianInjectedDeg),
        enough ? (followed ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Control moved by', deg(s.medianControlDeg),
        enough ? (controlOk ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Samples', enough ? String(s.injectionSamples) : `${s.injectionSamples} / ${MIN_INJECTION_SAMPLES}`),
      stat('Inlier drift', `${pct(s.medianInjectedInlierDrift)} · control ${pct(s.medianControlInlierDrift)}`,
        s.medianInjectedInlierDrift > 0.1 ? 's-PERMISSION_DENIED' : ''),
      stat('Planar flips', `${s.injectionPlanarFlips} · control ${s.controlPlanarFlips}`,
        s.injectionSamples > 0 && s.injectionPlanarFlips / s.injectionSamples > 0.1
          ? 's-PERMISSION_DENIED' : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `On a sample of frames the harness applies a ${INJECTED_ROTATION_DEG}° camera rotation to ` +
        'the second view — `K·Rⱼ·K⁻¹`, which is exactly what would have been seen had the phone ' +
        'turned that far — and re-runs the whole chain, model fit included, on a set handed over ' +
        'with no marking. The solver never learns Rⱼ, and cannot optimise against this number.',
    ]),
    el('p', { class: 'footnote' }, [
      '"Control moved by" is the same correspondences, unmodified, refitted with a different ' +
        'seed. Both numbers are the measurement: a solver returning a constant reports 0° for ' +
        'the first, and one returning noise reports a large number for the second.',
    ]),
    el('p', { class: 'footnote' }, [
      'This is the only figure in Phase 6 a stage returning the same pose on every frame could ' +
        'not produce. Such a stage has a valid rotation matrix, a unit translation, a small ' +
        'reprojection error and a *perfect* temporal stability — better than a working solver’s ' +
        '— and it scores exactly 0.00° here. v3 §67 states the condition in one line: ' +
        'Poseが計算結果により変化.',
    ]),
    el('p', { class: 'footnote' }, [
      'Inlier drift and planar flips carry the control’s own figures beside them, and that is ' +
        'the point of showing them. The *exact* epipolar geometry maps exactly under an ' +
        'image-space rotation — `b′ᵀ(Hⱼ⁻ᵀF)a = bᵀFa` — but the inlier test is a **pixel ' +
        'threshold**, and a Sampson distance is not invariant under a projective map of one ' +
        'image, so a correspondence sitting on 1.5 px can cross. What the control drifts is what ' +
        'refitting the same data costs; what the injection drifts beyond that is the question.',
    ]),
    ...(s.injections.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recent injections']),
          ...s.injections.slice(-4).map((inj) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${inj.requestedDeg}° asked`]),
              el('span', { class: 'cap-method' }, [
                `${deg(inj.recoveredDeg)} moved · control ${deg(inj.controlDeg)}`,
              ]),
              el('span', {
                class: `cap-state ${Math.abs(inj.recoveredDeg - inj.requestedDeg) <= INJECTION_TOLERANCE_DEG ? 's-AVAILABLE' : 's-PERMISSION_DENIED'}`,
              }, [`${inj.inliersBefore} → ${inj.inliersAfter} inliers`]),
            ]),
          ),
        ]
      : []),
  ]);
}

/** POSE-002 — the second instrument, and the reason this phase cannot pass off the device. */
function renderGyro(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.rotationSamples >= MIN_JUDGED_FRAMES;
  const agreeing =
    enough &&
    s.medianRotationDisagreementDeg >= 0 &&
    s.medianRotationDisagreementDeg <= Math.max(ROTATION_AGREEMENT_DEG, 0.3 * s.medianGyroRotationDeg);

  return card('Does the camera agree with the gyroscope?', [
    el('div', { class: 'stat-grid' }, [
      stat('Camera says', deg(s.medianVisualRotationDeg)),
      stat('Gyroscope says', s.gyroAvailable ? deg(s.medianGyroRotationDeg) : 'not available',
        s.gyroAvailable ? '' : 's-PERMISSION_REQUIRED'),
      stat('Disagreement', deg(s.medianRotationDisagreementDeg),
        enough ? (agreeing ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Comparable frames', enough
        ? `${s.rotationSamples} of ${s.rotationComparisons}`
        : `${s.rotationSamples} / ${MIN_JUDGED_FRAMES}`),
      stat('Frames agreeing', pct(s.rotationAgreementRate),
        s.rotationAgreementRate > 1
          ? 's-PERMISSION_DENIED'
          : s.rotationAgreementRate >= MIN_ROTATION_AGREEMENT_RATE ? 's-AVAILABLE' : ''),
      stat('This frame', s.poseFrames > 0 ? deg(s.rotationDeg) : null),
    ]),
    el('p', { class: 'footnote' }, [
      s.gyroAvailable
        ? `The gyroscope's rotation is integrated over the same interval the pose spans — anchor ` +
          'to now — by composing the rotation vector properly rather than integrating |ω|, which ' +
          'is the total path and would over-read on any wobble. The solver never sees it: it is a ' +
          'different sensor on a different thread.'
        : s.gyroReason ||
          'Without the gyroscope there is no instrument independent of the pose solver that can ' +
            'say how far the camera actually turned, so POSE-002 reports PENDING with that ' +
            'reason instead of being judged. This is why Phase 6 cannot pass off the device.',
    ]),
    el('p', { class: 'footnote' }, [
      'Every figure here is over the **retained window** — §56 bounds what a twenty-minute ' +
        'session may keep — and "comparable frames" is that window beside the total ever ' +
        'compared. They are shown together because they came apart once: an agreement counter ' +
        'that kept climbing over a denominator that stopped at 400 reported 232.3% agreeing on ' +
        'the device, and a rate above 100% is not a rate.',
    ]),
    el('p', { class: 'footnote' }, [
      `Only frames where the gyroscope measured at least ${MIN_COMPARABLE_ROTATION_DEG}° are ` +
        'compared. An agreement between two zeros is not an agreement — a phone held still gives ' +
        '0° from both instruments, and a stage returning a constant identity rotation matches it ' +
        'perfectly.',
    ]),
    el('p', { class: 'footnote' }, [
      'Angles only, never axes. `rotationRate` is expressed in the device’s frame and the ' +
        'camera’s differs from it by a fixed rotation nobody here has measured; a rotation angle ' +
        'is invariant under that change of basis and an axis is not. And v3 §19 lists ' +
        '`IMU consistency` among the pose confidence inputs — this phase withholds it precisely ' +
        'so that this comparison means something.',
    ]),
  ]);
}

function renderPose(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const stateClass =
    s.state === PoseState.POSE
      ? 's-AVAILABLE'
      : s.state === PoseState.ROTATION_ONLY
        ? 's-PERMISSION_REQUIRED'
        : 's-PERMISSION_DENIED';

  return card('This frame (v3 §15)', [
    el('div', { class: 'stat-grid' }, [
      stat('State', s.poseFrames > 0 ? s.state : null, stateClass),
      stat('From', s.source ?? (s.poseFrames > 0 ? 'nothing' : null)),
      stat('Rotation', deg(s.rotationDeg)),
      stat('Translation', vec(s.translation) ?? (s.poseFrames > 0 ? 'none' : null)),
      stat('Scale', s.scale, s.scale === 'LOCAL_UNITS' ? 's-AVAILABLE' : 's-PERMISSION_DENIED'),
      stat('In front of both', s.correspondences > 0
        ? `${s.pointsInFront} / ${s.correspondences}` : null,
        s.correspondences > 0 && s.pointsInFront / s.correspondences >= MIN_CHEIRALITY_FRACTION
          ? 's-AVAILABLE' : ''),
      stat('Reprojection', px(s.reprojectionErrorPx),
        s.reprojectionErrorPx >= 0 && s.reprojectionErrorPx <= MAX_REPROJECTION_PX ? 's-AVAILABLE' : ''),
      stat('Parallax left by R', px(s.rotationOnlyResidualPx)),
      stat('Ambiguous', s.ambiguous ? 'yes' : 'no', s.ambiguous ? 's-PERMISSION_REQUIRED' : ''),
      stat('Frames', String(s.poseFrames)),
      stat('State mismatches', String(s.stateMismatches),
        s.stateMismatches > 0 ? 's-PERMISSION_DENIED' : ''),
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
    el('p', { class: 'footnote' }, [s.stateReason || 'Pose recovery has not run.']),
    el('p', { class: 'footnote' }, [
      `"Parallax left by R" is what rotation alone cannot explain, measured on the ` +
        'correspondences rather than read off the decomposition: `K·R·K⁻¹` predicts where every ' +
        `point would be if the camera had only turned, and the median distance to where it ` +
        `actually is *is* the parallax a translation accounts for. At or under ` +
        `${PURE_ROTATION_PARALLAX_PX} px — §13’s acceptable forward/backward band — there is ` +
        'nothing left for a translation to explain, and none is reported.',
    ]),
    ...(s.cheirality.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Candidates, and how many points each put in front']),
          ...s.cheirality.map((c) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [
                `#${c.candidate}${c.candidate === s.chosen ? ' ← chosen' : ''}`,
              ]),
              el('span', { class: 'cap-method' }, [deg(c.rotationDeg)]),
              el('span', { class: `cap-state ${c.candidate === s.chosen ? 's-AVAILABLE' : ''}` }, [
                `${c.inFront} in front of both cameras`,
              ]),
            ]),
          ),
          el('p', { class: 'footnote' }, [
            'All of them, not just the winner. Decomposing an Essential matrix gives four ' +
              'candidates and exactly one places the scene in front of both cameras; showing ' +
              'only the chosen one would make the decision an assertion. A homography gives up ' +
              'to eight, and the ones cheirality cannot separate are a genuine ambiguity that ' +
              'needs a third view — reported, never tie-broken.',
          ]),
        ]
      : []),
  ]);
}

function renderPlanar(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const lowered = s.planarTranslationNotLowered === 0 &&
    s.medianPlanarUnseparated > s.medianNonPlanarUnseparated;

  return card('Planar scene handling (v3 §16)', [
    el('div', { class: 'stat-grid' }, [
      stat('Planar frames posed', String(s.planarPosedFrames),
        s.planarPosedFrames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('Non-planar frames posed', String(s.nonPlanarPosedFrames),
        s.nonPlanarPosedFrames >= MIN_JUDGED_FRAMES ? 's-AVAILABLE' : ''),
      stat('Planar via Essential', String(s.planarFromEssential),
        s.planarFromEssential > 0 ? 's-PERMISSION_DENIED' : 's-AVAILABLE'),
      stat('Unseparated candidates, planar', s.medianPlanarUnseparated >= 0
        ? String(s.medianPlanarUnseparated) : null, lowered ? 's-AVAILABLE' : ''),
      stat('...and with depth', s.medianNonPlanarUnseparated >= 0
        ? String(s.medianNonPlanarUnseparated) : null),
      stat('Not lowered', String(s.planarTranslationNotLowered),
        s.planarTranslationNotLowered > 0 ? 's-PERMISSION_DENIED' : ''),
      stat('Translation confidence', s.medianPlanarTranslationConfidence >= 0
        ? `${s.medianPlanarTranslationConfidence} planar · ${s.medianNonPlanarTranslationConfidence} with depth`
        : null),
      stat('Ambiguous frames', String(s.ambiguousFrames)),
    ]),
    el('p', { class: 'footnote' }, [
      'A planar scene is decomposed from the homography, never from the Essential matrix. An E ' +
        'fitted to a plane is degenerate: it still decomposes, and the pose it yields looks ' +
        'entirely reasonable. That is the failure v3 §16 exists to prevent, and it is invisible ' +
        'to every other number on this screen.',
    ]),
    el('p', { class: 'footnote' }, [
      'The lowered translation confidence is **counted, not chosen**. A homography ' +
        'decomposition leaves a genuine two-fold ambiguity that two views cannot resolve, so ' +
        'where cheirality could not separate k candidates the translation is one of k equally ' +
        'supported answers and the term is 1/k — generically a half on a plane. Nothing is ' +
        'assumed about planes; the candidates are counted, and the counts are the two figures ' +
        'above.',
    ]),
    el('p', { class: 'footnote' }, [
      'The two confidence figures are **reported, not compared across classes**. Each is the ' +
        'minimum over several terms: on a plane the binding term is the penalty (a half, every ' +
        'time), and on a scene with depth it is whatever else was worst — often the feature ' +
        'count. Two runs of the automated leg on identical code disagreed about which was ' +
        'lower, because the comparison was measuring the population and not the planar ' +
        'handling. What is judged is the mechanism: every planar frame lowered, and the ' +
        'ambiguity found where a plane produces one.',
    ]),
  ]);
}

function renderConfidence(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Pose confidence (v3 §19)', [
    el('div', { class: 'stat-grid' }, [
      stat('Overall', s.poseFrames > 0 ? String(s.confidence) : null),
      stat('Rotation', s.poseFrames > 0 ? String(s.rotationConfidence) : null),
      stat('Translation', s.poseFrames > 0 ? String(s.translationConfidence) : null),
      stat('Median over the run', s.medianConfidence >= 0 ? String(s.medianConfidence) : null),
    ]),
    ...(s.confidenceTerms.length > 0
      ? s.confidenceTerms.map((t) =>
          el('div', { class: 'cap-row' }, [
            el('span', { class: 'cap-label' }, [t.name]),
            el('span', { class: 'cap-method' }, [t.value < 0 ? '—' : String(t.value)]),
            el('span', { class: 'cap-state' }, [t.note]),
          ]),
        )
      : [el('p', { class: 'empty' }, ['No pose yet.'])]),
    el('p', { class: 'footnote' }, [
      'The **minimum** over its terms, not the average. v3 §19 ends with a prohibition — ' +
        '不確実なPoseは強制的に高confidenceにしない — and an average is exactly how an uncertain ' +
        'pose acquires a high confidence: five comfortable terms carry one bad one and the ' +
        'number comes out reassuring. Every term is shown so it can be taken apart.',
    ]),
    ...(s.confidenceWithheld.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Withheld, by name']),
          ...s.confidenceWithheld.map((w) => el('p', { class: 'footnote' }, [w])),
        ]
      : []),
  ]);
}

function renderIntrinsics(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const k = s.intrinsics;
  return card('Camera intrinsics — INTRINSICS: ESTIMATED (v3 §15)', [
    el('div', { class: 'stat-grid' }, [
      stat('fx, fy', k ? `${Math.round(k.fx)}, ${Math.round(k.fy)}` : null),
      stat('cx, cy', k ? `${Math.round(k.cx)}, ${Math.round(k.cy)}` : null),
      stat('Frame', k ? `${k.width} × ${k.height}` : null),
      stat('Assumed FOV', `${NOMINAL_FOV_DEG}° across the long edge`, 's-PERMISSION_REQUIRED'),
      stat('±20% moves rotation by', deg(s.medianSensitivityRotationDeg)),
      stat('...and translation by', deg(s.medianSensitivityTranslationDeg)),
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §15 gives the matrix and, in the same breath, what to do when it cannot be obtained: ' +
        '**INTRINSICS: ESTIMATED**. It cannot be obtained. Safari exposes no focal length, no ' +
        'sensor size and no lens identifier; the device reports a label, a resolution and ' +
        'nothing about optics, and nobody is going to print a chessboard to play a ball game.',
    ]),
    el('p', { class: 'footnote' }, [
      'So the two figures on the right are the honest half of being allowed to say that: the ' +
        'same pose recomputed with `f` scaled ±20 %, and how far it moved. What barely moves ' +
        'does not depend on the guess; what moves does. A nominal field of view stated without ' +
        'them would be a guess with a number attached.',
    ]),
    el('p', { class: 'footnote' }, [
      '§H.0: K is recomputed on every frame rather than read once at open. Rotating the device ' +
        'swaps the frame dimensions on the same track — 1280×720 ↔ 720×1280 — and fx, fy, cx ' +
        'and cy all change with them.',
    ]),
  ]);
}

function renderCost(vm: Phase6ViewModel): HTMLElement {
  const s = vm.stats;
  const total = s.meanPoseMs >= 0 && vm.verifyMs >= 0 ? s.meanPoseMs + vm.verifyMs : -1;
  const within = total >= 0 && total <= POSE_PIPELINE_BUDGET_MS;
  return card('Cost (§H’s budget)', [
    el('div', { class: 'stat-grid' }, [
      stat('Pose recovery', s.meanPoseMs >= 0 ? `${s.meanPoseMs} ms` : null),
      stat('Phase 5 RANSAC', vm.verifyMs >= 0 ? `${vm.verifyMs} ms` : null),
      stat('Together', total >= 0 ? `${Math.round(total * 1000) / 1000} ms` : null,
        total >= 0 ? (within ? 's-AVAILABLE' : 's-PERMISSION_DENIED') : ''),
      stat('Budget', `${POSE_PIPELINE_BUDGET_MS} ms`),
      stat('Samples', String(s.poseCostSamples)),
      stat('Frames with a pose', String(s.posedFrames)),
    ]),
    el('p', { class: 'footnote' }, [
      `§H budgets "RANSAC (E/H) + pose recovery" as **one** ${POSE_PIPELINE_BUDGET_MS} ms line, ` +
        'so the sum is what is measured against it rather than this phase claiming a fresh ' +
        'allowance for itself. Phase 5’s device run already spent 3.45 ms of it.',
    ]),
    el('p', { class: 'footnote' }, [
      'POSE-006 is advisory for the reason §34 gives — correctness before performance — and ' +
        'because §H.4 records that a device budget cannot be adjudicated off the device. Both ' +
        'models are still fitted on every judged frame and both decompositions still run; v3 §16 ' +
        'is not skipped to save time.',
    ]),
  ]);
}

function renderTests(vm: Phase6ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const counts = {
    pass: vm.results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: vm.results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: vm.results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  return card(`Tests — Phase 6 · ${vm.phase6.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase6.state}`, id: 'phase6-verdict' }, [vm.phase6.state]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase6.reason]),
    ...vm.results.map((r) =>
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
    ),
  ]);
}

function renderEvidence(vm: Phase6ViewModel, handlers: Phase6Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase6-pending-warning' }, [
        `This export would record ${vm.phase6.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p6',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase6.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p6',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}

function renderNavigation(vm: Phase6ViewModel, handlers: Phase6Handlers): HTMLElement {
  const open = vm.canEnterPhase7 && vm.phase7Implemented;
  const label = !vm.phase7Implemented
    ? 'IMU SUPPORT / FUSION — NOT IMPLEMENTED'
    : !vm.canEnterPhase7
      ? 'IMU SUPPORT / FUSION — LOCKED'
      : 'GO TO IMU SUPPORT / FUSION';
  const note = !vm.phase7Implemented
    ? 'Phase 7 has not been written in this build.'
    : !vm.canEnterPhase7
      ? vm.phase7BlockedReason
      : `Phase 7 is ${vm.phase7.state}.`;

  return card('Navigation', [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase5',
        textContent: 'BACK TO VERIFICATION',
        onclick: handlers.onBack,
      } as never),
      el('button', {
        class: 'primary',
        id: 'go-to-phase7',
        disabled: !open,
        textContent: label,
        onclick: handlers.onEnterPhase7,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [note]),
  ]);
}
