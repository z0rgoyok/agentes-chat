import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../src/api/http";
import { keys } from "../src/api/keys";
import type { AccountLoginStatus, AppNotification, Machine, MachineAccount } from "../src/api/types";
import {
  type AccountLoginInput,
  allowedFolders,
  allowFolderCommand,
  allowsInApp,
  beginLogin,
  brainTool,
  browserNoAnswerMessage,
  browserOffMessage,
  CLI_GIT_MISSING,
  CLI_HOME_ONLY,
  cliCommandWayOut,
  cliInstallCommand,
  cliInstallFailure,
  cliOneClick,
  codexSandboxNote,
  commandInReason,
  computerKind,
  computerState,
  computerStorage,
  desktopTargetOf,
  downloadHref,
  egressOfflineText,
  egressViaParts,
  egressViaText,
  folderName,
  foldersOfAgent,
  formatUserCode,
  freeDuplicate,
  geminiNotShared,
  installableCli,
  installCommand,
  isHandheld,
  isPaused,
  isUrlWithoutCode,
  LOGIN_RECONNECT_MS,
  LoginReadError,
  locationText,
  loginFailureLine,
  loginRead,
  loginReadPasses,
  machineReasonText,
  normalizeUserCode,
  oneClickTerminal,
  otherThanHint,
  pausedByText,
  pauseUntil,
  platformOf,
  profileRefusalLine,
  profileToolOff,
  sharedFolderFacts,
  sharedFolderOf,
  shellQuote,
  toolOnCommand,
  toolOneClick,
} from "../src/lib/machines";
import { gateLine } from "../src/lib/no-ai";
import { openTarget, workspaceHeadline } from "../src/lib/notifications";
import { accessOf, applyComputerEvent, applyMachineEvent, pauseOf } from "../src/realtime/machines";

describe("connected computers helpers (ADR 0036)", () => {
  test("device codes: normalized for the API, shown with a dot to compare", () => {
    expect(normalizeUserCode(" k7q·4zp")).toBe("K7Q4ZP");
    // Letters that look alike (0/O, 1/I/L) are never in a code.
    expect(normalizeUserCode("O0I1L")).toBe("");
    expect(formatUserCode("K7Q4ZP")).toBe("K7Q·4ZP");
    expect(formatUserCode("K7Q")).toBe("K7Q");
  });

  test("commands: the installer has no code; granting quotes paths that need it", () => {
    expect(installCommand("https://app.agentes.chat/")).toBe(
      "curl -fsSL https://app.agentes.chat/api/machines/install.sh | sh",
    );
    expect(allowFolderCommand("/Users/you/Projects/loja-v5", "bento")).toBe(
      "agentes-runner folders allow /Users/you/Projects/loja-v5 --agent bento",
    );
    expect(allowFolderCommand("/Users/you/Meus Projetos")).toBe(
      "agentes-runner folders allow '/Users/you/Meus Projetos'",
    );
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    // What a runner says is missing: the command in it, to copy.
    expect(commandInReason("Install what desktop use needs: `sudo apt install xdotool` (missing: xdotool)")).toBe(
      "sudo apt install xdotool",
    );
    expect(commandInReason("Desktop use runs on Linux computers only")).toBeNull();
    expect(commandInReason(null)).toBeNull();
  });

  test("why a computer can't yet: the runner's code in the person's words; an older runner's own English as it is", async () => {
    const { ptBR, resources } = await import("@agenteschat/i18n");
    const i18next = (await import("i18next")).default;
    const instance = i18next.createInstance();
    void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const t = instance.t;
    const download = "Couldn't download the agent browser: fetch failed";
    expect(machineReasonText(t, { reason: download, code: "browser_download" })).toBe(
      ptBR.machines.reasons.browser_download,
    );
    expect(machineReasonText(t, { reason: download, code: null })).toBe(download);
    // A code this app has no words for yet: the runner's own.
    expect(machineReasonText(t, { reason: download, code: "browser_new_thing" })).toBe(download);
    expect(machineReasonText(t, null)).toBeNull();
    // A runner from before codes, its install sentence with the command in it: the app's words, the command in its block.
    const install = "Install what desktop use needs: `sudo apt install xdotool` (missing: xdotool)";
    expect(machineReasonText(t, { reason: install }, "desktop_use_install")).toBe(
      ptBR.machines.reasons.desktop_use_install,
    );
    expect(machineReasonText(t, { reason: "Desktop use runs on Linux computers only" }, "desktop_use_install")).toBe(
      "Desktop use runs on Linux computers only",
    );
  });

  test("folders: the name, and the ones an agent may use", () => {
    expect(folderName("/Users/you/Projects/loja-v5/")).toBe("loja-v5");
    expect(folderName("C:\\Users\\w\\docs")).toBe("docs");
    const access = {
      folders: [
        { path: "/a", agents: ["x"] },
        { path: "/b", agents: [] },
      ],
      tools: { claude: true, codex: false, commands: false },
    };
    expect(foldersOfAgent(access, "x").map((f) => f.path)).toEqual(["/a"]);
    expect(foldersOfAgent(null, "x")).toEqual([]);
  });

  test("pause: until resumed, until a time, or over", () => {
    const now = Date.parse("2026-10-17T15:00:00.000Z");
    expect(isPaused({ paused: { paused: true, until: null } }, now)).toBe(true);
    expect(isPaused({ paused: { paused: true, until: "2026-10-17T16:24:00.000Z" } }, now)).toBe(true);
    expect(isPaused({ paused: { paused: true, until: "2026-10-17T14:00:00.000Z" } }, now)).toBe(false);
    expect(isPaused({ paused: { paused: false } }, now)).toBe(false);
    expect(isPaused({}, now)).toBe(false);
  });

  test("events are checked before they touch the cache", () => {
    expect(pauseOf({ paused: true })).toEqual({ paused: true, until: null });
    // The server's own shape: `{ until }` while paused, null when not.
    expect(pauseOf({ until: "2026-10-17T16:24:00.000Z", timezone: null })).toEqual({
      paused: true,
      until: "2026-10-17T16:24:00.000Z",
    });
    expect(pauseOf(null)).toEqual({ paused: false });
    expect(isPaused({ paused: { until: null } })).toBe(true);
    expect(isPaused({ paused: null })).toBe(false);
    expect(pauseOf({ paused: false, until: "x" })).toEqual({ paused: false });
    expect(pauseOf("yes")).toBeUndefined();
    // Who paused it from the apps comes along only when the event says so.
    expect(pauseOf({ until: null, by: { id: "u1", name: "Ana" } })).toEqual({
      paused: true,
      until: null,
      by: { id: "u1", name: "Ana" },
    });
    expect(pauseOf({ until: null, by: "u1" })).toEqual({ paused: true, until: null });
    expect(accessOf(null)).toBeNull();
    expect(accessOf({ folders: "no" })).toBeUndefined();
  });

  test("download link and location", () => {
    expect(downloadHref("/api/desktop/download/0.2.0/a.dmg", "https://app.agentes.chat")).toBe(
      "https://app.agentes.chat/api/desktop/download/0.2.0/a.dmg",
    );
    expect(downloadHref("https://cdn.example/a.dmg", "https://app.agentes.chat")).toBe("https://cdn.example/a.dmg");
    expect(locationText({ city: "Curitiba", region: null, country: "Brasil" })).toBe("Curitiba, Brasil");
  });

  test("the app to download follows the visitor's system: one build for both Mac chips, x64 or ARM64 elsewhere", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
    const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
    const linux = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
    const arm = "Mozilla/5.0 (X11; Linux aarch64; rv:131.0) Gecko/20100101 Firefox/131.0";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
    expect([mac, windows, linux].map(platformOf)).toEqual(["mac", "windows", "linux"]);
    expect(desktopTargetOf(mac)).toEqual({ target: "darwin", arch: "aarch64" });
    expect(desktopTargetOf(windows)).toEqual({ target: "windows", arch: "x86_64" });
    expect(desktopTargetOf(linux)).toEqual({ target: "linux", arch: "x86_64" });
    expect(desktopTargetOf(arm)).toEqual({ target: "linux", arch: "aarch64" });
    // A Windows browser says x64 on ARM too: only its own report of the chip tells.
    expect(desktopTargetOf(windows, "arm")).toEqual({ target: "windows", arch: "aarch64" });
    expect(desktopTargetOf(windows, "x86")).toEqual({ target: "windows", arch: "x86_64" });
    // A phone reads as Linux or a Mac, and a Linux on another chip has no build: none of them gets one.
    const armv7 = "Mozilla/5.0 (X11; Linux armv7l; rv:131.0) Gecko/20100101 Firefox/131.0";
    expect([platformOf(android), platformOf(iphone)]).toEqual(["linux", "mac"]);
    expect([android, iphone, armv7].map((ua) => desktopTargetOf(ua))).toEqual([null, null, null]);
    expect([android, iphone, linux, mac].map(isHandheld)).toEqual([true, true, false, false]);
  });

  test("a tool turned off: its command (sudo in system mode), the app only on a Mac or a PC, a brain's switch by name", () => {
    expect(toolOnCommand({ mode: "single" }, "browser")).toBe("agentes-runner tools enable browser");
    expect(toolOnCommand({ mode: "system" }, "desktop")).toBe("sudo agentes-runner tools enable desktop");
    expect([allowsInApp("darwin"), allowsInApp("windows"), allowsInApp("linux"), allowsInApp("other")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(brainTool("claude_code")).toBe("claude");
    expect(brainTool("opencode")).toBe("opencode");
  });

  test("portraits: the kind from the machine's os, the state with pause over online", () => {
    expect(computerKind("darwin")).toBe("mac");
    expect(computerKind("windows")).toBe("windows");
    expect(computerKind("linux")).toBe("linux");
    expect(computerKind("other")).toBe("linux");
    expect(computerKind(null)).toBe("linux");
    expect(computerState({ online: true, paused: null })).toBe("online");
    expect(computerState({ online: false, paused: null })).toBe("offline");
    expect(computerState({ online: true, paused: { until: null } })).toBe("paused");
    expect(computerState({ online: true, paused: { until: "2026-01-01T00:00:00Z" } }, Date.parse("2026-02-01"))).toBe(
      "online",
    );
  });

  test("the browser and who thinks refetch when the computer allows something new, or the agent moves", () => {
    const qc = new QueryClient();
    const browser = keys.agentBrowser("o1", "a1");
    const brain = keys.agentBrain("o1", "a1");
    const stale = () => [browser, brain].map((k) => qc.getQueryState(k)?.isInvalidated ?? false);
    const fresh = () => {
      qc.setQueryData(browser, { available: false });
      qc.setQueryData(brain, { brain: "model" });
    };
    fresh();
    // A rename alone changes neither.
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", name: "Mac" } as { type: string });
    expect(stale()).toEqual([false, false]);
    // The person turned the browser on in the app's Ferramentas: no reload needed.
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", access: true } as { type: string });
    expect(stale()).toEqual([true, true]);
    fresh();
    // A plan's program installed there since it connected (`executors.changed`): its sign-in turns on in place.
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", executors: true } as { type: string });
    expect(stale()).toEqual([true, true]);
    fresh();
    applyComputerEvent(qc, "o1", { type: "agent.computer", agentId: "a1", target: { kind: "none" } } as {
      type: string;
    });
    expect(stale()).toEqual([true, true]);
  });

  test("the agents' screens refetch when the computer changes, so a browser card on one goes back to frames", () => {
    const qc = new QueryClient();
    const desk = keys.agentDesktop("o1", "a1");
    const other = keys.agentDesktop("o1", "a2");
    const stale = () => [desk, other].map((k) => qc.getQueryState(k)?.isInvalidated ?? false);
    const fresh = () => {
      qc.setQueryData(desk, { available: true });
      qc.setQueryData(other, { available: true });
    };
    fresh();
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", name: "Mac" } as { type: string });
    expect(stale()).toEqual([false, false]);
    // Offline, its switches, its agents moving: every agent's screen.
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
    expect(stale()).toEqual([true, true]);
    fresh();
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", access: true } as { type: string });
    expect(stale()).toEqual([true, true]);
    fresh();
    // An agent's own computer changing: that agent's screen.
    applyComputerEvent(qc, "o1", { type: "agent.computer", agentId: "a1" } as { type: string });
    expect(stale()).toEqual([true, false]);
    // Never its picture: each one asked again is a capture on the computer.
    const picture = keys.agentDesktopPicture("o1", "a1");
    qc.setQueryData(picture, { picture: null });
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
    applyComputerEvent(qc, "o1", { type: "agent.computer", agentId: "a1" } as { type: string });
    expect(qc.getQueryState(picture)?.isInvalidated).toBe(false);
  });

  test("a computer in standby going quiet reads online still; its hello ends the standby", () => {
    const qc = new QueryClient();
    const list = keys.machines("o1");
    qc.setQueryData(list, [{ id: "m1", kind: "managed", online: true, standby: true, lastSeenAt: null }]);
    const m1 = () => (qc.getQueryData(list) as { online: boolean; standby: boolean }[])[0];
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
    expect(m1()).toMatchObject({ online: true, standby: true });
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: true } as { type: string });
    expect(m1()).toMatchObject({ online: true, standby: false });
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
    expect(m1()?.online).toBe(false);
  });

  test("put in standby after it went quiet: the list and its agents' computer read online again", () => {
    const qc = new QueryClient();
    const list = keys.machines("o1");
    const target = keys.computers("o1");
    qc.setQueryData(list, [{ id: "m1", kind: "managed", online: true, standby: false, lastSeenAt: null }]);
    qc.setQueryData(target, { target: { kind: "machine", machineId: "m1", name: "Box", online: true } });
    const m1 = () => (qc.getQueryData(list) as { online: boolean; standby: boolean }[])[0];
    const t1 = () => (qc.getQueryData(target) as { target: { online: boolean } }).target;
    applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
    expect(m1()?.online).toBe(false);
    expect(t1().online).toBe(false);
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", standby: true } as { type: string });
    expect(m1()).toMatchObject({ online: true, standby: true });
    expect(t1().online).toBe(true);
  });

  test("a wake that failed (or the standby taken back): no longer waking, and the list and its agents' computer refetch", () => {
    const qc = new QueryClient();
    const list = keys.machines("o1");
    const target = keys.computers("o1");
    qc.setQueryData(list, [{ id: "m1", kind: "managed", online: true, standby: true, lastSeenAt: null }]);
    qc.setQueryData(target, { target: { kind: "machine", machineId: "m1", name: "Box", online: true } });
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", standby: false } as { type: string });
    expect((qc.getQueryData(list) as { standby: boolean }[])[0]?.standby).toBe(false);
    expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(target)?.isInvalidated).toBe(true);
  });

  test("a plan's usage moving on a computer refetches the agent list, which carries each plan's limits", () => {
    const qc = new QueryClient();
    const agents = keys.agents("o1");
    const stale = () => qc.getQueryState(agents)?.isInvalidated ?? false;
    qc.setQueryData(agents, []);
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", name: "Mac" } as { type: string });
    expect(stale()).toBe(false);
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", accounts: true } as { type: string });
    expect(stale()).toBe(true);
  });

  test("a sign-in starts with no address asked: Claude's hint is the account's own, dropped if the server refuses it", async () => {
    const sent: AccountLoginInput[] = [];
    const begin = async (input: AccountLoginInput) => {
      sent.push(input);
      return input;
    };
    // A first sign-in names nothing; signing in again names the account, and Claude gets its email as the hint.
    expect(await beginLogin(begin, "claude_code", {})).toEqual({});
    expect(await beginLogin(begin, "claude_code", { again: "a1", hint: "walt@acme.com" })).toEqual({
      accountId: "a1",
      email: "walt@acme.com",
    });
    // ChatGPT and a coding plan's key take no hint.
    expect(await beginLogin(begin, "codex", { again: "a2", hint: "walt@acme.com" })).toEqual({ accountId: "a2" });
    expect(await beginLogin(begin, "claude_code", { provider: "zai", hint: "walt@acme.com" })).toEqual({
      provider: "zai",
    });
    // The hint only steered Claude's page: refused, the sign-in starts without it; anything else stays an error.
    const strict = async (input: AccountLoginInput) => {
      if (input.email) throw new ApiError(400, "account.invalid_email", "Use a plain email address");
      return begin(input);
    };
    sent.length = 0;
    expect(await beginLogin(strict, "claude_code", { again: "a1", hint: "o'brien@acme.com" })).toEqual({
      accountId: "a1",
    });
    expect(sent).toEqual([{ accountId: "a1" }]);
    const offline = async (): Promise<AccountLoginInput> => {
      throw new ApiError(409, "machine.offline", "Offline");
    };
    expect(await beginLogin(offline, "claude_code", { hint: "walt@acme.com" }).catch((e) => e.code)).toBe(
      "machine.offline",
    );
  });

  test("the account a sign-in came back as, already there: theirs to use while it's signed in and thinks for no one", () => {
    const account: MachineAccount = {
      id: "a1",
      kind: "claude_code",
      label: "Claude Max",
      email: "walt@acme.com",
      plan: "max",
      status: "active",
      ownerId: "u1",
      ownerName: "Walter",
      mine: true,
      usedBy: [],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const failed = (duplicate: AccountLoginStatus["duplicate"]): AccountLoginStatus => ({ state: "failed", duplicate });
    expect(freeDuplicate(failed({ label: "Claude Max", account }))).toBe(account);
    expect(freeDuplicate(failed({ label: "Claude Max", account: { ...account, usedBy: ["Theo"] } }))).toBeNull();
    // One for all of the person's agents there thinks for this one too.
    const forAll = { ...account, usedBy: ["Theo"], shared: true };
    expect(freeDuplicate(failed({ label: "Claude Max", account: forAll }))).toBe(forAll);
    expect(freeDuplicate(failed({ label: "Claude Max", account: { ...account, status: "signed_out" } }))).toBeNull();
    // An older server names it only.
    expect(freeDuplicate(failed({ label: "Claude Max" }))).toBeNull();
    expect(freeDuplicate({ state: "failed" })).toBeNull();
    expect(freeDuplicate(undefined)).toBeNull();
  });

  test("a Gemini sign-in the computer couldn't share with every agent: trying again ends the same way", () => {
    expect(geminiNotShared("antigravity", { state: "failed", code: "not_kept" })).toBe(true);
    // Claude's token the computer couldn't write, and Gemini's other failures, may pass on another try.
    expect(geminiNotShared("claude_code", { state: "failed", code: "not_kept" })).toBe(false);
    expect(geminiNotShared("antigravity", { state: "failed", code: "bad_code" })).toBe(false);
    expect(geminiNotShared("antigravity", { state: "failed" })).toBe(false);
    expect(geminiNotShared("antigravity", undefined)).toBe(false);
  });

  test("a new sign-in is another account only when its hint named a different email", () => {
    expect(otherThanHint("walt@pessoal.com", { email: "walt@acme.com" })).toBe(true);
    expect(otherThanHint("Walt@Pessoal.com", { email: "walt@pessoal.com" })).toBe(false);
    // No hint (Claude's page picked), or no email to compare: the account that came back is the one.
    expect(otherThanHint(null, { email: "walt@acme.com" })).toBe(false);
    expect(otherThanHint(undefined, { email: "walt@acme.com" })).toBe(false);
    expect(otherThanHint("walt@pessoal.com", { email: null })).toBe(false);
  });

  test("a sign-in's status that can't be read: reconnecting for 90 s from the first failed read, if it passes", () => {
    // A restart that misses the runner's fifth dial (`reconnectDelay`: within 1, 2, 4, 8, 16, then 32 s after a drop)
    // has it back at the sixth: still waiting then, and for the next read 2 s on.
    const sixthDial = [1, 2, 4, 8, 16, 32].reduce((at, s) => at + s, 0) * 1000;
    expect(LOGIN_RECONNECT_MS).toBeGreaterThan(sixthDial + 2_000);
    // The server restarting (no answer, or only the proxy's) or the computer reconnecting (offline, late).
    for (const error of [
      new TypeError("Failed to fetch"),
      new ApiError(502, "http_502", "Bad Gateway"),
      new ApiError(521, "http_521", "Web server is down"),
      new ApiError(409, "machine.offline", "The computer agentes.chat isn't answering right now."),
      new ApiError(502, "machine.timeout", "the computer agentes.chat did not answer in time"),
    ])
      expect(loginReadPasses(error)).toBe(true);
    // The sign-in gone from the server or the computer, the session over, or the server's own error.
    const gone = [
      new ApiError(404, "account.login_not_found", "Sign-in not found"),
      new ApiError(502, "machine.not_found", "This sign-in is gone (it expired or was canceled)"),
      new ApiError(401, "unauthorized", "Sign in again"),
      new ApiError(500, "internal", "Internal error"),
    ];
    for (const error of gone) expect(loginReadPasses(error)).toBe(false);
    const first = Date.parse("2026-10-30T12:00:00Z");
    const failing = (afterMs: number) => ({
      isError: true,
      error: new LoginReadError(new TypeError("Failed to fetch"), first),
      errorUpdatedAt: first + afterMs,
    });
    expect(loginRead(failing(0))).toBe("reconnecting");
    expect(loginRead(failing(LOGIN_RECONNECT_MS - 1))).toBe("reconnecting");
    expect(loginRead(failing(LOGIN_RECONNECT_MS))).toBe("noAnswer");
    for (const error of gone) expect(loginRead({ isError: true, error, errorUpdatedAt: first })).toBe("failed");
    expect(loginRead({ isError: false, error: null, errorUpdatedAt: first })).toBeNull();
  });
});

test("an observed exit address updates live, its country left to the server, and is cleared across connection changes", () => {
  const qc = new QueryClient();
  const list = keys.machines("o1");
  qc.setQueryData(list, [{ id: "m1", kind: "managed", online: true, egress: null }]);
  const event = (value: Record<string, unknown>) =>
    applyMachineEvent(qc, "o1", { type: "machine.updated", machineId: "m1", ...value } as { type: string });
  const current = () => qc.getQueryData<Machine[]>(list)?.[0]?.egress;
  const first = { ip: "8.8.8.8", country: "US", at: "2026-11-01T12:00:00Z" };
  event({ egress: first });
  // The event can't tell whether it was seen on the route the agents take now: no flag until the list says.
  expect(current()).toEqual({ ip: "8.8.8.8", at: first.at });
  expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
  event({ egress: { ip: "1.1.1.1", country: 42, at: first.at } });
  expect(current()).toEqual({ ip: "1.1.1.1", at: first.at });
  event({ egress: { ip: "<bad>", at: first.at } });
  expect(current()?.ip).toBe("1.1.1.1");
  event({ egress: null });
  expect(current()).toBeNull();
  event({ egress: first });
  applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: false } as { type: string });
  expect(current()).toBeNull();
  applyMachineEvent(qc, "o1", { type: "machine.status", machineId: "m1", online: true } as { type: string });
  expect(current()).toBeNull();
  qc.clear();
});

test("personal machine updates discard old-server public addresses", () => {
  const qc = new QueryClient();
  const list = keys.machines("o1");
  qc.setQueryData(list, [{ id: "m1", kind: "connected", online: true, egress: null }]);
  applyMachineEvent(qc, "o1", {
    type: "machine.updated",
    machineId: "m1",
    egress: { ip: "8.8.8.8", country: "US", at: "2026-11-01T12:00:00Z" },
  } as { type: string });
  expect(qc.getQueryData<Machine[]>(list)?.[0]?.egress).toBeNull();
  qc.clear();
});

describe("the shared folder (ADR 0115)", () => {
  test("is the folder granted to every agent; an agent's own list leaves it out; its disk notice opens the computer", () => {
    const access = {
      folders: [
        { path: "/srv/data", agents: ["ada"] },
        { path: "/srv/agentes/shared", agents: ["*"] },
      ],
      tools: { claude: true, codex: true, commands: true },
    };
    expect(sharedFolderOf(access)).toBe("/srv/agentes/shared");
    expect(sharedFolderOf({ ...access, folders: [access.folders[0] as (typeof access.folders)[0]] })).toBeNull();
    expect(sharedFolderOf(null)).toBeNull();
    expect(foldersOfAgent(access, "ada").map((f) => f.path)).toEqual(["/srv/data"]);
    const notice = {
      kind: "computer_disk_full",
      source: { machineId: "m1", label: "Build box" },
      latest: { diskUse: 0.91 },
    } as unknown as AppNotification;
    expect(workspaceHeadline(notice)).toBe("machines.shared.diskFullNotice");
    expect(openTarget(notice)).toEqual({
      to: "/org/$orgId/settings/computers/$machineId",
      params: { machineId: "m1" },
    });
    // A computer without Google Chrome (ADR 0133): its own headline, and it opens that computer too.
    const noChrome = { ...notice, kind: "computer_no_chrome", latest: {} } as AppNotification;
    expect(workspaceHeadline(noChrome)).toBe("machines.chromeMissingNotice");
    expect(openTarget(noChrome)).toEqual(openTarget(notice));
  });

  test("the folders people allowed leave it out (web and phone show it on its own row); its facts", () => {
    const access = {
      folders: [
        { path: "/srv/data", agents: ["ada"] },
        { path: "/srv/agentes/shared", agents: ["*"] },
      ],
      tools: { claude: true, codex: true, commands: true },
    };
    expect(allowedFolders(access).map((f) => f.path)).toEqual(["/srv/data"]);
    expect(allowedFolders({ ...access, folders: [access.folders[1] as (typeof access.folders)[0]] })).toEqual([]);
    expect(allowedFolders(null)).toEqual([]);
    const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
    expect(sharedFolderFacts(t, "en", { freeGb: 42.5, use: 0.8, sharedGb: 3.2 })).toBe(
      'machines.shared.size{"size":"3.2 GB"} · machines.shared.free{"free":"43 GB"}',
    );
    expect(sharedFolderFacts(t, "en", null)).toBe("machines.shared.measuring");
  });

  test("a computer's storage: its size, what is in use, what takes it by kind with the rest as Other, and when it fills up", () => {
    const parts = { projects: 20, apps: 10, agents: 30, caches: 8, system: 0 };
    const s = computerStorage({ freeGb: 20, use: 0.8, sharedGb: null, sizeGb: 100, parts });
    expect(s).toMatchObject({ sizeGb: 100, usedGb: 80, freeGb: 20, full: false });
    // A kind that takes nothing draws nothing; what no kind covers is Other, in its gray.
    expect(s?.parts.map((p) => [p.key, p.gb])).toEqual([
      ["projects", 20],
      ["apps", 10],
      ["agents", 30],
      ["caches", 8],
      ["other", 12],
    ]);
    expect(s?.parts.at(-1)).toMatchObject({ light: "#9a9a94", dark: "#6f6f6a" });
    expect(new Set(s?.parts.map((p) => p.light)).size).toBe(5);
    expect(computerStorage({ freeGb: 10, use: 0.9, sharedGb: null, sizeGb: 100, parts })?.full).toBe(true);
    // Counted over what df says is used (rounding): no negative Other.
    expect(computerStorage({ freeGb: 40, use: 0.6, sharedGb: null, sizeGb: 100, parts })?.parts.at(-1)?.key).toBe(
      "caches",
    );
    // An older runner: the size from what is free and the share in use, no parts yet.
    expect(computerStorage({ freeGb: 25, use: 0.75, sharedGb: null })).toMatchObject({ sizeGb: 100, parts: [] });
    expect(computerStorage({ freeGb: 25, use: null, sharedGb: null })).toBeNull();
    expect(computerStorage(null)).toBeNull();
  });

  test("why a sign-in ended: a line per code, the CLI's words under three of them, none when canceled", () => {
    const add = "agentPage.work.brain.add";
    const worded = [
      "not_installed",
      "no_tty",
      "network",
      "bad_code",
      "cli_exit",
      "not_signed_in_after_login",
      "status_unknown",
      "no_token",
      "not_kept",
      "sandbox",
    ];
    for (const code of worded) {
      expect(loginFailureLine(code)).toEqual({
        key: `${add}.why.${code}`,
        detail: code === "cli_exit" || code === "not_signed_in_after_login" || code === "sandbox",
      } as never);
    }
    // Too long is what an expired sign-in already says.
    expect(loginFailureLine("timeout")).toEqual({ key: `${add}.expired`, detail: false });
    expect(loginFailureLine("canceled")).toEqual({ key: null, detail: false });
    // An older runner sends no code, a newer one may send one this app doesn't know: the plain line.
    for (const code of [undefined, null, "", "something_new", "toString"]) {
      expect(loginFailureLine(code)).toEqual({ key: `${add}.failed`, detail: false });
    }
  });

  test("a pasted address without a code is told from a code and from an address that carries one", () => {
    for (const url of [
      "https://example.com/oauth-callback",
      " https://example.com/oauth-callback?state=abc ",
      "http://localhost:8085/?code=",
      "HTTPS://example.com/#code=4/0Afake",
      "https://",
    ]) {
      expect(isUrlWithoutCode(url)).toBe(true);
    }
    for (const ok of [
      "",
      "4/0AfakeCode",
      "https://example.com/callback?code=4%2F0Afake&state=abc",
      "code=abc",
      "http",
    ]) {
      expect(isUrlWithoutCode(ok)).toBe(false);
    }
  });
});

describe("pausing from the apps", () => {
  test("an hour, tomorrow at 9:00 local time, or until resumed", () => {
    const now = new Date(2026, 10, 11, 15, 30);
    expect(pauseUntil("1h", now)).toBe(new Date(2026, 10, 11, 16, 30).toISOString());
    expect(pauseUntil("tomorrow", now)).toBe(new Date(2026, 10, 12, 9, 0).toISOString());
    expect(pauseUntil("manual", now)).toBeNull();
  });

  test("the line says who paused it, and nothing for a pause on the computer", () => {
    const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
    expect(pausedByText(t, "en", { until: null }, "u1")).toBeNull();
    expect(pausedByText(t, "en", { until: null, by: { id: "u1", name: "Ana" } }, "u1")).toBe(
      "machines.remotePause.byYou",
    );
    expect(pausedByText(t, "en", { until: null, by: { id: "u2", name: "Bia" } }, "u1")).toBe(
      'machines.remotePause.byName{"name":"Bia"}',
    );
  });
});

describe("one click where a tool is off (ADR 0036 §8)", () => {
  const bia = { id: "u-bia", name: "Bia Rocha" };
  const mac = { kind: "connected", pairedBy: bia, accessAllow: true } as Pick<
    Machine,
    "kind" | "pairedBy" | "accessAllow"
  >;

  test("whoever connected it turns it on; anyone else asks them; an old app updates first; the Cloud's never", () => {
    expect(toolOneClick(mac, "u-bia")).toEqual({ kind: "allow" });
    expect(toolOneClick({ ...mac, accessAllow: false }, "u-bia")).toEqual({ kind: "outdated" });
    expect(toolOneClick(mac, "u-caio")).toEqual({ kind: "ask", ownerId: "u-bia", ownerName: "Bia Rocha" });
    expect(toolOneClick({ ...mac, kind: "managed" }, "u-bia")).toBeNull();
    expect(toolOneClick({ ...mac, pairedBy: null }, "u-caio")).toBeNull();
    expect(toolOneClick(null, "u-bia")).toBeNull();
  });

  test("a coding CLI: whoever connected it installs it, anyone else asks, never where no installer runs", () => {
    const pc = { kind: "connected", pairedBy: bia, cliInstall: true, os: "windows", mode: "single" } as Pick<
      Machine,
      "kind" | "pairedBy" | "cliInstall" | "os" | "mode"
    >;
    expect(cliOneClick(pc, "u-bia", "claude")).toEqual({ kind: "allow" });
    expect(cliOneClick({ ...pc, cliInstall: false }, "u-bia", "claude")).toEqual({ kind: "outdated" });
    expect(cliOneClick(pc, "u-caio", "claude")).toEqual({ kind: "ask", ownerId: "u-bia", ownerName: "Bia Rocha" });
    // OpenAI's Windows build has no installer of its own; root's agents get theirs from the computer's setup.
    expect(cliOneClick(pc, "u-bia", "codex")).toBeNull();
    expect(cliOneClick({ ...pc, os: "darwin" }, "u-bia", "codex")).toEqual({ kind: "allow" });
    expect(cliOneClick({ ...pc, os: "linux", mode: "system" }, "u-bia", "claude")).toBeNull();
    // A system-mode runner that installs its own copy for all of its agents' users: the same button.
    const agents = { ...pc, os: "linux", mode: "system" as const, cliFetchable: ["claude", "codex"] };
    expect(cliOneClick(agents, "u-bia", "codex")).toEqual({ kind: "allow" });
    expect(cliOneClick(agents, "u-caio", "claude")).toEqual({ kind: "ask", ownerId: "u-bia", ownerName: "Bia Rocha" });
    expect(cliOneClick({ ...agents, cliFetchable: ["claude"] }, "u-bia", "codex")).toBeNull();
    expect(cliOneClick({ ...pc, kind: "managed" }, "u-bia", "claude")).toBeNull();
    expect(installableCli("claude_code")).toBe("claude");
    const words = { program: "Claude Code", computer: "PC" };
    const said = (k: string, v?: Record<string, unknown>) => `${k} ${JSON.stringify(v)}`;
    const t = said as unknown as Parameters<typeof cliInstallFailure>[0];
    expect(cliInstallFailure(t, { tool: "claude", state: "running" }, words)).toBeNull();
    expect(cliInstallFailure(t, { tool: "claude", state: "failed", cause: "git_missing" }, words)).toContain(
      "connectAi.cli.gitMissing",
    );
    expect(cliInstallFailure(t, { tool: "claude", state: "failed", message: "curl: (6)" }, words)).toBe(
      'connectAi.cli.failed {"computer":"PC","message":"curl: (6)"}',
    );
    expect(installableCli("cursor")).toBeNull();
  });

  test("Codex on Windows: its own sandbox where MXC is missing, or nothing at all, in words for the computer's ⓘ", async () => {
    const { resources } = await import("@agenteschat/i18n");
    const i18next = (await import("i18next")).default;
    const instance = i18next.createInstance();
    void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const t = instance.t;
    const desk = { name: "Estudio-PC" };
    for (const codexSandbox of ["mxc", null, undefined] as const)
      expect(codexSandboxNote(t, { ...desk, codexSandbox })).toBeNull();
    expect(codexSandboxNote(t, { ...desk, codexSandbox: "unelevated" })).toBe(t("brain.sandboxPartial"));
    const none = t("brain.reasons.windows_sandbox", { computer: "Estudio-PC", program: "Codex" });
    expect(codexSandboxNote(t, { ...desk, codexSandbox: "none" })).toBe(none);
    expect(none).toBe(
      "O Windows do Estudio-PC não consegue isolar os comandos do Codex. Escolha o Claude ou uma chave de API, ou atualize esse computador para o Windows\u00a011\u00a024H2 ou mais novo, com as atualizações em dia.",
    );
    // The same words where a person picks Codex for an agent there, on the web and the phone (`gateLine`).
    expect(
      gateLine(t, {
        gate: { state: "unsupported", reason: "windows_sandbox" },
        edition: "selfhost",
        kind: "codex",
        computer: "Estudio-PC",
      })?.text,
    ).toBe(none);
    // On the Cloud's own computers (Linux) it never happens: its line is the "on our side" one.
    expect(
      gateLine(t, {
        gate: { state: "unsupported", reason: "windows_sandbox" },
        edition: "cloud",
        kind: "codex",
        computer: "Computador da Acme",
      })?.text,
    ).toBe(t("aiAccounts.connect.needsCloud.stuck", { computer: "Computador da Acme", program: "Codex" }));
  });

  test("Devin on a Windows computer: the plan's line says why it doesn't run there, and the way out", async () => {
    const { resources } = await import("@agenteschat/i18n");
    const i18next = (await import("i18next")).default;
    const instance = i18next.createInstance();
    void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const t = instance.t;
    const line = (kind: "devin" | "grok", os: string) =>
      gateLine(t, {
        gate: { state: "unsupported", reason: "system", os },
        edition: "selfhost",
        kind,
        computer: "Estudio-PC",
      })?.text;
    expect(line("devin", "windows")).toBe(
      "O Estudio-PC usa Windows, onde o Devin ainda não roda: lá a CLI dele não consegue manter separado o login de cada conta. Use o Devin num computador Mac ou Linux, ou escolha outra IA.",
    );
    // Any other plan off its system keeps the plain line.
    expect(line("grok", "windows")).toBe(t("brain.reasons.system", { computer: "Estudio-PC", program: "Grok Build" }));
  });

  test("a CLI the apps don't install: the line to run there, for every agent's user in system mode", async () => {
    const { ptBR, resources } = await import("@agenteschat/i18n");
    const i18next = (await import("i18next")).default;
    const instance = i18next.createInstance();
    void instance.init({ lng: "pt-BR", fallbackLng: "en", resources, initAsync: false });
    const t = instance.t;
    const server = { kind: "connected", os: "linux", mode: "single", cliErrors: null } as Pick<
      Machine,
      "kind" | "os" | "mode" | "cliErrors"
    >;
    const system = { ...server, mode: "system" as const };
    expect(cliInstallCommand("antigravity", server)).toBe(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    );
    expect(cliInstallCommand("antigravity", system)).toBe(
      "sudo env HOME=/opt/agy sh -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-path' && sudo chmod -R a+rX /opt/agy && sudo ln -sf /opt/agy/.local/bin/agy /usr/local/bin/agy",
    );
    expect(cliInstallCommand("cursor", system)).toContain(
      "sudo ln -sf /opt/cursor/.local/bin/agent /usr/local/bin/agent",
    );
    for (const no of [
      cliInstallCommand("claude_code", server),
      cliInstallCommand("opencode", server),
      cliInstallCommand("antigravity", { ...server, os: "windows" }),
      cliInstallCommand("grok", { ...server, kind: "managed" }),
    ])
      expect(no).toBeNull();
    // xAI's PowerShell installer, in a line cmd runs too.
    expect(cliInstallCommand("grok", { ...server, os: "windows" })).toBe(
      'powershell -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
    );

    const words = { program: "Antigravity CLI", computer: "srv-1" };
    expect(cliCommandWayOut(t, "antigravity", server, "not_installed", "srv-1")?.text).toBe(
      `${t("connectAi.cli.missing", words)} ${ptBR.connectAi.cli.runThis}`,
    );
    expect(cliCommandWayOut(t, "antigravity", system, "not_installed", "srv-1")?.text).toBe(
      t("connectAi.cli.missingSystem", words),
    );
    const rootOnly = { ...system, cliErrors: { antigravity: CLI_HOME_ONLY } };
    expect(cliCommandWayOut(t, "antigravity", rootOnly, "cant_start", "srv-1")).toEqual({
      text: t("connectAi.cli.homeOnly", words),
      command: cliInstallCommand("antigravity", system) ?? "",
    });
    // There and failing on its own: the CLI's own error says why, not a command.
    const crashing = { ...system, cliErrors: { antigravity: "segfault" } };
    expect(cliCommandWayOut(t, "antigravity", crashing, "cant_start", "srv-1")).toBeNull();
    expect(
      gateLine(t, {
        gate: { state: "unsupported", reason: "cant_start" },
        edition: "selfhost",
        kind: "antigravity",
        computer: "srv-1",
        machine: rootOnly,
      })?.text,
    ).toBe(t("brain.reasons.home_only", words));
  });

  test("a CLI there that won't start says the CLI's own words, and Gemini on Windows says why it can't", async () => {
    const { resources } = await import("@agenteschat/i18n");
    const i18next = (await import("i18next")).default;
    const instance = i18next.createInstance();
    void instance.init({
      lng: "pt-BR",
      fallbackLng: "en",
      resources,
      initAsync: false,
      // As the apps: React escapes.
      interpolation: { escapeValue: false },
    });
    const t = instance.t;
    const pc = { kind: "connected", os: "windows", mode: "single" } as const;
    const cantStart = { state: "unsupported", reason: "cant_start" } as const;
    const line = (
      kind: "opencode" | "claude_code" | "antigravity",
      machine: Parameters<typeof gateLine>[1]["machine"],
      gate: Parameters<typeof gateLine>[1]["gate"] = cantStart,
    ) => gateLine(t, { gate, edition: "selfhost", kind, computer: "PC da Bia", machine })?.text;
    const said = "Error: Cannot find module 'opencode-windows-x64/package.json'";
    expect(line("opencode", { ...pc, cliErrors: { opencode: said } })).toBe(
      `O OpenCode está no PC da Bia, mas não abre: ${said}`,
    );
    // Claude Code's error is kept under its command's name; Git for Windows missing is a code, said in words.
    expect(line("claude_code", { ...pc, cliErrors: { claude: "spawn EPERM" } })).toBe(
      "O Claude Code está no PC da Bia, mas não abre: spawn EPERM",
    );
    expect(line("claude_code", { ...pc, cliErrors: { claude: CLI_GIT_MISSING } })).toBe(
      t("connectAi.cli.gitMissing", { program: "Claude Code", computer: "PC da Bia" }),
    );
    // No words from the runner (an older one): the plain line.
    expect(line("opencode", pc)).toBe(t("brain.reasons.cant_start", { program: "OpenCode", computer: "PC da Bia" }));
  });

  test("Prefiro no Terminal: the same switches as one command, only for who turns them on, where there may be no app", () => {
    const linux: Pick<Machine, "mode" | "os"> = { mode: "single", os: "linux" };
    expect(oneClickTerminal(linux, { kind: "allow" }, ["desktop", "commands"])).toBe(
      "agentes-runner tools enable desktop && agentes-runner tools enable commands",
    );
    expect(oneClickTerminal({ ...linux, mode: "system" }, { kind: "allow" }, ["browser"])).toBe(
      "sudo agentes-runner tools enable browser",
    );
    expect(oneClickTerminal({ ...linux, os: "darwin" }, { kind: "allow" }, ["browser"])).toBeNull();
    expect(oneClickTerminal(linux, { kind: "ask", ownerId: "u-bia", ownerName: "Bia" }, ["browser"])).toBeNull();
    expect(oneClickTerminal(linux, { kind: "allow" }, [])).toBeNull();
  });

  test("a refused Fazer login reads its cause and what this person can do", () => {
    const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
    const off = (params: Record<string, unknown>) =>
      new ApiError(400, "browser_profile.tool_off", "The browser is turned off on Mac", {
        machineId: "m1",
        machineName: "Bia's Mac",
        tool: "browser",
        ...params,
      });
    expect(profileToolOff(off({ mayAllow: true }))).toEqual({
      machineId: "m1",
      machineName: "Bia's Mac",
      tool: "browser",
      oneClick: { kind: "allow" },
    });
    expect(profileToolOff(off({ outdated: true }))?.oneClick).toEqual({ kind: "outdated" });
    const ask = off({ ownerId: "u-bia", ownerName: "Bia Rocha" });
    expect(profileToolOff(ask)?.oneClick).toEqual({ kind: "ask", ownerId: "u-bia", ownerName: "Bia Rocha" });
    expect(profileRefusalLine(t, ask)).toBe('browser.profiles.toolOffOther{"name":"Bia"}');
    expect(profileRefusalLine(t, off({ mayAllow: true }))).toBe("browser.profiles.toolOff");
    const other = new ApiError(400, "browser_profile.unavailable", "Chrome isn't installed", { machineName: "Mac" });
    expect(profileToolOff(other)).toBeNull();
    expect(profileRefusalLine(t, other)).toBe('browser.profiles.notOpened{"machine":"Mac"}');
    expect(profileRefusalLine(t, new ApiError(409, "browser_profile.busy", "busy"))).toBe("browser.profiles.busy");
    expect(profileToolOff(new Error("boom"))).toBeNull();
  });

  test("the runner's refusal of a browser that is off is read in every runner version's words", () => {
    expect(
      browserOffMessage("Browser is turned off on this computer (its owner can turn it on from agentes.chat)"),
    ).toBe(true);
    expect(
      browserOffMessage(
        "Browser is turned off on this computer (its owner can turn it on in the agentes app (Preferences > Tools))",
      ),
    ).toBe(true);
    expect(browserOffMessage("The browser is turned off on this computer")).toBe(true);
    expect(browserOffMessage("Too many browsers are open")).toBe(false);
    expect(browserOffMessage(undefined)).toBe(false);
  });

  test("the runner's own timeout is told apart from the computer's", () => {
    expect(browserNoAnswerMessage("The browser didn't answer within 15 s")).toBe(true);
    expect(browserNoAnswerMessage("the computer Desk did not answer within 120 s")).toBe(false);
    expect(browserNoAnswerMessage(null)).toBe(false);
  });
});

test("whose internet a borrowing computer uses: the computer in the line, who connected it on its name's tip", () => {
  const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
  const via = { machineId: "m-ana", name: "Ana's iMac", userName: "Ana" };
  expect(egressViaText(t, { kind: "managed", online: true, egressVia: via })).toBe(
    'machines.egress.via{"name":"Ana\'s iMac"}',
  );
  const words = ((key: string, o?: Record<string, string>) =>
    key === "machines.egress.via" ? `Agents use the internet of ${o?.name}` : `Connected by ${o?.name}`) as never;
  expect(egressViaParts(words, { kind: "managed", online: true, egressVia: via })).toEqual({
    before: "Agents use the internet of ",
    name: "Ana's iMac",
    after: "",
    by: "Connected by Ana",
  });
  expect(
    egressViaParts(words, { kind: "managed", online: true, egressVia: { ...via, userName: null } })?.by,
  ).toBeNull();
  expect(egressViaParts(words, { kind: "managed", online: false, egressVia: via })).toBeNull();
  expect(egressViaText(t, { kind: "managed", online: false, egressVia: via })).toBeNull();
  // A self-hosted server's own computer, or one marked the workspace's, borrows too (the server sends it only then).
  expect(egressViaText(t, { kind: "host", online: true, egressVia: via })).toBe(
    'machines.egress.via{"name":"Ana\'s iMac"}',
  );
  expect(egressViaParts(words, { kind: "host", online: true, egressVia: via })?.name).toBe("Ana's iMac");
  expect(egressViaText(t, { kind: "connected", online: true, egressVia: null })).toBeNull();
  // Lent "only" and that computer offline: the workspace's computer says its agents have no internet, and whose.
  expect(egressOfflineText(t, { kind: "managed", egressOffline: via })).toBe(
    'machines.egress.offline{"name":"Ana\'s iMac"}',
  );
  expect(egressOfflineText(t, { kind: "managed", egressOffline: null })).toBeNull();
  expect(egressOfflineText(t, { kind: "managed" })).toBeNull();
  expect(egressViaText(t, { kind: "managed", online: true, egressVia: null })).toBeNull();
});
