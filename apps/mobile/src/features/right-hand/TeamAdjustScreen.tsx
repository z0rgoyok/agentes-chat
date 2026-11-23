import { type TeamAgentDraft, useTeamCard } from "@agenteschat/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { useOrg } from "@/providers/org";
import { GroupedField, GroupedHeader, GroupedList, useFieldText } from "@/ui";
import { router } from "@/ui/navigation";
import { pickStore } from "../agents/pick-store";
import { useFailed } from "../routines/hooks";
import { NEXT_FIELD, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useColors } from "../shared/hooks";
import { goBack, successHaptic } from "../shared/parts";
import { overLimit, TextArea } from "../shared/TextArea";

/** What "Adjust" changes on one agent of the right hand's team card before the team exists. */
type AdjustPatch = {
  name: string;
  role: string;
  line: string;
  channel: string;
  instructions: string;
  firstTask: string;
};

/** The card's agent being adjusted: the card it belongs to and its draft. A route can't carry them (`pickStore`). */
interface TeamAdjust {
  channelId: string;
  messageId: string;
  agent: TeamAgentDraft;
}

const store = pickStore<TeamAdjust>();

/** Opens "Adjust" for an agent of a team card, a screen of its own over the conversation. */
export function openTeamAdjust(adjust: TeamAdjust) {
  store.open(adjust);
  router.push("/team-adjust");
}

/** The first task's length, as the card's own field kept it. */
const FIRST_TASK = { max: 500 };

/**
 * "Ajustar" (ADR 0137 §10), pushed from an agent's row on the team card (screens, not sheets): the draft as a settings
 * form, the short fields as rows of one group (Next goes down them), the long ones each under its header, Save in the
 * bar. Leaving with changes asks first; saved, it goes back to the card, which shows the change.
 */
export function TeamAdjustScreen() {
  const pick = useSyncExternalStore(store.subscribe, store.now);
  // Opened with no card under it (its address on its own, after a restart): nothing to adjust.
  useEffect(() => {
    if (!pick) goBack();
  }, [pick]);
  // The draft is the screen's while it shows; it goes when the screen does.
  useEffect(() => () => store.close(), []);
  if (!pick) return <SettingsPage title="" />;
  return <AdjustForm key={pick.agent.handle} pick={pick} />;
}

function AdjustForm({ pick }: { pick: TeamAdjust }) {
  const { t } = useTranslation();
  const c = useColors();
  const words = useFieldText("body");
  const failed = useFailed();
  const { orgId } = useOrg();
  const { agent } = pick;
  const adjust = useTeamCard(orgId, { channelId: pick.channelId, messageId: pick.messageId }).adjust;
  const saved: AdjustPatch = {
    name: agent.name,
    role: agent.role,
    line: agent.line,
    channel: agent.channel,
    instructions: agent.instructions,
    firstTask: agent.firstTask ?? "",
  };
  const [v, setV] = useState<AdjustPatch>(saved);
  const changed = (Object.keys(saved) as (keyof AdjustPatch)[]).some((k) => v[k] !== saved[k]);
  const leave = useUnsavedGuard(changed && !adjust.isPending);
  // Past its limit the task stays as typed, its line saying so: nothing is saved cut.
  const ready = changed && v.name.trim() !== "" && !overLimit(v.firstTask, FIRST_TASK);
  const save = () => {
    if (!ready || adjust.isPending) return;
    adjust.mutate(
      { handle: agent.handle, patch: v },
      {
        onSuccess: () => {
          leave();
          successHaptic();
          goBack();
        },
        onError: failed,
      },
    );
  };
  const input = (key: "name" | "role" | "line" | "channel", label: string, max: number) => (
    <GroupedField key={key} label={label}>
      <TextInput
        value={v[key]}
        maxLength={max}
        accessibilityLabel={label}
        onChangeText={(text) => setV((p) => ({ ...p, [key]: text }))}
        {...NEXT_FIELD}
        style={[styles.input, words, { color: c.ink }]}
      />
    </GroupedField>
  );
  return (
    <SettingsPage
      title={t("teamPlan.adjust.title", { name: agent.name })}
      action={{ label: t("common.save"), onPress: save, disabled: !ready }}
      busy={adjust.isPending}
      // Six fields, two of them long: the system's bar over the keyboard walks them and closes it.
      toolbar
    >
      <GroupedList>
        {input("name", t("teamPlan.adjust.name"), 80)}
        {input("role", t("teamPlan.adjust.role"), 200)}
        {input("line", t("teamPlan.adjust.line"), 300)}
        {/* An agent with no channel lives in its DM with the person (ADR 0159): nothing to name. */}
        {agent.channel ? input("channel", t("teamPlan.adjust.channel"), 80) : null}
      </GroupedList>
      <GroupedHeader>{t("teamPlan.adjust.instructions")}</GroupedHeader>
      <GroupedList>
        <TextArea
          value={v.instructions}
          accessibilityLabel={t("teamPlan.adjust.instructions")}
          onChangeText={(text) => setV((p) => ({ ...p, instructions: text }))}
          minHeight={140}
          scrollEnabled={false}
          style={styles.bare}
        />
      </GroupedList>
      <GroupedHeader>{t("teamPlan.adjust.firstTask")}</GroupedHeader>
      <GroupedList>
        <TextArea
          value={v.firstTask}
          limit={FIRST_TASK}
          accessibilityLabel={t("teamPlan.adjust.firstTask")}
          onChangeText={(text) => setV((p) => ({ ...p, firstTask: text }))}
          scrollEnabled={false}
          style={styles.bare}
        />
      </GroupedList>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // A one-line field's input in a grouped field row.
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  // Inside a grouped list: the list is its surface.
  bare: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
});
