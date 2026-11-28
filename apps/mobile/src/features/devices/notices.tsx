import {
  type AppNotification,
  type InstallableCli,
  useAskMachineFolder,
  useCliInstall,
  useMachines,
  useNotificationAction,
  useRefuseFolderRequest,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { cliInstallFailure, computerKind, installableCli } from "@agenteschat/client/lib/machines";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ComputerIcon } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import { Button, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { AskButtons } from "../chat/asks";
import { useRowDirectory } from "../chat/row-data";
import { useColors, useDirectory, useOrgId, useWhen } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { WaitingCard } from "../shared/WaitingCard";
import { type DeviceNotice, deviceHref, deviceNoticeOf, deviceNoticeTitle, joinFacts } from "./logic";
import { JoinButtons, JoinInternetLine } from "./parts";
import { useDeviceMutation, useDevices } from "./queries";
import { ToolOneClickButton } from "./ToolOneClick";

/** Whom the agent works for, by first name ("" when it's the viewer or nobody says). */
export function useNoticePerson(n: Pick<AppNotification, "kind" | "source" | "latest">) {
  // The app's one directory (`WorkspaceRowData`): Atividade's rows and the island ask for it per notice.
  const dir = useRowDirectory();
  const id = deviceNoticeOf(n)?.forUserId;
  return id ? firstName(dir.nameOf({ type: "person", id })) : "";
}

/**
 * A device notification waiting on the viewer, as Atividade's cards: a computer asking to join (its card with Let it
 * join / Deny), or an agent asking to use their device (Allow once / No, and "Always allow Rui" under them).
 */
export function DeviceNoticeCard({ item: n, first }: { item: AppNotification; first: boolean }) {
  const d = deviceNoticeOf(n);
  if (!d) return null;
  if (d.kind === "device.folder_request") return <FolderNotice n={n} d={d} />;
  if (d.kind === "device.tool_request" || d.kind === "device.cli_request") return <ToolNotice n={n} d={d} />;
  return d.kind === "device.join_request" ? <JoinNotice n={n} d={d} /> : <AccessNotice n={n} d={d} first={first} />;
}

/**
 * An agent waits for a folder on the viewer's computer: it is allowed there, in the app on that computer (or with the
 * runner's command), so the card has no button that would grant it from here: No, and where the app runs that
 * computer, Liberar no computador, which opens the request there.
 */
function FolderNotice({ n, d }: { n: AppNotification; d: DeviceNotice }) {
  const { t } = useTranslation();
  const toast = useToast();
  const when = useWhen();
  const dir = useDirectory();
  const orgId = useOrgId();
  const refuse = useRefuseFolderRequest(orgId);
  const show = useAskMachineFolder(orgId);
  const computer = useMachines(orgId).data?.find((m) => m.id === d.machineId);
  const agent = n.actors.find((a) => a.type === "agent");
  const name = dir.nameOf(agent ? { type: "agent", id: agent.id } : null);
  return (
    <WaitingCard
      agentId={agent?.id ?? null}
      name={name}
      kind={{ icon: "laptop", label: t("mobile.devices.notice.kind") }}
      title={deviceNoticeTitle(t, d, name, "", "")}
      where={when.short(n.updatedAt)}
      onPress={() => router.push(deviceHref(d))}
      decision={
        d.machineId && d.requestId ? (
          <View style={styles.acts}>
            {computer?.folderPick ? (
              <Button
                variant="primary"
                size="sm"
                label={t("devices.notice.folderOnComputer")}
                loading={show.isPending}
                disabled={refuse.isPending}
                onPress={() =>
                  d.machineId &&
                  d.requestId &&
                  show.mutate(
                    { machineId: d.machineId, requestId: d.requestId },
                    {
                      onSuccess: () =>
                        toast({ title: t("devices.notice.folderShown", { deviceName: d.device }), icon: "check" }),
                      onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                    },
                  )
                }
              />
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              label={t("devices.notice.no")}
              loading={refuse.isPending}
              disabled={show.isPending}
              onPress={() =>
                d.machineId &&
                d.requestId &&
                refuse.mutate(
                  { machineId: d.machineId, requestId: d.requestId },
                  {
                    onSuccess: () => toast({ title: t("devices.notice.decided.no"), icon: "check" }),
                    onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                  },
                )
              }
            />
          </View>
        ) : undefined
      }
    >
      {d.doing ? (
        <Text variant="small" tone="muted">
          {d.doing}
        </Text>
      ) : null}
    </WaitingCard>
  );
}

/** Someone asks the viewer to turn a tool on on their computer: the same one-click button as where it was needed. */
function ToolNotice({ n, d }: { n: AppNotification; d: DeviceNotice }) {
  const { t } = useTranslation();
  const when = useWhen();
  const dir = useDirectory();
  const done = useDone(n);
  const asker = n.actors.find((a) => a.type === "user");
  const name = dir.nameOf(asker ? { type: "person", id: asker.id } : null);
  return (
    <WaitingCard
      name={name}
      kind={{ icon: "laptop", label: t("mobile.devices.notice.kind") }}
      title={deviceNoticeTitle(t, d, name, "", "")}
      where={when.short(n.updatedAt)}
      onPress={() => router.push(deviceHref(d))}
      decision={
        d.kind === "device.cli_request" ? (
          d.machineId && installableCli(d.tool ?? "") ? (
            <CliInstallButton
              machineId={d.machineId}
              machineName={d.device}
              cli={installableCli(d.tool ?? "") ?? "claude"}
            />
          ) : undefined
        ) : d.machineId && d.tool ? (
          <ToolOneClickButton
            machineId={d.machineId}
            machineName={d.device}
            oneClick={{ kind: "allow" }}
            tool={d.tool}
            onAllowed={done}
          />
        ) : undefined
      }
    />
  );
}

/** The one click for whoever connected the computer, when someone asked them for a coding CLI there: it installs it. */
function CliInstallButton({
  machineId,
  machineName,
  cli,
}: {
  machineId: string;
  machineName: string;
  cli: InstallableCli;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const run = useCliInstall(useOrgId(), machineId, cli, true);
  const program = t(`brain.card.${cli === "claude" ? "claude_code" : "codex"}`);
  // An install that ended badly says why where it was started; one that ended before this row opened says nothing.
  const was = useRef(run.install?.state);
  useEffect(() => {
    const failed = was.current === "running" && cliInstallFailure(t, run.install, { program, computer: machineName });
    if (failed) toast({ title: failed, icon: "x" });
    was.current = run.install?.state;
  }, [run.install, t, program, machineName, toast]);
  return (
    <Button
      variant="primary"
      size="sm"
      label={t("connectAi.cli.install", { program })}
      loading={run.start.isPending || run.install?.state === "running"}
      onPress={() => run.start.mutate(undefined, { onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })}
    />
  );
}

function useDone(n: AppNotification) {
  const act = useNotificationAction(useOrgId());
  return () => act.mutate({ type: "done", item: n, done: true });
}

function JoinNotice({ n, d }: { n: AppNotification; d: DeviceNotice }) {
  const { t } = useTranslation();
  const c = useColors();
  const { org } = useOrg();
  const when = useWhen();
  const requests = useDevices().data?.requests;
  const done = useDone(n);
  const request = requests?.find((r) => r.id === d.requestId) ?? (requests?.length === 1 ? requests[0] : undefined);
  const kind = { icon: "laptop" as const, label: t("mobile.devices.notice.kind") };
  if (request)
    return (
      <WaitingCard
        leading={
          <Tile>
            <ComputerIcon kind={computerKind(request.os)} size={18} color={c.muted} />
          </Tile>
        }
        name={request.name || request.hostname}
        kind={kind}
        title={t("mobile.devices.join.title", { name: request.name || request.hostname, org: org?.name ?? "" })}
        where={when.short(n.updatedAt)}
        decision={<JoinButtons request={request} onDone={done} />}
      >
        <Text variant="small" tone="muted">
          {joinFacts(t, request)}
        </Text>
        <JoinInternetLine os={request.os} />
      </WaitingCard>
    );
  // Answered elsewhere, or out of time: the card opens the devices.
  return (
    <WaitingCard
      kind={kind}
      title={deviceNoticeTitle(t, d, "", "", org?.name ?? "")}
      where={when.short(n.updatedAt)}
      action={{ label: t("mobile.activityNow.open"), onPress: () => router.push("/settings/devices") }}
    />
  );
}

function AccessNotice({ n, d, first }: { n: AppNotification; d: DeviceNotice; first: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const when = useWhen();
  const dir = useDirectory();
  const person = useNoticePerson(n);
  const done = useDone(n);
  const decide = useDeviceMutation((api, orgId, decision: "once" | "always" | "no") =>
    api.devices.decideAccess(orgId, d.requestId ?? "", decision),
  );
  const agent = n.actors.find((a) => a.type === "agent");
  const name = dir.nameOf(agent ? { type: "agent", id: agent.id } : null);
  const answer = (decision: "once" | "always" | "no") =>
    decide.mutate(decision, { onSuccess: done, onError: (err) => toast({ title: errorText(t, err), icon: "x" }) });
  const button = (decision: "once" | "no", label: string, primary: boolean) => (
    <Button
      variant={primary ? "primary" : "secondary"}
      size="card"
      wide
      label={label}
      disabled={decide.isPending || !d.requestId}
      onPress={() => answer(decision)}
    />
  );
  return (
    <WaitingCard
      agentId={agent?.id ?? null}
      name={name}
      kind={{ icon: "laptop", label: t("mobile.devices.notice.kind") }}
      title={deviceNoticeTitle(t, d, name, person, "")}
      where={when.short(n.updatedAt)}
      onPress={() => router.push(deviceHref(d))}
      decision={
        <View style={styles.decide}>
          <AskButtons
            primary={button("once", t("mobile.devices.notice.allowOnce"), first)}
            secondary={button("no", t("mobile.devices.notice.no"), false)}
          />
          <Button
            variant="ghost"
            size="card"
            wide
            label={t("mobile.devices.notice.always", { name: person || name })}
            disabled={decide.isPending || !d.requestId}
            onPress={() => answer("always")}
          />
        </View>
      }
    >
      {d.doing ? (
        <Text variant="small" tone="muted">
          {d.doing}
        </Text>
      ) : null}
    </WaitingCard>
  );
}

/** Under an inbox row: Stop while an agent holds the viewer's phone, Turn off a computer's internet lent to agents. */
export function DeviceNoticeActions({ item: n }: { item: AppNotification }) {
  const { t } = useTranslation();
  const toast = useToast();
  const done = useDone(n);
  const d = deviceNoticeOf(n);
  const stop = useDeviceMutation((api, orgId, id: string) => api.devices.stopPhone(orgId, id));
  const lendOff = useDeviceMutation((api, orgId, id: string) =>
    api.devices.updateComputer(orgId, id, { shareInternet: false }),
  );
  if (d?.kind === "device.internet_shared" && d.machineId && !n.doneAt) {
    const machineId = d.machineId;
    return (
      <View style={styles.row}>
        <Button
          variant="secondary"
          size="sm"
          label={t("devices.notice.internetOff")}
          loading={lendOff.isPending}
          onPress={() =>
            lendOff.mutate(machineId, {
              onSuccess: () => {
                done();
                toast({ title: t("devices.notice.internetOffDone", { deviceName: d.device }), icon: "check" });
              },
              onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
            })
          }
        />
      </View>
    );
  }
  if (d?.kind !== "device.in_use" || !d.phoneId || n.doneAt) return null;
  const phoneId = d.phoneId;
  return (
    <View style={styles.row}>
      <Button
        variant="secondary"
        size="sm"
        label={t("mobile.devices.notice.stop")}
        disabled={stop.isPending}
        onPress={() =>
          stop.mutate(phoneId, { onSuccess: done, onError: (err) => toast({ title: errorText(t, err), icon: "x" }) })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  decide: { gap: 8 },
  row: { flexDirection: "row" },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
