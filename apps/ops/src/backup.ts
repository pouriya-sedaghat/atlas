import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, relative } from 'node:path';
import { readPointers, type Pointers } from './activate.js';
import { composeRuntime } from './compose.js';
import { initDatabase, psql, waitForDb } from './db.js';
import { layout, managedChild, validateSettings, writeAtomic, DEFAULT_SETTINGS, type Settings } from './layout.js';
import { readManifest, sha256File, type Manifest } from './manifest.js';
import { run } from './proc.js';

/** Secret files that must be restored (from the operator's separate secret backup) before `init`. */
export const REQUIRED_SECRETS = ['db_admin_password', 'db_render_import_password', 'db_api_password', 'tile_db_password'];

/**
 * Backup generations (review R5). Each `backup` writes one generation into a hidden staging
 * directory `.seyra-backup-<stamp>-<id>.partial`, writes `backup-manifest.json` (every file with
 * its role, size and SHA-256, plus the backed-up pointers and release/source identities) last,
 * fsyncs, and only then publishes the directory by renaming it to `seyra-backup-<stamp>-<id>`.
 * A published generation is therefore complete by construction; an interrupted backup leaves at
 * most a `.partial` directory, which restore never reads. Restore uses exactly one generation.
 */
export const BACKUP_SCHEMA = 'seyra.backup/1';
const COMPLETION = 'backup-manifest.json';
const GENERATION = /^seyra-backup-\d{8}T\d{9}Z-[0-9a-f]{6}$/;
const PARTIAL = /^\.seyra-backup-.+\.partial$/;
const LEGACY = /^(seyra_app-.+\.sql|state-.+\.tar\.gz|manifests-.+\.tar\.gz)$/;
const FIXED = { 'control-db': 'seyra_app.sql', state: 'state.tar.gz', manifests: 'manifests.tar.gz' } as const;

type FileRole = keyof typeof FIXED | 'source' | 'source-meta';
interface BackupFile {
  path: string;
  role: FileRole;
  size: number;
  sha256: string;
}
interface BackupRelease {
  role: 'active' | 'previous';
  dataset_id: string;
  source_filename: string;
  source_sha256: string;
  snapshot_timestamp: string | null;
  snapshot_timestamp_source: string;
  /** Path of the included managed source inside the generation, when `--include-sources`. */
  source_file: string | null;
}
export interface BackupManifest {
  schema: typeof BACKUP_SCHEMA;
  generation: string;
  created_at: string;
  pointers: Pointers;
  include_sources: boolean;
  releases: BackupRelease[];
  files: BackupFile[];
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function fsyncPath(p: string): void {
  const fd = openSync(p, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))]));
}

function roleOf(path: string): FileRole | null {
  for (const [role, name] of Object.entries(FIXED)) if (path === name) return role as FileRole;
  if (/^sources\/[a-z0-9][a-z0-9-]{2,79}\.osm\.pbf$/.test(path)) return 'source';
  if (/^sources\/[a-z0-9][a-z0-9-]{2,79}\.json$/.test(path)) return 'source-meta';
  return null;
}

/** A plain-format pg_dump that ran to completion (header and completion trailer present). */
function assertCompleteDump(sql: string, where: string): void {
  if (!sql.startsWith('--\n-- PostgreSQL database dump') || !sql.includes('\n-- PostgreSQL database dump complete\n')) {
    throw new Error(`${where} is not a complete pg_dump output (header or completion trailer missing)`);
  }
}

/**
 * Control database dump + state/manifests archives (+ the managed input of the active and previous
 * releases with `includeSources`) as one generation under `out`. Map stores are not backed up:
 * they are rebuilt from the original OSM input and the locked images. Secrets and TLS keys are
 * never included. Returns the published generation directory.
 */
export async function backup(out: string, opts: { includeSources: boolean; log: (m: string) => void }): Promise<string> {
  const l = layout();
  if (!out.startsWith('/')) throw new Error('--out must be absolute');
  mkdirSync(out, { recursive: true, mode: 0o750 });
  const now = new Date();
  const generation = `seyra-backup-${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
  const staging = join(out, `.${generation}.partial`);
  mkdirSync(staging, { mode: 0o750 });
  try {
    const pointers = readPointers(l);
    const dump = (await composeRuntime(l, ['exec', '-T', 'db', 'pg_dump', '-U', 'seyra_admin', '-d', 'seyra_app', '--no-owner'], { discardStdout: false })).stdout;
    assertCompleteDump(dump, 'pg_dump of seyra_app');
    writeFileSync(join(staging, FIXED['control-db']), dump, { mode: 0o600 });
    await run('tar', ['-C', l.home, '-czf', join(staging, FIXED.state), 'state']);
    const manifests = readdirSync(l.releases).filter((n) => existsSync(join(l.releases, n, 'manifest.json')));
    await run('tar', ['-C', l.releases, '-czf', join(staging, FIXED.manifests), ...(manifests.length ? manifests.map((n) => `${n}/manifest.json`) : ['-T', '/dev/null'])]);
    const releases: BackupRelease[] = [];
    for (const [role, id] of [['active', pointers.active], ['previous', pointers.previous]] as const) {
      if (!id) continue;
      const m = readManifest(managedChild(l.releases, id));
      let sourceFile: string | null = null;
      if (opts.includeSources) {
        mkdirSync(join(staging, 'sources'), { recursive: true, mode: 0o750 });
        sourceFile = `sources/${id}.osm.pbf`;
        copyFileSync(m.source.managed_copy, join(staging, sourceFile));
        const copied = await sha256File(join(staging, sourceFile));
        if (copied !== m.source.sha256) throw new Error(`the managed source of ${id} does not match its release manifest (sha256 ${copied}, expected ${m.source.sha256})`);
        writeFileSync(join(staging, 'sources', `${id}.json`), `${JSON.stringify({ dataset_id: id, sha256: m.source.sha256, snapshot_timestamp: m.source.snapshot_timestamp, original_filename: m.source.filename }, null, 2)}\n`);
        opts.log(`[backup] included managed source of ${id} (${m.source.size_bytes} bytes)`);
      }
      releases.push({
        role,
        dataset_id: id,
        source_filename: m.source.filename,
        source_sha256: m.source.sha256,
        snapshot_timestamp: m.source.snapshot_timestamp,
        snapshot_timestamp_source: m.source.snapshot_timestamp_source,
        source_file: sourceFile,
      });
    }
    const files: BackupFile[] = [];
    for (const path of walk(staging).sort()) {
      const role = roleOf(path);
      if (!role) throw new Error(`unexpected file in backup staging: ${path}`);
      files.push({ path, role, size: statSync(join(staging, path)).size, sha256: await sha256File(join(staging, path)) });
    }
    const manifest: BackupManifest = { schema: BACKUP_SCHEMA, generation, created_at: now.toISOString(), pointers, include_sources: opts.includeSources, releases, files };
    for (const f of files) fsyncPath(join(staging, f.path));
    // Completion record last, then publish the whole generation atomically.
    writeFileSync(join(staging, COMPLETION), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
    fsyncPath(join(staging, COMPLETION));
    if (opts.includeSources) fsyncPath(join(staging, 'sources'));
    fsyncPath(staging);
    renameSync(staging, join(out, generation));
    fsyncPath(out);
    opts.log(`[backup] published generation ${join(out, generation)} (${files.length} files, sha256-listed in ${COMPLETION}; secrets and TLS keys are NOT included; back them up separately)`);
    return join(out, generation);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true }); // a killed backup leaves it; restore ignores it
    throw err;
  }
}

/**
 * Choose exactly one published generation: `from` itself when it is a generation directory, the
 * one named by `requested`, or else the newest one under `from`. Nothing is combined across
 * generations; incomplete attempts and older-layout files are reported, never used.
 */
function selectGeneration(from: string, requested: string | undefined, log: (m: string) => void): { dir: string; name: string } {
  if (existsSync(join(from, COMPLETION))) {
    const name = basename(from);
    if (requested && requested !== name) throw new Error(`--from ${from} is generation ${name}, not ${requested}`);
    log(`[restore] selected backup generation ${name} (given directly)`);
    return { dir: from, name };
  }
  const entries = readdirSync(from, { withFileTypes: true });
  const complete = entries.filter((e) => e.isDirectory() && GENERATION.test(e.name)).map((e) => e.name).sort();
  const partial = entries.filter((e) => PARTIAL.test(e.name)).map((e) => e.name).sort();
  const legacy = entries.filter((e) => e.isFile() && LEGACY.test(e.name)).map((e) => e.name).sort();
  for (const p of partial) log(`[restore] ignoring incomplete backup attempt ${p} (never published: the backup was interrupted)`);
  if (complete.length === 0) {
    if (legacy.length) {
      throw new Error(
        `${from} holds files in the older backup layout (${legacy.join(', ')}) and no complete backup generation. That layout has no completion record, ` +
          'so these files cannot be proven to belong to one complete backup and are not restored. Take a new backup with `seyra-maps backup`.',
      );
    }
    throw new Error(`${from} contains no complete backup generation (seyra-backup-*/${COMPLETION})`);
  }
  if (legacy.length) log(`[restore] ignoring ${legacy.length} file(s) in the older backup layout in ${from}`);
  if (requested) {
    if (!complete.includes(requested)) throw new Error(`backup generation ${requested} is not a complete generation in ${from}; available: ${complete.join(', ')}`);
    log(`[restore] selected backup generation ${requested} (requested with --generation)`);
    return { dir: join(from, requested), name: requested };
  }
  const name = complete.at(-1)!;
  log(
    complete.length === 1
      ? `[restore] selected backup generation ${name} (the only complete generation in ${from})`
      : `[restore] selected backup generation ${name} (newest of ${complete.length} complete generations in ${from}; others: ${complete.slice(0, -1).join(', ')}; use --generation NAME to choose another)`,
  );
  return { dir: join(from, name), name };
}

interface Verified {
  manifest: BackupManifest;
  sql: string;
  settings: Settings | null;
  history: Buffer | null;
  manifestsDir: string;
}

/** Validate the whole generation before anything is changed; throws on the first problem. */
async function verifyGeneration(dir: string, name: string, tmp: string): Promise<Verified> {
  const bad = (m: string): never => {
    throw new Error(`backup generation ${name} is not usable: ${m}`);
  };
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, COMPLETION), 'utf8')) as BackupManifest;
  } catch (err) {
    return bad(`${COMPLETION} is missing or unreadable (${(err as Error).message})`);
  }
  if (manifest.schema !== BACKUP_SCHEMA) bad(`${COMPLETION} schema is ${String(manifest.schema)}, expected ${BACKUP_SCHEMA}`);
  if (manifest.generation !== name) bad(`${COMPLETION} names generation ${manifest.generation}`);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.releases) || typeof manifest.include_sources !== 'boolean') bad(`${COMPLETION} is malformed`);
  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (typeof f.path !== 'string' || normalize(f.path) !== f.path || f.path.startsWith('/') || f.path.startsWith('..') || roleOf(f.path) !== f.role) bad(`unexpected file entry ${JSON.stringify(f.path)}`);
    listed.add(f.path);
    const p = join(dir, f.path);
    if (!existsSync(p)) bad(`${f.path} is missing`);
    if (statSync(p).size !== f.size) bad(`${f.path} has ${statSync(p).size} bytes, expected ${f.size}`);
    if ((await sha256File(p)) !== f.sha256) bad(`${f.path} does not match its recorded SHA-256 (corrupted or modified)`);
  }
  for (const role of Object.keys(FIXED) as (keyof typeof FIXED)[]) {
    if (manifest.files.filter((f) => f.role === role).length !== 1) bad(`it must contain exactly one ${role} file`);
  }
  const unlisted = walk(dir).filter((p) => p !== COMPLETION && !listed.has(p));
  if (unlisted.length) bad(`unlisted files present: ${unlisted.join(', ')}`);

  // Control database dump: re-hash the exact bytes that will be replayed.
  const sqlBytes = readFileSync(join(dir, FIXED['control-db']));
  if (sha256(sqlBytes) !== manifest.files.find((f) => f.role === 'control-db')!.sha256) bad('the SQL dump changed while being read');
  const sql = sqlBytes.toString('utf8');
  assertCompleteDump(sql, `${name}/${FIXED['control-db']}`);

  // Operator state: settings must satisfy the access rules; pointers must match the record.
  const stateDir = join(tmp, 'state-archive');
  mkdirSync(stateDir);
  await run('tar', ['-C', stateDir, '-xzf', join(dir, FIXED.state)]);
  const settingsFile = join(stateDir, 'state', 'settings.json');
  const settings = existsSync(settingsFile) ? { ...DEFAULT_SETTINGS, ...(JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<Settings>) } : null;
  if (settings) validateSettings(settings);
  const pointersFile = join(stateDir, 'state', 'pointers.json');
  const pointers = existsSync(pointersFile) ? (JSON.parse(readFileSync(pointersFile, 'utf8')) as Pointers) : { active: null, previous: null };
  if ((pointers.active ?? null) !== (manifest.pointers?.active ?? null) || (pointers.previous ?? null) !== (manifest.pointers?.previous ?? null)) bad('the state archive pointers differ from the completion record');
  const historyFile = join(stateDir, 'state', 'history.jsonl');

  // Release manifests and (when included) sources must describe the backed-up releases.
  const manifestsDir = join(tmp, 'manifests-archive');
  mkdirSync(manifestsDir);
  await run('tar', ['-C', manifestsDir, '-xzf', join(dir, FIXED.manifests)]);
  const expected = [['active', manifest.pointers.active], ['previous', manifest.pointers.previous]].filter(([, id]) => id) as [string, string][];
  if (manifest.releases.length !== expected.length || expected.some(([role, id]) => !manifest.releases.some((r) => r.role === role && r.dataset_id === id))) bad('the release list differs from the backed-up pointers');
  for (const r of manifest.releases) {
    const mf = join(manifestsDir, r.dataset_id, 'manifest.json');
    if (!existsSync(mf)) bad(`the manifest archive has no manifest for ${r.dataset_id}`);
    const m = JSON.parse(readFileSync(mf, 'utf8')) as Manifest;
    if (m.dataset_id !== r.dataset_id || m.source?.sha256 !== r.source_sha256) bad(`the archived manifest of ${r.dataset_id} does not match the completion record`);
    if (manifest.include_sources) {
      const f = manifest.files.find((x) => x.path === r.source_file && x.role === 'source');
      if (!f) bad(`the included source of ${r.dataset_id} is not listed`);
      if (f!.sha256 !== r.source_sha256) bad(`the included source of ${r.dataset_id} is not the release's input (sha256 ${f!.sha256}, expected ${r.source_sha256})`);
    } else if (r.source_file !== null) bad(`${r.dataset_id} names a source file although sources were not included`);
  }
  return { manifest, sql, settings, history: existsSync(historyFile) ? readFileSync(historyFile) : null, manifestsDir };
}

/**
 * Fresh-host restore of the control database and operator state from one backup generation.
 * Order (RUNBOOK §7): bundle installed, the separately backed-up `secrets/` restored, `init` run
 * (so the database roles carry the restored passwords), then `restore`. The generation is selected
 * and fully verified first; only then is the initialised control database replaced by the dump
 * (no replay over an existing schema), grants and pending migrations re-applied, and settings and
 * history restored. Release pointers are NOT restored: the map stores do not exist yet; the command
 * prints the re-import commands that rebuild the backed-up releases with their original dataset
 * ids, after which `activate` completes the restore.
 */
export async function restore(from: string, log: (m: string) => void, opts: { generation?: string } = {}): Promise<void> {
  const l = layout();
  if (!from.startsWith('/') || !existsSync(from)) throw new Error('--from must be an existing absolute directory');
  if (readPointers(l).active) throw new Error('restore is for a fresh installation: a release is already active here');
  for (const s of REQUIRED_SECRETS) {
    if (!existsSync(join(l.secrets, s))) throw new Error(`secret ${s} is missing: restore the secrets backup into ${l.secrets} and run init first`);
  }
  const gen = selectGeneration(from, opts.generation, log);
  mkdirSync(l.work, { recursive: true });
  const tmp = mkdtempSync(join(l.work, '.restore-'));
  try {
    const v = await verifyGeneration(gen.dir, gen.name, tmp);
    log(`[restore] generation ${gen.name} (created ${v.manifest.created_at}) verified: ${v.manifest.files.length} files match their SHA-256; complete SQL dump; settings valid`);

    // Control database: replace the freshly initialised one with the dump.
    await composeRuntime(l, ['up', '-d', 'db']);
    await waitForDb(l);
    await composeRuntime(l, ['stop', 'api'], { allowFailure: true });
    await psql(l, 'postgres', 'DROP DATABASE IF EXISTS seyra_app WITH (FORCE);');
    await psql(l, 'postgres', 'CREATE DATABASE seyra_app OWNER seyra_admin;');
    await psql(l, 'seyra_app', v.sql);
    const applied = await initDatabase(l);
    const events = (await psql(l, 'seyra_app', 'SELECT count(*) FROM seyra_control.release_events;')).trim();
    log(`[restore] control database restored from ${gen.name}/${FIXED['control-db']} (${events} release events); grants re-applied; migrations applied now: ${applied.length ? applied.join(', ') : 'none'}`);

    // Operator state: settings and history; pointers only reported.
    if (v.settings) writeAtomic(l.settingsFile, `${JSON.stringify(v.settings, null, 2)}\n`);
    if (v.history) {
      writeFileSync(l.historyFile, v.history, { mode: 0o640 });
      writeFileSync(l.historyFile, `${JSON.stringify({ at: new Date().toISOString(), event: 'restored', generation: gen.name })}\n`, { flag: 'a' });
    }
    const restoredDir = join(l.state, 'restored');
    rmSync(restoredDir, { recursive: true, force: true });
    cpSync(v.manifestsDir, restoredDir, { recursive: true });
    for (const r of v.manifest.releases) {
      const ts = r.snapshot_timestamp_source === 'operator' && r.snapshot_timestamp ? ` --snapshot-timestamp ${r.snapshot_timestamp}` : '';
      log(
        `[restore] backed-up ${r.role} release ${r.dataset_id}: source ${r.source_filename} sha256 ${r.source_sha256}` +
          (r.source_file
            ? `; rebuild with: seyra-maps import --pbf ${join(gen.dir, r.source_file)}${ts}`
            : `; rebuild it from the owner's original input with that sha256: seyra-maps import --pbf /path/to/input.osm.pbf${ts}`),
      );
    }
    log('[restore] then activate the rebuilt active release (seyra-maps activate DATASET_ID); identical inputs and images reproduce the same dataset id');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
