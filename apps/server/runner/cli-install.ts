import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import os from "node:os";
import path, { win32 } from "node:path";
import {
  CLI_ERROR_MAX,
  type CliInstall,
  type InstallableCli,
  isInstallableCli,
} from "@agenteschat/adapters/machine-protocol";
import { ConsoleDecoder } from "./console-text";
import { killTree } from "./exec";
import { envValue, findOnWindowsPath, isFile, pickedCli } from "./executors";
import { CLAUDE_INSTALL_PS1_URL, CLAUDE_INSTALL_URL, CODEX_RELEASES } from "./install-script";
import { lastLine } from "./lines";
import { mergePathWith } from "./login-path";

/**
 * A coding CLI installed on this computer from the apps (`cli.install`), as the person the runner runs as: the
 * vendor's own installer, fetched over https from the address held here. Nothing in a request reaches a shell: it
 * names a program from `INSTALLABLE_CLIS`, and each one's script is fixed below. One install at a time; it outlives
 * the request that started it and ends with the runner.
 */

/** A slow connection downloads Claude Code's ~200 MB in minutes. */
export const CLI_INSTALL_RUN_MS = 15 * 60_000;

/** The command name the runner's own Git Bash is picked by (`setCliPick`): never one found on the PATH. */
export const GIT_BASH_PICK = "git-bash";

/**
 * Git Bash, which Claude Code needs on Windows: where `CLAUDE_CODE_GIT_BASH_PATH` points, or beside a `git` on the
 * PATH, or where Git for Windows installs for the machine or for the person, or else the runner's own (MinGit, fetched
 * on demand, ADR 0228 §6) unless `runnerCopy` is false (whether the person has one). Null: none.
 */
export function gitBashPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = isFile,
  runnerCopy = true,
) {
  const pinned = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH", "win32");
  if (pinned && exists(pinned)) return pinned;
  const git = findOnWindowsPath("git", envValue(env, "PATH", "win32") ?? "", envValue(env, "PATHEXT", "win32"), exists);
  // `<Git>\cmd\git.exe` or `<Git>\bin\git.exe`: bash is in `<Git>\bin`.
  const roots = [
    ...(git ? [win32.dirname(win32.dirname(git))] : []),
    win32.join(envValue(env, "ProgramFiles", "win32") || "C:\\Program Files", "Git"),
    win32.join(
      envValue(env, "LOCALAPPDATA", "win32") || win32.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "Git",
    ),
  ];
  const own = roots.map((root) => win32.join(root, "bin", "bash.exe")).find((file) => exists(file));
  return own ?? (runnerCopy ? (pickedCli(GIT_BASH_PICK) ?? null) : null);
}

/** `env` with Claude Code's Git Bash on Windows (`CLAUDE_CODE_GIT_BASH_PATH`), when it finds one; as it is elsewhere. */
export function withGitBash(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32" || envValue(env, "CLAUDE_CODE_GIT_BASH_PATH", "win32")) return env;
  const bash = gitBashPath(env);
  return bash ? { ...env, CLAUDE_CODE_GIT_BASH_PATH: bash } : env;
}

/** Where the installers below leave the CLI: `~/.local/bin`, on every system. */
export const cliInstallDir = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? win32.join(envValue(env, "USERPROFILE", "win32") || os.homedir(), ".local", "bin")
    : path.join(env.HOME || os.homedir(), ".local", "bin");

/**
 * The program and argv that install `tool` here, or null where we have no installer for it (Codex on Windows: OpenAI
 * documents npm there). The address is an argument (`$0`), never part of the script's text.
 */
export function cliInstaller(
  tool: InstallableCli,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } | null {
  if (platform === "win32") {
    if (tool !== "claude") return null;
    const root = envValue(env, "SystemRoot", "win32") || "C:\\Windows";
    return {
      file: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        // Windows PowerShell 5.1 may still default to TLS 1.0.
        `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm '${CLAUDE_INSTALL_PS1_URL}' | iex`,
      ],
    };
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const script =
    tool === "claude"
      ? `set -o pipefail; curl -fsSL --proto '=https' "$0" | bash`
      : [
          "set -e",
          `case "$(uname -m)" in x86_64 | amd64) CPU=x86_64 ;; aarch64 | arm64) CPU=aarch64 ;; *) echo "OpenAI has no Codex build for $(uname -m)" >&2; exit 1 ;; esac`,
          `BUILD=$CPU-unknown-linux-musl; if [ "$(uname -s)" = Darwin ]; then BUILD=$CPU-apple-darwin; fi`,
          `D=$(mktemp -d); trap 'rm -rf "$D"' EXIT`,
          `curl -fsSL --proto '=https' "$0/codex-$BUILD.tar.gz" -o "$D/codex.tar.gz"`,
          `tar -xzf "$D/codex.tar.gz" -C "$D"`,
          `mkdir -p "$HOME/.local/bin"`,
          `cp "$D/codex-$BUILD" "$HOME/.local/bin/codex.new" && chmod 755 "$HOME/.local/bin/codex.new" && mv -f "$HOME/.local/bin/codex.new" "$HOME/.local/bin/codex"`,
        ].join("\n");
  return { file: "/bin/bash", args: ["-c", script, tool === "claude" ? CLAUDE_INSTALL_URL : CODEX_RELEASES] };
}

export interface CliInstallerOptions {
  log: (line: string) => void;
  /**
   * After an installer ended well: the PATH read again and the CLIs looked up now (the server hears of a change).
   * Resolves to whether `tool` is found: an install the look can't find ends `failed` with `still_missing`.
   */
  onDone: (tool: InstallableCli) => Promise<boolean>;
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * System mode: the install is the runner's pinned build where every agent's user runs it (`CliCopies.ensure`), never
   * the vendor's installer as root, which installs for root alone. Rejects in words for the person.
   */
  fetch?: (tool: InstallableCli) => Promise<void>;
  /** Tests: the installer to run in place of the vendor's. */
  installer?: typeof cliInstaller;
  gitBash?: () => string | null;
  runMs?: number;
}

export class CliInstaller {
  private install: CliInstall | null = null;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CliInstallerOptions) {}

  state(): CliInstall | null {
    return this.install ? { ...this.install } : null;
  }

  /** The machine op: start (or the one already under way), where it stands, or stop it. */
  handle(req: { action?: unknown; tool?: unknown }): { install: CliInstall | null } {
    if (req.action === "start" && isInstallableCli(req.tool)) return { install: this.start(req.tool) };
    if (req.action === "cancel") return { install: this.cancel() };
    return { install: this.state() };
  }

  start(tool: InstallableCli): CliInstall {
    if (this.install?.state === "running") return { ...this.install };
    if (this.opts.fetch) return this.fetched(tool, this.opts.fetch);
    const platform = this.opts.platform ?? process.platform;
    const env = this.opts.env ?? process.env;
    const uid = this.opts.uid ?? process.getuid?.() ?? -1;
    // Root (system mode) installs for itself, not for the agents' users: the computer's setup installs those.
    const installer = uid === 0 ? null : (this.opts.installer ?? cliInstaller)(tool, platform, env);
    if (!installer) {
      this.install = { tool, state: "unsupported" };
      return { ...this.install };
    }
    if (platform === "win32" && tool === "claude" && !(this.opts.gitBash ?? (() => gitBashPath(env)))()) {
      this.install = { tool, state: "failed", cause: "git_missing" };
      return { ...this.install };
    }
    this.install = { tool, state: "running" };
    let child: ChildProcess;
    try {
      child = spawn(installer.file, installer.args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: platform !== "win32",
      });
    } catch (err) {
      this.install = { tool, state: "failed", message: err instanceof Error ? err.message : String(err) };
      return { ...this.install };
    }
    this.child = child;
    // Apart: two pipes' chunks come in no set order, and why an installer failed is on its stderr.
    const said = { out: "", err: "" };
    const keep = (pipe: keyof typeof said, decoder: ConsoleDecoder) => (chunk: Buffer) => {
      said[pipe] = `${said[pipe]}${decoder.write(chunk)}`.slice(-4000);
    };
    child.stdout?.on("data", keep("out", new ConsoleDecoder()));
    child.stderr?.on("data", keep("err", new ConsoleDecoder()));
    this.timer = setTimeout(() => {
      if (this.child !== child) return;
      this.install = { tool, state: "failed", message: "It took too long" };
      this.end();
      killTree(child, "SIGTERM");
    }, this.opts.runMs ?? CLI_INSTALL_RUN_MS);
    this.timer.unref?.();
    const finish = (code: number | null) => {
      if (this.child !== child) return;
      this.end();
      if (code !== 0) {
        const last = (lastLine(said.err) ?? lastLine(said.out) ?? "").slice(0, CLI_ERROR_MAX);
        this.install = { tool, state: "failed", message: last || `exit code ${code}` };
        this.opts.log(`cli install: ${tool} failed: ${this.install.message}`);
        return;
      }
      // The installers write to ~/.local/bin, which a PATH taken before may not have.
      env.PATH = mergePathWith(
        platform === "win32" ? ";" : ":",
        envValue(env, "PATH", platform),
        cliInstallDir(platform, env),
      );
      const ran = this.install;
      void this.opts
        .onDone(tool)
        .catch(() => false)
        .then((found) => {
          if (this.install !== ran) return;
          this.install = found ? { tool, state: "done" } : { tool, state: "failed", cause: "still_missing" };
          this.opts.log(`cli install: ${tool} ${this.install.state}`);
        });
    };
    const events = child as unknown as EventEmitter;
    events.on("error", (err: Error) => {
      said.err = err.message;
      finish(null);
    });
    events.on("close", finish);
    this.opts.log(`cli install: ${tool} started`);
    return { ...this.install };
  }

  private fetched(tool: InstallableCli, fetch: (tool: InstallableCli) => Promise<void>): CliInstall {
    const ran: CliInstall = { tool, state: "running" };
    this.install = ran;
    this.opts.log(`cli install: ${tool} started (for the agents)`);
    void fetch(tool)
      .then(() => this.opts.onDone(tool))
      .then(
        (found): CliInstall => (found ? { tool, state: "done" } : { tool, state: "failed", cause: "still_missing" }),
        (err: unknown): CliInstall => ({
          tool,
          state: "failed",
          message: (err instanceof Error ? err.message : String(err)).slice(0, CLI_ERROR_MAX),
        }),
      )
      .then((end) => {
        if (this.install !== ran) return;
        this.install = end;
        this.opts.log(`cli install: ${tool} ${end.state}`);
      });
    return { ...ran };
  }

  cancel(): CliInstall | null {
    const child = this.child;
    if (this.install?.state !== "running") return this.state();
    // A fetch for the agents goes on and is kept for the next ask; only its end is no longer told here.
    this.install = { ...this.install, state: "canceled" };
    this.end();
    if (child) killTree(child, "SIGTERM");
    return this.state();
  }

  private end() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child = null;
  }

  stop() {
    const child = this.child;
    this.end();
    if (child) killTree(child, "SIGTERM");
  }
}
