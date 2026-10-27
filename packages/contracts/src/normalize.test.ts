import { describe, expect, it } from 'vitest';
import { codePointLength, normalizeForSearch } from './normalize.js';

describe('normalizeForSearch', () => {
  it('folds Arabic Yeh/Kaf to Persian forms', () => {
    expect(normalizeForSearch('خيابان كوثر')).toBe(normalizeForSearch('خیابان کوثر'));
    expect(normalizeForSearch('علي')).toBe('علی');
  });
  it('maps Persian and Arabic-Indic digits to ASCII', () => {
    expect(normalizeForSearch('خیابان ۱۲')).toBe('خیابان 12');
    expect(normalizeForSearch('٣٤')).toBe('34');
  });
  it('treats ZWNJ as a token boundary and removes bidi/format marks', () => {
    expect(normalizeForSearch('می‌روم')).toBe('می روم');
    expect(normalizeForSearch('‏تهران‎')).toBe('تهران');
  });
  it('removes diacritics and tatweel', () => {
    expect(normalizeForSearch('مُحَمَّد')).toBe('محمد');
    expect(normalizeForSearch('بـــازار')).toBe('بازار');
  });
  it('folds presentation-form lam-alef ligatures', () => {
    expect(normalizeForSearch('ﻻ')).toBe('لا');
  });
  it('lowercases Latin text and collapses whitespace', () => {
    expect(normalizeForSearch('  Azadi   SQUARE ')).toBe('azadi square');
  });
  it('is idempotent', () => {
    for (const s of ['خيابان كوثر ۱۲', 'می‌روم', 'Café', 'آزادی']) {
      expect(normalizeForSearch(normalizeForSearch(s))).toBe(normalizeForSearch(s));
    }
  });
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('😀a')).toBe(2);
  });
});
