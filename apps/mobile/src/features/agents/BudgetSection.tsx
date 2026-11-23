import { type Agent, useUpdateAgent } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { readBudget } from "@agenteschat/client/lib/new-agent";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { fieldText, GROUPED_ROW, GroupedFooter, GroupedHeader, GroupedList, Text, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { useColors, useOrgId } from "../shared/hooks";

/**
 * A monthly budget in dollars as a field row of a grouped list: "US$" before what is typed, "/mês" after it, on the
 * list's own surface (Edit agent's Orçamento mensal, a setup step's limit).
 */
export function BudgetField({
  value,
  onChangeText,
  onEndEditing,
  label,
  editable = true,
  placeholder,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onEndEditing?: () => void;
  label: string;
  editable?: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <GroupedList>
      <View style={styles.row}>
        <Text variant="body" tone="muted">
          US$
        </Text>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          {...(onEndEditing ? { onEndEditing } : {})}
          editable={editable}
          keyboardType="decimal-pad"
          {...(placeholder ? { placeholder } : {})}
          placeholderTextColor={c.faint}
          accessibilityLabel={label}
          style={[styles.amount, fieldText("body"), { color: c.ink }]}
        />
        <Text variant="body" tone="muted">
          {t("rightHand.settings.perMonth")}
        </Text>
      </View>
    </GroupedList>
  );
}

/**
 * The web's Orçamento mensal, where a spent budget's "Aumentar orçamento" lands: saved by who manages agents as the
 * field is left, with a toast, a group of the form as every other (its header, the field, the note under it).
 */
export function BudgetSection({ agent }: { agent: Agent }) {
  const { t } = useTranslation();
  const toast = useToast();
  const failed = useFailed();
  const update = useUpdateAgent(useOrgId(), agent.id);
  const [typed, setTyped] = useState(agent.monthlyBudgetUsd == null ? "" : String(agent.monthlyBudgetUsd));
  const save = () => {
    const { amount, invalid } = readBudget(typed);
    if (invalid) return toast({ title: t("agent.budgetInvalid"), icon: "x" });
    // Saved as the field is left, apart from the form's Salvar: the toast says it went.
    if (amount !== (agent.monthlyBudgetUsd ?? null))
      update.mutate(
        { monthlyBudgetUsd: amount },
        { onSuccess: () => toast({ title: t("mobile.agentEdit.saved"), agentId: agent.id }), onError: failed },
      );
  };
  return (
    <>
      <GroupedHeader>{t("rightHand.settings.budget")}</GroupedHeader>
      <BudgetField
        value={typed}
        onChangeText={setTyped}
        onEndEditing={save}
        label={t("rightHand.settings.budget")}
        placeholder={t("rightHand.value.budgetDefault")}
      />
      <GroupedFooter>{t("agent.budgetHelp", { ...agentGrammar(agent.name), ownerNote: "" }).trim()}</GroupedFooter>
    </>
  );
}

const styles = StyleSheet.create({
  // A field row of the list, as Create agent's: its height and sides.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  amount: { flex: 1, paddingVertical: GROUPED_ROW.tallPadY },
});
