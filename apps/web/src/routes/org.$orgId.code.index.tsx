import { createFileRoute } from "@tanstack/react-router";
import { CodeHome } from "@/components/code/CodeHome";
import { CodePage } from "@/components/code/CodePage";

/** Code (ADR 0215): the home, where a session starts (the field in the agents' sky). */
export const Route = createFileRoute("/org/$orgId/code/")({
  component: () => (
    <CodePage activeId={null}>
      <CodeHome />
    </CodePage>
  ),
});
