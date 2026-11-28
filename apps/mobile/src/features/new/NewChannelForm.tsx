import { keys, useApi, useChannels } from "@agenteschat/client";
import { takesGroupNames } from "@agenteschat/client/lib/group-conversations";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import { Button, fieldText, GROUPED_ROW, GroupedFooter, GroupedList, Icon, Locked, SheetScreen } from "@/ui";
import { chatHref } from "../links/logic";
import { useColors, useErrorToast, useOrgId } from "../shared/hooks";
import { closeSheetsAndOpen, SheetHeader } from "./parts";

/**
 * "New channel": only the name; people and agents are called in later, by name. A personal workspace's channels are
 * its group conversations (ADR 0159). The sheet comes up with the keyboard down (the person taps the name), and a
 * channel that couldn't be made says why. A group conversation takes its name as written ("Viagem pra Lisboa", ADR
 * 0159, amendment of 2026-11-26) where the server keeps it so: no #, the keyboard's capitals and corrections on. An
 * older server lowers the name and refuses spaces, so the field stays a channel's there.
 */
export function NewChannelForm() {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const { org } = useOrg();
  const title = isPersonal(org) ? t("shell.sidebarMenu.newChannelPersonal") : t("mobile.chats.newChannel");
  const qc = useQueryClient();
  const failed = useErrorToast();
  const c = useColors();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const channels = useChannels(orgId).data;
  const grouped = isPersonal(org) && takesGroupNames(channels);
  const clean = grouped
    ? name
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^#+\s*/, "")
    : name.trim().replace(/^#/, "");
  const submit = () => {
    if (!clean || busy) return;
    setBusy(true);
    api.chat
      .createChannel(orgId, { name: clean })
      .then((ch) => {
        void qc.invalidateQueries({ queryKey: keys.channels(orgId) });
        closeSheetsAndOpen(chatHref(ch.id));
      })
      .catch(failed)
      .finally(() => setBusy(false));
  };
  return (
    <SheetScreen>
      <SheetHeader title={title} />
      {/* The name in a group of its own, on the grouped rows' ruler, the fine print under it as every group's. */}
      <Locked when={busy}>
        <GroupedList>
          <View style={styles.field}>
            <Icon name={grouped ? "members" : "hash"} size={20} color={c.faint} />
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={t(modeKey(org, "mobile.chats.channelPlaceholder"))}
              placeholderTextColor={c.faint}
              accessibilityLabel={title}
              autoCapitalize={grouped ? "sentences" : "none"}
              autoCorrect={grouped}
              maxLength={grouped ? 80 : undefined}
              returnKeyType="done"
              onSubmitEditing={submit}
              style={[styles.input, { color: c.ink }]}
            />
          </View>
        </GroupedList>
        <GroupedFooter>{t(modeKey(org, "mobile.new.channelFine"))}</GroupedFooter>
      </Locked>
      <Button
        variant="primary"
        wide
        label={t(modeKey(org, "mobile.chats.createChannel"))}
        loading={busy}
        disabled={!clean}
        onPress={submit}
      />
    </SheetScreen>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  input: { flex: 1, paddingVertical: 12, ...fieldText("body") },
});
