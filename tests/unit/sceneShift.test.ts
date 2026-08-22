/**
 * The independent scene-motion measurement (FLOW-002's anti-fake gate).
 *
 * The point of these tests is not that the search is accurate — it is deliberately coarse.
 * It is that the search **disagrees with a tracker that returns its input**, on a frame pair
 * that demonstrably moved, without ever being shown the tracker's output. Everything else
 * about a track can be produced without looking at the second frame; this cannot.
 */

import { describe, expect, it } from 'vitest';
import {
  FAST_SHIFT_PX,
  FrameMotion,
  MIN_SHIFT_CONFIDENCE,
  OCCLUDED_LUMA,
  OCCLUSION_MAD,
  SHIFT_AGREEMENT_FRACTION,
  SHIFT_AGREEMENT_PX,
  SHIFT_SEARCH_RADIUS,
  STATIC_SHIFT_PX,
  SceneShiftProbe,
  classifyFrameMotion,
  estimateSceneShift,
  shiftAgreementTolerance,
} from '../../src/tracking/SceneShift';

const W = 80;
const H = 60;

function texture(x: number, y: number): number {
  const v =
    128 +
    50 * Math.sin(x * 0.19 + 0.3) * Math.cos(y * 0.15 - 0.4) +
    36 * Math.cos(x * 0.07 + y * 0.09) +
    20 * Math.sin(x * 0.41 - y * 0.33);
  return Math.max(0, Math.min(255, v));
}

/** A plane of `texture` whose content is displaced by (dx, dy) — the tracker's sense. */
function planeAt(dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = Math.round(texture(x - dx, y - dy));
  }
  return out;
}

describe('thresholds', () => {
  it('are the ones the test plan fixed', () => {
    expect(STATIC_SHIFT_PX).toBe(1.0);
    expect(FAST_SHIFT_PX).toBe(12.0);
    expect(SHIFT_AGREEMENT_PX).toBe(2.0);
    expect(SHIFT_AGREEMENT_FRACTION).toBe(0.35);
    expect(OCCLUDED_LUMA).toBe(12);
    expect(OCCLUSION_MAD).toBe(60);
    expect(SHIFT_SEARCH_RADIUS).toBe(8);
  });

  it('takes the larger of the absolute and proportional tolerances', () => {
    expect(shiftAgreementTolerance(0)).toBe(2.0);
    expect(shiftAgreementTolerance(4)).toBe(2.0);
    expect(shiftAgreementTolerance(20)).toBeCloseTo(7.0, 6);
    expect(shiftAgreementTolerance(-20)).toBeCloseTo(7.0, 6);
  });
});

describe('measuring the shift', () => {
  const cases = [
    { dx: 0, dy: 0 },
    { dx: 3, dy: 0 },
    { dx: 0, dy: -2 },
    { dx: -5, dy: 4 },
    { dx: 7, dy: 7 },
  ];

  for (const { dx, dy } of cases) {
    it(`recovers (${dx}, ${dy}) in the tracker's sense`, () => {
      // levelScale 1 so the assertion is about the search, not about the scaling.
      const r = estimateSceneShift(planeAt(0, 0), planeAt(dx, dy), W, H, 1);
      expect(r).not.toBeNull();
      expect(r?.dx).toBe(dx);
      expect(r?.dy).toBe(dy);
      expect(r?.magnitude0).toBeCloseTo(Math.hypot(dx, dy), 6);
    });
  }

  it('scales into level-0 pixels, which is where the tracker reports', () => {
    const r = estimateSceneShift(planeAt(0, 0), planeAt(2, -1), W, H, 4);
    expect(r?.dx0).toBe(8);
    expect(r?.dy0).toBe(-4);
    expect(r?.levelScale).toBe(4);
  });

  it('says nothing about a flat pair rather than reporting it motionless', () => {
    // The distinction that matters: "the image did not move" and "this frame pair cannot say
    // whether it moved" are different claims, and only the first is a measurement.
    const flat = new Uint8Array(W * H).fill(90);
    const r = estimateSceneShift(flat, flat, W, H, 1);
    expect(r).not.toBeNull();
    expect(r?.confidence).toBeLessThan(MIN_SHIFT_CONFIDENCE);
    expect(classifyFrameMotion(r, 90, 0)).toBe(FrameMotion.INDETERMINATE);
  });

  it('clears the confidence floor on a textured pair that really moved', () => {
    const r = estimateSceneShift(planeAt(0, 0), planeAt(3, 2), W, H, 1);
    expect(r?.confidence).toBeGreaterThanOrEqual(MIN_SHIFT_CONFIDENCE);
  });
});

describe('classifying the frame from the image', () => {
  it('calls a still scene STATIC and a moving one SLOW or FAST', () => {
    const still = estimateSceneShift(planeAt(0, 0), planeAt(0, 0), W, H, 4);
    expect(classifyFrameMotion(still, 128, 1)).toBe(FrameMotion.STATIC);

    const slow = estimateSceneShift(planeAt(0, 0), planeAt(1, 0), W, H, 4);
    expect(slow?.magnitude0).toBe(4);
    expect(classifyFrameMotion(slow, 128, 5)).toBe(FrameMotion.SLOW);

    const fast = estimateSceneShift(planeAt(0, 0), planeAt(4, 0), W, H, 4);
    expect(fast?.magnitude0).toBe(16);
    expect(classifyFrameMotion(fast, 128, 20)).toBe(FrameMotion.FAST);
  });

  it('calls a dark frame OCCLUDED whatever the shift search says', () => {
    const r = estimateSceneShift(planeAt(0, 0), planeAt(2, 0), W, H, 4);
    expect(classifyFrameMotion(r, OCCLUDED_LUMA - 1, 5)).toBe(FrameMotion.OCCLUDED);
    expect(classifyFrameMotion(r, OCCLUDED_LUMA + 1, 5)).not.toBe(FrameMotion.OCCLUDED);
  });

  it('calls a wholesale change with no shift explaining it OCCLUDED', () => {
    // A hand across a bright lens: the image changes completely and no translation accounts
    // for it. That is the second clause, and it is why one luma threshold is not enough.
    const flat = new Uint8Array(W * H).fill(200);
    const r = estimateSceneShift(planeAt(0, 0), flat, W, H, 4);
    expect(classifyFrameMotion(r, 200, OCCLUSION_MAD + 5)).toBe(FrameMotion.OCCLUDED);
  });

  it('does not call a large but explained motion OCCLUDED', () => {
    const r = estimateSceneShift(planeAt(0, 0), planeAt(6, 0), W, H, 4);
    expect(r?.confidence).toBeGreaterThanOrEqual(MIN_SHIFT_CONFIDENCE);
    expect(classifyFrameMotion(r, 128, OCCLUSION_MAD + 5)).toBe(FrameMotion.FAST);
  });
});

describe('the probe keeps its own memory of the previous frame', () => {
  it('reports nothing on the first frame, then measures against it', () => {
    const probe = new SceneShiftProbe();
    expect(probe.measure(planeAt(0, 0), W, H, 4)).toBeNull();
    const r = probe.measure(planeAt(2, 1), W, H, 4);
    expect(r?.dx0).toBe(8);
    expect(r?.dy0).toBe(4);
  });

  it('forgets when the geometry changes, rather than comparing incomparable frames', () => {
    const probe = new SceneShiftProbe();
    expect(probe.measure(planeAt(0, 0), W, H, 4)).toBeNull();
    expect(probe.measure(new Uint8Array(40 * 30), 40, 30, 8)).toBeNull();
  });

  it('allocates once per geometry, not once per frame', () => {
    const probe = new SceneShiftProbe();
    for (let i = 0; i < 20; i++) probe.measure(planeAt(i, 0), W, H, 4);
    expect(probe.allocations).toBe(1);
  });
});

describe('the disagreement FLOW-002 gates on', () => {
  it('separates a working tracker from one that returns its input', () => {
    // The scene moves 3 px at the top level — 12 level-0 px at a scale of 4.
    const probe = new SceneShiftProbe();
    probe.measure(planeAt(0, 0), W, H, 4);
    const measured = probe.measure(planeAt(3, 0), W, H, 4);
    expect(measured).not.toBeNull();
    const sceneMagnitude = measured?.magnitude0 ?? 0;
    expect(sceneMagnitude).toBe(12);

    // A tracker that returns its input reports zero displacement — and a *perfect* §13
    // forward/backward error, so nothing computed from its own output objects.
    const identityTrackerDisplacement = 0;
    const tolerance = shiftAgreementTolerance(sceneMagnitude);
    expect(Math.abs(identityTrackerDisplacement - sceneMagnitude)).toBeGreaterThan(tolerance);

    // A tracker that followed the image lands inside the tolerance, even measured against
    // this instrument's own 4 px quantisation.
    const workingTrackerDisplacement = 11.4;
    expect(Math.abs(workingTrackerDisplacement - sceneMagnitude)).toBeLessThanOrEqual(tolerance);
  });

  it('shares no state with the tracker: the probe holds its own copy of the frame', () => {
    // If the probe read the tracker's retained buffer, an aliasing bug there would make both
    // "measurements" the same measurement. It copies, so overwriting the caller's array after
    // the fact cannot change what the probe remembers.
    const probe = new SceneShiftProbe();
    const frame = planeAt(0, 0);
    probe.measure(frame, W, H, 1);
    frame.set(planeAt(9, 9));
    const r = probe.measure(planeAt(2, 0), W, H, 1);
    expect(r?.dx).toBe(2);
  });
});
