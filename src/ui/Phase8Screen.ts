/**
 * KEYFRAME SYSTEM screen (Phase 8, v3 §20, v4 §20).
 *
 * Four things are here because of what Phase 8 can fake.
 *
 *  - **"What would a metronome have kept?" is the top panel.** A selector firing on a schedule
 *    satisfies every interval, every bound and every record in this phase, and on a moving
 *    camera its keyframes are as well separated as anyone's. The two counts are shown side by
 *    side over the frames where Phase 4's own scene-shift search said the image was not moving,
 *    because that is the only place the two programs differ.
 *  - **Every one of v3 §20's conditions is listed with its measured value beside its
 *    threshold**, including the one that never fires. `TRANSLATION: UNMEASURED` is displayed as
 *    a value, with the missing scale named and with the angle the translation *direction* moved
 *    printed beside it — a refusal with a number behind it is a finding; a refusal with a
 *    citation behind it is an assertion.
 *  - **The eviction is shown with its counterfactual.** What the retained set's spread came to,
 *    and what dropping the oldest would have given. Dropping the oldest is the obvious policy
 *    and it is the wrong one, and the screen shows the number rather than the argument.
 *  - **Staleness is a surviving-observation fraction, never an age.** v4 §20 forbids using old
 *    information blindly; it does not say old information is bad.
 */

import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  KEYFRAME_BUDGET_MS,
  KEYFRAME_DISPLACEMENT_PX,
  KEYFRAME_ROTATION_DEG,
  KEYFRAME_TRANSLATION_UNITS,
  MAX_KEYFRAMES,
  MAX_KEYFRAME_INTERVAL_MS,
  MIN_JUDGED_DECISIONS,
  MIN_KEYFRAME_INTERVAL_MS,
  MIN_KEYFRAME_OBSERVATIONS,
  MIN_STATIC_METRONOME_RATIO,
  STALE_SURVIVAL_FRACTION,
} from '../testkit/Phase8Tests';
import type { KeyframeStats } from '../tracking/keyframeStats';
import { BAD, OK, card, deg, el, num, pct, px, stat } from './dom';
import { evidenceSection, navigationSection, testsSection } from './phaseSections';

export interface Phase8ViewModel {
  readonly phase8: PhaseInfo;
  readonly phase9: PhaseInfo;
  readonly canEnterPhase9: boolean;
  readonly phase9Implemented: boolean;
  readonly phase9BlockedReason: string;
  readonly cameraState: CameraState;
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: the store asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: KeyframeStats;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase8Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase9: () => void;
  onDownloadEvidence: () => void;
  onCopyEvidence: () => void;
}

export function renderPhase8Screen(
  root: HTMLElement,
  vm: Phase8ViewModel,
  handlers: Phase8Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['Keyframe System']),
      el('p', {}, [
        'Phase 8 — which views are worth keeping. v3 §20 gives four conditions, a minimum ' +
          'interval and a maximum; three of the four are measurable here and the fourth asks ' +
          'for a translation **magnitude**, which this platform cannot produce. Phase 5’s ' +
          'verification anchor stays exactly where it is: it is what Phases 5 and 6 passed on ' +
          'the device with, and the store is a second structure beside it rather than a ' +
          'replacement for it.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderMetronome(vm));
  root.append(renderConditions(vm));
  root.append(renderStore(vm));
  root.append(renderKeyframes(vm));
  root.append(renderRefusal(vm));
  root.append(renderCost(vm));
  root.append(testsSection(8, vm.phase8, vm.results));
  root.append(
    evidenceSection(8, vm.phase8, vm.results, {
      onDownload: handlers.onDownloadEvidence,
      onCopy: handlers.onCopyEvidence,
    }),
  );
  root.append(
    navigationSection(
      { index: 7, label: 'BACK TO IMU SUPPORT / FUSION', onClick: handlers.onBack },
      {
        index: 9,
        name: 'TRIANGULATION',
        phase: vm.phase9,
        canEnter: vm.canEnterPhase9,
        implemented: vm.phase9Implemented,
        blockedReason: vm.phase9BlockedReason,
        onClick: handlers.onEnterPhase9,
      },
    ),
  );
}

function renderPreview(vm: Phase8ViewModel, handlers: Phase8Handlers): HTMLElement {
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
        s.decisions > 0
          ? 'Nothing about the keyframe store is drawn on the picture. A keyframe is a *view*, ' +
            'not a place in this frame, and marking one on the current image would be drawing ' +
            'a thing that is not there.'
          : vm.running
            ? 'Waiting for the first decision.'
            : 'Fusion is live. The keyframe store has not been started.',
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
              : 'KEYFRAMES NOT STARTED';
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
        id: 'start-keyframes',
        // §H.5, for the sixth time and from the one predicate. Seven stages are already live
        // when this screen opens; a predicate assembled from any of them cannot be pressed.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'KEEPING' : vm.opening ? 'REQUESTING…' : 'START KEYFRAMES',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-keyframes',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('Camera', children);
}

/** KEY-002 — the gate. Nothing else here distinguishes a selector from a schedule. */
function renderMetronome(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.staticDecisions >= MIN_JUDGED_DECISIONS;
  const ahead =
    enough && s.staticMetronomeInsertions >= MIN_STATIC_METRONOME_RATIO * s.staticSelectorInsertions;
  return card('What would a metronome have kept?', [
    el('div', { class: 'stat-grid' }, [
      stat('Static decisions', enough ? String(s.staticDecisions) : `${s.staticDecisions} / ${MIN_JUDGED_DECISIONS}`),
      stat('This selector kept', String(s.staticSelectorInsertions), enough ? (ahead ? OK : BAD) : ''),
      stat('A metronome would have', String(s.staticMetronomeInsertions)),
      stat('Ratio', s.staticRatio < 0 ? null : `${s.staticRatio}×`, enough ? (ahead ? OK : BAD) : ''),
      stat('...of a needed', `${MIN_STATIC_METRONOME_RATIO}×`),
      stat('Geometric, nothing moved at all', String(s.stillIntervalGeometricInsertions),
        s.stillIntervalGeometricInsertions > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      `A second selector runs on the same frames and fires every ${MIN_KEYFRAME_INTERVAL_MS} ms — ` +
        'as often as this one is *allowed* to. On a moving camera the two look alike, because on ' +
        'a moving camera any schedule produces separated views. On a camera that is not moving ' +
        'they part company, and that is the only place a keyframe system and a schedule differ.',
    ]),
    el('p', { class: 'footnote' }, [
      'Whether the image is moving is **not** decided here. It is Phase 4’s independent ' +
        'scene-shift search — an exhaustive integer search that shares no code with the tracker ' +
        'and never sees the feature list — reporting `STATIC` below 1 px of image motion. A ' +
        'phase that classified its own test conditions would be marking its own paper.',
    ]),
    el('p', { class: 'footnote' }, [
      'What is counted against the selector is a geometric insertion over an interval in which ' +
        '**nothing moved** — not one that merely lands on a still frame. A condition is ' +
        'accumulated over the interval since the last keyframe: a view 30 px from it is 30 px ' +
        'from it whether or not the image happens to be still at the instant the minimum ' +
        'interval elapses. ' +
        `${s.staticGeometricInsertions} insertion(s) landed on a still frame, of which ` +
        `${s.stillIntervalGeometricInsertions} had nothing moving behind them.`,
    ]),
    el('p', { class: 'footnote' }, [
      `The current frame reads ${s.frameMotion || '—'}.`,
    ]),
  ]);
}

/** KEY-001 and KEY-005 — v3 §20's conditions, every one of them, with the one that cannot fire. */
function renderConditions(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  return card('v3 §20’s conditions, on this frame', [
    el('div', { class: 'stat-grid' }, [
      stat('Decision', s.reason || '—', s.inserted ? OK : ''),
      stat('Since the last', s.sinceLastMs < 0 ? null : `${Math.round(s.sinceLastMs)} ms`),
      stat('Interval', `${MIN_KEYFRAME_INTERVAL_MS}–${MAX_KEYFRAME_INTERVAL_MS} ms`),
      stat('Rotation', deg(s.rotationDeg)),
      stat('Displacement', px(s.displacementPx)),
      stat('Shared with the last', `${s.sharedWithLast} / ${s.observations}`),
    ]),
    ...s.conditions.map((c) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [c.name]),
        el('span', { class: 'cap-method' }, [c.note]),
        el('span', { class: `cap-state ${c.fired ? OK : ''}` }, [
          c.state === 'UNMEASURED'
            ? 'UNMEASURED'
            : c.value < 0
              ? '—'
              : `${c.value} / ${c.threshold} ${c.unit}`,
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [s.detail]),
    el('p', { class: 'footnote' }, [
      `Rotation is accumulated from Phase 6’s per-frame increments rather than read from one of ` +
        'its reports: its rotation is measured from Phase 5’s anchor, and across a re-anchor two ' +
        'such rotations have different origins and their difference is not a rotation of the ' +
        `camera. ${s.droppedIncrements} increment(s) have been dropped since the last keyframe ` +
        'for exactly that reason, and the count is here because a run that dropped several has ' +
        'a rotation figure that understates.',
    ]),
    el('p', { class: 'footnote' }, [
      `Displacement is the median over the features this view and the last keyframe **share**, ` +
        'by feature id — a net displacement between exactly those two views, which needs no ' +
        `anchor. v3 §20 asks for ${KEYFRAME_DISPLACEMENT_PX} px and ${KEYFRAME_ROTATION_DEG}°.`,
    ]),
  ]);
}

/** KEY-001 and KEY-003 — what the store did, and what it let go of. */
function renderStore(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const clean =
    s.reasonMismatches === 0 && s.minIntervalViolations === 0 && s.maxIntervalGaps === 0;
  return card('The store', [
    el('div', { class: 'stat-grid' }, [
      stat('Held', `${s.keyframes} / ${MAX_KEYFRAMES}`, s.storeOverflows > 0 ? BAD : OK),
      stat('Inserted', String(s.totalInserted)),
      stat('On a geometric condition', String(s.geometricInsertions),
        s.totalInserted > 0 && s.geometricInsertions === 0 ? BAD : ''),
      stat('Heartbeats', String(s.heartbeatInsertions)),
      stat('Evictions', String(s.evictions)),
      stat('Decisions', String(s.decisions)),
    ]),
    el('div', { class: 'stat-grid' }, [
      stat('Reasons that do not follow', String(s.reasonMismatches), clean ? OK : BAD),
      stat('Inside the minimum', String(s.minIntervalViolations),
        s.minIntervalViolations > 0 ? BAD : ''),
      stat('Past the maximum', String(s.maxIntervalGaps), s.maxIntervalGaps > 0 ? BAD : ''),
      stat('Longest gap', s.longestGapMs < 0 ? null : `${Math.round(s.longestGapMs)} ms`),
      stat('Coverage kept', `${s.evictionsCoverageKept} / ${s.evictions}`),
      stat('Newest evicted', String(s.evictedNewest), s.evictedNewest > 0 ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      'Every decision is re-derived by the same pure function from the inputs recorded beside ' +
        'it, and the disagreements are counted. A selector that inserted on a timer and attached ' +
        'the label ROTATION would satisfy every count above and be caught by that one figure.',
    ]),
    ...(s.recentEvictions.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recent evictions']),
          ...s.recentEvictions.slice(-4).map((e) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`#${e.keyframeId} ${e.reason}`]),
              el('span', { class: 'cap-method' }, [e.detail]),
              el('span', {
                class: `cap-state ${e.retainedSeparationPx >= e.oldestFirstSeparationPx ? OK : BAD}`,
              }, [
                `${px(e.retainedSeparationPx)} vs ${px(e.oldestFirstSeparationPx)} oldest-first`,
              ]),
            ]),
          ),
        ]
      : []),
    el('p', { class: 'footnote' }, [
      'When the store is full, what goes is the most redundant viewpoint — not the oldest. ' +
        'Dropping the oldest is the obvious policy and it is the wrong one: it turns a store ' +
        'that describes the room into one that describes the last fifteen seconds. The ' +
        'counterfactual is measured on every eviction rather than argued.',
    ]),
  ]);
}

/** KEY-004 and KEY-006 — what each keyframe carries, and whether it still describes anything. */
function renderKeyframes(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Keyframes', [
    el('div', { class: 'stat-grid' }, [
      stat('Observations, median shared', num(s.medianSharedWithLast)),
      stat('Floor', String(MIN_KEYFRAME_OBSERVATIONS)),
      stat('Below the floor', String(s.observationFloorViolations),
        s.observationFloorViolations > 0 ? BAD : OK),
      stat('Intrinsics mismatches', String(s.intrinsicsMismatches),
        s.intrinsicsMismatches > 0 ? BAD : OK),
      stat('Stale now', `${s.staleKeyframes} / ${s.keyframes}`),
      stat('Median surviving', pct(s.medianSurvivingFraction)),
    ]),
    ...s.recent.map((kf) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [`#${kf.id} ${kf.reason}`]),
        el('span', { class: 'cap-method' }, [
          `${kf.observations} obs · ${deg(kf.rotationFromPreviousDeg)} · ` +
            `${px(kf.displacementFromPreviousPx)} · ${kf.intrinsics.width}×${kf.intrinsics.height}`,
        ]),
        el('span', { class: `cap-state ${kf.stale ? BAD : OK}` }, [
          kf.stale ? 'STALE' : pct(kf.survivingFraction),
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [
      `A keyframe is stale when fewer than ${Math.round(STALE_SURVIVAL_FRACTION * 100)}% of its ` +
        'observations are still tracked — a function of surviving observations and of nothing ' +
        'else. v4 §20 forbids using old information *blindly*; it does not say old information ' +
        'is bad, and a keyframe whose points are all still visible is as useful as when it was ' +
        'taken. A stale one is not used as the comparison partner.',
    ]),
    el('p', { class: 'footnote' }, [
      'Each keyframe carries **its own** intrinsics (§H.0): a device rotation swaps the frame ' +
        'dimensions on the same track and every one of fx, fy, cx, cy changes with it, so a ' +
        'keyframe that borrowed the current K would be wrong for every view taken before the ' +
        'rotation — and Phase 9 triangulates from these. They are re-derived from each ' +
        'keyframe’s own recorded geometry rather than trusted.',
    ]),
    el('p', { class: 'footnote' }, [
      'No imagery is stored. §H.1 budgets 30 downscaled grayscale frames for a relocaliser that ' +
        'does not exist yet; Phases 8, 9 and 10 need the observations and the pose, and keeping ' +
        'pixels nothing reads would be carrying data no test can check.',
    ]),
  ]);
}

/** KEY-005 — the refusal, with the number behind it. */
function renderRefusal(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const c = s.translationCondition;
  return card('The condition this phase refuses', [
    el('div', { class: 'stat-grid' }, [
      stat('Translation', c ? c.state : 'ABSENT', c?.state === 'UNMEASURED' ? OK : BAD),
      stat('v3 §20 asks for', `${KEYFRAME_TRANSLATION_UNITS} local unit`),
      stat('It has fired', String(s.translationFired), s.translationFired > 0 ? BAD : OK),
      stat('Direction moved', deg(s.translationDirectionDeg)),
      stat('...over', `${s.translationDirectionSamples} sample(s)`),
      stat('Scale', s.scale, s.scaleViolations > 0 ? BAD : OK),
    ]),
    el('p', { class: 'footnote' }, [
      'v3 §20 asks for a translation **magnitude**. Phase 6 recovers a unit direction with ' +
        'SCALE: LOCAL_UNITS, because v3 §15 and v4 §18 both forbid a monocular camera claiming a ' +
        'distance — and Phase 7 refused position for the same reason. There is no such magnitude ' +
        'in this build, so the condition is carried as a value that never fires rather than as a ' +
        'field that happens to be absent.',
    ]),
    el('p', { class: 'footnote' }, [
      'The number beside it is what *can* be measured: how far the translation direction has ' +
        'moved since the last keyframe. It is not offered as the magnitude and it is not used as ' +
        'a condition. It is here so the refusal carries a measurement rather than a citation.',
    ]),
    el('p', { class: 'footnote' }, [
      'What fires in its place is v3 §20’s own third condition — the median displacement of the ' +
        'features the two views share — which is the same quantity in the units this platform ' +
        'can produce.',
    ]),
  ]);
}

function renderCost(vm: Phase8ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanKeyframeMs >= 0 && s.meanKeyframeMs <= KEYFRAME_BUDGET_MS;
  return card('Cost (§H has no line for this)', [
    el('div', { class: 'stat-grid' }, [
      stat('Keyframe upkeep', s.meanKeyframeMs >= 0 ? `${s.meanKeyframeMs} ms` : null,
        s.meanKeyframeMs >= 0 ? (within ? OK : BAD) : ''),
      stat('Budget', `${KEYFRAME_BUDGET_MS} ms`),
      stat('Samples', String(s.costSamples)),
      stat('Store size', `${s.keyframes} / ${MAX_KEYFRAMES}`),
    ]),
    el('p', { class: 'footnote' }, [
      '§H allocates every millisecond it has — acquire 6, Shi-Tomasi 8 amortised, LK 14, ' +
        'forward/backward 4, RANSAC and pose 6 — and names no line for keyframe upkeep, as it ' +
        `named none for fusion. So the ${KEYFRAME_BUDGET_MS} ms above is a ceiling this phase ` +
        'set for itself rather than one it was given.',
    ]),
    el('p', { class: 'footnote' }, [
      'Most decisions are a handful of comparisons. The expensive ones are the frames that ' +
        'evict, which measure the retained set’s pairwise separation twice — once for the policy ' +
        'and once for the counterfactual it is judged against — and those are rare by ' +
        'construction.',
    ]),
  ]);
}
