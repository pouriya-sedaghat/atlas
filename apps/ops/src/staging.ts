import { randomBytes } from 'node:crypto';
import { composeJobs } from './compose.js';
import { psql, renderDbName } from './db.js';
import type { Layout } from './layout.js';
import { imageEnv, type LockedImage } from './lock.js';
import { run } from './proc.js';

export interface StageCheck {
  name: string;
  ok: boolean;
  detail: unknown;
}
export interface StageResult {
  ok: boolean;
  checks: StageCheck[];
  identities: { tiles: string; routing: string; geocoder: string; overpass: string } | null;
}

async function http(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<{ status: number; body: string; bytes: number }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf.toString('utf8'), bytes: buf.length };
}

async function waitFor(url: string, timeoutS: number): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await http(url, undefined, 3000);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

function lonLatTile(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

/**
 * Start the real providers against the STAGING stores on the internal build network, record the
 * identity each one serves and run smoke checks drawn from the dataset itself. Containers are
 * always stopped afterwards; nothing touches the active release.
 */
export async function stageValidate(l: Layout, images: LockedImage[], releaseDir: string, datasetId: string, log: (m: string) => void): Promise<StageResult> {
  const short = randomBytes(3).toString('hex');
  const names = {
    valhalla: `seyra-demo-stage-valhalla-${short}`,
    photon: `seyra-demo-stage-photon-${short}`,
    overpass: `seyra-demo-stage-overpass-${short}`,
    tegola: `seyra-demo-stage-tegola-${short}`,
  };
  const env = { ...imageEnv(images), SEYRA_JOB_RELEASE: releaseDir };
  const checks: StageCheck[] = [];
  const check = (name: string, ok: boolean, detail: unknown) => {
    checks.push({ name, ok, detail });
    log(`[stage] ${ok ? 'PASS' : 'FAIL'} ${name}`);
  };
  const started: string[] = [];
  try {
    for (const [svc, name] of Object.entries(names)) {
      await composeJobs(l, env, ['run', '-d', '--rm', '--no-deps', '--name', name, `stage-${svc}`]);
      started.push(name);
    }
    const base = {
      valhalla: `http://${names.valhalla}:8002`,
      photon: `http://${names.photon}:2322`,
      overpass: `http://${names.overpass}:8080`,
      tegola: `http://${names.tegola}:8080`,
    };
    const ups = await Promise.all([
      waitFor(`${base.valhalla}/status`, 120),
      waitFor(`${base.photon}/status`, 240),
      waitFor(`${base.overpass}/healthz`, 60),
      waitFor(`${base.tegola}/capabilities`, 60),
    ]);
    check('providers-started', ups.every(Boolean), { valhalla: ups[0], photon: ups[1], overpass: ups[2], tegola: ups[3] });

    const renderDb = renderDbName(datasetId);
    // Sample data from the frozen render DB for smoke checks (no fabricated coordinates).
    const roads = (
      await psql(
        l,
        renderDb,
        `SELECT ST_X(p1), ST_Y(p1), ST_X(p2), ST_Y(p2) FROM (
           SELECT ST_Transform(ST_StartPoint(geom), 4326) p1, ST_Transform(ST_EndPoint(geom), 4326) p2
             FROM render.transport WHERE class = 'highway' AND type IN ('primary','secondary','tertiary','residential','unclassified','trunk')
               AND coalesce(access, '') NOT IN ('no', 'private') ORDER BY ST_Length(geom) DESC LIMIT 5) s;`,
      )
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((r) => r.split('|').map(Number));
    const sampleName = (await psql(l, renderDb, `SELECT coalesce(name_en, name) FROM render.places WHERE coalesce(name_en, name) IS NOT NULL ORDER BY population DESC NULLS LAST LIMIT 1;`)).trim() ||
      (await psql(l, renderDb, `SELECT coalesce(name_en, name) FROM render.pois WHERE coalesce(name_en, name) IS NOT NULL LIMIT 1;`)).trim();
    // ST_Extent returns a box2d without SRID; render geometries are EPSG:3857 (seyra-flex.lua).
    const center = (await psql(l, renderDb, `SELECT ST_X(c), ST_Y(c) FROM (SELECT ST_Transform(ST_SetSRID(ST_Centroid(ST_Extent(geom)::geometry), 3857), 4326) c FROM render.transport) s;`)).trim().split('|').map(Number);

    // Each provider check records its own failure so one unavailable provider does not hide
    // the results of the others.
    const guarded = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        check(name, false, { error: err instanceof Error ? err.message : String(err) });
      }
    };

    // tiles
    const tegolaMap = `seyra_${datasetId.replace(/-/g, '_')}`;
    await guarded('tiles', async () => {
      const caps = await http(`${base.tegola}/capabilities`);
      const capsOk = caps.status === 200 && caps.body.includes(`"${tegolaMap}"`);
      let tileOk = false;
      let tileDetail: unknown = null;
      if (capsOk && center.length === 2 && center.every(Number.isFinite)) {
        const [x, y] = lonLatTile(center[0]!, center[1]!, 14);
        const tile = await http(`${base.tegola}/maps/${tegolaMap}/14/${x}/${y}.pbf`);
        tileOk = tile.status === 200 && tile.bytes > 0;
        tileDetail = { z: 14, x, y, status: tile.status, bytes: tile.bytes };
      }
      check('tiles', capsOk && tileOk, { map: tegolaMap, capabilities: caps.status, tile: tileDetail });
    });

    // routing
    let routingIdentity: number | null = null;
    await guarded('routing', async () => {
      const status = await http(`${base.valhalla}/status`);
      const vstatus = JSON.parse(status.body) as { tileset_last_modified?: number; version?: string };
      let routed = 0;
      for (const [a, b, c, d] of roads) {
        const r = await http(`${base.valhalla}/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ locations: [{ lon: a, lat: b }, { lon: c, lat: d }], costing: 'pedestrian', directions_type: 'none' }),
        });
        if (r.status === 200) routed++;
      }
      const ok = typeof vstatus.tileset_last_modified === 'number' && routed > 0;
      if (ok) routingIdentity = vstatus.tileset_last_modified!;
      check('routing', ok, { version: vstatus.version, tileset_last_modified: vstatus.tileset_last_modified, sampled_routes: roads.length, routed });
    });

    // geocoder
    const marker = `seyra-release-${datasetId}`;
    await guarded('geocoder', async () => {
      const mres = await http(`${base.photon}/api?q=${encodeURIComponent(marker)}&include=seyra.release_marker&limit=1`);
      const markerFound = mres.status === 200 && (JSON.parse(mres.body) as { features?: { properties?: { name?: string } }[] }).features?.[0]?.properties?.name === marker;
      let searchHits = 0;
      if (sampleName) {
        const sres = await http(`${base.photon}/api?q=${encodeURIComponent(sampleName)}&limit=3&exclude=seyra.release_marker`);
        searchHits = sres.status === 200 ? ((JSON.parse(sres.body) as { features?: unknown[] }).features?.length ?? 0) : 0;
      }
      check('geocoder', markerFound && (sampleName === '' || searchHits > 0), { marker_found: markerFound, sample_query_present: sampleName !== '', sample_hits: searchHits });
    });

    // overpass
    let oIdentity: string | null = null;
    await guarded('overpass', async () => {
      const probe = '[out:json][timeout:5][bbox:0,0,0.0000001,0.0000001];node;out ids 1;';
      const ores = await http(`${base.overpass}/api/interpreter`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: probe }).toString() });
      oIdentity = ores.status === 200 ? ((JSON.parse(ores.body) as { osm3s?: { timestamp_osm_base?: string } }).osm3s?.timestamp_osm_base ?? null) : null;
      check('overpass', oIdentity === `seyra:${datasetId}`, { identity: oIdentity, status: ores.status });
    });

    const ok = checks.every((c) => c.ok);
    return {
      ok,
      checks,
      identities:
        ok && routingIdentity !== null && oIdentity !== null
          ? { tiles: tegolaMap, routing: String(routingIdentity), geocoder: marker, overpass: oIdentity }
          : null,
    };
  } catch (err) {
    check('staging-exception', false, err instanceof Error ? err.message : String(err));
    return { ok: false, checks, identities: null };
  } finally {
    for (const name of started) await run('docker', ['stop', '-t', '20', name], { allowFailure: true });
  }
}
