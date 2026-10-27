import { lstatSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from './layout.js';

/**
 * Import storage admission and measurement.
 *
 * What the check covers: free space on the filesystem holding SEYRA_HOME (statfs). Every byte an
 * import writes goes there: the managed source copy, the new render database (data/postgres), the
 * Valhalla graph, the temporary Nominatim database and Photon input (work/ and the release), the
 * Overpass database including its build-time temporary files, map metadata and logs. It does NOT
 * cover a Docker data root on another filesystem (image layers, container logs) or tmpfs mounts.
 *
 * Reference (run vm2-2026-10-18, docs/validation/iran): importing the owner's 229,845,082-byte Iran
 * PBF on a fresh SEYRA_HOME lowered free space by 21,930,196,992 bytes at its sampled low point
 * (during the Overpass build), i.e. 95.4 x the input, and left 11,083,399,168 bytes retained. Runs
 * that replaced a failed build needed 89.3-89.4 x after that build was removed. The default factor
 * adds ~25 % margin for sampling (10 s interval), snapshot growth and filesystem reserve. It is a
 * guard derived from one extract, not a guarantee for every input or for concurrent disk use.
 */
export const REFERENCE_MIN_FREE_FACTOR = 120;

/** Free-space sampling interval during an import (also at every step boundary). */
export const FREE_SPACE_SAMPLE_MS = 5_000;

export function freeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

export interface CapacityCheck {
  ok: boolean;
  filesystem_path: string;
  free_bytes: number;
  /** Conservative credit for a failed build of the same dataset id that the import would replace. */
  reclaimable_bytes: number;
  available_bytes: number;
  required_bytes: number;
  input_bytes: number;
  min_free_factor: number;
  min_free_bytes: number;
  reference_min_free_factor: number;
}

/** required = max(minFreeBytes, minFreeFactor x input); available = free + reclaimable. Pure. */
export function capacityCheck(path: string, free: number, reclaimable: number, inputBytes: number, s: Pick<Settings, 'minFreeFactor' | 'minFreeBytes'>): CapacityCheck {
  const required = Math.max(s.minFreeBytes, Math.ceil(s.minFreeFactor * inputBytes));
  const available = free + reclaimable;
  return {
    ok: available >= required,
    filesystem_path: path,
    free_bytes: free,
    reclaimable_bytes: reclaimable,
    available_bytes: available,
    required_bytes: required,
    input_bytes: inputBytes,
    min_free_factor: s.minFreeFactor,
    min_free_bytes: s.minFreeBytes,
    reference_min_free_factor: REFERENCE_MIN_FREE_FACTOR,
  };
}

export function describeCapacity(c: CapacityCheck): string {
  const gb = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
  return `available ${c.available_bytes} B (${gb(c.available_bytes)}: free ${c.free_bytes} + reclaimable ${c.reclaimable_bytes}) ${c.ok ? '>=' : '<'} required ${c.required_bytes} B (${gb(c.required_bytes)}: max(minFreeBytes ${c.min_free_bytes}, minFreeFactor ${c.min_free_factor} x input ${c.input_bytes}))`;
}

export interface ReclaimEstimate {
  /** Credited bytes: allocated blocks that deleting the tree releases on the checked filesystem. */
  bytes: number;
  /** Informational only: apparent size of regular files (never credited). */
  logical_bytes: number;
  files: number;
  directories: number;
  /** Entries given no credit, by reason. */
  not_credited: { symlinks: number; other_filesystem: number; shared_inodes: number; special: number; unreadable: number };
  method: string;
}

/**
 * Conservative estimate of what deleting `dir` releases on the filesystem with device id `fsDev`
 * (the one statfs(SEYRA_HOME) reports). Counted: allocated blocks (st_blocks x 512) of regular files
 * and directories. Never counted:
 *   - symlinks (they are not followed; deleting a link frees no target bytes);
 *   - anything on another filesystem (a mount point inside the tree is not descended);
 *   - a hard-linked inode with a link outside the tree (deletion leaves its data in place);
 *   - special files and unreadable subtrees (unknown, so zero).
 * Apparent length (st_size) is never credited, so sparse files earn only their allocated blocks.
 * Space held by a file that is still open is only released when it closes, so this stays an
 * estimate: the importer re-measures free space after the cleanup and before any new write.
 */
export function reclaimableBytes(dir: string, fsDev: bigint): ReclaimEstimate {
  const r: ReclaimEstimate = {
    bytes: 0,
    logical_bytes: 0,
    files: 0,
    directories: 0,
    not_credited: { symlinks: 0, other_filesystem: 0, shared_inodes: 0, special: 0, unreadable: 0 },
    method: 'allocated blocks (st_blocks x 512), lstat (no symlink following), same device as SEYRA_HOME, hard links credited once and only if all links are inside the tree',
  };
  const inodes = new Map<string, { seen: number; nlink: bigint; bytes: bigint }>();
  let dirBytes = 0n;
  const visit = (p: string): void => {
    let st;
    try {
      st = lstatSync(p, { bigint: true });
    } catch {
      r.not_credited.unreadable++;
      return;
    }
    if (st.isSymbolicLink()) {
      r.not_credited.symlinks++;
      return;
    }
    if (st.dev !== fsDev) {
      r.not_credited.other_filesystem++;
      return;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(p);
      } catch {
        r.not_credited.unreadable++;
        return;
      }
      r.directories++;
      dirBytes += st.blocks * 512n;
      for (const n of names) visit(join(p, n));
      return;
    }
    if (!st.isFile()) {
      r.not_credited.special++;
      return;
    }
    r.files++;
    r.logical_bytes += Number(st.size);
    const key = `${st.dev}:${st.ino}`;
    const e = inodes.get(key);
    if (e) e.seen++;
    else inodes.set(key, { seen: 1, nlink: st.nlink, bytes: st.blocks * 512n });
  };
  visit(dir);
  let fileBytes = 0n;
  for (const e of inodes.values()) {
    if (BigInt(e.seen) >= e.nlink) fileBytes += e.bytes;
    else r.not_credited.shared_inodes++;
  }
  r.bytes = Number(dirBytes + fileBytes);
  return r;
}

export class CapacityRefusal extends Error {}

export interface Admission {
  admission: CapacityCheck;
  /** Estimate for a failed build that would be replaced (null when there is none). */
  reclaim: ReclaimEstimate | null;
  /** pg_database_size of that build's render DB: informational, credited as 0. */
  render_db_logical_bytes: number | null;
  render_db_credit_bytes: 0;
  /** Observed free space after the authorized cleanup, checked before any new import write. */
  after_cleanup: CapacityCheck | null;
}

/**
 * Admission for one import. With a failed build of the same dataset present:
 *   1. estimate = observed free + conservative reclaim of its release tree (+ 0 for its render DB,
 *      whose pg_database_size is not a promise of an equal statfs gain);
 *   2. if insufficient: refuse; nothing is changed (failed build, DB, other releases, input);
 *   3. otherwise remove it (`cleanup`), then compare the *observed* free space with the requirement
 *      before anything new is written, and refuse if it fell short.
 * Without a failed build only the observed free space counts. No reservation is made: another
 * process can still consume space between this check and the import's writes.
 */
export async function admitImport(o: {
  path: string;
  datasetId: string;
  inputBytes: number;
  settings: Pick<Settings, 'minFreeFactor' | 'minFreeBytes'>;
  free: () => number;
  failedBuild: null | { estimate: () => ReclaimEstimate; renderDbLogicalBytes: () => Promise<number | null>; cleanup: () => Promise<void> };
  log: (m: string) => void;
}): Promise<Admission> {
  const reclaim = o.failedBuild ? o.failedBuild.estimate() : null;
  const dbLogical = o.failedBuild ? await o.failedBuild.renderDbLogicalBytes().catch(() => null) : null;
  const admission = capacityCheck(o.path, o.free(), reclaim?.bytes ?? 0, o.inputBytes, o.settings);
  const result: Admission = { admission, reclaim, render_db_logical_bytes: dbLogical, render_db_credit_bytes: 0, after_cleanup: null };
  o.log(`[import] capacity: ${describeCapacity(admission)}${reclaim ? ` (reclaim estimate of the failed build: ${reclaim.bytes} B allocated; its apparent size ${reclaim.logical_bytes} B and render DB ${dbLogical ?? 'unknown'} B are not credited)` : ''}`);
  if (!admission.ok) {
    throw Object.assign(
      new CapacityRefusal(
        `insufficient free space for ${o.datasetId} on ${o.path}: ${describeCapacity(admission)}; nothing was changed${o.failedBuild ? ` (the failed build of ${o.datasetId} was kept)` : ''}. Add capacity or, after measuring, adjust minFreeFactor/minFreeBytes in state/settings.json; never delete unrelated data`,
      ),
      { admission: result },
    );
  }
  if (o.failedBuild) {
    await o.failedBuild.cleanup();
    const after = capacityCheck(o.path, o.free(), 0, o.inputBytes, o.settings);
    result.after_cleanup = after;
    o.log(`[import] capacity after removing the failed build: ${describeCapacity(after)}`);
    if (!after.ok) {
      throw Object.assign(
        new CapacityRefusal(
          `insufficient free space for ${o.datasetId} on ${o.path} after removing its failed build: observed ${describeCapacity(after)}; no new import data was written. The removal released less than estimated or other data grew; add capacity before retrying`,
        ),
        { admission: result },
      );
    }
  }
  return result;
}

/**
 * Low-water mark of free space, sampled on a timer and at step boundaries. Finite polling can miss
 * a shorter dip and cannot prevent another process from filling the disk; it records what it saw.
 */
export class FreeSpaceMonitor {
  min = Number.POSITIVE_INFINITY;
  minAt: string | null = null;
  samples = 0;
  private stepMin = Number.POSITIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sampleFn: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  sample(): number {
    let v: number;
    try {
      v = this.sampleFn();
    } catch {
      return Number.NaN; // a failed statfs is not a measurement
    }
    if (!Number.isFinite(v)) return Number.NaN;
    this.samples++;
    if (v < this.min) {
      this.min = v;
      this.minAt = this.now().toISOString();
    }
    if (v < this.stepMin) this.stepMin = v;
    return v;
  }

  /** Start a step: its own minimum begins with a fresh sample. */
  beginStep(): void {
    this.stepMin = Number.POSITIVE_INFINITY;
    this.sample();
  }

  /** End a step: take a closing sample and return the step's observed minimum. */
  endStep(): number | null {
    this.sample();
    return Number.isFinite(this.stepMin) ? this.stepMin : null;
  }

  start(intervalMs = FREE_SPACE_SAMPLE_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  minimum(): number | null {
    return Number.isFinite(this.min) ? this.min : null;
  }
}
