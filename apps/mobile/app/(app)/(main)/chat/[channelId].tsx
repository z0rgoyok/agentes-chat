import { useChannels, useDms } from "@agenteschat/client";
import { type ErrorBoundaryProps, useLocalSearchParams } from "expo-router";
import { ChatScreen } from "@/features/chat/ChatScreen";
import { chatHref } from "@/features/links/logic";
import { useRememberPlace } from "@/features/me/useStart";
import { isSafeId } from "@/features/shared/logic";
import { FocusLive } from "@/features/shared/parts";
import { ScreenError } from "@/features/shared/ScreenError";
import { useOrgId } from "@/providers/org";
import { useConversationUnder, useSettleStill } from "@/ui/navigation";

/** A conversation that breaks while drawing shows what happened in its own screen; back still goes back. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <ScreenError {...props} />;
}

/**
 * A conversation (deep link `agenteschat://chat/<channelId>?thread=<rootId>`). `handoff=<id>`: an agent's
 * request for help in its browser, whose card opens in place, in control. `m=<id>`: open at that message. `still=1`:
 * opened in place at launch (the start screen, ADR 0108), without its slide.
 */
export default function ChatRoute() {
  const params = useLocalSearchParams<{
    channelId: string;
    thread?: string;
    handoff?: string;
    m?: string;
    still?: string;
  }>();
  const { channelId, thread, handoff, m } = params;
  const threadId = isSafeId(thread) ? thread : null;
  useSettleStill(params);
  // Back from a channel's or a DM's thread opened from anywhere else (the Threads tab, a notification) goes to that
  // conversation; a task's or a file's has none to go to.
  const orgId = useOrgId();
  const channels = useChannels(orgId).data;
  const dms = useDms(orgId).data;
  const listed = channels?.some((c) => c.id === channelId) || dms?.some((d) => d.channelId === channelId);
  useConversationUnder(channelId, listed ? threadId : null);
  // Where "Onde você parou" opens the next time the app starts (ADR 0108).
  useRememberPlace(chatHref(channelId, threadId));
  return (
    <FocusLive>
      <ChatScreen
        key={`${channelId}:${thread ?? ""}`}
        channelId={channelId}
        threadId={threadId}
        handoffId={isSafeId(handoff) ? handoff : null}
        focusId={isSafeId(m) ? m : null}
      />
    </FocusLive>
  );
}
