import { and, type Executor, eq, schema } from "@agenteschat/db";
import { isLiveArtifactKind, type LiveArtifactKind } from "../artifacts";

const { artifactVersions } = schema;

/**
 * Uploaded files the apps show on a page of their own with a conversation beside them (ADR 0208): a picture, a video
 * or a PDF, told by the type of the version shown. Comments there point at a place in them: an area or a point of
 * the picture, a moment of the video, a page of the PDF.
 */
export type MediaKind = "image" | "video" | "pdf";
export const MEDIA_KINDS: readonly MediaKind[] = ["image", "video", "pdf"];
export const isMediaKind = (kind: string): kind is MediaKind => (MEDIA_KINDS as readonly string[]).includes(kind);

/** What a file's conversation is about: a live file's kind, or what an uploaded file is (`MediaKind`). */
export type TalkKind = LiveArtifactKind | MediaKind;
export const isTalkKind = (kind: string): kind is TalkKind => isLiveArtifactKind(kind) || isMediaKind(kind);

/** The types the apps show (the client's `previewKind`): the same list, so a page never opens on what it can't show. */
const MEDIA_TYPES: Record<string, MediaKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "application/pdf": "pdf",
};

/** A content type as a `MediaKind` (parameters and case ignored), or null for anything else. */
export function mediaOfType(contentType: string | null | undefined): MediaKind | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPES[type] ?? null;
}

/** An uploaded file's `MediaKind`, by the type of its current version; null for any other file or kind. */
export async function mediaKindOf(
  db: Executor,
  file: { id: string; kind: string; currentVersion: number },
): Promise<MediaKind | null> {
  if (file.kind !== "file") return null;
  const [v] = await db
    .select({ contentType: artifactVersions.contentType })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, file.id), eq(artifactVersions.version, file.currentVersion)));
  return mediaOfType(v?.contentType);
}

/** What a file's conversation is about (`TalkKind`), or null for a file that has none. */
export async function talkKindOf(
  db: Executor,
  file: { id: string; kind: string; currentVersion: number },
): Promise<TalkKind | null> {
  if (isLiveArtifactKind(file.kind)) return file.kind;
  return mediaKindOf(db, file);
}
