import { deflateRawSync, inflateRawSync } from "node:zlib";
import { ValidationError } from "./errors";

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/** A file as the central directory lists it: where its bytes are and their declared size, nothing inflated. */
export interface ZipListing {
  path: string;
  size: number;
  /** A symbolic link (Unix mode in the external attributes): its bytes are a path, not content. */
  symlink: boolean;
  method: number;
  flags: number;
  compressed: number;
  local: number;
}

/**
 * The central directory's files (folders left out). No zip64, so at most 65,535 entries: an archive past that is
 * refused, never read in part.
 */
export function listZip(buffer: Uint8Array): ZipListing[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ValidationError("Not a zip file", "skill.bad_zip");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  // Past what these fields hold, writers (git archive among them) put their maximum here and the real values in a
  // zip64 record, whose locator sits just before: read as they are, they would list only the first 65,535 files.
  const zip64 = eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50;
  if (zip64 && (count === 0xffff || offset === 0xffffffff)) {
    throw new ValidationError("Too many files to read (max 65,535)", "skill.too_many_files", {
      files: "65,535+",
      max: 65_535,
    });
  }
  const decoder = new TextDecoder();
  const files: ZipListing[] = [];
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new ValidationError("Corrupt zip (central directory)", "skill.bad_zip");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const path = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLength));
    if (!path.endsWith("/")) {
      files.push({
        path,
        size: view.getUint32(offset + 24, true),
        symlink: ((view.getUint32(offset + 38, true) >>> 16) & 0o170000) === 0o120000,
        method: view.getUint16(offset + 10, true),
        flags: view.getUint16(offset + 8, true),
        compressed: view.getUint32(offset + 20, true),
        local: view.getUint32(offset + 42, true),
      });
    }
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return files;
}

/** One file's bytes, inflated to exactly its declared size (so a zip bomb can't grow past what was checked). */
export function inflateZipEntry(buffer: Uint8Array, entry: ZipListing): Uint8Array {
  if (entry.flags & 0x1) throw new ValidationError("Encrypted zips are not supported", "skill.bad_zip");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (entry.local + 30 > buffer.length || view.getUint32(entry.local, true) !== 0x04034b50) {
    throw new ValidationError("Corrupt zip (local header)", "skill.bad_zip");
  }
  const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
  const raw = buffer.subarray(start, start + entry.compressed);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }));
  else throw new ValidationError(`Unsupported compression in ${entry.path}`, "skill.bad_zip");
  if (data.byteLength !== entry.size) throw new ValidationError(`Corrupt zip entry ${entry.path}`, "skill.bad_zip");
  return data;
}

/**
 * Reads a zip archive (stored or deflated entries; no zip64, no encryption)
 * within limits, checked before inflating so a zip bomb can't get through.
 * Entries `skip` names come back with no data: never inflated, and not counted toward `maxBytes`.
 */
export function readZip(
  buffer: Uint8Array,
  limits: { maxFiles: number; maxBytes: number },
  skip: (path: string) => boolean = () => false,
): ZipEntry[] {
  const files = listZip(buffer);
  if (files.length > limits.maxFiles) throw new ValidationError(`Too many files (max ${limits.maxFiles})`);
  if (files.reduce((n, f) => n + (skip(f.path) ? 0 : f.size), 0) > limits.maxBytes) {
    throw new ValidationError(`The skill is too large (max ${limits.maxBytes} bytes)`);
  }
  return files.map((f) => ({ path: f.path, data: skip(f.path) ? new Uint8Array() : inflateZipEntry(buffer, f) }));
}

// ── Writing ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip of files (UTF-8 names; text as UTF-8 or bytes as they are), the one writer of Word, Excel and PowerPoint files
 * here. Each entry is deflated, unless `store` keeps it as it is (pictures, already compressed). No zip64: at most
 * 65,535 files and 4 GiB.
 */
export function zip(files: [string, string | Uint8Array][], options: { store?: (path: string) => boolean } = {}) {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = enc.encode(path);
    const raw = typeof content === "string" ? enc.encode(content) : content;
    const stored = options.store?.(path) === true;
    const data = stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
