import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import type {
  AppNotification,
  AuthConfig,
  ComputerDevice,
  ComputerMaintenance,
  ConnectLinkState,
  DeviceAudience,
  DeviceStatus,
  DevicesList,
  MachineOfflineCause,
  MachineTool,
  OrgSummary,
  PermissionNeed,
  PhoneDevice,
  WifiPairing,
} from "../api/types";
import { DESKTOP_CLOSE, type DesktopMode, type DesktopRetry } from "../desktop";
import { type SocketBase, socketUrl } from "../realtime/connection";
import { selfHosted } from "./about";
import { computerNameOf } from "./computer";
import { LEGACY_MOVE, maintenanceLine, maintenanceOf, maintenanceShort, maintenanceWhen } from "./computer-maintenance";
import { clockAt, firstName, joinNames } from "./format";
import { computerKind, osName } from "./machines";
import { norm as fold } from "./tool-review";
import { isPersonal } from "./workspace-mode";

/**
 * Bring your own devices: the words, pictures and order the web and phone apps give the devices list
 * (`GET /devices`), the connect flows and the device notices. Platform-neutral.
 */

/** `t` for a key built from a code (a reason, a system): the keys exist, the type can't list them. */
const say = (t: TFunction, key: string, options?: Record<string, unknown>) =>
  (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);

// ── Status ───────────────────────────────────────────────────────────────────

/** One look per state, the same on every screen (the pill's `data-status`). */
export type StatusLook = "ready" | "inuse" | "busy" | "needs" | "preparing" | "paused" | "offline" | "unsupported";

export const statusLook = (s: DeviceStatus): StatusLook =>
  s.kind === "in_use"
    ? "inuse"
    : s.kind === "needs_you"
      ? "needs"
      : s.kind === "moving"
        ? "preparing"
        : s.kind === "busy" || s.kind === "preparing" || s.kind === "paused" || s.kind === "offline"
          ? s.kind
          : s.kind === "unsupported"
            ? "unsupported"
            : "ready";

/** The pill's words: the state only ("In use by Lia", "Busy 1/1"); the rest goes beside it (`statusDetail`). */
export function statusPill(t: TFunction, s: DeviceStatus): string {
  switch (s.kind) {
    case "in_use": {
      // A person in control of its screen has no agent: the pill names them.
      const name = s.agentName ?? (s.agentId === null && s.userName ? firstName(s.userName) : null);
      return name ? t("devices.status.inUseBy", { name }) : t("devices.status.inUse");
    }
    case "busy":
      return s.max === null
        ? t("devices.status.busyRunning", { running: s.running })
        : t("devices.status.busy", { running: s.running, max: s.max });
    case "needs_you":
      return t("devices.status.needs");
    case "preparing":
      return t("devices.status.preparing");
    case "paused":
      return t("devices.status.paused");
    case "moving":
      return maintenanceShort(t, maintenanceOf(s) ?? LEGACY_MOVE);
    case "offline":
      return t("devices.status.offline");
    case "unsupported":
      return t("devices.status.unsupported");
    default:
      return t("devices.status.ready");
  }
}

/** Why an iPhone used over Wi-Fi can't be reached now: the guide words each in full (`devices.iphone.wifiState`). */
export const IPHONE_WIFI_REASONS = ["wifi_away", "wifi_asleep", "tunnel_down", "wifi_untrusted"] as const;
export type IphoneWifiReason = (typeof IPHONE_WIFI_REASONS)[number];
export const isIphoneWifiReason = (reason: string | null | undefined): reason is IphoneWifiReason =>
  (IPHONE_WIFI_REASONS as readonly string[]).includes(reason ?? "");

/** An iPhone its Mac reaches over Wi-Fi, through CoreDevice's tunnel (picked by the Mac's owner). */
export const iphoneOverWifi = (p: { platform: string; transport: string | null }) =>
  p.platform === "ios" && p.transport === "wifi";

/**
 * Ligar or Desligar on a simulator or an emulator, for who may use or change it: start one that is offline while its
 * computer is online, shut down one that runs and nobody holds. Null for a real phone, or nothing to do.
 */
export function powerChoice(p: Pick<PhoneDevice, "phoneKind" | "status" | "mayUse" | "mayManage">) {
  if (p.phoneKind === "device" || !(p.mayUse || p.mayManage)) return null;
  if (p.status.kind === "offline") return p.status.withHost ? null : "start";
  return p.status.kind === "in_use" ? null : "stop";
}

/** A reason code the apps word (`devices.reason.<code>`); a code they don't know reads as a generic line. */
const REASONS = new Set([
  "locked",
  "unauthorized",
  "untrusted",
  "developer_mode_off",
  "ui_automation_off",
  "xcode_missing",
  "xcode_too_old",
  "ios_behind_xcode",
  "device_support",
  "helper_missing",
  "helper_expired",
  "apple_account_missing",
  "apple_team_missing",
  "ui_not_authorized",
  "team_limit",
  "helper_untrusted",
  "booting",
  "no_driver",
  "os_too_old",
  "adb_offline",
  ...IPHONE_WIFI_REASONS,
]);
/** A reason's key. A phone with no driver reads by the host's system: Windows wants its maker's driver, Linux udev rules. */
const reasonKey = (reason: string, os?: string | null) =>
  !REASONS.has(reason)
    ? "other"
    : reason === "no_driver" && os && computerKind(os) === "linux"
      ? "no_driverLinux"
      : reason;

/** Why it isn't ready, as a sentence ("Developer Mode is off"). `os`: the host's, for words that depend on it. */
export const reasonText = (t: TFunction, reason: string, os?: string | null) =>
  say(t, `devices.reason.${reasonKey(reason, os)}`);

/** What to do about it, phrased as the action ("Turn on Developer Mode"). */
export const fixText = (t: TFunction, reason: string, os?: string | null) =>
  say(t, `devices.fix.${reasonKey(reason, os)}`);

/**
 * `hostOs`: the host's system, which a phone with no driver reads by. `ios`: an iPhone's iOS version, which its
 * "too old" line names.
 */
type StatusOptions = {
  host?: string | null;
  hostOs?: string | null;
  now?: Date;
  ios?: string | null;
  /** The computer's `maintenance`: while it works (a move's copy), the line says it may be slower. */
  maintenance?: ComputerMaintenance | null;
  /** Installed from the Terminal, not run by the app (`terminalInstall`): a stopped one is started again there. */
  cli?: boolean;
};

/** An iPhone's iOS version, for `StatusOptions.ios`. */
export const iosOf = (d: ComputerDevice | PhoneDevice) =>
  "platform" in d && d.platform === "ios" ? d.osVersion : null;

/** The version a "too old" line names: devicectl gives none for some iPhones below iOS 17. */
export const tooOldVersion = (t: TFunction, version: string) => version || t("devices.iphone.tooOldVersion");

/**
 * The quiet line under a row's pill: "for Rui since 14:10", "last seen 14:02", "with Ana's iMac", "until 18:00";
 * for Needs you the fix itself ("Turn on Developer Mode"). Null when the pill says it all.
 */
export function statusDetail(
  t: TFunction,
  locale: string,
  s: DeviceStatus,
  options: StatusOptions = {},
): string | null {
  const now = options.now ?? new Date();
  switch (s.kind) {
    case "in_use":
      return s.userName && s.agentId !== null
        ? t("devices.detail.forSince", { name: firstName(s.userName), time: clockAt(locale, s.since, now) })
        : t("devices.detail.since", { time: clockAt(locale, s.since, now) });
    case "needs_you":
      return fixText(t, s.reason, options.hostOs);
    case "preparing":
      return reasonKey(s.reason) === "other" ? null : reasonText(t, s.reason);
    case "paused":
      return s.until ? t("devices.detail.until", { time: clockAt(locale, s.until, now) }) : null;
    case "offline":
      if (s.withHost && options.host) return t("devices.detail.withHost", { host: options.host });
      if (s.cause && s.lastSeenAt) return offlineCauseText(t, s.cause, clockAt(locale, s.lastSeenAt, now), "detail");
      return s.lastSeenAt ? t("devices.detail.lastSeen", { time: clockAt(locale, s.lastSeenAt, now) }) : null;
    case "unsupported":
      return s.reason === "os_too_old" && options.ios != null
        ? t("devices.reason.iosTooOld", { version: tooOldVersion(t, options.ios) })
        : reasonText(t, s.reason);
    case "moving":
      return maintenanceWhen(t, maintenanceOf(s) ?? LEGACY_MOVE, now);
    // The row's column is narrow: the word alone, its line behind the row's ⓘ.
    default:
      return options.maintenance && !options.maintenance.away ? maintenanceShort(t, options.maintenance) : null;
  }
}

/**
 * The device page's line under its chips: the reason in words, never a bare code. Null when the pill says it all (ready,
 * busy with its count), so the page shows no line then.
 */
export function statusSentence(
  t: TFunction,
  locale: string,
  s: DeviceStatus,
  options: StatusOptions = {},
): string | null {
  const now = options.now ?? new Date();
  switch (s.kind) {
    case "needs_you":
      return reasonText(t, s.reason, options.hostOs);
    case "moving":
      return maintenanceLine(t, maintenanceOf(s) ?? LEGACY_MOVE, now);
    case "offline":
      if (s.withHost && options.host) return t("devices.line.offlineWithHost", { host: options.host });
      if (s.cause && s.lastSeenAt)
        return offlineCauseText(t, s.cause, clockAt(locale, s.lastSeenAt, now), "line", options.cli);
      return s.lastSeenAt
        ? t("devices.line.offlineSeen", { time: clockAt(locale, s.lastSeenAt, now) })
        : t("devices.line.offline");
    case "busy":
    case "ready":
      return options.maintenance && !options.maintenance.away ? maintenanceLine(t, options.maintenance, now) : null;
    default:
      return statusDetail(t, locale, s, options);
  }
}

// ── Portraits and words ─────────────────────────────────────────────────────

export type DevicePortraitKind = "mac" | "windows" | "linux" | "android" | "iphone";
export type DevicePortraitState = "online" | "paused" | "offline";

/** The pixel portrait: the computer's own system, a phone by platform; dark offline, dimmed paused or needing you. */
export function portraitOf(d: ComputerDevice | PhoneDevice): { kind: DevicePortraitKind; state: DevicePortraitState } {
  const state: DevicePortraitState =
    d.status.kind === "offline"
      ? "offline"
      : d.status.kind === "paused" || ("platform" in d && d.status.kind === "needs_you")
        ? "paused"
        : "online";
  if ("platform" in d) return { kind: d.platform === "ios" ? "iphone" : "android", state };
  return { kind: d.machineKind === "managed" ? "linux" : computerKind(d.os), state };
}

/** What a device is called on screen: its name, or for this server's own computer before it names itself, that. */
export const deviceName = (t: TFunction, d: { name: string; machineKind?: string; hostname?: string }) =>
  d.name || (d.machineKind === "host" ? t("machines.host.label") : (d.hostname ?? ""));

export { osName };

/** A computer's system as its page says it: "macOS 26.1" when its runner said the version, else "macOS". */
export const systemText = (t: TFunction, d: Pick<ComputerDevice, "os" | "system">) => d.system || osName(t, d.os);

/**
 * A computer's processor as its page says it: its name ("Apple M4 Pro") with its count aside (a tooltip), or the count
 * alone when its runner is older and names no processor. Null when neither is known. `cpus` counts logical CPUs, so
 * without the physical cores it is said as threads: "8 cores, 16 threads" where both are known and differ, "14 cores"
 * where they match, "16 threads" where the runner said no cores (older, or Windows).
 */
export function processorText(
  t: TFunction,
  d: Pick<ComputerDevice, "cpus" | "cpuModel" | "cores">,
): { name: string; cores: string | null } | null {
  const threads = d.cpus ? t("devices.threads", { count: d.cpus }) : null;
  const cores = !d.cores
    ? threads
    : d.cores === d.cpus || !threads
      ? t("devices.cores", { count: d.cores })
      : `${t("devices.cores", { count: d.cores })}, ${threads}`;
  if (d.cpuModel) return { name: d.cpuModel, cores };
  return cores ? { name: cores, cores: null } : null;
}

/** "macOS 26.1 · 12 CPU · 36 GB"; the workspace computer says "Cloud" where a system would go. */
export function computerLine(t: TFunction, d: ComputerDevice): string {
  return [
    d.machineKind === "managed" ? t("devices.cloud") : osName(t, d.os),
    d.cpus ? t("devices.cpus", { count: d.cpus }) : null,
    d.memoryGb ? t("devices.memory", { gb: d.memoryGb }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── Tasks at once ────────────────────────────────────────────────────────────

/** The choices for a computer's tasks at once (`TASK_LIMIT_BOUNDS`), with the one it has when that isn't one of them. */
export const taskChoices = (current: number) =>
  [...new Set([1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, current])].sort((a, b) => a - b);

/** Who changes it: whoever connected the computer, or an admin on one nobody did (`updateComputerDevice`). */
export const mayChangeTasks = (d: ComputerDevice, viewerId: string, admin: boolean) =>
  d.machineKind !== "managed" && (d.ownerUserId === viewerId || (d.ownerUserId === null && admin));

/**
 * Under a busy computer's pill: its limit and where it changes, so a full one doesn't read as stuck. `maxTasks` null:
 * an app too old to say it or change it from here.
 */
export function taskLimitLine(t: TFunction, d: ComputerDevice, mayChange: boolean): string | null {
  if (d.status.kind !== "busy") return null;
  const room = d.taskRoom;
  if (room) {
    if (room.pushHarder) return t("devices.line.tasksPushing", { gb: room.freeGb });
    if (room.more > 0) return null;
    return room.cpuBusy ? t("devices.line.tasksNoCpu") : t("devices.line.tasksNoMemory", { gb: room.freeGb });
  }
  if (d.maxTasks === null) return t("devices.line.tasksUpdate", { max: d.status.max });
  return t(mayChange ? "devices.line.tasksChange" : "devices.line.tasksOwner", { max: d.maxTasks });
}

/** The Tasks at once row where tasks start on room: "Automatic · 3 running · room for about 8 more". */
export function tasksAutoText(t: TFunction, d: ComputerDevice): string | null {
  if (!d.taskRoom) return null;
  const running = d.status.kind === "busy" ? d.status.running : 0;
  return d.taskRoom.more > 0
    ? t("devices.tasksAutoRoom", { running, more: d.taskRoom.more })
    : t("devices.tasksAutoFull", { running });
}

/**
 * A permission a computer waits on, as the web and the phone say it: what and where, the next step (it is allowed in
 * the agentes.chat app on that computer, nowhere else), and who asked it for what (null: nothing said what).
 * `agent`: the asking agent's name.
 */
export function permissionWaitLines(t: TFunction, need: PermissionNeed, computer: string, agent?: string) {
  const permission = say(t, `devices.permission.names.${need.permission}`);
  const trigger = need.trigger;
  return {
    title: t("devices.permission.title", { permission, computer }),
    next: t("devices.permission.next"),
    asked: !trigger
      ? null
      : agent
        ? t("devices.permission.askedBy", { agent, trigger })
        : t("devices.permission.asked", { trigger }),
  };
}

/** How a computer helps its owner's agents: never, while their own computer is full or away, or first for their work. */
export const SPILL_USES = ["off", "help", "first"] as const;
export type SpillUse = (typeof SPILL_USES)[number];
export const spillUseOf = (d: Pick<ComputerDevice, "spill">): SpillUse =>
  d.spill.first ? "first" : d.spill.own ? "help" : "off";
export const spillOfUse = (use: SpillUse) => ({ own: use !== "off", first: use === "first" });

/** ADR 0237: people's computers here lend their internet, so a computer that joins does too (an older server: its own computer). */
export const lendsInternet = (list: Pick<DevicesList, "devices" | "lendsInternet"> | undefined): boolean =>
  list?.lendsInternet ?? list?.devices.some((d) => d.machineKind === "managed") === true;

/** The switch's hint: a self-hosted server's agents reach a lent internet only through proxy settings (ADR 0237). */
export const shareInternetHint = (t: TFunction, server: AuthConfig | undefined) =>
  t(selfHosted(server) ? "devices.shareInternetHintProxy" : "devices.shareInternetHint");

/** ADR 0237: whether a computer of `os` that joins lends its internet: not a Linux one where server boxes borrow. */
export const joinLends = (
  list: Pick<DevicesList, "devices" | "lendsInternet" | "serverBoxesBorrow"> | undefined,
  os: string,
) => lendsInternet(list) && !(list?.serverBoxesBorrow && os === "linux");

/**
 * ADR 0237, under "Agents use this computer's internet": in use now, or which computer the agents use instead (the
 * computer that lends now, `lending`, from the same list). Null: nothing to say.
 */
export function shareInternetText(t: TFunction, d: ComputerDevice, lending: ComputerDevice | null): string | null {
  if (!d.shareInternet?.on) return null;
  if (d.shareInternet.inUse) return t("devices.shareInternetInUse");
  return lending && lending.id !== d.id ? t("devices.shareInternetOther", { name: lending.name }) : null;
}

/** The computer of a devices list whose internet the workspace's computer uses now (ADR 0237), if any. */
export const lendingDevice = (devices: readonly ComputerDevice[] | undefined) =>
  devices?.find((x) => x.shareInternet?.inUse) ?? null;

/** A computer in the line's "More computers" list: "Online · macOS · 16 GB · your Claude Max plan" (`plan`: the viewer's there). */
export const spillDeviceText = (t: TFunction, d: ComputerDevice, plan: string | null) =>
  [statusPill(t, d.status), computerLine(t, d), plan && t("queue.spill.plan", { plan })].filter(Boolean).join(" · ");

/**
 * The line under a reply that thought on another computer because the agent's own was full or away (`meta.spilled`,
 * ADR 0233): "Thought on Bruno's MacBook: Acme's computer was full." The workspace's own computer reads in the
 * reader's words (`computerNameOf`). Null on any other reply.
 */
export function spilledText(
  t: TFunction,
  meta: Record<string, unknown> | null | undefined,
  org: Pick<OrgSummary, "name" | "mode"> | null | undefined,
): string | null {
  const s = meta?.spilled as { to?: unknown; from?: unknown; cause?: unknown } | undefined;
  if (!s || typeof s.to !== "string") return null;
  // Its owner chose that computer for their agents' work (`spill.first`): nothing was wrong with its own.
  if (s.cause === "chosen") return t("chat.spilled.chosen", { to: s.to });
  const from =
    typeof s.from === "string" && s.from
      ? computerNameOf(t, org?.name ?? "", s.from, isPersonal(org))
      : t("chat.spilled.itsComputer");
  return t(s.cause === "away" ? "chat.spilled.away" : "chat.spilled.full", { to: s.to, from });
}

/**
 * The computers that take an agent's new work while its own (`home`) is away (ADR 0233), as the server picks them
 * (`spillTarget`): online and helping in a workspace that lets them, never a server install, and its owner's own or
 * one marked the workspace's.
 */
export function helpingDevices(
  list: { devices: ComputerDevice[]; devicesHelp?: boolean } | undefined,
  agentOwner: string | null,
  home: string | null,
): ComputerDevice[] {
  if (!list || list.devicesHelp === false) return [];
  return list.devices.filter(
    (d) =>
      d.id !== home &&
      d.machineKind === "connected" &&
      !d.systemMode &&
      d.spill.own &&
      (d.status.kind === "ready" || d.status.kind === "busy") &&
      (d.belongsToWorkspace || (agentOwner !== null && d.ownerUserId === agentOwner)),
  );
}

/**
 * Under the agent's computer while it is away, appended to what the cover says (`help`): "Meanwhile, its new work
 * thinks on Bruno's MacBook." when computers help (`helpingDevices`), else `help` alone.
 */
export function withHelping(t: TFunction, help: string | undefined, helping: ComputerDevice[]): string | undefined {
  if (helping.length === 0) return help;
  const line = t("agentComputer.state.helping", {
    names: joinNames(
      helping.map((d) => d.name),
      t,
    ),
  });
  return help ? t("common.joinSentences", { a: help, b: line }) : line;
}

/** "Android 16" or "iOS 27.1". */
export const phoneSystem = (t: TFunction, p: Pick<PhoneDevice, "platform" | "osVersion">) =>
  t(p.platform === "ios" ? "devices.system.ios" : "devices.system.android", { version: p.osVersion });

/** How it's reached: "USB", "Wi-Fi", or what it is when it lives on the computer ("Emulator", "Simulator"). */
export function phoneLink(t: TFunction, p: Pick<PhoneDevice, "phoneKind" | "transport">): string | null {
  if (p.phoneKind !== "device") return say(t, `devices.phoneKind.${p.phoneKind}`);
  return p.transport === "usb" || p.transport === "wifi" ? say(t, `devices.transport.${p.transport}`) : null;
}

/** "Android 16 · USB"; with the host when the phone isn't nested under it ("iOS 27.1 · on Sam's MacBook Pro"). */
export function phoneLine(t: TFunction, p: PhoneDevice, host?: string | null): string {
  return [phoneSystem(t, p), phoneLink(t, p), host ? t("devices.onHost", { host }) : null].filter(Boolean).join(" · ");
}

export type AudienceIcon = "audienceEveryone" | "audiencePeople" | "audienceOwner" | "link";

const RANK = { owner: 0, people: 1, everyone: 2 } as const;

/**
 * Who may point their agents at it, short: "Everyone", "Only Sam", "2 people, 1 role", "Same as Sam's MacBook Pro"
 * (an iPhone follows its Mac, the only phone that does), and ", phone only" on a phone shared wider than its computer. A workspace device
 * nobody owns under "only the owner" reads as everyone, as the server applies it.
 */
export function audienceWords(
  t: TFunction,
  d: {
    audience: DeviceAudience | null;
    ownerName: string | null;
    belongsToWorkspace?: boolean;
    host?: { name: string; audience: DeviceAudience } | null;
    /** A list row's narrow column: "Same as its Mac" in place of the Mac's name. */
    short?: boolean;
  },
): { icon: AudienceIcon; text: string } {
  const a = d.audience;
  if (!a)
    return {
      icon: "link",
      text: d.short ? t("devices.who.sameAsMac") : t("devices.who.sameAs", { host: d.host?.name ?? "" }),
    };
  const mode = a.mode === "owner" && !d.ownerName && d.belongsToWorkspace ? "everyone" : a.mode;
  let text =
    mode === "everyone"
      ? t("devices.who.everyone")
      : mode === "owner"
        ? d.ownerName
          ? t("devices.who.only", { name: firstName(d.ownerName) })
          : t("devices.who.onlyOwner")
        : [
            a.userIds.length ? t("devices.who.people", { count: a.userIds.length }) : null,
            a.roleIds.length ? t("devices.who.roles", { count: a.roleIds.length }) : null,
          ]
            .filter(Boolean)
            .join(", ") || t("devices.who.onlyOwner");
  if (d.host && RANK[mode] > RANK[d.host.audience.mode]) text = t("devices.who.phoneOnly", { who: text });
  return {
    icon: mode === "everyone" ? "audienceEveryone" : mode === "owner" ? "audienceOwner" : "audiencePeople",
    text,
  };
}

/**
 * Whether a rule only narrows `from` to `to`: what an admin may do to someone's personal device. Mirrors
 * `narrowsAudience` in packages/engine/src/devices.ts.
 */
export function narrowsAudience(from: DeviceAudience, to: DeviceAudience): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return true;
  if (to.mode === "everyone") return false;
  if (from.mode === "owner") return false;
  return to.userIds.every((id) => from.userIds.includes(id)) && to.roleIds.every((id) => from.roleIds.includes(id));
}

/** The rule a new device gets when its maker lets it join: a server is everyone's, a person's computer theirs. */
export const defaultLinkAudience = (kind: "server" | "computer"): DeviceAudience => ({
  mode: kind === "server" ? "everyone" : "owner",
  userIds: [],
  roleIds: [],
});

export const sameAudience = (a: DeviceAudience, b: DeviceAudience) =>
  a.mode === b.mode &&
  (a.mode !== "people" ||
    (a.userIds.length === b.userIds.length &&
      a.roleIds.length === b.roleIds.length &&
      a.userIds.every((id) => b.userIds.includes(id)) &&
      a.roleIds.every((id) => b.roleIds.includes(id))));

// ── The list ────────────────────────────────────────────────────────────────

export type DeviceFilter = "all" | "computers" | "phones";

export type DeviceRow =
  | { kind: "computer"; device: ComputerDevice }
  /** `nested`: right under its host (All); else on its own with the host in its line (Phones, a search). */
  | { kind: "phone"; device: PhoneDevice; host: ComputerDevice | null; nested: boolean };

/** The workspace computer first, then the server's order. */
export const sortDevices = (list: readonly ComputerDevice[]) =>
  [...list].sort((a, b) => Number(b.machineKind === "managed") - Number(a.machineKind === "managed"));

export function deviceCounts(list: readonly ComputerDevice[]) {
  const phones = list.reduce((n, d) => n + d.phones.length, 0);
  return { all: list.length + phones, computers: list.length, phones };
}

const matches = (q: string, ...words: (string | null | undefined)[]) =>
  !q || words.some((w) => w && fold(w).includes(q));

/**
 * The rows the list shows: computers with their phones nested under them (All), only computers, or only phones.
 * A search keeps a computer whose phone matches, so the phone stays under its host.
 */
export function deviceRows(list: readonly ComputerDevice[], filter: DeviceFilter, query = ""): DeviceRow[] {
  const q = fold(query.trim());
  const rows: DeviceRow[] = [];
  for (const d of sortDevices(list)) {
    const self = matches(q, d.name, d.hostname, d.os);
    const phones = d.phones.filter((p) => self || matches(q, p.name, p.model));
    if (filter === "phones") {
      for (const p of phones) rows.push({ kind: "phone", device: p, host: d, nested: false });
      continue;
    }
    if (!self && phones.length === 0) continue;
    rows.push({ kind: "computer", device: d });
    if (filter === "all") for (const p of phones) rows.push({ kind: "phone", device: p, host: d, nested: true });
  }
  return rows;
}

/** A phone by id, with its host. */
export function findPhone(list: readonly ComputerDevice[] | undefined, phoneId: string) {
  for (const host of list ?? []) {
    const phone = host.phones.find((p) => p.id === phoneId);
    if (phone) return { phone, host };
  }
  return null;
}

// ── Connect links ───────────────────────────────────────────────────────────

/** How often the connect dialog asks about its link: every 2 s while a computer may still show up or ask. */
export const LINK_POLL_MS = 2000;

/** Where a link stands, the clock included: a link nobody used is expired at `expiresAt` even before the server says. */
export function linkPhase(
  state: Pick<ConnectLinkState, "status"> | undefined,
  expiresAt: string,
  now = Date.now(),
): ConnectLinkState["status"] {
  const status = state?.status ?? "waiting";
  return status === "waiting" && now >= new Date(expiresAt).getTime() ? "expired" : status;
}

export const linkPolls = (phase: ConnectLinkState["status"]) => phase === "waiting" || phase === "asking";

/** "build-box · Ubuntu 24.04 · 203.0.113.7 · Frankfurt": what a computer asking to join says about itself. */
export function joinFacts(
  t: TFunction,
  r: { hostname: string; os: string; arch: string; ip: string; location: string | null },
) {
  return [osName(t, r.os), r.arch || null, r.ip || null, r.location].filter(Boolean).join(" · ");
}

/**
 * Another computer, connected from the desktop app on it: the first computer of `userId`'s that wasn't in the list
 * when the screen opened (`known`). The app pairs it with the person's own session, so it shows up as theirs.
 */
export const newComputerOf = (
  list: readonly ComputerDevice[] | undefined,
  known: ReadonlySet<string>,
  userId: string | undefined,
) => (userId ? list?.find((d) => d.ownerUserId === userId && !known.has(d.id)) : undefined);

// ── Connect a phone ─────────────────────────────────────────────────────────

/**
 * Where plugging an Android phone into `host` stands, from what the computer reports: still looking, the computer
 * sees the phone but has no driver for it, the phone asks to allow USB debugging, or it's ready. Phones the computer
 * already had when the dialog opened (`known`) count only while they still wait for a driver or Allow.
 */
export type AndroidStage =
  | { kind: "looking" }
  | { kind: "driver"; phone: PhoneDevice }
  | { kind: "allow"; phone: PhoneDevice }
  | { kind: "ready"; phone: PhoneDevice };

const waitsOn = (p: PhoneDevice, reason: string) => p.status.kind === "needs_you" && p.status.reason === reason;

export function androidStage(host: ComputerDevice | undefined, known: ReadonlySet<string>): AndroidStage {
  const phones = (host?.phones ?? []).filter(
    (p) => p.platform === "android" && p.phoneKind === "device" && p.status.kind !== "offline",
  );
  const asking = phones.find((p) => waitsOn(p, "unauthorized"));
  if (asking) return { kind: "allow", phone: asking };
  const driverless = phones.find((p) => waitsOn(p, "no_driver"));
  if (driverless) return { kind: "driver", phone: driverless };
  const fresh = phones.find((p) => !known.has(p.id));
  if (fresh)
    return fresh.status.kind === "needs_you" ? { kind: "allow", phone: fresh } : { kind: "ready", phone: fresh };
  return { kind: "looking" };
}

/** The cable guide's steps, in order. */
export const ANDROID_STEPS = ["devOptions", "usbDebugging", "plug", "allow"] as const;
export type AndroidStep = (typeof ANDROID_STEPS)[number];
/** Steps done on the phone alone: the computer can't see them until the phone shows up, so the person ticks them. */
export const ANDROID_TICKABLE: ReadonlySet<AndroidStep> = new Set<AndroidStep>(["devOptions", "usbDebugging"]);

/**
 * The cable guide's checklist: each step done, the one to do now, or waiting. The person ticks the phone-only steps;
 * once the computer sees the phone in any state, every step before Allow is done by itself. `byHand`: ticked by the
 * person and not seen by the computer yet, so they may untick it. One step is open: the one asked for, else now's.
 */
export function androidSteps(
  stage: AndroidStage,
  ticked: ReadonlySet<AndroidStep>,
  asked: AndroidStep | null = null,
): { states: Record<AndroidStep, StepState>; now: AndroidStep; open: AndroidStep; byHand: ReadonlySet<AndroidStep> } {
  const seen = stage.kind !== "looking";
  const done = (s: AndroidStep) =>
    s === "allow"
      ? stage.kind === "ready"
      : s === "plug"
        ? stage.kind === "allow" || stage.kind === "ready"
        : seen || ticked.has(s);
  const now = ANDROID_STEPS.find((s) => !done(s)) ?? "allow";
  const states = Object.fromEntries(
    ANDROID_STEPS.map((s) => [s, done(s) ? "done" : s !== now ? "waiting" : seen ? "needs" : "current"]),
  ) as Record<AndroidStep, StepState>;
  const byHand = new Set(seen ? [] : ANDROID_STEPS.filter((s) => ANDROID_TICKABLE.has(s) && ticked.has(s)));
  return { states, now, open: asked ?? now, byHand };
}

/** How often an open phone guide asks its computer to look for a phone with no driver (it looks for a minute after). */
export const PHONE_LOOK_MS = 20_000;

/** How long the guide looks for a plugged phone before it says why one may not show up. */
export const ANDROID_SLOW_MS = 30_000;

/** The official pages for a phone maker's USB driver on Windows: Google's (Pixel), Samsung's, and the other makers'. */
export const ANDROID_USB_DRIVERS = {
  google: "https://developer.android.com/studio/run/win-usb",
  samsung: "https://developer.samsung.com/android-usb-driver",
  others: "https://developer.android.com/studio/run/oem-usb",
} as const;
/** Android's own page on udev rules, so Linux may open a phone. */
export const ANDROID_UDEV = "https://developer.android.com/studio/run/device#setting-up";

/** Why a plugged phone may not show up, as the checklist under the cable step says it; the driver only on Windows. */
export const androidNotShowing = (os: string | null | undefined) => [
  "cable" as const,
  "unlocked" as const,
  "fileTransfer" as const,
  "usbDebugging" as const,
  "samsung" as const,
  ...(computerKind(os) === "windows" ? ["driver" as const] : []),
];

/** Our phone app is in neither store yet, so a QR meant to open steps in it would only open a web page: hidden. */
export const PHONE_APP_IN_STORE = { android: false, ios: false } as const;

/** How often a Wi-Fi pairing is asked where it stands while it runs. */
export const WIFI_PAIR_POLL_MS = 1500;
/** How often a Mac's iPhones on its Wi-Fi are asked while its page or the iPhone guide is open. */
export const WIFI_IPHONES_POLL_MS = 5000;

/** The computer still looks for the phone, pairs or connects it. */
export const wifiPairLive = (p: Pick<WifiPairing, "state"> | undefined) =>
  p?.state === "waiting" || p?.state === "pairing" || p?.state === "connecting";

/** Computers a person may pair a phone with over Wi-Fi: ones they may manage that run as a person (not a server). */
export const wifiHosts = (hosts: readonly ComputerDevice[]) =>
  hosts.filter((h) => h.machineKind === "connected" && h.mayManage && !h.systemMode);

const LOCAL_NETWORK = new Set(["timed_out", "same_wifi", "mdns_off"]);

/** A Wi-Fi pairing that failed in a way macOS's Local Network permission for the app may cause. */
export const failedOnLocalNetwork = (p: Pick<WifiPairing, "state" | "reason"> | undefined) =>
  p?.state === "failed" && LOCAL_NETWORK.has(p.reason ?? "");

/**
 * The line a Wi-Fi pairing shows: where it is while it runs, else why it failed (the cause and the way out). A code
 * the phone refused reads differently from a pairing it stopped. On a Mac, a phone it never heard from, couldn't reach
 * or couldn't look for may also be macOS's Local Network permission for the app, so those name it.
 */
export function wifiPairText(
  t: TFunction,
  p: Pick<WifiPairing, "state" | "reason" | "way">,
  computer: string,
  mac = false,
) {
  if (p.state === "failed") {
    const base = p.reason === "refused" && p.way === "code" ? "refusedCode" : (p.reason ?? "failed");
    const reason = mac && LOCAL_NETWORK.has(base) ? `${base}Mac` : base;
    return say(t, `devices.wifiPair.fail.${reason}`, {
      computer,
      defaultValue: say(t, "devices.wifiPair.fail.failed"),
    });
  }
  return say(t, `devices.wifiPair.${p.state === "connected" ? "connecting" : p.state}`);
}

export type StepState = "done" | "current" | "waiting" | "needs";

export const IPHONE_STEPS = [
  "xcode",
  "tools",
  "account",
  "connected",
  "trust",
  "developerMode",
  "uiAutomation",
  "helper",
] as const;
export type IphoneStep = (typeof IPHONE_STEPS)[number];

const IPHONE_REASON: Record<string, IphoneStep> = {
  xcode_missing: "xcode",
  xcode_too_old: "xcode",
  ios_behind_xcode: "helper",
  device_support: "tools",
  untrusted: "trust",
  locked: "trust",
  developer_mode_off: "developerMode",
  ui_automation_off: "uiAutomation",
  helper_missing: "helper",
  helper_expired: "helper",
  apple_account_missing: "account",
  apple_team_missing: "account",
  ui_not_authorized: "uiAutomation",
  os_too_old: "connected",
  wifi_away: "connected",
  wifi_asleep: "connected",
  tunnel_down: "connected",
  wifi_untrusted: "trust",
  team_limit: "helper",
  helper_untrusted: "helper",
};

const hasAppleTeam = (host: ComputerDevice) => !!host.toolchains.appleTeam || host.toolchains.appleAccount === "team";

/** Xcode lists an Apple Account that shows no team yet: the account step says how to get one, not "sign in". */
export const iphoneNoTeam = (host: ComputerDevice | undefined, phone: PhoneDevice | null) =>
  host?.toolchains.appleAccount === "no_team" ||
  (!!phone && "reason" in phone.status && phone.status.reason === "apple_team_missing");

/** An iPhone's iOS major version ("27" from "27.0.1"), for the Xcode it needs. */
export const iosMajor = (version: string) => version.split(".")[0] ?? version;

/** What Xcode needs for an iPhone on a newer iOS than it knows, after installing the matching Xcode. */
export const DDIS_UPDATE = "xcrun devicectl manage ddis update";

/**
 * What the Mac runs in Terminal for Xcode installed but blocked (the runner's `toolchains.xcodeBlocked`): the developer
 * folder left on the Command Line Tools, or the license not agreed to. One paste, one password, both causes, and the
 * first-launch packages an iPhone's build needs: the same commands the Mac's own fix runs (`xcode.fix` `select`).
 * Each line ends in `&&` so a paste is read whole before sudo asks: sudo flushes typed-ahead input, which would drop
 * the lines after the first in a shell without bracketed paste.
 */
export const XCODE_FIX_COMMAND = [
  "sudo xcode-select -s /Applications/Xcode.app &&",
  "sudo xcodebuild -license accept &&",
  "sudo xcodebuild -runFirstLaunch",
].join("\n");
export const XCODE_BLOCKED = ["command_line_tools", "license"] as const;
export type XcodeBlocked = (typeof XCODE_BLOCKED)[number];

/** Why the Mac's Xcode doesn't answer, when it's installed and one command fixes it; null otherwise. */
export function xcodeBlockedOf(host: ComputerDevice | undefined): XcodeBlocked | null {
  const blocked = host?.toolchains.xcodeBlocked;
  return !host?.toolchains.xcode && blocked && (XCODE_BLOCKED as readonly string[]).includes(blocked)
    ? (blocked as XcodeBlocked)
    : null;
}

/** What updates a runner installed from the Terminal (the app updates its own). */
export const RUNNER_UPDATE_COMMAND = "agentes-runner update";
/** What tells why a runner installed from the Terminal is down. */
export const RUNNER_DOCTOR_COMMAND = "agentes-runner doctor";

const CAUSE_KEY = { unresponsive: "Unresponsive", stopped: "Stopped", dropped: "Dropped" } as const;

/**
 * Why a computer someone brought went offline, at `time` (already in words): `detail`, the short words after a row's
 * pill; `line`, the sentence on its page with the one way out, in plain words (a Terminal install, `cli`, is started
 * again there; the command that tells why waits under Technical details, `doctorShown`).
 */
export const offlineCauseText = (
  t: TFunction,
  cause: MachineOfflineCause,
  time: string,
  form: "detail" | "line",
  cli = false,
) =>
  say(t, `devices.${form}.offline${CAUSE_KEY[cause]}${form === "line" && cause === "stopped" && cli ? "Cli" : ""}`, {
    time,
  });

/** Installed from the Terminal, not run by the agentes.chat app: a computer someone brought, or the server's own. */
export const terminalInstall = (m: { kind?: string; app?: boolean } | null | undefined) =>
  m != null && m.kind !== "managed" && m.app === false;

/** Offline with a known cause and installed from the Terminal: `RUNNER_DOCTOR_COMMAND` says why, folded away. */
export const doctorShown = (
  s: DeviceStatus | null | undefined,
  m: { kind?: string; app?: boolean } | null | undefined,
) => s?.kind === "offline" && !s.withHost && Boolean(s.cause) && terminalInstall(m);

/** How often the iPhone guide asks where a fix of the Mac's Xcode stands while it runs. */
export const XCODE_FIX_POLL_MS = 1500;

/** A fix of the Mac's Xcode still under way: the password window open, or its commands running. */
export const xcodeFixLive = (fix: { state: string } | null | undefined) =>
  fix?.state === "asking" || fix?.state === "running";

export type XcodeFixStage = "offer" | "asking" | "running" | "done" | "missed" | "failed" | "still" | "terminal";

/**
 * What the Xcode step shows for a fix of `kind`: the button (`offer`), the password window open, the commands
 * running, done (the Mac looks at Xcode again), nobody typed the password or Cancel (`missed`), failed, every command
 * ran yet Xcode is still blocked (`still`: why, the command and Try again), or the Terminal command: picked
 * (`terminal`), for who can't press the button, or a Mac whose app can't fix it.
 */
export function xcodeFixStage(
  fix: { kind: string; state: string; still?: string } | null | undefined,
  kind: "select" | "update",
  o: { mayFix: boolean; terminal: boolean; outdated?: boolean },
): XcodeFixStage {
  const mine = fix?.kind === kind ? fix : null;
  if (!o.mayFix || o.outdated || mine?.state === "unsupported") return "terminal";
  if (mine?.state === "asking" || mine?.state === "running") return mine.state;
  if (o.terminal) return "terminal";
  if (mine?.state === "done") return "done";
  if (mine?.state === "canceled" || mine?.state === "no_answer") return "missed";
  if (mine?.state === "failed") return mine.still ? "still" : "failed";
  return "offer";
}

/** A step under way or waiting on the person this long, unchanged, says what most likely holds it and one way out. */
export const SETUP_STALL_MS = 45_000;

/**
 * Whether `key` (the step and what the device reports) stayed the same for `SETUP_STALL_MS`. A new key starts over;
 * null: nothing waits.
 */
export function useStalled(key: string | null, ms = SETUP_STALL_MS): boolean {
  const [since, setSince] = useState(() => ({ key, at: Date.now() }));
  const [, rerender] = useState(0);
  useEffect(() => {
    setSince({ key, at: Date.now() });
    if (key === null) return;
    // Read again just after the time is up: the answer is the clock's.
    const timer = setTimeout(() => rerender((n) => n + 1), ms + 100);
    return () => clearTimeout(timer);
  }, [key, ms]);
  return key !== null && since.key === key && Date.now() - since.at >= ms;
}

/** How long an iPhone gone from its Mac at the Developer Mode step reads as restarting before the guide asks for it. */
export const IPHONE_RESTART_MS = 3 * 60_000;

/** The iPhone guide's memory of the Developer Mode step: which phone was at it, since when it is gone, whether it came back. */
export interface IphoneRestartMemo {
  at: string | null;
  goneAt: number | null;
  back: boolean;
}
export const NO_IPHONE_RESTART: IphoneRestartMemo = { at: null, goneAt: null, back: false };
/** `restarting`: gone from its Mac after the Developer Mode step; `back`: there again and the mode still off. */
export type IphoneRestart = "restarting" | "back" | null;
/** An iPhone as the guide sees it now: a key that names it, and its reason (null: none, ready). */
export type IphoneSeen = { key: string; reason: string | null | undefined } | null;

/** The memo after seeing `phone` (null: the Mac lists none) at `now`. */
export function iphoneRestartNext(memo: IphoneRestartMemo, phone: IphoneSeen, now: number): IphoneRestartMemo {
  if (!phone) return memo.at && memo.goneAt === null ? { ...memo, goneAt: now } : memo;
  if (phone.reason !== "developer_mode_off") return NO_IPHONE_RESTART;
  const same = memo.at === phone.key;
  return { at: phone.key, goneAt: null, back: same && (memo.back || memo.goneAt !== null) };
}

export function iphoneRestartOf(memo: IphoneRestartMemo, phone: IphoneSeen, now: number): IphoneRestart {
  if (!phone) return memo.at && memo.goneAt !== null && now - memo.goneAt < IPHONE_RESTART_MS ? "restarting" : null;
  return memo.back && memo.at === phone.key && phone.reason === "developer_mode_off" ? "back" : null;
}

/**
 * An iPhone restarts to turn Developer Mode on, and is gone from its Mac meanwhile: the guide stays on that step
 * (`restarting`) for up to `IPHONE_RESTART_MS` instead of asking for the cable again, then says what to do once it is
 * back (`back`). Kept in memory: a guide opened during the restart starts from what the Mac sees.
 */
export function useIphoneRestart(phone: IphoneSeen): IphoneRestart {
  const [memo, setMemo] = useState(NO_IPHONE_RESTART);
  const [, rerender] = useState(0);
  const now = Date.now();
  const next = iphoneRestartNext(memo, phone, now);
  const changed = next.at !== memo.at || next.goneAt !== memo.goneAt || next.back !== memo.back;
  useEffect(() => {
    if (changed) setMemo(next);
  }, [changed, next]);
  const goneAt = next.goneAt;
  useEffect(() => {
    if (goneAt === null) return;
    // Read again just after the time is up: the answer is the clock's.
    const timer = setTimeout(() => rerender((n) => n + 1), Math.max(0, goneAt + IPHONE_RESTART_MS - Date.now()) + 100);
    return () => clearTimeout(timer);
  }, [goneAt]);
  return iphoneRestartOf(next, phone, now);
}

/** The iPhone a Mac reaches (a real one first), for the iPhone guide. */
export const iphoneOf = (host: ComputerDevice | undefined) =>
  host?.phones.find((p) => p.platform === "ios" && p.phoneKind === "device" && p.status.kind !== "offline") ?? null;

/**
 * The iPhone guide's checklist, mirrored from what the Mac reports: steps before the phone's reason are done, that
 * one is current (amber when only the person can do it), the rest wait. No Xcode on the Mac stops at step one; with
 * no iPhone plugged in yet, the Apple Account comes from what the Mac found in Xcode. An iPhone restarting to turn
 * Developer Mode on (`restarting`, `useIphoneRestart`) stays on that step, under way.
 */
export function iphoneSteps(
  host: ComputerDevice | undefined,
  phone: PhoneDevice | null,
  restarting = false,
): Record<IphoneStep, StepState> {
  let at: IphoneStep | null;
  let needs = false;
  if (!phone && restarting) {
    at = "developerMode";
  } else if (!phone) {
    at = !host?.toolchains.xcode ? "xcode" : !hasAppleTeam(host) ? "account" : "connected";
    needs = at !== "connected";
  } else if (phone.status.kind === "unsupported") {
    // An iPhone below iOS 17: nothing the person does on this Mac makes it usable, so it ends here.
    [at, needs] = ["connected", true];
  } else if (phone.status.kind === "needs_you" || phone.status.kind === "preparing") {
    at = IPHONE_REASON[phone.status.reason] ?? "helper";
    // While the Mac builds or renews the test helper the phone is preparing; needs_you there means it failed.
    needs = phone.status.kind === "needs_you";
  } else {
    at = null;
  }
  const index = at ? IPHONE_STEPS.indexOf(at) : IPHONE_STEPS.length;
  const states = Object.fromEntries(
    IPHONE_STEPS.map((id, i) => [id, i < index ? "done" : i > index ? "waiting" : needs ? "needs" : "current"]),
  ) as Record<IphoneStep, StepState>;
  // The Mac looks for the Apple Account only once the iPhone is plugged in, trusted and in Developer Mode.
  if (phone && at === "account") states.connected = states.trust = states.developerMode = "done";
  return states;
}

// ── In the chat and the inbox ───────────────────────────────────────────────

/** How a device wait ended, or that it still waits. */
export type DeviceWaitState =
  | "waiting"
  | "back"
  | "retried"
  | "stopped"
  | "moved_on"
  | "allowed"
  | "denied"
  | "gave_up"
  | "left";

const WAIT_STATES = new Set<string>([
  "waiting",
  "back",
  "retried",
  "stopped",
  "moved_on",
  "allowed",
  "denied",
  "gave_up",
  "left",
]);

/**
 * A run parked until a device can take it (`wait_for_device`), as the agent's card message carries it in
 * `meta.deviceWait`: the device and its computer, why it waits (a phone's own reason in `detail`), who owns it (asked
 * for access: `asked`), and the state the server moves it to when the wait ends (`device_wait.updated`).
 */
export interface DeviceWait {
  runId: string | null;
  deviceName: string;
  hostName: string | null;
  kind: "computer" | "phone";
  platform: "android" | "ios" | null;
  /** The phone's id, or the computer's. */
  deviceId: string | null;
  ownerUserId: string | null;
  /** `offline`, `missing`, `busy`, `needs_you`, `preparing` or `asked`. */
  reason: string;
  /** A phone's reason code (`PhoneReason`), for `needs_you` and `preparing`. */
  detail: string | null;
  lastSeenAt: string | null;
  until: string | null;
  state: DeviceWaitState;
  endedAt: string | null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function deviceWaitOf(meta: Record<string, unknown> | null | undefined): DeviceWait | null {
  const w = meta?.deviceWait;
  if (!w || typeof w !== "object") return null;
  const x = w as Record<string, unknown>;
  const device = (x.device && typeof x.device === "object" ? x.device : {}) as Record<string, unknown>;
  const deviceName = str(x.deviceName) ?? str(device.name);
  if (!deviceName) return null;
  const state = str(x.state) ?? "waiting";
  return {
    runId: str(x.runId),
    deviceName,
    hostName: str(x.hostName) ?? str(device.hostName),
    kind: device.kind === "phone" ? "phone" : "computer",
    platform: device.platform === "android" || device.platform === "ios" ? device.platform : null,
    deviceId: str(device.id),
    ownerUserId: str(device.ownerUserId),
    reason: str(x.reason) ?? "offline",
    detail: str(x.detail),
    lastSeenAt: str(x.lastSeenAt),
    until: str(x.until),
    state: (WAIT_STATES.has(state) ? state : "waiting") as DeviceWaitState,
    endedAt: str(x.endedAt),
  };
}

/** A `device_wait.updated` event: which message's card changed, and its new `meta.deviceWait`. */
export function deviceWaitEventOf(event: { type: string }): {
  channelId: string;
  threadId: string | null;
  messageId: string;
  deviceWait: Record<string, unknown>;
} | null {
  if (event.type !== "device_wait.updated") return null;
  const e = event as Record<string, unknown>;
  const channelId = str(e.channelId);
  const messageId = str(e.messageId);
  if (!channelId || !messageId || !e.deviceWait || typeof e.deviceWait !== "object") return null;
  return { channelId, threadId: str(e.threadId), messageId, deviceWait: e.deviceWait as Record<string, unknown> };
}

/**
 * The sentence under the waiting card: why it can't use the device now, and that it starts when it can. `owner`: the
 * device owner's name, for an access it asked for.
 */
export function waitText(
  t: TFunction,
  locale: string,
  w: DeviceWait,
  options: { owner?: string | null; now?: Date } = {},
): string {
  const seen = w.lastSeenAt ? clockAt(locale, w.lastSeenAt, options.now ?? new Date()) : null;
  const deviceName = w.deviceName;
  if (w.reason === "asked")
    return options.owner
      ? t("devices.wait.asked", { deviceName, owner: firstName(options.owner) })
      : t("devices.wait.askedOwner", { deviceName });
  if (w.reason === "offline" && w.hostName && w.hostName !== deviceName)
    return seen
      ? t("devices.wait.hostOfflineSeen", { deviceName, host: w.hostName, time: seen })
      : t("devices.wait.hostOffline", { deviceName, host: w.hostName });
  if (w.reason === "offline")
    return seen ? t("devices.wait.offlineSeen", { deviceName, time: seen }) : t("devices.wait.offline", { deviceName });
  if (w.reason === "missing")
    return w.hostName
      ? t("devices.wait.missing", { deviceName, host: w.hostName })
      : t("devices.wait.offline", { deviceName });
  if (w.reason === "busy") return t("devices.wait.busy", { deviceName });
  return t("devices.wait.needs", { deviceName, reason: reasonText(t, w.detail ?? "other") });
}

/** The one quiet line an ended wait leaves in the thread. */
export function waitEndedText(t: TFunction, w: DeviceWait, owner?: string | null): string {
  const deviceName = w.deviceName;
  const who = owner ? firstName(owner) : null;
  switch (w.state) {
    case "back":
      return t("devices.wait.ended.back", { deviceName });
    case "retried":
      return t("devices.wait.ended.retried", { deviceName });
    case "stopped":
      return t("devices.wait.ended.stopped");
    case "moved_on":
      return t("devices.wait.ended.movedOn");
    case "allowed":
      return who
        ? t("devices.wait.ended.allowed", { owner: who, deviceName })
        : t("devices.wait.ended.allowedAny", { deviceName });
    case "denied":
      return who
        ? t("devices.wait.ended.denied", { owner: who, deviceName })
        : t("devices.wait.ended.deniedAny", { deviceName });
    case "gave_up":
      return t("devices.wait.ended.gaveUp", { deviceName });
    default:
      return t("devices.wait.ended.left", { deviceName });
  }
}

// ── A phone's screen, live ───────────────────────────────────────────────────

/** What a phone's live screen shows. */
export type PhoneScreenState =
  | "connecting"
  | "live"
  /** Its computer is offline, or it doesn't see the phone now (opens again by itself). */
  | "offline"
  /** As many people watch as it takes, or too many opens in a minute (opens again by itself). */
  | "busy"
  /** The phone needs its person first (unauthorized, replugged): opens again by itself. */
  | "notReady"
  | "forbidden"
  /** The agentes.chat app on its computer is too old for this. */
  | "outdated"
  /** Its computer can't show it (no adb, no Xcode, an iPhone without the test helper), or it's gone. */
  | "unavailable"
  /** It closed for good: only Try again opens it. */
  | "ended";

/**
 * Why control was refused, or ended: the screen opens again as a watcher and says so. `late` and `failed`: control
 * never showed a picture (its phone wasn't ready in a start's wait, or it couldn't start there).
 */
export type PhoneControlRefusal = "in_use" | "someone" | "unsupported" | "paused" | "held" | "lost" | "late" | "failed";

/** The most text one `text` frame carries (mirror of `PHONE_VIEW.text` in `@agenteschat/adapters`). */
export const PHONE_TEXT_MAX = 2000;

/** A person's socket to a phone's screen. `text`: its pictures as base64 text frames (the phone app). */
export function phoneScreenUrl(
  base: SocketBase,
  v: { orgId: string; phoneId: string; mode: DesktopMode; text?: boolean },
) {
  const params: Record<string, string | number> = { orgId: v.orgId, phoneId: v.phoneId, mode: v.mode };
  if (v.text) params.text = 1;
  return socketUrl(base, "/api/phone-screen", params);
}

/**
 * What a phone screen socket's close means (`reason`: the server's, or the computer's error code). `opening`: a
 * control socket that showed no picture yet. Opening it again would wait the whole start again behind the same
 * spinner, each time, so a close that would only try again goes back to watching and says why instead.
 */
export function phoneCloseState(
  code: number,
  reason = "",
  o: { opening?: boolean } = {},
): { state: PhoneScreenState; retry: DesktopRetry; control?: PhoneControlRefusal } {
  const next = closeOf(code, reason);
  if (!o.opening || next.control || (next.state !== "connecting" && next.state !== "notReady")) return next;
  // A dropped connection (a server restarting, the network) is no answer about the phone: control opens again.
  if (code === 1001 || code === 1006) return next;
  return watchAgain(code === DESKTOP_CLOSE.late || reason === "phone_not_ready" ? "late" : "failed");
}

const watchAgain = (control: PhoneControlRefusal) => ({
  state: "connecting" as const,
  retry: "now" as const,
  control,
});

function closeOf(
  code: number,
  reason: string,
): { state: PhoneScreenState; retry: DesktopRetry; control?: PhoneControlRefusal } {
  switch (code) {
    case DESKTOP_CLOSE.controlEnded:
      return watchAgain(reason === "in_use" ? "in_use" : reason === "someone_in_control" ? "someone" : "lost");
    case DESKTOP_CLOSE.forbidden:
      return { state: "forbidden", retry: "never" };
    case DESKTOP_CLOSE.notFound:
      return { state: "unavailable", retry: "never" };
    case DESKTOP_CLOSE.tooMany:
      return { state: "busy", retry: "later" };
    case DESKTOP_CLOSE.unreachable:
      return { state: "offline", retry: "later" };
    case DESKTOP_CLOSE.normal:
      return { state: "ended", retry: "never" };
    case DESKTOP_CLOSE.refused:
      if (reason === "unsupported") return watchAgain("unsupported");
      if (reason === "machine_paused") return watchAgain("paused");
      // The workspace is on hold: nothing new starts on its computers, control included.
      if (reason === "held") return watchAgain("held");
      if (reason === "phone_busy") return watchAgain("someone");
      if (reason === "phone_missing") return { state: "offline", retry: "later" };
      if (reason === "phone_not_ready") return { state: "notReady", retry: "later" };
      if (reason === "runner_outdated") return { state: "outdated", retry: "never" };
      if (reason === "tool_missing" || reason === "bad_request") return { state: "unavailable", retry: "never" };
      return { state: "connecting", retry: "later" };
    default:
      return { state: "connecting", retry: "later" };
  }
}

/** Whether the phone can't show now by its state: offline, or waiting on its person (a lock screen shows, though). */
export const phoneScreenAway = (p: PhoneDevice) =>
  p.status.kind === "offline" ||
  p.status.kind === "preparing" ||
  p.status.kind === "unsupported" ||
  (p.status.kind === "needs_you" && p.status.reason !== "locked");

/** What covers a phone's screen while it can't show live: the cause, and Try again when only the person can. */
export interface PhoneScreenCover {
  title: string;
  text?: string;
  /** It opens again by itself. */
  spinner?: boolean;
  retry?: boolean;
}

export function phoneScreenCover(
  t: TFunction,
  view: PhoneScreenState,
  p: PhoneDevice,
  host: string,
): PhoneScreenCover | null {
  const name = p.name;
  const st = p.status;
  const offline = { title: t("devices.screen.offline", { name }), text: t("devices.screen.offlineText", { host }) };
  const forbidden = { title: t("devices.screen.forbidden"), text: t("devices.screen.forbiddenText", { name }) };
  if (st.kind === "offline") return offline;
  if (phoneScreenAway(p)) {
    const reason = st.kind === "needs_you" || st.kind === "preparing" || st.kind === "unsupported" ? st.reason : "";
    return { title: t("devices.screen.notReady", { name }), text: fixText(t, reason) };
  }
  if (!p.mayUse) return forbidden;
  switch (view) {
    case "live":
      return null;
    case "connecting":
      return { title: t("devices.screen.opening"), spinner: true };
    case "offline":
      return { ...offline, spinner: true };
    case "busy":
      return { title: t("devices.screen.busy"), text: t("devices.screen.busyText"), spinner: true };
    case "notReady":
      return { title: t("devices.screen.notReady", { name }), text: t("devices.screen.notReadyText"), spinner: true };
    case "forbidden":
      return forbidden;
    case "outdated":
      return {
        title: t("devices.screen.outdated", { host }),
        text: t("devices.screen.outdatedText", { host }),
        retry: true,
      };
    case "unavailable":
      return {
        title: t("devices.screen.unavailable"),
        text:
          p.platform === "ios" && p.phoneKind === "device"
            ? t("devices.screen.needsHelper")
            : t("devices.screen.unavailableText", { host }),
        retry: true,
      };
    default:
      return { title: t("devices.screen.ended"), retry: true };
  }
}

/** The words for control refused, or ended, as `phoneCloseState` says it (`agent`: who holds the phone). */
export function controlRefusalText(
  t: TFunction,
  why: PhoneControlRefusal,
  v: { name: string; host: string; agent: string },
): string {
  switch (why) {
    case "in_use":
      return t("devices.screen.noTake", { agent: v.agent });
    case "someone":
      return t("devices.screen.someone", { name: v.name });
    case "unsupported":
      return t("devices.screen.unsupported");
    case "paused":
      return t("devices.screen.paused", { host: v.host });
    case "held":
      return t("devices.screen.held");
    case "late":
      return t("devices.screen.controlLate", { name: v.name, host: v.host });
    case "failed":
      return t("devices.screen.controlFailed", { name: v.name, host: v.host });
    default:
      return t("devices.screen.lost", { name: v.name });
  }
}

/** Whether a phone's holder is a person in control of its screen (no agent, no run). */
export const personInControl = (s: DeviceStatus) =>
  s.kind === "in_use" && s.agentId === null && s.userId !== null ? s.userId : null;

/**
 * Who may take control of a phone's screen now, as the server decides it (`phoneStreamAccess`): one they may use,
 * free or theirs, or held by an agent they may stop (its owner, an admin, or whom it works for). Another person in
 * control keeps it.
 */
export function mayTakePhone(p: Pick<PhoneDevice, "mayUse" | "mayManage" | "status">, userId: string) {
  if (!p.mayUse) return false;
  const s = p.status;
  if (s.kind !== "in_use") return true;
  if (s.agentId === null) return s.userId === userId;
  return p.mayManage || s.userId === userId;
}

/** A tap, or a swipe from where the finger (or the pointer) went down: a hold in place is a long press. */
export function screenGesture(
  from: { x: number; y: number; at: number },
  to: { x: number; y: number; at: number },
):
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; ms: number } {
  const share = (v: number) => Math.min(1, Math.max(0, v));
  const ms = Math.round(Math.min(5000, Math.max(1, to.at - from.at)));
  const moved = Math.hypot(to.x - from.x, to.y - from.y) > 0.015;
  if (!moved && ms < 500) return { type: "tap", x: share(from.x), y: share(from.y) };
  return {
    type: "swipe",
    x1: share(from.x),
    y1: share(from.y),
    x2: share(to.x),
    y2: share(to.y),
    ms: Math.max(ms, 80),
  };
}

export type DeviceNoticeKind =
  | "device.join_request"
  | "device.in_use"
  | "device.access_request"
  | "device.waiting"
  | "device.tool_request"
  | "device.cli_request"
  | "device.folder_request"
  | "device.internet_shared";
const NOTICE_KINDS = new Set<string>([
  "device.join_request",
  "device.in_use",
  "device.access_request",
  "device.waiting",
  "device.tool_request",
  "device.cli_request",
  "device.folder_request",
  "device.internet_shared",
]);

/**
 * A device notice's parts: the request to decide (`source.requestId`: a computer's join, or an access request), the
 * phone or computer (`source.phoneId`, `source.machineId`, named in `source.label`), the run (`source.runId`), the
 * agent (the notice's actor, or `source.agentId`) and the person it works for (`source.userId`, their first name in
 * `latest.title`), what it's doing or why (`latest.text`) and, for a join, the computer's own facts (`latest.os`,
 * `latest.ip`, `latest.location`).
 */
export interface DeviceNotice {
  kind: DeviceNoticeKind;
  requestId: string | null;
  phoneId: string | null;
  machineId: string | null;
  runId: string | null;
  device: string;
  agentId: string | null;
  userId: string | null;
  /** The person the agent works for, by first name, as the server wrote it. */
  forName: string | null;
  text: string | null;
  join: { name: string; os: string; ip: string; location: string | null } | null;
  /**
   * `device.tool_request`: the tool to turn on (`latest.reason`) and who asked (the person actor);
   * `device.cli_request`: the coding CLI to install, the same way.
   */
  tool: MachineTool | null;
  /** `device.folder_request`: the folder an agent waits for on this computer (`latest.title`). */
  path: string | null;
  askerId: string | null;
}

export function deviceNoticeOf(
  n: Pick<AppNotification, "kind" | "source" | "latest"> & { actors?: AppNotification["actors"] },
): DeviceNotice | null {
  const kind = n.kind as string;
  if (!NOTICE_KINDS.has(kind)) return null;
  const s = n.source as Record<string, unknown>;
  const l = n.latest as Record<string, unknown>;
  const join = kind === "device.join_request";
  const actor = n.actors?.find((a) => a.type === "agent");
  const tool =
    kind === "device.tool_request" || kind === "device.cli_request" ? (str(l.reason) as MachineTool | null) : null;
  return {
    kind: kind as DeviceNoticeKind,
    requestId: str(s.requestId),
    phoneId: str(s.phoneId),
    machineId: str(s.machineId),
    runId: str(s.runId),
    device: str(s.label) ?? str(l.title) ?? "",
    agentId: actor?.id ?? str(s.agentId),
    userId: str(s.userId),
    // A folder request's `latest.title` is the folder itself, and a lent internet's the computer: neither is a person.
    forName: join || kind === "device.folder_request" || kind === "device.internet_shared" ? null : str(l.title),
    text: str(l.text),
    join: join
      ? {
          name: str(s.label) ?? str(l.title) ?? "",
          os: str(l.os) ?? "",
          ip: str(l.ip) ?? "",
          location: str(l.location),
        }
      : null,
    tool,
    path: kind === "device.folder_request" ? str(l.title) : null,
    askerId: tool ? (n.actors?.find((a) => a.type === "user")?.id ?? null) : null,
  };
}
