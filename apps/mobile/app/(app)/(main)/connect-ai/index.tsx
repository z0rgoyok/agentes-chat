import { ConnectAiStart } from "@/features/ai/ConnectAi";

/**
 * "Conectar uma IA": its first page, from Você, an agent's no-AI reply, the create-agent step or the computer being
 * ready (`?ready=1`). Each page after it is pushed over it (`connect-ai/*`).
 */
export default function ConnectAiRoute() {
  return <ConnectAiStart />;
}
