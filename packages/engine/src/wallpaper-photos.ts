import type { BlobStore } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { readImage } from "./avatars";
import { chatPrefsOf, WALLPAPER_PHOTO_PATH, type Wallpaper } from "./chat-prefs";
import { NotFoundError } from "./errors";

const { organizationMembers } = schema;

const folder = (userId: string) => `wallpapers/${userId}/`;

/**
 * A photo for a conversation's background (`PUT …/me/wallpaper-photo`): JPEG, PNG or WebP up to 2 MB, checked by its
 * bytes and stripped of metadata as a profile photo is (the apps shrink it first), stored in the platform bucket and
 * served only to its owner (`GET /api/app/wallpapers/{userId}/{file}`). Its address goes into a background with
 * `PUT …/me/chat` or `PUT …/channels/{id}/wallpaper`; the photos no background of theirs shows any more are removed
 * here, keeping the one just sent.
 */
export async function setWallpaperPhoto(
  deps: { db: Database; blobs: BlobStore },
  userId: string,
  input: { imageBase64: string; contentType: string },
): Promise<{ url: string }> {
  const { body, type, file } = readImage(input, "wallpaper");
  await deps.blobs.put(`${folder(userId)}${file}`, body, { contentType: type });
  await pruneWallpaperPhotos(deps, userId, file).catch(() => undefined);
  return { url: `/api/app/wallpapers/${encodeURIComponent(userId)}/${file}` };
}

/** The files of a person's backgrounds, in every workspace (their `chatPrefs`). */
async function photosInUse(db: Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ chatPrefs: organizationMembers.chatPrefs })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId));
  const used = new Set<string>();
  const add = (w: Wallpaper | undefined) => {
    const m = w?.kind === "photo" ? WALLPAPER_PHOTO_PATH.exec(w.url) : null;
    if (m?.[2]) used.add(m[2]);
  };
  for (const row of rows) {
    const prefs = chatPrefsOf(row.chatPrefs);
    add(prefs.wallpaper);
    for (const w of Object.values(prefs.wallpapers ?? {})) add(w);
  }
  return used;
}

async function pruneWallpaperPhotos(deps: { db: Database; blobs: BlobStore }, userId: string, keep: string) {
  const used = await photosInUse(deps.db, userId);
  const keys = await deps.blobs.list(folder(userId), 200);
  const unused = keys.filter((key) => {
    const file = key.slice(folder(userId).length);
    return file !== keep && !used.has(file);
  });
  // Every photo no background shows goes; the one just sent stays for the background it is about to be.
  await Promise.all(unused.map((k) => deps.blobs.delete(k)));
}

/** A background's photo for `GET /api/app/wallpapers/{userId}/{file}`: only its owner sees it. */
export async function wallpaperPhotoFile(
  deps: { db: Database; blobs: BlobStore },
  viewerId: string,
  userId: string,
  file: string,
) {
  if (viewerId !== userId || !/^[0-9a-f]{16}\.(jpg|png|webp)$/.test(file)) throw new NotFoundError("Not found");
  const object = await deps.blobs.get(`${folder(userId)}${file}`);
  if (!object) throw new NotFoundError("Not found");
  return object;
}
