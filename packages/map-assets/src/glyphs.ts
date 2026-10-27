import { coverage, flatten, sdfFromCoverage, type PathCommand } from './raster.js';
import { encodeGlyphRange, type GlyphRecord } from './encode.js';

/** Subset of the opentype.js API used here (opentype.js 2.0.0). */
export interface OtFont {
  unitsPerEm: number;
  tables: { hhea: { ascender: number } };
  charToGlyphIndex(ch: string): number;
  charToGlyph(ch: string): OtGlyph;
}
export interface OtGlyph {
  advanceWidth?: number;
  getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  getPath(x: number, y: number, fontSize: number): { commands: PathCommand[] };
}

export const FONT_SIZE = 24;
export const BUFFER = 3;
/**
 * Vertical origin convention: PBF `top` = glyph top above baseline minus TOP_ADJUSTMENT. MapLibre
 * aligns its own TinySDF (font-faces) glyphs with server glyphs using 27.5; 27 keeps the two
 * paths visually consistent for this font.
 */
export const TOP_ADJUSTMENT = 27;

export function renderGlyph(font: OtFont, codePoint: number): GlyphRecord | null {
  const ch = String.fromCodePoint(codePoint);
  if (font.charToGlyphIndex(ch) <= 0) return null;
  const glyph = font.charToGlyph(ch);
  const scale = FONT_SIZE / font.unitsPerEm;
  const advance = Math.max(0, Math.round((glyph.advanceWidth ?? 0) * scale));
  const bb = glyph.getBoundingBox();
  const empty = !Number.isFinite(bb.x1) || bb.x2 <= bb.x1 || bb.y2 <= bb.y1;
  if (empty) return { id: codePoint, bitmap: new Uint8Array(0), width: 0, height: 0, left: 0, top: -TOP_ADJUSTMENT, advance };
  const left = Math.floor(bb.x1 * scale);
  const right = Math.ceil(bb.x2 * scale);
  const top = Math.ceil(bb.y2 * scale);
  const bottom = Math.floor(bb.y1 * scale);
  const width = Math.max(1, right - left);
  const height = Math.max(1, top - bottom);
  const path = glyph.getPath(-left, top, FONT_SIZE);
  const cov = coverage(flatten(path.commands), width, height);
  const bitmap = sdfFromCoverage(cov, width, height, BUFFER);
  return { id: codePoint, bitmap, width, height, left, top: top - TOP_ADJUSTMENT, advance };
}

/** Encode one 256-code-point range ("start-end") for a font stack; empty ranges are valid. */
export function buildRange(font: OtFont, stack: string, start: number): { pbf: Uint8Array; count: number } {
  const end = start + 255;
  const glyphs: GlyphRecord[] = [];
  for (let cp = start; cp <= end; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const g = renderGlyph(font, cp);
    if (g) glyphs.push(g);
  }
  return { pbf: encodeGlyphRange(stack, `${start}-${end}`, glyphs), count: glyphs.length };
}
