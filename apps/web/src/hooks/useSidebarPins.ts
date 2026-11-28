import type { SidebarPins } from "@agenteschat/client";
import { useAgentGroups, useChannels, useDms, useSetSidebarView, useSidebarView } from "@agenteschat/client";
import { hiddenAgentIds } from "@agenteschat/client/lib/audience";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import {
  dayOnePins,
  type FavoriteKind,
  favoriteKey,
  favoritesOf,
  moveBy,
  parseFavorite,
  toggleFavorite,
} from "@agenteschat/client/lib/sidebar-view";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import type { MenuEntry } from "@/lib/context-menu";
import { useToast } from "@/lib/toast";
import { useDirectory } from "./useDirectory";

/**
 * Favoritos (ADR 0260): people, agents and channels the person keeps on top of the sidebar, in their order, and the
 * menu item that adds or removes one. Saved per person (`…/me/sidebar/view`); never saved, they start from the pins
 * of before, else (day one) the person's own agents. A personal workspace (ADR 0159) shows its favorite agents and
 * conversations on top of their own lists (`pins`).
 */
export function useSidebarFavorites() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const view = useSidebarView(org.id);
  const setView = useSetSidebarView(org.id);
  const dir = useDirectory(org.id);
  const dms = useDms(org.id).data;
  const groups = useAgentGroups(org.id).data;
  const channels = useChannels(org.id).data;
  const hidden = hiddenAgentIds(org, dir.agents);
  const listed = dir.agents.filter((a) => !hidden.has(a.id));
  const lastActive = new Map<string, string>();
  for (const d of dms ?? [])
    if (d.with.type === "agent" && d.lastMessage) lastActive.set(d.with.id, d.lastMessage.createdAt);
  const dayOne = dayOnePins(
    listed.filter((a) => !isRightHand(a)),
    me.user.id,
    lastActive,
    groups,
  );
  // A favorite of something no longer in these lists holds no place.
  const known = {
    agent: listed.map((a) => a.id),
    channel: channels?.filter((c) => c.isMember || c.visibility === "public").map((c) => c.id),
    person: dir.members.map((m) => m.userId),
  };
  const list = favoritesOf(view, dayOne, known);
  const save = (next: (from: string[]) => string[]) =>
    setView((now) => ({ ...now, favorites: next(favoritesOf(now, dayOne, known)) }));
  const toggle = (kind: FavoriteKind, id: string) => {
    const key = favoriteKey(kind, id);
    if (!toggleFavorite(list, key)) {
      toast.show(t("sidebarFavorites.full"), "info");
      return;
    }
    save((from) => toggleFavorite(from, key) ?? from);
  };
  const ids = (kind: FavoriteKind) =>
    list.flatMap((key) => (key.startsWith(`${kind}:`) ? [key.slice(kind.length + 1)] : []));
  const pins: SidebarPins = { agents: ids("agent"), channels: ids("channel"), people: ids("person") };
  return {
    view,
    setView,
    /** Favoritos as keys (`agent:<id>`…), in order. */
    list,
    /** Each kind's favorite ids: a personal workspace's lists put them on top. */
    pins,
    isFavorite: (kind: FavoriteKind, id: string) => list.includes(favoriteKey(kind, id)),
    toggle,
    /** One step up (-1) or down (1) among the favorites. */
    move: (key: string, delta: -1 | 1) => save((from) => moveBy(from, key, delta)),
    /** `key` before `before` (null: at the end): a favorite dragged onto another. */
    place: (key: string, before: string | null) =>
      save((from) => {
        const rest = from.filter((k) => k !== key);
        const at = before ? rest.indexOf(before) : -1;
        rest.splice(at < 0 ? rest.length : at, 0, key);
        return rest;
      }),
    parse: parseFavorite,
    /** "Adicionar aos favoritos" / "Tirar dos favoritos" for a row's menus. */
    entry: (kind: FavoriteKind, id: string): MenuEntry => ({
      kind: "item",
      id: "favorite",
      label: list.includes(favoriteKey(kind, id)) ? t("sidebarFavorites.remove") : t("sidebarFavorites.add"),
      icon: "star",
      run: () => toggle(kind, id),
    }),
  };
}
