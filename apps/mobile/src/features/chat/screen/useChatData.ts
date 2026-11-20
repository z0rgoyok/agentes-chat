import {
  type Channel,
  channelsQuery,
  type DirectMessage,
  dmsQuery,
  heldTakeoversHere,
  inMainTimeline,
  type LiveRun,
  MESSAGES_PAGE,
  type Message,
  useAgentsBrowserHandoffs,
  type useApi,
  useChannelThreads,
  useDmReads,
  useHeldPlaces,
  useJoinChannel,
  useMessages,
  usePins,
  useRightHandWave,
  useRoster,
  useThreadInfo,
  useThreadMessages,
  useThreadMission,
} from "@agenteschat/client";
import { managesAgent } from "@agenteschat/client/lib/audience";
import { CHAT_RHYTHM } from "@agenteschat/client/lib/chat-look";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { seenMessageId } from "@agenteschat/client/lib/seen";
import { makingImage } from "@agenteschat/client/lib/work";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused, useIsPreview } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { frameClock } from "@/agent/clock";
import { rightHandSeen } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import type { ComposerWorking } from "@/ui";
import { useSetupSteps } from "../../agents/setup/SetupCard";
import { usePlanHold } from "../../ai/parts";
import type { Directory } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import { browsingRuns } from "../LiveRows";
import { useChatLive } from "../live";
import { mayStopRun, mergeTimeline, pinnedAsListed, quietInset, sameItems, stoppableInLine } from "../logic";
import { useConversationLook, useConversationWallpaper } from "../look";
import { useMentionMembers } from "../MentionPicker";
import { rememberTurn, turnItems, turnRuns, turnSignature } from "../turn";

/** A run's messages this recent are asked whether a take over still holds the agent's browser. */
const HELD_RECENT_MS = 12 * 60 * 60_000;

/**
 * What the conversation shows, read and derived: its row in the lists and its look, its messages and older pages, the
 * live work in it and the agents' blocks drawn from that work. The conversation calls it first, as these were first.
 */
export function useChatData({
  channelId,
  threadId,
  orgId,
  meId,
  api,
  dir,
}: {
  channelId: string;
  threadId: string | null;
  orgId: string;
  meId: string | null;
  api: ReturnType<typeof useApi>;
  dir: Directory;
}) {
  // This conversation's row of each list, not the lists: they are read again for a message anywhere in the workspace,
  // and every conversation open was drawn again with each read.
  const ownChannel = useCallback((all: Channel[]) => all.find((x) => x.id === channelId), [channelId]);
  const ownDm = useCallback((all: DirectMessage[]) => all.find((d) => d.channelId === channelId), [channelId]);
  const channels = useQuery({ ...channelsQuery(api, orgId), select: ownChannel });
  const dms = useQuery({ ...dmsQuery(api, orgId), select: ownDm });
  const channel = channels.data;
  const dm = dms.data;
  // A conversation the loaded lists don't have yet (opened a moment ago, or reached by a link): they load
  // again once, so the header gets its name.
  const unlisted = channels.isSuccess && dms.isSuccess && !channel && !dm;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once each time the conversation goes missing
  useEffect(() => {
    if (!unlisted) return;
    void channels.refetch();
    void dms.refetch();
  }, [unlisted]);
  const isThread = Boolean(threadId);
  const thread = useThreadInfo(orgId, threadId);
  const missionQ = useThreadMission(orgId, threadId);
  const mission = missionQ.data ?? null;
  const dmAgentId = dm?.with.type === "agent" ? dm.with.id : null;
  const dmAgent = dmAgentId ? dir.agentById.get(dmAgentId) : undefined;
  const rightHandId = useMemo(() => dir.agents.find(isRightHand)?.id, [dir.agents]);
  const convoDm = Boolean(dm) || thread.data?.channelKind === "dm";
  const dmAgentColor = dmAgent ? agentLook(dmAgent).color : undefined;
  const rowLook = useConversationLook(convoDm, dmAgentColor, channelId);
  // Mine alone: this conversation's background, behind the list, the clear bar and the composer.
  const backdrop = useConversationWallpaper(convoDm, channelId, dmAgentColor);
  const walled = rowLook.wallpaper === true;
  const rhythm = CHAT_RHYTHM[rowLook.style];
  const quiet = quietInset(rowLook);
  // The right hand (ADR 0137): its own line and composer hint, and its greeting on top. Its computer opens as any agent's.
  const rightHand = isRightHand(dmAgent) && !isThread;
  // A new agent's setup checklist (ADR 0155 §2) for whoever sets it up: its greeting and the checklist on top.
  const setupIntro = useSetupSteps(dmAgent).length > 0 && !rightHand && !isThread;
  // Its DM is open, from its row or any other way in: its row's "Novo" goes.
  useEffect(() => {
    if (rightHand && meId) rightHandSeen.mark(rightHandSeenKey(meId, orgId));
  }, [rightHand, meId, orgId]);
  // Its wave on the person's first visit, kept here: the greeting moves into the list with the first message, and
  // the wave neither goes nor plays again.
  const wave = useRightHandWave(orgId, rightHand && dmAgent ? dmAgent.id : "");
  const waveFrom = useMemo(() => (wave ? frameClock.time() : undefined), [wave]);
  const member = dm ? true : (channel?.isMember ?? true);
  // An administrator reads every channel without joining it (ADR 0151): only what needs being in it waits for Entrar.
  const admin = can(useOrg().org, "administrator");
  const readable = member || admin;
  const roster = useRoster(orgId, channelId, Boolean(channel?.isMember) && !isThread);
  const join = useJoinChannel(orgId, channelId);
  // The "@" picker's sections: a channel's members (also in its threads); a DM has none.
  const mentionMembers = useMentionMembers(channelId, !dm && Boolean(channel?.isMember));

  // ── Messages ──
  const top = useMessages(orgId, channelId, readable && !isThread);
  const threadMessages = useThreadMessages(orgId, isThread && readable ? channelId : undefined, threadId ?? "");
  const channelThreads = useChannelThreads(orgId, channelId, "all", readable && !isThread);
  // Every thread with replies is a link under its root (as on the web): agents asked in the
  // channel answer in the channel, so a thread is always a conversation of its own.
  const linkThreads = useMemo(
    () =>
      new Map(
        (channelThreads.data?.threads ?? [])
          .filter((x) => x.state !== "archived" && (x.replyCount > 0 || x.mission || x.context))
          .map((x) => [x.id, x]),
      ),
    [channelThreads.data],
  );
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  // Going to a message far back shows the page around it on its own (`older`), apart from the latest page: newer
  // pages come as the person scrolls down, until they reach it.
  const [gap, setGap] = useState(false);
  // Something is pinned here: its lines wait above the first message (`PinnedLines`). Older pages take their pins from
  // it (`pinnedAsListed`): no cache update reaches them.
  const pinsData = usePins(orgId, channelId, member).data;
  const olderPinned = useMemo(() => pinnedAsListed(older, pinsData), [older, pinsData]);
  const list = useMemo(() => {
    if (isThread) {
      // My replies still sending wait in the channel's list.
      const mine = (top.data ?? []).filter((m) => m.local && m.threadId === threadId);
      return mergeTimeline(threadMessages.data ?? [], [mine]);
    }
    return mergeTimeline(gap ? olderPinned : [...olderPinned, ...(top.data ?? [])], []);
  }, [isThread, threadId, top.data, threadMessages.data, olderPinned, gap]);
  // Messages said in the channel itself: a "thinking" row the app guessed hangs off one of them.
  const topIds = useMemo(() => new Set(list.flatMap((m) => (m.threadId ? [] : [m.id]))), [list]);
  // A DM with a person: their face beside my latest message once they read it (live: `channel.read`).
  const reads = useDmReads(orgId, channelId, dm?.with.type === "person" && !isThread);
  const seenId = useMemo(
    () => (reads.data && meId ? seenMessageId(top.data ?? [], meId, reads.data) : null),
    [reads.data, top.data, meId],
  );
  const seenBy = seenId ? dm?.with.id : undefined;

  // ── Live ──
  // Under a screen pushed over it, it keeps listening and draws nothing until it is back (`useChatLive`'s `inView`).
  // Peeked at from the list (iOS's long press preview), it is live.
  const focused = useIsFocused();
  const peeking = useIsPreview();
  const live = useChatLive(orgId, channelId, readable, focused || peeking);
  // Agents my message here named that won't answer me: in this conversation or this thread only.
  const notices = useMemo(
    () => live.notices.filter((n) => (isThread ? n.threadId === threadId : n.threadId === null)),
    [live.notices, isThread, threadId],
  );
  // People's messages loaded over HTTP start (or catch up) their agents' receipts, as on the web.
  const { seed: seedReceipts } = live;
  useEffect(() => {
    if (list.length > 0) seedReceipts(list);
  }, [list, seedReceipts]);
  const runs = useMemo(
    () => live.runs.filter((r) => (isThread ? r.threadId === threadId : inMainTimeline(r, topIds))),
    [live.runs, isThread, threadId, topIds],
  );
  const consults = useMemo(
    () => live.consults.filter((x) => (isThread ? x.threadId === threadId : inMainTimeline(x, topIds))),
    [live.consults, isThread, threadId, topIds],
  );

  // "Parar" in the working line (as on the web): who manages the agent (the server's `canManage`), its owner, or who
  // started it.
  const { org } = useOrg();
  const canStop = useCallback(
    (r: LiveRun) =>
      mayStopRun(r, {
        meId,
        manageAgents: managesAgent(dir.agentById.get(r.agentId)),
        agentOwnerId: dir.agentById.get(r.agentId)?.ownerUserId,
        messages: list,
      }),
    [meId, dir.agentById, list],
  );
  const { stop } = live;
  const stopRun = useCallback(
    (r: LiveRun) => {
      if (meId) stop(r.runId, meId);
    },
    [meId, stop],
  );
  const { sendTyping } = live;
  // While an agent works here, a tap on send reaches it at its next pause and holding send stops it and sends (the
  // server takes a steer). "Parar" itself is a word at the end of the working line, the conversation's last line (and
  // of the live row while it shows): the composer keeps only its send, the one ink circle.
  const busyRuns = useMemo(() => stoppableInLine(runs).filter((r) => !r.stopping), [runs]);
  const stoppable = useMemo(() => stoppableInLine(runs).filter((r) => canStop(r)), [runs, canStop]);
  // The same object while someone works: the field isn't redrawn by each step of that work.
  const busy = busyRuns.length > 0;
  const working = useMemo<ComposerWorking | null>(() => (busy ? {} : null), [busy]);
  const lineStop = useMemo(
    () => (stoppable.length > 0 ? { runs: stoppable, onStop: stopRun } : undefined),
    [stoppable, stopRun],
  );

  // ── Agents' blocks ──
  // An agent at work in its browser: its card in the conversation, open on demand. The same array while its runs are
  // the same objects: another agent's step (a new `runs` many times a second) leaves the rows built from it alone.
  const browsingRef = useRef<readonly LiveRun[]>([]);
  const browsing = useMemo(() => {
    browsingRef.current = sameItems(browsingRef.current, browsingRuns(runs));
    return browsingRef.current;
  }, [runs]);
  // An agent making a picture: its place in the conversation, as the web's live row. Its row draws only who makes it,
  // so it is new only when that changes.
  const makingNow = runs.filter((r) => r.status !== "failed" && makingImage(r));
  const makingKey = makingNow.map((r) => `${r.runId}:${r.agentId}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `makingKey` stands for the runs making a picture
  const making = useMemo(() => makingNow, [makingKey]);
  // A take over held here after its run's live row went (the run paused for the person, or ended): the
  // same card stays, at the end, until the browser is handed back. Its runs: recent ones of this
  // conversation, the ones taken over here (or heard of in its events), and the live ones.
  const heldPlaces = useHeldPlaces();
  // The runs by their ids: an agent's step (a new `runs` many times a second) asks nothing new.
  const runIdsKey = runs.map((r) => r.runId).join(" ");
  const heldAsk = useMemo(() => {
    const since = Date.now() - HELD_RECENT_MS;
    const runIds = new Set<string>(runIdsKey ? runIdsKey.split(" ") : []);
    const agentIds = new Set<string>();
    for (const m of list) {
      if (m.author.type !== "agent" || !m.author.id || !m.agentRunId || Date.parse(m.createdAt) < since) continue;
      runIds.add(m.agentRunId);
      agentIds.add(m.author.id);
    }
    for (const p of heldPlaces) {
      if (p.channelId !== channelId || (isThread && p.threadId !== threadId)) continue;
      runIds.add(p.runId);
      agentIds.add(p.agentId);
    }
    return { runIds, agentIds: [...agentIds].sort() };
  }, [runIdsKey, list, heldPlaces, channelId, threadId, isThread]);
  const agentHandoffs = useAgentsBrowserHandoffs(orgId, heldAsk.agentIds);
  const heldNow = heldTakeoversHere(agentHandoffs, {
    runIds: heldAsk.runIds,
    drawnAgents: new Set(browsing.map((r) => r.agentId)),
  });
  const heldKey = heldNow.map((h) => `${h.id}:${h.runId}:${h.controllerUserId ?? ""}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the rows change only when what is held changes
  const held = useMemo(() => heldNow, [heldKey]);
  // Every agent at work here draws nothing in the conversation while it works: the line above the composer says who
  // works, on what and for how long, and its reply shows whole once posted, with the work it did (kept here, so the
  // reply shows it at once, `recentTurn`). A run in its browser has its browser card instead.
  const atWork = useMemo(() => turnRuns(runs, new Set(browsing.map((r) => r.runId))), [runs, browsing]);
  const workKey = useMemo(() => atWork.map((r) => `${r.runId}:${turnSignature(turnItems(r))}`).join("|"), [atWork]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `workKey` stands for the runs' work
  useEffect(() => {
    for (const run of atWork) rememberTurn(run.runId, { items: turnItems(run, true), at: Date.now() });
  }, [workKey]);

  // ── Older pages (channel view) ──
  // The row above the oldest message shows a page loading and, when one didn't come, the way to ask again (`OlderRow`):
  // a failed page is not the conversation's start, so the start stays to be reached.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  // The list asks for older rows on a layout change too, not only a scroll (Legend List 3.7): one page at a
  // time, whatever the state says this render.
  const fetchingOlder = useRef(false);
  const fetchOlder = useCallback(() => {
    if (isThread || olderDone || fetchingOlder.current || !top.data) return;
    const oldest = older[0] ?? top.data[0];
    if (!oldest || top.data.length < MESSAGES_PAGE) {
      setOlderDone(true);
      return;
    }
    fetchingOlder.current = true;
    setLoadingOlder(true);
    setOlderFailed(false);
    api.chat
      .messages(orgId, channelId, { before: oldest.createdAt, limit: MESSAGES_PAGE })
      .then((page) => {
        setOlder((prev) => [...page, ...prev]);
        if (page.length < MESSAGES_PAGE) setOlderDone(true);
      })
      .catch(() => setOlderFailed(true))
      .finally(() => {
        fetchingOlder.current = false;
        setLoadingOlder(false);
      });
  }, [api, orgId, channelId, isThread, olderDone, top.data, older]);
  // The list's own asks (reaching the top, a layout) stop after a page failed: without a connection they would ask
  // again at every layout. "Try again" on the row asks again.
  const loadOlder = useCallback(() => {
    if (!olderFailed && !loadingOlder) fetchOlder();
  }, [olderFailed, loadingOlder, fetchOlder]);
  /** Shows the page around a message: joined to the latest page when they meet, apart (`gap`) when not. */
  const showAround = useCallback(
    (page: Message[]) => {
      const start = top.data?.[0]?.createdAt;
      const joins = !start || (page.at(-1)?.createdAt ?? "") >= start;
      setOlder(joins && start ? page.filter((m) => m.createdAt < start) : page);
      setGap(!joins);
      setOlderDone(false);
      setOlderFailed(false);
    },
    [top.data],
  );
  const fetchingNewer = useRef(false);
  const loadNewer = useCallback(() => {
    const newest = older.at(-1);
    if (!gap || fetchingNewer.current || !newest) return;
    fetchingNewer.current = true;
    api.chat
      .messages(orgId, channelId, { after: newest.createdAt, limit: MESSAGES_PAGE })
      .then((page) => {
        const known = new Set(older.map((m) => m.id));
        const next = [...older, ...page.filter((m) => !known.has(m.id))];
        const start = top.data?.[0]?.createdAt;
        const met = page.length < MESSAGES_PAGE || (start !== undefined && (page.at(-1)?.createdAt ?? "") >= start);
        if (!met) {
          setOlder(next);
          return;
        }
        showAround(next);
        setGap(false);
      })
      .catch(() => undefined)
      .finally(() => {
        fetchingNewer.current = false;
      });
  }, [api, orgId, channelId, gap, older, top.data, showAround]);
  // The workspace's plan holding its agents: the no-AI banner and the key guard read it.
  const planHeld = usePlanHold(orgId, org) !== null;

  return {
    admin,
    atWork,
    backdrop,
    browsing,
    canStop,
    channel,
    channelThreads,
    consults,
    dm,
    dmAgent,
    dmAgentId,
    fetchOlder,
    focused,
    gap,
    held,
    isThread,
    join,
    lineStop,
    linkThreads,
    list,
    live,
    loadNewer,
    loadOlder,
    loadingOlder,
    making,
    member,
    mentionMembers,
    mission,
    notices,
    olderDone,
    olderFailed,
    org,
    peeking,
    pinsData,
    planHeld,
    quiet,
    readable,
    rhythm,
    rightHand,
    rightHandId,
    roster,
    rowLook,
    runs,
    seenBy,
    seenId,
    sendTyping,
    setGap,
    setOlder,
    setOlderDone,
    setupIntro,
    showAround,
    stopRun,
    thread,
    threadMessages,
    top,
    unlisted,
    walled,
    waveFrom,
    working,
  };
}

export type ChatData = ReturnType<typeof useChatData>;
