import { MapServiceError, UNITS, type MapLimits, type ProximityRequest, type ProximityResponse } from '@seyra/contracts';
import { mapBounded } from '../concurrency.js';
import type { RoutingProvider } from './routing.js';

export interface GeographyDistance {
  /** Geodesic distances (metres, PostGIS geography on the WGS84 spheroid) from origin to each point. */
  distances(origin: { lon: number; lat: number }, points: { lon: number; lat: number }[], signal: AbortSignal): Promise<number[]>;
}

type Result = ProximityResponse['results'][number];

/**
 * Stateless ranking of the supplied candidate set only: no hidden shortlist, eligibility rules,
 * default direction or silent straight-line fallback for road metrics.
 */
export class ProximityService {
  constructor(
    private readonly routing: RoutingProvider,
    private readonly geography: GeographyDistance,
    private readonly limits: MapLimits,
  ) {}

  validate(req: ProximityRequest): void {
    if (req.candidates.length > this.limits.proximityMaxCandidates) {
      throw new MapServiceError('LIMIT_EXCEEDED', `at most ${this.limits.proximityMaxCandidates} candidates may be ranked`, {
        details: { limit: this.limits.proximityMaxCandidates, candidates: req.candidates.length },
      });
    }
    const ids = new Set<string>();
    for (const c of req.candidates) {
      if (ids.has(c.id)) throw new MapServiceError('INVALID_REQUEST', `duplicate candidate id "${c.id}"`, { details: { field: 'candidates' } });
      ids.add(c.id);
    }
    if (req.metric === 'straight_line') {
      if (req.profile !== undefined) {
        throw new MapServiceError('INVALID_REQUEST', 'profile applies only to road_distance and travel_time', { details: { field: 'profile' } });
      }
    } else if (req.profile === undefined) {
      throw new MapServiceError('INVALID_REQUEST', `${req.metric} requires an explicit road profile`, { details: { field: 'profile' } });
    }
  }

  async rank(req: ProximityRequest, datasetId: string, signal: AbortSignal): Promise<ProximityResponse> {
    this.validate(req);
    let results: Result[];
    if (req.metric === 'straight_line') {
      const d = await this.geography.distances(req.origin, req.candidates, signal);
      results = req.candidates.map((c, i) => ({
        id: c.id,
        input_index: i,
        rank: null,
        status: 'reachable',
        distance_m: Math.round(d[i]! * 100) / 100,
        duration_s: null,
      }));
    } else {
      const profile = req.profile!;
      const objective = req.metric === 'road_distance' ? 'distance' : 'time';
      results = await mapBounded(req.candidates, this.limits.providerConcurrency, async (c, i): Promise<Result> => {
        if (c.lon === req.origin.lon && c.lat === req.origin.lat) {
          return { id: c.id, input_index: i, rank: null, status: 'reachable', distance_m: 0, duration_s: 0 };
        }
        const [from, to] = req.direction === 'origin_to_candidate' ? [req.origin, c] : [c, req.origin];
        const outcome = await this.routing.pair(from, to, profile, objective, signal);
        return outcome.kind === 'route'
          ? { id: c.id, input_index: i, rank: null, status: 'reachable', distance_m: outcome.distance_m, duration_s: outcome.duration_s }
          : { id: c.id, input_index: i, rank: null, status: 'unreachable', distance_m: null, duration_s: null };
      });
    }
    const key: 'distance_m' | 'duration_s' = req.metric === 'travel_time' ? 'duration_s' : 'distance_m';
    const reachable = results
      .filter((r) => r.status === 'reachable')
      .sort((a, b) => a[key]! - b[key]! || a.input_index - b.input_index);
    reachable.forEach((r, i) => (r.rank = i + 1));
    const unreachable = results.filter((r) => r.status === 'unreachable').sort((a, b) => a.input_index - b.input_index);
    return {
      dataset_id: datasetId,
      metric: req.metric,
      direction: req.direction,
      profile: req.profile ?? null,
      provider: req.metric === 'straight_line' ? 'postgis' : 'valhalla',
      ranking_scope: 'supplied_candidates_only',
      ranked_by: key,
      units: UNITS,
      results: [...reachable, ...unreachable],
    };
  }
}
