import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandProfile } from "@agenteschat/adapters/command-policy";
import type { AgentScope, BrainEffort, BrainSpeed, CursorModelInfo } from "@agenteschat/adapters/machine-protocol";
import { isAccountId } from "@agenteschat/adapters/machine-protocol";
import { devinVariant } from "@agenteschat/providers/plans";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountFolders,
  type AccountGrant,
  accountEnv,
  accountSignIn,
  withoutSignIns,
} from "./accounts";
import { ACP_METHOD_NOT_FOUND, ACP_PROTOCOL_VERSION, AcpConnection, AcpError } from "./acp";
import { LIMIT_TEXT } from "./brain";
import {
  CODEX_TOOL_OUTPUT_MAX,
  type CodexBrainEvent,
  CodexThreads,
  chatFolder,
  codexProfileOf,
  codexThreadKey,
} from "./brain-codex";
import { opencodeBridge, opencodePrompt } from "./brain-opencode";
import { clearDevinProject, prepareDevinHome, writeDevinTurnConfig } from "./devin-home";
import { RunnerError } from "./errors";
import { killTree } from "./exec";
import { DEVIN_BIN, resolveCommand } from "./executors";
import { CODEX_MCP_SERVER, redactDeep } from "./mcp";
import { resolveForAgent } from "./paths";
import { resetFromWords } from "./plan-usage";
import type { Spawn } from "./scope-gate";
import { agentSecrets } from "./secrets";

/**
 * The Devin branch of `brain.turn` (protocol 89, ADR 0253): one agent turn as one `devin acp` process, driven through
 * `acp.ts`, with the person's own Devin plan. Shapes as Devin CLI 3000.14.30821 sent them, run against a Devin Pro
 * account on its free models (2026-11-22).
 *
 * - Always an account: its folder is the CLI's whole `HOME` (`devin-home.ts`, made ready before every turn), so its
 *   sign-in, settings and sessions are its own and nothing the computer's user set up for Devin reaches an agent.
 * - The model: a family as the agent's settings store it (`claude-opus-5-5`), run as the variant its effort and speed
 *   name (`devinVariant` over the variants the account listed, `--model <variant>` as the process starts: the CLI's
 *   `model` config option offers each family's default only). Where no account listed that family, the CLI's own
 *   match for the name runs.
 * - The session: our session → Devin's lives in `<runner home>/brain/devin-sessions.json`, per account and folder, with
 *   the variant it ran. A stored one is loaded (`session/load`, whose replayed history is skipped); a session that ran
 *   another variant, or one Devin no longer has, starts over with the engine's context leading its first prompt: a
 *   loaded session keeps the model it began with.
 * - ADR 0053 §3: every turn runs in Code mode (`accept-edits`: edits in the folder ask nothing; Ask mode would refuse
 *   our server's tools) with its own settings file (`--config`, `devinTurnRules`): our server's tools never ask, a
 *   `plan` turn's edits and commands are refused by the CLI. Every other permission it asks comes to the runner
 *   (`devinPermission`): in `work` commands and the files of the turn's folder, the agent's folder, its allowed folders
 *   and the temp folder; anything else is refused.
 * - `chat` (the team's right hand, ADR 0137 §4): in an empty folder with none of the agent's secrets, every tool of the
 *   CLI's own refused by its rules, and stopped when one of them runs anyway (`devinChatBreach`).
 * - Events: `agent_message_chunk` streams the text; a tool of the CLI's own, once it ended, is an executed `tool_call`
 *   (our server's are left out: the engine ran them); the prompt's answer carries the tokens (`source: "plan"`).
 * - No live steering: `brain.steer` answers `unsupported`.
 */

/** After asking the CLI to stop, how long the turn waits for it before the process is killed. */
const STOP_WAIT_MS = 8000;
/** After the turn, how long the process may take to exit by itself (its input closed) before it is killed. */
const EXIT_GRACE_MS = 3000;
/** How long a process told to end has to go before the turn stops waiting for it. */
const KILL_WAIT_MS = 2000;
/** How long each step of starting (initialize, the session, its mode) may take. */
const SETUP_TIMEOUT_MS = 120_000;
/** A turn that hears nothing from the CLI this long, with no tool running, stops. */
export const DEVIN_SILENCE_MS = 5 * 60_000;

/** `brain.turn` with `kind: "devin"`. */
export interface DevinBrainTurnRequest {
  runId: string;
  kind: "devin";
  session: { id: string; resume: boolean };
  cwd?: string;
  model?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string; tools?: string };
  agent?: AgentScope;
  account?: string;
  effort?: BrainEffort;
  speed?: BrainSpeed;
  permissions?: { mode?: "plan" | "work" | "chat" };
  keepAlive?: boolean;
}

/** Where our session → Devin session ids live in the runner home. */
export const devinSessionsFile = (runnerHome: string) => path.join(runnerHome, "brain", "devin-sessions.json");

/** The session key: per account and folder (a loaded session keeps the folder it began in). */
export const devinSessionKey = (sessionId: string, account: string, cwd: string) =>
  `${codexThreadKey(sessionId, account)}|${cwd}`;

/** What is stored for a session: Devin's id and the variant it ran. */
const storedOf = (v: string | undefined) => {
  const at = v?.indexOf("#") ?? -1;
  return v && at > 0 ? { id: v.slice(0, at), variant: v.slice(at + 1) } : v ? { id: v, variant: "" } : null;
};

/** Our server's tools as the CLI names them (`mcp__agenteschat_agentes__post_message`). */
const OURS = `mcp__${CODEX_MCP_SERVER}__`;

/** A tool of our server (or the CLI listing our server's tools), by the name and input the CLI gave it. */
export function isOurDevinTool(name: string, input?: unknown): boolean {
  if (name.startsWith(OURS)) return true;
  const server = input && typeof input === "object" ? (input as Record<string, unknown>).server_name : undefined;
  return (name === "mcp_list_tools" || name === "mcp_list_resources") && server === CODEX_MCP_SERVER;
}

/**
 * The variant a turn runs: of the family's listed variants, the one its effort and speed name; the name as it is where
 * the accounts listed no such family (the CLI's own match runs).
 */
export function devinTurnModel(
  model: string | undefined,
  listed: readonly CursorModelInfo[] | undefined,
  effort?: BrainEffort,
  fast = false,
): string | undefined {
  if (!model) return undefined;
  const family = listed?.find((m) => m.id === model);
  return (family?.variants && devinVariant(family.variants, effort, fast)) || model;
}

/**
 * The CLI's mode: always Code (`accept-edits`). Its Ask mode refuses every MCP tool that isn't marked read only, our
 * server's included, so a `plan` or `chat` turn holds its own tools back with rules instead (`devinTurnRules`).
 */
export const devinMode = (_profile: CommandProfile, _chat: boolean) => "accept-edits";

/** The CLI's own tools as its permission rules name them, and its web reach. */
const DEVIN_OWN_TOOLS = ["read", "edit", "grep", "glob", "exec", "web_search", "webfetch"];
const DEVIN_WEB = ["Fetch(https://*)", "Fetch(http://*)"];

/**
 * A turn's permission rules (its `--config`): our server's tools never ask; a `plan` turn's edits and commands are
 * refused by the CLI itself; a `chat` turn's every tool of the CLI's own (and its subagents) too, so the model is left
 * with ours. A deny refuses the call, it doesn't hide the tool: what still runs is the runner's to stop.
 */
export function devinTurnRules(
  profile: CommandProfile,
  chat: boolean,
): { permissions: { allow: string[]; deny: string[]; ask: string[] }; subagents?: false } {
  const allow = [`${OURS}*`];
  if (chat) return { permissions: { allow, deny: [...DEVIN_OWN_TOOLS, ...DEVIN_WEB], ask: [] }, subagents: false };
  if (profile === "plan") return { permissions: { allow, deny: ["edit", "exec", "Write(/**)"], ask: [] } };
  return { permissions: { allow, deny: [], ask: [] } };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cut = (text: string) =>
  text.length > CODEX_TOOL_OUTPUT_MAX ? `${text.slice(0, CODEX_TOOL_OUTPUT_MAX)}\n…` : text;

/** Whether `p` is `root` or inside it. */
const within = (root: string, p: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * The runner's answer to one of the CLI's requests for permission (`session/request_permission`), by the rule it names
 * (`_meta["cognition.ai/permissionRule"]`: `mcp__<server>__<tool>`, `Write(/tmp)`, `Read(…)`, `Exec(…)`): `allow` or
 * `reject`. `roots`: the folders a `work` turn may write and read.
 */
export function devinPermission(
  rule: string,
  o: { profile: CommandProfile; chat: boolean; roots: readonly string[] },
): "allow" | "reject" {
  if (rule.startsWith(OURS)) return "allow";
  if (o.chat) return "reject";
  const m = /^(\w+)\((.*)\)$/s.exec(rule);
  const verb = m?.[1] ?? "";
  const target = (m?.[2] ?? "").trim();
  const pathIn = target.replace(/\/\*\*?$|\/$/, "");
  if (verb === "Read" && pathIn && path.isAbsolute(pathIn) && o.roots.some((r) => within(r, pathIn))) return "allow";
  if (o.profile !== "work") return "reject";
  if (verb === "Exec") return "allow";
  if ((verb === "Write" || verb === "Edit" || verb === "Read") && pathIn && path.isAbsolute(pathIn)) {
    return o.roots.some((r) => within(r, pathIn)) ? "allow" : "reject";
  }
  return "reject";
}

/**
 * What a `chat` turn's context adds: the CLI offers the model its own tools even where its rules refuse them, and a
 * model refused its own web search gives up rather than look for ours, so it is told which to use.
 */
export const DEVIN_CHAT_NOTE = `Your own tools (files, shell, web search and fetch) are turned off here. Use the ${CODEX_MCP_SERVER} MCP server's tools instead: mcp__${CODEX_MCP_SERVER}__web_search and mcp__${CODEX_MCP_SERVER}__web_fetch for the web, and its other tools for everything else.`;

/** A `chat` turn's guard: a tool that isn't our server's and ran (the CLI's rules refused it not) stops it. */
export function devinChatBreach(name: string, input: unknown): string | null {
  return isOurDevinTool(name, input)
    ? null
    : `The Devin CLI used a tool of its own (${name.slice(0, 64)}), so the turn stopped.`;
}

const DEVIN_LIMIT =
  /quota|rate.?limit|usage limit|too many requests|\b429\b|out of (?:credits|usage|acus?)|insufficient (?:credits|acus?)|daily limit|weekly limit|limit reached|exceeded/i;
/** The CLI can't think for the account (signed out, a refused token). */
export const DEVIN_AUTH =
  /not logged in|log ?in required|auth(?:entication)? required|unauthenticated|unauthori[sz]ed|\b401\b|invalid (?:api )?(?:key|token|credentials)|run `devin auth login`/i;

/** How a turn that went wrong ends: `limit` then `plan_limit`, `not_logged_in`, or `devin_failed`. */
export function devinProblem(problem: string, worked = false, now?: number): CodexBrainEvent[] {
  if (DEVIN_LIMIT.test(problem) || LIMIT_TEXT.test(problem)) {
    const resetsAt = resetFromWords(problem, now);
    return [
      { type: "limit", ...(resetsAt ? { resetsAt } : {}) },
      { type: "error", code: "plan_limit", message: problem, retryable: true, worked },
    ];
  }
  if (DEVIN_AUTH.test(problem)) return [{ type: "error", code: "not_logged_in", message: problem, retryable: true }];
  return [{ type: "error", code: "devin_failed", message: problem, retryable: true }];
}

/** An ACP error's words without JSON-RPC's prefix, with its data when it says more. */
function problemOf(err: unknown): string {
  if (!(err instanceof AcpError)) return err instanceof Error ? err.message : String(err);
  const data = typeof err.data === "string" ? err.data : isRecord(err.data) ? str(err.data.message) : "";
  const message = err.message.replace(/^(?:Internal error|Invalid params):\s*/i, "") || "The Devin CLI refused";
  return data && !message.includes(data) ? `${message}: ${data}` : message;
}

/** The name the CLI gave a call (`cognition.ai/toolName`, else the one inference called); "" when it gave none. */
function cliToolNameOf(update: Record<string, unknown>): string {
  const meta = isRecord(update._meta) ? update._meta : {};
  return (str(meta["cognition.ai/toolName"]) || str(meta["cognition.ai/inferenceToolName"])).slice(0, 128);
}

/** A tool call's name: the CLI's own, else its title. */
const toolNameOf = (update: Record<string, unknown>) =>
  cliToolNameOf(update) || str(update.title).slice(0, 128) || "tool";

/** The text of a tool call's ACP content, else its raw output. */
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
export class DevinTurnReader {
  streamed = "";
  /** The text after the turn's last tool call: its answer (what came before was narration). */
  answer = "";
  worked = false;
  /** Tool calls started and not ended (the silence check waits while one runs). */
  readonly running = new Set<string>();
  /** A tool of the CLI's own in a `chat` turn: why the turn stops. */
  breach?: string;
  /** `cliName`: what decides whether a call is our server's (never its title, which can carry the model's words). */
  private readonly tools = new Map<string, { name: string; cliName: string; input: unknown; output?: string }>();
  private afterTool = false;

  constructor(private readonly opts: { chat?: boolean; redact?: (text: string) => string } = {}) {}

  private clean(text: string) {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  update(update: unknown): CodexBrainEvent[] {
    if (!isRecord(update)) return [];
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = isRecord(update.content) ? update.content : {};
        if (content.type !== "text") return [];
        const said = this.clean(str(content.text));
        if (!said) return [];
        const lead = this.afterTool && this.streamed && !this.streamed.endsWith("\n") ? "\n\n" : "";
        this.afterTool = false;
        this.streamed += lead + said;
        this.answer += said;
        return [{ type: "text_delta", text: lead + said }];
      }
      case "tool_call": {
        const id = str(update.toolCallId);
        if (!id) return [];
        const input = update.rawInput ?? {};
        this.tools.set(id, { name: toolNameOf(update), cliName: cliToolNameOf(update), input });
        this.running.add(id);
        this.answer = "";
        this.afterTool = true;
        // ACP lets a call arrive already ended, with no update after it.
        const status = str(update.status);
        return status === "completed" || status === "failed"
          ? this.update({ ...update, sessionUpdate: "tool_call_update" })
          : [];
      }
      case "tool_call_update": {
        const id = str(update.toolCallId);
        const tool = this.tools.get(id);
        if (!tool) return [];
        if (update.rawInput !== undefined) tool.input = update.rawInput;
        const status = str(update.status);
        const failed = status === "failed";
        // The CLI sends a call's output while it runs, and its last update may carry none.
        const said = toolText(update, false);
        if (said) tool.output = said;
        if (status !== "completed" && !failed) return [];
        this.running.delete(id);
        this.tools.delete(id);
        if (isOurDevinTool(tool.cliName, tool.input)) {
          this.worked = true;
          return [];
        }
        // A `chat` turn: one its rules refused did nothing; one that ran stops the turn, and says nothing of it.
        if (this.opts.chat) {
          if (!failed && !this.breach) this.breach = devinChatBreach(tool.cliName || "tool", tool.input) ?? undefined;
          return [];
        }
        this.worked = true;
        return [
          {
            type: "tool_call",
            id,
            name: tool.name,
            input: redactDeep(isRecord(tool.input) ? tool.input : {}, (t) => this.clean(t)),
            executed: {
              content: cut(this.clean(failed ? toolText(update, true) : (tool.output ?? ""))),
              ...(failed ? { isError: true } : {}),
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  /** The prompt's `usage` as our event (every input token, cache included). */
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

export interface DevinTurnInput {
  runId: string;
  sessionId: string;
  cwd: string;
  /** The model family as stored; `variant`, what runs. */
  model?: string;
  variant?: string;
  system: string;
  prompt: string;
  mcp: { token: string; url?: string };
  /** The account: its folder is the CLI's `HOME`, its sessions are its own. */
  account: { id: string; home: string };
  profile?: CommandProfile;
  /** The team's right hand (`cwd` its empty `chatFolder`): stopped at a tool of the CLI's own. */
  chat?: boolean;
  /** The folders a `work` turn may write and read besides `cwd` (the agent's own, its allowed ones). */
  roots?: string[];
}

export interface DevinTurnOptions {
  sessions: CodexThreads;
  emit: (event: CodexBrainEvent) => void;
  signal: AbortSignal;
  mcpCommand?: string[];
  socketPath?: string;
  runnerHome: string;
  env?: Record<string, string>;
  redact?: (text: string) => string;
  /** Tests: the executable, how it starts, the silence limit, the exit grace and the clock. */
  bin?: string;
  spawn?: Spawn;
  silenceMs?: number;
  exitGraceMs?: number;
  now?: () => number;
}

/** `p`, or a rejection after `ms` (the timer cleared either way). */
function inTime<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
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
  inTime(
    exited.then(() => true),
    ms,
    "",
  ).catch(() => false);

/** An error that carries how the process ended (it closed the connection). */
type ExitError = Error & { exit?: { code: number | null; error?: Error } };

/** Runs one Devin turn and emits its events; ends with exactly one `done` or `error`. Never throws. */
export async function runDevinTurn(input: DevinTurnInput, opts: DevinTurnOptions): Promise<void> {
  let ended = false;
  const emit = (event: CodexBrainEvent) => {
    if (ended) return;
    if (event.type === "done" || event.type === "error") ended = true;
    opts.emit(event);
  };
  const fail = (code: string, message: string, retryable?: boolean) =>
    emit({ type: "error", code, message, ...(retryable ? { retryable } : {}) });
  try {
    prepareDevinHome(input.account.home);
  } catch (err) {
    return fail("devin_failed", `Couldn't set up the Devin CLI for the agent: ${(err as Error).message}`, true);
  }
  const chat = input.chat === true;
  const profile = input.profile ?? "work";
  const base: NodeJS.ProcessEnv = { ...(chat ? withoutSignIns(process.env) : process.env), ...(opts.env ?? {}) };
  const env = accountEnv("devin", input.account.home, base);
  env.PWD = input.cwd;
  const redact = opts.redact;
  const variant = input.variant ?? input.model;
  // The turn's own settings: the account's, with its profile's rules.
  const turnConfig = path.join(opts.runnerHome, "brain", "devin-turns", `${input.runId}.json`);
  try {
    writeDevinTurnConfig(turnConfig, input.account.home, devinTurnRules(profile, chat));
  } catch (err) {
    return fail("devin_failed", `Couldn't set up the Devin CLI for the agent: ${(err as Error).message}`, true);
  }
  const args = [
    "--config",
    turnConfig,
    "acp",
    "--process-model",
    "in-process",
    ...(variant ? ["--model", variant] : []),
  ];
  let child: ChildProcess;
  try {
    child = (opts.spawn ?? spawn)(resolveCommand(opts.bin ?? DEVIN_BIN, env.PATH), args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return fail(
      missing ? "devin_missing" : "devin_failed",
      missing ? "The Devin CLI, Cognition's, is not installed on this computer." : String(err),
      true,
    );
  }

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-4000);
  });
  const reader = new DevinTurnReader({ ...(chat ? { chat: true } : {}), ...(redact ? { redact } : {}) });
  const sessionKey = devinSessionKey(input.sessionId, input.account.id, input.cwd);
  const roots = [input.cwd, ...(input.roots ?? []), tmpdir()];
  const s = {
    sessionId: null as string | null,
    admitted: false,
    refused: null as string | null,
    stopping: null as "canceled" | "silence" | "breach" | null,
    killTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  };
  const admit = () => {
    if (s.admitted || !s.sessionId) return;
    s.admitted = true;
    opts.sessions.set(sessionKey, `${s.sessionId}#${variant ?? ""}`);
  };

  const conn = new AcpConnection(
    child.stdin as NonNullable<ChildProcess["stdin"]>,
    child.stdout as NonNullable<ChildProcess["stdout"]>,
    {
      onNotification(method, params) {
        if (method !== "session/update" || !isRecord(params) || params.sessionId !== s.sessionId) return;
        if (s.stopping === "breach") return;
        admit();
        const events = reader.update(params.update);
        if (reader.breach) return stop("breach");
        for (const event of events) emit(event);
      },
      onRequest(method, params) {
        if (method !== "session/request_permission") {
          throw new AcpError(ACP_METHOD_NOT_FOUND, `Method not found: ${method}`);
        }
        const p = isRecord(params) ? params : {};
        const call = isRecord(p.toolCall) ? p.toolCall : {};
        const meta = isRecord(call._meta) ? call._meta : {};
        const rule = str(meta["cognition.ai/permissionRule"]);
        const options = Array.isArray(p.options) ? p.options.filter(isRecord) : [];
        const answer = devinPermission(rule, { profile, chat, roots });
        const pick =
          answer === "allow"
            ? options.find((o) => o.kind === "allow_once")
            : options.find((o) => str(o.kind).startsWith("reject"));
        if (answer === "reject") s.refused ??= rule || "use a tool";
        return pick
          ? { outcome: { outcome: "selected", optionId: str(pick.optionId) } }
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
    const said = stderr
      .split("\n")
      .filter((l) => /\b(?:ERROR|Error:)/.test(l))
      .slice(-3)
      .join("\n")
      .trim();
    const why = error?.message ?? `The Devin CLI exited with code ${code ?? "?"}${said ? `: ${said}` : ""}`;
    const closed: ExitError = new Error(redact ? redact(why) : why);
    closed.exit = { code, ...(error ? { error } : {}) };
    conn.close(closed);
  });

  function stop(why: "canceled" | "silence" | "breach") {
    if (s.stopping) return;
    s.stopping = why;
    if (s.sessionId) conn.notify("session/cancel", { sessionId: s.sessionId });
    s.killTimer = setTimeout(() => killTree(child, "SIGKILL"), why === "breach" ? 0 : STOP_WAIT_MS);
  }
  const onAbort = () => stop("canceled");
  if (opts.signal.aborted) onAbort();
  else opts.signal.addEventListener("abort", onAbort, { once: true });
  const silenceMs = opts.silenceMs ?? DEVIN_SILENCE_MS;
  const silence = setInterval(
    () => {
      if (s.sessionId && reader.running.size === 0 && Date.now() - conn.lastHeard > silenceMs) stop("silence");
    },
    Math.min(15_000, Math.max(50, silenceMs / 4)),
  );
  const setup = <T>(p: Promise<T>) => inTime(p, SETUP_TIMEOUT_MS, "The Devin CLI took too long to start");
  const stopped = () => {
    if (s.stopping === "canceled") fail("canceled", "The turn was canceled.");
    else if (s.stopping === "breach") {
      fail("tools_not_locked", reader.breach ?? "The Devin CLI used a tool of its own, so the turn stopped.");
    } else if (s.stopping === "silence") {
      fail(
        "devin_failed",
        `The Devin CLI said nothing for ${Math.round(silenceMs / 60_000) || 1} minutes with no tool running, so the turn stopped.`,
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
    const bridge = opencodeBridge({
      runId: input.runId,
      token: input.mcp.token,
      ...(input.mcp.url ? { url: input.mcp.url } : {}),
      ...(opts.mcpCommand ? { command: opts.mcpCommand } : {}),
      ...(opts.socketPath ? { socketPath: opts.socketPath } : {}),
      runnerHome: opts.runnerHome,
    });

    // A stored session that ran this variant is loaded; any other starts over, with the context.
    const stored = storedOf(opts.sessions.get(sessionKey));
    let opened: Record<string, unknown> | null = null;
    if (stored && stored.variant === (variant ?? "") && caps.loadSession === true && !s.stopping) {
      // The load replays the history as updates: none of them is this turn's.
      opened = await setup(
        conn.request<Record<string, unknown> | null>("session/load", {
          sessionId: stored.id,
          cwd: input.cwd,
          mcpServers: [bridge],
        }),
      ).then(
        (r) => r ?? {},
        () => null,
      );
      if (opened) {
        s.sessionId = stored.id;
        s.admitted = true;
      }
    }
    if (stored && !opened) opts.sessions.delete(sessionKey);
    const fresh = !opened;
    if (fresh && !s.stopping) {
      opened = await setup(
        conn.request<Record<string, unknown> | null>("session/new", { cwd: input.cwd, mcpServers: [bridge] }),
      );
      s.sessionId = str(opened?.sessionId) || null;
      if (!s.sessionId) throw new Error("The Devin CLI didn't start a session");
    }
    const mode = devinMode(profile, chat);
    if (s.sessionId && !s.stopping) {
      const options = Array.isArray(opened?.configOptions) ? opened.configOptions.filter(isRecord) : [];
      if (str(options.find((o) => o.id === "mode")?.currentValue) !== mode) {
        await setup(
          conn.request("session/set_config_option", { sessionId: s.sessionId, configId: "mode", value: mode }),
        ).catch((err: unknown) => {
          throw new Error(`The Devin CLI couldn't switch to its ${mode} mode: ${problemOf(err)}`);
        });
      }
    }

    if (stopped()) return;
    const answer = await conn
      .request<Record<string, unknown> | null>("session/prompt", {
        sessionId: s.sessionId,
        prompt: [
          {
            type: "text",
            // A `chat` turn's note leads every prompt: a loaded session may predate it.
            text: chat
              ? `${DEVIN_CHAT_NOTE}\n\n${opencodePrompt(input.system, input.prompt, fresh)}`
              : opencodePrompt(input.system, input.prompt, fresh),
          },
        ],
      })
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    if (answer.ok) {
      admit();
      for (const event of reader.usage(answer.result?.usage, input.model)) emit(event);
    }
    if (stopped()) return;
    if (!answer.ok) {
      if ((answer.error as ExitError).exit) throw answer.error;
      const said = problemOf(answer.error);
      for (const event of devinProblem(redact ? redact(said) : said, reader.worked, opts.now?.())) emit(event);
      return;
    }
    const stopReason = str(answer.result?.stopReason);
    const text = reader.answer || reader.streamed;
    if (stopReason === "cancelled") {
      // The rule can be a whole command line, and so carry a secret.
      const asked = s.refused ? (redact ? redact(s.refused) : s.refused).slice(0, 120) : "";
      return fail(
        "devin_failed",
        asked
          ? `The Devin CLI asked for permission (${asked}), which this agent may not do here, so the turn stopped.`
          : "The Devin CLI stopped the turn by itself.",
        true,
      );
    }
    if (stopReason === "refusal" && !text.trim()) return fail("model_refused", "The model refused to answer.");
    emit({ type: "done", text, session: { id: input.sessionId } });
  } catch (err) {
    if (stopped()) return;
    const exit = (err as ExitError).exit;
    if ((exit?.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return fail("devin_missing", "The Devin CLI, Cognition's, is not installed on this computer.", true);
    }
    const said = problemOf(err);
    for (const event of devinProblem(redact ? redact(said) : said, reader.worked, opts.now?.())) emit(event);
  } finally {
    clearInterval(silence);
    rmSync(turnConfig, { force: true });
    clearTimeout(s.killTimer);
    opts.signal.removeEventListener("abort", onAbort);
    conn.close();
    if (!ended) fail("devin_failed", "The Devin CLI ended without an answer.", true);
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

/** What the runner's `brain.turn` handler hands the Devin branch. */
export interface DevinBrainContext {
  folder: string;
  exec: boolean;
  runnerHome: string;
  secretsDir?: string;
  mcp?: { socketPath: string; command: string[] };
  sessions?: CodexThreads;
  bin?: string;
  grants?: string[];
  accounts?: AccountFolders;
  /** In a worker, what root handed over for the account (`AccountManager.grant`). */
  grant?: AccountGrant;
  /** The model families the accounts here listed, with their variants (`AccountManager.listedModels`). */
  listed?: () => CursorModelInfo[] | undefined;
  spawn?: Spawn;
}

const sessionStores = new Map<string, CodexThreads>();

/** `brain.turn` with `kind: "devin"`: the turn's folder in the agent's own folder, its account and secrets, the turn. */
export async function handleDevinBrainTurn(
  ctx: DevinBrainContext,
  req: DevinBrainTurnRequest,
  scope: { signal: AbortSignal; emit: (event: CodexBrainEvent) => void },
): Promise<void> {
  if (!ctx.exec) throw new RunnerError("not_allowed", "The Devin CLI is turned off on this computer");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  if (typeof req.runId !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.runId)) {
    throw new RunnerError("bad_request", "runId is invalid");
  }
  if (typeof req.session?.id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(req.session.id)) {
    throw new RunnerError("bad_request", "session.id is invalid");
  }
  if (typeof req.mcp?.token !== "string" || !req.mcp.token)
    throw new RunnerError("bad_request", "mcp.token is required");
  if (typeof req.model === "string" && req.model && !/^[\w.:-]{1,80}$/.test(req.model)) {
    throw new RunnerError("bad_request", "model is a Devin model's name");
  }
  // ADR 0041: the account's folder or nothing (the computer's own sign-in would bring its user's MCP servers).
  const accountId: unknown = req.account;
  if (accountId === undefined || accountId === null || accountId === "") {
    scope.emit({
      type: "error",
      code: "not_logged_in",
      message: "Devin thinks only with a Devin account connected for the agent. Connect one on the agent's page.",
      retryable: false,
    });
    return;
  }
  if (!isAccountId(accountId)) throw new RunnerError("bad_request", "Invalid account id");
  let signIn: Awaited<ReturnType<typeof accountSignIn>>;
  try {
    signIn = await accountSignIn(ctx.accounts, "devin", accountId, ctx.grant);
  } catch (err) {
    scope.emit({
      type: "error",
      code: "devin_failed",
      message: `This computer couldn't hand the agent its Devin sign-in (${(err as Error).message}). Try again.`,
      retryable: true,
    });
    return;
  }
  if (signIn === "signed_out") {
    scope.emit({ type: "error", code: "not_logged_in", message: ACCOUNT_SIGNED_OUT, retryable: true });
    return;
  }
  if (signIn === "missing") {
    scope.emit({ type: "error", code: "account_missing", message: ACCOUNT_MISSING_MESSAGE.devin, retryable: false });
    return;
  }
  try {
    const chat = req.permissions?.mode === "chat";
    const folder = chat ? chatFolder(ctx.runnerHome, String(req.agent.id)) : ctx.folder;
    if (!chat) clearDevinProject(folder);
    let cwd = folder;
    if (!chat && typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveForAgent(folder, ctx.grants, req.cwd);
      if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
      cwd = resolved.abs;
    }
    const secrets = chat ? null : await agentSecrets(ctx.secretsDir, req.agent);
    const file = devinSessionsFile(ctx.runnerHome);
    const sessions = ctx.sessions ?? sessionStores.get(file) ?? new CodexThreads(file);
    sessionStores.set(file, sessions);
    const model = typeof req.model === "string" && req.model ? req.model : undefined;
    const variant = devinTurnModel(model, ctx.listed?.(), req.effort, req.speed === "fast");
    await runDevinTurn(
      {
        runId: req.runId,
        sessionId: req.session.id,
        cwd,
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
        system: typeof req.system === "string" ? req.system : "",
        prompt: typeof req.prompt === "string" ? req.prompt : "",
        mcp: { token: req.mcp.token, ...(typeof req.mcp.url === "string" && req.mcp.url ? { url: req.mcp.url } : {}) },
        account: { id: accountId, home: signIn.home },
        profile: codexProfileOf(req),
        ...(chat ? { chat } : {}),
        roots: chat ? [] : [folder, ...(ctx.grants ?? [])],
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
  } finally {
    signIn.release?.();
  }
}
