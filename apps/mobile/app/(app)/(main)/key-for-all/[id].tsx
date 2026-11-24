import { useLocalSearchParams } from "expo-router";
import { AgentSetupScreen } from "@/features/ai/AgentSetupScreen";

/** "Usar em todos os agentes" (a coding plan key's actions, a reply's stand-in model): "Usar em outros agentes" on it. */
export default function KeyForAllRoute() {
  const { id, machineId, model } = useLocalSearchParams<{ id: string; machineId: string; model?: string }>();
  return <AgentSetupScreen account={{ id: id ?? "", machineId: machineId ?? "", model }} />;
}
