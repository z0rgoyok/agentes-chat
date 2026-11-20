import type { LiveKind, LiveRef, LiveSelection } from "@agenteschat/client";

/**
 * A live file's own conversation on the phone (ADR 0199), the pure part: the line under the file (who took part, an
 * agent at work there or the last message, how many), the quote over the composer and the line over a message about
 * part of the file, and which agent "Ask Atlas" calls. The screens draw it; the tests read it.
 */

type T = (key: string, options?: Record<string, unknown>) => string;

// ── The quote and the line about the file ─────────────────────────────────────────────────────────────────────────

/** A spreadsheet's label is "Sheet!Range": its range and its sheet's name ("C2:D6", "Custos"). */
export function sheetParts(label: string): { range: string; sheet: string } | null {
  const at = label.lastIndexOf("!");
  if (at <= 0 || at === label.length - 1) return null;
  return { sheet: label.slice(0, at), range: label.slice(at + 1) };
}

/**
 * The quote over the composer: "About C2:D6 in Costs", "About 1 image on the canvas", "About slide 1", "About the
 * selected passage"; a comment's spot on a canvas: "A comment on a spot of the canvas".
 */
export function aboutWords(t: T, kind: LiveKind, selection: LiveSelection): string {
  const label = selection.label;
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
 * image" in "Summer banner"; the file alone when nothing in particular was selected.
 */
export function aboutParts(t: T, ref: LiveRef): { what: string; where: string } {
  const selection = ref.selection;
  const title = ref.title || t("live.conversation.untitled");
  if (!selection) return { what: title, where: t(`live.kinds.${ref.kind}`) };
  const sheet = ref.kind === "spreadsheet" ? sheetParts(selection.label) : null;
  if (sheet) return { what: sheet.range, where: sheet.sheet };
  return { what: selection.label, where: title };
}

/** Two selections are the same part of the file. */
export const selectionKey = (s: LiveSelection | null | undefined) =>
  s ? JSON.stringify([s.label, s.sheet, s.range, s.slide, s.shapes, s.point, s.text, s.block]) : "";

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

// ── Where the conversation opens ─────────────────────────────────────────────────────────────────────────────────

/**
 * Whether the screen under the conversation is this file's own (the stack's route before the conversation's): then
 * going back to it is going back, never a second copy pushed over the conversation.
 */
export function fileUnder(
  routes: readonly { name: string; params?: object | undefined }[] | undefined,
  fileId: string,
): boolean {
  if (!routes || routes.length < 2) return false;
  const under = routes[routes.length - 2];
  if (!under || !LIVE_ROUTE_NAMES.has(under.name)) return false;
  return (under.params as { id?: unknown } | undefined)?.id === fileId;
}

const LIVE_ROUTE_NAMES: ReadonlySet<string> = new Set([
  "spreadsheet/[id]",
  "slides/[id]",
  "canvas/[id]",
  "document/[id]",
]);
