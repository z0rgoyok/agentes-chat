import { useNotifications } from "@agenteschat/client";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { notificationHref } from "@/features/links/logic";
import { useColors, useOrgId } from "@/features/shared/hooks";
import { landOn } from "@/ui/navigation";

/**
 * A bare link to an agent's request for help in its browser (`agenteschat://handoff/<id>`): the request
 * lives in its conversation, so this finds where its notice in "Esperando você" opens (the conversation with
 * the card in control, or the agent's computer) and goes there in its place; without it, to the activity tab (back
 * down to the tabs, never a second copy of them).
 */
export default function HandoffRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const orgId = useOrgId();
  const c = useColors();
  const waiting = useNotifications(orgId, "waiting");
  // Once: the list may refresh before this screen is gone.
  const left = useRef(false);
  useEffect(() => {
    if (left.current || (!waiting.data && !waiting.isError)) return;
    left.current = true;
    const notice = waiting.data?.pages.flatMap((p) => p.items).find((n) => n.source.handoffId === id);
    const href = notice ? notificationHref(notice) : null;
    landOn(href && !href.startsWith("/handoff/") ? href : "/activity");
  }, [waiting.data, waiting.isError, id]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
      <ActivityIndicator color={c.muted} />
    </View>
  );
}
