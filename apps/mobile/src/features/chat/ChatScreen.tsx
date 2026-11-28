import { isMediaKind, MESSAGES_PAGE, useAiStatus, useApi } from "@agenteschat/client";
import { workIsOver } from "@agenteschat/client/lib/long-work";
import { pinsIn } from "@agenteschat/client/lib/pins";
import { CodeConversation } from "@agenteschat/client/lib/work-context";
import type { LegendListRef } from "@legendapp/list/react-native";
import { LinearGradient } from "expo-linear-gradient";
import { HeaderHeightContext } from "expo-router/react-navigation";
import { type ComponentRef, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, ScrollView, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useAnimatedStyle, useDerivedValue, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { holdOpenConversation } from "@/lib/push";
import { usePush } from "@/providers/push";
import { useToast } from "@/ui";
import { createComposerFloat } from "@/ui/Composer";
import { usePane } from "@/ui/pane";
import { AgentSetupIntro } from "../agents/setup/SetupCard";
import { OpenHandoffProvider } from "../browser/open";
import { MissionCardView } from "../missions/cards";
import { isOpenMission } from "../missions/logic";
import { RightHandIntro } from "../right-hand/Intro";
import { TeamFlight } from "../right-hand/TeamFlight";
import { FirstUse } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useMyHandle, useOrgId, useWhen } from "../shared/hooks";
import { FocusLive } from "../shared/parts";
import { SheetHostProvider, useSheet } from "../shared/SheetHost";
import { AskStore } from "./ask-store";
import { AskProbes, AskStoreProvider, useAwayAsk } from "./asks";
import { ChannelHello } from "./ChannelHello";
import { ChatSkeleton } from "./ChatSkeleton";
import { ChatWallpaper, WallpaperBand } from "./ChatWallpaper";
import { takeComposerRequest, useComposerRequest } from "./composer-request";
import { openingDockHeight, rememberDockHeight } from "./dock-height";
import { FirstDay } from "./FirstDay";
import { GroupCover, useGroupConversation } from "./GroupCover";
import { useListEnd } from "./list-end";
import { endsOnNoAiCard, noAiBanner } from "./no-ai-banner";
import { placeKey, placeMessage, takeHandedPlace, useReadingPlace } from "./reading-place";
import { ConversationRowData } from "./row-data";
import { ChatDock } from "./screen/ChatDock";
import { ChatHeader, useChatTitle } from "./screen/ChatHeader";
import { ChatList, useListPlacement } from "./screen/ChatList";
import type { RowHands } from "./screen/ChatMessage";
import { DOCK_SIDE } from "./screen/constants";
import { useLatest, useTurnEndTap } from "./screen/hooks";
import { useSettled } from "./screen/opening";
import { ChannelGreeting, DockGestureArea, DockRoom, ReadMark } from "./screen/parts";
import { useChatData } from "./screen/useChatData";
import { useChatRows, useRowReceipts } from "./screen/useChatRows";
import { useChatSend } from "./screen/useChatSend";
import { useConversationActions } from "./screen/useConversationActions";
import { useFollowEnd } from "./screen/useFollowEnd";
import { useKeepPlace } from "./screen/useKeepPlace";
import { HereReturns, type WorkLine } from "./screen/work-line";
import { ThreadLanding, useMarkThreadOpen } from "./thread-open";
import { withOpacity } from "./turn";

/** How far from its end a list that follows it may rest (rounding) before it is taken there. */
const END_SLACK = 2;
/** The composer's safe-area padding hides behind the open keyboard; this much stays between them. */
const KEYBOARD_GAP = 8;
/** The dock with a one-line field and nothing over it, above its bottom padding (the box's 6 and the field's 49). */
const DOCK_LINE = 55;
/**
 * At rest (no keyboard) the capsule floats this much narrower on each side, and opens to `DOCK_SIDE` with the keyboard,
 * frame by frame on its progress (so dragging the keyboard down closes it back too).
 */
const DOCK_REST = 16;
/** Air under the conversation's last message, before the composer's box. */
const LIST_END_AIR = 22;
/** The composer's box over its field (`ChatDock`'s `composer`): part of the gap from the list's end to the field. */
const DOCK_TOP = 6;
/** The notifications line was shown and answered here: it doesn't come back on this screen. */
const OFFER_DONE = "done";

/**
 * A conversation: a channel, a DM, a thread or a mission's thread (`threadId`). `handoffId`: a request
 * for help a push or the inbox opened it for (its card opens in place, in control). A file's conversation (ADR 0208)
 * is one of these, pushed over the file at its root.
 */
export function ChatScreen({
  channelId,
  threadId,
  handoffId,
  focusId,
}: {
  channelId: string;
  threadId?: string | null;
  handoffId?: string | null;
  /** Open at this message: paged in, scrolled to and lit for a moment (a pin). */
  focusId?: string | null;
}) {
  // Where the same conversation was being read on the other display (ADR 0212: an iPhone Duo opened or closed), taken
  // once as it opens, when no message was asked for: it opens there, as a pin opens at its message, without the light.
  const [handed] = useState(() => (focusId ? null : takeHandedPlace(placeKey(channelId, threadId ?? null))));
  // A thread's screen: its message stays marked in the conversation under it, and its first rows fade in, in turn.
  useMarkThreadOpen(threadId ?? null);
  // Its rows read the agents' questions once for the conversation (`ConversationRowData`), its sheets included.
  return (
    <ThreadLanding on={Boolean(threadId)}>
      <ConversationRowData channelId={channelId}>
        <SheetHostProvider>
          <FocusLive>
            <OpenHandoffProvider handoffId={handoffId ?? null}>
              <Chat
                channelId={channelId}
                threadId={threadId ?? null}
                focusId={focusId ?? handed}
                quietFocus={!focusId && handed !== null}
              />
            </OpenHandoffProvider>
          </FocusLive>
        </SheetHostProvider>
      </ConversationRowData>
    </ThreadLanding>
  );
}

function Chat({
  channelId,
  threadId,
  focusId,
  quietFocus,
}: {
  channelId: string;
  threadId: string | null;
  focusId: string | null;
  /** `focusId` is a place handed from the other display (ADR 0212): gone to without the light. */
  quietFocus: boolean;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const meId = useMeId();
  const myHandle = useMyHandle();
  const api = useApi();
  const dir = useDirectory();
  const c = useColors();
  const toast = useToast();
  const sheet = useSheet();
  const insets = useSafeAreaInsets();
  // Where the keyboard is, as the keyboard library says: the composer rides it, and nothing else writes it.
  const keyboardAt = useReanimatedKeyboardAnimation();
  // The capsule at rest floats narrower and opens to the dock's sides with the keyboard (`DOCK_REST`); the picker over
  // it and the way back to the latest messages (over its last button) move with it.
  const restSide = useDerivedValue(() => DOCK_REST * (1 - keyboardAt.progress.get()));
  const capsuleRest = useAnimatedStyle(() => ({ marginHorizontal: restSide.get() }));
  const floatRest = useAnimatedStyle(() => ({ paddingHorizontal: DOCK_SIDE + restSide.get() }));
  const jumpRest = useAnimatedStyle(() => ({ marginRight: DOCK_SIDE + 4 + restSide.get() }));
  const when = useWhen();
  // The requests waiting here and which messages are on screen: the line above the composer says when one
  // waits out of view (waiting beats working).
  const [asks] = useState(() => new AskStore());
  const awayAsk = useAwayAsk(asks);

  const data = useChatData({ channelId, threadId, orgId, meId, api, dir });
  const {
    admin,
    backdrop,
    canStop,
    channel,
    dm,
    dmAgent,
    dmAgentId,
    fetchOlder,
    focused,
    gap,
    isThread,
    join,
    lineStop,
    linkThreads,
    replying,
    list,
    live,
    loadNewer,
    loadOlder,
    loadingOlder,
    member,
    mission,
    notices,
    olderDone,
    olderFailed,
    org,
    peeking,
    pinsData,
    planHeld,
    quiet,
    rhythm,
    rightHand,
    rightHandId,
    roster,
    rowLook,
    runs,
    seenBy,
    seenId,
    setupIntro,
    stopRun,
    thread,
    threadMessages,
    top,
    walled,
    waveFrom,
    working,
  } = data;
  // The push has ended (or there was none, as in a peek): what the first frame doesn't show mounts from here.
  const settled = useSettled(peeking);
  // The screen's size: the background and its band under the bar are one picture, cut to the same place. Kept in the
  // screen's state only while there is a background: without one, its layout drew the conversation again for nothing.
  const [wallSize, setWallSize] = useState<{ width: number; height: number } | null>(null);
  const screenSize = useRef<{ width: number; height: number } | null>(null);
  const walledRef = useRef(walled);
  walledRef.current = walled;
  const onScreenLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    screenSize.current = { width, height };
    if (walledRef.current)
      setWallSize((now) => (now && now.width === width && now.height === height ? now : { width, height }));
  }, []);
  useEffect(() => {
    const size = screenSize.current;
    if (walled && size)
      setWallSize((now) => (now && now.width === size.width && now.height === size.height ? now : size));
  }, [walled]);
  const rowData = useChatRows({ channelId, threadId, orgId, t, data });
  const { consultData, consultFolds, lineBase, rows, shownMessages, stoppedRuns, stopsMoved } = rowData;
  const follow = useFollowEnd({ channelId, threadId, orgId, meId, myHandle, keyboardAt, awayAsk, rows, data });
  const {
    atEnd,
    band,
    dock,
    dragging,
    far,
    gliding,
    isFresh,
    listRef,
    openedMessages,
    postedNow,
    readHold,
    releaseAtEnd,
    seeAsk,
    seeWaiting,
    shownRows,
    timePan,
    timePull,
    toEnd,
    touched,
    unseen,
    waitingFirst,
    waitingHere,
    markTouched,
  } = follow;
  const { freeze, leavePlace, placeNow, stickers } = useKeepPlace({ sheet, follow });
  const {
    afterVoice,
    canAttach,
    captionBack,
    channelAgents,
    composerAttachments,
    composerBanner,
    composerMedia,
    helloAgent,
    longFromField,
    mentionCard,
    onRecording,
    onReply,
    onResend,
    onRetry,
    onSend,
    onType,
    openNewMission,
    openRemind,
    pending,
    plusFromField,
    quote,
    replyAt,
    sendFromField,
    talkable,
    voiceFromField,
    voiceOn,
    voiceTakeBack,
    voiceAsk,
  } = useChatSend({
    channelId,
    threadId,
    orgId,
    meId,
    api,
    dir,
    t,
    i18n,
    toast,
    sheet,
    toEnd,
    leavePlace,
    data,
  });
  // A personal workspace's group conversation (ADR 0159), from a server that lists its agents: its cover at its start,
  // in its greeting while it is empty.
  const group = useGroupConversation(dm || isThread ? null : channel, roster.data);
  const startCover = useMemo(
    () => (group && channel ? <GroupCover name={channel.name} group={group} /> : null),
    [group, channel],
  );
  const { codeId, info, personDm, rootFile, rootTask, subtitle, title } = useChatTitle({
    threadId,
    orgId,
    t,
    dir,
    data,
  });
  const {
    canMission,
    canReply,
    flashId,
    goToPin,
    jumpToMessage,
    onHoldPill,
    onLongPress,
    onMission,
    onQuote,
    onRemind,
    openBrowserLine,
    openMembers,
    openOptions,
    openPins,
    openReturns,
    openSearch,
    returnLine,
    rowsRef,
    searchPlace,
    seeConsult,
    setAround,
    setSeek,
  } = useConversationActions({
    channelId,
    threadId,
    focusId,
    quietFocus,
    orgId,
    api,
    t,
    toast,
    sheet,
    info,
    title,
    subtitle,
    personDm,
    leavePlace,
    onReply,
    openNewMission,
    openRemind,
    follow,
    data,
  });

  const placeholder = isThread
    ? rootTask
      ? // One line on the phone: the tip after "·" in the web's placeholder doesn't fit.
        t("issues.comment")
      : rootFile
        ? // A picture's, a video's or a PDF's (ADR 0208): the shared words, one line as the live files' are.
          t(
            isMediaKind(rootFile.kind)
              ? `files.comments.write.${rootFile.kind}`
              : `mobile.live.talk.placeholder.${rootFile.kind}`,
          )
        : t("mobile.chat.reply")
    : dm
      ? // One line on the phone: the right hand's "nada muda sem você" doesn't fit beside its name.
        t("mobile.chat.messageTo", { name: dm.with.name })
      : t("mobile.chat.messageIn", { channel: channel ? `#${channel.name}` : "" });
  rowsRef.current = rows;
  // Where the person reads, for this conversation opened on the other display (ADR 0212); in a pane, kept as it leaves.
  const pane = usePane();
  useReadingPlace(placeKey(channelId, threadId), () => placeMessage(placeNow(), rowsRef.current), pane !== null);
  const pinned = mission && isOpenMission(mission) ? mission : null;
  const hasPins = useMemo(() => pinsIn(pinsData ?? [], threadId).length > 0, [pinsData, threadId]);

  const { receiptId, receipt, markAt, receipts } = useRowReceipts({
    orgId,
    channelId,
    meId,
    live,
    rowLook,
    rows,
    shownMessages,
  });
  // Above the box: an agent here without an AI, or the whole workspace without one (as on the web).
  const aiStatus = useAiStatus(orgId);
  // The right hand's greeting says it itself (its Connect AI card).
  const banner =
    member && !rightHand && !planHeld && !setupIntro
      ? noAiBanner(aiStatus.data, {
          agentIds: dmAgentId ? [dmAgentId] : channelAgents,
          dmAgentId,
          cardShown: endsOnNoAiCard(shownMessages),
        })
      : null;
  const connectInline = banner === null;
  // A thread opens on its root the channel holds (`isPlaceholderData`) when it has no replies to wait for.
  const loading = isThread
    ? threadMessages.isLoading || (threadMessages.isPlaceholderData && (thread.data?.replyCount ?? 1) > 0)
    : top.isLoading;

  // ── Asking for notifications where it makes sense ──
  // Right after an agent says it will take a while (a long work it is still on, ADR 0121), once, under that
  // message: "Quer saber quando a Dora terminar?" with Avisar. Only while the app may still ask (the person
  // hasn't answered the system yet), and never twice on this screen.
  const push = usePush();
  const longWorkAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.author.type === "agent" && m.longWork && !workIsOver(m.longWork)) return m.id;
    }
    return null;
  }, [list]);
  const [offerAt, setOfferAt] = useState<string | null>(null);
  const { markOffered } = push;
  const mayOffer = push.offer.answer && member;
  useEffect(() => {
    if (offerAt || !longWorkAt || !mayOffer) return;
    setOfferAt(longWorkAt);
    // Counted as offered once it shows: the home's own ask waits its turn after this one.
    markOffered();
  }, [offerAt, longWorkAt, mayOffer, markOffered]);

  // What every message row is handed alike (`ChatMessage`), each keeping its identity across the screen's redraws.
  const onOfferDone = useCallback(() => setOfferAt(OFFER_DONE), []);
  const hands = useMemo<RowHands>(
    () => ({ onReply, onMission, onRemind, onLongPress, onRetry, onQuote, onResend, onOfferDone }),
    [onReply, onMission, onRemind, onLongPress, onRetry, onQuote, onResend, onOfferDone],
  );

  // Pushes about this conversation stay quiet while it is on screen (no banner, no buzz), and so does the island.
  useEffect(() => {
    if (!focused) return;
    // The release clears it only if it still holds this screen's conversation (the next screen may have
    // taken over before this one's blur).
    return holdOpenConversation({ orgId, channelId, threadId });
  }, [focused, orgId, channelId, threadId]);
  // "Falar com o Theo" from two agents' conversation: "@theo " in this field, once this screen is in view again.
  const composerRequest = useComposerRequest(channelId);
  const prefill = focused ? composerRequest : null;
  useEffect(() => {
    if (prefill) takeComposerRequest(prefill.at);
  }, [prefill]);

  // The composer floats over the list's bottom and rides the keyboard (KeyboardStickyView, on the keyboard library's
  // values and nothing else); the list ends where the composer starts (`useListEnd`, below).
  // The "@" picker floats above the box, outside what is measured (`ComposerFloat`): it comes and goes as the person
  // types and the conversation stays where it is. No suggestion pills over the conversation: always there, they read
  // as noise (the owner had them removed).
  const composerRef = useRef<ComponentRef<typeof View>>(null);
  const [composerFloat] = useState(createComposerFloat);
  // The composer's box with the lines over it, as last laid out (the agent's face and a background's band size to it).
  const boxHeight = useSharedValue(openingDockHeight(Math.max(insets.bottom, 10) + DOCK_LINE));
  // Read while laying out the box: at the conversation's end and following it (not held where the person reads).
  const followingEnd = useRef(true);
  followingEnd.current = atEnd && !readHold;
  // An agent's turn ending in front of the person, at the end: one light tap.
  const followingNow = useCallback(() => followingEnd.current, []);
  useTurnEndTap(runs, list, focused && !peeking, followingNow);
  // Whether the conversation follows its end right now. The screen's `atEnd` is false while the list is still on its
  // way down to a message just sent; the list's own follow (`maintainScrollAtEnd`) is on then, and is what counts.
  const followsEnd = () => {
    if (readHold) return false;
    if (followingEnd.current) return true;
    const state = listRef.current?.getState();
    return !!state && (state.isFollowingEnd || state.isAtEnd);
  };
  const onComposerBoxLayout = (e: LayoutChangeEvent) => {
    const height = e.nativeEvent.layout.height;
    const before = dock.get();
    const grew = before > 0 && height > before + 0.5;
    boxHeight.set(height);
    rememberDockHeight(height);
    // Only what is drawn from it redraws (`DockHeight`); the waiting requests look again at their band's new bottom.
    dock.set(height);
    watchList();
    // The dock grew under the conversation (a request out of view, the reply bar, a taller field) while it follows its
    // end. The libraries cover only part of it: the keyboard's scroll view shifts the list by the grown inset only when
    // it rests at its end, and with the keyboard up the list learns the new inset without following it. A message just
    // sent is still scrolling down when the dock grows, so its last lines stayed under it.
    // Two frames on, once the inset is in (the list's distance counts it), a list left short goes on to the end: one
    // that the scroll view already shifted is at its end and isn't moved twice.
    // While a send glides, the list's own follow takes the grown dock into the same motion.
    if (grew && followsEnd() && !gliding.current)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const state = listRef.current?.getState();
          if (followsEnd() && state && state.distanceFromEnd > END_SLACK)
            void listRef.current?.scrollToEnd({ animated: true });
        }),
      );
  };
  const bottomPad = Math.max(insets.bottom, 10);
  // The header floats over the conversation (glass on iOS 26, a blur before; round plates on Android), which
  // fades under it.
  // Peeked at from the list (iOS's long press): no bar over it and no composer, so no room for either (no stack's
  // header there to measure: read without `useHeaderHeight`, which throws where there is none).
  const barHeight = useContext(HeaderHeightContext) ?? 0;
  const headerHeight = peeking ? 0 : barHeight;
  // How far down the fade under the header stays solid: through the status bar and the bar (a message scrolled up
  // showed through the bar's pill and between its buttons), fading out in the 28 points under it.
  const topFadeSolid = headerHeight > 0 ? Math.min(1, headerHeight / (headerHeight + 28)) : 0;
  // In a pane whose foot stands above the window's (ADR 0212; Android's tabs end above their bar) the keyboard, rising
  // from the window's edge, covers that much less of the conversation.
  const lift = Math.max(0, bottomPad - KEYBOARD_GAP) + (pane?.below ?? 0);
  // The list ends where the composer starts: the dock's height plus whatever part of the keyboard the composer rides
  // over that the list's own keyboard room missed (a height iOS changed with no notification).
  const {
    end: listEnd,
    dragStarted: keyboardDragStarted,
    dragSettled: keyboardDragSettled,
  } = useListEnd({ keyboard: keyboardAt, box: boxHeight, lift, freeze });
  // The dock's room told to the list as it mounts (Legend List's own chat example, #586): the keyboard's list hears it
  // only through a round trip from the UI thread, which can land after the list said it was placed at its end, and the
  // conversation opened with its last message under the dock.
  const attachList = useCallback(
    (list: LegendListRef | null) => {
      listRef.current = list;
      list?.reportContentInset({ bottom: listEnd.get() });
    },
    [listRef, listEnd],
  );
  const showList = !loading && !(rows.length === 0 && runs.length === 0);
  // Who works and who types here, and at rest who comes back when: the conversation's last line, under its last
  // message and scrolling with it (the list's footer, `WORK_FOOTER`), as a reply on its way. Pinned above the composer,
  // it stayed over the words being read and moved the conversation's end each time an agent started or finished.
  // Above the composer only while there is no conversation to end with. The composer's edges, and a turn's gap on
  // both sides: above it from the last message, under it to the field. Under it, the list's end air and the composer's
  // box give way to that gap; its own padding under it is for when it sits above the composer.
  const lineInList = useMemo(
    () => ({
      paddingHorizontal: DOCK_SIDE,
      paddingTop: rhythm.turn,
      paddingBottom: 0,
      marginBottom: rhythm.turn - LIST_END_AIR - DOCK_TOP,
    }),
    [rhythm.turn],
  );
  const listReturns = useMemo(
    () => <HereReturns channelId={channelId} threadId={threadId} onOpen={openReturns} style={lineInList} />,
    [channelId, threadId, openReturns, lineInList],
  );
  const workLine = useMemo<WorkLine | null>(
    () =>
      member && showList
        ? {
            runs,
            consults: lineBase,
            consultData,
            typing: live.typing,
            meId,
            threadId,
            onSeeConsult: seeConsult,
            // The agent's browser card is in the conversation, its page always in view: go to it at the end.
            onOpenBrowser: openBrowserLine,
            stop: lineStop,
            rest: listReturns,
            style: lineInList,
          }
        : null,
    [
      member,
      showList,
      runs,
      lineBase,
      consultData,
      live.typing,
      meId,
      threadId,
      seeConsult,
      openBrowserLine,
      lineStop,
      listReturns,
      lineInList,
    ],
  );
  // The conversation starts below the clear bar by our own padding, on both platforms (the pinned card, when there
  // is one, already holds that room). iOS's automatic inset made keyboard moves land short at the end.
  const hasPin = pinned !== null;
  band.current = { top: hasPin ? 0 : headerHeight, lift };
  // The conversation's first message is loaded (a thread loads whole): what sits above it can show.
  const atStart = isThread || olderDone || (top.data?.length ?? 0) < MESSAGES_PAGE;
  const listPad = useMemo(
    () => (hasPin ? styles.listPad : [styles.listPad, { paddingTop: headerHeight + 8 }]),
    [hasPin, headerHeight],
  );

  const { listFade, listFrame, listScroll, onListReady, onListScroll, peekAgentId, placed, pull, watchList } =
    useListPlacement({
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
    });
  const openPinsHere = useLatest(openPins);
  const goToPinHere = useLatest(goToPin);

  return (
    <CodeConversation.Provider value={codeId !== null}>
      <AskStoreProvider store={asks}>
        <AskProbes messages={shownMessages} />
        {/* Seen up to the message posted last (`ReadMark`, drawn with the screen). Peeked at from the list (iOS's long
          press preview, `peeking`): nothing is read until it is opened. Mounted after the push (`settled`): marking
          read rewrites the conversation lists, which redraws this screen and the one under it mid-slide. */}
        {settled ? (
          <ReadMark
            orgId={orgId}
            channelId={channelId}
            threadId={threadId}
            member={member}
            postedNow={postedNow}
            peeking={peeking}
            focused={focused}
          />
        ) : null}
        <View style={[styles.screen, { backgroundColor: c.bg }]} onTouchStart={markTouched} onLayout={onScreenLayout}>
          {walled && wallSize ? (
            <ChatWallpaper
              wallpaper={backdrop.wallpaper}
              strength={backdrop.strength}
              width={wallSize.width}
              height={wallSize.height}
              style={styles.wallpaper}
            />
          ) : null}
          <ChatHeader
            channelId={channelId}
            threadId={threadId}
            codeId={codeId}
            title={title}
            subtitle={subtitle}
            info={info}
            isThread={isThread}
            dm={dm}
            dmAgent={dmAgent}
            dmAgentId={dmAgentId}
            channel={channel}
            roster={roster}
            member={member}
            runs={runs}
            lineBase={lineBase}
            consultData={consultData}
            far={far}
            unseen={unseen}
            focused={focused}
            peeking={peeking}
            searchPlace={searchPlace}
            openOptions={openOptions}
            openMembers={openMembers}
            openSearch={openSearch}
            onHoldPill={onHoldPill}
            leavePlace={leavePlace}
          />
          {hasPin ? (
            // The bar is see-through (the conversation runs under it): an open mission's card starts below it. Pinned
            // messages have no bar here: they wait above the first message, revealed by pulling down (`PinnedLines`).
            <View style={{ backgroundColor: walled ? "transparent" : c.bg, paddingTop: headerHeight }}>
              {pinned ? (
                <View style={styles.pin}>
                  <MissionCardView mission={pinned} pinned />
                </View>
              ) : null}
            </View>
          ) : null}
          <DockGestureArea dock={dock} lift={lift}>
            {loading ? null : (
              <>
                {/* Mounted before the first message too: a list that appears while the keyboard is already up never
                  hears it open, and its first message landed under it. */}
                <ChatList
                  when={when}
                  dir={dir}
                  meId={meId}
                  canMission={canMission}
                  canReply={canReply}
                  flashId={flashId}
                  channelId={channelId}
                  threadId={threadId}
                  orgId={orgId}
                  connectInline={connectInline}
                  hands={hands}
                  offerAt={offerAt}
                  consultFolds={consultFolds}
                  isFresh={isFresh}
                  isThread={isThread}
                  linkThreads={linkThreads}
                  replying={replying}
                  quiet={quiet}
                  rhythm={rhythm}
                  seenBy={seenBy}
                  seenId={seenId}
                  walled={walled}
                  markAt={markAt}
                  receipt={receipt}
                  receiptId={receiptId}
                  receipts={receipts}
                  atStart={atStart}
                  startCover={startCover}
                  headerHeight={headerHeight}
                  keyboardDragSettled={keyboardDragSettled}
                  keyboardDragStarted={keyboardDragStarted}
                  dmAgent={dmAgent}
                  fetchOlder={fetchOlder}
                  loadingOlder={loadingOlder}
                  olderFailed={olderFailed}
                  rightHand={rightHand}
                  setupIntro={setupIntro}
                  waveFrom={waveFrom}
                  dragging={dragging}
                  releaseAtEnd={releaseAtEnd}
                  openPinsHere={openPinsHere}
                  goToPinHere={goToPinHere}
                  hasPins={hasPins}
                  stickers={stickers}
                  placed={placed}
                  settled={settled}
                  listFade={listFade}
                  listFrame={listFrame}
                  watchList={watchList}
                  rightHandId={rightHandId}
                  dm={dm}
                  thread={thread}
                  jumpToMessage={jumpToMessage}
                  rowLook={rowLook}
                  stoppedRuns={stoppedRuns}
                  stopsMoved={stopsMoved}
                  openedMessages={openedMessages}
                  workLine={workLine}
                  timePull={timePull}
                  timePan={timePan}
                  attachList={attachList}
                  listScroll={listScroll}
                  shownRows={shownRows}
                  readHold={readHold}
                  gap={gap}
                  freeze={freeze}
                  onListReady={onListReady}
                  loadOlder={loadOlder}
                  loadNewer={loadNewer}
                  onListScroll={onListScroll}
                  lift={lift}
                  listEnd={listEnd}
                  listPad={listPad}
                  hasPin={hasPin}
                />
                {showList ? null : (
                  // A conversation with nothing yet: the agent's first day or a quiet line, over the empty list, above
                  // the dock (its height read here alone).
                  <DockRoom dock={dock}>
                    {(dockHeight) => {
                      // A DM's intro before its first message (the right hand's greeting, a new agent's checklist): below
                      // the bar, above the box, its buttons answering the first tap while the keyboard is up, the
                      // keyboard going with a drag and its last rows reachable above it.
                      const introScroll = {
                        contentContainerStyle: { paddingTop: headerHeight, paddingBottom: dockHeight },
                        scrollIndicatorInsets: { top: headerHeight, bottom: dockHeight },
                        keyboardShouldPersistTaps: "handled" as const,
                        keyboardDismissMode: "interactive" as const,
                        automaticallyAdjustKeyboardInsets: true,
                      };
                      return (
                        <View style={StyleSheet.absoluteFill}>
                          {dmAgent && rightHand ? (
                            <ScrollView {...introScroll}>
                              <RightHandIntro agent={dmAgent} channelId={channelId} waveFrom={waveFrom} />
                            </ScrollView>
                          ) : dmAgent && setupIntro ? (
                            <ScrollView {...introScroll}>
                              <AgentSetupIntro agent={dmAgent} channelId={channelId} />
                            </ScrollView>
                          ) : dmAgent && !isThread ? (
                            <FirstDay
                              agent={dmAgent}
                              topInset={headerHeight}
                              bottomInset={dockHeight}
                              keyboardLift={lift}
                              onAsk={onSend}
                              channelId={channelId}
                            />
                          ) : channel && helloAgent && !dm && !isThread ? (
                            <ChannelHello
                              channelId={channelId}
                              channel={channel.name}
                              topic={channel.topic}
                              agents={[helloAgent, ...talkable.filter((a) => a.id !== helloAgent.id)]}
                              members={roster.data ?? []}
                              topInset={headerHeight}
                              bottomInset={dockHeight}
                              keyboardLift={lift}
                              onAsk={onSend}
                              group={group}
                            />
                          ) : (
                            <View style={[styles.center, { paddingBottom: dockHeight }]}>
                              {/* No button: the composer under it is the next step. */}
                              <FirstUse place="chat" size="panel" acts={member && channel?.can?.post !== false} />
                            </View>
                          )}
                        </View>
                      );
                    }}
                  </DockRoom>
                )}
              </>
            )}
            {/* The messages on their way, or the list still placing itself at its end: their shape, never a blank screen. */}
            {loading || (showList && !placed) ? (
              <DockRoom dock={dock}>
                {(dockHeight) => <ChatSkeleton look={rowLook} top={hasPin ? 0 : headerHeight} bottom={dockHeight} />}
              </DockRoom>
            ) : null}
            {!hasPin ? (
              // The conversation fades under the floating header, as it does under the box. Not under a pinned bar
              // or card: the list already starts below them, and a header-tall fade there was a dark band over the
              // first messages (the pinned bar's own hairline is the edge). Solid behind the status bar: a message
              // passing there showed through the clock and the indicators, its words cut by them. Over a background
              // it fades into the background itself, never into a band of the page's color.
              walled && wallSize ? (
                <WallpaperBand
                  wallpaper={backdrop.wallpaper}
                  strength={backdrop.strength}
                  width={wallSize.width}
                  height={wallSize.height}
                  band={headerHeight + 28}
                  solid={topFadeSolid}
                />
              ) : (
                <LinearGradient
                  pointerEvents="none"
                  colors={[c.bg, c.bg, withOpacity(c.bg, 0)]}
                  locations={[0, topFadeSolid, 1]}
                  style={[styles.topFade, { height: headerHeight + 28 }]}
                />
              )
            ) : null}
            {channel && !dm && !isThread && member && showList && settled ? (
              // The channel greets you under the bar, as the web's: a newcomer's #general, or the first channel of a day.
              // It drops in, over the list, after the push.
              <ChannelGreeting
                channelId={channelId}
                channelName={channel.name}
                messages={top.data}
                agentIds={channelAgents}
                top={headerHeight + 8}
                touched={touched}
              />
            ) : null}
            {peeking ? null : (
              <ChatDock
                lift={lift}
                peekAgentId={peekAgentId}
                showList={showList}
                settled={settled}
                pull={pull}
                boxHeight={boxHeight}
                far={far}
                atEnd={atEnd}
                gap={gap}
                readHold={readHold}
                unseen={unseen}
                jumpRest={jumpRest}
                toEnd={toEnd}
                floatRest={floatRest}
                composerFloat={composerFloat}
                composerRef={composerRef}
                onComposerBoxLayout={onComposerBoxLayout}
                bottomPad={bottomPad}
                walled={walled}
                wallSize={wallSize}
                backdrop={backdrop}
                keyboardAt={keyboardAt}
                banner={banner}
                org={org}
                notices={notices}
                member={member}
                awayAsk={awayAsk}
                seeAsk={seeAsk}
                runs={runs}
                lineBase={lineBase}
                consultData={consultData}
                canStop={canStop}
                stopRun={stopRun}
                waitingFirst={waitingFirst}
                waitingHere={waitingHere}
                seeWaiting={seeWaiting}
                live={live}
                meId={meId}
                threadId={threadId}
                seeConsult={seeConsult}
                openBrowserLine={openBrowserLine}
                lineStop={lineStop}
                returnLine={returnLine}
                dmAgent={dmAgent}
                channel={channel}
                capsuleRest={capsuleRest}
                placeholder={placeholder}
                sendFromField={sendFromField}
                working={working}
                plusFromField={plusFromField}
                composerMedia={composerMedia}
                channelId={channelId}
                prefill={prefill}
                captionBack={captionBack}
                replyAt={replyAt}
                composerBanner={composerBanner}
                composerAttachments={composerAttachments}
                pending={pending}
                canAttach={canAttach}
                longFromField={longFromField}
                mentionCard={mentionCard}
                onType={onType}
                orgId={orgId}
                dmAgentId={dmAgentId}
                quote={quote}
                voiceOn={voiceOn}
                afterVoice={afterVoice}
                voiceFromField={voiceFromField}
                voiceTakeBack={voiceTakeBack}
                voiceAsk={voiceAsk}
                onRecording={onRecording}
                admin={admin}
                join={join}
              />
            )}
          </DockGestureArea>
          <TeamFlight barHeight={headerHeight} />
        </View>
      </AskStoreProvider>
    </CodeConversation.Provider>
  );
}

const styles = StyleSheet.create({
  topFade: { position: "absolute", top: 0, left: 0, right: 0 },
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  pin: { paddingHorizontal: 12, paddingBottom: 10 },
  wallpaper: { position: "absolute", top: 0, left: 0 },
  // Under the last message, air before the composer (its box adds its own 6).
  listPad: { paddingTop: 8, paddingBottom: LIST_END_AIR },
});
