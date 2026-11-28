import type { WorkTone } from "@agenteschat/client/lib/agent-work";
import { upperFirst } from "@agenteschat/client/lib/format";
import { orbitColors } from "@agenteschat/ui/agent/orbit";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { CHROME_MAX_SCALE, LIST_PREVIEW, Text, useTheme, weights } from "@/ui";
import { withAlpha } from "@/ui/palette";

/**
 * An agent's status in a list's second line (the web's `AgentWorkLine`): its word in bold, first letter up, then what
 * follows it (` · 22 min`, what it asks) in `restTone`, one line that ends in "…". Only what waits on you takes a colour
 * (amber); working, its face wears the orbit in its own colours, so the word stays in the ink. No plate, so a row
 * never shows two badges (an agent's role beside its name is one).
 */
export function StatusWord({
  text,
  tone,
  rest,
  restTone = "faint",
}: {
  text: string;
  tone: WorkTone;
  rest?: string | null | undefined;
  restTone?: "faint" | "ink2";
}) {
  const { i18n } = useTranslation();
  const { colors: c } = useTheme();
  return (
    <Text variant="small" tone={restTone} numberOfLines={1} style={[LIST_PREVIEW, styles.shrink]}>
      <Text variant="small" style={[LIST_PREVIEW, styles.strong, { color: tone === "you" ? c.amberInk : c.ink2 }]}>
        {upperFirst(text, i18n.language)}
      </Text>
      {rest ? ` · ${rest}` : ""}
    </Text>
  );
}

/**
 * A handed work's state under "Passado para" (the web's `HandedWorkLine`): a soft plate in the state's colour, the
 * agent's own while it works (`color`, its look's), amber while it waits on you, green once it is done, the neutral
 * plate for a wait elsewhere, its first letter up. What comes after it is the line's own text.
 */
export function StatusBadge({ text, tone, color }: { text: string; tone: WorkTone | "done"; color?: string }) {
  const { i18n } = useTranslation();
  const { colors: c, scheme } = useTheme();
  const dark = scheme === "dark";
  const lead =
    tone === "you" ? c.amber : tone === "done" ? c.ok : tone === "working" ? orbitColors(color, dark).rings[0] : null;
  return (
    <View style={[styles.badge, { backgroundColor: lead ? withAlpha(lead, dark ? 0.26 : 0.13) : c.plate }]}>
      <Text
        variant="caption"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.word, { color: tone === "you" ? c.amberInk : (lead ?? c.ink2) }]}
      >
        {upperFirst(text, i18n.language)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexShrink: 1, minWidth: 0, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6 },
  word: { fontWeight: "600" },
  strong: { fontWeight: weights.semibold },
  shrink: { flexShrink: 1 },
});
