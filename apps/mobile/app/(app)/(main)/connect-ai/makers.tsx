import { ConnectAiPushed } from "@/features/ai/ConnectAi";

/** Whose API key, pushed from the key's page: picking a maker goes back to it. */
export default function ConnectAiMakersRoute() {
  return <ConnectAiPushed page="makers" />;
}
