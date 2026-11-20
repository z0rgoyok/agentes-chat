import { ValidationError } from "../errors";
import { inflateZipEntry, listZip, type ZipListing } from "../zip";
import { OFFICE_LIMITS, officeEncrypted, officeTooLarge, officeUnreadable } from "./limits";
import { attr, type Element, kids, MAX_PACKAGE_TAGS, parseXml, tagCount } from "./xml";

/**
 * An Office file as a package of parts (ADR 0198): the zip's entries by name, read on demand within one budget of
 * inflated bytes for the whole file (`OFFICE_LIMITS.unpackedBytes`, checked against each entry's declared size before
 * it is inflated, and `inflateZipEntry` never inflates past that size), and the relationships that tie the parts
 * together. Names are matched without regard to case or to a leading slash, as Office itself does.
 */

export interface Relationship {
  id: string;
  type: string;
  /** The part it points at (a package path, no leading slash), or the address of an external target. */
  target: string;
  external: boolean;
}

/** The well-known relationship types, by the end of their URI (strict and transitional files differ before it). */
export const REL = {
  officeDocument: "/officeDocument",
  worksheet: "/worksheet",
  sharedStrings: "/sharedStrings",
  styles: "/styles",
  theme: "/theme",
  slide: "/slide",
  slideLayout: "/slideLayout",
  slideMaster: "/slideMaster",
  notesSlide: "/notesSlide",
  image: "/image",
  hyperlink: "/hyperlink",
  numbering: "/numbering",
} as const;

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** An OLE compound file: an old binary Office file, or a new one locked with a password (stored encrypted inside). */
export const isCompoundFile = (bytes: Uint8Array) => CFB_MAGIC.every((b, i) => bytes[i] === b);

export const isZipFile = (bytes: Uint8Array) =>
  bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);

/** A package path without a leading slash, with `.` and `..` resolved; null when it climbs out of the package. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/** Where a relationship's target points from the part that holds it. */
export function resolveTarget(fromPart: string, target: string): string | null {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Not percent-encoded after all: as written.
  }
  if (decoded.startsWith("/")) return normalizePath(decoded);
  const dir = fromPart.includes("/") ? fromPart.slice(0, fromPart.lastIndexOf("/") + 1) : "";
  return normalizePath(dir + decoded);
}

/** The relationships part of a part: `xl/workbook.xml` → `xl/_rels/workbook.xml.rels`. */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

export class OfficePackage {
  private readonly entries = new Map<string, ZipListing>();
  private readonly xmlCache = new Map<string, Element | null>();
  private readonly relsCache = new Map<string, Map<string, Relationship>>();
  private used = 0;
  /** Tags of the parts parsed so far (`MAX_PACKAGE_TAGS`). */
  private tags = 0;

  private constructor(private readonly buffer: Uint8Array) {
    let listing: ZipListing[];
    try {
      listing = listZip(buffer);
    } catch (error) {
      if (error instanceof ValidationError && error.code === "skill.too_many_files") throw officeTooLarge("parts");
      throw officeUnreadable("it is not a valid Office file");
    }
    if (listing.length > OFFICE_LIMITS.parts) throw officeTooLarge("parts");
    for (const entry of listing) {
      const key = normalizePath(entry.path)?.toLowerCase();
      if (key && !entry.symlink && !this.entries.has(key)) this.entries.set(key, entry);
    }
  }

  /** Opens a package: refused past the input limit, when locked with a password, or when it is no zip at all. */
  static open(bytes: Uint8Array): OfficePackage {
    if (bytes.byteLength > OFFICE_LIMITS.inputBytes) throw officeTooLarge("size");
    if (isCompoundFile(bytes)) throw officeEncrypted();
    if (!isZipFile(bytes)) throw officeUnreadable("it is not a valid Office file");
    return new OfficePackage(bytes);
  }

  /** Every part's name (lowercase, no leading slash). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(path: string): boolean {
    const key = normalizePath(path)?.toLowerCase();
    return key !== undefined && this.entries.has(key);
  }

  /** A part's declared (inflated) size, or null when there is no such part. */
  sizeOf(path: string): number | null {
    const key = normalizePath(path)?.toLowerCase();
    const entry = key ? this.entries.get(key) : undefined;
    return entry ? entry.size : null;
  }

  /** A part's bytes, counted in the file's budget; null when there is no such part. */
  bytes(path: string): Uint8Array | null {
    const key = normalizePath(path)?.toLowerCase();
    const entry = key ? this.entries.get(key) : undefined;
    if (!entry) return null;
    if (this.used + entry.size > OFFICE_LIMITS.unpackedBytes) throw officeTooLarge("unpacked");
    this.used += entry.size;
    try {
      return inflateZipEntry(this.buffer, entry);
    } catch (error) {
      if (error instanceof ValidationError && /encrypted/i.test(error.message)) throw officeEncrypted();
      throw officeUnreadable(`${entry.path} is damaged`);
    }
  }

  /** A part as text (UTF-8, or UTF-16 by its byte order mark); null when there is no such part. */
  text(path: string): string | null {
    const bytes = this.bytes(path);
    if (!bytes) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    return new TextDecoder().decode(bytes);
  }

  /** A part's root element (parsed once); null when there is no such part. */
  xml(path: string): Element | null {
    const key = normalizePath(path)?.toLowerCase() ?? "";
    if (this.xmlCache.has(key)) return this.xmlCache.get(key) ?? null;
    const text = this.text(path);
    if (text !== null) {
      this.tags += tagCount(text);
      if (this.tags > MAX_PACKAGE_TAGS) throw officeUnreadable("it is too large to read");
    }
    const root = text === null ? null : parseXml(text, path);
    this.xmlCache.set(key, root);
    return root;
  }

  /** A part's relationships by id (none when it has no relationships part). */
  rels(part: string): Map<string, Relationship> {
    const key = normalizePath(part)?.toLowerCase() ?? "";
    const cached = this.relsCache.get(key);
    if (cached) return cached;
    const out = new Map<string, Relationship>();
    const root = this.xml(relsPathOf(normalizePath(part) ?? part));
    for (const rel of kids(root, "Relationship")) {
      const id = attr(rel, "Id");
      const rawTarget = attr(rel, "Target");
      if (!id || rawTarget === null) continue;
      const external = attr(rel, "TargetMode") === "External";
      const target = external ? rawTarget : resolveTarget(part, rawTarget);
      if (target === null) continue;
      out.set(id, { id, type: attr(rel, "Type") ?? "", target, external });
    }
    this.relsCache.set(key, out);
    return out;
  }

  /** The part a relationship id of `part` points at (inside the package), or null. */
  target(part: string, id: string | null): string | null {
    if (!id) return null;
    const rel = this.rels(part).get(id);
    return rel && !rel.external ? rel.target : null;
  }

  /** The first relationship of a type (`REL.*`, matched by the end of its URI), or null. */
  relOfType(part: string, type: string): Relationship | null {
    for (const rel of this.rels(part).values()) if (rel.type.endsWith(type)) return rel;
    return null;
  }

  /** Every relationship of a type, in the order the part lists them. */
  relsOfType(part: string, type: string): Relationship[] {
    return [...this.rels(part).values()].filter((rel) => rel.type.endsWith(type));
  }

  /** The main part (`_rels/.rels`'s office document), or `fallback` when the package doesn't say. */
  mainPart(fallback: string): string {
    const rel = this.relOfType("", REL.officeDocument);
    return rel && !rel.external && this.has(rel.target) ? rel.target : fallback;
  }
}

/** A picture's type by its first bytes (PNG, JPEG, GIF, WebP): the only pictures the apps are given. */
export function imageTypeOf(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
  if (riff && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
