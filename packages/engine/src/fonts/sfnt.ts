import { inflateSync } from "node:zlib";

/**
 * A font file read the safe way (ADR 0220 §2): what the server needs of a font a person or an agent uploads, or of one
 * the server ships — its names, its embedding rights, its weight and slant, and the metrics to measure text with —
 * from TrueType or OpenType (CFF) data, also inside a WOFF. Every offset is checked against the file, every count is
 * capped, and anything off-shape is a `FontError`, never a crash or a read past the bytes. Outlines aren't read here
 * (PDF subsetting is `ttf.ts`, for the server's own TrueType files).
 */

export class FontError extends Error {}

/** The largest font file taken (an upload, or a file a deck carries). */
export const FONT_MAX_BYTES = 10 * 1024 * 1024;

const MAX_TABLES = 64;
const MAX_GLYPHS = 65_535;
const MAX_CMAP_SEGMENTS = 20_000;
const MAX_CMAP_GROUPS = 50_000;

export type FontFormat = "ttf" | "otf" | "woff";

export interface FontInfo {
  format: FontFormat;
  /** The family name as the file gives it (typographic family first), at most 100 characters. */
  family: string;
  /** Its style name ("Bold Italic"), at most 100 characters. */
  style: string;
  /** 100 to 900, from the OS/2 table (400 when it has none). */
  weight: number;
  italic: boolean;
  /**
   * What its license lets documents do with it (OS/2 `fsType`): `installable` and `editable` embed anywhere,
   * `preview` embeds in a document that is only viewed or printed (a PDF, never a PowerPoint or Word file people edit),
   * `restricted` embeds nowhere.
   */
  embedding: "installable" | "editable" | "preview" | "restricted";
  /** The sfnt bytes (unwrapped from a WOFF), what metrics and PDFs read. */
  sfnt: Uint8Array;
}

export interface FontMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  /** Advance width of a character in font units, or null when the font lacks it. */
  advanceOf(codePoint: number): number | null;
}

/** A font's format from its first bytes, or null when they aren't a font's. */
export function sniffFont(bytes: Uint8Array): FontFormat | null {
  if (bytes.length < 12) return null;
  const tag = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return "ttf";
  return null;
}

/** The media type a font file is served with. */
export function fontMediaType(format: FontFormat): string {
  return format === "woff" ? "font/woff" : format === "otf" ? "font/otf" : "font/ttf";
}

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(at: number, length: number): void {
    if (!Number.isInteger(at) || at < 0 || length < 0 || at + length > this.bytes.length) {
      throw new FontError("The font file is cut short or malformed");
    }
  }
  u8(at: number): number {
    this.check(at, 1);
    return this.view.getUint8(at);
  }
  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at);
  }
  i16(at: number): number {
    this.check(at, 2);
    return this.view.getInt16(at);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at);
  }
  tag(at: number): string {
    this.check(at, 4);
    return String.fromCharCode(this.u8(at), this.u8(at + 1), this.u8(at + 2), this.u8(at + 3));
  }
}

interface Table {
  offset: number;
  length: number;
}

/** WOFF 1.0 to the sfnt it wraps: each table inflated (zlib) when compressed, checked against its stated length. */
function unwrapWoff(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes);
  const flavor = r.u32(4);
  const numTables = r.u16(12);
  const totalSfntSize = r.u32(16);
  if (numTables === 0 || numTables > MAX_TABLES) throw new FontError("The font has no tables or too many");
  if (totalSfntSize > FONT_MAX_BYTES * 4) throw new FontError("The font is too large once unpacked");
  const entries: { tag: string; offset: number; compLength: number; origLength: number; checksum: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    entries.push({
      tag: r.tag(at),
      offset: r.u32(at + 4),
      compLength: r.u32(at + 8),
      origLength: r.u32(at + 12),
      checksum: r.u32(at + 16),
    });
  }
  const headerSize = 12 + numTables * 16;
  let size = headerSize;
  for (const e of entries) size += (e.origLength + 3) & ~3;
  if (size > FONT_MAX_BYTES * 4) throw new FontError("The font is too large once unpacked");
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, flavor);
  view.setUint16(4, numTables);
  let at = headerSize;
  entries.forEach((e, i) => {
    r.check(e.offset, e.compLength);
    const raw = bytes.subarray(e.offset, e.offset + e.compLength);
    let data: Uint8Array;
    if (e.compLength < e.origLength) {
      try {
        data = new Uint8Array(inflateSync(raw, { maxOutputLength: e.origLength }));
      } catch {
        throw new FontError("A table of the font doesn't unpack");
      }
    } else data = raw;
    if (data.length !== e.origLength) throw new FontError("A table of the font has the wrong size");
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = e.tag.charCodeAt(k);
    view.setUint32(rec + 4, e.checksum);
    view.setUint32(rec + 8, at);
    view.setUint32(rec + 12, e.origLength);
    out.set(data, at);
    at += (e.origLength + 3) & ~3;
  });
  return out;
}

function tablesOf(r: Reader): Map<string, Table> {
  const count = r.u16(4);
  if (count === 0 || count > MAX_TABLES) throw new FontError("The font has no tables or too many");
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    const tag = r.tag(rec);
    const offset = r.u32(rec + 8);
    const length = r.u32(rec + 12);
    r.check(offset, length);
    tables.set(tag, { offset, length });
  }
  return tables;
}

function need(tables: Map<string, Table>, tag: string, min: number): Table {
  const t = tables.get(tag);
  if (!t || t.length < min) throw new FontError(`The font has no usable ${tag.trim()} table`);
  return t;
}

/** A string of the name table: UTF-16BE (Windows, Unicode) or Latin-1 (Mac Roman, close enough for a name). */
function nameString(r: Reader, at: number, length: number, platform: number): string {
  r.check(at, length);
  let s = "";
  if (platform === 3 || platform === 0) {
    for (let i = 0; i + 1 < length; i += 2) s += String.fromCharCode(r.u16(at + i));
  } else {
    for (let i = 0; i < length; i++) s += String.fromCharCode(r.u8(at + i));
  }
  // Only what a name holds: no control characters, at most 100 characters.
  let clean = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) clean += ch;
  }
  return clean.trim().slice(0, 100);
}

function namesOf(r: Reader, tables: Map<string, Table>): { family: string; style: string } {
  const t = tables.get("name");
  if (!t || t.length < 6) return { family: "", style: "" };
  const count = Math.min(r.u16(t.offset + 2), 2000);
  const strings = t.offset + r.u16(t.offset + 4);
  const found = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const rec = t.offset + 6 + i * 12;
    if (rec + 12 > t.offset + t.length) break;
    const platform = r.u16(rec);
    const language = r.u16(rec + 4);
    const id = r.u16(rec + 6);
    if (![1, 2, 16, 17].includes(id)) continue;
    const length = r.u16(rec + 8);
    const offset = r.u16(rec + 10);
    // English (Windows 0x409, or Mac 0) on the Windows platform is the name every app shows.
    const score = (platform === 3 ? 4 : platform === 0 ? 2 : 1) + (language === 0x409 || language === 0 ? 1 : 0);
    const prev = found.get(id);
    if (prev && prev.score >= score) continue;
    try {
      const value = nameString(r, strings + offset, length, platform);
      if (value) found.set(id, { score, value });
    } catch {
      // A name past the table's end is skipped, not fatal.
    }
  }
  return {
    family: found.get(16)?.value ?? found.get(1)?.value ?? "",
    style: found.get(17)?.value ?? found.get(2)?.value ?? "",
  };
}

/** A character map: format 4 (the basic plane) or 12 (all of Unicode), the best one the font has. */
function cmapOf(r: Reader, tables: Map<string, Table>): (codePoint: number) => number {
  const t = need(tables, "cmap", 4);
  const count = Math.min(r.u16(t.offset + 2), 100);
  let best: { format: number; at: number } | null = null;
  for (let i = 0; i < count; i++) {
    const rec = t.offset + 4 + i * 8;
    const platform = r.u16(rec);
    const encoding = r.u16(rec + 2);
    const at = t.offset + r.u32(rec + 4);
    if (at >= t.offset + t.length) continue;
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = r.u16(at);
    if (format === 12 && best?.format !== 12) best = { format, at };
    else if (format === 4 && !best) best = { format, at };
  }
  if (!best) throw new FontError("The font has no Unicode character map");
  const { format, at } = best;
  if (format === 4) {
    const segX2 = r.u16(at + 6);
    const segs = segX2 / 2;
    if (segs > MAX_CMAP_SEGMENTS) throw new FontError("The font's character map is too large");
    const ends = at + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    r.check(at, 16 + segX2 * 4);
    return (cp) => {
      if (cp > 0xffff) return 0;
      let lo = 0;
      let hi = segs - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const end = r.u16(ends + mid * 2);
        if (cp > end) lo = mid + 1;
        else {
          const start = r.u16(starts + mid * 2);
          if (cp < start) hi = mid - 1;
          else {
            const delta = r.i16(deltas + mid * 2);
            const rangeOffset = r.u16(ranges + mid * 2);
            if (rangeOffset === 0) return (cp + delta) & 0xffff;
            const glyphAt = ranges + mid * 2 + rangeOffset + (cp - start) * 2;
            try {
              const g = r.u16(glyphAt);
              return g === 0 ? 0 : (g + delta) & 0xffff;
            } catch {
              return 0;
            }
          }
        }
      }
      return 0;
    };
  }
  const groups = r.u32(at + 12);
  if (groups > MAX_CMAP_GROUPS) throw new FontError("The font's character map is too large");
  r.check(at + 16, groups * 12);
  return (cp) => {
    let lo = 0;
    let hi = groups - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = at + 16 + mid * 12;
      const start = r.u32(g);
      const end = r.u32(g + 4);
      if (cp < start) hi = mid - 1;
      else if (cp > end) lo = mid + 1;
      else return r.u32(g + 8) + (cp - start);
    }
    return 0;
  };
}

/**
 * Reads a font file: refuses what isn't one (or is too big, or malformed), and says its names, weight, slant and
 * embedding rights. A WOFF is unwrapped; WOFF2 isn't taken (its tables need a decoder the server doesn't carry).
 */
export function readFont(input: Uint8Array): FontInfo {
  if (input.length > FONT_MAX_BYTES) throw new FontError("The font is over 10 MB");
  const format = sniffFont(input);
  if (!format) {
    const tag = String.fromCharCode(input[0] ?? 0, input[1] ?? 0, input[2] ?? 0, input[3] ?? 0);
    throw new FontError(
      tag === "wOF2" ? "WOFF2 fonts aren't taken: upload the .ttf or .otf" : "That isn't a font file",
    );
  }
  const sfnt = format === "woff" ? unwrapWoff(input) : input;
  const r = new Reader(sfnt);
  const tables = tablesOf(r);
  const head = need(tables, "head", 54);
  if (r.u32(head.offset + 12) !== 0x5f0f3cf5) throw new FontError("The font's header is malformed");
  need(tables, "hhea", 36);
  const maxp = need(tables, "maxp", 6);
  if (r.u16(maxp.offset + 4) > MAX_GLYPHS) throw new FontError("The font has too many glyphs");
  need(tables, "hmtx", 4);
  cmapOf(r, tables);
  const names = namesOf(r, tables);
  if (!names.family) throw new FontError("The font has no family name");
  const os2 = tables.get("OS/2");
  let weight = 400;
  let embedding: FontInfo["embedding"] = "installable";
  let italic = (r.u16(head.offset + 44) & 2) !== 0;
  if (os2 && os2.length >= 10) {
    const w = r.u16(os2.offset + 4);
    if (w >= 1 && w <= 1000) weight = Math.min(900, Math.max(100, Math.round(w / 100) * 100));
    const fsType = r.u16(os2.offset + 8);
    // Bits 1–3 are exclusive in theory; the most restrictive one set wins in practice.
    if (fsType & 0x0002) embedding = "restricted";
    else if (fsType & 0x0004) embedding = "preview";
    else if (fsType & 0x0008) embedding = "editable";
    if (os2.length >= 64 && (r.u16(os2.offset + 62) & 1) !== 0) italic = true;
  }
  return {
    format,
    family: names.family,
    style: names.style || (italic ? "Italic" : "Regular"),
    weight,
    italic,
    embedding,
    sfnt,
  };
}

/** The metrics to measure text with, from an sfnt `readFont` checked (or a file the server ships). */
export function fontMetrics(sfnt: Uint8Array): FontMetrics {
  const r = new Reader(sfnt);
  const tables = tablesOf(r);
  const head = need(tables, "head", 54);
  const hhea = need(tables, "hhea", 36);
  const hmtx = need(tables, "hmtx", 4);
  const unitsPerEm = r.u16(head.offset + 18) || 1000;
  const numberOfHMetrics = Math.max(1, r.u16(hhea.offset + 34));
  if (numberOfHMetrics * 4 > hmtx.length) throw new FontError("The font's widths are cut short");
  const glyphOf = cmapOf(r, tables);
  const os2 = tables.get("OS/2");
  // Browsers line text up by the typographic metrics when the font asks for them (USE_TYPO_METRICS), else hhea.
  const useTypo = os2 && os2.length >= 78 && (r.u16(os2.offset + 62) & 0x80) !== 0;
  const ascent = useTypo && os2 ? r.i16(os2.offset + 68) : r.i16(hhea.offset + 4);
  const descent = useTypo && os2 ? r.i16(os2.offset + 70) : r.i16(hhea.offset + 6);
  const lineGap = useTypo && os2 ? r.i16(os2.offset + 72) : r.i16(hhea.offset + 8);
  const cache = new Map<number, number | null>();
  return {
    unitsPerEm,
    ascent,
    descent,
    lineGap,
    advanceOf(cp) {
      const hit = cache.get(cp);
      if (hit !== undefined) return hit;
      const gid = glyphOf(cp);
      const width = gid === 0 ? null : r.u16(hmtx.offset + Math.min(gid, numberOfHMetrics - 1) * 4);
      cache.set(cp, width);
      return width;
    },
  };
}
