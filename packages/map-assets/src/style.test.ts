import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { BASE_TOKEN, buildStyle, buildTileJson } from './style.js';

const variants = (['light', 'dark'] as const).flatMap((theme) => (['fa', 'en'] as const).map((lang) => ({ theme, lang })));

describe('generated MapLibre styles', () => {
  it.each(variants)('$theme-$lang validates against the MapLibre style specification', ({ theme, lang }) => {
    const style = buildStyle({ datasetId: 'ds-20261001-000000000000', theme, lang, bounds: [0, 0, 0.1, 0.1], center: [0.05, 0.05], zoom: 12 });
    // Absolute URLs are produced by the proxy from the base token; substitute it as the proxy does.
    const resolved = JSON.parse(JSON.stringify(style).replaceAll(BASE_TOKEN, 'https://127.0.0.1:8443')) as Record<string, unknown>;
    expect(validateStyleMin(resolved as never).map((e: { message: string }) => e.message)).toEqual([]);
  });

  it('keeps every resource on the ingress origin (no remote fonts, sprites or sources)', () => {
    const text = JSON.stringify(buildStyle({ datasetId: 'ds-20261001-000000000000', theme: 'dark', lang: 'fa', center: [0, 0], zoom: 2 }));
    const urls = [...text.matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]!);
    expect(urls.filter((u) => !u.startsWith('https://www.openstreetmap.org/copyright'))).toEqual([]);
    expect(text).toContain(BASE_TOKEN);
  });

  it('builds TileJSON pointing at the dataset-scoped tile path', () => {
    const tj = buildTileJson('ds-20261001-000000000000', [0, 0, 0.1, 0.1], [0.05, 0.05, 12]) as { tiles: string[]; maxzoom: number };
    expect(tj.tiles).toEqual([`${BASE_TOKEN}/maps/ds-20261001-000000000000/tiles/{z}/{x}/{y}.pbf`]);
    expect(tj.maxzoom).toBe(16);
  });
});
