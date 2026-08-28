/**
 * LANDMARK MAP screen (Phase 10, v4 §22, §56, §34).
 *
 * The first screen with a **world** on it, and four things are here because of what a world can
 * be faked into.
 *
 *  - **"Does the map predict what has not happened yet?" is the top panel.** A map that
 *    overwrites each landmark with the newest triangulation agrees with every observation
 *    exactly, is never inconsistent, and has nothing to predict *with*. The held-out error is the
 *    only figure it cannot produce.
 *  - **The injection is beside it**, with the false-cull rate printed next to the recall, because
 *    a map that rejects everything scores a perfect recall and one that rejects nothing scores a
 *    perfect false-cull rate. GEO-003's pair, one layer up.
 *  - **The registration's scale is shown as a ratio, never as a length.** It is the number this
 *    phase exists to recover, and it is what makes Phase 9's ninety separate answers one map.
 *  - **The sparsity is a number.** v4 §22 forbids treating this as a model; a screen full of
 *    points implies otherwise unless it says how few of them there are and what lies between.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  INJECTION_RECALL_FLOOR,
  LANDMARK_BUDGET_MS,
  LANDMARK_INJECTION_FRACTION,
  MAX_CLEAN_CULL_EXCESS,
  MAX_LANDMARKS,
  MAX_LANDMARK_REPROJECTION_PX,
  MAX_REGISTRATION_RESIDUAL,
  MIN_INJECTIONS,
  MIN_JUDGED_BATCHES,
  MIN_OBSERVATIONS_CONFIRMED,
  MIN_REGISTRATION_POINTS,
} from '../testkit/Phase10Tests';
import type { LandmarkStats } from '../tracking/landmarkStats';
import { BAD, OK, card, deg, el, num, pct, px, stat, vec } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase10ViewModel {
  readonly phase10: PhaseInfo;
  readonly phase11: PhaseInfo;
  readonly canEnterPhase11: boolean;
  readonly phase11Implemented: boolean;
  readonly phase11BlockedReason: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  readonly running: boolean;
  readonly stats: LandmarkStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase10Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase11: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase10Screen(
  root: HTMLElement,
  vm: Phase10ViewModel,
  handlers: Phase10Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Landmark Map']),
      el('p', {}, [
        'Phase 10 — one frame for what Phase 9 leaves as ninety separate answers. Each of its ' +
          'batches is in units of its own pair’s baseline; the landmarks two batches share fix ' +
          'the ratio between them, which is the only mechanism a monocular camera has. The world ' +
          'has a consistent unit and no known one.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderPrediction(vm));
  root.append(renderInjection(vm));
  root.append(renderRegistration(vm));
  root.append(renderMap(vm));
  root.append(renderConvergence(vm));
  root.append(renderNotAModel(vm));
  root.append(renderCost(vm));
  root.append(testsSection(10, vm.phase10, vm.results));
  root.append(
    evidenceSection(10, vm.phase10, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 9, label: 'BACK TO TRIANGULATION', onClick: handlers.onBack },
      {
        index: 11,
        name: 'SURFACE UNDERSTANDING',
        phase: vm.phase11,
        canEnter: vm.canEnterPhase11,
        implemented: vm.phase11Implemented,
        blockedReason: vm.phase11BlockedReason,
        onClick: handlers.onEnterPhase11,
      },
    ),
  );
}

function renderPreview(vm: Phase10ViewModel, handlers: Phase10Handlers): HTMLElement {
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
          ? 'The landmarks are not drawn on the picture. A few hundred points over a camera ' +
            'image reads as a reconstruction, and v4 §22 says in one line that this is not one — ' +
            'so the map is reported as numbers until there is a phase whose job is to show it.'
          : vm.running
            ? 'Waiting for the first batch. The map needs a keyframe pair Phase 9 could triangulate.'
            : 'Triangulation is live. The map has not been started.',
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
              : 'LANDMARK MAP NOT STARTED';
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
        id: 'start-landmarks',
        // §H.5, for the eighth time and from the one predicate.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'MAPPING' : vm.opening ? 'REQUESTING…' : 'START LANDMARK MAP',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-landmarks',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('Camera', children);
}

/** MAP-002 — the gate. Nothing else here separates a map from a list of the last batch. */
function renderPrediction(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.heldOutBatches >= MIN_JUDGED_BATCHES;
  const within = enough && s.medianHeldOutPx <= MAX_LANDMARK_REPROJECTION_PX;
  const copying = enough && s.heldOutSamples > 0 && s.zeroHeldOut === s.heldOutSamples;
  return card('Does the map predict what it has not seen?', [
    el('div', { class: 'stat-grid' }, [
      stat('Held-out error', px(s.medianHeldOutPx), enough ? (within ? OK : BAD) : ''),
      stat('Ceiling', `${MAX_LANDMARK_REPROJECTION_PX} px`),
      stat('Worst', px(s.worstHeldOutPx)),
      stat('Batches', enough ? String(s.heldOutBatches) : `${s.heldOutBatches} / ${MIN_JUDGED_BATCHES}`),
      stat('Exactly zero', String(s.zeroHeldOut), copying ? BAD : ''),
      stat('Observations when asked', num(s.medianObservationsAtPrediction)),
    ]),
    el('p', { class: 'footnote' }, [
      'A landmark’s position, **as the map held it before this batch**, is projected into the ' +
        'keyframe the batch has just added — a view that position was not computed from — and ' +
        'compared against where the tracker actually saw it. The observation count each landmark ' +
        'had at that moment travels with the record, so "before" is something the evidence says ' +
        'rather than something the code claims.',
    ]),
    el('p', { class: 'footnote' }, [
      'This is the only figure a map with no memory cannot produce. Overwrite each landmark with ' +
        'the newest triangulation and it agrees with every observation exactly, is never ' +
        'inconsistent, keeps every count right, and has nothing at all to predict with.',
    ]),
  ]);
}

/** MAP-005 — the second gate, with GEO-003's pair of numbers. */
function renderInjection(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.injections >= MIN_INJECTIONS;
  const found = enough && s.medianRecall >= INJECTION_RECALL_FLOOR;
  const spared = enough && s.medianCleanExcess <= MAX_CLEAN_CULL_EXCESS;
  return card('Does the map find what it was not told about?', [
    el('div', { class: 'stat-grid' }, [
      stat('Recall', pct(s.medianRecall), enough ? (found ? OK : BAD) : ''),
      stat('Floor', pct(INJECTION_RECALL_FLOOR)),
      stat('Untouched, rejected', pct(s.medianCleanRejectionRate)),
      stat('...uncorrupted, the same gate refuses', pct(s.medianBaselineRejectionRate)),
      stat('Excess', pct(s.medianCleanExcess), enough ? (spared ? OK : BAD) : ''),
      stat('Ceiling', pct(MAX_CLEAN_CULL_EXCESS)),
      stat('Injections', enough ? String(s.injections) : `${s.injections} / ${MIN_INJECTIONS}`),
      stat('Displacement', px(s.injectionDisplacementPx)),
    ]),
    el('p', { class: 'footnote' }, [
      `A known subset of the batch's positions is displaced **perpendicular to the viewing ray** ` +
        `by ${LANDMARK_INJECTION_FRACTION} of the point's depth and handed over unmarked. Moving ` +
        'a point *along* its ray changes its depth and barely moves it in the image; moving it ' +
        'across moves the projection by `f · Δ/Z`, and at `Δ = 0.05 Z` the depth cancels — the ' +
        'same displacement in pixels for a near point and a far one.',
    ]),
    el('p', { class: 'footnote' }, [
      'The map is asked what it *would* do rather than being made to do it, so finding out ' +
        'whether the gate works does not corrupt the thing being measured. That is why GEO-003 ' +
        'verifies a copy of the correspondence set rather than the set itself.',
    ]),
    el('p', { class: 'footnote' }, [
      'Every one of the numbers is reported, because each alone is scored perfectly by some ' +
        'degenerate map: recall by one that rejects everything, the untouched rate by one that ' +
        'rejects nothing, and an *absolute* untouched rate by a quiet scene.',
    ]),
    el('p', { class: 'footnote' }, [
      'The figure that is judged is the **excess**. This gate compares two estimates of one ' +
        'point, so it refuses the ordinary tail of their disagreement whether or not anything ' +
        'was injected — the same gate on the same batch, uncorrupted, is the baseline printed ' +
        'above it. What the criterion asks is whether corrupting a third of the batch made the ' +
        'gate suspicious of the innocent.',
    ]),
  ]);
}

/** MAP-003 — the scale, which is the whole point of the phase. */
function renderRegistration(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.medianRegistrationResidual >= 0 && s.medianRegistrationResidual <= MAX_REGISTRATION_RESIDUAL;
  return card('One frame', [
    el('div', { class: 'stat-grid' }, [
      stat('Registered', `${s.registeredBatches} / ${s.batches}`),
      stat('Scale recovered', num(s.medianRegistrationScale)),
      stat('Residual', s.medianRegistrationResidual < 0 ? null : String(s.medianRegistrationResidual),
        s.registeredBatches > 0 ? (within ? OK : BAD) : ''),
      stat('Limit', String(MAX_REGISTRATION_RESIDUAL)),
      stat('Epochs', `${s.epochs} (${s.epochRestarts} restart(s))`),
      stat('Scale', s.scale, s.scaleViolations > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      'A similarity — seven degrees of freedom, in closed form — is fitted from each batch’s ' +
        `frame to the world over the landmarks they share, with at least ` +
        `${MIN_REGISTRATION_POINTS} of them. **Its scale term is the ratio** between that batch's ` +
        'baseline and the world’s, and it is the quantity a monocular camera has no other way to ' +
        'obtain. It is a ratio and never a length.',
    ]),
    el('p', { class: 'footnote' }, [
      'The residual is relative to the depth, because the world’s unit is a baseline whose ' +
        `length nobody has measured. The limit is half Phase 9's depth-uncertainty limit: a ` +
        'registration at that figure has added as much error as the depths already carry.',
    ]),
    ...(Object.keys(s.unregisteredReasons).length > 0
      ? [
          el('p', { class: 'footnote' }, [
            `Batches the map could not register: ${JSON.stringify(s.unregisteredReasons)}. They ` +
              'are not ingested — a batch the map cannot place is a batch whose points would go ' +
              'somewhere arbitrary.',
          ]),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      'After five consecutive batches it cannot register, the world is redefined and the epoch ' +
        'count rises. §H.8’s three-way distinction: failed, restarted, and interrupted for a ' +
        'reason we can name — and a run with several epochs is not the same run as one with none.',
    ]),
  ]);
}

/** MAP-001 and MAP-004 — what the map holds, and what it let go of. */
function renderMap(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  return card('The map', [
    el('div', { class: 'stat-grid' }, [
      stat('Landmarks', `${s.landmarks} / ${MAX_LANDMARKS}`, s.boundBreaches > 0 ? BAD : OK),
      stat('Confirmed', `${s.confirmed} (most ${s.peakConfirmed})`),
      stat('...at', `${MIN_OBSERVATIONS_CONFIRMED} observations`),
      stat('Median confidence', num(s.medianConfidence)),
      stat('Culled', String(s.culled)),
      stat('Batch', `${s.admitted} new · ${s.merged} merged · ${s.rejected} refused`),
    ]),
    ...s.samples.map((l) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${l.id}`]),
        el('span', { class: 'cap-method' }, [
          `${vec(l.position)} · ${l.observations} obs from ${l.keyframes} view(s) · ` +
            `${deg(l.maxParallaxDeg)} parallax · predicts within ${px(l.meanPredictionPx)}`,
        ]),
        el('span', { class: `cap-state ${l.state === 'CONFIRMED' ? OK : ''}` }, [
          String(l.confidence),
        ]),
      ]),
    ),
    ...(s.recentCulls.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recently culled']),
          ...s.recentCulls.slice(-4).map((c) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`#${c.id}`]),
              el('span', { class: 'cap-method' }, [c.detail]),
              el('span', { class: 'cap-state' }, [c.reason]),
            ]),
          ),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      'Confidence is the **minimum** over four measured terms — observation count, the parallax ' +
        'that determined the point, how well its predictions land, and how many viewpoints have ' +
        'seen it. None of them is a clock: a landmark seen for a long time is not thereby a good ' +
        'landmark, and `audit-fake-data.mjs` enforces the absence of the alternative rather than ' +
        'leaving it to review.',
    ]),
  ]);
}

/** MAP-006 — does a position settle, or does it wander? */
function renderConvergence(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const settling =
    s.moveAtTwoSamples > 0 && s.moveAtFiveSamples > 0 && s.moveAtFive <= s.moveAtTwo;
  return card('Convergence', [
    el('div', { class: 'stat-grid' }, [
      stat('Move at 2 observations', s.moveAtTwo < 0 ? null : String(s.moveAtTwo)),
      stat('...at 5 or more', s.moveAtFive < 0 ? null : String(s.moveAtFive),
        s.moveAtFiveSamples > 0 ? (settling ? OK : BAD) : ''),
      stat('Samples', `${s.moveAtTwoSamples} · ${s.moveAtFiveSamples}`),
      stat('Median move', s.medianMoveRelative < 0 ? null : String(s.medianMoveRelative)),
    ]),
    el('p', { class: 'footnote' }, [
      'A landmark’s position is a running mean over its observations, so what a new one moves it ' +
        'by falls like 1/n. The figures are relative to the landmark’s own depth, because the ' +
        'world’s unit has no length and an absolute movement would be a movement in an arbitrary ' +
        'scale.',
    ]),
    el('p', { class: 'footnote' }, [
      'A map that re-guesses each time random-walks instead, and the two are distinguishable in ' +
        'exactly this figure: a random walk’s step size does not fall with the number of steps.',
    ]),
  ]);
}

/** MAP-007 — v4 §22's second line, as a value. */
function renderNotAModel(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  return card('What this is not', [
    el('div', { class: 'stat-grid' }, [
      stat('Surfaces', 'NONE', OK),
      stat('Mesh', 'NONE', OK),
      stat('Completeness', 'NOT CLAIMED', OK),
      stat('Landmarks per keyframe', num(s.landmarksPerKeyframe)),
      stat('...per tracked feature', num(s.landmarksPerTrackedFeature)),
      stat('Confirmed', `${s.confirmed} · ${pct(s.confirmedShare)} of the map`),
    ]),
    el('p', { class: 'footnote' }, [s.modelClaim]),
    el('p', { class: 'footnote' }, [
      'The density figures are what makes the sparsity a measurement. A screen full of points ' +
        'reads as a reconstruction; a dozen or so places per view, held for as long as the room ' +
        'keeps agreeing with them, reads as what it is. Phase 11 is where surfaces begin, from ' +
        'these.',
    ]),
    el('p', { class: 'footnote' }, [
      '"Per tracked feature" is a **ratio and not a share**, and it is routinely above one: the ' +
        'map remembers points that have left the frame and the tracked population does not. It ' +
        'was first reported as a percentage of the population and read 338 % — the same shape as ' +
        'Phase 6’s device run reporting an agreement rate of 232.3 %, and the reason every rate ' +
        'in this project is checked against 0..1.',
    ]),
  ]);
}

function renderCost(vm: Phase10ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanLandmarkMs >= 0 && s.meanLandmarkMs <= LANDMARK_BUDGET_MS;
  return card('Cost (§27 puts this off the frame cadence)', [
    el('div', { class: 'stat-grid' }, [
      stat('Per batch', s.meanLandmarkMs >= 0 ? `${s.meanLandmarkMs} ms` : null,
        s.meanLandmarkMs >= 0 ? (within ? OK : BAD) : ''),
      stat('Budget', `${LANDMARK_BUDGET_MS} ms`),
      stat('Amortised per frame', s.amortisedMsPerFrame < 0 ? null : `${s.amortisedMsPerFrame} ms`),
      stat('Batches timed', String(s.costSamples)),
    ]),
    el('p', { class: 'footnote' }, [
      'Half Phase 9’s per-batch ceiling, because this stage fits no two-view model: a closed-form ' +
        'similarity over a few dozen points, one projection per shared landmark, and bookkeeping.',
    ]),
    el('p', { class: 'footnote' }, [
      'The amortised figure is the one §B.2’s mapping-worker decision should be taken on, as ' +
        'Phase 9’s is. Together they are what a second thread would be buying.',
    ]),
  ]);
}
