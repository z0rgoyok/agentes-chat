import {
  type ApiClient,
  agentGroupsQuery,
  agentsQuery,
  type Channel,
  channelMembersQuery,
  channelsQuery,
  channelThreadsQuery,
  type DirectMessage,
  dmsQuery,
  formerAgentsQuery,
  keys,
  membersQuery,
  messagesQuery,
  rolesQuery,
  sidebarItemsQuery,
  type ThreadInfo,
} from "@agenteschat/client";
import { opensInConversation } from "@agenteschat/client/lib/threads";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Route loaders' reads: they run on a link's hover (`defaultPreload: "intent"`) and on the navigation itself, are never
 * awaited (the page shows at once and fills in), and ask only for what isn't fresh in the cache already.
 */

/**
 * What the workspace's shell draws from before anything in it shows (the sidebar's lists, and the people and agents
 * every row names), asked for with the page's own reads rather than once the shell's code has loaded and drawn.
 */
export function prefetchShell(qc: QueryClient, api: ApiClient, orgId: string) {
  void qc.prefetchQuery(channelsQuery(api, orgId));
  void qc.prefetchQuery(dmsQuery(api, orgId));
  // A channel in a sector (ADR 0240) would show under Canais until the sectors are in.
  void qc.prefetchQuery(agentGroupsQuery(api, orgId));
  void qc.prefetchQuery(sidebarItemsQuery(api, orgId));
  void qc.prefetchQuery(membersQuery(api, orgId));
  void qc.prefetchQuery(agentsQuery(api, orgId));
  void qc.prefetchQuery(formerAgentsQuery(api, orgId));
  void qc.prefetchQuery(rolesQuery(api, orgId));
}

/** What a conversation opens with, all at once instead of one after another. */
export function prefetchConversation(qc: QueryClient, api: ApiClient, orgId: string, channelId: string) {
  void qc.prefetchQuery(messagesQuery(api, orgId, channelId));
  void qc.prefetchQuery(channelMembersQuery(api, orgId, channelId));
  void qc.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "all"));
  void qc.prefetchQuery(channelThreadsQuery(api, orgId, channelId, "archived"));
}

/**
 * A channel's reads, only for a channel I'm in (the server refuses the rest until I join). With the channel list
 * cached (the sidebar's) that is known at once; without it (a cold open of a channel's address) the list and the
 * messages are read side by side rather than one after the other: a refused read of a channel I'm not in is
 * harmless (its page doesn't read the messages until I join).
 */
export function prefetchChannel(qc: QueryClient, api: ApiClient, orgId: string, channelId: string) {
  const channels = qc.getQueryData<Channel[]>(keys.channels(orgId));
  if (channels) {
    if (channels.some((c) => c.id === channelId && c.isMember)) prefetchConversation(qc, api, orgId, channelId);
    void qc.prefetchQuery(channelsQuery(api, orgId));
    return;
  }
  void qc.prefetchQuery(channelsQuery(api, orgId));
  prefetchConversation(qc, api, orgId, channelId);
}

/** The DM page's own query (`DmPage`): which conversation a DM with this agent or person is. */
export const dmKey = (orgId: string, kind: "agent" | "person", id: string) => ["org", orgId, "dm", kind, id] as const;

/**
 * A DM already in my list needs no `POST /dms` (which opens one) to know its conversation: the page's query gets it
 * from the list, and its messages are read now. A DM not in the list is opened by its page, as before; a hover never
 * opens one.
 */
export function prefetchDm(qc: QueryClient, api: ApiClient, orgId: string, kind: "agent" | "person", id: string) {
  const known = qc
    .getQueryData<DirectMessage[]>(keys.dms(orgId))
    ?.find((d) => d.with.type === kind && d.with.id === id);
  if (!known) {
    void qc.prefetchQuery(dmsQuery(api, orgId));
    return;
  }
  const key = dmKey(orgId, kind, id);
  if (qc.getQueryData(key) === undefined) qc.setQueryData(key, { channelId: known.channelId });
  prefetchConversation(qc, api, orgId, known.channelId);
}

/** A thread's header and state (`useThreadInfo`), read on the link's hover. */
export function prefetchThread(qc: QueryClient, api: ApiClient, orgId: string, threadId: string) {
  void qc.prefetchQuery({
    queryKey: keys.threadInfo(orgId, threadId),
    queryFn: () => api.threads.get(orgId, threadId),
    staleTime: 15_000,
  });
}

/**
 * The thread a link names, when it opens in its conversation (`opensInConversation`) and that conversation is in my
 * lists (an archived channel's isn't: its page would say it isn't there): read once unless held already (awaited:
 * where it lives decides the page). Null: its own page, which also says when a thread is gone.
 */
export async function threadInConversation(
  qc: QueryClient,
  api: ApiClient,
  orgId: string,
  threadId: string,
): Promise<ThreadInfo | null> {
  const [thread, channels, dms] = await Promise.all([
    qc
      .ensureQueryData({
        queryKey: keys.threadInfo(orgId, threadId),
        queryFn: () => api.threads.get(orgId, threadId),
        staleTime: 15_000,
      })
      .catch(() => null),
    qc.ensureQueryData(channelsQuery(api, orgId)).catch((): Channel[] => []),
    qc.ensureQueryData(dmsQuery(api, orgId)).catch((): DirectMessage[] => []),
  ]);
  if (!thread || !opensInConversation(thread)) return null;
  const listed = channels.some((c) => c.id === thread.channelId) || dms.some((d) => d.channelId === thread.channelId);
  return listed ? thread : null;
}
