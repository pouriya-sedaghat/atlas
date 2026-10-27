import { readFileSync } from 'node:fs';
import pg from 'pg';
import { MapServiceError } from '@seyra/contracts';
import type { GeographyDistance } from './services/proximity.js';

export interface DbSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  passwordFile: string;
}

/** Read-only control/geography access. The password comes from a secret file, never env/argv. */
export function createPool(s: DbSettings): pg.Pool {
  const password = readFileSync(s.passwordFile, 'utf8').trim();
  if (!password) throw new Error('database password file is empty');
  return new pg.Pool({
    host: s.host,
    port: s.port,
    database: s.database,
    user: s.user,
    password,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'seyra-api',
  });
}

export class PgGeography implements GeographyDistance {
  constructor(private readonly pool: pg.Pool) {}

  async distances(origin: { lon: number; lat: number }, points: { lon: number; lat: number }[], signal: AbortSignal): Promise<number[]> {
    if (signal.aborted) throw new MapServiceError('CANCELLED', 'request cancelled');
    try {
      // Parameterized arrays; ST_Distance on geography uses the WGS84 spheroid (metres).
      const res = await this.pool.query<{ ord: string; d: number }>(
        `SELECT t.ord, ST_Distance(
             ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography,
             ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography) AS d
           FROM unnest($3::float8[], $4::float8[]) WITH ORDINALITY AS t(lon, lat, ord)
          ORDER BY t.ord`,
        [origin.lon, origin.lat, points.map((p) => p.lon), points.map((p) => p.lat)],
      );
      return res.rows.map((r) => Number(r.d));
    } catch (err) {
      throw new MapServiceError('PROVIDER_ERROR', 'geography distance query failed', { provider: 'postgis', cause: err });
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1 FROM seyra_control.schema_migrations LIMIT 1');
  }
}
