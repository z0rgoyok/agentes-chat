import {
  type Approval,
  useApprovals,
  useChannels,
  useDms,
  useMissionList,
  useNotificationCount,
  useTasksUnread,
  useThreadList,
  useWorkingRuns,
} from "@agenteschat/client";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import * as Notifications from "expo-notifications";
import { useEffect, useMemo, useRef } from "react";
import { useOrg } from "@/providers/org";
import { busyChannels, type WorkItem, workingNow } from "../agents/logic";
import { waitingApprovals } from "../approvals/logic";
import {
  appBadgeCount,
  buildConversations,
  type ConversationRow,
  hiddenAgentIds,
  unreadConversationCount,
  unreadThreadCount,
} from "../chats/logic";
import { useDirectory, useNow, useOrgId } from "./hooks";

/**
 * Reads several screens share: who is working, the conversation list, what
 * waits on you (and the tab badges).
 */

/** One result per set of inputs, kept on them: each level holds the next by the input's identity. */
interface Kept<R> {
  next: WeakMap<object, Kept<R>>;
  made?: { value: R };
}

/** Stands for an input not loaded yet (undefined or null), as a key. */
const UNREAD = {};
/** A workspace's mode as a key: a personal one's channels are listed as group conversations (ADR 0159). */
const PERSONAL = {};
const TEAM = {};

/**
 * `make()`'s result for these inputs (the query cache's objects, new only when their contents change), made once and
 * handed to every screen and row asking with the same ones; dropped with the inputs.
 */
function keptBy<R>(root: Kept<R>, inputs: readonly (object | null | undefined)[], make: () => R): R {
  let node = root;
  for (const input of inputs) {
    const key = input ?? UNREAD;
    let next = node.next.get(key);
    if (!next) {
      next = { next: new WeakMap() };
      node.next.set(key, next);
    }
    node = next;
  }
  node.made ??= { value: make() };
  return node.made.value;
}

const activeWork: Kept<WorkItem[]> = { next: new WeakMap() };
const workingOnly: Kept<WorkItem[]> = { next: new WeakMap() };
const hiddenAgents: Kept<Set<string>> = { next: new WeakMap() };
const conversations: Kept<ConversationRow[]> = { next: new WeakMap() };
const unreadThreads: Kept<number> = { next: new WeakMap() };

/**
 * Everything agents are on: active missions, then agent runs in progress in the
 * conversations you are in (`GET …/active-runs`, for everyone), runs stopped on a person included.
 */
export function useActiveWork() {
  const orgId = useOrgId();
  const runs = useWorkingRuns(orgId);
  const missions = useMissionList(orgId, { status: "active" });
  const list = missions.data?.missions;
  return keptBy(activeWork, [runs.data, list], () => workingNow(runs.data, list));
}

/** Who is working now: the active work without the runs waiting on a person (those say "espera seu ok"). */
export function useWorkingNow() {
  const all = useActiveWork();
  return keptBy(workingOnly, [all], () => all.filter((w) => !w.waiting));
}

/** My threads and missions, the latest 50 (Conversas' rows and the Threads tab). */
const THREAD_LIST = { tab: "all", mine: true, limit: 50 } as const;

/**
 * The agents whose DMs my conversation lists leave out (`hiddenAgentIds`: their DM wouldn't open for me), and whether
 * the directory that names them is still loading.
 */
export function useHiddenAgents() {
  const org = useOrg().org;
  const dir = useDirectory();
  const hidden = keptBy(hiddenAgents, [dir.agents, org], () => hiddenAgentIds(org, dir.agents));
  return { hidden, loading: dir.loading };
}

/**
 * Conversas: channels, DMs and my threads and missions, newest first (agent DMs say who is working). Built once per
 * set of lists for every screen that shows them (the home, Recentes, Buscar, Novo…), not once per screen.
 */
export function useConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const threads = useThreadList(orgId, THREAD_LIST);
  const work = useWorkingNow();
  const { hidden, loading: agentsLoading } = useHiddenAgents();
  // A personal workspace's channels are group conversations, shown by their agents (ADR 0159).
  const personal = isPersonal(useOrg().org);
  const rows = keptBy(
    conversations,
    [channels.data, dms.data, threads.data, work, hidden, personal ? PERSONAL : TEAM],
    () =>
      buildConversations({
        channels: channels.data ?? [],
        dms: dms.data ?? [],
        threads: threads.data?.pages.flatMap((p) => p.threads) ?? [],
        workingChannels: busyChannels(work),
        hiddenAgents: hidden,
        personal,
      }),
  );
  const lists = [channels, dms];
  return {
    rows,
    // The directory too: before it names the agents a member doesn't see, their DMs would flash in. And the threads:
    // drawn without them, they came in a moment later between the channels and DMs, moving every row under them.
    loading: channels.isLoading || dms.isLoading || threads.isLoading || agentsLoading,
    // The server didn't answer: nothing to show (`failed`), or the kept rows weren't loaded again (`stale`).
    failed: lists.some((q) => q.isError && !q.data),
    stale: lists.some((q) => q.isError && q.data),
    refetch: () => Promise.all([channels.refetch(), dms.refetch(), threads.refetch()]),
  };
}

/** The badge of Conversas: channels and DMs with something unread (the home's Recent list; threads have their tab). */
export function useUnreadConversations() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const { hidden, loading } = useHiddenAgents();
  // Like the home, it waits for the directory, so a DM the home leaves out never counts.
  return useMemo(
    () =>
      loading
        ? 0
        : unreadConversationCount({ channels: channels.data ?? [], dms: dms.data ?? [], hiddenAgents: hidden }),
    [channels.data, dms.data, hidden, loading],
  );
}

/** Keeps the app icon's number on the web tab title's total, live while the app runs; 0 once signed out. */
export function useAppIconBadge() {
  const orgId = useOrgId();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const { hidden, loading } = useHiddenAgents();
  const total =
    loading || !channels.data || !dms.data
      ? null
      : appBadgeCount({ channels: channels.data, dms: dms.data, hiddenAgents: hidden });
  useEffect(() => {
    if (total !== null) void Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [total]);
  // Signed out (the app's stack goes away): no workspace's number stays on the icon.
  useEffect(() => () => void Notifications.setBadgeCountAsync(0).catch(() => {}), []);
}

/** The badge of Threads: thread and mission rows with something unread. */
export function useUnreadThreads() {
  const orgId = useOrgId();
  // The same query as Conversas' list (shared cache); channels and DMs aren't needed for these rows.
  const threads = useThreadList(orgId, THREAD_LIST);
  return keptBy(unreadThreads, [threads.data], () =>
    unreadThreadCount(
      buildConversations({ channels: [], dms: [], threads: threads.data?.pages.flatMap((p) => p.threads) ?? [] }),
    ),
  );
}

/** Tarefas in Você: bold for a reply you haven't read in a task's conversation, its badge for a mention of you there. */
export function useTasksUnreadMarks() {
  return useTasksUnread(useOrgId());
}

const NO_APPROVALS: Approval[] = [];

/**
 * Requests you may decide now, the one closest to expiring first. The same array while the same requests wait: the
 * clock's tick re-reads it, and a list made anew each time redrew everything handed it.
 */
export function useWaitingApprovals() {
  const orgId = useOrgId();
  const approvals = useApprovals(orgId);
  const now = useNow();
  const before = useRef(NO_APPROVALS);
  return useMemo(() => {
    const next = waitingApprovals(approvals.data ?? [], now);
    const kept = before.current;
    if (next.length === kept.length && next.every((a, i) => a === kept[i])) return kept;
    before.current = next;
    return next;
  }, [approvals.data, now]);
}

/** The badge of Atividade: what waits on you (the inbox's own count, live through `notification.counts`). */
export function useWaitingCount() {
  const orgId = useOrgId();
  return useNotificationCount(orgId).data?.waiting ?? 0;
}
