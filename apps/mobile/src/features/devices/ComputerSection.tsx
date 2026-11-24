import { type ComputerDevice, useWifiIphones } from "@agenteschat/client";
import { mayChangeTasks, taskChoices } from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { computerKind } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { Button, GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { chooseAction, Gap } from "../settings/parts";
import { useMeId, useOrgId } from "../shared/hooks";
import { openPhone } from "./DevicesScreen";
import { DevicePortrait, StatusLine, useAudienceText } from "./parts";
import { useDeviceMutation } from "./queries";

/**
 * On a computer's page, what bringing devices adds: who can use it (its owner changes it, an admin narrows it), the
 * workspace's mark for admins, the line about whose computer it is, the phones plugged into it, and on a Mac the
 * iPhones on its Wi-Fi that trust it, each with Use over Wi-Fi (for who may manage it).
 */
export function ComputerSection({ device: d, name }: { device: ComputerDevice; name: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { org } = useOrg();
  const meId = useMeId();
  const audienceText = useAudienceText();
  const mark = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { belongsToWorkspace: on }),
  );
  const spill = useDeviceMutation((api, orgId, input: { own?: boolean; others?: boolean }) =>
    api.devices.updateComputer(orgId, d.id, { spill: input }),
  );
  const tasks = useDeviceMutation((api, orgId, maxTasks: number) =>
    api.devices.updateComputer(orgId, d.id, { maxTasks }),
  );
  const brought = d.machineKind === "connected";
  const admin = can(org, "configure");
  const maxTasks = (tasks.isPending ? tasks.variables : undefined) ?? d.maxTasks;
  const askTasks = (current: number) =>
    chooseAction(
      t("devices.maxTasks"),
      taskChoices(current).map((n) => ({
        label: String(n),
        checked: n === current,
        onPress: () => {
          if (n !== current) tasks.mutate(n, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
        },
      })),
      t("common.cancel"),
    );
  // What is being saved shows at once: a switch moves as it is tapped. Each change stays pending until the computers
  // are read again (`useDeviceMutation`), so the saved value takes over with no flicker.
  const spillOn = (key: "own" | "others") => (spill.isPending ? spill.variables?.[key] : undefined) ?? d.spill[key];
  const belongs = (mark.isPending ? mark.variables : undefined) ?? d.belongsToWorkspace;
  const wifi = useWifiIphones(
    useOrgId(),
    d.id,
    d.mayManage && computerKind(d.os) === "mac" && d.status.kind !== "offline",
  );
  return (
    <>
      {d.machineKind !== "managed" ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              label={t("mobile.devices.audience.label")}
              value={audienceText(d.audience, d.ownerUserId)}
              {...(d.mayManage
                ? {
                    chevron: true,
                    onPress: () => router.push({ pathname: "/settings/devices/audience", params: { id: d.id } }),
                  }
                : {})}
            />
            {/* Only once the computer says its limit: a guess here would be a setting that changes nothing. */}
            {maxTasks !== null ? (
              <GroupedRow
                label={t("devices.maxTasks")}
                hint={{ name: t("common.about", { label: t("devices.maxTasks") }), text: t("devices.maxTasksHint") }}
                value={String(maxTasks)}
                {...(mayChangeTasks(d, meId ?? "", admin)
                  ? {
                      menu: true,
                      // The computer applies it: offline, nothing would.
                      disabled: tasks.isPending || d.status.kind === "offline",
                      onPress: () => askTasks(maxTasks),
                    }
                  : {})}
              />
            ) : null}
            {/* Spill-over: its owner turns these on; an admin may only turn them off. */}
            {brought && d.mayManage && !d.systemMode
              ? (["own", "others"] as const).map((key) => {
                  const label = t(key === "own" ? "devices.spillOwn" : "devices.spillOthers");
                  const on = spillOn(key);
                  return (
                    <GroupedRow
                      key={key}
                      label={label}
                      labelLines={2}
                      hint={{
                        name: t("common.about", { label }),
                        text: t(key === "own" ? "devices.spillOwnHint" : "devices.spillOthersHint"),
                      }}
                      toggle={on}
                      disabled={d.ownerUserId !== meId && !on}
                      onPress={() =>
                        spill.mutate(
                          { [key]: !on },
                          { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) },
                        )
                      }
                    />
                  );
                })
              : null}
            {brought && admin ? (
              <GroupedRow
                label={t("mobile.devices.page.belongs")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("mobile.devices.page.belongs") }),
                  text: t("mobile.devices.page.belongsHint"),
                }}
                toggle={belongs}
                onPress={() =>
                  mark.mutate(!belongs, {
                    onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                  })
                }
              />
            ) : null}
          </GroupedList>
          {brought && d.ownerUserId !== meId ? (
            <GroupedFooter>{t("mobile.devices.page.ownerReads")}</GroupedFooter>
          ) : null}
        </>
      ) : null}
      {d.phones.length > 0 || wifi.available.length > 0 ? (
        <>
          <GroupedHeader>{t("mobile.devices.page.phones")}</GroupedHeader>
          <GroupedList>
            {wifi.available.map((p) => (
              <GroupedRow
                key={p.serial}
                icon="wifi"
                label={t("mobile.devices.iphone.wifi.also", { host: name, name: p.name ?? p.model })}
                labelLines={3}
                hint={{
                  name: t("common.about", { label: t("mobile.devices.iphone.wifi.use") }),
                  text: t("mobile.devices.iphone.wifi.hint"),
                }}
                below={
                  <Button
                    size="sm"
                    variant="secondary"
                    label={t("mobile.devices.iphone.wifi.use")}
                    loading={wifi.pick.isPending && wifi.pick.variables === p.serial}
                    disabled={wifi.pick.isPending}
                    onPress={() =>
                      wifi.pick.mutate(p.serial, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
                    }
                  />
                }
              />
            ))}
            {d.phones.map((p) => (
              <GroupedRow
                key={p.id}
                leading={<DevicePortrait phone={p} />}
                label={p.name}
                labelLines={2}
                below={<StatusLine status={p.status} hostName={name} />}
                chevron
                onPress={() => openPhone(p.id)}
              />
            ))}
          </GroupedList>
        </>
      ) : null}
    </>
  );
}
