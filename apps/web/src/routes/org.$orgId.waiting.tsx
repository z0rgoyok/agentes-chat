import { createFileRoute, redirect } from "@tanstack/react-router";

/** What waits on me is the inbox's top and one of its filters: links to the page it once had open the inbox there. */
export const Route = createFileRoute("/org/$orgId/waiting")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$orgId/notifications", params, search: { filter: "waiting" }, replace: true });
  },
});
