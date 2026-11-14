import { useLocalSearchParams } from "expo-router";
import { AgentWhoScreen } from "@/features/roles/AgentsScreen";

/** Quem fala com an agent (`agentId`, from `roleId`), pushed over Agentes. */
export default function SettingsRoleAgentRoute() {
  const { roleId, agentId } = useLocalSearchParams<{ roleId: string; agentId: string }>();
  return <AgentWhoScreen roleId={roleId ?? ""} agentId={agentId ?? ""} />;
}
