// opentype.js 2.0.0 ships no type declarations; only `parse` is used by the asset build.
declare module 'opentype.js' {
  const opentype: { parse(buffer: ArrayBuffer): import('./glyphs.js').OtFont };
  export default opentype;
}
