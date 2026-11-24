import type { GitHubAppInstallation } from "@agenteschat/client";
import {
  useConnections,
  useGitHubApp,
  useInstallGitHubApp,
  useRemoveGitHubApp,
  useRemoveGitHubAppSettings,
  useStartGitHubAppManifest,
} from "@agenteschat/client";
import { GITHUB_APP_AUTH } from "@agenteschat/client/lib/connected";
import {
  githubAppPanel,
  installationReach,
  removedText,
  removeInstallationText,
} from "@agenteschat/client/lib/github-app";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Chip, Dialog, DialogFooter, Icon, InfoHint, List } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { navigateAway } from "@/lib/navigate";
import { useToast } from "@/lib/toast";

/** Where GitHub sends the person back: the install's and the manifest's returns land on Conectores. */
const connectorsPath = (orgId: string) => `/org/${orgId}/settings/connectors`;

/**
 * Settings → Conectores: the GitHub accounts where the organization installed the agentes.chat app (ADR 0033, 0156).
 * Where it is installed, agents act on GitHub as the app. Each account opens its page on GitHub (Gerenciar no GitHub,
 * where its repositories are picked), and Remover uninstalls it there too. Only installations made from here count
 * for this organization. Hidden when the server has no app and nothing is installed, except for the admins whose
 * server owner can make one.
 */
export function GitHubAppPanel({ onConnectAccount }: { onConnectAccount: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const admin = can(org, "manage_connectors");
  const info = useGitHubApp(org.id);
  const connections = useConnections(org.id);
  const install = useInstallGitHubApp(org.id);
  const [removing, setRemoving] = useState<GitHubAppInstallation | null>(null);
  const github = connections.data?.find((c) => c.connector === "github" && !c.revokedAt);
  const panel = githubAppPanel(info.data, admin, github);
  if (!panel) return null;
  const alone = github?.authType === GITHUB_APP_AUTH && panel.installations.length === 1;
  return (
    <section className="gh-app" aria-labelledby="sec-github-app">
      <div className="gh-app__head">
        <div className="ac-hintline">
          <h3 id="sec-github-app" className="ac-card__title">
            {t("githubApp.title")}
          </h3>
          <InfoHint name={t("common.about", { label: t("githubApp.title") })}>
            {t("githubApp.text", { org: org.name })}
          </InfoHint>
        </div>
        {panel.install && (
          <Button
            size="sm"
            icon="plus"
            loading={install.isPending}
            disabled={install.isPending}
            onClick={() => install.mutate(connectorsPath(org.id), { onSuccess: (url) => navigateAway(url) })}
          >
            {t(panel.install === "first" ? "githubApp.install" : "githubApp.installMore")}
          </Button>
        )}
      </div>
      {panel.installations.length > 0 ? (
        <List aria-label={t("githubApp.title")}>
          {panel.installations.map((i) => (
            <div key={i.id} className="ac-list__row">
              <span className="list-col">
                <span className="list-title">
                  <span>{i.accountLogin}</span>
                  <Chip icon={i.suspended ? "waiting" : "check"} tone={i.suspended ? "waiting" : "done"}>
                    {installationReach(t, i)}
                  </Chip>
                </span>
              </span>
              {admin && (
                <span className="ac-acts">
                  {i.manageUrl && (
                    <Button asChild size="sm">
                      <a
                        href={i.manageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={t("githubApp.manageName", { account: i.accountLogin })}
                      >
                        <Icon name="external" size={14} />
                        {t("githubApp.manage")}
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="link"
                    aria-label={t("githubApp.removeName", { account: i.accountLogin })}
                    onClick={() => setRemoving(i)}
                  >
                    {t("githubApp.remove")}
                  </Button>
                </span>
              )}
            </div>
          ))}
        </List>
      ) : (
        <p className="small muted">
          {panel.ownerHint
            ? t("githubApp.ownerHint")
            : panel.usingAccount
              ? t("githubApp.usingAccount", { account: panel.usingAccount })
              : t("githubApp.none")}
        </p>
      )}
      {panel.connectAccount && (
        <span className="ac-acts">
          <Button size="sm" variant="ghost" icon="plus" onClick={onConnectAccount}>
            {t("githubApp.connectAccount")}
          </Button>
        </span>
      )}
      <RemoveInstallationDialog installation={removing} alone={alone} onClose={() => setRemoving(null)} />
    </section>
  );
}

/** "Remover o app de acme?": it is uninstalled on GitHub too, and the last one of the app alone takes GitHub away. */
function RemoveInstallationDialog({
  installation,
  alone,
  onClose,
}: {
  installation: GitHubAppInstallation | null;
  alone: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const remove = useRemoveGitHubApp(org.id);
  const account = installation?.accountLogin ?? "";
  return (
    <Dialog
      open={installation !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("githubApp.removeTitle", { account })}
      description={installation ? removeInstallationText(t, account, alone) : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          loading={remove.isPending}
          onClick={() => {
            if (!installation) return;
            const manageUrl = installation.manageUrl;
            remove.mutate(installation.id, {
              onSuccess: ({ uninstalled }) => {
                // GitHub didn't confirm it: the installation's page there is the way out.
                if (uninstalled || !manageUrl) toast.show(removedText(t, account, uninstalled));
                else
                  toast.show(removedText(t, account, false), "warning", {
                    label: t("githubApp.openPage"),
                    run: () => window.open(manageUrl, "_blank", "noopener,noreferrer"),
                  });
                onClose();
              },
            });
          }}
        >
          {t("githubApp.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** Starts creating this server's GitHub app on GitHub (its manifest); GitHub sends the owner back to Conectores. */
export function useCreateServerApp() {
  const { org } = useOrg();
  const start = useStartGitHubAppManifest();
  return {
    pending: start.isPending,
    run: () => start.mutate(connectorsPath(org.id), { onSuccess: (url) => navigateAway(url) }),
  };
}

/** "Remove the app": forgets the GitHub app saved in this server's settings, after asking. */
export function RemoveServerAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const remove = useRemoveGitHubAppSettings();
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("githubApp.server.removeTitle")}
      description={t("githubApp.server.removeText")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="danger"
          disabled={remove.isPending}
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                onClose();
                toast.show(t("githubApp.server.removed"));
              },
            })
          }
        >
          {t("githubApp.server.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
