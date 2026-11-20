import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { accountCodeAad } from "@agenteschat/adapters/machine-protocol";
import { cutAtWord } from "@agenteschat/adapters/redact";
import { sealSecret } from "@agenteschat/adapters/secret-box";
import {
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  AccountManager,
  accountEnv,
  accountSignIn,
  agentAccountHome,
  agentAccountsDir,
  grantOf,
  loginFailureOf,
  parseAgyLoginUrl,
  parseAgyStatus,
} from "../../runner/accounts";
import {
  AGY_CHAT_AGENT,
  AGY_KEYCHAIN,
  AGY_PLANTED,
  AGY_SIGN_IN_FILE,
  agyAuthOf,
  agyKeychain,
  agyRuntimeDir,
  agySignInOf,
  dropAgySignIns,
  prepareAgyHome,
  writeAgySettings,
} from "../../runner/agy-home";
import {
  type AntigravityBrainContext,
  type AntigravityBrainTurnRequest,
  antigravityChatBreach,
  antigravityChatsFile,
  antigravityProblem,
  antigravityTurnArgs,
  handleAntigravityBrainTurn,
  isOurAgyTool,
  parseAgyError,
} from "../../runner/brain-antigravity";
import type { CodexBrainEvent } from "../../runner/brain-codex";
import { detectExecutors, parseAgyModels } from "../../runner/executors";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import { antigravityUsage, resetFromWords } from "../../runner/plan-usage";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const managers: AccountManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  delete process.env.FAKE_AGY_LOG;
  delete process.env.FAKE_AGY_TOOLS;
  delete process.env.FAKE_AGY_BOUND;
  delete process.env.FAKE_AGY_KEYRING;
  delete process.env.FAKE_AGY_REFRESH_MS;
  delete process.env.FAKE_AGY_CHECK;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-agy.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000b1";
const SESSION = "0193cccc-0000-7000-8000-0000000000b1";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff00b1", handle: "dev" };
const ACCOUNT = "0193eeee-0000-7000-8000-0000000000b1";
const ORG = "0193dddd-0000-7000-8000-000000000001";
const FIRST = "c3b60000-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-11-04T12:00:00Z");

test("command line: headless stream-json in the sandbox; work takes edits, plan doesn't, chat runs as Lodi's agent", () => {
  const work = antigravityTurnArgs({ prompt: "oi", model: "gemini-4-argon-high", chat: FIRST, effort: "max" });
  expect(work.slice(0, 4)).toEqual(["-p", "oi", "--output-format", "stream-json"]);
  expect(work.join(" ")).toContain("--sandbox --disable-slash-commands --mode accept-edits");
  expect(work.join(" ")).toContain("--model gemini-4-argon-high");
  // A slug names its thinking level: no `--effort` beside it.
  expect(work).not.toContain("--effort");
  expect(work.join(" ")).toContain(`--conversation ${FIRST}`);
  expect(antigravityTurnArgs({ prompt: "oi", effort: "xhigh" }).join(" ")).toContain("--effort high");
  const plan = antigravityTurnArgs({ prompt: "oi", profile: "plan" }).join(" ");
  expect(plan).not.toContain("--mode");
  expect(plan).not.toContain("--dangerously-skip-permissions");
  const chat = antigravityTurnArgs({ prompt: "oi", locked: true }).join(" ");
  expect(chat).toContain(`--agent ${AGY_CHAT_AGENT}`);
  expect(chat).not.toContain("accept-edits");
});

test("the account's home: what a turn planted goes, our settings, our server alone and Lodi's agent; the sign-in stays", () => {
  const home = tempDir("agy-home-");
  dirs.push(home);
  for (const rel of [".gemini/config/hooks.json", ".gemini/GEMINI.md", AGY_SIGN_IN_FILE]) {
    mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    writeFileSync(path.join(home, rel), "x");
  }
  mkdirSync(path.join(home, ".gemini/config/plugins/evil"), { recursive: true });
  prepareAgyHome(home, ["/usr/bin/agentes-runner"]);
  for (const rel of AGY_PLANTED.filter((r) => !r.endsWith("/agents")))
    expect(existsSync(path.join(home, rel))).toBe(false);
  expect(existsSync(path.join(home, AGY_SIGN_IN_FILE))).toBe(true);
  const mcp = JSON.parse(readFileSync(path.join(home, ".gemini/config/mcp_config.json"), "utf8"));
  // The run and the token only through the env: never in the shared file.
  expect(mcp).toEqual({
    mcpServers: { [CODEX_MCP_SERVER]: { command: "/usr/bin/agentes-runner", args: ["mcp"], timeoutSeconds: 360 } },
  });
  const settings = JSON.parse(readFileSync(path.join(home, ".gemini/antigravity-cli/settings.json"), "utf8"));
  expect(settings).toMatchObject({
    auth: { type: "oauth-personal" },
    toolPermission: "proceed-in-sandbox",
    allowNonWorkspaceAccess: false,
    useG1Credits: false,
    permissions: { allow: [`mcp(${CODEX_MCP_SERVER}/*)`] },
  });
  // Turns pass `--disable-slash-commands`; `/usage` and `/logout` must still reach the CLI.
  expect(settings.disableSlashCommands).toBeUndefined();
  expect(existsSync(agyRuntimeDir(home))).toBe(true);
  const agent = readFileSync(path.join(home, `.gemini/config/agents/${AGY_CHAT_AGENT}/agent.md`), "utf8");
  expect(agent).toContain("tools: []");
  expect(agent).toContain("subagent: false");
});

test("macOS: each Gemini account signs in to a keychain of its own in its folder, made once and unlocked before every run", () => {
  const home = tempDir("agy-keychain-");
  dirs.push(home);
  const runs: string[][] = [];
  const fake = (args: string[]) => {
    runs.push(args);
    if (args[0] === "create-keychain") writeFileSync(args[3] as string, "");
  };
  const file = path.join(home, AGY_KEYCHAIN);
  agyKeychain(home, fake);
  agyKeychain(home, fake);
  expect(runs).toEqual([
    ["create-keychain", "-p", "", file],
    ["set-keychain-settings", file],
    ["unlock-keychain", "-p", "", file],
  ]);
  // A `security` that fails leaves the CLI its own secrets file: never a thrown turn.
  expect(() =>
    agyKeychain(path.join(home, "other"), () => {
      throw new Error("security: failed");
    }),
  ).not.toThrow();
});

test.skipIf(process.platform !== "darwin")(
  "macOS: the account's keychain is the default one under its HOME, apart from the computer user's",
  () => {
    const home = tempDir("agy-keychain-");
    dirs.push(home);
    agyKeychain(home);
    agyKeychain(home);
    const security = (...args: string[]) =>
      spawnSync("/usr/bin/security", args, { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(security("default-keychain").stdout).toContain(path.join(home, AGY_KEYCHAIN));
    expect(
      security("add-generic-password", "-U", "-s", "Antigravity CLI", "-a", "test", "-w", "fake-token").status,
    ).toBe(0);
    expect(security("find-generic-password", "-s", "Antigravity CLI", "-wa", "test").stdout.trim()).toBe("fake-token");
    expect(spawnSync("/usr/bin/security", ["default-keychain"], { encoding: "utf8" }).stdout).not.toContain(home);
  },
);

test("a chat turn's guard: init with our server's tools alone; a tool of its own, a subagent or an answer first stop it", () => {
  const init = (tools: unknown) => ({ event: "init", conversation_id: FIRST, init: { tools } });
  expect(
    antigravityChatBreach(init([`${CODEX_MCP_SERVER}/post_message`, `mcp_${CODEX_MCP_SERVER}_read`]), false),
  ).toBeNull();
  expect(antigravityChatBreach(init([`${CODEX_MCP_SERVER}/post_message`, "run_command"]), false)).toContain(
    "run_command",
  );
  expect(antigravityChatBreach({ event: "init", init: {} }, false)).toContain("didn't list its tools");
  const say = { event: "step_update", step_update: { step_type: "agent_response", text_delta: "hi" } };
  expect(antigravityChatBreach(say, false)).toContain("before listing");
  expect(antigravityChatBreach(say, true)).toBeNull();
  const tool = (name: string) => ({ event: "step_update", step_update: { step_type: "tool", tool_name: name } });
  expect(antigravityChatBreach(tool(`${CODEX_MCP_SERVER}/post_message`), true)).toBeNull();
  expect(antigravityChatBreach(tool("view_file"), true)).toContain("view_file");
  expect(antigravityChatBreach(tool("linear/save_issue"), true)).toContain("linear/save_issue");
  const sub = { event: "step_update", step_update: { step_type: "agent_response", subagent_info: { subagents: [] } } };
  expect(antigravityChatBreach(sub, true)).toContain("another agent");
  expect(isOurAgyTool(`evil_${CODEX_MCP_SERVER}/x`)).toBe(false);
});

test("a turn that went wrong: AGY_ERROR's quota is a plan limit with its reset, a refused sign-in, anything else", () => {
  const quota = parseAgyError(
    'note\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":true,"message":"Quota exceeded. Resets in 2h 5m."}\n',
  );
  expect(quota).toEqual({ message: "Quota exceeded. Resets in 2h 5m.", limit: true, auth: false });
  expect(antigravityProblem(quota?.message ?? "", { limit: true, worked: true, now: NOW })).toEqual([
    { type: "limit", resetsAt: "2026-11-04T14:05:00.000Z" },
    { type: "error", code: "plan_limit", message: "Quota exceeded. Resets in 2h 5m.", retryable: true, worked: true },
  ]);
  expect(parseAgyError('AGY_ERROR: {"status":"UNAUTHENTICATED","code":401}')).toMatchObject({ auth: true });
  expect(antigravityProblem("Error: authentication required")[0]).toMatchObject({ code: "not_logged_in" });
  expect(antigravityProblem("boom")[0]).toMatchObject({ code: "antigravity_failed" });
  expect(parseAgyError("plain failure")).toBeNull();
});

test("the CLI's words: its models, its sign-in status, its sign-in link and its /usage quotas", () => {
  expect(parseAgyModels("gemini-4-argon-high       Gemini 4 Argon (High)\n...\n")).toEqual([
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  ]);
  // What 1.5.0 prints on stdout (its "Fetching available models..." goes to stderr): a tab between slug and name.
  const listed = "gemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n";
  expect(parseAgyModels(listed)).toEqual([
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
  ]);
  expect(parseAgyModels("Fetching available models...\n")).toEqual([]);
  const models = `${listed}\nFetching available models...\n`;
  expect(parseAgyStatus(0, models, "oauth-personal")).toEqual({ loggedIn: true });
  expect(parseAgyStatus(0, "gemini-4-argon-high       Gemini 4 Argon (High)\n", null)).toEqual({ loggedIn: true });
  expect(parseAgyStatus(0, models, "oauth-business")).toEqual({
    loggedIn: true,
    provider: "enterprise",
    plan: "enterprise",
  });
  const signedOut =
    "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";
  expect(parseAgyStatus(1, signedOut, null)).toEqual({ loggedIn: false });
  expect(parseAgyStatus(0, "Fetching available models...\n", null)).toEqual({ loggedIn: false });
  const login =
    "Open this link in a browser to log in with Google:\r\n\r\n  https://accounts.google.com/o/oauth2/auth?client_id=agy&state=s1\r\n\r\nThen paste the authorization code";
  expect(parseAgyLoginUrl(login)).toBe("https://accounts.google.com/o/oauth2/auth?client_id=agy&state=s1");
  expect(parseAgyLoginUrl("https://evil.example/accounts.google.com\n", true)).toBeNull();
  // Why a sign-in failed, by the CLI's words.
  expect(loginFailureOf('couldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Bad Request"')).toBe(
    "bad_code",
  );
  expect(loginFailureOf("token exchange failed: dial tcp: lookup oauth2.googleapis.com: no such host")).toBe("network");
  expect(loginFailureOf("Error: no controlling terminal; cannot complete interactive login")).toBe("no_tty");
  expect(loginFailureOf("panic: something else")).toBe("cli_exit");
  expect(cutAtWord("Eligibility check failed: PERMISSION_DENIED", 30)).toBe("Eligibility check failed:…");
  expect(cutAtWord("short", 30)).toBe("short");
  const usage = antigravityUsage(
    "Model quotas\n\nGemini Models\nWeekly Limit Remaining\n75%\nFive Hour Limit Remaining\n40% · resets in 2h 30m\n\nClaude and GPT models\nWeekly Limit Remaining\n100%\n",
    "probe",
    NOW,
  );
  expect(usage?.windows).toEqual([
    { kind: "seven_day", usedPercent: 25 },
    { kind: "five_hour", usedPercent: 60, resetsAt: "2026-11-04T14:30:00.000Z" },
    { kind: "other", label: "Claude and GPT models · 7d", usedPercent: 0 },
  ]);
  expect(resetFromWords("Resets at 2026-11-05T10:00:00Z")).toBe("2026-11-05T10:00:00.000Z");
});

test("the CLI's real /usage: one tab-separated row per quota, each model group its own, disabled ones skipped", () => {
  // `agy -p /usage` of Antigravity CLI 1.5.6, 2026-11-14: group, quota, percent left (or "disabled"), its reset.
  const report = [
    "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-21T21:48:50Z",
    "Gemini Models\tFive Hour Limit Remaining\t97%\t2026-11-15T02:48:50Z",
    "Claude and GPT models\tWeekly Limit Remaining\t0%\t2026-11-17T04:21:04Z",
    "Claude and GPT models\tFive Hour Limit Remaining\tdisabled\t",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t99%\t2026-11-21T21:45:50Z",
    "",
  ].join("\n");
  expect(antigravityUsage(report, "probe", NOW)?.windows).toEqual([
    { kind: "seven_day", usedPercent: 2, resetsAt: "2026-11-21T21:48:50.000Z" },
    { kind: "five_hour", usedPercent: 3, resetsAt: "2026-11-15T02:48:50.000Z" },
    { kind: "other", label: "Claude and GPT models · 7d", usedPercent: 100, resetsAt: "2026-11-17T04:21:04.000Z" },
    { kind: "other", label: "Gemini 4 Argon · 7d", usedPercent: 1, resetsAt: "2026-11-21T21:45:50.000Z" },
  ]);
});

test("an account's folder is the CLI's whole home: no keyring, no Gemini key or ADC from the runner, no updates", () => {
  const env = accountEnv("antigravity", "/acc/x", {
    PATH: "/bin",
    HOME: "/root",
    GEMINI_API_KEY: "AIza-machine",
    GOOGLE_APPLICATION_CREDENTIALS: "/root/sa.json",
    GOOGLE_CLOUD_PROJECT: "p",
    CLOUDSDK_CONFIG: "/root/.config/gcloud",
    AGY_ADC_AUTH: "true",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    XDG_RUNTIME_DIR: "/run/user/0",
    DISPLAY: ":0",
  });
  expect(env).toMatchObject({
    HOME: "/acc/x",
    XDG_CONFIG_HOME: "/acc/x/.config",
    XDG_RUNTIME_DIR: "/acc/x/.run",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  for (const name of [
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "CLOUDSDK_CONFIG",
    "AGY_ADC_AUTH",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
  ]) {
    expect(env[name]).toBeUndefined();
  }
  // Google Cloud's sign-ins stay with an agent on another CLI.
  const codex = accountEnv("codex", "/acc/y", { GOOGLE_APPLICATION_CREDENTIALS: "/root/sa.json", GEMINI_API_KEY: "k" });
  expect(codex).toMatchObject({ GOOGLE_APPLICATION_CREDENTIALS: "/root/sa.json" });
  expect(codex.GEMINI_API_KEY).toBeUndefined();
});

test.skipIf(!posix)("detection: the CLI's version line and the models it lists", async () => {
  const run = (command: string, args: string[]) =>
    command === "agy"
      ? args[0] === "--version"
        ? { status: 0, stdout: "agy 1.4.12\n" }
        : { status: 0, stdout: "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)\n" }
      : { status: 1, stdout: "" };
  expect((await detectExecutors(run)).found.antigravity).toEqual({
    version: "agy 1.4.12",
    models: [{ id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" }],
  });
});

function turnContext(root: string) {
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  const accountDir = path.join(root, "accounts", "antigravity", ACCOUNT);
  for (const d of [ws, home, accountDir]) mkdirSync(d, { recursive: true });
  return {
    home,
    accountDir,
    ctx: {
      folder: ws,
      exec: true,
      runnerHome: home,
      platform: "linux" as const,
      accounts: {
        accountDir: (kind: string, id: string) => (kind === "antigravity" && id === ACCOUNT ? accountDir : null),
      },
      mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/agentes-runner"] },
      spawn: ((_, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn,
    },
  };
}

/** What the CLI keeps once signed in, as the fake writes it. */
const TOKEN = { access_token: "fake-access", refresh_token: "fake-refresh", token_type: "Bearer" };

const signIn = (accountDir: string) => {
  mkdirSync(path.dirname(path.join(accountDir, AGY_SIGN_IN_FILE)), { recursive: true });
  writeFileSync(path.join(accountDir, AGY_SIGN_IN_FILE), JSON.stringify(TOKEN));
};

const turn = (over: Partial<AntigravityBrainTurnRequest> = {}): AntigravityBrainTurnRequest => ({
  runId: RUN,
  kind: "antigravity",
  session: { id: SESSION, resume: false },
  cwd: "",
  system: "You are Dev, the team's developer.",
  prompt: "run the tests",
  mcp: { token: "tok_run" },
  agent: AGENT,
  account: ACCOUNT,
  ...over,
});

async function run(ctx: AntigravityBrainContext, req: AntigravityBrainTurnRequest) {
  const events: CodexBrainEvent[] = [];
  await handleAntigravityBrainTurn(ctx, req, { signal: new AbortController().signal, emit: (e) => events.push(e) });
  return events;
}

const logOf = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map(
      (l) => JSON.parse(l) as { args: string[]; home: string; run: string; token: string; geminiKey: string | null },
    );

test.skipIf(!posix)(
  "a fake agy: the first turn starts a conversation with the context, the next resumes it with the new message only",
  async () => {
    const root = tempDir("brain-agy-");
    dirs.push(root);
    const { ctx, home, accountDir } = turnContext(root);
    signIn(accountDir);
    const log = path.join(root, "agy.log");
    process.env.FAKE_AGY_LOG = log;
    const events = await run(ctx, turn());
    expect(events.at(-1)).toEqual({ type: "done", text: "Let me check. All good.", session: { id: SESSION } });
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("Let me check. All good.\n");
    // The CLI's shell step is on the transcript; the call to our server isn't (the engine ran it).
    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      expect.objectContaining({
        name: "run_command",
        input: { CommandLine: "bun test" },
        executed: { content: "3 pass\n" },
      }),
    ]);
    // The turn's own step, not the conversation's running total.
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      source: "plan",
      input: 1000,
      output: 40,
      cacheRead: 400,
    });
    const [first] = logOf(log);
    expect(first?.args[1]).toBe("You are Dev, the team's developer.\n\nrun the tests");
    expect(first?.args).not.toContain("--conversation");
    expect(first?.args.join(" ")).not.toContain("tok_run");
    expect(first).toMatchObject({ home: accountDir, run: RUN, token: "tok_run" });
    expect(JSON.parse(readFileSync(antigravityChatsFile(home), "utf8"))).toEqual({ [`${ACCOUNT}:${SESSION}`]: FIRST });

    await run(ctx, turn({ runId: RUN.replace(/1$/, "2"), prompt: "and now?" }));
    const second = logOf(log)[1];
    expect(second?.args.join(" ")).toContain(`--conversation ${FIRST}`);
    expect(second?.args[1]).toBe("and now?");

    // A conversation the CLI no longer has (another runner home names one) comes back as a new one: stopped, started
    // again with the context.
    const other = turnContext(path.join(root, "other"));
    signIn(other.accountDir);
    mkdirSync(path.dirname(antigravityChatsFile(other.home)), { recursive: true });
    writeFileSync(
      antigravityChatsFile(other.home),
      JSON.stringify({ [`${ACCOUNT}:${SESSION}`]: "c3b60000-0000-4000-8000-0000000000ff" }),
    );
    const again = await run(other.ctx, turn({ runId: RUN.replace(/1$/, "3"), prompt: "still there?" }));
    expect(again.at(-1)).toMatchObject({ type: "done" });
    expect(logOf(log).at(-1)?.args[1]).toBe("You are Dev, the team's developer.\n\nstill there?");
  },
  20_000,
);

test.skipIf(!posix)(
  "an account's turn: none or gone refused, signed out is not_logged_in, a quota is plan_limit, elsewhere than Linux refused",
  async () => {
    const root = tempDir("brain-agy-");
    dirs.push(root);
    const { ctx, accountDir } = turnContext(root);
    const final = async (over: Partial<AntigravityBrainTurnRequest>, c: object = ctx) =>
      (await run(c as typeof ctx, turn(over))).at(-1);
    expect(await final({ account: undefined })).toMatchObject({ type: "error", code: "not_logged_in" });
    expect(await final({ runId: RUN.replace(/1$/, "4") })).toMatchObject({ type: "error", code: "not_logged_in" });
    expect(await final({}, { ...ctx, accounts: { accountDir: () => null } })).toMatchObject({
      code: "account_missing",
      message: expect.stringContaining("Gemini account"),
    });
    signIn(accountDir);
    const limited = await run(ctx, turn({ runId: RUN.replace(/1$/, "6"), prompt: "LIMIT" }));
    expect(limited.find((e) => e.type === "limit")).toMatchObject({ resetsAt: expect.any(String) });
    expect(limited.at(-1)).toMatchObject({ type: "error", code: "plan_limit" });
    expect(await final({}, { ...ctx, platform: "win32" })).toMatchObject({ code: "unsupported" });
  },
  20_000,
);

test.skipIf(!posix)(
  "a chat turn: Lodi's agent and our server alone; a tool of the CLI's own stops it, the agent's secrets never come",
  async () => {
    const root = tempDir("brain-agy-");
    dirs.push(root);
    const { ctx, accountDir } = turnContext(root);
    signIn(accountDir);
    const log = path.join(root, "agy.log");
    process.env.FAKE_AGY_LOG = log;
    const chat = { permissions: { mode: "chat" as const } };
    const done = await run(ctx, turn({ ...chat, prompt: "BRIDGE_ONLY hi" }));
    expect(done.at(-1)).toMatchObject({ type: "done" });
    expect(logOf(log)[0]?.args.join(" ")).toContain(`--agent ${AGY_CHAT_AGENT}`);
    expect(logOf(log)[0]?.geminiKey).toBeNull();
    const own = await run(ctx, turn({ ...chat, runId: RUN.replace(/1$/, "7"), prompt: "BRIDGE_ONLY OWN_TOOL" }));
    expect(own.at(-1)).toMatchObject({
      type: "error",
      code: "tools_not_locked",
      message: expect.stringContaining("view_file"),
    });
    process.env.FAKE_AGY_TOOLS = `${CODEX_MCP_SERVER}/post_message,run_command`;
    const listed = await run(ctx, turn({ ...chat, runId: RUN.replace(/1$/, "8"), prompt: "BRIDGE_ONLY" }));
    expect(listed.at(-1)).toMatchObject({ code: "tools_not_locked", message: expect.stringContaining("run_command") });
  },
  20_000,
);

test.skipIf(!posix)("the CLI turned off on the computer refuses the turn", async () => {
  const root = tempDir("brain-agy-");
  dirs.push(root);
  const { ctx } = turnContext(root);
  await expect(run({ ...ctx, exec: false }, turn())).rejects.toMatchObject({ code: "not_allowed" });
});

test.skipIf(!posix)(
  "sign-in on the computer: Google's link, the pasted code sealed to the computer, then signed in; Enterprise says so",
  async () => {
    const home = tempDir("agy-accounts-");
    dirs.push(home);
    const m = new AccountManager({
      root: path.join(home, "accounts"),
      orgId: () => ORG,
      platform: "linux",
      commands: { antigravity: [process.execPath, FAKE] },
    });
    managers.push(m);
    const id = "0193eeee-0000-7000-8000-0000000000d2";
    const begun = await m.begin("antigravity", id, false, undefined, "enterprise");
    expect(begun.url).toBe("https://accounts.google.com/o/oauth2/auth?client_id=agy&state=s1");
    expect(typeof begun.publicKey).toBe("string");
    expect(agyAuthOf(path.join(home, "accounts", "antigravity", id))).toBe("oauth-business");
    const aad = accountCodeAad(id, ORG);
    await m.code(id, aad, await sealSecret(begun.publicKey as string, "4/0AbCdEf-code", aad));
    await waitFor(() => m.status(id).state !== "waiting", 5000);
    // `agy models` lists its models split by a tab: signed in.
    expect(m.status(id)).toMatchObject({
      state: "done",
      account: { kind: "antigravity", loggedIn: true, provider: "enterprise" },
    });
    // Windows keeps every sign-in in the user's one Credential Manager: refused.
    const win = new AccountManager({ root: path.join(home, "win"), orgId: () => ORG, platform: "win32" });
    managers.push(win);
    await expect(win.begin("antigravity", "0193eeee-0000-7000-8000-0000000000d3")).rejects.toMatchObject({
      code: "bad_request",
    });
  },
  20_000,
);

test.skipIf(!posix)(
  "a sign-in that fails says why as a code with the CLI's own words, never the pasted code, and leaves no folder",
  async () => {
    const home = tempDir("agy-accounts-");
    dirs.push(home);
    const lines: string[] = [];
    const m = new AccountManager({
      root: path.join(home, "accounts"),
      orgId: () => ORG,
      platform: "linux",
      commands: { antigravity: [process.execPath, FAKE] },
      log: (l) => lines.push(l),
    });
    managers.push(m);
    const signIn = async (n: number, code: string) => {
      const id = `0193eeee-0000-7000-8000-0000000000e${n}`;
      const begun = await m.begin("antigravity", id);
      const aad = accountCodeAad(id, ORG);
      await m.code(id, aad, await sealSecret(begun.publicKey as string, code, aad));
      await waitFor(() => m.status(id).state !== "waiting", 5000);
      await waitFor(() => !existsSync(path.join(home, "accounts", "antigravity", id)), 3000);
      return m.status(id);
    };
    const refused = await signIn(1, "4/0Abad-code-xyz");
    expect(refused).toMatchObject({
      state: "failed",
      code: "bad_code",
      message: 'couldn\'t log in: token exchange failed: oauth2: "invalid_grant" "Bad Request"',
    });
    expect(refused.error).toContain("couldn't sign in with that code");
    expect(JSON.stringify(refused)).not.toContain("4/0Abad-code-xyz");
    expect(await signIn(2, "4/0Aoffline-code")).toMatchObject({ state: "failed", code: "network" });
    // Signed in, but Google won't serve the account: `agy models` says why.
    expect(await signIn(3, "4/0Aineligible-code")).toMatchObject({
      state: "failed",
      code: "not_signed_in_after_login",
      message: "Error: Eligibility check failed: PERMISSION_DENIED (code 403): The caller does not have permission",
    });
    expect(lines.filter((l) => l.includes("failed: "))).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("4/0A");
  },
  30_000,
);

test("a Gemini sign-in for all agents as a turn gets it: root's file and seat, in the agent's folder while its turns run", async () => {
  const root = tempDir("agy-share-");
  dirs.push(root);
  // Root's folder signed in to an Enterprise seat: the CLI's file, and the project it saved in its settings.
  const kept = path.join(root, "kept");
  writeAgySettings(kept, "oauth-business", { project: "acme-gemini" });
  signIn(kept);
  const signedIn = { auth: TOKEN, type: "oauth-business" as const, gcp: { project: "acme-gemini" } };
  expect(agySignInOf(kept)).toEqual(signedIn);
  expect(agySignInOf(path.join(root, "nothing"))).toBeNull();
  // Over the worker link as root sent it; anything else is no grant.
  const grant = grantOf(JSON.parse(JSON.stringify({ kind: "agy_auth", ...signedIn }))) ?? undefined;
  expect(grant).toEqual({ kind: "agy_auth", ...signedIn });
  expect(grantOf({ kind: "agy_auth", auth: "fake-access", type: "oauth-personal" })).toBeNull();
  expect(grantOf({ kind: "agy_auth", auth: TOKEN, type: "api-key" })).toBeNull();

  const worker = path.join(root, "worker");
  const folders: AccountFolders = { accountDir: () => null, agentHome: (k, id) => agentAccountHome(worker, k, id) };
  const own = agentAccountHome(worker, "antigravity", ACCOUNT) as string;
  const file = path.join(own, AGY_SIGN_IN_FILE);
  const one = await accountSignIn(folders, "antigravity", ACCOUNT, grant);
  const two = await accountSignIn(folders, "antigravity", ACCOUNT, grant);
  if (typeof one === "string" || typeof two === "string") throw new Error("no sign-in");
  expect(one.home).toBe(own);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(TOKEN);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(agyAuthOf(own)).toBe("oauth-business");
  const settings = JSON.parse(readFileSync(path.join(own, ".gemini/antigravity-cli/settings.json"), "utf8"));
  expect(settings.gcp).toEqual({ project: "acme-gemini" });
  // The agent's last turn on it takes the copy with it.
  one.release?.();
  one.release?.();
  expect(existsSync(file)).toBe(true);
  two.release?.();
  expect(existsSync(file)).toBe(false);
  expect(await accountSignIn(folders, "antigravity", ACCOUNT, { kind: "none" })).toBe("signed_out");
  // A worker killed mid-turn leaves its copy: the next one to start takes it away, whatever else is there.
  const left = await accountSignIn(folders, "antigravity", ACCOUNT, grant);
  if (typeof left === "string") throw new Error("no sign-in");
  writeFileSync(path.join(agentAccountsDir(worker, "antigravity"), "stray"), "x");
  dropAgySignIns(agentAccountsDir(worker, "antigravity"));
  expect(existsSync(file)).toBe(false);
  expect(agyAuthOf(own)).toBe("oauth-business");
  left.release?.();
  dropAgySignIns(path.join(root, "nothing"));
  // The agent's own shell put a file where the CLI's folder was: the turn that ends still ends as it did.
  const odd = await accountSignIn(folders, "antigravity", ACCOUNT, grant);
  if (typeof odd === "string") throw new Error("no sign-in");
  rmSync(path.dirname(file), { recursive: true, force: true });
  writeFileSync(path.dirname(file), "x");
  expect(() => odd.release?.()).not.toThrow();
});

test.skipIf(!posix)(
  "system mode: one Gemini sign-in for all agents, root's and never lent, tried as a copy, a copy in each agent's turn",
  async () => {
    const home = tempDir("agy-accounts-");
    dirs.push(home);
    const log = path.join(home, "agy.log");
    process.env.FAKE_AGY_LOG = log;
    const m = new AccountManager({
      root: path.join(home, "accounts"),
      orgId: () => ORG,
      platform: "linux",
      commands: { antigravity: [process.execPath, FAKE] },
      lending: { chown: async () => {} },
    });
    managers.push(m);
    const dir = path.join(home, "accounts", "antigravity", ACCOUNT);
    const begun = await m.begin("antigravity", ACCOUNT, false, undefined, undefined, true);
    const aad = accountCodeAad(ACCOUNT, ORG);
    await m.code(ACCOUNT, aad, await sealSecret(begun.publicKey as string, "4/0AbCdEf-code", aad));
    await waitFor(() => m.status(ACCOUNT).state !== "waiting", 8000);
    const account = {
      id: ACCOUNT,
      kind: "antigravity" as const,
      loggedIn: true,
      shared: true,
      authMethod: "cli_login" as const,
    };
    expect(m.status(ACCOUNT)).toEqual({ state: "done", account });
    // Its CLI in root's folder, then a copy of the sign-in in a home of its own, gone after.
    expect(
      logOf(log)
        .filter((l) => l.args[0] === "models")
        .map((l) => l.home),
    ).toEqual([dir, path.join(dir, ".check")]);
    expect(existsSync(path.join(dir, ".check"))).toBe(false);
    expect(await m.lendTo("antigravity", ACCOUNT, 21001)).toBe(false);
    m.invalidate();
    expect(await m.list()).toEqual([account]);
    // Its plan's usage, from its CLI in root's folder, which refreshes the sign-in in place meanwhile: a turn's copy is
    // read once the file is whole again, never as an empty one that would sign every agent out.
    process.env.FAKE_AGY_REFRESH_MS = "500";
    m.probeUsage([ACCOUNT]);
    await waitFor(() => statSync(path.join(dir, AGY_SIGN_IN_FILE)).size === 0, 5000);
    const grant = (await m.grant("antigravity", ACCOUNT)) ?? undefined;
    expect(grant).toEqual({ kind: "agy_auth", auth: { ...TOKEN, home: dir }, type: "oauth-personal" });
    await waitFor(() => m.snapshot()?.[0]?.usage !== undefined, 5000);
    delete process.env.FAKE_AGY_REFRESH_MS;
    const worker = (n: number, given: typeof grant) => {
      const { ctx, home: runner } = turnContext(path.join(home, `agent-${n}`));
      const folders: AccountFolders = { accountDir: () => null, agentHome: (k, id) => agentAccountHome(runner, k, id) };
      return {
        ctx: { ...ctx, accounts: folders, grant: given },
        own: agentAccountHome(runner, "antigravity", ACCOUNT),
      };
    };
    // Two agents, each in its own folder for the account, with a copy only while its turn runs.
    for (const n of [1, 2]) {
      const { ctx, own } = worker(n, grant);
      const events = await run(ctx, turn({ runId: RUN.replace(/1$/, String(n + 1)) }));
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(logOf(log).at(-1)?.home).toBe(own as string);
      expect(existsSync(path.join(own as string, AGY_SIGN_IN_FILE))).toBe(false);
    }
    // Refused in a turn: every agent's next turn says it is signed out.
    await m.refused("antigravity", ACCOUNT);
    expect(await m.grant("antigravity", ACCOUNT)).toEqual({ kind: "none" });
    const out = await run(worker(3, { kind: "none" }).ctx, turn());
    expect(out.at(-1)).toEqual({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
  },
  30_000,
);

test.skipIf(!posix)(
  "a Gemini sign-in for all agents whose copy doesn't sign in fails and says why; for one agent the same CLI signs in",
  async () => {
    const home = tempDir("agy-accounts-");
    dirs.push(home);
    const m = new AccountManager({
      root: path.join(home, "accounts"),
      orgId: () => ORG,
      platform: "linux",
      commands: { antigravity: [process.execPath, FAKE] },
      lending: { chown: async () => {} },
    });
    managers.push(m);
    const signInAs = async (n: number, shared: boolean, again = false) => {
      const id = `0193eeee-0000-7000-8000-0000000000f${n}`;
      const begun = await m.begin("antigravity", id, again, undefined, undefined, shared);
      const aad = accountCodeAad(id, ORG);
      await m.code(id, aad, await sealSecret(begun.publicKey as string, "4/0AbCdEf-code", aad));
      await waitFor(() => m.status(id).state !== "waiting", 8000);
      return { id, status: m.status(id) };
    };
    // A CLI whose sign-in holds only in the home it signed in from.
    process.env.FAKE_AGY_BOUND = "1";
    const bound = await signInAs(1, true);
    expect(bound.status).toMatchObject({
      state: "failed",
      code: "not_kept",
      message: "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
    });
    expect(bound.status.error).toContain("a copy of that sign-in doesn't sign in, so it can't think for every agent");
    await waitFor(() => !existsSync(path.join(home, "accounts", "antigravity", bound.id)), 3000);
    expect((await signInAs(2, false)).status).toMatchObject({ state: "done", account: { loggedIn: true } });
    // A CLI that keeps its sign-in somewhere else than its file, as in a keyring.
    delete process.env.FAKE_AGY_BOUND;
    process.env.FAKE_AGY_KEYRING = "1";
    const elsewhere = await signInAs(3, true);
    expect(elsewhere.status).toMatchObject({ state: "failed", code: "not_kept" });
    expect(elsewhere.status.error).toContain(`no ${AGY_SIGN_IN_FILE}`);
    expect(elsewhere.status.message).toBeUndefined();
    // Signed in again, one whose copy doesn't sign in leaves the account signed out for every agent, never as signed in
    // with a copy that fails each agent's next turn.
    delete process.env.FAKE_AGY_KEYRING;
    expect((await signInAs(4, true)).status).toMatchObject({ state: "done" });
    process.env.FAKE_AGY_BOUND = "1";
    const again = await signInAs(4, true, true);
    expect(again.status).toMatchObject({ state: "failed", code: "not_kept" });
    expect(await m.grant("antigravity", again.id)).toEqual({ kind: "none" });
    m.invalidate();
    expect((await m.list()).find((a) => a.id === again.id)).toMatchObject({ loggedIn: false, shared: true });
  },
  45_000,
);

test.skipIf(!posix)(
  "a Gemini sign-in for all agents whose copy says nothing for sure fails with Try again, and signs no agent out",
  async () => {
    const home = tempDir("agy-accounts-");
    dirs.push(home);
    const m = new AccountManager({
      root: path.join(home, "accounts"),
      orgId: () => ORG,
      platform: "linux",
      commands: { antigravity: [process.execPath, FAKE] },
      lending: { chown: async () => {} },
      statusTimeoutMs: 2000,
    });
    managers.push(m);
    const signInAs = async (n: number, again = false) => {
      const id = `0193eeee-0000-7000-8000-0000000000e${n}`;
      const begun = await m.begin("antigravity", id, again, undefined, undefined, true);
      const aad = accountCodeAad(id, ORG);
      await m.code(id, aad, await sealSecret(begun.publicKey as string, "4/0AbCdEf-code", aad));
      await waitFor(() => m.status(id).state !== "waiting", 8000);
      return { id, status: m.status(id) };
    };
    // Root's own CLI signed in; its copy, in the empty home, didn't answer in time.
    process.env.FAKE_AGY_CHECK = "slow";
    const slow = await signInAs(1);
    expect(slow.status).toMatchObject({ state: "failed", code: "status_unknown" });
    expect(slow.status.error).toContain("a copy of that sign-in didn't answer in time");
    expect(slow.status.error).toContain("Try again.");
    // Signed in again, its copy couldn't reach Google: what each agent's turn gets stays as it was.
    delete process.env.FAKE_AGY_CHECK;
    expect((await signInAs(2)).status).toMatchObject({ state: "done" });
    process.env.FAKE_AGY_CHECK = "offline";
    const offline = await signInAs(2, true);
    expect(offline.status).toMatchObject({
      state: "failed",
      code: "status_unknown",
      message:
        'Error: Post "https://oauth2.googleapis.com/token": dial tcp: lookup oauth2.googleapis.com: no such host',
    });
    expect(offline.status.error).toContain("a copy of that sign-in didn't say whether it signs in");
    expect(await m.grant("antigravity", offline.id)).toMatchObject({ kind: "agy_auth" });
    m.invalidate();
    expect((await m.list()).find((a) => a.id === offline.id)).toMatchObject({ loggedIn: true, shared: true });
  },
  45_000,
);
