import type { ComputerMaintenance, MachineOs } from "@agenteschat/client";
import { useMachines } from "@agenteschat/client";
import { maintenanceDetails, maintenanceLine, maintenanceShort } from "@agenteschat/client/lib/computer-maintenance";
import { computerKind } from "@agenteschat/client/lib/machines";
import { endSentence } from "@agenteschat/client/lib/text";
import { Button, Chip, ComputerIcon, Icon, type IconName, InfoHint } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";

/*
 * A connected computer's small pieces, shown in conversations, missions, routines and settings: apart from the
 * computers' own screens (Machines.tsx), which load with their pages, not with the app.
 */

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** A connected computer's line icon by its id (its kind from the computers list); the generic one until known. */
export function MachineIcon({ machineId, size = 14 }: { machineId: string | null | undefined; size?: 14 | 16 }) {
  const { org } = useOrg();
  const machines = useMachines(org.id, Boolean(machineId));
  const m = machineId ? machines.data?.find((x) => x.id === machineId) : undefined;
  return m ? <ComputerIcon kind={computerKind(m.os)} size={size} /> : <Icon name="computer" size={size} />;
}

const MAINTENANCE_ICON: Record<string, IconName> = {
  moving: "swap",
  restarting: "refresh",
  updating: "download",
  converting: "database",
};

/**
 * Online / Offline, with an icon (never a colored dot). Away for what we do to it (ADR 0257: a move, a restart…), it
 * says that instead, and an ⓘ beside it tells why, since when, about when it is back and what still works; online
 * while a move copies it, the ⓘ says it may be slower.
 */
export function MachineChip({
  online,
  maintenance = null,
}: {
  online: boolean;
  maintenance?: ComputerMaintenance | null;
}) {
  const { t } = useTranslation();
  const away = !online && maintenance?.away ? maintenance : null;
  const chip = away ? (
    <Chip icon={MAINTENANCE_ICON[away.kind] ?? "cog"} className="machine-chip">
      {maintenanceShort(t, away)}
    </Chip>
  ) : (
    <Chip icon={online ? "check" : "dash"} className="machine-chip">
      {online ? t("machines.online") : t("machines.offline")}
    </Chip>
  );
  const told = away ?? (online && maintenance && !maintenance.away ? maintenance : null);
  if (!told) return chip;
  return (
    <span className="ac-hintline">
      {chip}
      <MaintenanceHint maintenance={told} />
    </span>
  );
}

/** The ⓘ of what we do to the computer: its line, why, since when, about when it is back, what still works. */
export function MaintenanceHint({ maintenance }: { maintenance: ComputerMaintenance }) {
  const { t, i18n } = useTranslation();
  const now = new Date();
  return (
    <InfoHint name={t("machines.maintenance.about")}>
      {[
        endSentence(maintenanceLine(t, maintenance, now)),
        ...maintenanceDetails(t, i18n.language, maintenance, now),
      ].join(" ")}
    </InfoHint>
  );
}

/** Copies text and says so in a toast (`done`; null: nothing to say), or that it couldn't. */
function useCopy() {
  const { t } = useTranslation();
  const toast = useToast();
  return async (text: string, done: string | null) => {
    try {
      await navigator.clipboard?.writeText(text);
      if (done) toast.show(done);
      return true;
    } catch {
      toast.show(t("common.unknownError"), "error");
      return false;
    }
  };
}

/**
 * "Prefiro no Terminal": under a one-click button, the same switch as a command, folded until asked for. `label`
 * names the fold where the command is the way without the app ("Sem o app lá? Use o Terminal").
 */
export function TerminalFallback({ command, label }: { command: string | null; label?: string }) {
  const { t } = useTranslation();
  if (!command) return null;
  return (
    <details className="cflow__more">
      <summary>{label ?? t("machines.access.preferTerminal")}</summary>
      <div className="cflow__key">
        <CommandBlock command={command} />
      </div>
    </details>
  );
}

/**
 * A terminal command (or anything to paste) in a code block, with Copiar; `copied`: what the toast says, `onCopied`:
 * after it reached the clipboard. `labelled`: the screen's main thing (a one-line install): Copy in words, which
 * says Copied for a moment instead of a toast, and a long line wraps instead of scrolling.
 */
export function CommandBlock({
  command,
  copied,
  copyLabel,
  onCopied,
  labelled = false,
}: {
  command: string;
  copied?: string;
  copyLabel?: string;
  onCopied?: () => void;
  labelled?: boolean;
}) {
  const { t } = useTranslation();
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(timer);
  }, [done]);
  const label = copyLabel ?? t("common.copy");
  return (
    <div className={labelled ? "machine-command dv-cmd" : "machine-command"}>
      <pre className="machine-command__code">
        <code>{command}</code>
      </pre>
      {labelled ? (
        <Button
          size="sm"
          variant="ghost"
          icon={done ? "check" : "copy"}
          className="machine-command__copy dv-cmd__copy"
          data-copied={done || undefined}
          aria-live="polite"
          onClick={() =>
            void copy(command, null).then((ok) => {
              if (!ok) return;
              setDone(true);
              onCopied?.();
            })
          }
        >
          {done ? t("common.copied") : label}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="copy"
          className="machine-command__copy"
          aria-label={label}
          title={label}
          onClick={() =>
            void copy(command, copied ?? t("machines.commandCopied")).then((ok) => {
              if (ok) onCopied?.();
            })
          }
        />
      )}
    </div>
  );
}
