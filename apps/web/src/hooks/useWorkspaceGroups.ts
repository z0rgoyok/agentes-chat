import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/context";
import { desktopListsWorkspaces, thisMac } from "@/lib/desktop";
import { type WorkspaceGroup, workspaceGroups } from "@/lib/workspaces";

/**
 * The workspace menu's "Your workspaces" in groups. In the desktop app (ADR 0154): this server's workspaces with their
 * unread counts, and every other server's the app reads, by server. Anywhere (ADR 0183): the workspaces of every
 * account signed in on this browser, by account. Null with one account outside the app (and in older apps): the menu
 * stays a plain list there.
 */
export function useWorkspaceGroups(input: {
  orgs: { id: string; name: string; logo?: string | null }[];
  currentOrgId: string;
}): WorkspaceGroup[] | null {
  const on = desktopListsWorkspaces();
  const api = useApi();
  const unread = useQuery({
    queryKey: ["me", "unread"],
    queryFn: () => api.account.unread(),
    enabled: on,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  // Asked while a menu that lists them is open: the hook lives in those menus.
  const accounts = useQuery({
    queryKey: ["me", "device-accounts"],
    queryFn: () => api.account.deviceAccounts(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const others = useQuery({
    queryKey: ["desktop", "workspaces"],
    queryFn: () => thisMac.workspaces(),
    enabled: on,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  // Whether this page's server is the one the app runs on this computer: named so, never by its address.
  const place = useQuery({
    queryKey: ["desktop", "thisMac"],
    queryFn: () => thisMac.status(),
    enabled: on,
    staleTime: 60_000,
  });
  if (!on && (accounts.data?.length ?? 0) < 2) return null;
  return workspaceGroups({
    here: window.location.origin,
    thisComputer: place.data?.local === true,
    desktop: on,
    orgs: input.orgs,
    currentOrgId: input.currentOrgId,
    unread: unread.data?.organizations ?? null,
    accounts: accounts.data ?? [],
    others: others.data ?? [],
  });
}
