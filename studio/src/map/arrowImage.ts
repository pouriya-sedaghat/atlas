/**
 * The direction arrow, rasterised here at runtime.
 *
 * Atlas Studio loads nothing from the network but the Atlas API: no sprite
 * sheet, no glyph server, no icon CDN. MapLibre will happily take a raw RGBA
 * buffer, so the arrow is drawn with arithmetic instead of fetched.
 *
 * Deliberately not a canvas: a pure rasteriser is testable without a DOM, is
 * byte-for-byte deterministic, and cannot be defeated by a headless browser
 * that ships no 2D context.
 */

/** The image name the direction layer refers to. */
export const ARROW_IMAGE_ID = 'atlas-direction-arrow';

/** The pixel ratio the image is drawn at. */
export const ARROW_PIXEL_RATIO = 2;

/** A raw RGBA image, in the shape MapLibre's `addImage` accepts. */
export interface ArrowImage {
  width: number;
  height: number;
  /** Non-premultiplied RGBA, row-major, four bytes per pixel. */
  data: Uint8Array;
}

type Point = readonly [number, number];

/**
 * The arrow points along +x.
 *
 * With `symbol-placement: line` MapLibre rotates an icon so that its
 * horizontal axis follows the line, so an arrow drawn pointing right follows
 * the coordinate order, and `icon-rotate: 180` turns it against the order.
 * Nothing here has to know which way round that is: the shape is symmetric
 * about the horizontal axis, so a 180° turn is the only thing that changes.
 */
const ARROW: readonly Point[] = [
  [0.2, 0.13],
  [0.88, 0.5],
  [0.2, 0.87],
];

/** How much larger the dark rim is than the bright body. */
const RIM_SCALE = 1.22;

/** A dark rim keeps the arrow readable on a light road colour. */
const RIM_RGB: Point3 = [5, 8, 13];
/** The body colour, matching the Studio foreground. */
const BODY_RGB: Point3 = [230, 236, 245];

type Point3 = readonly [number, number, number];

/** Samples per axis inside each pixel; 4 gives 16 coverage steps. */
const SUBSAMPLES = 4;

function centroid(polygon: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const [px, py] of polygon) {
    x += px;
    y += py;
  }
  return [x / polygon.length, y / polygon.length];
}

function scaleAboutCentroid(polygon: readonly Point[], scale: number): Point[] {
  const [cx, cy] = centroid(polygon);
  return polygon.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale] as Point);
}

/** Winding test for a convex polygon given in a consistent orientation. */
function contains(polygon: readonly Point[], x: number, y: number): boolean {
  let positive = false;
  let negative = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const [ax, ay] = polygon[index]!;
    const [bx, by] = polygon[(index + 1) % polygon.length]!;
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross > 0) {
      positive = true;
    } else if (cross < 0) {
      negative = true;
    }
    if (positive && negative) {
      return false;
    }
  }
  return true;
}

/** The fraction of one pixel covered by a polygon, in unit coordinates. */
function coverage(polygon: readonly Point[], column: number, row: number, size: number): number {
  let hits = 0;
  for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
    const y = (row + (sy + 0.5) / SUBSAMPLES) / size;
    for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
      const x = (column + (sx + 0.5) / SUBSAMPLES) / size;
      if (contains(polygon, x, y)) {
        hits += 1;
      }
    }
  }
  return hits / (SUBSAMPLES * SUBSAMPLES);
}

/**
 * Draws the arrow.
 *
 * Only the top half is rasterised; the bottom is mirrored from it. That is
 * cheaper, and it makes the vertical symmetry exact rather than dependent on
 * floating-point luck at the edges.
 */
export function createArrowImage(size = 20): ArrowImage {
  const rim = scaleAboutCentroid(ARROW, RIM_SCALE);
  const data = new Uint8Array(size * size * 4);
  const half = Math.ceil(size / 2);

  for (let row = 0; row < half; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const outer = coverage(rim, column, row, size);
      const inner = coverage(ARROW, column, row, size);
      const [red, green, blue, alpha] = pixel(outer, inner);

      const top = (row * size + column) * 4;
      data[top] = red;
      data[top + 1] = green;
      data[top + 2] = blue;
      data[top + 3] = alpha;

      const mirrored = size - 1 - row;
      if (mirrored !== row) {
        const bottom = (mirrored * size + column) * 4;
        data[bottom] = red;
        data[bottom + 1] = green;
        data[bottom + 2] = blue;
        data[bottom + 3] = alpha;
      }
    }
  }

  return { width: size, height: size, data };
}

/** Composites the bright body over the dark rim for one pixel. */
function pixel(outer: number, inner: number): [number, number, number, number] {
  if (outer <= 0) {
    return [0, 0, 0, 0];
  }
  const blend = Math.min(inner / outer, 1);
  const channel = (index: 0 | 1 | 2): number =>
    Math.round(RIM_RGB[index] + (BODY_RGB[index] - RIM_RGB[index]) * blend);
  return [channel(0), channel(1), channel(2), Math.round(outer * 255)];
}
