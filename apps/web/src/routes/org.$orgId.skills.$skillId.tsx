import { createFileRoute } from "@tanstack/react-router";
import { Main } from "@/components/Main";
import { SkillPage } from "@/components/skills/SkillPage";

/** A skill's page: what it teaches, who knows it, where it was used and what changed. */
export const Route = createFileRoute("/org/$orgId/skills/$skillId")({
  component: function SkillRoute() {
    const { skillId } = Route.useParams();
    return (
      <Main>
        <SkillPage key={skillId} id={skillId} />
      </Main>
    );
  },
});
