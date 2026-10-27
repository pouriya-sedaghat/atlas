import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, tightenLimits } from './limits.js';
import { bboxAreaKm2, parseBbox } from './geo.js';

describe('tightenLimits', () => {
  it('allows tightening', () => {
    expect(tightenLimits(DEFAULT_LIMITS, { orderedMaxPoints: 10 }).orderedMaxPoints).toBe(10);
  });
  it('refuses raising caps or disabling', () => {
    expect(() => tightenLimits(DEFAULT_LIMITS, { optimizedMaxPoints: 12 })).toThrow();
    expect(() => tightenLimits(DEFAULT_LIMITS, { poiMaxResults: 0 })).toThrow();
    expect(() => tightenLimits(DEFAULT_LIMITS, { bogus: 1 } as never)).toThrow();
  });
});

describe('bbox helpers', () => {
  it('parses and rejects inverted boxes', () => {
    expect(parseBbox('51.3,35.6,51.4,35.7')).toEqual([51.3, 35.6, 51.4, 35.7]);
    expect(parseBbox('51.4,35.6,51.3,35.7')).toBeNull();
    expect(parseBbox('a,b,c,d')).toBeNull();
  });
  it('computes spherical rectangle area', () => {
    const a = bboxAreaKm2([0, 0, 0.1, 0.1]);
    expect(a).toBeGreaterThan(123);
    expect(a).toBeLessThan(124);
  });
});
