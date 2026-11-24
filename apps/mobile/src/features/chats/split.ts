import { createContext, useContext } from "react";
import { isSafeId } from "../shared/logic";
import { createSplitStore, type SplitStore, splitHandoff } from "../shared/split-store";
import type { ConversationRow } from "./logic";

/**
 * Conversas and Threads in two panes (ADR 0212: the iPhone Duo's inner display, a large screen): the conversation open
 * beside each list, kept per workspace while the app runs (through redraws, remounts and the device opening and
 * closing; `split-store.ts`), and what the window changing size class does with it. Pure but for the stores and their
 * hooks, so the tests run it.
 */

/** A conversation the split shows: a channel or a DM, or a thread of one. */
export interface ChatTarget {
  channelId: string;
  threadId: string | null;
}

export const sameChat = (a: ChatTarget | null, b: ChatTarget | null): boolean =>
  a === b || (a !== null && b !== null && a.channelId === b.channelId && a.threadId === b.threadId);

/** A conversation's name in a split's store: two targets with one name are the same conversation. */
const chatKey = (c: ChatTarget) => `${c.channelId}:${c.threadId ?? ""}`;

/** The conversation open beside Conversas' list. */
export const chatSplit: SplitStore<ChatTarget> = createSplitStore(chatKey);
/** The thread or mission open beside Threads' list: its own, so the two tabs never swap each other's. */
export const threadSplit: SplitStore<ChatTarget> = createSplitStore(chatKey);

/** The Threads tab's name in the tabs' navigator (`(tabs)/_layout.tsx`). */
export const THREADS_TAB = "threads";

/** The conversation a row of Conversas opens; null for an agent with none yet (`channelId: ""`). */
export function chatOfRow(row: ConversationRow): ChatTarget | null {
  if (!row.channelId) return null;
  return { channelId: row.channelId, threadId: row.kind === "thread" || row.kind === "mission" ? row.threadId : null };
}

/** The first conversation of a list (Recentes: the most recent first); null when it has none. */
export function firstChatOf(rows: readonly ConversationRow[]): ChatTarget | null {
  for (const row of rows) {
    const chat = chatOfRow(row);
    if (chat) return chat;
  }
  return null;
}

/**
 * Opens a conversation in the workspace's split of Conversas. `again`: a new visit even when it is the one open (it
 * opens afresh, at a place handed over: `reading-place.ts`).
 */
export function chooseChat(orgId: string, target: ChatTarget, again = false) {
  chatSplit.choose(orgId, { channelId: target.channelId, threadId: target.threadId }, again);
}

/** The conversation open in the workspace's split of Conversas, if any. */
export function chosenChat(orgId: string): ChatTarget | null {
  return chatSplit.chosen(orgId);
}

/** The key its pane is drawn under: a new conversation, or a new visit of the same one, draws it afresh. */
export function chosenKey(orgId: string): string | null {
  return chatSplit.shownKey(orgId);
}

/** Conversas' split's choice as it changes (its key, `chosenKey`). */
export function useChosenKey(orgId: string): string | null {
  return chatSplit.useShownKey(orgId);
}

/** How the list opens a conversation while a split shows: beside it, in its pane, rather than pushed. */
export interface ChatOpener {
  orgId: string;
  /** The split's own choice (Conversas' or Threads'), which its rows light. */
  store: SplitStore<ChatTarget>;
  open: (target: ChatTarget) => void;
}

/** Given by a split around both panes; none elsewhere, where a conversation is pushed as always. */
export const ChatOpenerContext = createContext<ChatOpener | null>(null);

export const useChatOpener = () => useContext(ChatOpenerContext);

/**
 * Whether this conversation is the one open beside the list it is in (its opener's split): a row redraws only when its
 * own answer changes. False outside a split.
 */
export function useIsChosen(opener: ChatOpener | null, target: ChatTarget | null): boolean {
  return (opener?.store ?? chatSplit).useIsShown(opener?.orgId ?? null, target);
}

/**
 * The conversation pushed over the tabs when it is what shows: the main stack's `chat/[channelId]` route on top, as
 * expo-router's `useSegments` and `useGlobalSearchParams` give it. Null for anything else.
 */
export function pushedChatOf(
  segments: readonly string[],
  params: Readonly<Record<string, string | string[] | undefined>>,
): ChatTarget | null {
  const n = segments.length;
  if (n < 3 || segments[n - 1] !== "[channelId]" || segments[n - 2] !== "chat" || segments[n - 3] !== "(main)")
    return null;
  const { channelId, thread } = params;
  if (!isSafeId(channelId)) return null;
  return { channelId, threadId: isSafeId(thread) && thread !== channelId ? thread : null };
}

/**
 * A conversation's address (`chatHref`: `/chat/<id>`, with `thread=`) as the split opens it; null for any other place,
 * and for an agent's request for help (`handoff=`), whose card opens in control on the pushed screen.
 */
export function chatOfHref(href: string): ChatTarget | null {
  const [path = "", query = ""] = href.split("?");
  const channelId = /^\/chat\/([^/]+)$/.exec(path)?.[1];
  if (!isSafeId(channelId)) return null;
  const params = new Map(
    query
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const [name = "", value = ""] = pair.split("=");
        return [name, value] as const;
      }),
  );
  if (params.has("handoff")) return null;
  const thread = params.get("thread");
  return { channelId, threadId: isSafeId(thread) && thread !== channelId ? thread : null };
}

/** What the window changing size class does with the conversation (`handoffOf`). */
export type Handoff = { kind: "push"; chat: ChatTarget } | { kind: "split"; chat: ChatTarget } | null;

/**
 * So that closing and opening an iPhone Duo mid-task keeps the person in the conversation (ADR 0212), as every split
 * does (`splitHandoff`):
 * - wide to compact, with the split on screen and a conversation open in it, that conversation is pushed, as a tap on
 *   its row does on a phone;
 * - compact to wide, with a conversation pushed over the tabs, it opens in the split, back on the tabs.
 * Anything else stays as it is (a screen pushed over the split, another tab, no change of size class).
 */
export function handoffOf(
  before: boolean,
  wide: boolean,
  state: { splitShown: boolean; chosen: ChatTarget | null; pushed: ChatTarget | null },
): Handoff {
  const step = splitHandoff(before, wide, state);
  return step ? { kind: step.kind, chat: step.item } : null;
}

/**
 * Which split takes a conversation pushed over the tabs when the device opens: Threads' when it was pushed from the
 * Threads tab (the tab selected under it), Conversas' from any other or where that can't be told (null).
 */
export const chatOwner = (tab: string | null): "threads" | "chats" => (tab === THREADS_TAB ? "threads" : "chats");
