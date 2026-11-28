import { useChannels } from "@agenteschat/client";
import { managesChannel } from "@agenteschat/client/lib/permissions";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import type { ConversationRow } from "../chats/logic";
import { usePins } from "../chats/pins";
import { useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { ActionList, Tile } from "../shared/parts";
import { useSheet } from "../shared/SheetHost";
import { sectorHref } from "./logic";

const NO_CHANNELS: never[] = [];

/** One of a row's long press actions: the app's sheet shows `icon`, iOS's own menu the SF Symbol `symbol`. */
export interface RowAction {
  key: "pin" | "move";
  icon: "star" | "list";
  symbol: "star" | "star.slash" | "folder";
  label: string;
  run: () => void;
}

/**
 * The long press of a conversation on the home (its row, or its face on the strip of Favoritos), as a short sheet:
 * "Adicionar aos favoritos" or "Tirar dos favoritos" (a channel, an agent's or a person's DM) and a channel's "Mover
 * para a seção", the person's own sections (ADR 0260). The same actions fill iOS's own menu under the conversation's
 * preview.
 */
export function useRowMenus() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const sheet = useSheet();
  const channels = useChannels(orgId).data ?? NO_CHANNELS;
  // Every row asks for its channel: by id, made once per list.
  const channelsById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const dir = useDirectory();
  const pins = usePins();
  // What a row pins or takes off (a channel, an agent's or a person's DM); null for one that has no pin, or a channel
  // not in the list.
  const pinOf = (r: ConversationRow) => {
    if (r.kind === "channel")
      return channelsById.has(r.channelId) ? { kind: "channels" as const, id: r.channelId } : null;
    if (r.kind === "dm")
      return { kind: r.with.type === "agent" ? ("agents" as const) : ("people" as const), id: r.with.id };
    return null;
  };
  // What a row's long press offers: add it to Favoritos or take it off, and move a channel to one of my sections. The
  // same list fills the app's sheet and iOS's own menu.
  const rowActions = (r: ConversationRow): RowAction[] => {
    const channel = r.kind === "channel" ? channelsById.get(r.channelId) : undefined;
    const pin = pinOf(r);
    if (!pin) return [];
    const pinned = pins.isPinned(pin.kind, pin.id);
    return [
      {
        key: "pin",
        icon: "star",
        symbol: pinned ? "star.slash" : "star",
        label: pinned ? t("sidebarFavorites.remove") : t("sidebarFavorites.add"),
        run: () => pins.toggle(pin.kind, pin.id),
      },
      ...(channel
        ? [
            {
              key: "move" as const,
              icon: "list" as const,
              symbol: "folder" as const,
              label: t("sidebarSections.moveTo"),
              run: () => router.push(sectorHref(channel.id)),
            },
          ]
        : []),
    ];
  };
  const rowMenu = (r: ConversationRow) => {
    const actions = rowActions(r);
    if (actions.length === 0) return;
    const channel = r.kind === "channel" ? channelsById.get(r.channelId) : undefined;
    sheet.open(
      <>
        <SheetTitle
          {...(channel ? { leading: <Tile icon="hash" size={40} /> } : {})}
          title={channel ? `#${channel.name}` : r.kind === "dm" ? dir.nameOf(r.with) : ""}
        />
        <ActionList
          items={actions.map((a) => ({
            key: a.key,
            icon: a.icon,
            label: a.label,
            onPress: () => {
              sheet.close();
              a.run();
            },
          }))}
        />
      </>,
    );
  };
  // One function for every render (the rows are memoized), always running the latest menu.
  const latest = useRef({ rowMenu, rowActions });
  latest.current = { rowMenu, rowActions };
  const openRowMenu = useCallback((r: ConversationRow) => latest.current.rowMenu(r), []);
  const rowActionsOf = useCallback((r: ConversationRow) => latest.current.rowActions(r), []);
  // The swipe's words for a row: its menu's pin action's, without making the whole menu; null: none.
  const pinLabelOf = (r: ConversationRow) => {
    const pin = pinOf(r);
    if (!pin) return null;
    return pins.isPinned(pin.kind, pin.id) ? t("sidebarFavorites.remove") : t("sidebarFavorites.add");
  };
  return { openRowMenu, rowActionsOf, pinLabelOf };
}

/** Whether I may change this channel (its ⋯ sheet shows "reply in threads" then): who manages it, its creator. */
export function useMovesChannel(channelId: string) {
  const orgId = useOrgId();
  const { org } = useOrg();
  const meId = useMeId();
  const channel = useChannels(orgId).data?.find((c) => c.id === channelId);
  return channel ? managesChannel(channel, meId, org) : false;
}
