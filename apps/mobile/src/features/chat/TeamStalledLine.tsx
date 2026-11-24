import { useAgentStatuses } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { budgetPausedIds, budgetStalledText } from "@agenteschat/client/lib/team-watch";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { Button, Icon, LineIcon, Text, useReducedMotion } from "@/ui";
import { BUTTON_SIZES } from "@/ui/Button";
import { router } from "@/ui/navigation";
import { useColors, useDirectory } from "../shared/hooks";

/**
 * Above #general's box, as on the web: the agents whose work waits on their monthly budget, with Aumentar orçamento for
 * who manages agents (the agent's page, or Uso for several). Shaped as the no-AI line above the box.
 */
export function TeamStalledLine() {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useColors();
  const reduced = useReducedMotion();
  const { orgId, org } = useOrg();
  const paused = budgetPausedIds(useAgentStatuses(orgId).data).flatMap((id) => dir.agentById.get(id) ?? []);
  const first = paused[0];
  if (!first) return null;
  const acts = can(org, "manage_agents");
  const raise = () => router.push((paused.length === 1 ? `/agent/${first.id}` : "/usage") as never);
  return (
    <Animated.View
      entering={reduced ? undefined : FadeInDown.duration(220)}
      exiting={reduced ? undefined : FadeOut.duration(160)}
      accessibilityLiveRegion="polite"
      style={[styles.line, { backgroundColor: c.sunken }]}
    >
      {acts ? (
        <View style={styles.atButton}>
          <Icon name="pause" size={15} color={c.ink2} />
        </View>
      ) : (
        <LineIcon variant="small" name="pause" size={15} color={c.ink2} />
      )}
      <Text variant="small" tone="ink2" style={[styles.text, acts ? styles.textAtButton : null]}>
        <Text variant="small" tone="ink2" style={styles.strong}>
          {t("channel.teamStalled")}
        </Text>{" "}
        {budgetStalledText(
          t,
          paused.map((a) => a.name),
        )}
      </Text>
      {acts ? (
        <Button variant="secondary" size="sm" label={t("notifications.teamWatch.act.budget")} onPress={raise} />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: 4,
    marginBottom: 6,
    paddingVertical: 6,
    paddingLeft: 10,
    paddingRight: 6,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    borderBottomLeftRadius: 3,
  },
  text: { flex: 1, minWidth: 0 },
  atButton: { height: BUTTON_SIZES.sm.height, justifyContent: "center" },
  textAtButton: { paddingTop: (BUTTON_SIZES.sm.height - 20) / 2 },
  strong: { fontWeight: "600" },
});
