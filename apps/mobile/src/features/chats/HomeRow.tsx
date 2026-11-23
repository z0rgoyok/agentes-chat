import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { type SwipeAction, SwipeRow } from "@/ui";
import type { RowAction } from "../categories/menus";
import { useColors } from "../shared/hooks";
import { ConversationItem } from "./ConversationRowView";
import type { ConversationRow } from "./logic";
import type { RowFacts } from "./rowFacts";

export interface HomeRowProps {
  row: ConversationRow;
  facts: RowFacts;
  divider: boolean;
  live: boolean;
  /** The swipe's first action ("Fixar no topo", "Tirar do topo" once pinned); null: none, and the row doesn't swipe. */
  pinLabel: string | null;
  /** The long press's sheet, its actions (iOS's own menu) and what it does, for screen readers. */
  onHold: (row: ConversationRow) => void;
  holdActions: (row: ConversationRow) => RowAction[];
  holdLabel: string;
  /** A row for an agent with no conversation yet: starts one. */
  onStart?: (agentId: string) => void;
  /** A channel's "Silenciar" (or "Reativar"), beside the pin. */
  onMute: (row: ConversationRow) => void;
}

/**
 * A row of Conversas' Recentes, and of its "See all": the conversation's row, which a swipe to the left slides off its
 * actions on panes (Fixar no topo or Tirar do topo, the menu's first action, and on a channel Silenciar or Reativar
 * beside it; the row stays opaque over them, so the hairline and the sky never show), and whose long press has the
 * rest (iOS's own menu under the preview, a sheet elsewhere). Memoized on plain values and stable handlers: it draws
 * again only when its own row, its words or its place change.
 */
export const HomeRow = memo(function HomeRow({
  row,
  facts,
  divider,
  live,
  pinLabel,
  onHold,
  holdActions,
  holdLabel,
  onStart,
  onMute,
}: HomeRowProps) {
  const { t } = useTranslation();
  const c = useColors();
  const muted = row.kind === "channel" && row.muted === true;
  const panes = useMemo((): SwipeAction | SwipeAction[] | null => {
    if (pinLabel === null) return null;
    const pin: SwipeAction = {
      label: pinLabel,
      icon: "pin",
      color: c.agent,
      ink: c.onAgent,
      // The menu's own action, as it stands when the pane is pressed.
      onAction: () =>
        holdActions(row)
          .find((a) => a.key === "pin")
          ?.run(),
    };
    if (row.kind !== "channel") return pin;
    return [
      pin,
      {
        label: t(muted ? "mobile.chats.swipe.unmute" : "mobile.chats.swipe.mute"),
        icon: "mute",
        color: c.muted,
        ink: c.bg,
        onAction: () => onMute(row),
      },
    ];
  }, [pinLabel, row, muted, c, t, holdActions, onMute]);
  const view = (
    <ConversationItem
      row={row}
      facts={facts}
      divider={divider}
      live={live}
      onHold={onHold}
      holdLabel={holdLabel}
      holdActions={holdActions}
      {...(onStart ? { onStart } : {})}
    />
  );
  if (!panes) return view;
  return (
    <SwipeRow right={panes}>
      <View style={{ backgroundColor: c.bg }}>{view}</View>
    </SwipeRow>
  );
});
