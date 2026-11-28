import {
  type SidebarPins,
  useAgentGroups,
  useChannels,
  useDms,
  useSetSidebarView,
  useSidebarView,
} from "@agenteschat/client";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  dayOnePins,
  type FavoriteKind,
  favoriteKey,
  favoritesOf,
  type PinKind,
  toggleFavorite,
} from "@agenteschat/client/lib/sidebar-view";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { useToast } from "@/ui";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";

/** A row's kind of pin, as a favorite's (ADR 0260). */
const KIND: Record<PinKind, FavoriteKind> = { agents: "agent", channels: "channel", people: "person" };

/** Whether two lists hold the same keys in the same order. */
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Favoritos (ADR 0260), the web sidebar's on the phone: the same per-person list (`…/me/sidebar/view`), on Conversas'
 * strip (`PinnedStrip`) in its order and on top of Agentes' Livres. Never saved, it starts from the pins of before,
 * else the person's own agents. The same object while the favorites stay the same, so what is memoized on them holds.
 */
export function usePins(): {
  /** Favoritos as keys (`agent:<id>`, `channel:<id>`, `person:<user id>`), in the person's order. */
  favorites: readonly string[];
  /** Each kind's favorite ids, for a list that puts them on top of its own. */
  pins: SidebarPins;
  /** The person chose these favorites (false: day one's default, the agents they made, nothing they did). */
  chosen: boolean;
  isPinned: (kind: PinKind, id: string) => boolean;
  toggle: (kind: PinKind, id: string) => void;
} {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const toast = useToast();
  const dir = useDirectory();
  const dms = useDms(orgId).data;
  const groups = useAgentGroups(orgId).data;
  const channels = useChannels(orgId).data;
  const view = useSidebarView(orgId);
  const setView = useSetSidebarView(orgId);
  const kept = useRef<string[] | null>(null);
  const shown = useMemo(() => {
    const lastActive = new Map<string, string>();
    for (const d of dms ?? [])
      if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
    const listed = dir.agents.filter((a) => listsAgent(org, a));
    const dayOne = meId
      ? dayOnePins(
          listed.filter((a) => !isRightHand(a)),
          meId,
          lastActive,
          groups,
        )
      : [];
    // A favorite of something no longer in these lists holds no place.
    const known = {
      agent: listed.map((a) => a.id),
      channel: channels?.filter((c) => c.isMember || c.visibility === "public").map((c) => c.id),
      person: [...dir.memberById.keys()],
    };
    const next = favoritesOf(view, dayOne, known);
    // A DM's new message reorders day one's candidates without changing the favorites: the list of before stays.
    const favorites = kept.current && sameList(kept.current, next) ? kept.current : next;
    kept.current = favorites;
    const ids = (kind: FavoriteKind) =>
      favorites.flatMap((key) => (key.startsWith(`${kind}:`) ? [key.slice(kind.length + 1)] : []));
    return {
      favorites,
      pins: { agents: ids("agent"), channels: ids("channel"), people: ids("person") },
      dayOne,
      known,
    };
  }, [dms, dir.agents, dir.memberById, org, meId, groups, channels, view]);
  // `toggle` reads the latest of these: one function for every render.
  const latest = useRef({ shown, setView, t, toast });
  latest.current = { shown, setView, t, toast };
  const toggle = useCallback((kind: PinKind, id: string) => {
    const at = latest.current;
    const key = favoriteKey(KIND[kind], id);
    if (!toggleFavorite(at.shown.favorites, key)) {
      at.toast({ title: at.t("sidebarFavorites.full"), icon: "star" });
      return;
    }
    at.setView((now) => {
      const from = favoritesOf(now, at.shown.dayOne, at.shown.known);
      return { ...now, favorites: toggleFavorite(from, key) ?? from };
    });
  }, []);
  const chosen = view.favorites != null || view.pins != null;
  return useMemo(
    () => ({
      favorites: shown.favorites,
      pins: shown.pins,
      chosen,
      isPinned: (kind: PinKind, id: string) => shown.favorites.includes(favoriteKey(KIND[kind], id)),
      toggle,
    }),
    [shown.favorites, shown.pins, chosen, toggle],
  );
}
