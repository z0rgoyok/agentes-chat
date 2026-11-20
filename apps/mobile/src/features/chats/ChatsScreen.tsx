import { keys, useChannels, useMuteChannel } from "@agenteschat/client";
import { canTalk, listsAgent } from "@agenteschat/client/lib/audience";
import { waitingComputerByAgent } from "@agenteschat/client/lib/machine-outages";
import { isRightHand, rightHandOf } from "@agenteschat/client/lib/right-hand";
import { WORKING_POLL_MS } from "@agenteschat/client/lib/working";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { LargeTitleScreen, LIST_AVATAR, ListRow, SkeletonList } from "@/ui";
import { router } from "@/ui/navigation";
import { workByAgent } from "../agents/logic";
import { useRowMenus } from "../categories/menus";
import { SetupNotice } from "../computer/SetupWait";
import { chatHref } from "../links/logic";
import { useOpenStart } from "../me/useStart";
import { useOpenDm } from "../new/useOpenDm";
import { OutageNotices } from "../outages/OutageNotice";
import { useMachineOutages } from "../outages/queries";
import { RightHandAsk } from "../right-hand/Pin";
import { FirstUse } from "../shared/FirstUse";
import { useDirectory, useMeId, useOrgId, usePullRefresh } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { useActiveWork, useHiddenAgents, useWorkingNow } from "../shared/queries";
import { SheetHostProvider } from "../shared/SheetHost";
import { useTabHeader } from "../shared/tabHeader";
import { alongInAccessory } from "../work-along/logic";
import { useHasWorkAlong } from "../work-along/WorkAlong";
import { DeletingNotice } from "./DeletingNotice";
import { FirstAgentEmpty, Greeting, GreetingSky } from "./Greeting";
import { Arrive, useHomeEntrance, useWake } from "./HomeEntrance";
import { HomeRow } from "./HomeRow";
import { CollapsibleSection, SeeAllRow, useCollapsedSections } from "./HomeSection";
import { HomeServerError, HomeServerNotice } from "./HomeServerError";
import { HomeWidgets } from "./HomeWidgets";
import {
  agentStarters,
  type ConversationRow,
  type ListKind,
  pinnedRows,
  RECENT_MAX,
  recentRows,
  rightHandPin,
  withoutQuietGeneral,
} from "./logic";
import { type PinnedItem, PinnedStrip } from "./PinnedStrip";
import { usePins } from "./pins";
import { TeamPeek } from "./TeamPeek";
import { teamPeekers } from "./team-peek";
import { useAgentRowStates, useFinished } from "./useHomeNow";
import { useConversationRows, useRowFacts } from "./useRows";
import { useWaitingItems } from "./useWaitingItems";

/** Faces of the home that move, the pinned ones at work first, then the first rows (a long list stays light). */
const LIVE_ROWS = 6;
/** The home's sky fading in after the launch splash. */
const SKY_ARRIVE_MS = 300;
/**
 * The team peeking past the list's end (`TeamPeek`) where the list reports a pull there: iOS bounces past its end;
 * Android's list stops at it (as in a conversation, `ChatPeek`).
 */
const PEEK = Platform.OS === "ios";
/** iOS 26 holds the work-along line in the tab bar's accessory, over the bar: the faces would rise behind it. */
const ACCESSORY = alongInAccessory(Platform.OS, Platform.Version);

/** A section's "See all", pushed: Recentes in full. */
export const openKindList = (kind: ListKind) => router.push(`/conversations/${kind}`);

/**
 * Whether the lists leave a quiet #general out (ADR 0159): in a personal workspace while its person is the only member
 * (or while the members load), as the web's sidebar. With family in it, #general shows.
 */
export function useHidesQuietGeneral(): boolean {
  const { org } = useOrg();
  const meId = useMeId();
  const { memberById } = useDirectory();
  return isPersonal(org) && ![...memberById.keys()].some((id) => id !== meId);
}

/**
 * Conversas, the home: the large title with Você and "+" (Novo) in the bar, over a light sky, the greeting under it
 * with what changed (what an agent finished, how many work) and the right hand's own field. Under the greeting, the
 * workspace's own computer while it is being prepared, and a notice per computer that went offline with agents waiting
 * for it. Then Início's widgets (the way to Dashboards, ADR 0135 §15), what is pinned on a strip that scrolls sideways
 * (`PinnedStrip`), and Recentes: every conversation by its latest activity with no grouping, the first ones and "See
 * all". Each part is collapsible (remembered). An agent's row and face say it waits on your ok, waits for its computer,
 * or what it is doing. A row swiped left pins it (or takes it off), the long press's menu has the rest. While the list
 * loads, rows of its own shape stand in (no spinner). Search and Threads have their own tabs. Empty, it invites the
 * first agent. Nothing opens over it on its own: the offer to turn on notifications comes as a line in the right
 * hand's conversation. When the server doesn't answer it says so (`HomeServerError`), over the kept rows as a card,
 * and tries again on its own. A personal workspace (ADR 0159), while its person is alone in it, leaves a quiet #general
 * out. Pulled past its last row, the team peeks up from behind the tab bar (iOS, `TeamPeek`); archived channels are in
 * You › Work.
 */
export function ChatsScreen() {
  return (
    <SheetHostProvider>
      <Home />
    </SheetHostProvider>
  );
}

function Home() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const hideGeneral = useHidesQuietGeneral();
  const qc = useQueryClient();
  const focused = useIsFocused();
  // What the person chose to open when the app starts goes over Conversas, once (ADR 0108).
  useOpenStart(focused);
  const header = useTabHeader();
  const dir = useDirectory();
  // Each row kept while nothing in it changes, and what it says worked out here once for all of them: a row redraws
  // only when its own changed.
  const list = useConversationRows();
  const factsOf = useRowFacts();
  const work = useWorkingNow();
  // A run that stops on your ok hasn't finished: "terminou" is told from all the work, waiting included.
  const active = useActiveWork();
  const waiting = useWaitingItems();
  const { collapsed, toggle } = useCollapsedSections();
  // The widgets' section is memoized: its toggle stays one function.
  const toggleWidgets = useCallback(() => toggle("widgets"), [toggle]);
  // An administrator reads every channel (ADR 0151): the ones they aren't in wait at the end of the home.
  const others = (useChannels(orgId).data ?? []).filter((c) => c.seenAsAdmin);
  const menus = useRowMenus();
  const { mutate: muteChannel } = useMuteChannel(orgId);
  const muteRow = useCallback(
    (r: ConversationRow) => {
      if (r.kind === "channel") muteChannel({ channelId: r.channelId, muted: !r.muted });
    },
    [muteChannel],
  );

  useEffect(() => {
    if (!focused) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: keys.working(orgId) }), WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [focused, qc, orgId]);

  const outages = useMachineOutages();
  const offline = useMemo(() => waitingComputerByAgent(outages.outages), [outages.outages]);
  const { hidden } = useHiddenAgents();
  // An agent waiting for its offline computer isn't working (its run only waits), and the count matches Agentes,
  // which it opens: my lists can leave some agents out (`listsAgent`; one I only edit is in them, its DM isn't).
  const working = workByAgent(work)
    .map((w) => w.agentId)
    .filter((id) => {
      const a = dir.agentById.get(id);
      return a !== undefined && listsAgent(org, a) && !offline.has(id);
    });
  const finished = useFinished(active, list.rows);
  const pull = usePullRefresh(() => Promise.allSettled([list.refetch(), waiting.refetch(), outages.refetch()]));
  const openDm = useOpenDm();
  const startDm = useCallback((agentId: string) => void openDm({ agentId }), [openDm]);
  // The right hand (ADR 0137): its own field under the greeting, never a row of Recentes nor a face on the strip;
  // outside its audience, none.
  const rightHand = rightHandOf(dir.agents);
  const pinned = rightHandPin(list.rows, rightHand && canTalk(rightHand) ? rightHand : undefined);
  // The team's agents never talked to, as ones to start (a pinned one stands on the strip): only those whose DM the
  // server opens for me (`agentStarters`), never one I only edit.
  const starters = useMemo(
    () =>
      agentStarters(
        dir.agents.filter((a) => !isRightHand(a)),
        hidden,
      ),
    [dir.agents, hidden],
  );
  // What an agent's row or face says instead of its last message, for the agents never talked to as well (a pinned
  // one stands on the strip).
  const withStarters = useMemo(() => [...list.rows, ...starters], [list.rows, starters]);
  const agentStates = useAgentRowStates(withStarters, work, waiting.items, offline);
  const pins = usePins();
  // Recentes: every conversation by its latest activity, the pinned ones in their place (the strip holds the pins).
  const recent = recentRows(withoutQuietGeneral(pinned.rows, hideGeneral));
  // A list that failed to load isn't an empty workspace: it says the server didn't answer. A #general left out of
  // sight still counts: the home keeps its greeting and the right hand's field.
  const failed = list.failed && list.rows.length === 0;
  // Who peeks past the end: the right hand in the middle, then the agents of the latest conversations (none hidden);
  // nobody while the line of work along stands over the bar, or while the list isn't there.
  const along = useHasWorkAlong();
  const peekers =
    PEEK && !(ACCESSORY && along) && !list.loading && !failed
      ? teamPeekers(rightHand && canTalk(rightHand) ? rightHand.id : null, recent, hidden).join(" ")
      : "";
  // Agents already in the team (in Agentes, a pinned one on the strip) leave out the invitation to make the first one:
  // every one the Agents tab lists (`listsAgent`), those I only edit included, though none of them is one to start.
  const teamListed = dir.agents.some((a) => !isRightHand(a) && listsAgent(org, a));
  const empty = !list.loading && !failed && pinned.rows.length === 0 && !teamListed;

  // The first Conversas after the splash arrives as one gesture (once per launch, never holding a tap back): the sky
  // comes up from the splash's, the greeting rises, the right hand's field follows and its face wakes with a small
  // hop. The title stays put: it is where the eye lands.
  const entrance = useHomeEntrance();
  const wake = useWake(entrance.armed, entrance.play);
  const arrive = { armed: entrance.armed, play: entrance.play };

  const ask =
    pinned.pin && !failed && !list.loading ? (
      <Arrive {...arrive} delay={90}>
        <RightHandAsk row={pinned.pin} onStart={startDm} faceMode={wake.mode} faceStyle={wake.style} />
      </Arrive>
    ) : null;

  const holdLabel = t("sidebarPins.pin");
  // The faces that move: the pinned ones at work first (the strip leads the list), then the first rows; none of a
  // closed section.
  let live = 0;
  const strip = pinnedRows(pinned.rows, starters, pins.pins).map((r): PinnedItem => {
    const facts = factsOf(r, agentStates.get(r.key));
    const moves = !collapsed.includes("pinned") && facts.face === "run" && live < LIVE_ROWS;
    if (moves) live++;
    return { row: r, facts, live: moves };
  });
  return (
    <LargeTitleScreen
      title={t("mobile.chats.title")}
      {...header}
      // The sky stands behind the bar and the large title and scrolls with them: the title is drawn with it.
      drawnTitle
      backdrop={
        empty || failed ? undefined : (
          // The sky comes up quickly after the splash's own (300 ms): the home is there, not still arriving.
          <Arrive {...arrive} rise={0} duration={SKY_ARRIVE_MS} style={StyleSheet.absoluteFill}>
            <GreetingSky />
          </Arrive>
        )
      }
      below={
        empty || failed ? undefined : (
          <Greeting
            working={working}
            finished={finished.finished}
            onFinishedPress={(f) => finished.dismiss(f.key)}
            after={ask}
            arrive={arrive}
          />
        )
      }
      pull={pull}
      {...(peekers ? { pastEnd: (scroll) => <TeamPeek scroll={scroll} agents={peekers} /> } : {})}
    >
      {/* Being deleted, its line comes first and alone: its work stopped, nothing else is news (ADR 0088 §7). */}
      {org?.deletion ? (
        <DeletingNotice />
      ) : (
        <>
          <SetupNotice />
          <OutageNotices />
        </>
      )}
      {list.stale && !failed ? <HomeServerNotice retry={list.refetch} /> : null}
      {failed ? (
        <HomeServerError retry={list.refetch} />
      ) : empty ? (
        <FirstAgentEmpty />
      ) : list.loading ? (
        // Recentes as it will stand (closed if the person closed it, no count until it is known): a header tapped
        // meanwhile still opens or closes it.
        <CollapsibleSection
          title={t("mobile.chats.recent")}
          collapsed={collapsed.includes("recent")}
          onToggle={() => toggle("recent")}
        >
          <SkeletonList rows={6} />
        </CollapsibleSection>
      ) : (
        <>
          {/* Início's widgets, and the way to Dashboards ("See all"), not a tab (ADR 0135 §15). */}
          <HomeWidgets collapsed={collapsed.includes("widgets")} onToggle={toggleWidgets} />
          <PinnedStrip
            items={strip}
            collapsed={collapsed.includes("pinned")}
            onToggle={() => toggle("pinned")}
            onStart={startDm}
            onHold={menus.openRowMenu}
            holdActions={menus.rowActionsOf}
            holdLabel={t("sidebarPins.unpin")}
          />
          <CollapsibleSection
            title={t("mobile.chats.recent")}
            count={recent.length}
            collapsed={collapsed.includes("recent")}
            onToggle={() => toggle("recent")}
          >
            {recent.length === 0 ? (
              // The team's agents are in Agentes and on the strip, never talked to yet: the first conversation.
              <FirstUse
                place="chats"
                size="panel"
                acts
                label={t("mobile.empty.chats.action")}
                icon="chat"
                onPress={() => router.push("/new-chat")}
              />
            ) : (
              recent.slice(0, RECENT_MAX).map((r, i) => (
                // Swiped left: Fixar no topo (or Tirar do topo) and a channel's Silenciar; held: the menu (`HomeRow`).
                <HomeRow
                  key={r.key}
                  row={r}
                  facts={factsOf(r, agentStates.get(r.key))}
                  divider={i > 0}
                  live={!collapsed.includes("recent") && live++ < LIVE_ROWS}
                  pinLabel={menus.pinLabelOf(r)}
                  onHold={menus.openRowMenu}
                  holdLabel={holdLabel}
                  holdActions={menus.rowActionsOf}
                  onMute={muteRow}
                />
              ))
            )}
            {recent.length > RECENT_MAX ? (
              <SeeAllRow label={t("mobile.chats.seeAll")} onPress={() => openKindList("recent")} />
            ) : null}
          </CollapsibleSection>
        </>
      )}
      {others.length > 0 ? (
        <CollapsibleSection
          title={t(modeKey(org, "shell.otherChannels"))}
          count={others.length}
          collapsed={collapsed.includes("otherChannels")}
          onToggle={() => toggle("otherChannels")}
        >
          {/* In the list's own rows, as every channel of the home: the tile, the name, the chevron to open it. */}
          {others.map((o, i) => (
            <ListRow
              key={o.id}
              divider={i > 0}
              leading={<Tile icon="lock" size={LIST_AVATAR} />}
              title={`#${o.name}`}
              {...(o.topic ? { sub: o.topic, subLines: 1 } : {})}
              chevron
              accessibilityRole="button"
              onPress={() => router.push(chatHref(o.id))}
            />
          ))}
        </CollapsibleSection>
      ) : null}
    </LargeTitleScreen>
  );
}
