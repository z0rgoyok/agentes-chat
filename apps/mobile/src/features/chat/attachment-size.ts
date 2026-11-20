/** How the thumbnails waiting in the field are sized (`AttachmentStrip`): pure, for the strip and its tests. */

/** Every thumbnail is this tall; a photo or video is as wide as its shape says, within `MIN_W`–`MAX_W`. */
export const TILE_H = 72;
const MIN_W = 54;
const MAX_W = 128;
/** A file: its type's tile, its name and its size, on a card wider than a photo. */
export const FILE_W = 176;

/** A thumbnail's width: a photo's or video's own shape at the row's height, square when unknown; a file's card. */
export function tileWidth(f: { type: string; width?: number | undefined; height?: number | undefined }): number {
  if (!f.type.startsWith("image/") && !f.type.startsWith("video/")) return FILE_W;
  if (!f.width || !f.height) return TILE_H;
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, (TILE_H * f.width) / f.height)));
}
