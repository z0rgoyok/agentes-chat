import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  lchown,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { CliFetchFailure, CliFetchState, FetchName, RunnerClisInfo } from "@agenteschat/adapters/machine-protocol";
import {
  CLI_NO_SELF_UPDATE,
  CLI_PINS,
  type CliBuild,
  type CliPin,
  type CliPins,
  ownCopyServes,
  PIN_CLIS,
  type PinCli,
  type PinPlatform,
  parseCliPins,
  pinPlatformOf,
} from "@agenteschat/providers/cli-pins";
import { GIT_BASH_PICK, gitBashPath } from "./cli-install";
import { RunnerError } from "./errors";
import { envValue, isExecutable, ownCommand, setCliPick } from "./executors";

/**
 * The one way this runner gets its coding CLIs (ADR 0228 §6). For each CLI the pin list names one version and each
 * system's build at the vendor's address with its hash (`@agenteschat/providers/cli-pins`; the server sends its own,
 * `clis.pins`, kept in `cli-pins.json`). The person's own copy runs when it is at that version or newer; otherwise,
 * where the CLI is wanted (an account of it here, the person's older copy, or a turn or a sign-in asking), this
 * fetches the pinned build, checks its hash, unpacks it aside and moves it in place under the runner's home, and has
 * `resolveCommand` run it (`setCliPick`). One fetch per CLI at a time, a failed one waits `RETRY_MS` unless someone
 * asks again, and nothing here throws but `ensure`. Each fetch is told as it goes (`onFetch`, throttled by
 * `progressGate`). In system mode (`shared`) only where no agent's user reaches a copy of the CLI at all (the
 * computer's setup installs them, and they update themselves): root's, nobody else may change it, each linked from
 * `/usr/local/bin`, which is on every agent's PATH.
 */

/**
 * The command each CLI answers to on the PATH (Cursor's is `agent`; the Antigravity CLI's `agy`). Git for Windows'
 * bash is picked by a name of its own (`GIT_BASH_PICK`), never `git`: the runner's other `git` calls stay the PATH's.
 */
export const CLI_COMMAND: Readonly<Record<PinCli, string>> = {
  claude: "claude",
  codex: "codex",
  cursor: "agent",
  opencode: "opencode",
  grok: "grok",
  antigravity: "agy",
  devin: "devin",
  git: GIT_BASH_PICK,
};

/** Whether `name` is one the runner fetches (a request names it; the server's list may be newer than this runner). */
export const isPinCli = (name: string): name is PinCli => (PIN_CLIS as readonly string[]).includes(name);

/** The CLI a brain thinks with. */
export const CLI_OF_BRAIN: Readonly<Record<string, PinCli>> = {
  claude_code: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  grok: "grok",
  antigravity: "antigravity",
  devin: "devin",
};

/** A download, its unpacking and their checks take at most this long (a slow line, a few hundred MB). */
const FETCH_MS = 20 * 60_000;
/** After a failed fetch, the next one that nobody asked for waits this long. */
export const RETRY_MS = 30 * 60_000;
/** A fetch's progress is told at most this often, or when it moved this much (percent). */
export const PROGRESS_MS = 1000;
export const PROGRESS_STEP = 5;

/** Tells a fetch's progress only after `PROGRESS_MS`, or `PROGRESS_STEP` percent more, since the last one told. */
export function progressGate(now: () => number = Date.now) {
  let at = Number.NEGATIVE_INFINITY;
  let pct = Number.NEGATIVE_INFINITY;
  return (done: number, total: number | null): boolean => {
    const t = now();
    const p = total ? (done / total) * 100 : 0;
    if (t - at < PROGRESS_MS && (!total || p - pct < PROGRESS_STEP)) return false;
    at = t;
    pct = p;
    return true;
  };
}

class FetchError extends Error {
  constructor(
    readonly reason: CliFetchFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Why a fetch failed, as the apps say it. */
function failureOf(err: unknown): CliFetchFailure {
  if (err instanceof FetchError) return err.reason;
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.code;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === "ENOSPC" || cause === "ENOSPC") return "disk_full";
  const net = new Set(["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH"]);
  if ((typeof code === "string" && net.has(code)) || (typeof cause === "string" && net.has(cause))) return "offline";
  if ((err as { name?: unknown } | null)?.name === "TimeoutError" || err instanceof TypeError) return "offline";
  return "failed";
}

/** The words a failure reads as in the runner's log and a turn's error. */
const FAILURE_WORDS: Record<CliFetchFailure, string> = {
  offline: "this computer couldn't reach the download",
  hash_mismatch: "the download didn't match the vendor's build, so it wasn't used",
  no_build: "there is no build of it for this computer's system",
  disk_full: "the disk is full",
  failed: "the download didn't finish",
};

export interface CliCopiesOptions {
  /** The runner's home: copies go in `clis/<cli>-<version>/`, the server's pins in `cli-pins.json`. */
  home: string;
  log: (line: string) => void;
  /** Whether a CLI is wanted here though no turn asks yet: an account of it on this computer. */
  inUse: (cli: PinCli) => boolean;
  /** A copy started or stopped being the one to run: the CLIs and the accounts' models are looked at again. */
  onChange: () => void;
  /** A fetch moved on (throttled), ended or failed: told to the server (`cli.fetch`). */
  onFetch: (cli: PinCli, state: CliFetchState) => void;
  /** Tests. */
  pins?: CliPins;
  platform?: PinPlatform | null;
  fetch?: typeof fetch;
  /** The person's own copy of `cli` and its `--version` line; null: none. In system mode: the copy the agents reach. */
  own?: (cli: PinCli, pinned: string) => Promise<{ file: string; version: string } | null>;
  /**
   * System mode: every agent's user runs the copies, so they are root's and closed to everyone else's writes, and each
   * is linked from `bin` (`/usr/local/bin`) unless something else is there.
   */
  shared?: { bin: string };
  now?: () => number;
}

export class CliCopies {
  private pins: CliPins;
  private readonly platform: PinPlatform | null;
  private running: Promise<void> | null = null;
  private readonly fetching = new Map<PinCli, Promise<string>>();
  private readonly failedAt = new Map<PinCli, number>();
  private readonly picked = new Map<PinCli, string | undefined>();
  private readonly states = new Map<PinCli, CliFetchState>();

  /** System mode: the copies are the agents' (`shared`). */
  readonly forAgents: boolean;

  constructor(private readonly opts: CliCopiesOptions) {
    this.forAgents = Boolean(opts.shared);
    this.platform = opts.platform === undefined ? thisPlatform() : opts.platform;
    this.pins = opts.pins ?? withKept(CLI_PINS, path.join(opts.home, "cli-pins.json"));
  }

  /** The CLIs fetched here on this system, and where each fetch stands (`hello.clis`). */
  info(): RunnerClisInfo {
    const fetchable = PIN_CLIS.filter((cli) => this.buildOf(cli)) as FetchName[];
    return { fetchable, fetch: Object.fromEntries(this.states) };
  }

  /** The server's pin list (`clis.pins`): each CLI it names replaces the built-in one, kept for the next start. */
  async setPins(raw: unknown) {
    const given = parseCliPins(raw);
    if (!given) return;
    const next = { ...CLI_PINS, ...given };
    if (JSON.stringify(next) === JSON.stringify(this.pins)) return;
    this.pins = next;
    await writeFile(path.join(this.opts.home, "cli-pins.json"), JSON.stringify(given), { mode: 0o600 }).catch(
      () => undefined,
    );
    void this.check();
  }

  /** Where `cli`'s pinned build goes. */
  file(cli: PinCli): string | null {
    const build = this.buildOf(cli);
    return build ? path.join(this.folder(cli), build.executable) : null;
  }

  /** Every CLI looked at (cheap until a fetch is due); one look at a time, never throws. */
  check(): Promise<void> {
    this.running ??= (async () => {
      for (const cli of PIN_CLIS) {
        await this.look(cli).catch((err: unknown) =>
          this.opts.log(`${cli}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(cli: PinCli) {
    const pin = this.pins[cli];
    const own = await this.ownOf(cli);
    if (own && ownCopyServes(pin, own.version)) return this.use(cli, undefined);
    const file = this.file(cli);
    if (!file) return this.use(cli, undefined);
    if (isExecutable(file)) return this.use(cli, file);
    if (!own && !this.opts.inUse(cli)) return;
    const failed = this.failedAt.get(cli);
    if (failed && this.now() - failed < RETRY_MS) return;
    await this.use(cli, await this.fetchOnce(cli));
  }

  /**
   * `cli` ready to run now, for a turn or a sign-in: the person's own when it serves, else the runner's copy, fetched
   * at once if it isn't here (no waiting out an earlier failure). Throws, in words for the person, when it can't be.
   */
  async ensure(cli: PinCli): Promise<void> {
    const own = await this.ownOf(cli);
    if (own && ownCopyServes(this.pins[cli], own.version)) return this.use(cli, undefined);
    const file = this.file(cli);
    if (!file) {
      if (own) return;
      throw new RunnerError("not_found", `${cliName(cli)} isn't on this computer, and ${FAILURE_WORDS.no_build}.`);
    }
    try {
      await this.use(cli, isExecutable(file) ? file : await this.fetchOnce(cli));
    } catch (err) {
      if (own) return;
      const why = FAILURE_WORDS[failureOf(err)];
      throw new RunnerError("internal", `Couldn't get ${cliName(cli)} ready on this computer: ${why}.`);
    }
  }

  /** The apps' "Try again": a fetch starts now, whatever an earlier failure said; answers where it stands. */
  retry(cli: PinCli): CliFetchState | null {
    if (!this.file(cli)) return { state: "failed", version: this.pins[cli].version, reason: "no_build" };
    this.failedAt.delete(cli);
    void this.ensure(cli).catch(() => undefined);
    return this.states.get(cli) ?? null;
  }

  private buildOf(cli: PinCli): CliBuild | undefined {
    return this.platform ? this.pins[cli].builds[this.platform] : undefined;
  }

  private folder(cli: PinCli) {
    return path.join(this.opts.home, "clis", `${cli}-${safeVersion(this.pins[cli].version)}`);
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async ownOf(cli: PinCli) {
    const own = await (this.opts.own ?? ownCopy)(cli, this.pins[cli].version);
    // The agents reaching the runner's own link to another pin's copy: kept to fall back on, never at this pin.
    return own && (await this.linkedElsewhere(cli)) ? { ...own, version: "" } : own;
  }

  /** System mode: `bin/<command>` is the runner's own link to a copy other than this pin's. */
  private async linkedElsewhere(cli: PinCli) {
    const bin = this.opts.shared?.bin;
    if (!bin) return false;
    const was = await readlink(path.join(bin, CLI_COMMAND[cli])).catch(() => null);
    return was !== null && this.runnerLink(was) && was !== this.file(cli);
  }

  private runnerLink(target: string) {
    return target.startsWith(path.join(this.opts.home, "clis") + path.sep);
  }

  /** One fetch per CLI at a time, whoever asks; its end (ready or failed) is told. */
  private fetchOnce(cli: PinCli): Promise<string> {
    let running = this.fetching.get(cli);
    if (!running) {
      const version = this.pins[cli].version;
      running = this.download(cli)
        .then((file) => {
          this.failedAt.delete(cli);
          this.tell(cli, { state: "ready", version });
          return file;
        })
        .catch((err: unknown) => {
          this.failedAt.set(cli, this.now());
          const reason = failureOf(err);
          this.opts.log(`${cli}: couldn't fetch ${version}: ${err instanceof Error ? err.message : String(err)}`);
          this.tell(cli, { state: "failed", version, reason });
          throw err;
        })
        .finally(() => this.fetching.delete(cli));
      this.fetching.set(cli, running);
    }
    return running;
  }

  private tell(cli: PinCli, state: CliFetchState) {
    this.states.set(cli, state);
    try {
      this.opts.onFetch(cli, state);
    } catch {}
  }

  private async use(cli: PinCli, file: string | undefined) {
    if (this.picked.has(cli) && this.picked.get(cli) === file) return;
    this.picked.set(cli, file);
    // Its own files to start with, relative to the copy's folder (Cursor's Windows `index.js`).
    const launch = file ? (this.buildOf(cli)?.launch ?? []).map((f) => path.join(this.folder(cli), f)) : [];
    setCliPick(CLI_COMMAND[cli], file, launch);
    if (file && this.opts.shared) await this.link(cli, file);
    this.opts.log(
      file ? `${cli}: running the runner's own ${this.pins[cli].version}` : `${cli}: running the computer's own`,
    );
    this.opts.onChange();
    if (file) await this.prune(cli, this.folder(cli));
  }

  /**
   * `bin/<command>` to the runner's copy, for every agent's PATH: made where nothing is there, moved along where it is
   * the runner's own link to an older copy; never over anything else (someone's own install).
   */
  private async link(cli: PinCli, file: string) {
    const bin = this.opts.shared?.bin;
    if (!bin) return;
    const to = path.join(bin, CLI_COMMAND[cli]);
    const was = await readlink(to).catch((err: { code?: string }) => (err.code === "ENOENT" ? null : undefined));
    if (was === undefined || (was !== null && !this.runnerLink(was))) return;
    const tmp = `${to}.${process.pid}.tmp`;
    try {
      await mkdir(bin, { recursive: true });
      await rm(tmp, { force: true });
      await symlink(file, tmp);
      await rename(tmp, to);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      this.opts.log(`${cli}: couldn't link ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Other versions of `cli` the runner fetched before: a turn that started one keeps its open files. */
  private async prune(cli: PinCli, keep: string) {
    const root = path.dirname(keep);
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const dir = path.join(root, name);
      if (name.startsWith(`${cli}-`) && !name.includes(".tmp") && dir !== keep) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /** The pinned build for this system, refused unless its hash is the pinned one; unpacked aside, then moved in. */
  private async download(cli: PinCli): Promise<string> {
    const pin: CliPin = this.pins[cli];
    const build = this.buildOf(cli);
    if (!build) throw new FetchError("no_build", `no ${cli} build for ${this.platform ?? process.platform}`);
    const dir = this.folder(cli);
    const staging = `${dir}.${process.pid}.tmp`;
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: this.opts.shared ? 0o755 : 0o700 });
    try {
      this.opts.log(`${cli}: fetching ${pin.version} (${this.platform})`);
      this.tell(cli, { state: "fetching", version: pin.version, done: 0, total: null });
      const res = await (this.opts.fetch ?? fetch)(build.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_MS),
      });
      if (!res.ok || !res.body) {
        throw new FetchError(res.status >= 500 ? "offline" : "failed", `download failed: HTTP ${res.status}`);
      }
      const length = Number(res.headers.get("content-length"));
      const total = Number.isFinite(length) && length > 0 ? length : null;
      const download = path.join(staging, build.archive === "file" ? build.executable : `download.${build.archive}`);
      await mkdir(path.dirname(download), { recursive: true });
      const hash = createHash(build.hash.algorithm);
      const out = createWriteStream(download, { mode: 0o600 });
      const gate = progressGate(this.opts.now);
      let done = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          done += chunk.length;
          if (!out.write(chunk)) await new Promise((ok) => out.once("drain", ok));
          if (gate(done, total)) this.tell(cli, { state: "fetching", version: pin.version, done, total });
        }
      } finally {
        await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));
      }
      if (hash.digest("hex") !== build.hash.value) {
        throw new FetchError("hash_mismatch", "the download didn't match the pinned hash");
      }
      if (build.archive !== "file") {
        await unpack(download, staging, build);
        await rm(download, { force: true });
      }
      // MinGit's bash ships as `sh.exe` only: a copy named `bash.exe` runs as full bash (ADR 0228 §6).
      if (build.from && !existsSync(path.join(staging, build.executable))) {
        const from = path.join(staging, build.from);
        if (!existsSync(from)) throw new FetchError("failed", `the download has no ${build.from}`);
        await mkdir(path.dirname(path.join(staging, build.executable)), { recursive: true });
        await copyFile(from, path.join(staging, build.executable));
      }
      const program = path.join(staging, build.executable);
      for (const f of build.launch ?? []) {
        if (!existsSync(path.join(staging, f))) throw new FetchError("failed", `the download has no ${f}`);
      }
      if (!existsSync(program)) throw new FetchError("failed", `the download has no ${build.executable}`);
      if (process.platform !== "win32") await chmod(program, 0o755);
      if (this.opts.shared) await lockDown(staging);
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      return path.join(dir, build.executable);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * `archive` unpacked into `into`: the system's `tar` reads both kinds on macOS and Windows (there Windows' own
 * `System32\tar.exe`, bsdtar, never a GNU tar on the PATH, which reads no zip); Linux's needs `unzip`.
 */
export function unpackCommand(
  archive: string,
  into: string,
  build: CliBuild,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): [string, string[]] {
  const strip = build.strip ? [`--strip-components=${build.strip}`] : [];
  if (build.archive === "zip" && platform === "linux") return ["unzip", ["-q", "-o", archive, "-d", into]];
  const tar =
    platform === "win32"
      ? path.win32.join(envValue(env, "SystemRoot", "win32") || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  return [tar, [build.archive === "zip" ? "-xf" : "-xzf", archive, "-C", into, ...strip]];
}

function unpack(archive: string, into: string, build: CliBuild): Promise<void> {
  const [file, args] = unpackCommand(archive, into, build);
  return new Promise((done, fail) =>
    execFile(file, args as string[], { timeout: FETCH_MS, windowsHide: true }, (err) =>
      err ? fail(new FetchError("failed", `couldn't unpack it: ${err.message}`)) : done(),
    ),
  );
}

/**
 * Every file of a shared copy root's, and writable by root alone: tar run as root keeps the owners and modes the
 * archive says, and an agent whose uid one of them names could change what every agent runs.
 */
async function lockDown(dir: string) {
  const root = process.getuid?.() === 0;
  for (const name of ["", ...(await readdir(dir, { recursive: true }))]) {
    const file = path.join(dir, name);
    const st = await lstat(file);
    if (root) await lchown(file, 0, 0);
    if (!st.isSymbolicLink()) await chmod(file, st.mode & 0o755);
  }
}

const safeVersion = (v: string) => v.replace(/[^\w.+-]/g, "_");

const NAMES: Record<PinCli, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor's CLI",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "the Antigravity CLI",
  devin: "the Devin CLI",
  git: "Git for Windows",
};
const cliName = (cli: PinCli) => NAMES[cli];

/** This system's name in the pins; null where none is pinned. */
function thisPlatform(): PinPlatform | null {
  const musl =
    process.platform === "linux" &&
    (existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1"));
  return pinPlatformOf(process.platform, process.arch, musl);
}

/** The built-in list with the server's last one over it (`cli-pins.json`); the built-in alone when there is none. */
function withKept(builtIn: CliPins, file: string): CliPins {
  try {
    const kept = parseCliPins(JSON.parse(readFileSync(file, "utf8")));
    return kept ? { ...builtIn, ...kept } : builtIn;
  } catch {
    return builtIn;
  }
}

/** `file --version`'s first line, or null when it doesn't answer. */
function versionOf(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--version"],
      { timeout: 8000, encoding: "utf8", windowsHide: true, env: { ...process.env, ...CLI_NO_SELF_UPDATE } },
      (err, stdout) => resolve(err ? null : (stdout.trim().split("\n")[0] ?? null)),
    );
  });
}

/**
 * The person's own copy of `cli` on the PATH, never the runner's, with its version line. Git: the person's Git Bash,
 * any version (its bash is all Claude Code needs), so it reads as the pinned one.
 */
async function ownCopy(cli: PinCli, pinned: string): Promise<{ file: string; version: string } | null> {
  if (cli === "git") {
    const bash = process.platform === "win32" ? gitBashPath(process.env, undefined, false) : null;
    return bash ? { file: bash, version: pinned } : null;
  }
  const file = ownCommand(CLI_COMMAND[cli]);
  const version = file ? await versionOf(file) : null;
  return file && version ? { file, version } : null;
}

/** Every process the runner starts keeps its CLIs from updating themselves (`CLI_NO_SELF_UPDATE`). */
export function holdCliSelfUpdates(env: NodeJS.ProcessEnv = process.env) {
  for (const [name, value] of Object.entries(CLI_NO_SELF_UPDATE)) env[name] ??= value;
}
