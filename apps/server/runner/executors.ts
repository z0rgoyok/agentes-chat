import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import {
  CLI_ERROR_MAX,
  CLI_GIT_MISSING,
  CLI_HOME_ONLY,
  CURSOR_MODEL_LIMITS,
  type CursorModelInfo,
  parseExecutors,
  type RunnerExecutorInfo,
  type RunnerInfo,
} from "@agenteschat/adapters/machine-protocol";
import {
  DEVIN_FUSION_HELPER,
  DEVIN_LEVELS,
  devinVariantOf,
  isOpencodeFreeModel,
  OPENCODE_FREE_MODELS,
} from "@agenteschat/providers/plans";
import { type CodexSignIn, codexLoginStatusOf } from "./codex-sign-in";
import { consoleText } from "./console-text";
import { readSmallJson, writeJson } from "./json-file";
import { usualDirs } from "./login-path";
import { SHARED_BIN_ENV } from "./shared-folder";

/**
 * Which coding CLIs this machine has (protocol 7, ADR 0029): `claude` and
 * `codex` on the PATH the runner (and so its tasks) sees, with the first line
 * of `--version`. Best effort and cached: `hello` carries the last known list
 * at once, a fresh look happens in the background at most every
 * `EXECUTORS_TTL_MS`, and a list that changed goes out as `executors.changed`.
 */
export const EXECUTORS_TTL_MS = 10 * 60_000;
/** After a look that couldn't tell (a CLI timed out or failed), the next one comes this soon, then doubles up to the TTL. */
export const EXECUTORS_RETRY_MS = 30_000;
/** A CLI whose `--version` keeps failing this many looks in a row is gone (a broken shim, a launcher left behind). */
export const EXECUTORS_EXIT_STRIKES = 3;

type Executors = NonNullable<RunnerInfo["executors"]>;
export type RunResult = { status: number | null; stdout: string; stderr?: string; error?: unknown };
export type ExecutorRun = (command: string, args: string[]) => RunResult | Promise<RunResult>;
type Run = ExecutorRun;

/** Shells' "command not found" (127), "not executable" (126) and cmd.exe's (9009). */
const NOT_FOUND_EXITS = new Set([126, 127, 9009]);
/** cmd.exe's words for a program it can't find: the CLI, or the `node` an npm launcher runs. */
const CMD_NOT_FOUND = /is not recognized as an internal or external command/i;

/**
 * Only a binary that isn't there is missing: not found, or a shell saying so (Windows runs CLIs through cmd.exe, an
 * npm shim whose `node` is gone exits 127). A timeout or a crash (a busy machine, a CLI mid-update) says nothing
 * about what is installed, so the last good look stands.
 */
const missing = (r: RunResult) =>
  (r.error as { code?: unknown } | undefined)?.code === "ENOENT" ||
  (r.status !== null && NOT_FOUND_EXITS.has(r.status)) ||
  (process.platform === "win32" && r.status !== 0 && CMD_NOT_FOUND.test(r.stderr ?? ""));

/**
 * A CLI process that ended because it isn't there: the spawn's `ENOENT` (the runner's own prefix on its stderr), or
 * cmd.exe's not found (exit 9009, its words), which a CLI started through cmd.exe on Windows ends with instead.
 */
export const endedNotFound = (stderr: string, exitCode: number | null) =>
  stderr.startsWith("ENOENT") || exitCode === 9009 || CMD_NOT_FOUND.test(stderr);

export const isExecutable = (file: string) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * `command`'s full path on the current `process.env.PATH`, or the bare name. The app mode adopts the login
 * shell's PATH after start (`adoptLoginPath`); a compiled runner still looks commands up on the PATH it
 * started with (macOS's bare one from Finder) unless told otherwise, so we resolve it ourselves.
 */
export function resolveCommand(
  command: string,
  pathList = process.env.PATH ?? "",
  sharedBin = process.env[SHARED_BIN_ENV],
  platform: NodeJS.Platform = process.platform,
): string {
  const picked = pickedCommand(command);
  if (picked) return picked;
  // On Windows a program by its full path, so a spawn never looks in the current folder first (`findOnWindowsPath`);
  // a launcher (`.cmd`) stays a bare name for `cliSpawn`'s cmd.exe.
  if (platform === "win32") return windowsExe(command, pathList) ?? command;
  if (command.includes("/")) return command;
  const dirs = pathList.split(delimiter).filter((dir) => dir && dir !== sharedBin);
  const found = onPath(command, dirs);
  if (found) return found;
  // A bare name would be looked up on the PATH again, shared `bin/` included: a path that isn't there fails the same.
  return sharedBin && dirs[0] ? join(dirs[0], command) : command;
}

const onPath = (command: string, dirs: readonly string[]) =>
  dirs.map((dir) => join(dir, command)).find((full) => isExecutable(full));

/** `command` on the PATH as the person has it, never a copy the runner picked in its place; null: not there. */
export function ownCommand(
  command: string,
  pathList = process.env.PATH ?? "",
  sharedBin = process.env[SHARED_BIN_ENV],
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") {
    return findOnWindowsPath(command, envValue(process.env, "PATH") ?? "", envValue(process.env, "PATHEXT"));
  }
  return (
    onPath(
      command,
      pathList.split(delimiter).filter((dir) => dir && dir !== sharedBin),
    ) ?? null
  );
}

/**
 * The copies of the coding CLIs the runner fetched (`CliCopies`, ADR 0228 §6), by command (`claude`, `agent`, `agy`…),
 * where the person's own is older than the pin or missing: `resolveCommand` and `cliSpawn` start these for every look,
 * sign-in and turn, so each runs the version reported.
 */
const cliPicks = new Map<string, string>();
/** Files a pick starts with before its own arguments (Cursor's Windows `node.exe` and its `index.js`). */
const cliLaunch = new Map<string, string[]>();

export function setCliPick(command: string, file: string | undefined, launch: readonly string[] = []) {
  if (file) cliPicks.set(command, file);
  else cliPicks.delete(command);
  if (file && launch.length) cliLaunch.set(command, [...launch]);
  else cliLaunch.delete(command);
}

/** The file the runner starts for a bare `command` whatever the PATH: its own copy, or the `codex` its look chose. */
export const pickedCommand = (command: string): string | undefined =>
  command.includes("/") ? undefined : (pickedCli(command) ?? (command === "codex" ? pickedCodex() : undefined));

/** The runner's own copy of `command`, while it is the one to run and still there. */
export function pickedCli(command: string): string | undefined {
  const file = cliPicks.get(command);
  return file && isExecutable(file) ? file : undefined;
}

/** What the runner's own copy of `command` starts with before its arguments; none for most. */
export const pickedLaunch = (command: string): string[] => [...(cliLaunch.get(command) ?? [])];

/**
 * One argument on cmd.exe's command line, read back by the program as it was: in quotes, so an empty one stays an
 * argument and a space, `&` or `|` stays text; backslashes doubled only where they come before a quote; a quote
 * doubled. `%NAME%` still expands there, so what a person typed goes through its own check first.
 */
export const winQuote = (arg: string) => `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`;

/** A file that is there (a folder isn't). */
export const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** An environment variable as Windows reads it, whatever its case (`Path` is how Windows spells `PATH`); elsewhere exactly. */
export function envValue(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (env[name] !== undefined || platform !== "win32") return env[name];
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}

/** `name` on the Windows PATH when it is a program that starts by itself (`.exe`, `.com`); null: none, or a launcher. */
function windowsExe(name: string, pathList: string): string | null {
  const found = findOnWindowsPath(name, pathList, envValue(process.env, "PATHEXT", "win32"));
  return found && /\.(?:exe|com)$/i.test(found) ? found : null;
}

/** The extensions of a program the runner starts on Windows, in PATHEXT's order (never a script host's `.js` or `.vbs`). */
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

/**
 * A program's full path on Windows: each PATH folder in order, the name with each PATHEXT extension (`claude.exe`,
 * `codex.cmd`…). Never the current folder, which cmd.exe and a bare name's spawn search before the PATH: a turn's is
 * the agent's own folder, where the agent writes, so a `claude.cmd` there would run in place of the CLI, as the person
 * and outside every policy. Nor a PATH entry that isn't a full path (it reads from the current folder too). A name
 * with a folder is checked as given. Null: not there.
 */
export function findOnWindowsPath(
  name: string,
  pathList: string,
  pathExt = "",
  exists: (file: string) => boolean = isFile,
): string | null {
  const listed = (pathExt || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase());
  const exts = [...new Set(listed.filter((e) => RUNNABLE.includes(e)))];
  const own = win32.extname(name).toLowerCase();
  const candidates = (base: string) => [...(RUNNABLE.includes(own) ? [base] : []), ...exts.map((e) => base + e)];
  if (/[\\/]/.test(name)) return candidates(name).find((file) => exists(file)) ?? null;
  for (const entry of pathList.split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(dir)) continue;
    const hit = candidates(win32.join(dir, name)).find((file) => exists(file));
    if (hit) return hit;
  }
  return null;
}

/**
 * In a Windows program's env: neither cmd.exe nor CreateProcess looks for a program in the current folder (a launcher's
 * bare `node`, npm's and Bun's alike), which they search before the PATH otherwise.
 */
export const NO_CWD_LOOKUP: Readonly<Record<string, string>> = { NoDefaultCurrentDirectoryInExePath: "1" };

/** cmd.exe by its full path (`ComSpec`, else System32's): a bare `cmd.exe` would be looked for in the current folder first. */
export function windowsShell(env: Record<string, string | undefined> = process.env): string {
  const spec = envValue(env, "ComSpec", "win32");
  if (spec && win32.isAbsolute(spec) && /^(?:[a-zA-Z]:|\\\\)/.test(spec)) return spec;
  return win32.join(envValue(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "cmd.exe");
}

/**
 * `program` and `args` as one cmd.exe line (a `.cmd` or `.bat` launcher runs only there): every argument quoted
 * (`winQuote`), delayed expansion off (`/v:off`, whatever the registry says), no AutoRun (`/d`), and `NO_CWD_LOOKUP`
 * in its env.
 */
export function windowsShellLine(
  program: string,
  args: readonly string[],
): { file: string; args: string[]; windowsVerbatimArguments: true; env: Record<string, string> } {
  const line = [program, ...args].map(winQuote).join(" ");
  return {
    file: windowsShell(),
    args: ["/d", "/v:off", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
    env: { ...NO_CWD_LOOKUP },
  };
}

/**
 * The program npm's Windows launcher runs, when that launcher only starts a native binary in its own folder (npm writes
 * `"%dp0%\node_modules\<package>\bin\<name>.exe" %*` for a package whose `bin` is an `.exe`, as OpenCode's): started
 * directly, it takes its argv as given and dies with the tree `killTree` stops, with no cmd.exe between. Any other
 * launcher (a Node script's, one edited by hand) or a binary that isn't there: null, and it runs through cmd.exe.
 */
export function npmNativeLauncher(
  launcher: string,
  read: (file: string) => string | null = readLauncher,
  exists: (file: string) => boolean = isFile,
): string | null {
  if (win32.extname(launcher).toLowerCase() !== ".cmd") return null;
  const lines = (read(launcher) ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // npm's preamble finds its own folder (`%dp0%`); the last line runs the binary with every argument.
  if (lines[0]?.toLowerCase() !== "@echo off" || !lines.includes("SET dp0=%~dp0")) return null;
  const target = /^"%dp0%\\([^"%]+\.exe)"\s+%\*$/i.exec(lines.at(-1) ?? "")?.[1];
  if (!target || target.split("\\").includes("..")) return null;
  const exe = win32.join(win32.dirname(launcher), target);
  return exists(exe) ? exe : null;
}

/** A launcher's text, when it is small enough to be one; null otherwise or unreadable. */
function readLauncher(file: string): string | null {
  try {
    return statSync(file).size < 4096 ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * A Node script's launcher (npm's and pnpm's `claude.cmd`) runs the `node.exe` in its own folder, else a bare `node`
 * from the PATH: true when it names that `node.exe` and neither is there.
 */
export function launcherNodeMissing(
  launcher: string,
  pathList: string,
  pathExt: string | undefined,
  read: (file: string) => string | null = readLauncher,
  exists: (file: string) => boolean = isFile,
): boolean {
  if (!/%~?dp0%?\\node\.exe/i.test(read(launcher) ?? "")) return false;
  return (
    !exists(win32.join(win32.dirname(launcher), "node.exe")) && !findOnWindowsPath("node", pathList, pathExt, exists)
  );
}

/**
 * cmd.exe ending at once with its own code for a program it can't find (9009), and no words: its "not recognized"
 * is in the system's language and comes with exit 1, so only this code reads as not installed everywhere.
 */
const notFoundRun = (): CliRun => ({
  file: windowsShell(),
  args: ["/d", "/c", "exit", "9009"],
  env: { ...NO_CWD_LOOKUP },
});

/** How a CLI starts: the file, its argv, and what to add to its env (Windows: `windowsShellLine`'s). */
export interface CliRun {
  file: string;
  args: string[];
  windowsVerbatimArguments?: true;
  env?: Record<string, string>;
}

/**
 * How a CLI (`command`: a bare name, or a launcher and what it runs) starts with `args`. On Windows a bare name is
 * found on the PATH (`findOnWindowsPath`, never the current folder): an `.exe` starts as it is, with its argv (and
 * `NO_CWD_LOOKUP`: it may be a launcher too, as Bun's are); a
 * `.cmd` launcher (npm's `claude.cmd`) through cmd.exe with every argument quoted (`windowsShellLine`), since Node's own
 * `shell: true` joins them as they are, so an empty one (`--setting-sources ""`) vanished and the next flag became its
 * value, and a path with a space split in two; unless the launcher only starts a native binary (`npmNativeLauncher`),
 * which then starts as an `.exe`. One not found, or a Node script's launcher with no `node` to run
 * (`launcherNodeMissing`), ends as cmd.exe's not found (`notFoundRun`).
 * Elsewhere, and for a launcher: the file and its argv, no shell.
 */
export function cliSpawn(
  command: readonly string[],
  args: readonly string[],
  pathList?: string,
  platform: NodeJS.Platform = process.platform,
  lookup: {
    pathExt?: string;
    exists?: (file: string) => boolean;
    read?: (file: string) => string | null;
  } = {},
): CliRun {
  const [file = "", ...pre] = command;
  const own = command.length === 1 ? pickedCli(file) : undefined;
  // The runner's own copy (ADR 0228 §6), with what it starts with first: never a `.cmd` (cmd.exe's line is too short
  // for a prompt), so it starts as it is.
  if (own) {
    const launch = pickedLaunch(file);
    return platform === "win32"
      ? { file: own, args: [...launch, ...args], env: { ...NO_CWD_LOOKUP } }
      : { file: own, args: [...launch, ...args] };
  }
  if (platform === "win32" && command.length === 1) {
    const path = pathList ?? envValue(process.env, "PATH", platform) ?? "";
    const pathExt = lookup.pathExt ?? envValue(process.env, "PATHEXT", platform);
    const found = findOnWindowsPath(file, path, pathExt, lookup.exists);
    const exe = !found
      ? null
      : /\.(?:exe|com)$/i.test(found)
        ? found
        : npmNativeLauncher(found, lookup.read, lookup.exists);
    if (exe) return { file: exe, args: [...args], env: { ...NO_CWD_LOOKUP } };
    if (!found || launcherNodeMissing(found, path, pathExt, lookup.read, lookup.exists)) return notFoundRun();
    return windowsShellLine(found, args);
  }
  return { file: resolveCommand(file, pathList), args: [...pre, ...args] };
}

const defaultRun: Run = (command, args) =>
  new Promise((resolve) => {
    const run = cliSpawn([command], args);
    execFile(
      run.file,
      run.args,
      {
        encoding: "buffer",
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: run.env ? { ...process.env, ...run.env } : process.env,
        windowsVerbatimArguments: run.windowsVerbatimArguments,
      },
      (err, stdout, stderr) => resolve(execResult(err, consoleText(stdout), consoleText(stderr))),
    );
  });

/**
 * `execFile`'s answer as a look reads it. One killed past its time limit couldn't tell: on Windows the runtime reports
 * the killed process's exit code (1, from `TerminateProcess`) where elsewhere there is none, which read as a CLI that
 * can't start, when it was only slow (a large binary's first start under the antivirus' scan).
 */
export function execResult(err: unknown, stdout: unknown, stderr: unknown): RunResult {
  const e = err as { code?: unknown; killed?: unknown } | null;
  const out = `${stdout ?? ""}`;
  if (e && typeof e.code === "number" && e.killed !== true)
    return { status: e.code, stdout: out, stderr: `${stderr ?? ""}` };
  return e ? { status: null, stdout: out, error: e } : { status: 0, stdout: out };
}

const word = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,40}$/.test(v) ? v : undefined);

/**
 * The rate-limit tier of the plan Anthropic sold as Max 20x, called Ultra since 2026-10-30 (claude.com/pricing);
 * the old Max 5x, now Max, is `default_claude_max_5x`.
 */
const ULTRA_TIER = "default_claude_max_20x";
/** `.claude.json` also holds the CLI's projects: one larger than this isn't read. */
const CLAUDE_CONFIG_MAX_BYTES = 4 * 1024 * 1024;
/** Claude Code's `subscriptionType` for each organization type, as the CLI maps them. */
const CLAUDE_ORG_PLANS = new Map([
  ["claude_pro", "pro"],
  ["claude_max", "max"],
  ["claude_team", "team"],
  ["claude_enterprise", "enterprise"],
]);

/**
 * Claude's plan as Anthropic names it (`pro`, `max`, `ultra`, `team`, `enterprise`): Claude Code's
 * `subscriptionType`, which says `max` for both Max and Ultra, told apart by the organization's rate-limit tier
 * (`tier`, read only for a `max`). A `max` whose tier is unknown stays `max`.
 */
export function claudePlan(subscriptionType: unknown, tier: () => unknown): string | undefined {
  const plan = word(subscriptionType);
  return plan === "max" && tier() === ULTRA_TIER ? "ultra" : plan;
}

/**
 * The organization Claude Code is signed in to, as the CLI keeps it in its config folder's `.claude.json`
 * (`oauthAccount`): its type and rate-limit tier, which `auth status` doesn't say. Its sign-in writes both, and they
 * are missing only where its bootstrap call there failed or was skipped (offline, nonessential traffic off, another
 * provider). `own`: the computer's own config, read through a link as Claude Code reads it; an account folder's never
 * is.
 */
function claudeOrganization(configDir: string, own = false) {
  const config = readSmallJson(join(configDir, ".claude.json"), CLAUDE_CONFIG_MAX_BYTES, own) as {
    oauthAccount?: { organizationType?: unknown; organizationRateLimitTier?: unknown };
  } | null;
  return config?.oauthAccount;
}

/** The rate-limit tier of the organization Claude Code is signed in to (`claudeOrganization`). */
export const claudeTier = (configDir: string, own = false): unknown =>
  claudeOrganization(configDir, own)?.organizationRateLimitTier;

/** The plan as `claudePlan` names it from `.claude.json` alone, for a folder where no CLI may run. */
export function claudeKeptPlan(configDir: string): string | undefined {
  const org = claudeOrganization(configDir);
  const type = typeof org?.organizationType === "string" ? CLAUDE_ORG_PLANS.get(org.organizationType) : undefined;
  return claudePlan(type, () => org?.organizationRateLimitTier);
}

/**
 * Protocol 8: whether Claude Code is logged in (`claude auth status --json`:
 * `loggedIn`, `authMethod`, `subscriptionType`, the plan as `claudePlan` names
 * it). Only these three leave the machine (never the email or the
 * organization). Unknown on any failure; null when the CLI couldn't answer (timed out, failed to start).
 */
export async function claudeAuth(
  run: Run = defaultRun,
  tier: () => unknown = () => claudeTier(process.env.CLAUDE_CONFIG_DIR || homedir(), true),
): Promise<{ loggedIn?: boolean; authMethod?: string; plan?: string } | null> {
  try {
    const r = await run("claude", ["auth", "status", "--json"]);
    if (r.error) return missing(r) ? {} : null;
    const json = JSON.parse(r.stdout.trim() || "null") as Record<string, unknown> | null;
    if (!json || typeof json !== "object") return r.status !== 0 ? { loggedIn: false } : {};
    const authMethod = word(json.authMethod);
    const plan = claudePlan(json.subscriptionType, tier);
    return {
      ...(typeof json.loggedIn === "boolean" ? { loggedIn: json.loggedIn } : {}),
      ...(authMethod ? { authMethod } : {}),
      ...(plan ? { plan } : {}),
    };
  } catch {
    return {};
  }
}

/** Cursor's CLI, named `agent` since it was renamed from `cursor-agent`. */
export const CURSOR_BIN = "agent";

/**
 * `agent models` → the models its sign-in lists. One per line, `<id> - <label>` (or the id alone); a line that says
 * the plan includes it (`included`) marks it `inPlan`. Headers and anything that isn't a model id are skipped.
 */
export function parseCursorModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  for (const raw of clean.split("\n")) {
    const line = raw.replace(/^[\s*•>-]+/, "").trim();
    const m = /^([a-z0-9][\w.:/-]{0,79})(?:\s+[-–—:]\s+(.+))?$/i.exec(line);
    if (!m?.[1] || !/[\d-]/.test(m[1]) || out.some((x) => x.id === m[1])) continue;
    const rest = m[2]?.trim() ?? "";
    const inPlan = /\bincluded\b/i.test(rest);
    const label = rest
      .replace(/\(?\s*(?:current|default|included(?: in (?:your )?plan)?)\s*\)?/gi, "")
      .trim()
      .slice(0, 80);
    out.push({ id: m[1], ...(label ? { label } : {}), ...(inPlan ? { inPlan: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/** Cursor's CLI versions are dated (`2026.10.28-1a2b3c4`): an `agent` on the PATH that isn't Cursor's is skipped. */
const CURSOR_VERSION = /^\d{4}\.\d{1,2}\.\d{1,2}\b/;

/**
 * Protocol 36 (ADR 0114): Cursor's CLI (`agent`) and the models its sign-in lists (`agent models`, which asks
 * Cursor: none when signed out or offline).
 */
function detectCursor(run: Run): Promise<Probe> {
  return detectWithModels(run, CURSOR_BIN, CURSOR_VERSION, parseCursorModels);
}

/** OpenCode's CLI (`opencode-ai` on npm). */
export const OPENCODE_BIN = "opencode";

/**
 * `opencode models` → the models it can run: one `provider/model` per line (its own sort, OpenCode's first). With no
 * key that is OpenCode's free tier and whatever providers the computer's own config signs in; `free` marks the free
 * tier's. Anything that isn't a `provider/model` id is skipped.
 */
export function parseOpencodeModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const id = raw.trim();
    if (!/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(id) || id.length > 80 || out.some((x) => x.id === id)) continue;
    const label = OPENCODE_FREE_MODELS.find((m) => m.id === id)?.label;
    out.push({ id, ...(label ? { label } : {}), ...(isOpencodeFreeModel(id) ? { free: true } : {}) });
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * OpenCode's versions are plain semver (`1.19.5`), behind its name since 2.2 (`opencode v2.2.7`): an `opencode` on the
 * PATH that says anything else is skipped.
 */
const OPENCODE_VERSION = /^(?:opencode\s+)?v?\d+\.\d+\.\d+\b/;

/**
 * `opencode models`' argv for a version line: OpenCode 2 answers on a private server of its own (`--standalone`), as
 * it otherwise starts the person's background service and leaves it running; 1.x has no such flag (nor service).
 */
export const opencodeModelsArgs = (version: string) =>
  Number(/^(?:opencode\s+)?v?(\d+)\./.exec(version)?.[1] ?? 0) >= 2 ? ["models", "--standalone"] : ["models"];

/**
 * Protocol 39 (ADR 0132): OpenCode's CLI and the models it lists (`opencode models`: the free tier with no key). Its
 * version is kept without the name.
 */
async function detectOpencode(run: Run): Promise<Probe> {
  const probe = await detectWithModels(run, OPENCODE_BIN, OPENCODE_VERSION, parseOpencodeModels, opencodeModelsArgs);
  if (probe.entry) probe.entry = { ...probe.entry, version: probe.entry.version.replace(/^opencode\s+/, "") };
  return probe;
}

/** xAI's Grok Build CLI. Always `grok`: its installer also makes `~/.local/bin/agent`, which is Cursor's name. */
export const GROK_BIN = "grok";

/**
 * `grok models` → the models it lists: `  * grok-4.6 (default)` and `  - grok-4.5` under "Available models" (Grok Build
 * 1.0.34). Anything else (its "Default model:" line, a sign-in notice) is skipped.
 */
export function parseGrokModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const id = /^\s*[*-]\s+([a-z0-9][\w.:/-]{0,79})(?:\s|$)/i.exec(raw)?.[1];
    if (!id || out.some((x) => x.id === id)) continue;
    out.push({ id });
    if (out.length >= 60) break;
  }
  return out;
}

/** Grok Build's version line: `grok 1.0.34 (3736acbc8658) [stable]`; a `grok` that says anything else is skipped. */
const GROK_VERSION = /^grok \d+\.\d+\.\d+\b/;

/** Protocol 43 (ADR 0142): Grok Build and the models it lists (`grok models`). */
function detectGrok(run: Run): Promise<Probe> {
  return detectWithModels(run, GROK_BIN, GROK_VERSION, parseGrokModels);
}

/** Google's Antigravity CLI (ADR 0143). */
export const AGY_BIN = "agy";

/**
 * `agy models` → its slugs and names, one per line, split by a tab in 1.5.0 (`gemini-4-argon-high\tGemini 4 Argon
 * (High)`) or by spaces. A line without a slug and a name (a sign-in notice, `...`) is skipped.
 */
export function parseAgyModels(output: string): CursorModelInfo[] {
  const out: CursorModelInfo[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the CLI's colors
  for (const raw of output.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
    const m = /^\s*([a-z0-9][\w.:/-]{0,79})(?:\t\s*| {2,})(\S.{0,79}?)\s*$/i.exec(raw);
    if (!m?.[1] || !m[2] || out.some((x) => x.id === m[1])) continue;
    out.push({ id: m[1], label: m[2] });
    if (out.length >= 60) break;
  }
  return out;
}

/** The Antigravity CLI's version line has its version in it (`agy 1.4.12`, `1.4.12`); anything else is skipped. */
const AGY_VERSION = /^(?:agy|antigravity(?: cli)?)?[\s:v]*\d+\.\d+\.\d+\b/i;

/** Protocol 44 (ADR 0143): the Antigravity CLI and the models it lists (`agy models`). */
function detectAntigravity(run: Run): Promise<Probe> {
  return detectWithModels(run, AGY_BIN, AGY_VERSION, parseAgyModels);
}

/** Cognition's Devin CLI (ADR 0253). */
export const DEVIN_BIN = "devin";

/** The Devin CLI's version line (`devin 3000.14.30821 (a09cd7f323ee)`); anything else is skipped. */
const DEVIN_VERSION = /^devin \d+\.\d+\.\d+\b/;

/**
 * Protocol 89 (ADR 0253): the Devin CLI, by its version alone. Its models are what the accounts signed in here list
 * (`AccountManager.listedModels`): the computer's own CLI thinks for no agent.
 */
async function detectDevin(run: Run): Promise<Probe> {
  const r = await run(DEVIN_BIN, ["--version"]);
  if (r.error || r.status !== 0) return versionFailed(r);
  const version = firstLine(r);
  return DEVIN_VERSION.test(version) ? { entry: { version } } : {};
}

/** The most model families kept from one `devin models list` (its Fusion pairs counted as one per main model). */
const DEVIN_MAX_FAMILIES = CURSOR_MODEL_LIMITS.models;
/** The most variants kept for one family. */
const DEVIN_MAX_VARIANTS = 24;

/**
 * `devin models list --format json` (`{ families: [{ family_uid, family_label, variants: [{ model_uid, label,
 * max_context_tokens, cost_tier, … }] }] }`, CLI 3000.14) → one model per family: its levels, whether it has a faster
 * variant, its window, its variants (kept on the runner) and `free` when every standard variant is "Free" on the plan.
 * Fusion becomes one model per main family, each with SWE-2 Medium as its helper (`DEVIN_FUSION_HELPER`). Anything
 * that doesn't read as that shape lists nothing.
 */
export function parseDevinModels(output: string): CursorModelInfo[] {
  let o: unknown;
  try {
    o = JSON.parse(output);
  } catch {
    return [];
  }
  const families = (o as { families?: unknown } | null)?.families;
  if (!Array.isArray(families)) return [];
  type Variant = { uid: string; label: string; window: number; free: boolean };
  type Family = { id: string; label: string; variants: Variant[] };
  const word = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const read: Family[] = [];
  for (const f of families) {
    const r = f as Record<string, unknown> | null;
    const id = word(r?.family_uid, 80);
    if (!id || !/^[\w.:-]{1,80}$/.test(id) || !Array.isArray(r?.variants)) continue;
    const variants: Variant[] = [];
    for (const v of r.variants as unknown[]) {
      const x = v as Record<string, unknown> | null;
      const uid = word(x?.model_uid, 120);
      if (!uid || !/^[\w.:-]{1,120}$/.test(uid)) continue;
      const window = typeof x?.max_context_tokens === "number" ? Math.round(x.max_context_tokens) : 0;
      variants.push({ uid, label: word(x?.label, 80), window, free: x?.cost_tier === "Free" });
    }
    if (variants.length) read.push({ id, label: word(r.family_label, 80) || id, variants });
  }
  // Fusion: one model per main family, with the free helper.
  const familyOfUid = new Map<string, Family>();
  for (const f of read) if (f.id !== "fusion") for (const v of f.variants) familyOfUid.set(v.uid, f);
  const fused = new Map<string, Family>();
  for (const v of read.find((f) => f.id === "fusion")?.variants ?? []) {
    if (!v.uid.endsWith(DEVIN_FUSION_HELPER)) continue;
    const main = familyOfUid.get(v.uid.slice("fusion-".length, -DEVIN_FUSION_HELPER.length));
    if (!main) continue;
    const id = `fusion-${main.id}`.slice(0, 80);
    const f = fused.get(id) ?? { id, label: `Fusion · ${main.label}`, variants: [] };
    f.variants.push({ ...v, free: false });
    fused.set(id, f);
  }
  const all = [...read.filter((f) => f.id !== "fusion"), ...fused.values()];
  const out: CursorModelInfo[] = [];
  for (const f of all) {
    const variants = f.variants.slice(0, DEVIN_MAX_VARIANTS);
    const kinds = variants.map((v) => devinVariantOf(v.uid));
    const standard = variants.filter((_, i) => !kinds[i]?.fast);
    const efforts = DEVIN_LEVELS.filter((l) => kinds.some((k) => !k.fast && k.level === l));
    const window = Math.max(0, ...variants.map((v) => v.window));
    out.push({
      id: f.id,
      label: f.label.slice(0, CURSOR_MODEL_LIMITS.label),
      ...(standard.length > 0 && standard.every((v) => v.free) ? { free: true } : {}),
      ...(efforts.length ? { efforts: [...efforts] } : {}),
      ...(kinds.some((k) => k.fast) ? { fast: true } : {}),
      ...(window > 0 ? { contextWindow: window } : {}),
      variants: variants.map((v) => v.uid),
    });
    if (out.length >= DEVIN_MAX_FAMILIES) break;
  }
  return out;
}

/**
 * One CLI's look: what it found, and whether it couldn't tell (then the last good look stands). `exited`: unsure
 * because `--version` failed with an exit code, counted toward `EXECUTORS_EXIT_STRIKES`.
 */
type Probe = { entry?: RunnerExecutorInfo; unsure?: boolean; exited?: boolean; said?: string };

/** The last line a failing CLI wrote (its error), else its exit code. */
const errorLine = (r: RunResult) =>
  `${r.stderr ?? ""}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, CLI_ERROR_MAX) || `exit code ${r.status}`;

const versionFailed = (r: RunResult): Probe =>
  missing(r) ? {} : r.error ? { unsure: true } : { unsure: true, exited: true, said: errorLine(r) };

const firstLine = (r: RunResult) => r.stdout.trim().split("\n")[0]?.trim().slice(0, 80) ?? "";

/** A version anywhere in a `--version` output: a warning may come first, or the CLI may write it to stderr. */
const VERSION = /\d+\.\d+\.\d+[\w.+-]*/;

/** The `--version` line that holds a version, else its first line; "unknown" when it printed nothing. */
export function versionLine(r: Pick<RunResult, "stdout" | "stderr">): string {
  const lines = `${r.stdout}\n${r.stderr ?? ""}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.find((l) => VERSION.test(l)) ?? lines[0] ?? "unknown").slice(0, 80);
}

/** `a` is a newer version than `b`; a line with no version in it is older than any. */
export function newerVersion(a: string, b: string): boolean {
  const parts = (s: string) => VERSION.exec(s)?.[0].split(/\D+/).slice(0, 3).map(Number) ?? [-1];
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * The line of a Codex that refused its command line (a flag or subcommand it doesn't have yet, in clap's words), as it
 * said it; null for any other failure.
 */
export function codexRefusal(stderr: string): string | null {
  const line = /^error: (?:unexpected argument|unrecognized subcommand|invalid value)\b.*$/m.exec(stderr)?.[0];
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Every `codex` this runner could start, each once: the PATH in order, then the usual install folders. Never one in
 * the shared `bin/` (the agents write there) or in a folder that isn't a full path.
 */
export function codexCandidates(
  pathList = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
  sharedBin = process.env[SHARED_BIN_ENV],
  ownHome: string | null = codexForAgents ? homedir() : null,
): string[] {
  if (platform === "win32") return [];
  const dirs = [...pathList.split(delimiter), ...usualDirs()].filter(
    (d) => isAbsolute(d) && d !== sharedBin && !(ownHome && d.startsWith(`${ownHome}/`)),
  );
  // The runner's own copy (`setCliPick`) too: it is there because the person's is older, so the newest wins it.
  const copy = cliPicks.get("codex");
  return [...new Set([...dirs.map((d) => join(d, "codex")), ...(copy ? [copy] : [])])].filter(
    (f) => isFile(f) && isExecutable(f),
  );
}

/**
 * System mode: agents' users start the `codex` the look chooses (`resolveCommand`), so one in the runner's own home,
 * which they can't enter, is never a candidate; it is `CLI_HOME_ONLY` instead.
 */
let codexForAgents = false;
export function setCodexForAgents(system: boolean) {
  codexForAgents = system;
}

/**
 * The `codex` the last look chose (`detectCodex`): `resolveCommand` starts this one, so a turn runs the Codex whose
 * version was reported, never an older copy earlier on the PATH.
 */
let codexPick: string | undefined;

/** The `codex` the last look chose, while it is still there. */
export function pickedCodex(): string | undefined {
  return codexPick && isExecutable(codexPick) ? codexPick : undefined;
}

/** Each copy's `--version`; the newest that answers wins (the first on the PATH among equals), with its path. */
async function detectCodex(run: Run, bins: string[]): Promise<Probe> {
  const looks = await Promise.all(bins.map(async (path) => ({ path, r: await run(path, ["--version"]) })));
  const ok = looks
    .filter(({ r }) => !r.error && r.status === 0)
    .map(({ path, r }) => ({ path, version: versionLine(r) }));
  const best = ok.reduce<(typeof ok)[number] | undefined>(
    (a, b) => (!a || newerVersion(b.version, a.version) ? b : a),
    undefined,
  );
  codexPick = best?.path;
  if (best) return { entry: best };
  return looks[0] ? versionFailed(looks[0].r) : detectVersion(run, "codex");
}

/**
 * How the computer's own Codex is signed in, asked of its app-server (`readCodexAccount`, given by the daemon: this
 * module can't import the app-server's client); null when it couldn't tell.
 */
export type CodexSignInProbe = (bin: string, version: string) => Promise<CodexSignIn | null>;

/**
 * The computer's own Codex with how it is signed in (`loggedIn`, `authMethod`, `plan`), so the apps offer it as a sign-in
 * of the computer's own the way they offer Claude Code's: by its app-server when it answers (an API key and a model
 * provider of the person's own count), else by `codex login status`. Only the app-server is believed on "signed out":
 * `codex login status` says that of a model provider that needs no sign-in, and Codex turns never waited on it.
 */
async function withCodexSignIn(run: Run, probe: Probe, ask: CodexSignInProbe): Promise<Probe> {
  const entry = probe.entry;
  if (!entry) return probe;
  const bin = entry.path ?? "codex";
  const read = await ask(bin, entry.version).catch(() => null);
  const said =
    read ??
    (await Promise.resolve(run(bin, ["login", "status"]))
      .then((r) => (r.error ? null : codexLoginStatusOf(r.status, `${r.stdout}\n${r.stderr ?? ""}`)))
      .catch(() => null));
  if (!said || (!said.loggedIn && !read)) return probe;
  return {
    ...probe,
    entry: {
      ...entry,
      loggedIn: said.loggedIn,
      ...(said.authMethod ? { authMethod: said.authMethod } : {}),
      ...(said.plan ? { plan: said.plan } : {}),
    },
  };
}

/** `<bin> --version` checked against `shape`, then `<bin> models` (none when signed out or offline). */
async function detectWithModels(
  run: Run,
  bin: string,
  shape: RegExp,
  parse: (output: string) => CursorModelInfo[],
  modelsArgs: (version: string) => string[] = () => ["models"],
): Promise<Probe> {
  const r = await run(bin, ["--version"]);
  if (r.error || r.status !== 0) return versionFailed(r);
  const version = firstLine(r);
  if (!shape.test(version)) return {};
  const m = await run(bin, modelsArgs(version));
  const models = !m.error && m.status === 0 ? parse(m.stdout) : [];
  return {
    entry: { version, ...(models.length ? { models } : {}) },
    ...(m.error && !missing(m) ? { unsure: true } : {}),
  };
}

async function detectVersion(run: Run, name: "claude" | "codex"): Promise<Probe> {
  const r = await run(name, ["--version"]);
  if (r.error || r.status !== 0) return versionFailed(r);
  const version = versionLine(r);
  if (name !== "claude") return { entry: { version } };
  const auth = await claudeAuth(run);
  return auth ? { entry: { version, ...auth } } : { entry: { version }, unsure: true };
}

/** Each CLI by its command: any of them may be in the home's own install folders (`~/.local/bin`…) only. */
const HOME_INSTALLED = {
  claude: "claude",
  codex: "codex",
  cursor: CURSOR_BIN,
  opencode: OPENCODE_BIN,
  grok: GROK_BIN,
  antigravity: AGY_BIN,
  devin: DEVIN_BIN,
} as const;

/** `bin` in the install folders under `home` (`~/.local/bin`…), which other users can't reach; null: none there. */
export function inHomeDirs(bin: string, home = homedir(), isExe: (file: string) => boolean = isExecutable) {
  return (
    usualDirs(home)
      .filter((dir) => dir.startsWith(`${home}/`))
      .map((dir) => join(dir, bin))
      .find(isExe) ?? null
  );
}

/**
 * Every CLI looked up at once. One that couldn't tell keeps its entry from `prev` (the last good look), and the
 * whole look is `unsure`, so it is retried soon instead of cached. `strikes` counts each CLI's failing exits in a
 * row across looks (the caller keeps it). A CLI whose `--version` fails with no good look to keep, or past its
 * strikes, is `broken` with its error line: it is there and can't start, which is not missing. Claude Code on Windows
 * says why only through `gitMissing`: without Git for Windows it can't start at all. `homeOnly`: a CLI of
 * `HOME_INSTALLED` not found is in the runner's own home only (system mode), `CLI_HOME_ONLY`. `codexSignIn`: how the
 * computer's own Codex is signed in is asked too (`withCodexSignIn`); left out, only its version.
 */
export async function detectExecutors(
  run: Run = defaultRun,
  prev: Executors = {},
  strikes: Partial<Record<string, number>> = {},
  gitMissing: () => boolean = () => false,
  codexBins: () => string[] = run === defaultRun ? codexCandidates : () => [],
  homeOnly: (bin: string) => boolean = () => false,
  codexSignIn?: CodexSignInProbe,
): Promise<{ found: Executors; unsure: boolean }> {
  const safe = (p: () => Promise<Probe>) => p().catch((): Probe => ({ unsure: true }));
  const names = ["claude", "codex", "cursor", "opencode", "grok", "antigravity", "devin"] as const;
  const codex = async () => {
    const probe = await detectCodex(run, codexBins());
    return codexSignIn ? withCodexSignIn(run, probe, codexSignIn) : probe;
  };
  const probes = await Promise.all([
    safe(() => detectVersion(run, "claude")),
    safe(codex),
    safe(() => detectCursor(run)),
    safe(() => detectOpencode(run)),
    safe(() => detectGrok(run)),
    safe(() => detectAntigravity(run)),
    safe(() => detectDevin(run)),
  ]);
  const found: Executors = {};
  const broken: NonNullable<Executors["broken"]> = {};
  let unsure = false;
  names.forEach((name, i) => {
    let p = probes[i] ?? {};
    strikes[name] = p.exited ? (strikes[name] ?? 0) + 1 : 0;
    const struck = (strikes[name] ?? 0) >= EXECUTORS_EXIT_STRIKES;
    if (p.said && (struck || !prev[name])) broken[name] = name === "claude" && gitMissing() ? CLI_GIT_MISSING : p.said;
    if (struck) p = {};
    const entry = p.unsure ? (prev[name] ?? p.entry) : p.entry;
    if (entry) found[name] = entry;
    if (p.unsure) unsure = true;
  });
  for (const [name, bin] of Object.entries(HOME_INSTALLED) as [keyof typeof HOME_INSTALLED, string][]) {
    if (!found[name] && !broken[name] && homeOnly(bin)) broken[name] = CLI_HOME_ONLY;
  }
  if (Object.keys(broken).length) found.broken = broken;
  return { found, unsure };
}

/** The last list kept on disk, believed only as far as `hello` would carry it; null when there is none. */
function keptExecutors(file: string): Executors | null {
  const kept = readSmallJson(file, 1024 * 1024);
  return kept && typeof kept === "object" && !Array.isArray(kept)
    ? parseExecutors(kept as Record<string, unknown>)
    : null;
}

export interface ExecutorsCache {
  /** The last known list, at once; a look starts in the background when it is due. */
  (): Executors;
  /** False until a list is known (kept on disk or looked up): an empty list then means "not looked yet", not "none". */
  readonly known: boolean;
  /** The list, waiting for the first look when none is known yet. */
  ready(): Promise<Executors>;
  /** A look now, whatever the TTL says (the app's "Check again" after an install). */
  fresh(): Promise<Executors>;
}

/**
 * `detectExecutors` in the background, looked up again only after the TTL (sooner after an unsure look). `file`
 * keeps the last list across restarts, so the first `hello` after one already has it; `onChange` hears of a list
 * that changed.
 */
export function cachedExecutors(
  opts: {
    now?: () => number;
    run?: Run;
    file?: string;
    onChange?: (found: Executors) => void;
    /** Before each look (Windows: the PATH read again, so a CLI installed since is found). */
    before?: () => void;
    gitMissing?: () => boolean;
    /** System mode: a CLI found only in root's own install folders (`CLI_HOME_ONLY`). */
    homeOnly?: (bin: string) => boolean;
    /** How the computer's own Codex is signed in (`readCodexAccount`); left out, only its version. */
    codexSignIn?: CodexSignInProbe;
    /** System mode: each look as the agents reach it (`agentsReach`), never what root alone can start. */
    reach?: (found: Executors) => Promise<Executors>;
  } = {},
): ExecutorsCache {
  const now = opts.now ?? Date.now;
  const kept = opts.file ? keptExecutors(opts.file) : null;
  let value: Executors = kept ?? {};
  let known = kept !== null;
  let at = Number.NEGATIVE_INFINITY;
  let wait = EXECUTORS_TTL_MS;
  let retry = 0;
  let running: Promise<Executors> | null = null;
  const strikes: Partial<Record<string, number>> = {};
  const look = (): Promise<Executors> =>
    (running ??= Promise.resolve()
      .then(() => opts.before?.())
      .catch(() => undefined)
      .then(() =>
        detectExecutors(opts.run, value, strikes, opts.gitMissing, undefined, opts.homeOnly, opts.codexSignIn),
      )
      .then(async (look) => (opts.reach ? { ...look, found: await opts.reach(look.found) } : look))
      .then(({ found, unsure }) => {
        at = now();
        retry = unsure ? Math.min(retry ? retry * 2 : EXECUTORS_RETRY_MS, EXECUTORS_TTL_MS) : 0;
        wait = retry || EXECUTORS_TTL_MS;
        if (unsure) setTimeout(() => void look(), wait).unref?.();
        const changed = !known || JSON.stringify(found) !== JSON.stringify(value);
        value = found;
        known = true;
        if (changed) {
          if (opts.file) {
            try {
              writeJson(opts.file, found);
            } catch {}
          }
          try {
            opts.onChange?.(found);
          } catch {}
        }
        return value;
      })
      .finally(() => {
        running = null;
      }));
  const get = (() => {
    if (now() - at >= wait) void look();
    return value;
  }) as ExecutorsCache;
  get.ready = () => (known ? Promise.resolve(get()) : look());
  get.fresh = look;
  Object.defineProperty(get, "known", { get: () => known });
  return get;
}

/**
 * `codex --version` alone, for a Codex turn: a good answer is kept for the TTL; null when it couldn't tell (timed
 * out, failed), never cached.
 */
export function cachedCodexVersion(
  run: Run = defaultRun,
  now: () => number = Date.now,
  codexBins: () => string[] = run === defaultRun ? codexCandidates : () => [],
) {
  let kept: { version?: string; at: number } | undefined;
  return async (): Promise<string | undefined | null> => {
    if (kept && now() - kept.at < EXECUTORS_TTL_MS) return kept.version;
    const p = await detectCodex(run, codexBins()).catch((): Probe => ({ unsure: true }));
    if (p.unsure) return null;
    kept = { ...(p.entry ? { version: p.entry.version } : {}), at: now() };
    return kept.version;
  };
}
