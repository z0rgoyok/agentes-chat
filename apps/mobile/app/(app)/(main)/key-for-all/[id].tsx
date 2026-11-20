import { useLocalSearchParams } from "expo-router";
import { KeyForAllScreen } from "@/features/ai/KeyForAllScreen";

/** "Usar em todos os agentes" (from a coding plan key's actions in Contas de IA): one of its models for every agent. */
export default function KeyForAllRoute() {
  const { id, machineId, model } = useLocalSearchParams<{ id: string; machineId: string; model?: string }>();
  return <KeyForAllScreen accountId={id ?? ""} machineId={machineId ?? ""} model={model} />;
}
