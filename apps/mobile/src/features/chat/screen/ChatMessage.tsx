import type { Message, MessageReceipt, ReplyRef, ThreadInfo } from "@agenteschat/client";
import { runPosition } from "@agenteschat/client/lib/chat";
import { memo, useCallback, useMemo } from "react";
import Animated, { LayoutAnimationConfig } from "react-native-reanimated";
import { PushOfferLine } from "../../push/PushOfferLine";
import { FanStrip } from "../../queue/parts";
import { useColors } from "../../shared/hooks";
import { AgentReceiptLine, EveryoneLine } from "../AgentReceipts";
import { MessageMenuFor } from "../MessageMenu";
import { MessageRow } from "../MessageRow";
import { useRowDirectory } from "../row-data";
import { SwipeReply } from "../SwipeReply";
import type { MessageActionsContext } from "../sheets";
import { ENTER, NATIVE_MENU } from "./constants";
import type { MessageItem } from "./rows";

/** What every message row of the conversation is handed alike: callbacks that keep their identity. */
export interface RowHands {
  onReply: (m: Message) => void;
  onMission: (goal: string, threadId: string) => void;
  onRemind: (m: Message) => void;
  /** Where the platform has no menu of its own (Android): the app's sheet on a hold. */
  onLongPress: ((m: Message) => void) | undefined;
  onRetry: (m: Message) => void;
  onQuote: (reply: ReplyRef) => void;
  onResend: (m: Message) => Promise<unknown> | undefined;
  onOfferDone: () => void;
}

/**
 * A message's row with what stands around it: the swipe that answers it, the system's menu on a hold (iOS), and under
 * it the strip of the agents it called, its receipt's line and the notifications' offer. Kept as it was unless what is
 * its own changes: a receipt arriving, a thread's link or the lit row redraw that one row, never every row on screen
 * with its menu (each builds its actions, with their queries, and the system's menu). A row mounted again as it
 * scrolls back into view plays nothing in again (`skipEntering`); what shows up on it later still comes in.
 */
export const ChatMessage = memo(function ChatMessage({
  item,
  fresh,
  lit,
  isThread,
  meId,
  canReply,
  canMission,
  thread,
  replying,
  menuThread,
  aboveThread,
  markReceipt,
  seenBy,
  fanReceipt,
  line,
  lineReceipt,
  connectInline,
  offer,
  hands,
}: {
  item: MessageItem;
  /** Just arrived at the bottom: it rises in, an agent's reply too (it shows whole, once, with nothing to replace). */
  fresh: boolean;
  /** The message gone to, lit for a moment. */
  lit: boolean;
  isThread: boolean;
  meId: string | null;
  canReply: boolean;
  canMission: boolean;
  /** The thread it starts, a link under it in the conversation. */
  thread: ThreadInfo | undefined;
  /** The agents replying in the thread under it before it has a link, comma-joined (`replyingUnder`). */
  replying: string | undefined;
  /** The thread its menu works with: the one it starts or the one it is in. */
  menuThread: ThreadInfo | undefined;
  aboveThread: boolean;
  /** The agents' receipt its mark shows, on the row that wears it. */
  markReceipt: MessageReceipt | undefined;
  seenBy: string | undefined;
  /** The receipt of an agent's message that called several agents, or of a mention of everyone. */
  fanReceipt: MessageReceipt | undefined;
  /** Its receipt's line under it (the one message that has it), with that receipt. */
  line: boolean;
  lineReceipt: MessageReceipt | undefined;
  connectInline: boolean;
  /** The notifications' offer under it. */
  offer: boolean;
  hands: RowHands;
}) {
  const m = item.message;
  const c = useColors();
  const dir = useRowDirectory();
  const { onReply, onMission, onRemind } = hands;
  const reply = useCallback(() => onReply(m), [onReply, m]);
  const menu = useMemo<MessageActionsContext>(
    () => ({
      message: m,
      canMission,
      inThread: isThread,
      thread: menuThread,
      onMission,
      onRemind,
      onReply: canReply ? onReply : undefined,
    }),
    [m, canMission, isThread, menuThread, onMission, onRemind, canReply, onReply],
  );
  const row = (
    <MessageRow
      message={m}
      grouped={item.grouped}
      newTurn={item.newTurn}
      run={runPosition(item.grouped, item.continued ?? false)}
      above={item.above}
      relay={item.relay}
      aboveThread={aboveThread}
      meId={meId}
      thread={thread}
      replying={replying}
      inThread={isThread}
      {...(hands.onLongPress ? { onLongPress: hands.onLongPress } : {})}
      onRetry={hands.onRetry}
      onQuote={hands.onQuote}
      receipt={markReceipt}
      seenBy={seenBy}
    />
  );
  return (
    // My own words are there at once, whole (as every chat app's): only someone else's rise in.
    <Animated.View
      entering={fresh && m.author.id !== meId ? ENTER : undefined}
      style={lit ? { backgroundColor: c.sunken } : undefined}
    >
      {/* Swipe right to answer it (a quote above the field); hold it for the system's menu (iOS) or the app's sheet. A
          message still on its way can't be swiped, and its menu offers only copying its words; the same views stand
          around it either way, so it isn't drawn again when it turns sent. The menu brings the plain view it lifts (the
          row can be a fragment: a pair row, a quote). */}
      <SwipeReply enabled={canReply && !m.local} onReply={reply}>
        {NATIVE_MENU ? <MessageMenuFor context={menu}>{row}</MessageMenuFor> : row}
      </SwipeReply>
      <LayoutAnimationConfig skipEntering>
        {m.author.type === "agent" && m.mentionedAgentIds.length > 1 ? (
          <FanStrip message={m} receipt={fanReceipt} />
        ) : null}
        {m.meta?.everyoneShape ? <EveryoneLine message={m} receipt={fanReceipt} mine={m.author.id === meId} /> : null}
        {line ? (
          <AgentReceiptLine
            message={m}
            receipt={lineReceipt}
            mine={m.author.id === meId}
            connectInline={connectInline}
            onRetry={hands.onResend}
          />
        ) : null}
        {offer ? <PushOfferLine agent={dir.nameOf(m.author)} onDone={hands.onOfferDone} /> : null}
      </LayoutAnimationConfig>
    </Animated.View>
  );
});
