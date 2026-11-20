import { ConnectAiPushed } from "@/features/ai/ConnectAi";

/** One plan's page of Connect an AI (`?choice=<plan>`): for which agent, and its sign-in on the agent's computer. */
export default function ConnectAiPlanRoute() {
  return <ConnectAiPushed page="plan" />;
}
