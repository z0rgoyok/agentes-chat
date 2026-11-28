import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { devinVariant, devinVariantOf } from "@agenteschat/providers/plans";
import { accountEnv, parseDevinLoginUrl, parseDevinStatus, parseDevinWho } from "../../runner/accounts";
import { type CodexBrainEvent, CodexThreads } from "../../runner/brain-codex";
import {
  DevinTurnReader,
  devinChatBreach,
  devinMode,
  devinPermission,
  devinProblem,
  devinTurnModel,
  isOurDevinTool,
  runDevinTurn,
} from "../../runner/brain-devin";
import {
  clearDevinProject,
  DEVIN_NO_IMPORTS,
  DEVIN_PLANTED,
  devinConfigFile,
  devinCredentialsFile,
  prepareDevinHome,
} from "../../runner/devin-home";
import { parseDevinModels } from "../../runner/executors";
import type { Spawn } from "../../runner/scope-gate";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  delete process.env.FAKE_DEVIN_LOG;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-devin.mjs");
const RUN = "0193aaaa-0000-7000-8000-0000000000d1";
const SESSION = "0193cccc-0000-7000-8000-0000000000d1";
const ACCOUNT = "0193eeee-0000-7000-8000-0000000000d1";
const fakeSpawn: Spawn = ((_file, args, options) => spawn(process.execPath, [FAKE, ...args], options)) as Spawn;

/** The fake's model listing, as a signed-in account's look reads it. */
function fakeListing(home: string) {
  mkdirSync(path.dirname(devinCredentialsFile(home)), { recursive: true });
  writeFileSync(devinCredentialsFile(home), 'windsurf_api_key = "devin-fake"\n');
  return execFileSync(process.execPath, [FAKE, "models", "list", "--format", "json"], {
    env: { ...process.env, ...accountEnv("devin", home, {}) },
  }).toString();
}

// ── Models, levels and variants ─────────────────────────────────────────────────

test("a variant's level and faster serving, read off its id; Fusion by its main model", () => {
  expect(devinVariantOf("claude-opus-5-5-xhigh")).toEqual({ level: "xhigh", fast: false });
  expect(devinVariantOf("gpt-6-sol-high-priority")).toEqual({ level: "high", fast: true });
  expect(devinVariantOf("swe-2-max-lightning")).toEqual({ level: "max", fast: true });
  expect(devinVariantOf("claude-opus-4-6-thinking")).toEqual({ fast: false });
  expect(devinVariantOf("fusion-claude-opus-5-5-medium-fast-sidekick-swe-2-medium")).toEqual({
    level: "medium",
    fast: true,
  });
});

test("the variant a turn runs: its effort, else the nearest level below, else above; fast where there is one", () => {
  const opus = ["claude-opus-5-5-medium", "claude-opus-5-5-low", "claude-opus-5-5-max", "claude-opus-5-5-medium-fast"];
  expect(devinVariant(opus)).toBe("claude-opus-5-5-medium");
  expect(devinVariant(opus, "max")).toBe("claude-opus-5-5-max");
  // No xhigh: the nearest level below it.
  expect(devinVariant(opus, "xhigh")).toBe("claude-opus-5-5-medium");
  expect(devinVariant(opus, "medium", true)).toBe("claude-opus-5-5-medium-fast");
  // No faster max: the standard one.
  expect(devinVariant(opus, "max", true)).toBe("claude-opus-5-5-max");
  // Nothing at or below low: the nearest above.
  expect(devinVariant(["kimi-k3-high", "kimi-k3-max"], "low")).toBe("kimi-k3-high");
  // A family whose variants name no level runs its first.
  expect(devinVariant(["claude-opus-4-6", "claude-opus-4-6-thinking"], "high")).toBe("claude-opus-4-6");
  expect(devinVariant([], "high")).toBeNull();
});

test.skipIf(!posix)("`devin models list`: one model per family, its levels, Fusion with the free helper only", () => {
  const root = tempDir("devin-models-");
  dirs.push(root);
  const models = parseDevinModels(fakeListing(root));
  expect(models.map((m) => m.id)).toEqual(["swe-2", "claude-opus-5-5", "fusion-claude-opus-5-5"]);
  expect(models[0]).toMatchObject({ label: "SWE-2", free: true, efforts: ["medium", "high", "max"], fast: true });
  expect(models[1]).toMatchObject({
    label: "Claude Opus 5.5",
    efforts: ["low", "medium", "xhigh", "max"],
    fast: true,
    contextWindow: 1000000,
  });
  expect(models[1]?.free).toBeUndefined();
  // The GLM helper's pair is left out.
  expect(models[2]).toMatchObject({ label: "Fusion · Claude Opus 5.5", efforts: ["medium", "max"] });
  expect(models[2]?.variants).toEqual([
    "fusion-claude-opus-5-5-medium-sidekick-swe-2-medium",
    "fusion-claude-opus-5-5-max-sidekick-swe-2-medium",
  ]);
  expect(parseDevinModels("Error: Not logged in.")).toEqual([]);
  expect(devinTurnModel("claude-opus-5-5", models, "max")).toBe("claude-opus-5-5-max");
  // A family no account listed: the CLI's own match for the name.
  expect(devinTurnModel("gpt-6-2-sol", models, "max")).toBe("gpt-6-2-sol");
  expect(devinTurnModel(undefined, models, "max")).toBeUndefined();
});

test("the sign-in: its link on app.devin.ai; signed in when its models list says so", () => {
  const said =
    "Visit \u001b]8;;https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1\u001b\\https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1\u001b]8;;\u001b\\ to sign in, then copy the code and paste it below.\n";
  expect(parseDevinLoginUrl(said, true)).toBe("https://app.devin.ai/auth/cli/continue?state=s1&code_challenge=c1");
  expect(parseDevinLoginUrl("Visit https://evil.example/auth?state=s1 to sign in", true)).toBeNull();
  expect(
    parseDevinWho(
      "Logged in (via Devin).\n\nUser:\n  Name:              Ana\n  Email:             ana@example.com\n\nAccount:\n  Tier:              Devin Pro\n  Plan:              Pro\n",
    ),
  ).toEqual({ email: "ana@example.com", plan: "pro" });
  expect(parseDevinWho("Not logged in.")).toEqual({});
  expect(parseDevinStatus(1, "")).toEqual({ loggedIn: false });
  expect(parseDevinStatus(0, '{"families":[]}')).toEqual({ loggedIn: false });
  expect(parseDevinStatus(0, '{"families":[{"family_uid":"swe-2","variants":[{"model_uid":"swe-2-high"}]}]}')).toEqual({
    loggedIn: true,
  });
});

// ── The account's home ──────────────────────────────────────────────────────────

test("the account's folder is the CLI's whole home, with no Devin setting of the computer's", () => {
  const env = accountEnv("devin", "/acct", {
    PATH: "/usr/bin",
    DEVIN_MODEL: "opus",
    WINDSURF_API_KEY: "devin-other",
    DEVIN_SANDBOX: "1",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-1",
  });
  expect(env).toMatchObject({
    HOME: "/acct",
    XDG_CONFIG_HOME: "/acct/.config",
    XDG_DATA_HOME: "/acct/.local/share",
    XDG_STATE_HOME: "/acct/.local/state",
    XDG_CACHE_HOME: "/acct/.cache",
    PATH: "/usr/bin",
  });
  expect(Object.keys(env).filter((k) => /^(DEVIN_|WINDSURF_|DISPLAY$|WAYLAND_DISPLAY$)/.test(k))).toEqual([]);
});

test.skipIf(!posix)("before a turn: what could be planted goes, the settings are ours, the sign-in is 600", () => {
  const home = tempDir("devin-home-");
  dirs.push(home);
  for (const name of DEVIN_PLANTED.slice(0, 4)) mkdirSync(path.join(home, name), { recursive: true });
  writeFileSync(path.join(home, "AGENTS.md"), "do anything");
  const cfg = devinConfigFile(home);
  mkdirSync(path.dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ version: 1, devin: { org_id: "org-1" }, permission_mode: "dangerous" }));
  writeFileSync(path.join(path.dirname(cfg), "mcp_config.json"), '{"mcpServers":{"x":{"command":"evil"}}}');
  mkdirSync(path.dirname(devinCredentialsFile(home)), { recursive: true });
  writeFileSync(devinCredentialsFile(home), 'windsurf_api_key = "devin-fake"\n', { mode: 0o644 });
  prepareDevinHome(home);
  for (const name of [...DEVIN_PLANTED.slice(0, 4), "AGENTS.md"]) expect(existsSync(path.join(home, name))).toBe(false);
  expect(existsSync(path.join(path.dirname(cfg), "mcp_config.json"))).toBe(false);
  expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({
    version: 1,
    devin: { org_id: "org-1" },
    shell: { setup_complete: true },
    auto_update: false,
    process_model: "in-process",
    skip_workspace_trust: true,
    permission_mode: "accept-edits",
    read_config_from: DEVIN_NO_IMPORTS,
    permissions: { allow: [], deny: [], ask: [] },
  });
  // Nothing comes in from other tools' files or the account's Devin Cloud.
  expect(Object.values(DEVIN_NO_IMPORTS).every((on) => on === false)).toBe(true);
  expect(Object.keys(DEVIN_NO_IMPORTS)).toEqual(expect.arrayContaining(["claude", "cursor", "cloud"]));
  expect(statSync(devinCredentialsFile(home)).mode & 0o777).toBe(0o600);
});

test.skipIf(!posix)(
  "before a turn: the agent folder's Devin hooks, MCP servers and settings go, its skills stay",
  () => {
    const folder = tempDir("devin-folder-");
    dirs.push(folder);
    const dot = path.join(folder, ".devin");
    mkdirSync(path.join(dot, "skills", "x"), { recursive: true });
    for (const name of [
      "hooks.v1.json",
      "config.json",
      "config.local.json",
      "mcp_config.json",
      "mcp_config.local.json",
    ]) {
      writeFileSync(path.join(dot, name), "{}");
    }
    clearDevinProject(folder);
    expect(readdirSync(dot)).toEqual(["skills"]);
    // Nothing there: nothing to do.
    clearDevinProject(path.join(folder, "missing"));
  },
);

// ── What the runner allows ──────────────────────────────────────────────────────

test("permissions: our tools always; a work turn's commands and its folders; nothing else, nothing in a chat", () => {
  const roots = ["/agents/dev", "/tmp"];
  const work = { profile: "work" as const, chat: false, roots };
  expect(devinPermission("mcp__agenteschat_agentes__post_message", { ...work, chat: true })).toBe("allow");
  expect(devinPermission("Exec(ls)", work)).toBe("allow");
  expect(devinPermission("Write(/tmp)", work)).toBe("allow");
  expect(devinPermission("Write(/agents/dev/src/**)", work)).toBe("allow");
  expect(devinPermission("Write(/etc/passwd)", work)).toBe("reject");
  expect(devinPermission("Write(/agents/dev-other)", work)).toBe("reject");
  expect(devinPermission("Write(relative)", work)).toBe("reject");
  expect(devinPermission("mcp__someone_else__tool", work)).toBe("reject");
  expect(devinPermission("WebFetch(example.com)", work)).toBe("reject");
  const plan = { ...work, profile: "plan" as const };
  expect(devinPermission("Read(/agents/dev/a.txt)", plan)).toBe("allow");
  expect(devinPermission("Exec(ls)", plan)).toBe("reject");
  expect(devinPermission("Write(/tmp)", plan)).toBe("reject");
  expect(devinPermission("Exec(ls)", { ...work, chat: true })).toBe("reject");
  expect(devinMode("work", false)).toBe("accept-edits");
  expect(devinMode("plan", false)).toBe("accept-edits");
  expect(devinMode("work", true)).toBe("accept-edits");
});

test("Lodi's guard: our server's tools (and listing them) only", () => {
  expect(isOurDevinTool("mcp__agenteschat_agentes__post_message")).toBe(true);
  expect(isOurDevinTool("mcp_list_tools", { server_name: "agenteschat_agentes" })).toBe(true);
  expect(isOurDevinTool("mcp_list_tools", { server_name: "other" })).toBe(false);
  expect(devinChatBreach("exec", {})).toContain("tool of its own (exec)");
  expect(devinChatBreach("mcp__agenteschat_agentes__ask_agent", {})).toBeNull();
});

test("Lodi's guard reads a call's name from the CLI, never its title, and a call that arrives already ended", () => {
  const ended = (id: string, extra: Record<string, unknown>) => ({
    sessionUpdate: "tool_call",
    toolCallId: id,
    status: "completed",
    rawInput: {},
    ...extra,
  });
  const chat = new DevinTurnReader({ chat: true });
  chat.update(ended("t1", { title: "mcp__agenteschat_agentes__post_message" }));
  expect(chat.breach).toContain("tool of its own (tool)");
  const own = new DevinTurnReader({ chat: true });
  own.update(ended("t2", { _meta: { "cognition.ai/toolName": "exec" } }));
  expect(own.breach).toContain("(exec)");
  expect(own.running.size).toBe(0);
  const ours = new DevinTurnReader({ chat: true });
  ours.update(ended("t3", { _meta: { "cognition.ai/toolName": "mcp__agenteschat_agentes__post_message" } }));
  expect(ours.breach).toBeUndefined();
  expect(ours.worked).toBe(true);
  const work = new DevinTurnReader();
  expect(
    work.update(
      ended("t4", {
        _meta: { "cognition.ai/toolName": "exec" },
        content: [{ type: "content", content: { type: "text", text: "ok" } }],
      }),
    ),
  ).toMatchObject([{ type: "tool_call", id: "t4", name: "exec", executed: { content: "ok" } }]);
});

test("a turn that went wrong: the plan's quota is a limit, a refused sign-in signed out, anything else failed", () => {
  expect(devinProblem("Weekly quota exceeded. It resets in 3 days.", true)).toMatchObject([
    { type: "limit" },
    { type: "error", code: "plan_limit", worked: true },
  ]);
  expect(devinProblem("Not logged in. Run `devin auth login` to authenticate.")).toEqual([
    {
      type: "error",
      code: "not_logged_in",
      message: "Not logged in. Run `devin auth login` to authenticate.",
      retryable: true,
    },
  ]);
  expect(devinProblem("boom")).toEqual([{ type: "error", code: "devin_failed", message: "boom", retryable: true }]);
});

// ── A turn, through the fake CLI ────────────────────────────────────────────────

interface Logged {
  start?: boolean;
  method?: string;
  params?: Record<string, unknown>;
  text?: string;
  model?: string;
  args?: string[];
  home?: string | null;
  devinEnv?: string[];
  config?: Record<string, unknown> | null;
  permissionAnswer?: unknown;
  configArg?: string | null;
}
const logOf = (file: string): Logged[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function turnSetup() {
  const root = tempDir("brain-devin-");
  dirs.push(root);
  const home = path.join(root, "acct");
  const ws = path.join(root, "agents", "dev");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const log = path.join(root, "devin.log");
  process.env.FAKE_DEVIN_LOG = log;
  const events: CodexBrainEvent[] = [];
  const sessions = new CodexThreads(path.join(root, "sessions.json"));
  const input = {
    runId: RUN,
    sessionId: SESSION,
    cwd: ws,
    model: "swe-2",
    variant: "swe-2-high",
    system: "You are Dev.",
    prompt: "run the tests",
    mcp: { token: "tok_run" },
    account: { id: ACCOUNT, home },
    roots: [ws],
  };
  const opts = {
    sessions,
    emit: (e: CodexBrainEvent) => events.push(e),
    signal: new AbortController().signal,
    runnerHome: path.join(root, "runner"),
    spawn: fakeSpawn,
    env: { DEVIN_MODEL: "opus", WINDSURF_API_KEY: "devin-other" },
  };
  return { root, home, ws, log, events, sessions, input, opts };
}

test.skipIf(!posix)(
  "a work turn: the variant as it starts, our bridge, the CLI's own command allowed, its output, the tokens",
  async () => {
    const t = turnSetup();
    await runDevinTurn(t.input, t.opts);
    const start = logOf(t.log).find((l) => l.start);
    expect(start?.args).toEqual(["acp", "--process-model", "in-process", "--model", "swe-2-high"]);
    // Its own settings file, gone once the turn ended.
    expect(start?.configArg).toBe(path.join(t.root, "runner", "brain", "devin-turns", `${RUN}.json`));
    expect(existsSync(start?.configArg ?? "")).toBe(false);
    expect(start?.config).toMatchObject({ permissions: { allow: ["mcp__agenteschat_agentes__*"], deny: [] } });
    expect(start?.home).toBe(t.home);
    expect(start?.devinEnv).toEqual([]);
    expect(start?.config).toMatchObject({ process_model: "in-process", permission_mode: "accept-edits" });
    const opened = logOf(t.log).find((l) => l.method === "session/new");
    const servers = (opened?.params?.mcpServers ?? []) as { name: string; args: string[]; env: { name: string }[] }[];
    const bridge = servers[0];
    expect(bridge?.name).toBe("agenteschat_agentes");
    expect(bridge?.args.slice(-3)).toEqual(["mcp", "--run", RUN]);
    expect(bridge?.env.map((e) => e.name)).toContain("AGENTES_MCP_TOKEN");
    // A new session: the engine's context leads the prompt.
    expect(logOf(t.log).find((l) => l.method === "session/prompt" && l.text !== undefined)?.text).toBe(
      "You are Dev.\n\nrun the tests",
    );
    expect(logOf(t.log).find((l) => l.permissionAnswer)?.permissionAnswer).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
    expect(t.events).toEqual([
      { type: "text_delta", text: "Working." },
      {
        type: "tool_call",
        id: "call_own",
        name: "exec",
        input: { command: "ls" },
        executed: { content: "hello.txt" },
      },
      { type: "text_delta", text: "\n\nDone." },
      { type: "usage", input: 1100, output: 100, source: "plan", model: "swe-2", cacheRead: 100 },
      { type: "done", text: "Done.", session: { id: SESSION } },
    ]);

    // The next turn loads that session, its history skipped and no context again.
    t.events.length = 0;
    await runDevinTurn({ ...t.input, prompt: "and now?" }, t.opts);
    expect(logOf(t.log).filter((l) => l.method === "session/load")).toHaveLength(1);
    expect(
      logOf(t.log)
        .filter((l) => l.method === "session/prompt" && l.text !== undefined)
        .at(-1)?.text,
    ).toBe("and now?");
    expect(t.events.at(-1)).toMatchObject({ type: "done", text: "Done." });
    expect(t.events.some((e) => e.type === "text_delta" && e.text.includes("run the tests"))).toBe(false);

    // Another effort is another variant: a new session, with the context.
    await runDevinTurn({ ...t.input, variant: "swe-2-max", prompt: "harder" }, t.opts);
    const prompts = logOf(t.log).filter((l) => l.method === "session/prompt" && l.text !== undefined);
    expect(prompts.at(-1)).toMatchObject({ text: "You are Dev.\n\nharder", model: "swe-2-max" });
    expect(logOf(t.log).filter((l) => l.method === "session/new")).toHaveLength(2);
  },
  20_000,
);

test.skipIf(!posix)(
  "a plan turn's edits and commands are refused by its rules; an edit outside the folders too; a chat turn's own tools refused, and stopped when one runs",
  async () => {
    const t = turnSetup();
    await runDevinTurn({ ...t.input, prompt: "OUTSIDE" }, t.opts);
    expect(logOf(t.log).find((l) => l.permissionAnswer)?.permissionAnswer).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });
    expect(t.events.find((e) => e.type === "tool_call")).toMatchObject({ executed: { isError: true } });

    t.events.length = 0;
    await runDevinTurn({ ...t.input, sessionId: SESSION.replace(/1$/, "2"), profile: "plan" }, t.opts);
    // Code mode still (Ask would refuse our server's tools), with the plan's rules.
    expect(logOf(t.log).find((l) => l.method === "session/set_config_option")).toBeUndefined();
    expect(
      logOf(t.log)
        .filter((l) => l.start)
        .at(-1)?.config,
    ).toMatchObject({
      permission_mode: "accept-edits",
      permissions: { deny: ["edit", "exec", "Write(/**)"] },
    });
    // Asked to run a command, a plan turn says no.
    expect(
      logOf(t.log)
        .filter((l) => l.permissionAnswer)
        .at(-1)?.permissionAnswer,
    ).toEqual({
      outcome: { outcome: "selected", optionId: "reject_once" },
    });

    // A chat turn: its own tools denied by its rules, a refused one says nothing and the turn goes on.
    t.events.length = 0;
    await runDevinTurn({ ...t.input, sessionId: SESSION.replace(/1$/, "3"), chat: true, roots: [] }, t.opts);
    expect(
      logOf(t.log)
        .filter((l) => l.start)
        .at(-1)?.config,
    ).toMatchObject({
      subagents_enabled: false,
      permissions: { deny: expect.arrayContaining(["read", "exec", "web_search", "webfetch"]) },
    });
    expect(t.events.some((e) => e.type === "tool_call")).toBe(false);
    expect(t.events.at(-1)).toMatchObject({ type: "done" });
    // Told which tools are its own here, ahead of the context.
    expect(
      logOf(t.log)
        .filter((l) => l.method === "session/prompt" && l.text !== undefined)
        .at(-1)?.text,
    ).toStartWith("Your own tools (files, shell, web search and fetch) are turned off here.");
    // One that runs anyway stops it.
    t.events.length = 0;
    await runDevinTurn(
      { ...t.input, sessionId: SESSION.replace(/1$/, "5"), chat: true, roots: [], prompt: "OWNRUN" },
      t.opts,
    );
    expect(t.events.at(-1)).toMatchObject({
      type: "error",
      code: "tools_not_locked",
      message: expect.stringContaining("tool of its own (read)"),
    });
    expect(t.events.some((e) => e.type === "text_delta" && e.text.includes("Read it"))).toBe(false);
  },
  20_000,
);

test.skipIf(!posix)(
  "the plan's quota is a limit, a refused sign-in is signed out, and a CLI that isn't there is missing",
  async () => {
    const t = turnSetup();
    await runDevinTurn({ ...t.input, prompt: "LIMIT" }, t.opts);
    expect(t.events).toMatchObject([{ type: "limit" }, { type: "error", code: "plan_limit" }]);
    t.events.length = 0;
    await runDevinTurn({ ...t.input, sessionId: SESSION.replace(/1$/, "4"), prompt: "AUTH" }, t.opts);
    expect(t.events.at(-1)).toMatchObject({ type: "error", code: "not_logged_in" });
    t.events.length = 0;
    const nowhere = ((_file, args, options) => spawn(path.join(t.root, "no-such-devin"), args, options)) as Spawn;
    await runDevinTurn(t.input, { ...t.opts, spawn: nowhere });
    expect(t.events).toEqual([
      {
        type: "error",
        code: "devin_missing",
        message: "The Devin CLI, Cognition's, is not installed on this computer.",
        retryable: true,
      },
    ]);
  },
  20_000,
);
