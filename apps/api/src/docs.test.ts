import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import Ajv from 'ajv';
import { CapabilitiesSchema, DEFAULT_LIMITS, MapServiceError } from '@seyra/contracts';
import { buildApp } from './app.js';
import { OPERATION_DOCS } from './api-docs.js';
import { HealthService, type ProviderProbes } from './services/health.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exported = JSON.parse(readFileSync(join(repo, 'docs', 'openapi', 'map-services-v1.json'), 'utf8')) as Record<string, any>;

/** An app whose providers all fail and count every call (docs must never contact them). */
async function makeApp(datasetId: string) {
  const calls: string[] = [];
  const down = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new MapServiceError('PROVIDER_UNAVAILABLE', `${name} down`, { provider: name }));
  };
  const probes: ProviderProbes = { tiles: down('tiles'), routing: down('routing'), geocoder: down('geocoder'), overpass: down('overpass'), controlDb: down('control_db') };
  const health = new HealthService(
    { schema: 'seyra.active-release/1', dataset_id: datasetId, activated_at: '2026-10-19T00:00:00Z', identities: { tiles: 'a', routing: 'b', geocoder: 'c', overpass: 'd' } },
    probes,
    { cacheMs: 60_000, probeTimeoutMs: 50, maintenanceFlagFile: '/nonexistent' },
  );
  const app = await buildApp({
    limits: DEFAULT_LIMITS,
    health,
    routing: { route: down('routing.route'), pair: down('routing.pair') },
    geocoder: { search: down('geocoder.search'), reverse: down('geocoder.reverse') },
    poi: { run: down('poi.run') },
    geography: { distances: down('geography.distances') },
    logLevel: 'silent',
  });
  return { app, calls };
}

describe('offline Swagger UI and the canonical specification', () => {
  it('serves the runtime document equal to the exported file, independent of the active dataset', async () => {
    for (const ds of ['ds-20261001-9843cf36a06e', 'ds-docs-check-other']) {
      const { app } = await makeApp(ds);
      const r = await app.inject({ method: 'GET', url: '/api/docs/json' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
      expect(r.json()).toEqual(exported);
      expect(r.body).not.toContain(ds);
      await app.close();
    }
  });

  it('documents every public operation with a stable unique id, summary and truthful responses', async () => {
    const ops = Object.entries(exported.paths as Record<string, Record<string, any>>).flatMap(([path, m]) => Object.entries(m).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })));
    expect(ops.map((o) => o.key).sort()).toEqual(Object.keys(OPERATION_DOCS).sort());
    expect(Object.fromEntries(ops.map((o) => [o.key, o.op.operationId]))).toEqual({
      'GET /health/live': 'getLiveness',
      'GET /health/ready': 'getReadiness',
      'GET /api/v1/map/health': 'getMapHealth',
      'GET /api/v1/map/capabilities': 'getCapabilities',
      'GET /api/v1/map/search': 'searchPlaces',
      'GET /api/v1/map/autocomplete': 'autocompletePlaces',
      'GET /api/v1/map/reverse': 'reversePlaces',
      'POST /api/v1/map/route': 'computeRoute',
      'POST /api/v1/map/proximity': 'rankProximity',
      'GET /api/v1/map/pois': 'queryPois',
    });
    for (const { key, op } of ops) {
      expect(op.summary, key).toBeTruthy();
      expect(op.description, key).toBeTruthy();
      expect(op.responses['200'], key).toBeTruthy();
      for (const [status, res] of Object.entries(op.responses as Record<string, any>)) {
        expect(res.description, `${key} ${status}`).not.toBe('Default Response');
        if (Number(status) >= 400 && key !== 'GET /health/ready') {
          expect(res.content['application/json'].schema.properties.error.required, `${key} ${status}`).toEqual(expect.arrayContaining(['code', 'message', 'request_id']));
        }
      }
    }
    // Bodies over 64 KiB are a documented 413 on both POST operations.
    expect(Object.keys(exported.paths['/api/v1/map/route'].post.responses)).toContain('413');
    expect(Object.keys(exported.paths['/api/v1/map/proximity'].post.responses)).toContain('413');
    // Geocoding never answers 422, so it is not documented.
    expect(Object.keys(exported.paths['/api/v1/map/search'].get.responses)).not.toContain('422');
    // No documentation, provider, admin or diagnostics route is part of the public contract.
    expect(Object.keys(exported.paths).filter((p) => /docs|diagnostics|admin|import|tegola|photon|valhalla|overpass/.test(p))).toEqual([]);
    expect(exported.servers).toEqual([{ url: '/' }]);
    expect(JSON.stringify(exported)).not.toMatch(/securitySchemes|oauth|petstore/i);
  });

  it('describes the proxy-served map assets in the narrative instead of inventing API routes', () => {
    const d = exported.info.description as string;
    for (const p of ['/maps/{dataset_id}/tiles.json', '/maps/{dataset_id}/tiles/{z}/{x}/{y}.pbf', '/styles/{light|dark}-{fa|en}.json', '/fonts/{fontstack}/{start}-{end}.pbf', '/sprites/{light|dark}[@2x].{json|png}', 'DATASET_MISMATCH', '204']) {
      expect(d).toContain(p);
    }
    expect(Object.keys(exported.paths).some((p) => p.startsWith('/maps/'))).toBe(false);
  });

  it('keeps request validation schemas unchanged by documentation (examples are annotations only)', async () => {
    const { app } = await makeApp('ds-docs-check');
    // An example value is not a default and unknown fields are still rejected.
    const r = await app.inject({ method: 'POST', url: '/api/v1/map/route', payload: { profile: 'car', objective: 'time', points: [{ id: 'a', lon: 0, lat: 0 }, { id: 'b', lon: 0, lat: 0.1 }], extra: 1 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('INVALID_REQUEST');
    const q = await app.inject({ method: 'GET', url: '/api/v1/map/search' });
    expect(q.statusCode).toBe(400);
    await app.close();
  });

  it('serves the UI from local assets only, with no plugin CSP and no remote or query-string configuration', async () => {
    const { app, calls } = await makeApp('ds-docs-check');
    for (const url of ['/api/docs/', '/api/docs']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['content-security-policy'], 'the ingress owns the CSP').toBeUndefined();
      const refs = [...r.body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
      expect(refs.length).toBeGreaterThan(3);
      for (const ref of refs) {
        expect(ref, url).not.toMatch(/^(https?:)?\/\//);
        const asset = await app.inject({ method: 'GET', url: ref.startsWith('/') ? ref : `/api/docs/${ref.replace(/^\.\//, '')}` });
        expect(asset.statusCode, ref).toBe(200);
        expect(asset.headers['content-security-policy']).toBeUndefined();
      }
      expect(r.body).not.toMatch(/<script>(?!\s*<\/script>)|<script(?![^>]*\bsrc=)[^>]*>/); // no inline script
    }
    const init = await app.inject({ method: 'GET', url: '/api/docs/static/swagger-initializer.js' });
    expect(init.statusCode).toBe(200);
    const js = init.body.replace(/\s+/g, '');
    for (const needle of ['"layout":"BaseLayout"', 'validatorUrl:null', '"validatorUrl":null', '"queryConfigEnabled":false', '"tryItOutEnabled":false', '"supportedSubmitMethods":["get","post"]', "url:resolveUrl('./json')"]) {
      expect(js, needle).toContain(needle);
    }
    // The plugin's initializer has one URL, inside a code comment; executable code references none.
    expect(init.body.replace(/\/\/ [^\n]*/g, '')).not.toMatch(/https?:\/\//);
    expect(js).not.toMatch(/"(urls|configUrl|oauth2RedirectUrl)"/);
    const legacy = await app.inject({ method: 'GET', url: '/api/docs/static/index.html' });
    expect(legacy.statusCode).toBe(302);
    expect(legacy.headers.location).toBe('/api/docs/');
    // Loading documentation runs no operation and contacts no provider.
    expect(calls).toEqual([]);
    await app.close();
  });

  it('stays available while providers are down; attempted operations return real typed errors', async () => {
    const { app, calls } = await makeApp('ds-docs-check');
    expect((await app.inject({ method: 'GET', url: '/api/docs/json' })).statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    const s = await app.inject({ method: 'GET', url: '/api/v1/map/search?q=test' });
    expect(s.statusCode).toBe(503);
    expect(s.json().error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', request_id: expect.any(String) });
    expect(calls.length).toBeGreaterThan(0);
    await app.close();
  });
});

describe('capabilities response schema', () => {
  it('validates the actual response and matches the recorded live fixture apart from release-specific values', async () => {
    const { app } = await makeApp('ds-20261001-681455d56afb');
    const r = await app.inject({ method: 'GET', url: '/api/v1/map/capabilities' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Value.Check(CapabilitiesSchema, body), JSON.stringify([...Value.Errors(CapabilitiesSchema, body)].slice(0, 3))).toBe(true);
    const recorded = JSON.parse(readFileSync(join(repo, 'docs', 'mobile-fixtures', 'capabilities.json'), 'utf8')).response.body;
    expect(body).toEqual(recorded);
    await app.close();
  });
});

describe('hidden diagnostics route', () => {
  it('is absent from the specification and matches only its exact path inside the API (the ingress blocks the prefix)', async () => {
    const { app } = await makeApp('ds-docs-check');
    expect(Object.keys(exported.paths)).not.toContain('/api/v1/map/diagnostics');
    for (const url of ['/api/v1/map/Diagnostics', '/api/v1/map/diagnostics/', '/api/v1/map/diagnostics;x', '/API/v1/map/diagnostics']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    await app.close();
  });
});

describe('error responses against the served schema (review H5)', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schemaFor = (spec: Record<string, any>, path: string, method: string, status: string) => spec.paths[path][method].responses[status].content['application/json'].schema;
  it('API-generated and ingress-generated 413 bodies both satisfy the served 413 schemas', async () => {
    // API-generated: a provider answer above its size bound (routing and proximity).
    const tooLarge = () => Promise.reject(new MapServiceError('PAYLOAD_TOO_LARGE', 'valhalla response exceeded 1048576 bytes', { provider: 'valhalla' }));
    const health = new HealthService(
      { schema: 'seyra.active-release/1', dataset_id: 'ds-docs-check', activated_at: '2026-10-19T00:00:00Z', identities: { tiles: 'a', routing: 'b', geocoder: 'c', overpass: 'd' } },
      { tiles: async () => ({ identity: 'a' }), routing: async () => ({ identity: 'b' }), geocoder: async () => ({ identity: 'c' }), overpass: async () => ({ identity: 'd' }), controlDb: async () => undefined },
      { cacheMs: 60_000, probeTimeoutMs: 50, maintenanceFlagFile: '/nonexistent' },
    );
    await health.refresh();
    const app = await buildApp({ limits: DEFAULT_LIMITS, health, routing: { route: tooLarge, pair: tooLarge }, geocoder: { search: tooLarge, reverse: tooLarge }, poi: { run: tooLarge }, geography: { distances: tooLarge }, logLevel: 'silent' });
    const spec = (await app.inject({ method: 'GET', url: '/api/docs/json' })).json();
    const pts = [{ id: 'a', lon: 0.01, lat: 0.02 }, { id: 'b', lon: 0.05, lat: 0.03 }];
    const cases: [string, string, Record<string, unknown> | null][] = [
      ['/api/v1/map/route', 'post', { profile: 'car', objective: 'time', points: pts }],
      ['/api/v1/map/proximity', 'post', { metric: 'road_distance', direction: 'origin_to_candidate', profile: 'car', origin: { lon: 0.03, lat: 0.04 }, candidates: [{ id: 'c', lon: 0.03, lat: 0.02 }] }],
      ['/api/v1/map/search', 'get', null],
      ['/api/v1/map/pois', 'get', null],
    ];
    for (const [path, method, body] of cases) {
      const url = method === 'get' ? `${path}?${path.endsWith('search') ? 'q=x' : 'bbox=0.005,0.005,0.06,0.06&preset=food'}` : path;
      const r = await app.inject({ method: method.toUpperCase() as 'GET' | 'POST', url, ...(body ? { payload: body } : {}) });
      expect(r.statusCode, path).toBe(413);
      const validate = ajv.compile(schemaFor(spec, path, method, '413'));
      expect(validate(r.json()), `${path} API 413: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // Ingress-generated: the exact body the proxy template renders (nginx substitutes $request_id).
    const tpl = readFileSync(join(repo, 'infra', 'images', 'proxy', 'locations.conf.template'), 'utf8');
    const literal = tpl.match(/return 413 '([^']+)';/)![1]!.replace('$request_id', '0123456789abcdef0123456789abcdef');
    for (const path of ['/api/v1/map/route', '/api/v1/map/proximity']) {
      const validate = ajv.compile(schemaFor(spec, path, 'post', '413'));
      expect(validate(JSON.parse(literal)), `${path} ingress 413: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    // The schema stays strong: an error body without request_id (the old ingress literal) is rejected.
    const weak = ajv.compile(schemaFor(spec, '/api/v1/map/route', 'post', '413'));
    expect(weak({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'request body exceeds 64 KiB' } })).toBe(false);
    expect(weak({ error: { code: 'NOT_A_CODE', message: 'x', request_id: 'r' } })).toBe(false);
    await app.close();
  });

  it('every ingress-generated JSON error in the proxy template carries request_id', () => {
    const tpl = readFileSync(join(repo, 'infra', 'images', 'proxy', 'locations.conf.template'), 'utf8');
    const bodies = [...tpl.matchAll(/return \d{3} '(\{"error"[^']+)';/g)].map((m) => m[1]!);
    expect(bodies.length).toBeGreaterThanOrEqual(5);
    for (const b of bodies) expect(JSON.parse(b.replace('$request_id', 'x')).error.request_id, b).toBe('x');
  });

  it('API 4xx/5xx bodies validate against their documented schemas', async () => {
    const { app } = await makeApp('ds-docs-check');
    const spec = (await app.inject({ method: 'GET', url: '/api/docs/json' })).json();
    const bad = await app.inject({ method: 'GET', url: '/api/v1/map/search' });
    expect(ajv.compile(schemaFor(spec, '/api/v1/map/search', 'get', '400'))(bad.json())).toBe(true);
    const down = await app.inject({ method: 'GET', url: '/api/v1/map/search?q=x' });
    expect(ajv.compile(schemaFor(spec, '/api/v1/map/search', 'get', '503'))(down.json())).toBe(true);
    await app.close();
  });
});
