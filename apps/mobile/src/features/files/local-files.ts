import type { Message } from "@agenteschat/client";

/**
 * Files of mine on their way up, on the message the conversation shows the moment I send (`meta.localFiles`), before
 * the server has them: the photos, videos and files drawn from the phone while they upload, then the message goes
 * with them and the server's copy takes its place.
 */
export interface LocalFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
  /** A photo's or video's own size in pixels: it shows in its shape. */
  width?: number;
  height?: number;
  /** A video's length in seconds. */
  duration?: number;
}

export const LOCAL_FILES = "localFiles";

export function localFilesOf(meta: Message["meta"] | undefined): LocalFile[] {
  const raw = (meta as Record<string, unknown> | null | undefined)?.[LOCAL_FILES];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is LocalFile =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as LocalFile).uri === "string" &&
      typeof (f as LocalFile).type === "string",
  );
}

/** A photo's or video's width over its height, kept between 1:4 and 4:1 (as a picture's on a message). */
export function localRatio(f: Pick<LocalFile, "width" | "height">): number | undefined {
  if (!f.width || !f.height) return undefined;
  return Math.min(4, Math.max(0.25, f.width / f.height));
}

export const isLocalMedia = (f: Pick<LocalFile, "type">) => f.type.startsWith("image/") || f.type.startsWith("video/");
