import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeForSearch } from '@seyra/contracts';
import { addNameVariants, preprocessDump, textValues, tokens } from './geocoder-preprocess.js';

const dir = mkdtempSync(join(tmpdir(), 'seyra-pre-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('geocoder dump preprocessing', () => {
  it('adds normalized name variants without touching display names', () => {
    const c = { name: { name: 'خيابان اصلي آزمايشي', 'name:en': 'Synthetic Main Street' } };
    const r = addNameVariants(c);
    expect(r.added).toBe(1);
    expect(c.name.name).toBe('خيابان اصلي آزمايشي');
    expect(Object.values(c.name)).toContain(normalizeForSearch('خیابان اصلی آزمایشی'));
  });

  it('tokenizes for single-word synonyms', () => {
    expect(tokens('خیابان‌ شمالی, No.12-B')).toEqual(['خیابان', 'شمالی', 'No', '12', 'B']);
  });

  it('streams the dump, records originals, builds synonyms and appends the release marker', async () => {
    const input = join(dir, 'in.jsonl');
    writeFileSync(
      input,
      [
        JSON.stringify({ type: 'NominatimDumpFile', content: { version: '0.1.0', data_timestamp: '2026-10-01T00:00:00Z' } }),
        JSON.stringify({
          type: 'Place',
          content: [{ place_id: '1', object_type: 'N', object_id: 7, name: { name: 'داروخانه كوثر', 'name:en': 'Kowsar' }, address: { street: 'خيابان اصلي' }, housenumber: '۱۲', extra: { 'seyra:fixture': 'synthetic' }, centroid: [0, 0] }],
        }),
      ].join('\n'),
    );
    const out = join(dir, 'out.jsonl');
    const syn = join(dir, 'syn.json');
    const stats = await preprocessDump(input, out, syn, 'seyra-release-ds-x');
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    const place = lines[1].content[0];
    expect(place.extra).toEqual({ seyra_name: 'داروخانه كوثر', seyra_name_en: 'Kowsar', seyra_housenumber: '۱۲' });
    expect(place.housenumber).toBe('12');
    expect(place.name.name).toBe('داروخانه كوثر');
    expect(lines[2].content[0].categories).toEqual(['seyra.release_marker']);
    expect(lines[2].content[0].name.name).toBe('seyra-release-ds-x');
    const synonyms = JSON.parse(readFileSync(syn, 'utf8')).search_synonyms as string[];
    expect(synonyms).toContain('کوثر,كوثر');
    expect(synonyms).toContain('اصلی,اصلي');
    expect(synonyms).toContain('12,۱۲');
    expect(stats.places).toBe(1);
  });

  // Photon 1.3.0 `dump-nominatim-db` writes address lines it cannot map to a named field as string
  // arrays (`other`, `other:<lang>`); 1,191,816 of 1,199,311 places in the owner's Iran export
  // carried them (docs/validation/iran/vm2-2026-10-18). Real-Iran run: TypeError, no release.
  it('accepts the string-array address lines of real Photon dumps', async () => {
    const input = join(dir, 'in-other.jsonl');
    const address = { city: 'شهر نمونه', other: ['محله يك', 'بخش دو'], 'other:fa': ['محله یک'], 'other:en': ['District One'] };
    writeFileSync(
      input,
      [
        JSON.stringify({ type: 'NominatimDumpFile', content: { version: '0.1.0', data_timestamp: '2026-10-17T20:14:22.000+00:00' } }),
        JSON.stringify({ type: 'Place', content: [{ place_id: '2', object_type: 'N', object_id: 8, name: { name: 'کافه نمونه' }, address, centroid: [51.4, 35.7] }] }),
      ].join('\n'),
    );
    const out = join(dir, 'out-other.jsonl');
    const syn = join(dir, 'syn-other.json');
    const stats = await preprocessDump(input, out, syn, 'seyra-release-ds-y');
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(stats.places).toBe(1);
    expect(lines).toHaveLength(3);
    // The address passes through unchanged; Photon indexes it and the API ignores non-string fields.
    expect(lines[1].content[0].address).toEqual(address);
    // Array elements contribute synonyms like any other address text (Arabic Kaf/Yeh -> Persian).
    expect(JSON.parse(readFileSync(syn, 'utf8')).search_synonyms as string[]).toContain('یک,يك');
  });

  // Real Iran names include «؟؟؟؟» (unknown-name placeholders) and a bare «؟». The tokenizer kept
  // them and normalization turned them into «????»/«?»; Photon's search analyzer eliminates such
  // terms completely and then refuses the whole synonym file, so the provider did not start
  // (run vm2-2026-10-18, staging-validation). Terms without a letter or digit are never synonyms.
  it('never emits synonym terms without a letter or digit', async () => {
    const input = join(dir, 'in-punct.jsonl');
    writeFileSync(
      input,
      [
        JSON.stringify({ type: 'NominatimDumpFile', content: { version: '0.1.0' } }),
        JSON.stringify({ type: 'Place', content: [{ place_id: '3', object_type: 'W', object_id: 9, name: { name: '؟؟؟؟' }, address: { street: 'كوچه ؟', other: ['؟'] }, centroid: [51.4, 35.7] }] }),
      ].join('\n'),
    );
    const syn = join(dir, 'syn-punct.json');
    await preprocessDump(input, join(dir, 'out-punct.jsonl'), syn, 'seyra-release-ds-z');
    const entries = JSON.parse(readFileSync(syn, 'utf8')).search_synonyms as string[];
    for (const term of entries.flatMap((e) => e.split(','))) expect(term).toMatch(/[\p{L}\p{N}]/u);
    expect(entries).toContain('کوچه,كوچه');
  });

  it('takes text values from strings and string arrays only', () => {
    expect(textValues('a')).toEqual(['a']);
    expect(textValues(['a', 3, 'b', null])).toEqual(['a', 'b']);
    expect(textValues(5)).toEqual([]);
    expect(textValues({ a: 'b' })).toEqual([]);
    expect(textValues(undefined)).toEqual([]);
  });
});
