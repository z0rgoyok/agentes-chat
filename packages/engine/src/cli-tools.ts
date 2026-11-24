import { BRAIN_LIMITS, PERMISSION_TOOL } from "@agenteschat/adapters";
import { cutMarked, cutText, isJsonObject } from "./format";
import { redactCredentials } from "./tool-detail";

/**
 * A computer brain's own tool calls (ADR 0215: Claude Code's Read, Grep, Edit, Bash…, Codex's commands and file
 * changes, the other CLIs' alike) as the quiet lines a terminal shows: what it did (`verb`), on what (`target`: a file
 * relative to the folder it works in, a pattern, a command, an address) and what it came to (`meta`), read from the
 * call's input and its result as the runner forwards them (`tool_call` with `executed`). Pure: the executor keeps each
 * one on the run's trail (a `context` step with `cliTool`) and says it live (`agent.step`).
 */

export const CLI_VERBS = [
  "read",
  "search",
  "edit",
  "write",
  "run",
  "fetch",
  "delegate",
  "skill",
  "workflow",
  "other",
] as const;
export type CliVerb = (typeof CLI_VERBS)[number];

/** What a call came to, as counts the apps put in words ("+2 −1", "3 places", "15 passed", "exit 1"). */
export interface CliToolMeta {
  /** Lines an edit or a write added and removed (a write removes none it can tell). */
  added?: number;
  removed?: number;
  /** Places a search found (files or matches, as the tool counted them). */
  found?: number;
  /** Files one change touched, when more than one (Codex's file changes). */
  files?: number;
  /** Tests a command ran, from the test runner's own summary. */
  passed?: number;
  failed?: number;
  /** A failed command's exit code. */
  exit?: number;
}

export interface CliToolSummary {
  verb: CliVerb;
  target?: string;
  /** `other`: what it was for (a subagent's description, the plan's item at work, a picture's prompt). */
  about?: string;
  meta?: CliToolMeta;
}

/** One call on the run's trail (`context` step `cliTool`): its summary, how it went and what it gave back. */
export interface CliToolStep extends CliToolSummary {
  id: string;
  name: string;
  ok: boolean;
  /** The start of its result (an edit's or a write's: the lines it changed), masked. */
  output?: string;
  /** From its start (`tool_started`) to its end, when the brain told both. */
  ms?: number;
}

/** How much of a call's result its step keeps. */
export const CLI_OUTPUT_MAX = 1500;
const TARGET_MAX = 300;
const ABOUT_MAX = 120;

/** The CLIs' own tool names (lower-cased) by what they do: Claude Code's, Codex's, then the other CLIs'. */
const VERBS: Record<string, CliVerb> = {
  // A subagent of its own (`Agent`, `Task` before Claude Code 2.1.63), a skill and a workflow of subagents (ADR 0215).
  agent: "delegate",
  task: "delegate",
  skill: "skill",
  workflow: "workflow",
  read: "read",
  notebookread: "read",
  ls: "read",
  grep: "search",
  glob: "search",
  websearch: "search",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  write: "write",
  bash: "run",
  powershell: "run",
  webfetch: "fetch",
  shell: "run",
  local_shell: "run",
  exec_command: "run",
  apply_patch: "edit",
  read_file: "read",
  view: "read",
  list: "read",
  list_dir: "read",
  list_files: "read",
  grep_search: "search",
  file_search: "search",
  codebase_search: "search",
  search: "search",
  web_search: "search",
  edit_file: "edit",
  search_replace: "edit",
  str_replace: "edit",
  patch: "edit",
  delete: "edit",
  write_file: "write",
  create_file: "write",
  run_terminal_cmd: "run",
  run_terminal_command: "run",
  run_command: "run",
  fetch: "fetch",
  web_fetch: "fetch",
};

/** Its own calls that are no line of its work: looking our deferred tools up, the computer's own permission check. */
const UNSHOWN = new Set(["toolsearch", PERMISSION_TOOL]);

/** Whether a call of the brain's own is a line of its work (ADR 0215). */
export const cliToolShown = (name: string) => name.trim() !== "" && !UNSHOWN.has(name.trim().toLowerCase());

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * A call's input, also one the runner cut (`{ truncated: <the start of its JSON> }`, a write of a long file): the
 * whole text fields that start holds, so its path or command still reads.
 */
function inputOf(input: unknown): Record<string, unknown> {
  if (!isJsonObject(input)) return {};
  if (typeof input.truncated !== "string" || Object.keys(input).length !== 1) return input;
  const fields: Record<string, unknown> = {};
  for (const m of input.truncated.matchAll(/"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = m[1] ?? "";
    if (!key || Object.hasOwn(fields, key)) continue;
    try {
      fields[key] = JSON.parse(`"${m[2] ?? ""}"`);
    } catch {
      // Not a whole JSON string: left out.
    }
  }
  return fields;
}

/** The first of `keys` the input holds as text (a command given as its words, joined). */
function first(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const v = input[key];
    const text = Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(" ") : str(v);
    if (text.trim()) return text.trim();
  }
  return "";
}

const PATH_KEYS = [
  "file_path",
  "notebook_path",
  "filePath",
  "target_file",
  "path",
  "file",
  "target_directory",
  "relative_workspace_path",
  "directory",
] as const;
const PATTERN_KEYS = ["pattern", "query", "regex", "search_term", "glob_pattern", "glob"] as const;
const COMMAND_KEYS = ["command", "cmd"] as const;
const URL_KEYS = ["url", "uri"] as const;
const ABOUT_KEYS = ["description", "subject", "prompt", "skill"] as const;
/** What a subagent was asked to do: its short description, else its prompt. */
const DELEGATE_KEYS = ["description", "prompt"] as const;
/** Which skill it used. */
const SKILL_KEYS = ["skill", "name", "command"] as const;
/** A workflow named by its caller; else the script's own `meta` says what it does. */
const WORKFLOW_KEYS = ["name", "description"] as const;
const WORKFLOW_META = (key: "description" | "name") => new RegExp(`\\b${key}\\s*:\\s*(["'\`])([^"'\`\\n]{1,200})\\1`);

/** A JSON text's escapes undone (`\n`, `\"`, `ó`…), for a string the runner cut before its end. */
const unescaped = (text: string) =>
  text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) =>
    c.length === 5 ? String.fromCharCode(Number.parseInt(c.slice(1), 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c,
  );

/**
 * What a workflow does: its name, else its script's `meta` description or name, else its script's file. A script
 * longer than the runner forwards whole comes cut (`{ truncated }`), its `meta` at its start all the same.
 */
function workflowAbout(i: Record<string, unknown>, raw: unknown): string {
  const named = first(i, WORKFLOW_KEYS);
  if (named) return named;
  const cut = isJsonObject(raw) && typeof raw.truncated === "string" ? unescaped(raw.truncated) : "";
  const script = typeof i.script === "string" ? i.script : cut;
  const meta = WORKFLOW_META("description").exec(script)?.[2] ?? WORKFLOW_META("name").exec(script)?.[2];
  if (meta) return meta;
  return typeof i.scriptPath === "string" ? i.scriptPath : "";
}

/**
 * `path` as the folder it works in (`cwd`, relative to the agent's own folder: a code session's worktree) reads it.
 * Elsewhere on the computer only its last parts: a whole absolute path names people's folders.
 */
export function workingPath(path: string, cwd = ""): string {
  const p = path.trim().replace(/\\/g, "/");
  const folder = cwd
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (folder) {
    const at = p.lastIndexOf(`/${folder}/`);
    if (at >= 0) return p.slice(at + folder.length + 2) || ".";
    if (p.endsWith(`/${folder}`) || p === folder) return ".";
    if (p.startsWith(`${folder}/`)) return p.slice(folder.length + 1);
  }
  if (p.startsWith("./")) return p.slice(2);
  if (/^(?:\/|~\/|[A-Za-z]:\/)/.test(p)) {
    const parts = p.split("/").filter(Boolean);
    return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : p;
  }
  return p;
}

/** A command as one line: its first, marked when more follow. */
function commandLine(command: string): string {
  const lines = command.split("\n").filter((l) => l.trim());
  const head = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  return lines.length > 1 ? `${head} …` : head;
}

const linesOf = (text: string) => (text === "" ? [] : text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"));

/** Lines a change added and removed, by content: the lines each side has that the other lacks. */
export function changedLines(before: string, after: string): { added: number; removed: number } {
  const left = new Map<string, number>();
  for (const line of linesOf(before)) left.set(line, (left.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of linesOf(after)) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return { added, removed };
}

/** An edit's replacements: `old_string`/`new_string` (each of a `MultiEdit`'s `edits`), or in camelCase. */
function replacementsOf(input: Record<string, unknown>): { before: string; after: string }[] {
  const one = (e: Record<string, unknown>) => {
    const before = e.old_string ?? e.oldString;
    const after = e.new_string ?? e.newString;
    return typeof before === "string" && typeof after === "string" ? [{ before, after }] : [];
  };
  return Array.isArray(input.edits) ? input.edits.filter(isJsonObject).flatMap(one) : one(input);
}

/** Codex's file changes (`file_change`: each path and whether it was added, deleted or updated). */
function changesOf(input: Record<string, unknown>): { path: string; kind: string }[] {
  return Array.isArray(input.changes)
    ? input.changes.filter(isJsonObject).flatMap((c) => (str(c.path) ? [{ path: str(c.path), kind: str(c.kind) }] : []))
    : [];
}

/** A file's whole new text (Claude Code's `Write`, the other CLIs' alike). */
const contentOf = (input: Record<string, unknown>) =>
  typeof input.content === "string" ? input.content : typeof input.contents === "string" ? input.contents : null;

/** What an edit changed: its lines past the ones both sides start and end with. */
function changedPart(before: string, after: string): { removed: string[]; added: string[] } {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  const sameEnd = () => a[a.length - 1 - tail] === b[b.length - 1 - tail];
  while (tail < a.length - head && tail < b.length - head && sameEnd()) tail++;
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

/** The lines an edit or a write changed, as a diff reads them (`-`, `+`). */
function diffText(input: Record<string, unknown>): string {
  const content = contentOf(input);
  const parts: { removed: string[]; added: string[] }[] =
    content !== null
      ? [{ removed: [], added: linesOf(content) }]
      : replacementsOf(input).map((e) => changedPart(e.before, e.after));
  return parts
    .map(({ removed, added }) => [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join("\n"))
    .filter(Boolean)
    .join("\n…\n");
}

/** Places a search found, as the tool counted them; a list it cut is never counted. */
function foundOf(key: string, output: string): number | undefined {
  const text = output.trim();
  if (/^No (?:files|matches) found\b/i.test(text)) return 0;
  const said =
    /^Found (\d+) (?:files?|lines?|matches?)\b/i.exec(text) ?? /\bFound (\d+) total occurrences?\b/i.exec(text);
  if (said) return Number(said[1]);
  // Glob's answer is its files, one a line.
  if (key === "glob" && text && !/truncated/i.test(text) && output.length < BRAIN_LIMITS.toolText)
    return linesOf(text).length;
  return undefined;
}

/** A command that runs tests: its runner's summary says how many passed and failed. */
const TEST_COMMAND = /\b(?:test|tests|spec|jest|vitest|pytest|mocha|rspec|phpunit|ctest)\b/i;
const PASSED = /(\d+)\s+(?:tests?\s+)?pass(?:ed|es|ing)?\b/gi;
const FAILED = /(\d+)\s+(?:tests?\s+)?fail(?:ed|s|ing|ures?)?\b/gi;

/** The number of the last match: a test runner's summary comes at the end of its output. */
const lastCount = (text: string, pattern: RegExp) => {
  let n: number | undefined;
  for (const m of text.matchAll(pattern)) n = Number(m[1]);
  return n;
};

function runMeta(command: string, output: string, ok: boolean): CliToolMeta | undefined {
  const passed = TEST_COMMAND.test(command) ? lastCount(output, PASSED) : undefined;
  const failed = TEST_COMMAND.test(command) ? lastCount(output, FAILED) : undefined;
  if (passed !== undefined || failed !== undefined)
    return { ...(passed !== undefined ? { passed } : {}), ...(failed !== undefined ? { failed } : {}) };
  // Claude Code's failed command starts "Exit code 1"; others say "exit status 1".
  const exit = ok ? null : (/^Exit code (\d+)/i.exec(output.trim()) ?? /\bexit status (\d+)\b/i.exec(output));
  return exit ? { exit: Number(exit[1]) } : undefined;
}

/** A name to show for a tool with no verb of its own: another MCP server's tool as `server.tool`. */
const shownName = (name: string) => name.trim().replace(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/, "$1.$2");

/** The item of Claude Code's plan (`TodoWrite`) it is at now. */
function todoAtWork(input: Record<string, unknown>): string {
  const todos = Array.isArray(input.todos) ? input.todos.filter(isJsonObject) : [];
  const now = todos.find((t) => t.status === "in_progress");
  return now ? str(now.activeForm) || str(now.content) : "";
}

const masked = (text: string, max: number) => cutMarked(redactCredentials(text), max);

/**
 * One call as its line: what it did and on what, and, once it ended (`result`), what it came to. `cwd`: the folder its
 * CLI works in, relative to the agent's own (a code session's worktree), for the paths it names.
 */
export function cliToolSummary(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean } | null,
  cwd = "",
): CliToolSummary {
  const key = name.trim().toLowerCase();
  const i = inputOf(input);
  const changes = key === "file_change" ? changesOf(i) : [];
  // Only the table's own names: a tool called `constructor` is no verb.
  const known = Object.hasOwn(VERBS, key) ? VERBS[key] : undefined;
  const verb: CliVerb =
    key === "file_change"
      ? changes.length > 0 && changes.every((c) => c.kind === "add")
        ? "write"
        : "edit"
      : (known ?? "other");
  const ok = result?.isError !== true;
  const output = result ? str(result.content) : "";
  let target = "";
  let about = "";
  let meta: CliToolMeta | undefined;
  switch (verb) {
    case "read":
    case "edit":
    case "write": {
      const path = changes[0]?.path ?? first(i, PATH_KEYS);
      target = path ? workingPath(path, cwd) : "";
      if (changes.length > 1) meta = { files: changes.length };
      else if (ok && verb !== "read") {
        const content = contentOf(i);
        const counts = replacementsOf(i).map((e) => changedLines(e.before, e.after));
        if (content !== null) meta = { added: linesOf(content).length };
        else if (counts.length > 0)
          meta = {
            added: counts.reduce((n, c) => n + c.added, 0),
            removed: counts.reduce((n, c) => n + c.removed, 0),
          };
      }
      break;
    }
    case "search": {
      target = first(i, PATTERN_KEYS);
      const found = result && ok ? foundOf(key, output) : undefined;
      if (found !== undefined) meta = { found };
      break;
    }
    case "run": {
      const command = first(i, COMMAND_KEYS);
      target = commandLine(command);
      if (result) meta = runMeta(command, output, ok);
      break;
    }
    case "fetch":
      target = first(i, URL_KEYS);
      break;
    case "delegate":
      about = first(i, DELEGATE_KEYS);
      break;
    case "skill":
      target = first(i, SKILL_KEYS);
      break;
    case "workflow":
      about = workflowAbout(i, input);
      break;
    case "other":
      target = shownName(name);
      about = (key === "todowrite" ? todoAtWork(i) : "") || first(i, ABOUT_KEYS);
      break;
  }
  return {
    verb,
    ...(target ? { target: masked(target, TARGET_MAX) } : {}),
    ...(about ? { about: masked(about.split("\n")[0]?.trim() ?? "", ABOUT_MAX) } : {}),
    ...(meta ? { meta } : {}),
  };
}

/** What a call gave back, as its line opens on it: an edit's or a write's changed lines, else its result's start. */
function outputOf(verb: CliVerb, input: unknown, result: { content: string; isError?: boolean } | undefined) {
  const changed = result?.isError !== true && (verb === "edit" || verb === "write");
  const text = changed ? diffText(inputOf(input)) || str(result?.content) : str(result?.content);
  // Claude Code adds notes for the model to some results: never part of what the call gave back. Blank lines around
  // it go; the first line keeps its indent (a file's numbered lines).
  const shown = text.replace(/<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g, "").replace(/^\s*\n|\s+$/g, "");
  return shown ? masked(shown, CLI_OUTPUT_MAX) : "";
}

/**
 * One call of the brain's own as its run keeps it (ADR 0215). `ms`: how long it ran, when the brain said its start.
 * `background`: its work went on after the call (a workflow, a subagent it didn't wait for), so the call only answered
 * that it started, in words for the model: nothing of it to open.
 */
export function cliToolStep(
  call: { id: string; name: string; input?: unknown; result?: { content: string; isError?: boolean } },
  options: { cwd?: string; ms?: number; background?: boolean } = {},
): CliToolStep {
  const summary = cliToolSummary(call.name, call.input, call.result ?? null, options.cwd);
  const output = options.background ? "" : outputOf(summary.verb, call.input, call.result);
  return {
    id: cutText(call.id, 128),
    name: cutText(call.name, 128),
    ...summary,
    ok: call.result?.isError !== true,
    ...(output ? { output } : {}),
    ...(options.ms !== undefined && Number.isFinite(options.ms) ? { ms: Math.max(0, Math.round(options.ms)) } : {}),
  };
}

/** A workflow's agent as the apps show it (`CliProgress.agents`). */
export interface CliProgressAgent {
  /** What the workflow calls it. */
  label: string;
  /** The title of its phase. */
  phase?: string;
  state: "running" | "done" | "failed";
  /** Calls it made so far. */
  calls?: number;
  /** What its latest call does: its tool's verb only (the workflow doesn't tell its input). */
  verb?: CliVerb;
}

/**
 * A subagent's or a workflow's progress while it works (ADR 0215), as the apps show it live (`agent.tool.progress`):
 * the subagent's call running now as its line, how many calls it made, a workflow's agents, and its end.
 */
export interface CliProgress {
  kind: "agent" | "workflow";
  now?: CliToolSummary;
  calls?: number;
  agents?: CliProgressAgent[];
  ended?: true;
  failed?: true;
}

/** A tool's verb by its name alone (a workflow's agent's latest call). */
/** What a CLI's own tool does, by its name ("other" for one this table doesn't know). */
export const verbOfTool = (name: string): CliVerb => {
  const key = name.trim().toLowerCase();
  return Object.hasOwn(VERBS, key) ? (VERBS[key] ?? "other") : "other";
};

/** The progress a computer brain told (`tool_progress`), as the apps show it: lines read as the call's own are. */
export function cliProgress(
  p: {
    kind: "agent" | "workflow";
    step?: { name: string; input?: unknown };
    calls?: number;
    agents?: { label: string; phase?: string; state: "running" | "done" | "failed"; calls?: number; tool?: string }[];
    ended?: { failed?: boolean };
  },
  cwd = "",
): CliProgress {
  const now = p.step && cliToolShown(p.step.name) ? cliToolSummary(p.step.name, p.step.input ?? {}, null, cwd) : null;
  return {
    kind: p.kind,
    ...(now ? { now } : {}),
    ...(p.calls ? { calls: p.calls } : {}),
    ...(p.agents
      ? {
          agents: p.agents.map((a) => ({
            label: masked(a.label, ABOUT_MAX),
            ...(a.phase ? { phase: masked(a.phase, ABOUT_MAX) } : {}),
            state: a.state,
            ...(a.calls ? { calls: a.calls } : {}),
            ...(a.tool ? { verb: verbOfTool(a.tool) } : {}),
          })),
        }
      : {}),
    ...(p.ended ? { ended: true as const, ...(p.ended.failed ? { failed: true as const } : {}) } : {}),
  };
}
