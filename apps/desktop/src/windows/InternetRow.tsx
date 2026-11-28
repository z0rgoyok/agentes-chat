import type { ComputerDevice } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import { Icon, Switch } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost } from "../app";
import { siteApi } from "../control/devices";
import { hintFor, PrefRow } from "../ui/settings";

/**
 * "Agents use this computer's internet" (ADR 0237): the computers that borrow (the workspace's own; on a self-hosted
 * server, that server's computer and its reads of web pages) open websites through this one's connection while it is
 * on. Its owner turns it on; on, it says so in a line that stays in sight. Nothing where nothing borrows
 * (`shareInternet` null).
 */
export function InternetRow({
  server,
  orgId,
  computer,
  onChanged,
}: {
  server: string;
  orgId: string;
  computer: ComputerDevice;
  onChanged?: () => Promise<void> | void;
}) {
  const { t, i18n } = useTranslation();
  const host = useHost();
  const [on, setOn] = useState(computer.shareInternet?.on ?? false);
  const [only, setOnly] = useState(computer.shareInternet?.only ?? false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setOn(computer.shareInternet?.on ?? false), [computer.shareInternet?.on]);
  useEffect(() => setOnly(computer.shareInternet?.only ?? false), [computer.shareInternet?.only]);
  if (!computer.shareInternet) return null;
  const id = `internet-${computer.id}`;
  const title = t("desktop.pair.internet");
  const owner = computer.mayManage;
  const save = async (next: { shareInternet: boolean } | { internetOnly: boolean }) => {
    setSaving(true);
    setFailed(null);
    try {
      await siteApi(host, server).devices.updateComputer(orgId, computer.id, next);
      if ("shareInternet" in next) {
        setOn(next.shareInternet);
        if (!next.shareInternet) setOnly(false);
      } else setOnly(next.internetOnly);
      await onChanged?.();
    } catch (err) {
      setFailed(errorText(t, err, i18n.language));
    } finally {
      setSaving(false);
    }
  };
  const onlyTitle = t("desktop.pair.internetOnly");
  return (
    <>
      <PrefRow
        lead={
          <span className="dk-logo">
            <Icon name="globe" size={16} />
          </span>
        }
        htmlFor={id}
        title={title}
        // A self-hosted server's agents reach this computer's internet only through proxy settings.
        hint={hintFor(
          t,
          title,
          t(server === CLOUD_SERVER ? "desktop.pair.internetHint" : "desktop.pair.internetHintProxy"),
        )}
        desc={failed ?? (on ? t("desktop.pair.internetOn") : t("desktop.pair.internetOff"))}
        end={
          <Switch
            id={id}
            aria-describedby={`${id}-hint`}
            checked={on}
            disabled={saving || !owner}
            onCheckedChange={(next) => void save({ shareInternet: next })}
          />
        }
      />
      {/* Under the switch while it lends (an older server has no such choice): nothing goes the usual way, AI included. */}
      {on && computer.shareInternet.only !== undefined && (
        <PrefRow
          nested
          htmlFor={`${id}-only`}
          title={onlyTitle}
          hint={hintFor(t, onlyTitle, t("desktop.pair.internetOnlyHint"))}
          end={
            <Switch
              id={`${id}-only`}
              aria-describedby={`${id}-only-hint`}
              checked={only}
              disabled={saving || !owner}
              onCheckedChange={(next) => void save({ internetOnly: next })}
            />
          }
        />
      )}
    </>
  );
}

/** The row for a computer paired a moment ago: its row in the workspace's list, read once. */
export function InternetRowFor({ server, orgId, machineId }: { server: string; orgId: string; machineId: string }) {
  const host = useHost();
  const [computer, setComputer] = useState<ComputerDevice | null>(null);
  useEffect(() => {
    let live = true;
    siteApi(host, server)
      .devices.list(orgId)
      .then((list) => live && setComputer(list.devices.find((d) => d.id === machineId) ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [host, server, orgId, machineId]);
  return computer?.shareInternet ? <InternetRow server={server} orgId={orgId} computer={computer} /> : null;
}
