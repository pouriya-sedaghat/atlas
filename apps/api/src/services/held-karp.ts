import { OPTIMIZED_HARD_CEILING } from '@seyra/contracts';

export interface OrderSolution {
  /** Visit order as indices into the input points; always starts at 0 and ends at n-1. */
  order: number[];
  /** Sum of modeled pair costs along `order` (same integer unit as the input table). */
  cost: number;
}

/**
 * Exact fixed-endpoint shortest Hamiltonian path over a directed cost table (Held–Karp DP).
 *
 * - `cost(i, j)` must be a non-negative integer or `Infinity` (no modeled path from i to j).
 * - Point 0 is the fixed start and point n-1 the fixed end; every intermediate is visited once.
 * - Ties are broken deterministically: the lexicographically smallest index sequence wins.
 * - Returns null when no order with finite cost exists.
 *
 * Exactness holds only for this finite additive table; it says nothing about road paths that
 * the table does not model (turn state, stop snapping, live traffic, ...).
 */
export function solveFixedEndpoints(n: number, cost: (from: number, to: number) => number): OrderSolution | null {
  if (!Number.isInteger(n) || n < 2) throw new Error('at least two points are required');
  if (n > OPTIMIZED_HARD_CEILING) throw new Error(`exact solver ceiling is ${OPTIMIZED_HARD_CEILING} points`);
  const end = n - 1;
  if (n === 2) {
    const c = cost(0, 1);
    return Number.isFinite(c) ? { order: [0, 1], cost: c } : null;
  }
  const m = n - 2; // intermediates are nodes 1..m; bit (k-1) marks node k
  const full = (1 << m) - 1;
  // f[mask * n + j]: min cost to finish from intermediate j having visited `mask` (j ∈ mask).
  const f = new Float64Array((full + 1) * n).fill(Infinity);
  for (let j = 1; j <= m; j++) f[full * n + j] = cost(j, end);
  for (let mask = full - 1; mask > 0; mask--) {
    for (let j = 1; j <= m; j++) {
      if (!(mask & (1 << (j - 1)))) continue;
      let best = Infinity;
      for (let k = 1; k <= m; k++) {
        const bit = 1 << (k - 1);
        if (mask & bit) continue;
        const v = cost(j, k) + f[(mask | bit) * n + k]!;
        if (v < best) best = v;
      }
      f[mask * n + j] = best;
    }
  }
  let total = Infinity;
  for (let k = 1; k <= m; k++) {
    const v = cost(0, k) + f[(1 << (k - 1)) * n + k]!;
    if (v < total) total = v;
  }
  if (!Number.isFinite(total)) return null;

  // Forward reconstruction choosing the smallest index that preserves optimality.
  const order = [0];
  let mask = 0;
  let current = 0;
  let remaining = total;
  for (let step = 0; step < m; step++) {
    let chosen = -1;
    for (let k = 1; k <= m; k++) {
      const bit = 1 << (k - 1);
      if (mask & bit) continue;
      const v = cost(current, k) + f[(mask | bit) * n + k]!;
      if (v === remaining) {
        chosen = k;
        break;
      }
    }
    if (chosen < 0) throw new Error('internal: Held–Karp reconstruction failed');
    const bit = 1 << (chosen - 1);
    remaining -= cost(current, chosen);
    mask |= bit;
    current = chosen;
    order.push(chosen);
  }
  order.push(end);
  return { order, cost: total };
}
