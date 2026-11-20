import type { Agent, LiveKind, LiveRef, LiveSelection } from "@agenteschat/client";
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
  kind: LiveKind;
  title: string;
  /** The conversation's root (the panel's thread), once it exists. */
  rootId: string | null;
  /** What the person has selected in the file: over the composer, and on the next message sent there. */
  about: LiveSelection | null;
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
  s ? JSON.stringify([s.label, s.sheet, s.range, s.slide, s.shapes, s.point, s.text, s.block]) : "";

/** A part of a file a message's line named in another chat, kept until the file's page opens and shows it. */
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
export function aboutWords(t: TFunction, kind: LiveKind, selection: LiveSelection): string {
  const label = selection.label;
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
  if (!selection) return { what: title, where: t(`live.kinds.${ref.kind}` as "live.kinds.canvas") };
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
