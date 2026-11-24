import { createFileRoute } from "@tanstack/react-router";
import { agentPanelSearch, threadSearch } from "@/lib/open-param";
import { prefetchDm } from "@/lib/prefetch";
import { DmPage } from "@/pages/DmPage";

/** Direct message with a person (sidebar "Mensagens diretas"). */
export const Route = createFileRoute("/org/$orgId/dm/person/$userId")({
  // `?m=<message>` opens the DM at that message (a search hit); `?thread=` is the one in its panel, `?agent=` the
  // agent's page there instead.
  validateSearch: (
    search: Record<string, unknown>,
  ): { m?: string } & ReturnType<typeof threadSearch> & ReturnType<typeof agentPanelSearch> => ({
    ...threadSearch(search),
    ...agentPanelSearch(search),
    ...(typeof search.m === "string" && search.m ? { m: search.m } : {}),
  }),
  // A DM already in my list opens with its messages read on the link's hover, and no round trip to find it.
  loader: ({ context: { queryClient, api }, params: { orgId, userId } }) =>
    prefetchDm(queryClient, api, orgId, "person", userId),
  component: function PersonDm() {
    const { userId } = Route.useParams();
    return <DmPage key={userId} target={{ userId }} focusMessageId={Route.useSearch().m} />;
  },
});
