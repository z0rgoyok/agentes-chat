import type { Machine } from "@agenteschat/client";
import { useRetryCliFetch } from "@agenteschat/client";
import { cliFetchLine, shownFetch } from "@agenteschat/client/lib/cli-fetch";
import { Button, Meter, SettingNote, Spinner } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import "./cli-fetch.css";

/**
 * A coding CLI its computer fetches by itself (ADR 0228 §6), in the agent's brain settings and its account in Contas
 * de IA: "Preparando o Claude Code no MacBook… 45%" with the kit's meter while it comes, and why it failed with "Tentar
 * de novo", which asks the computer to fetch it again now. Nothing once it is ready.
 */
export function CliFetchLine({ machine, cli }: { machine: Machine; cli: string | undefined }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const retry = useRetryCliFetch(org.id);
  const shown = cli ? shownFetch(machine, cli) : undefined;
  const line = shown ? cliFetchLine(t, machine.cliFetch?.[shown], shown, machine.name) : null;
  if (!shown || !line) return null;
  if (!line.failed) {
    return (
      <div className="cli-fetch" role="status">
        <p className="ac-iconline">
          <Spinner size={14} />
          <span>{line.text}</span>
        </p>
        {line.percent !== null && <Meter value={line.percent} max={100} label={line.text} />}
      </div>
    );
  }
  return (
    <div className="cli-fetch">
      <SettingNote icon="alert">{line.text}</SettingNote>
      <Button
        size="sm"
        disabled={retry.isPending || !machine.online}
        loading={retry.isPending}
        onClick={() => retry.mutate({ machineId: machine.id, cli: shown })}
      >
        {t("common.retry")}
      </Button>
    </div>
  );
}
