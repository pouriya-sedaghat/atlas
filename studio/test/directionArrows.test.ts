import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpressionSpecification } from 'maplibre-gl';

import { ARROW_IMAGE_ID } from '../src/map/arrowImage.js';
import {
  ARROW_ROTATE_PROPERTY,
  ROAD_DIRECTION_LAYER_ID,
  applyDirectionProfile,
  directionArrowLayer,
  directionFilter,
  directionRotation,
} from '../src/map/directionArrows.js';
import type { DirectionLayerTarget } from '../src/map/directionArrows.js';
import { ROAD_SOURCE_ID, roadLayers } from '../src/map/roadLayers.js';
import { TRAVEL_PROFILES } from '../src/map/traversal.js';
import type { TravelProfile } from '../src/map/traversal.js';

class FakeMap implements DirectionLayerTarget {
  readonly filters: [string, ExpressionSpecification][] = [];
  readonly layoutProperties: [string, string, unknown][] = [];

  constructor(private readonly layers: ReadonlySet<string>) {}

  getLayer(id: string): unknown {
    return this.layers.has(id) ? { id } : undefined;
  }

  setFilter(id: string, filter: ExpressionSpecification): void {
    this.filters.push([id, filter]);
  }

  setLayoutProperty(id: string, name: string, value: unknown): void {
    this.layoutProperties.push([id, name, value]);
  }
}

function mapWithArrowLayer(): FakeMap {
  return new FakeMap(new Set([ROAD_DIRECTION_LAYER_ID]));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('direction expressions', () => {
  it('selects only forward and reverse roads for the chosen profile', () => {
    expect(directionFilter('bicycle')).toEqual([
      'in',
      ['get', 'direction:bicycle'],
      ['literal', ['forward', 'reverse']],
    ]);
  });

  it('turns the arrow around for a reverse road and leaves forward alone', () => {
    expect(directionRotation('foot')).toEqual([
      'case',
      ['==', ['get', 'direction:foot'], 'reverse'],
      180,
      0,
    ]);
  });

  it('reads a different property for every profile', () => {
    const keys = TRAVEL_PROFILES.map(
      (profile) =>
        JSON.stringify(directionFilter(profile)) + JSON.stringify(directionRotation(profile)),
    );
    expect(new Set(keys).size).toBe(TRAVEL_PROFILES.length);
  });
});

describe('directionArrowLayer', () => {
  it('is a line-placed symbol layer using the locally generated image', () => {
    const layer = directionArrowLayer('motorcar');
    expect(layer.id).toBe(ROAD_DIRECTION_LAYER_ID);
    expect(layer.type).toBe('symbol');
    expect('source' in layer && layer.source).toBe(ROAD_SOURCE_ID);
    const layout = (layer as { layout: Record<string, unknown> }).layout;
    expect(layout['symbol-placement']).toBe('line');
    expect(layout['icon-image']).toBe(ARROW_IMAGE_ID);
    expect(layout['icon-rotation-alignment']).toBe('map');
    expect(layout[ARROW_ROTATE_PROPERTY]).toEqual(directionRotation('motorcar'));
    expect('filter' in layer && layer.filter).toEqual(directionFilter('motorcar'));
  });

  it('never names an external sprite, glyph or tile source', () => {
    const rendered = JSON.stringify(directionArrowLayer('motorcar'));
    expect(rendered).not.toMatch(/https?:/);
    expect(rendered).not.toMatch(/sprite|glyphs|tiles/i);
  });

  it('is part of the road layer stack, on top', () => {
    const layers = roadLayers('bicycle');
    const top = layers.at(-1);
    expect(top?.id).toBe(ROAD_DIRECTION_LAYER_ID);
    expect(top && 'filter' in top && top.filter).toEqual(directionFilter('bicycle'));
  });
});

describe('applyDirectionProfile', () => {
  it('re-points the arrows at the newly selected profile', () => {
    const map = mapWithArrowLayer();
    expect(applyDirectionProfile(map, 'foot')).toBe(true);
    expect(map.filters).toEqual([[ROAD_DIRECTION_LAYER_ID, directionFilter('foot')]]);
    expect(map.layoutProperties).toEqual([
      [ROAD_DIRECTION_LAYER_ID, ARROW_ROTATE_PROPERTY, directionRotation('foot')],
    ]);
  });

  it('touches nothing but the arrow layer', () => {
    const map = mapWithArrowLayer();
    applyDirectionProfile(map, 'bicycle');
    for (const [id] of [...map.filters, ...map.layoutProperties]) {
      expect(id).toBe(ROAD_DIRECTION_LAYER_ID);
    }
  });

  it('issues no HTTP request for any profile', () => {
    // This is the whole promise of a local profile selector: the features are
    // already in the browser, so switching profile must never go back to the
    // server. A fetch here would be a bug the user feels as a flicker.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const map = mapWithArrowLayer();
    for (const profile of TRAVEL_PROFILES satisfies readonly TravelProfile[]) {
      applyDirectionProfile(map, profile);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing before the style has added the layer', () => {
    const map = new FakeMap(new Set());
    expect(applyDirectionProfile(map, 'motorcar')).toBe(false);
    expect(map.filters).toEqual([]);
    expect(map.layoutProperties).toEqual([]);
  });
});
