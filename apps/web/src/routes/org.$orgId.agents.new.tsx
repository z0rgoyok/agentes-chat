import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "@/pages/NewAgentPage";

/**
 * The full form, a focused flow: the org layout leaves the sidebar out while it's open (see `org.$orgId.tsx`). The app
 * creates agents in the new agent's dialog (ADR 0164), an agent's proposal included; this page stays for the import and
 * a link that still names it. `?channel=` starts the agent in that channel.
 */
export const Route = createFileRoute("/org/$orgId/agents/new")({
  validateSearch: (search: Record<string, unknown>): { channel?: string } => ({
    channel: typeof search.channel === "string" ? search.channel : undefined,
  }),
  component: function NewAgent() {
    const { channel } = Route.useSearch();
    return <NewAgentPage channelId={channel ?? null} />;
  },
});
