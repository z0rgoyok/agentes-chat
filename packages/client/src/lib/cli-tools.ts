import type { TFunction } from "i18next";

/**
 * A computer brain's own tool calls in a code session (ADR 0215: Claude Code's Read, Grep, Edit, Bash…, Codex's
 * commands and file changes) as the quiet lines a terminal shows: what it did, on what, and what it came to. The
 * server says them (`packages/engine/src/cli-tools.ts`): live on `agent.step` (`cli`), saved as the run's `context`
 * steps (`cliTool`) and, for a reply's lone call, on `meta.work`.
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

/** What a call came to, as counts: lines added and removed, places found, files changed, tests, an exit code. */
export interface CliMeta {
  added?: number;
  removed?: number;
  found?: number;
  files?: number;
  passed?: number;
  failed?: number;
  exit?: number;
}

/** A call as its line: what it did (`verb`), on what (`target`, shown in mono), what for (`about`), what it came to. */
export interface CliLine {
  verb: CliVerb;
  target?: string;
  about?: string;
  meta?: CliMeta;
}

/** A call as the run's trail keeps it (`context` step `cliTool`). */
export interface CliStep extends CliLine {
  id: string;
  name: string;
  ok: boolean;
  /** The start of what it gave back (an edit's or a write's: the lines it changed). */
  output?: string;
  ms?: number;
}

const META_KEYS = ["added", "removed", "found", "files", "passed", "failed", "exit"] as const;

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A `cli` value from the server (an event, a step, `meta.work`), checked: null when it isn't one. */
export function cliLineOf(value: unknown): CliLine | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const verb = CLI_VERBS.find((x) => x === v.verb);
  if (!verb) return null;
  const m = (v.meta && typeof v.meta === "object" ? v.meta : {}) as Record<string, unknown>;
  const meta: CliMeta = {};
  for (const key of META_KEYS) {
    const n = count(m[key]);
    if (n !== undefined) meta[key] = n;
  }
  const target = text(v.target);
  const about = text(v.about);
  return {
    verb,
    ...(target ? { target } : {}),
    ...(about ? { about } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

/** A run step's call of the brain's own (`context` step `cliTool`), checked: null when the step isn't one. */
export function cliStepOf(data: Record<string, unknown>): CliStep | null {
  const v = data.cliTool as Record<string, unknown> | null | undefined;
  const line = cliLineOf(v);
  if (!v || !line || typeof v.name !== "string") return null;
  return {
    ...line,
    id: typeof v.id === "string" ? v.id : "",
    name: v.name,
    ok: v.ok !== false,
    ...(text(v.output) ? { output: v.output as string } : {}),
    ...(count(v.ms) !== undefined ? { ms: v.ms as number } : {}),
  };
}

/** "Read", "Ran"; while it runs "Reading", "Running". */
export const cliVerbWord = (t: TFunction, verb: CliVerb, running = false) =>
  t(running ? `cliTools.running.${verb}` : `cliTools.${verb}`);

/** What it came to, in words: "+2 −1", "3 places", "15 passed · 1 failed", "exit 1". Null: nothing to say. */
export function cliMetaWords(t: TFunction, meta: CliMeta | undefined): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.added !== undefined && meta.removed !== undefined)
    parts.push(t("cliTools.lines", { added: meta.added, removed: meta.removed }));
  else if (meta.added !== undefined) parts.push(t("cliTools.added", { added: meta.added }));
  if (meta.found !== undefined) parts.push(t("cliTools.found", { count: meta.found }));
  if (meta.files !== undefined) parts.push(t("cliTools.files", { count: meta.files }));
  if (meta.passed !== undefined) parts.push(t("cliTools.passed", { count: meta.passed }));
  if (meta.failed) parts.push(t("cliTools.failedTests", { count: meta.failed }));
  if (meta.exit !== undefined && parts.length === 0) parts.push(t("cliTools.exit", { code: meta.exit }));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A workflow's agent while it works (`CliProgress.agents`). */
export interface CliProgressAgent {
  label: string;
  phase?: string;
  state: "running" | "done" | "failed";
  calls?: number;
  /** What its latest call does (its tool's verb only). */
  verb?: CliVerb;
}

/**
 * A subagent's or a workflow's progress while it works (ADR 0215), live from the server (`agent.tool.progress`): the
 * subagent's call running now as its line, how many calls it made, a workflow's agents, and its end.
 */
export interface CliProgress {
  kind: "agent" | "workflow";
  now?: CliLine;
  calls?: number;
  agents?: CliProgressAgent[];
  ended?: boolean;
  failed?: boolean;
}

const AGENT_STATES = ["running", "done", "failed"] as const;

/** A `progress` value from the server, checked: null when it isn't one. */
export function cliProgressOf(value: unknown): CliProgress | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== "agent" && v.kind !== "workflow") return null;
  const now = cliLineOf(v.now);
  const calls = count(v.calls);
  const agents = Array.isArray(v.agents)
    ? v.agents.flatMap((a): CliProgressAgent[] => {
        if (!a || typeof a !== "object") return [];
        const x = a as Record<string, unknown>;
        const label = text(x.label);
        const state = AGENT_STATES.find((s) => s === x.state);
        if (!label || !state) return [];
        const phase = text(x.phase);
        const n = count(x.calls);
        const verb = CLI_VERBS.find((w) => w === x.verb);
        return [{ label, ...(phase ? { phase } : {}), state, ...(n ? { calls: n } : {}), ...(verb ? { verb } : {}) }];
      })
    : undefined;
  return {
    kind: v.kind,
    ...(now ? { now } : {}),
    ...(calls ? { calls } : {}),
    ...(agents ? { agents } : {}),
    ...(v.ended === true ? { ended: true } : {}),
    ...(v.failed === true ? { failed: true } : {}),
  };
}

/** A later progress over the one kept: what it says now, its counts never going back. */
export function mergeCliProgress(before: CliProgress | undefined, next: CliProgress): CliProgress {
  if (!before) return next;
  const calls = Math.max(before.calls ?? 0, next.calls ?? 0);
  return {
    ...before,
    ...next,
    ...(next.now ? {} : before.now ? { now: before.now } : {}),
    ...(next.agents ? {} : before.agents ? { agents: before.agents } : {}),
    ...(calls ? { calls } : {}),
  };
}

/** A run's subagents and workflows at work now (`subagentsNow`): what a line about them says. */
export interface SubagentsNow {
  /** Subagents at work (each `Agent` call whose subagent hasn't ended). */
  agents: number;
  /** The one subagent's call running now, when a single one works. */
  now?: CliLine;
  /** A workflow at work: its agents done, and in all. */
  workflow?: { done: number; total: number };
}

/** What a run's live work says of its subagents and workflows still at work; null when none is. */
export function subagentsNow(
  work: readonly { kind: string; progress?: CliProgress }[] | undefined,
): SubagentsNow | null {
  let agents = 0;
  let now: CliLine | undefined;
  let workflow: SubagentsNow["workflow"];
  for (const w of work ?? []) {
    const p = w.kind === "call" ? w.progress : undefined;
    if (!p || p.ended) continue;
    if (p.kind === "workflow") {
      const list = p.agents ?? [];
      workflow ??= { done: list.filter((a) => a.state !== "running").length, total: list.length };
    } else {
      agents += 1;
      now = agents === 1 ? p.now : undefined;
    }
  }
  if (!agents && !workflow) return null;
  return { agents, ...(now ? { now } : {}), ...(workflow ? { workflow } : {}) };
}

/**
 * Those subagents in words, as a step line: "Rodando um workflow · 2 de 3 prontos", "Pedindo a um subagente · lendo
 * todo.js", "Pedindo a 3 subagentes".
 */
export function subagentsWords(t: TFunction, busy: SubagentsNow, lower: (s: string) => string = (s) => s): string {
  if (busy.workflow) {
    const verb = cliVerbWord(t, "workflow", true);
    return busy.workflow.total > 0
      ? `${verb} · ${t("cliTools.progress.done", { done: busy.workflow.done, total: busy.workflow.total })}`
      : verb;
  }
  const asking = t("cliTools.progress.asking", { count: busy.agents });
  if (!busy.now) return asking;
  const doing = lower(cliVerbWord(t, busy.now.verb, true));
  return `${asking} · ${busy.now.target ? `${doing} ${busy.now.target.split("/").pop() ?? busy.now.target}` : doing}`;
}
