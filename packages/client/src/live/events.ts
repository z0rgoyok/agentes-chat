import type { QueryClient } from "@tanstack/react-query";
import { liveKeys } from "./queries";

/** Channel event: who is in one of the conversation's live files changed (ADR 0196 §5; ids only). */
export const LIVE_PRESENCE = "live.presence";

/**
 * A live file's event from the realtime socket: `live.presence` asks again who is in the cards that show that file
 * (every presence query of the workspace when the event names none). True when it was one. The web
 * (`realtime/context.tsx`) and the phone call it with every channel event, like `applyDashboardEvent`.
 */
export function applyLiveEvent(qc: QueryClient, orgId: string, event: { type: string }): boolean {
  if (event.type !== LIVE_PRESENCE) return false;
  const artifactId = (event as { artifactId?: unknown }).artifactId;
  const id = typeof artifactId === "string" && artifactId.length > 0 ? artifactId : null;
  void qc.invalidateQueries({
    queryKey: liveKeys.presenceAll(orgId),
    predicate: (query) => {
      if (!id) return true;
      const ids = query.queryKey[4];
      return typeof ids === "string" && ids.split(",").includes(id);
    },
  });
  return true;
}
