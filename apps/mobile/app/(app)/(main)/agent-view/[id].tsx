import { useLocalSearchParams } from "expo-router";
import { AgentProfileScreen, type ProfileView } from "@/features/agents/AgentProfileScreen";
import { FocusLive } from "@/features/shared/parts";

const VIEWS: readonly ProfileView[] = ["access", "memory", "did"];

/** One part of an agent's profile on its own screen (`?v=access|memory|did`), pushed from the profile's Details. */
export default function AgentViewRoute() {
  const { id, v } = useLocalSearchParams<{ id: string; v?: string }>();
  const view = VIEWS.find((x) => x === v) ?? "access";
  return (
    <FocusLive>
      <AgentProfileScreen key={`${id}:${view}`} id={id} view={view} />
    </FocusLive>
  );
}
