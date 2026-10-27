import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MapServiceError, type Objective } from '@seyra/contracts';
import type { PairOutcome } from '../providers/valhalla.js';
import type { RoutingProvider } from './routing.js';
import { ProximityService } from './proximity.js';

const origin = { lon: 51.4, lat: 35.7 };
const cand = (id: string, lon: number) => ({ id, lon, lat: 35.7 });

class DirectionalProvider implements Omit<RoutingProvider, 'route'> {
  calls: string[] = [];
  constructor(private readonly f: (from: number, to: number, objective: Objective) => PairOutcome | 'fail') {}
  async pair(a: { lon: number }, b: { lon: number }, _p: unknown, objective: Objective): Promise<PairOutcome> {
    this.calls.push(`${a.lon}>${b.lon}:${objective}`);
    const r = this.f(a.lon, b.lon, objective);
    if (r === 'fail') throw new MapServiceError('PROVIDER_UNAVAILABLE', 'down', { provider: 'valhalla' });
    return r;
  }
}

const geography = { distances: async (_o: unknown, ps: { lon: number }[]) => ps.map((p) => Math.abs(p.lon - origin.lon) * 90_000) };

function service(f: ConstructorParameters<typeof DirectionalProvider>[0]) {
  const prov = new DirectionalProvider(f);
  return { prov, svc: new ProximityService(prov as unknown as RoutingProvider, geography, DEFAULT_LIMITS) };
}

describe('proximity ranking (AC13)', () => {
  it('requires an explicit road profile for road metrics and rejects it for straight_line', async () => {
    const { svc } = service(() => ({ kind: 'route', distance_m: 1, duration_s: 1 }));
    expect(() => svc.validate({ metric: 'travel_time', direction: 'origin_to_candidate', origin, candidates: [cand('a', 51.5)] })).toThrow(/profile/);
    expect(() => svc.validate({ metric: 'straight_line', direction: 'origin_to_candidate', profile: 'car', origin, candidates: [cand('a', 51.5)] })).toThrow(/profile/);
  });

  it('routes in the requested direction (asymmetric one-way costs)', async () => {
    // From origin it is cheap to reach 'east'; coming back from 'east' is expensive.
    const f = (from: number, to: number): PairOutcome => ({ kind: 'route', distance_m: 100, duration_s: from === origin.lon && to > from ? 60 : 600 });
    const a = service(f);
    const out = await a.svc.rank({ metric: 'travel_time', direction: 'origin_to_candidate', profile: 'car', origin, candidates: [cand('east', 51.5), cand('west', 51.3)] }, 'ds', new AbortController().signal);
    expect(out.results.map((r) => [r.id, r.duration_s])).toEqual([
      ['east', 60],
      ['west', 600],
    ]);
    const b = service(f);
    const back = await b.svc.rank({ metric: 'travel_time', direction: 'candidate_to_origin', profile: 'car', origin, candidates: [cand('east', 51.5), cand('west', 51.3)] }, 'ds', new AbortController().signal);
    expect(back.results.every((r) => r.duration_s === 600)).toBe(true);
    expect(b.prov.calls).toEqual(expect.arrayContaining([`51.5>${origin.lon}:time`, `51.3>${origin.lon}:time`]));
  });

  it('uses the distance objective for road_distance and keeps ties stable by input order', async () => {
    const { svc, prov } = service(() => ({ kind: 'route', distance_m: 500, duration_s: 50 }));
    const out = await svc.rank({ metric: 'road_distance', direction: 'origin_to_candidate', profile: 'pedestrian', origin, candidates: [cand('b', 51.6), cand('a', 51.5)] }, 'ds', new AbortController().signal);
    expect(out.results.map((r) => [r.id, r.rank])).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    expect(prov.calls.every((c) => c.endsWith(':distance'))).toBe(true);
    expect(out.ranked_by).toBe('distance_m');
  });

  it('reports unreachable candidates explicitly, never substituting straight-line values', async () => {
    const { svc } = service((_f, to) => (to === 51.9 ? { kind: 'no_route', code: 'NO_ROUTE' } : { kind: 'route', distance_m: 10, duration_s: 1 }));
    const out = await svc.rank({ metric: 'travel_time', direction: 'origin_to_candidate', profile: 'motorcycle', origin, candidates: [cand('island', 51.9), cand('ok', 51.5)] }, 'ds', new AbortController().signal);
    expect(out.results).toEqual([
      { id: 'ok', input_index: 1, rank: 1, status: 'reachable', distance_m: 10, duration_s: 1 },
      { id: 'island', input_index: 0, rank: null, status: 'unreachable', distance_m: null, duration_s: null },
    ]);
  });

  it('fails the request on provider failure instead of ranking a partial set', async () => {
    const { svc } = service(() => 'fail');
    await expect(
      svc.rank({ metric: 'road_distance', direction: 'origin_to_candidate', profile: 'car', origin, candidates: [cand('a', 51.5)] }, 'ds', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('ranks straight-line distance over the whole supplied set and enforces the cap', async () => {
    const { svc } = service(() => 'fail');
    const out = await svc.rank({ metric: 'straight_line', direction: 'candidate_to_origin', origin, candidates: [cand('far', 52), cand('near', 51.41)] }, 'ds', new AbortController().signal);
    expect(out.results.map((r) => r.id)).toEqual(['near', 'far']);
    expect(out.provider).toBe('postgis');
    const many = Array.from({ length: 51 }, (_, i) => cand(`c${i}`, 51 + i / 100));
    expect(() => svc.validate({ metric: 'straight_line', direction: 'origin_to_candidate', origin, candidates: many })).toThrow(MapServiceError);
  });
});
