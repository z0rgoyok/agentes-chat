import { useLocalSearchParams } from "expo-router";
import { NewAgentStepScreen } from "@/features/agents/NewAgentScreen";

/**
 * Criar agente's "what it does" step, pushed after who it is, or from Revisar to change it (`?change=1`).
 */
export default function NewAgentInstructionsRoute() {
  const { change, tried } = useLocalSearchParams<{ change?: string; tried?: string }>();
  return <NewAgentStepScreen step="instructions" change={change === "1"} tried={tried === "1"} />;
}
