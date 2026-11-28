import { createFileRoute } from "@tanstack/react-router";
import { EmailUndoPage, SurfacePinResetPage, SurfaceUndoPage } from "@/pages/EmailUndoPage";

/**
 * Where an email's undo lands (`?token=`): the notice to an account's old address (“This wasn't me”), or with
 * `kind=surface` the one that says a chat app was linked (ADR 0187), or with `kind=surface-pin` the one that chooses the
 * PIN that confirms actions from it (ADR 0226).
 */
export const Route = createFileRoute("/email-undo")({
  validateSearch: (search: Record<string, unknown>): { token?: string; kind?: "surface" | "surface-pin" } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    kind: search.kind === "surface" || search.kind === "surface-pin" ? search.kind : undefined,
  }),
  component: function EmailUndo() {
    const { token, kind } = Route.useSearch();
    if (kind === "surface-pin") return <SurfacePinResetPage token={token} />;
    return kind === "surface" ? <SurfaceUndoPage token={token} /> : <EmailUndoPage token={token} />;
  },
});
