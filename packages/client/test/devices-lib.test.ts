import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { ComputerDevice, DeviceAudience, PhoneDevice } from "../src/api/types";
import {
  ANDROID_USB_DRIVERS,
  androidNotShowing,
  androidStage,
  androidSteps,
  audienceWords,
  controlRefusalText,
  deviceCounts,
  deviceNoticeOf,
  deviceRows,
  deviceWaitEventOf,
  deviceWaitOf,
  doctorShown,
  failedOnLocalNetwork,
  fixText,
  helpingDevices,
  IPHONE_RESTART_MS,
  type IphoneRestartMemo,
  type IphoneSeen,
  iosOf,
  iphoneNoTeam,
  iphoneRestartNext,
  iphoneRestartOf,
  iphoneSteps,
  joinLends,
  lendingDevice,
  lendsInternet,
  linkPhase,
  mayChangeTasks,
  mayTakePhone,
  NO_IPHONE_RESTART,
  narrowsAudience,
  newComputerOf,
  permissionWaitLines,
  phoneCloseState,
  phoneScreenCover,
  phoneScreenUrl,
  powerChoice,
  processorText,
  reasonText,
  SPILL_USES,
  screenGesture,
  shareInternetHint,
  shareInternetText,
  spilledText,
  spillOfUse,
  spillUseOf,
  statusDetail,
  statusPill,
  statusSentence,
  systemText,
  taskChoices,
  taskLimitLine,
  tasksAutoText,
  waitEndedText,
  waitText,
  wifiHosts,
  wifiPairLive,
  wifiPairText,
  XCODE_FIX_COMMAND,
  xcodeBlockedOf,
  xcodeFixLive,
  xcodeFixStage,
} from "../src/lib/devices";
import { errorText } from "../src/lib/errors";

const i18n = i18next.createInstance();
void i18n.init({ lng: "en", fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
const t = i18n.t as TFunction;
const NOW = new Date("2026-11-09T14:20:00");
const at = (h: number, m: number) => new Date(2026, 10, 9, h, m).toISOString();
const everyone: DeviceAudience = { mode: "everyone", userIds: [], roleIds: [] };
const owner: DeviceAudience = { mode: "owner", userIds: [], roleIds: [] };
const people = (userIds: string[], roleIds: string[] = []): DeviceAudience => ({ mode: "people", userIds, roleIds });

const phone = (p: Partial<PhoneDevice>): PhoneDevice => ({
  id: "p",
  platform: "android",
  phoneKind: "device",
  name: "Pixel 8",
  model: "Pixel 8",
  osVersion: "16",
  hostMachineId: "m",
  ownerUserId: "u-sam",
  audience: everyone,
  status: { kind: "ready" },
  transport: "usb",
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  ...p,
});
const computer = (c: Partial<ComputerDevice>): ComputerDevice => ({
  id: "m",
  machineKind: "connected",
  name: "Sam's MacBook Pro",
  os: "darwin",
  arch: "arm64",
  hostname: "sams-mbp",
  cpus: 12,
  memoryGb: 36,
  ownerUserId: "u-sam",
  belongsToWorkspace: false,
  spill: { own: true },
  systemMode: false,
  audience: owner,
  status: { kind: "ready" },
  maxTasks: 1,
  toolchains: {},
  lastSeenAt: null,
  mayUse: true,
  mayManage: true,
  phones: [],
  ...c,
});

describe("devices as extra capacity", () => {
  test("the line under a reply that thought elsewhere says where and why; any other reply has none", () => {
    const org = { name: "Acme", mode: "team" as const };
    expect(spilledText(t, { spilled: { to: "Bruno's MacBook", from: "Studio Mac", cause: "full" } }, org)).toBe(
      "Thought on Bruno's MacBook: Studio Mac was full.",
    );
    // The workspace's own computer, named in its first owner's language, reads in the reader's.
    expect(spilledText(t, { spilled: { to: "Bruno's MacBook", from: "Computador da Acme", cause: "full" } }, org)).toBe(
      `Thought on Bruno's MacBook: ${t("computerSetup.title", { org: "Acme" })} was full.`,
    );
    expect(spilledText(t, { spilled: { to: "Bruno's MacBook", from: null, cause: "away" } }, org)).toBe(
      "Thought on Bruno's MacBook: its computer was away.",
    );
    expect(spilledText(t, { speedFallback: true }, org)).toBeNull();
    // Its owner uses that computer for their agents' work: nothing was wrong with the agent's own.
    expect(spilledText(t, { spilled: { to: "Bruno's PC", from: "Studio Mac", cause: "chosen" } }, org)).toBe(
      "Thought on Bruno's PC, which its owner uses for their agents' work.",
    );
  });

  test("how a computer helps its owner's agents: never, when theirs is full or away, or first for their work", () => {
    expect(spillUseOf({ spill: { own: false } })).toBe("off");
    expect(spillUseOf({ spill: { own: true } })).toBe("help");
    expect(spillUseOf({ spill: { own: true, first: true } })).toBe("first");
    expect(SPILL_USES.map(spillOfUse)).toEqual([
      { own: false, first: false },
      { own: true, first: false },
      { own: true, first: true },
    ]);
  });

  test("the computers that help an agent: online, its owner's own or the workspace's, while the workspace lets them", () => {
    const mine = computer({ id: "mine", ownerUserId: "u-ana" });
    const theirs = computer({ id: "theirs", ownerUserId: "u-sam" });
    const team = computer({ id: "team", ownerUserId: "u-sam", belongsToWorkspace: true });
    const off = computer({ id: "off", ownerUserId: "u-ana", spill: { own: false } });
    const away = computer({ id: "away", ownerUserId: "u-ana", status: { kind: "offline", lastSeenAt: null } });
    const devices = [mine, theirs, team, off, away];
    expect(helpingDevices({ devices }, "u-ana", "home").map((d) => d.id)).toEqual(["mine", "team"]);
    expect(helpingDevices({ devices }, "u-ana", "mine").map((d) => d.id)).toEqual(["team"]);
    expect(helpingDevices({ devices, devicesHelp: false }, "u-ana", "home")).toEqual([]);
  });
});

describe("tasks at once", () => {
  test("where tasks start on room: no count in the pill, what still fits in the row, why none does under the pill", () => {
    const room = { more: 8, freeGb: 6.4, cpuBusy: false, pushHarder: false };
    const busy = computer({ status: { kind: "busy", running: 3, max: null }, maxTasks: 5, taskRoom: room });
    expect(statusPill(t, busy.status)).toBe("Busy · 3 running");
    expect(tasksAutoText(t, busy)).toBe("Automatic · 3 running · room for about 8 more");
    expect(taskLimitLine(t, busy, true)).toBeNull();
    const full = { ...busy, taskRoom: { ...room, more: 0, freeGb: 1.4 } };
    expect(tasksAutoText(t, full)).toBe("Automatic · 3 running · full for now");
    expect(taskLimitLine(t, full, true)).toBe(
      "No room for another task right now: 1.4 GB of memory free. The next one starts when one ends.",
    );
    expect(taskLimitLine(t, { ...full, taskRoom: { ...full.taskRoom, cpuBusy: true } }, true)).toContain(
      "the processor is nearly full",
    );
    expect(taskLimitLine(t, { ...full, taskRoom: { ...full.taskRoom, freeGb: 0.6, pushHarder: true } }, false)).toBe(
      "Pushing harder: 0.6 GB of memory free. Your own apps may slow down.",
    );
    expect(tasksAutoText(t, computer({ taskRoom: room }))).toBe("Automatic · 0 running · room for about 8 more");
    expect(tasksAutoText(t, computer({}))).toBeNull();
  });

  test("a busy computer says its limit and where it changes; its owner changes it, an admin only on nobody's", () => {
    const busy = computer({ status: { kind: "busy", running: 5, max: 5 }, maxTasks: 5 });
    expect(taskLimitLine(t, busy, true)).toBe("Tasks at once here: 5. Change it below.");
    expect(taskLimitLine(t, busy, false)).toBe("Tasks at once here: 5. The person who connected it can change that.");
    expect(taskLimitLine(t, { ...busy, maxTasks: null, status: { kind: "busy", running: 3, max: 3 } }, true)).toBe(
      "Tasks at once here: 3. Update its app to change that from here.",
    );
    expect(taskLimitLine(t, computer({}), true)).toBeNull();
    expect(mayChangeTasks(busy, "u-sam", false)).toBe(true);
    expect(mayChangeTasks(busy, "u-ana", true)).toBe(false);
    expect(mayChangeTasks({ ...busy, ownerUserId: null }, "u-ana", true)).toBe(true);
    expect(mayChangeTasks({ ...busy, machineKind: "managed", ownerUserId: null }, "u-ana", true)).toBe(false);
    expect(taskChoices(7)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20]);
    expect(taskChoices(4)).toHaveLength(11);
  });
});

describe("status words", () => {
  test("the pill says the state, the detail the rest", () => {
    const inUse = {
      kind: "in_use",
      agentId: "a",
      agentName: "Lia",
      userId: "u-rui",
      userName: "Rui Tanaka",
      since: at(14, 10),
    } as const;
    expect(statusPill(t, inUse)).toBe("In use by Lia");
    expect(statusDetail(t, "en-US", inUse, { now: NOW })).toBe("for Rui since 2:10 PM");
    expect(statusPill(t, { kind: "busy", running: 1, max: 1 })).toBe("Busy 1/1");
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "developer_mode_off" })).toBe(
      "Turn on Developer Mode",
    );
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "something_new" })).toBe("See what it needs");
    expect(statusDetail(t, "en-US", { kind: "offline", lastSeenAt: at(14, 2) }, { now: NOW })).toBe(
      "last seen 2:02 PM",
    );
    expect(
      statusDetail(t, "en-US", { kind: "offline", lastSeenAt: null, withHost: true }, { host: "Ana's iMac" }),
    ).toBe("with Ana's iMac");
    expect(statusDetail(t, "en-US", { kind: "ready" })).toBeNull();
  });

  test("a computer offline for a known cause: the row says why, its page adds the one way out in plain words", () => {
    const off = (cause: "unresponsive" | "stopped" | "dropped") =>
      ({ kind: "offline", lastSeenAt: at(14, 2), cause }) as const;
    expect(statusDetail(t, "en-US", off("unresponsive"), { now: NOW })).toBe("stopped answering at 2:02 PM");
    expect(statusDetail(t, "en-US", off("stopped"), { now: NOW })).toBe("agentes.chat stopped at 2:02 PM");
    expect(statusDetail(t, "en-US", off("dropped"), { now: NOW })).toBe("connection dropped at 2:02 PM");
    expect(statusSentence(t, "en-US", off("stopped"), { now: NOW })).toBe(
      "The agentes.chat app stopped on this computer at 2:02 PM. Open the app again.",
    );
    expect(statusSentence(t, "en-US", off("stopped"), { now: NOW, cli: true })).toBe(
      "agentes.chat stopped on this computer at 2:02 PM. Start it again there.",
    );
    // No command in the line: a Terminal install has it under Technical details.
    for (const cause of ["unresponsive", "stopped", "dropped"] as const)
      for (const cli of [false, true])
        expect(statusSentence(t, "en-US", off(cause), { now: NOW, cli })).not.toMatch(/runner|`/);
    const app = { kind: "connected", app: true };
    const terminal = { kind: "connected", app: false };
    expect(doctorShown(off("stopped"), terminal)).toBe(true);
    expect(doctorShown(off("stopped"), app)).toBe(false);
    expect(doctorShown(off("stopped"), { kind: "connected" })).toBe(false);
    expect(doctorShown({ kind: "offline", lastSeenAt: at(14, 2) }, terminal)).toBe(false);
    expect(doctorShown({ kind: "ready" }, terminal)).toBe(false);
  });
});

describe("who can use it", () => {
  test("in words, a phone shared wider than its computer says so", () => {
    const host = { name: "Sam's MacBook Pro", audience: owner };
    expect(audienceWords(t, { audience: owner, ownerName: "Sam Rivera" }).text).toBe("Only Sam");
    expect(audienceWords(t, { audience: everyone, ownerName: "Sam Rivera", host }).text).toBe("Everyone, phone only");
    expect(audienceWords(t, { audience: null, ownerName: "Sam Rivera", host }).text).toBe("Same as Sam's MacBook Pro");
    expect(audienceWords(t, { audience: people(["a", "b"], ["r"]), ownerName: "Sam" }).text).toBe("2 people, 1 role");
    // A workspace device nobody owns under "only the owner" is everyone's.
    expect(audienceWords(t, { audience: owner, ownerName: null, belongsToWorkspace: true }).text).toBe("Everyone");
  });

  test("an admin only narrows", () => {
    expect(narrowsAudience(everyone, people(["a"]))).toBe(true);
    expect(narrowsAudience(people(["a", "b"]), people(["a"]))).toBe(true);
    expect(narrowsAudience(people(["a"]), people(["a", "b"]))).toBe(false);
    expect(narrowsAudience(people(["a"]), everyone)).toBe(false);
    expect(narrowsAudience(owner, people(["a"]))).toBe(false);
    expect(narrowsAudience(people(["a"]), owner)).toBe(true);
  });
});

describe("the list", () => {
  const list = [
    computer({ id: "m", phones: [phone({ id: "p1" }), phone({ id: "p2", name: "iPhone 16", platform: "ios" })] }),
    computer({ id: "w", machineKind: "managed", name: "Workspace computer", os: "linux" }),
    computer({ id: "b", name: "build-box", os: "linux" }),
  ];
  test("the workspace computer first, phones under their host", () => {
    expect(deviceRows(list, "all").map((r) => r.device.id)).toEqual(["w", "m", "p1", "p2", "b"]);
    expect(deviceRows(list, "computers").map((r) => r.device.id)).toEqual(["w", "m", "b"]);
    expect(deviceRows(list, "phones").map((r) => [r.device.id, r.kind === "phone" && r.nested])).toEqual([
      ["p1", false],
      ["p2", false],
    ]);
    expect(deviceCounts(list)).toEqual({ all: 5, computers: 3, phones: 2 });
  });
  test("a search keeps a matching phone under its host", () => {
    expect(deviceRows(list, "all", "iphone").map((r) => r.device.id)).toEqual(["m", "p2"]);
    expect(deviceRows(list, "all", "BUILD").map((r) => r.device.id)).toEqual(["b"]);
  });
});

describe("connect links", () => {
  test("a link nobody used expires on the clock, even before the server says", () => {
    const expiresAt = new Date(NOW.getTime() + 60_000).toISOString();
    expect(linkPhase(undefined, expiresAt, NOW.getTime())).toBe("waiting");
    expect(linkPhase({ status: "waiting" }, expiresAt, NOW.getTime() + 61_000)).toBe("expired");
    // A computer already asking keeps asking past the link's own time.
    expect(linkPhase({ status: "asking" }, expiresAt, NOW.getTime() + 61_000)).toBe("asking");
  });

  test("another computer from the app: the person's first one that wasn't there when the screen opened", () => {
    const list = [computer({ id: "old" }), computer({ id: "ana", ownerUserId: "u-ana" })];
    const known = new Set(list.map((d) => d.id));
    expect(newComputerOf(list, known, "u-sam")).toBeUndefined();
    list.push(computer({ id: "theirs", ownerUserId: "u-ana" }));
    expect(newComputerOf(list, known, "u-sam")).toBeUndefined();
    list.push(computer({ id: "mine" }));
    expect(newComputerOf(list, known, "u-sam")?.id).toBe("mine");
    expect(newComputerOf(list, known, undefined)).toBeUndefined();
  });
});

describe("connecting a phone", () => {
  test("Android: looking, then Allow, then ready; a phone already there doesn't count", () => {
    const host = computer({ phones: [phone({ id: "old" })] });
    const known = new Set(["old"]);
    expect(androidStage(host, known).kind).toBe("looking");
    host.phones.push(phone({ id: "new", status: { kind: "needs_you", reason: "unauthorized" } }));
    expect(androidStage(host, known)).toMatchObject({ kind: "allow", phone: { id: "new" } });
    host.phones[1] = phone({ id: "new" });
    expect(androidStage(host, known)).toMatchObject({ kind: "ready", phone: { id: "new" } });
  });

  test("Android by cable: the person ticks the phone-only steps, one step open, and may untick their own", () => {
    const looking = androidStage(computer({}), new Set());
    const fresh = androidSteps(looking, new Set());
    expect(fresh.states).toEqual({ devOptions: "current", usbDebugging: "waiting", plug: "waiting", allow: "waiting" });
    expect(fresh.open).toBe("devOptions");
    // Done on the phone: it ticks, and the next one opens.
    const one = androidSteps(looking, new Set(["devOptions"]));
    expect(one.states).toMatchObject({ devOptions: "done", usbDebugging: "current" });
    expect(one.open).toBe("usbDebugging");
    expect([...one.byHand]).toEqual(["devOptions"]);
    const two = androidSteps(looking, new Set(["devOptions", "usbDebugging"]));
    expect(two.states).toMatchObject({ devOptions: "done", usbDebugging: "done", plug: "current" });
    // A done step opened again stays done, and only that one is open.
    expect(androidSteps(looking, new Set(["devOptions", "usbDebugging"]), "devOptions")).toMatchObject({
      open: "devOptions",
      now: "plug",
      states: { devOptions: "done", plug: "current" },
    });
  });

  test("Android by cable: the phone shows up in any state and every step before Allow ticks by itself", () => {
    const asking = phone({ id: "new", status: { kind: "needs_you", reason: "unauthorized" } });
    const allow = androidSteps(androidStage(computer({ phones: [asking] }), new Set()), new Set());
    expect(allow.states).toEqual({ devOptions: "done", usbDebugging: "done", plug: "done", allow: "needs" });
    expect(allow.open).toBe("allow");
    // Seen by the computer: nothing is the person's word alone any more.
    expect(allow.byHand.size).toBe(0);
    // Seen without a driver: the cable step needs the person, the phone's steps are done.
    const driverless = phone({ id: "new", status: { kind: "needs_you", reason: "no_driver" } });
    const stage = androidStage(computer({ os: "windows", phones: [driverless] }), new Set(["new"]));
    expect(stage.kind).toBe("driver");
    expect(androidSteps(stage, new Set()).states).toEqual({
      devOptions: "done",
      usbDebugging: "done",
      plug: "needs",
      allow: "waiting",
    });
  });

  test("Android by cable: why a phone may not show up, the USB driver on Windows only", () => {
    expect(androidNotShowing("darwin")).toEqual(["cable", "unlocked", "fileTransfer", "usbDebugging", "samsung"]);
    expect(androidNotShowing("linux")).not.toContain("driver");
    expect(androidNotShowing("windows").at(-1)).toBe("driver");
    expect(Object.values(ANDROID_USB_DRIVERS).every((u) => u.startsWith("https://developer."))).toBe(true);
    // No driver: Windows wants the phone maker's, Linux udev rules.
    expect(fixText(t, "no_driver", "windows")).toBe("Install the phone maker's USB driver");
    expect(reasonText(t, "no_driver", "windows")).toBe("Windows has no USB driver for this phone");
    expect(fixText(t, "no_driver", "linux")).toBe("Add udev rules for this phone");
    expect(reasonText(t, "no_driver", "linux")).toBe("Linux can't open this phone");
  });

  test("iPhone: steps before the phone's reason are done, that one waits on the person", () => {
    const mac = computer({ toolchains: { xcode: "27.0", appleTeam: "Sam Rivera (Personal Team)" } });
    expect(iphoneSteps(mac, null)).toMatchObject({
      xcode: "done",
      tools: "done",
      account: "done",
      connected: "current",
    });
    expect(iphoneSteps(computer({}), null).xcode).toBe("needs");
    // No Apple Account in Xcode yet: that's the person's step.
    expect(iphoneSteps(computer({ toolchains: { xcode: "27.0" } }), null)).toMatchObject({
      account: "needs",
      connected: "waiting",
    });
    const iphone = phone({ platform: "ios", status: { kind: "needs_you", reason: "developer_mode_off" } });
    expect(Object.values(iphoneSteps(mac, iphone))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "needs",
      "waiting",
      "waiting",
    ]);
    expect(Object.values(iphoneSteps(mac, phone({ platform: "ios" }))).every((s) => s === "done")).toBe(true);
    // The Mac builds the test helper by itself; trusting it on the iPhone is the person's.
    const at = (status: PhoneDevice["status"]) => iphoneSteps(mac, phone({ platform: "ios", status }));
    expect(at({ kind: "preparing", reason: "helper_missing" }).helper).toBe("current");
    // Its build failed: the person sees it.
    expect(at({ kind: "needs_you", reason: "helper_missing" }).helper).toBe("needs");
    expect(at({ kind: "needs_you", reason: "helper_untrusted" }).helper).toBe("needs");
    expect(at({ kind: "needs_you", reason: "team_limit" }).helper).toBe("needs");
    // Plugged in, trusted and in Developer Mode before the Mac looks for the account.
    expect(at({ kind: "needs_you", reason: "apple_account_missing" })).toMatchObject({
      account: "needs",
      connected: "done",
      developerMode: "done",
      uiAutomation: "waiting",
    });
  });

  test("iPhone: restarting for Developer Mode stays on that step, then waits on the person once back", () => {
    const mac = computer({ toolchains: { xcode: "27.0", appleTeam: "Sam Rivera (Personal Team)" } });
    // Gone from the Mac while restarting: the step stays, under way, instead of asking for the cable.
    expect(Object.values(iphoneSteps(mac, null, true))).toEqual([
      "done",
      "done",
      "done",
      "done",
      "done",
      "current",
      "waiting",
      "waiting",
    ]);
    let memo: IphoneRestartMemo = NO_IPHONE_RESTART;
    let now = 0;
    const see = (phone: IphoneSeen) => {
      memo = iphoneRestartNext(memo, phone, now);
      return iphoneRestartOf(memo, phone, now);
    };
    const off = { key: "p-1", reason: "developer_mode_off" };
    expect(see(off)).toBeNull();
    now = 1000;
    expect(see(null)).toBe("restarting");
    now += IPHONE_RESTART_MS - 2000;
    expect(see(null)).toBe("restarting");
    // Back, the mode still off: it waits on the person to unlock it and tap Turn On.
    expect(see(off)).toBe("back");
    expect(see(off)).toBe("back");
    // On: done with it.
    expect(see({ key: "p-1", reason: null })).toBeNull();
    expect(see(null)).toBeNull();
    // Gone too long: plugged out, not restarting.
    expect(see(off)).toBeNull();
    now += 10;
    expect(see(null)).toBe("restarting");
    now += IPHONE_RESTART_MS;
    expect(see(null)).toBeNull();
    // Another iPhone shows up instead: its own step, nothing remembered.
    expect(see({ key: "p-2", reason: "developer_mode_off" })).toBeNull();
    // A phone gone from any other step was unplugged.
    memo = NO_IPHONE_RESTART;
    see({ key: "p-1", reason: "untrusted" });
    expect(see(null)).toBeNull();
  });

  test("iPhone: a team found without its name, an account with no team, refused taps, an iOS too old", () => {
    // A runner that tells the account apart from its team: a team is enough, an account alone is the person's step.
    expect(iphoneSteps(computer({ toolchains: { xcode: "27.0", appleAccount: "team" } }), null).account).toBe("done");
    const noTeam = computer({ toolchains: { xcode: "27.0", appleAccount: "no_team" } });
    expect(iphoneSteps(noTeam, null)).toMatchObject({ account: "needs", connected: "waiting" });
    expect(iphoneNoTeam(noTeam, null)).toBe(true);
    expect(iphoneNoTeam(computer({ toolchains: { xcode: "27.0" } }), null)).toBe(false);
    const mac = computer({ toolchains: { xcode: "27.0", appleTeam: "Sam Rivera (Personal Team)" } });
    const at = (status: PhoneDevice["status"]) => iphoneSteps(mac, phone({ platform: "ios", status }));
    const teamless = phone({ platform: "ios", status: { kind: "needs_you", reason: "apple_team_missing" } });
    expect(iphoneSteps(mac, teamless)).toMatchObject({ account: "needs", connected: "done", uiAutomation: "waiting" });
    expect(iphoneNoTeam(mac, teamless)).toBe(true);
    expect(at({ kind: "needs_you", reason: "ui_not_authorized" })).toMatchObject({
      developerMode: "done",
      uiAutomation: "needs",
      helper: "waiting",
    });
    expect(at({ kind: "needs_you", reason: "xcode_too_old" }).xcode).toBe("needs");
    // Below iOS 17 it ends at being connected: never every step done, never a spinner.
    expect(Object.values(at({ kind: "unsupported", reason: "os_too_old" }))).toEqual([
      "done",
      "done",
      "done",
      "needs",
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
  });

  test("iPhone: Xcode installed but blocked stays on the Xcode step, with the command that fixes it", () => {
    const cli = computer({ toolchains: { xcodeBlocked: "command_line_tools" } });
    expect(xcodeBlockedOf(cli)).toBe("command_line_tools");
    expect(iphoneSteps(cli, null)).toMatchObject({ xcode: "needs", tools: "waiting" });
    // One paste for either cause, with the first-launch packages the iPhone's build needs.
    expect(XCODE_FIX_COMMAND.split("\n")).toEqual([
      "sudo xcode-select -s /Applications/Xcode.app &&",
      "sudo xcodebuild -license accept &&",
      "sudo xcodebuild -runFirstLaunch",
    ]);
    expect(xcodeBlockedOf(computer({ toolchains: { xcodeBlocked: "license" } }))).toBe("license");
    // Xcode answers (a stale reason never wins), an unknown reason, nothing said: not blocked.
    expect(xcodeBlockedOf(computer({ toolchains: { xcode: "27.0", xcodeBlocked: "license" } }))).toBeNull();
    expect(xcodeBlockedOf(computer({ toolchains: { xcodeBlocked: "toString" } }))).toBeNull();
    expect(xcodeBlockedOf(computer({ toolchains: {} }))).toBeNull();
    expect(xcodeBlockedOf(undefined)).toBeNull();
    // A fix polls while the password window is open or its commands run, never after.
    expect(["asking", "running"].map((state) => xcodeFixLive({ state }))).toEqual([true, true]);
    expect(["done", "canceled", "no_answer", "failed", "unsupported"].some((state) => xcodeFixLive({ state }))).toBe(
      false,
    );
    expect(xcodeFixLive(null)).toBe(false);
  });

  test("the Xcode step's fix: the button first, the Terminal way when picked or when the Mac can't", () => {
    const may = { mayFix: true, terminal: false };
    const fix = (state: string, kind = "select") => ({ kind, state });
    expect(xcodeFixStage(null, "select", may)).toBe("offer");
    expect(xcodeFixStage(fix("asking"), "select", may)).toBe("asking");
    expect(xcodeFixStage(fix("running"), "select", { ...may, terminal: true })).toBe("running");
    expect(xcodeFixStage(fix("done"), "select", may)).toBe("done");
    expect(xcodeFixStage(fix("no_answer"), "select", may)).toBe("missed");
    expect(xcodeFixStage(fix("canceled"), "select", may)).toBe("missed");
    expect(xcodeFixStage(fix("failed"), "select", may)).toBe("failed");
    expect(xcodeFixStage(fix("failed"), "select", { ...may, terminal: true })).toBe("terminal");
    // Every command ran, yet the Mac still reports Xcode blocked: why, the command and Try again.
    expect(xcodeFixStage({ ...fix("failed"), still: "license" }, "select", may)).toBe("still");
    // Another kind's fix says nothing about this one.
    expect(xcodeFixStage(fix("asking", "update"), "select", may)).toBe("offer");
    // Someone who doesn't manage the Mac, an app too old, a Mac that can't: the command.
    expect(xcodeFixStage(null, "select", { mayFix: false, terminal: false })).toBe("terminal");
    expect(xcodeFixStage(null, "select", { ...may, outdated: true })).toBe("terminal");
    expect(xcodeFixStage(fix("unsupported"), "select", may)).toBe("terminal");
  });

  test("the new reasons in words, and an iPhone too old names its iOS", () => {
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "apple_team_missing" })).toBe(
      "Run an app on the iPhone from Xcode once",
    );
    expect(statusDetail(t, "en-US", { kind: "needs_you", reason: "ui_not_authorized" })).toBe("Unlock the iPhone");
    const old = phone({ platform: "ios", osVersion: "16.7.10", status: { kind: "unsupported", reason: "os_too_old" } });
    expect(statusDetail(t, "en-US", old.status, { ios: iosOf(old) })).toBe(
      "It runs iOS 16.7.10, agents need iOS 17 or newer",
    );
    // devicectl names no version for some iPhones below iOS 17.
    expect(statusDetail(t, "en-US", old.status, { ios: "" })).toBe(
      "It runs iOS 16 or older, agents need iOS 17 or newer",
    );
    // An Android phone keeps the general line.
    expect(iosOf(phone({ osVersion: "9" }))).toBeNull();
    expect(statusDetail(t, "en-US", old.status)).toBe("This system is too old for the tools");
  });
});

describe("pairing over Wi-Fi", () => {
  test("computers one may manage that run as a person; the live line, then the cause and the way out", () => {
    const hosts = [
      computer({ id: "mine" }),
      computer({ id: "theirs", mayManage: false }),
      computer({ id: "server", systemMode: true }),
      computer({ id: "cloud", machineKind: "managed" }),
    ];
    expect(wifiHosts(hosts).map((h) => h.id)).toEqual(["mine"]);
    const line = (p: Parameters<typeof wifiPairText>[1]) => wifiPairText(t, p, "Sam's MacBook Pro");
    expect(line({ state: "waiting", way: "qr" })).toBe("Waiting for the phone to scan…");
    expect(line({ state: "pairing", way: "qr" })).toBe("Found a phone. Pairing…");
    expect(line({ state: "connected", way: "qr" })).toBe("Paired. Connecting…");
    expect(line({ state: "failed", way: "qr", reason: "same_wifi" })).toBe(
      "Couldn't reach the phone. It's not on the same network as Sam's MacBook Pro. Put it on the same Wi-Fi and try again.",
    );
    expect(line({ state: "failed", way: "code", reason: "refused" })).toBe(
      "The phone didn't take that code. Check the code and the address, then pair again.",
    );
    expect(line({ state: "failed", way: "qr", reason: "refused" })).toBe(
      "The phone stopped the pairing. Keep its pairing screen open and try again.",
    );
    expect(line({ state: "failed", way: "qr" })).toBe("The pairing didn't work. Try again, or use a cable.");
    expect(line({ state: "failed", way: "qr", reason: "timed_out" })).toBe(
      "No phone paired in 2 minutes. If the camera scanned the code or the phone left the Wi-Fi, put it on the same Wi-Fi as Sam's MacBook Pro and scan from Wireless debugging.",
    );
    expect(line({ state: "failed", way: "qr", reason: "mdns_off" })).toBe(
      "Sam's MacBook Pro can't look for phones on the Wi-Fi. Update Android platform-tools there, or use a cable.",
    );
    // On a Mac, each cause macOS's Local Network permission also gives names that setting; other causes don't.
    const onMac = (reason: Parameters<typeof wifiPairText>[1]["reason"]) =>
      wifiPairText(t, { state: "failed", way: "code", reason }, "Sam's MacBook Pro", true);
    expect(onMac("same_wifi")).toBe(
      "Couldn't reach the phone. Put it on the same Wi-Fi as Sam's MacBook Pro. On that Mac, also turn on agentes.chat in System Settings › Privacy & Security › Local Network.",
    );
    expect(onMac("mdns_off")).toBe(
      "Sam's MacBook Pro can't look for phones on the Wi-Fi. On that Mac, turn on agentes.chat in System Settings › Privacy & Security › Local Network, then try again.",
    );
    expect(onMac("timed_out")).toEndWith(
      "On that Mac, also turn on agentes.chat in System Settings › Privacy & Security › Local Network.",
    );
    expect(onMac("refused")).toBe("The phone didn't take that code. Check the code and the address, then pair again.");
    // Those same causes, and only they, get the button to that setting in the app on that Mac.
    expect(
      (["same_wifi", "mdns_off", "timed_out", "refused", "outdated"] as const).map((reason) =>
        failedOnLocalNetwork({ state: "failed", reason }),
      ),
    ).toEqual([true, true, true, false, false]);
    expect(failedOnLocalNetwork({ state: "pairing" })).toBe(false);
    expect([
      wifiPairLive({ state: "connecting" }),
      wifiPairLive({ state: "connected" }),
      wifiPairLive(undefined),
    ]).toEqual([true, false, false]);
  });
});

describe("in the chat and the inbox", () => {
  test("a device wait: live while waiting, then one line saying how it ended", () => {
    const meta = {
      deviceWait: {
        runId: "run-1",
        device: {
          kind: "phone",
          id: "p1",
          name: "Pixel 8",
          platform: "android",
          hostId: "m",
          hostName: "Sam's MacBook Pro",
        },
        deviceName: "Pixel 8",
        hostName: "Sam's MacBook Pro",
        reason: "offline",
        detail: null,
        lastSeenAt: at(14, 2),
        state: "waiting",
      },
    };
    const w = deviceWaitOf(meta);
    expect(w).toMatchObject({
      deviceName: "Pixel 8",
      deviceId: "p1",
      kind: "phone",
      platform: "android",
      state: "waiting",
    });
    if (!w) throw new Error("parsed");
    expect(waitText(t, "en-US", w, { now: NOW })).toBe(
      "Sam's MacBook Pro is offline (last seen 2:02 PM), so I can't reach Pixel 8 on it. I'll start when it's back.",
    );
    expect(waitText(t, "en-US", { ...w, reason: "asked" }, { owner: "Sam Rivera" })).toBe(
      "I've asked Sam to let me use Pixel 8.",
    );
    expect(waitText(t, "en-US", { ...w, reason: "needs_you", detail: "developer_mode_off" })).toBe(
      "Pixel 8 can't take work yet. Developer Mode is off. I'll start when it can.",
    );
    expect(waitEndedText(t, { ...w, state: "back" })).toBe("Pixel 8 is back");
    expect(waitEndedText(t, { ...w, state: "denied" }, "Sam Rivera")).toBe("Sam said no to Pixel 8");
    expect(deviceWaitOf({ deviceWait: { state: "waiting" } })).toBeNull();
    expect(
      deviceWaitEventOf({ type: "device_wait.updated", channelId: "c", messageId: "m", deviceWait: {} } as never),
    ).toEqual({
      channelId: "c",
      threadId: null,
      messageId: "m",
      deviceWait: {},
    });
  });

  test("a device notice's parts", () => {
    const n = {
      kind: "device.access_request",
      actors: [{ type: "agent", id: "a-lia" }],
      source: { requestId: "ar1", phoneId: "p1", label: "iPhone 16", userId: "u-rui", runId: "run-1" },
      latest: { title: "Rui", text: "Record the checkout" },
    } as never;
    expect(deviceNoticeOf(n)).toMatchObject({
      kind: "device.access_request",
      requestId: "ar1",
      device: "iPhone 16",
      agentId: "a-lia",
      forName: "Rui",
    });
    expect(deviceNoticeOf({ kind: "mention", source: {}, latest: {} } as never)).toBeNull();
    // Someone asks the computer's owner to turn a tool on: the tool, and who asked (a person, not an agent).
    const ask = {
      kind: "device.tool_request",
      actors: [{ type: "user", id: "u-caio" }],
      source: { machineId: "m1", label: "Bia's Mac" },
      latest: { reason: "browser" },
    } as never;
    expect(deviceNoticeOf(ask)).toMatchObject({
      kind: "device.tool_request",
      machineId: "m1",
      device: "Bia's Mac",
      tool: "browser",
      askerId: "u-caio",
      agentId: null,
    });
    // A computer paired before lends its internet now: the computer's name is never read as a person's.
    expect(
      deviceNoticeOf({
        kind: "device.internet_shared",
        source: { machineId: "m1", label: "Bia's Mac" },
        latest: { title: "Bia's Mac" },
      } as never),
    ).toMatchObject({ kind: "device.internet_shared", machineId: "m1", device: "Bia's Mac", forName: null });
    // An agent waits for a folder: the folder in `latest.title` (never read as a person's name), the computer and the
    // agent in it.
    const folder = {
      kind: "device.folder_request",
      actors: [{ type: "agent", id: "a-lia" }],
      source: { machineId: "m1", label: "Bia's Mac", agentId: "a-lia", requestId: "fr1", userId: "u-rui" },
      latest: { title: "/Users/bia/Music", text: "the playlist" },
    } as never;
    expect(deviceNoticeOf(folder)).toMatchObject({
      kind: "device.folder_request",
      machineId: "m1",
      device: "Bia's Mac",
      path: "/Users/bia/Music",
      forName: null,
      agentId: "a-lia",
      userId: "u-rui",
      text: "the playlist",
    });
  });
});

describe("a phone's screen", () => {
  const inUse = (agentId: string | null, userId: string | null) =>
    ({
      kind: "in_use",
      agentId,
      agentName: agentId ? "Lia" : null,
      userId,
      userName: userId === "u-rui" ? "Rui Tanaka" : "Sam Rivera",
      since: at(14, 10),
    }) as const;

  test("its socket, and what each close means", () => {
    expect(phoneScreenUrl("https://app.example.com", { orgId: "o", phoneId: "p", mode: "watch", text: true })).toBe(
      "wss://app.example.com/api/phone-screen?orgId=o&phoneId=p&mode=watch&text=1",
    );
    expect(phoneCloseState(4410, "in_use")).toEqual({ state: "connecting", retry: "now", control: "in_use" });
    expect(phoneCloseState(4410, "control ended").control).toBe("lost");
    expect(phoneCloseState(4502, "unsupported").control).toBe("unsupported");
    // A workspace on hold starts nothing on its computers: control is refused, watching goes on.
    expect(phoneCloseState(4502, "held").control).toBe("held");
    expect(controlRefusalText(t, "held", { name: "Pixel 8", host: "Sam's MacBook Pro", agent: "Lia" })).toBe(
      "This workspace is paused, so control waits until it's active again.",
    );
    expect(phoneCloseState(4502, "phone_missing")).toEqual({ state: "offline", retry: "later" });
    expect(phoneCloseState(4502, "runner_outdated")).toEqual({ state: "outdated", retry: "never" });
    expect(phoneCloseState(4403)).toEqual({ state: "forbidden", retry: "never" });
    expect(phoneCloseState(1006)).toEqual({ state: "connecting", retry: "later" });
  });

  test("control that never showed a picture goes back to watching with its cause, instead of opening again behind a spinner", () => {
    const opening = { opening: true };
    const host = "Sam's MacBook Pro";
    // The server's wait ran out, or the computer said the phone wasn't ready (its helper still building).
    expect(phoneCloseState(4408, "timeout", opening)).toEqual({ state: "connecting", retry: "now", control: "late" });
    expect(phoneCloseState(4502, "phone_not_ready", opening).control).toBe("late");
    // It couldn't start there.
    expect(phoneCloseState(4502, "internal", opening).control).toBe("failed");
    expect(phoneCloseState(1011, "", opening).control).toBe("failed");
    expect(controlRefusalText(t, "late", { name: "iPhone 17", host, agent: "Lia" })).toBe(
      "Control didn't start in time. Sam's MacBook Pro is still getting iPhone 17 ready: try again in a minute.",
    );
    expect(controlRefusalText(t, "failed", { name: "iPhone 17", host, agent: "Lia" })).toBe(
      "Couldn't take control of iPhone 17. Try again, or restart the agentes.chat app on Sam's MacBook Pro.",
    );
    // A dropped connection, or an answer that already says what happened, keeps its own meaning.
    expect(phoneCloseState(1006, "", opening)).toEqual({ state: "connecting", retry: "later" });
    expect(phoneCloseState(4503, "offline", opening)).toEqual({ state: "offline", retry: "later" });
    expect(phoneCloseState(4502, "unsupported", opening).control).toBe("unsupported");
    // Once live, a close opens control again as before.
    expect(phoneCloseState(4408, "timeout")).toEqual({ state: "connecting", retry: "later" });
  });

  test("who may take control: free or theirs, or an agent they may stop; never another person's", () => {
    expect(mayTakePhone(phone({ mayManage: false }), "u-rui")).toBe(true);
    expect(mayTakePhone(phone({ mayUse: false }), "u-sam")).toBe(false);
    const agent = phone({ mayManage: false, status: inUse("a-lia", "u-sam") });
    expect(mayTakePhone(agent, "u-rui")).toBe(false);
    expect(mayTakePhone(agent, "u-sam")).toBe(true);
    expect(mayTakePhone({ ...agent, mayManage: true }, "u-rui")).toBe(true);
    const person = phone({ status: inUse(null, "u-rui") });
    expect(mayTakePhone(person, "u-sam")).toBe(false);
    expect(mayTakePhone(person, "u-rui")).toBe(true);
    // The pill names a person in control, and its detail is only the time.
    expect(statusPill(t, inUse(null, "u-rui"))).toBe("In use by Rui");
    expect(statusDetail(t, "en-US", inUse(null, "u-rui"), { now: NOW })).toBe("since 2:10 PM");
  });

  test("what covers it: the cause, and Try again only where nothing retries by itself", () => {
    const host = "Sam's MacBook Pro";
    expect(phoneScreenCover(t, "live", phone({}), host)).toBeNull();
    expect(phoneScreenCover(t, "connecting", phone({}), host)).toEqual({ title: "Opening the screen…", spinner: true });
    // Offline or waiting on its person, by its state: no socket, the fix in words.
    expect(phoneScreenCover(t, "live", phone({ status: { kind: "offline", lastSeenAt: null } }), host)?.text).toBe(
      "It shows again by itself once Sam's MacBook Pro sees it.",
    );
    expect(phoneScreenCover(t, "live", phone({ status: { kind: "needs_you", reason: "unauthorized" } }), host)).toEqual(
      { title: "Pixel 8 isn't ready", text: "Tap Allow on the phone" },
    );
    expect(phoneScreenCover(t, "live", phone({ mayUse: false }), host)?.title).toBe("You can't see this screen");
    const iphone = phone({ platform: "ios", name: "Sam's iPhone 16" });
    expect(phoneScreenCover(t, "unavailable", iphone, host)).toMatchObject({
      text: "Finish the iPhone setup on the Mac to add the test helper it needs.",
      retry: true,
    });
    expect(controlRefusalText(t, "in_use", { name: "Pixel 8", host, agent: "Lia" })).toBe(
      "Only its owner, an admin or the person Lia works for can take control.",
    );
    expect(controlRefusalText(t, "lost", { name: "Pixel 8", host, agent: "Lia" })).toBe(
      "Control ended. You're watching Pixel 8 again.",
    );
  });

  test("a press is a tap, a drag a swipe, a hold in place a long press", () => {
    expect(screenGesture({ x: 0.5, y: 0.5, at: 0 }, { x: 0.505, y: 0.5, at: 120 })).toEqual({
      type: "tap",
      x: 0.5,
      y: 0.5,
    });
    expect(screenGesture({ x: 0.5, y: 0.9, at: 0 }, { x: 0.5, y: 0.2, at: 250 })).toEqual({
      type: "swipe",
      x1: 0.5,
      y1: 0.9,
      x2: 0.5,
      y2: 0.2,
      ms: 250,
    });
    expect(screenGesture({ x: 0.3, y: 0.3, at: 0 }, { x: 0.3, y: 0.3, at: 900 })).toMatchObject({
      type: "swipe",
      ms: 900,
    });
    // Off the picture's edge: kept on it.
    expect(screenGesture({ x: 0.5, y: 0.5, at: 0 }, { x: 1.4, y: -0.2, at: 200 })).toMatchObject({ x2: 1, y2: 0 });
  });
});

describe("agents use a person's computer's internet (ADR 0237)", () => {
  test("in use now, or which computer the agents use instead; nothing while off or with nothing to lend to", () => {
    const mine = computer({ id: "m-mine", shareInternet: { on: true, inUse: false } });
    const ana = computer({ id: "m-ana", name: "Ana's iMac", shareInternet: { on: true, inUse: true } });
    const lending = lendingDevice([mine, ana]);
    expect(lending?.id).toBe("m-ana");
    expect(shareInternetText(t, ana, lending)).toBe("In use now");
    expect(shareInternetText(t, mine, lending)).toBe("Agents use Ana's iMac now");
    expect(shareInternetText(t, computer({ shareInternet: { on: false, inUse: false } }), lending)).toBeNull();
    expect(shareInternetText(t, computer({ shareInternet: null }), lending)).toBeNull();
    expect(lendingDevice([mine])).toBeNull();
  });

  test("the switch's hint: every TCP connection on the Cloud; on a self-hosted server, what follows proxy settings", () => {
    const cloud = shareInternetHint(t, { cloud: true } as never);
    expect(cloud).toContain("SSH");
    expect(cloud).toContain("port 25");
    expect(cloud).toContain("UDP");
    const own = shareInternetHint(t, { cloud: false } as never);
    expect(own).toContain("ignore proxy settings");
    expect(own).toContain("port 25");
    // Before the server's config arrives: the Cloud's words, as `selfHosted` reads it.
    expect(shareInternetHint(t, undefined)).toBe(cloud);
  });

  test("a computer that joins lends where the server says computers lend; an older server: beside the workspace's own", () => {
    expect(lendsInternet({ devices: [computer({})], lendsInternet: true })).toBe(true);
    expect(lendsInternet({ devices: [computer({ machineKind: "managed" })], lendsInternet: false })).toBe(false);
    expect(lendsInternet({ devices: [computer({ machineKind: "managed" })] })).toBe(true);
    expect(lendsInternet({ devices: [computer({})] })).toBe(false);
    expect(lendsInternet(undefined)).toBe(false);
  });

  test("where the server lends, a Linux computer that joins is a server box and borrows; on the Cloud it lends (ADR 0237)", () => {
    const here = { devices: [], lendsInternet: true, serverBoxesBorrow: true };
    expect(joinLends(here, "linux")).toBe(false);
    expect(joinLends(here, "darwin")).toBe(true);
    expect(joinLends({ devices: [], lendsInternet: true }, "linux")).toBe(true);
    expect(joinLends({ devices: [], lendsInternet: false, serverBoxesBorrow: true }, "darwin")).toBe(false);
  });
});

test("a computer's wait for an OS permission: what and where, the one way on, and who asked it for what", () => {
  const disk = { permission: "disk", trigger: "ls ~/Desktop", since: "2026-11-26T18:00:00.000Z" } as const;
  expect(permissionWaitLines(t, disk, "Sam's MacBook Pro", "Lia")).toEqual({
    title: "Waiting for Full Disk Access on Sam's MacBook Pro",
    next: "Allow it in the agentes.chat app there.",
    asked: "Asked by Lia to run ls ~/Desktop",
  });
  expect(permissionWaitLines(t, { ...disk, trigger: "" }, "Mac").asked).toBeNull();
  expect(permissionWaitLines(t, disk, "Mac").asked).toBe("Needed to run ls ~/Desktop");
  const pt = i18n.cloneInstance({ lng: "pt-BR" }).t as TFunction;
  expect(permissionWaitLines(pt, { ...disk, permission: "screen" }, "iMac").title).toBe(
    "Aguardando Gravação de Tela em iMac",
  );
});

test("Ligar on an offline simulator, Desligar on one running and free; never a real phone, its Mac away, or held", () => {
  const sim = (p: Partial<PhoneDevice>) => phone({ platform: "ios", phoneKind: "simulator", ...p });
  const off = { kind: "offline", lastSeenAt: null } as const;
  expect(powerChoice(sim({ status: off }))).toBe("start");
  expect(powerChoice(phone({ phoneKind: "emulator", status: off }))).toBe("start");
  expect(powerChoice(sim({ status: { kind: "ready" } }))).toBe("stop");
  expect(powerChoice(sim({ status: { kind: "preparing", reason: "booting" } }))).toBe("stop");
  expect(powerChoice(phone({ status: off }))).toBeNull();
  expect(powerChoice(sim({ status: { ...off, withHost: true } }))).toBeNull();
  expect(
    powerChoice(
      sim({ status: { kind: "in_use", agentId: "a", agentName: "Lia", userId: null, userName: null, since: "" } }),
    ),
  ).toBeNull();
  expect(powerChoice(sim({ status: off, mayUse: false, mayManage: false }))).toBeNull();
  // The Mac's refusals in words: Xcode or the emulator missing, by platform; what it said when it failed.
  const said = (code: string, params: Record<string, unknown>) => errorText(t, new ApiError(409, code, "", params));
  expect(said("device.power_tool_missing", { platform: "ios", computer: "MacBook" })).toBe(
    "MacBook needs Xcode to run simulators. Install Xcode from the App Store on that Mac.",
  );
  expect(said("device.power_tool_missing", { platform: "android", computer: "Build PC" })).toStartWith(
    "Build PC doesn't have the Android Emulator.",
  );
  expect(said("device.power_start_failed", { name: "Pixel 8", computer: "Build PC", why: "PANIC: no image" })).toBe(
    "Pixel 8 didn't start. Build PC said: PANIC: no image",
  );
});

describe("a computer's system and processor", () => {
  test("the version and the processor's name its runner said, the cores aside; an older runner's family and threads", () => {
    const said = computer({ cpus: 14, cores: 14, cpuModel: "Apple M4 Pro", system: "macOS 26.1" });
    expect(systemText(t, said)).toBe("macOS 26.1");
    expect(processorText(t, said)).toEqual({ name: "Apple M4 Pro", cores: "14 cores" });
    // Logical CPUs are threads: cores only where the runner counted them.
    expect(processorText(t, computer({ cpus: 16, cores: 8, cpuModel: "AMD Ryzen 7 7700X" }))).toEqual({
      name: "AMD Ryzen 7 7700X",
      cores: "8 cores, 16 threads",
    });
    expect(processorText(t, computer({ cpus: 16, cores: null, cpuModel: "Intel Core i7-12700H" }))).toEqual({
      name: "Intel Core i7-12700H",
      cores: "16 threads",
    });
    const older = computer({});
    expect(systemText(t, older)).toBe("macOS");
    expect(processorText(t, older)).toEqual({ name: "12 threads", cores: null });
    expect(processorText(t, computer({ cpus: null }))).toBeNull();
    expect(processorText(t, computer({ cpus: null, cpuModel: "AMD EPYC 7763" }))).toEqual({
      name: "AMD EPYC 7763",
      cores: null,
    });
  });
});
