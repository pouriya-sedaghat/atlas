// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { ACCESS_CATEGORIES, CATEGORY_LABELS, OVERLAY_CATEGORIES } from '../src/map/access.js';
import { ACCESS_OVERLAY_STYLE } from '../src/map/accessOverlay.js';
import { AccessLegend, LEGEND_CATEGORIES } from '../src/ui/legend.js';

let root: HTMLElement;
let legend: AccessLegend;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  legend = new AccessLegend(root);
});

describe('AccessLegend', () => {
  it('lists every category the map can draw, ordinary first', () => {
    legend.render();
    const items = [...root.querySelectorAll('.legend-item')];
    expect(items).toHaveLength(ACCESS_CATEGORIES.length);
    expect(items.map((item) => (item as HTMLElement).dataset.category)).toEqual(LEGEND_CATEGORIES);
    expect(LEGEND_CATEGORIES).toEqual(['ordinary', ...OVERLAY_CATEGORIES]);
  });

  it('names each category in words', () => {
    legend.render();
    for (const category of ACCESS_CATEGORIES) {
      expect(root.textContent).toContain(CATEGORY_LABELS[category]);
    }
  });

  it('draws each overlay swatch in the colour and rhythm the map uses', () => {
    legend.render();
    for (const category of OVERLAY_CATEGORIES) {
      const item = root.querySelector(`[data-category="${category}"]`);
      const overlay = item?.querySelectorAll('line')[1];
      expect(overlay?.getAttribute('stroke')).toBe(ACCESS_OVERLAY_STYLE[category].color);
      // The dash array is scaled into SVG user units, so it is the rhythm that
      // must match, not the raw numbers.
      const dashes = (overlay?.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
      expect(dashes).toHaveLength(ACCESS_OVERLAY_STYLE[category].dashArray.length);
      const scale = dashes[0]! / ACCESS_OVERLAY_STYLE[category].dashArray[0]!;
      for (const [index, dash] of ACCESS_OVERLAY_STYLE[category].dashArray.entries()) {
        expect(dashes[index]).toBeCloseTo(dash * scale, 5);
      }
    }
  });

  it('draws the ordinary swatch as a bare road with no overlay on it', () => {
    legend.render();
    const ordinary = root.querySelector('[data-category="ordinary"]');
    expect(ordinary?.querySelectorAll('line')).toHaveLength(1);
    for (const category of OVERLAY_CATEGORIES) {
      expect(
        root.querySelector(`[data-category="${category}"]`)?.querySelectorAll('line'),
      ).toHaveLength(2);
    }
  });

  it('fetches nothing: every swatch is inline SVG', () => {
    legend.render();
    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toMatch(/https?:\/\//);
    expect(root.querySelectorAll('svg').length).toBe(ACCESS_CATEGORIES.length);
  });

  it('hides the decorative swatches from assistive technology', () => {
    legend.render();
    for (const svg of root.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('is idempotent, so a re-render never doubles the list', () => {
    legend.render();
    legend.render();
    expect(root.querySelectorAll('.legend-item')).toHaveLength(ACCESS_CATEGORIES.length);
  });
});
