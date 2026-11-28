import type { ComputerDevice } from "@agenteschat/client";
import { useComputerSetup, useMachines } from "@agenteschat/client";
import { computerName, setupPending, setupView } from "@agenteschat/client/lib/computer";
import { settingsFrozen } from "@agenteschat/client/lib/deletion";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { helpUrl } from "@agenteschat/client/lib/server";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { useTranslation } from "react-i18next";
import { Platform, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EmptyState, GroupedHeader, GroupedList, GroupedRow, Locked, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { openPage } from "../ai/parts";
import { SetupWait } from "../computer/SetupWait";
import { RowBones } from "../roles/parts";
import { AgentComputers, HostComputerOff } from "../settings/ComputersScreen";
import { Gap, SettingsPage } from "../settings/parts";
import { LoadFailed } from "../shared/FirstUse";
import { firstUseCopy } from "../shared/first-use";
import { Loaded } from "../shared/parts";
import { DevicePortrait, JoinRequestCard, StatusLine } from "./parts";
import { useDeviceMutation, useDevices } from "./queries";

export const openComputer = (id: string) => router.push(`/settings/devices/${id}`);
export const openPhone = (id: string) => router.push(`/settings/devices/phone/${id}`);
/** This phone's own guide: Android's setup, or the iPhone's steps on the Mac. */
export const openThisPhone = (machineId?: string) =>
  router.push({
    pathname: Platform.OS === "ios" ? "/settings/devices/iphone-setup" : "/settings/devices/android-setup",
    params: machineId ? { machine: machineId } : {},
  });

/**
 * Configurações › Dispositivos, as the web's: computers with the phones plugged into them nested under each (status
 * chip and words), the workspace's own computer first; the computers asking to join on top for whoever made their
 * link, with Let it join / Deny; Connect a device and this phone's own guide; which computer each agent uses.
 */
export function DevicesScreen() {
  const { t, i18n } = useTranslation();
  const { orgId, org } = useOrg();
  const pairs = can(org, "pair_computers");
  // Being deleted, what would change the workspace is greyed out, as on the web; each device still opens its page.
  const frozen = settingsFrozen(org, "devices");
  const list = useDevices();
  const setup = useComputerSetup(orgId);
  const view = setupView(setup.data, setup.dataUpdatedAt);
  const managed = useMachines(orgId).data?.find((m) => m.kind === "managed");
  const requests = list.data?.requests ?? [];
  const admin = can(org, "configure");
  const toast = useToast();
  const help = useDeviceMutation((api, id, on: boolean) => api.devices.setHelp(id, on));
  // A switch moves as it is tapped, and holds until the list is read again.
  const helpOn = (help.isPending ? help.variables : undefined) ?? list.data?.devicesHelp !== false;
  return (
    <SettingsPage
      title={t("mobile.devices.title")}
      onRefresh={() => Promise.allSettled([list.refetch(), setup.refetch()])}
    >
      {/* The workspace's own computer on its way: its wait until it is ready, then it is a row like the others. */}
      {setupPending(view) ? (
        <>
          <Gap />
          <GroupedList>
            <View style={styles.wait}>
              <SetupWait view={view} online={managed?.online ?? false} />
            </View>
          </GroupedList>
        </>
      ) : null}
      {requests.length > 0 ? (
        <Loaded>
          <GroupedHeader>{t("mobile.devices.join.header")}</GroupedHeader>
          <Locked when={frozen} readable style={styles.cards}>
            {requests.map((r) => (
              <JoinRequestCard key={r.id} request={r} />
            ))}
          </Locked>
        </Loaded>
      ) : null}
      <Gap />
      {list.isLoading ? (
        // The rows' shape while they load: nothing jumps when they come.
        <GroupedList>
          <RowBones />
          <RowBones name={56} />
        </GroupedList>
      ) : list.isError && !list.data ? (
        // A list that didn't load is not an empty one: what happened, and the way to ask again.
        <LoadFailed onRetry={() => void list.refetch()} />
      ) : (
        <DeviceList devices={list.data?.devices ?? []} pairs={pairs} />
      )}
      <Gap />
      <Locked when={frozen} readable>
        <GroupedList>
          {pairs ? (
            <GroupedRow
              icon="plus"
              label={t("mobile.devices.connect.title")}
              chevron
              onPress={() => router.push("/settings/devices/connect")}
            />
          ) : null}
          <GroupedRow
            icon="join"
            label={Platform.OS === "ios" ? t("mobile.devices.iphone.title") : t("mobile.devices.android.entry")}
            chevron
            onPress={() => openThisPhone()}
          />
        </GroupedList>
        <HostComputerOff />
        <AgentComputers />
        {admin && list.data ? (
          <>
            <Gap />
            <GroupedList>
              <GroupedRow
                icon="bolt"
                label={t("devices.helpWorkspace")}
                labelLines={2}
                hint={{
                  name: t("common.about", { label: t("devices.helpWorkspace") }),
                  text: t("devices.helpWorkspaceHint"),
                }}
                toggle={helpOn}
                onPress={() =>
                  help.mutate(!helpOn, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
                }
              />
            </GroupedList>
          </>
        ) : null}
      </Locked>
      <Gap />
      <GroupedList>
        <GroupedRow
          icon="help"
          label={t("computers.how")}
          chevron
          onPress={() => openPage(helpUrl("computers", i18n.language))}
        />
      </GroupedList>
    </SettingsPage>
  );
}

/** Every computer and, under each, the phones it reaches; each row opens its page. */
function DeviceList({ devices, pairs }: { devices: ComputerDevice[]; pairs: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  // Who can't connect one reads who does instead.
  const copy = pairs
    ? ({ title: "mobile.devices.empty.title", text: "mobile.devices.empty.text" } as const)
    : firstUseCopy("computers", pairs);
  // Nothing yet: what this place gives, in the words of an empty place; the rows under it are the way in.
  if (devices.length === 0) return <EmptyState size="inline" title={t(copy.title)} subtitle={t(copy.text)} />;
  return (
    <GroupedList>
      {devices.flatMap((d) => {
        const name = computerName(t, org?.name ?? "", { kind: d.machineKind, name: d.name }, isPersonal(org));
        return [
          <GroupedRow
            key={d.id}
            leading={<DevicePortrait computer={d} />}
            label={name}
            labelLines={2}
            below={<StatusLine status={d.status} />}
            chevron
            {...(d.phones.length > 0 ? { tree: "host" as const } : {})}
            onPress={() => openComputer(d.id)}
          />,
          ...d.phones.map((p, i) => (
            <GroupedRow
              key={p.id}
              leading={<DevicePortrait phone={p} />}
              label={p.name}
              labelLines={2}
              below={<StatusLine status={p.status} hostName={name} />}
              chevron
              tree={i === d.phones.length - 1 ? "end" : "mid"}
              onPress={() => openPhone(p.id)}
            />
          )),
        ];
      })}
    </GroupedList>
  );
}

const styles = StyleSheet.create({
  wait: { padding: 16 },
  cards: { gap: 12 },
});
