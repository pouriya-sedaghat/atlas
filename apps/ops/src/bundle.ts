import { chmodSync, chownSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { lockedImages, inspectImageId, readLock } from './lock.js';
import { sha256File, sha256Text } from './manifest.js';
import { run } from './proc.js';

/**
 * Offline bundle:
 *   images/<role>.tar           docker save archives (one per locked image)
 *   install/                    compose files, catalog, wrapper, runbooks, licence inventory, lock
 *   bundle-manifest.json        image refs + verified image IDs + archive sha256 + file sha256
 *   SHA256SUMS                  coreutils-compatible checksums of every file
 */
export const BUNDLE_SCHEMA = 'seyra.offline-bundle/1';

interface BundleManifest {
  schema: string;
  created_at: string;
  lock_sha256: string;
  images: { role: string; ref: string; image_id: string; archive: string; archive_sha256: string; platform: string }[];
  files: Record<string, string>;
}

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

/**
 * Install files copied into <bundle>/install with their repository-relative layout: what the
 * operator needs on the host. Developer material (the client integration guide, examples, seeds)
 * is the separate client handoff pack (infra/handoff/build-client-pack.mjs); links inside these
 * files must resolve within this set (tests/client/test-handoff-artifacts.mjs).
 */
export const INSTALL_PATHS = [
  'bin/seyra-maps',
  'infra/compose/runtime.yml',
  'infra/compose/runtime.relay.yml',
  'infra/compose/jobs.yml',
  'infra/catalog',
  'infra/valhalla',
  'infra/dependencies.lock.json',
  'infra/prepare/sources.json',
  'apps/ops/migrations',
  'docs/RUNBOOK.md',
  'docs/README-FA.md',
  'demo.sh',
  'scripts',
  'SOURCE.json',
  'fixtures/osm',
  'docs/VALIDATION.md',
  'docs/LICENSES.md',
  'docs/openapi',
];

export async function bundleExport(installDir: string, out: string, extraFiles: string[], log: (m: string) => void): Promise<void> {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`bundle output ${out} must be empty`);
  mkdirSync(join(out, 'images'), { recursive: true });
  mkdirSync(join(out, 'install'), { recursive: true });
  const images = lockedImages(installDir);
  const entries: BundleManifest['images'] = [];
  for (const img of images) {
    const id = await inspectImageId(img.ref);
    if (!id) throw new Error(`image ${img.ref} is not present; cannot export`);
    if (!img.image_id || id !== img.image_id) throw new Error(`image ${img.ref} identity ${id} does not match the lock (${img.image_id ?? 'unknown'})`);
    const archive = `images/${img.role.toLowerCase()}.tar`;
    log(`[bundle] saving ${img.ref}`);
    await run('docker', ['save', '-o', join(out, archive), img.ref]);
    entries.push({ role: img.role, ref: img.ref, image_id: id, archive, archive_sha256: await sha256File(join(out, archive)), platform: img.platform });
  }
  for (const rel of [...INSTALL_PATHS, ...extraFiles]) {
    const src = join(installDir, rel);
    if (!existsSync(src)) throw new Error(`install path missing: ${rel}`);
    const dest = join(out, 'install', rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
    else copyFileSync(src, dest);
  }
  const files: Record<string, string> = {};
  for (const rel of walkFiles(join(out, 'install'))) files[`install/${rel}`] = await sha256File(join(out, 'install', rel));
  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    created_at: new Date().toISOString(),
    lock_sha256: sha256Text(JSON.stringify(readLock(installDir))),
    images: entries,
    files,
  };
  writeFileSync(join(out, 'bundle-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums: string[] = [];
  for (const rel of walkFiles(out).filter((f) => f !== 'SHA256SUMS')) sums.push(`${await sha256File(join(out, rel))}  ${rel}`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  const owner = applyBundleOwnership(out);
  log(`[bundle] wrote ${entries.length} image archives and ${Object.keys(files).length} install files to ${out} (owner ${owner.uid}:${owner.gid}, files 0644/0755, directories 0755)`);
}

/**
 * Output ownership policy. Everything `bundle export` writes under OUT belongs to the owner of OUT
 * itself and is readable by everyone: directories 0755, executable files 0755, other files 0644.
 * The host wrapper creates OUT as the invoking operator before the ops container runs, so that
 * operator can verify (`sha256sum -c SHA256SUMS`), copy and `bootstrap-load` the bundle without root.
 * `docker save -o` alone leaves root-owned 0600 archives. A bundle carries image archives and install
 * files, never secrets or keys. Only the paths under OUT are touched (OUT's own mode is left alone);
 * file contents, and therefore every checksum, are unchanged.
 */
export function applyBundleOwnership(out: string): { uid: number; gid: number } {
  const { uid, gid } = statSync(out);
  const canChown = process.getuid?.() === 0 || process.getuid?.() === uid;
  const visit = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const name of readdirSync(p)) visit(join(p, name));
    } else {
      chmodSync(p, st.mode & 0o111 ? 0o755 : 0o644);
    }
    if (canChown && (st.uid !== uid || st.gid !== gid)) chownSync(p, uid, gid);
  };
  for (const name of readdirSync(out)) visit(join(out, name));
  return { uid, gid };
}

/** Verify every checksum; returns the list of problems (empty = intact). */
export async function bundleVerify(dir: string): Promise<{ problems: string[]; manifest: BundleManifest }> {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(dir, 'bundle-manifest.json'), 'utf8')) as BundleManifest;
  if (manifest.schema !== BUNDLE_SCHEMA) problems.push(`unexpected bundle schema ${manifest.schema}`);
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const listed = new Set<string>();
  for (const line of sums) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) {
      problems.push(`malformed SHA256SUMS line: ${line}`);
      continue;
    }
    listed.add(m[2]!);
    const p = join(dir, m[2]!);
    if (!existsSync(p)) problems.push(`missing file ${m[2]}`);
    else if ((await sha256File(p)) !== m[1]) problems.push(`checksum mismatch ${m[2]}`);
  }
  for (const rel of walkFiles(dir)) if (rel !== 'SHA256SUMS' && !listed.has(rel)) problems.push(`unlisted file ${rel}`);
  for (const img of manifest.images) {
    if (!/^sha256:[0-9a-f]{64}$/.test(img.image_id)) problems.push(`image ${img.ref} has no verifiable identity`);
  }
  return { problems, manifest };
}

/** Verify, docker load, then require each loaded reference to resolve to the manifest identity. */
export async function bundleLoad(dir: string, log: (m: string) => void): Promise<void> {
  const { problems, manifest } = await bundleVerify(dir);
  if (problems.length) throw new Error(`bundle verification failed: ${problems.join('; ')}`);
  for (const img of manifest.images) {
    log(`[bundle] loading ${img.ref}`);
    await run('docker', ['load', '-i', join(dir, img.archive)]);
    const id = await inspectImageId(img.ref);
    if (id !== img.image_id) throw new Error(`loaded ${img.ref} resolves to ${id ?? 'nothing'}, expected ${img.image_id}`);
  }
  log(`[bundle] ${manifest.images.length} images loaded; identities match the manifest`);
}
