import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SkillsPage } from "@/components/skills/SkillsPage";

/**
 * Skills, a page of its own: what the team knows. `?for=<agent>` shows it for one agent (what it knows, what it could
 * learn); `?teach=1` opens "Teach something new"; `?install=<link>` (with `connected`, `agent`) comes back from
 * connecting GitHub while reading a link.
 */
export const Route = createFileRoute("/org/$orgId/skills/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { for?: string; teach?: 1; install?: string; connected?: string; agent?: string } => ({
    for: typeof search.for === "string" ? search.for : undefined,
    teach: search.teach === undefined ? undefined : 1,
    install: typeof search.install === "string" ? search.install : undefined,
    connected: typeof search.connected === "string" ? search.connected : undefined,
    agent: typeof search.agent === "string" ? search.agent : undefined,
  }),
  component: function SkillsRoute() {
    const search = Route.useSearch();
    return (
      <Main>
        <SkillsPage
          key={search.for ?? ""}
          forAgentId={search.for}
          teach={search.teach !== undefined}
          install={search.install}
          connected={search.connected}
          agent={search.agent}
        />
      </Main>
    );
  },
});
