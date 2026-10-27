import { BoundedLimiter } from './concurrency.js';
import { loadConfig } from './config.js';
import { createPool, PgGeography } from './db.js';
import { buildApp } from './app.js';
import { loadActiveRelease } from './release.js';
import { OverpassClient } from './providers/overpass.js';
import { PhotonClient } from './providers/photon.js';
import { TegolaClient } from './providers/tegola.js';
import { ValhallaClient } from './providers/valhalla.js';
import { HealthService } from './services/health.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // Fail early (before listening) when no complete active release is configured.
  const release = loadActiveRelease(config.activeReleaseFile);
  const { providerConcurrency: c, providerQueueSize: q } = config.limits;
  const limiters = {
    valhalla: new BoundedLimiter('valhalla', c, q),
    photon: new BoundedLimiter('photon', c, q),
    overpass: new BoundedLimiter('overpass', c, q),
  };
  const valhalla = new ValhallaClient(config.providers.valhalla, limiters.valhalla);
  const photon = new PhotonClient(config.providers.photon, limiters.photon);
  const overpass = new OverpassClient(config.providers.overpass, limiters.overpass);
  const tegola = new TegolaClient(config.providers.tegola);
  const pool = createPool(config.db);
  const geography = new PgGeography(pool);

  const health = new HealthService(
    release,
    {
      tiles: (map, s) => tegola.identity(map, s),
      routing: (s) => valhalla.status(s),
      geocoder: (marker, s) => photon.identity(marker, s),
      overpass: (s) => overpass.identity(s),
      controlDb: () => geography.ping(),
    },
    { cacheMs: config.healthCacheMs, probeTimeoutMs: 5_000, maintenanceFlagFile: config.maintenanceFlagFile },
  );

  const shutdown = new AbortController();
  const app = await buildApp({
    limits: config.limits,
    health,
    routing: valhalla,
    geocoder: photon,
    poi: overpass,
    geography,
    logLevel: config.logLevel,
    shutdownSignal: shutdown.signal,
    providerStats: () => Object.fromEntries(Object.entries(limiters).map(([k, l]) => [k, l.stats])),
  });
  health.start();

  let closing = false;
  const stop = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal, graceMs: config.shutdownGraceMs }, 'draining: no new requests; in-flight work gets the grace period');
    const force = setTimeout(() => {
      app.log.warn('grace period over: cancelling outstanding provider work');
      shutdown.abort();
    }, config.shutdownGraceMs);
    force.unref();
    health.stop();
    app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ dataset_id: release.dataset_id }, 'seyra map api listening');
}

main().catch((err: unknown) => {
  // Startup errors must not leak secrets: report the message only.
  console.error(`seyra-api failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
