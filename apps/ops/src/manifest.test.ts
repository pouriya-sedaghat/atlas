import { describe, expect, it } from 'vitest';
import { DATA_COMPONENT_ROLES, dataComponents, deriveDatasetId } from './manifest.js';

const ids = (over: Record<string, string> = {}) => ({
  DB: 'sha256:db',
  OSMTOOLS: 'sha256:osm',
  VALHALLA: 'sha256:val',
  GEOCODER_BUILD: 'sha256:geo',
  PHOTON: 'sha256:pho',
  OVERPASS: 'sha256:ovp',
  TEGOLA: 'sha256:teg',
  API: 'sha256:api',
  PROXY: 'sha256:proxy',
  OPS: 'sha256:ops',
  ...over,
});
const derive = (components: Record<string, string>, extra: Partial<{ s: string; p: string; a: string }> = {}) =>
  deriveDatasetId('2026-10-01T00:00:00Z', { source_sha256: extra.s ?? 'src', pipeline_fingerprint: extra.p ?? 'pipe', components: dataComponents(components), assets_sha256: extra.a ?? 'assets' });

describe('deriveDatasetId', () => {
  it('is stable for the same inputs and carries the snapshot date', () => {
    expect(derive(ids())).toBe(derive(ids()));
    expect(derive(ids())).toMatch(/^ds-20261001-[0-9a-f]{12}$/);
  });

  it('does not change when only serving-layer images (API, proxy, ops) change', () => {
    expect(derive(ids({ API: 'sha256:api2', PROXY: 'sha256:proxy2', OPS: 'sha256:ops2' }))).toBe(derive(ids()));
  });

  it.each(DATA_COMPONENT_ROLES)('changes when the %s data component changes', (role) => {
    expect(derive(ids({ [role]: 'sha256:other' }))).not.toBe(derive(ids()));
  });

  it('changes with the source, pipeline or asset digest', () => {
    const base = derive(ids());
    expect(derive(ids(), { s: 'src2' })).not.toBe(base);
    expect(derive(ids(), { p: 'pipe2' })).not.toBe(base);
    expect(derive(ids(), { a: 'assets2' })).not.toBe(base);
  });
});
