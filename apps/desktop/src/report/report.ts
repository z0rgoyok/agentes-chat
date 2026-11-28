/**
 * "Send a report" from the app itself, where the server can't send it: the cover over a server here that won't start
 * (`desktop_server`), and Preferences › Activity for a computer that can't reach its server (`computer`). The report is
 * the problem report contract's format 1, built here from what Rust and the runner give, each log line scrubbed before
 * anyone sees it. `problem_report_send` (Rust) posts exactly what was shown.
 */

import { type KnownLabel, scrubLogLine } from "@agenteschat/adapters/error-scrub";
import { halfGb, type RunnerReportParts, versionNumbers } from "@agenteschat/adapters/machine-protocol";
import { capProblemReport, type ProblemLogName } from "@agenteschat/adapters/problem-report";

/** What `problem_report_parts` answers (local_server.rs). */
export interface CoverParts {
  appVersion: string;
  os: string;
  arch: string;
  phase: string;
  installedVersion: string | null;
  serverVersion: string | null;
  reach: boolean;
  usage: boolean;
  steps: string[];
  serverLogTail: string;
}

/** What `problem_report_facts` answers (vitals.rs): this computer's system and size, as measured. */
export interface ReportFacts {
  /** macOS's version (`15.1`), Windows' build (`10.0.19045`), Linux's kernel (`6.8.0-45-generic`). */
  osVersion: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  /** The memory of the processes behind the main window's web view. */
  webviewBytes: number | null;
  /** From the app's start to the site's first screen, when the window opened with the app. */
  openingMs: number | null;
}

export interface DesktopReport {
  format: 1;
  instance: null;
  source: "desktop";
  place: "desktop_server" | "computer";
  code: string | null;
  happenedAt: string;
  timings?: Record<string, number>;
  versions: Record<string, string | number>;
  install: "desktop" | null;
  locale: string | null;
  facts: Record<string, string | number | boolean | null>;
  logs: { name: ProblemLogName; lines: string[] }[];
  note: string | null;
  replyTo: string | null;
}

/** What `problem_report_send` answers (problem_report.rs). */
export interface SendAnswer {
  id?: string;
  error?: "off" | "too_large" | "bad_request" | "rate_limited" | "refused" | "unreachable";
  retryAfterS?: number;
}

const LINES = 300;
/** The contract's longest timing: a day. */
const TIMING_MAX_MS = 86_400_000;
const VERSION = /^[0-9A-Za-z.+_-]{1,40}$/;
const okVersion = (v: string | null | undefined) => (v && VERSION.test(v) ? v : undefined);
/** `notInstalled` → `not_installed`: a code is lowercase. */
const codeOf = (phase: string) => phase.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).slice(0, 64) || null;
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
};
const lang = (locale: string) => (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(locale) ? locale : null);

/**
 * This computer in a report: its system's version among the versions (its numbers alone, as the usage report says
 * it), its CPUs, memory and web view's memory as facts, and this opening (`timings.opening`). Nothing of what wasn't
 * measured.
 */
function thisComputer(about: ReportFacts | null) {
  const size = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
  const memory = size(about?.memoryBytes);
  const webview = size(about?.webviewBytes);
  const opening = about?.openingMs;
  return {
    osVersion: versionNumbers(about?.osVersion ?? ""),
    facts: {
      ...(size(about?.cpus) ? { "desktop.cpus": Math.round(about?.cpus ?? 0) } : {}),
      ...(memory ? { "desktop.memoryGb": halfGb(memory) } : {}),
      ...(webview ? { "desktop.webviewMb": Math.round(webview / 1e6) } : {}),
    },
    timings:
      typeof opening === "number" && opening >= 0 && opening <= TIMING_MAX_MS ? { opening: Math.round(opening) } : null,
  };
}

/** The servers' hosts this app knows, as `[server]` in every line. */
export const knownServers = (urls: (string | null | undefined)[]): [string, KnownLabel][] =>
  urls.map(hostOf).flatMap((h) => (h ? [[h, "server"] as [string, KnownLabel]] : []));

/**
 * The cover's report: the app's version, the server here's state and setup steps, the end of its log, and this
 * computer (`about`, when the app could tell).
 */
export function coverReport(
  parts: CoverParts,
  about: ReportFacts | null,
  known: [string, KnownLabel][],
  locale: string,
  now = new Date(),
) {
  const scrub = (lines: string[]) => lines.slice(-LINES).map((l) => scrubLogLine(l, known));
  const computer = thisComputer(about);
  const report: DesktopReport = {
    format: 1,
    instance: null,
    source: "desktop",
    place: "desktop_server",
    code: codeOf(parts.phase),
    happenedAt: now.toISOString(),
    ...(computer.timings ? { timings: computer.timings } : {}),
    versions: Object.fromEntries(
      Object.entries({
        desktop: okVersion(parts.appVersion),
        server: okVersion(parts.serverVersion) ?? okVersion(parts.installedVersion),
        os: parts.os,
        osVersion: computer.osVersion,
        arch: parts.arch,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    install: "desktop",
    locale: lang(locale),
    facts: {
      "desktop.phase": parts.phase.slice(0, 200),
      "desktop.installed": okVersion(parts.installedVersion) ?? null,
      "desktop.reach": parts.reach,
      "desktop.usage": parts.usage,
      ...computer.facts,
    },
    logs: [
      { name: "desktop_steps", lines: scrub(parts.steps) },
      { name: "server", lines: scrub(parts.serverLogTail.split(/\r?\n/).filter(Boolean)) },
    ],
    note: null,
    replyTo: null,
  };
  return capProblemReport(report);
}

/**
 * Preferences' report for one computer: the runner's own facts and its log (already scrubbed there, again here), and
 * this computer (`about`, when the app could tell).
 */
export function computerReport(
  parts: RunnerReportParts,
  app: { version: string; os: string; arch: string },
  about: ReportFacts | null,
  known: [string, KnownLabel][],
  locale: string,
  now = new Date(),
) {
  const computer = thisComputer(about);
  const facts: DesktopReport["facts"] = {
    "runner.runtime": parts.runtime,
    "runner.os": parts.os,
    "runner.compiled": parts.compiled,
    "runner.managedBy": parts.managedBy,
    "runner.connection": parts.connection,
    "runner.paused": parts.paused,
    "runner.agents": parts.agents,
    "runner.runningNow": parts.runningNow,
    "runner.browser": parts.browser?.state ?? null,
    "runner.claude": parts.executors.claude ?? null,
    "runner.codex": parts.executors.codex ?? null,
    "runner.claudeLoggedIn": parts.executors.claudeLoggedIn ?? null,
  };
  for (const [tool, on] of Object.entries(parts.tools)) facts[`runner.tools.${tool}`] = on;
  const report: DesktopReport = {
    format: 1,
    instance: null,
    source: "desktop",
    place: "computer",
    code: codeOf(parts.connection),
    happenedAt: now.toISOString(),
    ...(computer.timings ? { timings: computer.timings } : {}),
    versions: Object.fromEntries(
      Object.entries({
        desktop: okVersion(app.version),
        runner: okVersion(parts.runner),
        runnerProtocol: parts.protocol,
        os: app.os,
        osVersion: computer.osVersion,
        arch: app.arch,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string | number>,
    install: null,
    locale: lang(locale),
    facts: { ...facts, ...computer.facts },
    logs: [{ name: "runner", lines: parts.logTail.slice(-LINES).map((l) => scrubLogLine(l, known)) }],
    note: null,
    replyTo: null,
  };
  return capProblemReport(report);
}

/** The report as shown and copied, with the note and address as typed. */
export function reportText(report: DesktopReport, note: string, replyTo: string) {
  const sent = { ...report, note: note.trim() || null, replyTo: replyTo.trim() || null };
  return `agentes.chat problem report (format 1)\n\n${JSON.stringify(sent, null, 2)}`;
}
