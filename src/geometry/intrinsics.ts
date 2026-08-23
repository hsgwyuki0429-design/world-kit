/**
 * Camera intrinsics (v3 §15), and the fact that this platform will not tell us what they are.
 *
 * v3 §15 gives the matrix and then gives the escape hatch in the same breath:
 *
 * > intrinsicsが正確に取得できない場合： **INTRINSICS: ESTIMATED** とする。
 *
 * They cannot be obtained. Safari exposes no focal length, no sensor size and no lens
 * identifier through `MediaStreamTrack`; the device run of 2026-08-23 reported
 * `label: 背面デュアル広角カメラ`, `720×1280`, `aspectRatio 0.563` and nothing about optics.
 * A calibration pattern is not available either — nobody is going to print a chessboard to
 * play a ball game.
 *
 * So `K` here is **derived from an assumed field of view**, and every record that carries it
 * says so. Two consequences are built in rather than left to the reader:
 *
 *  - **`estimated: true` travels with the matrix**, so a downstream phase that wants to treat a
 *    focal length as measured has to strip the flag deliberately.
 *  - **The assumption's consequences are measured, not asserted.** `perturbed()` returns the
 *    same camera with `f` scaled, and Phase 6 recomputes its pose under ±20 % on every judged
 *    frame. What barely moves does not depend on the guess; what moves does. Stating a nominal
 *    FOV without that is a guess with a number attached.
 *
 * §H.0 is why this is a per-frame computation rather than a constant read at open: rotating the
 * device swaps the frame dimensions on the same track, 1280×720 ↔ 720×1280, and `K` is derived
 * from frame geometry. `fx`, `fy`, `cx` and `cy` all change mid-scan.
 */

/**
 * The assumed field of view across the **long** edge of the frame, in degrees.
 *
 * An iPhone rear wide camera in video mode is in this neighbourhood. It is a stated assumption
 * and not a measurement, which is the whole reason `estimated` exists and the whole reason
 * `INTRINSICS_SENSITIVITY` exists beside it. Expressed across the long edge so that it means
 * the same thing in portrait and landscape — the sensor does not rotate, only the readout does.
 */
export const NOMINAL_FOV_DEG = 67.0;

/** How far `f` is perturbed, each way, to measure what the assumption is holding up. */
export const INTRINSICS_SENSITIVITY = 0.2;

export interface Intrinsics {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  /** v3 §15. Always `true` in this build; a false here would need a calibration that does not exist. */
  readonly estimated: true;
  /** The assumption the focal length came from, carried so the number can be re-derived. */
  readonly assumedFovDeg: number;
}

/**
 * `K` for a frame of this size, on the stated assumption.
 *
 * Square pixels (`fx = fy`) and the principal point at the image centre. Both are assumptions
 * too, and both are far safer than the focal length: a modern phone sensor's pixels are square
 * to well under a percent, and a principal point off-centre by a few pixels moves a recovered
 * rotation by far less than the correspondence noise §13 already tolerates.
 */
export function intrinsicsFor(width: number, height: number, fovDeg = NOMINAL_FOV_DEG): Intrinsics | null {
  if (!(width > 0) || !(height > 0) || !(fovDeg > 0) || fovDeg >= 180) return null;
  const longEdge = Math.max(width, height);
  const f = (0.5 * longEdge) / Math.tan((fovDeg * Math.PI) / 360);
  if (!Number.isFinite(f) || f <= 0) return null;
  return {
    fx: f,
    fy: f,
    cx: width / 2,
    cy: height / 2,
    width,
    height,
    estimated: true,
    assumedFovDeg: fovDeg,
  };
}

/** The same camera with the focal length scaled — the sensitivity probe's only input. */
export function perturbed(k: Intrinsics, factor: number): Intrinsics {
  return { ...k, fx: k.fx * factor, fy: k.fy * factor };
}

/** Row-major `K`. */
export function matrixOf(k: Intrinsics): number[] {
  return [k.fx, 0, k.cx, 0, k.fy, k.cy, 0, 0, 1];
}

/** Row-major `K⁻¹`, in closed form — `invert3x3` would work and this cannot fail. */
export function inverseMatrixOf(k: Intrinsics): number[] {
  return [1 / k.fx, 0, -k.cx / k.fx, 0, 1 / k.fy, -k.cy / k.fy, 0, 0, 1];
}

/** Pixel to normalised camera ray, `z = 1`. */
export function toCameraRay(k: Intrinsics, x: number, y: number): number[] {
  return [(x - k.cx) / k.fx, (y - k.cy) / k.fy, 1];
}

/** ...and back. `null` when the point is at or behind the camera plane. */
export function projectRay(k: Intrinsics, p: readonly number[]): { x: number; y: number } | null {
  const z = p[2] ?? 0;
  if (!Number.isFinite(z) || Math.abs(z) <= 1e-12) return null;
  return { x: k.fx * ((p[0] ?? 0) / z) + k.cx, y: k.fy * ((p[1] ?? 0) / z) + k.cy };
}
