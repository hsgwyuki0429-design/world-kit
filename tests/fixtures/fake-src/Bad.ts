// Fixture for the audit test. Every line below is a pattern the audit must reject.
export function makePose() {
  return { x: Math.random(), y: Math.random(), z: 0 };
}
export const FIXED_FLOOR = { normal: [0, 1, 0], d: 0 };
export function bump(state: { coverage: number; confidence: number }, elapsed: number) {
  state.coverage += 1;
  state.confidence = elapsed * 0.01;
}
