/**
 * Gesture-gated motion / orientation capability probes (§Rule 003, CAP-0004, CAP-0005).
 *
 * The point of this file is that a sensor capability is only real when sensor *data*
 * arrives. `'DeviceMotionEvent' in window` is true on plenty of devices with no usable
 * accelerometer, and on iOS the constructor exists even before permission is granted.
 * So each probe:
 *
 *   1. requests permission from inside the user gesture (iOS 13+ requirement),
 *   2. listens for a fixed window,
 *   3. counts events that carried finite numbers, and
 *   4. measures the real sample rate.
 *
 * Events that fire but carry only nulls yield UNAVAILABLE, not AVAILABLE — that case is
 * exactly the one that would otherwise produce a fake "IMU: OK".
 */

import { CapabilityState, DetectionMethod } from '../core/types';
import type { CapabilityRecord, JsonValue } from '../core/types';
import { isFiniteNumber, describeError, toJsonSafe } from '../core/validate';
import { round2 } from './probeKit';

export const MOTION_LISTEN_MS = 2000;
/** Below this, a "granted" sensor has not actually demonstrated it produces data. */
export const MIN_EVENTS_FOR_AVAILABLE = 5;

interface PermissionGateResult {
  gated: boolean;
  granted: boolean;
  raw: string;
  error?: string;
}

async function requestSensorPermission(ctor: unknown): Promise<PermissionGateResult> {
  const req = (ctor as { requestPermission?: () => Promise<string> } | undefined)?.requestPermission;
  if (typeof req !== 'function') {
    return { gated: false, granted: true, raw: 'no permission gate on this platform' };
  }
  try {
    // MUST be called synchronously enough to stay inside the user gesture; callers
    // invoke this directly from a click/touch handler.
    const result = await req.call(ctor);
    return { gated: true, granted: result === 'granted', raw: String(result) };
  } catch (err) {
    return { gated: true, granted: false, raw: 'threw', error: describeError(err) };
  }
}

interface SampleStats {
  eventCount: number;
  eventsWithFiniteData: number;
  measuredHz: number;
  firstSample: Record<string, JsonValue> | null;
  fields: Record<string, boolean>;
}

function summariseRate(times: number[], windowMs: number): number {
  if (times.length < 2) return 0;
  const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  const effective = span > 0 ? span : windowMs;
  return round2(((times.length - 1) * 1000) / effective);
}

/**
 * Probe both motion sensors from a single user gesture.
 *
 * The ordering here is load-bearing. iOS only honours `requestPermission()` when it is
 * called from inside a user gesture, and an `await` between the two calls would put the
 * second one outside that gesture and make it throw. So both requests are started
 * synchronously, before anything is awaited, and the two listen windows then run
 * concurrently — which is also what the user expects from one tap.
 */
export async function probeMotionSensors(
  listenMs = MOTION_LISTEN_MS,
): Promise<{ motion: CapabilityRecord; orientation: CapabilityRecord }> {
  const motionCtor = (window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent;
  const orientationCtor = (window as unknown as { DeviceOrientationEvent?: unknown })
    .DeviceOrientationEvent;

  // Started, deliberately not awaited, while still inside the caller's gesture.
  const motionGateP =
    typeof motionCtor === 'function'
      ? requestSensorPermission(motionCtor)
      : Promise.resolve<PermissionGateResult>({ gated: false, granted: false, raw: 'absent' });
  const orientationGateP =
    typeof orientationCtor === 'function'
      ? requestSensorPermission(orientationCtor)
      : Promise.resolve<PermissionGateResult>({ gated: false, granted: false, raw: 'absent' });

  const [motionGate, orientationGate] = await Promise.all([motionGateP, orientationGateP]);

  const [motion, orientation] = await Promise.all([
    finishMotionProbe(motionCtor, motionGate, listenMs),
    finishOrientationProbe(orientationCtor, orientationGate, listenMs),
  ]);
  return { motion, orientation };
}

async function finishMotionProbe(
  ctor: unknown,
  gate: PermissionGateResult,
  listenMs: number,
): Promise<CapabilityRecord> {
  const started = performance.now();
  const id = 'motion.deviceMotion';
  const label = 'DeviceMotion';

  if (typeof ctor !== 'function') {
    return makeRecord(id, label, CapabilityState.UNAVAILABLE, DetectionMethod.PRESENCE_CHECK,
      'DeviceMotionEvent is absent on this platform', {}, started);
  }

  if (gate.gated && !gate.granted) {
    const denied = gate.raw === 'denied';
    return makeRecord(
      id, label,
      denied ? CapabilityState.PERMISSION_DENIED : CapabilityState.ERROR,
      DetectionMethod.FUNCTIONAL_PROBE,
      denied
        ? 'the user denied motion access — the engine will run vision-only (§17: IMU is ' +
          'not a substitute for vision, so this degrades fusion but does not stop tracking)'
        : `requestPermission() returned "${gate.raw}"`,
      { permission: gate.raw, ...(gate.error ? { error: gate.error } : {}) },
      started,
    );
  }

  const stats = await collectMotionSamples(listenMs);
  const available = stats.eventsWithFiniteData >= MIN_EVENTS_FOR_AVAILABLE;

  return makeRecord(
    id, label,
    available ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    DetectionMethod.FUNCTIONAL_PROBE,
    available
      ? `received ${stats.eventsWithFiniteData} events carrying finite sensor values in ` +
        `${listenMs} ms (${stats.measuredHz} Hz measured)`
      : stats.eventCount === 0
        ? `no devicemotion events arrived in ${listenMs} ms — the constructor exists but no ` +
          'sensor data is being delivered, so this is UNAVAILABLE, not AVAILABLE'
        : `${stats.eventCount} events arrived but only ${stats.eventsWithFiniteData} carried ` +
          `finite values (need >= ${MIN_EVENTS_FOR_AVAILABLE})`,
    {
      permission: gate.raw,
      permissionGated: gate.gated,
      listenMs,
      eventCount: stats.eventCount,
      eventsWithFiniteData: stats.eventsWithFiniteData,
      measuredHz: stats.measuredHz,
      fields: stats.fields,
      firstSample: stats.firstSample,
    },
    started,
  );
}

function collectMotionSamples(listenMs: number): Promise<SampleStats> {
  return new Promise((resolve) => {
    let eventCount = 0;
    let withData = 0;
    const times: number[] = [];
    let firstSample: Record<string, JsonValue> | null = null;
    const fields = {
      acceleration: false,
      accelerationIncludingGravity: false,
      rotationRate: false,
      interval: false,
    };

    const onMotion = (e: DeviceMotionEvent): void => {
      eventCount++;
      times.push(performance.now());
      const acc = e.acceleration;
      const accG = e.accelerationIncludingGravity;
      const rot = e.rotationRate;

      const hasAcc = !!acc && (isFiniteNumber(acc.x) || isFiniteNumber(acc.y) || isFiniteNumber(acc.z));
      const hasAccG = !!accG && (isFiniteNumber(accG.x) || isFiniteNumber(accG.y) || isFiniteNumber(accG.z));
      const hasRot = !!rot && (isFiniteNumber(rot.alpha) || isFiniteNumber(rot.beta) || isFiniteNumber(rot.gamma));

      if (hasAcc) fields.acceleration = true;
      if (hasAccG) fields.accelerationIncludingGravity = true;
      if (hasRot) fields.rotationRate = true;
      if (isFiniteNumber(e.interval)) fields.interval = true;

      if (hasAcc || hasAccG || hasRot) {
        withData++;
        if (!firstSample) {
          firstSample = toJsonSafe({
            acceleration: acc ? { x: acc.x, y: acc.y, z: acc.z } : null,
            accelerationIncludingGravity: accG ? { x: accG.x, y: accG.y, z: accG.z } : null,
            rotationRate: rot ? { alpha: rot.alpha, beta: rot.beta, gamma: rot.gamma } : null,
            interval: e.interval,
          }) as Record<string, JsonValue>;
        }
      }
    };

    window.addEventListener('devicemotion', onMotion);
    setTimeout(() => {
      window.removeEventListener('devicemotion', onMotion);
      resolve({
        eventCount,
        eventsWithFiniteData: withData,
        measuredHz: summariseRate(times, listenMs),
        firstSample,
        fields,
      });
    }, listenMs);
  });
}

/**
 * Finish the DeviceOrientation probe. Also records whether the readings are absolute and
 * whether WebKit's compass heading is present, because Phase 7 needs to know if the
 * orientation is referenced to anything or is relative-only.
 */
async function finishOrientationProbe(
  ctor: unknown,
  gate: PermissionGateResult,
  listenMs: number,
): Promise<CapabilityRecord> {
  const started = performance.now();
  const id = 'motion.deviceOrientation';
  const label = 'DeviceOrientation';

  if (typeof ctor !== 'function') {
    return makeRecord(id, label, CapabilityState.UNAVAILABLE, DetectionMethod.PRESENCE_CHECK,
      'DeviceOrientationEvent is absent on this platform', {}, started);
  }

  if (gate.gated && !gate.granted) {
    const denied = gate.raw === 'denied';
    return makeRecord(
      id, label,
      denied ? CapabilityState.PERMISSION_DENIED : CapabilityState.ERROR,
      DetectionMethod.FUNCTIONAL_PROBE,
      denied
        ? 'the user denied orientation access — vision-only mode'
        : `requestPermission() returned "${gate.raw}"`,
      { permission: gate.raw, ...(gate.error ? { error: gate.error } : {}) },
      started,
    );
  }

  const stats = await collectOrientationSamples(listenMs);
  const available = stats.eventsWithFiniteData >= MIN_EVENTS_FOR_AVAILABLE;

  return makeRecord(
    id, label,
    available ? CapabilityState.AVAILABLE : CapabilityState.UNAVAILABLE,
    DetectionMethod.FUNCTIONAL_PROBE,
    available
      ? `received ${stats.eventsWithFiniteData} orientation events with finite values in ` +
        `${listenMs} ms (${stats.measuredHz} Hz measured); ` +
        `absolute=${stats.absolute}, webkitCompassHeading=${stats.hasCompass}`
      : stats.eventCount === 0
        ? `no deviceorientation events arrived in ${listenMs} ms`
        : `${stats.eventCount} events arrived but only ${stats.eventsWithFiniteData} carried ` +
          'finite values',
    {
      permission: gate.raw,
      permissionGated: gate.gated,
      listenMs,
      eventCount: stats.eventCount,
      eventsWithFiniteData: stats.eventsWithFiniteData,
      measuredHz: stats.measuredHz,
      absolute: stats.absolute,
      webkitCompassHeading: stats.hasCompass,
      compassAccuracy: stats.compassAccuracy,
      firstSample: stats.firstSample,
    },
    started,
  );
}

function collectOrientationSamples(
  listenMs: number,
): Promise<SampleStats & { absolute: boolean; hasCompass: boolean; compassAccuracy: number | null }> {
  return new Promise((resolve) => {
    let eventCount = 0;
    let withData = 0;
    let absolute = false;
    let hasCompass = false;
    let compassAccuracy: number | null = null;
    const times: number[] = [];
    let firstSample: Record<string, JsonValue> | null = null;
    const fields = { alpha: false, beta: false, gamma: false };

    const onOrientation = (e: DeviceOrientationEvent): void => {
      eventCount++;
      times.push(performance.now());
      if (isFiniteNumber(e.alpha)) fields.alpha = true;
      if (isFiniteNumber(e.beta)) fields.beta = true;
      if (isFiniteNumber(e.gamma)) fields.gamma = true;
      if (e.absolute === true) absolute = true;

      const wk = e as unknown as { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      if (isFiniteNumber(wk.webkitCompassHeading)) {
        hasCompass = true;
        if (isFiniteNumber(wk.webkitCompassAccuracy)) compassAccuracy = wk.webkitCompassAccuracy;
      }

      if (fields.alpha || fields.beta || fields.gamma) {
        withData++;
        if (!firstSample) {
          firstSample = toJsonSafe({
            alpha: e.alpha,
            beta: e.beta,
            gamma: e.gamma,
            absolute: e.absolute,
            webkitCompassHeading: wk.webkitCompassHeading ?? null,
          }) as Record<string, JsonValue>;
        }
      }
    };

    window.addEventListener('deviceorientation', onOrientation);
    setTimeout(() => {
      window.removeEventListener('deviceorientation', onOrientation);
      resolve({
        eventCount,
        eventsWithFiniteData: withData,
        measuredHz: summariseRate(times, listenMs),
        firstSample,
        fields,
        absolute,
        hasCompass,
        compassAccuracy,
      });
    }, listenMs);
  });
}

function makeRecord(
  id: string,
  label: string,
  state: CapabilityState,
  method: DetectionMethod,
  detail: string,
  data: Record<string, unknown>,
  startedAt: number,
): CapabilityRecord {
  return {
    id,
    group: 'motion',
    label,
    state,
    method,
    detail,
    data: toJsonSafe(data) as Record<string, JsonValue>,
    durationMs: round2(performance.now() - startedAt),
    timestamp: Date.now(),
  };
}
