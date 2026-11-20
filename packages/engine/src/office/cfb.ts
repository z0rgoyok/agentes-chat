import { officeUnreadable } from "./limits";

/**
 * The Compound File Binary format (MS-CFB) that legacy Office files are stored in, read far enough to take one
 * stream out of the root storage (ADR 0198): a legacy workbook's `Workbook` stream, or the `EncryptedPackage` that
 * says an Office file is locked with a password. Every sector chain is followed at most once per sector, so a
 * damaged or hostile file (chains that loop, sectors past the end, sizes past the file) is refused, never followed
 * forever.
 */

const END_OF_CHAIN = 0xfffffffe;
/** Sector numbers at or above this one are markers (free, end of chain, FAT, DIFAT), never a sector. */
const MAX_REGULAR_SECTOR = 0xfffffffa;
const NO_STREAM = 0xffffffff;
const HEADER_BYTES = 512;
const DIR_ENTRY_BYTES = 128;
const STORAGE = 1;
const STREAM = 2;
const ROOT = 5;

interface DirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/** A compound file's root-level streams, read on demand. */
export class CompoundFile {
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: Uint32Array;
  private readonly entries: DirEntry[];
  private miniFat: Uint32Array | null = null;
  private miniStream: Uint8Array | null = null;

  constructor(private readonly bytes: Uint8Array) {
    if (bytes.byteLength < HEADER_BYTES) throw officeUnreadable("it is damaged");
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = this.view.getUint16(0x1e, true);
    const miniShift = this.view.getUint16(0x20, true);
    if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6) throw officeUnreadable("it is damaged");
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    this.miniCutoff = this.view.getUint32(0x38, true);
    this.fat = this.readFat();
    this.entries = this.readDirectory(this.view.getUint32(0x30, true));
  }

  /** How many whole sectors follow the header (a sector number past them points outside the file). */
  private get sectorCount(): number {
    return Math.floor(this.bytes.byteLength / this.sectorSize) - 1;
  }

  private sectorOffset(sector: number): number {
    if (sector >= MAX_REGULAR_SECTOR || sector >= this.sectorCount) throw officeUnreadable("it is damaged");
    return (sector + 1) * this.sectorSize;
  }

  /** The FAT: the sectors the DIFAT lists (109 in the header, the rest in a chain of DIFAT sectors). */
  private readFat(): Uint32Array {
    const fatSectors: number[] = [];
    const total = this.view.getUint32(0x2c, true);
    if (total > this.sectorCount) throw officeUnreadable("it is damaged");
    for (let i = 0; i < 109 && fatSectors.length < total; i++) {
      const s = this.view.getUint32(0x4c + i * 4, true);
      if (s < MAX_REGULAR_SECTOR) fatSectors.push(s);
    }
    let difat = this.view.getUint32(0x44, true);
    const perDifat = this.sectorSize / 4 - 1;
    const seen = new Set<number>();
    while (difat < MAX_REGULAR_SECTOR && fatSectors.length < total) {
      if (seen.has(difat)) throw officeUnreadable("it is damaged");
      seen.add(difat);
      const at = this.sectorOffset(difat);
      for (let i = 0; i < perDifat && fatSectors.length < total; i++) {
        const s = this.view.getUint32(at + i * 4, true);
        if (s < MAX_REGULAR_SECTOR) fatSectors.push(s);
      }
      difat = this.view.getUint32(at + perDifat * 4, true);
    }
    const perSector = this.sectorSize / 4;
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((sector, i) => {
      const at = this.sectorOffset(sector);
      for (let k = 0; k < perSector; k++) fat[i * perSector + k] = this.view.getUint32(at + k * 4, true);
    });
    return fat;
  }

  /** The sectors of a chain in order; a loop or a sector outside the table is a damaged file. */
  private chain(start: number, table: Uint32Array, limit: number): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let s = start; s !== END_OF_CHAIN; ) {
      if (s >= MAX_REGULAR_SECTOR || s >= table.length || seen.has(s) || out.length >= limit) {
        throw officeUnreadable("it is damaged");
      }
      seen.add(s);
      out.push(s);
      s = table[s] ?? END_OF_CHAIN;
    }
    return out;
  }

  /** A chain of regular sectors, `size` bytes of it (all of it when `size` is null). */
  private readChain(start: number, size: number | null): Uint8Array {
    const sectors = this.chain(start, this.fat, this.sectorCount);
    const length = size ?? sectors.length * this.sectorSize;
    if (length > sectors.length * this.sectorSize) throw officeUnreadable("it is damaged");
    const out = new Uint8Array(length);
    let written = 0;
    for (const sector of sectors) {
      if (written >= length) break;
      const at = this.sectorOffset(sector);
      const take = Math.min(this.sectorSize, length - written);
      out.set(this.bytes.subarray(at, at + take), written);
      written += take;
    }
    if (written < length) throw officeUnreadable("it is damaged");
    return out;
  }

  private readDirectory(start: number): DirEntry[] {
    const data = this.readChain(start, null);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out: DirEntry[] = [];
    for (let at = 0; at + DIR_ENTRY_BYTES <= data.byteLength; at += DIR_ENTRY_BYTES) {
      const nameBytes = Math.min(view.getUint16(at + 0x40, true), 64);
      const chars: number[] = [];
      for (let k = 0; k + 1 < nameBytes; k += 2) {
        const code = view.getUint16(at + k, true);
        if (code === 0) break;
        chars.push(code);
      }
      out.push({
        name: String.fromCharCode(...chars),
        type: view.getUint8(at + 0x42),
        left: view.getUint32(at + 0x44, true),
        right: view.getUint32(at + 0x48, true),
        child: view.getUint32(at + 0x4c, true),
        start: view.getUint32(at + 0x74, true),
        // Version 3 files keep only the low 32 bits; nothing this reader opens is past 4 GB.
        size: view.getUint32(at + 0x78, true),
      });
    }
    if (out[0]?.type !== ROOT) throw officeUnreadable("it is damaged");
    return out;
  }

  /** The root storage's direct children (its tree of siblings, each visited once). */
  private rootChildren(): DirEntry[] {
    const out: DirEntry[] = [];
    const seen = new Set<number>();
    const stack = [this.entries[0]?.child ?? NO_STREAM];
    while (stack.length > 0) {
      const id = stack.pop() as number;
      if (id === NO_STREAM || id >= this.entries.length || seen.has(id)) continue;
      seen.add(id);
      const entry = this.entries[id] as DirEntry;
      out.push(entry);
      stack.push(entry.left, entry.right);
    }
    return out;
  }

  /** Whether the root holds a stream or storage of this name (any case, as the format compares names). */
  has(name: string): boolean {
    const wanted = name.toUpperCase();
    return this.rootChildren().some(
      (e) => (e.type === STREAM || e.type === STORAGE) && e.name.toUpperCase() === wanted,
    );
  }

  /** A root-level stream's bytes, or null when there is none of that name. */
  stream(name: string): Uint8Array | null {
    const wanted = name.toUpperCase();
    const entry = this.rootChildren().find((e) => e.type === STREAM && e.name.toUpperCase() === wanted);
    if (!entry) return null;
    if (entry.size > this.bytes.byteLength) throw officeUnreadable("it is damaged");
    if (entry.size < this.miniCutoff) return this.readMini(entry.start, entry.size);
    return this.readChain(entry.start, entry.size);
  }

  /** A stream kept in the mini stream (64-byte sectors, their own table). */
  private readMini(start: number, size: number): Uint8Array {
    if (size === 0) return new Uint8Array();
    if (!this.miniFat || !this.miniStream) {
      const root = this.entries[0] as DirEntry;
      this.miniStream = this.readChain(root.start, root.size);
      const firstMiniFat = this.view.getUint32(0x3c, true);
      const raw = firstMiniFat < MAX_REGULAR_SECTOR ? this.readChain(firstMiniFat, null) : new Uint8Array();
      const table = new Uint32Array(raw.byteLength / 4);
      const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < table.length; i++) table[i] = v.getUint32(i * 4, true);
      this.miniFat = table;
    }
    const sectors = this.chain(start, this.miniFat, this.miniStream.byteLength / this.miniSectorSize + 1);
    if (size > sectors.length * this.miniSectorSize) throw officeUnreadable("it is damaged");
    const out = new Uint8Array(size);
    let written = 0;
    for (const sector of sectors) {
      if (written >= size) break;
      const at = sector * this.miniSectorSize;
      const take = Math.min(this.miniSectorSize, size - written);
      if (at + take > this.miniStream.byteLength) throw officeUnreadable("it is damaged");
      out.set(this.miniStream.subarray(at, at + take), written);
      written += take;
    }
    return out;
  }
}
