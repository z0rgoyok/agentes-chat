import { type DehydratedState, dehydrate, hydrate, type Query, type QueryClient } from "@tanstack/react-query";
import { ME_HASH } from "./keys";
import { MISSIONS_WAITING_COUNT } from "./missions";
import type { Me, Message } from "./types";

/**
 * A snapshot of the conversations on this device: opening the app shows the
 * last lists and recent chats at once, then every query revalidates as usual
 * (the server stays the source of truth). Each app brings its own storage
 * (IndexedDB on the web, a file on the phone).
 *
 * Only an allow-list is kept: the signed-in person, the conversation lists,
 * agents and people, the sidebar's tools and counts, and the latest messages
 * of the most recent chats. It belongs to one person: dropped when `me` leaves
 * the cache (`qc.clear()` on sign-out, sign-in or a 401), comes back as
 * someone else, or waits for its deletion.
 */
export interface SnapshotStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

/** Bump when a cached shape changes: older snapshots are ignored. */
export const SNAPSHOT_VERSION = 1;
/** Conversations kept, most recently updated first. */
export const SNAPSHOT_CHATS = 10;
/** Messages kept per conversation (the newest). */
export const SNAPSHOT_MESSAGES = 50;
/** Older snapshots are ignored (the app loads from the server). */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A change's longest wait to be saved, unless the app asks for another (`SnapshotOptions.saveAfterMs`). */
const SAVE_DELAY_MS = 2_000;
/** A save that is due waits for a quiet moment of the thread, never longer than this. */
const IDLE_WAIT_MS = 5_000;

export interface SnapshotOptions {
  /**
   * How long after a change the next save runs; the changes in between ride along with it. A save is the whole
   * snapshot (every list and the recent chats turned into one string) on the thread that draws, so an app where that
   * thread also moves the screens (the phone) saves less often and on `flush` when it goes to the background.
   */
  saveAfterMs?: number;
}

type IdleCallbacks = {
  requestIdleCallback?: (run: () => void, options: { timeout: number }) => unknown;
  cancelIdleCallback?: (handle: unknown) => void;
};

/**
 * Runs `run` once the thread is idle (at the latest after `IDLE_WAIT_MS`) where the platform says when (a browser, the
 * phone), else on the next turn. Never at once, so the caller holds the returned cancel before `run` can start.
 */
function whenIdle(run: () => void): () => void {
  const idle = globalThis as unknown as IdleCallbacks;
  if (typeof idle.requestIdleCallback === "function") {
    try {
      const handle = idle.requestIdleCallback(run, { timeout: IDLE_WAIT_MS });
      return () => idle.cancelIdleCallback?.(handle);
    } catch {
      // A platform that has the call but can't serve it: the next turn instead.
    }
  }
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
}

interface Snapshot {
  v: number;
  savedAt: number;
  owner: string;
  state: DehydratedState;
}

/**
 * `["org", orgId, <list>]`: the lists the shell and the chat need right away. Where I put the sidebar's tools too, and
 * the overview with its count of the approvals waiting for me, so no tool moves in once the server answers; and how I
 * look at Tarefas, so the board doesn't open as the default and then turn into my list.
 */
const ORG_LISTS = new Set([
  "channels",
  "channel-categories",
  "dms",
  "agents",
  "members",
  "team",
  "detail",
  "sidebar-items",
  "overview",
  "issues-view",
]);
/**
 * `["org", orgId, "channel", channelId, <part>]`: kept for the chats in the snapshot. With its messages, what changes
 * their rows (the agents' questions to each other here, and the threads' links below, `chatThreads`): a chat opened
 * from the snapshot shows its rows whole, and none grows under the person once the server answers.
 */
const CHAT_PARTS = new Set(["messages", "roster", "members", "consultations"]);

const isMe = (key: readonly unknown[]) => key.length === 1 && key[0] === "me";
/** `["org", orgId, "threads", "channel", channelId, "all"]`: a chat's threads, for the links under their roots. */
const chatThreads = (key: readonly unknown[]) =>
  key.length === 6 && key[0] === "org" && key[2] === "threads" && key[3] === "channel" && key[5] === "all"
    ? { chat: `${key[1]}/${key[4]}`, part: "threads" }
    : null;
const chatPart = (key: readonly unknown[]) =>
  key.length === 5 && key[0] === "org" && key[2] === "channel" && CHAT_PARTS.has(key[4] as string)
    ? { chat: `${key[1]}/${key[3]}`, part: key[4] as string }
    : chatThreads(key);
const isOrgList = (key: readonly unknown[]) => key.length === 3 && key[0] === "org" && ORG_LISTS.has(key[2] as string);
/** `["org", orgId, "missions", "list", <query>]`: only the sidebar's count of the missions waiting for me. */
const WAITING_COUNT = JSON.stringify(MISSIONS_WAITING_COUNT);
const isWaitingCount = (key: readonly unknown[]) =>
  key.length === 5 && key[0] === "org" && key[2] === "missions" && key[3] === "list" && key[4] === WAITING_COUNT;
/**
 * `["org", orgId, "threads", "list", <filters>]`: the threads and missions of the conversation list. Without them a
 * launch drew the list from its channels and DMs alone, and the threads came in from the server a moment later,
 * between them, moving every row under them (seen on a phone). Only their first page is written (`firstPage`).
 */
const isThreadList = (key: readonly unknown[]) =>
  key.length === 5 && key[0] === "org" && key[2] === "threads" && key[3] === "list";
/** Always kept (a chat's parts only for the most recent chats). */
const isKept = (key: readonly unknown[]) => isMe(key) || isOrgList(key) || isWaitingCount(key) || isThreadList(key);

/** A paged list's first page only: the newest, what a launch shows; the rest loads as the person scrolls. */
export function firstPage(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const { pages, pageParams } = data as { pages?: unknown; pageParams?: unknown };
  if (!Array.isArray(pages) || !Array.isArray(pageParams)) return data;
  return { pages: pages.slice(0, 1), pageParams: pageParams.slice(0, 1) };
}

/** The queries worth keeping: the allow-list, loaded, and only the chats most recently updated. */
export function pickSnapshotQueries(queries: Query[], chats = SNAPSHOT_CHATS): Query[] {
  const loaded = queries.filter((q) => q.state.status === "success" && q.state.data != null);
  const recent = loaded
    .filter((q) => chatPart(q.queryKey)?.part === "messages")
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, chats)
    .map((q) => chatPart(q.queryKey)?.chat);
  const kept = new Set(recent);
  return loaded.filter((q) => {
    if (isKept(q.queryKey)) return true;
    const c = chatPart(q.queryKey);
    return c !== null && kept.has(c.chat);
  });
}

/** A conversation's newest messages, without the ones still sending or that failed (they live in memory only). */
export const trimMessages = (list: Message[], max = SNAPSHOT_MESSAGES): Message[] =>
  list.filter((m) => !m.local).slice(-max);

export function createSnapshot(qc: QueryClient, storage: SnapshotStorage, options: SnapshotOptions = {}) {
  const saveAfterMs = options.saveAfterMs ?? SAVE_DELAY_MS;
  let owner: string | null = null;
  /** A save waiting for its time, then for a quiet moment (`whenIdle`). */
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle: (() => void) | null = null;
  /** Counts the wipes: a write that was on its way while one ran is taken back. */
  let wipes = 0;
  /**
   * Whether something kept changed since the last save, as `start` follows the cache: a flush with nothing new writes
   * nothing. Not followed (no `start`), a flush always writes.
   */
  let dirty = true;
  let following = false;

  const currentOwner = () => qc.getQueryData<Me | null>(["me"])?.user.id ?? null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    idle?.();
    idle = null;
  };

  const save = async () => {
    dirty = false;
    const me = qc.getQueryData<Me | null>(["me"]);
    if (!me) return;
    // Waiting for its deletion: the server alone says so at every opening, never a copy from disk whose session may
    // have ended since.
    if (me.user.deletion) return wipe();
    const who = me.user.id;
    owner = who;
    const picked = new Set(pickSnapshotQueries(qc.getQueryCache().getAll()).map((q) => q.queryHash));
    const state = dehydrate(qc, {
      shouldDehydrateQuery: (q) => picked.has(q.queryHash),
      // A request that waits for the network holds what it carries (a typed key, a header's value): never written.
      shouldDehydrateMutation: () => false,
    });
    for (const q of state.queries) {
      if (chatPart(q.queryKey)?.part === "messages" && Array.isArray(q.state.data)) {
        q.state = { ...q.state, data: trimMessages(q.state.data as Message[]) };
      } else if (isThreadList(q.queryKey)) {
        q.state = { ...q.state, data: firstPage(q.state.data) };
      }
    }
    const snapshot: Snapshot = { v: SNAPSHOT_VERSION, savedAt: Date.now(), owner: who, state };
    const at = wipes;
    await storage.write(JSON.stringify(snapshot)).catch(() => {});
    // Signed out while it was being written: nothing of that person stays.
    if (wipes !== at) await storage.remove().catch(() => {});
  };

  /** Time for the save that waited: it runs at the thread's next quiet moment. */
  const due = () => {
    timer = null;
    idle = whenIdle(() => {
      idle = null;
      void save();
    });
  };

  const wipe = async () => {
    owner = null;
    wipes += 1;
    cancel();
    await storage.remove().catch(() => {});
  };

  return {
    /** Puts the saved snapshot in the cache; false when there was none (or it was too old, or another version). */
    async restore(): Promise<boolean> {
      const raw = await storage.read().catch(() => null);
      if (!raw) return false;
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(raw) as Snapshot;
      } catch {
        await wipe();
        return false;
      }
      if (snapshot.v !== SNAPSHOT_VERSION || Date.now() - snapshot.savedAt > SNAPSHOT_MAX_AGE_MS) {
        await wipe();
        return false;
      }
      const saved = snapshot.state.queries.find((q) => q.queryHash === ME_HASH)?.state.data as Me | null | undefined;
      // `save` keeps no account that waits for its deletion, but a snapshot an older version of the app wrote can.
      if (saved?.user.deletion) {
        await wipe();
        return false;
      }
      owner = snapshot.owner;
      hydrate(qc, snapshot.state);
      return true;
    },

    /**
     * Saves after changes (`saveAfterMs` after the first one, at a quiet moment) and drops the snapshot with its owner.
     * Returns the stop.
     */
    start(): () => void {
      following = true;
      const off = qc.getQueryCache().subscribe((event) => {
        const q = event.query;
        if (q.queryHash === ME_HASH) {
          if (event.type === "removed") return void wipe();
          const who = currentOwner();
          if (event.type === "updated" && q.state.status === "success" && owner !== null && who !== owner) {
            // Signed out, or someone else on this device: nothing of the previous person stays.
            void wipe();
            if (who) void qc.resetQueries({ queryKey: ["org"] });
          }
        }
        // Only new data is worth a save: a request starting, failing or marked stale changes nothing kept.
        if (event.type !== "updated" || (event.action.type !== "success" && event.action.type !== "setState")) return;
        if (!isKept(q.queryKey) && !chatPart(q.queryKey)) return;
        dirty = true;
        if (!timer && !idle) timer = setTimeout(due, saveAfterMs);
      });
      return () => {
        following = false;
        off();
      };
    },

    /**
     * Saves now (the page is being hidden or the app goes to the background), if anything kept changed since the last
     * save: the whole snapshot is one string written on the thread that draws, and a stay away right after a save
     * (the notification shade, a quick look at another app) has nothing new to write.
     */
    flush: () => {
      cancel();
      return dirty || !following ? save() : Promise.resolve();
    },

    wipe,
  };
}

export type SnapshotController = ReturnType<typeof createSnapshot>;
