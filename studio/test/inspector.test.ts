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
        motorcar: {
          direction: 'forward',
          access: 'destination-only',
          speedLimits: {
            forward: {
              limit: { kind: 'numeric', value: '50', unit: 'km/h' },
              conditional: false,
              variable: 'not-tagged',
            },
            backward: {
              limit: { kind: 'numeric', value: '30', unit: 'mph' },
              conditional: true,
              variable: 'fixed',
            },
          },
        },
        bicycle: {
          direction: 'both',
          access: 'designated',
          speedLimits: {
            forward: {
              limit: { kind: 'walking-pace' },
              conditional: false,
              variable: 'not-tagged',
            },
            backward: {
              limit: { kind: 'no-fixed-limit' },
              conditional: false,
              variable: 'variable',
            },
          },
        },
        foot: {
          direction: 'indeterminate',
          access: 'unspecified',
          speedLimits: {
            forward: {
              limit: { kind: 'implicit', code: 'RO:urban' },
              conditional: false,
              variable: 'not-tagged',
            },
            backward: {
              limit: { kind: 'unspecified' },
              conditional: false,
              variable: 'not-tagged',
            },
          },
        },
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

  it('shows all twelve semantic rows, whichever profile is selected', () => {
    // Twelve rows, always: the interesting roads are the ones where the
    // profiles disagree, where a road runs one way and is closed the other,
    // or where it is signed differently in each geometry direction.
    panel.render({ feature: feature(), inCurrentViewport: true }, 'bicycle');
    const terms = [...root.querySelectorAll('dt')].map((node) => node.textContent);
    for (const expected of [
      'Car direction',
      'Car access',
      'Car forward speed',
      'Car backward speed',
      'Bicycle direction',
      'Bicycle access',
      'Bicycle forward speed',
      'Bicycle backward speed',
      'Foot direction',
      'Foot access',
      'Foot forward speed',
      'Foot backward speed',
    ]) {
      expect(terms).toContain(expected);
    }
  });

  it('renders every access value in words', () => {
    panel.render({ feature: feature(), inCurrentViewport: true }, 'motorcar');
    const text = root.textContent ?? '';
    expect(text).toContain('Destination traffic only');
    expect(text).toContain('Designated');
    // `unspecified` must never read as a permission.
    expect(text).toContain('Not stated');
    expect(text).not.toContain('Allowed');
  });

  it('keeps access and direction apart on a road that is both one-way and closed', () => {
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'forward', access: 'prohibited' },
            bicycle: { direction: 'forward', access: 'allowed' },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const directions = [...root.querySelectorAll('dd[data-direction]')].map((node) =>
      node.getAttribute('data-direction'),
    );
    const access = [...root.querySelectorAll('dd[data-access]')].map((node) =>
      node.getAttribute('data-access'),
    );
    expect(directions).toEqual(['forward', 'forward', 'both']);
    expect(access).toEqual(['prohibited', 'allowed', 'allowed']);
  });

  it('says indeterminate when the server sent directions but no access', () => {
    // An older server. Studio must not turn its silence into `unspecified`,
    // which would be a claim about the source it never made.
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'forward' },
            bicycle: { direction: 'both' },
            foot: { direction: 'both' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const access = [...root.querySelectorAll('dd[data-access]')].map((node) =>
      node.getAttribute('data-access'),
    );
    expect(access).toEqual(['indeterminate', 'indeterminate', 'indeterminate']);
    expect(root.textContent).not.toContain('Not stated');
  });

  it('degrades an unknown future access value to indeterminate', () => {
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'both', access: 'toll-required' },
            bicycle: { direction: 'both', access: 'allowed' },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const access = [...root.querySelectorAll('dd[data-access]')].map((node) =>
      node.getAttribute('data-access'),
    );
    expect(access).toEqual(['indeterminate', 'allowed', 'allowed']);
    expect(root.textContent).not.toContain('toll-required');
  });

  it('renders a hostile access value as text and as no rule at all', () => {
    const hostile = '<img src=x onerror="globalThis.hacked = true">';
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'both', access: hostile },
            bicycle: { direction: 'both', access: hostile },
            foot: { direction: 'both', access: hostile },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('<img');
    expect(root.textContent).not.toContain(hostile);
    expect(root.textContent).toContain('Indeterminate · not derived');
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

  it('marks all four rows of the selected profile without hiding the others', () => {
    // Milestone 2C: a profile now owns four rows — a direction, an access and
    // a speed limit in each geometry direction — and the map draws from all
    // of them. Marking fewer would tell the reader that some of what they are
    // looking at belongs to some other profile.
    panel.render({ feature: feature(), inCurrentViewport: true }, 'foot');
    const active = [...root.querySelectorAll('.row-active')];
    expect(active.map((node) => node.textContent)).toEqual([
      'Foot direction',
      'Foot access',
      'Foot forward speed',
      'Foot backward speed',
    ]);
    for (const node of active) {
      expect(node.getAttribute('aria-current')).toBe('true');
    }
    // The other eight semantic rows are still there, just not marked.
    expect(root.querySelectorAll('dt').length).toBeGreaterThanOrEqual(12);
    const terms = [...root.querySelectorAll('dt')].map((node) => node.textContent);
    for (const other of [
      'Car direction',
      'Car access',
      'Car forward speed',
      'Car backward speed',
      'Bicycle direction',
      'Bicycle access',
      'Bicycle forward speed',
      'Bicycle backward speed',
    ]) {
      expect(terms).toContain(other);
    }
  });

  it('defaults to the car profile and marks all four of its rows', () => {
    panel.render({ feature: feature(), inCurrentViewport: true });
    expect([...root.querySelectorAll('.row-active')].map((node) => node.textContent)).toEqual([
      'Car direction',
      'Car access',
      'Car forward speed',
      'Car backward speed',
    ]);
  });

  it('moves the marking when the profile changes, keeping every row', () => {
    const selection = { feature: feature(), inCurrentViewport: true };
    panel.render(selection, 'motorcar');
    expect(root.querySelectorAll('dt')).toHaveLength(19);
    panel.render(selection, 'foot');
    expect([...root.querySelectorAll('.row-active')].map((node) => node.textContent)).toEqual([
      'Foot direction',
      'Foot access',
      'Foot forward speed',
      'Foot backward speed',
    ]);
    expect(root.querySelectorAll('dt')).toHaveLength(19);
    expect(root.textContent).toContain('Car direction');
    expect(root.textContent).toContain('Bicycle access');
    expect(root.textContent).toContain('Bicycle forward speed');
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

  it('renders every speed limit kind in words', () => {
    panel.render({ feature: feature(), inCurrentViewport: true }, 'motorcar');
    const text = root.textContent ?? '';
    // The units are the ones the source stated; Studio never converts.
    expect(text).toContain('50 km/h');
    expect(text).toContain('30 mph · conditional · explicitly fixed');
    expect(text).toContain('Walking pace');
    expect(text).toContain('No fixed limit · variable');
    expect(text).toContain('Implicit · RO:urban');
    // `unspecified` must never read as a number or a default.
    expect(text).toContain('Not stated');
  });

  it('keeps the two geometry directions apart on every profile', () => {
    panel.render({ feature: feature(), inCurrentViewport: true }, 'motorcar');
    const rows = [...root.querySelectorAll('dd[data-speed-direction]')];
    expect(rows.map((node) => node.getAttribute('data-speed-direction'))).toEqual([
      'forward',
      'backward',
      'forward',
      'backward',
      'forward',
      'backward',
    ]);
    expect(rows.map((node) => node.getAttribute('data-speed-kind'))).toEqual([
      'numeric',
      'numeric',
      'walking-pace',
      'no-fixed-limit',
      'implicit',
      'unspecified',
    ]);
  });

  it('shows both speed directions on a one-way road', () => {
    // `forward` and `backward` are relative to the coordinate order of the
    // geometry, not to the way the traffic runs, so a one-way road has two of
    // them like everything else.
    panel.render({ feature: feature(), inCurrentViewport: true }, 'motorcar');
    const terms = [...root.querySelectorAll('dt')].map((node) => node.textContent);
    expect(terms).toContain('Car direction');
    expect(terms).toContain('Car forward speed');
    expect(terms).toContain('Car backward speed');
    expect(root.textContent).toContain('One-way · forward');
  });

  it('shows a modifier beside the ordinary limit, never instead of it', () => {
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: {
              direction: 'both',
              access: 'allowed',
              speedLimits: {
                forward: {
                  limit: { kind: 'numeric', value: '80', unit: 'km/h' },
                  conditional: true,
                  variable: 'not-tagged',
                },
                backward: {
                  limit: { kind: 'numeric', value: '100', unit: 'km/h' },
                  conditional: false,
                  variable: 'variable',
                },
              },
            },
            bicycle: { direction: 'both', access: 'allowed' },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const text = root.textContent ?? '';
    expect(text).toContain('80 km/h · conditional');
    expect(text).toContain('100 km/h · variable');
  });

  it('says indeterminate when the server sent no speed block', () => {
    // A Milestone 2B server. Studio must not turn its silence into
    // `unspecified`, which would be a claim about the source it never made.
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: { direction: 'forward', access: 'allowed' },
            bicycle: { direction: 'both', access: 'allowed' },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const kinds = [...root.querySelectorAll('dd[data-speed-kind]')].map((node) =>
      node.getAttribute('data-speed-kind'),
    );
    expect(kinds).toEqual(Array<string>(6).fill('indeterminate'));
    expect(root.textContent).toContain('Indeterminate · not derived');
    expect(root.textContent).not.toContain('Not stated');
    // A missing boolean is not `false`.
    const conditional = [...root.querySelectorAll('dd[data-speed-conditional]')].map((node) =>
      node.getAttribute('data-speed-conditional'),
    );
    expect(conditional).toEqual(Array<string>(6).fill('indeterminate'));
  });

  it('degrades an unknown future speed kind to indeterminate', () => {
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: {
              direction: 'both',
              access: 'allowed',
              speedLimits: {
                forward: {
                  limit: { kind: 'advisory', value: '40', unit: 'km/h' },
                  conditional: false,
                  variable: 'not-tagged',
                },
                backward: {
                  limit: { kind: 'numeric', value: '40', unit: 'furlongs/fortnight' },
                  conditional: false,
                  variable: 'not-tagged',
                },
              },
            },
            bicycle: { direction: 'both', access: 'allowed' },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    const text = root.textContent ?? '';
    expect(text).not.toContain('advisory');
    expect(text).not.toContain('furlongs');
    expect(text).toContain('Indeterminate · not derived');
  });

  it('renders a hostile speed value as text and as no limit at all', () => {
    const hostile = '<img src=x onerror="globalThis.hacked = true">';
    panel.render(
      {
        feature: feature({
          traversal: {
            motorcar: {
              direction: 'both',
              access: 'allowed',
              speedLimits: {
                forward: {
                  limit: { kind: hostile, value: hostile, unit: hostile, code: hostile },
                  conditional: hostile as unknown as boolean,
                  variable: hostile,
                },
                backward: {
                  limit: { kind: 'numeric', value: hostile, unit: 'km/h' },
                  conditional: false,
                  variable: 'not-tagged',
                },
              },
            },
            bicycle: {
              direction: 'both',
              access: 'allowed',
              speedLimits: {
                forward: { limit: { kind: 'implicit', code: hostile } },
                backward: { limit: { kind: 'implicit', code: 'XX:<script>' } },
              },
            },
            foot: { direction: 'both', access: 'allowed' },
          },
        }),
        inCurrentViewport: true,
      },
      'motorcar',
    );
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.innerHTML).not.toContain('<img');
    expect(root.innerHTML).not.toContain('<script');
    expect(root.textContent).not.toContain(hostile);
    expect(root.textContent).not.toContain('onerror');
    expect(root.textContent).toContain('Indeterminate · not derived');
    const kinds = [...root.querySelectorAll('dd[data-speed-kind]')].map((node) =>
      node.getAttribute('data-speed-kind'),
    );
    // Only the pedestrian rows, which carried no speed block at all, and
    // every hostile one alike: nothing hostile survived as a rendered kind.
    expect(new Set(kinds)).toEqual(new Set(['indeterminate']));
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
