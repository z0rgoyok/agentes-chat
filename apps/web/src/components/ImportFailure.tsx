import { useCatalog } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { hiddenRepoOf } from "@agenteschat/client/lib/skills";
import { Alert, Button } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { failedOffline } from "@/chat/offline";
import { ConnectFlow, type FlowState } from "@/components/ConnectFlow";
import { ConnectorIcon } from "@/components/ConnectorIcon";
import { useOrgIfAny } from "@/components/org-context";
import { type ImportFailure, importFailureText, retryable } from "@/lib/import-flow";

const GITHUB_MARK = { iconUrl: "/connectors/github.svg", brandColor: null };

/**
 * Why reading or planning an import failed, with "Tentar de novo" when trying again may work. A link into a private
 * repository none of the workspace's GitHub reads offers "Conectar o GitHub" to who may connect it, as Instalar skill
 * does, and reads the link again once connected here; signing in on GitHub's site comes back to this page.
 */
export function ImportFailureNote({ failure, retry }: { failure: ImportFailure; retry: () => unknown }) {
  const { t, i18n } = useTranslation();
  const org = useOrgIfAny()?.org;
  const catalog = useCatalog();
  const [flow, setFlow] = useState<FlowState | null>(null);
  const github = catalog.data?.connectors.find((c) => c.id === "github");
  const hidden = hiddenRepoOf(failure.cause);
  const mayConnect = Boolean(org && github && can(org, "manage_connectors"));
  return (
    <div className="imp-failure">
      <Alert tone={hidden ? "neutral" : undefined}>
        {importFailureText(t, failure, failedOffline, mayConnect, i18n.language)}
      </Alert>
      {hidden && mayConnect && hidden.connection !== "ok" && github && (
        <Button size="sm" variant="primary" onClick={() => setFlow({ step: 0, def: github })}>
          <ConnectorIcon def={GITHUB_MARK} label="GitHub" />
          {t("skills.hidden.connectButton")}
        </Button>
      )}
      {retryable(failure) && (
        <Button size="sm" icon="refresh" onClick={() => void retry()}>
          {t("common.retry")}
        </Button>
      )}
      {org && (
        <ConnectFlow
          flow={flow}
          returnTo={`${window.location.pathname}${window.location.search}`}
          onChange={(next) => {
            // Connected without leaving the page (a token): the link again, behind the steps that follow.
            if (flow?.step === 0) void retry();
            setFlow(next);
          }}
          onClose={() => setFlow(null)}
        />
      )}
    </div>
  );
}
