/**
 * The spatial leg presses controls by id and checks their labels character for character. Its
 * copy of those labels (a plain .mjs script) is pinned here to the screen's own constants.
 */

import { describe, expect, it } from 'vitest';

import { SPATIAL_PHASE_NAMES, SPATIAL_START } from '../../src/ui/SpatialScreens';
// @ts-expect-error — a plain .mjs module with no type declarations.
import { SPATIAL_LABELS } from '../../scripts/lib/spatialLabels.mjs';

describe('spatial leg labels', () => {
  it('match what the screens render, for every phase 11–21', () => {
    for (let n = 11; n <= 21; n++) {
      const leg = (SPATIAL_LABELS as Record<number, { name: string; start: string; idle: string; busy: string }>)[n];
      const screen = SPATIAL_START[n];
      expect(leg).toBeDefined();
      expect(screen).toBeDefined();
      expect(leg?.name).toBe(SPATIAL_PHASE_NAMES[n]);
      expect(leg?.start).toBe(`#${screen?.id}`);
      expect(leg?.idle).toBe(screen?.idle);
      expect(leg?.busy).toBe(screen?.busy);
    }
  });
});
