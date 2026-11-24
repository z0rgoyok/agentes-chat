import type { LiveSelection, Message, ResolvedMark } from "@agenteschat/client";
import { isPinnedSelection, messageLiveRef, resolvedOf } from "@agenteschat/client";

/*
 * Comments on a picture, a video or a PDF (ADR 0208), as the file's page draws them: each is a message of the file's
 * conversation whose `liveRef.selection` points at a place there (a mark in fractions of the picture, a video's moment,
 * a PDF's page), numbered oldest first as the agents number them, with the version it was made on and its "Resolved".
 */

/** A point or an area, in fractions (0 to 1) of the picture, the frame or the page. */
export type Mark = NonNullable<LiveSelection["mark"]>;

export interface MediaPin {
  message: Message;
  selection: LiveSelection;
  /** 1 for the oldest. */
  n: number;
  resolved: ResolvedMark | null;
  /** Made on a version older than the one shown: drawn faded. */
  old: boolean;
}

/** With the comments open and "Mark" on, a press on the file marks it; else it plays, zooms or scrolls as the viewer does. */
export type MediaTool = "move" | "comment";

/** What every stage shows over its picture: the comments, the one being written, and what the person does. */
export interface StageMarks {
  pins: readonly MediaPin[];
  focusId: string | null;
  showResolved: boolean;
  /** The comment being written: its mark, the number it will have, and the person's own face. */
  draft: { mark: Mark; n: number } | null;
  /** A PDF's comment being written: the page it is on. */
  draftPage?: number | undefined;
  tool: MediaTool;
  onOpenPin: (messageId: string) => void;
}

/** A pin this close to the picture's right edge turns inward, so the edge never cuts it. */
export const pinFlips = (x: number) => x > 0.86;

/** The conversation's comments with a pin on this file, numbered oldest first. */
export function mediaPinsOf(messages: readonly Message[], artifactId: string, version: number): MediaPin[] {
  const out: MediaPin[] = [];
  for (const message of messages) {
    const ref = messageLiveRef(message);
    const selection = ref?.artifactId === artifactId ? ref.selection : undefined;
    if (!selection || !isPinnedSelection(selection)) continue;
    out.push({
      message,
      selection,
      n: out.length + 1,
      resolved: resolvedOf(message.meta),
      old: selection.version !== undefined && selection.version < version,
    });
  }
  return out;
}

/** A drag shorter than this (screen pixels) is a click: a point. */
const AREA_MIN_PX = 8;
const unit = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * A press and its release over the picture's box (screen pixels, the box's own rectangle): a point when it barely
 * moved, an area otherwise, in fractions of the box.
 */
export function markOf(
  from: { x: number; y: number },
  to: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
): Mark | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const fx = unit((from.x - box.left) / box.width);
  const fy = unit((from.y - box.top) / box.height);
  if (Math.hypot(to.x - from.x, to.y - from.y) < AREA_MIN_PX) return { x: round(fx), y: round(fy) };
  const tx = unit((to.x - box.left) / box.width);
  const ty = unit((to.y - box.top) / box.height);
  const x = Math.min(fx, tx);
  const y = Math.min(fy, ty);
  return { x: round(x), y: round(y), w: round(Math.abs(tx - fx)), h: round(Math.abs(ty - fy)) };
}

/** Where a mark's pin stands: an area's top right corner, a point itself. */
export const pinAt = (mark: Mark) =>
  mark.w !== undefined ? { x: mark.x + mark.w, y: mark.y } : { x: mark.x, y: mark.y };

// ── The app's pictures of the place (what the agent sees, the comment's thumbnail) ──────────────────────────────────

/** The picture of what was marked: readable, at most this wide. */
const CROP_MAX = 800;
/** The whole picture with the mark drawn: small, for where it is. */
const FRAME_MAX = 1024;
/** Around a point, this share of the picture's shorter side is shown. */
const POINT_WINDOW = 0.3;
/** An area gets this much room around it (a share of its own size), and never less than this share of the picture. */
const AREA_MARGIN = 0.15;
const AREA_MIN = 0.12;

export interface MarkPictures {
  crop: Blob;
  frame: Blob;
}

/** The part of the picture (natural pixels) a crop shows for a mark. */
export function cropRect(mark: Mark, width: number, height: number) {
  let x0: number;
  let y0: number;
  let x1: number;
  let y1: number;
  if (mark.w !== undefined && mark.h !== undefined) {
    const mx = Math.max(mark.w * AREA_MARGIN, AREA_MIN / 2);
    const my = Math.max(mark.h * AREA_MARGIN, AREA_MIN / 2);
    x0 = (mark.x - mx) * width;
    y0 = (mark.y - my) * height;
    x1 = (mark.x + mark.w + mx) * width;
    y1 = (mark.y + mark.h + my) * height;
  } else {
    const r = (Math.min(width, height) * POINT_WINDOW) / 2;
    x0 = mark.x * width - r;
    y0 = mark.y * height - r;
    x1 = mark.x * width + r;
    y1 = mark.y * height + r;
  }
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width, Math.ceil(x1)) - x),
    h: Math.max(1, Math.min(height, Math.ceil(y1)) - y),
  };
}

const blobOf = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      // A picture from another origin taints the canvas: no pictures, the comment goes without them.
      resolve(null);
    }
  });

/** The mark drawn on the whole picture: white with a dark edge, readable on any picture. */
function drawMark(g: CanvasRenderingContext2D, mark: Mark, w: number, h: number) {
  const line = Math.max(2, Math.round(Math.min(w, h) / 220));
  const stroke = (path: () => void) => {
    g.lineWidth = line + 2;
    g.strokeStyle = "rgba(0,0,0,0.55)";
    path();
    g.stroke();
    g.lineWidth = line;
    g.strokeStyle = "#ffffff";
    path();
    g.stroke();
  };
  if (mark.w !== undefined && mark.h !== undefined) {
    stroke(() => {
      g.beginPath();
      g.rect(mark.x * w, mark.y * h, (mark.w ?? 0) * w, (mark.h ?? 0) * h);
    });
  } else {
    const r = Math.max(10, Math.min(w, h) / 30);
    stroke(() => {
      g.beginPath();
      g.arc(mark.x * w, mark.y * h, r, 0, Math.PI * 2);
    });
  }
}

/**
 * The two pictures a comment carries (ADR 0208), taken from what the person sees: a picture, the video's frame now, a
 * PDF's page drawn. `width` and `height` are the source's own pixels. Null when the browser can't read it.
 */
export async function takeMarkPictures(
  source: CanvasImageSource,
  width: number,
  height: number,
  mark: Mark,
): Promise<MarkPictures | null> {
  if (!width || !height || typeof document === "undefined") return null;
  const r = cropRect(mark, width, height);
  const cropScale = Math.min(1, CROP_MAX / r.w);
  const crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(r.w * cropScale));
  crop.height = Math.max(1, Math.round(r.h * cropScale));
  const frameScale = Math.min(1, FRAME_MAX / Math.max(width, height));
  const frame = document.createElement("canvas");
  frame.width = Math.max(1, Math.round(width * frameScale));
  frame.height = Math.max(1, Math.round(height * frameScale));
  const cg = crop.getContext("2d");
  const fg = frame.getContext("2d");
  if (!cg || !fg) return null;
  try {
    cg.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, crop.width, crop.height);
    fg.drawImage(source, 0, 0, frame.width, frame.height);
  } catch {
    return null;
  }
  drawMark(fg, mark, frame.width, frame.height);
  const [cropBlob, frameBlob] = await Promise.all([blobOf(crop, "image/jpeg", 0.86), blobOf(frame, "image/jpeg", 0.8)]);
  return cropBlob && frameBlob ? { crop: cropBlob, frame: frameBlob } : null;
}
