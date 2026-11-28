import { instanceQuery, useApi } from "@agenteschat/client";
import { LICENSE_URL, PUBLIC_SOURCE_URL } from "@agenteschat/client/lib/about";
import { can } from "@agenteschat/client/lib/permissions";
import { serverReleaseQuery, serverUpdate } from "@agenteschat/client/lib/server-release";
import { shownAddress } from "@agenteschat/client/lib/sites";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { useQuery } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrgMaybe } from "@/providers/org";
import { GroupedFooter, GroupedList, GroupedRow, Text } from "@/ui";
import { openPage } from "../ai/parts";
import { Page } from "./parts";

const link = (href: string) => (
  <Text variant="footnote" accessibilityRole="link" style={styles.link} onPress={() => openPage(href)} />
);

/**
 * Sobre o agentes.chat, pushed from Você: AGPL-3.0's Appropriate Legal Notices and the attribution the license's
 * section 7(b) term in NOTICE requires. Shown on every self-hosted server, with no setting that hides it (`showsAbout`).
 */
export function AboutPage() {
  const { t } = useTranslation();
  const api = useApi();
  const instance = useQuery(instanceQuery(api));
  const source = instance.data?.sourceUrl ?? PUBLIC_SOURCE_URL;
  // A newer release, for who configures the workspace (the web's Settings › About has the commands): the phone asks
  // GitHub, never the server.
  const admin = can(useOrgMaybe()?.org, "configure");
  const release = useQuery({ ...serverReleaseQuery(api), enabled: admin });
  const update = admin ? serverUpdate(instance.data?.version, release.data) : null;
  return (
    <Page title={t("settings.section.about")}>
      <View style={styles.gap} />
      <GroupedList>
        <GroupedRow
          label={t("settings.about.version")}
          value={instance.data?.version ?? "…"}
          {...(update
            ? {
                sub: t("settings.about.newer", { version: update.version }),
                subTone: "amber" as const,
                onPress: () => openPage(update.url),
              }
            : {})}
        />
        <GroupedRow
          label={t("settings.about.source")}
          value={shownAddress(source)}
          chevron
          onPress={() => openPage(source)}
        />
      </GroupedList>
      <GroupedFooter>
        <Trans i18nKey="settings.about.basedOn" components={{ site: link(DOCS_SITE) }} />
        {"\n\n"}
        <Trans i18nKey="settings.about.license" components={{ license: link(LICENSE_URL) }} />
        {"\n\n"}
        {t("settings.about.copyright")}
      </GroupedFooter>
    </Page>
  );
}

const styles = StyleSheet.create({
  gap: { height: 14 },
  link: { textDecorationLine: "underline" },
});
