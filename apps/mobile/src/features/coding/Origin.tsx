import { useCodeSession } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { router } from "@/ui/navigation";
import { chatHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";

/**
 * At the top of a code session opened from a suggestion (ADR 0215 §11), as a file's conversation says where it was
 * made: "Aberta da sua conversa com o Leo · Ver conversa", the way back to that message. Nothing for a person the
 * conversation isn't shared with (the server leaves `from` out), nor for a session opened on its own.
 */
export const CodeOrigin = memo(function CodeOrigin({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const from = useCodeSession(orgId, sessionId).data?.from;
  if (!from) return null;
  const href = chatHref(from.channelId, from.threadId, from.messageId);
  return (
    <View style={styles.origin}>
      <Icon name="message" size={13} color={c.faint} />
      <Text variant="caption" tone="faint" style={styles.words}>
        {from.kind === "dm"
          ? t("codeSessions.from.dm", agentGrammar(from.name))
          : t("codeSessions.from.channel", { name: from.name })}
        {" · "}
        <Text
          variant="caption"
          accessibilityRole="link"
          // A way back in the words' own ink, underlined: the brand's blue is the agents', not links'.
          style={[styles.link, { color: c.ink2 }]}
          onPress={() => router.push(href)}
        >
          {t("codeSessions.from.see")}
        </Text>
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  origin: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  words: { flexShrink: 1, textAlign: "center" },
  link: { fontWeight: "600", textDecorationLine: "underline" },
});
