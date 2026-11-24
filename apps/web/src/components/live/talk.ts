import type { Agent, LiveRef, LiveSelection, TalkKind } from "@agenteschat/client";
import { isMediaKind } from "@agenteschat/client";
import type { TFunction } from "i18next";
import { createContext, useContext } from "react";
import type { LiveAskRequest } from "./editor";

/*
 * A live file's own conversation, seen from the file (ADR 0199): the chat shown beside the file reads what the person
 * selected there (the quote over its composer, `meta.liveRef` on the next message), takes the text the file's buttons
 * put in it ("Pedir ao Atlas"), and sends a message's line about the file back to it. A module of its own, with no
 * editor in it, so every conversation can read it without loading the file's page.
 */

/** The open file, as its conversation beside it needs it. */
export interface FileTalk {
  artifactId: string;
  kind: TalkKind;
  title: string;
  /** The conversation's root (the panel's thread), once it exists. */
  rootId: string | null;
  /** What the person has selected in the file: over the composer, and on the next message sent there. */
  about: LiveSelection | null;
  /** A picture's, a video's or a PDF's comment (ADR 0208): the app's picture of the place, shown in the quote. */
  aboutThumb?: string | null;
  /**
   * Called as the message goes: what it is about, with the app's pictures of the place uploaded now (only a message
   * that is sent stores them); as it was when they can't go up.
   */
  prepareAbout?(about: LiveSelection): Promise<LiveSelection>;
  /** The quote's ×, and once a message carried it: it goes until the selection changes. */
  dropAbout(): void;
  /** Words to put in the composer ("@Atlas faz variações desta imagem"), a new `key` for each request. */
  prefill: { text: string; key: number } | null;
  /** The composer took `prefill`. */
  tookPrefill(): void;
  /** A message's line about this file was clicked: the editor selects that part. */
  reveal(selection: LiveSelection): void;
}

export const FileTalkContext = createContext<FileTalk | null>(null);

/** The file open beside this conversation, if any (null in every other chat). */
export const useFileTalk = () => useContext(FileTalkContext);

export const LiveAskContext = createContext<((request?: LiveAskRequest) => void) | null>(null);

/**
 * Asks in the open file's conversation (ADR 0199): it opens, its composer starts with the agent's @ and the words, and
 * the selection rides along. What "Pedir ao Atlas" and "Variações" call; null outside a file's page (or on a saved
 * version, which asks nothing).
 */
export const useAskInConversation = () => useContext(LiveAskContext);

/** Two selections are the same part of the file (the quote dropped for one stays dropped until it changes). */
export const selectionKey = (s: LiveSelection | null | undefined) =>
  s
    ? JSON.stringify([s.label, s.sheet, s.range, s.slide, s.shapes, s.point, s.text, s.block, s.mark, s.time, s.page])
    : "";

/** A video's moment as m:ss (h:mm:ss past an hour). */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A comment's pin number, as its app wrote it in the label (ADR 0208); empty when the label is no number. */
const pinNumber = (selection: LiveSelection) => (/^\d{1,5}$/.test(selection.label) ? selection.label : "");

/** The mark of a picture's, a video's or a PDF's comment, short: "Área 4", "Ponto 2". */
function markWhat(t: TFunction, selection: LiveSelection): string {
  const n = pinNumber(selection);
  const area = selection.mark?.w !== undefined;
  return n
    ? t(area ? "live.conversation.what.area" : "live.conversation.what.point", { n })
    : t(area ? "live.conversation.what.anArea" : "live.conversation.what.aPoint");
}

/**
 * A part of a file a message's line named in another chat, kept until the file opens and shows it (a live file's
 * page, the viewer's comments of a picture, a video or a PDF).
 */
const waiting = new Map<string, LiveSelection>();

export const revealOnOpen = (fileId: string, selection: LiveSelection) => void waiting.set(fileId, selection);

/** The part to show when the page opens (once). */
export function takeRevealOnOpen(fileId: string): LiveSelection | null {
  const selection = waiting.get(fileId) ?? null;
  waiting.delete(fileId);
  return selection;
}

/** A spreadsheet's label is "Sheet!Range": its range and its sheet's name ("C2:D6", "Custos"). */
function sheetParts(label: string): { range: string; sheet: string } | null {
  const at = label.lastIndexOf("!");
  if (at <= 0 || at === label.length - 1) return null;
  return { sheet: label.slice(0, at), range: label.slice(at + 1) };
}

/**
 * The quote over the composer: "Sobre C2:D6 em Custos", "Sobre 1 imagem no quadro", "Sobre o slide 1", "Sobre o
 * trecho selecionado".
 */
export function aboutWords(t: TFunction, kind: TalkKind, selection: LiveSelection): string {
  const label = selection.label;
  // A picture's, a video's or a PDF's comment (ADR 0208): "About area 4 of the image", "About 0:42 of the video".
  if (isMediaKind(kind)) {
    if (kind === "video" && selection.time !== undefined) {
      return t("live.conversation.about.videoAt", { time: clockOf(selection.time) });
    }
    if (kind === "pdf" && selection.page !== undefined)
      return t("live.conversation.about.pdfPage", { page: selection.page });
    const n = pinNumber(selection);
    if (selection.mark?.w !== undefined) return t("live.conversation.about.imageArea", { n });
    if (selection.mark) return t("live.conversation.about.imagePoint", { n });
    return t(`live.conversation.about.${kind}` as "live.conversation.about.image");
  }
  const sheet = kind === "spreadsheet" ? sheetParts(label) : null;
  if (sheet) return t("live.conversation.about.range", sheet);
  const slide = kind === "slides" ? /\d+/.exec(label)?.[0] : undefined;
  if (slide) return t("live.conversation.about.slide", { n: slide });
  // A comment pinned on a canvas points at a spot, not at shapes.
  if (kind === "canvas" && selection.point && !selection.shapes?.length) return t("live.conversation.about.point");
  if (kind === "canvas") return t("live.conversation.about.canvas", { label });
  if (String(kind) === "document") return t("live.conversation.about.text");
  return t("live.conversation.about.other", { label });
}

/**
 * A message's line about the file: what (bold) and where (quiet): "C2:D6" in "Custos", "Slide 3" in the file,
 * "1 imagem" in "Banner de verão"; the file alone when nothing in particular was selected.
 */
export function aboutParts(t: TFunction, ref: LiveRef): { what: string; where: string } {
  const selection = ref.selection;
  const title = ref.title || t("live.conversation.untitled");
  if (!selection) {
    return isMediaKind(ref.kind)
      ? { what: title, where: t(`live.conversation.where.${ref.kind}` as "live.conversation.where.image") }
      : { what: title, where: t(`live.kinds.${ref.kind}` as "live.kinds.canvas") };
  }
  // A picture's, a video's or a PDF's comment (ADR 0208): "Area 1" on the image, "0:42 · area 2" on the video,
  // "Page 3" with its "area 1".
  if (isMediaKind(ref.kind)) {
    const where = t(`live.conversation.where.${ref.kind}` as "live.conversation.where.image");
    if (ref.kind === "video" && selection.time !== undefined) {
      const time = clockOf(selection.time);
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
  const sheet = ref.kind === "spreadsheet" ? sheetParts(selection.label) : null;
  if (sheet) return { what: sheet.range, where: sheet.sheet };
  return { what: selection.label, where: title };
}

export const FileAgentContext = createContext<Agent | null>(null);

/**
 * The open file's agent (`useFileAgent` on the page, ADR 0199): whose face and name "Pedir ao Atlas" shows. Null
 * outside a file's page, or with no agent this person may ask.
 */
export const useFileAgentHere = () => useContext(FileAgentContext);
