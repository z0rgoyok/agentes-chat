import { useDms } from "@agenteschat/client";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { useOrg } from "@/components/org-context";

/** A place in a conversation: its thread when it has one, at a message when one is named. */
export interface ConversationPlace {
  channelId: string;
  threadId?: string | null;
  messageId?: string | null;
}

/**
 * Opens a place in a conversation the reader reads: its thread, else the person's DM with an agent at its own address,
 * else the channel, at the message when one is named.
 */
export function useOpenConversation() {
  const { org } = useOrg();
  const dms = useDms(org.id).data;
  const navigate = useNavigate();
  return useCallback(
    ({ channelId, threadId, messageId }: ConversationPlace) => {
      const search = messageId ? { m: messageId } : {};
      if (threadId) {
        void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId }, search });
        return;
      }
      const dm = dms?.find((d) => d.channelId === channelId && d.with.type === "agent");
      if (dm) {
        void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: dm.with.id }, search });
        return;
      }
      void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: org.id, channelId }, search });
    },
    [dms, navigate, org.id],
  );
}
