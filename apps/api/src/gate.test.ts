// Desired-behaviour regression tests for review finding R4: an operation may use a provider only
// while that provider's served identity was verified recently. Unit level (HealthService) and HTTP
// level (real Fastify app, provider adapters as spies that must not be called on rejection).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS, MapServiceError } from '@seyra/contracts';
import { buildApp, type AppDeps } from './app.js';
import type { ActiveRelease } from './release.js';
import { HealthService, type HealthOptions, type ProviderProbes } from './services/health.js';

const dir = mkdtempSync(join(tmpdir(), 'seyra-gate-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const release: ActiveRelease = {
  schema: 'seyra.active-release/1',
  dataset_id: 'ds-test-0001',
  activated_at: '2026-10-14T00:00:00Z',
  identities: { tiles: 'seyra_ds_test_0001', routing: '1760000000', geocoder: 'seyra-release-ds-test-0001', overpass: 'label-1' },
};

type Mode = 'ok' | 'down' | 'hang' | 'mismatch';
interface Ctl {
  mode: Mode;
  calls: number;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A controllable real-shaped probe; 'hang' waits until the probe's own timeout aborts it. */
function probe(ctl: Ctl, identity: string) {
  return (signal: AbortSignal): Promise<{ identity: string | null }> => {
    ctl.calls++;
    switch (ctl.mode) {
      case 'ok':
        return Promise.resolve({ identity });
      case 'mismatch':
        return Promise.resolve({ identity: 'another-revision' });
      case 'down':
        return Promise.reject(new Error('provider is unreachable'));
      case 'hang':
        return new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('probe timed out')), { once: true }));
    }
  };
}

function setup(modes: Partial<Record<'tiles' | 'routing' | 'geocoder' | 'overpass', Mode>> = {}, opts: Partial<HealthOptions> = {}) {
  const c = {
    tiles: { mode: modes.tiles ?? 'ok', calls: 0 } as Ctl,
    routing: { mode: modes.routing ?? 'ok', calls: 0 } as Ctl,
    geocoder: { mode: modes.geocoder ?? 'ok', calls: 0 } as Ctl,
    overpass: { mode: modes.overpass ?? 'ok', calls: 0 } as Ctl,
  };
  const probes: ProviderProbes = {
    tiles: (_m, s) => probe(c.tiles, release.identities.tiles)(s),
    routing: (s) => probe(c.routing, release.identities.routing)(s),
    geocoder: (_m, s) => probe(c.geocoder, release.identities.geocoder)(s),
    overpass: (s) => probe(c.overpass, release.identities.overpass)(s),
    controlDb: async () => undefined,
  };
  const health = new HealthService(release, probes, {
    cacheMs: 60_000,
    probeTimeoutMs: 300,
    gateWaitMs: 100,
    maxVerifiedAgeMs: 60_000,
    retryFailedAfterMs: 0,
    maintenanceFlagFile: join(dir, `absent-${Math.random()}`),
    ...opts,
  });
  return { c, health };
}

const code = (p: Promise<unknown>) => p.then(() => 'admitted', (e: MapServiceError) => e.code);

describe('provider gate (review R4)', () => {
  it('does not admit before the first verification when the provider cannot be verified in time', async () => {
    const { c, health } = setup({ routing: 'hang' });
    const t0 = Date.now();
    expect(await code(health.gate('routing'))).toBe('PROVIDER_UNAVAILABLE');
    expect(Date.now() - t0).toBeLessThan(1_000); // bounded wait, not the provider's whole outage
    expect(c.routing.calls).toBe(1);
  });

  it('verifies on demand before the first background probe and then admits', async () => {
    const { c, health } = setup();
    expect(await code(health.gate('routing'))).toBe('admitted');
    expect(c.routing.calls).toBe(1); // only the requested provider was probed
    expect(c.overpass.calls).toBe(0);
  });

  it('rejects when the target provider is unavailable (reviewed case) and when it serves another revision', async () => {
    const down = setup({ routing: 'down' });
    await down.health.refresh();
    expect((await down.health.readiness()).providers.find((p) => p.provider === 'routing')?.status).toBe('unavailable');
    expect(await code(down.health.gate('routing'))).toBe('PROVIDER_UNAVAILABLE');
    const other = setup({ geocoder: 'mismatch' });
    await other.health.refresh();
    expect(await code(other.health.gate('geocoder'))).toBe('PROVIDER_REVISION_MISMATCH');
  });

  it('does not admit on a stale verification', async () => {
    const { c, health } = setup({}, { maxVerifiedAgeMs: 40 });
    await health.refresh();
    expect(await code(health.gate('routing'))).toBe('admitted');
    c.routing.mode = 'hang';
    await sleep(60); // the last successful verification is now too old
    expect(await code(health.gate('routing'))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('recovers once the provider verifies again', async () => {
    const { c, health } = setup({ routing: 'down' });
    await health.refresh();
    expect(await code(health.gate('routing'))).toBe('PROVIDER_UNAVAILABLE');
    c.routing.mode = 'ok';
    expect(await code(health.gate('routing'))).toBe('admitted');
  });

  it('keeps a healthy provider usable during an unrelated provider outage', async () => {
    const { health } = setup({ overpass: 'hang' });
    const readiness = health.refresh(); // overpass probe pending until its timeout
    const t0 = Date.now();
    expect(await code(health.gate('routing'))).toBe('admitted');
    expect(Date.now() - t0).toBeLessThan(100);
    expect(await code(health.gate('overpass'))).toBe('PROVIDER_UNAVAILABLE');
    expect((await readiness).status).toBe('not_ready'); // readiness stays honest
  });
});

describe('HTTP admission (review R4)', () => {
  const routeResult = {
    primary: { distance_m: 1000, duration_s: 60, legs: [{ distance_m: 1000, duration_s: 60 }], coordinates: [[51.3, 35.7], [51.4, 35.7]] as [number, number][] },
    alternates: [],
  };
  async function app(health: HealthService) {
    const route = vi.fn(async () => routeResult);
    const pair = vi.fn(async () => ({ kind: 'route' as const, distance_m: 1, duration_s: 1 }));
    const run = vi.fn(async () => []);
    const search = vi.fn(async () => []);
    const deps: AppDeps = {
      limits: DEFAULT_LIMITS,
      health,
      routing: { route, pair },
      geocoder: { search, reverse: search },
      poi: { run },
      geography: { distances: async (_o, p) => p.map(() => 1) },
      logLevel: 'silent',
    };
    return { server: await buildApp(deps), route, pair, run, search };
  }
  const body = { profile: 'car', objective: 'time', points: [{ id: 'a', lon: 51.3, lat: 35.7 }, { id: 'b', lon: 51.4, lat: 35.7 }] };

  it('answers 503 without calling the adapter when routing is unverified at startup or unavailable', async () => {
    const { health } = setup({ routing: 'hang' }); // no background probe has run yet
    const a = await app(health);
    const r = await a.server.inject({ method: 'POST', url: '/api/v1/map/route', payload: body });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(a.route).not.toHaveBeenCalled();
    const prox = await a.server.inject({ method: 'POST', url: '/api/v1/map/proximity', payload: { metric: 'road_distance', direction: 'origin_to_candidate', profile: 'car', origin: { lon: 51.3, lat: 35.7 }, candidates: [{ id: 'x', lon: 51.4, lat: 35.7 }] } });
    expect(prox.statusCode).toBe(503);
    expect(a.pair).not.toHaveBeenCalled();
    await a.server.close();
  });

  it('answers 503 PROVIDER_REVISION_MISMATCH without calling the geocoder', async () => {
    const { health } = setup({ geocoder: 'mismatch' });
    const a = await app(health);
    const r = await a.server.inject({ method: 'GET', url: '/api/v1/map/search?q=test' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('PROVIDER_REVISION_MISMATCH');
    expect(a.search).not.toHaveBeenCalled();
    await a.server.close();
  });

  it('serves routing during an Overpass outage while refusing POIs, then recovers POIs', async () => {
    const { c, health } = setup({ overpass: 'down' });
    await health.refresh();
    const a = await app(health);
    const ok = await a.server.inject({ method: 'POST', url: '/api/v1/map/route', payload: body });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().dataset_id).toBe('ds-test-0001');
    expect(a.route).toHaveBeenCalledTimes(1);
    const pois = await a.server.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&preset=pharmacies' });
    expect(pois.statusCode).toBe(503);
    expect(a.run).not.toHaveBeenCalled();
    c.overpass.mode = 'ok';
    const back = await a.server.inject({ method: 'GET', url: '/api/v1/map/pois?bbox=51.3,35.6,51.31,35.61&preset=pharmacies' });
    expect(back.statusCode).toBe(200);
    expect(a.run).toHaveBeenCalledTimes(1);
    await a.server.close();
  });
});
