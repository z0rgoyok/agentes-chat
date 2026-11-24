import { useMembers } from "@agenteschat/client";
import { useMemo } from "react";
import { useOrg } from "@/components/org-context";

const NONE: readonly string[] = [];

/**
 * The roles I hold here (not `everyone`), from the members list: an agent one of them answers for is mine too (ADR
 * 0085, addendum of 2026-11-21; `ownsAgentAs`). Lighter than `useDirectory` for a row or a button that only asks this.
 */
export function useMyRoleIds(): readonly string[] {
  const { org, me } = useOrg();
  const members = useMembers(org.id);
  return useMemo(() => members.data?.find((m) => m.userId === me.user.id)?.roleIds ?? NONE, [members.data, me.user.id]);
}
