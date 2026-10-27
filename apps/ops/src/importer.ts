import { chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CATALOG_VERSION, SEARCH_NORMALIZATION_VERSION } from '@seyra/contracts';
import { STYLE_VERSION, buildStyle, buildTileJson } from '@seyra/map-assets';
import { FREE_SPACE_SAMPLE_MS, FreeSpaceMonitor, REFERENCE_MIN_FREE_FACTOR, admitImport, freeBytes, reclaimableBytes, type Admission } from './capacity.js';
import { composeJobs, jobsInvocation } from './compose.js';
import { psql, recordEvent, renderDbName } from './db.js';
import { PHOTON_EXTRA_TAGS, preprocessDump } from './geocoder-preprocess.js';
import { readPointers } from './activate.js';
import { acquireImportLock, releaseImportLock, setImportTarget } from './import-lock.js';
import { withLifecycleLock } from './lifecycle-lock.js';
import { writePhotonNodeConfig } from './photon-config.js';
import { layout, managedChild, readSettings, type Layout, type Settings } from './layout.js';
import { imageEnv, lockedImages, verifyImages, type LockedImage } from './lock.js';
import {
  MANIFEST_SCHEMA,
  PIPELINE_VERSION,
  dataComponents,
  deriveDatasetId,
  readManifest,
  duBytes,
  sha256File,
  sha256Text,
  treeDigest,
  writeManifest,
  type Manifest,
} from './manifest.js';
import { pipe, run } from './proc.js';
import { stageValidate } from './staging.js';

/** Container users of the Seyra images (fixed in the Dockerfiles). */
export const UID = { valhalla: 10001, osm: 10002, tegola: 10003, overpass: 10004, photon: 10005 } as const;

export interface ImportOptions {
  pbf: string;
  snapshotTimestamp?: string;
  log: (msg: string) => void;
}

const PIPELINE_FILES = [
  'infra/catalog/seyra-flex.lua',
  'infra/catalog/pre-import.sql',
  'infra/catalog/post-import.sql',
  'infra/catalog/catalog-report.sql',
  'infra/catalog/tegola.toml.tmpl',
  'infra/catalog/catalog.json',
  'infra/valhalla/valhalla.json',
  'infra/compose/jobs.yml',
];

export async function pipelineFingerprint(l: Layout): Promise<{ sha256: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  for (const f of PIPELINE_FILES) files[f] = await sha256File(join(l.install, f));
  const material = JSON.stringify({ files, PIPELINE_VERSION, CATALOG_VERSION, SEARCH_NORMALIZATION_VERSION, STYLE_VERSION, PHOTON_EXTRA_TAGS });
  return { sha256: sha256Text(material), files };
}

export async function assetsDigest(images: LockedImage[]): Promise<string> {
  const proxy = images.find((i) => i.role === 'PROXY')!;
  const r = await run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'cat', proxy.ref, '/usr/share/seyra/assets/asset-manifest.json']);
  const m = JSON.parse(r.stdout) as { assets_sha256?: string };
  if (!m.assets_sha256) throw new Error('proxy image asset manifest has no digest');
  return m.assets_sha256;
}

function chownTree(dir: string, uid: number, gid = uid): void {
  chownSync(dir, uid, gid);
}

interface SourceInfo {
  header?: { option?: Record<string, string>; boxes?: number[][] };
  data?: { bbox?: number[]; count?: Record<string, number> };
}

export async function sourceInfo(l: Layout, images: LockedImage[], pbf: string): Promise<SourceInfo> {
  const r = await composeJobs(l, { ...imageEnv(images), SEYRA_JOB_INPUT: pbf }, ['run', '--rm', '--no-deps', '-T', 'source-info']);
  const text = r.stdout;
  const start = text.indexOf('{');
  if (start < 0) throw new Error('osmium could not read the input file');
  return JSON.parse(text.slice(start)) as SourceInfo;
}

function centerAndZoom(bbox: [number, number, number, number] | null): { center: [number, number]; zoom: number } {
  if (!bbox) return { center: [53.5, 32.5], zoom: 5 };
  const [w, s, e, n] = bbox;
  const span = Math.max(e - w, n - s, 1e-6);
  const zoom = Math.max(1, Math.min(15, Math.floor(Math.log2(360 / span))));
  return { center: [(w + e) / 2, (s + n) / 2], zoom };
}

/** Tegola decodes bounds/center as float arrays; TOML integers (e.g. a 0 longitude) are rejected. */
export function tomlFloats(values: readonly number[]): string {
  return `[${values.map((v) => (Number.isInteger(v) ? v.toFixed(1) : String(v))).join(', ')}]`;
}

export async function importDataset(opts: ImportOptions): Promise<string> {
  const l = layout();
  const s: Settings = readSettings(l);
  const images = lockedImages(l.install);
  const imageCheck = await verifyImages(images);
  const bad = imageCheck.filter((c) => !c.ok);
  if (bad.length) throw new Error(`required images missing or not matching the lock (load the offline bundle): ${bad.map((b) => b.ref).join(', ')}`);

  const input = resolve(opts.pbf);
  const st = statSync(input);
  if (!st.isFile() || !input.endsWith('.osm.pbf')) throw new Error('input must be a local .osm.pbf file');
  if (input.startsWith(l.releases)) throw new Error('input must not be inside the managed releases directory');

  // Exclusive import lease (one build at a time); an abandoned lease is recovered (review R3).
  const lease = await acquireImportLock(l, opts.log);

  const steps: Manifest['measurements']['steps'] = [];
  // Free space on SEYRA_HOME's filesystem is sampled every FREE_SPACE_SAMPLE_MS and at every step
  // boundary, so the low-water mark inside long steps (e.g. the Overpass build) is recorded.
  const monitor = new FreeSpaceMonitor(() => freeBytes(l.home));
  const freeBefore = monitor.sample();
  monitor.start(FREE_SPACE_SAMPLE_MS);
  let capacity: Admission | null = null;
  const measurements = (): Manifest['measurements'] => ({
    steps,
    free_bytes_before: freeBefore,
    free_bytes_min_observed: monitor.minimum(),
    free_bytes_min_observed_at: monitor.minAt,
    free_space_sampling: { interval_s: FREE_SPACE_SAMPLE_MS / 1000, samples: monitor.samples, filesystem_path: l.home },
    ...(capacity ? { capacity_check: capacity } : {}),
  });
  let manifest: Manifest | null = null;
  let releaseDir = '';
  let current = 'preflight';
  const step = async <T>(name: string, fn: () => Promise<T>, outDir?: string): Promise<T> => {
    current = name;
    opts.log(`[import] ${name} …`);
    const t0 = Date.now();
    monitor.beginStep();
    const out = await fn();
    const stepMin = monitor.endStep();
    steps.push({ step: name, seconds: (Date.now() - t0) / 1000, bytes: outDir ? duBytes(outDir) : null, free_bytes_min: stepMin });
    if (manifest) {
      manifest.measurements = measurements();
      writeManifest(releaseDir, manifest);
    }
    return out;
  };

  try {
    const sourceSha = await step('source-checksum', () => sha256File(input));
    const info = await step('source-validate', () => sourceInfo(l, images, input));
    const counts = info.data?.count ?? {};
    if (!counts.nodes) throw new Error('input contains no nodes; refusing to build a release');
    const headerTs = info.header?.option?.osmosis_replication_timestamp ?? info.header?.option?.timestamp ?? null;
    const snapshot = opts.snapshotTimestamp ?? headerTs;
    const snapshotSource = opts.snapshotTimestamp ? 'operator' : headerTs ? 'pbf_header' : 'unknown';
    const bb = info.data?.bbox ?? info.header?.boxes?.[0] ?? null;
    const bbox = bb && bb.length === 4 ? ([bb[0], bb[1], bb[2], bb[3]] as [number, number, number, number]) : null;

    const pipeline = await pipelineFingerprint(l);
    const assets = await assetsDigest(images);
    const components = dataComponents(Object.fromEntries(imageCheck.map((c) => [c.role, c.observed!])));
    const datasetId = deriveDatasetId(snapshot, { source_sha256: sourceSha, pipeline_fingerprint: pipeline.sha256, components, assets_sha256: assets });
    releaseDir = managedChild(l.releases, datasetId);
    const managedCopy = join(releaseDir, 'source', 'input.osm.pbf');
    const log = (n: string) => join(releaseDir, 'logs', `${n}.log`);
    const now = new Date().toISOString();
    const initial: Manifest = {
      schema: MANIFEST_SCHEMA,
      dataset_id: datasetId,
      status: 'building',
      created_at: now,
      updated_at: now,
      source: {
        original_path: input,
        filename: basename(input),
        size_bytes: st.size,
        sha256: sourceSha,
        managed_copy: managedCopy,
        snapshot_timestamp: snapshot,
        snapshot_timestamp_source: snapshotSource,
        bbox,
        counts,
      },
      pipeline: {
        pipeline_version: PIPELINE_VERSION,
        fingerprint_sha256: pipeline.sha256,
        files: pipeline.files,
        catalog_version: CATALOG_VERSION,
        search_normalization_version: SEARCH_NORMALIZATION_VERSION,
        style_version: STYLE_VERSION,
      },
      components: Object.fromEntries(imageCheck.map((c) => [c.role, { ref: c.ref, image_id: c.observed! }])),
      assets: { assets_sha256: assets, source: 'proxy image /usr/share/seyra/assets/asset-manifest.json' },
      artifacts: {},
      identities: null,
      measurements: measurements(),
      validation: { status: 'pending', checks: [] },
      failure: null,
    };
    // Set-up mutates shared release state (replacing a failed build, creating the building
    // release); it runs under the lifecycle lock so prune/activation never see it half-done, and the
    // lease names its target from here on.
    const setupDir = releaseDir;
    current = 'setup'; // capacity admission and release creation (not a measured build step)
    await withLifecycleLock(
      l,
      'import-setup',
      datasetId,
      async () => {
        setImportTarget(l, lease, datasetId);
        // A failed build of the same inputs is replaced; anything else is never overwritten.
        let failedBuild: Manifest | null = null;
        if (existsSync(setupDir)) {
          const p = readPointers(l);
          const previous = existsSync(join(setupDir, 'manifest.json')) ? readManifest(setupDir) : null;
          if (previous?.status !== 'failed' || p.active === datasetId || p.previous === datasetId) {
            throw new Error(`release ${datasetId} already exists for these exact inputs (see seyra-maps status)`);
          }
          failedBuild = previous;
        }

        // Capacity admission before any side effect (capacity.ts): a failed build earns only a
        // conservative reclaim credit; it is removed only after admission, and the observed free
        // space is checked again before anything new is written. A refusal changes nothing.
        if (s.minFreeFactor < REFERENCE_MIN_FREE_FACTOR) {
          opts.log(`[import] warning: minFreeFactor ${s.minFreeFactor} is below the measured reference ${REFERENCE_MIN_FREE_FACTOR} (RUNBOOK §3); the import may run out of space`);
        }
        const fsDev = lstatSync(l.home, { bigint: true }).dev;
        capacity = await admitImport({
          path: l.home,
          datasetId,
          inputBytes: st.size,
          settings: s,
          free: () => monitor.sample(),
          log: opts.log,
          failedBuild: failedBuild
            ? {
                estimate: () => reclaimableBytes(setupDir, fsDev),
                renderDbLogicalBytes: () => renderDbLogicalBytes(l, datasetId),
                cleanup: async () => {
                  opts.log(`[import] replacing failed build of ${datasetId} (failed at ${failedBuild!.failure?.step ?? 'unknown'})`);
                  await psql(l, 'postgres', `DROP DATABASE IF EXISTS ${renderDbName(datasetId)} WITH (FORCE);`);
                  rmSync(setupDir, { recursive: true, force: true });
                },
              }
            : null,
        });

        mkdirSync(join(setupDir, 'source'), { recursive: true });
        for (const d of ['logs', 'validation', 'maps/styles', 'geocoder', '.work']) mkdirSync(join(setupDir, d), { recursive: true });
        chmodSync(join(setupDir, '.work'), 0o700);
        writeManifest(setupDir, initial);
      },
      { waitMs: 15 * 60_000 },
    );
    manifest = initial;
    opts.log(`[import] dataset_id ${datasetId}`);

    // The owner's original is only read (checksum + copy); every job uses the managed copy.
    await step('source-copy', async () => {
      copyFileSync(input, managedCopy);
      chmodSync(managedCopy, 0o444);
      if ((await sha256File(managedCopy)) !== sourceSha) throw new Error('managed copy checksum mismatch');
    });
    const jobBase = { ...imageEnv(images), SEYRA_JOB_INPUT: managedCopy, SEYRA_BUILD_THREADS: String(s.buildThreads) };

    // ---- rendering database (new DB per release; frozen after import) --------------------
    const renderDb = renderDbName(datasetId);
    await step('render-import', async () => {
      await psql(l, 'postgres', `CREATE DATABASE ${renderDb} OWNER seyra_admin;`);
      await psql(l, renderDb, readFileSync(join(l.install, 'infra/catalog/pre-import.sql'), 'utf8'), { render_db: renderDb });
      const pgpass = join(releaseDir, '.work', 'pgpass');
      const pw = readFileSync(join(l.secrets, 'db_render_import_password'), 'utf8').trim();
      writeFileSync(pgpass, `db:5432:${renderDb}:seyra_render_import:${pw}\n`, { mode: 0o400 });
      chownSync(pgpass, UID.osm, UID.osm);
      try {
        await composeJobs(l, { ...jobBase, SEYRA_JOB_RENDER_DB: renderDb, SEYRA_JOB_PGPASS: pgpass }, ['run', '--rm', '--no-deps', '-T', 'render-import'], { logFile: log('render-import'), discardStdout: true });
      } finally {
        unlinkSync(pgpass);
      }
      await psql(l, renderDb, readFileSync(join(l.install, 'infra/catalog/post-import.sql'), 'utf8'), {
        render_db: renderDb,
        dataset_id: datasetId,
        source_sha256: sourceSha,
        catalog_version: CATALOG_VERSION,
        pipeline_version: PIPELINE_VERSION,
      });
      const report = await psql(l, renderDb, readFileSync(join(l.install, 'infra/catalog/catalog-report.sql'), 'utf8'));
      writeFileSync(join(releaseDir, 'validation', 'catalog-report.json'), `${JSON.stringify(JSON.parse(report.trim()), null, 2)}\n`);
      const { center, zoom } = centerAndZoom(bbox);
      const tegolaToml = readFileSync(join(l.install, 'infra/catalog/tegola.toml.tmpl'), 'utf8')
        .replaceAll('{{DATASET_ID}}', datasetId)
        .replaceAll('{{CATALOG_VERSION}}', CATALOG_VERSION)
        .replaceAll('{{DB_HOST}}', 'db')
        .replaceAll('{{RENDER_DB}}', renderDb)
        .replaceAll('{{MAP_NAME}}', `seyra_${datasetId.replace(/-/g, '_')}`)
        .replaceAll('{{BOUNDS}}', tomlFloats(bbox ?? [-180, -85, 180, 85]))
        .replaceAll('{{CENTER}}', tomlFloats([center[0], center[1], zoom]));
      mkdirSync(join(releaseDir, 'tegola'), { recursive: true });
      writeFileSync(join(releaseDir, 'tegola', 'tegola.toml'), tegolaToml, { mode: 0o444 });
      manifest!.artifacts.render = {
        database: renderDb,
        frozen: true,
        catalog_report: 'validation/catalog-report.json',
        tegola_config_sha256: sha256Text(tegolaToml),
      };
    });

    // ---- routing graph (explicit Valhalla build; no scripted entrypoint) -----------------
    const valhallaDir = join(releaseDir, 'valhalla');
    await step(
      'routing-build',
      async () => {
        mkdirSync(join(valhallaDir, 'tiles'), { recursive: true });
        copyFileSync(join(l.install, 'infra/valhalla/valhalla.json'), join(valhallaDir, 'valhalla.json'));
        chownTree(valhallaDir, UID.valhalla);
        chownTree(join(valhallaDir, 'tiles'), UID.valhalla);
        chownSync(join(valhallaDir, 'valhalla.json'), UID.valhalla, UID.valhalla);
        await composeJobs(l, { ...jobBase, SEYRA_JOB_OUT: valhallaDir }, ['run', '--rm', '--no-deps', '-T', 'valhalla-build'], { logFile: log('routing-build'), discardStdout: true });
        const tree = await treeDigest(valhallaDir);
        manifest!.artifacts.routing = { dir: 'valhalla', ...tree, timezone_db: 'not packaged (date_time rejected in phase 1)', speed_config: 'not packaged (built-in class defaults)' };
      },
      valhallaDir,
    );

    // ---- geocoder: temporary Nominatim DB -> normalized Photon index ---------------------
    const photonDir = join(releaseDir, 'photon');
    await step(
      'geocoder-build',
      async () => {
        const work = managedChild(l.work, datasetId);
        const workGeo = join(work, 'geocoder');
        const exportDir = join(releaseDir, 'geocoder', 'export');
        // Scratch for this dataset id left by an earlier failed/interrupted build of the same inputs.
        rmSync(work, { recursive: true, force: true });
        mkdirSync(workGeo, { recursive: true });
        mkdirSync(exportDir, { recursive: true });
        const pgUid = Number((await run('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'id', images.find((i) => i.role === 'GEOCODER_BUILD')!.ref, '-u', 'postgres'])).stdout.trim());
        chownSync(workGeo, pgUid, pgUid);
        chownSync(exportDir, pgUid, pgUid);
        await composeJobs(l, { ...jobBase, SEYRA_JOB_WORK: workGeo, SEYRA_JOB_OUT: exportDir }, ['run', '--rm', '--no-deps', '-T', 'geocoder-export'], { logFile: log('geocoder-export'), discardStdout: true });
        const raw = join(exportDir, 'nominatim-export.jsonl');
        const rawSha = await sha256File(raw);
        const importFile = join(releaseDir, 'geocoder', 'photon-import.jsonl');
        const synonyms = join(releaseDir, 'geocoder', 'synonyms.json');
        const stats = await preprocessDump(raw, importFile, synonyms, `seyra-release-${datasetId}`);
        mkdirSync(photonDir, { recursive: true });
        chownTree(photonDir, UID.photon);
        writePhotonNodeConfig(photonDir);
        await composeJobs(
          l,
          { ...jobBase, SEYRA_JOB_IMPORT: join(releaseDir, 'geocoder'), SEYRA_JOB_OUT: photonDir, SEYRA_PHOTON_EXTRA_TAGS: PHOTON_EXTRA_TAGS },
          ['run', '--rm', '--no-deps', '-T', 'photon-import'],
          { logFile: log('photon-import'), discardStdout: true },
        );
        copyFileSync(synonyms, join(photonDir, 'synonyms.json'));
        chownSync(join(photonDir, 'synonyms.json'), UID.photon, UID.photon);
        const nominatimVersion = readFileSync(join(exportDir, 'nominatim-version.txt'), 'utf8').trim();
        // Job-owned temporaries only: raw export and the (already emptied) workspace.
        rmSync(exportDir, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
        manifest!.artifacts.geocoder = {
          nominatim: nominatimVersion,
          export_sha256: rawSha,
          import_file: 'geocoder/photon-import.jsonl',
          import_sha256: await sha256File(importFile),
          synonyms_sha256: await sha256File(synonyms),
          preprocess: stats,
          photon_dir: 'photon',
          photon_extra_tags: PHOTON_EXTRA_TAGS,
          note: 'The Photon index directory receives OpenSearch working-state writes while served; the import JSON is the immutable rebuild input.',
        };
      },
      photonDir,
    );

    // ---- Overpass base database (local XML stream; no clone/replication/areas) -----------
    const overpassDir = join(releaseDir, 'overpass');
    await step(
      'overpass-build',
      async () => {
        mkdirSync(overpassDir, { recursive: true });
        chownTree(overpassDir, UID.overpass);
        const label = `seyra:${datasetId}`;
        const env = { ...jobBase, SEYRA_JOB_OUT: overpassDir, SEYRA_JOB_OVERPASS_LABEL: label };
        const job = (svc: string) => jobsInvocation(l, env, ['run', '--rm', '--no-deps', '-T', svc]);
        await pipe(job('overpass-xml'), job('overpass-import'), log('overpass-build'));
        const tree = await treeDigest(join(overpassDir, 'db'));
        manifest!.artifacts.overpass = { dir: 'overpass/db', version_label: label, ...tree, meta: false, attic: false, areas: false };
      },
      overpassDir,
    );

    // ---- map metadata: TileJSON + light/dark × fa/en styles ------------------------------
    await step('map-styles', async () => {
      const { center, zoom } = centerAndZoom(bbox);
      const maps = join(releaseDir, 'maps');
      writeFileSync(join(maps, 'tiles.json'), `${JSON.stringify(buildTileJson(datasetId, bbox ?? undefined, [center[0], center[1], zoom]), null, 1)}\n`);
      for (const theme of ['light', 'dark'] as const) {
        for (const lang of ['fa', 'en'] as const) {
          const style = buildStyle({ datasetId, theme, lang, ...(bbox ? { bounds: bbox } : {}), center, zoom });
          writeFileSync(join(maps, 'styles', `${theme}-${lang}.json`), `${JSON.stringify(style, null, 1)}\n`);
        }
      }
      manifest!.artifacts.maps = { dir: 'maps', ...(await treeDigest(maps)) };
    });

    // ---- staging validation with real providers on the internal build network -------------
    const validation = await step('staging-validation', () => stageValidate(l, images, releaseDir, datasetId, opts.log));
    manifest.validation = { status: validation.ok ? 'passed' : 'failed', checks: validation.checks };
    manifest.identities = validation.identities;
    writeFileSync(join(releaseDir, 'validation', 'staging.json'), `${JSON.stringify(validation, null, 2)}\n`);
    if (!validation.ok || !validation.identities) throw new Error(`staging validation failed: ${validation.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);

    manifest.status = 'validated';
    manifest.measurements = measurements();
    writeManifest(releaseDir, manifest);
    rmSync(join(releaseDir, '.work'), { recursive: true, force: true });
    await recordEvent(l, datasetId, 'imported', { steps: steps.map((x) => [x.step, x.seconds]) }).catch(() => undefined);
    return datasetId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (manifest && releaseDir) {
      // Free the temporary geocoder database of the failed build; logs stay in the release.
      rmSync(managedChild(l.work, manifest.dataset_id), { recursive: true, force: true });
      manifest.status = 'failed';
      manifest.failure = { step: current, message };
      manifest.measurements = measurements();
      try {
        writeManifest(releaseDir, manifest);
      } catch {
        /* keep original error */
      }
      await recordEvent(l, manifest.dataset_id, 'import_failed', { step: current, message }).catch(() => undefined);
    }
    throw new Error(`import failed at ${current}: ${message}`);
  } finally {
    monitor.stop();
    releaseImportLock(l, lease);
  }
}

/** pg_database_size of a release's render DB (informational; never credited as free space). */
async function renderDbLogicalBytes(l: Layout, datasetId: string): Promise<number> {
  const out = await psql(l, 'postgres', `SELECT coalesce((SELECT pg_database_size(datname) FROM pg_database WHERE datname = '${renderDbName(datasetId)}'), 0);`);
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : 0;
}
