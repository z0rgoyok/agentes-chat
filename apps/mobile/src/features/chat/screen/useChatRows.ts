import {
  codeSessionOf,
  fileConversationOf,
  type Message,
  type ReceiptsState,
  type RunConsultation,
  useConsultations,
  useSteerState,
} from "@agenteschat/client";
import { conversationWaits } from "@agenteschat/client/lib/computer-queue";
import {
  asExchanges,
  consultBlocksNearEnd,
  consultNoticeFolds,
  consultsForLine,
  relayedAnswers,
} from "@agenteschat/client/lib/consult-group";
import { taskConversationOf } from "@agenteschat/client/lib/issues";
import { supersededBrainNotices } from "@agenteschat/client/lib/machine-outages";
import { stopsMovedOn } from "@agenteschat/client/lib/work";
import { useEffect, useMemo, useRef, useState } from "react";
import type { useTranslation } from "react-i18next";
import { markRowId, receiptMessageId } from "../agent-receipts";
import { buildRows, keepSameRows } from "../logic";
import { timesOnPull } from "../look";
import type { Unseen } from "../scroll";
import { movedOnKey, stoppedRunsKey, stoppedRunsOf } from "../stopped-runs";
import { DIVIDER_KEY, isQuietLine, type Row } from "./rows";
import type { ChatData } from "./useChatData";

/** No questions to other agents here (yet): the same list each time, so the memos over it keep. */
const NO_CONSULTATIONS: RunConsultation[] = [];

/**
 * The conversation's rows: its messages' rows (a thread's head first) and the live ones after them, and what is worked
 * out from the messages for them (the questions' folds, the stops, the work handed off).
 */
export function useChatRows({
  channelId,
  threadId,
  orgId,
  t,
  data,
}: {
  channelId: string;
  threadId: string | null;
  orgId: string;
  t: ReturnType<typeof useTranslation>["t"];
  data: Pick<
    ChatData,
    | "atWork"
    | "browsing"
    | "channel"
    | "channelThreads"
    | "consults"
    | "dm"
    | "held"
    | "isThread"
    | "list"
    | "live"
    | "making"
    | "readable"
    | "rowLook"
    | "runs"
    | "thread"
    | "threadMessages"
    | "top"
  >;
}) {
  const {
    atWork,
    browsing,
    channel,
    channelThreads,
    consults,
    dm,
    held,
    isThread,
    list,
    live,
    making,
    readable,
    rowLook,
    runs,
    thread,
    threadMessages,
    top,
  } = data;
  // ── Rows ──
  // One waiting card per agent and computer: an older "my computer is away" gives way to the newer one.
  const superseded = useMemo(() => supersededBrainNotices(list), [list]);
  // Looked for again when the messages, the receipts or which runs there are change, not on every redraw (an agent's
  // step).
  const liveRunIds = live.runs.map((r) => r.runId).join(" ");
  const waitsNow = useMemo(() => {
    const ids = new Set(liveRunIds ? liveRunIds.split(" ") : []);
    return conversationWaits(isThread ? list : list.filter((m) => !m.threadId), live.receipts, (id) => ids.has(id));
  }, [isThread, list, live.receipts, liveRunIds]);
  const waitsKey = waitsNow.map((w) => `${w.agentId}:${w.runId}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: new only when the waits change, not on every receipt
  const waits = useMemo(() => waitsNow, [waitsKey]);
  // A thread's first line: in a DM, with whom (its channel name is internal, "dm-…"); in a channel, where. Its words and
  // its count, not the lists' objects: the DM and channel lists are read again with each message, and the rows were
  // all built again with them.
  const startedText = isThread
    ? thread.data?.channelKind === "dm" || dm
      ? t("mobile.chat.startedWith", { name: dm?.with.name ?? "" })
      : t("mobile.chat.startedIn", { channel: thread.data?.channelName ?? channel?.name ?? "" })
    : "";
  const replyCount = thread.data?.replyCount;
  // In bubbles and compact the messages show no time (a pull does): a line says when the conversation picks up again
  // (`PAUSE_MS`).
  const timeLines = timesOnPull(rowLook.style);
  // Questions agents asked other agents from here: the pair rows below, and the consulted agents' words their askers
  // pass on right after (`relayedAnswers`), folded into the quote at the top of the asker's message. Out of the rows
  // themselves, so what groups around them groups as if they weren't there; worked out again with the messages, the
  // rows built again only when a fold changes.
  const consultations = useConsultations(orgId, channelId);
  const consultData = consultations.data;
  const relaysNow = useMemo(() => {
    const shown = isThread && threadId ? list.filter((m) => m.id !== threadId) : list.filter((m) => !m.threadId);
    return relayedAnswers(
      [...shown].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      consultData ?? NO_CONSULTATIONS,
    );
  }, [isThread, threadId, list, consultData]);
  const relaysKey = [...relaysNow.relays].map(([id, r]) => `${id}:${r.message.id}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `relaysKey` stands for the folds
  const relays = useMemo(() => relaysNow, [relaysKey]);
  // The messages' rows, built again only when the messages (or the thread's head) change: an agent's run events, many a
  // second while it works, touch only the live rows after them.
  const messageRows = useMemo<Row[]>(() => {
    // The asker's message that passes another agent's words on carries them, for its quote.
    const withRelays = (rows: Row[]): Row[] =>
      relays.relays.size === 0
        ? rows
        : rows.map((row) => {
            const relay = row.kind === "message" ? relays.relays.get(row.message.id) : undefined;
            return relay && row.kind === "message" ? { ...row, relay } : row;
          });
    if (isThread && threadId) {
      const root = list.find((m) => m.id === threadId);
      const replies = list.filter((m) => m.id !== threadId);
      // A task's conversation (ADR 0145): its root stands for the task, one screen back; only the replies show. A
      // live file's (ADR 0199) the same, under where the file was made, and a code session's (ADR 0215), whose root
      // is never shown: under where it was opened from, when a suggestion opened it (§11).
      const file = root ? fileConversationOf(root.meta) : null;
      const code = root ? codeSessionOf(root.meta) : null;
      const head: Row[] = file
        ? [{ kind: "origin", key: "origin", artifactId: file.artifactId, fileKind: file.kind }]
        : code?.fromChat
          ? [{ kind: "codeOrigin", key: "code-origin", sessionId: code.sessionId }]
          : root && !taskConversationOf(root.meta) && !codeSessionOf(root.meta)
            ? [
                { kind: "marker", key: "started", text: startedText },
                // The root as it started the thread (its mission card is pinned above already).
                {
                  kind: "message",
                  key: root.id,
                  message: { ...root, meta: { ...root.meta, missionStart: undefined, missionLink: undefined } },
                  grouped: false,
                },
                {
                  kind: "marker",
                  key: "replies",
                  text: t("mobile.chat.replies", { count: replyCount ?? replies.length }),
                },
              ]
            : [];
      const hidden = (m: Message) => superseded.has(m.id) || relays.relayed.has(m.id);
      return withRelays([...head, ...buildRows(replies, hidden, timeLines)]);
    }
    // A thread's replies live in the thread; the channel shows its link.
    const hidden = (m: Message) => superseded.has(m.id) || Boolean(m.threadId) || relays.relayed.has(m.id);
    return withRelays(buildRows(list, hidden, timeLines));
  }, [isThread, threadId, list, startedText, replyCount, superseded, timeLines, relays, t]);
  // What agents do here now, after the messages: browser cards, a picture on its way, turns waiting for a computer.
  const liveRows = useMemo<Row[]>(
    () => [
      ...browsing.map((run) => ({ kind: "browser" as const, key: `browser-${run.agentId}`, run })),
      ...held.map((h) => ({ kind: "browser" as const, key: `browser-${h.agentId}`, run: null, handoff: h })),
      ...making.map((run) => ({ kind: "image" as const, key: `image-${run.runId}`, run })),
      ...waits.map((wait) => ({ kind: "wait" as const, key: `wait-${wait.runId ?? wait.agentId}`, wait })),
    ],
    [browsing, held, making, waits],
  );
  const rows = useMemo(
    () => (liveRows.length > 0 ? [...messageRows, ...liveRows] : messageRows),
    [messageRows, liveRows],
  );
  // From the messages' rows alone (the live rows hold none): what is built on them keeps through run events.
  const shownMessages = useMemo(
    () => messageRows.flatMap((r) => (r.kind === "message" ? [r.message] : [])),
    [messageRows],
  );
  // Questions agents asked other agents, in the pair row before the replies that asked (`ConsultGroup`): how each
  // answer's notice draws (hidden under a reply close by, one line to one farther up, and while its asker still works
  // and posted nothing yet: its reply brings the row), and the working line without the questions a reply near the
  // end shows (an asker at work shows none: the line says them).
  // An exchange between the same two agents draws on its first asking run's reply (`asExchanges`).
  const consultList = useMemo(() => (consultData ? asExchanges(consultData) : NO_CONSULTATIONS), [consultData]);
  // The threads' links under their roots and these questions load beside the messages and change rows: the list waits
  // for them before it shows (`revealOpened`), so no row grows under the person as the conversation appears, at most
  // `ROWS_WAIT_MS` once the messages are in (a row's tap loads all three at once, `prefetchConversation`). Only on a
  // first read: messages already on the phone (in memory, or the snapshot, which keeps both lists with them) show at
  // once, as they did, never held behind two reads from the network.
  const openedOnPhone = useRef(
    isThread ? threadMessages.data !== undefined && !threadMessages.isPlaceholderData : top.data !== undefined,
  ).current;
  const rowsComplete =
    openedOnPhone || ((isThread || !readable || channelThreads.isFetched) && consultations.isFetched);
  const rowsCompleteRef = useRef(rowsComplete);
  rowsCompleteRef.current = rowsComplete;
  // By their ids: the folds below are worked out again when a turn starts or posts, not on each of its steps.
  const liveTurnsKey = useMemo(
    () => atWork.flatMap((r) => (shownMessages.some((m) => m.agentRunId === r.runId) ? [] : [r.runId])).join(" "),
    [atWork, shownMessages],
  );
  const liveTurns = useMemo(() => new Set(liveTurnsKey ? liveTurnsKey.split(" ") : []), [liveTurnsKey]);
  const foldsNow = useMemo(
    () => consultNoticeFolds(shownMessages, consultList, liveTurns, "first"),
    [shownMessages, consultList, liveTurns],
  );
  // The rows redraw when a notice's fold changes, not on every message (the folds are rebuilt on each).
  const foldsKey = [...foldsNow].map(([id, f]) => `${id}:${f.fold === "line" ? f.messageId : f.fold}`).join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `foldsKey` stands for the folds
  const consultFolds = useMemo(() => foldsNow, [foldsKey]);
  // One stop is one pill: the stopped reply's, with its notice's words (who, the reason), the notice itself drawing
  // nothing while that reply is here (`stoppedRunsOf`). Rebuilt with the messages, redrawn only when a stop changes.
  const stoppedNow = useMemo(() => stoppedRunsOf(shownMessages), [shownMessages]);
  const stoppedKey = stoppedRunsKey(stoppedNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stoppedKey` stands for the stops
  const stoppedRuns = useMemo(() => stoppedNow, [stoppedKey]);
  // A stop whose agent works here again, or wrote after it, is over: its pill offers no "Continue". At work for real,
  // not a guess at who will answer; by who, not by each step of their work.
  const atWorkAgents = runs.flatMap((r) => (r.provisional ? [] : [r.agentId])).join(" ");
  const movedNow = useMemo(
    () => stopsMovedOn(shownMessages, atWorkAgents ? atWorkAgents.split(" ") : []),
    [shownMessages, atWorkAgents],
  );
  const movedKey = movedOnKey(movedNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `movedKey` stands for the set
  const stopsMoved = useMemo(() => movedNow, [movedKey]);
  // Work handed off from here stays on the line for as long as it is out (ADR 0095 addendum), with the other agent's
  // state (`useLineConsults`, where the line and the header's pill are drawn: the workspace's presence changes often,
  // and the whole conversation was drawn again with each).
  const lineBase = useMemo(
    () => [
      ...consultsForLine(
        consults.filter((x) => x.kind !== "note"),
        consultBlocksNearEnd(shownMessages, consultList, undefined, "first"),
      ),
      ...consults.filter((x) => x.kind === "note"),
    ],
    [consults, shownMessages, consultList],
  );

  return {
    consultData,
    consultFolds,
    lineBase,
    rows,
    rowsComplete,
    rowsCompleteRef,
    shownMessages,
    stoppedRuns,
    stopsMoved,
  };
}

/**
 * The rows as the list shows them: the "Novas" line placed among them, a quiet line's and a turn's gaps, and each row
 * object kept as it was when nothing in it changed (`keepSameRows`).
 */
export function useShownRows({ rows, unseen, focused }: { rows: Row[]; unseen: Unseen; focused: boolean }) {
  // "Novas": before the first new row while the person reads above, in the same frame as that row (put a render later,
  // it pushed the row down under the person's eyes). It stays where it was put for as long as the conversation is on
  // screen, as a chat's own line does, and goes once the screen is left (out of sight): a line taken out while the
  // person scrolls moved every message under it.
  const [placedDivider, setPlacedDivider] = useState<string | null>(null);
  const dividerKey = placedDivider ?? unseen.firstKey;
  useEffect(() => {
    if (unseen.firstKey && !placedDivider) setPlacedDivider(unseen.firstKey);
  }, [unseen.firstKey, placedDivider]);
  useEffect(() => {
    if (!focused) setPlacedDivider(null);
  }, [focused]);
  // Each row object as it was when nothing in it changed (`keepSameRows`): the list redraws the rows that did.
  const shownRef = useRef<readonly Row[]>([]);
  const shownRows = useMemo(() => {
    const at = dividerKey ? rows.findIndex((r) => r.key === dividerKey) : -1;
    const all: Row[] = at >= 0 ? [...rows.slice(0, at), { kind: "unseen", key: DIVIDER_KEY }, ...rows.slice(at)] : rows;
    const next = all.map((r, i): Row => {
      if (r.kind !== "message") return r;
      const above = all[i - 1];
      if (isQuietLine(r)) return isQuietLine(above) ? { ...r, afterLine: true } : r;
      return r.grouped && (above?.kind !== "message" || isQuietLine(above)) ? { ...r, newTurn: true } : r;
    });
    shownRef.current = keepSameRows(shownRef.current, next);
    return shownRef.current;
  }, [rows, dividerKey]);
  return { shownRows, setPlacedDivider };
}

/** The agents' receipts the rows wear: the one on screen, its mark's row, and the fanned messages' own. */
export function useRowReceipts({
  orgId,
  channelId,
  meId,
  live,
  rowLook,
  rows,
  shownMessages,
}: {
  orgId: string;
  channelId: string;
  meId: string | null;
  live: ChatData["live"];
  rowLook: ChatData["rowLook"];
  rows: readonly Row[];
  shownMessages: Message[];
}) {
  // ── Agents' receipts ──
  // One receipt on screen (`receiptMessageId`): a mark beside my bubble, or at the end of the name line of someone
  // else's turn; a line under the message only for what asks something of you.
  const receiptId = useMemo(() => receiptMessageId(shownMessages, live.receipts), [shownMessages, live.receipts]);
  const receiptMine = Boolean(meId && shownMessages.find((m) => m.id === receiptId)?.author.id === meId);
  // Someone else's message sent into a task at work says nothing here (mine wears it: `ReceiptMark`).
  const receiptSteered = useSteerState(orgId, channelId, receiptId && !receiptMine ? receiptId : "") !== null;
  const markAt = useMemo(
    () =>
      !receiptId || receiptSteered
        ? null
        : receiptMine
          ? receiptId
          : markRowId(rows, receiptId, { faces: rowLook.faces, bubbles: rowLook.style === "bubbles" }),
    [receiptId, receiptSteered, receiptMine, rows, rowLook.faces, rowLook.style],
  );
  // The line redraws when what it shows changes, not on every event that touches the receipt (typing).
  const receiptNow = receiptId ? live.receipts[receiptId] : undefined;
  const receiptKey = receiptNow
    ? JSON.stringify([
        receiptNow.agents,
        receiptNow.routed,
        receiptNow.noAi ?? null,
        receiptNow.blocked ?? null,
        receiptNow.referenced ?? null,
        receiptNow.mentioned ?? null,
        receiptNow.picking ?? null,
        receiptNow.mentionNeeded ?? null,
        receiptNow.decidedBy ?? null,
      ])
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `receiptKey` stands for the receipt
  const receipt = useMemo(() => receiptNow, [receiptKey]);
  // Agents' messages that called several agents (their strip, `FanStrip`) and a person's mention of everyone one agent
  // answered for all (`EveryoneLine`). Only their receipts redraw the list.
  const fanned = useMemo(
    () =>
      shownMessages.filter(
        (m) => (m.author.type === "agent" && m.mentionedAgentIds.length > 1) || m.meta?.everyoneShape,
      ),
    [shownMessages],
  );
  const fanNow = fanned.map((m) => [m.id, live.receipts[m.id]] as const);
  const fanKey = JSON.stringify(fanNow);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fanKey` stands for the receipts
  const receipts: ReceiptsState = useMemo(() => Object.fromEntries(fanNow.filter(([, r]) => r)), [fanKey]);
  return { receiptId, receipt, markAt, receipts };
}

export type ChatRows = ReturnType<typeof useChatRows>;
