import { useOwnOAuthClient } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { Button, fieldText, InfoHint, Locked, Text, useToast } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { copyText, errorHaptic } from "../shared/parts";
import { Problem } from "./Problem";

/**
 * The workspace's own OAuth app for a server that lets in only apps it approved (who manages connectors), as on the
 * web: the redirect URI to register there with Copiar, its client ID, secret and scopes. "Salvar e continuar" saves it
 * and goes on to the sign-in.
 */
export function OwnClient({
  serverUrl,
  guide,
  busy,
  onSaved,
}: {
  serverUrl: string;
  /** The vendor's own steps, when we know them. */
  guide: string | null;
  busy: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const own = useOwnOAuthClient(useOrgId(), serverUrl, true);
  const saved = own.current.data?.client ?? null;
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [scopes, setScopes] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    setClientId(saved.clientId);
    setScopes(saved.scopes ?? "");
  }, [saved]);
  if (own.current.error) {
    return <Problem text={knownErrorText(t, own.current.error) ?? t("mobile.connectors.failed")} />;
  }
  const redirectUri = own.current.data?.redirectUri ?? "";
  const field = [styles.field, { backgroundColor: c.raised, color: c.ink, borderColor: c.line }];
  const save = () => {
    setError(null);
    if (clientId.trim() === "") return setError(t("connectFlow.ownClient.clientIdMissing"));
    own.save.mutate(
      { clientId: clientId.trim(), ...(secret.trim() ? { clientSecret: secret.trim() } : {}), scopes: scopes.trim() },
      {
        onSuccess: () => {
          setSecret("");
          onSaved();
        },
        onError: (e) => {
          errorHaptic();
          setError(knownErrorText(t, e) ?? t("mobile.connectors.failed"));
        },
      },
    );
  };
  const label = (text: string, hint?: string) =>
    hint ? (
      <InfoHint name={t("common.about", { label: text })} text={hint} variant="footnote">
        <Text variant="footnote" tone="faint">
          {text}
        </Text>
      </InfoHint>
    ) : (
      <Text variant="footnote" tone="faint">
        {text}
      </Text>
    );
  return (
    <Locked when={busy || own.current.isPending || own.save.isPending} style={styles.body}>
      <Text variant="small" tone="muted">
        {guide ?? t("connectFlow.ownClient.help")}
      </Text>
      <View style={styles.box}>
        {label(t("connectFlow.ownClient.redirectUri"))}
        <View style={styles.row}>
          <Text variant="footnote" selectable style={styles.grow}>
            {redirectUri}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            label={t("common.copy")}
            disabled={!redirectUri}
            onPress={() =>
              void copyText(redirectUri).then((ok) => ok && toast({ title: t("connectFlow.ownClient.copied") }))
            }
          />
        </View>
      </View>
      <View style={styles.box}>
        {label(t("connectFlow.ownClient.clientId"))}
        <TextInput
          value={clientId}
          onChangeText={setClientId}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("connectFlow.ownClient.clientId")}
          style={field}
        />
      </View>
      <View style={styles.box}>
        {label(t("connectFlow.ownClient.clientSecret"), t("connectFlow.ownClient.clientSecretHelp"))}
        <TextInput
          value={secret}
          onChangeText={setSecret}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("connectFlow.ownClient.clientSecret")}
          style={field}
        />
        {saved?.hasSecret && saved.clientId === clientId.trim() ? (
          <Text variant="footnote" tone="faint">
            {t("connectFlow.ownClient.secretSaved")}
          </Text>
        ) : null}
      </View>
      <View style={styles.box}>
        {label(t("connectFlow.ownClient.scopes"), t("connectFlow.ownClient.scopesHelp"))}
        <TextInput
          value={scopes}
          onChangeText={setScopes}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("connectFlow.ownClient.scopes")}
          style={field}
        />
      </View>
      <Button
        variant="primary"
        wide
        label={t("connectFlow.ownClient.save")}
        loading={own.save.isPending}
        onPress={save}
      />
      {error ? <Problem key={error} text={error} /> : null}
    </Locked>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14 },
  box: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  field: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    ...fieldText("body"),
  },
});
