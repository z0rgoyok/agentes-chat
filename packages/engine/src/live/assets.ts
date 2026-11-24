import { createHash } from "node:crypto";
import { and, eq, schema } from "@agenteschat/db";
import {
  type ArtifactActor,
  type ArtifactDeps,
  liveFileAccess,
  mediaFileOf,
  requireLiveFile,
  storedFileOfArtifact,
  writeLiveAssetBlob,
} from "../artifacts";
import { recordAudit } from "../audit";
import { UUID } from "../authority";
import { sniffImage, sniffModelImage } from "../avatars";
import { NotFoundError, ValidationError } from "../errors";
import { imageSize } from "../image-size";
import { looksLikeSvg, SVG_TYPE, sanitizeSvg } from "./svg";

/**
 * Pictures that belong to a live file (ADR 0196 §8): on a canvas or a slide, dropped by a person, made by the image
 * job, copied from the Drive or from another live file, drawn by an agent as an SVG or downloaded from the web. Each
 * is stored through the workspace's storage like a version's bytes (`writeLiveAssetBlob`: counted in its storage,
 * refused past its limits), served only to whoever reads the file and purged with it. Only pictures, told by their
 * bytes, never by the type a client declared; an SVG is stored as the sanitizer rebuilt it (`svg.ts`), never as sent.
 */

const { liveAssets } = schema;

/**
 * `drawn`: an SVG an agent wrote; `web`: downloaded from a public address (`origin` says which); `mark`: the app's
 * picture of the place a comment points at in a picture, a video or a PDF (ADR 0208).
 */
export type AssetSource = "upload" | "generated" | "copied" | "imported" | "drawn" | "web" | "mark";

/** Where a picture from the web came from: its address, and the credit an agent gave it (author, license, site). */
export interface LiveAssetOrigin {
  url: string;
  credit?: string;
}

/** A picture as the apps and tools see it. */
export interface LiveAsset {
  id: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** A picture from the web: where it came from. */
  origin?: LiveAssetOrigin | null;
}

/** The largest picture a live file takes. */
export const LIVE_ASSET_MB = 25;
export const LIVE_ASSET_BYTES = LIVE_ASSET_MB * 1024 * 1024;

const sha256Hex = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

const viewOf = (row: typeof liveAssets.$inferSelect): LiveAsset => ({
  id: row.id,
  contentType: row.contentType,
  size: row.size,
  width: row.width,
  height: row.height,
  origin: row.origin ?? null,
});

const actorRef = (actor: ArtifactActor) =>
  actor.type === "person"
    ? { type: "person" as const, id: actor.userId }
    : { type: "agent" as const, id: actor.agentId, runId: actor.runId ?? null };

/**
 * Stores a picture in a live file the actor may change (`requireLiveFile`). A picture the file already holds (same
 * bytes) is that one again, stored once.
 */
export async function putAsset(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  input: {
    bytes: Uint8Array;
    contentType: string;
    source: AssetSource;
    runId?: string | null;
    origin?: LiveAssetOrigin | null;
  },
): Promise<LiveAsset> {
  await requireLiveFile(deps, actor, orgId, fileId, { write: true });
  return storeAsset(deps, actor, orgId, fileId, input);
}

/** The largest picture of a comment's place: the app sends a small JPEG or PNG. */
export const MARK_PICTURE_BYTES = 2 * 1024 * 1024;

/**
 * Stores the app's picture of the place a comment points at (ADR 0208): what was marked, or the whole picture,
 * frame or page with the mark drawn. Whoever reads the picture, the video or the PDF comments on it, so reading it is
 * enough; only a raster picture, small.
 */
export async function putMarkPicture(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  bytes: Uint8Array,
): Promise<LiveAsset> {
  if (!(await mediaFileOf(deps, actor, orgId, fileId))) {
    throw new NotFoundError("Artifact not found", "artifact.not_found");
  }
  // PNG, JPEG or WebP only (`sniffImage`), as said: a GIF is no picture of a place.
  if (bytes.byteLength > MARK_PICTURE_BYTES || !sniffImage(bytes)) {
    throw new ValidationError("A comment's picture is a PNG, JPEG or WebP of at most 2 MB", "live.asset_type");
  }
  return storeAsset(deps, actor, orgId, fileId, { bytes, source: "mark" });
}

/** `putAsset` past its access check (the caller made it). */
async function storeAsset(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  input: { bytes: Uint8Array; source: AssetSource; runId?: string | null; origin?: LiveAssetOrigin | null },
): Promise<LiveAsset> {
  let { bytes } = input;
  if (bytes.byteLength > LIVE_ASSET_BYTES) {
    throw new ValidationError(`The picture is too large (max ${LIVE_ASSET_MB} MB)`, "live.asset_too_large", {
      max: LIVE_ASSET_MB,
    });
  }
  // Told by its bytes (PNG, JPEG, WebP or GIF), never by what the client said: nothing else is ever served from here.
  // An SVG is rebuilt by the sanitizer and stored as it came out, with the natural size it wrote.
  let contentType: string | null = sniffModelImage(bytes);
  let size = contentType ? imageSize(bytes) : null;
  if (!contentType && looksLikeSvg(bytes)) {
    const clean = sanitizeSvg(bytes);
    bytes = clean.bytes;
    contentType = SVG_TYPE;
    size = { width: clean.width, height: clean.height };
  }
  if (!contentType) {
    throw new ValidationError("Only pictures go in a live file: PNG, JPEG, WebP, GIF or SVG", "live.asset_type");
  }
  const sha256 = sha256Hex(bytes);
  const [same] = await deps.db
    .select()
    .from(liveAssets)
    .where(
      and(eq(liveAssets.artifactId, fileId), eq(liveAssets.sha256, sha256), eq(liveAssets.size, bytes.byteLength)),
    );
  if (same) return viewOf(same);
  const id = Bun.randomUUIDv7();
  const blob = await writeLiveAssetBlob(deps, orgId, fileId, id, bytes, contentType);
  const origin = input.origin ? cleanOrigin(input.origin) : null;
  const by = actorRef(actor);
  const asked = input.runId ?? (by.type === "agent" ? by.runId : null);
  const runId = asked && UUID.test(asked) ? asked : null;
  try {
    const [row] = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .insert(liveAssets)
        .values({
          id,
          orgId,
          artifactId: fileId,
          storageConfigId: blob.storageConfigId,
          blobKey: blob.key,
          contentType,
          size: bytes.byteLength,
          sha256,
          width: size?.width ?? null,
          height: size?.height ?? null,
          source: input.source,
          origin,
          createdByType: by.type,
          createdById: by.id,
          runId,
        })
        .returning();
      await recordAudit(tx, {
        orgId,
        actor: { type: by.type, id: by.id },
        action: "artifact.asset_added",
        target: { type: "artifact", id: fileId },
        details: {
          asset: id,
          source: input.source,
          contentType,
          size: bytes.byteLength,
          ...(origin ? { url: origin.url } : {}),
        },
        runId,
      });
      return rows;
    });
    if (!row) throw new Error("live asset insert returned nothing");
    return viewOf(row);
  } catch (error) {
    // The row never landed: its bytes go too, or they'd count in the storage with nothing pointing at them.
    const store = await deps.blobs.forConfig(orgId, blob.storageConfigId).catch(() => null);
    await store?.delete(blob.key).catch(() => undefined);
    throw error;
  }
}

/** An origin as stored: an https address and a short credit, both cut to a sane length. */
function cleanOrigin(origin: LiveAssetOrigin): LiveAssetOrigin {
  const credit = origin.credit?.replace(/\s+/g, " ").trim().slice(0, 300);
  return { url: origin.url.slice(0, 2048), ...(credit ? { credit } : {}) };
}

/**
 * Copies a picture into a live file the actor may change: a Drive file (an uploaded picture) or another live file's
 * picture, each under the actor's own check that they read where it comes from (not found otherwise).
 */
export async function copyAssetFrom(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  from: { artifactId: string; version?: number } | { fileId: string; assetId: string },
): Promise<LiveAsset> {
  await requireLiveFile(deps, actor, orgId, fileId, { write: true });
  if ("assetId" in from) {
    const source = await readAsset(deps, actor, orgId, from.fileId, from.assetId);
    if (!source) throw new NotFoundError("Picture not found", "artifact.not_found");
    if (from.fileId === fileId) return viewOf(source.row);
    return storeAsset(deps, actor, orgId, fileId, { bytes: source.bytes, source: "copied", origin: source.row.origin });
  }
  const file = await storedFileOfArtifact(deps, actor, orgId, from.artifactId, from.version);
  if (file.size > LIVE_ASSET_BYTES) {
    throw new ValidationError(`The picture is too large (max ${LIVE_ASSET_MB} MB)`, "live.asset_too_large", {
      max: LIVE_ASSET_MB,
    });
  }
  const store = await deps.blobs.forConfig(orgId, file.storageConfigId);
  const object = await store.get(file.blobKey);
  if (!object) throw new NotFoundError("File not found", "artifact.not_found");
  return storeAsset(deps, actor, orgId, fileId, { bytes: object.body, source: "copied" });
}

/** A picture from the Drive as its bytes say it is: PNG, JPEG, WebP or GIF, and its size when the bytes tell it. */
export interface PictureFile {
  bytes: Uint8Array;
  contentType: string;
  width: number | null;
  height: number | null;
}

/**
 * A Drive file's picture (an uploaded image, a picture posted in a conversation), under the actor's own check that
 * they read it (not found otherwise); refused when it isn't a picture by its bytes or is over `LIVE_ASSET_MB`.
 */
export async function readPictureFile(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  artifactId: string,
): Promise<PictureFile> {
  const file = await storedFileOfArtifact(deps, actor, orgId, artifactId);
  if (file.size > LIVE_ASSET_BYTES) {
    throw new ValidationError(`The picture is too large (max ${LIVE_ASSET_MB} MB)`, "live.asset_too_large", {
      max: LIVE_ASSET_MB,
    });
  }
  const store = await deps.blobs.forConfig(orgId, file.storageConfigId);
  const object = await store.get(file.blobKey);
  if (!object) throw new NotFoundError("File not found", "artifact.not_found");
  const contentType = sniffModelImage(object.body);
  if (!contentType) throw new ValidationError("This file isn't a picture: PNG, JPEG, WebP or GIF", "live.asset_type");
  const size = imageSize(object.body);
  return { bytes: object.body, contentType, width: size?.width ?? null, height: size?.height ?? null };
}

/** A picture's row and bytes, for whoever reads its file (null otherwise, as for none). */
async function readAsset(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, fileId: string, assetId: string) {
  if (!UUID.test(assetId)) return null;
  if (!(await liveFileAccess(deps, actor, orgId, fileId))) return null;
  const [row] = await deps.db
    .select()
    .from(liveAssets)
    .where(and(eq(liveAssets.artifactId, fileId), eq(liveAssets.orgId, orgId), eq(liveAssets.id, assetId)));
  if (!row) return null;
  const store = await deps.blobs.forConfig(orgId, row.storageConfigId).catch(() => null);
  const object = await store?.get(row.blobKey).catch(() => null);
  return object ? { row, bytes: object.body } : null;
}

/** A picture to serve: its bytes (or a stream of them where the store streams) with what it is. */
export type LiveAssetFile = { contentType: string; size: number; sha256: string } & (
  | { bytes: Uint8Array }
  | { stream: ReadableStream<Uint8Array> }
);

/** A picture of a live file the actor reads (in the trash too), or null: no such picture, or not theirs to see. */
export async function getAsset(
  deps: ArtifactDeps,
  actor: ArtifactActor,
  orgId: string,
  fileId: string,
  assetId: string,
): Promise<LiveAssetFile | null> {
  if (!UUID.test(assetId)) return null;
  // A live file's pictures, or the pictures of the comments on a picture, a video or a PDF (ADR 0208).
  if (!(await liveFileAccess(deps, actor, orgId, fileId)) && !(await mediaFileOf(deps, actor, orgId, fileId))) {
    return null;
  }
  const [row] = await deps.db
    .select()
    .from(liveAssets)
    .where(and(eq(liveAssets.artifactId, fileId), eq(liveAssets.orgId, orgId), eq(liveAssets.id, assetId)));
  if (!row) return null;
  const store = await deps.blobs.forConfig(orgId, row.storageConfigId).catch(() => null);
  if (!store) return null;
  const facts = { contentType: row.contentType, size: row.size, sha256: row.sha256 };
  const stream = await store.stream?.(row.blobKey).catch(() => null);
  if (stream) return { ...facts, stream };
  const object = await store.get(row.blobKey).catch(() => null);
  return object ? { ...facts, bytes: object.body } : null;
}

/** A live file's pictures (newest first), for whoever reads it. */
export async function listAssets(deps: ArtifactDeps, actor: ArtifactActor, orgId: string, fileId: string) {
  if (!(await liveFileAccess(deps, actor, orgId, fileId))) {
    throw new NotFoundError("Artifact not found", "artifact.not_found");
  }
  const rows = await deps.db
    .select()
    .from(liveAssets)
    .where(and(eq(liveAssets.artifactId, fileId), eq(liveAssets.orgId, orgId)));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(viewOf);
}
