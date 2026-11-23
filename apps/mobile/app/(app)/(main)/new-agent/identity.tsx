import { useLocalSearchParams } from "expo-router";
import { NewAgentStepScreen } from "@/features/agents/NewAgentScreen";

/**
 * Criar agente's "who it is" step, pushed after the role, or from Revisar to change it (`?change=1`, with `?tried=1`
 * when Criar found it can't go on yet).
 */
export default function NewAgentIdentityRoute() {
  const { change, tried } = useLocalSearchParams<{ change?: string; tried?: string }>();
  return <NewAgentStepScreen step="identity" change={change === "1"} tried={tried === "1"} />;
}
