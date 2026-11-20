import { ConnectAiPushed } from "@/features/ai/ConnectAi";

/** Connect an AI's plans, with a search, pushed from its first page ("Meu plano de IA"). */
export default function ConnectAiPlansRoute() {
  return <ConnectAiPushed page="plans" />;
}
