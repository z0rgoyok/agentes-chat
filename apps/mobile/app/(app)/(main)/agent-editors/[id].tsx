import { useLocalSearchParams } from "expo-router";
import { AgentEditorsScreen } from "@/features/agents/AgentEditorsScreen";

/** An agent's "Who can edit" (ADR 0085 addendum of 2026-11-17), pushed from its Edit screen. */
export default function AgentEditorsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AgentEditorsScreen key={id} agentId={id ?? ""} />;
}
