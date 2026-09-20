// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import type { AtlasFeature } from '../src/api/types.js';
import { InspectorPanel } from '../src/ui/inspector.js';

function feature(overrides: Partial<AtlasFeature['properties']> = {}): AtlasFeature {
  return {
    type: 'Feature',
    id: 'osm:way:101',
    geometry: {
      type: 'LineString',
      coordinates: [
        [51.388, 35.689],
        [51.39, 35.69],
        [51.392, 35.691],
      ],
    },
    properties: { kind: 'road', roadClass: 'residential', ...overrides },
  };
}

let root: HTMLElement;
let panel: InspectorPanel;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  panel = new InspectorPanel(root);
});

describe('InspectorPanel', () => {
  it('prompts when nothing is selected', () => {
    panel.render(null);
    expect(root.textContent).toContain('Click a road to inspect it.');
  });

  it('shows every field the inspector promises', () => {
    panel.render({
      feature: feature({
        name: 'خیابان ولیعصر',
        source: { system: 'openstreetmap', entityType: 'way', entityId: '101' },
      }),
      inCurrentViewport: true,
    });

    const text = root.textContent ?? '';
    expect(text).toContain('osm:way:101');
    expect(text).toContain('road');
    expect(text).toContain('residential');
    expect(text).toContain('خیابان ولیعصر');
    expect(text).toContain('openstreetmap:way/101');
    // Coordinate count and bounds.
    expect(text).toContain('3');
    expect(text).toContain('51.38800, 35.68900, 51.39200, 35.69100');
  });

  it('says so when the source reference was not requested', () => {
    panel.render({ feature: feature({ name: 'Service Lane' }), inCurrentViewport: true });
    expect(root.textContent).toContain('not included');
  });

  it('keeps a selection that has scrolled out of the queried viewport', () => {
    panel.render({ feature: feature({ name: 'Service Lane' }), inCurrentViewport: false });
    expect(root.textContent).toContain('outside the current viewport query');
  });

  it('renders untrusted names as text, never as markup', () => {
    const hostile = '<img src=x onerror="globalThis.hacked = true">';
    panel.render({ feature: feature({ name: hostile }), inCurrentViewport: true });

    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('<img');
    expect(root.textContent).toContain(hostile);
  });
});
