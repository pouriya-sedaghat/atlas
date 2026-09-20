import { describe, expect, it } from 'vitest';

import {
  bboxesEqual,
  boundsOfCoordinates,
  formatBbox,
  normalizeViewportBbox,
} from '../src/viewport/bbox.js';

describe('normalizeViewportBbox', () => {
  it('passes an ordinary viewport straight through', () => {
    expect(normalizeViewportBbox(51.38, 35.68, 51.4, 35.7)).toEqual([51.38, 35.68, 51.4, 35.7]);
  });

  it('clamps a viewport that runs past the poles', () => {
    expect(normalizeViewportBbox(10, -120, 20, 120)).toEqual([10, -90, 20, 90]);
  });

  it('widens a viewport that wraps the antimeridian', () => {
    // The Atlas API rejects west > east, so Studio must not send it.
    expect(normalizeViewportBbox(170, -10, -170, 10)).toEqual([-180, -10, 180, 10]);
  });

  it('widens a viewport that spans more than the whole globe', () => {
    expect(normalizeViewportBbox(-400, -10, 400, 10)).toEqual([-180, -10, 180, 10]);
  });

  it('orders latitudes even if the map reports them upside down', () => {
    expect(normalizeViewportBbox(0, 20, 10, 5)).toEqual([0, 5, 10, 20]);
  });

  it('falls back to the whole world for non-finite input', () => {
    expect(normalizeViewportBbox(Number.NaN, 0, 10, 10)).toEqual([-180, -90, 180, 90]);
  });
});

describe('bboxesEqual', () => {
  it('treats identical boxes as equal', () => {
    expect(bboxesEqual([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true);
  });

  it('tolerates sub-metre float noise', () => {
    expect(bboxesEqual([1, 2, 3, 4], [1 + 1e-9, 2, 3, 4])).toBe(true);
  });

  it('detects a real move', () => {
    expect(bboxesEqual([1, 2, 3, 4], [1.5, 2, 3, 4])).toBe(false);
  });
});

describe('boundsOfCoordinates', () => {
  it('covers every coordinate', () => {
    expect(
      boundsOfCoordinates([
        [51.39, 35.69],
        [51.38, 35.7],
        [51.4, 35.68],
      ]),
    ).toEqual([51.38, 35.68, 51.4, 35.7]);
  });

  it('returns null for an empty line', () => {
    expect(boundsOfCoordinates([])).toBeNull();
  });
});

describe('formatBbox', () => {
  it('renders a fixed-precision box', () => {
    expect(formatBbox([51.38, 35.68, 51.4, 35.7])).toBe('51.38000, 35.68000, 51.40000, 35.70000');
  });
});
