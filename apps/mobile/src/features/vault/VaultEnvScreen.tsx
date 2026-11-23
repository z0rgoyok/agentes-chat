import { useImportVaultKeys, useVault, type VaultAccess, type VaultScope } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { plainInline } from "@agenteschat/client/lib/markdown";
import {
  ENV_MAX_BYTES,
  ENV_MAX_KEYS,
  type EnvReviewRow,
  envImportInput,
  envReview,
  parseEnvFile,
  savedKeyNames,
} from "@agenteschat/client/lib/vault";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { Note } from "../ai/parts";
import { Gap, SettingsPage, useUnsavedGuard } from "../settings/parts";
import { useOrgId } from "../shared/hooks";
import { MONO, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { closeEnvDraft, type EnvDraft, envDraftNow, openEnvDraft } from "./env-draft";
import { defaultAccess, vaultHref } from "./logic";
import { AgentRows, ScopeRows } from "./parts";

const DOTS = "••••••••••";

/**
 * "Import .env" (ADR 0144 §11), the web's dialog as two pushed screens: here a .env file (or a JSON object of names
 * and values) picked or pasted and read on the phone; Review pushes its keys' review (`VaultEnvReviewScreen`), and the
 * system's back from there comes back to this paste as it was. The file's text and its values live in these screens
 * only.
 */
export function VaultEnvScreen({ scope: asked }: { scope: VaultScope }) {
  const { t } = useTranslation();
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Back with keys pasted and not saved asks first: they may exist nowhere else on the phone.
  const leave = useUnsavedGuard(pasted.trim() !== "");

  const review = (text: string) => {
    if (text.length > ENV_MAX_BYTES) return setError(t("vault.env.tooLarge"));
    const parsed = parseEnvFile(text);
    if (parsed.entries.length === 0) return setError(t("vault.env.none"));
    if (parsed.entries.length > ENV_MAX_KEYS) return setError(t("vault.env.tooMany", { max: ENV_MAX_KEYS }));
    setError(null);
    openEnvDraft({ file: parsed, scope: asked, leave });
    router.push(vaultHref.envReview as never);
  };
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const picked = res.canceled ? null : res.assets[0];
    if (!picked) return;
    if ((picked.size ?? 0) > ENV_MAX_BYTES) return setError(t("vault.env.tooLarge"));
    try {
      review(await new File(picked.uri).text());
    } catch {
      setError(t("vault.import.unreadable"));
    }
  };

  return (
    <SettingsPage
      title={t("vault.env.title")}
      action={{ label: t("vault.env.review"), onPress: () => review(pasted), disabled: pasted.trim() === "" }}
    >
      <GroupedFooter>{t("vault.env.text")}</GroupedFooter>
      <Gap />
      <GroupedList>
        <GroupedRow icon="file" label={t("vault.import.choose")} chevron onPress={() => void pick()} />
      </GroupedList>
      <GroupedHeader>{t("vault.env.paste")}</GroupedHeader>
      <TextArea
        value={pasted}
        onChangeText={(text) => {
          setPasted(text);
          setError(null);
        }}
        minHeight={120}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        placeholder={"ACME_API_KEY="}
        accessibilityLabel={t("vault.env.paste")}
        style={styles.mono}
      />
      {error ? (
        <View style={styles.note}>
          <Note icon="x">{error}</Note>
        </View>
      ) : null}
    </SettingsPage>
  );
}

/**
 * The second step of "Import .env": the file's keys one by one (a tap shows a value, another hides it; what can't be
 * imported says why), which saved ones to replace, Personal or Team, and the agents that may use them, then all saved
 * in one request. Saved, the whole flow closes back to the Vault. Opened without a draft (a link), it starts over.
 */
export function VaultEnvReviewScreen() {
  // Taken once as the screen opens, dropped as it closes.
  const [draft] = useState(envDraftNow);
  useEffect(() => () => closeEnvDraft(draft), [draft]);
  if (!draft) return <Redirect href={vaultHref.env("personal") as never} />;
  return <EnvReview draft={draft} />;
}

function EnvReview({ draft }: { draft: EnvDraft }) {
  const { t, i18n } = useTranslation();
  const orgId = useOrgId();
  const toast = useToast();
  const vault = useVault(orgId);
  const save = useImportVaultKeys(orgId);
  const canTeam = vault.data?.canManageTeam ?? false;
  const [chosen, setChosen] = useState<VaultScope>(draft.scope);
  const scope: VaultScope = chosen === "team" && canTeam ? "team" : "personal";
  const [touched, setTouched] = useState<VaultAccess | null>(null);
  const access = touched ?? defaultAccess(scope);
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const flip = (set: ReadonlySet<string>, name: string) => {
    const next = new Set(set);
    if (!next.delete(name)) next.add(name);
    return next;
  };
  const pickScope = (next: VaultScope) => {
    setChosen(next);
    // Each scope's own starting access, and its own saved names.
    setTouched(null);
    setReplace(new Set());
  };

  const rows = envReview(draft.file, savedKeyNames(vault.data?.items ?? [], scope));
  const input = envImportInput(rows, replace, scope, access);
  const total = input.keys.length;
  const send = () => {
    if (total === 0) return;
    save.mutate(input, {
      onSuccess: () => {
        successHaptic();
        toast({ title: t("mobile.vault.savedToVault"), icon: "lock" });
        // Saved: the paste on the step before is let go without asking, and the flow closes back to the Vault.
        draft.leave();
        router.dismissTo(vaultHref.list as never);
      },
      onError: (err) => toast({ title: errorText(t, err, i18n.language), icon: "x" }),
    });
  };
  const stateOf = (row: EnvReviewRow) =>
    row.state === "problem"
      ? plainInline(t(`vault.env.problem.${row.problem}`))
      : row.state === "exists"
        ? t("vault.env.exists")
        : t("vault.env.new");
  const saved = rows.filter((row) => row.state === "exists");

  return (
    <SettingsPage
      title={t("vault.env.title")}
      action={{
        label: t("vault.import.confirm", { count: total }),
        onPress: send,
        disabled: total === 0 || save.isPending,
      }}
      locked={save.isPending}
    >
      <GroupedHeader>{t("vault.kindPlural.keyTitle")}</GroupedHeader>
      <GroupedList>
        {rows.map((row) => (
          <GroupedRow
            key={row.name}
            icon="key"
            label={row.name}
            labelLines={3}
            value={stateOf(row)}
            faint={row.state === "problem"}
            media
            // A tap shows one key's value, another hides it. What can't be imported shows nothing.
            {...(row.state === "problem"
              ? {}
              : {
                  sub: shown.has(row.name) ? row.value : DOTS,
                  subLines: 40,
                  onPress: () => setShown((s) => flip(s, row.name)),
                })}
          />
        ))}
      </GroupedList>
      {draft.file.duplicates.length > 0 ? (
        <GroupedFooter>{t("vault.env.duplicates", { names: draft.file.duplicates.join(", ") })}</GroupedFooter>
      ) : null}

      {saved.length > 0 ? (
        <>
          <GroupedHeader>{t("vault.env.replace")}</GroupedHeader>
          <GroupedList>
            {saved.map((row) => (
              <GroupedRow
                key={row.name}
                label={row.name}
                labelLines={3}
                toggle={replace.has(row.name)}
                disabled={save.isPending}
                onPress={() => setReplace((r) => flip(r, row.name))}
              />
            ))}
          </GroupedList>
        </>
      ) : null}

      {canTeam ? (
        <ScopeRows scope={scope} onChange={pickScope} canTeam />
      ) : (
        <GroupedFooter>{t("vault.import.asPersonal")}</GroupedFooter>
      )}
      {scope === "team" ? <GroupedFooter>{t("mobile.vault.teamAudience")}</GroupedFooter> : null}
      <AgentRows scope={scope} access={access} onChange={setTouched} disabled={save.isPending} />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 4, paddingTop: 10 },
  mono: { fontFamily: MONO, fontSize: 14 },
});
