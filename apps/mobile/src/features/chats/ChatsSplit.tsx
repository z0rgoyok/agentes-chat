import { type Href, useGlobalSearchParams, useIsFocused, useSegments } from "expo-router";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { landOn, router } from "@/ui/navigation";
import { ChatScreen } from "../chat/ChatScreen";
import { handPlace, placeKey, readingPlace } from "../chat/reading-place";
import { stillHref } from "../links/landing";
import { chatHref } from "../links/logic";
import { useRememberPlace } from "../me/useStart";
import { useOrgId } from "../shared/hooks";
import { FocusLive } from "../shared/parts";
import { SplitPanes, useSelectedTab, useSplitHandoff } from "../shared/SplitPanes";
import type { SplitStore } from "../shared/split-store";
import {
  type ChatOpener,
  ChatOpenerContext,
  type ChatTarget,
  chatOwner,
  chatSplit,
  pushedChatOf,
  useChatOpener,
} from "./split";

/**
 * Conversas on a large screen (ADR 0212: the iPhone Duo's inner display): the list (the home, `list`) in the left pane
 * and the open conversation in the right one, with its own bar there (its pill in the middle, its computer and "…" at
 * the pane's top right, no back button: the list is beside it) and its composer at the pane's foot, clear of the tab
 * bar. A row opens its conversation here instead of pushing it and stays lit while it is open; another row swaps only
 * this pane. The choice is kept per workspace (`split.ts`), through redraws, remounts and the device closing and
 * opening; with none yet, the list's most recent conversation opens (`OpenFirstChat`).
 */
export function ChatsSplit({ list }: { list: ReactNode }) {
  const { t } = useTranslation();
  return <ChatSplit store={chatSplit} list={list} testID="chats-split" empty={t("mobile.chats.splitEmpty")} />;
}

/**
 * A list of conversations beside the open one (Conversas, Threads): `store` keeps which is open, `empty` is said where
 * it would be while there is none to open.
 */
export function ChatSplit({
  store,
  list,
  testID,
  empty,
}: {
  store: SplitStore<ChatTarget>;
  list: ReactNode;
  testID: string;
  empty: string;
}) {
  const orgId = useOrgId();
  const key = store.useShownKey(orgId);
  const chat = key ? store.shown(orgId) : null;
  const opener = useMemo<ChatOpener>(
    () => ({ orgId, store, open: (target) => store.choose(orgId, target) }),
    [orgId, store],
  );
  return (
    <ChatOpenerContext.Provider value={opener}>
      <SplitPanes
        testID={testID}
        list={list}
        // Its safe area is its own: the tab bar floats over its foot, where the composer stands.
        ownInsets
        detailKey={key && chat ? key : null}
        detail={chat ? <ConversationPane chat={chat} /> : null}
        empty={empty}
      />
    </ChatOpenerContext.Provider>
  );
}

/**
 * The open conversation in its pane: the conversation's own screen, its bar the pane's (`PushedHeader` in a pane), and
 * the place the app reopens at its next start (ADR 0108), as its pushed screen is.
 */
function ConversationPane({ chat }: { chat: ChatTarget }) {
  useRememberPlace(chatHref(chat.channelId, chat.threadId));
  return (
    <FocusLive>
      <ChatScreen channelId={chat.channelId} threadId={chat.threadId} />
    </FocusLive>
  );
}

/**
 * With nothing open yet beside the list, its first conversation (the most recent) opens, in the split the list is in
 * (Conversas' or Threads'). Draws nothing; only in a split.
 */
export function OpenFirstChat({ channelId, threadId }: { channelId: string | null; threadId: string | null }) {
  const opener = useChatOpener();
  const key = (opener?.store ?? chatSplit).useShownKey(opener?.orgId ?? "");
  useEffect(() => {
    if (opener && !key && channelId) opener.open({ channelId, threadId });
  }, [opener, key, channelId, threadId]);
  return null;
}

/**
 * Opening and closing the device mid-task keeps the person in the conversation (ADR 0212) in Conversas' split, as
 * `ChatHandoff` says. Under Conversas, which stays mounted beneath the other tabs and the screens pushed over them.
 */
export function SplitHandoff({ wide }: { wide: boolean }) {
  return <ChatHandoff wide={wide} store={chatSplit} owner="chats" home="/" />;
}

/**
 * A split of conversations across the device opening and closing (ADR 0212): the window changing size class moves the
 * open conversation between the split's pane and a pushed screen (`splitHandoff`), with the message being read
 * (`reading-place.ts`); what was being typed is the composer's own, kept by conversation while the app runs. Closing
 * pushes it in place, without the slide (it was already on screen). Opening with a conversation pushed over the tabs
 * opens it afresh in the pane of the split it came from (`chatOwner`: Threads' from the Threads tab, Conversas' from
 * any other), at the place handed over, then lands back on that tab (`home`). Draws nothing; under its tab's root.
 */
export function ChatHandoff({
  wide,
  store,
  owner,
  home,
}: {
  wide: boolean;
  store: SplitStore<ChatTarget>;
  owner: "chats" | "threads";
  home: Href;
}) {
  const orgId = useOrgId();
  const focused = useIsFocused();
  const segments = useSegments();
  const params = useGlobalSearchParams();
  const selectedTab = useSelectedTab();
  const handOver = (chat: ChatTarget) => {
    const place = placeKey(chat.channelId, chat.threadId);
    handPlace(place, readingPlace(place));
  };
  useSplitHandoff(
    wide,
    () => ({
      splitShown: focused,
      chosen: store.chosen(orgId),
      pushed: chatOwner(selectedTab()) === owner ? pushedChatOf(segments, params) : null,
    }),
    {
      push: (chat) => {
        handOver(chat);
        router.push(stillHref(chatHref(chat.channelId, chat.threadId)) as never);
      },
      take: (chat) => {
        handOver(chat);
        store.choose(orgId, chat, true);
        landOn(home);
      },
    },
  );
  return null;
}
