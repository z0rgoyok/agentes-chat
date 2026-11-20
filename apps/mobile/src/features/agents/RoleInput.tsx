import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput } from "react-native";
import { fieldText, GROUPED_ROW, GroupedHeader, GroupedList } from "@/ui";
import { NEXT_FIELD } from "../settings/parts";
import { useColors } from "../shared/hooks";

/**
 * An agent's role as Criar agente and Editar ask it, up to the API's 200 characters: a field of a grouped list, its
 * label the group's header. `next`: its return key goes on to the form's next field instead of closing the keyboard.
 */
export function RoleInput({
  value,
  onChangeText,
  placeholder,
  next = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  next?: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  return (
    <>
      <GroupedHeader>{t("agent.roleLabel")}</GroupedHeader>
      <GroupedList>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          maxLength={200}
          {...(next ? NEXT_FIELD : {})}
          placeholder={placeholder}
          placeholderTextColor={c.faint}
          accessibilityLabel={t("agent.roleLabel")}
          style={[styles.row, fieldText("body"), { color: c.ink }]}
        />
      </GroupedList>
    </>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: GROUPED_ROW.minHeight, paddingHorizontal: GROUPED_ROW.padX, paddingVertical: GROUPED_ROW.tallPadY },
});
