import { describe, expect, it } from 'vitest';
import { solveFixedEndpoints } from './held-karp.js';

/** Independent oracle: enumerate every permutation of intermediates in lexicographic order. */
function bruteForce(n: number, cost: (i: number, j: number) => number): { order: number[]; cost: number } | null {
  const inter = Array.from({ length: n - 2 }, (_, i) => i + 1);
  let best: { order: number[]; cost: number } | null = null;
  const permute = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) {
      const order = [0, ...prefix, n - 1];
      let c = 0;
      for (let i = 0; i + 1 < order.length; i++) c += cost(order[i]!, order[i + 1]!);
      if (Number.isFinite(c) && (best === null || c < best.cost)) best = { order, cost: c };
      return;
    }
    for (let i = 0; i < rest.length; i++) permute([...prefix, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
  };
  permute([], inter);
  return best;
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Held–Karp fixed-endpoint order (AC12)', () => {
  it('matches brute force on random directed tables, including unreachable pairs and ties', () => {
    const rnd = mulberry32(20261014);
    let compared = 0;
    for (let trial = 0; trial < 600; trial++) {
      const n = 2 + (trial % 8); // 2..9 points
      const table: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
      const tieHeavy = trial % 3 === 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const r = rnd();
          table[i]![j] = r < 0.12 ? Infinity : tieHeavy ? 1 + Math.floor(rnd() * 3) : Math.floor(rnd() * 100_000);
        }
      }
      const cost = (i: number, j: number) => table[i]![j]!;
      const expected = bruteForce(n, cost);
      const actual = solveFixedEndpoints(n, cost);
      if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).not.toBeNull();
        expect(actual!.cost).toBe(expected.cost);
        // brute force enumerates lexicographically and keeps the first optimum => same tie-break.
        expect(actual!.order).toEqual(expected.order);
      }
      compared++;
    }
    expect(compared).toBe(600);
  });

  it('keeps endpoints fixed and visits every intermediate exactly once (10 points)', () => {
    const n = 10;
    const coords = Array.from({ length: n }, (_, i) => [Math.cos(i * 1.7) * 100, Math.sin(i * 2.3) * 100] as const);
    const cost = (i: number, j: number) => Math.round(Math.hypot(coords[i]![0] - coords[j]![0], coords[i]![1] - coords[j]![1]) * 1000) + (i < j ? 7 : 0);
    const sol = solveFixedEndpoints(n, cost)!;
    expect(sol.order[0]).toBe(0);
    expect(sol.order[n - 1]).toBe(n - 1);
    expect([...sol.order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    expect(sol.cost).toBe(bruteForce(n, cost)!.cost);
  });

  it('handles duplicate coordinates (zero-cost pairs) deterministically', () => {
    // points 1 and 2 share a coordinate: cost between them is 0 both ways
    const t = [
      [0, 5, 5, 9],
      [5, 0, 0, 4],
      [5, 0, 0, 4],
      [9, 4, 4, 0],
    ];
    const sol = solveFixedEndpoints(4, (i, j) => t[i]![j]!)!;
    expect(sol).toEqual({ order: [0, 1, 2, 3], cost: 9 });
  });

  it('returns null when no finite order exists (disconnected stop)', () => {
    const t = [
      [0, 1, Infinity, 1],
      [1, 0, Infinity, 1],
      [Infinity, Infinity, 0, Infinity],
      [1, 1, Infinity, 0],
    ];
    expect(solveFixedEndpoints(4, (i, j) => t[i]![j]!)).toBeNull();
  });

  it('respects direction (asymmetric costs)', () => {
    // 0 -> 1 -> 2 -> 3 is cheap only in this direction
    const t = [
      [0, 1, 100, 100],
      [100, 0, 1, 100],
      [100, 100, 0, 1],
      [100, 100, 100, 0],
    ];
    expect(solveFixedEndpoints(4, (i, j) => t[i]![j]!)).toEqual({ order: [0, 1, 2, 3], cost: 3 });
  });

  it('refuses inputs above the reviewed ceiling', () => {
    expect(() => solveFixedEndpoints(11, () => 1)).toThrow();
  });
});
