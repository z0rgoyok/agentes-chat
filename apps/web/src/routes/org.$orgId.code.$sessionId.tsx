import { createFileRoute } from "@tanstack/react-router";
import { CodePage } from "@/components/code/CodePage";
import { CodeSessionView } from "@/components/code/CodeSessionView";

/** Code (ADR 0215): one session, its conversation and its side panel (Diff, Screen, Terminal). */
export const Route = createFileRoute("/org/$orgId/code/$sessionId")({
  component: function Page() {
    const { sessionId } = Route.useParams();
    return (
      <CodePage activeId={sessionId}>
        <CodeSessionView key={sessionId} sessionId={sessionId} />
      </CodePage>
    );
  },
});
