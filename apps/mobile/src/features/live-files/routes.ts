import { isLiveFileKind, type LiveKind, type TalkKind } from "@agenteschat/client";
import type { SFSymbolName } from "../../ui/headerActions";
import type { IconName } from "../../ui/icons.data";

/**
 * Where live files open on the phone (ADR 0196 §9), and their marks: kept apart from the screens' logic so the files'
 * routing (`fileRoute`) reads it without loading the documents' code.
 */

/** The screen each kind of live file opens on (a document's: ADR 0200). */
export const LIVE_SCREENS = {
  spreadsheet: "/spreadsheet/[id]",
  slides: "/slides/[id]",
  canvas: "/canvas/[id]",
  document: "/document/[id]",
} as const satisfies Record<LiveKind, string>;

export type LiveScreen = (typeof LIVE_SCREENS)[LiveKind];

/** The live kinds the phone opens on a screen of their own: every one. */
export type PhoneLiveKind = LiveKind;

/** Whether a file opens on a live file's own screen. */
export const opensLive = (kind: unknown): kind is PhoneLiveKind => isLiveFileKind(kind);

/**
 * A live file's own screen: it always opens as it is now (its versions are the web's history). `m`: a message of its
 * conversation to open at (a notice, a link: ADR 0199), pushed over the file once the file is known.
 */
export const liveRoute = (
  kind: LiveKind,
  id: string,
  m?: string | null,
): { pathname: LiveScreen; params: { id: string; m?: string } } => ({
  pathname: LIVE_SCREENS[kind],
  params: m ? { id, m } : { id },
});

/** Who is in a live file, and following one of them (`here/[id]`). */
export const hereRoute = (id: string) => ({ pathname: "/here/[id]" as const, params: { id } });

/** The kinds "New" makes, in its order (ADR 0196 §9, a document: ADR 0200). */
export const LIVE_KINDS_MADE: readonly LiveKind[] = ["document", "spreadsheet", "slides", "canvas"];

/** Each kind's line icon (the Drive, cards, New) and its SF Symbol (bar buttons and menus on iOS). */
export const LIVE_ICON: Record<LiveKind, IconName> = {
  spreadsheet: "spreadsheet",
  slides: "slides",
  canvas: "canvas",
  document: "doc",
};
export const LIVE_SF: Record<LiveKind, SFSymbolName> = {
  spreadsheet: "tablecells",
  slides: "rectangle.on.rectangle",
  canvas: "square.on.circle",
  document: "doc.text",
};

/** A file's conversation's mark: its live kind's, or a picture's, a video's or a PDF's (ADR 0208). */
export const talkIcon = (kind: TalkKind): IconName =>
  kind === "image" ? "image" : kind === "video" ? "play" : kind === "pdf" ? "file" : LIVE_ICON[kind];

/** The editors' tools, as line icons with their SF Symbols (the slides and canvas screens' bars and menus). */
export const LIVE_TOOL_SF = {
  frame: "rectangle.dashed",
  note: "note.text",
  shape: "square.on.circle",
  textTool: "textformat",
  follow: "location.north.line",
  present: "play.rectangle",
  redo: "arrow.uturn.forward",
  paste: "doc.on.clipboard",
} as const satisfies Partial<Record<IconName, SFSymbolName>>;
