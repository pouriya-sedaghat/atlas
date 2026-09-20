/**
 * Travel profiles and direction values, as Studio understands them.
 *
 * Everything here is pure: given wire data it returns decisions, and it never
 * touches the DOM, the map or the network. Switching profile is therefore a
 * local recomputation, not a new query.
 *
 * "Profile" is a Studio word. The API calls these modes, and the mapping
 * between the two lives here so that renaming a button never reaches the wire.
 */

import type { RoadProperties, RoadTraversal } from '../api/types.js';

/** Every direction value the Atlas v1 API can send. */
export const TRAVEL_DIRECTIONS = [
  'both',
  'forward',
  'reverse',
  'reversible',
  'alternating',
  'indeterminate',
] as const;

export type TravelDirection = (typeof TRAVEL_DIRECTIONS)[number];

/** The profiles the selector offers, in the order it offers them. */
export const TRAVEL_PROFILES = ['motorcar', 'bicycle', 'foot'] as const;

export type TravelProfile = (typeof TRAVEL_PROFILES)[number];

/** Car is the default because it is the profile most one-way data describes. */
export const DEFAULT_PROFILE: TravelProfile = 'motorcar';

export const PROFILE_LABELS: Record<TravelProfile, string> = {
  motorcar: 'Car',
  bicycle: 'Bicycle',
  foot: 'Foot',
};

/**
 * What each direction is called in the inspector.
 *
 * The two dynamic values and the indeterminate one say plainly that Atlas is
 * not stating a fixed direction, because the map deliberately draws no arrow
 * for them and a reader should not have to guess why.
 */
export const DIRECTION_LABELS: Record<TravelDirection, string> = {
  both: 'Two-way',
  forward: 'One-way · forward',
  reverse: 'One-way · reverse',
  reversible: 'Reversible · direction changes',
  alternating: 'Alternating · direction changes',
  indeterminate: 'Indeterminate · not stated',
};

/** The prefix Studio flattens the nested traversal block onto. */
export const DIRECTION_PROPERTY_PREFIX = 'direction:';

const KNOWN_DIRECTIONS = new Set<string>(TRAVEL_DIRECTIONS);
const KNOWN_PROFILES = new Set<string>(TRAVEL_PROFILES);

/**
 * Narrows an untrusted wire value to a direction.
 *
 * Anything Studio does not recognise reads as `indeterminate`, which is the
 * one answer that cannot be wrong: it draws no arrow and says so.
 */
export function parseDirection(value: unknown): TravelDirection {
  return typeof value === 'string' && KNOWN_DIRECTIONS.has(value)
    ? (value as TravelDirection)
    : 'indeterminate';
}

export function isTravelProfile(value: unknown): value is TravelProfile {
  return typeof value === 'string' && KNOWN_PROFILES.has(value);
}

/** One direction per profile, always complete. */
export type ProfileDirections = Record<TravelProfile, TravelDirection>;

/** Reads a traversal block, filling in anything the server left out. */
export function readTraversal(traversal: RoadTraversal | undefined): ProfileDirections {
  return {
    motorcar: parseDirection(traversal?.motorcar?.direction),
    bicycle: parseDirection(traversal?.bicycle?.direction),
    foot: parseDirection(traversal?.foot?.direction),
  };
}

/** Reads the traversal of one feature's properties. */
export function readFeatureDirections(properties: RoadProperties): ProfileDirections {
  return readTraversal(properties.traversal);
}

/** Which direction applies to one profile. */
export function directionFor(properties: RoadProperties, profile: TravelProfile): TravelDirection {
  return readFeatureDirections(properties)[profile];
}

/** The flattened MapLibre property name for a profile. */
export function directionPropertyKey(profile: TravelProfile): string {
  return `${DIRECTION_PROPERTY_PREFIX}${profile}`;
}

/**
 * Flattens a nested traversal block into MapLibre-friendly properties.
 *
 * MapLibre expressions cannot reach into a nested object, so the adapter
 * flattens. This is a rendering concern and it stops here: the API keeps the
 * nested shape, and so does everything the inspector reads.
 */
export function directionProperties(
  traversal: RoadTraversal | undefined,
): Record<string, TravelDirection> {
  const directions = readTraversal(traversal);
  const flattened: Record<string, TravelDirection> = {};
  for (const profile of TRAVEL_PROFILES) {
    flattened[directionPropertyKey(profile)] = directions[profile];
  }
  return flattened;
}

/** Which way an arrow should point, or `null` for no arrow at all. */
export type ArrowDirection = 'forward' | 'reverse';

/**
 * The rendering decision for one direction.
 *
 * Only the two static one-way values earn an arrow. A two-way road has no
 * one-way direction to draw, and the dynamic and indeterminate values have no
 * direction Atlas is willing to state, so inventing a static arrow for them
 * would be the map telling a lie the data never told.
 */
export function arrowFor(direction: TravelDirection): ArrowDirection | null {
  return direction === 'forward' || direction === 'reverse' ? direction : null;
}

/** Whether the direction genuinely changes over time. */
export function isDynamicDirection(direction: TravelDirection): boolean {
  return direction === 'reversible' || direction === 'alternating';
}

/** Whether Atlas declined to state a direction at all. */
export function isIndeterminateDirection(direction: TravelDirection): boolean {
  return direction === 'indeterminate';
}

/** The inspector label for a direction. */
export function directionLabel(direction: TravelDirection): string {
  return DIRECTION_LABELS[direction];
}
