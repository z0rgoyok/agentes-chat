import {
  useConnectVault,
  useUpdateVaultConnection,
  useVault,
  type VaultConnectField,
  type VaultConnection,
  type VaultScope,
  type VaultSourceInfo,
} from "@agenteschat/client";
import { vaultConnectRefusal } from "@agenteschat/client/lib/errors";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import {
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { Note, openPage } from "../ai/parts";
import { NEXT_FIELD, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { useOrgId } from "../shared/hooks";
import { pickOne } from "../shared/PickerSheet";
import { goBack, successHaptic, Tile } from "../shared/parts";
import {
  accessSentence,
  connectInput,
  connectMissing,
  fieldKeyboard,
  initialValues,
  shownFields,
  vaultHref,
} from "./logic";
import { InputField, ScopeRows, useVaultNames } from "./parts";

/**
 * Connecting a password manager (ADR 0144 §3), drawn from what the source describes: a warning when it has one
 * (Bitwarden's master password opens the whole account), its numbered steps, its fields, personal or the team's,
 * then Connect, which checks with the password manager before anything is kept; connected, the connection's own page
 * takes this one's place (who uses it and how to change that are there). With `connection`, the same fields replace a
 * connection's sign-in details (Reconnect).
 */
export function VaultConnectScreen({ kind, connectionId }: { kind: string; connectionId?: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const vault = useVault(orgId);
  const source = vault.data?.sources.find((s) => s.kind === kind);
  const connection = connectionId ? vault.data?.connections.find((x) => x.id === connectionId) : undefined;
  if (!source || (connectionId && !connection)) {
    return (
      <SettingsPage title={t("settings.section.vault")}>
        {vault.isError ? (
          <LoadFailed onRetry={() => void vault.refetch()} />
        ) : vault.isSuccess ? (
          <View style={styles.note}>
            <Note icon="x">{t("mobile.vault.connect.unknown")}</Note>
          </View>
        ) : (
          <SkeletonList rows={4} />
        )}
      </SettingsPage>
    );
  }
  return (
    <ConnectForm
      key={source.kind}
      source={source}
      canTeam={vault.data?.canManageTeam ?? false}
      {...(connection ? { connection } : {})}
    />
  );
}

function ConnectForm({
  source,
  canTeam,
  connection,
}: {
  source: VaultSourceInfo;
  canTeam: boolean;
  connection?: VaultConnection;
}) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const connect = useConnectVault(orgId);
  const update = useUpdateVaultConnection(orgId);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(source));
  const [chosen, setChosen] = useState<VaultScope>(canTeam ? "team" : "personal");
  const [refusal, setRefusal] = useState<string | null>(null);
  const names = useVaultNames();
  const scope: VaultScope = chosen === "team" && canTeam ? "team" : "personal";
  const missing = connectMissing(source, values);
  const busy = connect.isPending || update.isPending;
  const fields = shownFields(source, values);
  const lastTyped = fields.filter((f) => f.kind !== "choice").at(-1)?.id;
  const k = source.kind;
  // A source's words: their translation when the app has one, the source's own English otherwise (a module's).
  const say = (path: string, fallback: string): string => t(`vault.source.${k}.${path}`, { defaultValue: fallback });
  const set = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setRefusal(null);
  };
  // The password manager's refusal in plain words (wrong details, a vault too many), from the server's code.
  const failed = (err: unknown) => setRefusal(vaultConnectRefusal(t, k, err, i18n.language));

  const submit = () => {
    if (missing.length > 0 || busy) return;
    const input = connectInput(source, values);
    if (connection) {
      update.mutate(
        { connectionId: connection.id, input },
        {
          onSuccess: () => {
            successHaptic();
            toast({ title: t("mobile.vault.connect.reconnected", { name: source.name }) });
            goBack();
          },
          onError: failed,
        },
      );
      return;
    }
    connect.mutate(
      { kind: k, scope, input },
      {
        // Connected: its page in this one's place, never a "done" step drawn here; the toast says who can use it.
        onSuccess: (connected) => {
          successHaptic();
          toast({
            title: t("mobile.vault.connect.connected", { name: source.name }),
            subtitle: accessSentence(t, connected.scope, connected.access, names),
            icon: "check",
          });
          router.replace(vaultHref.connection(connected.id) as never);
        },
        onError: failed,
      },
    );
  };

  // A field with set values (a region, a kind) in the app's picker, the one chosen checked.
  const chooseValue = (f: VaultConnectField) =>
    void pickOne({
      title: say(`field.${f.id}`, f.label),
      value: values[f.id] ?? null,
      options: (f.choices ?? []).map((choice) => ({
        key: choice.value,
        label: say(`choice.${f.id}.${choice.value}`, choice.label),
      })),
    }).then((key) => {
      if (key !== null) set(f.id, key);
    });

  return (
    <SettingsPage
      title={
        connection
          ? t("mobile.vault.connect.reconnectTitle", { name: source.name })
          : t("mobile.vault.connect.title", { name: source.name })
      }
      action={{
        label: connection ? t("common.save") : t("mobile.vault.connect.action"),
        onPress: submit,
        disabled: missing.length > 0 || busy,
      }}
      locked={busy}
      toolbar
    >
      <GroupedFooter>{t("mobile.vault.connect.text", { name: source.name })}</GroupedFooter>
      {source.warning ? (
        <View style={styles.note}>
          <Note icon="shield">{say("warning", source.warning)}</Note>
        </View>
      ) : null}

      <GroupedHeader>{t("mobile.vault.connect.steps")}</GroupedHeader>
      <GroupedList>
        {source.steps.map((step, i) => (
          <GroupedRow
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are in order and never move
            key={i}
            leading={
              <Tile size={28}>
                <Text variant="footnote" tone="ink2" style={styles.number}>
                  {String(i + 1)}
                </Text>
              </Tile>
            }
            label={say(`step.${i + 1}`, step)}
            labelLines={4}
          />
        ))}
        {source.helpUrl ? (
          <GroupedRow
            icon="out"
            label={t("mobile.vault.connect.guide", { name: source.name })}
            onPress={() => openPage(source.helpUrl ?? "")}
          />
        ) : null}
      </GroupedList>

      <GroupedHeader>{t("mobile.vault.connect.fields")}</GroupedHeader>
      <GroupedList>
        {fields.map((f) => {
          const label = say(`field.${f.id}`, f.label);
          if (f.kind === "choice") {
            const value = values[f.id] ?? "";
            const choice = f.choices?.find((x) => x.value === value);
            return (
              <GroupedField key={f.id} label={label} onPress={() => chooseValue(f)}>
                <Text variant="callout" numberOfLines={1}>
                  {choice ? say(`choice.${f.id}.${choice.value}`, choice.label) : ""}
                </Text>
              </GroupedField>
            );
          }
          const keyboard = fieldKeyboard(f);
          return (
            // Return walks the typed fields (a choice in between is skipped); the last one closes the keyboard.
            <InputField
              key={f.id}
              label={label}
              value={values[f.id] ?? ""}
              onChange={(v) => set(f.id, v)}
              keyboardType={keyboard.keyboardType}
              secureTextEntry={keyboard.secure}
              autoCapitalize="none"
              textContentType="none"
              autoComplete="off"
              {...(f.placeholder ? { placeholder: say(`placeholder.${f.id}`, f.placeholder) } : {})}
              {...(f.id === lastTyped ? { returnKeyType: "done" as const } : NEXT_FIELD)}
            />
          );
        })}
      </GroupedList>
      {refusal ? (
        <View style={styles.note}>
          <Note icon="x" live>
            {refusal}
          </Note>
        </View>
      ) : (
        <GroupedFooter>{t("mobile.vault.connect.private")}</GroupedFooter>
      )}

      {connection ? null : (
        <>
          <ScopeRows scope={scope} onChange={setChosen} canTeam={canTeam} />
          <GroupedFooter>
            {scope === "team" ? t("mobile.vault.connect.teamHelp") : t("mobile.vault.connect.personalHelp")}
          </GroupedFooter>
        </>
      )}
      {busy ? (
        <View style={styles.note}>
          <Note icon="clock" live>
            {t("mobile.vault.connect.checking", { name: source.name })}
          </Note>
        </View>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  number: { fontWeight: "600" },
});
