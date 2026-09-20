import { describe, expect, it } from 'vitest';

import { ARROW_IMAGE_ID, ARROW_PIXEL_RATIO, createArrowImage } from '../src/map/arrowImage.js';

function alphaAt(image: ReturnType<typeof createArrowImage>, column: number, row: number): number {
  return image.data[(row * image.width + column) * 4 + 3]!;
}

describe('createArrowImage', () => {
  it('produces a square RGBA buffer of the requested size', () => {
    const image = createArrowImage(20);
    expect(image.width).toBe(20);
    expect(image.height).toBe(20);
    expect(image.data).toBeInstanceOf(Uint8Array);
    expect(image.data.length).toBe(20 * 20 * 4);
  });

  it('is byte-for-byte deterministic', () => {
    // The same arrow every run, on every machine: no canvas, no fonts, no
    // device pixel ratio, nothing to vary.
    expect(Array.from(createArrowImage(16).data)).toEqual(Array.from(createArrowImage(16).data));
  });

  it('is transparent at the corners and opaque in the body', () => {
    const image = createArrowImage(20);
    for (const [column, row] of [
      [0, 0],
      [19, 0],
      [0, 19],
      [19, 19],
    ] as const) {
      expect(alphaAt(image, column, row)).toBe(0);
    }
    // A point well inside the triangle, on its axis.
    expect(alphaAt(image, 8, 10)).toBe(255);
  });

  it('is symmetric about the horizontal axis', () => {
    // Rotating the arrow 180 degrees has to yield the same shape pointing the
    // other way, or a reverse road would render subtly differently.
    const image = createArrowImage(20);
    for (let row = 0; row < image.height; row += 1) {
      for (let column = 0; column < image.width; column += 1) {
        expect(alphaAt(image, column, row)).toBe(alphaAt(image, column, image.height - 1 - row));
      }
    }
  });

  it('points along +x, so more of it is drawn on the left than the right', () => {
    const image = createArrowImage(20);
    let left = 0;
    let right = 0;
    for (let row = 0; row < image.height; row += 1) {
      for (let column = 0; column < image.width; column += 1) {
        const alpha = alphaAt(image, column, row);
        if (column < image.width / 2) {
          left += alpha;
        } else {
          right += alpha;
        }
      }
    }
    expect(left).toBeGreaterThan(right);
  });

  it('writes only byte values', () => {
    const image = createArrowImage(12);
    for (const value of image.data) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });

  it('exports a stable image id and pixel ratio', () => {
    expect(ARROW_IMAGE_ID).toBe('atlas-direction-arrow');
    expect(ARROW_PIXEL_RATIO).toBe(2);
  });
});
