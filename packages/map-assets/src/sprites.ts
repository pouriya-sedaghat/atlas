import { coverage, flatten, type Contour, type PathCommand } from './raster.js';
import { POI_ICON_VALUES, type Theme } from './style.js';
import type { OtFont } from './glyphs.js';

/**
 * Generated test-client icon set: a coloured disc with a short Latin label drawn from the bundled
 * font, plus a generic fallback dot and a one-way arrow. Simple and fully local; not a final
 * cartographic icon design.
 */
const CATEGORY_COLOR: Record<string, string> = {
  health: '#d32f2f',
  emergency: '#c62828',
  pharmacy: '#2e7d32',
  food: '#ef6c00',
  education: '#6d4c41',
  transport: '#1565c0',
  tourism: '#8e24aa',
  government: '#455a64',
  worship: '#5d4037',
  leisure: '#388e3c',
  shop: '#7b1fa2',
  finance: '#00838f',
  generic: '#757575',
};

const ICONS: Record<string, [label: string, category: keyof typeof CATEGORY_COLOR]> = {
  hospital: ['H', 'health'], clinic: ['+', 'health'], doctors: ['Dr', 'health'], dentist: ['De', 'health'],
  pharmacy: ['Rx', 'pharmacy'], police: ['Po', 'emergency'], fire_station: ['F', 'emergency'], ambulance_station: ['A', 'emergency'],
  fuel: ['G', 'transport'], parking: ['P', 'transport'], station: ['St', 'transport'], bus_station: ['B', 'transport'],
  school: ['S', 'education'], university: ['U', 'education'], college: ['C', 'education'], kindergarten: ['K', 'education'], library: ['L', 'education'],
  restaurant: ['R', 'food'], fast_food: ['FF', 'food'], cafe: ['Ca', 'food'], food_court: ['Fc', 'food'],
  place_of_worship: ['W', 'worship'], mosque: ['M', 'worship'],
  bank: ['$', 'finance'], atm: ['$', 'finance'],
  hotel: ['Ht', 'tourism'], guest_house: ['Gh', 'tourism'], hostel: ['Hs', 'tourism'], museum: ['Mu', 'tourism'], attraction: ['At', 'tourism'],
  monument: ['Hi', 'tourism'], memorial: ['Me', 'tourism'], castle: ['Ct', 'tourism'],
  government: ['Gv', 'government'], townhall: ['T', 'government'], post_office: ['Pt', 'government'],
  park: ['Pk', 'leisure'], marketplace: ['Mk', 'shop'], supermarket: ['Sm', 'shop'], bakery: ['Bk', 'shop'], convenience: ['Cv', 'shop'], mall: ['Ml', 'shop'],
};

export interface SpriteEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelRatio: number;
}

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function circle(cx: number, cy: number, r: number): Contour {
  const pts: Contour = [];
  for (let i = 0; i < 48; i++) pts.push([cx + r * Math.cos((i / 48) * Math.PI * 2), cy + r * Math.sin((i / 48) * Math.PI * 2)]);
  return pts;
}

function blend(rgba: Uint8Array, w: number, x0: number, y0: number, cov: Float32Array, cw: number, ch: number, color: [number, number, number]): void {
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = cov[y * cw + x]!;
      if (a <= 0) continue;
      const i = ((y0 + y) * w + (x0 + x)) * 4;
      const da = rgba[i + 3]! / 255;
      const oa = a + da * (1 - a);
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round((color[k]! * a + rgba[i + k]! * da * (1 - a)) / (oa || 1));
      rgba[i + 3] = Math.round(oa * 255);
    }
  }
}

function textContours(font: OtFont, text: string, size: number, cx: number, cy: number): Contour[] {
  const scale = size / font.unitsPerEm;
  let width = 0;
  const glyphs = [...text].map((ch) => font.charToGlyph(ch));
  for (const g of glyphs) width += (g.advanceWidth ?? 0) * scale;
  let x = cx - width / 2;
  const baseline = cy + size * 0.36;
  const out: Contour[] = [];
  for (const g of glyphs) {
    out.push(...flatten(g.getPath(x, baseline, size).commands as PathCommand[]));
    x += (g.advanceWidth ?? 0) * scale;
  }
  return out;
}

/** Render the sprite sheet for one theme and pixel ratio. */
export function buildSprite(font: OtFont, theme: Theme, pixelRatio: 1 | 2): { width: number; height: number; rgba: Uint8Array; index: Record<string, SpriteEntry> } {
  const cell = 20 * pixelRatio;
  const names = ['poi-generic', 'oneway', ...POI_ICON_VALUES.map((v) => `poi-${v}`)];
  const cols = 8;
  const rows = Math.ceil(names.length / cols);
  const width = cols * cell;
  const height = rows * cell;
  const rgba = new Uint8Array(width * height * 4);
  const index: Record<string, SpriteEntry> = {};
  const ring: [number, number, number] = theme === 'light' ? [255, 255, 255] : [24, 26, 30];
  const fg: [number, number, number] = [255, 255, 255];
  names.forEach((name, i) => {
    const x0 = (i % cols) * cell;
    const y0 = Math.floor(i / cols) * cell;
    const c = cell / 2;
    if (name === 'oneway') {
      const s = pixelRatio;
      const arrow: Contour = [[3 * s, 8 * s], [12 * s, 8 * s], [12 * s, 5 * s], [17 * s, 10 * s], [12 * s, 15 * s], [12 * s, 12 * s], [3 * s, 12 * s]];
      blend(rgba, width, x0, y0, coverage([arrow], cell, cell), cell, cell, theme === 'light' ? [120, 120, 120] : [170, 170, 170]);
    } else {
      const value = name.slice(4);
      const [label, cat] = ICONS[value] ?? ['', 'generic'];
      blend(rgba, width, x0, y0, coverage([circle(c, c, cell * 0.47)], cell, cell), cell, cell, ring);
      const radius = value === 'generic' ? cell * 0.24 : cell * 0.4;
      blend(rgba, width, x0, y0, coverage([circle(c, c, radius)], cell, cell), cell, cell, hex(CATEGORY_COLOR[cat]!));
      if (label) {
        const size = (label.length > 1 ? 8.5 : 11) * pixelRatio;
        blend(rgba, width, x0, y0, coverage(textContours(font, label, size, c, c), cell, cell), cell, cell, fg);
      }
    }
    index[name] = { x: x0, y: y0, width: cell, height: cell, pixelRatio };
  });
  return { width, height, rgba, index };
}
