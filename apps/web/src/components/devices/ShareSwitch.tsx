import type { DeviceAudience } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Card, Switch } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { useDevices, useUpdateComputer } from "./queries";

const shared = (on: boolean): DeviceAudience => ({ mode: on ? "everyone" : "owner", userIds: [], roleIds: [] });

/**
 * "Let the whole workspace use it", right after a computer or a phone joins: off is its owner alone, on is everyone in
 * the workspace, saved at once. The device page's "Who can use it" holds the rest (some people or roles).
 */
export function ShareSwitch({
  id,
  audience,
  onChange,
  saving = false,
  hint,
}: {
  id: string;
  audience: DeviceAudience;
  onChange: (next: DeviceAudience) => void;
  saving?: boolean;
  hint: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const on = audience.mode === "everyone";
  return (
    <Card aria-label={t("devices.sharing")}>
      <div className="settings-rows">
        <PrefRow
          id={id}
          icon="audienceEveryone"
          label={t("devices.share.title")}
          hint={hint}
          status={on ? t("devices.share.on", { org: org.name }) : t("devices.share.off")}
          control={<Switch checked={on} disabled={saving} onCheckedChange={(next) => onChange(shared(next))} />}
        />
      </div>
    </Card>
  );
}

/** The switch for a computer that just joined, once the devices list has it and only for whoever may change it. */
export function ComputerShareSwitch({ machineId, server = false }: { machineId: string; server?: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateComputer(org.id);
  const device = useDevices(org.id).data?.devices.find((d) => d.id === machineId);
  if (!device?.mayManage) return null;
  return (
    <ShareSwitch
      id="dv-share"
      audience={device.audience}
      saving={update.isPending}
      hint={t(server ? "devices.share.hintServer" : "devices.share.hint", { org: org.name })}
      onChange={(audience) =>
        update.mutate({ id: machineId, audience }, { onError: (err) => toast.show(errorText(t, err), "error") })
      }
    />
  );
}
