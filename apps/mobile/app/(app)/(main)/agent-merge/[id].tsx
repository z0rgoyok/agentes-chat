import { useLocalSearchParams } from "expo-router";
import { MergeReposScreen } from "@/features/agents/MergeReposSection";

/** Where an agent merges without asking, pushed from its row on Access or Advanced. */
export default function AgentMergeRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <MergeReposScreen key={id} agentId={id ?? ""} />;
}
