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
    properties: {
      kind: 'road',
      roadClass: 'residential',
      traversal: {
        motorcar: { direction: 'forward' },
        bicycle: { direction: 'both' },
        foot: { direction: 'indeterminate' },
      },
      ...overrides,
    },
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

  it('shows all three profile directions, not only the selected one', () => {
    // The interesting roads are the ones where the profiles disagree, and a
    // disagreement is invisible one profile at a time.
    panel.render({ feature: feature(), inCurrentViewport: true }, 'bicycle');

    const text = root.textContent ?? '';
    expect(text).toContain('Car direction');
    expect(text).toContain('Bicycle direction');
    expect(text).toContain('Foot direction');
    expect(text).toContain('One-way · forward');
    expect(text).toContain('Two-way');
    expect(text).toContain('Indeterminate · not stated');
  });

  it('marks the selected profile without hiding the others', () => {
    panel.render({ feature: feature(), inCurrentViewport: true }, 'foot');
    const active = root.querySelectorAll('.row-active');
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toBe('Foot direction');
    expect(active[0]?.getAttribute('aria-current')).toBe('true');
  });

  it('defaults to the car profile', () => {
    panel.render({ feature: feature(), inCurrentViewport: true });
    expect(root.querySelector('.row-active')?.textContent).toBe('Car direction');
  });

  it('labels dynamic directions as changing rather than as a one-way', () => {
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'reversible' },
            bicycle: { direction: 'alternating' },
            foot: { direction: 'reverse' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const text = root.textContent ?? '';
    expect(text).toContain('Reversible · direction changes');
    expect(text).toContain('Alternating · direction changes');
    expect(text).toContain('One-way · reverse');
  });

  it('says indeterminate when the server sent no traversal at all', () => {
    panel.render(
      {
        feature: {
          ...feature(),
          properties: { kind: 'road', roadClass: 'service', name: 'Old Server Road' },
        },
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const values = [...root.querySelectorAll('dd[data-direction]')].map((node) =>
      node.getAttribute('data-direction'),
    );
    expect(values).toEqual(['indeterminate', 'indeterminate', 'indeterminate']);
  });

  it('renders untrusted names as text, never as markup', () => {
    const hostile = '<img src=x onerror="globalThis.hacked = true">';
    panel.render({ feature: feature({ name: hostile }), inCurrentViewport: true });

    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('<img');
    expect(root.textContent).toContain(hostile);
  });

  it('renders a hostile direction value as text and as no direction at all', () => {
    // Direction values come off the wire like everything else. An unknown one
    // reads as indeterminate, and it certainly never becomes markup.
    const hostile = '<script>globalThis.hacked = true</script>';
    panel.render(
      {
        feature: feature({
          name: 'Hostile Road',
          traversal: {
            motorcar: { direction: hostile },
            bicycle: { direction: hostile },
            foot: { direction: hostile },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );

    expect(root.querySelector('script')).toBeNull();
    expect(root.innerHTML).not.toContain('<script');
    expect(root.textContent).not.toContain(hostile);
    expect(root.textContent).toContain('Indeterminate · not stated');
  });
});
