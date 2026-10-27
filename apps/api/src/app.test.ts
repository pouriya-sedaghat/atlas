import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MapServiceError } from '@seyra/contracts';
import { buildApp, type AppDeps } from './app.js';
import { HealthService, type ProviderProbes } from './services/health.js';
import type { ActiveRelease } from './release.js';

const dir = mkdtempSync(join(tmpdir(), 'seyra-api-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const release: ActiveRelease = {
  schema: 'seyra.active-release/1',
  dataset_id: 'ds-test-0001',
  activated_at: '2026-10-14T00:00:00Z',
  identities: { tiles: 'seyra_ds_test_0001', routing: '1760000000', geocoder: 'seyra-release-ds-test-0001', overpass: 'label-1' },
};

const goodProbes: ProviderProbes = {
  tiles: async () => ({ identity: 'seyra_ds_test_0001' }),
  routing: async () => ({ identity: '1760000000' }),
  geocoder: async () => ({ identity: 'seyra-release-ds-test-0001' }),
  overpass: async () => ({ identity: 'label-1' }),
  controlDb: async () => undefined,
};

async function makeApp(probes: ProviderProbes, opts: { maintenance?: boolean; logs?: string[] } = {}) {
  const flag = join(dir, `maint-${Math.random()}`);
  if (opts.maintenance) writeFileSync(flag, '1');
  const health = new HealthService(release, probes, { cacheMs: 60_000, probeTimeoutMs: 1_000, maintenanceFlagFile: flag });
  await health.refresh();
  const unused = () => Promise.reject(new MapServiceError('PROVIDER_UNAVAILABLE', 'not used in this test'));
  const deps: AppDeps = {
    limits: DEFAULT_LIMITS,
    health,
    routing: { route: unused, pair: unused },
    geocoder: { search: async () => [], reverse: async () => [] },
    poi: { run: async () => [] },
    geography: { distances: async (_o, p) => p.map(() => 1) },
    logLevel: opts.logs ? 'info' : 'silent',
    ...(opts.logs
      ? {
          logStream: new Writable({
            write(chunk, _enc, cb) {
              opts.logs!.push(String(chunk));
              cb();
            },
          }),
        }
      : {}),
  };
  const app = await buildApp(deps);
  return app;
}

describe('HTTP contract', () => {
  it('rejects unknown parameters (e.g. raw QL) instead of stripping them', async () => {
    const app = await makeApp(goodProbes);
    const r = await app.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&preset=pharmacies&data=node;out;' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REQUEST');
    const r2 = await app.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&key=amenity&value=pharmacy%22%5D%3Bout%3B' });
    expect(r2.statusCode).toBe(400);
    const r3 = await app.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&key=amenity&value=reactor' });
    expect(r3.json().error.code).toBe('UNKNOWN_PRESET');
    await app.close();
  });

  it('returns typed errors for unsupported routing combinations and dataset mismatch', async () => {
    const app = await makeApp(goodProbes);
    const pts = [
      { id: 'a', lon: 51.3, lat: 35.7 },
      { id: 'b', lon: 51.4, lat: 35.7 },
      { id: 'c', lon: 51.5, lat: 35.7 },
    ];
    const multiAlt = await app.inject({ method: 'POST', url: '/api/v1/map/route', payload: { profile: 'car', objective: 'time', points: pts, alternatives: 1 } });
    expect(multiAlt.statusCode).toBe(422);
    expect(multiAlt.json().error.code).toBe('UNSUPPORTED_COMBINATION');
    const dt = await app.inject({ method: 'POST', url: '/api/v1/map/route', payload: { profile: 'car', objective: 'time', points: pts.slice(0, 2), date_time: '2026-10-14T08:00' } });
    expect(dt.json().error.code).toBe('UNSUPPORTED_COMBINATION');
    const mismatch = await app.inject({ method: 'GET', url: '/api/v1/map/search?q=x&dataset_id=ds-old-0000' });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('DATASET_MISMATCH');
    const tooLong = await app.inject({ method: 'GET', url: `/api/v1/map/search?q=${encodeURIComponent('ک'.repeat(257))}` });
    expect(tooLong.json().error.code).toBe('QUERY_TOO_LONG');
    const bigBbox = await app.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51,35,52,36&preset=fuel' });
    expect(bigBbox.json().error.code).toBe('BBOX_TOO_LARGE');
    await app.close();
  });

  it('reports no_results explicitly', async () => {
    const app = await makeApp(goodProbes);
    const r = await app.inject({ method: 'GET', url: '/api/v1/map/search?q=%D9%86%D8%A7%D9%85%D9%88%D8%AC%D9%88%D8%AF' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ result_status: 'no_results', results: [], provider: 'photon', dataset_id: 'ds-test-0001' });
    await app.close();
  });
});

describe('readiness gate (AC05)', () => {
  it('is ready only when every provider reports the active release identity', async () => {
    const app = await makeApp(goodProbes);
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('ready');
    await app.close();
  });

  it('is not ready when a provider is down or serves another revision, and gates that provider', async () => {
    const app = await makeApp({ ...goodProbes, overpass: async () => ({ identity: 'label-0' }), geocoder: async () => Promise.reject(new Error('connect ECONNREFUSED')) });
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body.status).toBe('not_ready');
    expect(body.providers.find((p: { provider: string }) => p.provider === 'overpass').status).toBe('revision_mismatch');
    expect(body.providers.find((p: { provider: string }) => p.provider === 'geocoder').status).toBe('unavailable');
    const pois = await app.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&preset=fuel' });
    expect(pois.statusCode).toBe(503);
    expect(pois.json().error.code).toBe('PROVIDER_REVISION_MISMATCH');
    await app.close();
  });

  it('missing marker (null identity) is a mismatch, never green', async () => {
    const app = await makeApp({ ...goodProbes, tiles: async () => ({ identity: null }) });
    const r = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(r.statusCode).toBe(503);
    await app.close();
  });

  it('maintenance window refuses map work and reports maintenance', async () => {
    const app = await makeApp(goodProbes, { maintenance: true });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().status).toBe('maintenance');
    const s = await app.inject({ method: 'GET', url: '/api/v1/map/search?q=abc' });
    expect(s.statusCode).toBe(503);
    expect(s.json().error.code).toBe('MAINTENANCE');
    expect(s.headers['retry-after']).toBe('5');
    await app.close();
  });
});

describe('log redaction (AC17)', () => {
  it('never writes query text, coordinates or bodies to default logs', async () => {
    const logs: string[] = [];
    const app = await makeApp(goodProbes, { logs });
    await app.inject({ method: 'GET', url: '/api/v1/map/search?q=SECRETPLACE%20%DA%A9%D9%88%D8%AB%D8%B1&bias_lon=51.123456&bias_lat=35.654321' });
    await app.inject({ method: 'POST', url: '/api/v1/map/proximity', payload: { metric: 'straight_line', direction: 'origin_to_candidate', origin: { lon: 51.987654, lat: 35.123987 }, candidates: [{ id: 'cand-secret', lon: 51.5, lat: 35.5 }] } });
    const all = logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const needle of ['SECRETPLACE', 'کوثر', '51.123456', '35.654321', '51.987654', 'cand-secret', 'bias_lon']) {
      expect(all).not.toContain(needle);
    }
    expect(all).toContain('/api/v1/map/search');
    await app.close();
  });
});
