import {
  isLiveFileKind,
  isMediaKind,
  isPinnedSelection,
  type LiveRef,
  type LiveSelection,
  type ResolvedMark,
  resolvedOf,
  type TalkKind,
} from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { decodeFileList, videoClock } from "../../files/logic";

/**
 * A live file's own conversation on the phone (ADR 0199), the pure part: the line under the file (who took part, an
 * agent at work there or the last message, how many), the quote over the composer and the line over a message about
 * part of the file, and which agent "Ask Atlas" calls. A picture, a video or a PDF has the same conversation (ADR
 * 0208), its comments pinned on the picture. The screens draw it; the tests read it.
 */

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * What a file's conversation is about: a live file's kind, or a picture's, a video's or a PDF's by its type (ADR
 * 0208); null for any other file.
 */
export function talkKindOf(
  file: { kind: string; content?: { kind?: string; contentType?: string } } | null | undefined,
): TalkKind | null {
  if (!file) return null;
  return isLiveFileKind(file.kind) ? file.kind : mediaKindOfArtifact(file);
}

// ── The quote and the line about the file ─────────────────────────────────────────────────────────────────────────

/** A spreadsheet's label is "Sheet!Range": its range and its sheet's name ("C2:D6", "Custos"). */
export function sheetParts(label: string): { range: string; sheet: string } | null {
  const at = label.lastIndexOf("!");
  if (at <= 0 || at === label.length - 1) return null;
  return { sheet: label.slice(0, at), range: label.slice(at + 1) };
}

/** A comment's pin number, as its app wrote it in the label (ADR 0208); empty when the label is no number. */
const pinNumber = (selection: LiveSelection) => (/^\d{1,5}$/.test(selection.label) ? selection.label : "");

/** The mark of a picture's, a video's or a PDF's comment, short: "Area 4", "Point 2". */
function markWhat(t: T, selection: LiveSelection): string {
  const n = pinNumber(selection);
  const area = selection.mark?.w !== undefined;
  return n
    ? t(area ? "live.conversation.what.area" : "live.conversation.what.point", { n })
    : t(area ? "live.conversation.what.anArea" : "live.conversation.what.aPoint");
}

/**
 * The quote over the composer: "About C2:D6 in Costs", "About 1 image on the canvas", "About slide 1", "About the
 * selected passage"; a comment's spot on a canvas: "A comment on a spot of the canvas"; a picture's, a video's or a
 * PDF's comment (ADR 0208): "About point 4 of the image", "About 0:42 of the video".
 */
export function aboutWords(t: T, kind: TalkKind, selection: LiveSelection): string {
  const label = selection.label;
  if (isMediaKind(kind)) {
    if (kind === "video" && selection.time !== undefined) {
      return t("live.conversation.about.videoAt", { time: videoClock(selection.time) });
    }
    if (kind === "pdf" && selection.page !== undefined) {
      return t("live.conversation.about.pdfPage", { page: selection.page });
    }
    const n = pinNumber(selection);
    if (selection.mark?.w !== undefined) return t("live.conversation.about.imageArea", { n });
    if (selection.mark) return t("live.conversation.about.imagePoint", { n });
    return t(`live.conversation.about.${kind}`);
  }
  if (kind === "spreadsheet") {
    const sheet = sheetParts(label);
    if (sheet) return t("live.conversation.about.range", sheet);
  }
  if (kind === "slides") {
    const n = /\d+/.exec(label)?.[0];
    if (n) return t("live.conversation.about.slide", { n });
  }
  if (kind === "canvas") {
    if (selection.point && !selection.shapes?.length) return t("mobile.live.talk.aboutPoint");
    return t("live.conversation.about.canvas", { label });
  }
  if (kind === "document") return t("live.conversation.about.text");
  return t("live.conversation.about.other", { label });
}

/**
 * A message's line about the file: what (bold) and where (quiet): "C2:D6" in "Costs", "Slide 3" in the file, "1
 * image" in "Summer banner"; a picture's, a video's or a PDF's comment (ADR 0208): "Area 1" on the image, "0:42 ·
 * point 2" on the video, "Page 3" with its "area 1"; the file alone when nothing in particular was selected.
 */
export function aboutParts(t: T, ref: LiveRef): { what: string; where: string } {
  const selection = ref.selection;
  const title = ref.title || t("live.conversation.untitled");
  if (isMediaKind(ref.kind)) {
    const where = t(`live.conversation.where.${ref.kind}`);
    if (!selection) return { what: title, where };
    if (ref.kind === "video" && selection.time !== undefined) {
      const time = videoClock(selection.time);
      return { what: selection.mark ? `${time} · ${markWhat(t, selection).toLowerCase()}` : time, where };
    }
    if (ref.kind === "pdf" && selection.page !== undefined) {
      return {
        what: t("live.conversation.what.page", { page: selection.page }),
        where: selection.mark ? markWhat(t, selection).toLowerCase() : where,
      };
    }
    return { what: selection.mark ? markWhat(t, selection) : title, where };
  }
  if (!selection) return { what: title, where: t(`live.kinds.${ref.kind}`) };
  const sheet = ref.kind === "spreadsheet" ? sheetParts(selection.label) : null;
  if (sheet) return { what: sheet.range, where: sheet.sheet };
  return { what: selection.label, where: title };
}

/** Two selections are the same part of the file. */
export const selectionKey = (s: LiveSelection | null | undefined) =>
  s
    ? JSON.stringify([s.label, s.sheet, s.range, s.slide, s.shapes, s.point, s.text, s.block, s.mark, s.time, s.page])
    : "";

// ── The line under the file ───────────────────────────────────────────────────────────────────────────────────────

/** What the line under a file says (B · "Linha embaixo"). */
export type TalkLine =
  /** An agent at work in the conversation now: its sentence in its color, with the pixel orbit. */
  | { state: "working"; agentId: string; text: string; count: number }
  /** The last message, "Atlas: Done, summed by status.", and how many. */
  | { state: "last"; text: string; count: number }
  /** Nobody wrote yet: "Talk about this canvas". */
  | { state: "start"; count: 0 };

export interface TalkLineInput {
  /** Replies in the conversation (`Artifact.conversation.count`). */
  count: number;
  /** The working sentence and its agent, while one works there. */
  working: { agentId: string; text: string } | null;
  /** The last reply: who wrote it and its words, one line. */
  last: { name: string; text: string } | null;
}

/** The line's state: an agent at work wins, then the last message; nothing written yet: the invitation. */
export function talkLine({ count, working, last }: TalkLineInput): TalkLine {
  const n = Math.max(0, Math.floor(count));
  if (working?.text) return { state: "working", agentId: working.agentId, text: working.text, count: n };
  if (last && (last.text || last.name)) return { state: "last", text: lastWords(last.name, last.text), count: n };
  if (n > 0) return { state: "last", text: "", count: n };
  return { state: "start", count: 0 };
}

/** "Atlas: Done, summed by status.": the name, then the words on one line, no Markdown marks. */
export function lastWords(name: string, text: string): string {
  const words = oneLine(text);
  if (!name) return words;
  return words ? `${name}: ${words}` : name;
}

/** Words on one line: Markdown's marks out, spaces collapsed. */
export function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── The file's agent ──────────────────────────────────────────────────────────────────────────────────────────────

type Who = { type: string; id: string | null };

/**
 * The file's agent (ADR 0199), whom "Ask Atlas" calls: the one that made it, else the last agent that spoke in
 * its conversation, else the last agent among those who took part, else the workspace's right hand, else the first
 * agent this person may ask. Only agents `askable` says this person may ask; null: none.
 */
export function fileAgentId(input: {
  createdBy: Who;
  /** The conversation's messages' authors, oldest first. */
  spoke: readonly Who[];
  participants: readonly Who[];
  rightHandId: string | null | undefined;
  agentIds: readonly string[];
  askable: (id: string) => boolean;
}): string | null {
  const ok = (w: Who | undefined): w is { type: string; id: string } =>
    w?.type === "agent" && typeof w.id === "string" && input.askable(w.id);
  if (ok(input.createdBy)) return input.createdBy.id;
  const spoke = [...input.spoke].reverse().find(ok);
  if (spoke) return spoke.id;
  const took = [...input.participants].reverse().find(ok);
  if (took) return took.id;
  if (input.rightHandId && input.askable(input.rightHandId)) return input.rightHandId;
  return input.agentIds.find((id) => input.askable(id)) ?? null;
}

/** What "Ask Atlas" writes in the composer: the agent's handle, ready for the person's words. */
export const askText = (handle: string, words = "") => (words ? `@${handle} ${words}` : `@${handle} `);

// ── Comment pins on a canvas ──────────────────────────────────────────────────────────────────────────────────────

/** A comment pinned on a canvas: a message of its conversation whose `liveRef` names a point. */
export interface TalkPin {
  messageId: string;
  author: Who;
  /** Its number, in the conversation's order (1 for the first pin). */
  n: number;
  at: { x: number; y: number };
}

/**
 * The pins a canvas draws (ADR 0199 §3): the conversation's messages about this file with a point, numbered in the
 * order they were written.
 */
export function talkPins(
  fileId: string,
  messages: readonly { id: string; author: Who; liveRef?: LiveRef | null }[],
): TalkPin[] {
  const pins: TalkPin[] = [];
  for (const m of messages) {
    const ref = m.liveRef;
    const at = ref?.artifactId === fileId ? ref.selection?.point : undefined;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    pins.push({ messageId: m.id, author: m.author, n: pins.length + 1, at: { x: at.x, y: at.y } });
  }
  return pins;
}

// ── Comment pins on a picture, a video or a PDF ──────────────────────────────────────────────────────────────────

/** A point or an area, in fractions (0 to 1) of the picture, the video's frame or the PDF's page (ADR 0208). */
export type Mark = NonNullable<LiveSelection["mark"]>;

/** A comment with a pin on a picture, a video or a PDF: a message of its conversation that points at a place there. */
export interface MediaPin {
  messageId: string;
  author: Who;
  /** Its number, oldest first (1 for the first), as the web and the agents number them. */
  n: number;
  selection: LiveSelection;
  /** Resolved: its pin leaves the picture, its message stays. */
  resolved: ResolvedMark | null;
  /** Made on a version older than the one shown: drawn faded. */
  old: boolean;
}

/**
 * The comments with a pin on this file (ADR 0208): the conversation's messages about it with a mark, a moment or a
 * page, numbered oldest first (resolved ones keep their number). `version`: the file's version on screen.
 */
export function mediaPins(
  fileId: string,
  messages: readonly { id: string; author: Who; liveRef?: LiveRef | null; meta?: Record<string, unknown> | null }[],
  version: number,
): MediaPin[] {
  const pins: MediaPin[] = [];
  for (const m of messages) {
    const ref = m.liveRef;
    const selection = ref?.artifactId === fileId ? ref.selection : undefined;
    if (!selection || !isPinnedSelection(selection)) continue;
    pins.push({
      messageId: m.id,
      author: m.author,
      n: pins.length + 1,
      selection,
      resolved: resolvedOf(m.meta),
      old: selection.version !== undefined && selection.version < version,
    });
  }
  return pins;
}

/**
 * The conversation's messages with mine still on their way after them, each once: a local copy whose server copy is
 * already in (the same `clientId`, or the same id) is left out.
 */
export function withSending<M extends { id: string; clientId?: string | null }>(
  messages: readonly M[],
  sending: readonly M[],
): readonly M[] {
  if (sending.length === 0) return messages;
  const ids = new Set(messages.map((m) => m.id));
  const echoed = new Set(messages.flatMap((m) => (m.clientId ? [m.clientId] : [])));
  return [...messages, ...sending.filter((m) => !ids.has(m.id) && !(m.clientId && echoed.has(m.clientId)))];
}

/** The pins drawn on a picture: those with a mark, open (a resolved one is off the picture). */
export const picturePins = (pins: readonly MediaPin[]) => pins.filter((p) => p.selection.mark && !p.resolved);

/** Where a mark's pin stands: an area's top right corner, a point itself. */
export const pinAnchor = (mark: Mark) =>
  mark.w !== undefined ? { x: mark.x + mark.w, y: mark.y } : { x: mark.x, y: mark.y };

/** A pin on the picture, on screen: its height and the most width a tap reaches it by (face, number, padding). */
export const MEDIA_PIN_H = 24;
export const MEDIA_PIN_W = 48;

/**
 * The pin under a tap on the picture, the newest on top; null for none. `tap`: where, in fractions of the picture, and
 * the picture's size as it shows now (its zoom included), since a pin keeps the screen's own size at any zoom, its
 * corner on its spot.
 */
export function pinUnder(
  pins: readonly MediaPin[],
  tap: { x: number; y: number; width: number; height: number },
): MediaPin | null {
  for (let i = pins.length - 1; i >= 0; i--) {
    const pin = pins[i];
    const mark = pin?.selection.mark;
    if (!pin || !mark) continue;
    const spot = pinAnchor(mark);
    const dx = (tap.x - spot.x) * tap.width;
    const dy = (tap.y - spot.y) * tap.height;
    if (dx >= -6 && dx <= MEDIA_PIN_W + 6 && dy >= -MEDIA_PIN_H - 10 && dy <= 10) return pin;
  }
  return null;
}

const fraction = (v: number) => Math.round(v * 10_000) / 10_000;

/** A tap that marks, as a comment's point in fractions of the picture; null off it (the black around it). */
export function pointMark(at: { x: number; y: number }): Mark | null {
  if (!(at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1)) return null;
  return { x: fraction(at.x), y: fraction(at.y) };
}

/**
 * The quote a new comment opens its conversation with (ADR 0208): the next pin's number, where it points (a point on
 * the picture, a video's moment to the tenth of a second with the point on its frame, a PDF's page from 1 with the
 * point on it) and the version on screen.
 */
export function commentSelection(
  pins: readonly MediaPin[],
  where: { mark?: Mark; time?: number; page?: number },
  version: number,
): LiveSelection {
  return {
    label: String(pins.length + 1),
    ...(where.mark ? { mark: where.mark } : {}),
    ...(where.time !== undefined ? { time: Math.round(Math.max(0, where.time) * 10) / 10 } : {}),
    ...(where.page !== undefined ? { page: Math.max(1, Math.round(where.page)) } : {}),
    version,
  };
}

/** The draft's pin key: it stands for no message yet. */
export const DRAFT_PIN = "draft";

/**
 * The comment being written, as a pin on the file (ADR 0208): the person's face and the number it will take, where
 * they tapped, while the quote over the composer is about a point of this file. Null when the quote is about no point
 * of it (or nothing is quoted).
 */
export function draftPin(about: LiveRef | null | undefined, fileId: string, me: Who | null): MediaPin | null {
  const selection = about?.artifactId === fileId ? about.selection : undefined;
  if (!me || !selection?.mark) return null;
  const n = Number(pinNumber(selection));
  return { messageId: DRAFT_PIN, author: me, n: n > 0 ? n : 0, selection, resolved: null, old: false };
}

/** A PDF page's pins (`page` from 1): its open comments with a mark there. */
export const pagePins = (pins: readonly MediaPin[], page: number) =>
  pins.filter((p) => p.selection.page === page && p.selection.mark && !p.resolved);

// ── Where the conversation opens ─────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the screen under the conversation is this file's own (the stack's route before the conversation's): then
 * going back to it is going back, never a second copy pushed over the conversation. The picture viewer counts when
 * the page it is on is this file (`at`, which it keeps as the person turns the pages).
 */
export function fileUnder(
  routes: readonly { name: string; params?: object | undefined }[] | undefined,
  fileId: string,
): boolean {
  if (!routes || routes.length < 2) return false;
  const under = routes[routes.length - 2];
  if (!under) return false;
  if (under.name === VIEWER_ROUTE) {
    const params = under.params as { files?: string | string[]; at?: string } | undefined;
    const files = decodeFileList(params?.files);
    return files[Math.max(0, Number(params?.at) || 0)]?.id === fileId;
  }
  if (!LIVE_ROUTE_NAMES.has(under.name)) return false;
  return (under.params as { id?: unknown } | undefined)?.id === fileId;
}

/** The picture viewer's route (`/images`). */
const VIEWER_ROUTE = "images";

const LIVE_ROUTE_NAMES: ReadonlySet<string> = new Set([
  "spreadsheet/[id]",
  "slides/[id]",
  "canvas/[id]",
  "document/[id]",
  // A PDF's screen (ADR 0208); pictures and videos open in the viewer (`VIEWER_ROUTE`).
  "file/[id]",
]);
