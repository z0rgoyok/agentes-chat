import type { ApiClient } from "@agenteschat/client";
import type { AgentLookInput } from "@/agent/looks";

/**
 * The agents' Live Activity (ADR 0210) is the iPhone's: `useLiveActivity.ios.ts` registers it. Everywhere else it does
 * nothing, and expo-widgets is never loaded.
 */
export function useLiveActivity(
  _api: ApiClient | null,
  _locale: string,
  _agents: readonly { id: string; look: AgentLookInput }[] | undefined,
): void {}
