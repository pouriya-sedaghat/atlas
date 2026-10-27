import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Layout } from './layout.js';
import { composeRuntime } from './compose.js';

/**
 * Admin SQL through the db container's local socket (`docker compose exec`), SQL on stdin.
 * Secrets in SQL never appear on a command line.
 */
export async function psql(l: Layout, database: string, sql: string, vars: Record<string, string> = {}): Promise<string> {
  const args = ['exec', '-T', 'db', 'psql', '-X', '-q', '-At', '-U', 'seyra_admin', '-d', database, '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(k) || /[\n\r]/.test(v)) throw new Error('invalid psql variable');
    args.push('-v', `${k}=${v}`);
  }
  const r = await composeRuntime(l, args, { input: sql });
  return r.stdout;
}

export function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function sqlIdent(v: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(v)) throw new Error(`unsafe identifier ${v}`);
  return `"${v}"`;
}

export function renderDbName(datasetId: string): string {
  return sqlIdentName(`render_${datasetId.replace(/-/g, '_')}`);
}
function sqlIdentName(v: string): string {
  sqlIdent(v);
  return v;
}

export async function waitForDb(l: Layout, timeoutS = 120): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    // TCP readiness: the image's first-start initialisation server listens on the socket only and
    // shuts down again, so a socket check alone can succeed too early.
    const r = await composeRuntime(l, ['exec', '-T', 'db', 'pg_isready', '-h', '127.0.0.1', '-U', 'seyra_admin', '-d', 'seyra_app'], { allowFailure: true });
    if (r.code === 0) return;
    if (Date.now() > deadline) throw new Error('database did not become ready');
    await new Promise((res) => setTimeout(res, 2000));
  }
}

/** Roles (passwords from secret files) and control-schema migrations. Idempotent. */
export async function initDatabase(l: Layout): Promise<string[]> {
  const pw = (name: string) => readFileSync(join(l.secrets, name), 'utf8').trim();
  const roleSql = (role: string, secret: string) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', ${sqlLiteral(role)});
  END IF;
  EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', ${sqlLiteral(role)}, ${sqlLiteral(pw(secret))});
END $$;`;
  await psql(
    l,
    'seyra_app',
    [
      roleSql('seyra_api', 'db_api_password'),
      roleSql('seyra_render_import', 'db_render_import_password'),
      roleSql('seyra_tile_reader', 'tile_db_password'),
      'REVOKE ALL ON DATABASE seyra_app FROM PUBLIC;',
      'GRANT CONNECT ON DATABASE seyra_app TO seyra_api;',
    ].join('\n'),
  );
  const applied: string[] = [];
  const dir = join(l.install, 'apps', 'ops', 'migrations');
  await psql(l, 'seyra_app', 'CREATE SCHEMA IF NOT EXISTS seyra_control; CREATE TABLE IF NOT EXISTS seyra_control.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());');
  const done = new Set((await psql(l, 'seyra_app', 'SELECT version FROM seyra_control.schema_migrations;')).split('\n').filter(Boolean));
  for (const file of readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await psql(l, 'seyra_app', `BEGIN;\n${sql}\nINSERT INTO seyra_control.schema_migrations (version) VALUES (${sqlLiteral(version)});\nCOMMIT;`);
    applied.push(version);
  }
  return applied;
}

export async function recordEvent(l: Layout, datasetId: string, event: string, detail: Record<string, unknown>): Promise<void> {
  await psql(
    l,
    'seyra_app',
    `INSERT INTO seyra_control.release_events (dataset_id, event, detail) VALUES (${sqlLiteral(datasetId)}, ${sqlLiteral(event)}, ${sqlLiteral(JSON.stringify(detail))}::jsonb);`,
  );
}
