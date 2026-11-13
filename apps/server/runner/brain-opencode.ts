import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope, BrainSteerReply } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { redactSecrets } from "@agenteschat/adapters/secret-box";
import { ACCOUNT_MISSING_MESSAGE, accountEnv, opencodeKeyOf, withoutSignIns } from "./accounts";
import { ACP_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION, AcpConnection, AcpError } from "./acp";
import {
  CODEX_TOOL_OUTPUT_MAX,
  type CodexBrainEvent,
  CodexThreads,
  codexProfileOf,
  codexThreadKey,
} from "./brain-codex";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { cliSpawn, envValue, OPENCODE_BIN } from "./executors";
import { CODEX_MCP_ENV, CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The OpenCode branch of `brain.turn` (protocol 39, ADR 0132; over the Agent Client Protocol since protocol 64): one
 * agent turn as one `opencode acp` process, driven through `acp.ts`. OpenCode 1.x and 2.x both serve it (read in
 * their sources at 1.19.5 and 2.2.7, `packages/opencode/src/acp` and `packages/cli/src/acp`, and run against both,
 * 2026-11-13); 2.x always runs it on a private server of its own, never on the person's background service.
 *
 * - The session: our session → OpenCode's lives in `<runner home>/brain/opencode-sessions.json`, per account and
 *   folder. A stored one is resumed (`session/resume`, no history replayed); one OpenCode no longer has answers with
 *   an error, and a new session starts with the engine's context leading its first prompt (ACP has no system prompt).
 *   Nothing is created silently in its place, so the context is never lost.
 * - The model: `session/set_config_option` (`model`), the protocol's own way that both versions list; the config
 *   names it too, so a new session starts with it.
 * - Our MCP server goes with each session (`mcpServers`): stdio `agentes-runner mcp --run <run>` with the token, socket
 *   and home in its env, or the bridge's URL with the token as a bearer.
 * - Everything else rides on `OPENCODE_CONFIG_CONTENT`: the permissions (ADR 0053 §3), no sharing, no self-update, the
 *   account's key, the free tier's one provider. OpenCode merges it over the other configs it reads and joins their
 *   plugin lists, so it removes nothing they add: those configs are kept empty instead. `OPENCODE_DISABLE_PROJECT_CONFIG`:
 *   no project `opencode.json` or `.opencode/`. Its global config folder (`XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR`) is
 *   `<runner home>/brain/opencode-config`, emptied of everything but OpenCode's own packages before each turn. A
 *   `~/.opencode` with settings, plugins, agents, modes or tools refuses the turn (OpenCode always reads it, and only a
 *   person should remove it). `OPENCODE_PERMISSION`, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` aren't inherited.
 * - Permissions never ask: every rule allows or denies, since OpenCode 2.x ends the whole turn when a request is
 *   refused over ACP. One that asks anyway (a rule a computer's managed config adds) is refused, and the turn says so.
 *   `execute` is denied so our bridge's tools are called by name, not through OpenCode 2's code mode.
 * - The free tier (`freeTier`: no account, a computer nobody connected): no stray key in the env and
 *   `enabled_providers: ["opencode"]`, so no key the runner or the computer holds thinks for anyone's agent.
 * - Events: `agent_message_chunk` streams the text; a tool call of OpenCode's own, once it ended, is an executed
 *   `tool_call` (transcript only; our bridge's are left out: the engine ran them); the prompt's answer carries the
 *   tokens. A `chat` turn stops at the first tool call that isn't our bridge's, before OpenCode runs it.
 * - Live steering (OpenCode 2.x, `_session/steering`): `brain.steer` hands messages to the turn, read at its next model
 *   step (`steer_read`). 1.x takes nothing mid-turn (`unsupported`).
 * - Silence: OpenCode 1.x waits out a provider's limit by itself (a `retry-after` of hours) and says nothing over ACP;
 *   a turn that hears nothing for `OPENCODE_SILENCE_MS` with no tool running stops and says why.
 * - Windows: the CLI starts by its full path, npm's launcher skipped for the binary it runs (`cliSpawn`), in no new
 *   console; stopping it takes its whole tree (`killTree`).
 * - ADR 0041/0059: a turn with an `account` runs with that account's folder as OpenCode's XDG folders (`accountEnv`)
 *   and its sealed key as the `opencode` provider's key. Without one, the computer's own OpenCode: its own sign-ins, or
 *   the free tier with none. Usage is the person's (`source: "plan"`, cost zero for us).
 */

/** After asking OpenCode to stop, how long the turn waits for it before the process is killed. */
const STOP_WAIT_MS = 8000;
/** After the turn, how long the process may take to exit by itself (its input closed) before it is killed. */
const EXIT_GRACE_MS = 3000;
/** How long a process told to end (SIGTERM, then SIGKILL) has to go before the turn stops waiting for it. */
const KILL_WAIT_MS = 2000;
/** How long each step of starting (initialize, the session, the model) may take. */
const SETUP_TIMEOUT_MS = 120_000;
/** A turn that hears nothing from OpenCode this long, with no tool running, stops (see the header). */
export const OPENCODE_SILENCE_MS = 5 * 60_000;

/** `brain.turn` with `kind: "opencode"`. */
export interface OpencodeBrainTurnRequest {
  runId: string;
  kind: "opencode";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
  /** No account on a computer nobody connected: OpenCode's own free tier and nothing else (ADR 0132). */
  freeTier?: boolean;
}

/** Where our session → OpenCode session ids live in the runner home. */
export const opencodeSessionsFile = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-sessions.json");

/** OpenCode's global config folder for our turns: emptied before each one but for `OPENCODE_CONFIG_KEPT`. */
export const opencodeConfigDir = (runnerHome: string) => path.join(runnerHome, "brain", "opencode-config");

/** What OpenCode keeps in its config folder itself (`@opencode-ai/plugin` installed with bun): kept between turns. */
const OPENCODE_CONFIG_KEPT = new Set(["node_modules", "package.json", "bun.lock", ".gitignore"]);

/** What OpenCode reads from `~/.opencode` on every run: settings, plugins, agents, modes, tools. */
export const OPENCODE_HOME_LOADED = [
  "opencode.json",
  "opencode.jsonc",
  "plugin",
  "plugins",
  "agent",
  "agents",
  "mode",
  "modes",
  "tool",
  "tools",
] as const;

/** Empties (or makes) the config folder, keeping only `OPENCODE_CONFIG_KEPT`. */
export function resetOpencodeConfig(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (!OPENCODE_CONFIG_KEPT.has(name)) rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** What of `OPENCODE_HOME_LOADED` is in `<home>/.opencode`. */
export const opencodeHomePlanted = (home: string) =>
  OPENCODE_HOME_LOADED.filter((name) => existsSync(path.join(home, ".opencode", name)));

/** The env name an account's key reaches the `opencode` provider through. */
export const OPENCODE_KEY_ENV = "OPENCODE_API_KEY";

/** Our bridge's tools as OpenCode names them (`<server>_<tool>`). */
const BRIDGE_PREFIX = `${CODEX_MCP_SERVER}_`;

/**
 * OpenCode's permissions for a profile (ADR 0053 §3): `plan` reads only; nothing reaches outside the turn's folder.
 * Every action allows or denies (see the header); `question` is denied (nobody answers mid-turn: the agent asks in its
 * reply), and `execute` (OpenCode 2's code mode) so our bridge's tools are called by name.
 */
export function opencodePermissions(profile: CommandProfile): Record<string, string> {
  const always = { external_directory: "deny", question: "deny", execute: "deny" };
  return profile === "plan"
    ? { "*": "allow", edit: "deny", bash: "deny", task: "deny", ...always }
    : { "*": "allow", ...always };
}

/**
 * A `chat` turn's permissions (protocol 41, the team's right hand): every tool denied by `*`, ours (`<server>_<tool>`)
 * allowed. OpenCode leaves out of the model's request every tool whose last matching rule denies it, so a tool a new
 * version adds is left out too.
 */
export const OPENCODE_CHAT_PERMISSION: Record<string, string> = { "*": "deny", [`${BRIDGE_PREFIX}*`]: "allow" };

/** The turn's `OPENCODE_CONFIG_CONTENT`: the permissions, the model, the account's key, the free tier's provider. */
export function opencodeConfig(input: {
  profile: CommandProfile;
  /** A `chat` turn: `OPENCODE_CHAT_PERMISSION`. */
  chat?: boolean;
  /**
   * The turn's model: a new session's, and the one that writes its title, as OpenCode otherwise picks a small model
   * of the same provider for that (github.com/anomalyco/opencode issue 56755, 2026-10), a call on a model nobody
   * chose that a key pays for.
   */
  model?: string;
  /** The account has a key: the `opencode` provider reads it from `OPENCODE_API_KEY`. */
  key?: boolean;
  /** OpenCode's own provider alone. */
  freeTier?: boolean;
}): string {
  return JSON.stringify({
    permission: input.chat ? OPENCODE_CHAT_PERMISSION : opencodePermissions(input.profile),
    ...(input.model ? { model: input.model, small_model: input.model } : {}),
    share: "disabled",
    autoupdate: false,
    ...(input.key ? { provider: { opencode: { options: { apiKey: `{env:${OPENCODE_KEY_ENV}}` } } } } : {}),
    ...(input.freeTier ? { enabled_providers: ["opencode"] } : {}),
  });
}

/** An MCP server as ACP's `session/new` takes it: stdio, or HTTP with headers. */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

/** Our bridge for one run: `agentes-runner mcp --run <run>` with the token, socket and home in its env, or the URL. */
export function opencodeBridge(input: {
  runId: string;
  token: string;
  url?: string;
  command?: string[];
  socketPath?: string;
  runnerHome: string;
}): AcpMcpServer {
  if (input.url) {
    return {
      type: "http",
      name: CODEX_MCP_SERVER,
      url: input.url,
      headers: [{ name: "Authorization", value: `Bearer ${input.token}` }],
    };
  }
  const [command = "agentes-runner", ...args] = input.command ?? [];
  const [tokenEnv, socketEnv, homeEnv] = CODEX_MCP_ENV;
  return {
    name: CODEX_MCP_SERVER,
    command,
    args: [...args, "mcp", "--run", input.runId],
    env: [
      { name: tokenEnv, value: input.token },
      ...(input.socketPath ? [{ name: socketEnv, value: input.socketPath }] : []),
      { name: homeEnv, value: input.runnerHome },
    ],
  };
}

/** The message: a new session's leads with the engine's context. */
export const opencodePrompt = (system: string, prompt: string, newSession: boolean) =>
  newSession && system.trim() ? `${system.trim()}\n\n${prompt}` : prompt;

/**
 * Where gh finds its sign-in for the agent's commands, whose `XDG_CONFIG_HOME` is OpenCode's emptied folder: where it
 * was before (`GH_CONFIG_DIR`, the old `XDG_CONFIG_HOME`), else gh's own default (`%AppData%\GitHub CLI` on Windows).
 */
export function githubConfigDir(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const set = envValue(env, "GH_CONFIG_DIR", platform);
  if (set) return set;
  const xdg = envValue(env, "XDG_CONFIG_HOME", platform);
  if (xdg) return path.join(xdg, "gh");
  const appData = envValue(env, "APPDATA", platform);
  if (platform === "win32" && appData) return path.win32.join(appData, "GitHub CLI");
  return path.join(home, ".config", "gh");
}

const USAGE_LIMIT =
  /usage limit|rate.?limit|too many requests|\b429\b|quota|insufficient (?:balance|credits|funds)|out of (?:credits|usage)|spend(?:ing)? limit|free (?:tier|usage) (?:limit|exceeded)/i;
/** OpenCode can't authenticate (a revoked or wrong key). */
export const OPENCODE_AUTH =
  /unauthori[sz]ed|\b401\b|invalid (?:api )?key|missing api key|authentication (?:failed|required)/i;
/** OpenCode 2's names (`errorName`) for a provider's limit, and for a refused key. */
const LIMIT_ERRORS =
  /^provider\.(?:free-limit|go-limit|rate-limit|quota|budget-limit|model-budget-limit|chatgpt-limit)$/;
const AUTH_ERRORS = /^provider\.auth$/;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `opencode_failed`. */
export function opencodeProblem(problem: string, worked = false, errorName?: string): CodexBrainEvent[] {
  if ((errorName && LIMIT_ERRORS.test(errorName)) || USAGE_LIMIT.test(problem))
    return [{ type: "limit" }, { type: "error", code: "plan_limit", message: problem, worked }];
  if ((errorName && AUTH_ERRORS.test(errorName)) || OPENCODE_AUTH.test(problem))
    return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "opencode_failed", message: problem, retryable: true }];
}

/** An error's words (an ACP error's without JSON-RPC's "Internal error: " in front) and OpenCode 2's error name. */
export function acpProblem(err: unknown): { message: string; errorName?: string; auth: boolean } {
  if (!(err instanceof AcpError)) return { message: err instanceof Error ? err.message : String(err), auth: false };
  const data = isRecord(err.data) ? err.data : {};
  const errorName = str(data.errorName) || undefined;
  const message = err.message.replace(/^(?:Internal error|Invalid params):\s*/i, "") || "OpenCode refused";
  // ACP's "authentication required" (OpenCode 1.x answers a refused key with it).
  const auth = err.code === -32000 || /^auth(?:entication)? required/i.test(err.message);
  return { message, ...(errorName ? { errorName } : {}), auth };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (text: string) =>
  text.length > CODEX_TOOL_OUTPUT_MAX ? `${text.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…` : text;

/** The text of a tool call's ACP content (`[{ type: "content", content: { type: "text", text } }]`), else its raw output. */
function toolText(update: Record<string, unknown>, failed: boolean): string {
  const blocks = Array.isArray(update.content) ? update.content : [];
  const text = blocks
    .map((b) => (isRecord(b) && isRecord(b.content) && b.content.type === "text" ? str(b.content.text) : ""))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  const raw = isRecord(update.rawOutput) ? update.rawOutput : {};
  return (failed ? str(raw.error) : str(raw.output)) || (failed ? "The tool failed." : "");
}

/** One turn's `session/update`s → brain events, plus what the turn's end needs. */
export class OpencodeTurnReader {
  streamed = "";
  /** The text after the turn's last tool call: its answer (what came before was narration). */
  answer = "";
  worked = false;
  /** Tool calls started and not ended (the silence check waits while one runs). */
  readonly running = new Set<string>();
  /** Model steps begun so far: output after a tool ended, or in another message (live steering reads it). */
  steps = 0;
  /** A tool of OpenCode's own in a `chat` turn: why the turn stops. */
  breach?: string;
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private lastMessage?: string;
  private boundary = false;
  private afterTool = false;

  constructor(private readonly opts: { chat?: boolean; redact?: (text: string) => string } = {}) {}

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  private step(messageId?: string) {
    if (this.boundary || (messageId && this.lastMessage && messageId !== this.lastMessage)) {
      this.steps++;
      this.boundary = false;
    }
    if (messageId) this.lastMessage = messageId;
  }

  update(update: unknown): CodexBrainEvent[] {
    if (!isRecord(update)) return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        this.step(str(update.messageId) || undefined);
        if (content.type !== "text") return [];
        const said = this.clean(str(content.text));
        if (!said) return [];
        // Text after a tool call is a paragraph of its own.
        const lead = this.afterTool && this.streamed && !this.streamed.endsWith("\n") ? "\n\n" : "";
        this.afterTool = false;
        this.streamed += lead + said;
        this.answer += said;
        return [{ type: "text_delta", text: lead + said }];
      }
      case "agent_thought_chunk":
        this.step(str(update.messageId) || undefined);
        return [];
      case "tool_call": {
        const id = str(update.toolCallId);
        if (!id) return [];
        this.step();
        // OpenCode 2 names the tool (`name`); 1.x only in its first title (later ones describe the call).
        const name = (str(update.name) || str(update.title) || "tool").slice(0, 128);
        this.tools.set(id, { name, input: update.rawInput ?? {} });
        this.running.add(id);
        this.answer = "";
        this.afterTool = true;
        if (this.opts.chat && !name.startsWith(BRIDGE_PREFIX) && !this.breach) {
          this.breach = `OpenCode called a tool of its own (${name}), so the turn stopped.`;
        }
        return [];
      }
      case "tool_call_update": {
        const id = str(update.toolCallId);
        const tool = this.tools.get(id);
        if (!tool) return [];
        if (update.rawInput !== undefined) tool.input = update.rawInput;
        const status = str(update.status);
        if (status !== "completed" && status !== "failed") return [];
        this.running.delete(id);
        this.tools.delete(id);
        this.worked = true;
        this.boundary = true;
        // Our bridge's tools: the engine records its own calls.
        if (tool.name.startsWith(BRIDGE_PREFIX)) return [];
        const failed = status === "failed";
        return [
          {
            type: "tool_call",
            id,
            name: tool.name,
            input: redactDeep(isRecord(tool.input) ? tool.input : {}, (t) => this.clean(t)),
            executed: { content: cut(this.clean(toolText(update, failed))), ...(failed ? { isError: true } : {}) },
          },
        ];
      }
      default:
        return [];
    }
  }

  /** The prompt's `usage` as our event (every input token, cache included; thinking counts as output). */
  usage(usage: unknown, model?: string): CodexBrainEvent[] {
    if (!isRecord(usage)) return [];
    const cacheRead = num(usage.cachedReadTokens);
    const cacheWrite = num(usage.cachedWriteTokens);
    const input = num(usage.inputTokens) + cacheRead + cacheWrite;
    const output = num(usage.outputTokens) + num(usage.thoughtTokens);
    if (!input && !output) return [];
    return [
      {
        type: "usage",
        input,
        output,
        source: "plan",
        ...(model ? { model } : {}),
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
      },
    ];
  }
}

type SteerMessage = { uuid: string; text: string; urgent?: boolean };

/** A live OpenCode turn that `brain.steer` can reach, by run. */
interface LiveTurn {
  agentId: string;
  session: string;
  steer(messages: SteerMessage[]): Promise<BrainSteerReply>;
}
const liveTurns = new Map<string, LiveTurn>();

/**
 * `brain.steer` for an OpenCode turn of `runId` (the request's agent's, that session's), or null when no OpenCode turn
 * of that run runs here.
 */
export function steerOpencodeTurn(
  agentId: string,
  req: { runId: string; session: string; messages: SteerMessage[] },
): Promise<BrainSteerReply> | null {
  const live = liveTurns.get(req.runId);
  if (!live) return null;
  if (live.agentId !== agentId || live.session !== req.session) return Promise.resolve({ status: "no_turn" });
  return live.steer(req.messages);
}

export interface OpencodeTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account (its sessions are its own): its folder, and its key. */
  account?: { id: string; home: string; key?: string };
  profile?: CommandProfile;
  freeTier?: boolean;
  /** Protocol 41: the team's right hand, OpenCode's tools all off, stopped at the first one it calls anyway. */
  chat?: boolean;
  /** The turn's agent (for `brain.steer`). */
  agentId?: string;
}

export interface OpencodeTurnOptions {
  sessions: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Tests: the executable, how it starts, the system, the silence limit, and the exit grace. */
  bin?: string;
  spawn?: Spawn;
  platform?: NodeJS.Platform;
  silenceMs?: number;
  exitGraceMs?: number;
}

/** The session key: per account and folder (a resumed OpenCode session keeps the folder it started in). */
export const opencodeSessionKey = (sessionId: string, account: string | undefined, cwd: string) =>
  `${codexThreadKey(sessionId, account)}|${cwd}`;

/** The env one turn's `opencode acp` runs with (see the header). */
export function opencodeTurnEnv(input: {
  inherited: NodeJS.ProcessEnv;
  cwd: string;
  configDir: string;
  config: string;
  account?: { home: string; key?: string };
  freeTier?: boolean;
  chat?: boolean;
  platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const inherited: NodeJS.ProcessEnv = { ...input.inherited };
  const unwanted = new Set([
    "OPENCODE_PERMISSION",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
  ]);
  for (const k of Object.keys(inherited)) if (unwanted.has(k.toUpperCase())) delete inherited[k];
  const home = envValue(inherited, "HOME", platform) || envValue(inherited, "USERPROFILE", platform) || os.homedir();
  const base = input.freeTier && !input.account ? withoutSignIns(inherited) : inherited;
  const env = input.account ? accountEnv("opencode", input.account.home, base) : { ...base };
  // The agent's commands inherit XDG_CONFIG_HOME: gh keeps finding its sign-in where it was.
  env.GH_CONFIG_DIR = githubConfigDir(inherited, home, platform);
  env.XDG_CONFIG_HOME = input.configDir;
  env.OPENCODE_CONFIG_DIR = input.configDir;
  env.OPENCODE_CONFIG_CONTENT = input.config;
  if (input.account?.key) env[OPENCODE_KEY_ENV] = input.account.key;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  // Language servers would be downloaded, unpinned, into each agent's home.
  env.OPENCODE_DISABLE_LSP_DOWNLOAD = "1";
  // OpenCode reads the computer's `~/.claude/CLAUDE.md` into every session: none in a `chat` turn.
  if (input.chat) env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  // OpenCode 2 starts in `$PWD` when it is set: the turn's folder, never the runner's own.
  env.PWD = input.cwd;
  return env;
}

/** `p`, or a rejection after `ms` (the timer cleared either way). */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Whether the process has exited within `ms`. */
const goneWithin = (exited: Promise<unknown>, ms: number) =>
  within(
    exited.then(() => true),
    ms,
    "",
  ).catch(() => false);

/** An error that carries how the process ended (it closed the connection). */
type ExitError = Error & { exit?: { code: number | null; error?: Error } };

/** Runs one OpenCode turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runOpencodeTurn(input: OpencodeTurnInput, opts: OpencodeTurnOptions): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const windows = platform === "win32";
  let ended = false;
  const emit = (event: CodexBrainEvent) => {
    if (ended) return;
    if (event.type === "done" || event.type === "error") ended = true;
    opts.emit(event);
  };
  const fail = (code: string, message: string, retryable?: boolean) =>
    emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });

  const inherited: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const home = envValue(inherited, "HOME", platform) || envValue(inherited, "USERPROFILE", platform) || os.homedir();
  const planted = opencodeHomePlanted(home);
  if (planted.length) {
    return fail(
      "opencode_failed",
      `OpenCode on this computer reads ${planted.join(", ")} in ${path.join(home, ".opencode")} on every run, which could change what an agent may do. Move them out of that folder for agents to think with OpenCode.`,
    );
  }
  const configDir = opencodeConfigDir(opts.runnerHome);
  try {
    resetOpencodeConfig(configDir);
  } catch (err) {
    return fail("opencode_failed", err instanceof Error ? err.message : String(err), true);
  }
  const key = input.account?.key;
  const freeTier = Boolean(input.freeTier && !input.account);
  const env = opencodeTurnEnv({
    inherited,
    cwd: input.cwd,
    configDir,
    config: opencodeConfig({
      profile: input.profile ?? "work",
      ...(input.chat ? { chat: true } : {}),
      ...(input.model ? { model: input.model } : {}),
      key: Boolean(key),
      freeTier,
    }),
    ...(input.account ? { account: input.account } : {}),
    freeTier,
    ...(input.chat ? { chat: true } : {}),
    platform,
  });
  // The agent's shell could print the key (its env, its file in the lent folder).
  const redact = key
    ? (text: string) => redactSecrets(opts.redact ? opts.redact(text) : text, [{ name: OPENCODE_KEY_ENV, value: key }])
    : opts.redact;

  const run = cliSpawn([opts.bin ?? OPENCODE_BIN], ["acp"], envValue(env, "PATH", platform), platform);
  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(run.file, run.args, {
      cwd: input.cwd,
      env: run.env ? { ...env, ...run.env } : env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so `killTree` takes what it started along. Not on Windows: there it would open a
      // console of its own, and `taskkill /T` follows the tree anyway.
      detached: !windows,
      windowsHide: true,
      ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "opencode_missing" : "opencode_failed",
      missing ? "OpenCode's CLI is not installed on this computer." : String(err),
      true,
    );
  }

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-2000);
  });
  const reader = new OpencodeTurnReader({ ...(input.chat ? { chat: true } : {}), ...(redact ? { redact } : {}) });
  const sessionKey = opencodeSessionKey(input.sessionId, input.account?.id, input.cwd);
  /** What the turn's callbacks change as it goes. */
  const s = {
    sessionId: null as string | null,
    admitted: false,
    refusedAsk: null as string | null,
    stopping: null as "canceled" | "silence" | "breach" | null,
    killTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  /** Messages handed with `brain.steer` and not read yet, with the step they were handed at. */
  const steered: { uuids: string[]; step: number }[] = [];
  const readSteered = (all: boolean) => {
    const read = steered.filter((m) => all || reader.steps > m.step);
    if (!read.length) return;
    steered.splice(0, steered.length, ...steered.filter((m) => !read.includes(m)));
    emit({ type: "steer_read", uuids: read.flatMap((m) => m.uuids) });
  };
  // The session holds the prompt (and the context it led with) once OpenCode took it: kept for the next turn.
  const admit = () => {
    if (s.admitted || !s.sessionId) return;
    s.admitted = true;
    opts.sessions.set(sessionKey, s.sessionId);
  };

  const conn = new AcpConnection(
    child.stdin as NonNullable<ChildProcess["stdin"]>,
    child.stdout as NonNullable<ChildProcess["stdout"]>,
    {
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== s.sessionId) return;
        // A `chat` turn that met a tool of OpenCode's own says nothing more: what that tool did goes nowhere.
        if (s.stopping === "breach") return;
        admit();
        const events = reader.update(params.update);
        if (reader.breach) return stop("breach");
        for (const event of events) emit(event);
        readSteered(false);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        // Nothing of ours asks (every rule allows or denies): a rule that asks comes from another config. Refused.
        const p = isRecord(params) ? params : {};
        const call = isRecord(p.toolCall) ? p.toolCall : {};
        s.refusedAsk ??= str(call.title) || str(call.name) || "use a tool";
        const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
        const reject = options.find((o) => str(o.kind).startsWith("reject"));
        return reject
          ? { outcome: { outcome: "selected", optionId: str(reject.optionId) } }
          : { outcome: { outcome: "cancelled" } };
      },
    },
  );

  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    const proc = child as unknown as EventEmitter;
    proc.on("error", (error: Error) => resolve({ code: null, error }));
    proc.on("close", (code: number | null) => resolve({ code }));
  });
  void exited.then(({ code, error }) => {
    const why =
      error?.message ?? `OpenCode exited with code ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    const closed: ExitError = new Error(redact ? redact(why) : why);
    closed.exit = { code, ...(error ? { error } : {}) };
    conn.close(closed);
  });

  /** Asks OpenCode to stop the turn, then kills it if it doesn't. */
  function stop(why: "canceled" | "silence" | "breach") {
    if (s.stopping) return;
    s.stopping = why;
    if (s.sessionId) conn.notify("session/cancel", { sessionId: s.sessionId });
    // A tool of its own in a `chat` turn: no waiting for it to run.
    s.killTimer = setTimeout(() => killTree(child, "SIGKILL"), why === "breach" ? 0 : STOP_WAIT_MS);
  }
  const onAbort = () => stop("canceled");
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const silenceMs = opts.silenceMs ?? OPENCODE_SILENCE_MS;
  const silence = setInterval(
    () => {
      if (s.sessionId && reader.running.size === 0 && Date.now() - conn.lastHeard > silenceMs) stop("silence");
    },
    Math.min(15_000, Math.max(50, silenceMs / 4)),
  );
  const setup = <T>(p: Promise<T>) => within(p, SETUP_TIMEOUT_MS, "OpenCode took too long to start");
  /** A turn we stopped ends with why (true), whatever OpenCode answered meanwhile. */
  const stopped = () => {
    if (s.stopping === "canceled") fail("canceled", "The turn was canceled.");
    else if (s.stopping === "breach") {
      fail("tools_not_locked", reader.breach ?? "OpenCode called a tool of its own, so the turn stopped.");
    } else if (s.stopping === "silence") {
      const span =
        silenceMs >= 60_000 ? `${Math.round(silenceMs / 60_000)} minutes` : `${Math.round(silenceMs / 1000)} seconds`;
      fail(
        "opencode_failed",
        `OpenCode said nothing for ${span} with no tool running (its provider may be refusing it, as at a usage limit), so the turn stopped.`,
        true,
      );
    }
    return s.stopping !== null;
  };

  try {
    const init = await setup(
      conn.request<Record<string, unknown> | null>("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agentes-runner", version: "1" },
      }),
    );
    const caps = isRecord(init?.agentCapabilities) ? init.agentCapabilities : {};
    const sessionCaps = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
    const version = isRecord(init?.agentInfo) ? str(init.agentInfo.version) : "";
    const meta = isRecord(init?._meta) ? init._meta : {};
    const steering = isRecord(meta.steering) && meta.steering.supported === true;
    const bridge = opencodeBridge({
      runId: input.runId,
      token: input.mcp.token,
      ...(input.mcp.url ? { url: input.mcp.url } : {}),
      ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
      ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
      runnerHome: opts.runnerHome,
    });

    // A stored session is resumed; one OpenCode no longer has (or can't resume) starts over, with the context.
    const stored = opts.sessions.get(sessionKey);
    let opened: Record<string, unknown> | null = null;
    const resume = isRecord(sessionCaps.resume) ? "session/resume" : caps.loadSession === true ? "session/load" : null;
    if (stored && resume && !s.stopping) {
      // A load replays the history as updates: none of them is this turn's.
      s.sessionId = resume === "session/resume" ? stored : null;
      opened = await setup(
        conn.request<Record<string, unknown> | null>(resume, {
          sessionId: stored,
          cwd: input.cwd,
          mcpServers: [bridge],
        }),
      ).then(
        (r) => r ?? {},
        () => null,
      );
      if (opened) {
        s.sessionId = stored;
        s.admitted = true;
      } else {
        s.sessionId = null;
        opts.sessions.delete(sessionKey);
      }
    } else if (stored) opts.sessions.delete(sessionKey);
    const fresh = !opened;
    if (fresh && !s.stopping) {
      opened = await setup(
        conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridge] }),
      );
      s.sessionId = str(opened?.sessionId) || null;
      if (!s.sessionId) throw new Error("OpenCode didn't start a session");
    }
    if (input.model && s.sessionId && !s.stopping) {
      const options = Array.isArray(opened?.configOptions) ? opened.configOptions.filter(isRecord) : [];
      if (str(options.find((o) => o.id === "model")?.currentValue) !== input.model) {
        await setup(
          conn.request("session/set_config_option", { sessionId: s.sessionId, configId: "model", value: input.model }),
        ).catch((err: unknown) => {
          throw new Error(`OpenCode here doesn't offer ${input.model}: ${acpProblem(err).message}`);
        });
      }
    }

    const sessionId = s.sessionId;
    if (input.agentId && sessionId) {
      liveTurns.set(input.runId, {
        agentId: input.agentId,
        session: input.sessionId,
        steer: async (messages) => {
          if (!steering) {
            return { status: "unsupported", reason: `OpenCode ${version || "here"} reads messages only between turns` };
          }
          if (messages.some((m) => m.urgent)) {
            return { status: "unsupported", reason: "OpenCode can't take an urgent message mid-turn" };
          }
          if (s.stopping || ended || conn.closed) return { status: "no_turn" };
          const step = reader.steps;
          const reply = await conn
            .request<Record<string, unknown> | null>("_session/steering", {
              sessionId,
              prompt: messages.map((m) => ({ type: "text", text: m.text })),
            })
            .catch(() => null);
          if (reply?.outcome !== "injected") return { status: "no_turn" };
          const uuids = messages.map((m) => m.uuid);
          steered.push({ uuids, step });
          return { status: "accepted", accepted: uuids };
        },
      });
    }

    if (stopped()) return;
    const answer = await conn
      .request<Record<string, unknown> | null>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opencodePrompt(input.system, input.prompt, fresh) }],
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    liveTurns.delete(input.runId);
    if (answer.ok) {
      admit();
      for (const event of reader.usage(answer.result?.usage, input.model)) emit(event);
    }
    if (stopped()) return;
    if (!answer.ok) {
      if ((answer.error as ExitError).exit) throw answer.error;
      const problem = acpProblem(answer.error);
      if (problem.auth) return fail("not_logged_in", problem.message, true);
      for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) emit(event);
      return;
    }
    const stopReason = str(answer.result?.stopReason);
    if (stopReason === "cancelled") {
      return fail(
        "opencode_failed",
        s.refusedAsk
          ? `OpenCode asked for permission to ${s.refusedAsk}, which this agent may not do here, so the turn stopped.`
          : "OpenCode stopped the turn by itself.",
        true,
      );
    }
    const text = reader.answer || reader.streamed;
    if (stopReason === "refusal" && !text.trim()) return fail("model_refused", "The model refused to answer.");
    readSteered(true);
    emit({ type: "done", text, session: { id: input.sessionId } });
  } catch (err) {
    if (stopped()) return;
    const exit = (err as ExitError).exit;
    const missing =
      (exit?.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (windows && exit?.code === 9009);
    if (missing) return fail("opencode_missing", "OpenCode's CLI is not installed on this computer.", true);
    const problem = acpProblem(err);
    for (const event of opencodeProblem(problem.message, reader.worked, problem.errorName)) emit(event);
  } finally {
    liveTurns.delete(input.runId);
    clearInterval(silence);
    clearTimeout(s.killTimer);
    opts.signal.removeEventListener("abort", onAbort);
    conn.close();
    if (!ended) fail("opencode_failed", "OpenCode ended without an answer.", true);
    // Done: its input closed, it exits by itself; still running after the grace, it is ended with its tree. The turn
    // returns once it has gone, so nothing it started (our bridge's process among them) outlives the turn's token.
    child.stdin?.end();
    if (!(await goneWithin(exited, s.stopping === "breach" ? 0 : (opts.exitGraceMs ?? EXIT_GRACE_MS)))) {
      killTree(child, "SIGTERM");
      if (!(await goneWithin(exited, KILL_WAIT_MS))) {
        killTree(child, "SIGKILL");
        await goneWithin(exited, KILL_WAIT_MS);
      }
    }
  }
}

/** What the runner's `brain.turn` handler hands the OpenCode branch. */
export interface OpencodeBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  sessions?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: { accountDir(kind: "opencode", id: string): string | null };
  spawn?: Spawn;
}

const sessionStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "opencode"`: the turn's folder in the agent's own folder, its secrets, then the turn. */
export async function handleOpencodeBrainTurn(
  ctx: OpencodeBrainContext,
  req: OpencodeBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "OpenCode is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  if (typeof req.model === "string" && req.model && !/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(req.model)) {
    throw new RunnerError("bad_request", "model is provider/model");
  }
  const freeTier = req.freeTier === true && !req.account;
  if (freeTier && typeof req.model === "string" && req.model && !req.model.startsWith("opencode/")) {
    throw new RunnerError("bad_request", "OpenCode's free tier thinks only with OpenCode's own models");
  }
  const chat = req.permissions?.mode === "chat";
  let cwd = ctx.folder;
  // A `chat` turn starts in the agent's own folder, whatever the request names.
  if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    cwd = resolved.abs;
  }
  // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
  let account: OpencodeTurnInput["account"];
  const accountId: unknown = req.account;
  if (accountId !== undefined && accountId !== null && accountId !== "") {
    if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
    const home = ctx.accounts?.accountDir("opencode", accountId);
    if (!home) {
      scope.emit({
        type: "error",
        code: "account_missing",
        message: ACCOUNT_MISSING_MESSAGE.opencode,
        retryable: false,
      });
      return;
    }
    const key = await opencodeKeyOf(home);
    account = { id: accountId, home, ...(key ? { key } : {}) };
  }
  const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
  const file = opencodeSessionsFile(ctx.runnerHome);
  const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
  sessionStores.set(file, sessions);
  await runOpencodeTurn(
    {
      runId: req.runId,
      sessionId: req.session.id,
      cwd,
      ...(typeof req.model === "string" && req.model ? { model: req.model } : {}),
      system: typeof req.system === "string" ? req.system : "",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
      ...(account ? { account } : {}),
      profile: codexProfileOf(req),
      ...(freeTier ? { freeTier } : {}),
      ...(chat ? { chat } : {}),
      agentId: String(req.agent.id),
    },
    {
      sessions,
      emit: scope.emit,
      signal: scope.signal,
      runnerHome: ctx.runnerHome,
      ...(ctx.mcp ? { mcpCommand: ctx.mcp.command, socketPath: ctx.mcp.socketPath } : {}),
      ...(secrets ? { env: secrets.env, redact: secrets.redact } : {}),
      ...(ctx.bin ? { bin: ctx.bin } : {}),
      ...(ctx.spawn ? { spawn: ctx.spawn } : {}),
    },
  );
}
