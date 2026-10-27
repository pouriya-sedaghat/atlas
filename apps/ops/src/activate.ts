import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRuntimeEnvSafe, composeRuntime, parseEnv, runtimeEnv, writeRuntimeEnv, NO_RELEASE } from './compose.js';
import { importLeaseState, recoverInterrupted } from './import-lock.js';
import { readOwner, withLifecycleLock } from './lifecycle-lock.js';
import { psql, recordEvent, renderDbName } from './db.js';
import { layout, managedChild, readSettings, writeAtomic, type Layout } from './layout.js';
import { lockedImages, verifyImages } from './lock.js';
import { PHOTON_OPENSEARCH_SETTINGS } from './photon-config.js';
import { DATA_COMPONENT_ROLES, readManifest, sha256File, sha256Text, treeDigest, type Manifest } from './manifest.js';

export interface Pointers {
  active: string | null;
  previous: string | null;
}

export function readPointers(l: Layout): Pointers {
  if (!existsSync(l.pointersFile)) return { active: null, previous: null };
  return JSON.parse(readFileSync(l.pointersFile, 'utf8')) as Pointers;
}

function writePointers(l: Layout, p: Pointers): void {
  writeAtomic(l.pointersFile, `${JSON.stringify(p, null, 2)}\n`);
}

function history(l: Layout, entry: Record<string, unknown>): void {
  writeFileSync(l.historyFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { flag: 'a', mode: 0o640 });
}

/** Re-verify a staged release before it may become active (managed checksums + frozen DB). */
export async function verifyRelease(l: Layout, datasetId: string): Promise<{ manifest: Manifest; problems: string[] }> {
  const dir = managedChild(l.releases, datasetId);
  const m = readManifest(dir);
  const problems: string[] = [];
  if (m.status !== 'validated') problems.push(`release status is ${m.status}`);
  if (!m.identities) problems.push('release has no recorded provider identities');
  // The stores are only servable by the exact data-component images that built them.
  const locked = new Map(lockedImages(l.install).map((i) => [i.role, i.image_id]));
  for (const role of DATA_COMPONENT_ROLES) {
    const built = m.components[role]?.image_id;
    if (!built || built !== locked.get(role)) problems.push(`release was built with ${role} ${built ?? 'unknown'}, locked image is ${locked.get(role) ?? 'unknown'}; re-import required`);
  }
  const art = m.artifacts as Record<string, Record<string, unknown>>;
  const routing = await treeDigest(join(dir, 'valhalla'));
  if (routing.sha256 !== art.routing?.sha256) problems.push('routing graph checksum mismatch');
  const overpass = await treeDigest(join(dir, 'overpass', 'db'));
  if (overpass.sha256 !== art.overpass?.sha256) problems.push('overpass base checksum mismatch');
  const maps = await treeDigest(join(dir, 'maps'));
  if (maps.sha256 !== art.maps?.sha256) problems.push('map styles checksum mismatch');
  const importFile = join(dir, 'geocoder', 'photon-import.jsonl');
  if (!existsSync(importFile) || (await sha256File(importFile)) !== art.geocoder?.import_sha256) problems.push('geocoder import checksum mismatch');
  if (!existsSync(join(dir, 'photon', 'photon_data'))) problems.push('photon index missing');
  const photonConf = join(dir, 'photon', 'photon_data', 'node_1', 'config', 'opensearch.yml');
  const conf = existsSync(photonConf) ? readFileSync(photonConf, 'utf8') : '';
  if (!PHOTON_OPENSEARCH_SETTINGS.every((line) => conf.includes(line))) {
    problems.push('photon index lacks the absolute disk watermarks (built by an older pipeline); re-import required');
  }
  const tegola = readFileSync(join(dir, 'tegola', 'tegola.toml'), 'utf8');
  if (sha256Text(tegola) !== art.render?.tegola_config_sha256) problems.push('tegola configuration checksum mismatch');
  if ((await sha256File(m.source.managed_copy)) !== m.source.sha256) problems.push('managed source copy checksum mismatch');
  try {
    const marker = (await psql(l, renderDbName(datasetId), 'SELECT dataset_id FROM render.seyra_release;')).trim();
    if (marker !== datasetId) problems.push(`render database marker is ${marker || 'missing'}`);
  } catch (err) {
    problems.push(`render database unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { manifest: m, problems };
}

interface ApiHealth {
  dataset_id: string | null;
  providers: { provider: string; status: string; observed_identity: string | null }[];
  dependencies: { name: string; status: string }[];
}

/** Probe the API's real provider checks from inside its container (no host port needed). */
export async function apiHealth(l: Layout): Promise<ApiHealth | null> {
  const script =
    "fetch('http://127.0.0.1:3000/api/v1/map/health').then(r=>r.text()).then(t=>{process.stdout.write(t)},()=>process.exit(3))";
  const r = await composeRuntime(l, ['exec', '-T', 'api', 'node', '-e', script], { allowFailure: true });
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as ApiHealth;
  } catch {
    return null;
  }
}

/** Same-revision readiness: every provider ok with the expected dataset (maintenance flag ignored). */
async function waitSameRevision(l: Layout, datasetId: string, timeoutS: number, pollMs: number, log: (m: string) => void): Promise<{ ok: boolean; last: ApiHealth | null }> {
  const deadline = Date.now() + timeoutS * 1000;
  let last: ApiHealth | null = null;
  while (Date.now() < deadline) {
    last = await apiHealth(l);
    if (last && last.dataset_id === datasetId && last.providers.length === 4 && last.providers.every((p) => p.status === 'ok') && last.dependencies.every((d) => d.status === 'ok')) {
      return { ok: true, last };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  log(`[activate] readiness not reached: ${JSON.stringify(last?.providers ?? null)}`);
  return { ok: false, last };
}

function releaseDescriptor(m: Manifest): string {
  return `${JSON.stringify({ schema: 'seyra.active-release/1', dataset_id: m.dataset_id, activated_at: new Date().toISOString(), identities: m.identities }, null, 2)}\n`;
}

/**
 * Bring up the complete stack from the current runtime.env (validated at the runtime boundary) and
 * confirm the ingress is really published. Docker can start a container whose host-port bind failed
 * earlier as "running" without that port, and `compose up` then leaves it alone (lifecycle L8). Such
 * a proxy is recreated once; an ingress that is still not published is an error, never "ready".
 */
export async function startStack(l: Layout, log: (m: string) => void): Promise<void> {
  assertRuntimeEnvSafe(l);
  await composeRuntime(l, ['up', '-d', '--remove-orphans']);
  await assertIngressPublished(l, log);
}

/** Expected publications: the ordinary listener and, with a relay, the relay listener. */
function expectedPublications(env: Record<string, string>): { port: string; want: string }[] {
  const out = [{ port: '8443', want: `${env.SEYRA_BIND_ADDR}:${env.SEYRA_HTTPS_PORT}` }];
  if (env.SEYRA_RELAY_PEER) out.push({ port: '8444', want: `${env.SEYRA_RELAY_BIND_ADDR}:${env.SEYRA_RELAY_PORT}` });
  return out;
}

export async function assertIngressPublished(l: Layout, log: (m: string) => void): Promise<void> {
  const env = parseEnv(readFileSync(l.runtimeEnv, 'utf8'));
  const check = async () => {
    const res = [];
    for (const p of expectedPublications(env)) {
      const r = await composeRuntime(l, ['port', 'proxy', p.port], { allowFailure: true });
      res.push({ ...p, ok: r.code === 0 && r.stdout.trim() === p.want, got: (r.stdout.trim() || r.stderr.trim()) || 'nothing' });
    }
    return res;
  };
  const first = await check();
  if (first.every((r) => r.ok)) return;
  log(`[ingress] the proxy is running without ${first.filter((r) => !r.ok).map((r) => `${r.want} (docker reports: ${r.got})`).join(', ')} published; recreating it`);
  await composeRuntime(l, ['up', '-d', '--no-deps', '--force-recreate', 'proxy']);
  const again = await check();
  const bad = again.filter((r) => !r.ok);
  if (bad.length) throw new Error(`the proxy does not publish ${bad.map((r) => `${r.want} (docker reports: ${r.got})`).join(', ')}`);
}

/**
 * Recreate only the proxy (after a certificate replacement or a relay/access change applied to
 * runtime.env), then confirm every expected publication. Providers and the API keep running.
 */
export async function restartProxy(l: Layout, log: (m: string) => void): Promise<void> {
  assertRuntimeEnvSafe(l);
  await composeRuntime(l, ['up', '-d', '--no-deps', '--force-recreate', 'proxy']);
  await assertIngressPublished(l, log);
  log('[ingress] proxy recreated with the current HTTP access configuration');
}

/**
 * Regenerate runtime.env from the persisted settings for the ACTIVE release (no dataset change).
 * `init` persists access settings but runtime.env is otherwise only rewritten by an activation, so
 * an access/relay change on a running install needs this explicit step. The previous file is kept
 * as runtime.env.prev; nothing is restarted here.
 */
export function applyAccess(l: Layout, log: (m: string) => void): { changed: string[] } {
  if (readTransition(l)) throw new Error('an activation/rollback did not finish; run: seyra-maps recover');
  const pointers = readPointers(l);
  if (!pointers.active) throw new Error('no active release; access settings are applied by the first activation');
  const s = readSettings(l);
  const next = runtimeEnv(l, s, lockedImages(l.install), pointers.active); // validates the settings
  const prev = existsSync(l.runtimeEnv) ? parseEnv(readFileSync(l.runtimeEnv, 'utf8')) : {};
  const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((k) => (prev[k] ?? '') !== (next[k] ?? '')).sort();
  if (!changed.length) {
    log('[access] runtime.env already matches the persisted settings');
    return { changed };
  }
  const allowed = /^SEYRA_(ACCESS_MODE|BIND_ADDR|HTTPS_PORT|LAN_ALLOW_CIDRS|SERVER_NAMES|RELAY_[A-Z_]+)$/;
  const other = changed.filter((k) => !allowed.test(k));
  if (other.length) throw new Error(`runtime.env differs beyond access settings (${other.join(', ')}); use the regular activation path`);
  if (existsSync(l.runtimeEnv)) writeAtomic(`${l.runtimeEnv}.prev`, readFileSync(l.runtimeEnv, 'utf8'), 0o640);
  writeRuntimeEnv(l, next);
  log(`[access] runtime.env updated (${changed.join(', ')}); previous kept as runtime.env.prev. Apply with: seyra-maps proxy restart`);
  return { changed };
}

// ------------------------------------------------------------------------------------------------
// Transition journal (review R2). An activation/rollback is not atomic across services; instead the
// configuration in force before it is backed up and the transition is journalled BEFORE anything
// changes. Every failure after maintenance begins (command, filesystem, probe or not-ready) runs
// the same recovery; if recovery itself fails, maintenance stays on and the journal + backup are
// kept so `seyra-maps recover` can finish the job (also after the process itself was killed).
// ------------------------------------------------------------------------------------------------

export interface Transition {
  schema: 'seyra.transition/1';
  op: 'activate' | 'rollback';
  from: string | null;
  to: string;
  started_at: string;
  phase: 'started' | 'switched' | 'committed';
}

export function readTransition(l: Layout): Transition | null {
  if (!existsSync(l.transitionFile)) return null;
  return JSON.parse(readFileSync(l.transitionFile, 'utf8')) as Transition;
}

function writeTransition(l: Layout, t: Transition): void {
  writeAtomic(l.transitionFile, `${JSON.stringify(t, null, 2)}\n`, 0o640);
}

const BACKED_UP = (l: Layout) => [
  { live: l.runtimeEnv, saved: join(l.transitionDir, 'runtime.env') },
  { live: join(l.active, 'release.json'), saved: join(l.transitionDir, 'release.json') },
];

function backupConfig(l: Layout): void {
  rmSync(l.transitionDir, { recursive: true, force: true });
  mkdirSync(l.transitionDir, { recursive: true, mode: 0o750 });
  for (const f of BACKED_UP(l)) if (existsSync(f.live)) copyFileSync(f.live, f.saved);
}

/** Put back exactly the configuration that was in force before the transition. */
function restoreConfig(l: Layout): void {
  for (const f of BACKED_UP(l)) {
    if (existsSync(f.saved)) {
      const tmp = `${f.live}.restore-${process.pid}`;
      copyFileSync(f.saved, tmp);
      renameSync(tmp, f.live);
    } else {
      rmSync(f.live, { force: true });
    }
  }
}

function finishTransition(l: Layout): void {
  rmSync(l.transitionFile, { force: true });
  rmSync(l.transitionDir, { recursive: true, force: true });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ActivateOptions {
  log: (m: string) => void;
  reason?: 'activate' | 'rollback';
  /** Overrides settings.readinessTimeoutS (tests). */
  readinessTimeoutS?: number;
  pollMs?: number;
}

/** Restore the pre-transition configuration and wait until `from` serves again; throws if not. */
async function restorePrevious(l: Layout, from: string, timeoutS: number, pollMs: number, log: (m: string) => void): Promise<void> {
  await composeRuntime(l, ['stop', '-t', '40', 'api'], { allowFailure: true });
  restoreConfig(l);
  await startStack(l, log);
  await composeRuntime(l, ['restart', 'api'], { allowFailure: true });
  const restored = await waitSameRevision(l, from, timeoutS, pollMs, log);
  if (!restored.ok) throw new Error(`previous release ${from} did not become ready: ${JSON.stringify(restored.last?.providers ?? null)}`);
}

export async function activate(datasetId: string, opts: ActivateOptions): Promise<void> {
  const l = layout();
  await withLifecycleLock(l, opts.reason ?? 'activate', datasetId, () => activateLocked(l, datasetId, opts));
}

async function activateLocked(l: Layout, datasetId: string, opts: ActivateOptions): Promise<void> {
  if (readTransition(l)) throw new Error('an earlier activation/rollback did not finish; run: seyra-maps recover');
  const s = readSettings(l);
  const timeoutS = opts.readinessTimeoutS ?? s.readinessTimeoutS;
  const pollMs = opts.pollMs ?? 3000;
  const images = lockedImages(l.install);
  const bad = (await verifyImages(images)).filter((c) => !c.ok);
  if (bad.length) throw new Error(`images missing or not matching the lock: ${bad.map((b) => b.ref).join(', ')}`);
  const { manifest, problems } = await verifyRelease(l, datasetId);
  if (problems.length) throw new Error(`release ${datasetId} cannot be activated: ${problems.join('; ')}`);
  const env = runtimeEnv(l, s, images, datasetId); // validates the settings before anything changes

  const pointers = readPointers(l);
  const prior = pointers.active;
  const op = opts.reason ?? 'activate';
  const maintenance = join(l.flags, 'maintenance');
  // Durable record first: backup of the current configuration, then the journal.
  backupConfig(l);
  const t: Transition = { schema: 'seyra.transition/1', op, from: prior, to: datasetId, started_at: new Date().toISOString(), phase: 'started' };
  writeTransition(l, t);
  opts.log(`[activate] ${prior ?? '(none)'} -> ${datasetId}: entering maintenance window`);
  writeFileSync(maintenance, `${datasetId}\n`);
  history(l, { event: 'activation_started', dataset_id: datasetId, from: prior });
  await recordEvent(l, datasetId, 'activation_started', { from: prior }).catch(() => undefined);

  try {
    // Drain: API stops admitting work (maintenance) and gets its grace period on SIGTERM.
    await composeRuntime(l, ['stop', '-t', '40', 'api'], { allowFailure: true });
    await composeRuntime(l, ['stop', '-t', '20', 'proxy', 'tegola', 'valhalla', 'photon', 'overpass'], { allowFailure: true });
    writeRuntimeEnv(l, env);
    writeAtomic(join(l.active, 'release.json'), releaseDescriptor(manifest));
    t.phase = 'switched';
    writeTransition(l, t);
    // Discard only the managed, dataset-keyed tile cache.
    for (const entry of readdirSync(join(l.cache, 'tiles'))) rmSync(join(l.cache, 'tiles', entry), { recursive: true, force: true });
    await startStack(l, opts.log);
    const result = await waitSameRevision(l, datasetId, timeoutS, pollMs, opts.log);
    if (!result.ok) throw new Error(`providers did not report ${datasetId} within ${timeoutS} s: ${JSON.stringify(result.last?.providers ?? null)}`);
  } catch (cause) {
    history(l, { event: 'activation_failed', dataset_id: datasetId, error: errText(cause) });
    await recordEvent(l, datasetId, 'activation_failed', { error: errText(cause) }).catch(() => undefined);
    if (!prior) {
      throw new Error(`activation of ${datasetId} failed (${errText(cause)}) and there is no previous release to restore; the platform stays in maintenance (not ready). Fix the cause, then run: seyra-maps recover`);
    }
    opts.log(`[activate] activation failed (${errText(cause)}); restoring ${prior}`);
    try {
      await restorePrevious(l, prior, timeoutS, pollMs, opts.log);
    } catch (recoveryError) {
      history(l, { event: 'recovery_failed', dataset_id: prior, error: errText(recoveryError) });
      throw new Error(
        `activation of ${datasetId} failed (${errText(cause)}) AND restoring ${prior} failed (${errText(recoveryError)}); the platform stays in maintenance. The journal ${l.transitionFile} and the backed-up configuration in ${l.transitionDir} are kept. Fix the cause, then run: seyra-maps recover`,
      );
    }
    rmSync(maintenance, { force: true });
    finishTransition(l);
    history(l, { event: 'recovered', dataset_id: prior });
    await recordEvent(l, prior, 'recovered', { failed: datasetId }).catch(() => undefined);
    throw new Error(`activation of ${datasetId} failed (${errText(cause)}); previous release ${prior} restored and ready`);
  }

  // Commit: pointers first (a crash after this is finalised by `recover`), then clear the journal.
  writePointers(l, op === 'rollback' ? { active: datasetId, previous: prior } : { active: datasetId, previous: prior ?? pointers.previous });
  t.phase = 'committed';
  writeTransition(l, t);
  rmSync(maintenance, { force: true });
  finishTransition(l);
  history(l, { event: op === 'rollback' ? 'rollback' : 'activated', dataset_id: datasetId, from: prior });
  await recordEvent(l, datasetId, op === 'rollback' ? 'rollback' : 'activated', { from: prior }).catch(() => undefined);
  opts.log(`[activate] ${datasetId} is active; all four providers report its identities`);
}

/**
 * Finish an interrupted or failed transition: finalise it when its pointers were already
 * committed, otherwise restore and verify the release that was active before it.
 */
export async function recover(opts: ActivateOptions): Promise<void> {
  const l = layout();
  await withLifecycleLock(l, 'recover', null, async () => {
    const t = readTransition(l);
    const maintenance = join(l.flags, 'maintenance');
    if (!t) {
      opts.log(`[recover] no unfinished transition${existsSync(maintenance) ? '; note: the maintenance flag is set' : ''}`);
      return;
    }
    const s = readSettings(l);
    const timeoutS = opts.readinessTimeoutS ?? s.readinessTimeoutS;
    const pollMs = opts.pollMs ?? 3000;
    const p = readPointers(l);
    if (p.active === t.to) {
      opts.log(`[recover] ${t.op} to ${t.to} was committed; finishing it`);
      await startStack(l, opts.log);
      const r = await waitSameRevision(l, t.to, timeoutS, pollMs, opts.log);
      if (!r.ok) throw new Error(`${t.to} is committed but not ready; maintenance stays on (${JSON.stringify(r.last?.providers ?? null)})`);
    } else if (t.from) {
      opts.log(`[recover] restoring ${t.from} (the ${t.op} to ${t.to} did not complete)`);
      await restorePrevious(l, t.from, timeoutS, pollMs, opts.log);
      history(l, { event: 'recovered', dataset_id: t.from });
      await recordEvent(l, t.from, 'recovered', { failed: t.to }).catch(() => undefined);
    } else {
      // A first activation never completed: put back the pre-activation configuration; nothing is
      // active, so the platform stays not ready until a release is activated.
      restoreConfig(l);
      finishTransition(l);
      opts.log('[recover] first activation did not complete; no release is active (run: seyra-maps activate DATASET_ID)');
      return;
    }
    rmSync(maintenance, { force: true });
    finishTransition(l);
    opts.log('[recover] done; the active release is ready');
  });
}

export async function rollback(log: (m: string) => void): Promise<void> {
  const l = layout();
  await withLifecycleLock(l, 'rollback', null, async () => {
    const p = readPointers(l);
    if (!p.previous) throw new Error('no previous release recorded');
    await activate(p.previous, { log, reason: 'rollback' });
  });
}

/**
 * Retain active + previous; remove other managed releases and their render databases. Runs under
 * the lifecycle lock (so no activation is in flight) and never touches what a running import is
 * building (review R3). An abandoned import is recovered first (its jobs stopped, release failed).
 */
export async function prune(log: (m: string) => void): Promise<string[]> {
  const l = layout();
  return withLifecycleLock(l, 'prune', null, async () => {
    if (readTransition(l)) throw new Error('an unfinished activation/rollback exists; run: seyra-maps recover');
    const p = readPointers(l);
    const keep = new Set([p.active, p.previous].filter((x): x is string => !!x));
    let lease = await importLeaseState(l); // throws when liveness cannot be determined: prune nothing
    if (lease.state === 'stale') {
      const stale = lease.owner;
      log(`[prune] the import started ${stale.started_at} is no longer running; recovering it first`);
      await recoverInterrupted(l, log);
      if (readOwner(l.importLock)?.token === stale.token) rmSync(l.importLock, { force: true });
      lease = await importLeaseState(l);
    }
    const liveImport = lease.state === 'live' ? lease.owner : null;
    const removed: string[] = [];
    for (const name of readdirSync(l.releases)) {
      if (keep.has(name) || name === NO_RELEASE) continue;
      const dir = managedChild(l.releases, name);
      if (!existsSync(join(dir, 'manifest.json'))) {
        log(`[prune] skipping ${name}: not a managed release (no manifest)`);
        continue;
      }
      const status = readManifest(dir).status;
      if (liveImport && (name === liveImport.target || status === 'building')) {
        log(`[prune] skipping ${name}: being built by the running import (started ${liveImport.started_at})`);
        continue;
      }
      if (status === 'building') {
        log(`[prune] skipping ${name}: still marked building without an import lease; run seyra-maps import to recover it`);
        continue;
      }
      await psql(l, 'postgres', `DROP DATABASE IF EXISTS ${renderDbName(name)} WITH (FORCE);`);
      rmSync(dir, { recursive: true, force: true });
      const work = join(l.work, name);
      if (existsSync(work)) rmSync(managedChild(l.work, name), { recursive: true, force: true });
      await recordEvent(l, name, 'pruned', {}).catch(() => undefined);
      removed.push(name);
      log(`[prune] removed release ${name}`);
    }
    return removed;
  });
}
