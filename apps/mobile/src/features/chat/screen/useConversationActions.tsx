import {
  ApiError,
  type Message,
  type MessagePin,
  type ReplyRef,
  type SearchHit,
  type useApi,
} from "@agenteschat/client";
import { canTalk } from "@agenteschat/client/lib/audience";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useTranslation } from "react-i18next";
import type { useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useChatOpener } from "../../chats/split";
import { chatHref, consultationHref } from "../../links/logic";
import { ConversationSearch } from "../../search/ConversationSearch";
import { hitTarget } from "../../search/logic";
import { Face, OpensAgent } from "../../shared/Face";
import { Tile } from "../../shared/parts";
import type { useSheet } from "../../shared/SheetHost";
import { usePresenceWord } from "../../status/hooks";
import { PersonStatusCard } from "../../status/StatusCard";
import { ConversationSwitcher } from "../ConversationSwitcher";
import { pinTarget } from "../logic";
import { channelMembersHrefs } from "../members";
import { PinsSheet } from "../PinsSheet";
import { ReturnsSheet } from "../Returns";
import { ChannelOptions, MessageActions, ThreadOptions } from "../sheets";
import { NATIVE_MENU } from "./constants";
import { useLatest } from "./hooks";
import type { Row } from "./rows";
import type { ChatData } from "./useChatData";
import type { FollowEnd } from "./useFollowEnd";
import { HereReturns } from "./work-line";

/** Going to a message: the page read around it (the server's largest). */
const SEEK_PAGE = 200;
/** How long the message gone to stays lit. */
const FLASH_MS = 1600;

/**
 * The conversation's actions and sheets: a message's menu, going to a message (a pin, a quote, a return, a search hit),
 * the pins, the returns, the search, who is in the channel, the options and the conversation switcher.
 */
export function useConversationActions({
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
}: {
  channelId: string;
  threadId: string | null;
  focusId: string | null;
  /**
   * `focusId` is where the conversation was being read on the other display (ADR 0212): gone to at once, at the top of
   * the view, not lit, and quietly given up when it can't be reached.
   */
  quietFocus: boolean;
  orgId: string;
  api: ReturnType<typeof useApi>;
  t: ReturnType<typeof useTranslation>["t"];
  toast: ReturnType<typeof useToast>;
  sheet: ReturnType<typeof useSheet>;
  info: ChatData["thread"]["data"];
  title: string;
  subtitle: string | undefined;
  personDm: string | null;
  leavePlace: () => void;
  onReply: (m: Message) => void;
  openNewMission: (goal?: string, homeThreadId?: string | null) => void;
  openRemind: (input?: { text?: string; message?: Message }) => void;
  follow: Pick<FollowEnd, "aimAt" | "letGo" | "listRef" | "shownRows" | "toEnd">;
  data: Pick<
    ChatData,
    | "channel"
    | "dm"
    | "dmAgent"
    | "dmAgentId"
    | "isThread"
    | "linkThreads"
    | "member"
    | "mission"
    | "org"
    | "showAround"
    | "thread"
    | "threadMessages"
    | "top"
  >;
}) {
  const { aimAt, letGo, listRef, shownRows, toEnd } = follow;
  const {
    channel,
    dm,
    dmAgent,
    dmAgentId,
    isThread,
    linkThreads,
    member,
    mission,
    org,
    showAround,
    thread,
    threadMessages,
    top,
  } = data;
  // ── Holding a message, swiping it ──
  // "Responder" quotes the message above the field, in the conversation or the thread (the server keeps the quote in
  // the same place), wherever I can write.
  const canMission = !mission && (Boolean(dm) || Boolean(channel));
  const canReply =
    member &&
    !org?.deletion &&
    (!isThread || thread.data?.state !== "archived") &&
    channel?.can?.post !== false &&
    (!dmAgent || canTalk(dmAgent));
  // What a message's menu works with: the system's menu (iOS, built by each row, `ChatMessage`) and the app's sheet
  // (Android) list the same actions. What it calls keeps its identity, reading the screen as it is when called.
  const onMission = useLatest((goal: string, rootId: string) => openNewMission(goal, rootId));
  const onRemind = useLatest((message: Message) => openRemind({ message }));
  // The app's own sheet only where the platform has no menu of its own: on iOS a hold is the system's.
  const openActions = useLatest((m: Message) =>
    sheet.open(
      <MessageActions
        message={m}
        canMission={canMission}
        inThread={isThread}
        thread={linkThreads.get(m.threadId ?? m.id)}
        onMission={onMission}
        onRemind={onRemind}
        onReply={canReply ? onReply : undefined}
      />,
    ),
  );
  const onLongPress = NATIVE_MENU ? undefined : openActions;

  // ── Pins ──
  const rowsRef = useRef<Row[]>([]);
  // Going to a message (a pin, `?m=`): found among the rows, or the page around it read from the server at any
  // distance; then scrolled to and lit for a moment.
  const [seek, setSeek] = useState<string | null>(focusId);
  const quietSeek = useRef(quietFocus ? focusId : null);
  const [flashId, setFlashId] = useState<string | null>(null);
  // The target whose page was asked for, and whether it came.
  const [around, setAround] = useState<{ id: string; done: boolean } | null>(null);
  const seekReady = isThread ? threadMessages.isSuccess && !threadMessages.isPlaceholderData : top.isSuccess;
  const seekRefreshing = isThread ? threadMessages.isFetching : top.isFetching;
  useEffect(() => {
    if (!seek || !seekReady) return;
    const index = shownRows.findIndex((r) => r.kind === "message" && r.message.id === seek);
    if (index >= 0) {
      setSeek(null);
      letGo();
      if (quietSeek.current === seek) {
        quietSeek.current = null;
        void listRef.current?.scrollToIndex({ index, animated: false, ...aimAt(index, 0, "start") });
        return;
      }
      void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.4, "start") });
      setFlashId(seek);
      return;
    }
    const missing = (error?: unknown) => {
      setSeek(null);
      if (quietSeek.current === seek) {
        quietSeek.current = null;
        return;
      }
      // A page that didn't come says so: the message may well be there.
      const gone = error === undefined || (error instanceof ApiError && error.status === 404);
      toast({ title: gone ? t("channel.jumpMissing") : t("common.loadFailed"), icon: "x" });
    };
    // A thread holds all it can show; a page read around it that still doesn't show it: deleted or not visible.
    if (isThread || (around?.id === seek && around.done)) {
      // A cached page refreshing may still bring it.
      if (!seekRefreshing) missing();
      return;
    }
    if (around?.id === seek) return;
    setAround({ id: seek, done: false });
    api.chat
      .messages(orgId, channelId, { around: seek, limit: SEEK_PAGE })
      .then((page) => {
        showAround(page);
        setAround({ id: seek, done: true });
      })
      .catch(missing);
  }, [
    seek,
    seekReady,
    seekRefreshing,
    shownRows,
    isThread,
    around,
    api,
    orgId,
    channelId,
    showAround,
    letGo,
    aimAt,
    t,
    toast,
    listRef,
  ]);
  useEffect(() => {
    if (!flashId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashId]);
  const onQuote = useCallback(
    (reply: ReplyRef) => {
      // A thread's reply isn't a row of the conversation: it is on the thread's screen.
      if (!isThread && reply.threadId) {
        router.push(chatHref(channelId, reply.threadId, reply.messageId));
        return;
      }
      setAround(null);
      setSeek(reply.messageId);
    },
    [isThread, channelId],
  );
  const goToPin = (pin: MessagePin) => {
    sheet.close();
    const target = pinTarget(pin, threadId);
    if (target.kind === "open") {
      router.push(chatHref(channelId, target.threadId, target.messageId));
      return;
    }
    setAround(null);
    setSeek(target.messageId);
  };
  // From the conversation's options, the next page of that sheet.
  const openPins = () => sheet.push(<PinsSheet channelId={channelId} threadId={threadId} onPick={goToPin} />);
  // The returns agents set here (ADR 0037 addendum): the dock's line at rest (`HereReturns`, which reads them), the
  // sheet behind it; a row goes to the reply that said it.
  const goToReturn = (messageId: string) => {
    sheet.close();
    setAround(null);
    setSeek(messageId);
  };
  const openReturns = useLatest(() =>
    sheet.open(<ReturnsSheet channelId={channelId} threadId={threadId} onPick={goToReturn} />),
  );
  // The working line's own, the same from one redraw of the conversation to the next: it redraws with the work.
  const returnLine = useMemo(
    () => <HereReturns channelId={channelId} threadId={threadId} onOpen={openReturns} />,
    [channelId, threadId, openReturns],
  );
  const seeConsult = useCallback((id: string) => router.push(consultationHref(id, channelId)), [channelId]);
  const openBrowserLine = useCallback(() => toEnd(), [toEnd]);
  // "Buscar nesta conversa" (as the web's header search): on the timeline, not in a thread.
  const searchPlace = isThread
    ? null
    : dm
      ? { id: channelId, name: dm.with.name, dm: true }
      : channel
        ? { id: channelId, name: channel.name }
        : null;
  const goToHit = (hit: SearchHit) => {
    sheet.close();
    const target = hitTarget(hit, channelId);
    if (target.kind === "open") {
      router.push(target.href);
      return;
    }
    setAround(null);
    setSeek(target.messageId);
  };
  const openSearch = () =>
    searchPlace ? sheet.push(<ConversationSearch place={searchPlace} onPick={goToHit} />) : undefined;
  // "Ver resultado" on a work's line: its report, when this conversation shows it. Its place is the list's, by its key:
  // counted in the rows, it fell one short under the "Novas" line (a row of the list's own).
  const jumpToMessage = useCallback(
    (messageId: string) => {
      const key = rowsRef.current.find((r) => r.kind === "message" && r.message.id === messageId)?.key;
      const index = key === undefined ? undefined : listRef.current?.getState().indexByKey(key);
      if (index === undefined) return false;
      void listRef.current?.scrollToIndex({ index, animated: true, ...aimAt(index, 0.4, "start") });
      return true;
    },
    [aimAt, listRef],
  );
  // Who is in the channel: managing it is a screen pushed over the conversation (its place kept for the way back).
  const openMembers = () => {
    if (!channel) return;
    leavePlace();
    router.push(channelMembersHrefs.list(channelId));
  };

  const openOptions = () =>
    info && isThread
      ? sheet.open(
          <ThreadOptions
            thread={info}
            mission={mission}
            onMission={() => openNewMission("", info.id)}
            onPins={openPins}
          />,
        )
      : sheet.open(
          <ConversationOptions
            person={personDm}
            subtitle={subtitle}
            channelId={channelId}
            title={title}
            leading={
              dm ? (
                <OpensAgent agentId={dm.with.id}>
                  <Face who={{ type: dm.with.type, id: dm.with.id }} size={36} live={false} />
                </OpensAgent>
              ) : (
                <Tile icon="hash" />
              )
            }
            agentId={dmAgentId}
            about={personDm ? <PersonStatusCard userId={personDm} /> : undefined}
            onPins={openPins}
            onMembers={
              channel && !dm
                ? () => {
                    sheet.close();
                    openMembers();
                  }
                : undefined
            }
            onSearch={dm && searchPlace ? openSearch : undefined}
          />,
        );
  const opener = useChatOpener();
  // Holding the pill: "Trocar de conversa". The pick swaps the conversation in place (the route's params; the
  // screen is keyed by them), not a new screen sliding in: the slide made the header's pill jump at its end.
  // The swap waits for the sheet to be gone (it lives in this screen, which the swap remounts): `sheet.close` says when.
  // The params merge, so the message this one opened at (`m`, from a notification) goes too: kept, the next
  // conversation paged back through its history looking for it, then said it couldn't reach it.
  const onHoldPill = useLatest(() => {
    sheet.open(
      <ConversationSwitcher
        channelId={channelId}
        onPick={(id) => {
          if (id === channelId) sheet.close();
          // Beside the list (ADR 0212) the pick opens in the split's pane, which draws this screen afresh.
          else if (opener) sheet.close(() => opener.open({ channelId: id, threadId: null }));
          else sheet.close(() => router.setParams({ channelId: id, thread: "", handoff: "", m: "" }));
        }}
      />,
    );
  });
  return {
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
  };
}

export type ConversationActions = ReturnType<typeof useConversationActions>;

/**
 * The conversation's options (`ChannelOptions`), with how the person of a DM appears under its name (`person`), read
 * here: in the conversation, the workspace's presence drew it all again with each change.
 */
function ConversationOptions({
  person,
  subtitle,
  ...options
}: Omit<ComponentProps<typeof ChannelOptions>, "subtitle"> & { person: string | null; subtitle: string | undefined }) {
  const word = usePresenceWord(person ? { type: "person", id: person } : null) ?? subtitle;
  return <ChannelOptions {...options} {...(word ? { subtitle: word } : {})} />;
}
