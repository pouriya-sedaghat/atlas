import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOBS_PROJECT } from './compose.js';
import { recordEvent } from './db.js';
import { managedChild, type Layout } from './layout.js';
import { newOwner, ownerAlive, readOwner, releaseOwned, tryCreate, withLifecycleLock, type LockOwner } from './lifecycle-lock.js';
import { readManifest, writeManifest } from './manifest.js';
import { run } from './proc.js';

export type ImportLease = { state: 'none' } | { state: 'live' | 'stale'; owner: LockOwner };

/** State of the import lease; throws when it cannot be judged (callers must then not touch builds). */
export async function importLeaseState(l: Layout): Promise<ImportLease> {
  if (!existsSync(l.importLock)) return { state: 'none' };
  const owner = readOwner(l.importLock);
  if (!owner) throw new Error(`import lease ${l.importLock} is unreadable; remove it only if no import process exists`);
  return { state: (await ownerAlive(owner)) ? 'live' : 'stale', owner };
}

/**
 * Clean up after an import whose process ended without finishing (killed, host restart):
 * stop its still-running build/staging job containers and mark its release failed. The active
 * release is never touched; the failed release is removed later by `prune`.
 */
export async function recoverInterrupted(l: Layout, log: (m: string) => void): Promise<void> {
  const jobs = await run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${JOBS_PROJECT}`]);
  const ids = jobs.stdout.split('\n').filter(Boolean);
  if (ids.length) {
    log(`[import] stopping ${ids.length} orphaned job container(s) of the interrupted import`);
    await run('docker', ['stop', '-t', '10', ...ids], { allowFailure: true });
  }
  if (!existsSync(l.releases)) return;
  for (const name of readdirSync(l.releases)) {
    const dir = join(l.releases, name);
    if (!existsSync(join(dir, 'manifest.json'))) continue;
    const m = readManifest(managedChild(l.releases, name));
    if (m.status !== 'building') continue;
    m.status = 'failed';
    m.failure = { step: 'interrupted', message: 'the import process ended before the release was complete' };
    writeManifest(dir, m);
    rmSync(managedChild(l.work, name), { recursive: true, force: true });
    await recordEvent(l, m.dataset_id, 'import_failed', { step: 'interrupted' }).catch(() => undefined);
    log(`[import] marked interrupted release ${name} as failed (remove it with: seyra-maps prune)`);
  }
}

/**
 * Exclusive import lease. A lease whose owner is positively gone is recovered under the lifecycle
 * lock (so a concurrent prune/activation never sees a half-recovered state); a live owner is never
 * recovered. Returns the owner record to pass to setImportTarget/releaseImportLock.
 */
export async function acquireImportLock(l: Layout, log: (m: string) => void): Promise<LockOwner> {
  const owner = newOwner('import', null);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(l.importLock, owner)) return owner;
    const lease = await importLeaseState(l);
    if (lease.state === 'live') throw new Error(`another import is running (started ${lease.owner.started_at}${lease.owner.target ? `, building ${lease.owner.target}` : ''})`);
    if (lease.state === 'stale') {
      log(`[import] the import started ${lease.owner.started_at} is no longer running; recovering`);
      await withLifecycleLock(
        l,
        'import-recovery',
        lease.owner.target,
        async () => {
          if (readOwner(l.importLock)?.token !== lease.owner.token) return; // someone else recovered it
          await recoverInterrupted(l, log);
          rmSync(l.importLock, { force: true });
        },
        { waitMs: 15 * 60_000 },
      );
    }
  }
  throw new Error('could not acquire the import lock');
}

/** Record the dataset an import is building, so prune can protect it by name. */
export function setImportTarget(l: Layout, owner: LockOwner, datasetId: string): void {
  owner.target = datasetId;
  if (readOwner(l.importLock)?.token === owner.token) writeFileSync(l.importLock, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

export function releaseImportLock(l: Layout, owner: LockOwner): void {
  releaseOwned(l.importLock, owner);
}
