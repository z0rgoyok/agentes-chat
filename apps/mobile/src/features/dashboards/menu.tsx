import {
  type Dashboard,
  useDashboards,
  useDeleteDashboard,
  useSetHomeDashboard,
  useUpdateDashboard,
} from "@agenteschat/client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { type HeaderAction, type HeaderMenuItem, type SFSymbolName, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { chooseAction } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack, successHaptic } from "../shared/parts";
import { type BoardMenuKey, boardMenuKeys, HOME } from "./logic";

/** A board menu's SF Symbols (iOS), beside each choice's line icon (Android). */
const SF: Record<BoardMenuKey, SFSymbolName> = {
  home: "house",
  unhome: "house.slash",
  organize: "square.grid.2x2",
  share: "person.2",
  edit: "pencil",
  pin: "pin",
  unpin: "pin.slash",
  delete: "trash",
};

/**
 * A board's "…" (ADR 0135): Use on Home or Remove from Home (§18), Organize, Share, Rename, Pin to the top or Unpin,
 * and Delete (with the system's confirmation), only what the viewer may do. On iOS the system's own menu opens from
 * the bar button (`PushedHeader actions`); Android lists the same choices in the app's sheet (`chooseAction`). Null
 * until the board loads, and with nothing to offer.
 */
export function useBoardMenu(board: Dashboard | undefined): HeaderAction | null {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateDashboard(orgId);
  const remove = useDeleteDashboard(orgId);
  const list = useDashboards(orgId);
  const setHome = useSetHomeDashboard(orgId);
  if (!board) return null;
  const home = board.kind === "home";
  const chosen = list.data?.homeDashboardId ?? null;
  const onHome = home ? !chosen : chosen === board.id;
  const showOnHome = (id: string | null) =>
    setHome.mutate(id, {
      onSuccess: () => {
        successHaptic();
        if (id) toast({ title: t("dashboards.onHomeDone") });
      },
      onError: failed,
    });
  const title = home ? t("dashboards.home") : board.title;
  const setPinned = (pinned: boolean) =>
    update.mutate(
      { dashboardId: board.id, pinned },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: pinned ? t("mobile.dashboards.pinned") : t("mobile.dashboards.unpinned") });
        },
        onError: failed,
      },
    );
  const confirmDelete = () =>
    Alert.alert(
      t("dashboards.delete.title", { title }),
      t("common.joinSentences", { a: t("dashboards.delete.text"), b: t("common.cantUndo") }),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("dashboards.delete.confirm"),
          style: "destructive",
          onPress: () =>
            remove.mutate(board.id, {
              onSuccess: () => {
                successHaptic();
                toast({ title: t("dashboards.delete.done", { title }) });
                goBack();
              },
              onError: failed,
            }),
        },
      ],
    );
  const all: Record<BoardMenuKey, Omit<HeaderMenuItem, "sf">> = {
    home: { icon: "home", label: t("dashboards.useOnHome"), onPress: () => showOnHome(home ? null : board.id) },
    unhome: { icon: "home", label: t("dashboards.stopOnHome"), onPress: () => showOnHome(null) },
    organize: {
      icon: "list",
      label: t("widgets.organize.start"),
      onPress: () => router.push(`/board-organize/${home ? HOME : board.id}`),
    },
    share: {
      icon: "share",
      label: t("dashboards.share.action"),
      onPress: () => router.push(`/board-share/${board.id}`),
    },
    edit: { icon: "pen", label: t("dashboards.rename"), onPress: () => router.push(`/board-edit/${board.id}`) },
    pin: { icon: "pin", label: t("dashboards.pinTop"), onPress: () => setPinned(true) },
    unpin: { icon: "pin", label: t("dashboards.unpin"), onPress: () => setPinned(false) },
    delete: { icon: "trash", label: t("dashboards.delete.action"), destructive: true, onPress: confirmDelete },
  };
  const items: HeaderMenuItem[] = boardMenuKeys(board, onHome).map((key) => ({ ...all[key], sf: SF[key] }));
  if (items.length === 0) return null;
  return {
    icon: "more",
    sf: "ellipsis",
    label: t("widgets.menu.label"),
    menu: items,
    onPress: () =>
      chooseAction(
        title,
        items.map((i) => ({ label: i.label, icon: i.icon, destructive: i.destructive, onPress: i.onPress })),
        t("mobile.common.cancel"),
      ),
  };
}

/** One choice of a pick menu: its word, a second line (an agent's role), and what goes before it on Android. */
export interface PickItem<K extends string> {
  key: K;
  label: string;
  hint?: string | null;
  leading?: ReactNode;
}

/**
 * A pick list from a form row ("Who looks after it", "Format"), in the app's picker on both systems: each choice with
 * what goes before it (a kind's glyph, a face), its second line, and the check on the current one.
 */
export function usePickMenu() {
  return function open<K extends string>(
    title: string,
    items: readonly PickItem<K>[],
    value: K | null,
    onPick: (key: K) => void,
  ) {
    if (items.length === 0) return;
    void pickOne({
      title,
      value,
      options: items.map((i) => ({
        key: i.key,
        label: i.label,
        ...(i.hint ? { sub: i.hint } : {}),
        ...(i.leading ? { leading: { kind: "node" as const, node: i.leading } } : {}),
      })),
    }).then((key) => {
      const item = items.find((i) => i.key === key);
      if (item) onPick(item.key);
    });
  };
}
