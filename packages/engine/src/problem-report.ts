/**
 * "Send a report" on a self-hosted server: what a person sees in full, then sends to agentes.chat with one click. The
 * body is the problem report contract (format 1), the same schema the receiver checks. Never content: no messages,
 * prompts, transcripts, tool arguments, page addresses, names or keys. Log lines go through `scrubLogLine`.
 */
import {
  capProblemReport,
  type KnownLabel,
  PROBLEM_REPORT_PROTOCOL,
  type RunnerReportParts,
  scrubLogLine,
} from "@agenteschat/adapters";
import { and, appliedMigrations, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { z } from "zod";
import { requireChannelAccess } from "./channels";
import { secondsBefore } from "./format";
import type { MachineCaller } from "./machine-hub";
import { getMachine, offlineCause } from "./machines";
import { pinnedOwner, requirePermission } from "./organizations";
import { lastRunComputer } from "./run-timings";
import { telemetryState } from "./telemetry";

const { agentRuns, agents, machines, organizations, users } = schema;

export const PROBLEM_REPORT_PLACES = [
  "browser",
  "computer",
  "run",
  "desktop_server",
  "settings",
  "ai_signin",
  "connector",
  "update",
  "pairing",
  "device",
  "email",
  "database",
] as const;
export type ProblemReportPlace = (typeof PROBLEM_REPORT_PLACES)[number];

export const PROBLEM_NOTE_MAX = 2000;

const CODE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const VERSION = /^[0-9A-Za-z.+_-]{1,40}$/;
export const LOCALE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;
const code = z.string().regex(CODE).nullable().optional();
const version = z.string().regex(VERSION).optional();

/** Format 1, as the receiver checks it: unknown keys are dropped, anything else that doesn't fit is refused. */
export const problemReportSchema = z.object({
  format: z.literal(1),
  instance: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .nullable()
    .optional(),
  source: z.enum(["server", "desktop"]),
  place: z.enum(PROBLEM_REPORT_PLACES),
  code,
  step: code,
  happenedAt: z.iso.datetime().nullable().optional(),
  timings: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), z.number().int().min(0).max(86_400_000))
    .refine((t) => Object.keys(t).length <= 20)
    .optional(),
  versions: z
    .object({
      server: version,
      desktop: version,
      runner: version,
      runnerProtocol: z.number().int().optional(),
      web: version,
      mobile: version,
      /** The system's own version where the sender reads it: macOS's (`15.1`), Windows' build, Linux's kernel. */
      osVersion: version,
      os: z
        .string()
        .max(80)
        .regex(/^[^@/]*$/)
        .optional(),
      arch: z
        .string()
        .max(20)
        .regex(/^[^@/]*$/)
        .optional(),
      browser: z
        .string()
        .max(40)
        .regex(/^[^@/]*$/)
        .optional(),
    })
    .optional(),
  install: z.enum(["docker", "native", "desktop"]).nullable().optional(),
  locale: z.string().regex(LOCALE_PATTERN).nullable().optional(),
  facts: z
    .record(
      z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,63}$/),
      z.union([z.string().max(200), z.number().refine(Number.isFinite), z.boolean(), z.null()]),
    )
    .refine((f) => Object.keys(f).length <= 120)
    .optional(),
  logs: z
    .array(
      z.object({
        name: z.enum(["runner", "server", "desktop", "desktop_steps"]),
        lines: z.array(z.string().max(1000)).max(400),
      }),
    )
    .max(4)
    .refine((logs) => new Set(logs.map((l) => l.name)).size === logs.length)
    .optional(),
  note: z.string().max(PROBLEM_NOTE_MAX).nullable().optional(),
  replyTo: z.email().max(254).nullable().optional(),
});
export type ProblemReport = z.infer<typeof problemReportSchema>;
type Facts = NonNullable<ProblemReport["facts"]>;
type Log = NonNullable<ProblemReport["logs"]>[number];

/** An offline computer's last close: its reason text is the runner's word, left out. */
function offlineFacts(machine: Parameters<typeof offlineCause>[0], now: Date): Facts {
  const last = machine.disconnects[0];
  return {
    "machine.offlineCause": offlineCause(machine, false),
    "machine.lastCloseCode": last?.code ?? null,
    "machine.lastCloseS": secondsBefore(now, last?.at),
    "machine.lastConnectedS": secondsBefore(now, last?.connectedAt),
  };
}

/** What the preview shows above the report: why a log isn't in it. */
export interface ProblemReportMissing {
  /** The computer's name (the person sees it already), when its log is missing. */
  computer?: string;
  runnerLog?: "no_answer" | "old_app";
  /** Server log lines left out: only the installation's owner sends them. */
  serverLines?: boolean;
}

export interface ProblemReportInput {
  orgId: string;
  userId: string;
  place: ProblemReportPlace;
  code?: string | null;
  step?: string | null;
  context?: { machineId?: string; agentId?: string; runId?: string };
  timings?: Record<string, number>;
  /** Facts the client measured (the browser card's state code, its attempt), checked against the contract. */
  clientFacts?: Record<string, string | number | boolean>;
  client?: { web?: string; mobile?: string; browser?: string; locale?: string };
}

export interface ProblemReportSources {
  server: { version: string; install: "docker" | "native" | "desktop"; os: string; arch: string };
  /** `config.<NAME>` facts: which settings are set, never their values (`configFacts`). */
  config: Facts;
  publicUrl: string;
  /** The server's recent log lines; only the installation's owner gets them in. */
  serverLines: () => readonly string[];
  hub?: Pick<MachineCaller, "call" | "status"> | null;
  now?: Date;
}

/** How long a report waits for a computer's part. */
export const REPORT_COLLECT_TIMEOUT_MS = 5_000;
const SERVER_LOG_WINDOW_MS = 30 * 60_000;
const LOG_LINES = 300;
/** The contract's limit on facts. */
const FACTS_MAX = 120;

const fit = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);
/** `versions.os`, `arch` and `browser` as the contract takes them: no `@` or `/`, cut to `max`. */
const words = (s: string, max: number) => fit(s.replace(/[@/]/g, ""), max);
const okCode = (s: string | null | undefined) => (s && CODE.test(s) ? s : null);
const okVersion = (s: string | null | undefined) => (s && VERSION.test(s) ? s : undefined);

/** A log line's own time (`{"time":"…"}`), when it has one. */
function lineTime(line: string): number | null {
  const m = /"time":"([^"]+)"/.exec(line);
  const t = m ? Date.parse(m[1] ?? "") : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

/** The plain text shown in the preview and copied by Copy report: exactly what's sent, as JSON. */
export function problemReportText(report: ProblemReport): string {
  return `agentes.chat problem report (format ${report.format})\n\n${JSON.stringify(report, null, 2)}`;
}

/** The facts kept from a computer's answer, which comes from the person's computer and is checked here. */
function runnerFacts(parts: Partial<RunnerReportParts>): Facts {
  const str = (v: unknown) => (typeof v === "string" ? fit(v, 200) : null);
  const facts: Facts = {
    "runner.runtime": str(parts.runtime),
    "runner.os": str(parts.os),
    "runner.compiled": typeof parts.compiled === "boolean" ? parts.compiled : null,
    "runner.managedBy": str(parts.managedBy),
    "runner.connection": str(parts.connection),
    "runner.agents": typeof parts.agents === "number" ? parts.agents : null,
    "runner.runningNow": typeof parts.runningNow === "number" ? parts.runningNow : null,
    "runner.browser": str(parts.browser?.state),
    "runner.claude": str(parts.executors?.claude),
    "runner.codex": str(parts.executors?.codex),
    "runner.claudeLoggedIn":
      typeof parts.executors?.claudeLoggedIn === "boolean" ? parts.executors.claudeLoggedIn : null,
  };
  for (const [tool, on] of Object.entries(parts.tools ?? {}).slice(0, 12)) {
    if (/^[a-zA-Z0-9_]{1,30}$/.test(tool) && typeof on === "boolean") facts[`runner.tools.${tool}`] = on;
  }
  return facts;
}

type Known = [string, KnownLabel][];

async function knownValues(db: Database, orgId: string, userId: string, publicUrl: string): Promise<Known> {
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [me] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  const names = await db.select({ name: machines.name }).from(machines).where(eq(machines.orgId, orgId));
  const agentNames = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(200);
  const host = (() => {
    try {
      return new URL(publicUrl).host;
    } catch {
      return "";
    }
  })();
  return [
    [host, "server"],
    [org?.name ?? "", "workspace"],
    [me?.name ?? "", "person"],
    [me?.email ?? "", "person"],
    ...names.map((m): [string, KnownLabel] => [m.name, "computer"]),
    ...agentNames.map((a): [string, KnownLabel] => [a.name, "agent"]),
  ];
}

/**
 * The report a person previews (`POST …/problem-reports/preview`). What it adds follows what they may see: a computer
 * of their workspace, a run in a conversation they read, and the server's log lines only for the installation's
 * owner. Reads only: a computer that doesn't answer in `REPORT_COLLECT_TIMEOUT_MS` is left out and said so.
 */
export async function buildProblemReport(
  db: Database,
  input: ProblemReportInput,
  sources: ProblemReportSources,
): Promise<{ report: ProblemReport; missing: ProblemReportMissing }> {
  await requirePermission(db, input.userId, input.orgId, "read");
  const now = sources.now ?? new Date();
  const known = await knownValues(db, input.orgId, input.userId, sources.publicUrl);
  const scrub = (lines: readonly string[]) => lines.map((l) => scrubLogLine(l, known));
  const state = await telemetryState(db);
  const count = async (table: typeof organizations | typeof agents | typeof machines) =>
    (await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]?.n ?? 0;

  const facts: Facts = {
    // Room for the rest under the contract's 120: at most 50 settings, 5 here, 10 from the screen, 8 of a run, 14 of a
    // computer, 23 of its runner and 2 notes on what's missing.
    ...Object.fromEntries(Object.entries(sources.config).slice(0, 50)),
    "counts.orgs": await count(organizations),
    "counts.agents": await count(agents),
    "counts.machines": await count(machines),
    uptimeHours: Math.round(((now.getTime() - state.startedAt.getTime()) / 3600_000) * 10) / 10,
    "db.migrationsApplied": (await appliedMigrations(db)).length,
  };
  for (const [key, value] of Object.entries(input.clientFacts ?? {}).slice(0, 10)) {
    const name = `client.${key}`;
    if (!/^[a-z][a-zA-Z0-9_.]{0,63}$/.test(name)) continue;
    facts[name] = typeof value === "string" ? fit(value, 200) : value;
  }
  const versions: NonNullable<ProblemReport["versions"]> = {
    server: okVersion(sources.server.version),
    os: words(sources.server.os, 80),
    arch: words(sources.server.arch, 20),
    web: okVersion(input.client?.web),
    mobile: okVersion(input.client?.mobile),
    ...(input.client?.browser ? { browser: words(input.client.browser, 40) } : {}),
  };
  const logs: Log[] = [];
  const missing: ProblemReportMissing = {};
  let code = okCode(input.code);

  const machineId =
    input.place === "computer"
      ? input.context?.machineId
      : input.place === "browser"
        ? (input.context?.machineId ?? (await agentMachine(input.context?.agentId)))
        : await runMachine();
  async function agentMachine(agentId: string | undefined): Promise<string | undefined> {
    if (!agentId) return undefined;
    const [agent] = await db
      .select({ machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, input.orgId)));
    return agent?.machineId ?? undefined;
  }
  async function runMachine(): Promise<string | undefined> {
    const runId = input.context?.runId;
    if (input.place !== "run" || !runId) return undefined;
    const [run] = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, input.orgId)));
    const readable =
      run &&
      (await requireChannelAccess(db, input.userId, input.orgId, run.channelId).then(
        () => true,
        () => false,
      ));
    if (!run || !readable) {
      facts.run = "not_visible";
      return undefined;
    }
    code ??= okCode(run.error?.split(":")[0]?.trim());
    Object.assign(facts, {
      "run.status": run.status,
      "run.brain": run.brain,
      "run.turns": run.turns,
      "run.hop": run.hop,
      "run.trigger": run.trigger,
      "run.background": run.background,
      // Its words too, scrubbed as a log line is: the code alone can't tell one runner refusal from another.
      "run.error": run.error ? (scrub([run.error])[0] ?? null) : null,
    });
    // The computer its turns ran on, as the run kept it: the agent's own may be none (the right hand thinks on its
    // plan's computer, a mission on its session's), and `waitingMachineId` is cleared once the run stops waiting.
    return run.waitingMachineId ?? lastRunComputer(run.profiles) ?? (await agentMachine(run.agentId));
  }

  if (machineId) {
    const machine = await getMachine(db, input.orgId, machineId);
    if (!machine) facts.machine = "not_visible";
    else {
      const status = (await sources.hub?.status(machine.id).catch(() => null)) ?? null;
      Object.assign(facts, {
        "machine.kind": machine.kind,
        "machine.os": machine.os,
        "machine.arch": machine.arch,
        "machine.runner": machine.runnerVersion || null,
        "machine.protocol": status?.protocol ?? machine.protocol,
        "machine.connection": status?.online ? "online" : "offline",
        "machine.lastSeenS": secondsBefore(now, status?.lastSeenAt),
        "machine.paused": machine.paused,
        // Offline: why, from its runner's last close (the device page's cause line), and that socket's code and times.
        ...(status?.online ? {} : offlineFacts(machine, now)),
        // Windows: its build, and what holds Codex's commands there (`mxc`, `unelevated`, `none`), once its runner said.
        ...(machine.os === "windows"
          ? {
              "machine.windowsBuild": machine.executors?.windowsBuild ?? null,
              "machine.codexSandbox": machine.executors?.codex?.sandbox ?? null,
            }
          : {}),
      });
      versions.runner = okVersion(machine.runnerVersion);
      versions.runnerProtocol = status?.protocol ?? machine.protocol;
      const protocol = status?.protocol ?? machine.protocol;
      if (!status?.online || !sources.hub) {
        missing.runnerLog = "no_answer";
        facts.runnerLog = "no_answer";
      } else if (protocol < PROBLEM_REPORT_PROTOCOL) {
        missing.runnerLog = "old_app";
        facts.runnerLog = "old_app";
      } else {
        try {
          const parts = (await sources.hub.call(
            machine.id,
            { op: "report.collect" },
            { timeoutMs: REPORT_COLLECT_TIMEOUT_MS },
          )) as Partial<RunnerReportParts>;
          Object.assign(facts, runnerFacts(parts));
          versions.runner = okVersion(parts.runner) ?? versions.runner;
          if (typeof parts.protocol === "number") versions.runnerProtocol = parts.protocol;
          const tail = Array.isArray(parts.logTail) ? parts.logTail.filter((l) => typeof l === "string") : [];
          logs.push({ name: "runner", lines: scrub(tail.slice(-LOG_LINES)) });
        } catch {
          missing.runnerLog = "no_answer";
          facts.runnerLog = "no_answer";
        }
      }
      if (missing.runnerLog) missing.computer = machine.name;
    }
  }

  if ((await pinnedOwner(db)) === input.userId) {
    const since = now.getTime() - SERVER_LOG_WINDOW_MS;
    const lines = sources.serverLines().filter((l) => (lineTime(l) ?? now.getTime()) >= since);
    if (lines.length > 0) logs.unshift({ name: "server", lines: scrub(lines.slice(-LOG_LINES)) });
  } else {
    missing.serverLines = true;
    facts.serverLog = "owner_only";
  }

  const timings = Object.entries(input.timings ?? {})
    .filter(([k, v]) => /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k) && Number.isInteger(v) && v >= 0 && v <= 86_400_000)
    .slice(0, 20);
  // Facts come from rows and the person's computer: kept within the contract instead of failing the whole report.
  const fittedFacts = Object.fromEntries(
    Object.entries(facts)
      .slice(0, FACTS_MAX)
      .map(([k, v]) => [
        k,
        typeof v === "string" ? fit(v, 200) : typeof v === "number" && !Number.isFinite(v) ? null : v,
      ]),
  );
  const report = capProblemReport({
    format: 1,
    instance: state.instanceId,
    source: "server",
    place: input.place,
    code,
    step: okCode(input.step),
    happenedAt: now.toISOString(),
    ...(timings.length > 0 ? { timings: Object.fromEntries(timings) } : {}),
    versions,
    install: sources.server.install,
    locale: input.client?.locale && LOCALE_PATTERN.test(input.client.locale) ? input.client.locale : null,
    facts: fittedFacts,
    logs,
    note: null,
    replyTo: null,
  });
  return { report: problemReportSchema.parse(report), missing };
}

/**
 * What `send` posts: the previewed report checked again, its logs scrubbed again (a person may have edited the JSON),
 * and the person's note (credentials masked, the rest as written) and reply address.
 */
export function finishProblemReport(
  report: ProblemReport,
  extra: { note?: string | null; replyTo?: string | null; redact: (text: string) => string },
): ProblemReport {
  const parsed = problemReportSchema.parse(report);
  const note = extra.note?.trim() ? fit(extra.redact(extra.note.trim()), PROBLEM_NOTE_MAX) : null;
  return problemReportSchema.parse({
    ...parsed,
    logs: parsed.logs?.map((l) => ({ ...l, lines: l.lines.map((line) => scrubLogLine(line)) })),
    note,
    replyTo: extra.replyTo?.trim() || null,
  });
}
