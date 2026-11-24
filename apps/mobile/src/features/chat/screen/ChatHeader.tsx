import {
  type CodeSession,
  codeSessionOf,
  fileConversationOf,
  type LiveConsult,
  type LiveRun,
  useArtifact,
  useCodeSession,
} from "@agenteschat/client";
import { joinNames } from "@agenteschat/client/lib/format";
import { issueWorkOf, taskConversationOf } from "@agenteschat/client/lib/issues";
import { textOrMedia } from "@agenteschat/client/lib/media";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import type { HeaderAction } from "@/ui";
import { router } from "@/ui/navigation";
import { threadTitle } from "../../chats/logic";
import { sessionCodeHref, sessionStateKey, shortBranch } from "../../coding/logic";
import { useSessionMenu } from "../../coding/menu";
import { DmQueueButton, QueueButton, useAgentsQueue, useOpenQueue } from "../../queue/QueueSheet";
import { type Directory, useDirectory, useOrgId } from "../../shared/hooks";
import { agentLook, previewOf } from "../../shared/logic";
import { PushedHeader } from "../../shared/parts";
import { AgentTasksButton, useDmAgentTasks } from "../../task-manager/AgentTasksButton";
import { agentTasksHref } from "../../task-manager/logic";
import { DmComputerWords, dmComputerAction } from "../DmComputerButton";
import { useLatest } from "./hooks";
import { ChannelPill, DmPill, ThreadPill, who } from "./pills";
import type { ChatData } from "./useChatData";
import type { ChatRows } from "./useChatRows";
import type { ConversationActions } from "./useConversationActions";
import type { FollowEnd } from "./useFollowEnd";

/** No work handed to the header's pill (a channel's, a thread's, a person's DM): the same lists each time. */
const NO_RUNS: LiveRun[] = [];
const NO_LINE: LiveConsult[] = [];

/**
 * A code session's line under its name (ADR 0215): its state in words and its branch, as the web's header says them
 * (the branch without its agent's prefix: the room is the pill's).
 */
function codeSessionLine(t: ReturnType<typeof useTranslation>["t"], s: CodeSession) {
  const state = sessionStateKey(s);
  return [
    state.pr !== null ? t(state.key, { number: state.pr }) : t(state.key),
    s.branch ? shortBranch(s.branch) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The conversation's title and the line under it, from where it is (a channel, a DM, a thread, a task's, a file's, a
 * code session's).
 */
export function useChatTitle({
  threadId,
  orgId,
  t,
  dir,
  data,
}: {
  threadId: string | null;
  orgId: string;
  t: ReturnType<typeof useTranslation>["t"];
  dir: Directory;
  data: Pick<
    ChatData,
    "channel" | "dm" | "dmAgentId" | "isThread" | "list" | "mission" | "rightHand" | "roster" | "thread"
  >;
}) {
  const { channel, dm, dmAgentId, isThread, list, mission, rightHand, roster, thread } = data;
  // ── Header ──
  // The header is glass over the conversation: the system's
  // back and "…" circles, and in the middle a pill with who or where, its sky and what the agent is doing.
  const info = thread.data;
  // A task's work thread: its root was written by the server in one language ("Issue #1: …"); the card's
  // number and title, in the reader's.
  const root = isThread ? list.find((m) => m.id === threadId) : undefined;
  const rootWork = issueWorkOf(root?.meta);
  // A task's conversation (ADR 0145): "Conversa da tarefa", the task under it.
  const rootTask = taskConversationOf(root?.meta);
  // A live file's (ADR 0199): "Canvas conversation", who took part under it (the file's name until someone writes).
  const rootFile = fileConversationOf(root?.meta);
  const fileTalk = useArtifact(orgId, rootFile?.artifactId ?? null).data?.conversation;
  // A code session's (ADR 0215): its name, and its project under it. The bar reads the session itself (its name as
  // renamed, its state and branch), so a change of state redraws the bar alone.
  const rootCode = codeSessionOf(root?.meta);
  const title = isThread
    ? rootTask
      ? t("issues.conversation.title")
      : rootFile
        ? t(`live.conversation.title.${rootFile.kind}`)
        : rootCode
          ? rootCode.title
          : rootWork
            ? t("issues.open", { number: rootWork.number, title: rootWork.title })
            : info
              ? // A thread on a GIF or a sticker has no words of its own to title it (ADR 0091).
                threadTitle(info) ||
                previewOf(root ? textOrMedia(t, root.body, root.meta) : "") ||
                t("mobile.chat.thread")
              : ""
    : dm
      ? dm.with.name
      : channel
        ? `#${channel.name}`
        : "";
  const agentsHere = (roster.data ?? []).filter((r) => r.type === "agent").length;
  const subtitle = isThread
    ? rootTask
      ? `#${rootTask.number} · ${rootTask.title}`
      : rootFile
        ? fileTalk?.participants.length
          ? joinNames(fileTalk.participants.map(dir.nameOf).filter(Boolean), t)
          : rootFile.title || undefined
        : rootCode
          ? rootCode.repo
          : info
            ? info.channelKind === "dm"
              ? // A DM's channel name is internal ("dm-…"): the thread says who it is with.
                t(
                  mission
                    ? "mobile.chat.missionWith"
                    : info.state === "closed"
                      ? "mobile.chat.closedThreadWith"
                      : "mobile.chat.threadWith",
                  { name: dm?.with.name ?? "" },
                )
              : t(
                  mission
                    ? "mobile.chat.missionIn"
                    : info.state === "closed"
                      ? "mobile.chat.closedThreadIn"
                      : "mobile.chat.threadIn",
                  {
                    channel: info.channelName,
                  },
                )
            : undefined
    : dmAgentId
      ? rightHand
        ? `${t("rightHand.label")} · ${t("rightHand.actsAsYou")}`
        : dir.agentById.get(dmAgentId)?.role || undefined
      : channel && roster.data
        ? // People and agents counted apart: "1 pessoa · 3 agentes", never "4 membros · 3 agentes".
          `${t("mobile.chat.people", { count: roster.data.length - agentsHere })} · ${t("mobile.chat.agentsHere", { count: agentsHere })}`
        : undefined;
  // The ⋯ of a DM with a person says how they appear (`ConversationOptions`), their line in a card under it.
  const personDm = dm && !dmAgentId && !isThread ? dm.with.id : null;
  return { codeId: rootCode?.sessionId ?? null, info, personDm, rootFile, rootTask, subtitle, title };
}

/**
 * The conversation's bar: its pill (who or where, its sky and what the agent does) and its buttons. On its own: what
 * only the bar shows (the computer's words, the queue, the agent's tasks, its buttons' width) redraws the bar alone.
 */
export function ChatHeader({
  channelId,
  threadId,
  title,
  subtitle,
  codeId,
  info,
  isThread,
  dm,
  dmAgent,
  dmAgentId,
  channel,
  roster,
  member,
  runs,
  lineBase,
  consultData,
  far,
  unseen,
  focused,
  peeking,
  searchPlace,
  openOptions,
  openMembers,
  openSearch,
  onHoldPill,
  leavePlace,
}: Pick<
  ChatData,
  "isThread" | "dm" | "dmAgent" | "dmAgentId" | "channel" | "roster" | "member" | "runs" | "focused" | "peeking"
> &
  Pick<ChatRows, "lineBase" | "consultData"> &
  Pick<FollowEnd, "far" | "unseen"> & {
    channelId: string;
    threadId: string | null;
    title: string;
    subtitle: string | undefined;
    /** The code session this thread is (ADR 0215), if it is one's. */
    codeId: string | null;
    info: ChatData["thread"]["data"];
    searchPlace: ConversationActions["searchPlace"];
    openOptions: () => void;
    openMembers: () => void;
    openSearch: () => void;
    onHoldPill: () => void;
    leavePlace: () => void;
  }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const orgId = useOrgId();
  // A code session's conversation (ADR 0215): the session's name and its state and branch in the pill, which opens its
  // code (its mark the code's); in the bar its agent's computer (where it shows what it builds) and the session's "…".
  // One button besides "…" at most: with two, the pill kept room for a few letters of the name on a 393-point phone.
  const codeQuery = useCodeSession(orgId, codeId);
  const codeSession = codeQuery.data ?? null;
  const codeMore = useSessionMenu(codeSession);
  const [codeComputerWords, setCodeComputerWords] = useState<string | null>(null);
  // Its agent's run here says "working" at once; when it ends, the session is read again for what came of it.
  const codeBusy = codeId !== null && runs.length > 0;
  const refetchCode = codeQuery.refetch;
  useEffect(() => {
    if (codeId && !codeBusy) void refetchCode();
  }, [codeId, codeBusy, refetchCode]);
  const pillTitle = codeSession?.title ?? title;
  const pillSubtitle = codeSession
    ? codeSessionLine(t, codeBusy ? { ...codeSession, work: "working" } : codeSession)
    : subtitle;
  const pressCode = useLatest(() => {
    if (!codeId) return;
    leavePlace();
    router.push(sessionCodeHref(codeId) as never);
  });
  // The computer this conversation's agents share, while turns wait for it: the bar's way into its line.
  const queueAgents = useMemo(
    () => (dmAgentId ? [dmAgentId] : (roster.data ?? []).filter((r) => r.type === "agent").map((r) => r.id)),
    [dmAgentId, roster.data],
  );
  const { machineId: queueMachineId, queue: barQueue } = useAgentsQueue(queueAgents);
  const openQueue = useOpenQueue();
  const queueShown = Boolean(queueMachineId && barQueue?.waiting.length && !isThread);
  // An agent's DM header counts its tasks, here and elsewhere (ADR 0128); a tap opens them, pushed like a thread.
  const agentTasks = useDmAgentTasks(member && !isThread ? dmAgentId : null);
  const holdHint = t("mobile.chat.switchHint");
  // The pill is drawn in the header, outside this screen: a new element for each of its redraws drew the header again.
  // It is made anew only when what it shows changes (`ThreadPill`, `DmPill`, `ChannelPill`), and its presses keep
  // their identity, reading the screen as it is when pressed.
  const pressOptions = useLatest(openOptions);
  const pressMembers = useLatest(openMembers);
  const pressAgent = useCallback(() => {
    if (dmAgentId) router.push(`/agent/${dmAgentId}`);
  }, [dmAgentId]);
  const pillKind = isThread && info ? "thread" : dm ? "dm" : channel ? "channel" : null;
  // An agent's DM says what the agent does from the work here: only its pill is handed that work.
  const pillRuns = pillKind === "dm" && dmAgentId ? runs : NO_RUNS;
  const pillConsults = pillKind === "dm" && dmAgentId ? lineBase : NO_LINE;
  // What stands in the bar beside "…", which the pill makes room for (`pillRoom`): our counted views first, as wide as
  // they lay out (`barLead`, measured), then the system's buttons (the computer, search).
  const [computerWords, setComputerWords] = useState<string | null>(null);
  const queueInBar = Boolean(queueShown && barQueue && queueMachineId);
  const tasksInBar = Boolean(dmAgentId && agentTasks);
  const [leadWidth, setLeadWidth] = useState(0);
  const leadRoom = queueInBar || tasksInBar ? leadWidth : 0;
  const computerInBar = Boolean(dmAgentId && !isThread && computerWords && !queueInBar);
  const dmExtra = computerInBar ? 1 : 0;
  const channelExtra = searchPlace ? 1 : 0;
  const codeComputer = codeSession && codeComputerWords ? codeSession.agentId : null;
  const threadExtra = channelExtra + (codeComputer ? 1 : 0);
  // The channel's sky in the pill, as an agent's DM: the color of the first agent in it.
  const channelColor = agentLook(dir.agentById.get(roster.data?.find((r) => r.type === "agent")?.id ?? "")).color;
  const dmColor = dmAgentId ? agentLook(dmAgent).color : undefined;
  const hereLine = roster.data ? t("mobile.chat.here", { count: roster.data.length }) : undefined;
  // Reading far up, a DM's pill closes to the face (the screen is the messages); a new reply opens it again.
  const quietBelow = unseen.messages === 0;
  const pillInView = focused || peeking;
  const pill = useMemo(
    () =>
      pillKind === "thread" ? (
        <ThreadPill
          title={pillTitle}
          subtitle={pillSubtitle}
          onPress={codeId ? pressCode : pressOptions}
          icon={codeId ? "code" : "reply"}
          extraActions={threadExtra}
          leadRoom={leadRoom}
          onHold={onHoldPill}
          holdHint={holdHint}
          label={t(codeId ? "mobile.coding.pill" : "mobile.chat.headerChannel", {
            who: who(pillTitle, pillSubtitle ?? ""),
          })}
        />
      ) : pillKind === "dm" && dm ? (
        <DmPill
          name={dm.with.name}
          withType={dm.with.type}
          withId={dm.with.id}
          agentId={dmAgentId}
          says={!isThread}
          roleLine={subtitle}
          runs={pillRuns}
          consults={pillConsults}
          consultData={consultData}
          color={dmColor}
          far={far}
          quietBelow={quietBelow}
          extraActions={dmExtra}
          leadRoom={leadRoom}
          inView={pillInView}
          onPress={dmAgentId ? pressAgent : pressOptions}
          onHold={onHoldPill}
          holdHint={holdHint}
        />
      ) : pillKind === "channel" && channel ? (
        <ChannelPill
          title={channel.name}
          subtitle={hereLine}
          color={channelColor}
          roster={roster.data}
          onPress={pressMembers}
          extraActions={channelExtra}
          leadRoom={leadRoom}
          inView={pillInView}
          onHold={onHoldPill}
          holdHint={holdHint}
          // A channel's pill opens who is in it, and says so (its "…" holds the options).
          label={t("mobile.chat.headerMembers", { who: who(title, subtitle ?? "") })}
        />
      ) : null,
    [
      pillKind,
      title,
      subtitle,
      pillTitle,
      pillSubtitle,
      codeId,
      pressCode,
      threadExtra,
      pressOptions,
      onHoldPill,
      holdHint,
      t,
      dm,
      dmAgentId,
      isThread,
      pillRuns,
      pillConsults,
      consultData,
      dmColor,
      far,
      quietBelow,
      dmExtra,
      pillInView,
      pressAgent,
      channel,
      hereLine,
      channelColor,
      roster.data,
      pressMembers,
      channelExtra,
      leadRoom,
    ],
  );
  // An agent's DM also opens its tasks while it has some (ADR 0128), pushed like a thread, and its computer (as the
  // web's DM header) for whoever may watch it: one entry, the line while turns wait for the computer (the way on to
  // it inside), else the computer.
  const dmComputer = dmAgentId && !isThread ? { agentId: dmAgentId, onOpen: leavePlace } : undefined;
  // The bar's buttons: one group on every platform, whatever shows. First our own counted views, which have no system
  // button (the agent's tasks, the computer's line; `lead`), then the system's own buttons (the computer, search, "…";
  // our icon buttons in the same capsule on Android). Never two ways of drawing it: a bar that switched to our views
  // while a count showed drew its buttons apart one moment and together the next.
  const hasBar = Boolean((isThread && info) || dm || channel);
  const queueButton =
    queueShown && barQueue && queueMachineId ? (
      dmComputer ? (
        <DmQueueButton
          agentId={dmComputer.agentId}
          queue={barQueue}
          onPress={() => openQueue(queueMachineId, dmComputer)}
        />
      ) : (
        <QueueButton queue={barQueue} onPress={() => openQueue(queueMachineId)} />
      )
    ) : null;
  const tasksButton =
    dmAgentId && agentTasks ? (
      <AgentTasksButton
        agentId={dmAgentId}
        view={agentTasks}
        onPress={() => {
          leavePlace();
          router.push(agentTasksHref(dmAgentId, { channelId, threadId }));
        }}
      />
    ) : null;
  const barLead =
    hasBar && (tasksButton || queueButton) ? (
      <View style={styles.barLead} onLayout={(e) => setLeadWidth(Math.round(e.nativeEvent.layout.width))}>
        {tasksButton}
        {queueButton}
      </View>
    ) : undefined;
  const barActions: HeaderAction[] | undefined = hasBar
    ? [
        // Its AI and model are changed on its profile ("Pensa com"), not from the bar. The computer's line, while it
        // shows, is the way to the computer.
        ...(dmComputer && computerWords && !queueButton
          ? [dmComputerAction(dmComputer.agentId, computerWords, leavePlace)]
          : []),
        // A code session's agent's computer (its code is the pill's).
        ...(codeComputer && codeComputerWords ? [dmComputerAction(codeComputer, codeComputerWords, leavePlace)] : []),
        // A DM searches from its "…" (its name and the agent's own buttons keep the room).
        ...(searchPlace && !dm
          ? [
              {
                icon: "search" as const,
                sf: "magnifyingglass" as const,
                label: t("searchPage.searchHere"),
                onPress: openSearch,
              },
            ]
          : []),
        codeMore ?? { icon: "more", sf: "ellipsis", label: t("mobile.chat.options"), onPress: openOptions },
      ]
    : undefined;
  return (
    <>
      {/* A clear bar on every conversation (DM, channel, thread): the band behind it is ours, below, so the
          system's scroll edge never makes one look different from another. */}
      <PushedHeader
        title={pill ?? title}
        plate
        solid={false}
        {...(barActions ? { actions: barActions, lead: barLead } : {})}
      />
      {dmComputer ? <DmComputerWords agentId={dmComputer.agentId} onWords={setComputerWords} /> : null}
      {codeSession ? <DmComputerWords agentId={codeSession.agentId} onWords={setCodeComputerWords} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  // The counted buttons side by side, first in the bar's group (`barLead`).
  barLead: { flexDirection: "row", alignItems: "center" },
});
