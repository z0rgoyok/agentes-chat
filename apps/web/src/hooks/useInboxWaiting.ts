import { useNotificationCount, useNotifications } from "@agenteschat/client";
import { allItems } from "@agenteschat/client/lib/notifications";

/**
 * How many things wait on me in the inbox: what the notifications count, less an older notice that proposals wait on
 * me. Agents apply their improvements themselves now (ADR 0219), so the inbox doesn't list that notice.
 */
export function useInboxWaiting(orgId: string): number {
  const waiting = useNotificationCount(orgId).data?.waiting ?? 0;
  const list = useNotifications(orgId, "waiting");
  const notice = allItems(list.data).some((n) => n.kind === "proposal_waiting" && n.waiting && !n.doneAt);
  return Math.max(0, waiting - (notice ? 1 : 0));
}
