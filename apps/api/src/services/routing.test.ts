import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MapServiceError, type IdentifiedPoint, type Objective, type RouteRequest } from '@seyra/contracts';
import type { PairOutcome, ValhallaRouteResult } from '../providers/valhalla.js';
import { RoutingService, validateRouteRequest, type RoutingProvider } from './routing.js';

const pts = (n: number): IdentifiedPoint[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, lon: 51 + i * 0.01, lat: 35 + (i % 3) * 0.01 }));
const req = (over: Partial<RouteRequest>): RouteRequest => ({ profile: 'car', objective: 'time', points: pts(2), ...over });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof MapServiceError ? err.code : 'other';
  }
  return undefined;
}

describe('routing support table validation (AC10)', () => {
  it('accepts every supported cell', () => {
    for (const profile of ['car', 'pedestrian', 'motorcycle'] as const) {
      for (const objective of ['time', 'distance'] as const) {
        expect(code(() => validateRouteRequest(req({ profile, objective, alternatives: 2 }), DEFAULT_LIMITS))).toBeUndefined();
        expect(code(() => validateRouteRequest(req({ profile, objective, points: pts(25) }), DEFAULT_LIMITS))).toBeUndefined();
        expect(code(() => validateRouteRequest(req({ profile, objective, order: 'optimized', points: pts(10) }), DEFAULT_LIMITS))).toBeUndefined();
        expect(code(() => validateRouteRequest(req({ profile, objective, order: 'optimized', points: pts(2) }), DEFAULT_LIMITS))).toBeUndefined();
      }
    }
  });

  it('rejects unsupported combinations with typed errors', () => {
    expect(code(() => validateRouteRequest(req({ points: pts(3), alternatives: 1 }), DEFAULT_LIMITS))).toBe('UNSUPPORTED_COMBINATION');
    expect(code(() => validateRouteRequest(req({ order: 'optimized', points: pts(4), alternatives: 1 }), DEFAULT_LIMITS))).toBe('UNSUPPORTED_COMBINATION');
    expect(code(() => validateRouteRequest(req({ date_time: { type: 1, value: '2026-10-14T08:00' } }), DEFAULT_LIMITS))).toBe('UNSUPPORTED_COMBINATION');
    expect(code(() => validateRouteRequest(req({ live_traffic: true }), DEFAULT_LIMITS))).toBe('UNSUPPORTED_COMBINATION');
  });

  it('rejects limit violations and duplicate ids', () => {
    expect(code(() => validateRouteRequest(req({ points: pts(26) }), DEFAULT_LIMITS))).toBe('LIMIT_EXCEEDED');
    expect(code(() => validateRouteRequest(req({ order: 'optimized', points: pts(11) }), DEFAULT_LIMITS))).toBe('LIMIT_EXCEEDED');
    expect(code(() => validateRouteRequest(req({ alternatives: 3 }), DEFAULT_LIMITS))).toBe('LIMIT_EXCEEDED');
    const dup = pts(3);
    dup[2] = { ...dup[2]!, id: 'p0' };
    expect(code(() => validateRouteRequest(req({ points: dup }), DEFAULT_LIMITS))).toBe('INVALID_REQUEST');
  });
});

/** Fixture provider over an explicit directed table keyed by point position (unit-test isolation only). */
class TableProvider implements RoutingProvider {
  calls = 0;
  constructor(
    private readonly table: Map<string, number | 'fail' | 'none'>,
    private readonly finalFactor = 1,
  ) {}
  private key(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
    return `${a.lon},${a.lat}>${b.lon},${b.lat}`;
  }
  async pair(a: { lon: number; lat: number }, b: { lon: number; lat: number }, _p: unknown, objective: Objective): Promise<PairOutcome> {
    this.calls++;
    const v = this.table.get(this.key(a, b));
    if (v === 'fail' || v === undefined) throw new MapServiceError('PROVIDER_ERROR', 'boom', { provider: 'valhalla' });
    if (v === 'none') return { kind: 'no_route', code: 'NO_ROUTE' };
    return objective === 'time' ? { kind: 'route', distance_m: v * 10, duration_s: v } : { kind: 'route', distance_m: v, duration_s: v / 10 };
  }
  async route(points: { lon: number; lat: number }[]): Promise<ValhallaRouteResult> {
    let total = 0;
    const legs = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const v = this.table.get(this.key(points[i]!, points[i + 1]!));
      const c = typeof v === 'number' ? v : 0;
      total += c;
      legs.push({ distance_m: c * 10, duration_s: c * this.finalFactor });
    }
    return {
      primary: { distance_m: total * 10, duration_s: total * this.finalFactor, legs, coordinates: points.map((p) => [p.lon, p.lat] as [number, number]) },
      alternates: [],
    };
  }
}

function tableFor(points: IdentifiedPoint[], cost: (i: number, j: number) => number | 'fail' | 'none') {
  const t = new Map<string, number | 'fail' | 'none'>();
  points.forEach((a, i) => points.forEach((b, j) => i !== j && t.set(`${a.lon},${a.lat}>${b.lon},${b.lat}`, cost(i, j))));
  return t;
}

describe('optimized order service', () => {
  it('reorders by the modeled pair table and reports modeled vs final totals separately', async () => {
    const p = pts(5);
    // cheapest: 0 -> 3 -> 1 -> 2 -> 4
    const cheap = new Set(['0:3', '3:1', '1:2', '2:4']);
    const prov = new TableProvider(tableFor(p, (i, j) => (cheap.has(`${i}:${j}`) ? 10 : 100)), 1.5);
    const svc = new RoutingService(prov, DEFAULT_LIMITS);
    const res = await svc.route({ profile: 'motorcycle', objective: 'time', order: 'optimized', points: p, alternatives: 0 }, 'ds-test', new AbortController().signal);
    expect(res.visit_order.map((v) => v.input_index)).toEqual([0, 3, 1, 2, 4]);
    expect(res.optimization?.visit_order_optimal_for_pair_costs).toBe(true);
    expect(res.optimization?.modeled_cost).toBe(40);
    expect(res.optimization?.final_route_cost).toBe(60); // final route measured separately
    expect(res.route_optimality).toBe('not_guaranteed');
    expect(res.optimization?.pair_routes_computed).toBe(3 + 3 + 6);
    expect(res.routes[0]!.legs.map((l) => `${l.from_id}>${l.to_id}`)).toEqual(['p0>p3', 'p3>p1', 'p1>p2', 'p2>p4']);
  });

  it('distinguishes provider failure from genuinely missing paths', async () => {
    const p = pts(4);
    const failing = new RoutingService(new TableProvider(tableFor(p, (i, j) => (i === 1 && j === 2 ? 'fail' : 5))), DEFAULT_LIMITS);
    await expect(failing.route({ profile: 'car', objective: 'distance', order: 'optimized', points: p, alternatives: 0 }, 'ds', new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    const isolated = new RoutingService(new TableProvider(tableFor(p, (i, j) => (i === 2 || j === 2 ? 'none' : 5))), DEFAULT_LIMITS);
    await expect(isolated.route({ profile: 'car', objective: 'distance', order: 'optimized', points: p, alternatives: 0 }, 'ds', new AbortController().signal)).rejects.toMatchObject({
      code: 'NO_ROUTE',
    });
  });

  it('gives duplicate coordinates zero cost without a provider call and keeps both stops', async () => {
    const p = pts(4);
    p[2] = { ...p[2]!, lon: p[1]!.lon, lat: p[1]!.lat };
    const prov = new TableProvider(tableFor(p, () => 7));
    const res = await new RoutingService(prov, DEFAULT_LIMITS).route(
      { profile: 'pedestrian', objective: 'distance', order: 'optimized', points: p, alternatives: 0 },
      'ds',
      new AbortController().signal,
    );
    expect(res.visit_order.map((v) => v.id).sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(prov.calls).toBe(4); // 0->1,0->2,1->3,2->3 routed; 1<->2 identical coordinates
  });

  it('two-point optimized requests keep input order', async () => {
    const p = pts(2);
    const res = await new RoutingService(new TableProvider(tableFor(p, () => 3)), DEFAULT_LIMITS).route(
      { profile: 'car', objective: 'time', order: 'optimized', points: p, alternatives: 0 },
      'ds',
      new AbortController().signal,
    );
    expect(res.visit_order.map((v) => v.id)).toEqual(['p0', 'p1']);
    expect(res.optimization?.pair_routes_computed).toBe(0);
  });
});
