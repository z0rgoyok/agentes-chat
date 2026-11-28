import type { Message } from "@agenteschat/client";
import type { RelayedAnswer } from "@agenteschat/client/lib/consult-group";
import { previewOf } from "@agenteschat/client/lib/consultations";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text, useTheme } from "@/ui";
import { router } from "@/ui/navigation";
import { withAlpha } from "@/ui/palette";
import { RADIUS } from "@/ui/radius";
import { consultationHref } from "../links/logic";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { nameInk } from "./logic";
import { useRowDirectory } from "./row-data";

/**
 * At the top of an agent's reply that passes on what another agent answered it (`relayedAnswers`), in place of that
 * agent's own bubble: its face and its name in its color, the start of its words in up to two lines and a chevron,
 * on a plate a step off the bubble, as a reply quotes a message; a tap opens the two agents' conversation, where those
 * words stay whole.
 */
export function RelayQuote({ relay, channelId }: { relay: RelayedAnswer<Message>; channelId: string }) {
  const { t } = useTranslation();
  const dir = useRowDirectory();
  const c = useColors();
  const { scheme } = useTheme();
  const { message: m, consultation } = relay;
  const agentId = m.author.id ?? consultation.consultedAgentId;
  const agent = dir.agentById.get(agentId);
  const name = agent?.name ?? t("mobile.chat.someone");
  const ink = nameInk(agentLook(agent).color, scheme === "dark");
  const excerpt = previewOf(m.body);
  return (
    <Pressable
      onPress={() => router.push(consultationHref(consultation.id, channelId))}
      accessibilityRole="button"
      accessibilityLabel={t("chat.consultPanel.relay", { name, excerpt })}
      style={({ pressed }) => [quote.box, { backgroundColor: withAlpha(c.ink, pressed ? 0.09 : 0.05) }]}
    >
      <View style={quote.inner}>
        <View style={quote.head}>
          <AgentFace agentId={agentId} size={QUOTE_FACE} live={false} mode="idle" />
          <Text variant="small" numberOfLines={1} style={[quote.name, { color: ink }]}>
            {name}
          </Text>
        </View>
        <Text variant="footnote" tone="muted" numberOfLines={2}>
          {excerpt}
        </Text>
      </View>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

/** The quote's faces. */
const QUOTE_FACE = 16;

const quote = StyleSheet.create({
  // The words' column, a step off the bubble's own fill, the chevron at its right.
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
    marginBottom: 8,
    // The plates' room and the scale's item corner, as a quote in the words.
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 10,
    borderRadius: RADIUS.md,
    overflow: "hidden",
  },
  inner: { flex: 1, minWidth: 0, gap: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 5 },
  name: { fontWeight: "600", flexShrink: 1 },
});
