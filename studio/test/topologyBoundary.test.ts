import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { LayerSpecification } from 'maplibre-gl';

import { applyAccessProfile } from '../src/map/accessOverlay.js';
import { applyDirectionProfile } from '../src/map/directionArrows.js';
import { roadLayers } from '../src/map/roadLayers.js';
import { TRAVEL_PROFILES } from '../src/map/traversal.js';
import { TOPOLOGY_LAYER_IDS, topologyLayers } from '../src/map/topologyLayers.js';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8');
}

/** The module specifiers one source file imports from. */
function importsOf(relative: string): string[] {
  return [...source(relative).matchAll(/from\s+'([^']+)'/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * The road stack: the composition root, the shared primitives and the two leaf
 * layer builders the profile switch drives.
 */
const ROAD_MODULES = [
  'map/roadLayers.ts',
  'map/roadPrimitives.ts',
  'map/accessOverlay.ts',
  'map/directionArrows.ts',
  'map/arrowImage.ts',
  'map/geojson.ts',
];

const TOPOLOGY_MODULES = ['map/topology.ts', 'map/topologyLayers.ts'];

describe('the topology overlay is a separate composition root', () => {
  it('no road module imports a topology module', () => {
    for (const module of ROAD_MODULES) {
      for (const specifier of importsOf(module)) {
        expect(specifier.toLowerCase()).not.toContain('topology');
      }
    }
  });

  it('no topology module imports the road composition root or its layers', () => {
    // `topologyLayers` is its own root. Importing `roadLayers` — which already
    // imports the leaf builders — is exactly the cycle this boundary exists to
    // prevent.
    for (const module of TOPOLOGY_MODULES) {
      for (const specifier of importsOf(module)) {
        expect(specifier).not.toContain('roadLayers');
        expect(specifier).not.toContain('roadPrimitives');
        expect(specifier).not.toContain('accessOverlay');
        expect(specifier).not.toContain('directionArrows');
      }
    }
  });

  it('the topology parser imports nothing from the map at all', () => {
    // It is pure: wire data in, view models out. It must not reach for a
    // MapLibre type, a layer id or a road module.
    for (const specifier of importsOf('map/topology.ts')) {
      expect(specifier).toBe('../api/types.js');
    }
  });

  it('the road stack never mentions a topology identifier', () => {
    for (const module of ROAD_MODULES) {
      const text = source(module);
      for (const identifier of [
        'TOPOLOGY_SEGMENT_SOURCE_ID',
        'TOPOLOGY_NODE_SOURCE_ID',
        'atlasTopologyId',
        'atlasDegreeCategory',
        'degreeCategory',
      ]) {
        expect(text).not.toContain(identifier);
      }
    }
  });

  it('topology never reads or writes a road rendering property', () => {
    for (const module of TOPOLOGY_MODULES) {
      const text = source(module);
      // `atlasId` is the road stack's feature-id property; topology has its
      // own. Flattening topology into road properties is what this forbids.
      expect(text).not.toContain("'atlasId'");
      expect(text).not.toContain('roadClass');
    }
  });
});

/**
 * A map holding both stacks, recording every call, so a test can prove which
 * layers a profile switch touches.
 */
class BothStacksMap {
  readonly touched: string[] = [];
  private readonly layerIds: Set<string>;

  constructor() {
    this.layerIds = new Set([
      ...roadLayers().map((layer: LayerSpecification) => layer.id),
      ...topologyLayers().map((layer: LayerSpecification) => layer.id),
    ]);
  }

  getLayer(id: string): unknown {
    return this.layerIds.has(id) ? { id } : undefined;
  }

  // The unused parameters are deliberately not declared: what a profile
  // switch *writes* is the subject of `accessOverlay.test.ts`, and what this
  // records is only which layer ids it reached for.
  setFilter(id: string): void {
    this.touched.push(id);
  }

  setLayoutProperty(id: string): void {
    this.touched.push(id);
  }
}

describe('switching profile leaves topology alone', () => {
  it('touches no topology layer, for any profile', () => {
    for (const profile of TRAVEL_PROFILES) {
      const map = new BothStacksMap();
      expect(applyAccessProfile(map, profile)).toBe(true);
      expect(applyDirectionProfile(map, profile)).toBe(true);
      expect(map.touched.length).toBeGreaterThan(0);
      for (const id of map.touched) {
        expect(TOPOLOGY_LAYER_IDS).not.toContain(id);
      }
    }
  });

  it('cannot issue any request, topology or otherwise', () => {
    // Neither profile-switch function is given a runner, a fetch or a URL, so
    // there is nothing for it to call. The `fetch` spy proves it in practice
    // as well as in the signature.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const map = new BothStacksMap();
    for (const profile of TRAVEL_PROFILES) {
      applyAccessProfile(map, profile);
      applyDirectionProfile(map, profile);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('is a pure filter swap: no source is read or written', () => {
    // `AccessLayerTarget` and `DirectionLayerTarget` between them offer
    // `getLayer`, `setFilter` and `setLayoutProperty` and nothing else. A
    // profile switch that wanted to touch a source, a viewport or a fetch
    // would have to widen one of those interfaces first.
    const map = new BothStacksMap();
    applyAccessProfile(map, 'bicycle');
    applyDirectionProfile(map, 'bicycle');
    expect(Object.getOwnPropertyNames(BothStacksMap.prototype).sort()).toEqual([
      'constructor',
      'getLayer',
      'setFilter',
      'setLayoutProperty',
    ]);
  });
});

describe('the main composition wires topology as an opt-in overlay', () => {
  const main = source('main.ts');

  it('starts with the toggle off, in every build', () => {
    expect(main).toContain('topologyToggle.checked = false;');
    // The diagnostics toggle follows the build mode; the topology one never
    // does, so a dev build makes no topology request either.
    expect(main).not.toContain('topologyToggle.checked = import.meta.env.DEV');
  });

  it('uses a separate toggle from the diagnostics one', () => {
    expect(main).toContain("requireElement<HTMLInputElement>('toggle-topology')");
    expect(main).toContain("requireElement<HTMLInputElement>('toggle-debug')");
  });

  it('clears stale topology when the dataset is replaced, before querying again', () => {
    const replacement = main.indexOf('if (dataset.datasetId !== previousId)');
    const cleared = main.indexOf('clearTopology()', replacement);
    const requested = main.indexOf('requestTopologyViewport(true)', replacement);
    expect(replacement).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(replacement);
    expect(requested).toBeGreaterThan(cleared);
  });

  it('never refetches road features when the overlay is toggled', () => {
    const enable = main.slice(
      main.indexOf('function enableTopology'),
      main.indexOf('function disableTopology'),
    );
    const disable = main.slice(
      main.indexOf('function disableTopology'),
      main.indexOf('function clearTopology'),
    );
    for (const body of [enable, disable]) {
      expect(body).not.toContain('requestViewport(');
      expect(body).not.toContain('queryController.');
      expect(body).not.toContain('fetchFeatures');
      expect(body).not.toContain('ROAD_SOURCE_ID');
    }
  });

  it('switching profile runs no topology code at all', () => {
    const body = main.slice(
      main.indexOf('function selectProfile'),
      main.indexOf('function applyHighlights'),
    );
    expect(body).not.toContain('topology');
    expect(body).not.toContain('Topology');
  });
});
