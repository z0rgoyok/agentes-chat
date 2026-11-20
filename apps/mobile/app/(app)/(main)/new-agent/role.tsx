import { useLocalSearchParams } from "expo-router";
import { NewAgentStepScreen } from "@/features/agents/NewAgentScreen";

/**
 * Criar agente's role, opened from Revisar to change it (`?change=1`); picking one goes back there.
 */
export default function NewAgentRoleRoute() {
  const { change, tried } = useLocalSearchParams<{ change?: string; tried?: string }>();
  return <NewAgentStepScreen step="role" change={change === "1"} tried={tried === "1"} />;
}
