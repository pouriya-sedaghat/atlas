/**
 * Search-only text normalization for Persian/Arabic-script and Latin queries.
 *
 * The same function is applied when building the Photon index (to derive extra searchable
 * name variants from the Nominatim export) and to every incoming free-text query. Display
 * strings are never rewritten: original OSM names are preserved and returned verbatim.
 *
 * Version is recorded in release manifests; any change requires a fresh geocoder index.
 */
export const SEARCH_NORMALIZATION_VERSION = 'fa-search-norm-1';

const CHAR_MAP: ReadonlyMap<number, string> = new Map<number, string>([
  // Arabic Yeh / Alef Maksura -> Farsi Yeh
  [0x064a, 'ی'],
  [0x0649, 'ی'],
  // Arabic Kaf -> Keheh (Persian Kaf)
  [0x0643, 'ک'],
  // Heh variants -> Heh
  [0x06c0, 'ه'],
  [0x06c1, 'ه'],
  [0x06d5, 'ه'],
  // Alef variants (hamza above/below, wasla, madda) -> bare Alef (search tolerance only)
  [0x0623, 'ا'],
  [0x0625, 'ا'],
  [0x0671, 'ا'],
  [0x0622, 'ا'],
  // Arabic punctuation -> ASCII
  [0x060c, ','],
  [0x061b, ';'],
  [0x061f, '?'],
  [0x066a, '%'],
  [0x066b, '.'],
  [0x066c, ','],
  // ZERO WIDTH NON-JOINER separates morphemes; treat as a token boundary.
  [0x200c, ' '],
]);

function isRemovedCodePoint(cp: number): boolean {
  return (
    (cp >= 0x064b && cp <= 0x065f) || // harakat / tanwin / shadda / sukun ...
    cp === 0x0670 || // superscript alef
    (cp >= 0x06d6 && cp <= 0x06ed) || // Quranic annotation marks
    cp === 0x0640 || // tatweel
    cp === 0x200d || // ZWJ
    cp === 0x200e ||
    cp === 0x200f || // LRM / RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embeddings/overrides
    (cp >= 0x2066 && cp <= 0x2069) || // bidi isolates
    cp === 0xfeff // BOM / ZWNBSP
  );
}

function mapDigit(cp: number): string | undefined {
  if (cp >= 0x0660 && cp <= 0x0669) return String(cp - 0x0660);
  if (cp >= 0x06f0 && cp <= 0x06f9) return String(cp - 0x06f0);
  return undefined;
}

/** Normalize text for matching. Idempotent: normalizeForSearch(normalizeForSearch(x)) === normalizeForSearch(x). */
export function normalizeForSearch(input: string): string {
  // NFKC folds Arabic presentation forms (e.g. U+FEFB lam-alef ligature) to base letters.
  const nfkc = input.normalize('NFKC');
  let out = '';
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0)!;
    if (isRemovedCodePoint(cp)) continue;
    const digit = mapDigit(cp);
    if (digit !== undefined) {
      out += digit;
      continue;
    }
    const mapped = CHAR_MAP.get(cp);
    out += mapped ?? ch;
  }
  return out.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Length in Unicode code points (the query cap is defined in code points, not UTF-16 units). */
export function codePointLength(input: string): number {
  let n = 0;
  for (const _ of input) n++;
  return n;
}

/** True when the string contains any Arabic-script letter (used to report script coverage). */
export function hasArabicScript(input: string): boolean {
  return /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/u.test(input);
}
