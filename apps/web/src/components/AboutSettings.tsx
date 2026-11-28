import { instanceQuery } from "@agenteschat/client";
import { LICENSE_URL, PUBLIC_SOURCE_URL } from "@agenteschat/client/lib/about";
import { dockerUpgrade, nativeUpgrade, type ServerRelease } from "@agenteschat/client/lib/server-release";
import { shownAddress } from "@agenteschat/client/lib/sites";
import { DOCS_SITE } from "@agenteschat/i18n/docs";
import { Card, CardHeader, codeAndBold, Icon } from "@agenteschat/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { LoadingLine } from "@/components/Loading";
import { CommandBlock } from "@/components/machine-bits";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useServerUpdate } from "@/hooks/useServerUpdate";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { useToast } from "@/lib/toast";

/** An outside page in a new tab, in the house link style. */
function Out({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a className="ac-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Configurações › Sobre: AGPL-3.0's Appropriate Legal Notices and the attribution the 7(b) term in NOTICE
 * requires. Shown to everyone on every self-hosted server, with no setting that hides it (`showsAbout`).
 */
export function AboutSection() {
  const { t } = useTranslation();
  const instance = useQuery(instanceQuery(useApi()));
  const source = instance.data?.sourceUrl ?? PUBLIC_SOURCE_URL;
  const server = useServerUpdate();
  return (
    <>
      {server.update && <UpdateCard release={server.update} />}
      <Card aria-labelledby="about-made">
        <CardHeader
          id="about-made"
          icon="info"
          title={
            // One inline run: the heading lays its children out with a gap, which would part the link from its words.
            <span>
              <Trans i18nKey="settings.about.basedOn" components={{ site: <Out href={DOCS_SITE} /> }} />
            </span>
          }
          subtitle={<Trans i18nKey="settings.about.license" components={{ license: <Out href={LICENSE_URL} /> }} />}
        />
        <div className="settings-rows">
          <PrefRow
            id="about-version"
            icon="download"
            label={t("settings.about.version")}
            status={
              server.update ? (
                <Out href={server.update.url}>{t("settings.about.newer", { version: server.update.version })}</Out>
              ) : server.latest && server.version ? (
                t("settings.about.latest")
              ) : undefined
            }
            control={
              instance.data ? <span className="ac-num">{instance.data.version}</span> : <LoadingLine width={80} />
            }
          />
          <PrefRow
            id="about-source"
            icon="code"
            label={t("settings.about.source")}
            control={
              <Out href={source}>
                <span className="ac-iconline">
                  {shownAddress(source)}
                  <Icon name="external" size={14} />
                </span>
              </Out>
            }
          />
          {server.ahead > 0 && (
            <PrefRow
              id="about-computers"
              icon="computer"
              label={t("settings.about.computers")}
              status={t("settings.about.computersAhead", { count: server.ahead })}
            />
          )}
        </div>
        <p className="ac-card__foot">{t("settings.about.copyright")}</p>
      </Card>
    </>
  );
}

/** The newer release, for who configures the workspace: SELF_HOSTING.md's upgrade with Docker and without. */
function UpdateCard({ release }: { release: ServerRelease }) {
  const { t } = useTranslation();
  return (
    <Card aria-labelledby="about-update">
      <CardHeader
        id="about-update"
        icon="download"
        title={t("settings.about.update.title", { version: release.version })}
        subtitle={<Out href={release.url}>{t("settings.about.notes")}</Out>}
      />
      <div className="about-update">
        <div className="about-update__way">
          <h3 className="about-update__name">{t("settings.about.update.docker")}</h3>
          <CommandBlock command={dockerUpgrade(release.version)} />
        </div>
        <div className="about-update__way">
          <h3 className="about-update__name">{t("settings.about.update.native")}</h3>
          <p className="about-update__help">{codeAndBold(t("settings.about.update.nativeHelp"))}</p>
          <CommandBlock command={nativeUpgrade(release.version)} />
        </div>
      </div>
      <p className="ac-card__foot">{t("settings.about.update.desktop")}</p>
    </Card>
  );
}

/**
 * The quiet notice of a newer server release: one toast per release in this browser, for who configures the
 * workspace, with the way to Settings › About.
 */
export function ServerUpdateNotice() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const version = useServerUpdate().update?.version;
  useEffect(() => {
    if (!version || storage.get(STORAGE_KEYS.serverUpdateSeen) === version) return;
    storage.set(STORAGE_KEYS.serverUpdateSeen, version);
    toast.show(t("settings.about.update.notice", { version }), "info", {
      label: t("settings.about.update.how"),
      run: () => void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "about" } }),
    });
  }, [version, toast, t, navigate, org.id]);
  return null;
}
