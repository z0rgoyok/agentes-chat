import type { Channel, DirectMessage } from "../api/types";
import { hiddenDm } from "./audience";

/**
 * The conversations to load as soon as the app opens: unread ones first, then
 * the latest activity (channels I'm in and DMs), at most `count` channel ids.
 */
export function recentConversations(
  channels: readonly Channel[],
  dms: readonly DirectMessage[],
  count: number,
): string[] {
  const all = new Map<string, { at: string; unread: number }>();
  for (const c of channels) {
    if (c.isMember && c.lastMessage)
      all.set(c.id, { at: c.lastMessage.createdAt, unread: c.muted ? 0 : (c.unreadCount ?? 0) });
  }
  for (const d of dms) {
    if (d.lastMessage) all.set(d.channelId, { at: d.lastMessage.createdAt, unread: d.unread });
  }
  return [...all]
    .sort(([, a], [, b]) => Number(b.unread > 0) - Number(a.unread > 0) || b.at.localeCompare(a.at))
    .slice(0, count)
    .map(([id]) => id);
}

/** Where a DM sorts: its latest message, or when it began while it has none, so a new DM lands on top. */
export const dmActivityAt = (d: Pick<DirectMessage, "lastMessage" | "openedAt">) =>
  d.lastMessage?.createdAt ?? d.openedAt ?? null;

/** How long a DM nobody wrote in stays in the sidebar: no row can be closed, and every visit to a person opens one. */
export const EMPTY_DM_SHOWN_MS = 24 * 3600_000;

/**
 * The sidebar's "Mensagens diretas": latest activity first, DMs with agents hidden from me left out, and one with no
 * message only while it is new.
 */
export const recentDms = <D extends Pick<DirectMessage, "with" | "lastMessage" | "openedAt">>(
  dms: readonly D[],
  hiddenAgents?: ReadonlySet<string>,
  now = Date.now(),
): D[] =>
  dms
    .filter(
      (d) =>
        !hiddenDm(d, hiddenAgents) &&
        (d.lastMessage !== null || now - Date.parse(d.openedAt ?? "") < EMPTY_DM_SHOWN_MS),
    )
    .sort((a, b) => (dmActivityAt(b) ?? "").localeCompare(dmActivityAt(a) ?? ""));

/** Someone Mensagens diretas lists (ADR 0260): a person or an agent, by id and name. */
export interface DmListed {
  kind: "person" | "agent";
  id: string;
  name: string;
}

/**
 * Mensagens diretas with people and agents together (ADR 0260): `first` (the right hand) on top, then by their DM's
 * latest activity, then everyone with none by name. `recent` keeps only the ones talked to (as `recentDms` reads a DM),
 * and anyone whose DM has something unread.
 */
export function dmList<L extends DmListed>(
  listed: readonly L[],
  dms: readonly Pick<DirectMessage, "with" | "lastMessage" | "openedAt" | "unread">[],
  {
    show = "all",
    first,
    locale,
    now = Date.now(),
  }: { show?: "all" | "recent"; first?: string; locale?: string; now?: number } = {},
): L[] {
  const dmOf = new Map(dms.map((d) => [`${d.with.type}:${d.with.id}`, d]));
  const at = (l: L) => {
    const d = dmOf.get(`${l.kind}:${l.id}`);
    if (!d) return null;
    if (d.lastMessage || d.unread > 0) return dmActivityAt(d);
    return now - Date.parse(d.openedAt ?? "") < EMPTY_DM_SHOWN_MS ? dmActivityAt(d) : null;
  };
  const kept = show === "all" ? listed : listed.filter((l) => l.id === first || at(l) !== null);
  return [...kept].sort((a, b) => {
    if (a.id === first || b.id === first) return a.id === first ? -1 : 1;
    const x = at(a);
    const y = at(b);
    if (x && y) return y.localeCompare(x);
    if (x || y) return x ? -1 : 1;
    return a.name.localeCompare(b.name, locale);
  });
}
