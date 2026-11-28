import type {
  ComputerDevice,
  ComputerMaintenance,
  DeviceAudience,
  Machine,
  PermissionNeed,
  PhoneDevice,
} from "@agenteschat/client";
import { useAuthConfig, useMachinePause, useMachines } from "@agenteschat/client";
import {
  deviceName,
  doctorShown,
  findPhone,
  iosOf,
  iphoneOverWifi,
  lendingDevice,
  mayChangeTasks,
  permissionWaitLines,
  personInControl,
  phoneLink,
  phoneSystem,
  powerChoice,
  processorText,
  RUNNER_DOCTOR_COMMAND,
  RUNNER_UPDATE_COMMAND,
  SPILL_USES,
  shareInternetHint,
  shareInternetText,
  spillOfUse,
  spillUseOf,
  statusLook,
  statusSentence,
  systemText,
  taskChoices,
  taskLimitLine,
  tasksAutoText,
  terminalInstall,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { isPaused, PAUSE_CHOICES, pauseChoiceText, pausedByText, pauseUntil } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import {
  Alert,
  Avatar,
  Button,
  Card,
  CardHeader,
  Chip,
  codeAndBold,
  Disclosure,
  EmptyState,
  Icon,
  List,
  Menu,
  MenuItem,
  MenuSeparator,
  ProviderLogo,
  Select,
  Switch,
  Tip,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorState, LoadingList } from "@/components/Loading";
import { MachineAccessCards, MachineAgents, MachineFactsExtra, MachinePage } from "@/components/Machines";
import { CommandBlock, MaintenanceHint } from "@/components/machine-bits";
import { PrefRow } from "@/components/NoticePrefs";
import { useOrg } from "@/components/org-context";
import { OrgMark } from "@/components/ProfilePhoto";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { ConnectDialog, type ConnectStart } from "./ConnectDialog";
import { WifiIphoneOffer } from "./ConnectPhone";
import {
  DeviceRemoveDialog,
  DeviceRenameDialog,
  DeviceRowView,
  type DeviceTarget,
  usePowerAction,
} from "./DevicesSection";
import { PhoneLive } from "./PhoneLive";
import { DevicePortrait, Facts, StatusPill, useOwner } from "./parts";
import { useDevices, useStopPhone, useUpdateComputer, useUpdatePhone } from "./queries";
import { WhoCanUseRow } from "./WhoCanUse";

/** `/settings/devices/<id>` (a computer) or `/settings/devices/phones/<id>` (a phone). */
export function DevicePage({ path }: { path: string }) {
  const phoneId = path.startsWith("phones/") ? path.slice("phones/".length) : null;
  return phoneId ? <PhonePage phoneId={phoneId} /> : <ComputerPage machineId={path} />;
}

function BackToDevices() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Button asChild size="sm" variant="ghost" className="machine-page__back">
      <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "devices" }} search={{}}>
        <Icon name="chevronLeft" />
        {t("devices.back")}
      </Link>
    </Button>
  );
}

function NotFound() {
  const { t } = useTranslation();
  return (
    <>
      <BackToDevices />
      <Card>
        <EmptyState icon="computer" title={t("devices.notFound")}>
          {t("devices.notFoundText")}
        </EmptyState>
      </Card>
    </>
  );
}

function useBackToList() {
  const { org } = useOrg();
  const navigate = useNavigate();
  return () =>
    void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "devices" }, search: {} });
}

/** The header card's top: the 96 portrait, the name with its rename pencil, chips (whose, its state, where), its actions. */
function Head({
  device,
  chips,
  menu,
  onRename,
}: {
  device: ComputerDevice | PhoneDevice;
  chips: ReactNode;
  menu?: ReactNode;
  onRename?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="row machine-page__head dv-head">
      <DevicePortrait device={device} size={96} />
      <span className="list-col machine-page__title">
        <span className="row dv-title ac-captop">
          <h2 id="dv-page-title" className="ac-card__title">
            {deviceName(t, device)}
          </h2>
          {onRename && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="edit"
              aria-label={t("devices.renameName", { name: device.name })}
              onClick={onRename}
            />
          )}
        </span>
        <span className="row dv-headchips">{chips}</span>
      </span>
      {menu}
    </div>
  );
}

/** Whose it is, as a chip: a person's face and name, or the workspace's mark. */
function OwnerChip({ userId }: { userId: string | null }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  // A personal workspace names no workspace (ADR 0159): a device of nobody in particular is its person's.
  const owner = useOwner(userId ?? (isPersonal(org) ? me.user.id : null));
  return owner ? (
    <Chip lead={<Avatar kind="person" size="xs" name={owner.name} imageUrl={owner.image} />}>{owner.name}</Chip>
  ) : (
    <Chip lead={<OrgMark logo={org.logo} size={14} />}>{t("devices.workspace")}</Chip>
  );
}

/** Under the header's chips: the state's reason in words and its one action; nothing when the pill says it all. */
function StatusLine({
  status,
  host,
  hostOs,
  action,
  ios,
  text,
  maintenance,
  cli,
}: {
  status: PhoneDevice["status"];
  host?: string;
  /** The host's system: a phone with no driver reads by it. */
  hostOs?: string;
  action?: ReactNode;
  ios?: string | null;
  /** In place of the status's own sentence, as typed (it carries a person's name). */
  text?: string | null;
  /** What we do to the computer (ADR 0257): its line, with its ⓘ. */
  maintenance?: ComputerMaintenance | null;
  /** Installed from the Terminal (`terminalInstall`). */
  cli?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const sentence = text ?? statusSentence(t, i18n.language, status, { host, hostOs, ios, maintenance, cli });
  const label = status.kind === "in_use" && status.label ? status.label : null;
  if (!sentence && !action) return null;
  return (
    <div className="dv-statusline" data-status={statusLook(status)} role="status">
      <span className={maintenance ? "dv-statusline__text ac-hintline" : "dv-statusline__text"}>
        {text ?? (sentence && codeAndBold(sentence, "cb", [host]))}
        {label && <small> · {label}</small>}
        {maintenance && <MaintenanceHint maintenance={maintenance} />}
      </span>
      {action}
    </div>
  );
}

const PAUSE_ICONS = { "1h": "clock", tomorrow: "calendar", manual: "pause" } as const;

/**
 * Pause or Resume on a computer's status line, for whoever connected it and admins. Its app applies it as a pause on
 * the computer itself; an app too old for it shows the button off and says to update.
 */
function PauseControl({ machine, paused }: { machine: Machine; paused: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const pause = useMachinePause(org.id);
  const set = (input: { until: string | null } | "resume") =>
    pause.mutate(
      { machineId: machine.id, input },
      {
        onSuccess: () =>
          toast.show(
            t(input === "resume" ? "machines.remotePause.resumed" : "machines.remotePause.paused", {
              name: machine.name,
            }),
          ),
        onError: (err) => toast.show(errorText(t, err), "error"),
      },
    );
  const words = t(paused ? "machines.remotePause.resume" : "machines.remotePause.button");
  if (!machine.remotePause) {
    return (
      <Button size="sm" icon={paused ? "play" : "pause"} disabled className="dv-pausebtn" aria-label={words}>
        {words}
      </Button>
    );
  }
  if (paused) {
    return (
      <Button
        size="sm"
        icon="play"
        loading={pause.isPending}
        onClick={() => set("resume")}
        className="dv-pausebtn"
        aria-label={words}
      >
        {words}
      </Button>
    );
  }
  const label = t("machines.remotePause.menu", { name: machine.name });
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button size="sm" icon="pause" loading={pause.isPending} className="dv-pausebtn" aria-label={words}>
          {words}
        </Button>
      }
    >
      {PAUSE_CHOICES.map((choice) => (
        <MenuItem key={choice} icon={PAUSE_ICONS[choice]} onSelect={() => set({ until: pauseUntil(choice) })}>
          {pauseChoiceText(t, choice)}
        </MenuItem>
      ))}
    </Menu>
  );
}

const TOOL_MARK: Record<string, string> = {
  git: "git",
  java: "openjdk",
  androidSdk: "android",
  adb: "android",
  xcode: "apple",
};
const TOOL_ORDER = ["java", "androidSdk", "adb", "git", "xcode", "node", "maestro", "scrcpy"];

/** The toolchains a computer reports, as chips with their official marks ("JDK 21", "Git 2.47"). */
function Toolchains({ tools }: { tools: Record<string, string> }) {
  const { t } = useTranslation();
  const say = t as unknown as (key: string, options: Record<string, string>) => string;
  // The Apple Account that signs the iPhone helper is no tool: the iPhone guide shows it.
  const found = Object.keys(tools)
    .filter((k) => k !== "appleTeam")
    .sort((a, b) => TOOL_ORDER.indexOf(a) - TOOL_ORDER.indexOf(b));
  return (
    <span className="dv-tools">
      {found.map((k) => {
        const version = tools[k] ?? "";
        // The SDK reports its folder, not a version.
        const shown = /[/\\]/.test(version) ? "" : version;
        const mark = TOOL_MARK[k];
        return (
          <Chip key={k} lead={mark ? <ProviderLogo id={mark} size="xs" /> : undefined}>
            {say(`devices.tools.${TOOL_ORDER.includes(k) ? k : "other"}`, { version: shown, name: k }).trim()}
          </Chip>
        );
      })}
    </span>
  );
}

/**
 * An OS permission the computer waits on: what and where, that it is allowed in the agentes.chat app there (the only
 * place it can be), and which agent asked it for what.
 */
function PermissionWait({ need, computer }: { need: PermissionNeed; computer: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const agents = useDirectory(org.id).agentById;
  const words = permissionWaitLines(t, need, computer, need.agentId ? agents.get(need.agentId)?.name : undefined);
  return (
    <Alert tone="neutral" icon="lock" className="dv-permission">
      <strong className="dv-permission__title">{words.title}</strong>
      {words.next}
      {words.asked && <small className="dv-permission__asked">{words.asked}</small>}
    </Alert>
  );
}

/**
 * A computer someone connected: its state and one action, facts and toolchains; who can use it, how many tasks at once
 * and whether it belongs to the workspace; the phones it reaches; then its folders and tools; Remove. The workspace
 * computer keeps its own page.
 */
function ComputerPage({ machineId }: { machineId: string }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const devices = useDevices(org.id);
  const machines = useMachines(org.id);
  const auth = useAuthConfig();
  const update = useUpdateComputer(org.id);
  const back = useBackToList();
  const [renaming, setRenaming] = useState<DeviceTarget | null>(null);
  const [removing, setRemoving] = useState<DeviceTarget | null>(null);
  const [connect, setConnect] = useState<ConnectStart | null>(null);
  if (devices.isLoading) return <LoadingList count={2} trailing />;
  if (devices.isError && !devices.data)
    return <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />;
  const d = devices.data?.devices.find((x) => x.id === machineId);
  if (!d) return <NotFound />;
  if (d.machineKind === "managed") return <MachinePage machineId={machineId} />;
  const machine = machines.data?.find((m) => m.id === machineId);
  // The computer's own events patch the machines list at once (a pause, going offline): the line follows them.
  const status: ComputerDevice["status"] =
    machine && isPaused(machine)
      ? { kind: "paused", until: machine.paused?.until ?? null }
      : machine && !machine.online && d.status.kind !== "offline"
        ? {
            kind: "offline",
            lastSeenAt: machine.lastSeenAt,
            ...(machine.offlineCause ? { cause: machine.offlineCause } : {}),
          }
        : d.status;
  const owner = d.ownerUserId === me.user.id;
  const admin = can(org, "configure");
  const lending = lendingDevice(devices.data?.devices);
  const internet = d.shareInternet;
  // Someone else's lends now: its owner may pick this one instead (on again moves it first).
  const mayPick = internet?.on === true && !internet.inUse && lending !== null && owner;
  const helpOff = devices.data?.devicesHelp === false;
  const tasksEditable = mayChangeTasks(d, me.user.id, admin);
  const pausedFromApps = status.kind === "paused" ? pausedByText(t, i18n.language, machine?.paused, me.user.id) : null;
  const pausable = machine?.canManage && machine.online ? machine : null;
  const save = (input: Parameters<typeof update.mutate>[0], done?: string) =>
    update.mutate(input, {
      onSuccess: () => done && toast.show(done),
      onError: (err) => toast.show(errorText(t, err), "error"),
    });
  const target: DeviceTarget = { kind: "computer", device: d };
  // This server's own computer stops being used here (and can be again), it isn't removed.
  const host = d.machineKind === "host";
  const removeWords = host ? t("machines.host.stop") : t("devices.remove");
  // At a glance when it was last seen while offline; its system, size, toolchains, way out and folder are behind
  // "Detalhes".
  const facts =
    d.status.kind === "offline" && d.lastSeenAt
      ? [{ label: t("devices.facts.lastSeen"), value: clockAt(i18n.language, d.lastSeenAt) }]
      : [];
  const processor = processorText(t, d);
  const more = [
    { label: t("devices.facts.system"), value: systemText(t, d) },
    ...(processor
      ? [
          {
            label: t("devices.facts.cpu"),
            value: processor.cores ? (
              <Tip tip={processor.cores} look="ac-msg__tip" tabIndex={0}>
                {processor.name}
                <span className="ac-visually-hidden">, {processor.cores}</span>
              </Tip>
            ) : (
              processor.name
            ),
          },
        ]
      : []),
    ...(d.memoryGb ? [{ label: t("devices.facts.memory"), value: t("devices.memory", { gb: d.memoryGb }) }] : []),
    ...(Object.keys(d.toolchains).length > 0
      ? [{ label: t("devices.facts.toolchains"), value: <Toolchains tools={d.toolchains} />, wide: true }]
      : []),
  ];
  return (
    <>
      <BackToDevices />
      <Card aria-labelledby="dv-page-title">
        <Head
          device={d}
          chips={
            <>
              <OwnerChip userId={d.belongsToWorkspace ? null : d.ownerUserId} />
              <StatusPill status={status} />
            </>
          }
          onRename={d.mayManage ? () => setRenaming(target) : undefined}
          menu={
            (pausable || d.mayManage) && (
              <span className="row dv-headacts">
                {pausable && <PauseControl machine={pausable} paused={status.kind === "paused"} />}
                {d.mayManage && (
                  <Menu
                    align="end"
                    label={t("devices.menu", { name: d.name })}
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="more"
                        aria-label={t("devices.menu", { name: d.name })}
                      />
                    }
                  >
                    <MenuItem icon="edit" onSelect={() => setRenaming(target)}>
                      {t("devices.rename")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={host ? "block" : "trash"} danger onSelect={() => setRemoving(target)}>
                      {removeWords}
                    </MenuItem>
                  </Menu>
                )}
              </span>
            )
          }
        />
        <StatusLine
          status={status}
          text={
            pausedFromApps ?? (status.kind === "busy" && !d.maintenance ? taskLimitLine(t, d, tasksEditable) : null)
          }
          maintenance={d.maintenance}
          cli={terminalInstall(machine)}
        />
        {(d.permissions ?? []).map((need) => (
          <PermissionWait key={need.permission} need={need} computer={d.name} />
        ))}
        {pausable && !pausable.remotePause && <span className="small muted">{t("machines.remotePause.outdated")}</span>}
        {machine?.canManage && machine.update && (
          <>
            <span className="small muted">{t(`machines.runnerBehind.${machine.update}`, { computer: d.name })}</span>
            {machine.update === "command" && <CommandBlock command={RUNNER_UPDATE_COMMAND} />}
          </>
        )}
        {machine?.canManage && doctorShown(status, machine) && (
          <Disclosure summary={t("devices.technical.title")}>
            <span className="small muted">{t("devices.technical.doctor")}</span>
            <CommandBlock command={RUNNER_DOCTOR_COMMAND} />
          </Disclosure>
        )}
        {facts.length > 0 && <Facts facts={facts} />}
        {status.kind === "paused" && !pausedFromApps && <span className="small muted">{t("machines.pausedHint")}</span>}
        <Disclosure summary={t("common.details")}>
          <Facts facts={more} />
          {machine && <MachineFactsExtra machine={machine} />}
          {d.systemMode ? (
            <p className="ac-setnote ac-iconline">
              <Icon name="code" size={14} />
              <span>{t("machines.agentUsers")}</span>
            </p>
          ) : null}
        </Disclosure>
        {machine && <MachineAgents machine={machine} />}
      </Card>
      {/* Who may change it: its owner and the admins. Everyone else reads. */}
      {!d.mayManage && <ReadOnlyNote userId={d.ownerUserId} />}
      <Card aria-label={t("devices.sharing")}>
        <div className="settings-rows">
          <WhoCanUseRow
            key={d.id}
            idPrefix="dv-pc"
            value={d.audience}
            ownerUserId={d.ownerUserId}
            editable={d.mayManage}
            narrowOnly={!owner}
            hint={t("devices.who.computerHint")}
            onChange={(audience: DeviceAudience) => save({ id: d.id, audience })}
          />
          {/* Tasks start on room there: what's running and what still fits, and the owner's Push harder. */}
          {d.taskRoom && (
            <PrefRow
              id="dv-pc-tasks"
              icon="layers"
              label={t("devices.maxTasks")}
              hint={t("devices.tasksAutoHint")}
              status={tasksAutoText(t, d)}
            />
          )}
          {d.taskRoom && tasksEditable && d.machineKind === "connected" && (
            <PrefRow
              id="dv-pc-push"
              icon="power"
              label={t("devices.pushHarder")}
              hint={t("devices.pushHarderHint")}
              control={
                <Switch
                  id="dv-pc-push-switch"
                  checked={d.taskRoom.pushHarder}
                  // The computer applies it: offline, nothing would.
                  disabled={status.kind === "offline"}
                  onCheckedChange={(on) => save({ id: d.id, pushHarder: on })}
                />
              }
            />
          )}
          {/* Only once the computer says its limit: a guess here would be a setting that changes nothing. */}
          {!d.taskRoom && d.maxTasks !== null && (
            <PrefRow
              id="dv-pc-tasks"
              icon="layers"
              label={t("devices.maxTasks")}
              hint={t("devices.maxTasksHint")}
              control={
                <Select
                  size="sm"
                  align="end"
                  aria-label={t("devices.maxTasks")}
                  // The computer applies it: offline, nothing would.
                  disabled={!tasksEditable || status.kind === "offline"}
                  value={String(d.maxTasks)}
                  onValueChange={(v) => save({ id: d.id, maxTasks: Number(v) })}
                  // The value it has stays a choice even when it isn't one of ours, so the select never shows empty.
                  options={taskChoices(d.maxTasks).map((n) => ({ value: String(n), label: String(n) }))}
                />
              }
            />
          )}
          {/* Its help, its owner's one choice: never, only as backup, or first for their own agents' work. The workspace's
              switch off wins. Never a server install's. */}
          {owner && d.machineKind === "connected" && !d.systemMode && (
            <PrefRow
              id="dv-pc-spill"
              icon="bolt"
              label={t("devices.helpUse")}
              hint={t(d.belongsToWorkspace ? "devices.helpUseTeamHint" : "devices.helpUseHint")}
              status={helpOff ? t("devices.spillWorkspaceOff") : undefined}
              control={
                <Select
                  size="sm"
                  align="end"
                  aria-label={t("devices.helpUse")}
                  disabled={helpOff}
                  value={helpOff ? "off" : spillUseOf(d)}
                  onValueChange={(use) => save({ id: d.id, spill: spillOfUse(use) })}
                  options={SPILL_USES.map((use) => ({ value: use, label: t(`devices.helpUses.${use}`) }))}
                />
              }
            />
          )}
          {/* Someone else's computer: an admin may only turn its help off. */}
          {!owner && d.mayManage && d.machineKind === "connected" && !d.systemMode && (
            <PrefRow
              id="dv-pc-spill"
              icon="bolt"
              label={t("devices.spillOwn")}
              hint={t(d.belongsToWorkspace ? "devices.spillTeamHint" : "devices.spillOwnHint")}
              status={helpOff ? t("devices.spillWorkspaceOff") : undefined}
              control={
                <Switch
                  id="dv-pc-spill-switch"
                  checked={d.spill.own && !helpOff}
                  disabled={helpOff || !d.spill.own}
                  onCheckedChange={(own) => save({ id: d.id, spill: { own } })}
                />
              }
            />
          )}
          {/* Its owner lends its internet to the workspace's computer; an admin may only stop it (ADR 0237). */}
          {internet && (d.mayManage || internet.on) && (
            <PrefRow
              id="dv-pc-internet"
              icon="globe"
              label={t("devices.shareInternet")}
              hint={shareInternetHint(t, auth.data)}
              status={shareInternetText(t, d, lending)}
              {...(mayPick
                ? {
                    // Beside a button the row's words are no label: the switch names itself.
                    actions: (
                      <>
                        <Button size="sm" onClick={() => save({ id: d.id, shareInternet: true })}>
                          {t("devices.shareInternetPick")}
                        </Button>
                        <Switch
                          id="dv-pc-internet-switch"
                          aria-label={t("devices.shareInternet")}
                          checked
                          onCheckedChange={(on) => save({ id: d.id, shareInternet: on })}
                        />
                      </>
                    ),
                  }
                : {
                    control: (
                      <Switch
                        id="dv-pc-internet-switch"
                        checked={internet.on}
                        disabled={!d.mayManage || (!owner && !internet.on)}
                        onCheckedChange={(on) => save({ id: d.id, shareInternet: on })}
                      />
                    ),
                  })}
            />
          )}
          {/* Under the switch while it lends: nothing of the agents' goes their usual way, AI calls included. Its
              owner's to turn on, as the switch is; an admin may only turn it off. */}
          {internet?.on && internet.only !== undefined && (d.mayManage || internet.only) && (
            <PrefRow
              id="dv-pc-internet-only"
              nested
              label={t("devices.shareInternetOnly")}
              hint={t("devices.shareInternetOnlyHint")}
              control={
                <Switch
                  id="dv-pc-internet-only-switch"
                  checked={internet.only}
                  disabled={!d.mayManage || (!owner && !internet.only)}
                  onCheckedChange={(on) => save({ id: d.id, internetOnly: on })}
                />
              }
            />
          )}
          {admin && d.machineKind === "connected" && (
            <PrefRow
              id="dv-pc-belongs"
              icon="members"
              label={t("devices.belongs")}
              hint={t("devices.belongsHint")}
              status={<ConnectedBy userId={d.ownerUserId} />}
              control={
                <Switch
                  id="dv-pc-belongs-switch"
                  checked={d.belongsToWorkspace}
                  onCheckedChange={(on) => save({ id: d.id, belongsToWorkspace: on })}
                />
              }
            />
          )}
        </div>
      </Card>
      {d.phones.length > 0 ? (
        <Card aria-labelledby="dv-pc-phones">
          <CardHeader id="dv-pc-phones" icon="phone" title={t("devices.phonesHere")} />
          <List className="dv-list" role="list" aria-label={t("devices.phonesHere")}>
            {d.phones.map((p) => (
              <DeviceRowView
                key={p.id}
                row={{ kind: "phone", device: p, host: d, nested: false }}
                onHostPage
                onFix={(phone) => setConnect({ step: phone.platform === "ios" ? "iphone" : "android", hostId: d.id })}
                onRename={setRenaming}
                onRemove={setRemoving}
              />
            ))}
          </List>
          <WifiIphoneOffer host={d} />
        </Card>
      ) : (
        <WifiIphoneOffer host={d} card />
      )}
      {machine && <MachineAccessCards machine={machine} />}
      {d.mayManage && (
        <div>
          <Button size="sm" variant="danger" icon={host ? "block" : "trash"} onClick={() => setRemoving(target)}>
            {removeWords}
          </Button>
        </div>
      )}
      <DeviceRenameDialog target={renaming} onClose={() => setRenaming(null)} />
      <DeviceRemoveDialog
        target={removing}
        onClose={() => setRemoving(null)}
        onRemoved={removing?.kind === "computer" ? back : undefined}
      />
      <ConnectDialog start={connect} onClose={() => setConnect(null)} />
    </>
  );
}

function ReadOnlyNote({ userId }: { userId: string | null }) {
  const { t } = useTranslation();
  const owner = useOwner(userId);
  return (
    <p className="page__note">
      {owner ? t("machines.page.readOnly", { name: owner.name }) : t("machines.page.readOnlyNobody")}
    </p>
  );
}

function ConnectedBy({ userId }: { userId: string | null }) {
  const { t } = useTranslation();
  const owner = useOwner(userId);
  return owner ? t("devices.connectedBy", { name: owner.name }) : null;
}

/**
 * A phone a computer reaches: its state (Stop while an agent uses it), facts, who can use it (an iPhone follows its
 * Mac), Forget.
 */
function PhonePage({ phoneId }: { phoneId: string }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const devices = useDevices(org.id);
  const update = useUpdatePhone(org.id);
  const stop = useStopPhone(org.id);
  const power = usePowerAction();
  const back = useBackToList();
  const [renaming, setRenaming] = useState<DeviceTarget | null>(null);
  const [removing, setRemoving] = useState<DeviceTarget | null>(null);
  const [connect, setConnect] = useState<ConnectStart | null>(null);
  if (devices.isLoading) return <LoadingList count={2} trailing />;
  if (devices.isError && !devices.data)
    return <ErrorState error={devices.error} onRetry={() => void devices.refetch()} />;
  const found = findPhone(devices.data?.devices, phoneId);
  if (!found) return <NotFound />;
  const { phone: p, host } = found;
  const target: DeviceTarget = { kind: "phone", device: p };
  const owner = p.ownerUserId === me.user.id;
  const powers = powerChoice(p);
  // A person in control gives it back on its screen instead.
  const canStop =
    p.status.kind === "in_use" &&
    personInControl(p.status) !== me.user.id &&
    (p.mayManage || p.status.userId === me.user.id);
  const action =
    p.status.kind === "in_use" && canStop ? (
      <Button
        size="sm"
        icon="stop"
        loading={stop.isPending}
        disabled={stop.isPending}
        onClick={() =>
          stop.mutate(p.id, {
            onSuccess: () => toast.show(t("devices.stopped", { name: p.name })),
            onError: (err) => toast.show(errorText(t, err), "error"),
          })
        }
      >
        {t("devices.stop")}
      </Button>
    ) : p.status.kind === "needs_you" && p.mayManage ? (
      <Button
        size="sm"
        onClick={() => setConnect({ step: p.platform === "ios" ? "iphone" : "android", hostId: host.id })}
      >
        {t("devices.showMe")}
      </Button>
    ) : powers ? (
      <Button
        size="sm"
        icon={powers === "start" ? "play" : "power"}
        loading={power.pending}
        disabled={power.pending}
        onClick={() => power.run(p, powers === "start")}
      >
        {t(powers === "start" ? "devices.power.start" : "devices.power.stop")}
      </Button>
    ) : undefined;
  const link = phoneLink(t, p);
  // An iPhone over Wi-Fi is let go, not forgotten: it comes back only if picked again.
  const forgetWords = iphoneOverWifi(p) ? t("devices.iphone.wifi.stop") : t("devices.forget");
  const facts = [
    { label: t("devices.facts.system"), value: phoneSystem(t, p) },
    { label: t("devices.facts.model"), value: p.model },
    ...(link ? [{ label: t("devices.facts.connection"), value: link }] : []),
  ];
  return (
    <>
      <BackToDevices />
      <Card aria-labelledby="dv-page-title">
        <Head
          device={p}
          chips={
            <>
              <OwnerChip userId={p.ownerUserId} />
              <StatusPill status={p.status} />
              <Link
                to="/org/$orgId/settings/devices/$deviceId"
                params={{ orgId: org.id, deviceId: host.id }}
                className="ac-chip dv-chiplink"
              >
                <Icon name="computer" size={14} />
                <span className="ac-chip__text">{t("devices.onHostChip", { host: host.name })}</span>
              </Link>
            </>
          }
          onRename={p.mayManage ? () => setRenaming(target) : undefined}
          menu={
            p.mayManage && (
              <Menu
                align="end"
                label={t("devices.menu", { name: p.name })}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="more"
                    aria-label={t("devices.menu", { name: p.name })}
                  />
                }
              >
                <MenuItem icon="edit" onSelect={() => setRenaming(target)}>
                  {t("devices.rename")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon="trash" danger onSelect={() => setRemoving(target)}>
                  {forgetWords}
                </MenuItem>
              </Menu>
            )
          }
        />
        <StatusLine status={p.status} host={host.name} hostOs={host.os} action={action} ios={iosOf(p)} />
        <Facts facts={facts} />
      </Card>
      <PhoneLive key={p.id} phone={p} host={host.name} />
      <Card aria-label={t("devices.sharing")}>
        <div className="settings-rows">
          {p.audience ? (
            <WhoCanUseRow
              key={p.id}
              idPrefix="dv-phone"
              value={p.audience}
              ownerUserId={p.ownerUserId}
              editable={p.mayManage}
              narrowOnly={!owner}
              hint={t("devices.who.phoneHint", { host: host.name })}
              onChange={(audience) =>
                update.mutate({ id: p.id, audience }, { onError: (err) => toast.show(errorText(t, err), "error") })
              }
            />
          ) : (
            <PrefRow
              id="dv-phone-who"
              icon="link"
              label={t("devices.who.title")}
              hint={t("devices.who.followsHint")}
              value={
                <Link
                  to="/org/$orgId/settings/devices/$deviceId"
                  params={{ orgId: org.id, deviceId: host.id }}
                  className="ac-link"
                >
                  {t("devices.who.sameAs", { host: host.name })}
                </Link>
              }
            />
          )}
        </div>
      </Card>
      {p.mayManage && (
        <div>
          <Button size="sm" variant="danger" icon="trash" onClick={() => setRemoving(target)}>
            {forgetWords}
          </Button>
        </div>
      )}
      <DeviceRenameDialog target={renaming} onClose={() => setRenaming(null)} />
      <DeviceRemoveDialog target={removing} onClose={() => setRemoving(null)} onRemoved={back} />
      <ConnectDialog start={connect} onClose={() => setConnect(null)} />
    </>
  );
}
