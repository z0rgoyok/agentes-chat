import type { FoundKey } from "@agenteschat/client/lib/api-key-text";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button } from "@/ui";
import { SheetTitle } from "../shared/PromptForm";
import { type KeyGuardChoice, keyGuardChoices, keyGuardTitle } from "./key-guard";

const LABEL: Record<KeyGuardChoice, string> = {
  vault: "keyGuard.vault",
  ai: "keyGuard.useAsAi",
  remove: "keyGuard.remove",
  send: "keyGuard.send",
};

/**
 * "Isso parece uma chave de API", the web's `KeyGuardDialog` as a sheet: nothing was sent, and nothing goes until the
 * person picks.
 */
export function KeyGuardSheet({
  found,
  managesKeys,
  onPick,
}: {
  found: FoundKey;
  managesKeys: boolean;
  onPick: (choice: KeyGuardChoice) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SheetTitle title={t(keyGuardTitle(found))} subtitle={t("keyGuard.vaultText")} />
      <View style={styles.acts}>
        {keyGuardChoices(found, managesKeys).map((choice) => (
          <Button
            key={choice}
            variant={choice === "vault" ? "primary" : choice === "send" ? "ghost" : "secondary"}
            wide
            label={t(LABEL[choice])}
            onPress={() => onPick(choice)}
          />
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  acts: { gap: 8 },
});
