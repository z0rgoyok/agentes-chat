import { type ComputerDevice, useAuthConfig, useWifiIphones } from "@agenteschat/client";
import {
  lendingDevice,
  mayChangeTasks,
  SPILL_USES,
  type SpillUse,
  shareInternetHint,
  shareInternetText,
  spillOfUse,
  spillUseOf,
  taskChoices,
  tasksAutoText,
} from "@agenteschat/client/lib/devices";
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
import { useDeviceMutation, useDevices } from "./queries";

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
  const auth = useAuthConfig();
  const audienceText = useAudienceText();
  const mark = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { belongsToWorkspace: on }),
  );
  const spill = useDeviceMutation((api, orgId, own: boolean) =>
    api.devices.updateComputer(orgId, d.id, { spill: { own } }),
  );
  const use = useDeviceMutation((api, orgId, next: SpillUse) =>
    api.devices.updateComputer(orgId, d.id, { spill: spillOfUse(next) }),
  );
  const helpOff = useDevices().data?.devicesHelp === false;
  const tasks = useDeviceMutation((api, orgId, maxTasks: number) =>
    api.devices.updateComputer(orgId, d.id, { maxTasks }),
  );
  const push = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { pushHarder: on }),
  );
  const share = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { shareInternet: on }),
  );
  const shareOnly = useDeviceMutation((api, orgId, on: boolean) =>
    api.devices.updateComputer(orgId, d.id, { internetOnly: on }),
  );
  const lending = lendingDevice(useDevices().data?.devices);
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
  const askUse = () =>
    chooseAction(
      t("devices.helpUse"),
      SPILL_USES.map((next) => ({
        label: t(`devices.helpUses.${next}`),
        checked: next === helpUse,
        onPress: () => {
          if (next !== helpUse) use.mutate(next, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
        },
      })),
      t("common.cancel"),
    );
  // What is being saved shows at once: a switch moves as it is tapped. Each change stays pending until the computers
  // are read again (`useDeviceMutation`), so the saved value takes over with no flicker.
  const spillOn = (spill.isPending ? spill.variables : undefined) ?? d.spill.own;
  const helpUse = (use.isPending ? use.variables : undefined) ?? spillUseOf(d);
  const belongs = (mark.isPending ? mark.variables : undefined) ?? d.belongsToWorkspace;
  const pushing = (push.isPending ? push.variables : undefined) ?? d.taskRoom?.pushHarder ?? false;
  const sharing = (share.isPending ? share.variables : undefined) ?? d.shareInternet?.on ?? false;
  const onlyLent = (shareOnly.isPending ? shareOnly.variables : undefined) ?? d.shareInternet?.only ?? false;
  const mine = d.ownerUserId === meId;
  // Someone else's lends now: its owner may pick this one instead (on again moves it first).
  const mayPick = sharing && !share.isPending && !d.shareInternet?.inUse && lending !== null && mine;
  const shareFailed = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  const tasksEditable = mayChangeTasks(d, meId ?? "", admin);
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
            {/* Tasks start on room there: what's running and what still fits, and the owner's Push harder. */}
            {d.taskRoom ? (
              <GroupedRow
                label={t("devices.maxTasks")}
                hint={{ name: t("common.about", { label: t("devices.maxTasks") }), text: t("devices.tasksAutoHint") }}
                sub={tasksAutoText(t, d) ?? undefined}
                subLines={2}
              />
            ) : null}
            {d.taskRoom && tasksEditable && brought ? (
              <GroupedRow
                label={t("devices.pushHarder")}
                hint={{
                  name: t("common.about", { label: t("devices.pushHarder") }),
                  text: t("devices.pushHarderHint"),
                }}
                toggle={pushing}
                // The computer applies it: offline, nothing would.
                disabled={d.status.kind === "offline"}
                onPress={() =>
                  push.mutate(!pushing, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
                }
              />
            ) : null}
            {/* Only once the computer says its limit: a guess here would be a setting that changes nothing. */}
            {!d.taskRoom && maxTasks !== null ? (
              <GroupedRow
                label={t("devices.maxTasks")}
                hint={{ name: t("common.about", { label: t("devices.maxTasks") }), text: t("devices.maxTasksHint") }}
                value={String(maxTasks)}
                {...(tasksEditable
                  ? {
                      menu: true,
                      // The computer applies it: offline, nothing would.
                      disabled: tasks.isPending || d.status.kind === "offline",
                      onPress: () => askTasks(maxTasks),
                    }
                  : {})}
              />
            ) : null}
            {/* Its help, its owner's one choice: never, only as backup, or first for their own agents' work. The
                workspace's switch off wins. */}
            {brought && mine && !d.systemMode ? (
              <GroupedRow
                label={t("devices.helpUse")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("devices.helpUse") }),
                  text: t(d.belongsToWorkspace ? "devices.helpUseTeamHint" : "devices.helpUseHint"),
                }}
                {...(helpOff ? { sub: t("devices.spillWorkspaceOff"), subLines: 0 } : {})}
                value={t(`devices.helpUses.${helpOff ? "off" : helpUse}`)}
                menu
                disabled={helpOff}
                onPress={askUse}
              />
            ) : null}
            {/* Someone else's computer: an admin may only turn its help off. */}
            {brought && !mine && d.mayManage && !d.systemMode ? (
              <GroupedRow
                label={t("devices.spillOwn")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("devices.spillOwn") }),
                  text: t(d.belongsToWorkspace ? "devices.spillTeamHint" : "devices.spillOwnHint"),
                }}
                {...(helpOff ? { sub: t("devices.spillWorkspaceOff"), subLines: 0 } : {})}
                toggle={spillOn && !helpOff}
                disabled={helpOff || !spillOn}
                onPress={() =>
                  spill.mutate(!spillOn, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
                }
              />
            ) : null}
            {/* Its owner lends its internet to the workspace's computer; an admin may only stop it (ADR 0237). */}
            {d.shareInternet && (d.mayManage || sharing) ? (
              <GroupedRow
                label={t("devices.shareInternet")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("devices.shareInternet") }),
                  text: shareInternetHint(t, auth.data),
                }}
                sub={shareInternetText(t, d, lending) ?? undefined}
                toggle={sharing}
                disabled={!d.mayManage || (!mine && !sharing)}
                onPress={() => share.mutate(!sharing, { onError: shareFailed })}
                {...(mayPick
                  ? {
                      below: (
                        <Button
                          size="sm"
                          variant="secondary"
                          label={t("devices.shareInternetPick")}
                          onPress={() => share.mutate(true, { onError: shareFailed })}
                        />
                      ),
                    }
                  : {})}
              />
            ) : null}
            {/* Under the switch while it lends: nothing goes the usual way, AI included. Its owner's to turn on. */}
            {sharing && d.shareInternet?.only !== undefined && (d.mayManage || onlyLent) ? (
              <GroupedRow
                depth={1}
                label={t("devices.shareInternetOnly")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("devices.shareInternetOnly") }),
                  text: t("devices.shareInternetOnlyHint"),
                }}
                toggle={onlyLent}
                disabled={!d.mayManage || (!mine && !onlyLent)}
                onPress={() => shareOnly.mutate(!onlyLent, { onError: shareFailed })}
              />
            ) : null}
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
