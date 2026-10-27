import { describe, expect, it } from 'vitest';
import { assertReleaseId, DEFAULT_RELEASE_POLICY as p, sessionExpiry, validateEndpoints, validatePolicy, type ReleasePolicy } from './policy.js';

describe('release policy boundaries', () => {
  it('caps renewal at absolute expiry and keeps active sessions distinct from retention count', () => {
    expect(sessionExpiry(0, 23.9*3600_000, p)).toBe(24*3600_000);
    expect(sessionExpiry(0, 1_000, p)).toBe(1_000+30*60_000);
    expect(p.keepLatest).toBe(3);
  });
  it('rejects disabling retention, fractional durations and unbounded request lifetimes', () => {
    for (const override of [{keepLatest:1},{idleSessionMs:1.2},{requestLeaseMs:3600_000},{absoluteSessionMs:1}]) {
      expect(() => validatePolicy({...p,...override})).toThrow();
    }
    const {keepLatest: _missing,...incomplete} = p;
    expect(() => validatePolicy(incomplete as ReleasePolicy)).toThrow();
  });
  it('does not permit paths, credentials or query parameters in endpoint origins', () => {
    const endpoints = {api:'http://api-r1:3000',tiles:'http://tiles-r1:3000',routing:'http://routing-r1:8002',geocoder:'http://geocoder-r1:2322',overpass:'http://poi-r1:8080'};
    expect(() => validateEndpoints(endpoints)).not.toThrow();
    for (const api of ['file:///tmp/a','http://user:secret@host/','http://host/route','http://host/?target=x']) {
      expect(() => validateEndpoints({...endpoints,api})).toThrow();
    }
    expect(() => assertReleaseId('../other')).toThrow();
  });
});
