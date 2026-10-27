/**
 * Minimal anti-aliased outline rasterizer (non-zero winding) used to build SDF glyphs and sprite
 * icons offline without native image libraries.
 */

export type Point = [number, number];
export type Contour = Point[];

export interface PathCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** Flatten path commands (quadratic/cubic Béziers) into closed polygon contours. */
export function flatten(commands: readonly PathCommand[], tolerance = 0.2): Contour[] {
  const contours: Contour[] = [];
  let current: Contour = [];
  let x = 0;
  let y = 0;
  const steps = (len: number) => Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tolerance))));
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        if (current.length > 1) contours.push(current);
        current = [[c.x!, c.y!]];
        x = c.x!;
        y = c.y!;
        break;
      case 'L':
        current.push([c.x!, c.y!]);
        x = c.x!;
        y = c.y!;
        break;
      case 'Q': {
        const n = steps(Math.hypot(c.x1! - x, c.y1! - y) + Math.hypot(c.x! - c.x1!, c.y! - c.y1!));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const mt = 1 - t;
          current.push([mt * mt * x + 2 * mt * t * c.x1! + t * t * c.x!, mt * mt * y + 2 * mt * t * c.y1! + t * t * c.y!]);
        }
        x = c.x!;
        y = c.y!;
        break;
      }
      case 'C': {
        const n = steps(Math.hypot(c.x1! - x, c.y1! - y) + Math.hypot(c.x2! - c.x1!, c.y2! - c.y1!) + Math.hypot(c.x! - c.x2!, c.y! - c.y2!));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const mt = 1 - t;
          current.push([
            mt ** 3 * x + 3 * mt * mt * t * c.x1! + 3 * mt * t * t * c.x2! + t ** 3 * c.x!,
            mt ** 3 * y + 3 * mt * mt * t * c.y1! + 3 * mt * t * t * c.y2! + t ** 3 * c.y!,
          ]);
        }
        x = c.x!;
        y = c.y!;
        break;
      }
      case 'Z':
        if (current.length > 1) contours.push(current);
        current = [];
        break;
    }
  }
  if (current.length > 1) contours.push(current);
  return contours;
}

/**
 * Coverage (0..1) per pixel for contours given in pixel coordinates (y down), using 8 sub-rows
 * per pixel and exact horizontal span coverage.
 */
export function coverage(contours: readonly Contour[], width: number, height: number, subRows = 8): Float32Array {
  const cov = new Float32Array(width * height);
  const edges: { x0: number; y0: number; x1: number; y1: number; dir: number }[] = [];
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]!;
      const b = contour[(i + 1) % contour.length]!;
      if (a[1] === b[1]) continue;
      edges.push(a[1] < b[1] ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 } : { x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 });
    }
  }
  const xs: { x: number; dir: number }[] = [];
  for (let py = 0; py < height; py++) {
    for (let s = 0; s < subRows; s++) {
      const sy = py + (s + 0.5) / subRows;
      xs.length = 0;
      for (const e of edges) {
        if (sy < e.y0 || sy >= e.y1) continue;
        xs.push({ x: e.x0 + ((sy - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      let winding = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        winding += xs[i]!.dir;
        if (winding === 0) continue;
        const start = Math.max(0, xs[i]!.x);
        const end = Math.min(width, xs[i + 1]!.x);
        if (end <= start) continue;
        // Add exact horizontal coverage of [start, end) for this sub-row.
        let px = Math.floor(start);
        while (px < end && px < width) {
          const left = Math.max(start, px);
          const right = Math.min(end, px + 1);
          if (right > left) cov[py * width + px]! += (right - left) / subRows;
          px++;
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, cov[i]!);
  return cov;
}

// ------------------------------------------------------------------------------------------
// Signed distance field — direct port of @mapbox/tiny-sdf 2.x (BSD-2-Clause) as bundled by
// maplibre-gl 6.14.0, so server glyphs match the client's own TinySDF output convention.
// ------------------------------------------------------------------------------------------
const INF = 1e20;
const alphaTable = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const d = 0.5 - Math.pow(i / 255, 1 / 2.2);
  alphaTable[i] = d * Math.abs(d);
}
alphaTable[255] = -INF;

function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    const qr = q - r;
    grid[offset + q * stride] = f[r]! + qr * qr;
  }
}

function edt(data: Float64Array, x0: number, y0: number, width: number, height: number, gridSize: number, f: Float64Array, v: Uint16Array, z: Float64Array): void {
  for (let x = x0; x < x0 + width; x++) edt1d(data, y0 * gridSize + x, gridSize, height, f, v, z);
  for (let y = y0; y < y0 + height; y++) edt1d(data, y * gridSize + x0, 1, width, f, v, z);
}

/** SDF bitmap (glyphWidth+2·buffer × glyphHeight+2·buffer) from a coverage raster. */
export function sdfFromCoverage(cov: Float32Array, glyphWidth: number, glyphHeight: number, buffer = 3, radius = 8, cutoff = 0.25): Uint8Array {
  const width = glyphWidth + 2 * buffer;
  const height = glyphHeight + 2 * buffer;
  const len = width * height;
  const out = new Uint8Array(len);
  if (glyphWidth === 0 || glyphHeight === 0) return out;
  const size = Math.max(width, height) + 1;
  const gridOuter = new Float64Array(len).fill(INF);
  const gridInner = new Float64Array(len);
  const f = new Float64Array(size);
  const v = new Uint16Array(size);
  const z = new Float64Array(size + 1);
  for (let y = 0; y < glyphHeight; y++) {
    for (let x = 0; x < glyphWidth; x++) {
      const a = Math.round(cov[y * glyphWidth + x]! * 255);
      if (a === 0) continue;
      const j = (y + buffer) * width + x + buffer;
      const t = alphaTable[a]!;
      gridOuter[j] = Math.max(0, t);
      gridInner[j] = Math.max(0, -t);
    }
  }
  edt(gridOuter, 0, 0, width, height, width, f, v, z);
  const pad = Math.min(buffer, 1);
  edt(gridInner, buffer - pad, buffer - pad, glyphWidth + 2 * pad, glyphHeight + 2 * pad, width, f, v, z);
  const scale = 255 / radius;
  const base = 255 * (1 - cutoff);
  for (let i = 0; i < len; i++) {
    const d = Math.sqrt(gridOuter[i]!) - Math.sqrt(gridInner[i]!);
    out[i] = Math.max(0, Math.min(255, Math.round(base - scale * d)));
  }
  return out;
}
