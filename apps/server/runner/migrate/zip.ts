import { closeSync, openSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * A .zip written one file at a time, stored and not compressed, so a workspace's files cost no memory (ADR 0055,
 * addendum 2026-11-16). No ZIP64: the import reads at most 2 GB and 50,000 files (`ARCHIVE_LIMITS`), and `walk.ts`
 * stops well before either. Written to `<path>.part` and renamed when complete, so a cut run leaves no file that
 * reads as an export.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * The files of a small .zip in hand (a skill an app keeps zipped): stored or deflated entries, no ZIP64, each at most
 * `max` bytes once unpacked. A name that climbs out (`..`) or starts at the root is left out. Null when it isn't a zip
 * this reads.
 */
export function readZip(bytes: Uint8Array, max: number): Map<string, Uint8Array> | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const out = new Map<string, Uint8Array>();
    for (let n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) return null;
      const method = view.getUint16(at + 10, true);
      const packed = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const local = view.getUint32(at + 42, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      if (name.endsWith("/") || name.startsWith("/") || name.split(/[\\/]/).includes("..") || size > max) continue;
      if (view.getUint32(local, true) !== 0x04034b50) return null;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + packed);
      if (method === 0) out.set(name, data);
      else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(data, { maxOutputLength: max })));
      else return null;
    }
    return out;
  } catch {
    return null;
  }
}

/** What goes in: bytes in hand, or a file on disk read in pieces. */
export type ZipSource = { bytes: Uint8Array } | { file: string };

/** The largest archive and entry count a zip without ZIP64 can say. */
const MAX_OFFSET = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
/** UTF-8 names (bit 11). */
const FLAGS = 0x0800;
/** 1980-01-01 00:00: the files' own times say nothing an import reads. */
const DOS_DATE = 0x0021;

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

export class ZipWriter {
  readonly #fd: number;
  readonly #entries: Entry[] = [];
  #offset = 0;
  readonly #names = new Set<string>();

  constructor(private readonly path: string) {
    this.#fd = openSync(`${path}.part`, "w", 0o600);
  }

  #write(bytes: Uint8Array, position?: number) {
    let done = 0;
    while (done < bytes.length) {
      done += writeSync(this.#fd, bytes, done, bytes.length - done, position === undefined ? null : position + done);
    }
    if (position === undefined) this.#offset += bytes.length;
  }

  /** Adds one entry; false when a name repeats, the file can't be read, or the archive is full. */
  add(name: string, source: ZipSource): boolean {
    if (this.#names.has(name) || this.#entries.length >= MAX_ENTRIES) return false;
    const encoded = new TextEncoder().encode(name);
    const at = this.#offset;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, FLAGS, true);
    header.setUint16(8, 0, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, DOS_DATE, true);
    header.setUint16(26, encoded.length, true);
    let crc = 0;
    let size = 0;
    if ("bytes" in source) {
      crc = crc32(source.bytes);
      size = source.bytes.length;
      if (at + 30 + encoded.length + size > MAX_OFFSET) return false;
      header.setUint32(14, crc, true);
      header.setUint32(18, size, true);
      header.setUint32(22, size, true);
      this.#write(new Uint8Array(header.buffer));
      this.#write(encoded);
      this.#write(source.bytes);
    } else {
      let fd: number;
      try {
        fd = openSync(source.file, "r");
      } catch {
        return false;
      }
      // The sizes and the CRC are written back once the file has been copied.
      this.#write(new Uint8Array(header.buffer));
      this.#write(encoded);
      const chunk = new Uint8Array(1024 * 1024);
      try {
        for (;;) {
          const n = readSync(fd, chunk, 0, chunk.length, null);
          if (n <= 0) break;
          const part = chunk.subarray(0, n);
          crc = crc32(part, crc);
          size += n;
          this.#write(part);
        }
      } finally {
        closeSync(fd);
      }
      const sizes = new DataView(new ArrayBuffer(12));
      sizes.setUint32(0, crc, true);
      sizes.setUint32(4, size, true);
      sizes.setUint32(8, size, true);
      this.#write(new Uint8Array(sizes.buffer), at + 14);
    }
    this.#names.add(name);
    this.#entries.push({ name: encoded, crc, size, offset: at });
    return true;
  }

  /** Writes the directory and puts the file in place. */
  close() {
    const start = this.#offset;
    for (const e of this.#entries) {
      const row = new DataView(new ArrayBuffer(46));
      row.setUint32(0, 0x02014b50, true);
      row.setUint16(4, 20, true);
      row.setUint16(6, 20, true);
      row.setUint16(8, FLAGS, true);
      row.setUint16(14, DOS_DATE, true);
      row.setUint32(16, e.crc, true);
      row.setUint32(20, e.size, true);
      row.setUint32(24, e.size, true);
      row.setUint16(28, e.name.length, true);
      row.setUint32(42, e.offset, true);
      this.#write(new Uint8Array(row.buffer));
      this.#write(e.name);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.#entries.length, true);
    end.setUint16(10, this.#entries.length, true);
    end.setUint32(12, this.#offset - start, true);
    end.setUint32(16, start, true);
    this.#write(new Uint8Array(end.buffer));
    closeSync(this.#fd);
    renameSync(`${this.path}.part`, this.path);
  }

  /** Drops what was written. */
  abort() {
    try {
      closeSync(this.#fd);
    } catch {}
    rmSync(`${this.path}.part`, { force: true });
  }
}
