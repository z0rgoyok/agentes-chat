import { createFileRoute } from "@tanstack/react-router";
import { SurfacePage } from "@/pages/SurfacePage";

/** Where a link sent on the outside chat surface lands (`?token=`, ADR 0226): one action to confirm with the PIN. */
export const Route = createFileRoute("/surface-page")({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: function SurfacePageRoute() {
    return <SurfacePage token={Route.useSearch().token} />;
  },
});
