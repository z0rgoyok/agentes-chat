import type { MessagePin } from "@agenteschat/client";
import { screenAboveEnd } from "@agenteschat/client/lib/chat";
import { firstUnreadId, opensAtLastRead, unreadThreadRootId } from "@agenteschat/client/lib/chat-look";
import { issueTakenOf } from "@agenteschat/client/lib/issues";
import { isEventLine } from "@agenteschat/client/lib/notices";
import { ConversationSeat } from "@agenteschat/client/lib/seat-context";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef, OnViewableItemsChanged } from "@legendapp/list/react-native";
import { type ComponentProps, type ComponentRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { KeyboardEvents, type useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  type SharedValue,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useStillWhileScrolling } from "@/agent/live";
import { StickerStageContext } from "@/agent/StickerCanvas";
import { Text } from "@/ui";
import { AgentSetupIntro } from "../../agents/setup/SetupCard";
import { BrowserCard, BrowserRunCard } from "../../browser/BrowserCard";
import { CodeOrigin } from "../../coding/Origin";
import { ImageMaking } from "../../files/ImageMaking";
import { FileOrigin } from "../../live-files/talk/AboutLine";
import { QueueWaitRow } from "../../queue/parts";
import { RightHandIntro } from "../../right-hand/Intro";
import { type Directory, useColors, type useWhen } from "../../shared/hooks";
import { agentLook } from "../../shared/logic";
import { RetryLine } from "../../shared/TeamSkyEmpty";
import type { AskStore } from "../ask-store";
import { useAskWatch } from "../asks";
import { usePullPastEnd } from "../ChatPeek";
import { OpenedMessagesContext } from "../ClippedMessage";
import { DATE_PILL_IDLE_MS, DatePill } from "../DatePill";
import { composerLift } from "../dock-height";
import { EventLine } from "../EventLine";
import { IssueTakenLine } from "../issue-work";
import { dayInView } from "../logic";
import { RowLookContext, useRhythm } from "../look";
import { stickerRowsOnScreen } from "../media";
import { PinnedLines } from "../PinsSheet";
import { peekAgentOf } from "../peek";
import { appendedKeys, STICK_TO_END_THRESHOLD } from "../scroll";
import { StoppedRunsContext, StopsMovedOnContext } from "../stopped-runs";
import { SwipeTimeFrame } from "../swipe-time";
import { JumpToMessageContext } from "../WorkLine";
import { ChatMessage, type RowHands } from "./ChatMessage";
import { ENTER } from "./constants";
import { createValueStore, useValueOf, type ValueStore } from "./hooks";
import { REACH_LAST, reachOf, whenIdle } from "./reach";
import { DIVIDER_KEY, type Row, rowKey, rowType, STICKER_VIEW } from "./rows";
import type { ChatData } from "./useChatData";
import type { ChatRows, useRowReceipts } from "./useChatRows";
import type { ConversationActions } from "./useConversationActions";
import type { FollowEnd } from "./useFollowEnd";
import type { KeepPlace } from "./useKeepPlace";
import { WORK_FOOTER, type WorkLine, WorkLineContext } from "./work-line";

/**
 * The list's follow of its end, always gliding (`maintainScrollAtEnd`): a message sent or arriving, a reply's next line,
 * the dock growing under them slide the conversation up in one motion, never a jump.
 */
const GLIDE = { animated: true } as const;
/** A row the list takes to the top of the room (a long reply's start, the "Novas" line) sits this far under the bar. */
const BAND_GAP = 8;
/** The row above the oldest loaded message while older ones exist: one height whether it waits, loads or is empty. */
const OLDER_ROW = 44;
/** A time line's extra air above and under it (bubbles: "Today 15:35"). */
const TIME_LINE_AIR = 6;
/**
 * The agent peeking past the conversation's end (`ChatPeek`) where the list reports a pull there: iOS bounces past its
 * end; Android's list stops at it (its stretch is drawn, never in the offset).
 */
const PEEK = Platform.OS === "ios";
/** The list shows by itself after this even if it never said it was placed (ms). */
const SHOW_LIST_MS = 700;
/**
 * How long the threads' links and the agents' questions (rows the list waits for, `rowsComplete`) may hold the
 * conversation once its messages are in (ms): past it, it shows and a late one grows its row.
 */
const ROWS_WAIT_MS = 200;

/**
 * The conversation's list, drawn again only when what it is handed changes: the screen redraws for someone typing, a
 * presence, an agent's step, and the list (a large component) was drawn again with each. Typed as the list itself: a
 * memo keeps its props but not its item type.
 */
const ConversationList = memo(KeyboardAwareLegendList) as unknown as typeof KeyboardAwareLegendList;

type RowReceipts = ReturnType<typeof useRowReceipts>;

/**
 * Where the list opens and when it shows, the waiting requests it measures, the agent peeking past its end and a long
 * message read from its top. On the conversation itself, as before: these effects run where they always did, after
 * the place keeping and the list's ref.
 */
export function useListPlacement({
  focusId,
  meId,
  asks,
  keyboardAt,
  settled,
  hasPin,
  headerHeight,
  lift,
  showList,
  rowsRef,
  setAround,
  setSeek,
  rowData,
  follow,
  data,
}: {
  focusId: string | null;
  meId: string | null;
  asks: AskStore;
  keyboardAt: ReturnType<typeof useReanimatedKeyboardAnimation>;
  settled: boolean;
  hasPin: boolean;
  headerHeight: number;
  lift: number;
  showList: boolean;
  rowsRef: ConversationActions["rowsRef"];
  setAround: ConversationActions["setAround"];
  setSeek: ConversationActions["setSeek"];
  rowData: Pick<ChatRows, "rows" | "rowsComplete" | "rowsCompleteRef" | "shownMessages">;
  follow: Pick<
    FollowEnd,
    | "atEndRef"
    | "band"
    | "dock"
    | "far"
    | "letGo"
    | "listRef"
    | "releaseAtEnd"
    | "roomNow"
    | "rowKeys"
    | "scrollRows"
    | "setAtEnd"
    | "setPlacedDivider"
    | "setReadHold"
    | "toReadRef"
  >;
  data: Pick<
    ChatData,
    "channel" | "channelThreads" | "dm" | "dmAgentId" | "isThread" | "list" | "org" | "top" | "unlisted"
  >;
}) {
  const { rows, rowsComplete, rowsCompleteRef, shownMessages } = rowData;
  const {
    atEndRef,
    band,
    dock,
    far,
    letGo,
    listRef,
    releaseAtEnd,
    roomNow,
    rowKeys,
    scrollRows,
    setAtEnd,
    setPlacedDivider,
    setReadHold,
    toReadRef,
  } = follow;
  const { channel, channelThreads, dm, dmAgentId, isThread, list, org, top, unlisted } = data;
  // ── Requests out of view ──
  // A waiting request shows while 40 points of its card do in the list's band: below the floating header (a pinned
  // card already holds that room) and above the composer, which rides the keyboard less `lift` (its dock's offset).
  // Nothing is out of view before the list is placed at the end, so the line above the composer never flashes.
  const listFrame = useRef<ComponentRef<typeof View>>(null);
  const listPlaced = useRef(false);
  const askInsets = useCallback(() => {
    if (!listPlaced.current) return null;
    const keyboard = composerLift(keyboardAt.height.get(), keyboardAt.progress.get(), lift);
    return { top: hasPin ? 0 : headerHeight, bottom: dock.get() + keyboard };
  }, [hasPin, headerHeight, lift, dock, keyboardAt]);
  // A row the list doesn't draw now (outside what it keeps mounted) has no card: its request is out of view.
  const askDrawn = useCallback(
    (messageId: string) => {
      const state = listRef.current?.getState();
      const key = rowsRef.current.find((r) => r.kind === "message" && r.message.id === messageId)?.key;
      const index = state && key !== undefined ? state.indexByKey(key) : undefined;
      return state !== undefined && index !== undefined && index >= state.startBuffered && index <= state.endBuffered;
    },
    [listRef, rowsRef],
  );
  const watchList = useAskWatch(asks, { frame: () => listFrame.current, insets: askInsets, drawn: askDrawn });
  const onListScroll = useCallback(() => {
    watchList();
    const state = listRef.current?.getState();
    if (state) far.set(screenAboveEnd(state.distanceFromEnd, state.scrollLength));
  }, [watchList, far, listRef]);
  // The conversation's agent peeks up from behind the dock as the person pulls past the last message (`ChatPeek`), read
  // from the list's scroll view on the UI thread: the keyboard's list lends it through `refScrollView`, next to its own.
  const listScroll = useAnimatedRef<Animated.ScrollView>();
  const peekAgentId = useMemo(() => (PEEK ? peekAgentOf(dmAgentId, shownMessages) : null), [dmAgentId, shownMessages]);
  const pull = usePullPastEnd(listScroll, peekAgentId !== null && settled);

  // The list shows once it sits where it opens, at the end or at the "Novas" line (no frame of it placing itself), as
  // Bluesky's and Expensify's do; from a little opacity, not none, so the glass inside rows keeps drawing.
  const listShown = useSharedValue(0.05);
  const listFade = useAnimatedStyle(() => ({ opacity: listShown.value }));
  // Until then the conversation's skeleton stands where the messages will (`ChatSkeleton`), and leaves as they fade in.
  const [placed, setPlaced] = useState(false);
  // Opening at the latest message (no "Novas" line to open at, no message asked for): set once the lists say so.
  const opensAtEnd = useRef(false);
  const revealing = useRef(false);
  const revealList = useCallback(() => {
    if (revealing.current) return;
    revealing.current = true;
    const show = () => {
      listShown.value = withTiming(1, { duration: 120 });
      listPlaced.current = true;
      setPlaced(true);
      watchList();
    };
    if (!opensAtEnd.current) {
      show();
      return;
    }
    // Opening at its latest message, it shows only once it sits at its end, taken there three times over two frames, as
    // v0's and Expensify's lists do: the list says it is placed a frame before iOS applies its last adjustment (Legend
    // List #600), and a row measured late moves the end. Nothing of it moves under the person's eyes.
    void listRef.current?.scrollToEnd({ animated: false });
    requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd({ animated: false });
      requestAnimationFrame(() => {
        void listRef.current?.scrollToEnd({ animated: false });
        show();
      });
    });
  }, [listShown, watchList, listRef]);
  useEffect(() => {
    if (!showList) return;
    const timer = setTimeout(revealList, SHOW_LIST_MS);
    return () => clearTimeout(timer);
  }, [showList, revealList]);

  // Whether the list follows the end (its own intent: kept through a drag's momentum and while a scroll to the end
  // lands, released by reading up, rearmed back near the end): the "new messages" button shows otherwise.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    // A new list opens at the end (initialScrollAtEnd); only changes count from here, so the button never
    // flashes on open.
    setAtEnd(true);
    return state.listen("isFollowingEnd", setAtEnd);
  }, [showList, listRef, setAtEnd]);

  // "Última mensagem lida" with something unread: it opens at the "Novas" line, kept as it was on opening because
  // reading moves it. Threads open at their end, and a conversation asked to open at a message (a pin) at that message.
  // Read as the lists arrive: a notification can open it before them; one they don't have opens at its end.
  const readFrom = useRef<{ at: string | null | undefined } | null | undefined>(undefined);
  if (readFrom.current === undefined && (isThread || focusId || channel || dm || unlisted))
    readFrom.current =
      !isThread && !focusId && opensAtLastRead(org?.chatPrefs, channel?.unreadCount ?? dm?.unread ?? 0)
        ? { at: channel?.lastReadAt ?? dm?.lastReadAt }
        : null;
  const openFrom = readFrom.current;
  opensAtEnd.current = openFrom === null && !focusId;
  // The list laid out (`onReady`) shows only once where it opens is settled: placed at its end and taken to the line
  // after, it showed its end and then jumped. `SHOW_LIST_MS` still shows it whatever happens.
  const listReady = useRef(false);
  const atReadDone = useRef(false);
  const goingToLine = useRef(false);
  // The rows' own reads (`rowsComplete`) hold it no longer than `ROWS_WAIT_MS` once the messages are in.
  const rowsWaitOver = useRef(false);
  const revealOpened = useCallback(() => {
    if (
      listReady.current &&
      atReadDone.current &&
      !goingToLine.current &&
      (rowsCompleteRef.current || rowsWaitOver.current)
    )
      revealList();
  }, [revealList, rowsCompleteRef]);
  const onListReady = useCallback(() => {
    listReady.current = true;
    revealOpened();
  }, [revealOpened]);
  useEffect(() => {
    if (rowsComplete) revealOpened();
  }, [rowsComplete, revealOpened]);
  useEffect(() => {
    if (!showList || rowsComplete) return;
    const timer = setTimeout(() => {
      rowsWaitOver.current = true;
      revealOpened();
    }, ROWS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [showList, rowsComplete, revealOpened]);
  // The line at the top of the room under the bar, with no glide, what came since right under it (sent to the top as
  // is, it landed under the bar, the line and the first new message hidden). The list stops following its end there,
  // as when reading a long message from its top. The line is a row this same render puts in: the list has it a frame
  // or two on.
  const openAtLine = useCallback(
    (key: string) =>
      new Promise<void>((landed) => {
        letGo();
        setReadHold(true);
        let frames = 0;
        const go = () => {
          const list = listRef.current;
          const line = list?.getState().indexByKey(DIVIDER_KEY);
          if (list && line === undefined && ++frames < 4) {
            requestAnimationFrame(go);
            return;
          }
          const index = line ?? list?.getState().indexByKey(key);
          if (!list || index === undefined) {
            landed();
            return;
          }
          const viewOffset = band.current.top + BAND_GAP;
          void list.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset }).finally(landed);
        };
        // After the render that turns following off, so the end doesn't pull it back down.
        requestAnimationFrame(go);
      }),
    [letGo, band, listRef, setReadHold],
  );
  useEffect(() => {
    if (atReadDone.current || openFrom === undefined) return;
    if (openFrom === null) {
      atReadDone.current = true;
      revealOpened();
      return;
    }
    if (!showList || !top.data || rows.length === 0) return;
    const id = firstUnreadId(list, openFrom.at, meId);
    const key = rows.find((r) => r.kind === "message" && r.message.id === id)?.key;
    // A page kept from an earlier visit has none of them: wait for the fresh one.
    atReadDone.current = Boolean(key) || !top.isFetching;
    if (!key) {
      revealOpened();
      return;
    }
    setPlacedDivider(key);
    goingToLine.current = true;
    void openAtLine(key).then(() => {
      goingToLine.current = false;
      // All that came since fits above the dock: at the end already, it follows it.
      releaseAtEnd();
      revealOpened();
    });
  }, [
    openFrom,
    showList,
    top.data,
    top.isFetching,
    rows,
    list,
    meId,
    openAtLine,
    releaseAtEnd,
    revealOpened,
    setPlacedDivider,
  ]);

  // Opened with something unread that isn't at its end: a reply in a thread, one link under its root, maybe far
  // above. That root comes into view, flashed, instead of an end with nothing new (as on the web). Once, with what
  // was unread on opening; never over a message the screen was asked to open at.
  const openedUnread = useRef<{ count: number; at: string | null | undefined } | undefined>(undefined);
  if (openedUnread.current === undefined && (channel || dm))
    openedUnread.current = {
      count: isThread || focusId ? 0 : (channel?.unreadCount ?? dm?.unread ?? 0),
      at: channel?.lastReadAt ?? dm?.lastReadAt,
    };
  const threadLanded = useRef(false);
  useEffect(() => {
    const opened = openedUnread.current;
    // The messages and the threads as the server has them now: lists kept from an earlier visit know nothing new.
    if (threadLanded.current || !opened || !showList || !top.isSuccess || top.isFetching) return;
    if (opened.count > 0 && (!channelThreads.isSuccess || channelThreads.isFetching)) return;
    threadLanded.current = true;
    if (opened.count === 0) return;
    const root = unreadThreadRootId(
      list.filter((m) => !m.threadId),
      // A thread made from a range has no root in the conversation (its marker stands there).
      (channelThreads.data?.threads ?? []).filter((x) => !x.context),
      opened.at,
      meId,
    );
    if (!root) return;
    setAround(null);
    setSeek(root);
  }, [
    showList,
    top.isSuccess,
    top.isFetching,
    channelThreads.isSuccess,
    channelThreads.isFetching,
    channelThreads.data,
    list,
    meId,
    setAround,
    setSeek,
  ]);

  // ── Reading from the top ──
  // A message someone else wrote (an agent's reply, also while it streams, or a teammate's) taller than the room
  // between the bar and the box lands once with its first line under the bar, as on the web (`readingLanding`),
  // and the list stops following the end, so it reads top to bottom. Reaching the end, sending or the pill
  // follow again. Rows there when the conversation opens, and one arriving while the person reads above, never
  // move it.
  const landedRef = useRef(new Set<string>());
  const readPrevRef = useRef<string[]>([]);
  useEffect(() => {
    const byKey = new Map(scrollRows.map((r) => [r.key, r]));
    for (const key of appendedKeys(readPrevRef.current, rowKeys)) {
      const r = byKey.get(key);
      if (!r || r.kind === "other") continue;
      // Your own message goes to the end as always; what was waiting to be read before it no longer jumps.
      toReadRef.current = r.mine || landedRef.current.has(key) ? null : key;
    }
    readPrevRef.current = rowKeys;
  }, [rowKeys, scrollRows, toReadRef]);
  // Taller than the room it shows in (under the bar, over the dock and the keyboard). The list says the new size before
  // it measures the row (an estimate): a row not measured yet waits for its own size, never taken for a tall one.
  const checkReading = useCallback(() => {
    const key = toReadRef.current;
    const room = roomNow();
    if (!key || !room) return;
    const index = room.state.indexByKey(key);
    if (index === undefined) return;
    // Typed as always known; it is the measured size, and a row not measured yet has none.
    const size: number | undefined = room.state.sizeAtIndex(index);
    if (size === undefined || size <= room.height - BAND_GAP) return;
    toReadRef.current = null;
    landedRef.current.add(key);
    if (!atEndRef.current) return;
    setReadHold(true);
    // After the render that turns following off, so the end doesn't pull it back down.
    requestAnimationFrame(() => {
      const viewOffset = band.current.top + BAND_GAP;
      void listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0, viewOffset });
    });
  }, [roomNow, atEndRef, band, listRef, setReadHold, toReadRef]);
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", checkReading);
  }, [showList, checkReading, listRef]);
  // A reply is judged against the room it landed in. One that fit with the keyboard down is never judged again over
  // the keyboard: a row changing size while the person types pulled the conversation up to that old reply's first line.
  useEffect(() => {
    const shown = KeyboardEvents.addListener("keyboardWillShow", () => {
      toReadRef.current = null;
    });
    return () => shown.remove();
  }, [toReadRef]);
  // Rows growing or shrinking (a reply streaming, a card opening) move the waiting requests' cards and the live rows.
  useEffect(() => {
    if (!showList) return;
    const state = listRef.current?.getState();
    if (!state) return;
    return state.listen("totalSize", watchList);
  }, [showList, watchList, listRef]);

  return {
    listFade,
    listFrame,
    listScroll,
    onListReady,
    onListScroll,
    peekAgentId,
    placed,
    pull,
    watchList,
  };
}

export type ListPlacement = ReturnType<typeof useListPlacement>;

/**
 * The conversation's list in its frame: the rows, their contexts, the floating date, and the list's reach, which grows
 * once it shows and the push has ended. Drawn with the conversation; its reach, growing, redraws it alone.
 */
export function ChatList({
  when,
  dir,
  meId,
  canMission,
  canReply,
  flashId,
  channelId,
  threadId,
  orgId,
  connectInline,
  hands,
  offerAt,
  consultFolds,
  isFresh,
  isThread,
  linkThreads,
  replying,
  quiet,
  rhythm,
  seenBy,
  seenId,
  walled,
  markAt,
  receipt,
  receiptId,
  receipts,
  atStart,
  headerHeight,
  keyboardDragSettled,
  keyboardDragStarted,
  dmAgent,
  fetchOlder,
  loadingOlder,
  olderFailed,
  rightHand,
  setupIntro,
  waveFrom,
  dragging,
  releaseAtEnd,
  openPinsHere,
  goToPinHere,
  hasPins,
  stickers,
  placed,
  settled,
  listFade,
  listFrame,
  watchList,
  rightHandId,
  dm,
  thread,
  jumpToMessage,
  rowLook,
  stoppedRuns,
  stopsMoved,
  openedMessages,
  workLine,
  timePull,
  timePan,
  attachList,
  listScroll,
  shownRows,
  readHold,
  gap,
  freeze,
  onListReady,
  loadOlder,
  loadNewer,
  onListScroll,
  lift,
  listEnd,
  listPad,
  hasPin,
}: Pick<
  ChatData,
  | "isThread"
  | "linkThreads"
  | "replying"
  | "quiet"
  | "rhythm"
  | "seenBy"
  | "seenId"
  | "walled"
  | "dmAgent"
  | "fetchOlder"
  | "loadingOlder"
  | "olderFailed"
  | "rightHand"
  | "setupIntro"
  | "waveFrom"
  | "rightHandId"
  | "dm"
  | "thread"
  | "rowLook"
  | "gap"
  | "loadOlder"
  | "loadNewer"
> &
  Pick<ChatRows, "consultFolds" | "stoppedRuns" | "stopsMoved"> &
  Pick<
    FollowEnd,
    "isFresh" | "dragging" | "releaseAtEnd" | "openedMessages" | "timePull" | "timePan" | "shownRows" | "readHold"
  > &
  Pick<KeepPlace, "stickers" | "freeze"> &
  Pick<ConversationActions, "canMission" | "canReply" | "flashId" | "jumpToMessage"> &
  Pick<
    ListPlacement,
    "placed" | "listFade" | "listFrame" | "watchList" | "listScroll" | "onListReady" | "onListScroll"
  > &
  Pick<RowReceipts, "markAt" | "receipt" | "receiptId" | "receipts"> & {
    when: ReturnType<typeof useWhen>;
    dir: Directory;
    meId: string | null;
    channelId: string;
    threadId: string | null;
    orgId: string;
    connectInline: boolean;
    hands: RowHands;
    offerAt: string | null;
    atStart: boolean;
    headerHeight: number;
    keyboardDragStarted: () => void;
    keyboardDragSettled: () => void;
    openPinsHere: () => void;
    goToPinHere: (pin: MessagePin) => void;
    hasPins: boolean;
    settled: boolean;
    workLine: WorkLine | null;
    attachList: (list: LegendListRef | null) => void;
    lift: number;
    listEnd: SharedValue<number>;
    listPad: ComponentProps<typeof ConversationList>["contentContainerStyle"];
    hasPin: boolean;
  }) {
  const { t } = useTranslation();
  const c = useColors();
  // Once placed, the list draws a screen's height of rows past each edge of what shows (half again more ahead of the
  // scroll): a row mounts and measures itself out of sight, never under the person's eyes as they fling. While it
  // opens, only `OPEN_DRAW_DISTANCE`: opening at its end, the list takes its whole reach at once, and two screens of
  // rows were drawn before the first showed. It grows there a step at a time once the push has ended (`reachStep`).
  // Taken at once as it was placed, the list's next pass, often the first scroll, mounted two screens of rows: the list
  // read a new reach only on its next pass, until our patch (`patches/@legendapp%2Flist@3.7.3.patch`) made it reach
  // the rows on the next frame, so each step mounts its rows in that idle moment.
  const { height: windowHeight } = useWindowDimensions();
  // The list's reach once it shows and the push has ended: one step per idle moment up to a screen's height
  // (`reachOf`). A drag before it is there takes it there at once (`onDragStart`), so a fling never outruns the rows.
  const [reachStep, setReachStep] = useState(0);
  useEffect(() => {
    if (!placed || !settled || reachStep >= REACH_LAST) return;
    return whenIdle(() => setReachStep((step) => Math.min(REACH_LAST, step + 1)));
  }, [placed, settled, reachStep]);
  // The floating date: the day at the top of what is in view, shown while the person drags or flings the list. Read by
  // the pill alone (`DayPill`): a day reaching the top drew the whole conversation again.
  const [topDay] = useState(() => createValueStore<string | null>(null));
  const dayShown = useSharedValue(0);
  const dayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hideDay = useCallback(() => {
    clearTimeout(dayTimer.current);
    dayTimer.current = setTimeout(() => {
      dayShown.value = withTiming(0, { duration: 300 });
    }, DATE_PILL_IDLE_MS);
  }, [dayShown]);
  const showDay = useCallback(() => {
    dayShown.value = withTiming(1, { duration: 120 });
    hideDay();
  }, [dayShown, hideDay]);
  useEffect(() => () => clearTimeout(dayTimer.current), []);
  const onViewable = useCallback<NonNullable<OnViewableItemsChanged<Row>>>(
    ({ viewableItems }) => {
      stickers.setOnScreen(stickerRowsOnScreen(viewableItems));
      topDay.set(dayInView(viewableItems, topDay.get()));
    },
    [stickers, topDay],
  );
  // A day's line in the list: faint words, or over a background a glass plate they read on (as the floating date's).
  const dayLine = useCallback(
    (words: string, at = false) => {
      // A time line (bubbles, `at`): the page's regular weight, with a little more air above and under it.
      const room = { marginTop: rhythm.turn + (at ? TIME_LINE_AIR : 0), marginBottom: at ? TIME_LINE_AIR : 0 };
      return walled ? (
        <View style={[styles.dayPlate, room, { backgroundColor: c.glass, borderColor: c.line2 }]}>
          <Text variant="footnote" tone="muted" style={[styles.dayOn, at && styles.dayAt]}>
            {words}
          </Text>
        </View>
      ) : (
        <Text variant="footnote" tone="faint" style={[styles.day, room, at && styles.dayAt]}>
          {words}
        </Text>
      );
    },
    [walled, rhythm.turn, c.glass, c.line2],
  );
  // The browser's and the picture's rows: one style object while the inset and the rhythm hold.
  const cardRow = useMemo(
    () => [styles.browserRow, { paddingLeft: quiet, marginTop: rhythm.turn }],
    [quiet, rhythm.turn],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case "day":
          return item.at
            ? dayLine(t("mobile.chat.dayAt", { day: when.day(item.iso), time: when.time(item.iso) }), true)
            : dayLine(when.day(item.iso));
        case "marker":
          return dayLine(item.text);
        case "origin":
          return <FileOrigin artifactId={item.artifactId} kind={item.fileKind} />;
        case "codeOrigin":
          return <CodeOrigin sessionId={item.sessionId} />;
        case "wait":
          return <QueueWaitRow channelId={channelId} wait={item.wait} />;
        case "unseen":
          return <UnseenLine />;
        case "browser": {
          const agentId = item.run ? item.run.agentId : item.handoff.agentId;
          return (
            <Animated.View entering={isFresh(item.key) ? ENTER : undefined} style={cardRow}>
              {item.run ? <BrowserRunCard run={item.run} /> : <BrowserCard agentId={agentId} handoff={item.handoff} />}
            </Animated.View>
          );
        }
        case "image":
          return (
            <Animated.View entering={isFresh(item.key) ? ENTER : undefined} style={cardRow}>
              <ImageMaking color={agentLook(dir.agentById.get(item.run.agentId)).color} />
            </Animated.View>
          );
        case "message":
          // What reached an agent's conversation (a routine's report, another agent's answer) and a routine
          // that ran in the background: quiet lines, never a person's or the agent's own voice.
          if (isEventLine(item.message.meta))
            return (
              <EventLine
                message={item.message}
                fold={consultFolds.get(item.message.id)}
                gap={item.afterLine ? rhythm.part : rhythm.turn}
              />
            );
          // An agent took an issue made from this conversation: one quiet line, not a voice.
          if (issueTakenOf(item.message.meta))
            return <IssueTakenLine message={item.message} gap={item.afterLine ? rhythm.part : rhythm.turn} />;
          // Handed only what is its own (the rest is the same for every row): a receipt or a lit row redraws one row.
          return (
            <ChatMessage
              item={item}
              fresh={isFresh(item.key)}
              lit={item.message.id === flashId}
              isThread={isThread}
              meId={meId}
              canReply={canReply}
              canMission={canMission}
              thread={isThread ? undefined : linkThreads.get(item.message.id)}
              replying={replying.get(item.message.id)?.join(",")}
              menuThread={linkThreads.get(item.message.threadId ?? item.message.id)}
              aboveThread={
                item.above && !isThread ? linkThreads.has(item.above.id) || replying.has(item.above.id) : false
              }
              markReceipt={item.message.id === markAt ? receipt : undefined}
              seenBy={item.message.id === seenId ? seenBy : undefined}
              fanReceipt={receipts[item.message.id]}
              line={item.message.id === receiptId}
              lineReceipt={item.message.id === receiptId ? receipt : undefined}
              connectInline={connectInline}
              offer={item.message.id === offerAt}
              hands={hands}
            />
          );
      }
    },
    [
      t,
      when,
      rhythm,
      cardRow,
      meId,
      isThread,
      channelId,
      isFresh,
      receiptId,
      receipt,
      markAt,
      seenId,
      seenBy,
      connectInline,
      consultFolds,
      flashId,
      receipts,
      canReply,
      canMission,
      linkThreads,
      replying,
      offerAt,
      hands,
      dir,
      dayLine,
    ],
  );

  // ── The list's own props ──
  // The list is drawn again only when what it is handed changes (`ConversationList`): someone typing, a presence, an
  // agent's step redraw the screen many times a minute and leave it alone. So nothing it is handed is made anew there.
  const listIndicator = useMemo(() => ({ top: headerHeight }), [headerHeight]);
  // The faces hold still while the conversation moves (their frames share the thread that places its rows).
  const still = useStillWhileScrolling();
  const onDragStart = useCallback(() => {
    dragging.current = true;
    setReachStep(REACH_LAST);
    still.hold();
    showDay();
    // The keys may follow the finger now: the list keeps its room until the move that ends the drag.
    keyboardDragStarted();
  }, [showDay, still, keyboardDragStarted, dragging]);
  const onGlide = useCallback(() => {
    still.hold();
    showDay();
  }, [showDay, still]);
  const onScrollSettled = useCallback(() => {
    still.settle();
    releaseAtEnd();
    hideDay();
    keyboardDragSettled();
  }, [releaseAtEnd, hideDay, still, keyboardDragSettled]);
  // Before the conversation's start: the older pages' row (a spinner while one loads, the way to ask again when one
  // didn't). At its start, once it is loaded: the pinned messages (pulling down past the first message reveals them),
  // then the right hand's greeting or a new agent's checklist.
  const listHeader = useMemo(
    () =>
      !atStart ? (
        <OlderRow loading={loadingOlder} failed={olderFailed} onRetry={fetchOlder} />
      ) : hasPins || (dmAgent && (rightHand || setupIntro)) ? (
        <>
          {hasPins ? (
            <PinnedLines channelId={channelId} threadId={threadId} onOpen={openPinsHere} onPick={goToPinHere} />
          ) : null}
          {dmAgent && rightHand ? (
            <RightHandIntro agent={dmAgent} channelId={channelId} waveFrom={waveFrom} />
          ) : dmAgent && setupIntro ? (
            <AgentSetupIntro agent={dmAgent} channelId={channelId} />
          ) : null}
        </>
      ) : (
        // The older pages' row keeps its room once the start is reached: taking it out moved every message up as the
        // last page came in.
        <View style={styles.older} />
      ),
    [
      atStart,
      loadingOlder,
      olderFailed,
      fetchOlder,
      hasPins,
      dmAgent,
      rightHand,
      setupIntro,
      channelId,
      threadId,
      openPinsHere,
      goToPinHere,
      waveFrom,
    ],
  );
  return (
    <Animated.View style={[styles.grow, listFade]}>
      {/* The list's frame, where the waiting requests' cards are measured from (never flattened away). */}
      <View ref={listFrame} collapsable={false} style={styles.grow} onLayout={watchList}>
        {/* The right hand's cards here show the place its work in this conversation is on. */}
        <ConversationSeat
          orgId={orgId}
          channelId={channelId}
          rightHandId={rightHandId}
          dm={Boolean(dm) || thread.data?.channelKind === "dm"}
        >
          <StickerStageContext.Provider value={stickers}>
            <JumpToMessageContext.Provider value={jumpToMessage}>
              <RowLookContext.Provider value={rowLook}>
                <StoppedRunsContext.Provider value={stoppedRuns}>
                  <StopsMovedOnContext.Provider value={stopsMoved}>
                    <OpenedMessagesContext.Provider value={openedMessages}>
                      <WorkLineContext.Provider value={workLine}>
                        <SwipeTimeFrame pull={timePull} gesture={timePan}>
                          <ConversationList
                            ref={attachList}
                            refScrollView={listScroll}
                            style={styles.grow}
                            data={shownRows}
                            keyExtractor={rowKey}
                            getItemType={rowType}
                            renderItem={renderItem}
                            // The list redraws mounted rows only when this changes: what a row shows beyond
                            // its message (the thread link that loads after it, a held state) lives in
                            // `renderItem`'s dependencies.
                            extraData={renderItem}
                            estimatedItemSize={72}
                            drawDistance={reachOf(reachStep, windowHeight)}
                            // Opens at the latest message, short conversations sit at the bottom like any
                            // chat.
                            initialScrollAtEnd
                            alignItemsAtEnd
                            // New messages, a reply growing word by word and the working line (the footer,
                            // whose size the list follows too) keep the end in view, but only while the
                            // person is near it, and never while newer messages wait to load under one
                            // opened far up (`gap`).
                            maintainScrollAtEnd={readHold || gap ? false : GLIDE}
                            maintainScrollAtEndThreshold={STICK_TO_END_THRESHOLD}
                            // Older pages above and rows changing size keep what is on screen still.
                            maintainVisibleContentPosition
                            // Our own insets, never the system's (the keyboard library's advice for chat
                            // lists): the bar's room is the content's top padding, the indicator kept below
                            // the bar.
                            contentInsetAdjustmentBehavior="never"
                            automaticallyAdjustContentInsets={false}
                            scrollIndicatorInsets={listIndicator}
                            // Still while a sheet or the agent's computer covers the conversation.
                            freeze={freeze}
                            onReady={onListReady}
                            onStartReached={loadOlder}
                            onEndReached={gap ? loadNewer : undefined}
                            // A look at the waiting requests' cards and the live rows, once a frame and only
                            // while there is one.
                            onScroll={onListScroll}
                            onViewableItemsChanged={onViewable}
                            viewabilityConfig={STICKER_VIEW}
                            onScrollBeginDrag={onDragStart}
                            onScrollEndDrag={onScrollSettled}
                            onMomentumScrollBegin={onGlide}
                            onMomentumScrollEnd={onScrollSettled}
                            onStartReachedThreshold={0.5}
                            keyboardDismissMode="interactive"
                            keyboardShouldPersistTaps="handled"
                            keyboardOffset={lift}
                            // The dock's height (the connection, a request out of view, the reply bar) and
                            // the keyboard move the conversation only at its end. Above it nothing moves:
                            // with the library's default the words being read shifted each time the dock
                            // changed, under the person's finger.
                            keyboardLiftBehavior="whenAtEnd"
                            contentInsetEndAdjustment={listEnd}
                            contentContainerStyle={listPad}
                            ListHeaderComponent={listHeader}
                            ListFooterComponent={WORK_FOOTER}
                          />
                        </SwipeTimeFrame>
                      </WorkLineContext.Provider>
                    </OpenedMessagesContext.Provider>
                  </StopsMovedOnContext.Provider>
                </StoppedRunsContext.Provider>
              </RowLookContext.Provider>
            </JumpToMessageContext.Provider>
          </StickerStageContext.Provider>
        </ConversationSeat>
        <DayPill day={topDay} shown={dayShown} top={hasPin ? 8 : headerHeight + 8} />
      </View>
    </Animated.View>
  );
}

/**
 * Above the oldest loaded message while older ones exist: a small spinner while a page loads, and when one didn't come,
 * what happened with "Try again" (`RetryLine`). Waiting or loading it keeps one height, so a page starting to load
 * never moves the conversation.
 */
function OlderRow({ loading, failed, onRetry }: { loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const c = useColors();
  if (failed && !loading) return <RetryLine onRetry={onRetry} />;
  return (
    <View style={styles.older}>
      {loading ? (
        <ActivityIndicator size="small" color={c.muted} accessibilityLabel={t("common.loadingMessages")} />
      ) : null}
    </View>
  );
}

/** "Novas": before the first message that arrived while the person read above, until they leave the conversation. */
const UnseenLine = memo(function UnseenLine() {
  const { t } = useTranslation();
  const rhythm = useRhythm();
  const c = useColors();
  return (
    <View style={[styles.unseen, { marginTop: rhythm.turn }]} accessibilityRole="text">
      <Text variant="caption" style={[styles.unseenText, { color: c.agent }]}>
        {t("mobile.chat.unseen.divider")}
      </Text>
      <View style={[styles.unseenRule, { backgroundColor: c.agent }]} />
    </View>
  );
});

/** The floating date (`DatePill`) with the day at the top of the list, which it reads itself. */
function DayPill({ day, ...pill }: Omit<ComponentProps<typeof DatePill>, "day"> & { day: ValueStore<string | null> }) {
  return <DatePill day={useValueOf(day)} {...pill} />;
}

const styles = StyleSheet.create({
  // Under the agent's words, like a card on its message.
  browserRow: { paddingRight: 16 },
  grow: { flex: 1 },
  day: { alignSelf: "center", textAlign: "center", fontWeight: "600" },
  dayAt: { fontWeight: "400" },
  // A day's line over a background: a small glass plate (as the design's).
  dayPlate: {
    alignSelf: "center",
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dayOn: { textAlign: "center", fontWeight: "600" },
  older: { height: OLDER_ROW, alignItems: "center", justifyContent: "center" },
  unseen: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16 },
  unseenText: { fontWeight: "700" },
  unseenRule: { flex: 1, height: StyleSheet.hairlineWidth * 2, opacity: 0.45 },
});
