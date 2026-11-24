import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { openSearch } from "@/lib/open-param";
import { DrivePage } from "@/pages/DrivePage";

/** A message's id, as the address carries it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Drive: every artifact the viewer can see. `?artifact=…&v=…` opens one (shared links), `&m=…` a picture's, a video's
 * or a PDF's comments at that message (ADR 0208); `?open=…` its details; `?folder=…` is the folder shown (the
 * browser's back goes up the path).
 */
export const Route = createFileRoute("/org/$orgId/drive")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { artifact?: string; v?: number; m?: string; open?: string | number; folder?: string } => ({
    ...openSearch(search),
    folder: typeof search.folder === "string" ? search.folder : undefined,
    artifact: typeof search.artifact === "string" ? search.artifact : undefined,
    v: typeof search.v === "number" && search.v > 0 ? search.v : undefined,
    m: typeof search.m === "string" && ID.test(search.m) ? search.m : undefined,
  }),
  component: function Page() {
    const { artifact, v, m, folder } = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    return (
      <Main>
        <DrivePage
          open={artifact ? { id: artifact, version: v, at: m } : undefined}
          folder={folder ?? null}
          onFolder={(id) => void navigate({ search: (s) => ({ ...s, folder: id ?? undefined }) })}
        />
      </Main>
    );
  },
});
