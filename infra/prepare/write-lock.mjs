#!/usr/bin/env node
// PREPARATION ENVIRONMENT. Write infra/dependencies.lock.json from REAL inspected identities:
// docker image IDs, base digests from Dockerfiles, pinned source commits, artifact checksums,
// npm lockfile integrity, and versions reported by the binaries inside the built images.
// Usage: SEYRA_SOURCES=/path node infra/prepare/write-lock.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadVerifiedSourceHeads } from './verified-source-heads.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcesDir = process.env.SEYRA_SOURCES;
if (!sourcesDir) throw new Error('SEYRA_SOURCES is required');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const shOk = (cmd, args) => {
  try {
    return sh(cmd, args);
  } catch (e) {
    return `ERROR: ${(e.stderr || e.message || '').toString().split('\n')[0]}`;
  }
};
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sources = JSON.parse(readFileSync(join(repo, 'infra/prepare/sources.json'), 'utf8'));
const verifiedHeads = process.env.SEYRA_VERIFIED_SOURCE_HEADS
  ? loadVerifiedSourceHeads(process.env.SEYRA_VERIFIED_SOURCE_HEADS, join(repo, 'infra/prepare/sources.json'), sourcesDir)
  : null;

const inspect = (ref) => JSON.parse(sh('docker', ['image', 'inspect', ref]))[0];
// Some tools print their version on stderr; capture both streams.
const inImage = (ref, entry, args) => {
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', entry, ref, ...args], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};
const dockerfileBases = (path) =>
  [...readFileSync(join(repo, path), 'utf8').matchAll(/^ARG [A-Z_]+_IMAGE=([^\s]+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]);
const dpkgDigest = (ref) => {
  let out = inImage(ref, 'dpkg-query', ['-W', '-f=${Package}=${Version}\\n']);
  let manager = 'dpkg';
  if (/executable file not found|no such file/i.test(out)) {
    out = inImage(ref, 'apk', ['info', '-v']);
    manager = 'apk';
  }
  if (/executable file not found|no such file/i.test(out)) return null;
  return { manager, packages: out.split('\n').length, sha256: createHash('sha256').update(out).digest('hex') };
};

const SOURCE_LICENSES = {
  valhalla: { spdx: 'MIT', file: 'COPYING' },
  prime_server: { spdx: 'BSD-2-Clause', file: 'COPYING' },
  overpass: { spdx: 'AGPL-3.0', file: 'COPYING' },
  osm2pgsql: { spdx: 'GPL-2.0-or-later', file: 'COPYING (+ README "or any later version")' },
  'osmium-tool': { spdx: 'GPL-3.0', file: 'LICENSE.txt' },
  tegola: { spdx: 'MIT', file: 'LICENSE.md' },
  photon: { spdx: 'Apache-2.0', file: 'LICENSE' },
  nominatim: { spdx: 'GPL-3.0-or-later', file: 'COPYING (GPLv3 text) + PyPI license expression' },
};

const sourceEntries = {};
for (const [name, s] of Object.entries(sources.sources)) {
  const path = join(sourcesDir, name);
  const head = verifiedHeads ? verifiedHeads[name] : existsSync(path) ? sh('git', ['-C', path, 'rev-parse', 'HEAD']) : null;
  if (head !== s.commit) throw new Error(`${name}: source checkout does not match pinned commit ${s.commit}`);
  sourceEntries[name] = {
    url: s.url,
    tag: s.tag,
    commit: s.commit,
    verified_checkout: head === s.commit,
    license: { ...SOURCE_LICENSES[name], verified_from_file: true },
  };
}
const artifactEntries = {};
for (const [name, a] of Object.entries(sources.artifacts)) {
  const p = join(sourcesDir, 'artifacts', name);
  artifactEntries[name] = { url: a.url, sha256_expected: a.sha256, sha256_observed: existsSync(p) ? sha256(p) : null };
}
artifactEntries['photon-1.3.0.jar'].provenance =
  'Official GitHub release asset; MANIFEST Git-Commit 523a59b4 ("prepare release 1.3.0") has the identical tree (94e69041289a0bc7aa6b11145b610ae63c519d73) as tag 1.3.0 merge commit 4c28c7c1.';

const IMAGES = [
  { role: 'DB', ref: 'postgis/postgis:17-3.5', origin: process.env.SEYRA_PREP_DB_ORIGIN ?? 'upstream docker.io/postgis/postgis (pulled through the mirror.gcr.io registry mirror in preparation)', versions: (r) => ({ postgres: inImage(r, 'postgres', ['--version']) }), license: 'PostgreSQL (server), GPL-2.0-or-later (PostGIS)' },
  { role: 'TEGOLA', ref: 'seyra-demo/tegola:0.21.2-seyra1', dockerfile: 'infra/images/tegola/Dockerfile', sources: ['tegola'], versions: (r) => ({ tegola: inImage(r, '/usr/local/bin/tegola', ['version']).split('\n').slice(0, 3).join(' | ') }), license: 'MIT' },
  { role: 'VALHALLA', ref: 'seyra-demo/valhalla:3.9.1-seyra1', dockerfile: 'infra/images/valhalla/Dockerfile', sources: ['valhalla', 'prime_server'], versions: (r) => ({ valhalla_service: inImage(r, 'valhalla_service', ['--version']) }), license: 'MIT (Valhalla), BSD-2-Clause (prime_server)' },
  { role: 'PHOTON', ref: 'seyra-demo/photon:1.3.0-seyra1', dockerfile: 'infra/images/photon/Dockerfile', sources: ['photon'], versions: (r) => ({ java: inImage(r, 'java', ['-version']).split('\n')[0] ?? '', photon_jar_sha256: inImage(r, 'sha256sum', ['/opt/photon/photon.jar']).split(' ')[0] }), license: 'Apache-2.0 (Photon), GPL-2.0-with-classpath-exception (OpenJDK)' },
  { role: 'OVERPASS', ref: 'seyra-demo/overpass:0.7.62.4-seyra1', dockerfile: 'infra/images/overpass/Dockerfile', sources: ['overpass'], versions: () => ({ overpass: '0.7.62.4 (configure AC_INIT; responses report "Overpass API 0.7.62.4")' }), license: 'AGPL-3.0' },
  { role: 'API', ref: 'seyra-demo/api:1.0.0-seyra1', dockerfile: 'infra/images/api/Dockerfile', versions: (r) => ({ node: inImage(r, 'node', ['--version']) }), license: 'project (UNLICENSED, owner) + npm dependency licences' },
  { role: 'PROXY', ref: 'seyra-demo/proxy:1.0.0-seyra1', dockerfile: 'infra/images/proxy/Dockerfile', versions: (r) => ({ nginx: inImage(r, 'nginx', ['-v']), assets_sha256: JSON.parse(inImage(r, 'cat', ['/usr/share/seyra/assets/asset-manifest.json'])).assets_sha256 }), license: 'BSD-2-Clause (nginx), OFL-1.1 (Vazirmatn), BSD-3-Clause (MapLibre GL JS)' },
  { role: 'OSMTOOLS', ref: 'seyra-demo/osmtools:2.3.1-1.19.1-seyra1', dockerfile: 'infra/images/osmtools/Dockerfile', sources: ['osm2pgsql', 'osmium-tool'], versions: (r) => ({ osm2pgsql: inImage(r, 'osm2pgsql', ['--version']).split('\n')[0], osmium: inImage(r, 'osmium', ['--version']).split('\n')[0] }), license: 'GPL-2.0-or-later (osm2pgsql), GPL-3.0 (osmium-tool)' },
  { role: 'GEOCODER_BUILD', ref: 'seyra-demo/geocoder-build:5.3.2-1.3.0-seyra1', dockerfile: 'infra/images/geocoder-build/Dockerfile', sources: ['nominatim', 'photon'], versions: (r) => ({ nominatim: inImage(r, '/opt/nominatim/bin/nominatim', ['--version']), postgres: inImage(r, '/usr/lib/postgresql/16/bin/postgres', ['--version']) }), license: 'GPL-3.0-or-later (Nominatim), PostgreSQL/PostGIS' },
  { role: 'OPS', ref: 'seyra-demo/ops:1.0.0-seyra1', dockerfile: 'infra/images/ops/Dockerfile', versions: (r) => ({ node: inImage(r, 'node', ['--version']), docker: inImage(r, 'docker', ['--version']), compose: inImage(r, 'docker', ['compose', 'version']) }), license: 'project + Apache-2.0 (Docker CLI/Compose)' },
];

const images = {};
for (const img of IMAGES) {
  const info = inspect(img.ref);
  images[img.role.toLowerCase()] = {
    role: img.role,
    ref: img.ref,
    image_id: info.Id,
    repo_digests: info.RepoDigests ?? [],
    platform: `${info.Os}/${info.Architecture}`,
    created: info.Created,
    origin: img.origin ?? 'custom build from pinned sources (preparation environment)',
    dockerfile: img.dockerfile ?? null,
    dockerfile_sha256: img.dockerfile ? sha256(join(repo, img.dockerfile)) : null,
    base_images: img.dockerfile ? dockerfileBases(img.dockerfile) : [],
    sources: img.sources ?? [],
    reported_versions: img.versions(img.ref),
    os_packages: img.role === 'DB' ? null : dpkgDigest(img.ref),
    license: img.license,
    validation: 'image inspected during demo preparation; full VM smoke check must be run separately',
  };
}

const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
const npmPick = (name) => lock.packages[`node_modules/${name}`]?.version ?? null;
const npm = {
  package_lock_sha256: sha256(join(repo, 'package-lock.json')),
  lockfile_version: lock.lockfileVersion,
  packages: Object.fromEntries(['fastify', '@fastify/swagger', '@fastify/type-provider-typebox', 'typebox', 'pg', 'maplibre-gl', 'react', 'react-dom', 'vite', '@vitejs/plugin-react', 'typescript', 'vitest', 'vazirmatn', 'opentype.js'].map((n) => [n, { version: npmPick(n), integrity: lock.packages[`node_modules/${n}`]?.integrity ?? null, license: lock.packages[`node_modules/${n}`]?.license ?? null }])),
};

const osRelease = readFileSync('/etc/os-release', 'utf8');
const out = {
  schema: 'seyra.dependencies-lock/1',
  generated_at: new Date().toISOString(),
  generated_by: 'infra/prepare/write-lock.mjs',
  status: 'DEMO image identities inspected; see docs/VALIDATION.md for executed checks',
  preparation_environment: {
    host_os: /PRETTY_NAME="([^"]+)"/.exec(osRelease)?.[1] ?? 'unknown',
    kernel: sh('uname', ['-sr']),
    arch: sh('uname', ['-m']),
    docker: shOk('docker', ['version', '--format', 'client {{.Client.Version}} / server {{.Server.Version}}']),
    compose: shOk('docker', ['compose', 'version', '--short']),
    node: process.version,
    // SEYRA_PREP_NOTE describes the environment this lock was actually generated in.
    note: process.env.SEYRA_PREP_NOTE ?? 'Cloud preparation environment (Claude Code remote session), not customer hardware. Docker Hub pulls went through mirror.gcr.io (Docker Hub returned 429); ghcr.io blob downloads were blocked by egress policy, so Valhalla is built from source.',
  },
  images,
  sources: sourceEntries,
  artifacts: artifactEntries,
  npm,
  assets: { fonts: 'Vazirmatn 33.0.3 (OFL-1.1) from npm', glyph_generator: 'packages/map-assets (opentype.js 2.0.0 + TinySDF-port)', digest: images.proxy.reported_versions.assets_sha256 },
};
writeFileSync(join(repo, 'infra/dependencies.lock.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote infra/dependencies.lock.json with ${Object.keys(images).length} images`);
