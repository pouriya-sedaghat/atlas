import { readFileSync } from 'node:fs';
import { DEFAULT_LIMITS, tightenLimits, type MapLimits } from '@seyra/contracts';

/**
 * Runtime configuration. Provider base URLs are deployment configuration on private networks;
 * they are never derived from client input. Secrets are read from files, never from argv/env.
 */
export interface ApiConfig {
  host: string;
  port: number;
  logLevel: string;
  activeReleaseFile: string;
  providers: {
    valhalla: string;
    photon: string;
    overpass: string;
    tegola: string;
  };
  db: {
    host: string;
    port: number;
    database: string;
    user: string;
    passwordFile: string;
  };
  limits: MapLimits;
  healthCacheMs: number;
  maintenanceFlagFile: string;
  shutdownGraceMs: number;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required environment variable ${name}`);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function privateUrl(name: string, fallback: string): string {
  const value = env(name, fallback);
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  if (url.username || url.password) throw new Error(`${name} must not embed credentials`);
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(): ApiConfig {
  let limits = DEFAULT_LIMITS;
  const limitsFile = process.env.SEYRA_LIMITS_FILE;
  if (limitsFile) {
    const override = JSON.parse(readFileSync(limitsFile, 'utf8')) as Partial<MapLimits>;
    limits = tightenLimits(DEFAULT_LIMITS, override);
  }
  return {
    host: env('SEYRA_API_HOST', '0.0.0.0'),
    port: intEnv('SEYRA_API_PORT', 3000),
    logLevel: env('SEYRA_LOG_LEVEL', 'info'),
    activeReleaseFile: env('SEYRA_ACTIVE_RELEASE_FILE', '/srv/seyra/active/release.json'),
    providers: {
      valhalla: privateUrl('SEYRA_VALHALLA_URL', 'http://valhalla:8002'),
      photon: privateUrl('SEYRA_PHOTON_URL', 'http://photon:2322'),
      overpass: privateUrl('SEYRA_OVERPASS_URL', 'http://overpass:8080'),
      tegola: privateUrl('SEYRA_TEGOLA_URL', 'http://tegola:8080'),
    },
    db: {
      host: env('SEYRA_DB_HOST', 'db'),
      port: intEnv('SEYRA_DB_PORT', 5432),
      database: env('SEYRA_DB_NAME', 'seyra_app'),
      user: env('SEYRA_DB_USER', 'seyra_api'),
      passwordFile: env('SEYRA_DB_PASSWORD_FILE', '/run/secrets/seyra_api_db_password'),
    },
    limits,
    healthCacheMs: intEnv('SEYRA_HEALTH_CACHE_MS', 5_000),
    maintenanceFlagFile: env('SEYRA_MAINTENANCE_FILE', '/srv/seyra/state/maintenance'),
    shutdownGraceMs: intEnv('SEYRA_SHUTDOWN_GRACE_MS', 30_000),
  };
}
