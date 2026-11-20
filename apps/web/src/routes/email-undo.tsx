import { createFileRoute } from "@tanstack/react-router";
import { EmailUndoPage, SurfaceUndoPage } from "@/pages/EmailUndoPage";

/**
 * Where an email's undo lands (`?token=`): the notice to an account's old address (“This wasn't me”), or with
 * `kind=surface` the one that says a chat app was linked (ADR 0187).
 */
export const Route = createFileRoute("/email-undo")({
  validateSearch: (search: Record<string, unknown>): { token?: string; kind?: "surface" } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    kind: search.kind === "surface" ? "surface" : undefined,
  }),
  component: function EmailUndo() {
    const { token, kind } = Route.useSearch();
    return kind === "surface" ? <SurfaceUndoPage token={token} /> : <EmailUndoPage token={token} />;
  },
});
