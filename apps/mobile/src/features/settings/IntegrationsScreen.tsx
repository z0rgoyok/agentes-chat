import type { IntegrationApp } from "@agenteschat/client";
import { useIntegrationAppActions, useIntegrationApps } from "@agenteschat/client";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { integrationAddresses, integrationFacts, integrationsSettingsUrl } from "@agenteschat/client/lib/integrations";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { serverUrl } from "@/lib/server";
import { useOrg } from "@/providers/org";
import { AppMark, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, SkeletonList, useToast } from "@/ui";
import { openPage } from "../ai/parts";
import { LoadFailed } from "../shared/FirstUse";
import { errorHaptic, Loaded, successHaptic } from "../shared/parts";
import { CommandBlock, chooseAction, confirmAction, Gap, SettingsPage } from "./parts";

/**
 * Configurações › Integrações (ADR 0251), as the web's: where apps call, the apps with their facts, a new token shown
 * once here, revoking and removing from each row's actions. Making an app and picking its channels open the web, where
 * the channel list and the webhook fit.
 */
export function IntegrationsScreen() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const list = useIntegrationApps(orgId);
  const actions = useIntegrationAppActions(orgId);
  const [shown, setShown] = useState<{ name: string; token: string } | null>(null);
  const title = t("settings.section.integrations");
  const addresses = integrationAddresses(serverUrl());
  const onWeb = () => openPage(integrationsSettingsUrl(serverUrl(), orgId));
  if (!list.data) {
    return (
      <SettingsPage title={title}>
        {list.isError ? <LoadFailed onRetry={() => void list.refetch()} /> : <SkeletonList rows={3} />}
      </SettingsPage>
    );
  }
  const failed = (err: unknown) => {
    errorHaptic();
    toast({ title: errorText(t, err), icon: "x" });
  };
  const act = (app: IntegrationApp) =>
    chooseAction(
      app.name,
      [
        { label: t("integrations.edit"), onPress: onWeb },
        {
          label: t("integrations.newToken"),
          onPress: () =>
            confirmAction({
              title: t("integrations.newTokenTitle", { name: app.name }),
              text: t("integrations.newTokenText"),
              action: t("integrations.newToken"),
              cancel: t("common.cancel"),
              destructive: false,
              onConfirm: () =>
                actions.newToken.mutate(app.id, {
                  onSuccess: (out) => {
                    successHaptic();
                    if (out.token) setShown({ name: app.name, token: out.token });
                  },
                  onError: failed,
                }),
            }),
        },
        ...(app.tokenHint
          ? [
              {
                label: t("integrations.revoke"),
                destructive: true,
                onPress: () =>
                  confirmAction({
                    title: t("integrations.revokeTitle", { name: app.name }),
                    text: t("integrations.revokeText"),
                    action: t("integrations.revoke"),
                    cancel: t("common.cancel"),
                    onConfirm: () =>
                      actions.revokeToken.mutate(app.id, {
                        onSuccess: () => {
                          successHaptic();
                          toast({ title: t("integrations.revoked"), icon: "check" });
                        },
                        onError: failed,
                      }),
                  }),
              },
            ]
          : []),
        {
          label: t("integrations.remove"),
          destructive: true,
          onPress: () =>
            confirmAction({
              title: t("integrations.removeTitle", { name: app.name }),
              text: t("integrations.removeText"),
              action: t("integrations.remove"),
              cancel: t("common.cancel"),
              onConfirm: () =>
                actions.remove.mutate(app.id, {
                  onSuccess: () => {
                    successHaptic();
                    toast({ title: t("integrations.removed", { name: app.name }), icon: "check" });
                  },
                  onError: failed,
                }),
            }),
        },
      ],
      t("common.cancel"),
    );
  const apps = list.data;
  return (
    <SettingsPage title={title} frozen={settingsFrozen(org, "connectors")}>
      <Loaded>
        <GroupedFooter>{t("settings.sectionText.integrations")}</GroupedFooter>
        {shown ? (
          <>
            <GroupedHeader>{t("integrations.tokenTitle", { name: shown.name })}</GroupedHeader>
            <CommandBlock command={shown.token} copiedTitle={t("apps.tokens.copied")} />
            <GroupedFooter>{t("apps.tokens.once")}</GroupedFooter>
            <GroupedList>
              <GroupedRow icon="check" label={t("apps.tokens.done")} onPress={() => setShown(null)} />
            </GroupedList>
          </>
        ) : null}
        <GroupedHeader>{t("integrations.api")}</GroupedHeader>
        <CommandBlock command={addresses.api} copiedTitle={t("integrations.apiCopied")} />
        <Gap />
        <CommandBlock command={addresses.mcp} copiedTitle={t("integrations.apiCopied")} />
        <GroupedFooter>{t("integrations.apiHelp")}</GroupedFooter>
        <Gap />
        <GroupedList>
          <GroupedRow icon="plus" label={t("integrations.connect")} chevron onPress={onWeb} />
        </GroupedList>
        {apps.length === 0 ? (
          <GroupedFooter>{t("integrations.empty")}</GroupedFooter>
        ) : (
          <>
            <GroupedHeader>{title}</GroupedHeader>
            <GroupedList>
              {apps.map((app) => (
                <GroupedRow
                  key={app.id}
                  label={app.name}
                  belowText={integrationFacts(t, i18n.language, app)}
                  leading={<AppMark color={app.color} name={app.name} size={28} />}
                  more
                  onPress={() => act(app)}
                />
              ))}
            </GroupedList>
          </>
        )}
      </Loaded>
    </SettingsPage>
  );
}
