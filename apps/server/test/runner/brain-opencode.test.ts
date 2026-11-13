import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters";
import { accountCodeAad, OPENCODE_KEY_PROVIDER } from "@agenteschat/adapters/machine-protocol";
import { sealSecret } from "@agenteschat/adapters/secret-box";
import { setTool } from "../../runner/access";
import { AccountManager, accountEnv, opencodeKeyOf } from "../../runner/accounts";
import { AcpError } from "../../runner/acp";
import { type CodexBrainEvent, CodexThreads } from "../../runner/brain-codex";
import {
  acpProblem,
  githubConfigDir,
  OPENCODE_CHAT_PERMISSION,
  OpencodeTurnReader,
  opencodeBridge,
  opencodeConfig,
  opencodeConfigDir,
  opencodePermissions,
  opencodeProblem,
  opencodePrompt,
  opencodeSessionKey,
  opencodeSessionsFile,
  opencodeTurnEnv,
  runOpencodeTurn,
} from "../../runner/brain-opencode";
import { accessToStore, effectiveAccess } from "../../runner/config";
import { detectExecutors, opencodeModelsArgs, parseOpencodeModels } from "../../runner/executors";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER } from "../../runner/mcp";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
const managers: AccountManager[] = [];
const realHome = process.env.HOME;
afterEach(async () => {
  for (const m of managers.splice(0)) await m.close();
  for (const name of ["FAKE_OPENCODE_LOG", "FAKE_OPENCODE_VERSION", "OPENCODE_PERMISSION", "ANTHROPIC_API_KEY"]) {
    delete process.env[name];
  }
  process.env.HOME = realHome;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-opencode.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000f1";
const SESSION = "0193cccc-0000-7000-8000-0000000000f1";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff00f1", handle: "dev" };
const ACCOUNT = "0193eeee-0000-7000-8000-0000000000f1";
const ORG = "0193dddd-0000-7000-8000-000000000001";
const KEY = "oc_sk_fake0000000000000000";
const BRIDGE = `${CODEX_MCP_SERVER}_`;
const run = (n: number) => RUN.replace(/1$/, String(n));
const VERSIONS = ["1", "2"] as const;

// ── What a turn sends ──────────────────────────────────────────────────────────

test("the turn's config: each profile's rules allow or deny, never ask; the chat lock; the model, the key, the free tier", () => {
  const work = JSON.parse(opencodeConfig({ profile: "work" }));
  expect(work.permission).toEqual({ "*": "allow", external_directory: "deny", question: "deny", execute: "deny" });
  expect(work).toMatchObject({ share: "disabled", autoupdate: false });
  // Our bridge goes with the session, never in the config.
  expect(work.mcp).toBeUndefined();
  expect(work.model).toBeUndefined();
  const plan = opencodePermissions("plan");
  expect(plan).toMatchObject({ "*": "allow", edit: "deny", bash: "deny", task: "deny", execute: "deny" });
  for (const rules of [work.permission, plan, OPENCODE_CHAT_PERMISSION]) {
    expect(Object.values(rules).every((v) => v === "allow" || v === "deny")).toBe(true);
  }
  const chat = JSON.parse(opencodeConfig({ profile: "work", chat: true, model: "opencode/glm-5.3" }));
  expect(chat.permission).toEqual({ "*": "deny", [`${BRIDGE}*`]: "allow" });
  expect(chat).toMatchObject({ model: "opencode/glm-5.3", small_model: "opencode/glm-5.3" });
  const keyed = JSON.parse(opencodeConfig({ profile: "work", key: true }));
  expect(keyed.provider.opencode.options.apiKey).toBe("{env:OPENCODE_API_KEY}");
  expect(JSON.parse(opencodeConfig({ profile: "work", freeTier: true })).enabled_providers).toEqual(["opencode"]);
});

test("our bridge goes with the session: stdio with the run's token, socket and home in its env, or HTTP with a bearer", () => {
  expect(
    opencodeBridge({
      runId: RUN,
      token: "tok",
      command: ["/opt/agentes-runner", "--x"],
      socketPath: "/s.sock",
      runnerHome: "/h",
    }),
  ).toEqual({
    name: CODEX_MCP_SERVER,
    command: "/opt/agentes-runner",
    args: ["--x", "mcp", "--run", RUN],
    env: [
      { name: "AGENTES_MCP_TOKEN", value: "tok" },
      { name: "AGENTES_MCP_SOCKET", value: "/s.sock" },
      { name: "AGENTES_RUNNER_HOME", value: "/h" },
    ],
  });
  expect(opencodeBridge({ runId: RUN, token: "tok", url: "https://x/mcp", runnerHome: "/h" })).toEqual({
    type: "http",
    name: CODEX_MCP_SERVER,
    url: "https://x/mcp",
    headers: [{ name: "Authorization", value: "Bearer tok" }],
  });
  expect(opencodePrompt("You are Dev.", "hi", true)).toBe("You are Dev.\n\nhi");
  expect(opencodePrompt("You are Dev.", "hi", false)).toBe("hi");
});

test("the env: the turn's folder as PWD, gh where it was (AppData on Windows), no inherited OpenCode config, the free tier keyless", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/p",
    PWD: "/runner/started/here",
    Opencode_Config: "/elsewhere.json",
    OPENCODE_PERMISSION: '{"bash":"allow"}',
    ANTHROPIC_API_KEY: "sk-ant-x",
  };
  const env = opencodeTurnEnv({ inherited: base, cwd: "/w/dev", configDir: "/r/cfg", config: "{}", platform: "linux" });
  expect(env).toMatchObject({
    PWD: "/w/dev",
    XDG_CONFIG_HOME: "/r/cfg",
    OPENCODE_CONFIG_DIR: "/r/cfg",
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    GH_CONFIG_DIR: "/home/p/.config/gh",
    ANTHROPIC_API_KEY: "sk-ant-x",
  });
  expect(env.Opencode_Config).toBeUndefined();
  expect(env.OPENCODE_PERMISSION).toBeUndefined();
  expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBeUndefined();
  const free = opencodeTurnEnv({
    inherited: base,
    cwd: "/w",
    configDir: "/c",
    config: "{}",
    freeTier: true,
    chat: true,
  });
  expect(free.ANTHROPIC_API_KEY).toBeUndefined();
  expect(free.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
  const account = opencodeTurnEnv({
    inherited: { ...base, OPENCODE_API_KEY: "machine" },
    cwd: "/w",
    configDir: "/c",
    config: "{}",
    account: { home: "/acc", key: KEY },
  });
  expect(account).toMatchObject({ XDG_DATA_HOME: "/acc", XDG_STATE_HOME: "/acc", XDG_CONFIG_HOME: "/c" });
  expect(account.OPENCODE_API_KEY).toBe(KEY);
  // Windows: no XDG folder of its own, so gh's sign-in is in %AppData%.
  expect(githubConfigDir({ APPDATA: "C:\\Users\\p\\AppData\\Roaming" }, "C:\\Users\\p", "win32")).toBe(
    "C:\\Users\\p\\AppData\\Roaming\\GitHub CLI",
  );
  expect(githubConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h", "linux")).toBe(path.join("/x", "gh"));
  expect(githubConfigDir({ GH_CONFIG_DIR: "/gh" }, "/h", "linux")).toBe("/gh");
});

test("sessions are kept per account and folder", () => {
  expect(opencodeSessionKey(SESSION, undefined, "/w/dev")).toBe(`${SESSION}|/w/dev`);
  expect(opencodeSessionKey(SESSION, ACCOUNT, "/w/dev/repo")).toBe(`${ACCOUNT}:${SESSION}|/w/dev/repo`);
});

// ── What a turn reads ──────────────────────────────────────────────────────────

const chunk = (text: string, messageId = "msg_1") => ({
  sessionUpdate: "agent_message_chunk",
  messageId,
  content: { type: "text", text },
});
const content = (text: string) => [{ type: "content", content: { type: "text", text } }];

test("updates: text streamed, a paragraph after a tool, OpenCode's own calls executed and ours left out, 1.x and 2.x names", () => {
  const reader = new OpencodeTurnReader({ redact: (t) => t.replaceAll("s3cr3t", "<redacted>") });
  const events = [
    chunk("Let me "),
    chunk("check."),
    // 1.x: the tool's name only in the first title; later ones describe the call.
    { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", kind: "execute", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "c1", title: "ls -la", rawInput: { command: "ls s3cr3t" } },
    { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: content("a.txt s3cr3t") },
    // 2.x names it; a failed call carries its error.
    { sessionUpdate: "tool_call", toolCallId: "c2", name: "read", title: "read", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed", rawOutput: { error: "no such file" } },
    { sessionUpdate: "tool_call", toolCallId: "c3", title: `${BRIDGE}post`, status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "c3", status: "completed", content: content("posted") },
    { sessionUpdate: "agent_thought_chunk", messageId: "msg_2", content: { type: "text", text: "thinking" } },
    chunk("All good.", "msg_2"),
    { sessionUpdate: "usage_update", used: 10 },
  ].flatMap((u) => reader.update(u));
  expect(events).toEqual([
    { type: "text_delta", text: "Let me " },
    { type: "text_delta", text: "check." },
    {
      type: "tool_call",
      id: "c1",
      name: "bash",
      input: { command: "ls <redacted>" },
      executed: { content: "a.txt <redacted>" },
    },
    { type: "tool_call", id: "c2", name: "read", input: {}, executed: { content: "no such file", isError: true } },
    { type: "text_delta", text: "\n\nAll good." },
  ]);
  expect(reader.streamed).toBe("Let me check.\n\nAll good.");
  // What came before the last tool call was narration.
  expect(reader.answer).toBe("All good.");
  expect(reader.worked).toBe(true);
  expect(reader.running.size).toBe(0);
});

test("a chat turn's reader: the first tool of OpenCode's own is a breach, before it runs; ours isn't", () => {
  const reader = new OpencodeTurnReader({ chat: true });
  reader.update({ sessionUpdate: "tool_call", toolCallId: "c1", name: `${BRIDGE}post`, status: "pending" });
  expect(reader.breach).toBeUndefined();
  reader.update({ sessionUpdate: "tool_call", toolCallId: "c2", name: "shell", status: "pending" });
  expect(reader.breach).toContain("shell");
});

test("steps: a new one begins with output after a tool ended, or in another message", () => {
  const reader = new OpencodeTurnReader();
  reader.update(chunk("a"));
  reader.update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", status: "pending" });
  expect(reader.steps).toBe(0);
  reader.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
  reader.update(chunk("b", "msg_1"));
  expect(reader.steps).toBe(1);
  reader.update(chunk("c", "msg_2"));
  expect(reader.steps).toBe(2);
});

test("the prompt's usage: every input token, cache included, thinking as output", () => {
  const reader = new OpencodeTurnReader();
  expect(
    reader.usage(
      { inputTokens: 900, outputTokens: 30, thoughtTokens: 10, cachedReadTokens: 100, cachedWriteTokens: 5 },
      "opencode/glm-5.3",
    ),
  ).toEqual([
    {
      type: "usage",
      input: 1005,
      output: 40,
      source: "plan",
      model: "opencode/glm-5.3",
      cacheRead: 100,
      cacheWrite: 5,
    },
  ]);
  expect(reader.usage({ inputTokens: 0, outputTokens: 0 })).toEqual([]);
  expect(reader.usage(undefined)).toEqual([]);
});

test("a turn that went wrong: OpenCode 2's error names, ACP's auth required, a limit or a key in words, anything else", () => {
  const free = acpProblem(
    new AcpError(-32603, "Internal error: Free usage limit reached.", { errorName: "provider.free-limit" }),
  );
  expect(free).toEqual({ message: "Free usage limit reached.", errorName: "provider.free-limit", auth: false });
  expect(opencodeProblem(free.message, true, free.errorName)).toEqual([
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "Free usage limit reached.", worked: true },
  ]);
  expect(opencodeProblem("Unauthorized", false, "provider.auth")[0]).toMatchObject({ code: "not_logged_in" });
  expect(acpProblem(new AcpError(-32000, "Authentication required")).auth).toBe(true);
  expect(opencodeProblem("Rate limit exceeded (429)")[1]).toMatchObject({ code: "plan_limit" });
  expect(opencodeProblem("401 invalid api key")[0]).toMatchObject({ code: "not_logged_in" });
  expect(opencodeProblem("model not found: x")).toEqual([
    { type: "error", code: "opencode_failed", message: "model not found: x", retryable: true },
  ]);
  expect(acpProblem(new Error("OpenCode exited with code 1")).message).toBe("OpenCode exited with code 1");
});

// ── Detection ──────────────────────────────────────────────────────────────────

test("the CLI's models: provider/model lines, the free tier marked", () => {
  expect(
    parseOpencodeModels(
      "opencode/big-pickle\nopencode/glm-5.3-flash-free\nopencode/glm-5.3\nanthropic/claude-x\nnoise\n",
    ),
  ).toEqual([
    { id: "opencode/big-pickle", label: "Big Pickle", free: true },
    { id: "opencode/glm-5.3-flash-free", label: "GLM-5.3 Flash Free", free: true },
    { id: "opencode/glm-5.3" },
    { id: "anthropic/claude-x" },
  ]);
});

test.skipIf(!posix)(
  "detection: OpenCode's semver and its models, OpenCode 2's on a private server; another `opencode` is skipped",
  async () => {
    const calls: string[][] = [];
    const run = (version: string) => (command: string, args: string[]) => {
      if (command === "opencode") calls.push(args);
      return command === "opencode"
        ? args[0] === "--version"
          ? { status: 0, stdout: `${version}\n` }
          : { status: 0, stdout: "opencode/big-pickle\n" }
        : { status: 1, stdout: "" };
    };
    expect((await detectExecutors(run("1.19.5"))).found.opencode).toEqual({
      version: "1.19.5",
      models: [{ id: "opencode/big-pickle", label: "Big Pickle", free: true }],
    });
    expect(calls.at(-1)).toEqual(["models"]);
    // OpenCode 2.2 says its name first (`opencode v2.2.7`): found, its version kept without the name, and its models
    // listed on a private server, never the person's background service started and left running.
    expect((await detectExecutors(run("opencode v2.2.7"))).found.opencode).toEqual({
      version: "v2.2.7",
      models: [{ id: "opencode/big-pickle", label: "Big Pickle", free: true }],
    });
    expect(calls.at(-1)).toEqual(["models", "--standalone"]);
    expect((await detectExecutors(run("opencode the game"))).found.opencode).toBeUndefined();
    expect(opencodeModelsArgs("0.15.0")).toEqual(["models"]);
    expect(opencodeModelsArgs("3.0.1")).toEqual(["models", "--standalone"]);
  },
);

test("an account folder is all of OpenCode's XDG folders, and no other key leaks in", () => {
  const env = accountEnv("opencode", "/acc/o", { PATH: "/bin", OPENCODE_API_KEY: "machine", HOME: "/h" });
  expect(env).toMatchObject({
    XDG_DATA_HOME: "/acc/o",
    XDG_CONFIG_HOME: "/acc/o",
    XDG_CACHE_HOME: "/acc/o",
    XDG_STATE_HOME: "/acc/o",
  });
  expect(env.OPENCODE_API_KEY).toBeUndefined();
});

test("access stored before OpenCode's switch follows Codex's", () => {
  const stored = (tools: Record<string, boolean>) =>
    ({ access: { folders: [], tools: { claude: true, commands: true, ...tools } } }) as never;
  expect(effectiveAccess(stored({ codex: false, cursor: true })).tools.opencode).toBe(false);
  expect(effectiveAccess(stored({ codex: true, opencode: false })).tools.opencode).toBe(false);
  // A Codex edit from an app without OpenCode's switch doesn't freeze OpenCode on; turning it off stores its own.
  const before = stored({ codex: true, cursor: true });
  const offCodex = accessToStore(before, setTool(effectiveAccess(before), "codex", false));
  expect(offCodex.tools.opencode).toBeUndefined();
  expect(accessToStore(before, setTool(effectiveAccess(before), "opencode", false)).tools.opencode).toBe(false);
});

// ── Turns against a fake OpenCode (ACP, as 1.19.5 or 2.2.7) ────────────────────

/** A request scope that streams nowhere. */
const quiet = { signal: new AbortController().signal, output: () => {}, emit: () => {} };

const fakeSpawn: Spawn = ((_file, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn;

function turnContext(root: string) {
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  // The agent's own home (`~/.opencode`), never the test machine's.
  process.env.HOME = path.join(root, "agent-home");
  for (const d of [ws, home, process.env.HOME]) mkdirSync(d, { recursive: true });
  return {
    home,
    ws,
    ctx: {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      codex: { runnerHome: home, runs: new Map(), spawn: fakeSpawn },
    },
  };
}

const turn = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.turn",
    runId: RUN,
    kind: "opencode",
    session: { id: SESSION, resume: false },
    cwd: "",
    system: "You are Dev, the team's developer.",
    prompt: "run the tests",
    mcp: { token: "tok_run" },
    agent: AGENT,
    ...over,
  }) as MachineRequest;

interface Logged {
  start?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  text?: string;
  args?: string[];
  cwd?: string;
  pwd?: string | null;
  dataHome?: string | null;
  configHome?: string | null;
  configDir?: string | null;
  configEntries?: string[];
  config?: string | null;
  permission?: string | null;
  apiKey?: string | null;
  anthropicKey?: string | null;
  projectConfig?: string | null;
  lspDownload?: string | null;
  claudeCode?: string | null;
  permissionAnswer?: unknown;
  pid?: number;
  exited?: boolean;
  sigterm?: boolean;
}
const logOf = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Logged)
    : [];
const methods = (file: string) => logOf(file).flatMap((l) => (l.method ? [l.method] : []));
const prompts = (file: string) => logOf(file).flatMap((l) => (l.method === "session/prompt" ? [l.text] : []));

/** One turn through the handler: its final event, and every event it streamed. */
async function runTurn(ctx: object, req: MachineRequest, signal = new AbortController().signal) {
  const events: CodexBrainEvent[] = [];
  const scope = {
    signal,
    output: () => {},
    emit: (f: { type: string; event?: CodexBrainEvent }) => f.type === "brain.event" && f.event && events.push(f.event),
  };
  const reply = (await handleRequest(ctx as never, req, scope as never)) as { final: CodexBrainEvent };
  return { final: reply.final, events };
}

for (const version of VERSIONS) {
  test.skipIf(!posix)(
    `OpenCode ${version}: the first turn starts a session with the context and our bridge in it; the next resumes it`,
    async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const root = tempDir("brain-opencode-");
      dirs.push(root);
      const { ctx, home, ws } = turnContext(root);
      const log = path.join(root, "opencode.log");
      process.env.FAKE_OPENCODE_LOG = log;
      const { final, events } = await runTurn(ctx, turn());
      expect(final).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
      expect(events.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name)).toEqual([
        version === "2" ? "shell" : "bash",
      ]);
      expect(events.find((e) => e.type === "usage")).toEqual({
        type: "usage",
        input: 1000,
        output: 40,
        source: "plan",
        cacheRead: 100,
      });
      expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual([
        "Let me check.",
        "\n\nAll ",
        "good.",
      ]);

      const [start] = logOf(log);
      expect(start).toMatchObject({ start: true, args: ["acp"], projectConfig: "1", apiKey: null });
      // The turn's folder, never the runner's own `$PWD`.
      expect(start?.pwd).toBe(start?.cwd);
      expect(start?.config).not.toContain("tok_run");
      expect(methods(log)).toEqual(["initialize", "session/new", "session/prompt"]);
      const created = logOf(log).find((l) => l.method === "session/new");
      expect(created?.params).toMatchObject({
        cwd: expect.stringContaining(`dev-${AGENT.id.slice(0, 8)}`),
        mcpServers: [
          {
            name: CODEX_MCP_SERVER,
            args: ["mcp", "--run", RUN],
            env: expect.arrayContaining([{ name: "AGENTES_MCP_TOKEN", value: "tok_run" }]),
          },
        ],
      });
      expect(prompts(log)).toEqual(["You are Dev, the team's developer.\n\nrun the tests"]);
      const stored = JSON.parse(readFileSync(opencodeSessionsFile(home), "utf8")) as Record<string, string>;
      expect(Object.values(stored)).toEqual(["ses_fake0001"]);
      expect(Object.keys(stored)[0]).toStartWith(`${SESSION}|${ws}`);

      // The next turn resumes it: no context again, no new session.
      expect((await runTurn(ctx, turn({ runId: run(2), prompt: "and now?" }))).final).toMatchObject({ type: "done" });
      expect(methods(log).slice(3)).toEqual(["initialize", "session/resume", "session/prompt"]);
      expect(prompts(log).at(-1)).toBe("and now?");

      // A model named: set on the resumed session; one OpenCode doesn't offer fails the turn in its words.
      await runTurn(ctx, turn({ runId: run(3), model: "opencode/glm-5.3", prompt: "x" }));
      expect(logOf(log).find((l) => l.method === "session/set_config_option")?.params).toEqual({
        sessionId: "ses_fake0001",
        configId: "model",
        value: "opencode/glm-5.3",
      });
      const missing = await runTurn(ctx, turn({ runId: run(4), model: "opencode/missing" }));
      expect(missing.final).toMatchObject({
        type: "error",
        code: "opencode_failed",
        message: expect.stringContaining("doesn't offer opencode/missing"),
      });
      await expect(
        handleRequest(ctx as never, turn({ runId: run(5), model: "--help" }), quiet as never),
      ).rejects.toMatchObject({ code: "bad_request" });
    },
    20_000,
  );

  test.skipIf(!posix)(
    `OpenCode ${version}: a session it lost answers with an error, and a new one starts with the context`,
    async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const root = tempDir("brain-opencode-");
      dirs.push(root);
      const { ctx, home, ws } = turnContext(root);
      const log = path.join(root, "opencode.log");
      process.env.FAKE_OPENCODE_LOG = log;
      const key = opencodeSessionKey(SESSION, undefined, path.join(ws, `dev-${AGENT.id.slice(0, 8)}`));
      mkdirSync(path.join(home, "brain"), { recursive: true });
      writeFileSync(opencodeSessionsFile(home), JSON.stringify({ [key]: "ses_gone" }));
      expect((await runTurn(ctx, turn({ prompt: "and now?" }))).final).toMatchObject({ type: "done" });
      expect(methods(log)).toEqual(["initialize", "session/resume", "session/new", "session/prompt"]);
      expect(prompts(log)).toEqual(["You are Dev, the team's developer.\n\nand now?"]);
      expect(JSON.parse(readFileSync(opencodeSessionsFile(home), "utf8"))).toEqual({ [key]: "ses_fake0001" });
    },
    20_000,
  );

  test.skipIf(!posix)(
    `OpenCode ${version}: an account's turn runs in its folder with its sealed key; a printed key is redacted; refused, limited`,
    async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const root = tempDir("brain-opencode-");
      dirs.push(root);
      const { ctx } = turnContext(root);
      const log = path.join(root, "opencode.log");
      process.env.FAKE_OPENCODE_LOG = log;
      const accountDir = path.join(root, "accounts", "opencode", ACCOUNT);
      mkdirSync(accountDir, { recursive: true });
      writeFileSync(path.join(accountDir, "opencode-key.json"), JSON.stringify({ key: KEY }));
      const withAccounts = (dir: string | null) => ({
        ...ctx,
        codex: { ...ctx.codex, accounts: { accountDir: (kind: string) => (kind === "opencode" ? dir : null) } },
      });
      const final = async (over: Record<string, unknown>, c: object = withAccounts(accountDir)) =>
        (await runTurn(c, turn({ account: ACCOUNT, ...over }))).final;

      expect(await final({})).toMatchObject({ type: "done" });
      const used = logOf(log).find((l) => l.start);
      expect(used).toMatchObject({ dataHome: accountDir, apiKey: KEY });
      expect(JSON.parse(used?.config ?? "{}").provider.opencode.options.apiKey).toBe("{env:OPENCODE_API_KEY}");
      expect(used?.config).not.toContain(KEY);

      const printed = await runTurn(withAccounts(accountDir), turn({ account: ACCOUNT, runId: run(4), prompt: "ENV" }));
      expect(JSON.stringify(printed)).not.toContain(KEY);
      expect(JSON.stringify(printed.events)).toContain("OPENCODE_API_KEY");

      expect(await final({ runId: run(5) }, withAccounts(null))).toEqual({
        type: "error",
        code: "account_missing",
        message: expect.stringContaining("OpenCode account"),
        retryable: false,
      });
      expect(await final({ runId: run(6), prompt: "BADKEY" })).toMatchObject({ code: "not_logged_in" });
      const limited = await runTurn(
        withAccounts(accountDir),
        turn({ account: ACCOUNT, runId: run(7), prompt: "LIMIT" }),
      );
      expect(limited.final).toMatchObject({ code: "plan_limit" });
      expect(limited.events.some((e) => e.type === "limit")).toBe(true);
    },
    20_000,
  );

  test.skipIf(!posix)(
    `OpenCode ${version}: a permission request is refused; 2.x then ends the turn and the turn says what it asked`,
    async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const root = tempDir("brain-opencode-");
      dirs.push(root);
      const { ctx } = turnContext(root);
      const log = path.join(root, "opencode.log");
      process.env.FAKE_OPENCODE_LOG = log;
      const { final } = await runTurn(ctx, turn({ prompt: "ASK" }));
      expect(logOf(log).find((l) => l.permissionAnswer)?.permissionAnswer).toEqual({
        outcome: { outcome: "selected", optionId: "reject" },
      });
      if (version === "2") {
        expect(final).toMatchObject({
          type: "error",
          code: "opencode_failed",
          message: expect.stringContaining("asked for permission to curl example.com"),
        });
      } else expect(final).toMatchObject({ type: "done", text: "I couldn't run it." });
    },
    20_000,
  );

  test.skipIf(!posix)(
    `OpenCode ${version}: a canceled turn asks OpenCode to stop and ends canceled`,
    async () => {
      process.env.FAKE_OPENCODE_VERSION = version;
      const root = tempDir("brain-opencode-");
      dirs.push(root);
      const { ctx } = turnContext(root);
      const log = path.join(root, "opencode.log");
      process.env.FAKE_OPENCODE_LOG = log;
      const controller = new AbortController();
      const pending = runTurn(ctx, turn({ prompt: "SLEEP" }), controller.signal);
      await waitFor(() => prompts(log).length > 0);
      controller.abort();
      const { final } = await pending;
      expect(final).toEqual({ type: "error", code: "canceled", message: "The turn was canceled." });
      expect(methods(log)).toContain("session/cancel");
    },
    20_000,
  );
}

test.skipIf(!posix)(
  "steering: an OpenCode 2 turn takes messages and says it read them at its next step; 1.x reads only between turns",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const uuid = "0193abcd-0000-7000-8000-000000000001";
    const steer = (runId: string, agent = AGENT) =>
      handleRequest(
        ctx as never,
        {
          op: "brain.steer",
          runId,
          session: SESSION,
          messages: [{ uuid, text: "Skip the rest." }],
          agent,
        } as MachineRequest,
        quiet as never,
      );

    const pending = runTurn(ctx, turn({ prompt: "STEER" }));
    await waitFor(() => prompts(log).length > 0);
    // Another agent's turn is never reached.
    expect(await steer(RUN, { ...AGENT, id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0002" })).toEqual({ status: "no_turn" });
    expect(await steer(RUN)).toEqual({ status: "accepted", accepted: [uuid] });
    const { final, events } = await pending;
    expect(final).toMatchObject({ type: "done", text: "Steered." });
    expect(events.filter((e) => e.type === "steer_read")).toEqual([{ type: "steer_read", uuids: [uuid] }]);
    expect(logOf(log).some((l) => l.method === "_session/steering")).toBe(true);
    // No turn of that run now.
    expect(await steer(RUN)).toMatchObject({ status: expect.stringMatching(/no_turn|unsupported/) });

    process.env.FAKE_OPENCODE_VERSION = "1";
    const controller = new AbortController();
    const old = runTurn(ctx, turn({ runId: run(2), prompt: "SLEEP" }), controller.signal);
    await waitFor(() => prompts(log).length > 1);
    expect(await steer(run(2))).toEqual({
      status: "unsupported",
      reason: "OpenCode 1.19.5 reads messages only between turns",
    });
    controller.abort();
    expect((await old).final).toMatchObject({ code: "canceled" });
  },
  20_000,
);

test.skipIf(!posix)(
  "a chat turn: the agent's own folder, the lock, no ~/.claude; a tool of OpenCode's own stops it before it runs",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const chat = (n: number, prompt: string) =>
      runTurn(
        { ...ctx, grants: ["/somewhere/else"], secretsDir: path.join(root, "no-secrets") },
        turn({ runId: run(n), cwd: "repos/acme/app", permissions: { mode: "chat" }, prompt }),
      );
    const ok = await chat(1, "hello");
    expect(ok.final).toMatchObject({ type: "done" });
    const start = logOf(log).find((l) => l.start);
    // Whatever folder the request names: the agent's own.
    expect(path.basename(start?.cwd ?? "")).toBe(`dev-${AGENT.id.slice(0, 8)}`);
    expect(JSON.parse(start?.config ?? "{}").permission).toEqual(OPENCODE_CHAT_PERMISSION);
    expect(start?.claudeCode).toBe("1");

    const breached = await chat(2, "OWNTOOL");
    expect(breached.final).toMatchObject({ type: "error", code: "tools_not_locked" });
    expect((breached.final as { message: string }).message).toContain("shell");
    expect(breached.events.filter((e) => e.type === "tool_call")).toEqual([]);
  },
  20_000,
);

test.skipIf(!posix)(
  "OpenCode reads no config but ours: its config folder emptied each turn, no inherited permission, ~/.opencode refused",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx, home } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    process.env.OPENCODE_PERMISSION = JSON.stringify({ bash: "allow", edit: "allow" });
    const configDir = opencodeConfigDir(home);
    // What an earlier `work` turn could have left there.
    mkdirSync(path.join(configDir, "plugin"), { recursive: true });
    mkdirSync(path.join(configDir, "node_modules"), { recursive: true });
    writeFileSync(path.join(configDir, "plugin", "x.js"), "export default {}");
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: { other: { type: "local" } } }));

    expect((await runTurn(ctx, turn({ permissions: { mode: "plan" } }))).final).toMatchObject({ type: "done" });
    const start = logOf(log).find((l) => l.start);
    expect(start).toMatchObject({
      configHome: configDir,
      configDir,
      configEntries: ["node_modules"],
      permission: null,
      lspDownload: "1",
    });
    expect(JSON.parse(start?.config ?? "{}").permission).toEqual(opencodePermissions("plan"));

    mkdirSync(path.join(process.env.HOME as string, ".opencode", "plugin"), { recursive: true });
    expect((await runTurn(ctx, turn({ runId: run(2) }))).final).toMatchObject({
      type: "error",
      code: "opencode_failed",
      message: expect.stringContaining("plugin"),
    });
    expect(logOf(log).filter((l) => l.start)).toHaveLength(1);
  },
  20_000,
);

test.skipIf(!posix)(
  "the free tier: no key from the runner's env, OpenCode's own provider alone, its models only",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { ctx } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-runner-key";
    await runTurn(ctx, turn({ freeTier: true, model: "opencode/big-pickle" }));
    const [free] = logOf(log).filter((l) => l.start);
    expect(free?.anthropicKey).toBeNull();
    expect(JSON.parse(free?.config ?? "{}").enabled_providers).toEqual(["opencode"]);

    await runTurn(ctx, turn({ runId: run(2) }));
    const own = logOf(log).filter((l) => l.start)[1];
    expect(own?.anthropicKey).toBe("sk-ant-fake-runner-key");
    expect(JSON.parse(own?.config ?? "{}").enabled_providers).toBeUndefined();

    await expect(
      handleRequest(ctx as never, turn({ runId: run(3), freeTier: true, model: "anthropic/claude-x" }), quiet as never),
    ).rejects.toMatchObject({ code: "bad_request" });
  },
  20_000,
);

test.skipIf(!posix)(
  "a turn that hears nothing from OpenCode stops and says why; a CLI that isn't there is missing",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { home, ws } = turnContext(root);
    const events: CodexBrainEvent[] = [];
    const input = {
      runId: RUN,
      sessionId: SESSION,
      cwd: ws,
      system: "",
      prompt: "SILENT",
      mcp: { token: "t" },
      agentId: AGENT.id,
    };
    const opts = {
      sessions: new CodexThreads(path.join(root, "sessions.json")),
      emit: (e: CodexBrainEvent) => events.push(e),
      signal: new AbortController().signal,
      runnerHome: home,
      spawn: fakeSpawn,
      silenceMs: 400,
    };
    await runOpencodeTurn(input, opts);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "opencode_failed",
      message: expect.stringContaining("said nothing for"),
    });

    events.length = 0;
    const nowhere = ((_file, args, options) => spawn(path.join(root, "no-such-opencode"), args, options)) as Spawn;
    await runOpencodeTurn({ ...input, prompt: "hi" }, { ...opts, spawn: nowhere });
    expect(events).toEqual([
      {
        type: "error",
        code: "opencode_missing",
        message: "OpenCode's CLI is not installed on this computer.",
        retryable: true,
      },
    ]);
  },
  20_000,
);

test.skipIf(!posix)(
  "the turn returns once OpenCode has gone: one that takes a moment is waited for, one that won't go is killed",
  async () => {
    const root = tempDir("brain-opencode-");
    dirs.push(root);
    const { home, ws } = turnContext(root);
    const log = path.join(root, "opencode.log");
    process.env.FAKE_OPENCODE_LOG = log;
    const events: CodexBrainEvent[] = [];
    const input = { runId: RUN, sessionId: SESSION, cwd: ws, system: "", mcp: { token: "t" }, agentId: AGENT.id };
    const opts = {
      sessions: new CodexThreads(path.join(root, "sessions.json")),
      emit: (e: CodexBrainEvent) => events.push(e),
      signal: new AbortController().signal,
      runnerHome: home,
      spawn: fakeSpawn,
      exitGraceMs: 400,
    };
    // Its input closed, it exits a moment later: by then its answer is out, and the turn returns after.
    await runOpencodeTurn({ ...input, prompt: "LINGER" }, opts);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "All good." });
    expect(logOf(log).some((l) => l.exited)).toBe(true);

    // Nor its input closing nor SIGTERM ends it: killed, and gone when the turn returns.
    events.length = 0;
    await runOpencodeTurn({ ...input, runId: run(2), prompt: "STUCK" }, opts);
    expect(events.at(-1)).toMatchObject({ type: "done", text: "All good." });
    expect(logOf(log).some((l) => l.sigterm)).toBe(true);
    const pid =
      logOf(log)
        .filter((l) => l.start)
        .at(-1)?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  },
  20_000,
);

test.skipIf(!posix)("OpenCode turned off refuses the turn", async () => {
  const root = tempDir("brain-opencode-");
  dirs.push(root);
  const { ctx } = turnContext(root);
  const tools = { claude: true, codex: true, opencode: false, commands: true };
  const off = { ...ctx, access: () => ({ folders: [], tools }) };
  await expect(handleRequest(off as never, turn(), quiet as never)).rejects.toMatchObject({ code: "not_allowed" });
});

test.skipIf(!posix)("an OpenCode account is its sealed key: no key, no sign-in", async () => {
  const home = tempDir("opencode-accounts-");
  dirs.push(home);
  const m = new AccountManager({
    root: path.join(home, "accounts"),
    orgId: () => ORG,
    commands: { opencode: [process.execPath, FAKE] },
  });
  managers.push(m);
  const id = "0193eeee-0000-7000-8000-0000000000e1";
  await expect(m.begin("opencode", id)).rejects.toMatchObject({ code: "bad_request" });
  await expect(m.begin("opencode", id, false, undefined, "cursor")).rejects.toMatchObject({ code: "bad_request" });
  const begun = await m.begin("opencode", id, false, undefined, OPENCODE_KEY_PROVIDER);
  expect(begun.publicKey).toBeString();
  const aad = accountCodeAad(id, ORG);
  await expect(m.code(id, aad, await sealSecret(begun.publicKey as string, "short", aad))).rejects.toMatchObject({
    message: "That doesn't look like an OpenCode API key. Copy the whole key.",
  });
  await m.code(id, aad, await sealSecret(begun.publicKey as string, KEY, aad));
  expect(m.status(id).account).toMatchObject({ kind: "opencode", loggedIn: true, provider: "zen", keyHint: "0000" });
  expect(await opencodeKeyOf(path.join(home, "accounts", "opencode", id))).toBe(KEY);
  m.invalidate();
  expect((await m.list()).find((a) => a.id === id)).toMatchObject({ loggedIn: true, provider: "zen" });
});

/** Waits for `check` (polling), at most `ms`. */
async function waitFor(check: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
