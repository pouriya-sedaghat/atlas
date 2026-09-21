/**
 * Speed limits, as Studio understands them.
 *
 * Everything here is pure: given wire data it returns values and labels, and
 * it never touches the DOM, the map or the network. Switching profile is
 * therefore a local recomputation, not a new query.
 *
 * Four things are worth knowing before reading on.
 *
 * A speed limit is a **legal maximum**, not a travel speed. Nothing here
 * estimates how fast anybody moves, and nothing here may be read as though it
 * did. That is also why Studio draws no speed colour scale: a colour ramp
 * needs thresholds, thresholds imply "fast" and "slow", and "fast" is a
 * journey-time claim this milestone does not make.
 *
 * A speed limit is not an access rule and not a direction. A prohibited road
 * still has limits, and a one-way road still has two of them. Nothing in this
 * file looks at a direction or an access, and nothing in `traversal.ts` or
 * `access.ts` looks at a speed.
 *
 * `forward` and `backward` are relative to the **coordinate order of the
 * geometry**, exactly as the arrows are. They are not "the way you are going".
 *
 * And everything arriving here is untrusted text from an OSM file by way of a
 * server Studio does not control. An unrecognised kind, unit, magnitude or
 * code is never displayed: it degrades to `indeterminate`, which is the one
 * answer that cannot be wrong.
 */

import type { DirectionalSpeedLimits, RoadProperties, RoadTraversal } from '../api/types.js';
import { TRAVEL_PROFILES, type TravelProfile } from './traversal.js';

/** Every ordinary-limit kind the Atlas v1 API can send, in the API's order. */
export const SPEED_LIMIT_KINDS = [
  'unspecified',
  'numeric',
  'no-fixed-limit',
  'walking-pace',
  'implicit',
  'indeterminate',
] as const;

export type SpeedLimitKind = (typeof SPEED_LIMIT_KINDS)[number];

/** Every unit the API can send. Studio never converts between them. */
export const SPEED_UNITS = ['km/h', 'mph', 'knots'] as const;

export type SpeedUnit = (typeof SPEED_UNITS)[number];

/**
 * Whether a conditional limit applies, with a third state the wire does not
 * have.
 *
 * The server sends a boolean. Studio needs three answers, because a *missing*
 * boolean from an older server is not `false`: `not-tagged` is a claim that
 * the source carried no conditional, and Studio must not make that claim on a
 * server's behalf any more than it may turn a missing access into
 * `unspecified`.
 */
export const CONDITIONAL_STATES = ['not-tagged', 'present', 'indeterminate'] as const;

export type ConditionalState = (typeof CONDITIONAL_STATES)[number];

/** Every variability value the API can send, plus the same missing-value rule. */
export const VARIABLE_STATES = ['not-tagged', 'fixed', 'variable', 'indeterminate'] as const;

export type VariableState = (typeof VARIABLE_STATES)[number];

/** Both geometry directions, in the order the inspector lists them. */
export const SPEED_DIRECTIONS = ['forward', 'backward'] as const;

export type SpeedDirection = (typeof SPEED_DIRECTIONS)[number];

export const DIRECTION_LABELS: Record<SpeedDirection, string> = {
  forward: 'forward',
  backward: 'backward',
};

/** An ordinary limit Studio has validated. */
export type SpeedLimit =
  | { kind: 'unspecified' }
  | { kind: 'numeric'; value: string; unit: SpeedUnit }
  | { kind: 'no-fixed-limit' }
  | { kind: 'walking-pace' }
  | { kind: 'implicit'; code: string }
  | { kind: 'indeterminate' };

/** One direction's validated fact: an ordinary limit and its two modifiers. */
export interface SpeedFact {
  limit: SpeedLimit;
  conditional: ConditionalState;
  variable: VariableState;
}

/** One profile's validated facts, both directions, always complete. */
export type DirectionalSpeedFacts = Record<SpeedDirection, SpeedFact>;

/** One entry per profile, in `TRAVEL_PROFILES` order. */
export type ProfileSpeeds = Record<TravelProfile, DirectionalSpeedFacts>;

const KNOWN_KINDS = new Set<string>(SPEED_LIMIT_KINDS);
const KNOWN_UNITS = new Set<string>(SPEED_UNITS);
const KNOWN_VARIABLE = new Set<string>(VARIABLE_STATES);

/**
 * The exact decimal form the API promises: digits, optionally a single point
 * and more digits. No sign, no exponent, no comma, no whitespace, no leading
 * zeroes beyond a bare `0`.
 *
 * Studio validates rather than trusts. A magnitude that does not match is a
 * string Studio would otherwise be pasting into the DOM unexamined.
 */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

/**
 * The implicit code shape: a two-letter country, an optional short region, a
 * colon, and one or more lower-case context components separated by colons.
 *
 * The context may narrow more than once — the source documents values such as
 * `AR:urban:primary` and `DE:zone:30` — and the server canonicalises case
 * before sending, so Studio sees an upper-case jurisdiction and lower-case
 * components. Each component must be non-empty: accepting more components is
 * not accepting missing ones, so `RO::urban`, `RO:urban:` and
 * `RO:urban::extra` stay rejected.
 */
const IMPLICIT_CODE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?:[a-z0-9_]+(?::[a-z0-9_]+)*$/;

/** The limit Studio uses when it has nothing it can trust. */
const INDETERMINATE_LIMIT: SpeedLimit = { kind: 'indeterminate' };

/** The fact Studio uses for a server that said nothing about speed at all. */
export function indeterminateFact(): SpeedFact {
  return {
    limit: INDETERMINATE_LIMIT,
    conditional: 'indeterminate',
    variable: 'indeterminate',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Narrows an untrusted ordinary limit.
 *
 * Anything Studio does not recognise reads as `indeterminate`, and so does a
 * missing one. That is deliberate and it is **not** `unspecified`: a server
 * that never sent a limit has not established that the source lacked speed
 * tags, it has only failed to say. `unspecified` is a claim about a source,
 * and Studio must not make it on a server's behalf.
 *
 * Each kind is validated down to its payload. A `numeric` whose magnitude is
 * not exact decimal text, or whose unit Studio does not know, is not a
 * half-usable number — it is something Studio cannot show, so it degrades too.
 */
export function parseSpeedLimit(value: unknown): SpeedLimit {
  if (!isRecord(value)) {
    return INDETERMINATE_LIMIT;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
    return INDETERMINATE_LIMIT;
  }

  switch (kind as SpeedLimitKind) {
    case 'numeric': {
      const magnitude = value.value;
      const unit = value.unit;
      if (
        typeof magnitude !== 'string' ||
        !CANONICAL_DECIMAL.test(magnitude) ||
        typeof unit !== 'string' ||
        !KNOWN_UNITS.has(unit)
      ) {
        return INDETERMINATE_LIMIT;
      }
      return { kind: 'numeric', value: magnitude, unit: unit as SpeedUnit };
    }
    case 'implicit': {
      const code = value.code;
      if (typeof code !== 'string' || !IMPLICIT_CODE.test(code)) {
        return INDETERMINATE_LIMIT;
      }
      return { kind: 'implicit', code };
    }
    case 'unspecified':
      return { kind: 'unspecified' };
    case 'no-fixed-limit':
      return { kind: 'no-fixed-limit' };
    case 'walking-pace':
      return { kind: 'walking-pace' };
    default:
      return INDETERMINATE_LIMIT;
  }
}

/**
 * Narrows an untrusted conditional flag.
 *
 * A boolean is the contract; anything else, including a missing member, is
 * `indeterminate` rather than `not-tagged`.
 */
export function parseConditional(value: unknown): ConditionalState {
  if (value === true) {
    return 'present';
  }
  if (value === false) {
    return 'not-tagged';
  }
  return 'indeterminate';
}

/** Narrows an untrusted variability value. */
export function parseVariable(value: unknown): VariableState {
  return typeof value === 'string' && KNOWN_VARIABLE.has(value)
    ? (value as VariableState)
    : 'indeterminate';
}

/**
 * Narrows one direction's untrusted fact.
 *
 * `unknown` rather than the declared wire type on purpose: the declaration
 * describes what a well-behaved server sends, and this function's job is to
 * cope with everything else.
 */
export function parseSpeedFact(value: unknown): SpeedFact {
  if (!isRecord(value)) {
    return indeterminateFact();
  }
  return {
    limit: parseSpeedLimit(value.limit),
    conditional: parseConditional(value.conditional),
    variable: parseVariable(value.variable),
  };
}

/**
 * Reads one mode's speed block, filling in anything the server left out.
 *
 * The two directions are read separately and never merged: a road may be
 * signed one way and silent the other, and collapsing them would lose exactly
 * the asymmetry worth looking at.
 */
export function parseDirectionalSpeeds(
  limits: DirectionalSpeedLimits | undefined,
): DirectionalSpeedFacts {
  return {
    forward: parseSpeedFact(isRecord(limits) ? limits.forward : undefined),
    backward: parseSpeedFact(isRecord(limits) ? limits.backward : undefined),
  };
}

/** Reads a traversal block's speeds for every profile, in a stable order. */
export function readSpeeds(traversal: RoadTraversal | undefined): ProfileSpeeds {
  return {
    motorcar: parseDirectionalSpeeds(traversal?.motorcar?.speedLimits),
    bicycle: parseDirectionalSpeeds(traversal?.bicycle?.speedLimits),
    foot: parseDirectionalSpeeds(traversal?.foot?.speedLimits),
  };
}

/** Reads the speeds of one feature's properties. */
export function readFeatureSpeeds(properties: RoadProperties): ProfileSpeeds {
  return readSpeeds(properties.traversal);
}

/** One profile's speeds, paired with the profile they belong to. */
export interface ProfileSpeedEntry {
  profile: TravelProfile;
  speeds: DirectionalSpeedFacts;
}

/**
 * Every profile's speeds, in `TRAVEL_PROFILES` order.
 *
 * A stable order so the inspector's rows never shuffle between renders, which
 * would make the panel unreadable while clicking around a map.
 */
export function speedEntries(properties: RoadProperties): ProfileSpeedEntry[] {
  const speeds = readFeatureSpeeds(properties);
  return TRAVEL_PROFILES.map((profile) => ({ profile, speeds: speeds[profile] }));
}

/** Which speeds apply to one profile. */
export function speedsFor(
  properties: RoadProperties,
  profile: TravelProfile,
): DirectionalSpeedFacts {
  return readFeatureSpeeds(properties)[profile];
}

/**
 * What each ordinary limit is called in the inspector.
 *
 * `unspecified` says "not stated" rather than anything that could be read as a
 * number or a default, and `indeterminate` says plainly that Atlas did not
 * derive one. Neither is ever shown as a speed.
 */
export function limitLabel(limit: SpeedLimit): string {
  switch (limit.kind) {
    case 'numeric':
      // The unit is the one the source stated. Studio does not convert.
      return `${limit.value} ${limit.unit}`;
    case 'no-fixed-limit':
      return 'No fixed limit';
    case 'walking-pace':
      return 'Walking pace';
    case 'implicit':
      return `Implicit · ${limit.code}`;
    case 'unspecified':
      return 'Not stated';
    case 'indeterminate':
      return 'Indeterminate · not derived';
  }
}

/**
 * The modifier text appended to a limit, or `null` for nothing to say.
 *
 * Only the states that communicate something get text. `not-tagged` on either
 * modifier means Atlas found no applicable tag, which is the ordinary case on
 * almost every road; printing it on every row would bury the rows where a
 * modifier actually applies.
 */
function modifierNotes(fact: SpeedFact): string[] {
  // When the ordinary limit itself was not derived — which is what an older
  // server's missing block degrades to — "conditional not derived" and
  // "variability not derived" repeat the same news twice more. The row
  // already says nothing was derived, so the modifiers stay quiet. They speak
  // up whenever the limit *was* readable and only a modifier was not, which
  // is the case where the distinction carries information.
  const derived = fact.limit.kind !== 'indeterminate';
  const notes: string[] = [];
  if (fact.conditional === 'present') {
    notes.push('conditional');
  } else if (fact.conditional === 'indeterminate' && derived) {
    notes.push('conditional not derived');
  }
  if (fact.variable === 'variable') {
    notes.push('variable');
  } else if (fact.variable === 'fixed') {
    // "Somebody checked and said it does not vary" is a different fact from
    // "nobody tagged it", and worth a word.
    notes.push('explicitly fixed');
  } else if (fact.variable === 'indeterminate' && derived) {
    notes.push('variability not derived');
  }
  return notes;
}

/**
 * The full inspector label for one direction's fact.
 *
 * Plain text, assembled from validated values only. Nothing here is markup and
 * nothing here is a raw wire string.
 */
export function speedLabel(fact: SpeedFact): string {
  return [limitLabel(fact.limit), ...modifierNotes(fact)].join(' · ');
}
