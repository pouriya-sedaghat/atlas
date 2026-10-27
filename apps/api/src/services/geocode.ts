import {
  MapServiceError,
  codePointLength,
  normalizeForSearch,
  parseBbox,
  type GeocodeResponse,
  type GeocodeResult,
  type Language,
  type MapLimits,
  type ReverseQuery,
  type SearchQuery,
} from '@seyra/contracts';

export interface GeocoderProvider {
  search(params: { q: string; lang: Language; limit: number; bias?: { lon: number; lat: number }; bbox?: [number, number, number, number] }, signal: AbortSignal): Promise<GeocodeResult[]>;
  reverse(params: { lon: number; lat: number; lang: Language; limit: number; radiusM?: number }, signal: AbortSignal): Promise<GeocodeResult[]>;
}

/**
 * Free-text search, autocomplete and reverse geocoding (fa/en). Queries are normalized with the
 * same function used to derive the index's searchable variants; displayed names stay original.
 * Photon 1.3.0 serves search-as-you-type on one endpoint, so autocomplete differs by intent and
 * its default result count, not by a separate engine.
 */
export class GeocodeService {
  constructor(
    private readonly provider: GeocoderProvider,
    private readonly limits: MapLimits,
  ) {}

  async search(q: SearchQuery, operation: 'search' | 'autocomplete', datasetId: string, signal: AbortSignal): Promise<GeocodeResponse> {
    if (codePointLength(q.q) > this.limits.queryMaxCodePoints) {
      throw new MapServiceError('QUERY_TOO_LONG', `query exceeds ${this.limits.queryMaxCodePoints} Unicode code points`, {
        details: { limit: this.limits.queryMaxCodePoints },
      });
    }
    const normalized = normalizeForSearch(q.q);
    if (normalized.length === 0) throw new MapServiceError('INVALID_REQUEST', 'query is empty after normalization', { details: { field: 'q' } });
    if ((q.bias_lon === undefined) !== (q.bias_lat === undefined)) {
      throw new MapServiceError('INVALID_REQUEST', 'bias_lon and bias_lat must be supplied together', { details: { field: 'bias' } });
    }
    let bbox: [number, number, number, number] | undefined;
    if (q.bbox !== undefined) {
      const parsed = parseBbox(q.bbox);
      if (!parsed) throw new MapServiceError('INVALID_REQUEST', 'bbox must be minLon,minLat,maxLon,maxLat with min < max', { details: { field: 'bbox' } });
      bbox = parsed;
    }
    const lang = q.lang ?? 'fa';
    const limit = this.clampLimit(q.limit ?? (operation === 'autocomplete' ? 5 : 10));
    const results = await this.provider.search(
      {
        q: normalized,
        lang,
        limit,
        ...(q.bias_lon !== undefined && q.bias_lat !== undefined ? { bias: { lon: q.bias_lon, lat: q.bias_lat } } : {}),
        ...(bbox ? { bbox } : {}),
      },
      signal,
    );
    return {
      dataset_id: datasetId,
      provider: 'photon',
      operation,
      language: lang,
      normalized_query: normalized,
      result_status: results.length > 0 ? 'ok' : 'no_results',
      results: results.slice(0, limit),
    };
  }

  async reverse(q: ReverseQuery, datasetId: string, signal: AbortSignal): Promise<GeocodeResponse> {
    const lang = q.lang ?? 'fa';
    const limit = this.clampLimit(q.limit ?? 1);
    const radius = q.radius_m;
    if (radius !== undefined && radius > this.limits.reverseMaxRadiusM) {
      throw new MapServiceError('LIMIT_EXCEEDED', `radius_m may not exceed ${this.limits.reverseMaxRadiusM}`);
    }
    const results = await this.provider.reverse({ lon: q.lon, lat: q.lat, lang, limit, ...(radius !== undefined ? { radiusM: radius } : {}) }, signal);
    return {
      dataset_id: datasetId,
      provider: 'photon',
      operation: 'reverse',
      language: lang,
      result_status: results.length > 0 ? 'ok' : 'no_results',
      results: results.slice(0, limit),
    };
  }

  private clampLimit(n: number): number {
    if (n < this.limits.searchMinResults || n > this.limits.searchMaxResults) {
      throw new MapServiceError('LIMIT_EXCEEDED', `limit must be between ${this.limits.searchMinResults} and ${this.limits.searchMaxResults}`);
    }
    return n;
  }
}
