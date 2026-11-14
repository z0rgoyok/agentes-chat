import type { DeviceAccount } from "@agenteschat/client";
import { CLOUD_SERVER, serverHost } from "@agenteschat/client/lib/server";

/**
 * The workspace menu's "Your workspaces" by server and by account. In the desktop app (ADR 0154): this server's
 * workspaces and every other server's the app reads with its own session (`thisMac.workspaces`), each with its unread
 * count. Anywhere (ADR 0183): the workspaces of every account signed in on this browser, by account.
 */

/** A workspace of another server, as the desktop app read it (`workspaces.rs`). */
export interface DesktopWorkspace {
  id: string;
  name: string;
  /** A data URL; null shows the workspace's mark. */
  logo: string | null;
  unread: number;
  waiting: number;
}

/** One of a server's accounts signed in on the app's window, as the desktop app read it (ADR 0183). */
export interface DesktopAccountWorkspaces {
  userId: string;
  name: string;
  email: string;
  /** The account the window is on at that server. */
  current: boolean;
  orgs: DesktopWorkspace[];
}

export interface DesktopServerWorkspaces {
  server: string;
  signedIn: boolean;
  /** The workspaces of the account the window is on there. */
  orgs: DesktopWorkspace[];
  /** Every account signed in there, the window's own first. Absent in older apps and from older servers. */
  accounts?: DesktopAccountWorkspaces[];
  /** It didn't answer since this time (milliseconds since 1970): its last answer, kept. Absent: it answered. */
  offlineSince?: number;
  /** The server the app runs on this computer (also at its Tailscale address). Absent in older apps. */
  here?: boolean;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  logo: string | null;
  unread: number;
  /** The workspace open now. */
  current: boolean;
}

export interface WorkspaceGroup {
  /** The server's origin. */
  server: string;
  /** "agentes.chat" for the Cloud, its host otherwise (the app's own server is named by what it is instead). */
  name: string;
  cloud: boolean;
  /** The server this page is on, as the account the browser is on: its workspaces open in place. */
  here: boolean;
  /**
   * Whose workspaces these are, when the server said (ADR 0183); null from an older app or server. On this page's
   * server and not `here`: another account signed in on this browser, one switch away.
   */
  account: { userId: string; name: string; email: string } | null;
  /** This page's server (as any of the browser's accounts). */
  sameServer: boolean;
  /** The server has more than one account listed: each group says whose it is. */
  several: boolean;
  /** In the desktop app, which lists every server (ADR 0154). */
  desktop: boolean;
  /** The server the app runs on this computer, at whichever address: named as such, never by its address. */
  thisComputer: boolean;
  /**
   * `signedOut`: the app has no session there (no workspaces listed, Sign in); `offline`: it didn't answer since
   * `offlineSince`, its last workspaces shown dimmed.
   */
  state: "ok" | "signedOut" | "offline";
  offlineSince: number | null;
  rows: WorkspaceRow[];
}

/** How a server reads in the menu: agentes.chat for the Cloud, its host otherwise. */
export const serverLabel = (server: string) => (server === CLOUD_SERVER ? "agentes.chat" : serverHost(server));

/**
 * Whether the workspace menus offer New workspace, made on the server open now: when the person may make one there (on
 * agentes.chat Cloud, while sign-up is by invitation, only an invitation does, ADR 0078). In the desktop app (`groups`)
 * on agentes.chat, Add workspace makes one instead; its window can't make one on a server of one's own.
 */
export const offersNewWorkspace = (canCreateWorkspace: boolean | undefined, groups: WorkspaceGroup[] | null) =>
  canCreateWorkspace !== false && !groups?.some((g) => g.here && g.cloud && g.desktop);

/**
 * This server's group first (its workspaces from `me`, its counts from `/me/unread` when it answered), then the other
 * accounts signed in on this browser (`accounts`, ADR 0183), then each other server of the app, in its order and by
 * account where it said them: signed in with workspaces, signed out there (to sign in again), or not answering (its
 * last workspaces, marked). One signed in with no workspace isn't listed, unless it is another account of this
 * browser (the way to it). `thisComputer`: this page's server is the one the app runs on this computer.
 */
export function workspaceGroups(input: {
  here: string;
  thisComputer?: boolean;
  /** In the desktop app (the default, as before accounts). */
  desktop?: boolean;
  orgs: { id: string; name: string; logo?: string | null }[];
  currentOrgId: string;
  unread: { orgId: string; unread: number }[] | null;
  /** The accounts signed in on this browser, the current one included; empty: only the current one is known. */
  accounts?: DeviceAccount[];
  others: DesktopServerWorkspaces[];
}): WorkspaceGroup[] {
  const desktop = input.desktop !== false;
  const accounts = input.accounts ?? [];
  const current = accounts.find((a) => a.current) ?? null;
  const elsewhere = accounts.filter((a) => !a.current);
  const counts = new Map((input.unread ?? current?.unread ?? []).map((u) => [u.orgId, u.unread]));
  const base = {
    server: input.here,
    name: serverLabel(input.here),
    cloud: input.here === CLOUD_SERVER,
    thisComputer: input.thisComputer === true,
    state: "ok" as const,
    offlineSince: null,
    sameServer: true,
    several: elsewhere.length > 0,
    desktop,
  };
  const who = (a: { user: { id: string; name: string; email: string } }) => ({
    userId: a.user.id,
    name: a.user.name,
    email: a.user.email,
  });
  const mine: WorkspaceGroup = {
    ...base,
    here: true,
    account: current ? who(current) : null,
    rows: input.orgs.map((o) => ({
      id: o.id,
      name: o.name,
      logo: o.logo ?? null,
      unread: counts.get(o.id) ?? 0,
      current: o.id === input.currentOrgId,
    })),
  };
  const theirs = elsewhere.map((a): WorkspaceGroup => {
    const unread = new Map(a.unread.map((u) => [u.orgId, u.unread]));
    return {
      ...base,
      here: false,
      account: who(a),
      rows: a.organizations.map((o) => ({
        id: o.id,
        name: o.name,
        logo: o.logo ?? null,
        unread: unread.get(o.id) ?? 0,
        current: false,
      })),
    };
  });
  const others = input.others
    .filter((s) => s.server !== input.here && (!s.signedIn || s.orgs.length > 0 || (s.accounts?.length ?? 0) > 1))
    .flatMap((s): WorkspaceGroup[] => {
      const group = {
        server: s.server,
        name: serverLabel(s.server),
        cloud: s.server === CLOUD_SERVER,
        here: false,
        thisComputer: s.here === true,
        state:
          s.offlineSince !== undefined ? ("offline" as const) : s.signedIn ? ("ok" as const) : ("signedOut" as const),
        offlineSince: s.offlineSince ?? null,
        sameServer: false,
        desktop,
      };
      const rows = (orgs: DesktopWorkspace[]) =>
        orgs.map((o) => ({ id: o.id, name: o.name, logo: o.logo, unread: o.unread, current: false }));
      const listed = s.signedIn ? (s.accounts ?? []).filter((a) => a.orgs.length > 0) : [];
      if (listed.length === 0)
        return [{ ...group, account: null, several: false, rows: s.signedIn ? rows(s.orgs) : [] }];
      return listed.map((a) => ({
        ...group,
        account: { userId: a.userId, name: a.name, email: a.email },
        several: listed.length > 1,
        rows: rows(a.orgs),
      }));
    });
  return [mine, ...theirs, ...others];
}
