/**
 * A picture's width and height from its first bytes (PNG, JPEG, GIF, WebP), so a conversation draws it in its own
 * proportions before it loads (`FileContent.width`/`height`). Null for anything else or a header it can't read.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const at = (i: number) => b[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  const ascii = (i: number, s: string) => [...s].every((c, k) => at(i + k) === c.charCodeAt(0));
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : null;
  // PNG: the signature, then the IHDR chunk.
  if (b.length >= 24 && at(0) === 0x89 && ascii(1, "PNG") && ascii(12, "IHDR")) return ok(be32(16), be32(20));
  // GIF87a / GIF89a: the logical screen.
  if (b.length >= 10 && ascii(0, "GIF8")) return ok(le16(6), le16(8));
  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (b.length >= 30 && ascii(0, "RIFF") && ascii(8, "WEBP")) {
    if (ascii(12, "VP8 ")) return ok(le16(26) & 0x3fff, le16(28) & 0x3fff);
    if (ascii(12, "VP8L")) {
      const v = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return ok((v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1);
    }
    if (ascii(12, "VP8X"))
      return ok((at(24) | (at(25) << 8) | (at(26) << 16)) + 1, (at(27) | (at(28) << 8) | (at(29) << 16)) + 1);
    return null;
  }
  // JPEG: the first start-of-frame marker. Turned by its EXIF orientation it may show the other way round; the box
  // still holds it (`object-fit: contain`).
  if (b.length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (marker === 0xff) {
        i++;
        continue;
      }
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return ok(be16(i + 7), be16(i + 5));
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/**
 * A video's width and height as it shows (MP4 and MOV: its first picture track's header, turned a quarter when the
 * track is), so its tile in a conversation has its shape before it loads. The header may sit after the picture data
 * (a file not written for streaming): the boxes are walked by their sizes, never read through.
 */
export function videoSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (i: number) =>
    String.fromCharCode(bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0);
  if (bytes.length < 16 || (type(4) !== "ftyp" && type(4) !== "moov")) return null;
  /** The boxes between `from` and `to`, each as [start of its contents, its end, its type]. */
  const boxes = function* (from: number, to: number): Generator<[number, number, string]> {
    let i = from;
    while (i + 8 <= to) {
      let size = view.getUint32(i);
      let head = 8;
      if (size === 1) {
        if (i + 16 > to) return;
        size = Number(view.getBigUint64(i + 8));
        head = 16;
      } else if (size === 0) size = to - i;
      if (size < head || i + size > to) return;
      yield [i + head, i + size, type(i + 4)];
      i += size;
    }
  };
  const find = (from: number, to: number, name: string) => {
    for (const box of boxes(from, to)) if (box[2] === name) return box;
    return null;
  };
  const moov = find(0, bytes.length, "moov");
  if (!moov) return null;
  for (const [start, end, name] of boxes(moov[0], moov[1])) {
    if (name !== "trak") continue;
    const tkhd = find(start, end, "tkhd");
    if (!tkhd) continue;
    // Version 1 has 64-bit times, 12 bytes more before the matrix. The size, in 16.16 fixed point, ends the box.
    const matrix = tkhd[0] + 4 + (bytes[tkhd[0]] === 1 ? 32 : 20) + 16;
    if (matrix + 44 > tkhd[1]) continue;
    const width = Math.round(view.getUint32(matrix + 36) / 65536);
    const height = Math.round(view.getUint32(matrix + 40) / 65536);
    // A sound track has no size.
    if (!width || !height || width > 100_000 || height > 100_000) continue;
    // A phone's portrait video is often stored landscape with a quarter turn: its matrix's a and d are zero.
    const turned = view.getInt32(matrix) === 0 && view.getInt32(matrix + 16) === 0;
    return turned ? { width: height, height: width } : { width, height };
  }
  return null;
}

/** A picture's size for a file's card in a message (`ArtifactLink`): only when both are known. */
export const pictureSize = (v: { width?: number | null; height?: number | null }) =>
  v.width && v.height ? { width: v.width, height: v.height } : {};
