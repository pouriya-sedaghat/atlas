import {
  MapServiceError,
  UNITS,
  type IdentifiedPoint,
  type MapLimits,
  type Objective,
  type OrderMode,
  type Profile,
  type RouteRequest,
  type RouteResponse,
} from '@seyra/contracts';
import { mapBounded } from '../concurrency.js';
import type { PairOutcome, ValhallaRouteResult, ValhallaTrip } from '../providers/valhalla.js';
import { solveFixedEndpoints } from './held-karp.js';

export interface RoutingProvider {
  route(points: { lon: number; lat: number }[], profile: Profile, objective: Objective, alternates: number, signal: AbortSignal): Promise<ValhallaRouteResult>;
  pair(from: { lon: number; lat: number }, to: { lon: number; lat: number }, profile: Profile, objective: Objective, signal: AbortSignal): Promise<PairOutcome>;
}

export interface ValidatedRoute {
  profile: Profile;
  objective: Objective;
  order: OrderMode;
  points: IdentifiedPoint[];
  alternatives: number;
}

/** Enforce the phase-1 routing support table; every rejection is typed. */
export function validateRouteRequest(req: RouteRequest, limits: MapLimits): ValidatedRoute {
  if (req.date_time !== undefined) {
    throw new MapServiceError('UNSUPPORTED_COMBINATION', 'date_time / time-dependent routing is not supported in phase 1', { details: { field: 'date_time' } });
  }
  if (req.live_traffic !== undefined) {
    throw new MapServiceError('UNSUPPORTED_COMBINATION', 'live traffic is not supported in phase 1', { details: { field: 'live_traffic' } });
  }
  const order: OrderMode = req.order ?? 'ordered';
  const alternatives = req.alternatives ?? 0;
  const n = req.points.length;
  const ids = new Set<string>();
  for (const p of req.points) {
    if (ids.has(p.id)) throw new MapServiceError('INVALID_REQUEST', `duplicate point id "${p.id}"; ids must be unique`, { details: { field: 'points' } });
    ids.add(p.id);
  }
  if (order === 'ordered') {
    if (n > limits.orderedMaxPoints) {
      throw new MapServiceError('LIMIT_EXCEEDED', `ordered routes accept at most ${limits.orderedMaxPoints} points`, { details: { limit: limits.orderedMaxPoints, points: n } });
    }
    if (alternatives > 0 && n > 2) {
      throw new MapServiceError('UNSUPPORTED_COMBINATION', 'alternatives are supported only for two-point ordered routes', { details: { alternatives, points: n } });
    }
  } else {
    if (alternatives > 0) {
      throw new MapServiceError('UNSUPPORTED_COMBINATION', 'alternatives cannot be combined with optimized visit order', { details: { alternatives, order } });
    }
    if (n > limits.optimizedMaxPoints) {
      throw new MapServiceError('LIMIT_EXCEEDED', `optimized order accepts at most ${limits.optimizedMaxPoints} points`, { details: { limit: limits.optimizedMaxPoints, points: n } });
    }
  }
  if (alternatives > limits.maxAlternatives) {
    throw new MapServiceError('LIMIT_EXCEEDED', `at most ${limits.maxAlternatives} additional routes may be requested`, { details: { limit: limits.maxAlternatives } });
  }
  return { profile: req.profile, objective: req.objective, order, points: req.points, alternatives };
}

const samePosition = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => a.lon === b.lon && a.lat === b.lat;

/** Integer pair cost used by the exact solver: milliseconds for time, metres for distance. */
export function pairCostUnits(objective: Objective, outcome: { distance_m: number; duration_s: number }): number {
  return objective === 'time' ? Math.round(outcome.duration_s * 1000) : Math.round(outcome.distance_m);
}

function toRoute(rank: number, trip: ValhallaTrip, points: IdentifiedPoint[]): RouteResponse['routes'][number] {
  return {
    rank,
    distance_m: trip.distance_m,
    duration_s: trip.duration_s,
    geometry: { type: 'LineString', coordinates: trip.coordinates },
    legs: trip.legs.map((leg, i) => ({ from_id: points[i]!.id, to_id: points[i + 1]!.id, distance_m: leg.distance_m, duration_s: leg.duration_s })),
  };
}

export class RoutingService {
  constructor(
    private readonly provider: RoutingProvider,
    private readonly limits: MapLimits,
  ) {}

  async route(v: ValidatedRoute, datasetId: string, signal: AbortSignal): Promise<RouteResponse> {
    if (v.order === 'optimized') return this.optimized(v, datasetId, signal);
    const result = await this.provider.route(v.points, v.profile, v.objective, v.alternatives, signal);
    const alternates = result.alternates.slice(0, v.alternatives);
    return {
      ...this.envelope(v, datasetId),
      visit_order: v.points.map((p, i) => ({ id: p.id, input_index: i })),
      alternatives_requested: v.alternatives,
      alternatives_returned: alternates.length,
      routes: [toRoute(0, result.primary, v.points), ...alternates.map((t, i) => toRoute(i + 1, t, v.points))],
    };
  }

  private envelope(v: ValidatedRoute, datasetId: string) {
    return {
      dataset_id: datasetId,
      provider: 'valhalla' as const,
      profile: v.profile,
      objective: v.objective,
      order: v.order,
      route_optimality: 'not_guaranteed' as const,
      duration_semantics: 'static_estimate' as const,
      units: UNITS,
      coordinate_order: 'lon,lat' as const,
    };
  }

  private async optimized(v: ValidatedRoute, datasetId: string, signal: AbortSignal): Promise<RouteResponse> {
    const n = v.points.length;
    const unit = v.objective === 'time' ? ('s' as const) : ('m' as const);
    const table = new Map<string, number>();
    let unreachable = 0;
    let computed = 0;
    if (n >= 3) {
      const pairs: [number, number][] = [];
      const end = n - 1;
      for (let k = 1; k < end; k++) pairs.push([0, k], [k, end]);
      for (let j = 1; j < end; j++) for (let k = 1; k < end; k++) if (j !== k) pairs.push([j, k]);
      // Provider failures abort the whole optimization; only genuine no-path becomes Infinity.
      await mapBounded(pairs, this.limits.providerConcurrency, async ([i, j]) => {
        const a = v.points[i]!;
        const b = v.points[j]!;
        let c: number;
        if (samePosition(a, b)) {
          c = 0; // duplicate coordinates are separate stops with zero modeled cost
        } else {
          const outcome = await this.provider.pair(a, b, v.profile, v.objective, signal);
          computed++;
          if (outcome.kind === 'route') c = pairCostUnits(v.objective, outcome);
          else {
            c = Infinity;
            unreachable++;
          }
        }
        table.set(`${i}:${j}`, c);
      });
    }
    const solution =
      n >= 3
        ? solveFixedEndpoints(n, (i, j) => table.get(`${i}:${j}`) ?? Infinity)
        : { order: [0, 1], cost: NaN };
    if (!solution) {
      throw new MapServiceError('NO_ROUTE', 'no visit order with a finite modeled cost exists; no stop is omitted', {
        provider: 'valhalla',
        details: { unreachable_pairs: unreachable, pair_routes_computed: computed },
      });
    }
    const ordered = solution.order.map((i) => v.points[i]!);
    let result: ValhallaRouteResult;
    try {
      result = await this.provider.route(ordered, v.profile, v.objective, 0, signal);
    } catch (err) {
      if (err instanceof MapServiceError && (err.code === 'NO_ROUTE' || err.code === 'POINT_NOT_ROUTABLE')) {
        throw new MapServiceError(err.code, 'the final multi-stop route failed although the modeled pair table was finite', {
          provider: 'valhalla',
          details: { visit_order: ordered.map((p) => p.id) },
        });
      }
      throw err;
    }
    const finalCost = v.objective === 'time' ? result.primary.duration_s : result.primary.distance_m;
    const modeled = n >= 3 ? (v.objective === 'time' ? solution.cost / 1000 : solution.cost) : finalCost;
    return {
      ...this.envelope(v, datasetId),
      visit_order: solution.order.map((i) => ({ id: v.points[i]!.id, input_index: i })),
      alternatives_requested: 0,
      alternatives_returned: 0,
      optimization: {
        method: 'held_karp_directed_pair_costs',
        visit_order_optimal_for_pair_costs: true,
        modeled_cost: modeled,
        modeled_cost_unit: unit,
        pair_routes_computed: computed,
        unreachable_pairs: unreachable,
        final_route_cost: finalCost,
        note:
          n >= 3
            ? 'Order is exact only for the modeled directed two-point pair-cost table; road-route optimality is not guaranteed and the final multi-stop route total can differ.'
            : 'Two points: the input order is the only order; no reordering was performed.',
      },
      routes: [toRoute(0, result.primary, ordered)],
    };
  }
}
