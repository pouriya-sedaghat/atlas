import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { writeAtomic } from './layout.js';

export const MANIFEST_SCHEMA = 'seyra.release-manifest/1';
export const PIPELINE_VERSION = 'seyra-pipeline-1.0.1';

const Nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const ManifestSchema = Type.Object({
  schema: Type.Literal(MANIFEST_SCHEMA),
  dataset_id: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{2,79}$' }),
  status: Type.Enum(['building', 'validated', 'failed']),
  created_at: Type.String(),
  updated_at: Type.String(),
  source: Type.Object({
    original_path: Type.String(),
    filename: Type.String(),
    size_bytes: Type.Integer(),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    managed_copy: Type.String(),
    snapshot_timestamp: Nullable(Type.String()),
    snapshot_timestamp_source: Type.Enum(['pbf_header', 'operator', 'unknown']),
    bbox: Type.Union([Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]), Type.Null()]),
    counts: Type.Record(Type.String(), Type.Number()),
  }),
  pipeline: Type.Object({
    pipeline_version: Type.String(),
    fingerprint_sha256: Type.String(),
    files: Type.Record(Type.String(), Type.String()),
    catalog_version: Type.String(),
    search_normalization_version: Type.String(),
    style_version: Type.String(),
  }),
  components: Type.Record(Type.String(), Type.Object({ ref: Type.String(), image_id: Type.String() })),
  assets: Type.Object({ assets_sha256: Type.String(), source: Type.String() }),
  artifacts: Type.Record(Type.String(), Type.Unknown()),
  identities: Type.Union([
    Type.Object({ tiles: Type.String(), routing: Type.String(), geocoder: Type.String(), overpass: Type.String() }),
    Type.Null(),
  ]),
  measurements: Type.Object({
    steps: Type.Array(
      Type.Object({
        step: Type.String(),
        seconds: Type.Number(),
        bytes: Type.Union([Type.Number(), Type.Null()]),
        // Lowest free space seen during the step (timer + boundary samples); absent in older manifests.
        free_bytes_min: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      }),
    ),
    free_bytes_before: Type.Union([Type.Number(), Type.Null()]),
    free_bytes_min_observed: Type.Union([Type.Number(), Type.Null()]),
    free_bytes_min_observed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    free_space_sampling: Type.Optional(Type.Object({ interval_s: Type.Number(), samples: Type.Number(), filesystem_path: Type.String() })),
    capacity_check: Type.Optional(Type.Unknown()),
  }),
  validation: Type.Object({
    status: Type.Enum(['pending', 'passed', 'failed']),
    checks: Type.Array(Type.Object({ name: Type.String(), ok: Type.Boolean(), detail: Type.Unknown() })),
  }),
  failure: Type.Union([Type.Object({ step: Type.String(), message: Type.String() }), Type.Null()]),
});
export type Manifest = Static<typeof ManifestSchema>;

export function manifestPath(releaseDir: string): string {
  return join(releaseDir, 'manifest.json');
}

export function readManifest(releaseDir: string): Manifest {
  const raw = JSON.parse(readFileSync(manifestPath(releaseDir), 'utf8')) as unknown;
  assertManifest(raw);
  return raw;
}

export function assertManifest(raw: unknown): asserts raw is Manifest {
  if (!Value.Check(ManifestSchema, raw)) {
    const first = [...Value.Errors(ManifestSchema, raw)][0];
    throw new Error(`release manifest does not match ${MANIFEST_SCHEMA}: ${first ? `${first.instancePath} ${first.message}` : 'schema mismatch'}`);
  }
}

export function writeManifest(releaseDir: string, m: Manifest): void {
  m.updated_at = new Date().toISOString();
  assertManifest(m);
  writeAtomic(manifestPath(releaseDir), `${JSON.stringify(m, null, 2)}\n`);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Deterministic digest of a directory tree: sorted relative paths with per-file sha256. */
export async function treeDigest(dir: string, exclude: (rel: string) => boolean = () => false): Promise<{ sha256: string; files: number; bytes: number }> {
  const entries: string[] = [];
  let bytes = 0;
  const walk = async (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (exclude(rel)) continue;
      const st = statSync(p);
      if (st.isDirectory()) await walk(p);
      else if (st.isFile()) {
        bytes += st.size;
        entries.push(`${rel}\t${await sha256File(p)}`);
      }
    }
  };
  if (existsSync(dir)) await walk(dir);
  return { sha256: sha256Text(entries.join('\n')), files: entries.length, bytes };
}

export function duBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return total;
}

/**
 * Images whose identity shapes or reads the built map stores (render DB, routing graph, geocoder
 * index, Overpass base, MVT encoding). A release is only servable by these exact identities.
 * The API, proxy and ops images do not change stored data; the proxy's map assets are covered by
 * the separate asset digest. All component identities are still recorded in the manifest.
 */
export const DATA_COMPONENT_ROLES = ['DB', 'OSMTOOLS', 'VALHALLA', 'GEOCODER_BUILD', 'PHOTON', 'OVERPASS', 'TEGOLA'] as const;

export function dataComponents(all: Record<string, string>): Record<string, string> {
  return Object.fromEntries(DATA_COMPONENT_ROLES.map((r) => [r, all[r] ?? 'missing']));
}

/**
 * dataset_id = ds-<snapshot date | nots>-<12 hex>. The hash covers the source checksum, pipeline
 * files, data-component image identities and the asset digest — not the PBF alone.
 */
export function deriveDatasetId(snapshot: string | null, parts: { source_sha256: string; pipeline_fingerprint: string; components: Record<string, string>; assets_sha256: string }): string {
  const date = snapshot && /^\d{4}-\d{2}-\d{2}/.test(snapshot) ? snapshot.slice(0, 10).replace(/-/g, '') : 'nots';
  const material = JSON.stringify({ s: parts.source_sha256, p: parts.pipeline_fingerprint, c: Object.entries(parts.components).sort(), a: parts.assets_sha256 });
  return `ds-${date}-${sha256Text(material).slice(0, 12)}`;
}
