import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_DESKTOP_SHA256,
  AGENT_DESKTOP_VERSION,
  type AgentDesktopTarget,
  type AgentScope,
  APPS_LIMITS,
  type AppsCommand,
  type AppsRunReply,
  agentDesktopUrl,
  isAppsCommand,
  type OsPermission,
  type RunnerTerminalInfo,
} from "@agenteschat/adapters/machine-protocol";
import type { ControlAppUse } from "@agenteschat/adapters/runner-control";
import { unpackCommand } from "./cli-copies";
import { RunnerError } from "./errors";

/**
 * The person's own apps, for agents (ADR 0258): the pinned `agent-desktop` CLI reads an app's accessibility tree
 * and acts on its elements by ref through the accessibility API, so the person's pointer and keyboard stay theirs.
 * Agents never reach the CLI: the server sends one command at a time (`apps.run`) and this adds the flags that
 * matter and refuses the rest:
 *
 * - Only `APPS_COMMANDS`, only the flags in `FLAGS`: never `--headed` (real input), coordinates, `--force`, a window
 *   by id, `--activate`, sessions, the clipboard.
 * - The agentes.chat app is never read or acted on (an agent must never click its own approval): an app named so is
 *   refused, and so is the person's web browser, where agentes.chat runs signed in as them (agents browse in their
 *   own browser). A snapshot of either is dropped, and so is one whose window shows agentes.chat.
 * - A ref acts only when this agent's own snapshot of an allowed app gave it.
 * - Text to type goes on the CLI's stdin, never in its arguments. Nothing it prints is logged.
 * - Each agent has a state root of its own (its snapshots), under the runner's home.
 * - Binary: the desktop app's sidecar next to the runner (signed with the app, so macOS credits Accessibility to
 *   agentes.chat), else the pinned release archive in `<runner home>/bin/`, checked against its SHA-256 first.
 */

/** Flags a command may carry, and what follows each: a value, a ref of the agent's, or nothing. */
const FLAGS: Readonly<Record<string, "value" | "ref" | "bare">> = {
  "--app": "value",
  "--role": "value",
  "--name": "value",
  "--value": "value",
  "--text": "value",
  "--exact": "bare",
  "--root": "ref",
  "--surface": "value",
  "--first": "bare",
  "--limit": "value",
  "-i": "bare",
  "--compact": "bare",
  "--skeleton": "bare",
  "--max-depth": "value",
  "--property": "value",
  "--direction": "value",
  "--amount": "value",
};

/** What each command takes before its flags: a ref, an app's name, or a word (an option, a key). */
const POSITIONAL: Readonly<Record<AppsCommand, readonly ("ref" | "app" | "word")[]>> = {
  "list-apps": [],
  "list-windows": [],
  snapshot: [],
  find: [],
  get: ["ref"],
  is: ["ref"],
  click: ["ref"],
  "double-click": ["ref"],
  "right-click": ["ref"],
  type: ["ref"],
  "set-value": ["ref"],
  clear: ["ref"],
  focus: ["ref"],
  select: ["ref", "word"],
  toggle: ["ref"],
  check: ["ref"],
  uncheck: ["ref"],
  expand: ["ref"],
  collapse: ["ref"],
  scroll: ["ref"],
  "scroll-to": ["ref"],
  press: ["word"],
  launch: ["app"],
  "close-app": ["app"],
};

/** Commands that name their app with `--app`, which they need: without it the CLI reads whatever is in front. */
const NEEDS_APP: ReadonlySet<AppsCommand> = new Set(["snapshot", "find", "press"]);
/** Commands whose text goes on stdin. */
const TAKES_TEXT: ReadonlySet<AppsCommand> = new Set(["type", "set-value"]);
/** Commands that only read: they don't mark the agent as using the app. */
const READS: ReadonlySet<AppsCommand> = new Set(["list-apps", "list-windows", "snapshot", "find", "get", "is"]);

/** agentes.chat itself, by display name, bundle id (`chat.agentes.desktop`) or executable (`agentes-runner`). */
const OURS = /agentes/i;
/**
 * The person's web browsers, by the names `list-apps` and `launch` take (macOS, Windows, Linux) and bundle ids. Our web
 * app runs in them signed in as the person, and its tab titles don't name us ("#general · Acme"), so a window title
 * can't tell it apart.
 * ponytail: a list of names; an unlisted browser still falls to `OUR_WINDOW` only. Upgrade: read the address bar.
 */
const BROWSERS =
  /chrome|chromium|safari|firefox|microsoft edge|msedge|edgemac|\bbrave\b|\bopera\b|vivaldi|\barc\b|thebrowser|\borion\b|zen browser|app\.zen|duckduckgo|yandex|tor browser|waterfox|librewolf|floorp|thorium|sidekick|sigmaos|epiphany|falkon|midori|konqueror|\bcomet\b|chatgpt atlas|iexplore|internet explorer/i;
/** A window showing our web app where its title still names us (the default tab title, a page's own). */
const OUR_WINDOW = /agentes\.chat/i;
const REF = /^@([a-z0-9]{1,40}):e\d{1,6}$/;
const ACT_TIMEOUT_MS = 60_000;
/** `launch` waits up to 30 s for the app on its own. */
const LAUNCH_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const RETRY_FAILURE_MS = 10 * 60_000;
/** Most of what one command may print (a big app's snapshot). */
const MAX_OUTPUT = 8 << 20;
/** Snapshots kept per agent: refs of older ones are refused (the CLI prunes them too). */
const SNAPSHOTS_KEPT = 50;
/** An app counts as in use this long after the agent's last command in it. */
export const APPS_USE_MS = 5 * 60_000;
/**
 * The menu bar's Stop refuses that agent's commands in the person's apps this long.
 * ponytail: a fixed pause; a "Let it continue" in the menu bar if people want it back sooner.
 */
export const APPS_STOP_MS = 10 * 60_000;

export function agentDesktopTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): AgentDesktopTarget | null {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `${cpu}-apple-darwin`;
  if (platform === "win32") return `${cpu}-pc-windows-msvc`;
  if (platform === "linux") return `${cpu}-unknown-linux-gnu`;
  return null;
}

const exeName = (platform: string) => `agent-desktop${platform === "win32" ? ".exe" : ""}`;

export interface AppControlOptions {
  /** The runner's home: `bin/` for the download, `apps/<agent>/` for each agent's snapshots. */
  home: string;
  log: (line: string) => void;
  /** Each agent works as its own OS user here: the person's session isn't theirs to drive. */
  systemMode?: boolean;
  /** The agentes.chat app runs this runner: a missing OS permission becomes a wait the app asks the person for. */
  needs?: (permission: OsPermission, trigger: string, agentId: string) => void;
  /** The apps in use changed (the menu bar's line). */
  onChange?: () => void;
  /** Tests: how to start `agent-desktop` (default: the sidecar or the downloaded binary). */
  command?: string[];
  /** The runner's executable (the sidecar sits next to it). */
  execPath?: string;
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

interface AgentState {
  /** Snapshot id → the app it read, newest last. */
  snapshots: Map<string, string>;
  use?: { app: string; at: number };
  stoppedUntil?: number;
}

export class AppControl {
  private readonly agents = new Map<string, AgentState>();
  private readonly platform: string;
  private readonly now: () => number;
  private binary: string | null = null;
  private ready: Promise<string> | null = null;
  private failure: { reason: string; at: number } | null = null;

  constructor(private readonly opts: AppControlOptions) {
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
  }

  /** `hello.apps`: whether agents can use the person's apps here (cheap: nothing is started). */
  info(): RunnerTerminalInfo {
    if (this.opts.systemMode) {
      return {
        available: false,
        code: "apps_own_users",
        reason: "Agents work as their own users on this computer, so the person's apps aren't theirs to use",
      };
    }
    const env = this.opts.env ?? process.env;
    if (this.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return { available: false, code: "apps_no_display", reason: "This computer has no graphical session" };
    }
    if (!this.opts.command && !this.bundled() && !agentDesktopTarget(this.platform, this.opts.arch)) {
      return { available: false, code: "apps_unsupported", reason: `Not on this system (${this.platform})` };
    }
    const recent = this.recentFailure();
    if (recent) return { available: false, code: "apps_download", reason: recent.reason };
    return { available: true };
  }

  /** The agents using the person's apps lately, for the menu bar. */
  using(): ControlAppUse[] {
    const out: ControlAppUse[] = [];
    for (const [agentId, s] of this.agents) {
      if (s.use && this.now() - s.use.at < APPS_USE_MS) {
        out.push({ agentId, app: s.use.app, actedAt: new Date(s.use.at).toISOString() });
      }
    }
    return out;
  }

  /** The menu bar's Stop: the agent's commands in the person's apps are refused for a while. */
  stop(agentId: string): { stopped: boolean } {
    const s = this.state(agentId);
    const was = s.use !== undefined;
    s.stoppedUntil = this.now() + APPS_STOP_MS;
    s.use = undefined;
    if (was) this.opts.onChange?.();
    return { stopped: true };
  }

  /** `apps.run`: one command for `agent`, after the checks. A failure the CLI reports is an answer, not a throw. */
  async run(
    agent: AgentScope,
    req: { command: unknown; args: unknown; text?: unknown },
    signal?: AbortSignal,
  ): Promise<AppsRunReply> {
    const info = this.info();
    if (!info.available) throw new RunnerError("unsupported", info.reason ?? "Agents can't use apps here");
    const s = this.state(agent.id);
    if (s.stoppedUntil && this.now() < s.stoppedUntil) {
      throw new RunnerError(
        "not_allowed",
        "The person at this computer stopped you from using their apps. Don't try again unless they ask you to.",
      );
    }
    const { command, args, text, app } = this.checked(s, req);
    const argv = [command, ...args, ...(text !== undefined ? ["--stdin"] : [])];
    const bin = await this.ensureReady();
    const state = path.join(this.opts.home, "apps", agent.id.replace(/[^A-Za-z0-9-]/g, ""));
    await mkdir(state, { recursive: true, mode: 0o700 });
    if (!READS.has(command) && app) this.used(s, app);
    const out = await this.spawn(
      [...bin, ...argv],
      { AGENT_DESKTOP_HOME: state },
      text,
      command === "launch" ? LAUNCH_TIMEOUT_MS : ACT_TIMEOUT_MS,
      signal,
    );
    const reply = parseEnvelope(out.stdout, out.code);
    if (!reply.ok) {
      if (reply.error.code === "PERM_DENIED") this.opts.needs?.("accessibility", `agent-desktop ${command}`, agent.id);
      return reply;
    }
    if (command === "snapshot" || command === "find") return this.keepSnapshot(s, reply, app);
    return reply;
  }

  // ── Checks ─────────────────────────────────────────────────────────────────

  private checked(s: AgentState, req: { command: unknown; args: unknown; text?: unknown }) {
    if (!isAppsCommand(req.command)) throw new RunnerError("bad_request", "Not a command agents may run in apps");
    const command = req.command;
    const raw = req.args;
    if (!Array.isArray(raw) || raw.length > APPS_LIMITS.args || raw.some((a) => typeof a !== "string")) {
      throw new RunnerError("bad_request", "`args` must be a short list of strings");
    }
    const args = raw as string[];
    if (args.some((a) => a.length > APPS_LIMITS.arg || a.includes("\0"))) {
      throw new RunnerError("bad_request", "An argument is too long");
    }
    let text: string | undefined;
    if (req.text !== undefined) {
      if (!TAKES_TEXT.has(command) || typeof req.text !== "string" || req.text.length > APPS_LIMITS.text) {
        throw new RunnerError("bad_request", "Only `type` and `set-value` take text, up to 4,000 characters");
      }
      text = req.text;
    } else if (TAKES_TEXT.has(command)) {
      throw new RunnerError("bad_request", "`type` and `set-value` need `text`");
    }
    let app: string | undefined;
    const positional = POSITIONAL[command];
    for (const [i, kind] of positional.entries()) {
      const a = args[i];
      if (a === undefined || a.startsWith("-")) throw new RunnerError("bad_request", `${command} needs its ${kind}`);
      if (kind === "ref") app = this.refApp(s, a);
      if (kind === "app") app = this.allowedApp(a);
    }
    for (let i = positional.length; i < args.length; i++) {
      const flag = args[i] as string;
      const kind = FLAGS[flag];
      if (!kind) throw new RunnerError("not_allowed", `${flag} isn't allowed here`);
      if (kind === "bare") continue;
      const value = args[++i];
      if (value === undefined) throw new RunnerError("bad_request", `${flag} needs a value`);
      if (kind === "ref") this.refApp(s, value);
      if (flag === "--app") app = this.allowedApp(value);
    }
    if (NEEDS_APP.has(command) && !args.includes("--app")) {
      throw new RunnerError("bad_request", `${command} needs --app: the app to read or act in`);
    }
    return { command, args, text, app };
  }

  private allowedApp(name: string): string {
    if (OURS.test(name)) throw new RunnerError("not_allowed", "agentes.chat itself is never used by agents");
    if (BROWSERS.test(name)) {
      throw new RunnerError(
        "not_allowed",
        "The person's web browser isn't yours to use: browse in your own browser (browser_do) instead",
      );
    }
    // A path would start any program: commands are run_code's.
    if (/[/\\]/.test(name)) throw new RunnerError("not_allowed", "Name the app as list-apps does, not a path");
    return name;
  }

  /** The app of the snapshot `ref` came from; refused unless this agent's own snapshot gave it. */
  private refApp(s: AgentState, ref: string): string {
    const snapshot = REF.exec(ref)?.[1];
    const app = snapshot ? s.snapshots.get(snapshot) : undefined;
    if (!app) {
      throw new RunnerError(
        "not_allowed",
        `${ref} isn't from one of your snapshots here: take a snapshot of the app and use its refs`,
      );
    }
    return app;
  }

  /** A snapshot of an allowed app: its refs may act. One of agentes.chat (or a window showing it) never leaves. */
  private keepSnapshot(s: AgentState, reply: Extract<AppsRunReply, { ok: true }>, asked?: string): AppsRunReply {
    const data = isRecord(reply.data) ? reply.data : {};
    const app = typeof data.app === "string" ? data.app : asked;
    if ((app && (OURS.test(app) || BROWSERS.test(app))) || windowTitles(data).some((t) => OUR_WINDOW.test(t))) {
      return {
        ok: false,
        error: {
          code: "NOT_ALLOWED",
          message: "That window is agentes.chat itself, which agents never use",
          retry: "safe",
        },
      };
    }
    const id = typeof data.snapshot_id === "string" ? data.snapshot_id : null;
    if (id && app) {
      s.snapshots.delete(id);
      s.snapshots.set(id, app);
      while (s.snapshots.size > SNAPSHOTS_KEPT) s.snapshots.delete(s.snapshots.keys().next().value as string);
    }
    return reply;
  }

  private state(agentId: string): AgentState {
    let s = this.agents.get(agentId);
    if (!s) {
      s = { snapshots: new Map() };
      this.agents.set(agentId, s);
    }
    return s;
  }

  private used(s: AgentState, app: string) {
    const changed = s.use?.app !== app || this.now() - (s.use?.at ?? 0) >= APPS_USE_MS;
    s.use = { app, at: this.now() };
    if (changed) this.opts.onChange?.();
  }

  // ── Binary ─────────────────────────────────────────────────────────────────

  /** The desktop app's sidecar next to the runner, if there is one. */
  private bundled(): string | null {
    const file = path.join(path.dirname(this.opts.execPath ?? process.execPath), exeName(this.platform));
    return existsSync(file) ? file : null;
  }

  private ensureReady(): Promise<string[]> {
    if (this.opts.command) return Promise.resolve(this.opts.command);
    const recent = this.recentFailure();
    if (recent) return Promise.reject(new RunnerError("unsupported", recent.reason));
    this.ready ??= this.prepare().finally(() => {
      this.ready = null;
    });
    return this.ready.then((bin) => [bin]);
  }

  private async prepare(): Promise<string> {
    if (this.binary) return this.binary;
    const here = this.bundled();
    if (here) {
      this.binary = here;
      return here;
    }
    const target = agentDesktopTarget(this.platform, this.opts.arch);
    if (!target) throw this.fail(`agent-desktop doesn't run on this system (${this.platform})`);
    const dir = path.join(this.opts.home, "bin", `agent-desktop-${AGENT_DESKTOP_VERSION}`);
    const file = path.join(dir, exeName(this.platform));
    // The folder appears only by a rename after the archive matched its hash and unpacked.
    if (!existsSync(file)) await this.download(target, dir);
    this.binary = file;
    return file;
  }

  private async download(target: AgentDesktopTarget, dir: string) {
    const url = agentDesktopUrl(target);
    const want = AGENT_DESKTOP_SHA256[target];
    this.opts.log(`downloading agent-desktop ${AGENT_DESKTOP_VERSION} (${target})`);
    let bytes: Buffer;
    try {
      const res = await (this.opts.fetch ?? fetch)(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      throw this.fail(`Couldn't download agent-desktop: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== want) {
      throw this.fail("The agent-desktop download didn't match its checksum, so it was not used");
    }
    const staging = `${dir}.${process.pid}.tmp`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const archive = path.join(staging, "agent-desktop.tar.gz");
      await writeFile(archive, bytes);
      const [tar, tarArgs] = unpackCommand(
        archive,
        staging,
        { url, hash: { algorithm: "sha256", value: want }, archive: "tar.gz", executable: exeName(this.platform) },
        this.platform as NodeJS.Platform,
        this.opts.env,
      );
      const unpacked = await this.spawn([tar, ...tarArgs], {}, undefined, DOWNLOAD_TIMEOUT_MS);
      if (unpacked.code !== 0) throw new Error(`tar exited with ${unpacked.code}`);
      await rm(archive, { force: true });
      await rename(staging, dir);
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw this.fail(`Couldn't unpack agent-desktop: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private fail(reason: string) {
    this.failure = { reason: reason.slice(0, 400), at: this.now() };
    return new RunnerError("unsupported", this.failure.reason);
  }

  private recentFailure() {
    return this.failure && this.now() - this.failure.at < RETRY_FAILURE_MS ? this.failure : null;
  }

  // ── Process ────────────────────────────────────────────────────────────────

  /** Runs it with `text` on stdin; what it prints stays here (customer content: never logged). */
  private spawn(
    argv: string[],
    env: Record<string, string>,
    text: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; code: number | null }> {
    const [file, ...args] = argv as [string, ...string[]];
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        env: { ...withoutOwnVars(this.opts.env ?? process.env), ...env },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const abort = () => child.kill("SIGKILL");
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_OUTPUT) chunks.push(c);
        else child.kill("SIGKILL");
      });
      // Through EventEmitter: some @types/node versions lose ChildProcess's event methods.
      const events = child as unknown as EventEmitter;
      events.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(new RunnerError("unsupported", `agent-desktop didn't start: ${err.message}`.slice(0, 400)));
      });
      events.on("close", (code: number | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve({ stdout: Buffer.concat(chunks).toString("utf8"), code });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(text ?? "");
    });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * The window titles a read names: a snapshot's `window` and its tree's window root, and each `find` match's path
 * (`window:<title>`, its only mention of the window).
 */
function windowTitles(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (isRecord(data.window) && typeof data.window.title === "string") out.push(data.window.title);
  if (isRecord(data.tree) && data.tree.role === "window" && typeof data.tree.name === "string")
    out.push(data.tree.name);
  const matches = Array.isArray(data.matches) ? data.matches : isRecord(data.match) ? [data.match] : [];
  for (const m of matches) {
    if (!isRecord(m) || !Array.isArray(m.path)) continue;
    for (const step of m.path) if (typeof step === "string" && step.startsWith("window:")) out.push(step.slice(7));
  }
  return out;
}

/** The CLI's own variables (a session, an agent id, another state root, a helper) come only from here. */
const withoutOwnVars = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith("AGENT_DESKTOP_")));

/** `agent-desktop`'s one JSON envelope (its last line), or a failure built from its exit. */
export function parseEnvelope(stdout: string, code: number | null): AppsRunReply {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, error: { code: "INTERNAL", message: `agent-desktop exited with ${code} and no answer` } };
  }
  if (isRecord(v) && v.ok === true) return { ok: true, data: v.data ?? null };
  const e = isRecord(v) && isRecord(v.error) ? v.error : {};
  const d = isRecord(e.disposition) ? e.disposition.retry : undefined;
  return {
    ok: false,
    error: {
      code: typeof e.code === "string" ? e.code.slice(0, 40) : "INTERNAL",
      message: typeof e.message === "string" ? e.message.slice(0, 1000) : "agent-desktop failed",
      ...(d === "safe" || d === "unsafe" || d === "unknown" ? { retry: d } : {}),
    },
  };
}
