/**
 * Versioned operational limits for Map Services phase 1 (requirements v1.0).
 *
 * These are reference defaults, not measured production capacity. They may be tightened
 * through configuration; they are never feature switches and cannot disable a capability.
 */
export const LIMITS_VERSION = '1.0.0';

export interface MapLimits {
  readonly orderedMaxPoints: number;
  readonly optimizedMaxPoints: number;
  readonly maxAlternatives: number;
  readonly proximityMaxCandidates: number;
  readonly searchMinResults: number;
  readonly searchMaxResults: number;
  readonly queryMaxCodePoints: number;
  readonly poiMaxBboxKm2: number;
  readonly poiMaxResults: number;
  readonly overpassTimeoutS: number;
  readonly overpassMaxSizeBytes: number;
  readonly providerConcurrency: number;
  readonly providerQueueSize: number;
  readonly routeDeadlineMs: number;
  readonly optimizeDeadlineMs: number;
  readonly searchDeadlineMs: number;
  readonly poiDeadlineMs: number;
  readonly reverseMaxRadiusM: number;
}

export const DEFAULT_LIMITS: MapLimits = Object.freeze({
  orderedMaxPoints: 25,
  optimizedMaxPoints: 10,
  maxAlternatives: 2,
  proximityMaxCandidates: 50,
  searchMinResults: 1,
  searchMaxResults: 20,
  queryMaxCodePoints: 256,
  poiMaxBboxKm2: 100,
  poiMaxResults: 200,
  overpassTimeoutS: 10,
  overpassMaxSizeBytes: 64 * 1024 * 1024,
  providerConcurrency: 4,
  providerQueueSize: 64,
  routeDeadlineMs: 30_000,
  optimizeDeadlineMs: 120_000,
  searchDeadlineMs: 10_000,
  poiDeadlineMs: 15_000,
  reverseMaxRadiusM: 5_000,
});

/**
 * The exact visit-order solver is exponential (Held–Karp, O(2^n · n^2)). Raising the optimized
 * point cap above this hard ceiling requires a deliberate algorithm/resource review.
 */
export const OPTIMIZED_HARD_CEILING = 10;

/** Validate an operator-supplied limits override: may only tighten, never disable or raise caps. */
export function tightenLimits(base: MapLimits, override: Partial<MapLimits>): MapLimits {
  const result: Record<string, number> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (!(key in base)) throw new Error(`unknown limit: ${key}`);
    const current = base[key as keyof MapLimits];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`limit ${key} must be a positive finite number (capabilities cannot be disabled)`);
    }
    if (key === 'searchMinResults') {
      if (value < current) throw new Error(`limit ${key} may only be raised toward searchMaxResults`);
    } else if (value > current) {
      throw new Error(`limit ${key}=${value} exceeds the versioned default ${current}; raising limits requires a requirements/resource review`);
    }
    result[key] = value;
  }
  if (result.optimizedMaxPoints! > OPTIMIZED_HARD_CEILING) {
    throw new Error('optimizedMaxPoints exceeds the reviewed exact-solver ceiling');
  }
  if (result.searchMinResults! > result.searchMaxResults!) {
    throw new Error('searchMinResults cannot exceed searchMaxResults');
  }
  return Object.freeze(result) as unknown as MapLimits;
}
