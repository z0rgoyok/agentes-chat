import { createFileRoute } from "@tanstack/react-router";
import { agentPanelSearch } from "@/lib/open-param";
import { ThreadPage } from "@/pages/ThreadPage";

/**
 * A thread: its context, its conversation and its controls (ADR 0029).
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
  component: function Thread() {
    const { reply, m } = Route.useSearch();
    return <ThreadPage threadId={Route.useParams().threadId} reply={reply} focusMessageId={m} />;
  },
});
