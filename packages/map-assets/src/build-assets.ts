#!/usr/bin/env node
/**
 * Build the local map asset set (preparation step; output is baked into the proxy image):
 *   fonts/<stack>/<start>-<end>.pbf   SDF glyph ranges 0..65535 for each font stack
 *   fonts/files/*.woff2               font files referenced by the style's font-faces
 *   sprites/{light,dark}[@2x].{png,json}
 *   licenses/Vazirmatn-OFL.txt
 *   asset-manifest.json               sha256 of every file + source versions
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import opentype from 'opentype.js';
import { buildRange } from './glyphs.js';
import { buildSprite } from './sprites.js';
import { encodePng } from './encode.js';
import { FONT_BOLD, FONT_REGULAR, STYLE_VERSION } from './style.js';

const require = createRequire(import.meta.url);
const out = resolve(process.argv[2] ?? 'assets-dist');
const vazirDir = dirname(require.resolve('vazirmatn/package.json'));
const vazirVersion = (JSON.parse(readFileSync(join(vazirDir, 'package.json'), 'utf8')) as { version: string }).version;
const otVersion = (JSON.parse(readFileSync(require.resolve('opentype.js/package.json'), 'utf8')) as { version: string }).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const fonts = [
  { stack: FONT_REGULAR, ttf: 'Vazirmatn-Regular.ttf', woff2: 'Vazirmatn-Regular.woff2' },
  { stack: FONT_BOLD, ttf: 'Vazirmatn-Bold.ttf', woff2: 'Vazirmatn-Bold.woff2' },
];

const glyphCounts: Record<string, number> = {};
for (const f of fonts) {
  const buf = readFileSync(join(vazirDir, 'fonts/ttf', f.ttf));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const dir = join(out, 'fonts', f.stack);
  mkdirSync(dir, { recursive: true });
  let total = 0;
  for (let r = 0; r < 256; r++) {
    const start = r * 256;
    const { pbf, count } = buildRange(font, f.stack, start);
    writeFileSync(join(dir, `${start}-${start + 255}.pbf`), pbf);
    total += count;
  }
  glyphCounts[f.stack] = total;
  mkdirSync(join(out, 'fonts/files'), { recursive: true });
  copyFileSync(join(vazirDir, 'fonts/webfonts', f.woff2), join(out, 'fonts/files', f.woff2));
}

const regularBuf = readFileSync(join(vazirDir, 'fonts/ttf', 'Vazirmatn-Bold.ttf'));
const iconFont = opentype.parse(regularBuf.buffer.slice(regularBuf.byteOffset, regularBuf.byteOffset + regularBuf.byteLength) as ArrayBuffer);
mkdirSync(join(out, 'sprites'), { recursive: true });
for (const theme of ['light', 'dark'] as const) {
  for (const ratio of [1, 2] as const) {
    const s = buildSprite(iconFont, theme, ratio);
    const suffix = ratio === 2 ? '@2x' : '';
    writeFileSync(join(out, 'sprites', `${theme}${suffix}.png`), encodePng(s.width, s.height, s.rgba));
    writeFileSync(join(out, 'sprites', `${theme}${suffix}.json`), `${JSON.stringify(s.index)}\n`);
  }
}

mkdirSync(join(out, 'licenses'), { recursive: true });
copyFileSync(join(vazirDir, 'OFL.txt'), join(out, 'licenses', 'Vazirmatn-OFL.txt'));

const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(out, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
};
walk(out);
const manifestBody = {
  schema: 'seyra.map-assets/1',
  style_version: STYLE_VERSION,
  sources: {
    vazirmatn: { version: vazirVersion, license: 'OFL-1.1', origin: 'npm:vazirmatn' },
    'opentype.js': { version: otVersion, license: 'MIT', role: 'build-time font parsing only' },
    sdf: 'port of @mapbox/tiny-sdf 2.x (BSD-2-Clause) parameters fontSize=24 buffer=3 radius=8 cutoff=0.25',
  },
  glyph_counts: glyphCounts,
  files,
};
const assetsDigest = createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
writeFileSync(join(out, 'asset-manifest.json'), `${JSON.stringify({ ...manifestBody, assets_sha256: assetsDigest }, null, 2)}\n`);
console.log(`assets written to ${out}: ${Object.keys(files).length} files, glyphs ${JSON.stringify(glyphCounts)}, digest ${assetsDigest}`);
