import { createFileRoute } from "@tanstack/react-router";
import { ConnectorStorePage } from "@/components/ConnectorStore";
import { Main } from "@/components/Main";

/** The connectors store, a page of its own: `?service=` opens a service's page. */
export const Route = createFileRoute("/org/$orgId/connectors")({
  validateSearch: (search: Record<string, unknown>): { service?: string } => ({
    service: typeof search.service === "string" ? search.service : undefined,
  }),
  component: function ConnectorsRoute() {
    const { service } = Route.useSearch();
    return (
      <Main>
        <ConnectorStorePage service={service} />
      </Main>
    );
  },
});
