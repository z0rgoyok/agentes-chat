import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { DrivePage } from "@/pages/DrivePage";

/**
 * Drive: every artifact the viewer can see. `?artifact=…&v=…` opens one (shared links); `?open=…` its details;
 * `?folder=…` is the folder shown (the browser's back goes up the path).
 */
export const Route = createFileRoute("/org/$orgId/drive")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { artifact?: string; v?: number; open?: string | number; folder?: string } => ({
    ...openSearch(search),
    folder: typeof search.folder === "string" ? search.folder : undefined,
    artifact: typeof search.artifact === "string" ? search.artifact : undefined,
    v: typeof search.v === "number" && search.v > 0 ? search.v : undefined,
  }),
  component: function Page() {
    const { artifact, v, folder } = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <Main>
        <DrivePage
          open={artifact ? { id: artifact, version: v } : undefined}
          folder={folder ?? null}
          onFolder={(id) => void navigate({ search: (s) => ({ ...s, folder: id ?? undefined }) })}
        />
      </Main>
    );
  },
});
