import type { ManagedTask } from "@agenteschat/client";
import { SHORT_NAME } from "@agenteschat/client/lib/agora";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import type { WorkItem } from "@agenteschat/client/lib/working";
import type { TFunction } from "i18next";
import { needsHeaderBlur } from "@/lib/nav";
import { type AppHref, chatHref } from "../links/logic";

/**
 * The work-along line, the phone's Agora (ADR 0128 addendum of 2026-11-14): what it shows, where a tap goes and where
 * it stands, apart from React Native so it can be tested.
 */

/**
 * The work the line may show: a run marked waiting stays only when something of that agent really waits on me (my
 * requests, missions and questions); otherwise it waits on someone else, or the flag outlived the decision.
 */
export function alongWork(work: readonly WorkItem[], waitingOnMe: readonly { agentId: string | null }[]): WorkItem[] {
  const mine = new Set(waitingOnMe.map((w) => w.agentId).filter((id): id is string => Boolean(id)));
  return work.filter((w) => !w.waiting || mine.has(w.agentId));
}

/** A plain answer is over before it's worth a line: a run shows once it has gone on this long. */
export const ALONG_AFTER_MS = 45_000;

/**
 * The one piece of work worth carrying across tabs: what waits on you first (a request stops an agent), then the
 * newest long work (a mission, a task, a run past `ALONG_AFTER_MS`). Null when there is none, and the line goes
 * away with it, so a quick reply never makes it flash.
 */
export function workAlong(work: readonly WorkItem[], now: number): { lead: WorkItem; others: number } | null {
  const long = work.filter((w) => w.waiting || w.kind !== "run" || now - new Date(w.since).getTime() >= ALONG_AFTER_MS);
  if (long.length === 0) return null;
  const waiting = long.filter((w) => w.waiting);
  const pool = waiting.length > 0 ? waiting : long;
  const lead = [...pool].sort((a, b) => b.since.localeCompare(a.since))[0];
  return lead ? { lead, others: long.length - 1 } : null;
}

/**
 * The line's words: "Theo · esperando você", "Atlas · ajudando a Ada" (work Ada handed it, `forName`), "Atlas ·
 * Corrigir o link", "Atlas está trabalhando". `mark` wraps what may give way on a short line (the names, a title), so
 * the words between them stay whole (`markInk`, then `markedPieces`).
 */
export function alongWords(
  t: TFunction,
  lead: WorkItem,
  name: string,
  forName?: string,
  mark: (text: string) => string = (text) => text,
): string {
  if (lead.waiting) return t("mobile.along.waits", { name: mark(name) });
  if (forName) {
    const g = agentGrammar(forName);
    const what = t("chat.consultPanel.helping", { name: mark(g.name), context: g.context });
    return t("mobile.along.on", { name: mark(name), what });
  }
  return lead.what
    ? t("mobile.along.on", { name: mark(name), what: mark(lead.what) })
    : t("mobile.along.working", { name: mark(name) });
}

/** Whether a piece of the line's words gives way ("…") on a short line: a marked name or title, never a short name. */
export const givesWay = (piece: { text: string; bold: boolean }) => piece.bold && [...piece.text].length > SHORT_NAME;

/** A tap: one piece of work opens its place (work handed off, at the reply that handed it); several, the task manager. */
export const alongHref = (lead: WorkItem, others: number): AppHref | "/task-manager" =>
  others > 0 ? "/task-manager" : chatHref(lead.channelId, lead.threadId, lead.messageId);

/** The run behind the line, what its long press stops or opens the steps of; a mission has none. */
export const alongRunId = (lead: Pick<WorkItem, "key">) => (lead.key.startsWith("r:") ? lead.key.slice(2) : null);

/**
 * A long press's items, by the task manager's list: "Ver passos" for a run it lists, "Parar" for who may stop it. A run
 * it doesn't list (two agents' work for someone who only reads where it was handed off) has no steps to show: none,
 * and the press opens the work's place.
 */
export const runMenuItems = (task: Pick<ManagedTask, "canStop"> | undefined): ("steps" | "stop")[] =>
  task ? (task.canStop ? ["steps", "stop"] : ["steps"]) : [];

/** iOS 26 holds the line in the tab bar's own accessory; Android and older iOS get a strip over the tab bar. */
export const alongInAccessory = (os: string, version: string | number) => os === "ios" && !needsHeaderBlur(os, version);

/** The strip's height: the tab roots' lists keep as much room at their end, so no row moves under it. */
export const ALONG_STRIP = 48;

/** UIKit's tab bar before iOS 26, over the home indicator's room: the strip sits on its top edge. */
const LEGACY_TAB_BAR = 49;

/**
 * How far over the screen's bottom the strip sits: on the tab bar's top. Android lays a tab root out above its bar;
 * older iOS lays it under its translucent bar.
 */
export const alongStripBottom = (os: string, safeBottom: number) => (os === "ios" ? safeBottom + LEGACY_TAB_BAR : 0);
