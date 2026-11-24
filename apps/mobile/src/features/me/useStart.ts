import { useChannels, useDms } from "@agenteschat/client";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect } from "react";
import { readValue, STORED, writeValue } from "@/lib/storage";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import { chatOfHref, useChatOpener } from "../chats/split";
import { useLaunched } from "../launch/launched";
import { stillHref } from "../links/landing";
import { inConversation, startHref, withPlace } from "./logic";

/** This conversation is where "Onde você parou" opens the next time the app starts (ADR 0108). */
export function useRememberPlace(href: string) {
  const { orgId } = useOrg();
  useFocusEffect(
    useCallback(() => {
      void readValue(STORED.lastPlace).then((raw) => writeValue(STORED.lastPlace, withPlace(raw, orgId, href)));
    }, [orgId, href]),
  );
}

/** Once per app start: the choice applies when the app starts, never when Conversas shows again. */
let started = false;

/**
 * When the app starts on Conversas (`focused` once the launch splash leaves), what the person chose opens over it,
 * back to Conversas. It is there in place, without the push's slide (`stillHref`): the app opens on it rather than on
 * Conversas with a conversation sliding over once the lists are in. Never over a screen a notification or a link
 * opened.
 */
export function useOpenStart(focused: boolean) {
  const { org, orgId } = useOrg();
  const launched = useLaunched();
  const channels = useChannels(orgId);
  const dms = useDms(orgId);
  const choice = org?.start;
  // Beside the list on a large screen (ADR 0212) a conversation opens in the split's pane, not over the split.
  const opener = useChatOpener();
  useEffect(() => {
    if (started || !launched) return;
    if (!focused || !choice || choice.page === "home") {
      started = true;
      return;
    }
    if (!channels.data || !dms.data) return;
    started = true;
    const mine = inConversation(channels.data, dms.data);
    void readValue(STORED.lastPlace).then((raw) => {
      const href = startHref(choice, raw, orgId, mine);
      if (!href) return;
      const chat = opener ? chatOfHref(href) : null;
      if (opener && chat) opener.open(chat);
      else router.push(stillHref(href) as never);
    });
  }, [launched, focused, choice, channels.data, dms.data, orgId, opener]);
}
