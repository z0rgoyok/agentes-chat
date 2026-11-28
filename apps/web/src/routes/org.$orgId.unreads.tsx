import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { UnreadsPage } from "@/pages/UnreadsPage";

/** Não lidas (ADR 0260): what waits for the person in the inbox and every conversation with unread messages. */
export const Route = createFileRoute("/org/$orgId/unreads")({
  component: () => (
    <Main>
      <UnreadsPage />
    </Main>
  ),
});
