/**
 * Minimal ambient declarations for the platform APIs Phase 0 probes.
 *
 * Declared locally, and only as far as they are actually used, rather than pulling in
 * `@webgpu/types` and `@types/webxr`. Phase 0's whole purpose is to find out what this
 * platform really offers, and a hand-written surface of exactly the members we touch makes
 * the dependency explicit: if a probe starts using a new member, it has to be added here
 * deliberately.
 *
 * These are types only — they assert nothing about availability at runtime, which is what
 * the probes measure.
 */

interface GPUSupportedLimits {
  readonly maxTextureDimension2D: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
}

interface GPUDevice {
  readonly limits: GPUSupportedLimits;
  destroy(): void;
}

interface GPUAdapter {
  readonly features: ReadonlySet<string> | Iterable<string>;
  requestDevice(): Promise<GPUDevice>;
}

interface GPURequestAdapterOptions {
  powerPreference?: 'low-power' | 'high-performance';
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

type XRSessionMode = 'inline' | 'immersive-vr' | 'immersive-ar';

interface XRSystem {
  isSessionSupported(mode: XRSessionMode): Promise<boolean>;
}
