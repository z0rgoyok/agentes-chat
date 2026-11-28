import type { LiveKind } from "@agenteschat/live";
import type { PeerKind } from "@agenteschat/live/awareness";
import type { DeckData, WorkbookData } from "@agenteschat/live/office";
import type { LiveMode } from "@agenteschat/live/protocol";

/**
 * What the apps share about live files (ADR 0196): spreadsheets, presentations and canvases people and agents edit
 * together. The document itself is `@agenteschat/live`'s; these are the shapes of the routes around it
 * (`apps/server/src/routes/app/live.ts`) and of the apps' own connection to it.
 */

export type { LiveKind, LiveMode };

/**
 * Where a live file's connection stands: `connecting` before anything came, `syncing` once the document is here but
 * the socket hasn't caught up yet, `live` in step with everyone, `offline` while the connection is down (changes are
 * kept and go when it comes back), `closed` for good (no access, the file gone, or the screen left).
 *
 * Named `LiveFileStatus` because the package root already exports `LiveStatus` (a run's status, `realtime/streams`).
 */
export type LiveFileStatus = "connecting" | "syncing" | "live" | "offline" | "closed";

/**
 * Why a live file closed (`status` "closed": `forbidden`, `not_found`, `unauthorized`, `invalid`), or what the server
 * refused in it (`read_only`, `too_large`, `rate`): codes the apps word through i18n.
 */
export type LiveRoomError = "forbidden" | "not_found" | "unauthorized" | "invalid" | "read_only" | "too_large" | "rate";

/** `GET …/artifacts/{id}/live`: the document as it stands, to open it with (the socket catches up from it). */
export interface LiveFileState {
  /** Base64 of the document as one Yjs update. */
  state: string;
  /** The newest change it holds. */
  seq: number;
  /** `view`: read-only now (in the trash, its workspace being deleted). */
  mode: LiveMode;
  kind: LiveKind;
}

/** "Novo" › Planilha, Apresentação, Quadro: in the Drive, or in a conversation (and its thread) the person is in. */
export interface CreateLiveFileInput {
  kind: LiveKind;
  title: string;
  channelId?: string | null;
  threadId?: string | null;
}

/** Someone in a live file now, as the Drive's and messages' cards show them (hidden people never come). */
export interface LivePresent {
  kind: PeerKind;
  id: string;
  mode: "viewing" | "editing";
}

/** `GET …/live/presence?ids=`: who is in each file, by file id (files the person can't read are left out). */
export type PresenceSummary = Record<string, LivePresent[]>;

/** Channel event: who is in one of the conversation's live files changed (ids only: the cards ask again). */
export interface LivePresenceEvent {
  type: "live.presence";
  channelId?: string;
  artifactId: string;
}

/** A picture that belongs to a live file (ADR 0196 §8): its type is read from its bytes. */
export interface LiveAsset {
  id: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  /** A font (ADR 0220 §2): what its own file says it is; null or missing for a picture. */
  font?: LiveAssetFont | null;
}

/** A font file's family, style and weight, as the file itself names them. */
export interface LiveAssetFont {
  family: string;
  style: string;
  weight: number;
  italic: boolean;
}

/** One of a live file's own fonts (brought from the Drive); the file names it `asset:<id>`. */
export interface LiveFileFont extends LiveAssetFont {
  id: string;
}

/** Where a copied picture comes from: a Drive file the person reads (one of its versions), or another live file's. */
export type LiveAssetSource = { artifactId: string; version?: number } | { fileId: string; assetId: string };

/** A version saved or restored (ADR 0196 §7); `null`: nothing changed since the last one, so none was written. */
export interface LiveVersionSaved {
  version: number | null;
}

/** The shapes a generated picture can take (ADR 0197). */
export type ImageAspect = "1:1" | "3:2" | "2:3" | "4:3" | "3:4" | "16:9" | "9:16";
export const IMAGE_ASPECTS: readonly ImageAspect[] = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"];
/** At most this many pictures a request (ADR 0197). */
export const MAX_IMAGES_PER_REQUEST = 4;

/** An image model the workspace can use now (`GET …/images/models`), the default first. */
export interface ImageModelOption {
  id: string;
  label: string;
  /** Who makes it ("gemini", "openai", "openrouter", a workspace's own endpoint). */
  provider: string;
  aspects: ImageAspect[];
  /** Pictures one request may ask for. */
  maxCount: number;
  /** It takes pictures to start from (variations, edits). */
  refs: boolean;
  /** What a picture costs, in USD: only for whoever may see usage. */
  pricePerImage?: number;
}

export type ImageRequestStatus = "queued" | "running" | "done" | "failed";
/** Why pictures weren't made (each placeholder says so, with Try again). */
export type ImageFailure = "no_key" | "budget" | "limit" | "blocked" | "provider" | "too_many";

/** A request for pictures: its placeholders are already on the canvas, the pictures come in their place. */
export interface ImageRequestResult {
  requestId: string;
  status: ImageRequestStatus;
  /** The placeholders' shape ids (the pictures take the same ids). */
  shapeIds: string[];
  /** The frame they were placed in, titled with the prompt. */
  frameId: string | null;
}

/**
 * An uploaded Office file as the server read it (ADR 0198): a workbook (`.xlsx`, `.xls`, `.ods`, `.csv`, `.tsv`) the
 * spreadsheet view draws read-only, a deck (`.pptx`) the slides view draws (its pictures by `media[name].url`), or a
 * Word document as clean HTML, drawn only in an isolated frame.
 */
export type OfficePreview =
  | { kind: "workbook"; workbook: WorkbookData }
  | { kind: "deck"; deck: DeckData }
  | { kind: "document"; html: string };

/**
 * What a person had selected in a file when they wrote, as they see it ("Planilha 1!B2:E9", "slide 3", "2 imagens"):
 * the quote bar of the file's conversation, sent as the message's `liveRef` (ADR 0199).
 */
export interface LiveSelection {
  label: string;
  /** The sheet's id. */
  sheet?: string;
  /** The range in A1 ("B2:E9"). */
  range?: string;
  /** The slide's id. */
  slide?: string;
  /** Canvas shape ids. */
  shapes?: string[];
  /** A comment pinned on a canvas, in its world units. */
  point?: { x: number; y: number };
  /** A document's quoted words (at most 200 characters). */
  text?: string;
  /** A document's block id. */
  block?: string;
  /** A picture's, a video frame's or a PDF page's point (no `w`, `h`) or area, in fractions (ADR 0208). */
  mark?: { x: number; y: number; w?: number; h?: number };
  /** A video's moment, in seconds. */
  time?: number;
  /** A PDF's page, from 1. */
  page?: number;
  /** The file's version the mark was made on. */
  version?: number;
  /** The app's picture of what was marked (a file's picture, `…/marks`). */
  crop?: string;
  /** The app's picture of the whole picture, frame or page with the mark drawn. */
  frame?: string;
}

/** Uploaded files with a page and a conversation of their own (ADR 0208): a picture, a video, a PDF. */
export type FileMediaKind = "image" | "video" | "pdf";
/** What a file's conversation is about: a live file's kind, or a `FileMediaKind`. */
export type TalkKind = LiveKind | FileMediaKind;

const MEDIA_KIND_NAMES: readonly string[] = ["image", "video", "pdf"] satisfies readonly FileMediaKind[];
export const isMediaKind = (kind: unknown): kind is FileMediaKind =>
  typeof kind === "string" && MEDIA_KIND_NAMES.includes(kind);

/** A comment that points at a place in a picture, a video or a PDF: it has a numbered pin there (ADR 0208). */
export const isPinnedSelection = (s: LiveSelection | undefined | null): boolean =>
  Boolean(s && (s.mark || s.time !== undefined || s.page !== undefined));

/** Who resolved a comment, and when (`meta.resolved`, ADR 0208). */
export interface ResolvedMark {
  by: { type: "person" | "agent"; id: string };
  at: string;
}

/** `meta.resolved` of a comment, when it reads right; null: open. */
export function resolvedOf(meta: Record<string, unknown> | null | undefined): ResolvedMark | null {
  const r = meta?.resolved;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  const by = o.by as Record<string, unknown> | undefined;
  if (typeof o.at !== "string" || !by || (by.type !== "person" && by.type !== "agent") || typeof by.id !== "string") {
    return null;
  }
  return { by: { type: by.type, id: by.id }, at: o.at };
}

/** "Perguntar a um agente" from inside a file (ADR 0196 §6). */
export interface AskAgentInput {
  agentId: string;
  text: string;
  selection?: LiveSelection;
}

/** The message that went: in the file's conversation, or a DM with the agent when the file lives in the Drive. */
export interface AskAgentResult {
  id: string;
  channelId: string;
  threadId: string | null;
}

/**
 * `message.liveRef` (from `meta.liveRef`, ADR 0199): the file a message is about and what its writer had selected in
 * it. The server fills `kind` and `title`; a message sends only `LiveRefInput`.
 */
export interface LiveRef {
  artifactId: string;
  kind: TalkKind;
  title: string;
  selection?: LiveSelection;
}

/** What a message in a file's conversation sends of its `liveRef`: the server adds the file's kind and title. */
export interface LiveRefInput {
  artifactId: string;
  selection?: LiveSelection;
}

/**
 * `meta.fileConversation`: the root of a live file's conversation (ADR 0199). It stands for the file and is never
 * drawn: the file is right there. `kind` names the panel ("Canvas conversation").
 */
export interface FileConversationRoot {
  artifactId: string;
  kind: TalkKind;
  title: string;
}

/** The live kinds, as the client knows them without loading the package's code (types only come from it here). */
const LIVE_KIND_NAMES: readonly string[] = [
  "spreadsheet",
  "slides",
  "canvas",
  "document",
] satisfies readonly LiveKind[];

/** Whether an artifact kind is a live file's (`isLiveKind` of `@agenteschat/live`, without importing its code). */
export const isLiveFileKind = (kind: unknown): kind is LiveKind =>
  typeof kind === "string" && LIVE_KIND_NAMES.includes(kind);

/** Whether a conversation's kind is one the apps know (`TalkKind`). */
export const isTalkKind = (kind: unknown): kind is TalkKind => isLiveFileKind(kind) || isMediaKind(kind);

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

/** The selection a message carries, when it reads as one (anything else is left out). */
export function liveSelectionOf(raw: unknown): LiveSelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const label = text(o.label, 200);
  if (!label) return undefined;
  const sel: LiveSelection = { label };
  const sheet = text(o.sheet, 100);
  const range = text(o.range, 100);
  const slide = text(o.slide, 100);
  if (sheet) sel.sheet = sheet;
  if (range) sel.range = range;
  if (slide) sel.slide = slide;
  if (Array.isArray(o.shapes)) {
    const shapes = o.shapes.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 200);
    if (shapes.length) sel.shapes = shapes;
  }
  const point = o.point && typeof o.point === "object" ? (o.point as Record<string, unknown>) : null;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    sel.point = { x: point.x as number, y: point.y as number };
  }
  const quote = text(o.text, 200);
  const block = text(o.block, 64);
  if (quote) sel.text = quote;
  if (block) sel.block = block;
  const frac = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined);
  const mark = o.mark && typeof o.mark === "object" ? (o.mark as Record<string, unknown>) : null;
  const mx = frac(mark?.x);
  const my = frac(mark?.y);
  if (mx !== undefined && my !== undefined) {
    const w = frac(mark?.w);
    const h = frac(mark?.h);
    sel.mark = w && h ? { x: mx, y: my, w, h } : { x: mx, y: my };
  }
  if (typeof o.time === "number" && Number.isFinite(o.time) && o.time >= 0) sel.time = o.time;
  if (Number.isInteger(o.page) && (o.page as number) >= 1) sel.page = o.page as number;
  if (Number.isInteger(o.version) && (o.version as number) >= 1) sel.version = o.version as number;
  const crop = text(o.crop, 64);
  const frame = text(o.frame, 64);
  if (crop) sel.crop = crop;
  if (frame) sel.frame = frame;
  return sel;
}

/** `meta.fileConversation` of a file conversation's root, when it reads right; null for any other message. */
export function fileConversationOf(meta: Record<string, unknown> | null | undefined): FileConversationRoot | null {
  const raw = meta?.fileConversation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const artifactId = text(o.artifactId, 100);
  if (!artifactId || !isTalkKind(o.kind)) return null;
  return { artifactId, kind: o.kind, title: typeof o.title === "string" ? o.title.slice(0, 200) : "" };
}

/**
 * What a message points at in its file (ADR 0199): the server's `liveRef`, else its `meta.liveRef` (an optimistic copy
 * or an older server). Null for a message about no file.
 */
export const messageLiveRef = (m: { liveRef?: LiveRef; meta?: Record<string, unknown> }): LiveRef | null =>
  m.liveRef ?? liveRefOf(m.meta);

/** `message.meta.liveRef`, when a message has one that reads right; null otherwise. */
export function liveRefOf(meta: Record<string, unknown> | null | undefined): LiveRef | null {
  const raw = meta?.liveRef;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const artifactId = text(o.artifactId, 100);
  if (!artifactId || !isTalkKind(o.kind)) return null;
  const ref: LiveRef = { artifactId, kind: o.kind, title: typeof o.title === "string" ? o.title.slice(0, 200) : "" };
  const selection = liveSelectionOf(o.selection);
  if (selection) ref.selection = selection;
  return ref;
}
