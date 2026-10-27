import { crc32, deflateSync } from 'node:zlib';

/** Minimal protobuf writer for the MapLibre glyph PBF schema. */
class ProtoWriter {
  private readonly parts: number[] = [];

  varint(n: number): this {
    if (!Number.isInteger(n) || n < 0) throw new Error('varint must be a non-negative integer');
    let v = n;
    while (v > 0x7f) {
      this.parts.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.parts.push(v);
    return this;
  }
  tag(field: number, wire: number): this {
    return this.varint((field << 3) | wire);
  }
  uint(field: number, n: number): this {
    return this.tag(field, 0).varint(n);
  }
  sint(field: number, n: number): this {
    return this.tag(field, 0).varint(n >= 0 ? n * 2 : -n * 2 - 1);
  }
  bytes(field: number, data: Uint8Array): this {
    this.tag(field, 2).varint(data.length);
    for (const b of data) this.parts.push(b);
    return this;
  }
  string(field: number, s: string): this {
    return this.bytes(field, new TextEncoder().encode(s));
  }
  message(field: number, w: ProtoWriter): this {
    return this.bytes(field, w.finish());
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export interface GlyphRecord {
  id: number;
  bitmap: Uint8Array;
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

/** glyphs { stacks { name, range, glyphs { id, bitmap, width, height, left, top, advance } } } */
export function encodeGlyphRange(stack: string, range: string, glyphs: readonly GlyphRecord[]): Uint8Array {
  const fontstack = new ProtoWriter().string(1, stack).string(2, range);
  for (const g of glyphs) {
    const gw = new ProtoWriter().uint(1, g.id);
    if (g.bitmap.length > 0) gw.bytes(2, g.bitmap);
    gw.uint(3, g.width).uint(4, g.height).sint(5, g.left).sint(6, g.top).uint(7, g.advance);
    fontstack.message(3, gw);
  }
  return new ProtoWriter().message(1, fontstack).finish();
}

/** Encode an RGBA buffer as a PNG (filter type 0, zlib-deflated). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
