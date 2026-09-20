/**
 * The access overlay legend.
 *
 * Small, local and static: three swatches drawn with the same colours and dash
 * rhythms the map uses, plus the category that has no overlay at all. It is
 * rendered once and never re-rendered on a profile change, because the
 * categories do not depend on the profile — only which roads fall into them
 * does.
 *
 * The swatches are inline SVG generated here. Nothing is fetched: no sprite,
 * no icon font, no image.
 */

import { CATEGORY_LABELS, OVERLAY_CATEGORIES, type AccessCategory } from '../map/access.js';
import { ACCESS_OVERLAY_STYLE } from '../map/accessOverlay.js';
import { clear, element } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const SWATCH_WIDTH = 36;
const SWATCH_HEIGHT = 10;
const SWATCH_STROKE = 3;

/** The categories the legend lists, in the order the map stacks them. */
export const LEGEND_CATEGORIES: AccessCategory[] = ['ordinary', ...OVERLAY_CATEGORIES];

/** The road colour a swatch draws its overlay on top of. */
const SWATCH_ROAD_COLOR = '#8fb6ff';

function swatch(category: AccessCategory): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${SWATCH_WIDTH} ${SWATCH_HEIGHT}`);
  svg.setAttribute('width', String(SWATCH_WIDTH));
  svg.setAttribute('height', String(SWATCH_HEIGHT));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('legend-swatch');

  const middle = SWATCH_HEIGHT / 2;
  const road = document.createElementNS(SVG_NS, 'line');
  road.setAttribute('x1', '1');
  road.setAttribute('y1', String(middle));
  road.setAttribute('x2', String(SWATCH_WIDTH - 1));
  road.setAttribute('y2', String(middle));
  road.setAttribute('stroke', SWATCH_ROAD_COLOR);
  road.setAttribute('stroke-width', String(SWATCH_STROKE));
  road.setAttribute('stroke-linecap', 'round');
  svg.append(road);

  if (category !== 'ordinary') {
    const style = ACCESS_OVERLAY_STYLE[category];
    const width = SWATCH_STROKE * style.widthScale;
    const overlay = document.createElementNS(SVG_NS, 'line');
    overlay.setAttribute('x1', '1');
    overlay.setAttribute('y1', String(middle));
    overlay.setAttribute('x2', String(SWATCH_WIDTH - 1));
    overlay.setAttribute('y2', String(middle));
    overlay.setAttribute('stroke', style.color);
    overlay.setAttribute('stroke-width', String(width));
    // MapLibre's dash array is in line widths; SVG's is in user units, so the
    // same rhythm has to be scaled by the stroke width to look the same.
    overlay.setAttribute(
      'stroke-dasharray',
      style.dashArray.map((dash) => (dash * width).toFixed(2)).join(' '),
    );
    svg.append(overlay);
  }

  return svg;
}

export class AccessLegend {
  constructor(private readonly root: HTMLElement) {}

  render(): void {
    clear(this.root);
    const list = element('ul', 'legend');
    for (const category of LEGEND_CATEGORIES) {
      const item = element('li', 'legend-item');
      item.dataset.category = category;
      item.append(swatch(category), element('span', 'legend-label', CATEGORY_LABELS[category]));
      list.append(item);
    }
    this.root.append(list);
  }
}
