/**
 * The **fused** pose's confidence (v3 §19), with all seven of its inputs.
 *
 * Phase 6's `poseConfidence` is not touched and not extended. It describes the *visual* pose and
 * it withholds v3 §19's `IMU consistency` for a reason that is still true: POSE-002 scores Phase
 * 6 against the gyroscope, and a confidence that had consumed the gyroscope could not then be
 * checked against it (§H.7). Phase 6 has passed on the device with that arrangement, and editing
 * it now would be editing a passed phase.
 *
 * So Phase 7 computes a second number, for a second pose, and both travel in the bundle. The six
 * visual terms are carried through **by value**, unrecomputed — they are Phase 6's measurements
 * of Phase 6's pose and this module has no business re-deriving them — and two more are added.
 *
 * ## Seven, and then one more that is not §19's
 *
 * `imuConsistency` is §19's seventh. It is the smaller of two disagreements, because they are
 * two views of the same question: how far the visual increment sat from what the gyroscope
 * predicted, and how far the accelerometer's gravity sits from the filter's own. Either one
 * being large means the two instruments are not describing the same motion.
 *
 * `propagation` is **not** in §19's list, and is here because v3 §17 puts a limit §19 does not:
 * the gyroscope is for 短時間回転推定, and an orientation that has been running open-loop for
 * three seconds is not as good as one that was measured. IMU-007 requires the confidence to fall
 * while running open-loop, and a confidence that cannot fall is the failure that record names.
 * It is flat while vision is live — a pose is not less trustworthy for arriving 200 ms ago — and
 * ramps to zero across the window between `DEAD_RECKONING_AFTER_MS` and `MAX_PROPAGATION_MS`.
 *
 * ## Minimum, still
 *
 * v3 §19's prohibition — 不確実なPoseは強制的に高confidenceにしない — applies to this number as it
 * does to Phase 6's, so the combination is the **minimum** over the terms that could be measured.
 * That also settles IMU-004's failure condition by construction rather than by test: the fused
 * terms are a superset of the visual ones, and a minimum over a superset cannot exceed the
 * minimum over the subset. The fused confidence can never be *raised* by attaching a sensor.
 */

import type { ConfidenceTermRecord } from './trackingMessages';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Linear ramp from `lo` (0) to `hi` (1), clamped. `lo > hi` ramps downward. */
function ramp(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

export interface FusionConfidenceInput {
  /** Phase 6's terms for this frame, carried through unchanged. Empty where it had no pose. */
  readonly visualTerms: readonly ConfidenceTermRecord[];
  /** Innovation on the last applied visual update, degrees. `-1` where none has been applied. */
  readonly innovationDeg: number;
  /** ...and on the last gravity update. `-1` where none has been applied. */
  readonly gravityDeg: number;
  /** The innovation at which the term reaches zero. */
  readonly innovationLimitDeg: number;
  /** ...and the gravity disagreement at which it does. */
  readonly gravityLimitDeg: number;
  /** Milliseconds since vision last produced a pose. `-1` before the first one. */
  readonly propagatedMs: number;
  /** Below this, propagation is a gap between frames rather than an open-loop run. */
  readonly deadReckoningAfterMs: number;
  /** ...and past this the propagated orientation is no longer offered. */
  readonly maxPropagationMs: number;
  /**
   * The filter is running on the IMU. False on a run with no IMU **and** on a run whose sensors
   * are live but whose device→camera rotation has not been measured, so the term is withheld by
   * name in both cases — never scored as good.
   */
  readonly hasImu: boolean;
  /**
   * The sensor is delivering samples, whatever the filter is doing with them.
   *
   * Separate from `hasImu` because the two were one flag and the record paid for it: the device
   * run of 2026-09-05 carried `imuSamples: 9619` at a measured 50.71 Hz and a withheld term
   * reading *no IMU is reporting on this run*. Rule 002 — the bundle may not contradict itself,
   * and a reader who believes the withheld line goes looking for a permission problem that is
   * not there.
   */
  readonly imuReporting: boolean;
  /** Why the extrinsic is not known yet, where it is not. Named in the withheld term. */
  readonly handEyeReason: string;
}

export interface FusionConfidence {
  /** `0..1`. The minimum over every term that could be measured. */
  readonly overall: number;
  readonly terms: readonly ConfidenceTermRecord[];
  /** Named, so an omission reads as a decision rather than as an oversight. */
  readonly withheld: readonly string[];
}

export function fusionConfidence(input: FusionConfidenceInput): FusionConfidence {
  const terms: ConfidenceTermRecord[] = input.visualTerms.map((t) => ({
    name: t.name,
    value: t.value,
    note: `${t.note} (Phase 6's measurement of the visual pose, carried through unchanged)`,
  }));
  const withheld: string[] = [];

  const parts: { name: string; value: number }[] = [];
  if (input.hasImu && input.innovationDeg >= 0) {
    parts.push({
      name: 'visual/inertial',
      value: ramp(input.innovationDeg, input.innovationLimitDeg, 0),
    });
  }
  if (input.hasImu && input.gravityDeg >= 0) {
    parts.push({ name: 'gravity', value: ramp(input.gravityDeg, input.gravityLimitDeg, 0) });
  }

  if (parts.length === 0) {
    // Three cases, not two. The filter can be idle because there is no sensor, or because there
    // is a sensor whose frame is not yet related to the camera's — and those call for opposite
    // things from whoever is holding the phone.
    const note = input.hasImu
      ? 'the IMU is reporting but neither a visual increment nor a gravity sample has been ' +
        'applied yet, so there is no disagreement to score — withheld rather than counted as good'
      : input.imuReporting
        ? 'the IMU is reporting, but nothing is fused yet because the device→camera rotation ' +
          `has not been measured: ${input.handEyeReason}. Until it is, the gyroscope and the ` +
          'visual increment are in two frames and their disagreement is not a measurement of ' +
          'anything — withheld rather than counted as good'
        : 'no IMU is reporting, so there is nothing to be consistent with — v3 §19 lists this ' +
          'term and this run cannot measure it; it is withheld by name rather than scored as 1';
    terms.push({ name: 'imuConsistency', value: -1, note });
    withheld.push(
      input.hasImu
        ? 'IMUConsistency — the sensors are live but no update has been applied yet'
        : input.imuReporting
          ? 'IMUConsistency — the sensors are live and the device→camera rotation is not ' +
            'measured yet, so nothing is fused (v3 §68: vision-only continues)'
          : 'IMUConsistency — no IMU is reporting on this run (v3 §68: vision-only continues)',
    );
  } else {
    const worst = parts.reduce((a, b) => (b.value < a.value ? b : a));
    terms.push({
      name: 'imuConsistency',
      value: round(worst.value),
      note:
        parts.map((p) => `${p.name} ${round(p.value)}`).join(', ') +
        ` — the smaller is taken, against ${input.innovationLimitDeg}° visual / ` +
        `${input.gravityLimitDeg}° gravity; v3 §19's seventh input, which Phase 6 withholds`,
    });
  }

  if (input.propagatedMs < 0) {
    terms.push({
      name: 'propagation',
      value: -1,
      note: 'vision has not produced a pose yet, so there is no open-loop interval to score',
    });
  } else {
    terms.push({
      name: 'propagation',
      value: round(ramp(input.propagatedMs, input.maxPropagationMs, input.deadReckoningAfterMs)),
      note:
        `${round(input.propagatedMs)} ms since vision last reported, against v3 §17's ` +
        `短時間 window of ${input.deadReckoningAfterMs}–${input.maxPropagationMs} ms. Not one of ` +
        "§19's seven — added because §17 limits how long a propagated orientation is worth " +
        'anything, and IMU-007 requires the confidence to fall while running open-loop',
    });
  }

  const measured = terms.filter((t) => t.value >= 0).map((t) => t.value);
  return {
    overall: measured.length > 0 ? round(Math.min(...measured)) : -1,
    terms,
    withheld,
  };
}

function round(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : x;
}
