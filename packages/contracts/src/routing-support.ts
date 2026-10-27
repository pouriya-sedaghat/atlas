import type { MapLimits } from './limits.js';

export const PROFILES = ['car', 'pedestrian', 'motorcycle'] as const;
export type Profile = (typeof PROFILES)[number];

export const OBJECTIVES = ['time', 'distance'] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const ORDER_MODES = ['ordered', 'optimized'] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

export interface SupportCell {
  readonly order: OrderMode;
  readonly min_points: number;
  readonly max_points: number;
  readonly objectives: readonly Objective[];
  readonly profiles: readonly Profile[];
  readonly max_alternatives: number;
  readonly note: string;
}

/** Routing support table (requirements v1.0), exported verbatim in capabilities metadata. */
export function routingSupportTable(limits: MapLimits): SupportCell[] {
  return [
    {
      order: 'ordered',
      min_points: 2,
      max_points: 2,
      objectives: [...OBJECTIVES],
      profiles: [...PROFILES],
      max_alternatives: limits.maxAlternatives,
      note: 'Up to max_alternatives additional routes; the provider may return fewer or none.',
    },
    {
      order: 'ordered',
      min_points: 3,
      max_points: limits.orderedMaxPoints,
      objectives: [...OBJECTIVES],
      profiles: [...PROFILES],
      max_alternatives: 0,
      note: 'Multipoint alternatives are unsupported in phase 1 (UNSUPPORTED_COMBINATION).',
    },
    {
      order: 'optimized',
      min_points: 2,
      max_points: 2,
      objectives: [...OBJECTIVES],
      profiles: [...PROFILES],
      max_alternatives: 0,
      note: 'Two points: input order is returned; no reordering, no alternatives.',
    },
    {
      order: 'optimized',
      min_points: 3,
      max_points: limits.optimizedMaxPoints,
      objectives: [...OBJECTIVES],
      profiles: [...PROFILES],
      max_alternatives: 0,
      note: 'Fixed first/last points; exact Held–Karp order over the modeled directed pair-cost table only.',
    },
  ];
}

export const UNSUPPORTED_COMBINATIONS = [
  'alternatives with more than 2 points',
  'alternatives with optimized order',
  'date_time / time-dependent routing',
  'live traffic',
  'point counts above the configured limits',
] as const;

/** Mapping from Seyra profile to the pinned Valhalla costing model. */
export const VALHALLA_COSTING: Readonly<Record<Profile, string>> = Object.freeze({
  car: 'auto',
  pedestrian: 'pedestrian',
  motorcycle: 'motorcycle',
});
