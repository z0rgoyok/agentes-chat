import { createFileRoute } from "@tanstack/react-router";
import { EmailUndoPage } from "@/pages/EmailUndoPage";

/** Where the notice to an account's old address lands: “This wasn't me” (`?token=`). */
export const Route = createFileRoute("/email-undo")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: function EmailUndo() {
    const { token } = Route.useSearch();
    return <EmailUndoPage token={token} />;
  },
});
