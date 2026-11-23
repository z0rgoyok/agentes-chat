import { deflateSync, inflateSync } from "node:zlib";

/**
 * Pictures as PDF image objects (ADR 0198), in pure TypeScript: a JPEG goes in as it is (DCT, the reader decodes it),
 * with its size, color space and EXIF turn read from its markers; a PNG is decoded (every color type, bit depth,
 * filter and interlacing) into 8-bit RGB with its transparency as a separate soft mask, both deflated; a GIF's first
 * frame likewise. Anything else (WebP has no decoder here), or a picture past `PIXELS_MAX`, isn't drawn.
 */

/** The most pixels a PNG or a GIF is decoded to (its RGB and its mask held at once). */
const PIXELS_MAX = 24_000_000;

export interface PdfImage {
  width: number;
  height: number;
  /** The image dictionary's entries past type, size and length (`/ColorSpace /DeviceRGB …`). */
  dict: string;
  data: Uint8Array;
  /** The soft mask (8-bit gray, deflated) when the picture has transparency. */
  mask?: Uint8Array;
  /**
   * How the stored pixels are turned to show upright (JPEG's EXIF orientation): 0, 90, 180 or 270 degrees clockwise.
   * The width and height are the stored ones.
   */
  turn: 0 | 90 | 180 | 270;
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

/** The EXIF orientation of a JPEG's APP1 segment (1 when none). */
function exifOrientation(b: Uint8Array, start: number, length: number): number {
  if (length < 14 || String.fromCharCode(...b.subarray(start, start + 4)) !== "Exif") return 1;
  const tiff = start + 6;
  const little = b[tiff] === 0x49;
  const u16 = (i: number) => (little ? (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) : ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0));
  const u32 = (i: number) =>
    little
      ? ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
      : (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  const count = u16(ifd);
  for (let k = 0; k < count && k < 200; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > start + length) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

export function jpegImage(b: Uint8Array): PdfImage | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let orientation = 1;
  let adobe = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, length - 2);
    if (marker === 0xee && String.fromCharCode(...b.subarray(i + 4, i + 9)) === "Adobe") adobe = true;
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      const height = ((b[i + 5] ?? 0) << 8) | (b[i + 6] ?? 0);
      const width = ((b[i + 7] ?? 0) << 8) | (b[i + 8] ?? 0);
      const components = b[i + 9] ?? 3;
      if (!width || !height) return null;
      const space = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      // Photoshop writes CMYK inverted (its Adobe marker says so).
      const decode = components === 4 && adobe ? " /Decode [1 0 1 0 1 0 1 0]" : "";
      const turn = orientation === 3 ? 180 : orientation === 6 ? 90 : orientation === 8 ? 270 : 0;
      return {
        width,
        height,
        dict: `/ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}`,
        data: b,
        turn,
      };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + length;
  }
  return null;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undoes PNG's row filters in place; `data` is rows of `1 + rowBytes` bytes. */
function unfilter(data: Uint8Array, offset: number, rows: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rows * rowBytes);
  for (let y = 0; y < rows; y++) {
    const filter = data[offset + y * (rowBytes + 1)] ?? 0;
    const src = offset + y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x] ?? 0;
      const a = x >= bpp ? (out[row + x - bpp] as number) : 0;
      const b = y > 0 ? (out[prev + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (out[prev + x - bpp] as number) : 0;
      let v: number;
      switch (filter) {
        case 1:
          v = raw + a;
          break;
        case 2:
          v = raw + b;
          break;
        case 3:
          v = raw + ((a + b) >> 1);
          break;
        case 4:
          v = raw + paeth(a, b, c);
          break;
        default:
          v = raw;
      }
      out[row + x] = v & 0xff;
    }
  }
  return out;
}

export function pngImage(b: Uint8Array): PdfImage | null {
  if (b.length < 33 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at + 8 <= b.length) {
    const length = view.getUint32(at);
    const kind = String.fromCharCode(b[at + 4] ?? 0, b[at + 5] ?? 0, b[at + 6] ?? 0, b[at + 7] ?? 0);
    const body = b.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = b[at + 16] ?? 8;
      type = b[at + 17] ?? 0;
      interlace = b[at + 20] ?? 0;
    } else if (kind === "PLTE") palette = body;
    else if (kind === "tRNS") trns = body;
    else if (kind === "IDAT") idat.push(body);
    else if (kind === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || width * height > PIXELS_MAX) return null;
  const channels = type === 0 ? 1 : type === 2 ? 3 : type === 3 ? 1 : type === 4 ? 2 : type === 6 ? 4 : 0;
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = interlace === 1 ? ADAM7 : ([[0, 0, 1, 1]] as const);
  let expected = 0;
  const sizes = passes.map(([x0, y0, dx, dy]) => {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    const rowBytes = Math.ceil((w * bitsPerPixel) / 8);
    const bytes = w > 0 && h > 0 ? h * (rowBytes + 1) : 0;
    expected += bytes;
    return { w, h, rowBytes, bytes };
  });
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of idat) {
      joined.set(c, o);
      o += c.length;
    }
    raw = new Uint8Array(inflateSync(joined, { maxOutputLength: expected + 1024 }));
  } catch {
    return null;
  }
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height).fill(255);
  let transparent = false;
  const max = (1 << Math.min(depth, 8)) - 1;
  // A gray or RGB tRNS names one color that is transparent (16-bit samples).
  const key = trns && (type === 0 || type === 2) ? trns : null;
  let offset = 0;
  passes.forEach(([x0, y0, dx, dy], p) => {
    const size = sizes[p] as (typeof sizes)[number];
    if (size.bytes === 0) return;
    const pixels = unfilter(raw, offset, size.h, size.rowBytes, bpp);
    offset += size.bytes;
    const sample = (row: number, index: number): number => {
      const base = row * size.rowBytes;
      if (depth === 8) return pixels[base + index] as number;
      if (depth === 16)
        return (((pixels[base + index * 2] as number) << 8) | (pixels[base + index * 2 + 1] as number)) >>> 0;
      const bit = index * depth;
      const byte = pixels[base + (bit >> 3)] as number;
      return (byte >> (8 - depth - (bit & 7))) & max;
    };
    const to8 = (v: number) => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / max));
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        const px = (y0 + y * dy) * width + x0 + x * dx;
        const s = (k: number) => sample(y, x * channels + k);
        let r: number;
        let g: number;
        let bl: number;
        let a = 255;
        if (type === 3) {
          const index = s(0);
          r = palette?.[index * 3] ?? 0;
          g = palette?.[index * 3 + 1] ?? 0;
          bl = palette?.[index * 3 + 2] ?? 0;
          if (trns && index < trns.length) a = trns[index] as number;
        } else if (type === 0 || type === 4) {
          const v = s(0);
          r = to8(v);
          g = r;
          bl = r;
          if (type === 4) a = to8(s(1));
          else if (key && key.length >= 2 && v === (((key[0] as number) << 8) | (key[1] as number))) a = 0;
        } else {
          const vr = s(0);
          const vg = s(1);
          const vb = s(2);
          r = to8(vr);
          g = to8(vg);
          bl = to8(vb);
          if (type === 6) a = to8(s(3));
          else if (key && key.length >= 6) {
            const kr = ((key[0] as number) << 8) | (key[1] as number);
            const kg = ((key[2] as number) << 8) | (key[3] as number);
            const kb = ((key[4] as number) << 8) | (key[5] as number);
            if (vr === kr && vg === kg && vb === kb) a = 0;
          }
        }
        rgb[px * 3] = r;
        rgb[px * 3 + 1] = g;
        rgb[px * 3 + 2] = bl;
        if (a !== 255) {
          alpha[px] = a;
          transparent = true;
        }
      }
    }
  });
  const image: PdfImage = {
    width,
    height,
    dict: "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
    data: new Uint8Array(deflateSync(rgb)),
    turn: 0,
  };
  if (transparent) image.mask = new Uint8Array(deflateSync(alpha));
  return image;
}

// ── GIF ──────────────────────────────────────────────────────────────────────

/** A GIF frame's LZW data (its sub-blocks joined) as `count` palette indices; what a short stream leaves is 0. */
function unLzw(data: Uint8Array, minSize: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minSize;
  const end = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) suffix[i] = i;
  let size = minSize + 1;
  let mask = (1 << size) - 1;
  let next = clear + 2;
  let old = -1;
  let first = 0;
  let acc = 0;
  let bits = 0;
  let at = 0;
  let o = 0;
  while (o < count) {
    while (bits < size) {
      if (at >= data.length) return out;
      acc |= (data[at++] as number) << bits;
      bits += 8;
    }
    const code = acc & mask;
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minSize + 1;
      mask = (1 << size) - 1;
      next = clear + 2;
      old = -1;
      continue;
    }
    if (code === end) break;
    if (old === -1) {
      // The first code after a clear is a color of its own.
      if (code >= clear) break;
      out[o++] = code;
      old = code;
      first = code;
      continue;
    }
    // A code past the table's next entry is damage: what was read stays.
    if (code > next) break;
    let sp = 0;
    let c = code;
    if (code === next) {
      // The entry being made now: the previous string and its own first color.
      stack[sp++] = first;
      c = old;
    }
    while (c >= clear) {
      stack[sp++] = suffix[c] as number;
      c = prefix[c] as number;
    }
    first = c;
    stack[sp++] = c;
    while (sp > 0 && o < count) out[o++] = stack[--sp] as number;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if (next > mask && size < 12) {
        size++;
        mask = (1 << size) - 1;
      }
    }
    old = code;
  }
  return out;
}

/** The passes of an interlaced GIF frame: rows from `start`, every `step`. */
const GIF_PASSES = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
] as const;

/** Where each stored row of an interlaced frame goes. */
function interlacedRows(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of GIF_PASSES) for (let y = start; y < height; y += step) rows.push(y);
  return rows;
}

/** A GIF's first frame on its screen (what the frame doesn't cover, and its transparent color, see-through). */
export function gifImage(b: Uint8Array): PdfImage | null {
  if (b.length < 13 || !/^GIF8[79]a$/.test(String.fromCharCode(...b.subarray(0, 6)))) return null;
  const u16 = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const width = u16(6);
  const height = u16(8);
  if (!width || !height || width * height > PIXELS_MAX) return null;
  const screen = b[10] ?? 0;
  let at = 13;
  let palette: Uint8Array | null = null;
  if (screen & 0x80) {
    const size = 3 * (1 << ((screen & 7) + 1));
    palette = b.subarray(at, at + size);
    at += size;
  }
  let transparentIndex = -1;
  const skipBlocks = () => {
    while (at < b.length) {
      const length = b[at] ?? 0;
      at += 1 + length;
      if (length === 0) return;
    }
  };
  while (at < b.length) {
    const kind = b[at++];
    if (kind === 0x21) {
      const label = b[at++];
      // A graphic control extension says whether the frame has a transparent color.
      if (label === 0xf9 && (b[at] ?? 0) >= 4 && ((b[at + 1] ?? 0) & 1) === 1) transparentIndex = b[at + 4] ?? -1;
      skipBlocks();
      continue;
    }
    // Past the extensions, the first frame (a file ending before one has nothing to show).
    if (kind !== 0x2c) return null;
    const left = u16(at);
    const top = u16(at + 2);
    const fw = u16(at + 4);
    const fh = u16(at + 6);
    const flags = b[at + 8] ?? 0;
    at += 9;
    if (flags & 0x80) {
      const size = 3 * (1 << ((flags & 7) + 1));
      palette = b.subarray(at, at + size);
      at += size;
    }
    const minSize = b[at++] ?? 0;
    if (!palette || minSize < 1 || minSize > 8 || !fw || !fh || fw * fh > PIXELS_MAX) return null;
    const parts: Uint8Array[] = [];
    let total = 0;
    while (at < b.length) {
      const length = b[at] ?? 0;
      at += 1;
      if (length === 0) break;
      const part = b.subarray(at, at + length);
      parts.push(part);
      total += part.length;
      at += length;
    }
    const data = new Uint8Array(total);
    let o = 0;
    for (const part of parts) {
      data.set(part, o);
      o += part.length;
    }
    const indices = unLzw(data, minSize, fw * fh);
    const rows = flags & 0x40 ? interlacedRows(fh) : null;
    const rgb = new Uint8Array(width * height * 3);
    const alpha = new Uint8Array(width * height);
    let transparent = left > 0 || top > 0 || left + fw < width || top + fh < height;
    for (let r = 0; r < fh; r++) {
      const y = top + (rows ? (rows[r] as number) : r);
      if (y >= height) continue;
      for (let x = 0; x < fw && left + x < width; x++) {
        const index = indices[r * fw + x] as number;
        const p = y * width + left + x;
        if (index === transparentIndex) {
          transparent = true;
          continue;
        }
        rgb[p * 3] = palette[index * 3] ?? 0;
        rgb[p * 3 + 1] = palette[index * 3 + 1] ?? 0;
        rgb[p * 3 + 2] = palette[index * 3 + 2] ?? 0;
        alpha[p] = 255;
      }
    }
    const image: PdfImage = {
      width,
      height,
      dict: "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
      data: new Uint8Array(deflateSync(rgb)),
      turn: 0,
    };
    if (transparent) image.mask = new Uint8Array(deflateSync(alpha));
    return image;
  }
  return null;
}

/** A picture as a PDF image, or null when it is of a kind (or a size) not drawn. */
export function pdfImage(bytes: Uint8Array): PdfImage | null {
  try {
    return jpegImage(bytes) ?? pngImage(bytes) ?? gifImage(bytes);
  } catch {
    return null;
  }
}
