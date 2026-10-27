import {
  MapServiceError,
  POI_PRESETS,
  bboxAreaKm2,
  isAllowlisted,
  parseBbox,
  type MapLimits,
  type PoiQuery,
  type PoiResponse,
} from '@seyra/contracts';
import { buildPoiQuery, type OverpassElement } from '../providers/overpass.js';
import { displayName } from '../providers/photon.js';

export interface PoiProvider {
  run(query: string, signal: AbortSignal): Promise<OverpassElement[]>;
}

/** Bounded bbox POI queries over Overpass from fixed presets or the finite catalog allowlist. */
export class PoiService {
  constructor(
    private readonly provider: PoiProvider,
    private readonly limits: MapLimits,
  ) {}

  async query(q: PoiQuery, datasetId: string, signal: AbortSignal): Promise<PoiResponse> {
    const bbox = parseBbox(q.bbox);
    if (!bbox) throw new MapServiceError('INVALID_REQUEST', 'bbox must be minLon,minLat,maxLon,maxLat with min < max', { details: { field: 'bbox' } });
    const area = bboxAreaKm2(bbox);
    if (area > this.limits.poiMaxBboxKm2) {
      throw new MapServiceError('BBOX_TOO_LARGE', `bbox area ${area.toFixed(1)} km² exceeds ${this.limits.poiMaxBboxKm2} km²`, {
        details: { area_km2: Number(area.toFixed(3)), limit_km2: this.limits.poiMaxBboxKm2 },
      });
    }
    const limit = q.limit ?? 100;
    if (limit > this.limits.poiMaxResults) throw new MapServiceError('LIMIT_EXCEEDED', `limit may not exceed ${this.limits.poiMaxResults}`);

    let filters: { key: string; value: string }[];
    let presetId: string | null = null;
    if (q.preset !== undefined) {
      if (q.key !== undefined || q.value !== undefined) {
        throw new MapServiceError('INVALID_REQUEST', 'use either preset or key/value, not both');
      }
      const preset = POI_PRESETS.find((p) => p.id === q.preset);
      if (!preset) throw new MapServiceError('UNKNOWN_PRESET', 'unknown POI preset');
      filters = preset.filters.map((f) => ({ key: f.key, value: f.value }));
      presetId = preset.id;
    } else {
      if (q.key === undefined || q.value === undefined) {
        throw new MapServiceError('INVALID_REQUEST', 'preset, or both key and value, are required');
      }
      if (!isAllowlisted(q.key, q.value)) {
        throw new MapServiceError('UNKNOWN_PRESET', 'key/value is not in the catalog allowlist', { details: { key: q.key } });
      }
      filters = [{ key: q.key, value: q.value }];
    }

    const ql = buildPoiQuery(filters, bbox, limit, this.limits.overpassTimeoutS, this.limits.overpassMaxSizeBytes);
    const elements = await this.provider.run(ql, signal);
    const lang = q.lang ?? 'fa';
    const features: PoiResponse['features'] = [];
    for (const el of elements.slice(0, limit)) {
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      const tags = el.tags ?? {};
      const match = filters.find((f) => tags[f.key] === f.value) ?? filters[0]!;
      const names: { default?: string; fa?: string; en?: string } = {};
      if (tags.name) names.default = tags.name;
      if (tags['name:fa']) names.fa = tags['name:fa'];
      if (tags['name:en']) names.en = tags['name:en'];
      features.push({
        id: `osm:${el.type[0]}${el.id}`,
        osm_type: el.type,
        osm_id: el.id,
        coordinate: { lon, lat },
        key: match.key,
        value: match.value,
        name: displayName(names, lang),
        names,
      });
    }
    return {
      dataset_id: datasetId,
      provider: 'overpass',
      selector: { preset: presetId, filters },
      bbox,
      bbox_area_km2: Number(area.toFixed(3)),
      limit,
      truncated: elements.length > limit,
      features,
    };
  }
}
