/**
 * TRIANGULATION screen (Phase 9, v4 §21, v3 §15, §16).
 *
 * The first screen in this project that shows a **three-dimensional** quantity, and four things
 * are here because of what that quantity can be faked into.
 *
 *  - **"Are these the depths the harness chose?" is the top panel.** A triangulator returning one
 *    constant depth puts every point in front of both cameras, reprojects beautifully into both
 *    views — a two-view reprojection is dominated by the ray direction, which is right — and adds
 *    up perfectly. The control is printed beside the measurement, so what separates them is a
 *    factor of hundreds rather than a tolerance.
 *  - **The pure-rotation injection is beside it.** A camera that turns produces large,
 *    well-conditioned image motion and no parallax at all, which is what a phone does when
 *    someone stands still and turns. The count that matters is zero.
 *  - **The parallax gate is shown as an angle with its derivation**, not as a percentage of
 *    whatever the frame contained. §H.6.
 *  - **Depths are shown per batch, never pooled**, with the batch-to-batch spread printed as the
 *    number behind that refusal: on one scene with one camera the median depth moves that much
 *    between pairs purely because each baseline is a different unit.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  DEPTH_ERROR_TOLERANCE,
  DEPTH_UNCERTAINTY_LIMIT,
  INJECTED_ROTATION_DEG,
  MAX_TRIANGULATION_REPROJECTION_PX,
  MIN_CONTROL_ADVANTAGE,
  MIN_INJECTIONS,
  MIN_JUDGED_BATCHES,
  MIN_PARALLAX_DEG,
  MIN_RANK_CORRELATION,
  TRIANGULATION_BUDGET_MS,
} from '../testkit/Phase9Tests';
import type { TriangulationStats } from '../tracking/triangulationStats';
import { BAD, OK, card, deg, el, num, pct, px, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase9ViewModel {
  readonly phase9: PhaseInfo;
  readonly phase10: PhaseInfo;
  readonly canEnterPhase10: boolean;
  readonly phase10Implemented: boolean;
  readonly phase10BlockedReason: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly running: boolean;
  readonly stats: TriangulationStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase9Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase10: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase9Screen(
  root: HTMLElement,
  vm: Phase9ViewModel,
  handlers: Phase9Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Triangulation']),
      el('p', {}, [
        'Phase 9 — where a point **is**, not merely where it appears, from two keyframes far ' +
          'enough apart to determine one. v4 §21 asks for sparse information from sufficient ' +
          'parallax and forbids forcing a great many points out of very little; both halves are ' +
          'numbers here. Every depth is in units of its own pair’s baseline, which is 1 by ' +
          'construction and has no length in the world.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderDepthInjection(vm));
  root.append(renderRotationInjection(vm));
  root.append(renderBatch(vm));
  root.append(renderGates(vm));
  root.append(renderRotationCheck(vm));
  root.append(renderScale(vm));
  root.append(renderCost(vm));
  root.append(testsSection(9, vm.phase9, vm.results));
  root.append(
    evidenceSection(9, vm.phase9, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 8, label: 'BACK TO KEYFRAME SYSTEM', onClick: handlers.onBack },
      {
        index: 10,
        name: 'LANDMARK MAP',
        phase: vm.phase10,
        canEnter: vm.canEnterPhase10,
        implemented: vm.phase10Implemented,
        blockedReason: vm.phase10BlockedReason,
        onClick: handlers.onEnterPhase10,
      },
    ),
  );
}

function renderPreview(vm: Phase9ViewModel, handlers: Phase9Handlers): HTMLElement {
  const children: (Node | string)[] = [];
  const s = vm.stats;
  if (vm.trackLive) {
    const ratio =
      vm.sourceWidth > 0 && vm.sourceHeight > 0 ? `${vm.sourceWidth} / ${vm.sourceHeight}` : '3 / 4';
    children.push(
      el('div', { class: 'overlay-stack', style: `aspect-ratio: ${ratio}` } as never, [
        getPreviewVideo(),
      ]),
      el('p', { class: 'footnote' }, [
        s.batches > 0
          ? 'The triangulated points are not drawn on the picture. They belong to a pair of ' +
            'keyframes, not to this frame, and each pair’s depths are in that pair’s own units — ' +
            'so a drawing of them over the live image would be a picture of several different ' +
            'scales at once. Phase 10 is where they come into one frame.'
          : vm.running
            ? 'Waiting for the second keyframe. A batch needs a pair.'
            : 'The keyframe store is live. Triangulation has not been started.',
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
              : 'TRIANGULATION NOT STARTED';
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
        id: 'start-triangulation',
        // §H.5, for the seventh time and from the one predicate.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'TRIANGULATING' : vm.opening ? 'REQUESTING…' : 'START TRIANGULATION',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-triangulation',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('Camera', children);
}

/** TRI-004 — the gate. Nothing else here separates a triangulator from one constant. */
function renderDepthInjection(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.depthInjections >= MIN_INJECTIONS;
  const close = enough && s.medianDepthError <= DEPTH_ERROR_TOLERANCE;
  const ahead = enough && s.medianDepthError * MIN_CONTROL_ADVANTAGE <= s.medianControlError;
  const ordered = enough && s.medianRankCorrelation >= MIN_RANK_CORRELATION;

  return card('Are these the depths the harness chose?', [
    el('div', { class: 'stat-grid' }, [
      stat('Relative error', s.medianDepthError < 0 ? null : String(s.medianDepthError),
        enough ? (close ? OK : BAD) : ''),
      stat('Tolerance', String(DEPTH_ERROR_TOLERANCE)),
      stat('A constant depth scores', s.medianControlError < 0 ? null : String(s.medianControlError),
        enough ? (ahead ? OK : BAD) : ''),
      stat('Rank correlation', s.medianRankCorrelation < -1 ? null : String(s.medianRankCorrelation),
        enough ? (ordered ? OK : BAD) : ''),
      stat('Injections', enough ? String(s.depthInjections) : `${s.depthInjections} / ${MIN_INJECTIONS}`),
      stat('Worst error', s.worstDepthError < 0 ? null : String(s.worstDepthError)),
    ]),
    el('p', { class: 'footnote' }, [
      'The harness picks a depth for every point, projects it through a rotation and a unit ' +
        'translation it also picked — using this frame’s own intrinsics — and hands the ' +
        'correspondences over with no marking. The **whole chain** runs on them: fit, decompose, ' +
        'triangulate. Nothing in the triangulator can see which set it has.',
    ]),
    el('p', { class: 'footnote' }, [
      '"A constant depth scores" is the error the best possible single number would have made on ' +
        'the same set. It is printed because a tolerance on its own proves nothing: a stage that ' +
        'returns one depth for everything passes every other criterion in this phase — every ' +
        'point in front of both cameras, every reprojection small, every count adding up — and ' +
        'scores exactly that number here.',
    ]),
    ...(s.lastDepthInjection
      ? [
          el('p', { class: 'group-title' }, ['The last injection']),
          el('div', { class: 'cap-row' }, [
            el('span', { class: 'cap-label' }, [`${s.lastDepthInjection.points} points`]),
            el('span', { class: 'cap-method' }, [
              `chosen median ${s.lastDepthInjection.medianTrueDepth}, recovered ` +
                `${s.lastDepthInjection.medianRecoveredDepth}; rotation asked ` +
                `${deg(s.lastDepthInjection.requestedRotationDeg)}, recovered off by ` +
                `${deg(s.lastDepthInjection.recoveredRotationDeg)}`,
            ]),
            el('span', { class: `cap-state ${close ? OK : BAD}` }, [
              String(s.lastDepthInjection.medianRelativeError),
            ]),
          ]),
        ]
      : []),
  ]);
}

/** TRI-003 — the other gate: a camera that turned and did not move. */
function renderRotationInjection(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.rotationInjections >= MIN_INJECTIONS;
  return card('And when the camera only turned?', [
    el('div', { class: 'stat-grid' }, [
      stat('Points from a pure rotation', String(s.rotationInjectionAccepted),
        enough ? (s.rotationInjectionAccepted === 0 ? OK : BAD) : ''),
      stat('...from the untouched pair', String(s.rotationInjectionCleanAccepted),
        enough ? (s.rotationInjectionCleanAccepted > 0 ? OK : BAD) : ''),
      stat('Rotation applied', `${INJECTED_ROTATION_DEG}°`),
      stat('Injections', enough ? String(s.rotationInjections) : `${s.rotationInjections} / ${MIN_INJECTIONS}`),
      stat('The pose came back', Object.keys(s.rotationInjectionPoseStates).join(', ') || null),
      stat('Refused for parallax', String(s.lastRotationInjection?.lowParallaxRefusals ?? 0)),
    ]),
    el('p', { class: 'footnote' }, [
      'The pair’s second view is replaced by `K R K⁻¹` applied to its **first**, which is exactly ' +
        'the second view of a camera that turned by R from the same place. It has a real ' +
        'rotation, large well-conditioned image motion, and no baseline at all — every ray pair ' +
        'meets at infinity.',
    ]),
    el('p', { class: 'footnote' }, [
      'This is not a corner case. It is what a phone does when someone stands still and turns, ' +
        'which is most of a room scan. A triangulator that solves the linear system anyway gets ' +
        'an answer — at whatever depth the noise implied — and reports a full set of points from ' +
        'a camera that never moved.',
    ]),
    el('p', { class: 'footnote' }, [
      'The untouched pair’s count is printed beside it, because a refusal on its own is scored ' +
        'perfectly by a stage that refuses everything.',
    ]),
  ]);
}

/** TRI-001 — what the last batch did, and what the run has done. */
function renderBatch(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  return card('The last pair', [
    el('div', { class: 'stat-grid' }, [
      stat('State', s.state, s.state === 'TRIANGULATED' ? OK : ''),
      stat('Keyframes', s.keyframePair ? `#${s.keyframePair[0]} → #${s.keyframePair[1]}` : null),
      stat('Shared observations', String(s.correspondences)),
      stat('Verified', String(s.inliers)),
      stat('Accepted', String(s.accepted)),
      stat('Model', s.model ?? null),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('Batches', enoughLabel(s.batches, MIN_JUDGED_BATCHES)),
      stat('Triangulated', `${s.batchesTriangulated} / ${s.batches}`),
      stat('Points in total', String(s.totalAccepted)),
      stat('Median per batch', num(s.medianAcceptedPerBatch)),
      stat('Per keyframe', num(s.pointsPerKeyframe)),
      stat('Refused batches', String(s.batchesRefused)),
    ]),
    el('p', { class: 'footnote' }, [s.stateReason]),
    ...(Object.keys(s.batchRefusalsByReason).length > 0
      ? [
          el('p', { class: 'footnote' }, [
            `Batch refusals: ${JSON.stringify(s.batchRefusalsByReason)}. A pair that verified ` +
              'nothing, or that recovered only a rotation, is refused whole — a batch that ' +
              'produced no geometry produces no points.',
          ]),
        ]
      : []),
    ...s.samples.map((p) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${p.id}`]),
        el('span', { class: 'cap-method' }, [
          `${vec(p.position)} · depth ${p.depth} · ${deg(p.parallaxDeg)} parallax · ` +
            `σ/Z ${p.depthUncertainty} · ${px(p.reprojectionPx)}`,
        ]),
        el('span', { class: 'cap-state' }, [String(p.depth)]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      'Points are matched between the two keyframes by **feature id**, never by proximity. The ' +
        'ids come from the tracker and are unique for the life of the run, so a match here is ' +
        'the same physical point followed across the gap rather than two points that happen to ' +
        'be near each other — which is also what makes a triangulated point recognisable to ' +
        'Phase 10.',
    ]),
  ]);
}

/** TRI-002 and TRI-005 — the gates, and what they refused. */
function renderGates(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const belowFloor = s.worstAcceptedParallaxDeg >= 0 && s.worstAcceptedParallaxDeg < MIN_PARALLAX_DEG;
  const overCeiling = s.worstAcceptedReprojectionPx > MAX_TRIANGULATION_REPROJECTION_PX;
  return card('What was refused, and why', [
    el('div', { class: 'stat-grid' }, [
      stat('Parallax floor', `${MIN_PARALLAX_DEG}°`),
      stat('Median parallax', deg(s.medianParallaxDeg)),
      stat('...of the accepted', deg(s.medianAcceptedParallaxDeg)),
      stat('Worst accepted', deg(s.worstAcceptedParallaxDeg), belowFloor ? BAD : OK),
      stat('Depth uncertainty', s.medianDepthUncertainty < 0 ? null : String(s.medianDepthUncertainty),
        s.medianDepthUncertainty > DEPTH_UNCERTAINTY_LIMIT ? BAD : OK),
      stat('Acceptance rate', pct(s.acceptanceRate)),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('Reprojection ceiling', `${MAX_TRIANGULATION_REPROJECTION_PX} px`),
      stat('Median reprojection', px(s.medianReprojectionPx)),
      stat('Worst accepted', px(s.worstAcceptedReprojectionPx), overCeiling ? BAD : OK),
      stat('Low parallax', String(s.lowParallaxRefusals)),
      stat('Behind a camera', String(s.behindCameraRefusals)),
      stat('High reprojection', String(s.highReprojectionRefusals)),
    ]),
    el('p', { class: 'footnote' }, [
      `The floor is an **angle**, and it is derived rather than chosen. A triangulated depth's ` +
        'relative uncertainty is σ_θ/θ: §13’s 1.5 px correspondence band over the assumed focal ' +
        `length is 0.089° of angular noise, and asking for a depth good to ` +
        `${DEPTH_UNCERTAINTY_LIMIT} of itself gives 0.89°. A percentile of whatever the frame ` +
        'happened to contain could not express "there is not enough parallax here" — §H.6.',
    ]),
    el('p', { class: 'footnote' }, [
      'The gates run in the order in which a failure makes the later ones meaningless: a point ' +
        'the linear system could not solve has no depth to check the sign of, and a point with ' +
        'too little parallax has a reprojection error that says nothing — a badly conditioned ' +
        'solution reprojects beautifully into both views, which is exactly why the reprojection ' +
        'check cannot be the gate.',
    ]),
  ]);
}

/** TRI-006 — the fresh fit, and the witness it needs. */
function renderRotationCheck(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const within =
    s.rotationSamples > 0 && s.medianRotationDisagreementDeg <= s.rotationToleranceDeg;
  return card('Two routes to one rotation', [
    el('div', { class: 'stat-grid' }, [
      stat('The pair fit says', deg(s.medianRotationDeg)),
      stat('Phase 6’s chain disagrees by', deg(s.medianRotationDisagreementDeg),
        s.rotationSamples > 0 ? (within ? OK : BAD) : ''),
      stat('Tolerance', deg(s.rotationToleranceDeg)),
      stat('Inside it', `${s.rotationsWithinTolerance} / ${s.rotationSamples}`),
      stat('Batches', enoughLabel(s.rotationSamples, MIN_JUDGED_BATCHES)),
      stat('Exactly zero', String(s.zeroDisagreements),
        s.rotationSamples > 0 && s.zeroDisagreements === s.rotationSamples ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      'The pose for this pair is a **fresh fit**, because no model exists for it — Phase 5 and ' +
        'Phase 6 relate the anchor to the current frame, and this relates one keyframe to ' +
        'another. A fresh fit needs a witness, and one exists that costs nothing: Phase 6 already ' +
        'measured the rotation between these two views by an entirely different route, per-frame ' +
        'poses against a moving anchor, composed by Phase 8 across anchor epochs.',
    ]),
    el('p', { class: 'footnote' }, [
      'The tolerance is Phase 6’s own — max(3°, 30 % of measured) — reused unchanged, because ' +
        'these are the same two quantities POSE-002 compared. Inventing a new one here would be ' +
        'two phases disagreeing about when two rotations agree.',
    ]),
  ]);
}

/** TRI-007 — no distance, with the number behind the refusal to pool. */
function renderScale(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Scale', [
    el('div', { class: 'stat-grid' }, [
      stat('Scale', s.scale, s.scaleViolations > 0 ? BAD : OK),
      stat('Baseline', `${s.baselineUnits} by construction`),
      stat('Median batch depth', num(s.medianBatchDepth)),
      stat('Batch-to-batch spread', s.batchDepthSpread < 0 ? null : String(s.batchDepthSpread)),
      stat('Points per batch', num(s.medianAcceptedPerBatch)),
      stat('Points per keyframe', num(s.pointsPerKeyframe)),
    ]),
    el('p', { class: 'footnote' }, [s.baselineNote]),
    el('p', { class: 'footnote' }, [
      'The spread is the number behind the refusal. On one scene with one camera, the median ' +
        'depth moves by that much between batches — not because the room changed, but because ' +
        'each pair’s baseline is a different unit. Averaging them would be averaging over ' +
        'incommensurable quantities, and no record here does it. Phase 10 is where the batches ' +
        'are brought into one frame by the landmarks they share.',
    ]),
    el('p', { class: 'footnote' }, [
      'The last two figures are what makes *Sparse Spatial Information* a measurement rather ' +
        'than an adjective.',
    ]),
  ]);
}

function renderCost(vm: Phase9ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanTriangulationMs >= 0 && s.meanTriangulationMs <= TRIANGULATION_BUDGET_MS;
  return card('Cost (§27 puts this off the frame cadence)', [
    el('div', { class: 'stat-grid' }, [
      stat('Per keyframe insert', s.meanTriangulationMs >= 0 ? `${s.meanTriangulationMs} ms` : null,
        s.meanTriangulationMs >= 0 ? (within ? OK : BAD) : ''),
      stat('Budget', `${TRIANGULATION_BUDGET_MS} ms`),
      stat('Amortised per frame', s.amortisedMsPerFrame < 0 ? null : `${s.amortisedMsPerFrame} ms`),
      stat('Batches timed', String(s.costSamples)),
    ]),
    el('p', { class: 'footnote' }, [
      '§27 puts mapping off the tracking cadence explicitly — *triangulation on keyframe insert ' +
        'only* — so this cost lands on roughly one frame in thirty rather than on every one. The ' +
        'budget is §H’s RANSAC line plus a third, because this fit is over a pair with a longer ' +
        'baseline and more correspondences than the anchor pair.',
    ]),
    el('p', { class: 'footnote' }, [
      '§B.2 puts a **mapping worker** in the plan from this phase. It has not been built, and ' +
        'the amortised figure above is what that decision should be taken on rather than the ' +
        'diagram: a cost that disappears into the margin does not need a second thread, and one ' +
        'that does not is the argument for building it.',
    ]),
  ]);
}

function enoughLabel(have: number, need: number): string {
  return have >= need ? String(have) : `${have} / ${need}`;
}
