import { useWaitingOnMe } from "@agenteschat/client";
import { mentionsReader } from "@agenteschat/client/lib/everyone";
import { isMediaAfterReply } from "@agenteschat/client/lib/media";
import { answerIds, shownWhole } from "@agenteschat/client/lib/message-length";
import { lastPostedId } from "@agenteschat/client/lib/timeline";
import { waitingAway, waitingNotification } from "@agenteschat/client/lib/waiting";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useReducedMotion } from "@/ui";
import { router } from "@/ui/navigation";
import { notificationHref } from "../../links/logic";
import type { useAwayAsk } from "../asks";
import type { OpenedMessages } from "../ClippedMessage";
import { composerLift, createDockHeight } from "../dock-height";
import { timesOnPull } from "../look";
import { appendedKeys, arrivesNow, bandAim, lastSeenKey, type ScrollRow, type Unseen, unseenBelow } from "../scroll";
import { useSwipeTimePan } from "../swipe-time";
import { FRESH_MS } from "./constants";
import { createValueStore, useLatest } from "./hooks";
import { type Row, rowKey } from "./rows";
import type { ChatData } from "./useChatData";
import { useShownRows } from "./useChatRows";

/** How close to the end a scroll has to stop for a list held at a long message's start to follow again. */
const READ_RELEASE_PX = 24;

/**
 * Following the conversation's end: the list's ref, where the person reads (at the end, held at a long message's
 * start), what arrived below them, the "Novas" line and the rows that rise in, and the moves to the end and to a
 * request.
 */
export function useFollowEnd({
  channelId,
  threadId,
  orgId,
  meId,
  myHandle,
  keyboardAt,
  awayAsk,
  rows,
  data,
}: {
  channelId: string;
  threadId: string | null;
  orgId: string;
  meId: string | null;
  myHandle: string | null;
  keyboardAt: ReturnType<typeof useReanimatedKeyboardAnimation>;
  awayAsk: ReturnType<typeof useAwayAsk>;
  rows: Row[];
  data: Pick<ChatData, "atWork" | "focused" | "gap" | "list" | "rowLook" | "setGap" | "setOlder" | "setOlderDone">;
}) {
  const { atWork, focused, gap, list, rowLook, setGap, setOlder, setOlderDone } = data;
  // ── Following the end ──
  // The list sticks to the end only while the person is near it (Legend List's maintainScrollAtEnd); farther
  // up nothing moves (the scroll is never taken): the round button at the top right counts what arrived below (in
  // red when it mentions me) and goes back to the end, and a "Novas" line marks the first of it.
  const listRef = useRef<LegendListRef>(null);
  // The person dragging the list, a new hold on their place (see "Keeping the place") and the app moving it on
  // purpose (sending, the pill, a pin): each lets go of a held place.
  const dragging = useRef(false);
  const holding = useRef(0);
  const aimed = useRef(0);
  const letGo = useCallback(() => {
    holding.current++;
    aimed.current++;
  }, []);
  // The room the list shows rows in: under the floating bar (a pinned card already holds that room) and over the dock
  // riding the keyboard. Its top and the keyboard's share are set as the screen draws (`band.current`, below), the
  // dock's height as it lays out (`dock`, `onComposerBoxLayout`); it is read when the list is aimed, after that.
  const band = useRef({ top: 0, lift: 0 });
  const [dock] = useState(createDockHeight);
  const roomNow = useCallback(() => {
    const state = listRef.current?.getState();
    if (!state) return null;
    const { top, lift } = band.current;
    const keyboard = composerLift(keyboardAt.height.get(), keyboardAt.progress.get(), lift);
    return { state, top, height: state.scrollLength - top - dock.get() - keyboard };
  }, [dock, keyboardAt]);
  /** `scrollToIndex`'s place for a row in that room (`bandAim`): sent to the top, it lands under the bar. */
  const aimAt = useCallback(
    (index: number, viewPosition: number, tall: "start" | "end") => {
      const room = roomNow();
      if (!room) return { viewPosition };
      return bandAim({ viewPosition, size: room.state.sizeAtIndex(index), band: room.height, top: room.top, tall });
    },
    [roomNow],
  );
  const scrollRows = useMemo<ScrollRow[]>(
    () =>
      rows.map((r) => ({
        key: r.key,
        kind: r.kind === "message" ? "message" : "other",
        ...(r.kind === "message" ? { id: r.message.id } : {}),
        mine: r.kind === "message" && r.message.author.type === "person" && r.message.author.id === meId,
        // An agent's sticker or GIF after its reply (ADR 0091) is never news of its own.
        silent: r.kind === "message" && isMediaAfterReply(r.message.meta),
        mentionsMe: r.kind === "message" && r.message.author.id !== meId && mentionsReader(r.message, myHandle),
        ...(r.kind === "message" && r.message.author.id
          ? { who: `${r.message.author.type}:${r.message.author.id}` }
          : {}),
      })),
    [rows, meId, myHandle],
  );
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(atEnd);
  atEndRef.current = atEnd;
  // Held at the start of a long message someone else wrote (see "Reading from the top"), or where "Ver mais" opened
  // one: the list doesn't follow the end until the person gets there, sends, or takes the pill.
  const [readHold, setReadHold] = useState(false);
  // Going to the end (a send, the round button): for `GLIDE_MS` the list's own follow of its end glides instead of
  // jumping (`GLIDE`), so a message just sent slides up into view in one motion as the rows and the dock settle under it.
  // A count, so each send starts its own.
  const [glide, setGlide] = useState(0);
  const gliding = useRef(false);
  gliding.current = glide > 0;
  // The person's first touch here, anywhere (a scroll, the box, a message): the day's greeting closes a while after.
  // Outside the screen's state (`ValueStore`): that touch, often the first scroll's, redraws the greeting alone.
  const [touched] = useState(() => createValueStore(false));
  const markTouched = useCallback(() => touched.set(true), [touched]);
  // The messages "Ver mais" opened in place: they stay open while the screen lives (rows unmount off screen), and while
  // the app runs (`shownWhole`), so a screen opened again starts with them.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(shownWhole));
  // The newest message and the reader's answer (`answerIds`), or one that mentions them: shown whole however long.
  const answers = useMemo(() => {
    const messages = scrollRows.flatMap((r) =>
      r.kind === "message" && r.id ? [{ id: r.id, mine: r.mine === true }] : [],
    );
    const ids = answerIds(messages);
    for (const r of scrollRows) if (r.mentionsMe && r.id) ids.add(r.id);
    return ids;
  }, [scrollRows]);
  // Read as each row draws, not a change of the screen's context: a row joins the answers only as it first draws (the
  // newest, or one after the reader's latest), and stays whole after (`shownWhole`).
  const answer = useLatest((id: string) => answers.has(id));
  const openedMessages = useMemo<OpenedMessages>(
    () => ({
      has: (id) => opened.has(id),
      open: (id) => {
        shownWhole.add(id);
        setOpened((s) => new Set(s).add(id));
        if (atEndRef.current) setReadHold(true);
      },
      answer,
    }),
    [opened, answer],
  );
  // The last row the person saw at the end, and the message posted last then (one posted since in a place above the
  // last row they saw, `PLACE_KEPT_MS`, is new to them too). Taken as the screen draws while it is at the end: set in
  // an effect after, they drew the whole conversation a second time for every message that landed.
  const latestSeen = lastSeenKey(scrollRows);
  const postedNow = useMemo(() => lastPostedId(list), [list]);
  const seenAt = useRef<{ key: string | null; posted: string | undefined }>({ key: null, posted: undefined });
  if (atEnd) seenAt.current = { key: latestSeen, posted: postedNow };
  const seenKey = seenAt.current.key;
  const seenPostedId = seenAt.current.posted;
  // More than a screen above the end: the round button shows even with nothing new below, and the header's pill
  // closes to the face. Outside the screen's state (`ValueStore`): crossing that line redraws those two alone.
  const [far] = useState(() => createValueStore(false));
  // Who writes now ("Atlas escrevendo"): its reply comes below, whole once posted.
  const writingKey = [...new Set(atWork.filter((r) => r.status === "running").map((r) => `agent:${r.agentId}`))].join(
    " ",
  );
  const unseen: Unseen = useMemo(
    () =>
      atEnd
        ? { messages: 0, firstKey: null, authors: [], working: [], mentionsMe: false }
        : { ...unseenBelow(scrollRows, seenKey, seenPostedId), working: writingKey ? writingKey.split(" ") : [] },
    [atEnd, scrollRows, seenKey, seenPostedId, writingKey],
  );
  const { shownRows, setPlacedDivider } = useShownRows({ rows, unseen, focused });
  // A long message someone else wrote, waiting to be measured and read from its top (see "Reading from the top").
  const toReadRef = useRef<string | null>(null);
  const toEnd = useCallback(() => {
    // Away from the latest page: back to it.
    if (gap) {
      setGap(false);
      setOlder([]);
      setOlderDone(false);
    }
    letGo();
    // Going to the end (a send, the round button) leaves nothing waiting to be read from the top: the room may have
    // shrunk since (the dock grew), and a reply that fit would be taken for a tall one as my message lands.
    toReadRef.current = null;
    setReadHold(false);
    setAtEnd(true);
    setGlide((n) => n + 1);
    requestAnimationFrame(() => void listRef.current?.scrollToEnd({ animated: true }));
  }, [letGo, gap, setGap, setOlder, setOlderDone]);

  // The person is at the end of what they were reading (they scrolled there, or the list landed there): the list
  // follows again, and the round button, with nothing below to go to, goes.
  const releaseAtEnd = useCallback(() => {
    const state = listRef.current?.getState();
    if (state && state.distanceFromEnd <= READ_RELEASE_PX) setReadHold(false);
  }, []);
  // "Ver" on the requests' line: the list goes to the request and stays there. It stops following the end, as
  // when reading a long message from its top, so a reply streaming in doesn't pull it back down; reaching the end,
  // sending or the pill follow again. The card ends its message: in the middle of the room, or, a message taller than
  // the room, its end.
  const holdAt = useCallback(
    (messageId: string | undefined) => {
      const key = messageId ? rows.find((r) => r.kind === "message" && r.message.id === messageId)?.key : undefined;
      if (!key) return false;
      letGo();
      setReadHold(true);
      // After the render that turns following off, so the end doesn't pull it back down.
      requestAnimationFrame(() => {
        const index = listRef.current?.getState().indexByKey(key);
        if (index === undefined) return;
        void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.5, "end") })?.then(releaseAtEnd);
      });
      return true;
    },
    [rows, letGo, aimAt, releaseAtEnd],
  );
  // The same function whatever the rows: the line above the composer isn't drawn again by each message.
  const seeAsk = useLatest(() => void holdAt(awayAsk?.ask.messageId));
  // What waits on me here with its card not loaded (older, or in a thread): the line counts it and opens the oldest.
  const waitingOnMe = useWaitingOnMe(orgId).data?.items;
  const waitingHere = useMemo(
    () =>
      waitingAway(
        waitingOnMe,
        channelId,
        threadId ?? null,
        new Set(rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []))),
      ),
    [waitingOnMe, channelId, threadId, rows],
  );
  const waitingFirst = awayAsk ? undefined : waitingHere[0];
  const seeWaiting = useCallback(() => {
    const href = waitingFirst && notificationHref(waitingNotification(waitingFirst));
    if (href) router.push(href);
  }, [waitingFirst]);

  // Rows that arrive at the bottom while the screen is open rise in; older pages, the first load and what the server
  // sends right after opening (messages written before it opened, `arrivesNow`) don't.
  const prevKeysRef = useRef<string[]>([]);
  const freshRef = useRef(new Map<string, number>());
  const openedAt = useRef(Date.now());
  const rowKeys = useMemo(() => rows.map(rowKey), [rows]);
  useMemo(() => {
    const now = Date.now();
    const appended = appendedKeys(prevKeysRef.current, rowKeys);
    const byKey = appended.length > 0 ? new Map(rows.map((r) => [rowKey(r), r])) : null;
    for (const key of appended) {
      const row = byKey?.get(key);
      if (row?.kind === "message" && !arrivesNow(row.message.createdAt, openedAt.current)) continue;
      freshRef.current.set(key, now);
    }
    for (const [key, t0] of freshRef.current) if (now - t0 > FRESH_MS) freshRef.current.delete(key);
  }, [rowKeys, rows]);
  useEffect(() => {
    prevKeysRef.current = rowKeys;
  }, [rowKeys]);
  // Less motion asked for: nothing rises in.
  const stillRows = useReducedMotion();
  // The way to the times in a conversation of bubbles (they hold none): a pull to the left (`swipe-time.tsx`).
  const timePull = useSharedValue(0);
  const timePan = useSwipeTimePan(timePull, timesOnPull(rowLook.style), stillRows);
  const isFresh = useCallback(
    (key: string) => {
      const t0 = freshRef.current.get(key);
      return !stillRows && t0 !== undefined && Date.now() - t0 <= FRESH_MS;
    },
    [stillRows],
  );

  return {
    aimAt,
    aimed,
    atEnd,
    atEndRef,
    band,
    dock,
    dragging,
    far,
    glide,
    gliding,
    holding,
    isFresh,
    letGo,
    listRef,
    openedMessages,
    postedNow,
    readHold,
    releaseAtEnd,
    roomNow,
    rowKeys,
    scrollRows,
    seeAsk,
    seeWaiting,
    setAtEnd,
    setGlide,
    setPlacedDivider,
    setReadHold,
    shownRows,
    timePan,
    timePull,
    toEnd,
    toReadRef,
    touched,
    markTouched,
    unseen,
    waitingFirst,
    waitingHere,
  };
}

export type FollowEnd = ReturnType<typeof useFollowEnd>;
