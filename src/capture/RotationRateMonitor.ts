/**
 * A live `rotationRate` feed for FLOW-003 (§65, §17).
 *
 * Phase 0's `MotionCapabilityProbe` answers "is there a gyroscope, and does it deliver
 * finite values" once, from a user gesture, and then stops listening. Phase 4 needs the
 * readings themselves, continuously, because FLOW-003 is defined against **a second
 * independent instrument**: the scene-shift search measures the image, the gyroscope
 * measures the device, and neither of them is the tracker. A test that could not tell a
 * rotation from a translation would have to take the operator's word for which one they
 * performed, and §65's whole difficulty is that the operator's intention is not evidence.
 *
 * What this class does *not* do is decide anything. It reports samples and it reports why
 * there are none; FLOW-003 turns an absence into `PENDING` with the reason attached, exactly
 * as Phase 1 did for CAM-004 when the sensor was missing.
 *
 * **On iOS the listener needs permission, and permission needs a gesture.** `start()` must
 * therefore be called from a click handler, and it calls `requestPermission()` before any
 * `await` for the reason `MotionCapabilityProbe` documents at length: an `await` in between
 * puts the call outside the gesture and it throws.
 */

import { describeError } from '../core/validate';

/**
 * One complete `devicemotion` reading, for Phase 7.
 *
 * Phase 4 and Phase 6 need the angular rate and nothing else, so `RotationReading` carries that
 * and the listener throws the rest away. Phase 7 fuses, and a fusion needs the accelerometer as
 * well — so the same listener now also offers the whole event, on a second callback, rather than
 * a second listener being attached with a second `requestPermission()` call. One gesture, one
 * permission, one event stream: two consumers of it.
 *
 * **An absent channel is an empty array, never zeros.** A phone lying on a table reports a real
 * `[0, 0, 0]` rotation rate, and a build that denied permission reports `null`. Collapsing the
 * two would make a stationary phone look like a phone with no gyroscope, which is exactly the
 * distinction IMU-002 turns on.
 */
export interface MotionSample {
  /** `performance.now()` when the event arrived — the frame clock's epoch, not the event's. */
  readonly at: number;
  /** m/s², body frame, gravity removed by the platform. `[]` where the event carried none. */
  readonly acceleration: readonly number[];
  readonly accelerationIncludingGravity: readonly number[];
  /** **rad/s**, body frame. Converted here so nothing downstream has to know the event's unit. */
  readonly rotationRate: readonly number[];
  /** The event's own `interval`, seconds. `-1` where the platform supplied none. */
  readonly interval: number;
}

/** The magnitude of the device's angular velocity, in degrees per second. */
export interface RotationReading {
  /** `performance.now()` when the event arrived. */
  readonly at: number;
  readonly degPerSecond: number;
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

export const RotationSource = {
  /** Events are arriving and carrying finite `rotationRate` values. */
  LIVE: 'LIVE',
  /** Listening, but nothing has arrived yet. */
  WAITING: 'WAITING',
  /** `DeviceMotionEvent` is absent on this platform. */
  UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Not started. */
  IDLE: 'IDLE',
} as const;
export type RotationSource = (typeof RotationSource)[keyof typeof RotationSource];

function finite(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

export class RotationRateMonitor {
  private listener: ((e: DeviceMotionEvent) => void) | null = null;
  private source: RotationSource = RotationSource.IDLE;
  private detail = 'not started';
  private events = 0;
  private eventsWithRotation = 0;
  private firstAt = -1;
  private lastAt = -1;
  private last: RotationReading | null = null;

  getSource(): RotationSource {
    return this.source;
  }

  /** Why there is no data, in words a test can put in a `PENDING` reason. */
  getDetail(): string {
    return this.detail;
  }

  isLive(): boolean {
    return this.source === RotationSource.LIVE;
  }

  getLast(): RotationReading | null {
    return this.last;
  }

  /** Measured event rate over the run, so the evidence carries it rather than assuming 60 Hz. */
  measuredHz(): number {
    if (this.events < 2 || this.lastAt <= this.firstAt) return -1;
    return Math.round(((this.events - 1) * 1000) / (this.lastAt - this.firstAt) * 100) / 100;
  }

  describe(): Record<string, unknown> {
    return {
      source: this.source,
      detail: this.detail,
      events: this.events,
      eventsWithRotation: this.eventsWithRotation,
      measuredHz: this.measuredHz(),
      lastReading: this.last,
    };
  }

  /**
   * MUST be reached from a click handler on iOS — see the note at the top of this file.
   *
   * @param onReading called for every event carrying a finite `rotationRate`.
   * @param onSample called for **every** event, whatever it carried — Phase 7 needs to see the
   *   ones with nothing in them, because an event stream that fires with every field `null` is
   *   what a half-granted permission looks like and IMU-002 decides on that.
   */
  async start(
    onReading: (reading: RotationReading) => void,
    onSample?: (sample: MotionSample) => void,
  ): Promise<RotationSource> {
    this.stop();
    const ctor = (window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent;
    if (typeof ctor !== 'function') {
      this.source = RotationSource.UNAVAILABLE;
      this.detail = 'DeviceMotionEvent is absent on this platform';
      return this.source;
    }

    const req = (ctor as { requestPermission?: () => Promise<string> }).requestPermission;
    if (typeof req === 'function') {
      // Started before any await, so it is still inside the caller's gesture.
      let raw = 'threw';
      try {
        raw = String(await req.call(ctor));
      } catch (err) {
        this.source = RotationSource.PERMISSION_DENIED;
        this.detail = `DeviceMotionEvent.requestPermission() threw: ${describeError(err)}`;
        return this.source;
      }
      if (raw !== 'granted') {
        this.source = RotationSource.PERMISSION_DENIED;
        this.detail =
          `the user did not grant motion access (requestPermission returned "${raw}"). ` +
          '§17: the IMU is not a substitute for vision, so tracking continues without it and ' +
          'FLOW-003 reports PENDING rather than failing';
        return this.source;
      }
    }

    this.source = RotationSource.WAITING;
    this.detail = 'listening for devicemotion; no event with rotationRate has arrived yet';

    this.listener = (e: DeviceMotionEvent): void => {
      const at = performance.now();
      this.events++;
      if (this.firstAt < 0) this.firstAt = at;
      this.lastAt = at;
      onSample?.({
        at,
        acceleration: vector(e.acceleration),
        accelerationIncludingGravity: vector(e.accelerationIncludingGravity),
        // Degrees per second on the wire, radians per second everywhere below this line.
        rotationRate: vector(e.rotationRate as DeviceMotionEventAcceleration | null).map(
          (d) => (d * Math.PI) / 180,
        ),
        interval: typeof e.interval === 'number' && Number.isFinite(e.interval) && e.interval > 0
          ? e.interval
          : -1,
      });
      const rot = e.rotationRate;
      if (!rot) return;
      const alpha = finite(rot.alpha);
      const beta = finite(rot.beta);
      const gamma = finite(rot.gamma);
      if (alpha === 0 && beta === 0 && gamma === 0 && !hasAnyFinite(rot)) return;
      this.eventsWithRotation++;
      // The magnitude of the angular velocity vector. Which axis the device turned about is
      // not what FLOW-003 asks — it asks whether it turned at all, and by how much.
      const degPerSecond = Math.sqrt(alpha * alpha + beta * beta + gamma * gamma);
      const reading: RotationReading = { at, degPerSecond, alpha, beta, gamma };
      this.last = reading;
      if (this.source !== RotationSource.LIVE) {
        this.source = RotationSource.LIVE;
        this.detail = 'devicemotion is delivering finite rotationRate values';
      }
      onReading(reading);
    };
    window.addEventListener('devicemotion', this.listener);
    return this.source;
  }

  stop(): void {
    if (this.listener) {
      window.removeEventListener('devicemotion', this.listener);
      this.listener = null;
    }
    if (this.source === RotationSource.LIVE || this.source === RotationSource.WAITING) {
      this.source = RotationSource.IDLE;
      this.detail = 'stopped';
    }
  }
}

/**
 * `[x, y, z]` from an event's vector, or `[]` where the platform gave none.
 *
 * `DeviceMotionEventRotationRate` names its components `alpha`/`beta`/`gamma`; they are rotations
 * about the device's z, x and y axes respectively, so the order below is the axis order and not
 * the property order. Getting that wrong would put the gyroscope's x on the accelerometer's z,
 * which is a rotation of the body frame nothing downstream could detect.
 */
function vector(v: DeviceMotionEventAcceleration | DeviceMotionEventRotationRate | null): number[] {
  if (!v) return [];
  const asAccel = v as DeviceMotionEventAcceleration;
  const asRate = v as DeviceMotionEventRotationRate;
  const x = typeof asAccel.x === 'number' ? asAccel.x : asRate.beta;
  const y = typeof asAccel.y === 'number' ? asAccel.y : asRate.gamma;
  const z = typeof asAccel.z === 'number' ? asAccel.z : asRate.alpha;
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return [];
  return [x as number, y as number, z as number];
}

function hasAnyFinite(rot: DeviceMotionEventRotationRate): boolean {
  return (
    (typeof rot.alpha === 'number' && Number.isFinite(rot.alpha)) ||
    (typeof rot.beta === 'number' && Number.isFinite(rot.beta)) ||
    (typeof rot.gamma === 'number' && Number.isFinite(rot.gamma))
  );
}
