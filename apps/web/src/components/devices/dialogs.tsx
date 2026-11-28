import type { DeviceJoinRequest } from "@agenteschat/client";
import { defaultLinkAudience, joinFacts, joinLends } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerKind } from "@agenteschat/client/lib/machines";
import {
  Button,
  ComputerPortrait,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Locked,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { StatusPill } from "./parts";
import { useApproveRequest, useDenyRequest, useDevices } from "./queries";
import { ComputerShareSwitch } from "./ShareSwitch";

/** Rename a computer or a phone: one field, saved on Save. */
export function RenameDeviceDialog({
  name,
  open,
  onClose,
  onSave,
  saving,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<unknown>;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setValue(name);
    setError(null);
  }, [open, name]);
  const clean = value.trim();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("devices.renameTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          onSave(clean).then(onClose, (err) => setError(errorText(t, err)));
        }}
      >
        <Locked when={saving}>
          <DialogBody>
            <Field label={t("devices.name")} id="device-rename" error={error ?? undefined}>
              <Input value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!clean || saving} loading={saving}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** Remove a computer, or forget a phone, after one confirmation. */
export function RemoveDeviceDialog({
  name,
  phone,
  wifi = false,
  host = false,
  open,
  onClose,
  onRemove,
  removing,
}: {
  name: string;
  phone: boolean;
  /** An iPhone used over Wi-Fi: it stops being used over Wi-Fi, and comes back only if picked again. */
  wifi?: boolean;
  /** This server's own computer: it stops being used in this workspace, and can be used again. */
  host?: boolean;
  open: boolean;
  onClose: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={
        host
          ? t("machines.host.stopTitle")
          : wifi
            ? t("devices.iphone.wifi.stopTitle", { name })
            : t(phone ? "devices.forgetTitle" : "devices.removeTitle", { name })
      }
      description={
        host
          ? t("machines.host.stopText")
          : wifi
            ? t("devices.iphone.wifi.stopText")
            : t(phone ? "devices.forgetText" : "devices.removeText")
      }
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={removing} disabled={removing} onClick={onRemove}>
          {host
            ? t("machines.host.stop")
            : wifi
              ? t("devices.iphone.wifi.stop")
              : t(phone ? "devices.forget" : "devices.remove")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * A computer that ran a connect link, asking to join: its name, system, address and rough place, then its name, and
 * Let it join or Deny. Who can use it comes after it joined (`ShareSwitch`), starting from the link's kind.
 */
export function JoinRequestForm({
  request,
  kind,
  onJoined,
  onDenied,
  footer = true,
}: {
  request: DeviceJoinRequest;
  /** What the link was made for: a server is everyone's by default, a person's computer theirs. */
  kind: "server" | "computer";
  onJoined: (machineId: string, name: string) => void;
  onDenied: () => void;
  footer?: boolean;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const approve = useApproveRequest(org.id);
  const deny = useDenyRequest(org.id);
  // Where computers lend their internet, this one will too, but a server box (ADR 0237).
  const lends = joinLends(useDevices(org.id).data, request.os);
  const [name, setName] = useState(request.name);
  const busy = approve.isPending || deny.isPending;
  const clean = name.trim();
  const join = () =>
    approve.mutate(
      { id: request.id, name: clean || request.name, audience: defaultLinkAudience(kind) },
      {
        onSuccess: ({ machineId }) => onJoined(machineId, clean || request.name),
        onError: (err) => toast.show(errorText(t, err), "error"),
      },
    );
  // Out of the list at once and the form goes; a refusal puts the request back and says why.
  const refuse = () => {
    void deny.mutateAsync(request.id).then(
      () => toast.show(t("devices.request.denied", { name: request.name })),
      (err: unknown) => toast.show(errorText(t, err), "error"),
    );
    onDenied();
  };
  return (
    <>
      <Locked when={busy}>
        <DialogBody>
          <div className="ac-faceline dv-join">
            <ComputerPortrait kind={computerKind(request.os)} state="online" />
            <span className="dv-connected__text">
              <span className="dv-connected__name ac-captop">{request.name}</span>
              <span className="dv-connected__facts">{joinFacts(t, request)}</span>
            </span>
          </div>
          <Field label={t("devices.name")} id={`join-${request.id}-name`} example={t("devices.nameHelp")}>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          {lends && (
            <p className="setup-line ac-iconline small muted">
              <Icon name="globe" size={14} />
              <span>{t("devices.shareInternetJoin")}</span>
            </p>
          )}
        </DialogBody>
      </Locked>
      {footer && (
        <DialogFooter>
          <Button onClick={refuse} loading={deny.isPending} disabled={busy}>
            {t("devices.request.deny")}
          </Button>
          <Button variant="primary" onClick={join} loading={approve.isPending} disabled={busy}>
            {t("devices.request.letJoin")}
          </Button>
        </DialogFooter>
      )}
    </>
  );
}

/** Let it join, from the Devices list or a notification: the request's form in its own dialog, then it as connected. */
export function JoinRequestDialog({ request, onClose }: { request: DeviceJoinRequest | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [joined, setJoined] = useState<{ machineId: string; name: string; request: DeviceJoinRequest } | null>(null);
  useEffect(() => {
    if (!request) setJoined(null);
  }, [request]);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(o) => !o && onClose()}
      title={
        joined
          ? t("devices.link.joinedTitle", { name: joined.name })
          : request
            ? t("devices.request.title", { name: request.name, org: org.name })
            : ""
      }
      closeLabel={t("common.close")}
      width={520}
    >
      {joined ? (
        <Joined joined={joined} server={false} onClose={onClose} />
      ) : (
        request && (
          <JoinRequestForm
            request={request}
            kind="computer"
            onJoined={(machineId, name) => setJoined({ machineId, name, request })}
            onDenied={onClose}
          />
        )
      )}
    </Dialog>
  );
}

/** The computer joined: its portrait, name and state, what it is, whether the whole workspace may use it, and Done. */
export function Joined({
  joined,
  server,
  onClose,
}: {
  joined: { machineId: string; name: string; request: DeviceJoinRequest };
  server: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const devices = useDevices(org.id);
  const device = devices.data?.devices.find((d) => d.id === joined.machineId);
  return (
    <>
      <DialogBody>
        <div className="ac-faceline" role="status">
          <span className="dv-pic">
            <ComputerPortrait kind={computerKind(joined.request.os)} state="online" />
          </span>
          <span className="dv-connected__text">
            <span className="dv-connected__name ac-captop">
              {joined.name}
              {/* Just joined and not running yet: its service is starting, not a computer gone away. */}
              {device && (
                <StatusPill
                  status={device.status.kind === "offline" ? { kind: "preparing", reason: "starting" } : device.status}
                />
              )}
            </span>
            <span className="dv-connected__facts">{joinFacts(t, joined.request)}</span>
          </span>
        </div>
        <ComputerShareSwitch machineId={joined.machineId} server={server} />
        <p className="small muted">
          <Link
            to="/org/$orgId/settings/devices/$deviceId"
            params={{ orgId: org.id, deviceId: joined.machineId }}
            className="ac-link"
            onClick={onClose}
          >
            {t("devices.link.openPage")}
          </Link>
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onClose}>
          {t("devices.done")}
        </Button>
      </DialogFooter>
    </>
  );
}
