import { afterEach, describe, expect, it, vi } from 'vitest';

import { AtlasApiError, buildFeaturesUrl, fetchFeatures } from '../src/api/client.js';
import type { Bbox } from '../src/api/types.js';

const VIEWPORT: Bbox = [51.38, 35.68, 51.4, 35.7];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildFeaturesUrl', () => {
  it('always sends the bbox in west,south,east,north order', () => {
    expect(buildFeaturesUrl({ bbox: VIEWPORT })).toBe(
      '/api/v1/map/features?bbox=51.38%2C35.68%2C51.4%2C35.7',
    );
  });

  it('omits optional parameters that were not asked for', () => {
    const url = buildFeaturesUrl({ bbox: VIEWPORT });
    expect(url).not.toContain('kind=');
    expect(url).not.toContain('limit=');
    expect(url).not.toContain('include=');
    expect(url).not.toContain('dataset=');
  });

  it('includes every optional parameter that was asked for', () => {
    const url = new URL(
      buildFeaturesUrl({
        bbox: VIEWPORT,
        kind: 'road',
        limit: 250,
        include: ['source', 'diagnostics'],
        dataset: 'ds-1',
      }),
      'http://localhost',
    );
    expect(url.searchParams.get('kind')).toBe('road');
    expect(url.searchParams.get('limit')).toBe('250');
    expect(url.searchParams.get('include')).toBe('source,diagnostics');
    expect(url.searchParams.get('dataset')).toBe('ds-1');
  });

  it('trims coordinates to a precision the server can parse', () => {
    const url = new URL(
      buildFeaturesUrl({ bbox: [51.3812345678, 35.68, 51.4, 35.7] }),
      'http://localhost',
    );
    expect(url.searchParams.get('bbox')).toBe('51.381235,35.68,51.4,35.7');
  });
});

describe('fetchFeatures', () => {
  it('returns the parsed feature collection on success', async () => {
    const collection = { type: 'FeatureCollection', bbox: VIEWPORT, features: [], atlas: {} };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(collection), {
            status: 200,
            headers: { 'content-type': 'application/geo+json' },
          }),
        ),
      ),
    );
    const result = await fetchFeatures({ bbox: VIEWPORT }, new AbortController().signal);
    expect(result.type).toBe('FeatureCollection');
  });

  it('turns the structured error envelope into an AtlasApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'INVALID_BOUNDING_BOX',
                message: 'west must not be greater than east',
                requestId: 'req-00000007',
                details: {},
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    await expect(fetchFeatures({ bbox: VIEWPORT }, new AbortController().signal)).rejects.toThrow(
      AtlasApiError,
    );

    try {
      await fetchFeatures({ bbox: VIEWPORT }, new AbortController().signal);
      expect.unreachable('the request should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      const apiError = error as AtlasApiError;
      expect(apiError.code).toBe('INVALID_BOUNDING_BOX');
      expect(apiError.status).toBe(400);
      expect(apiError.requestId).toBe('req-00000007');
    }
  });

  it('still reports an error when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('gateway exploded', { status: 502 }))),
    );
    await expect(fetchFeatures({ bbox: VIEWPORT }, new AbortController().signal)).rejects.toThrow(
      AtlasApiError,
    );
  });
});
