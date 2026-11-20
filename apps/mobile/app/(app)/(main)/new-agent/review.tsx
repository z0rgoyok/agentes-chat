import { NewAgentStepScreen } from "@/features/agents/NewAgentScreen";

/** Criar agente's last step, Revisar, pushed after what it does: Criar makes the agent and leaves the whole flow. */
export default function NewAgentReviewRoute() {
  return <NewAgentStepScreen step="review" />;
}
