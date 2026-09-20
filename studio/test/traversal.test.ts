import { describe, expect, it } from 'vitest';

import type { RoadProperties } from '../src/api/types.js';
import {
  DEFAULT_PROFILE,
  DIRECTION_LABELS,
  PROFILE_LABELS,
  TRAVEL_DIRECTIONS,
  TRAVEL_PROFILES,
  arrowFor,
  directionFor,
  directionLabel,
  directionProperties,
  directionPropertyKey,
  isDynamicDirection,
  isIndeterminateDirection,
  isTravelProfile,
  parseDirection,
  readFeatureDirections,
  readTraversal,
} from '../src/map/traversal.js';
import type { TravelDirection } from '../src/map/traversal.js';

function properties(overrides: Partial<RoadProperties> = {}): RoadProperties {
  return { kind: 'road', roadClass: 'residential', ...overrides };
}

describe('parseDirection', () => {
  it('accepts every value the API can send', () => {
    for (const direction of TRAVEL_DIRECTIONS) {
      expect(parseDirection(direction)).toBe(direction);
    }
  });

  it('falls back to indeterminate for anything else', () => {
    // A value Studio does not know is exactly the case `indeterminate`
    // describes: no arrow, and the inspector says so.
    for (const value of ['FORWARD', 'sometimes', '', ' forward ', 1, null, undefined, {}, []]) {
      expect(parseDirection(value)).toBe('indeterminate');
    }
  });
});

describe('readTraversal', () => {
  it('reads a complete traversal block', () => {
    expect(
      readTraversal({
        motorcar: { direction: 'forward' },
        bicycle: { direction: 'both' },
        foot: { direction: 'indeterminate' },
      }),
    ).toEqual({ motorcar: 'forward', bicycle: 'both', foot: 'indeterminate' });
  });

  it('is complete even when the server sent nothing', () => {
    // An older server that has never heard of traversal must not make Studio
    // invent directions; it makes it draw none.
    expect(readTraversal(undefined)).toEqual({
      motorcar: 'indeterminate',
      bicycle: 'indeterminate',
      foot: 'indeterminate',
    });
    expect(readTraversal({ motorcar: { direction: 'forward' } })).toEqual({
      motorcar: 'forward',
      bicycle: 'indeterminate',
      foot: 'indeterminate',
    });
  });

  it('reads a feature s properties', () => {
    const feature = properties({
      traversal: {
        motorcar: { direction: 'reverse' },
        bicycle: { direction: 'both' },
        foot: { direction: 'both' },
      },
    });
    expect(readFeatureDirections(feature)).toEqual({
      motorcar: 'reverse',
      bicycle: 'both',
      foot: 'both',
    });
    expect(directionFor(feature, 'motorcar')).toBe('reverse');
    expect(directionFor(feature, 'bicycle')).toBe('both');
    expect(directionFor(feature, 'foot')).toBe('both');
  });
});

describe('profile to property mapping', () => {
  it('names one flattened property per profile', () => {
    expect(directionPropertyKey('motorcar')).toBe('direction:motorcar');
    expect(directionPropertyKey('bicycle')).toBe('direction:bicycle');
    expect(directionPropertyKey('foot')).toBe('direction:foot');
  });

  it('flattens a nested block onto those properties', () => {
    expect(
      directionProperties({
        motorcar: { direction: 'forward' },
        bicycle: { direction: 'reverse' },
        foot: { direction: 'both' },
      }),
    ).toEqual({
      'direction:motorcar': 'forward',
      'direction:bicycle': 'reverse',
      'direction:foot': 'both',
    });
  });

  it('always emits every profile so a filter never reads undefined', () => {
    const flattened = directionProperties(undefined);
    expect(Object.keys(flattened).sort()).toEqual(TRAVEL_PROFILES.map(directionPropertyKey).sort());
  });
});

describe('arrow rendering decisions', () => {
  it('draws an arrow only for the two static one-way values', () => {
    expect(arrowFor('forward')).toBe('forward');
    expect(arrowFor('reverse')).toBe('reverse');
  });

  it('draws no arrow for a two-way road', () => {
    expect(arrowFor('both')).toBeNull();
  });

  it('refuses to invent a direction for a dynamic or unstated value', () => {
    for (const direction of ['reversible', 'alternating', 'indeterminate'] as const) {
      expect(arrowFor(direction)).toBeNull();
    }
  });

  it('classifies dynamic and indeterminate values apart from the rest', () => {
    expect(isDynamicDirection('reversible')).toBe(true);
    expect(isDynamicDirection('alternating')).toBe(true);
    expect(isDynamicDirection('indeterminate')).toBe(false);
    expect(isIndeterminateDirection('indeterminate')).toBe(true);
    expect(isIndeterminateDirection('both')).toBe(false);
  });
});

describe('display labels', () => {
  it('labels every direction distinctly', () => {
    const labels = TRAVEL_DIRECTIONS.map((direction) => directionLabel(direction));
    expect(new Set(labels).size).toBe(TRAVEL_DIRECTIONS.length);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('says plainly that a dynamic or unstated direction is not a fixed one', () => {
    expect(DIRECTION_LABELS.reversible).toMatch(/changes/i);
    expect(DIRECTION_LABELS.alternating).toMatch(/changes/i);
    expect(DIRECTION_LABELS.indeterminate).toMatch(/indeterminate/i);
    // Neither may read like a one-way direction.
    for (const direction of ['reversible', 'alternating', 'indeterminate'] as const) {
      expect(DIRECTION_LABELS[direction]).not.toMatch(/one-way/i);
    }
  });

  it('labels every profile', () => {
    expect(TRAVEL_PROFILES.map((profile) => PROFILE_LABELS[profile])).toEqual([
      'Car',
      'Bicycle',
      'Foot',
    ]);
  });
});

describe('profiles', () => {
  it('defaults to car', () => {
    expect(DEFAULT_PROFILE).toBe('motorcar');
    expect(TRAVEL_PROFILES[0]).toBe('motorcar');
  });

  it('recognises only the three profiles', () => {
    for (const profile of TRAVEL_PROFILES) {
      expect(isTravelProfile(profile)).toBe(true);
    }
    for (const value of ['car', 'Motorcar', '', null, 7]) {
      expect(isTravelProfile(value)).toBe(false);
    }
  });

  it('keeps the direction type in step with the runtime list', () => {
    const typed: readonly TravelDirection[] = TRAVEL_DIRECTIONS;
    expect(typed).toEqual([
      'both',
      'forward',
      'reverse',
      'reversible',
      'alternating',
      'indeterminate',
    ]);
  });
});
