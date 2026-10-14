/**
 * Which way is down, in the phone's own frame — the input Phase 11 needs to tell a floor from a
 * wall (v4 §23, §24).
 *
 * A camera cannot see gravity. Every landmark, every surface and every pose this project
 * produces is in a world whose axes are those of the first registered keyframe's camera, tilted
 * however the phone happened to be tilted at that moment. A plane is a plane in that world; it
 * is a *floor* only relative to gravity, and the only instrument on the device that measures
 * gravity is the motion sensor.
 *
 * ## Which reading, and why that one
 *
 * `deviceorientation`'s `beta` and `gamma` are the platform's own fused attitude, defined by the
 * W3C specification against the Earth frame, so the down vector they imply has **no sign
 * ambiguity**:
 *
 * ```
 *   up_device = (−sin γ · cos β,  sin β,  cos γ · cos β)
 * ```
 *
 * `accelerationIncludingGravity` is the raw alternative, and its sign is exactly what the
 * platforms disagree about — the Phase 7 filter refuses to assume one for that reason. It is
 * read here too, but only as a **cross-check**: the sign that makes it agree with the
 * orientation-derived down is measured, and the angle they then disagree by is reported. On
 * the Phase 0 device bundle the two agree to within a degree with `accelerationIncludingGravity`
 * pointing *down* — the opposite of the W3C convention — which is the disagreement the
 * cross-check exists to measure rather than assume.
 *
 * Nothing here relates the device frame to the camera's; that is `mapping/gravity.ts`, which
 * measures it.
 *
 * **On iOS the listener needs permission, and permission needs a gesture**, so `start()` must be
 * called from a click handler and calls `requestPermission()` before anything is awaited — the
 * ordering `MotionCapabilityProbe` documents.
 */

import { describeError } from '../core/validate';

export interface GravitySample {
  /** `Date.now()` when the event arrived — the clock `postedAtEpoch` is on. */
  readonly at: number;
  /** Unit vector toward the ground, device frame (x right, y up the screen, z out of it). */
  readonly down: readonly number[];
  readonly beta: number;
  readonly gamma: number;
  /** `screen.orientation.angle` when the sample arrived, normalised to 0/90/180/270. */
  readonly screenAngle: number;
}

export const GravitySource = {
  LIVE: 'LIVE',
  WAITING: 'WAITING',
  UNAVAILABLE: 'UNAVAILABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  IDLE: 'IDLE',
} as const;
export type GravitySource = (typeof GravitySource)[keyof typeof GravitySource];

const NO_GATE = 'no permission gate on this platform';

/** How much history is kept: a frame is paired with a sample at most this old. */
const HISTORY_MS = 4000;
/** A frame further than this from any orientation sample has no gravity reading. */
export const MAX_PAIRING_GAP_MS = 60;

export interface AccelerationCheck {
  /** `+1` when `accelerationIncludingGravity` points down, `-1` when up, `0` before it is known. */
  readonly sign: number;
  /** Median angle between the signed reading and the orientation's down, degrees. `-1` before any. */
  readonly medianDeg: number;
  readonly samples: number;
}

export class GravityMonitor {
  private source: GravitySource = GravitySource.IDLE;
  private detail = 'not started';
  private readonly history: GravitySample[] = [];
  private orientationListener: ((e: DeviceOrientationEvent) => void) | null = null;
  private motionListener: ((e: DeviceMotionEvent) => void) | null = null;
  private events = 0;
  private readonly agreeDown: number[] = [];
  private readonly agreeUp: number[] = [];

  getSource(): GravitySource {
    return this.source;
  }

  getDetail(): string {
    return this.detail;
  }

  isLive(): boolean {
    return this.source === GravitySource.LIVE;
  }

  /** The sample nearest `atEpoch`, or `null` if none is within `MAX_PAIRING_GAP_MS`. */
  sampleAt(atEpoch: number): GravitySample | null {
    let best: GravitySample | null = null;
    let gap = Infinity;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const s = this.history[i];
      if (!s) continue;
      const d = Math.abs(s.at - atEpoch);
      if (d < gap) {
        gap = d;
        best = s;
      }
      if (s.at < atEpoch - MAX_PAIRING_GAP_MS) break;
    }
    return best && gap <= MAX_PAIRING_GAP_MS ? best : null;
  }

  /**
   * How fast the down vector was changing around `atEpoch`, deg/s. A frame taken while the phone
   * was being swung has a pairing error proportional to this, and the aligner leaves it out.
   */
  turnRateAt(atEpoch: number): number {
    const before = this.history.filter((s) => s.at <= atEpoch).slice(-3);
    const after = this.history.find((s) => s.at > atEpoch);
    const a = before[0];
    const b = after ?? before[before.length - 1];
    if (!a || !b || b.at <= a.at) return -1;
    return (angleDeg(a.down, b.down) * 1000) / (b.at - a.at);
  }

  accelerationCheck(): AccelerationCheck {
    const n = Math.max(this.agreeDown.length, this.agreeUp.length);
    if (n === 0) return { sign: 0, medianDeg: -1, samples: 0 };
    const down = median(this.agreeDown);
    const up = median(this.agreeUp);
    return down <= up
      ? { sign: 1, medianDeg: round(down, 3), samples: n }
      : { sign: -1, medianDeg: round(up, 3), samples: n };
  }

  describe(): Record<string, unknown> {
    const last = this.history[this.history.length - 1] ?? null;
    return {
      source: this.source,
      detail: this.detail,
      events: this.events,
      lastSample: last,
      accelerationCheck: this.accelerationCheck(),
    };
  }

  /** MUST be reached from a click handler on iOS — see the note at the top of this file. */
  async start(): Promise<GravitySource> {
    this.stop();
    const orientationCtor = (window as unknown as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
    const motionCtor = (window as unknown as { DeviceMotionEvent?: unknown }).DeviceMotionEvent;
    if (typeof orientationCtor !== 'function') {
      this.source = GravitySource.UNAVAILABLE;
      this.detail = 'DeviceOrientationEvent is absent on this platform, so nothing here can say which way is down';
      return this.source;
    }
    // Both requests started before anything is awaited, so both are inside the gesture.
    const orientationGate = requestPermission(orientationCtor);
    const motionGate = typeof motionCtor === 'function' ? requestPermission(motionCtor) : Promise.resolve('absent');
    const [orientation, motion] = await Promise.all([orientationGate, motionGate]);
    if (orientation !== 'granted' && orientation !== NO_GATE) {
      this.source = GravitySource.PERMISSION_DENIED;
      this.detail =
        `orientation access was not granted (${orientation}). Without it the world has no down, ` +
        'every surface stays UNKNOWN and no stage can be generated — fail closed (v4 §44)';
      return this.source;
    }

    this.source = GravitySource.WAITING;
    this.detail = 'listening for deviceorientation; nothing with beta and gamma has arrived yet';
    this.orientationListener = (e: DeviceOrientationEvent): void => {
      const beta = e.beta;
      const gamma = e.gamma;
      if (typeof beta !== 'number' || typeof gamma !== 'number') return;
      if (!Number.isFinite(beta) || !Number.isFinite(gamma)) return;
      this.events++;
      const sample: GravitySample = {
        at: Date.now(),
        down: downFromOrientation(beta, gamma),
        beta,
        gamma,
        screenAngle: currentScreenAngle(),
      };
      this.history.push(sample);
      while (this.history.length > 0 && (this.history[0]?.at ?? 0) < sample.at - HISTORY_MS) this.history.shift();
      if (this.source !== GravitySource.LIVE) {
        this.source = GravitySource.LIVE;
        this.detail = 'deviceorientation is delivering finite beta and gamma';
      }
    };
    window.addEventListener('deviceorientation', this.orientationListener);

    if (motion === 'granted' || motion === NO_GATE) {
      this.motionListener = (e: DeviceMotionEvent): void => {
        const a = e.accelerationIncludingGravity;
        if (!a || typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') return;
        const v = [a.x, a.y, a.z];
        if (!v.every(Number.isFinite)) return;
        const norm = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
        // Far from 1 g the reading is mostly the hand, not gravity, and says nothing about sign.
        if (!(norm > 7.8 && norm < 11.8)) return;
        const s = this.sampleAt(Date.now());
        if (!s) return;
        const unit = v.map((x) => x / norm);
        this.agreeDown.push(angleDeg(unit, s.down));
        this.agreeUp.push(angleDeg(unit.map((x) => -x), s.down));
        if (this.agreeDown.length > 600) this.agreeDown.shift();
        if (this.agreeUp.length > 600) this.agreeUp.shift();
      };
      window.addEventListener('devicemotion', this.motionListener);
    }
    return this.source;
  }

  stop(): void {
    if (this.orientationListener) {
      window.removeEventListener('deviceorientation', this.orientationListener);
      this.orientationListener = null;
    }
    if (this.motionListener) {
      window.removeEventListener('devicemotion', this.motionListener);
      this.motionListener = null;
    }
    if (this.source === GravitySource.LIVE || this.source === GravitySource.WAITING) {
      this.source = GravitySource.IDLE;
      this.detail = 'stopped';
    }
  }
}

/** W3C `deviceorientation`: `R = Rz(α)·Rx(β)·Ry(γ)` carries device into Earth; down is `−Rᵀ·ẑ`. */
export function downFromOrientation(betaDeg: number, gammaDeg: number): number[] {
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  return [Math.sin(g) * Math.cos(b), -Math.sin(b), -Math.cos(g) * Math.cos(b)];
}

function currentScreenAngle(): number {
  const so = (screen as unknown as { orientation?: { angle?: unknown } }).orientation;
  const a =
    typeof so?.angle === 'number'
      ? so.angle
      : typeof (window as unknown as { orientation?: unknown }).orientation === 'number'
        ? ((window as unknown as { orientation: number }).orientation)
        : 0;
  return (((Math.round(a / 90) * 90) % 360) + 360) % 360;
}

async function requestPermission(ctor: unknown): Promise<string> {
  const req = (ctor as { requestPermission?: () => Promise<string> }).requestPermission;
  if (typeof req !== 'function') return NO_GATE;
  try {
    const r = String(await req.call(ctor));
    return r === 'granted' ? 'granted' : r;
  } catch (err) {
    return `threw: ${describeError(err)}`;
  }
}

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const d = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Infinity;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
