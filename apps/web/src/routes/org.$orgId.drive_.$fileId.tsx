import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { LiveFilePage, type LiveFileSearch } from "@/components/live/LiveFilePage";

/** Ids the editors write in the address (a sheet's, a slide's): plain, short. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A spreadsheet, a presentation or a canvas on a page of the app (ADR 0196 §9, ADR 0199), the sidebar beside it:
 * `?v=` shows a saved version read-only, `?sheet=` and `?slide=` where the editor is, `?present` presents (then the
 * window is the slide's alone), `?m=` opens the file's conversation at that message. Links to files stay
 * `/drive?artifact=…` (`filePath`): the Drive sends live files here.
 */
export const Route = createFileRoute("/org/$orgId/drive_/$fileId")({
  validateSearch: (search: Record<string, unknown>): LiveFileSearch => ({
    v: typeof search.v === "number" && Number.isInteger(search.v) && search.v > 0 ? search.v : undefined,
    sheet: typeof search.sheet === "string" && ID.test(search.sheet) ? search.sheet : undefined,
    slide: typeof search.slide === "string" && ID.test(search.slide) ? search.slide : undefined,
    present: search.present === true || search.present === "true" || search.present === 1 ? true : undefined,
    m: typeof search.m === "string" && ID.test(search.m) ? search.m : undefined,
  }),
  component: function Page() {
    const { fileId } = Route.useParams();
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    // The editor keeps the address in step with it: the entry is replaced, so Back leaves the file.
    const onSearch = useCallback(
      (patch: Partial<LiveFileSearch>) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true }),
      [navigate],
    );
    return (
      <main className="shell__main shell__main--chat lf-main">
        <LiveFilePage key={fileId} fileId={fileId} search={search} onSearch={onSearch} />
      </main>
    );
  },
});
