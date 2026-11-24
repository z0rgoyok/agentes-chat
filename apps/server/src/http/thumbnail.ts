/** The widths a picture is made small to: a face, a conversation's tile, a lone picture on a high-density screen. */
export const THUMB_WIDTHS = [96, 480, 960] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

/** Formats made small; a GIF keeps its animation as it is, anything else shows as the file it is. */
const THUMB_FORMATS = new Set(["jpeg", "png", "webp"]);
/** Bigger pictures aren't decoded here: their pixels alone would take hundreds of MB. */
const MAX_PIXELS = 50_000_000;
/** At once per process: a photo's pixels take ~4 bytes each while it decodes. */
const MAX_RUNNING = 2;
/** Small pictures kept per process, the least recently asked for dropped first. */
const MAX_KEPT = 300;

const kept = new Map<string, Uint8Array>();
let running = 0;
const queue: (() => void)[] = [];

/**
 * A picture made at most `width` wide and high (never larger than it is), as WebP, its EXIF orientation applied; null
 * for what isn't a JPEG, PNG or WebP this server can decode. `key` names where the bytes are stored (a store and its
 * key, unique per write), never their hash: a workspace's own bucket can change the bytes behind a key, and a hash
 * key would then serve them to another workspace's file with the same hash. The same file asked for again, by anyone
 * who may read it, is made once. Decoding runs off the event loop (`Bun.Image`'s worker thread).
 */
export async function thumbnail(key: string, width: ThumbWidth, read: () => Promise<Uint8Array>) {
  const id = `${key}:${width}`;
  const hit = kept.get(id);
  if (hit) {
    kept.delete(id);
    kept.set(id, hit);
    return hit;
  }
  if (running >= MAX_RUNNING) await new Promise<void>((go) => queue.push(go));
  running++;
  try {
    const image = new Bun.Image(await read(), { maxPixels: MAX_PIXELS });
    if (!THUMB_FORMATS.has((await image.metadata()).format)) return null;
    const small = await image
      .resize(width, width, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .bytes();
    kept.set(id, small);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
    return small;
  } catch {
    // Not a picture after all, a broken one, or too many pixels: the app shows the file's own tile.
    return null;
  } finally {
    running--;
    queue.shift()?.();
  }
}
