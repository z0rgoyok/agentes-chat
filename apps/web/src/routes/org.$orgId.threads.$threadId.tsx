import { threadAnchor } from "@agenteschat/client/lib/threads";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentPanelSearch, threadInConversationSearch } from "@/lib/open-param";
import { threadInConversation } from "@/lib/prefetch";
import { ThreadPage } from "@/pages/ThreadPage";

/**
 * A thread's link. A channel's or a DM's thread opens in its conversation, at its root, in the panel beside it (Back
 * goes to where the link was); a mission's, a task's and a file's keep this page (ADR 0029).
 * `?reply=true` focuses the composer; `?m=<message>` opens at that card
 * (Aprovações → "Esperando você em missões"); `?agent=` is the agent's page in its panel.
 */
export const Route = createFileRoute("/org/$orgId/threads/$threadId")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { reply?: boolean; m?: string } & ReturnType<typeof agentPanelSearch> => ({
    ...agentPanelSearch(search),
    ...(search.reply === true || search.reply === "true" ? { reply: true } : {}),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
  }),
  loaderDeps: ({ search: { reply, m } }) => ({ reply, m }),
  loader: async ({ context: { queryClient, api }, params: { orgId, threadId }, deps }) => {
    const thread = await threadInConversation(queryClient, api, orgId, threadId);
    if (!thread) return;
    throw redirect({
      to: "/org/$orgId/c/$channelId",
      params: { orgId, channelId: thread.channelId },
      search: threadInConversationSearch(threadId, threadAnchor(thread), { focus: deps.m, reply: deps.reply }),
      replace: true,
    });
  },
  component: function Thread() {
    const { reply, m } = Route.useSearch();
    return <ThreadPage threadId={Route.useParams().threadId} reply={reply} focusMessageId={m} />;
  },
});
