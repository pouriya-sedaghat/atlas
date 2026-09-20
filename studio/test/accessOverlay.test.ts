import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpressionSpecification } from 'maplibre-gl';

import { OVERLAY_CATEGORIES, rulesInCategory } from '../src/map/access.js';
import type { OverlayCategory } from '../src/map/access.js';
import {
  ACCESS_LAYER_IDS,
  ACCESS_OVERLAY_STYLE,
  accessFilter,
  accessLayerId,
  accessOverlayLayer,
  accessOverlayLayers,
  applyAccessProfile,
} from '../src/map/accessOverlay.js';
import type { AccessLayerTarget } from '../src/map/accessOverlay.js';
import { ROAD_DIRECTION_LAYER_ID, applyDirectionProfile } from '../src/map/directionArrows.js';
import {
  ROAD_CASING_LAYER_ID,
  ROAD_HIT_LAYER_ID,
  ROAD_HOVER_LAYER_ID,
  ROAD_LAYER_ID,
  ROAD_SELECTED_LAYER_ID,
  ROAD_SOURCE_ID,
  roadLayers,
} from '../src/map/roadLayers.js';
import { TRAVEL_PROFILES } from '../src/map/traversal.js';
import type { TravelProfile } from '../src/map/traversal.js';

class FakeMap implements AccessLayerTarget {
  readonly filters: [string, ExpressionSpecification][] = [];

  constructor(private readonly layers: ReadonlySet<string>) {}

  getLayer(id: string): unknown {
    return this.layers.has(id) ? { id } : undefined;
  }

  setFilter(id: string, filter: ExpressionSpecification): void {
    this.filters.push([id, filter]);
  }
}

function mapWithOverlays(): FakeMap {
  return new FakeMap(new Set(ACCESS_LAYER_IDS));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('access filters', () => {
  it('selects exactly the rules in one category for one profile', () => {
    expect(accessFilter('bicycle', 'prohibited')).toEqual([
      'in',
      ['get', 'access:bicycle'],
      ['literal', ['prohibited']],
    ]);
    expect(accessFilter('foot', 'uncertain')).toEqual([
      'in',
      ['get', 'access:foot'],
      ['literal', ['variable', 'conditional', 'indeterminate']],
    ]);
  });

  it('lists every restricted rule so none is silently left undrawn', () => {
    expect(accessFilter('motorcar', 'restricted')).toEqual([
      'in',
      ['get', 'access:motorcar'],
      ['literal', rulesInCategory('restricted')],
    ]);
    expect(rulesInCategory('restricted')).toHaveLength(12);
  });

  it('reads a different property for every profile', () => {
    for (const category of OVERLAY_CATEGORIES) {
      const rendered = TRAVEL_PROFILES.map((profile) =>
        JSON.stringify(accessFilter(profile, category)),
      );
      expect(new Set(rendered).size).toBe(TRAVEL_PROFILES.length);
    }
  });

  it('never reads a direction property', () => {
    for (const profile of TRAVEL_PROFILES) {
      for (const category of OVERLAY_CATEGORIES) {
        expect(JSON.stringify(accessFilter(profile, category))).not.toContain('direction');
      }
    }
  });

  it('covers every road exactly once across the overlays and the ordinary rules', () => {
    // A rule drawn by two overlays would be drawn twice; a rule drawn by none
    // and not ordinary would vanish. Neither is allowed.
    const drawn = OVERLAY_CATEGORIES.flatMap((category) => rulesInCategory(category));
    expect(new Set(drawn).size).toBe(drawn.length);
    expect(drawn).not.toContain('allowed');
    expect(drawn).not.toContain('unspecified');
    expect(drawn).not.toContain('designated');
  });
});

describe('accessOverlayLayer', () => {
  it('is a dashed line layer on the road source', () => {
    for (const category of OVERLAY_CATEGORIES) {
      const layer = accessOverlayLayer(category, 'motorcar');
      expect(layer.id).toBe(accessLayerId(category));
      expect(layer.type).toBe('line');
      expect('source' in layer && layer.source).toBe(ROAD_SOURCE_ID);
      expect('filter' in layer && layer.filter).toEqual(accessFilter('motorcar', category));
      const paint = (layer as { paint: Record<string, unknown> }).paint;
      expect(paint['line-color']).toBe(ACCESS_OVERLAY_STYLE[category].color);
      expect(paint['line-dasharray']).toEqual(ACCESS_OVERLAY_STYLE[category].dashArray);
    }
  });

  it('gives each category a visually distinct colour and dash rhythm', () => {
    const colors = OVERLAY_CATEGORIES.map((category) => ACCESS_OVERLAY_STYLE[category].color);
    const dashes = OVERLAY_CATEGORIES.map((category) =>
      JSON.stringify(ACCESS_OVERLAY_STYLE[category].dashArray),
    );
    expect(new Set(colors).size).toBe(OVERLAY_CATEGORIES.length);
    expect(new Set(dashes).size).toBe(OVERLAY_CATEGORIES.length);
  });

  it('stays narrower than the road so the class colour still shows', () => {
    for (const category of OVERLAY_CATEGORIES) {
      expect(ACCESS_OVERLAY_STYLE[category].widthScale).toBeGreaterThan(0);
      expect(ACCESS_OVERLAY_STYLE[category].widthScale).toBeLessThan(1);
    }
  });

  it('never names an external sprite, glyph or tile source', () => {
    const rendered = JSON.stringify(accessOverlayLayers('motorcar'));
    expect(rendered).not.toMatch(/https?:/);
    expect(rendered).not.toMatch(/sprite|glyphs|tiles/i);
  });
});

describe('the road layer stack', () => {
  it('draws the overlays above the road and below everything that highlights it', () => {
    const ids = roadLayers('motorcar').map((layer) => layer.id);
    const at = (id: string) => ids.indexOf(id);

    expect(at(ROAD_CASING_LAYER_ID)).toBeLessThan(at(ROAD_LAYER_ID));
    for (const id of ACCESS_LAYER_IDS) {
      expect(at(id)).toBeGreaterThan(at(ROAD_LAYER_ID));
      expect(at(id)).toBeLessThan(at(ROAD_HIT_LAYER_ID));
      expect(at(id)).toBeLessThan(at(ROAD_HOVER_LAYER_ID));
      expect(at(id)).toBeLessThan(at(ROAD_SELECTED_LAYER_ID));
      // Direction arrows stay on top: a prohibited one-way still shows one.
      expect(at(id)).toBeLessThan(at(ROAD_DIRECTION_LAYER_ID));
    }
    expect(ids.at(-1)).toBe(ROAD_DIRECTION_LAYER_ID);
  });

  it('builds the overlays for the profile it was asked for', () => {
    for (const profile of TRAVEL_PROFILES) {
      const layers = roadLayers(profile);
      for (const category of OVERLAY_CATEGORIES) {
        const layer = layers.find((candidate) => candidate.id === accessLayerId(category));
        expect(layer && 'filter' in layer && layer.filter).toEqual(accessFilter(profile, category));
      }
    }
  });

  it('leaves the hover and selection filters alone', () => {
    // Both start matching nothing and are driven only by the id filter, which
    // access must never touch.
    const layers = roadLayers('foot');
    for (const id of [ROAD_HOVER_LAYER_ID, ROAD_SELECTED_LAYER_ID]) {
      const layer = layers.find((candidate) => candidate.id === id);
      expect(layer && 'filter' in layer && layer.filter).toEqual(['==', ['get', 'atlasId'], '']);
    }
  });
});

describe('applyAccessProfile', () => {
  it('re-filters every overlay at the newly selected profile', () => {
    const map = mapWithOverlays();
    expect(applyAccessProfile(map, 'foot')).toBe(true);
    expect(map.filters).toEqual(
      OVERLAY_CATEGORIES.map((category: OverlayCategory) => [
        accessLayerId(category),
        accessFilter('foot', category),
      ]),
    );
  });

  it('touches nothing but the overlay layers', () => {
    const map = mapWithOverlays();
    applyAccessProfile(map, 'bicycle');
    for (const [id] of map.filters) {
      expect(ACCESS_LAYER_IDS).toContain(id);
    }
    expect(map.filters.map(([id]) => id)).not.toContain(ROAD_DIRECTION_LAYER_ID);
    expect(map.filters.map(([id]) => id)).not.toContain(ROAD_HOVER_LAYER_ID);
    expect(map.filters.map(([id]) => id)).not.toContain(ROAD_SELECTED_LAYER_ID);
  });

  it('issues no HTTP request for any profile', () => {
    // The whole promise of a local profile selector: the features are already
    // in the browser, so switching profile must never go back to the server.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const map = mapWithOverlays();
    for (const profile of TRAVEL_PROFILES satisfies readonly TravelProfile[]) {
      applyAccessProfile(map, profile);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gives a different set of filters for each profile', () => {
    const rendered = TRAVEL_PROFILES.map((profile) => {
      const map = mapWithOverlays();
      applyAccessProfile(map, profile);
      return JSON.stringify(map.filters);
    });
    expect(new Set(rendered).size).toBe(TRAVEL_PROFILES.length);
  });

  it('does nothing before the style has added the layers', () => {
    expect(applyAccessProfile(new FakeMap(new Set()), 'motorcar')).toBe(false);
    // A half-built style is not a licence to half-update either.
    const partial = new FakeMap(new Set([accessLayerId('restricted')]));
    expect(applyAccessProfile(partial, 'motorcar')).toBe(false);
    expect(partial.filters).toEqual([]);
  });
});

/**
 * What `selectProfile` in `main.ts` actually does to the map.
 *
 * The two switches are separate functions on separate layers, and the thing
 * worth proving is that running both of them together still touches only those
 * layers — no fetch, no source update, and nothing done to hover or selection,
 * which is what lets a selected road survive a profile change.
 */
class FullFakeMap implements AccessLayerTarget {
  readonly filters: [string, ExpressionSpecification][] = [];
  readonly layoutProperties: [string, string, unknown][] = [];
  readonly sourceUpdates: unknown[] = [];

  private readonly layers = new Set([...ACCESS_LAYER_IDS, ROAD_DIRECTION_LAYER_ID]);

  getLayer(id: string): unknown {
    return this.layers.has(id) ? { id } : undefined;
  }

  setFilter(id: string, filter: ExpressionSpecification): void {
    this.filters.push([id, filter]);
  }

  setLayoutProperty(id: string, name: string, value: unknown): void {
    this.layoutProperties.push([id, name, value]);
  }

  getSource(): { setData(data: unknown): void } {
    return { setData: (data: unknown) => this.sourceUpdates.push(data) };
  }
}

describe('switching profile the way main.ts does', () => {
  it('updates the access overlays and the arrows and nothing else', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const map = new FullFakeMap();

    expect(applyAccessProfile(map, 'bicycle')).toBe(true);
    expect(applyDirectionProfile(map, 'bicycle')).toBe(true);

    const touched = new Set([
      ...map.filters.map(([id]) => id),
      ...map.layoutProperties.map(([id]) => id),
    ]);
    expect([...touched].sort()).toEqual([...ACCESS_LAYER_IDS, ROAD_DIRECTION_LAYER_ID].sort());

    // Hover and selection are never in that set, which is precisely why a
    // selected road stays selected across a profile change.
    expect(touched.has(ROAD_HOVER_LAYER_ID)).toBe(false);
    expect(touched.has(ROAD_SELECTED_LAYER_ID)).toBe(false);
    expect(touched.has(ROAD_HIT_LAYER_ID)).toBe(false);
    expect(touched.has(ROAD_LAYER_ID)).toBe(false);

    // No query, and no re-parse of the data already in the browser.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(map.sourceUpdates).toEqual([]);
  });

  it('issues no request however many times the profile changes', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const map = new FullFakeMap();
    for (const profile of [...TRAVEL_PROFILES, ...TRAVEL_PROFILES, ...TRAVEL_PROFILES]) {
      applyAccessProfile(map, profile);
      applyDirectionProfile(map, profile);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(map.sourceUpdates).toEqual([]);
  });

  it('ends on the filters the newly selected profile asks for', () => {
    const map = new FullFakeMap();
    applyAccessProfile(map, 'motorcar');
    applyAccessProfile(map, 'foot');
    for (const category of OVERLAY_CATEGORIES) {
      const last = map.filters.filter(([id]) => id === accessLayerId(category)).at(-1);
      expect(last?.[1]).toEqual(accessFilter('foot', category));
    }
  });
});
