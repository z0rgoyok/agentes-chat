import type { Machine, ScopeGrant } from "@agenteschat/client";
import {
  BROWSER_TOOL_SCOPE,
  isOpenHandoff,
  keys,
  machineProfiles,
  useAgentsBrowserHandoffs,
  useAllAgents,
  useAllowMachineTool,
  useApi,
  useAskMachineFolder,
  useBrowserHandoffMutations,
  useBrowserProfileMutations,
  useBrowserProfiles,
  useComputerSetup,
  useMachineAction,
  useMachinePause,
  useMachines,
  useReduceMachineAccess,
} from "@agenteschat/client";
import { computerName, setupView } from "@agenteschat/client/lib/computer";
import {
  maintenanceDetails,
  maintenanceLine,
  maintenanceOf,
  maintenanceShort,
} from "@agenteschat/client/lib/computer-maintenance";
import {
  doctorShown,
  mayChangeTasks,
  offlineCauseText,
  processorText,
  RUNNER_DOCTOR_COMMAND,
  RUNNER_UPDATE_COMMAND,
  systemText,
  taskLimitLine,
  terminalInstall,
} from "@agenteschat/client/lib/devices";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt, firstName, formatTime, joinNames } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  allowedFolders,
  allowsInApp,
  canReduceAccess,
  codexSandboxNote,
  commandInReason,
  computerKind,
  computerState,
  egressOfflineText,
  egressViaText,
  folderName,
  hostDescKey,
  isPaused,
  MACHINE_TOOLS,
  machineReasonText,
  oneClickTerminal,
  PAUSE_CHOICES,
  pauseChoiceText,
  pausedByText,
  pauseUntil,
  profileRefusalLine,
  profileToolOff,
  profileUnavailable,
  sharedFolderFacts,
  sharedFolderOf,
  toolOnCommand,
  toolOneClick,
} from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { SHARED_SEAT, screenId } from "@agenteschat/client/lib/seat";
import { helpUrl } from "@agenteschat/client/lib/server";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { countryFlagSvg } from "@agenteschat/ui/brand/flags";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { ComputerPortrait } from "@/computer/ComputerPortrait";
import { useOrg } from "@/providers/org";
import {
  Button,
  Chip,
  EmptyState,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  Icon,
  type IconName,
  ProviderLogo,
  SkeletonList,
  Text,
  useToast,
} from "@/ui";
import { router } from "@/ui/navigation";
import { openPage } from "../ai/parts";
import { openComputer } from "../computer/AgentComputerRow";
import { ComputerSection } from "../devices/ComputerSection";
import { findDevice } from "../devices/logic";
import { PermissionWaits, StatusLine } from "../devices/parts";
import { useDevices } from "../devices/queries";
import { MachineToolButton } from "../devices/ToolOneClick";
import { AgentFace } from "../shared/Face";
import { LoadFailed } from "../shared/FirstUse";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { FocusLive, goBack, successHaptic } from "../shared/parts";
import { TextArea } from "../shared/TextArea";
import { DESKTOP_TURN_ON, grantCommand, osOf, pauseText, type Reduce, reduceTexts, seenText } from "./logic";
import {
  CommandBlock,
  chooseAction,
  confirmAction,
  Gap,
  SettingsPage,
  TerminalFallback,
  useUnsavedGuard,
} from "./parts";

/**
 * One computer, as the web's page: its portrait and state (online, paused, who connected it) and what it is; the
 * agents that use it (each opens its page; Abrir shows its computer to whoever may watch it); then what it allows:
 * the folders and who uses each, its tools, the agents' browser, apps on the agents' screens, and how to allow more
 * (only ever on the computer itself). Admins and whoever connected it take things away, rename or remove it;
 * everyone else reads. The workspace's own computer (ADR 0056 §10) shows its size and its help page instead. Its
 * portrait and the agents at work hold still while a screen it opened is over it.
 */
export function MachineScreen({ machineId }: { machineId: string }) {
  return (
    <FocusLive>
      <MachinePage machineId={machineId} />
    </FocusLive>
  );
}

function MachinePage({ machineId }: { machineId: string }) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const api = useApi();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const machines = useMachines(orgId);
  const askReduce = useAskReduce(machineId);
  const action = useMachineAction(orgId);
  const pause = useMachinePause(orgId);
  const meId = useMeId();
  const setupQ = useComputerSetup(orgId);
  const setup = setupView(setupQ.data, setupQ.dataUpdatedAt);
  const m = machines.data?.find((x) => x.id === machineId);
  // Its state, who can use it and its phones (`GET …/devices`); the page reads without them while they load.
  const device = findDevice(useDevices().data?.devices, machineId)?.computer;
  // Each agent's screen as this person sees it (the agent page's cache): it answers only who may watch it.
  const desktops = useQueries({
    queries: (m?.agents ?? []).map((a) => ({
      queryKey: keys.agentDesktop(orgId, a.id),
      queryFn: () => api.desktop.status(orgId, a.id),
      retry: false,
    })),
  });
  // The right hand's shared place here (ADR 0175), for whoever may open it: its screen's state answers only them.
  const sharedOf = m?.agents.find((a) => a.id === m.sharedSeatOf);
  const sharedDesktop = useQuery({
    queryKey: keys.agentDesktop(orgId, screenId(sharedOf?.id ?? "", SHARED_SEAT)),
    queryFn: () => api.desktop.status(orgId, sharedOf?.id ?? "", SHARED_SEAT),
    enabled: Boolean(sharedOf),
    retry: false,
  });

  const [moreOpen, setMoreOpen] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  if (!m) {
    return (
      <SettingsPage title={t("machines.page.back")}>
        {machines.isLoading ? (
          <SkeletonList rows={4} />
        ) : machines.isError && !machines.data ? (
          <LoadFailed onRetry={() => void machines.refetch()} />
        ) : (
          <View style={styles.missing}>
            <EmptyState title={t("machines.page.notFound")} subtitle={t("machines.page.notFoundText")} />
          </View>
        )}
      </SettingsPage>
    );
  }

  const managed = m.kind === "managed";
  const title = computerName(t, org?.name ?? "", m, isPersonal(org));
  const paused = pauseText(t, i18n.language, m.paused);
  const askRemove = () => {
    const host = m.kind === "host";
    const name = m.name;
    confirmAction({
      title: host ? t("machines.host.stopTitle") : t("machines.removeTitle", { name }),
      text: host ? t("machines.host.stopText") : t("machines.removeText"),
      action: host ? t("machines.host.stop") : t("machines.remove"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        action.mutate(
          { machineId: m.id, action: "remove" },
          {
            onSuccess: () => {
              toast({ title: host ? t("machines.host.stopped") : t("machines.removed", { name }), icon: "check" });
              goBack();
            },
            onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
          },
        ),
    });
  };

  const setPause = (input: { until: string | null } | "resume") =>
    pause.mutate(
      { machineId: m.id, input },
      {
        onSuccess: () => {
          successHaptic();
          toast({
            title: t(input === "resume" ? "machines.remotePause.resumed" : "machines.remotePause.paused", {
              name: m.name,
            }),
            icon: "check",
          });
        },
        onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
      },
    );
  const askPause = () =>
    chooseAction(
      t("machines.remotePause.menu", { name: m.name }),
      PAUSE_CHOICES.map((choice) => ({
        label: pauseChoiceText(t, choice),
        onPress: () => setPause({ until: pauseUntil(choice) }),
      })),
      t("common.cancel"),
    );
  const pausedNow = isPaused(m);
  // Pause from here: whoever connected it and admins, while it's online; never the workspace's own computer.
  const pausable = m.canManage && m.online && !managed;

  // What we do to it (ADR 0257): away, said instead of offline; its line and details in the facts.
  const told = maintenanceOf(m);
  const away = !m.online && told?.away ? told : null;
  // One status word (the device's own line says it when there is one): paused outranks online.
  const status: { icon: IconName; label: string } | null = device
    ? null
    : paused
      ? { icon: "pause", label: paused }
      : m.online
        ? { icon: "check", label: t("machines.online") }
        : away
          ? { icon: "swap", label: maintenanceShort(t, away) }
          : { icon: "circle", label: t("machines.offline") };
  // One facts line, and why it's paused while it is.
  const facts = [
    managed
      ? [setup?.specs ? t("computerSetup.specs", setup.specs) : null, m.online ? null : seenText(t, i18n.language, m)]
          .filter(Boolean)
          .join(" · ")
      : seenText(t, i18n.language, m),
    isPaused(m) ? (pausedByText(t, i18n.language, m.paused, meId ?? "") ?? t("machines.pausedHint")) : null,
    told && (away || m.online)
      ? [maintenanceLine(t, told), ...maintenanceDetails(t, i18n.language, told)].join(" ")
      : null,
  ].filter((x): x is string => Boolean(x));
  // What most people never need, behind one "Detalhes" row, as the web's: its system, processor and memory first.
  const processor = device ? processorText(t, device) : null;
  const specs = [
    managed
      ? null
      : { label: t("devices.facts.system"), value: device ? systemText(t, device) : t(`machines.os.${osOf(m.os)}`) },
    processor ? { label: t("devices.facts.cpu"), value: processor.name, note: processor.cores } : null,
    !managed && device?.memoryGb
      ? { label: t("devices.facts.memory"), value: t("devices.memory", { gb: device.memoryGb }) }
      : null,
  ].filter((x) => x !== null);
  const details = [
    m.kind === "host" ? t(`machines.host.${hostDescKey(m.os)}`) : null,
    managed ? t("computerSetup.users") : null,
    !managed && m.runnerVersion ? t("machines.versionShort", { version: m.runnerVersion }) : null,
    // System mode: each agent works in its own home, never in the folder the computer was connected from.
    m.mode === "system" && !managed && m.kind !== "host" ? t("machines.agentUsers") : null,
    managed && m.online && m.egressWaiting ? t("machines.egress.waiting") : null,
    egressOfflineText(t, m),
    egressViaText(t, m),
    managed && m.networkTransition
      ? t(m.networkTransition.state === "draining" ? "machines.egress.draining" : "machines.egress.restart", {
          when: formatTime(i18n.language, m.networkTransition.deadline),
        })
      : null,
    m.workspace && m.mode !== "system" ? `${t("machines.workspace")} ${m.workspace}` : null,
    m.pairedBy ? t("machines.pairedBy", { name: m.pairedBy.name }) : null,
  ].filter((x): x is string => Boolean(x));
  // Offline with a known cause: the sentence with its way out, in place of the row's short words.
  const s = device?.status;
  const causeLine =
    s?.kind === "offline" && s.cause && s.lastSeenAt
      ? offlineCauseText(t, s.cause, clockAt(i18n.language, s.lastSeenAt), "line", terminalInstall(m))
      : device
        ? taskLimitLine(t, device, mayChangeTasks(device, meId ?? "", can(org, "configure")))
        : null;
  const egressIp = managed && m.online ? (m.egress?.ip ?? null) : null;
  const flag = egressIp ? countryFlagSvg(m.egress?.country) : null;

  return (
    <SettingsPage title={title}>
      <View style={styles.head}>
        <ComputerPortrait kind={computerKind(m.os)} state={computerState(m)} size={96} />
        {device ? <StatusLine status={device.status} center text={causeLine} /> : null}
        {status ? (
          <View style={styles.chips}>
            <Chip icon={status.icon} label={status.label} />
          </View>
        ) : null}
        {facts.map((line) => (
          <Text key={line} variant="small" tone="muted" style={styles.center}>
            {line}
          </Text>
        ))}
      </View>

      {device?.permissions?.length ? (
        <>
          <Gap />
          <PermissionWaits device={device} />
        </>
      ) : null}

      {m.canManage && m.update ? (
        <>
          <Gap />
          <GroupedFooter>{t(`machines.runnerBehind.${m.update}`, { computer: title })}</GroupedFooter>
          {m.update === "command" ? (
            <>
              <Gap />
              <CommandBlock command={RUNNER_UPDATE_COMMAND} />
            </>
          ) : null}
        </>
      ) : null}

      {m.canManage && doctorShown(s, m) ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={techOpen ? "up" : "down"}
              label={t("devices.technical.title")}
              onPress={() => setTechOpen((o) => !o)}
            />
          </GroupedList>
          {techOpen ? (
            <>
              <GroupedFooter>{t("devices.technical.doctor")}</GroupedFooter>
              <Gap />
              <CommandBlock command={RUNNER_DOCTOR_COMMAND} />
            </>
          ) : null}
        </>
      ) : null}

      {specs.length > 0 || details.length > 0 || egressIp ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={moreOpen ? "up" : "down"}
              label={t("common.details")}
              onPress={() => setMoreOpen((o) => !o)}
            />
            {moreOpen
              ? specs.map((f) => (
                  <GroupedRow key={f.label} label={f.label} value={f.value} valueNote={f.note ?? undefined} />
                ))
              : null}
            {moreOpen ? details.map((line) => <GroupedRow key={line} label={line} labelLines={4} />) : null}
            {moreOpen && egressIp ? (
              <GroupedRow
                leading={
                  flag ? <SvgXml xml={flag} width={20} height={14} /> : <Icon name="globe" size={15} color={c.muted} />
                }
                label={t("machines.egress.line", { ip: egressIp })}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}

      {pausable ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon={pausedNow ? "play" : "pause"}
              label={t(pausedNow ? "machines.remotePause.resume" : "machines.remotePause.button")}
              {...(m.remotePause ? {} : { sub: t("machines.remotePause.outdated"), subLines: 3 })}
              // Pausing lists how long in the app's short menu: the three dots of a row that opens one.
              {...(pausedNow ? {} : { more: true })}
              disabled={!m.remotePause || pause.isPending}
              onPress={pausedNow ? () => setPause("resume") : askPause}
            />
          </GroupedList>
        </>
      ) : null}

      {device ? <ComputerSection device={device} name={title} /> : null}

      {m.agents.length > 0 ? (
        <>
          <GroupedHeader>{t("machines.page.agents")}</GroupedHeader>
          <GroupedList>
            {m.agents.flatMap((a, i) => {
              // What this agent may use here, beyond its own folder (only who may see the access knows).
              const folders = m.access?.folders.filter((f) => f.agents.includes(a.id)).map((f) => folderName(f.path));
              const line =
                folders && (folders.length > 0 || !managed)
                  ? folders.length > 0
                    ? t("machines.page.agentFolders", {
                        ...agentGrammar(a.name),
                        folders: joinNames(folders, t),
                      })
                    : t("machines.page.agentOwnFolder", agentGrammar(a.name))
                  : null;
              const agentRow = (
                <GroupedRow
                  key={a.id}
                  leading={<AgentFace agentId={a.id} size={30} live={false} />}
                  label={a.name}
                  sub={[`@${a.handle}`, line].filter(Boolean).join(" · ")}
                  subLines={2}
                  chevron
                  onPress={() => router.push(`/agent/${a.id}`)}
                />
              );
              // Abrir: the agent's computer, full screen, for whoever may watch it (its screen's state answers them;
              // anyone else gets a refusal), as on the agent's page. A row of its own, so screen readers reach it.
              if (!desktops[i]?.isSuccess) return [agentRow];
              return [
                agentRow,
                <GroupedRow
                  key={`${a.id}:computer`}
                  icon="laptop"
                  label={t("agentComputer.title", agentGrammar(a.name))}
                  value={t("agentComputer.open")}
                  chevron
                  onPress={() => router.push(`/computer/${a.id}`)}
                />,
              ];
            })}
            {sharedOf && sharedDesktop.isSuccess ? (
              <GroupedRow
                icon="laptop"
                label={t(
                  "agentComputer.title",
                  agentGrammar(sharedOf.name, t("rightHand.sharedName", { name: sharedOf.name })),
                )}
                sub={t("rightHand.sharedPlace")}
                subLines={4}
                value={t("agentComputer.open")}
                chevron
                onPress={() => openComputer(sharedOf.id, SHARED_SEAT)}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}
      {/* Nobody in the workspace changes what its own computer allows, admins included. */}
      {!m.canManage && !managed ? (
        <GroupedFooter>
          {m.pairedBy ? t("machines.page.readOnly", { name: m.pairedBy.name }) : t("machines.page.readOnlyNobody")}
        </GroupedFooter>
      ) : null}

      {managed ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="help"
              label={t("computers.about")}
              chevron
              onPress={() => openPage(helpUrl("workspace-computer", i18n.language))}
            />
          </GroupedList>
        </>
      ) : (
        <>
          <FoldersSection machine={m} />
          <ToolsSection machine={m} onReduce={askReduce} />
          <BrowserSection machine={m} onTurnOff={() => askReduce({ kind: "tool", tool: "browser" })} />
          <ProfilesSection machine={m} />
          <DesktopUseSection machine={m} />
          <GrantSection machine={m} />
        </>
      )}

      {m.canManage ? (
        <>
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="pen"
              label={t("machines.rename")}
              chevron
              onPress={() => router.push({ pathname: "/settings/computers/rename", params: { machineId: m.id } })}
            />
            {/* The workspace's own computer stays: people rename it, never remove it. */}
            {!managed ? (
              <GroupedRow
                icon={m.kind === "host" ? "stop" : "x"}
                label={m.kind === "host" ? t("machines.host.stop") : t("machines.remove")}
                labelLines={2}
                danger
                disabled={action.isPending}
                onPress={askRemove}
              />
            ) : null}
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Confirms, then takes something away on the computer (granting happens only on the computer itself). */
function useAskReduce(machineId: string) {
  const { t } = useTranslation();
  const toast = useToast();
  const reduceAccess = useReduceMachineAccess(useOrgId());
  return (reduce: Reduce, done?: () => void) => {
    const r = reduceTexts(t, reduce);
    confirmAction({
      title: r.title,
      text: r.text,
      action: r.action,
      cancel: t("common.cancel"),
      onConfirm: () =>
        reduceAccess.mutate(
          { machineId, ...r.input },
          {
            onSuccess: () => {
              successHaptic();
              toast({ title: r.done, icon: "check" });
              done?.();
            },
            onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
          },
        ),
    });
  };
}

/** An agent's name: from the workspace's agents, else from the computer's list. */
function useAgentName(m: Pick<Machine, "agents"> | undefined) {
  const agents = useAllAgents(useOrgId());
  return (id: string) => agents.data?.find((a) => a.id === id)?.name ?? m?.agents.find((a) => a.id === id)?.name ?? "";
}

/**
 * Pastas liberadas: each folder and who uses it; for who manages the computer, a folder opens its own screen to take
 * it away (the web's menu, with a row per agent).
 */
function FoldersSection({ machine: m }: { machine: Machine }) {
  const { t, i18n } = useTranslation();
  const nameOf = useAgentName(m);
  const access = m.access;
  const shared = sharedFolderOf(access);
  const folders = allowedFolders(access);
  const reduces = canReduceAccess(m);
  const open = (path: string) =>
    router.push({ pathname: "/settings/computers/folder", params: { machineId: m.id, path } });
  return (
    <>
      <GroupedHeader>{t("machines.access.folders")}</GroupedHeader>
      {!access ? (
        // The server shows the folders only to admins and whoever connected it.
        <GroupedFooter>{m.canManage ? t("machines.access.noReport") : t("machines.access.hidden")}</GroupedFooter>
      ) : (
        <>
          <GroupedList>
            <GroupedRow
              icon="lock"
              label={t("machines.access.ownFolder")}
              sub={t("machines.access.ownFolderText")}
              subLines={2}
              media
            />
            {shared ? (
              <GroupedRow
                icon="members"
                label={t("machines.shared.title")}
                sub={shared}
                subLines={2}
                media
                below={
                  <Text variant="caption" tone="faint" numberOfLines={4}>
                    {`${t("machines.shared.text")} ${sharedFolderFacts(t, i18n.language, m.disk)}`}
                  </Text>
                }
              />
            ) : null}
            {folders.map((f) => (
              <GroupedRow
                key={f.path}
                icon="drive"
                label={folderName(f.path)}
                sub={f.path}
                subLines={2}
                media
                below={
                  <Text variant="caption" tone="faint" numberOfLines={2}>
                    {f.agents.length > 0 ? joinNames(f.agents.map(nameOf), t) : t("machines.access.nobody")}
                  </Text>
                }
                chevron={reduces}
                {...(reduces ? { onPress: () => open(f.path) } : {})}
              />
            ))}
          </GroupedList>
          {folders.length === 0 ? <GroupedFooter>{t("machines.access.noFolders")}</GroupedFooter> : null}
        </>
      )}
    </>
  );
}

/**
 * Ferramentas: on or off; who manages the computer turns one off here, whoever connected it turns one on too; never on
 * the workspace's own.
 */
function ToolsSection({ machine: m, onReduce }: { machine: Machine; onReduce: (r: Reduce) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const allow = useAllowMachineTool(useOrgId());
  // Whoever connected it turns an off tool on with a tap too (ADR 0036 §8).
  const allows = toolOneClick(m, useMeId())?.kind === "allow";
  const access = m.access;
  if (!access) return null;
  const reduces = canReduceAccess(m);
  const turnOn = (tool: (typeof MACHINE_TOOLS)[number]) =>
    allow.mutate(
      { machineId: m.id, tool },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("machines.oneClick.done", { machine: m.name }) });
        },
        onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
      },
    );
  return (
    <>
      {/* How the rows work, behind the header's ⓘ: the list ends on its rows. */}
      <GroupedHeader
        {...(allows || (reduces && MACHINE_TOOLS.some((tool) => access.tools[tool]))
          ? {
              hint: {
                name: t("common.about", { label: t("machines.access.tools") }),
                text: allows ? t("mobile.settings.machine.toolsHowOwner") : t("mobile.settings.machine.toolsHow"),
              },
            }
          : {})}
      >
        {t("machines.access.tools")}
      </GroupedHeader>
      <GroupedList>
        {MACHINE_TOOLS.map((tool) => {
          const on = access.tools[tool];
          const sub = [
            t(`machines.access.toolText.${tool}`),
            tool === "commands" && on ? t("machines.access.commandsWarn") : null,
          ]
            .filter(Boolean)
            .join(" ");
          const label = t(`machines.access.tool.${tool}`);
          // Codex on Windows: what holds its commands there, when that is less than MXC.
          const note = tool === "codex" ? codexSandboxNote(t, m) : null;
          return (
            <GroupedRow
              key={tool}
              {...(tool === "commands"
                ? { icon: "code" as const }
                : { leading: <ProviderLogo id={tool} size="sm" off={!on} /> })}
              label={label}
              {...(note ? { hint: { name: t("common.about", { label }), text: note } } : {})}
              sub={sub}
              subLines={3}
              media
              value={on ? t("machines.access.on") : t("machines.access.off")}
              {...(on && reduces
                ? { onPress: () => onReduce({ kind: "tool", tool }) }
                : !on && allows && !allow.isPending
                  ? { onPress: () => turnOn(tool) }
                  : {})}
            />
          );
        })}
      </GroupedList>
    </>
  );
}

/**
 * Perfis do navegador (ADR 0110), read-only: each profile, free or who uses it, and how many agents may. "Fazer
 * login" (for who may drive it) takes control and opens its live view. Creating, choosing agents and deleting stay
 * on the web.
 */
function ProfilesSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const dir = useDirectory();
  const profiles = useBrowserProfiles(orgId);
  const actions = useBrowserProfileMutations(orgId);
  const allow = useAllowMachineTool(orgId);
  const mine = machineProfiles(profiles.data, m);
  if (mine.length === 0) return null;
  const drive = can(org, "manage_connectors") && can(org, "control_browsers");
  const fail = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  // A refusal with a cause asks with its one way out (as the web's line under the row); anything else is a toast.
  const refused = (profileId: string, err: unknown) => {
    const off = profileToolOff(err);
    const title = profileRefusalLine(t, err);
    if (off?.oneClick?.kind === "allow")
      return chooseAction(
        title,
        [
          {
            label: t("browser.profiles.loginOn"),
            onPress: () =>
              allow.mutate(
                { machineId: off.machineId, tool: off.tool },
                {
                  onSuccess: () => {
                    toast({ title: t("browser.profiles.turningOn", { machine: off.machineName }) });
                    login(profileId);
                  },
                  onError: fail,
                },
              ),
          },
        ],
        t("common.cancel"),
      );
    if (off?.oneClick?.kind === "ask") {
      const name = firstName(off.oneClick.ownerName);
      return chooseAction(
        title,
        [
          {
            label: t("machines.oneClick.ask", { name }),
            onPress: () =>
              allow.mutate(
                { machineId: off.machineId, tool: off.tool, ask: true },
                { onSuccess: () => toast({ title: t("machines.oneClick.asked", { name }) }), onError: fail },
              ),
          },
        ],
        t("common.cancel"),
      );
    }
    if (off?.oneClick?.kind === "outdated")
      return toast({ title, subtitle: t("machines.oneClick.outdated", { machine: off.machineName }), icon: "x" });
    if (profileUnavailable(err))
      return chooseAction(title, [{ label: t("common.retry"), onPress: () => login(profileId) }], t("common.cancel"));
    toast({ title, icon: "x" });
  };
  const login = (profileId: string) =>
    actions.takeover.mutate(profileId, {
      onSuccess: () => router.push(`/browser-profile/${profileId}`),
      onError: (err) => refused(profileId, err),
    });
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("browser.profiles.title") }), text: t("browser.profiles.sub") }}
      >
        {t("browser.profiles.title")}
      </GroupedHeader>
      <GroupedList>
        {mine.map((p) => (
          <GroupedRow
            key={p.id}
            icon="globe"
            label={p.name}
            sub={
              p.holder
                ? t("browser.profiles.inUsePerson", {
                    name:
                      p.holder.type === "agent"
                        ? dir.nameOf({ type: "agent", id: p.holder.agentId })
                        : dir.nameOf({ type: "person", id: p.holder.userId }),
                  })
                : t("browser.profiles.free")
            }
            value={t("browser.profiles.agents", { count: p.agentIds.length })}
            {...(drive
              ? {
                  more: true,
                  onPress: () =>
                    chooseAction(
                      p.name,
                      [{ label: t("browser.profiles.login"), onPress: () => login(p.id) }],
                      t("common.cancel"),
                    ),
                }
              : {})}
          />
        ))}
      </GroupedList>
    </>
  );
}

/**
 * Navegador (ADR 0040): whether the agents' browser is ready here, which agents are in it with a person now (Ver,
 * Parar), and which agents may use it. Turning it on happens on the computer; here it is only turned off.
 */
function BrowserSection({ machine: m, onTurnOff }: { machine: Machine; onTurnOff: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const toast = useToast();
  const orgId = useOrgId();
  const oneClick = toolOneClick(m, useMeId());
  const actions = useBrowserHandoffMutations(orgId);
  const agentIds = m.agents.map((a) => a.id);
  const handoffs = useAgentsBrowserHandoffs(orgId, agentIds);
  const scopes = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.scopes(orgId, id),
      queryFn: () => api.scopes.get(orgId, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const settings = useQueries({
    queries: agentIds.map((id) => ({
      queryKey: keys.agentBrowser(orgId, id),
      queryFn: () => api.browser.settings(orgId, id),
      retry: false,
      enabled: m.canManage,
    })),
  });
  const access = m.access;
  if (!access && !m.browser) return null;
  const switchedOn = access?.tools.browser === true;
  const ready = switchedOn && m.browser?.available === true;
  const command = commandInReason(m.browser?.reason);
  const status = ready ? "ready" : !switchedOn ? "off" : command ? "needsCommand" : "notReady";
  const uses = m.agents.flatMap((a, i) => {
    const h = handoffs[i];
    return h && isOpenHandoff(h) ? [{ agent: a, open: h }] : [];
  });
  const allowed = m.agents.flatMap((a, i) => {
    const grants = scopes[i]?.data as ScopeGrant[] | undefined;
    if (!grants?.some((g) => g.connectionId === null && g.scope === BROWSER_TOOL_SCOPE)) return [];
    return [{ agent: a, domains: settings[i]?.data?.allowedDomains ?? null }];
  });
  const stop = (agentId: string, name: string) => {
    const g = agentGrammar(name);
    confirmAction({
      title: t("browser.machine.stopConfirm", g),
      action: t("browser.machine.stop"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        actions.stop.mutate(agentId, {
          onSuccess: () => toast({ title: t("browser.machine.stopped", g), icon: "check" }),
          onError: () => toast({ title: t("browser.live.actionFailed"), icon: "x" }),
        }),
    });
  };
  const use = (agentId: string, name: string) =>
    chooseAction(
      name,
      [
        { label: t("browser.machine.see"), onPress: () => router.push(`/computer/${agentId}`) },
        { label: t("browser.machine.stop"), destructive: true, onPress: () => stop(agentId, name) },
      ],
      t("common.cancel"),
    );
  return (
    <>
      <GroupedHeader>{t("browser.title")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="globe"
          label={t(`browser.machine.${status}`)}
          {...(ready && m.browser?.chrome ? { value: m.browser.chrome } : {})}
        />
        {switchedOn && canReduceAccess(m) ? (
          <GroupedRow icon="x" label={t("browser.machine.turnOffLabel")} labelLines={2} danger onPress={onTurnOff} />
        ) : null}
      </GroupedList>
      {!switchedOn && oneClick && oneClick.kind !== "outdated" ? (
        <>
          <GroupedFooter>
            {oneClick.kind === "ask"
              ? t("browser.profiles.toolOffOther", { name: firstName(oneClick.ownerName) })
              : t("browser.profiles.toolOff")}
          </GroupedFooter>
          <Gap />
          <MachineToolButton machine={m} tool="browser" />
          <TerminalFallback command={oneClickTerminal(m, oneClick, ["browser"])} />
        </>
      ) : !switchedOn ? (
        allowsInApp(m.os) ? (
          <GroupedFooter>{t("browser.machine.offHelp")}</GroupedFooter>
        ) : (
          // A Linux computer may be a server without the app: the command too.
          <>
            <GroupedFooter>
              {t("common.joinSentences", { a: t("browser.machine.offHelp"), b: t("machines.access.grantTerminal") })}
            </GroupedFooter>
            <Gap />
            <CommandBlock command={toolOnCommand(m, "browser")} />
          </>
        )
      ) : null}
      {switchedOn && !ready && m.browser?.reason ? (
        <>
          <GroupedFooter>{machineReasonText(t, m.browser)}</GroupedFooter>
          {command ? (
            <>
              <Gap />
              <CommandBlock command={command} />
            </>
          ) : null}
        </>
      ) : null}
      {ready ? (
        <>
          <GroupedHeader>{t("browser.machine.inUse")}</GroupedHeader>
          {uses.length === 0 ? (
            <GroupedFooter>{t("browser.machine.nobody")}</GroupedFooter>
          ) : (
            <GroupedList>
              {uses.map(({ agent, open }) => {
                const g = agentGrammar(agent.name);
                const waiting = open.status === "pending";
                return (
                  <GroupedRow
                    key={agent.id}
                    leading={<AgentFace agentId={agent.id} size={30} mode={waiting ? "idle" : "think"} />}
                    label={waiting ? t("browser.machine.waiting", g) : t("browser.machine.helping", g)}
                    labelLines={2}
                    {...(open.kind === "ask" && open.instructions ? { sub: open.instructions } : {})}
                    subLines={2}
                    media
                    {...(waiting ? { value: t("browser.machine.waitingChip") } : {})}
                    more
                    onPress={() => use(agent.id, agent.name)}
                  />
                );
              })}
            </GroupedList>
          )}
        </>
      ) : null}
      {m.canManage ? (
        <>
          <GroupedHeader
            hint={{ name: t("common.about", { label: t("browser.machine.who") }), text: t("browser.machine.whoHelp") }}
          >
            {t("browser.machine.who")}
          </GroupedHeader>
          {allowed.length > 0 ? (
            <GroupedList>
              {allowed.map(({ agent, domains }) => (
                <GroupedRow
                  key={agent.id}
                  leading={<AgentFace agentId={agent.id} size={30} live={false} />}
                  label={agent.name}
                  sub={
                    domains?.length
                      ? t("browser.machine.whoOnly", { sites: domains.join(", ") })
                      : t("browser.machine.whoAny")
                  }
                  subLines={2}
                  media
                />
              ))}
            </GroupedList>
          ) : null}
          {/* Nobody yet: what to do now, under the header. */}
          {allowed.length > 0 ? null : (
            <GroupedFooter>
              {t("common.joinSentences", { a: t("browser.machine.whoNone"), b: t("browser.machine.whoHelp") })}
            </GroupedFooter>
          )}
        </>
      ) : null}
    </>
  );
}

/**
 * Each agent's own screen, on a Linux computer (ADR 0062): whether agents can use apps on their own screens here; when
 * not, the computer's own words on what is missing with the command in them; or the two switches to turn on. Not on a
 * Mac or Windows computer, where it can't apply, nor on the workspace's own computer.
 */
function DesktopUseSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const oneClick = toolOneClick(m, useMeId());
  const use = m.desktopUse;
  if (!use || m.os !== "linux") return null;
  const off = use.available && !(m.access?.tools.desktop && m.access.tools.commands);
  const desktopOff = (["desktop", "commands"] as const).filter((tool) => m.access?.tools[tool] !== true);
  const reason = use.available ? null : machineReasonText(t, use, "desktop_use_install");
  const command = use.available ? null : commandInReason(use.reason);
  return (
    <>
      <GroupedHeader
        hint={{ name: t("common.about", { label: t("desktop.use.title") }), text: t("desktop.use.description") }}
      >
        {t("desktop.use.title")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="laptop"
          label={!use.available ? t("desktop.use.unavailable") : off ? t("desktop.use.off") : t("desktop.use.ready")}
        />
      </GroupedList>
      {off && oneClick && oneClick.kind !== "outdated" ? (
        <>
          <GroupedFooter>{t("desktop.use.offOne")}</GroupedFooter>
          <Gap />
          <View style={styles.oneClicks}>
            {oneClick.kind === "ask" ? (
              <MachineToolButton machine={m} tool={desktopOff} />
            ) : (
              desktopOff.map((tool) => <MachineToolButton key={tool} machine={m} tool={tool} />)
            )}
          </View>
          <TerminalFallback command={oneClickTerminal(m, oneClick, desktopOff)} />
        </>
      ) : off ? (
        <>
          <GroupedFooter>{t("desktop.use.offHelp")}</GroupedFooter>
          <Gap />
          <CommandBlock command={DESKTOP_TURN_ON} />
        </>
      ) : null}
      {reason ? (
        <>
          <GroupedFooter>{reason}</GroupedFooter>
          {command ? (
            <>
              <Gap />
              <CommandBlock command={command} />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * "Para liberar mais", as the web's: granting happens on the computer. Where the agentes.chat app runs it, "Liberar
 * uma pasta" asks the app there to open the system's folder picker for whoever is at it; elsewhere how to do it
 * there, the command folded as the way without the app.
 */
function GrantSection({ machine: m }: { machine: Machine }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ask = useAskMachineFolder(useOrgId());
  // A folder allowed there (picked, or any other way, a folder already allowed given to more agents too) ends the wait.
  const folders = JSON.stringify(m.access?.folders ?? []);
  const [askedAt, setAskedAt] = useState<string | null>(null);
  const waiting = askedAt !== null && askedAt === folders;
  // In system mode the runner's settings are root's (ADR 0057): allowing takes the computer's administrator.
  const system = m.mode === "system";
  const app = allowsInApp(m.os);
  return (
    <>
      <GroupedHeader>{t("machines.access.grantTitle")}</GroupedHeader>
      {m.canManage && m.folderPick ? (
        <>
          <GroupedFooter>
            {waiting
              ? t("machines.access.pickWaiting", { machine: m.name })
              : t("machines.access.pickText", { machine: m.name })}
          </GroupedFooter>
          <Gap />
          <Button
            variant="primary"
            wide
            label={t("machines.access.pick")}
            loading={ask.isPending}
            onPress={() =>
              ask.mutate(
                { machineId: m.id },
                {
                  onSuccess: () => {
                    setAskedAt(folders);
                    toast({ title: t("machines.access.picked", { machine: m.name }), icon: "check" });
                  },
                  onError: (err) => toast({ title: errorText(t, err), icon: "x" }),
                },
              )
            }
          />
        </>
      ) : m.canManage ? (
        <>
          <GroupedFooter>
            {app
              ? t("machines.access.grantText")
              : system
                ? t("machines.access.grantTextAdmin")
                : t("machines.access.grantTextTerminal")}
          </GroupedFooter>
          <TerminalFallback
            command={grantCommand(m, t("machines.access.pathPlaceholder"), t("machines.access.agentPlaceholder"))}
            label={t("machines.access.grantTerminalMore")}
          />
        </>
      ) : (
        <GroupedFooter>
          {m.pairedBy
            ? t("machines.access.grantOnlyOwner", { name: m.pairedBy.name })
            : t("machines.page.readOnlyNobody")}
        </GroupedFooter>
      )}
    </>
  );
}

/**
 * A folder a computer allows, pushed over its page (the web's folder menu, as a screen): who uses it, each one taken
 * off it on their own, or the folder taken away for everyone. Allowing it again happens only on the computer itself.
 */
export function FolderScreen({ machineId, path }: { machineId: string; path: string }) {
  const { t } = useTranslation();
  const machines = useMachines(useOrgId());
  const m = machines.data?.find((x) => x.id === machineId);
  const nameOf = useAgentName(m);
  const askReduce = useAskReduce(machineId);
  const grant = m?.access?.folders.find((f) => f.path === path);
  const folder = folderName(path);
  return (
    <SettingsPage title={folder}>
      <GroupedFooter>{path}</GroupedFooter>
      {machines.isLoading ? <SkeletonList rows={2} /> : null}
      {machines.isError && !machines.data ? <LoadFailed onRetry={() => void machines.refetch()} /> : null}
      {grant && m && canReduceAccess(m) ? (
        <>
          <GroupedHeader>{t("machines.access.usedBy", { folder })}</GroupedHeader>
          {grant.agents.length > 0 ? (
            <GroupedList>
              {grant.agents.map((id) => (
                <GroupedRow
                  key={id}
                  leading={<AgentFace agentId={id} size={30} live={false} />}
                  label={nameOf(id)}
                  // The row's ×: this agent alone off the folder (the system's confirmation first).
                  remove={{
                    label: t("machines.access.remove"),
                    onPress: () => askReduce({ kind: "folder", path, agent: { id, name: nameOf(id) } }),
                  }}
                />
              ))}
            </GroupedList>
          ) : (
            <GroupedFooter>{t("machines.access.nobody")}</GroupedFooter>
          )}
          <Gap />
          <GroupedList>
            <GroupedRow
              icon="x"
              label={t("machines.access.removeAll")}
              danger
              onPress={() => askReduce({ kind: "folder", path }, goBack)}
            />
          </GroupedList>
        </>
      ) : null}
    </SettingsPage>
  );
}

/** Renomear, pushed over a computer's page: its name (how people and agents see it); "Salvar" saves and goes back. */
export function RenameMachineScreen({ machineId }: { machineId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const orgId = useOrgId();
  const machines = useMachines(orgId);
  const action = useMachineAction(orgId);
  const m = machines.data?.find((x) => x.id === machineId);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = name ?? m?.name ?? "";
  const clean = value.trim();
  const ready = Boolean(m) && clean.length > 0 && clean !== m?.name && !action.isPending;
  // Back with a new name not saved asks first.
  const leave = useUnsavedGuard(Boolean(m) && name !== null && clean !== m?.name);
  const save = () => {
    if (!m || !ready) return;
    action.mutate(
      { machineId: m.id, action: "rename", name: clean },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("machines.renamed", { name: clean }), icon: "check" });
          leave();
          goBack();
        },
        onError: (err) => setError(errorText(t, err)),
      },
    );
  };
  return (
    <SettingsPage
      title={t("machines.renameTitle")}
      action={{ label: t("common.save"), disabled: !ready, onPress: save }}
      locked={action.isPending}
    >
      <GroupedHeader hint={{ name: t("common.about", { label: t("machines.name") }), text: t("machines.nameHelp") }}>
        {t("machines.name")}
      </GroupedHeader>
      <TextArea
        value={value}
        onChangeText={(v) => {
          setName(v);
          setError(null);
        }}
        multiline={false}
        minHeight={50}
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={save}
        accessibilityLabel={t("machines.name")}
      />
      {error ? (
        <Text variant="footnote" tone="danger" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  oneClicks: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  missing: { paddingTop: 40 },
  head: { alignItems: "center", gap: 8, paddingTop: 10, paddingBottom: 6, paddingHorizontal: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6, paddingBottom: 2 },
  center: { textAlign: "center" },
  error: { paddingTop: 8, paddingHorizontal: 16 },
});
