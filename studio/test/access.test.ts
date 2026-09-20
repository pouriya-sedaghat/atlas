import { describe, expect, it } from 'vitest';

import type { RoadProperties } from '../src/api/types.js';
import {
  ACCESS_CATEGORIES,
  ACCESS_LABELS,
  ACCESS_RULES,
  CATEGORY_LABELS,
  OVERLAY_CATEGORIES,
  accessCategory,
  accessFor,
  accessLabel,
  accessProperties,
  accessPropertyKey,
  hasOverlay,
  parseAccess,
  readAccess,
  readFeatureAccess,
  rulesInCategory,
} from '../src/map/access.js';
import type { AccessRule } from '../src/map/access.js';
import { TRAVEL_PROFILES } from '../src/map/traversal.js';

function properties(overrides: Partial<RoadProperties> = {}): RoadProperties {
  return { kind: 'road', roadClass: 'residential', ...overrides };
}

describe('parseAccess', () => {
  it('accepts every value the API can send', () => {
    for (const rule of ACCESS_RULES) {
      expect(parseAccess(rule)).toBe(rule);
    }
    expect(ACCESS_RULES).toHaveLength(19);
  });

  it('falls back to indeterminate for anything else', () => {
    for (const value of [
      'ALLOWED',
      'destination_only',
      'destination only',
      'yes',
      'no',
      '',
      ' allowed ',
      1,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(parseAccess(value)).toBe('indeterminate');
    }
  });

  it('degrades a wire value from a future server to indeterminate', () => {
    // A server that grows a twentieth rule must not make this Studio build
    // draw the wrong overlay for it; it makes it draw the uncertain one.
    for (const future of ['toll-required', 'seasonal', 'weight-limited']) {
      expect(parseAccess(future)).toBe('indeterminate');
      expect(accessCategory(parseAccess(future))).toBe('uncertain');
    }
  });

  it('never reads a missing value as unspecified', () => {
    // The distinction the whole milestone exists for, seen from the client
    // side: an older server that sent no access has not established that the
    // source lacked access tags, so Studio must not claim it did.
    expect(parseAccess(undefined)).toBe('indeterminate');
    expect(parseAccess(undefined)).not.toBe('unspecified');
  });
});

describe('readAccess', () => {
  it('reads a complete traversal block', () => {
    expect(
      readAccess({
        motorcar: { direction: 'forward', access: 'private' },
        bicycle: { direction: 'both', access: 'designated' },
        foot: { direction: 'both', access: 'unspecified' },
      }),
    ).toEqual({ motorcar: 'private', bicycle: 'designated', foot: 'unspecified' });
  });

  it('is complete even when the server sent nothing', () => {
    expect(readAccess(undefined)).toEqual({
      motorcar: 'indeterminate',
      bicycle: 'indeterminate',
      foot: 'indeterminate',
    });
  });

  it('treats a Milestone 2A block with directions but no access as indeterminate', () => {
    expect(
      readAccess({
        motorcar: { direction: 'forward' },
        bicycle: { direction: 'both' },
        foot: { direction: 'both' },
      }),
    ).toEqual({
      motorcar: 'indeterminate',
      bicycle: 'indeterminate',
      foot: 'indeterminate',
    });
  });

  it('fills in only the modes the server left out', () => {
    expect(readAccess({ foot: { direction: 'both', access: 'allowed' } })).toEqual({
      motorcar: 'indeterminate',
      bicycle: 'indeterminate',
      foot: 'allowed',
    });
  });

  it("reads a feature's properties", () => {
    const feature = properties({
      traversal: {
        motorcar: { direction: 'forward', access: 'prohibited' },
        bicycle: { direction: 'both', access: 'allowed' },
        foot: { direction: 'both', access: 'unspecified' },
      },
    });
    expect(readFeatureAccess(feature)).toEqual({
      motorcar: 'prohibited',
      bicycle: 'allowed',
      foot: 'unspecified',
    });
    expect(accessFor(feature, 'motorcar')).toBe('prohibited');
    expect(accessFor(feature, 'bicycle')).toBe('allowed');
    expect(accessFor(feature, 'foot')).toBe('unspecified');
  });
});

describe('profile to property mapping', () => {
  it('names one flattened property per profile', () => {
    expect(accessPropertyKey('motorcar')).toBe('access:motorcar');
    expect(accessPropertyKey('bicycle')).toBe('access:bicycle');
    expect(accessPropertyKey('foot')).toBe('access:foot');
  });

  it('flattens a nested block onto those properties', () => {
    expect(
      accessProperties({
        motorcar: { direction: 'forward', access: 'destination-only' },
        bicycle: { direction: 'both', access: 'designated' },
        foot: { direction: 'both', access: 'allowed' },
      }),
    ).toEqual({
      'access:motorcar': 'destination-only',
      'access:bicycle': 'designated',
      'access:foot': 'allowed',
    });
  });

  it('always emits every profile so a filter never reads undefined', () => {
    const flattened = accessProperties(undefined);
    expect(Object.keys(flattened).sort()).toEqual(TRAVEL_PROFILES.map(accessPropertyKey).sort());
    expect(Object.values(flattened)).toEqual(['indeterminate', 'indeterminate', 'indeterminate']);
  });

  it('never collides with the direction properties beside it', () => {
    const directionKeys = TRAVEL_PROFILES.map((profile) => `direction:${profile}`);
    for (const profile of TRAVEL_PROFILES) {
      expect(directionKeys).not.toContain(accessPropertyKey(profile));
    }
  });
});

describe('semantic categories', () => {
  it('draws nothing for a road the source did not hold back', () => {
    for (const rule of ['unspecified', 'allowed', 'designated'] as const) {
      expect(accessCategory(rule)).toBe('ordinary');
      expect(hasOverlay(rule)).toBe(false);
    }
  });

  it('draws the restricted overlay for every conditional-on-a-purpose rule', () => {
    for (const rule of [
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
    ] as const) {
      expect(accessCategory(rule)).toBe('restricted');
      expect(hasOverlay(rule)).toBe(true);
    }
  });

  it('draws the prohibited overlay only for an explicit no', () => {
    expect(accessCategory('prohibited')).toBe('prohibited');
    expect(rulesInCategory('prohibited')).toEqual(['prohibited']);
  });

  it('draws the uncertain overlay for a dynamic or unresolved rule', () => {
    for (const rule of ['variable', 'conditional', 'indeterminate'] as const) {
      expect(accessCategory(rule)).toBe('uncertain');
    }
    expect(rulesInCategory('uncertain')).toEqual(['variable', 'conditional', 'indeterminate']);
  });

  it('assigns every rule to exactly one category', () => {
    const assigned = ACCESS_CATEGORIES.flatMap((category) => rulesInCategory(category));
    expect(assigned.sort()).toEqual([...ACCESS_RULES].sort());
    expect(new Set(assigned).size).toBe(ACCESS_RULES.length);
  });

  it('keeps unspecified drawn like an ordinary road but named apart from allowed', () => {
    // Drawing an overlay on every untagged road would map how complete OSM is,
    // not how accessible the roads are. Saying "allowed" would be a lie.
    expect(accessCategory('unspecified')).toBe(accessCategory('allowed'));
    expect(accessLabel('unspecified')).not.toBe(accessLabel('allowed'));
    expect(accessLabel('unspecified')).toMatch(/not stated/i);
  });

  it('overlays exactly the three non-ordinary categories, bottom to top', () => {
    expect(OVERLAY_CATEGORIES).toEqual(['restricted', 'prohibited', 'uncertain']);
    expect(ACCESS_CATEGORIES[0]).toBe('ordinary');
    expect(rulesInCategory('ordinary')).toEqual(['unspecified', 'allowed', 'designated']);
  });
});

describe('display labels', () => {
  it('labels every rule distinctly', () => {
    const labels = ACCESS_RULES.map((rule) => accessLabel(rule));
    expect(new Set(labels).size).toBe(ACCESS_RULES.length);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('says plainly that a dynamic or unresolved rule is not a decision', () => {
    expect(ACCESS_LABELS.variable).toMatch(/changes/i);
    expect(ACCESS_LABELS.conditional).toMatch(/not evaluated/i);
    expect(ACCESS_LABELS.indeterminate).toMatch(/not derived/i);
    // None of them may read as a permission or a refusal.
    for (const rule of ['variable', 'conditional', 'indeterminate'] as const) {
      expect(ACCESS_LABELS[rule]).not.toMatch(/^allowed|^prohibited/i);
    }
  });

  it('labels every category for the legend', () => {
    for (const category of ACCESS_CATEGORIES) {
      expect(CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
    expect(new Set(Object.values(CATEGORY_LABELS)).size).toBe(ACCESS_CATEGORIES.length);
  });

  it('keeps the rule type in step with the runtime list', () => {
    const typed: readonly AccessRule[] = ACCESS_RULES;
    expect(typed[0]).toBe('unspecified');
    expect(typed.at(-1)).toBe('indeterminate');
  });
});
