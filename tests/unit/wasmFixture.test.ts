/**
 * The CAP-0006 fixture is hand-assembled bytes. If those bytes were wrong, the probe would
 * report ERROR on every device and the failure would look like a platform problem rather
 * than an authoring mistake. Compiling them here proves the fixture itself is valid.
 */

import { describe, expect, it } from 'vitest';
import { WASM_ADD_MODULE } from '../../src/capture/CapabilityDetector';

describe('WASM_ADD_MODULE fixture', () => {
  it('is a valid module of the documented size', () => {
    expect(WASM_ADD_MODULE.length).toBe(41);
    expect(Array.from(WASM_ADD_MODULE.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(WebAssembly.validate(WASM_ADD_MODULE)).toBe(true);
  });

  it('instantiates and computes add(a,b) correctly', async () => {
    const { instance } = await WebAssembly.instantiate(WASM_ADD_MODULE as BufferSource, {});
    const add = instance.exports['add'] as (a: number, b: number) => number;
    expect(typeof add).toBe('function');
    expect(add(2, 3)).toBe(5);
    expect(add(-7, 7)).toBe(0);
    expect(add(2147483647, 1)).toBe(-2147483648); // i32 wraparound, as expected
  });
});
