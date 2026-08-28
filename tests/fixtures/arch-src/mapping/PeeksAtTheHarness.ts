/**
 * The Phase 8 half of the architecture fixture.
 *
 * A selector that can reach the tracking layer can see the population it is deciding about and
 * the metronome it is being scored against — KEY-002's whole point is that the two selectors are
 * told nothing about each other. The audit has to reject this.
 */
import { FlowTracker } from '../tracking/FlowTracker';
export const z = FlowTracker;
