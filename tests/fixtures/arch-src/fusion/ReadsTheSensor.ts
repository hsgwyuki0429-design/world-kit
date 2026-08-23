/**
 * The Phase 7 half of the architecture fixture.
 *
 * A filter that can reach the capture layer can read the gyroscope stream before the harness
 * has added the bias IMU-005 scores it on finding. The audit has to reject this.
 */
import { RotationRateMonitor } from '../capture/RotationRateMonitor';
export const z = RotationRateMonitor;
