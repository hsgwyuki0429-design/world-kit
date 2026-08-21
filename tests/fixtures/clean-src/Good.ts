import { Rng } from '../../../src/core/Rng';
export function sample(rng: Rng, n: number, pop: number) {
  return rng.sampleDistinct(n, pop);
}
