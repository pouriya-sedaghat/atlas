import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { Layout } from './layout.js';
import { run } from './proc.js';

/**
 * Lifecycle exclusion (review R3 and its follow-up).
 *
 * - `state/lifecycle.lock` — one global lock for every mutating command (activate, rollback,
 *   recover, prune, start, stop, init, backup, restore and the set-up phase of an import).
 *   Exclusion is a kernel flock(2) on this file, held through an open file description of the
 *   running command. The kernel drops it when that process (or its ops container) ends, however
 *   it ends, so a crashed owner never has to be "reclaimed": there is no read-then-unlink step two
 *   recovering commands could interleave on. The file is never unlinked; its content is only the
 *   current owner record (diagnostics). A record still present when the lock is acquired was left
 *   by a command that ended without releasing it; with an unfinished transition only `recover`
 *   may then proceed. Conflicting commands fail fast (or wait a bounded time) with the owner's
 *   description; nested calls in the same async chain are re-entrant.
 * - `state/import.lock` — the long-running import lease (see import-lock.ts). It names its target
 *   dataset once known; prune never touches that target or any `building` release while it lives.
 *   A lease is only ever removed while holding the lifecycle lock.
 *
 * SEYRA_HOME must be on a local Linux filesystem that enforces flock between open file
 * descriptions; every acquisition verifies that and refuses to run otherwise.
 */
export interface LockOwner {
  pid: number;
  /** Host name of the owner; inside the wrapper-started ops container this is the container id. */
  host: string;
  op: string;
  target: string | null;
  started_at: string;
  /** Random token so a process only ever removes its own lock. */
  token: string;
}

export class LifecycleBusyError extends Error {
  constructor(readonly owner: LockOwner | null) {
    super(
      owner
        ? `another lifecycle operation is running: ${owner.op}${owner.target ? ` ${owner.target}` : ''} (started ${owner.started_at}); retry when it has finished`
        : 'another lifecycle operation is running (it has not recorded itself yet); retry when it has finished',
    );
  }
}

export function readOwner(path: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    return typeof o.pid === 'number' && typeof o.host === 'string' && typeof o.started_at === 'string' && typeof o.op === 'string' && typeof o.token === 'string'
      ? ({ target: null, ...o } as LockOwner)
      : null;
  } catch {
    return null;
  }
}

/** Import lease owner: true = alive, false = positively gone. Throws when liveness cannot be determined. */
export async function ownerAlive(o: LockOwner): Promise<boolean> {
  if (o.host === hostname()) {
    try {
      process.kill(o.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  // Another (wrapper-started) ops container: alive while that container is running.
  const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', o.host], { allowFailure: true });
  if (r.code === 0) return r.stdout.trim() === 'true';
  if (/no such (object|container)/i.test(r.stderr)) return false;
  throw new Error(`cannot determine whether lock owner ${o.host} is alive (${r.stderr.trim().split('\n').pop() ?? 'docker inspect failed'}); not touching its lock`);
}

export function newOwner(op: string, target: string | null): LockOwner {
  return { pid: process.pid, host: hostname(), op, target, started_at: new Date().toISOString(), token: `${process.pid}-${Math.random().toString(36).slice(2)}` };
}

/** Create a lease file exclusively; false when it already exists. */
export function tryCreate(path: string, owner: LockOwner): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  writeFileSync(fd, `${JSON.stringify(owner)}\n`);
  closeSync(fd);
  return true;
}

/** Remove a lease only if it still carries our token. */
export function releaseOwned(path: string, owner: LockOwner): void {
  if (readOwner(path)?.token === owner.token) rmSync(path, { force: true });
}

// Re-entrancy is scoped to the async call chain that holds the lock (e.g. rollback -> activate),
// so a concurrent call in the same process still sees the lock as busy.
const holder = new AsyncLocalStorage<LockOwner>();

export function lifecycleLockHeld(): LockOwner | null {
  return holder.getStore() ?? null;
}

const BUSY = 75;
/** Fail-fast callers still retry this long, so a momentary `status` probe never makes them fail. */
const PROBE_GRACE_MS = 200;

/**
 * Try to take an exclusive flock on the open file description `fd` without blocking. util-linux
 * `flock` locks the descriptor it inherits as fd 3, which is the same open file description as
 * ours, so the lock stays held by this process after that helper exits and is released when `fd`
 * is closed or this process ends.
 */
function tryFlock(fd: number, path: string): boolean {
  const r = spawnSync('flock', ['-n', '-x', '-E', String(BUSY), '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
  if (r.error) throw new Error(`cannot run flock (util-linux) for ${path}: ${r.error.message}`);
  if (r.status === 0) return true;
  if (r.status === BUSY) return false;
  throw new Error(`flock on ${path} failed (exit ${r.status}): ${r.stderr.toString().trim()}`);
}

/** A second, independent open of the file must now be refused; otherwise the lock is not enforced here. */
function assertEnforced(path: string): void {
  const r = spawnSync('flock', ['-n', '-x', '-E', String(BUSY), path, 'true'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== BUSY) {
    throw new Error(`file locking is not enforced on the filesystem of ${path}; SEYRA_HOME must be on a local Linux filesystem (flock(2))`);
  }
}

function writeRecord(fd: number, owner: LockOwner | null): void {
  ftruncateSync(fd, 0);
  if (owner) writeSync(fd, `${JSON.stringify(owner)}\n`, 0);
}

/**
 * Run `fn` holding the global lifecycle lock. `waitMs` > 0 polls for a live owner to finish
 * instead of failing immediately. A record left by an owner that ended without releasing the lock
 * is replaced, except that an unfinished activation transition must be handled by `recover`.
 */
export async function withLifecycleLock<T>(l: Pick<Layout, 'lifecycleLock' | 'transitionFile'>, op: string, target: string | null, fn: () => Promise<T>, opts: { waitMs?: number; pollMs?: number } = {}): Promise<T> {
  if (holder.getStore()) return fn();
  const owner = newOwner(op, target);
  const deadline = Date.now() + (opts.waitMs ?? 0);
  mkdirSync(dirname(l.lifecycleLock), { recursive: true, mode: 0o755 }); // `init` on a fresh SEYRA_HOME
  const fd = openSync(l.lifecycleLock, constants.O_RDWR | constants.O_CREAT, 0o600);
  const started = Date.now();
  try {
    while (!tryFlock(fd, l.lifecycleLock)) {
      if (Date.now() >= deadline && Date.now() - started >= PROBE_GRACE_MS) throw new LifecycleBusyError(readOwner(l.lifecycleLock));
      await new Promise((res) => setTimeout(res, Date.now() < deadline ? (opts.pollMs ?? 2000) : 50));
    }
    assertEnforced(l.lifecycleLock);
    // We hold the kernel lock, so any record still present belongs to a command that has ended.
    const left = readOwner(l.lifecycleLock);
    if (left && existsSync(l.transitionFile) && op !== 'recover') {
      throw new Error(`the ${left.op} started ${left.started_at} ended without finishing; run: seyra-maps recover`);
    }
    writeRecord(fd, owner);
    try {
      return await holder.run(owner, fn);
    } finally {
      writeRecord(fd, null);
    }
  } finally {
    closeSync(fd); // releases the flock (if held) together with this descriptor
  }
}

/** Read-only view for `status`: is the lock held right now (shared probe), and the owner record. */
export function lifecycleLockState(path: string): { held: boolean; owner: LockOwner | null } {
  if (!existsSync(path)) return { held: false, owner: null };
  const r = spawnSync('flock', ['-n', '-s', '-E', String(BUSY), path, 'true'], { stdio: 'ignore' });
  return { held: r.status === BUSY, owner: readOwner(path) };
}
