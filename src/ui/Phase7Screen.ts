/**
 * IMU SUPPORT / FUSION screen (Phase 7, v3 §17, §18, §19, §68).
 *
 * The first screen in this project whose headline is a **refusal**, and the first whose spec
 * pass condition is about absence: v3 §68 asks for *IMU unavailableでもVision-only modeで継続可能*
 * and nothing else. So the mode is the first thing on the screen, and it says `VISION ONLY` in
 * plain letters when there are no sensors rather than hiding an unavailable IMU behind a fused
 * number that came from vision alone.
 *
 * Four things are here because of what Phase 7 can fake.
 *
 *  - **"Does the filter find a bias it was not told about?" is the top panel.** A fusion that
 *    returns the visual pose unchanged tracks the camera perfectly, has innovations of exactly
 *    zero — *better* than a real filter's — and never invents a position. It scores 0.0 °/s
 *    here, and this is the only number in the phase it cannot produce.
 *  - **`POSITION: UNAVAILABLE` is displayed as a value, with the drift beside it.** Not an
 *    absent field: a value a later phase has to remove deliberately. And the accelerometer *is*
 *    double-integrated, for the record only, so the refusal carries a number rather than a
 *    citation.
 *  - **The fused confidence is shown beside Phase 6's**, and the fused one may never be higher.
 *    Adding a sensor is evidence, and evidence can only lower a minimum.
 *  - **The propagation clock is shown while vision is out.** v3 §17 gives the gyroscope
 *    短時間回転推定 without saying how short; three seconds is where the number reaches zero and
 *    the pose stops being offered, and the screen counts towards it in the open.
 *
 * Both filters' bias estimates are shown rather than the difference alone, for the reason Phase
 * 5 shows both models' inlier counts and Phase 6 shows all four cheirality candidates: a
 * measurement presented without what it was measured against is an assertion.
 */

import { Verdict } from '../core/types';
import type { PhaseInfo, TestResult } from '../core/types';
import { CameraState } from '../capture/CameraSource';
import { getPreviewVideo } from './PreviewVideo';
import {
  BIAS_AXIS_TOLERANCE_DEG,
  BIAS_TOLERANCE_DPS,
  FUSION_BUDGET_MS,
  GRAVITY_AGREEMENT_DEG,
  MIN_BIAS_SAMPLES_JUDGED,
  MIN_JUDGED_FRAMES,
} from '../testkit/Phase7Tests';
import {
  DEAD_RECKONING_AFTER_MS,
  FusionMode,
  GRAVITY_TOLERANCE_MS2,
  GYRO_BIAS_INJECTION_DPS,
  MAX_PROPAGATION_MS,
  VISUAL_UPDATE_INTERVAL_MS,
} from '../tracking/FusionStage';
import type { FusionStats } from '../tracking/fusionStats';

export interface Phase7ViewModel {
  readonly phase7: PhaseInfo;
  readonly phase8: PhaseInfo;
  readonly canEnterPhase8: boolean;
  readonly phase8Implemented: boolean;
  readonly phase8BlockedReason: string;
  readonly cameraState: CameraState;
  /** The camera is delivering — which is NOT whether fusion is running (§H.5). */
  readonly trackLive: boolean;
  readonly opening: boolean;
  /** The one predicate: fusion asked for AND a pipeline running to serve it. */
  readonly running: boolean;
  readonly stats: FusionStats;
  /** The acquired frame's dimensions, so the preview is not stretched (`object-fit: fill`). */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly results: readonly TestResult[];
}

export interface Phase7Handlers {
  onStart: () => void;
  onStop: () => void;
  onBack: () => void;
  onEnterPhase8: () => void;
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

const OK = 's-AVAILABLE';
const BAD = 's-PERMISSION_DENIED';

function deg(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 100) / 100}°`;
}

function dps(n: number): string {
  return n < 0 ? '—' : `${Math.round(n * 1000) / 1000} °/s`;
}

function vec(v: readonly number[] | null): string | null {
  if (!v || v.length === 0) return null;
  return `[${v.map((x) => (Math.round(x * 1000) / 1000).toFixed(3)).join(', ')}]`;
}

export function renderPhase7Screen(
  root: HTMLElement,
  vm: Phase7ViewModel,
  handlers: Phase7Handlers,
): void {
  root.replaceChildren();
  root.append(
    el('header', { class: 'hero' }, [
      el('h1', {}, ['IMU Support / Fusion']),
      el('p', {}, [
        'Phase 7 — the device’s own motion sensing, used as an **auxiliary** to the visual pose ' +
          'and never as a replacement. Two of v3 §18’s five filter states are estimated: ' +
          'orientation and gyroscope bias. Position, velocity and accelerometer bias are ' +
          'refused, because the accelerometer reports m/s² and Phase 6’s translation is a unit ' +
          'direction with no scale — and inventing the conversion is the fabrication Rule 001 ' +
          'names.',
      ]),
    ]),
  );

  root.append(renderPreview(vm, handlers));
  root.append(renderInjection(vm));
  root.append(renderMode(vm));
  root.append(renderSensors(vm));
  root.append(renderConsistency(vm));
  root.append(renderPosition(vm));
  root.append(renderConfidence(vm));
  root.append(renderCost(vm));
  root.append(renderTests(vm));
  root.append(renderEvidence(vm, handlers));
  root.append(renderNavigation(vm, handlers));
}

function renderPreview(vm: Phase7ViewModel, handlers: Phase7Handlers): HTMLElement {
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
        s.fusionFrames > 0
          ? 'Nothing about the fused orientation is drawn on the picture, for the reason Phase 6 ' +
            'drew nothing: an attitude belongs to the device, not to any point on screen, and ' +
            'there is still no depth here to mark.'
          : vm.running
            ? 'Waiting for the first fused frame.'
            : 'Pose recovery is live. Fusion has not been started.',
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
              : 'FUSION NOT STARTED';
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
        id: 'start-fusion',
        // §H.5, for the fifth time and from the one predicate. Six stages are already live when
        // this screen opens; a predicate assembled from any of them cannot be pressed.
        disabled: vm.opening || vm.running,
        textContent: vm.running ? 'FUSING' : vm.opening ? 'REQUESTING…' : 'START FUSION',
        onclick: handlers.onStart,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'stop-fusion',
        disabled: !vm.running,
        textContent: 'STOP',
        onclick: handlers.onStop,
      } as never),
    ]),
  );
  return card('Camera', children);
}

/** IMU-005 — the gate. Nothing else here distinguishes a filter from a pass-through. */
function renderInjection(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.biasSamples >= MIN_BIAS_SAMPLES_JUDGED;
  const off = Math.abs(s.medianBiasDifferenceDps - s.requestedInjectionDps);
  const found = enough && off <= BIAS_TOLERANCE_DPS;
  const onAxis =
    enough && s.medianBiasAxisErrorDeg >= 0 && s.medianBiasAxisErrorDeg <= BIAS_AXIS_TOLERANCE_DEG;

  return card('Does the filter find a bias it was not told about?', [
    el('div', { class: 'stat-grid' }, [
      stat('Bias injected', `${GYRO_BIAS_INJECTION_DPS} °/s`),
      stat('Difference recovered', dps(s.medianBiasDifferenceDps), enough ? (found ? OK : BAD) : ''),
      stat('Off the injected axis', deg(s.medianBiasAxisErrorDeg), enough ? (onAxis ? OK : BAD) : ''),
      stat('Samples', enough ? String(s.biasSamples) : `${s.biasSamples} / ${MIN_BIAS_SAMPLES_JUDGED}`),
      stat('This phone’s own bias', vec(s.gyroBiasDps)),
      stat('Injected along', vec(s.injectionAxis)),
    ]),
    el('p', { class: 'footnote' }, [
      `Two filters run on the same visual poses and the same gyroscope, and one of them is fed ` +
        `every sample with a constant ${GYRO_BIAS_INJECTION_DPS} °/s added before it sees it. ` +
        'Neither is told which it is. The measurement is the **difference** between their bias ' +
        'estimates: this phone’s own bias is unknown and common to both, so it cancels — which ' +
        'is what makes this decidable on a device whose real bias nobody can look up.',
    ]),
    el('p', { class: 'footnote' }, [
      '"This phone’s own bias" is the control filter’s estimate, shown because it *is* this ' +
        'gyroscope’s bias and that is worth knowing. It is not what the test judges.',
    ]),
    el('p', { class: 'footnote' }, [
      'This is the only figure in Phase 7 a fusion that returned the visual pose could not ' +
        'produce. Such a fusion tracks the camera perfectly, reports innovations of exactly zero ' +
        '— better than a real filter’s — and never invents a position; it scores 0.0 °/s here. ' +
        'v3 §68 asks for something else entirely, and IMU-002 below is where that is decided.',
    ]),
    el('p', { class: 'footnote' }, [
      `The difference is withheld until ${MIN_BIAS_SAMPLES_JUDGED} visual updates have been ` +
        'applied. Not because the estimate needs them — gravity alone estimates the bias very ' +
        'well on a device that turns, which the unit fixture measured — but because a number a ' +
        'dead-reckoner can produce cannot be the gate on a fusion.',
    ]),
    ...(s.biasDifferences.length > 0
      ? [
          el('p', { class: 'group-title' }, ['Recent measurements']),
          ...s.biasDifferences.slice(-4).map((b) =>
            el('div', { class: 'cap-row' }, [
              el('span', { class: 'cap-label' }, [`${b.visualUpdates} updates`]),
              el('span', { class: 'cap-method' }, [
                `${dps(b.magnitudeDps)} · ${deg(b.axisErrorDeg)} off axis`,
              ]),
              el('span', {
                class: `cap-state ${
                  Math.abs(b.magnitudeDps - s.requestedInjectionDps) <= BIAS_TOLERANCE_DPS ? OK : BAD
                }`,
              }, [vec(b.differenceDps) ?? '—']),
            ]),
          ),
        ]
      : []),
  ]);
}

/** IMU-002 and IMU-007 — the mode, which is the spec's own pass condition and its dropout. */
function renderMode(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const propagating = s.mode === FusionMode.DEAD_RECKONING;
  return card('Mode', [
    el('div', { class: 'stat-grid' }, [
      stat('Now', s.mode, s.mode === FusionMode.FUSED ? OK : ''),
      stat('Usable', s.usable ? 'YES' : 'NO', s.usable ? OK : BAD),
      stat('Propagated for', s.propagatedMs < 0 ? null : `${Math.round(s.propagatedMs)} ms`,
        propagating ? (s.propagatedMs > MAX_PROPAGATION_MS ? BAD : '') : ''),
      stat('Frames', `${s.fusedFrames} fused · ${s.dropoutFrames} open-loop`),
      stat('Longest gap', s.longestPropagatedMs < 0 ? null : `${Math.round(s.longestPropagatedMs)} ms`),
      stat('Reconvergence', deg(s.medianReconvergenceInnovationDeg)),
    ]),
    el('p', { class: 'footnote' }, [
      `${FusionMode.VISION_ONLY} means no IMU is reporting and the fused orientation **is** the ` +
        'visual orientation, unchanged. That is not a degraded state — it is v3 §68’s pass ' +
        'condition, verbatim: IMU unavailableでもVision-only modeで継続可能. Nothing is invented ' +
        'from sensors that are not there, and the bias reads null rather than zero.',
    ]),
    el('p', { class: 'footnote' }, [
      `${FusionMode.DEAD_RECKONING} means vision stopped more than ${DEAD_RECKONING_AFTER_MS} ms ` +
        `ago and the gyroscope is carrying the orientation alone. Past ${MAX_PROPAGATION_MS} ms ` +
        'the pose is no longer offered as usable: v3 §17 gives the gyroscope 短時間回転推定 ' +
        'without saying how short, and three seconds is where a ~1 °/s consumer bias has ' +
        'accumulated Phase 6’s own 3° agreement floor — the point at which a propagated ' +
        'orientation stops being as good as a measurement.',
    ]),
    el('p', { class: 'footnote' }, [
      'The confidence falls the whole way down and the jump when vision returns is recorded ' +
        'above rather than absorbed. A filter that snapped back silently would be hiding the one ' +
        'moment its two instruments disagreed most.',
    ]),
  ]);
}

/** IMU-001 — what is actually arriving, never what the platform advertised. */
function renderSensors(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Sensors', [
    el('div', { class: 'stat-grid' }, [
      stat('IMU', s.imuAvailable ? 'DELIVERING' : 'NOT AVAILABLE', s.imuAvailable ? OK : ''),
      stat('Measured rate', s.measuredImuHz < 0 ? null : `${s.measuredImuHz} Hz`),
      stat('Platform claims', s.reportedImuHz < 0 ? null : `${s.reportedImuHz} Hz`),
      stat('Samples', String(s.imuSamples)),
      stat('Gravity used', `${s.gravitySamples} · ${s.gravityRejected} rejected`),
      stat('Propagating frames', `${s.propagatingFrames} / ${MIN_JUDGED_FRAMES}`,
        s.propagatingFrames >= MIN_JUDGED_FRAMES ? OK : ''),
    ]),
    ...s.sensors.map((c) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [c.name]),
        el('span', { class: 'cap-method' }, [c.detail]),
        el('span', { class: `cap-state ${c.arriving ? OK : ''}` }, [
          c.arriving ? 'ARRIVING' : 'ABSENT',
        ]),
      ]),
    ),
    el('p', { class: 'footnote' }, [s.imuReason]),
    el('p', { class: 'footnote' }, [
      `A gravity sample is used only when ‖a+g − a‖ is within ±${GRAVITY_TOLERANCE_MS2} m/s² of ` +
        '9.81. Outside that the phone was accelerating and the difference is not a gravity ' +
        'direction at all — so it is rejected rather than fed in with a larger noise. A ' +
        'measurement of the wrong quantity is not a noisy measurement of the right one.',
    ]),
    el('p', { class: 'footnote' }, [
      'The world frame is *defined* by the first accepted gravity reading rather than assumed ' +
        'from a sign convention: the platforms disagree about the sign of ' +
        '`accelerationIncludingGravity`, and one sample from one device cannot settle it. So no ' +
        'sign is assumed — whatever direction gravity pointed at initialisation *is* down.',
    ]),
  ]);
}

/** IMU-003 and IMU-004 — the two instruments, and how far apart they are. */
function renderConsistency(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const enough = s.innovationSamples >= MIN_JUDGED_FRAMES;
  const within = enough && s.medianInnovationDeg >= 0 && s.medianInnovationDeg <= s.toleranceDeg;
  const copying = enough && s.zeroInnovationSamples === s.innovationSamples;
  return card('Vision against the gyroscope', [
    el('div', { class: 'stat-grid' }, [
      stat('Camera turned by', deg(s.medianVisualIncrementDeg)),
      stat('Prediction was off by', deg(s.medianInnovationDeg), enough ? (within ? OK : BAD) : ''),
      stat('Tolerance', deg(s.toleranceDeg)),
      stat('Updates', enough ? String(s.innovationSamples) : `${s.innovationSamples} / ${MIN_JUDGED_FRAMES}`),
      stat('Exactly zero', String(s.zeroInnovationSamples), copying ? BAD : ''),
      stat('Gravity disagreement', deg(s.medianGravityDeg),
        s.gravityDegSamples > 0 && s.medianGravityDeg > GRAVITY_AGREEMENT_DEG ? BAD : ''),
    ]),
    el('p', { class: 'footnote' }, [
      `Each update spans about ${VISUAL_UPDATE_INTERVAL_MS} ms. The gyroscope is integrated ` +
        'across it to predict where the camera should have ended up, and the visual increment ' +
        'says where it actually did. The difference is the innovation, and it is the number that ' +
        'separates a prediction from a copy: a "fusion" whose prediction always matches its ' +
        'measurement exactly is not predicting.',
    ]),
    el('p', { class: 'footnote' }, [
      'The interval is a second rather than a frame because the information a run collects about ' +
        'the bias is proportional to the interval length — halving it halves what the run ' +
        'learns, and at one visual frame per update a 3 °/s injection could not be separated ' +
        'from nothing within the tolerance.',
    ]),
    el('p', { class: 'footnote' }, [
      'The tolerance is Phase 6’s own, reused unchanged: max(3°, 30 % of what was measured). ' +
        'These are the same two instruments POSE-002 compared, so inventing a new tolerance here ' +
        'would be two phases disagreeing about when a camera and a gyroscope agree.',
    ]),
  ]);
}

/** IMU-006 — the refusal, with the number behind it. */
function renderPosition(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  return card('Position', [
    el('div', { class: 'stat-grid' }, [
      stat('Position', 'UNAVAILABLE', s.positionsReported > 0 ? BAD : OK),
      stat('Scale', s.scale, s.scaleViolations > 0 ? BAD : OK),
      stat('Heading', s.heading),
      stat('Records with a position', String(s.positionsReported), s.positionsReported > 0 ? BAD : OK),
      stat('If it had been integrated', s.deadReckonedPositionM < 0 ? null : `${s.deadReckonedPositionM} m`),
      stat('...over', s.deadReckonedSeconds < 0 ? null : `${s.deadReckonedSeconds} s`),
    ]),
    el('p', { class: 'footnote' }, [s.positionReason]),
    el('p', { class: 'footnote' }, [s.velocityReason]),
    el('p', { class: 'footnote' }, [s.accelBiasReason]),
    el('p', { class: 'footnote' }, [
      'The last two figures are what double-integrating the accelerometer over this run *would* ' +
        'have produced. It is computed and it is never fed to the pose — it exists so that the ' +
        'refusal carries a number rather than a citation. v3 §17 says it twice: Acceleration: ' +
        '長時間の絶対位置推定には直接使用しない, and IMUだけを積分して絶対位置を生成してはならない.',
    ]),
    el('p', { class: 'footnote' }, [
      'UNAVAILABLE is a **value**, not an absent field. Phase 9 triangulates, Phase 11 fits ' +
        'planes, Phase 19 drops a ball, and each reads what the phase below hands over — so a ' +
        'later phase has to remove this deliberately rather than by forgetting.',
    ]),
  ]);
}

/** IMU-004 — v3 §19's seventh term, and the prohibition that governs it. */
function renderConfidence(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const raised = s.fusedAboveVisual > 0;
  return card('Confidence (v3 §19, all seven inputs)', [
    el('div', { class: 'stat-grid' }, [
      stat('Fused', s.confidence < 0 ? null : String(s.confidence), raised ? BAD : OK),
      stat('Phase 6’s (visual)', s.visualConfidence < 0 ? null : String(s.visualConfidence)),
      stat('IMU consistency', s.imuConsistency < 0 ? 'WITHHELD' : String(s.imuConsistency)),
      stat('Lowest it reached', s.minImuConsistency < 0 ? null : String(s.minImuConsistency)),
      stat('Frames below 1', String(s.imuConsistencyBelowOne)),
      stat('Above its worst term', String(s.confidenceAboveWorstTerm),
        s.confidenceAboveWorstTerm > 0 ? BAD : OK),
    ]),
    el('p', { class: 'group-title' }, ['Terms']),
    ...s.confidenceTerms.map((t) =>
      el('div', { class: 'cap-row' }, [
        el('span', { class: 'cap-label' }, [t.name]),
        el('span', { class: 'cap-method' }, [t.note]),
        el('span', { class: `cap-state ${t.value < 0 ? '' : t.value >= 0.75 ? OK : ''}` }, [
          t.value < 0 ? 'WITHHELD' : String(t.value),
        ]),
      ]),
    ),
    ...s.confidenceWithheld.map((w) => el('p', { class: 'footnote' }, [w])),
    el('p', { class: 'footnote' }, [
      'This is a **separate** number from Phase 6’s, not an edit to it. Phase 6’s confidence ' +
        'describes the visual pose and withholds `IMU consistency` on purpose — it is the ' +
        'instrument POSE-002 scored that phase against. Phase 6 has passed on the device with ' +
        'that arrangement, and changing it now would be editing a passed phase.',
    ]),
    el('p', { class: 'footnote' }, [
      'The fused number is the **minimum** over its terms, so it can never sit above the visual ' +
        'one: the fused terms are the visual terms plus two more, and a minimum over a superset ' +
        'cannot exceed the minimum over the subset. Attaching a sensor can lower a confidence ' +
        'and can never raise it — v3 §19: 不確実なPoseは強制的に高confidenceにしない.',
    ]),
    el('p', { class: 'footnote' }, [
      '`propagation` is not one of §19’s seven. It is here because §17 limits how long a ' +
        'propagated orientation is worth anything, and a confidence that could not fall while ' +
        'running open-loop would be claiming otherwise.',
    ]),
  ]);
}

function renderCost(vm: Phase7ViewModel): HTMLElement {
  const s = vm.stats;
  const within = s.meanFusionMs >= 0 && s.meanFusionMs <= FUSION_BUDGET_MS;
  return card('Cost (§H has no line for this)', [
    el('div', { class: 'stat-grid' }, [
      stat('Fusion', s.meanFusionMs >= 0 ? `${s.meanFusionMs} ms` : null,
        s.meanFusionMs >= 0 ? (within ? OK : BAD) : ''),
      stat('Budget', `${FUSION_BUDGET_MS} ms`),
      stat('Samples', String(s.fusionCostSamples)),
      stat('Sensor rate', s.measuredImuHz < 0 ? null : `${s.measuredImuHz} Hz`),
    ]),
    el('p', { class: 'footnote' }, [
      '§H allocates every millisecond it has — acquire 6, Shi-Tomasi 8 amortised, LK 14, ' +
        'forward/backward 4, RANSAC and pose 6 — and names no line for fusion. So whatever this ' +
        `costs comes out of margin that does not exist on paper, and the ${FUSION_BUDGET_MS} ms ` +
        'above is a ceiling this phase set for itself rather than one it was given.',
    ]),
    el('p', { class: 'footnote' }, [
      'An orientation error-state filter is a handful of 3×3 operations per sample. Anything ' +
        'approaching a millisecond at 60 Hz is an implementation error rather than a platform ' +
        'fact, which is why IMU-008 is advisory and gated separately (§34, §H.4).',
    ]),
  ]);
}

function renderTests(vm: Phase7ViewModel): HTMLElement {
  if (vm.results.length === 0) {
    return card('Tests', [el('p', { class: 'empty' }, ['Not run yet.'])]);
  }
  const counts = {
    pass: vm.results.filter((r) => r.verdict === Verdict.PASS).length,
    fail: vm.results.filter((r) => r.verdict === Verdict.FAIL).length,
    pending: vm.results.filter((r) => r.verdict === Verdict.PENDING).length,
  };
  return card(`Tests — Phase 7 · ${vm.phase7.state}`, [
    el('div', { class: 'verdict-head' }, [
      el('div', { class: `verdict-state ${vm.phase7.state}`, id: 'phase7-verdict' }, [vm.phase7.state]),
      el('div', { class: 'verdict-counts' }, [
        `${counts.pass} PASS · ${counts.fail} FAIL · ${counts.pending} PENDING`,
      ]),
    ]),
    el('p', { class: 'verdict-reason' }, [vm.phase7.reason]),
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

function renderEvidence(vm: Phase7ViewModel, handlers: Phase7Handlers): HTMLElement {
  const pending = vm.results.filter((r) => r.spec.required && r.verdict === Verdict.PENDING);
  const children: (Node | string)[] = [];
  if (pending.length > 0) {
    children.push(
      el('p', { class: 'evidence-warning', id: 'phase7-pending-warning' }, [
        `This export would record ${vm.phase7.state}, not a pass: ` +
          `${pending.map((r) => r.spec.id).join(', ')} still PENDING.`,
      ]),
    );
  }
  children.push(
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'download-evidence-p7',
        textContent: `DOWNLOAD EVIDENCE JSON — ${vm.phase7.state}`,
        onclick: handlers.onDownloadEvidence,
      } as never),
      el('button', {
        class: 'secondary',
        id: 'copy-evidence-p7',
        textContent: 'COPY EVIDENCE JSON',
        onclick: handlers.onCopyEvidence,
      } as never),
    ]),
  );
  return card('Evidence', children);
}

function renderNavigation(vm: Phase7ViewModel, handlers: Phase7Handlers): HTMLElement {
  const open = vm.canEnterPhase8 && vm.phase8Implemented;
  const label = !vm.phase8Implemented
    ? 'KEYFRAME SYSTEM — NOT IMPLEMENTED'
    : !vm.canEnterPhase8
      ? 'KEYFRAME SYSTEM — LOCKED'
      : 'GO TO KEYFRAME SYSTEM';
  const note = !vm.phase8Implemented
    ? 'Phase 8 has not been written in this build.'
    : !vm.canEnterPhase8
      ? vm.phase8BlockedReason
      : `Phase 8 is ${vm.phase8.state}.`;

  return card('Navigation', [
    el('div', { class: 'button-row' }, [
      el('button', {
        class: 'secondary',
        id: 'back-to-phase6',
        textContent: 'BACK TO RELATIVE POSE',
        onclick: handlers.onBack,
      } as never),
      el('button', {
        class: 'primary',
        id: 'go-to-phase8',
        disabled: !open,
        textContent: label,
        onclick: handlers.onEnterPhase8,
      } as never),
    ]),
    el('p', { class: 'footnote' }, [note]),
  ]);
}
