import { describe, expect, it } from 'vitest';
import { MapServiceError } from '@seyra/contracts';
import { buildPoiQuery, dispatcherRejection } from './overpass.js';
import { decodePolyline6, mapValhallaError } from './valhalla.js';
import { displayName } from './photon.js';

describe('polyline6 decoding', () => {
  it('decodes the reference polyline vector at precision 6', () => {
    // Google reference string; at precision 6 the decoded values are one tenth of precision 5.
    expect(decodePolyline6('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [-12.02, 3.85],
      [-12.095, 4.07],
      [-12.6453, 4.3252],
    ]);
  });
  it('rejects truncated input', () => {
    expect(() => decodePolyline6('_p~iF~ps|U_')).toThrow(MapServiceError);
  });
});

describe('valhalla error mapping', () => {
  it('separates genuine no-path from provider failures', () => {
    expect(mapValhallaError(400, { error_code: 442 }).code).toBe('NO_ROUTE');
    expect(mapValhallaError(400, { error_code: 170 }).code).toBe('NO_ROUTE');
    expect(mapValhallaError(400, { error_code: 171 }).code).toBe('POINT_NOT_ROUTABLE');
    expect(mapValhallaError(400, { error_code: 154 }).code).toBe('LIMIT_EXCEEDED');
    expect(mapValhallaError(500, { error_code: 199 }).code).toBe('PROVIDER_ERROR');
    expect(mapValhallaError(400, { error_code: 125 }).code).toBe('PROVIDER_ERROR');
  });
});

describe('overpass query builder (AC15)', () => {
  const bbox: [number, number, number, number] = [51.3, 35.6, 51.35, 35.65];
  it('emits bounded QL with fixed timeout, memory cap and limit+1', () => {
    const q = buildPoiQuery([{ key: 'amenity', value: 'pharmacy' }], bbox, 200, 10, 64 * 1024 * 1024);
    expect(q).toContain('[timeout:10]');
    expect(q).toContain('[maxsize:67108864]');
    expect(q).toContain('[bbox:35.6000000,51.3000000,35.6500000,51.3500000]');
    expect(q).toContain('nwr["amenity"="pharmacy"];');
    expect(q).toContain('out tags center 201;');
  });
  it('rejects anything outside the allowlist, including injection-shaped values', () => {
    for (const bad of [
      { key: 'amenity', value: 'pharmacy"];out;node(1' },
      { key: 'amenity', value: '.*' },
      { key: 'name', value: 'x' },
      { key: 'amenity', value: 'nuclear_reactor' },
      { key: 'amenity"]', value: 'pharmacy' },
    ]) {
      expect(() => buildPoiQuery([bad], bbox, 10, 10, 1024)).toThrow(MapServiceError);
    }
  });
});

describe('label/name fallback', () => {
  it('follows fa: name:fa → name → name:en and en: name:en → name → name:fa', () => {
    expect(displayName({ default: 'نام', en: 'Name' }, 'fa')).toBe('نام');
    expect(displayName({ fa: 'فارسی', default: 'نام', en: 'Name' }, 'fa')).toBe('فارسی');
    expect(displayName({ en: 'English' }, 'fa')).toBe('English');
    expect(displayName({ fa: 'فارسی', default: 'نام' }, 'en')).toBe('نام');
    expect(displayName({ fa: 'فارسی' }, 'en')).toBe('فارسی');
    expect(displayName({}, 'en')).toBeNull();
  });
});

describe('overpass dispatcher rejections', () => {
  // Shape observed from the pinned Overpass 0.7.62.4 interpreter (HTML even for [out:json]).
  const page = (reason: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<html><body>\n<p><strong style="color:#FF0000">Error</strong>: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::${reason} </p>\n</body></html>`;

  it.each(['rate_limited', 'timeout', 'duplicate_query'])('maps %s to a typed OVERLOADED error without provider text', (reason) => {
    const err = dispatcherRejection(page(reason));
    expect(err?.code).toBe('OVERLOADED');
    expect(err?.message).not.toContain('open64');
  });

  it('maps other dispatcher failures to PROVIDER_ERROR and leaves JSON bodies alone', () => {
    expect(dispatcherRejection(page('protocol_error'))?.code).toBe('PROVIDER_ERROR');
    expect(dispatcherRejection('{"version":0.6,"elements":[]}')).toBeNull();
  });
});
