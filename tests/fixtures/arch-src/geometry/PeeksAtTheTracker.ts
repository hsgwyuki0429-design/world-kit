/**
 * The Phase 5 half of the architecture fixture.
 *
 * A two-view solver that reaches into `tracking` can see the population it is being scored
 * against — which is exactly what GEO-003 assumes it cannot. The audit has to reject this.
 */
import { FlowTracker } from '../tracking/FlowTracker';
export const y = FlowTracker;
