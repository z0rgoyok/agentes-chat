import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute } from "@tanstack/react-router";
import { agentPanelSearch, threadSearch } from "@/lib/open-param";
import { prefetchChannel } from "@/lib/prefetch";
import { ChannelPage } from "@/pages/ChannelPage";

type PanelSearch = ReturnType<typeof threadSearch> & ReturnType<typeof agentPanelSearch>;

/**
 * A channel; `?m={messageId}` (from "Copiar link") opens it at that message;
 * `?adjust={threadId}` opens "Ajustar trecho" for that thread's range; `?thread=` is the one in its panel, `?agent=`
 * the agent's page there instead; `?paid`: back from paying for the workspace, which opens in #general (the hold
 * banner says the payment is being confirmed).
 */
export const Route = createFileRoute("/org/$orgId/c/$channelId")({
  validateSearch: (search: Record<string, unknown>): { m?: string; adjust?: string; paid?: true } & PanelSearch => ({
    ...threadSearch(search),
    ...agentPanelSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
    ...(typeof search.adjust === "string" && search.adjust ? { adjust: search.adjust } : {}),
    ...(isPaidReturn(search) ? { paid: true as const } : {}),
  }),
  // What the channel opens with, all at once; a hover on a link starts it too (`defaultPreload: "intent"`).
  loader: ({ context: { queryClient, api }, params: { orgId, channelId } }) =>
    prefetchChannel(queryClient, api, orgId, channelId),
  component: function Channel() {
    const { m, adjust } = Route.useSearch();
    return <ChannelPage channelId={Route.useParams().channelId} focusMessageId={m} adjustThreadId={adjust} />;
  },
});
