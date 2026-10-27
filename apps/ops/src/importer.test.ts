import { describe, expect, it } from 'vitest';
import { tomlFloats } from './importer.js';

describe('tomlFloats', () => {
  it('writes integral values as TOML floats (Tegola rejects integer bounds such as a 0 longitude)', () => {
    expect(tomlFloats([0, 0, 0.095, 0.095])).toBe('[0.0, 0.0, 0.095, 0.095]');
    expect(tomlFloats([0.0475, 0.0475, 11])).toBe('[0.0475, 0.0475, 11.0]');
    expect(tomlFloats([-180, -85, 180, 85])).toBe('[-180.0, -85.0, 180.0, 85.0]');
  });
});
