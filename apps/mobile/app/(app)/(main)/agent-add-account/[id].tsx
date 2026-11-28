import { useLocalSearchParams } from "expo-router";
import { AgentAddAccountScreen } from "@/features/ai/AgentAddAccountScreen";

/** "Add account" for an agent, pushed from the end of its AI's account list. */
export default function AgentAddAccountRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentAddAccountScreen agentId={id ?? ""} />;
}
