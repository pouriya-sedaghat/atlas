import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_LIMITS, MapServiceError } from '@seyra/contracts';
import { buildApp } from './app.js';
import { HealthService } from './services/health.js';

/**
 * Generate the OpenAPI document from the registered route schemas. Providers are not
 * contacted: the document generator never serves traffic.
 */
async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? 'openapi.json');
  const unavailable = () => Promise.reject(new MapServiceError('PROVIDER_UNAVAILABLE', 'documentation build'));
  const health = new HealthService(
    {
      schema: 'seyra.active-release/1',
      dataset_id: 'ds-openapi-document',
      activated_at: new Date(0).toISOString(),
      identities: { tiles: 'n/a', routing: 'n/a', geocoder: 'n/a', overpass: 'n/a' },
    },
    { tiles: unavailable, routing: unavailable, geocoder: unavailable, overpass: unavailable, controlDb: unavailable },
    { cacheMs: 60_000, probeTimeoutMs: 10, maintenanceFlagFile: '/nonexistent' },
  );
  const app = await buildApp({
    limits: DEFAULT_LIMITS,
    health,
    routing: { route: unavailable, pair: unavailable },
    geocoder: { search: unavailable, reverse: unavailable },
    poi: { run: unavailable },
    geography: { distances: unavailable },
    logLevel: 'silent',
  });
  await app.ready();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
  await app.close();
  console.log(`wrote ${out}`);
}

void main();
