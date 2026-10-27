import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { SEARCH_NORMALIZATION_VERSION, normalizeForSearch } from '@seyra/contracts';

/**
 * Prepare a Nominatim->Photon JSON dump for the Seyra geocoder index.
 *
 * - Original names (and house numbers) are copied verbatim into `extra.seyra_*` so the API can
 *   return them unchanged (display text is never rewritten).
 * - Search-only normalized variants of each name are added into unused alternative-name slots
 *   (indexed by Photon but never displayed).
 * - A query-time synonym list maps normalized single tokens to their original spellings found in
 *   names and address components, so queries normalized by the API still match original text.
 * - One release marker document (category seyra.release_marker) is appended; the API excludes
 *   that category from every user query and uses it as the served-index identity probe.
 */
export const EXTRA_KEYS = { default: 'seyra_name', fa: 'seyra_name_fa', en: 'seyra_name_en', housenumber: 'seyra_housenumber' } as const;
/** Value for Photon's -extra-tags import option. */
export const PHOTON_EXTRA_TAGS = Object.values(EXTRA_KEYS).join(',');
export const MARKER_CATEGORY = 'seyra.release_marker';
const VARIANT_SLOTS = ['reg_name', 'loc_name', 'int_name', 'old_name', 'alt_name'] as const;
const MAX_SYNONYMS = 200_000;

export interface PreprocessStats {
  places: number;
  names_with_variants: number;
  variants_added: number;
  variants_without_free_slot: number;
  synonym_entries: number;
  synonym_entries_dropped: number;
  marker_name: string;
  normalization_version: string;
}

interface PlaceContent {
  place_id?: string | number;
  object_type?: string;
  categories?: string[];
  name?: Record<string, string>;
  // Photon's dump writes unmatched address lines as string arrays (`other`, `other:<lang>`).
  address?: Record<string, string | string[]>;
  extra?: Record<string, string>;
  housenumber?: string;
  centroid?: [number, number];
  [k: string]: unknown;
}

/** The text values of a dump field: strings as they are, string arrays element-wise, nothing else. */
export function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Split text into single-word tokens the way synonyms require (no spaces, hyphens, commas). */
export function tokens(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/[\s,\-‐-―_/\\()[\]{}"'«»؛،.:;!?]+/u)
    .map((t) => t.replace(/[‌‍‎‏]/gu, ''))
    .filter((t) => t.length > 0);
}

export function addNameVariants(content: PlaceContent): { added: number; missingSlots: number } {
  const names = content.name;
  if (!names) return { added: 0, missingSlots: 0 };
  const existing = new Set(Object.values(names));
  const wanted: string[] = [];
  for (const value of Object.values(names)) {
    if (typeof value !== 'string') continue;
    const n = normalizeForSearch(value);
    if (n.length > 0 && n !== value.toLowerCase() && !existing.has(n) && !wanted.includes(n)) wanted.push(n);
  }
  let added = 0;
  for (const slot of VARIANT_SLOTS) {
    if (wanted.length === 0) break;
    if (names[slot] === undefined) {
      names[slot] = wanted.shift()!;
      added++;
    }
  }
  return { added, missingSlots: wanted.length };
}

export function recordOriginalNames(content: PlaceContent): void {
  const names = content.name ?? {};
  const extra: Record<string, string> = {};
  if (names.name) extra[EXTRA_KEYS.default] = names.name;
  if (names['name:fa']) extra[EXTRA_KEYS.fa] = names['name:fa'];
  if (names['name:en']) extra[EXTRA_KEYS.en] = names['name:en'];
  // Photon matches house numbers literally (no synonyms), so the indexed value is normalized
  // (e.g. Persian digits -> ASCII) and the original is kept verbatim for display.
  if (typeof content.housenumber === 'string' && content.housenumber.length > 0) {
    extra[EXTRA_KEYS.housenumber] = content.housenumber;
    content.housenumber = normalizeForSearch(content.housenumber);
  }
  // Only the Seyra keys are kept at import (-extra-tags); other extratags are not needed at runtime.
  content.extra = extra;
}

/** A synonym term needs a letter or digit; Photon's analyzer eliminates anything else (e.g. «؟؟؟؟»). */
const HAS_TEXT = /[\p{L}\p{N}]/u;

export function collectSynonyms(text: string, into: Map<string, Set<string>>): void {
  for (const token of tokens(text)) {
    const n = normalizeForSearch(token);
    if (!HAS_TEXT.test(n) || !HAS_TEXT.test(token) || n === token.toLowerCase() || /[\s,]/u.test(n)) continue;
    let set = into.get(n);
    if (!set) into.set(n, (set = new Set()));
    set.add(token.toLowerCase());
  }
}

export function markerDocument(markerName: string, dataTimestamp: string | undefined): string {
  return JSON.stringify({
    type: 'Place',
    content: [
      {
        place_id: 'seyra_release_marker',
        object_type: 'X',
        object_id: 0,
        osm_key: 'seyra',
        osm_value: 'release_marker',
        categories: [MARKER_CATEGORY],
        address_type: 'other',
        importance: 0,
        name: { name: markerName },
        extra: { [EXTRA_KEYS.default]: markerName, seyra_data_timestamp: dataTimestamp ?? 'unknown' },
        // Far from any routable or searchable area; excluded from all user queries by category.
        centroid: [0, -89.9],
      },
    ],
  });
}

/** Stream-transform the export into the import file and synonym list. */
export async function preprocessDump(inputPath: string, outputPath: string, synonymPath: string, markerName: string): Promise<PreprocessStats> {
  const out = createWriteStream(outputPath, { encoding: 'utf8', mode: 0o644 });
  const rl = createInterface({ input: createReadStream(inputPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  const synonyms = new Map<string, Set<string>>();
  const stats: PreprocessStats = {
    places: 0,
    names_with_variants: 0,
    variants_added: 0,
    variants_without_free_slot: 0,
    synonym_entries: 0,
    synonym_entries_dropped: 0,
    marker_name: markerName,
    normalization_version: SEARCH_NORMALIZATION_VERSION,
  };
  let dataTimestamp: string | undefined;
  const write = async (line: string) => {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  };
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const doc = JSON.parse(line) as { type: string; content: unknown };
    if (doc.type === 'NominatimDumpFile') {
      dataTimestamp = (doc.content as { data_timestamp?: string }).data_timestamp;
    } else if (doc.type === 'Place') {
      const items = (Array.isArray(doc.content) ? doc.content : [doc.content]) as PlaceContent[];
      for (const c of items) {
        stats.places++;
        for (const v of Object.values(c.name ?? {})) for (const t of textValues(v)) collectSynonyms(t, synonyms);
        for (const v of Object.values(c.address ?? {})) for (const t of textValues(v)) collectSynonyms(t, synonyms);
        for (const t of textValues(c.housenumber)) collectSynonyms(t, synonyms);
        recordOriginalNames(c);
        const r = addNameVariants(c);
        if (r.added > 0) stats.names_with_variants++;
        stats.variants_added += r.added;
        stats.variants_without_free_slot += r.missingSlots;
      }
    }
    await write(JSON.stringify(doc));
  }
  await write(markerDocument(markerName, dataTimestamp));
  out.end();
  await once(out, 'finish');

  const entries: string[] = [];
  for (const [normalized, originals] of [...synonyms.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (entries.length >= MAX_SYNONYMS) {
      stats.synonym_entries_dropped++;
      continue;
    }
    entries.push([normalized, ...[...originals].sort()].join(','));
  }
  stats.synonym_entries = entries.length;
  const synOut = createWriteStream(synonymPath, { encoding: 'utf8', mode: 0o644 });
  synOut.end(`${JSON.stringify({ search_synonyms: entries, classification_terms: [] }, null, 1)}\n`);
  await once(synOut, 'finish');
  return stats;
}
