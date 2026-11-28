import { type AppNotification, useAskMachineFolder, useMachines, useRefuseFolderRequest } from "@agenteschat/client";
import { type DeviceNotice, deviceNoticeOf, joinFacts } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { installableCli, toolWords } from "@agenteschat/client/lib/machines";
import { Button, cx, ProviderLogo } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type ReactNode, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CliInstallButton } from "@/components/ai/CliMissing";
import type { Dir } from "@/components/NotificationParts";
import { useOrg } from "@/components/org-context";
import { TYPED_VALUES } from "@/i18n";
import { useToast } from "@/lib/toast";
import { JoinRequestDialog } from "./dialogs";
import { osMark } from "./parts";
import { useDecideAccess, useDenyRequest, useDevices, useStopPhone, useUpdateComputer } from "./queries";
import { ToolOneClickButton } from "./ToolOneClick";

/** The agent and the person it works for, as a notice names them: "Lia (for Rui)", or the agent alone. */
function whoFor(dir: Dir, d: DeviceNotice, t: (key: string, o?: Record<string, unknown>) => string) {
  const agent = d.agentId ? (dir.anyAgent(d.agentId)?.name ?? t("channel.unknownAgent")) : "";
  const person = (d.userId ? dir.memberById.get(d.userId)?.name : undefined) ?? d.forName;
  return person && agent ? t("devices.notice.agentFor", { agent, person: firstName(person) }) : agent;
}

/** A device notice's line: who wants what of which device. */
export function DeviceHeadline({ n, dir }: { n: AppNotification; dir: Dir }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const d = deviceNoticeOf(n);
  if (!d) return null;
  const tt = t as unknown as (key: string, o?: Record<string, unknown>) => string;
  const values =
    d.kind === "device.join_request"
      ? { name: d.join?.name ?? d.device, org: org.name }
      : d.kind === "device.folder_request"
        ? { who: whoFor(dir, d, tt), path: d.path ?? "", deviceName: d.device }
        : d.kind === "device.tool_request" || d.kind === "device.cli_request"
          ? {
              who: (d.askerId ? dir.memberById.get(d.askerId)?.name : undefined) ?? t("channel.unknownPerson"),
              tool: d.tool ? toolWords(t, d.tool) : "",
              deviceName: d.device,
            }
          : { who: whoFor(dir, d, tt), deviceName: d.device };
  const key = {
    "device.join_request": "devices.notice.join",
    "device.in_use": "devices.notice.inUse",
    "device.access_request": "devices.notice.access",
    "device.waiting": "devices.notice.waiting",
    "device.tool_request": "devices.notice.toolRequest",
    "device.cli_request": "devices.notice.cliRequest",
    "device.folder_request": "devices.notice.folderRequest",
    "device.internet_shared": "devices.notice.internetShared",
  }[d.kind];
  return <Trans i18nKey={key as never} values={values} components={{ b: <b /> }} {...TYPED_VALUES} />;
}

/** The face of a device notice: the agent that uses or asks for the device, else the joining computer's system. */
export function DeviceFace({ n, className }: { n: AppNotification; className?: string }) {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  if (d.agentId) return <AgentAvatar agentId={d.agentId} name="" size="md" className={className} />;
  return (
    <span className={cx("nt-sys", className)} aria-hidden="true">
      <ProviderLogo id={osMark(d.join?.os ?? "")} size="xs" />
    </span>
  );
}

/** Where a device notice opens: the phone's or computer's page, or the list for a computer asking to join. */
export function deviceTarget(n: AppNotification): string | null {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  if (d.phoneId) return `phones/${d.phoneId}`;
  if (d.machineId && d.kind !== "device.join_request") return d.machineId;
  return "";
}

/** The decision's buttons: a row under an inbox row's text, or in a waiting card's foot (`inline`). */
function Wrap({
  inline,
  onClick,
  children,
}: {
  inline: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return inline ? (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the card's own click away from its buttons
    <span className="ac-acts" onClick={onClick} onKeyDown={() => {}}>
      {children}
    </span>
  ) : (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's own click away from its buttons
    <div className="nt-steprow ac-acts" onClick={onClick} onKeyDown={() => {}}>
      {children}
    </div>
  );
}

/** A device notice's second line: a joining computer's facts, or what the agent is doing. */
export function deviceNoticeLine(t: TFunction, n: AppNotification): string | null {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  // The server writes a joining computer's facts as one line (`latest.text`: "Linux · 203.0.113.7 · Frankfurt").
  if (d.join?.os)
    return joinFacts(t, { hostname: d.join.name, os: d.join.os, arch: "", ip: d.join.ip, location: d.join.location });
  if (d.kind === "device.internet_shared") return t("devices.notice.internetSharedLine");
  return d.text;
}

/**
 * A device notice's own decision, in the row: Let it join or Deny a computer, Stop an agent on the person's phone,
 * Allow once, Always or No to someone's agent asking for a device, Turn off a computer's internet lent to the agents,
 * No to a folder an agent waits for, and where the agentes.chat app runs that computer, Allow on the computer, which
 * opens the request there (it is allowed only on the computer itself).
 */
export function DeviceNoticeActions({ n, inline = false }: { n: AppNotification; inline?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const devices = useDevices(org.id);
  const deny = useDenyRequest(org.id);
  const stop = useStopPhone(org.id);
  const decide = useDecideAccess(org.id);
  const update = useUpdateComputer(org.id);
  const refuse = useRefuseFolderRequest(org.id);
  const show = useAskMachineFolder(org.id);
  const [joining, setJoining] = useState(false);
  const d = deviceNoticeOf(n);
  const folderAsk = d?.kind === "device.folder_request" && !n.doneAt;
  const computer = useMachines(org.id, folderAsk).data?.find((m) => m.id === d?.machineId);
  if (!d || n.doneAt) return null;
  const fail = (err: unknown) => toast.show(errorText(t, err), "error");
  const busy =
    deny.isPending || stop.isPending || decide.isPending || update.isPending || refuse.isPending || show.isPending;
  const request = d.requestId ? devices.data?.requests.find((r) => r.id === d.requestId) : undefined;
  const answer = (decision: "once" | "always" | "no") =>
    d.requestId &&
    decide.mutate(
      { id: d.requestId, decision },
      { onSuccess: () => toast.show(t(`devices.notice.decided.${decision}`, { deviceName: d.device })), onError: fail },
    );
  // Clicks here are the row's own: they never open it.
  const keep = (e: React.MouseEvent) => e.stopPropagation();
  if (d.kind === "device.join_request" && d.requestId && request)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setJoining(true)}>
          {t("devices.request.letJoin")}
        </Button>
        <Button
          size="sm"
          loading={deny.isPending}
          disabled={busy}
          onClick={() =>
            d.requestId &&
            deny.mutate(d.requestId, {
              onSuccess: () => toast.show(t("devices.request.denied", { name: request.name })),
              onError: fail,
            })
          }
        >
          {t("devices.request.deny")}
        </Button>
        <JoinRequestDialog request={joining ? request : null} onClose={() => setJoining(false)} />
      </Wrap>
    );
  if (d.kind === "device.in_use" && d.phoneId)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button
          size="sm"
          icon="stop"
          loading={stop.isPending}
          disabled={busy}
          onClick={() =>
            d.phoneId &&
            stop.mutate(d.phoneId, {
              onSuccess: () => toast.show(t("devices.stopped", { name: d.device })),
              onError: fail,
            })
          }
        >
          {t("devices.stop")}
        </Button>
      </Wrap>
    );
  if (d.kind === "device.tool_request" && d.machineId && d.tool)
    return (
      <Wrap inline={inline} onClick={keep}>
        <ToolOneClickButton machineId={d.machineId} machineName={d.device} oneClick={{ kind: "allow" }} tool={d.tool} />
      </Wrap>
    );
  if (d.kind === "device.cli_request" && d.machineId && installableCli(d.tool ?? ""))
    return (
      <Wrap inline={inline} onClick={keep}>
        <CliInstallButton
          machineId={d.machineId}
          machineName={d.device}
          cli={installableCli(d.tool ?? "") ?? "claude"}
        />
      </Wrap>
    );
  if (d.kind === "device.internet_shared" && d.machineId)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button
          size="sm"
          loading={update.isPending}
          disabled={busy}
          onClick={() =>
            d.machineId &&
            update.mutate(
              { id: d.machineId, shareInternet: false },
              {
                onSuccess: () => toast.show(t("devices.notice.internetOffDone", { deviceName: d.device })),
                onError: fail,
              },
            )
          }
        >
          {t("devices.notice.internetOff")}
        </Button>
      </Wrap>
    );
  if (d.kind === "device.folder_request" && d.machineId && d.requestId)
    return (
      <Wrap inline={inline} onClick={keep}>
        {computer?.folderPick && (
          <Button
            size="sm"
            variant="primary"
            icon="computer"
            loading={show.isPending}
            disabled={busy}
            onClick={() =>
              d.machineId &&
              d.requestId &&
              show.mutate(
                { machineId: d.machineId, requestId: d.requestId },
                {
                  onSuccess: () => toast.show(t("devices.notice.folderShown", { deviceName: d.device })),
                  onError: fail,
                },
              )
            }
          >
            {t("devices.notice.folderOnComputer")}
          </Button>
        )}
        <Button
          size="sm"
          loading={refuse.isPending}
          disabled={busy}
          onClick={() =>
            d.machineId &&
            d.requestId &&
            refuse.mutate(
              { machineId: d.machineId, requestId: d.requestId },
              { onSuccess: () => toast.show(t("devices.notice.decided.no")), onError: fail },
            )
          }
        >
          {t("devices.notice.no")}
        </Button>
      </Wrap>
    );
  if (d.kind === "device.access_request" && d.requestId)
    return (
      <Wrap inline={inline} onClick={keep}>
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => answer("once")}>
          {t("devices.notice.once")}
        </Button>
        <Button size="sm" icon="check" disabled={busy} onClick={() => answer("always")}>
          {t("devices.notice.always")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => answer("no")}>
          {t("devices.notice.no")}
        </Button>
      </Wrap>
    );
  return null;
}
