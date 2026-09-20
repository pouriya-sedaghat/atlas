/**
 * Access rules, as Studio understands them.
 *
 * Everything here is pure: given wire data it returns decisions, and it never
 * touches the DOM, the map or the network. Switching profile is therefore a
 * local recomputation, not a new query.
 *
 * Two things are worth knowing before reading on.
 *
 * Access is not direction. A road can be one-way *and* prohibited, and the two
 * are drawn by different layers from different properties. Nothing in this
 * file looks at a direction, and nothing in `traversal.ts` looks at an access.
 *
 * Access is not a routing answer. `restricted` here means "the source attached
 * a condition to using this road", not "you may not go". Deciding what a
 * destination restriction or a permit requirement means for a given journey is
 * a routing profile's job, and Atlas has no routing profiles yet.
 */

import type { RoadProperties, RoadTraversal } from '../api/types.js';
import { TRAVEL_PROFILES, type TravelProfile } from './traversal.js';

/** Every access value the Atlas v1 API can send, in the API's own order. */
export const ACCESS_RULES = [
  'unspecified',
  'allowed',
  'designated',
  'permissive',
  'discouraged',
  'destination-only',
  'customers-only',
  'delivery-only',
  'agricultural-only',
  'forestry-only',
  'military-only',
  'private',
  'permit-required',
  'dismount-required',
  'use-sidepath',
  'prohibited',
  'variable',
  'conditional',
  'indeterminate',
] as const;

export type AccessRule = (typeof ACCESS_RULES)[number];

/**
 * How the map treats one rule.
 *
 * Four categories, because four is how many distinguishable things a reader
 * can hold at once on a map that is already coloured by road class:
 *
 * - `ordinary` — nothing to draw. The mode is not held back by the source.
 * - `restricted` — usable on some stated condition. Amber.
 * - `prohibited` — the source says no. Red.
 * - `uncertain` — the answer changes, or Atlas could not derive one. Purple.
 *
 * `unspecified` sits in `ordinary` for *drawing* only. It is emphatically not
 * the same fact as `allowed`, and the inspector says so in words; but a map
 * that drew an overlay on every untagged road would be a map of how complete
 * OpenStreetMap is, not a map of access.
 */
export const ACCESS_CATEGORIES = ['ordinary', 'restricted', 'prohibited', 'uncertain'] as const;

export type AccessCategory = (typeof ACCESS_CATEGORIES)[number];

/** The categories that earn an overlay layer, in bottom-to-top draw order. */
export const OVERLAY_CATEGORIES = ['restricted', 'prohibited', 'uncertain'] as const;

export type OverlayCategory = (typeof OVERLAY_CATEGORIES)[number];

const CATEGORY_OF: Record<AccessRule, AccessCategory> = {
  unspecified: 'ordinary',
  allowed: 'ordinary',
  designated: 'ordinary',
  permissive: 'restricted',
  discouraged: 'restricted',
  'destination-only': 'restricted',
  'customers-only': 'restricted',
  'delivery-only': 'restricted',
  'agricultural-only': 'restricted',
  'forestry-only': 'restricted',
  'military-only': 'restricted',
  private: 'restricted',
  'permit-required': 'restricted',
  'dismount-required': 'restricted',
  'use-sidepath': 'restricted',
  prohibited: 'prohibited',
  variable: 'uncertain',
  conditional: 'uncertain',
  indeterminate: 'uncertain',
};

/**
 * What each rule is called in the inspector and the legend.
 *
 * `unspecified` says "not stated" rather than anything that could be read as
 * permission, because that distinction is the point of the whole milestone.
 */
export const ACCESS_LABELS: Record<AccessRule, string> = {
  unspecified: 'Not stated',
  allowed: 'Allowed',
  designated: 'Designated',
  permissive: 'Permissive · revocable',
  discouraged: 'Discouraged',
  'destination-only': 'Destination traffic only',
  'customers-only': 'Customers only',
  'delivery-only': 'Delivery only',
  'agricultural-only': 'Agricultural traffic only',
  'forestry-only': 'Forestry traffic only',
  'military-only': 'Military traffic only',
  private: 'Private',
  'permit-required': 'Permit required',
  'dismount-required': 'Dismount required',
  'use-sidepath': 'Use the sidepath',
  prohibited: 'Prohibited',
  variable: 'Variable · changes',
  conditional: 'Conditional · not evaluated',
  indeterminate: 'Indeterminate · not derived',
};

/** What each overlay category is called in the legend. */
export const CATEGORY_LABELS: Record<AccessCategory, string> = {
  ordinary: 'No restriction recorded',
  restricted: 'Restricted or special purpose',
  prohibited: 'Prohibited',
  uncertain: 'Dynamic or unresolved',
};

/** The prefix Studio flattens each mode's access onto. */
export const ACCESS_PROPERTY_PREFIX = 'access:';

const KNOWN_RULES = new Set<string>(ACCESS_RULES);

/**
 * Narrows an untrusted wire value to an access rule.
 *
 * Anything Studio does not recognise reads as `indeterminate`, and so does a
 * missing one. That is deliberate and it is *not* `unspecified`: a server that
 * never sent an access member has not established that the source lacked
 * access tags, it has only failed to say. `unspecified` is a claim about a
 * source, and Studio must not make it on a server's behalf.
 */
export function parseAccess(value: unknown): AccessRule {
  return typeof value === 'string' && KNOWN_RULES.has(value)
    ? (value as AccessRule)
    : 'indeterminate';
}

/** One access rule per profile, always complete. */
export type ProfileAccess = Record<TravelProfile, AccessRule>;

/** Reads a traversal block's access, filling in anything the server left out. */
export function readAccess(traversal: RoadTraversal | undefined): ProfileAccess {
  return {
    motorcar: parseAccess(traversal?.motorcar?.access),
    bicycle: parseAccess(traversal?.bicycle?.access),
    foot: parseAccess(traversal?.foot?.access),
  };
}

/** Reads the access of one feature's properties. */
export function readFeatureAccess(properties: RoadProperties): ProfileAccess {
  return readAccess(properties.traversal);
}

/** Which access rule applies to one profile. */
export function accessFor(properties: RoadProperties, profile: TravelProfile): AccessRule {
  return readFeatureAccess(properties)[profile];
}

/** The flattened MapLibre property name for a profile's access. */
export function accessPropertyKey(profile: TravelProfile): string {
  return `${ACCESS_PROPERTY_PREFIX}${profile}`;
}

/**
 * Flattens a nested traversal block's access into MapLibre-friendly properties.
 *
 * Same boundary discipline as the direction properties beside it: MapLibre
 * expressions cannot reach into a nested object, so the adapter flattens. This
 * is a rendering concern and it stops here — the API keeps the nested shape,
 * and so does everything the inspector reads.
 */
export function accessProperties(traversal: RoadTraversal | undefined): Record<string, AccessRule> {
  const access = readAccess(traversal);
  const flattened: Record<string, AccessRule> = {};
  for (const profile of TRAVEL_PROFILES) {
    flattened[accessPropertyKey(profile)] = access[profile];
  }
  return flattened;
}

/** Which overlay, if any, a rule belongs to. */
export function accessCategory(rule: AccessRule): AccessCategory {
  return CATEGORY_OF[rule];
}

/** Every rule in one category, in the API's order. */
export function rulesInCategory(category: AccessCategory): AccessRule[] {
  return ACCESS_RULES.filter((rule) => CATEGORY_OF[rule] === category);
}

/** Whether the map draws an access overlay for this rule at all. */
export function hasOverlay(rule: AccessRule): boolean {
  return accessCategory(rule) !== 'ordinary';
}

/** The inspector label for an access rule. */
export function accessLabel(rule: AccessRule): string {
  return ACCESS_LABELS[rule];
}
