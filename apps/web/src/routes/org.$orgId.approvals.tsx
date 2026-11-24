import { createFileRoute, redirect } from "@tanstack/react-router";
import { openSearch } from "@/lib/open-param";

/**
 * Requests are decided in the inbox: links to the page they once had (`?open=<id>`: one request) open the inbox on
 * that request, or on the decided ones.
 */
export const Route = createFileRoute("/org/$orgId/approvals")({
  validateSearch: openSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/org/$orgId/notifications",
      params,
      search: typeof search.open === "string" ? { approval: search.open } : { filter: "waiting" },
      replace: true,
    });
  },
});
