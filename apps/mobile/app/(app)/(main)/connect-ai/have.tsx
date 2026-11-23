import { ConnectAiPushed } from "@/features/ai/ConnectAi";

/** Every account already connected for the agent ("Ver as N contas"), pushed from the first page: one tap uses it. */
export default function ConnectAiHaveRoute() {
  return <ConnectAiPushed page="have" />;
}
