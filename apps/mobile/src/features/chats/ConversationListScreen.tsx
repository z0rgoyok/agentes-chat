import { useMuteChannel } from "@agenteschat/client";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl } from "react-native";
import { SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { useRowMenus } from "../categories/menus";
import { FirstUse, LoadFailed } from "../shared/FirstUse";
import { useDirectory, useOrgId, usePullRefresh } from "../shared/hooks";
import { PushedLargeTitle } from "../shared/PushedLargeTitle";
import { useWorkingNow } from "../shared/queries";
import { SheetHostProvider } from "../shared/SheetHost";
import { useHidesQuietGeneral } from "./ChatsScreen";
import { HomeRow } from "./HomeRow";
import { type ConversationRow, recentRows, rightHandPin, withoutQuietGeneral } from "./logic";
import { useAgentRowStates } from "./useHomeNow";
import { useConversationRows, useRowFacts } from "./useRows";
import { useWaitingItems } from "./useWaitingItems";

/** Rows whose agent moves (a long list stays light). */
const LIVE_ROWS = 8;

/**
 * Recentes in full, pushed from its "See all" on Conversas: every conversation (agents', people's and channels') by
 * latest activity with no grouping, in the home's own rows: one tap deeper a row behaves as it does there (a swipe to
 * pin it or silence a channel, the long press's menu), under the same large title, and the same rows of its shape stand
 * in while it loads. An agent's row says it waits on you, or what it is doing. As on the home, the right hand has its
 * own field there and isn't listed, and a personal workspace (ADR 0159) leaves a quiet #general out while its person is
 * alone in it.
 */
export function ConversationListScreen() {
  return (
    <SheetHostProvider>
      <ConversationList />
    </SheetHostProvider>
  );
}

function ConversationList() {
  const { t } = useTranslation();
  const list = useConversationRows();
  const factsOf = useRowFacts();
  const dir = useDirectory();
  const orgId = useOrgId();
  const hideGeneral = useHidesQuietGeneral();
  // The right hand has its own field on Conversas, never a row here (ADR 0137).
  const all = withoutQuietGeneral(rightHandPin(list.rows, rightHandOf(dir.agents)).rows, hideGeneral);
  const rows = recentRows(all);
  const work = useWorkingNow();
  const waiting = useWaitingItems();
  const agentStates = useAgentRowStates(list.rows, work, waiting.items);
  const pull = usePullRefresh(list.refetch);
  // The home's own handlers for its rows: the long press's menu, the swipe's pin and a channel's silence.
  const menus = useRowMenus();
  const { mutate: muteChannel } = useMuteChannel(orgId);
  const muteRow = useCallback(
    (r: ConversationRow) => {
      if (r.kind === "channel") muteChannel({ channelId: r.channelId, muted: !r.muted });
    },
    [muteChannel],
  );
  const firstStep = {
    place: "chats" as const,
    acts: true,
    label: t("mobile.empty.chats.action"),
    icon: "chat" as const,
    onPress: () => router.push("/new-chat"),
  };
  const holdLabel = t("sidebarPins.pin");
  return (
    <PushedLargeTitle
      title={t("mobile.chats.recent")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      {list.loading ? (
        <SkeletonList rows={6} />
      ) : list.failed && rows.length === 0 ? (
        <LoadFailed onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <FirstUse {...firstStep} />
      ) : (
        rows.map((r, i) => (
          <HomeRow
            key={r.key}
            row={r}
            facts={factsOf(r, agentStates.get(r.key))}
            divider={i > 0}
            live={i < LIVE_ROWS}
            pinLabel={menus.pinLabelOf(r)}
            onHold={menus.openRowMenu}
            holdLabel={holdLabel}
            holdActions={menus.rowActionsOf}
            onMute={muteRow}
          />
        ))
      )}
    </PushedLargeTitle>
  );
}
