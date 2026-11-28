import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { CodexSandbox, RunnerExecutorInfo } from "@agenteschat/adapters/machine-protocol";
import { accountEnv } from "./accounts";
import { consoleText } from "./console-text";
import {
  type CliRun,
  codexRefusal,
  envValue,
  findOnWindowsPath,
  isFile,
  NO_CWD_LOOKUP,
  resolveCommand,
  windowsShellLine,
} from "./executors";

/**
 * Codex on Windows (ADR 0032 "Codex", ADR 0053's addenda of 2026-11-12 and 2026-11-24): how it starts there, and the
 * sandbox a `plan` or `work` turn runs in.
 *
 * - It starts as the native `codex.exe`, found on the PATH, never in the current folder (`findOnWindowsPath`); npm's
 *   `codex.cmd` as the `codex.exe` behind it. Nothing goes through cmd.exe then: its line stops at 8,191 characters
 *   and expands `%NAME%` even in quotes.
 * - The sandbox is chosen per computer and Codex version (`windowsCodexSandbox`), named in `-c` on every process of a
 *   `plan` or `work` turn, so a sandbox the computer's own Codex config names never stands in for it. MXC (Microsoft
 *   Execution Containers, Windows 11 24H2 with its August 2026 update) where Codex's own check runs a command in it:
 *   Windows' own isolation, no setup, no network, writes in the agent's folders. Elsewhere Codex's `unelevated`
 *   sandbox, where the same check runs a command in it: a restricted token and ACLs keep its writes in the agent's
 *   folders, but it keeps the network out only through proxy variables (a program that ignores them still reaches the
 *   network and loopback), and it reads anything the person can. Neither: the turn fails with `windows_sandbox`.
 *   `elevated` stays out: its administrator's setup is per Codex home, and each AI account has its own (ADR 0041).
 *   A `chat` turn needs none: with no sandbox, Codex refuses every command of its own there, and the turn stops at the
 *   first one anyway.
 * - Nothing asks on Windows (`approvalPolicy: never`): the command policy reads POSIX shells, not the PowerShell Codex
 *   runs its commands in, so the sandbox is the whole limit, as for `codex exec` everywhere. Nothing lifts it, on any
 *   system (`brain-codex.ts`): no one's own Codex rules (an allow there runs a command outside the sandbox, unasked:
 *   `codexRulesNear`), no network and no folder beyond the agent's, whatever the Codex home's config says.
 */

/** Where npm puts the native Codex for each Windows CPU (`@openai/codex`'s platform packages). */
const NPM_TARGETS: Record<string, { pkg: string; triple: string }> = {
  x64: { pkg: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
  arm64: { pkg: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
};

/**
 * The `codex.exe` npm's `codex.cmd` runs (through `node` and the package's launcher): in the platform package, nested
 * in `@openai/codex` as a global install puts it, or beside it, or in the package's own `vendor` folder. It finds its
 * helpers (the sandbox's, the code mode host, `rg`) next to itself, so it works started directly. Null: laid out
 * some other way.
 */
export function codexExeBehindShim(shim: string, arch: string = process.arch, exists = isFile): string | null {
  const target = NPM_TARGETS[arch];
  if (!target) return null;
  const dir = path.win32.dirname(shim);
  const main = path.win32.join(dir, "node_modules", "@openai", "codex");
  const exes = [
    path.win32.join(main, "node_modules", "@openai", target.pkg),
    path.win32.join(dir, "node_modules", "@openai", target.pkg),
    main,
  ].map((pkg) => path.win32.join(pkg, "vendor", target.triple, "bin", "codex.exe"));
  return exes.find((exe) => exists(exe)) ?? null;
}

/** cmd.exe's longest line (8,191 characters), with room to spare. */
const CMD_LINE_MAX = 8000;

/** How `codex` starts, or why it can't (`missing`: not installed). */
export type CodexLaunch = CliRun | { error: string; missing?: true };

/**
 * How `codex <args>` starts. Elsewhere: its full path on the PATH, as before. On Windows: found on the PATH, never in
 * the current folder; a `codex.exe` as it is; npm's `codex.cmd` as the `codex.exe` behind it (with what npm's
 * launcher tells it, how it was installed). A launcher laid out some other way goes through cmd.exe, only with our own
 * words in it (paths, ids and settings: nothing cmd.exe would read, `%`, `!` or a line break) and within its line.
 * Every Windows start carries `NO_CWD_LOOKUP` (an `.exe` may be a launcher too, as Bun's are).
 */
export function codexLaunch(
  args: readonly string[],
  opts: {
    bin?: string;
    pathList?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    pathExt?: string;
    exists?: (file: string) => boolean;
  } = {},
): CodexLaunch {
  const platform = opts.platform ?? process.platform;
  const bin = opts.bin ?? "codex";
  if (platform !== "win32") return { file: resolveCommand(bin, opts.pathList), args: [...args] };
  const exists = opts.exists ?? isFile;
  const found = findOnWindowsPath(
    bin,
    opts.pathList ?? envValue(process.env, "PATH", platform) ?? "",
    opts.pathExt ?? envValue(process.env, "PATHEXT", platform),
    exists,
  );
  if (!found) return { error: "Codex is not installed on this computer.", missing: true };
  if (/\.(?:exe|com)$/i.test(found)) return { file: found, args: [...args], env: { ...NO_CWD_LOOKUP } };
  if (!/\.(?:cmd|bat)$/i.test(found)) {
    return {
      error: `Codex here starts through ${path.win32.basename(found)}, which agents can't run. Install it with npm or OpenAI's installer.`,
    };
  }
  const exe = codexExeBehindShim(found, opts.arch ?? process.arch, exists);
  if (exe) return { file: exe, args: [...args], env: { ...NO_CWD_LOOKUP, CODEX_MANAGED_BY_NPM: "1" } };
  const launcher = "Codex here starts through a launcher agents can't hand this turn to";
  if (args.some((a) => /[%!\r\n]/.test(a))) {
    return { error: `${launcher} (its settings have a % or ! in them). Install Codex with npm or OpenAI's installer.` };
  }
  const run = windowsShellLine(found, args);
  if ((run.args.at(-1) ?? "").length > CMD_LINE_MAX) {
    return { error: `${launcher} (its settings are too long for it). Install Codex with npm or OpenAI's installer.` };
  }
  return run;
}

/** A sandbox Codex runs a `plan` or `work` turn's commands in on Windows. */
export type CodexWindowsSandbox = Exclude<CodexSandbox, "none">;

/**
 * A `plan` or `work` turn's sandbox on Windows, named in `-c`: so a sandbox the computer's own Codex config names never
 * stands in for it, and a computer where it stopped working fails closed (Codex refuses to run a command there rather
 * than run it elsewhere).
 */
export const codexWindowsConfig = (sandbox: CodexWindowsSandbox) => [`windows.sandbox="${sandbox}"`];

/** What a `plan` or `work` turn says where Windows can't hold Codex's commands. */
export const WINDOWS_SANDBOX_MESSAGE =
  "Codex couldn't start any isolation for its commands on this Windows computer: neither Microsoft Execution Containers (MXC) nor its own sandbox ran here. Choose Claude or an API key for this agent, or update Windows to Windows 11 24H2 or newer, with its latest updates.";

/**
 * A thread's first prompt on Windows when it runs on `codex exec`: its instructions lead it, on stdin, as the plan
 * router's do (`codexRoute`). A command line can't carry them there (32,767 characters, 8,191 through cmd.exe).
 */
export const codexStdinPrompt = (instructions: string, prompt: string) =>
  instructions.trim() ? `${instructions.trim()}\n\n${prompt}` : prompt;

/** What a sandbox's check prints when it ran its command. */
const sandboxMark = (sandbox: CodexWindowsSandbox) => `${sandbox.toUpperCase()}_OK`;

/**
 * Codex's own check of a sandbox (Codex 0.162.0 and later): `echo MXC_OK` (or `UNELEVATED_OK`) run inside it, with the
 * workspace's permissions and any managed requirements.
 */
export const sandboxCheckArgs = (sandbox: CodexWindowsSandbox) => [
  "-c",
  `windows.sandbox="${sandbox}"`,
  "sandbox",
  "--include-managed-config",
  "--permission-profile",
  ":workspace",
  "--",
  "cmd.exe",
  "/d",
  "/c",
  "echo",
  sandboxMark(sandbox),
];

const SANDBOX_CHECK_TIMEOUT_MS = 60_000;

/**
 * Runs Codex's check of `sandbox`: true when it printed its mark and ended well (the sandbox ran a command here), false
 * when it ran and didn't (no such sandbox here, or a policy that forbids it), null when it couldn't tell (it didn't
 * start, didn't end in time, or this Codex is too old for the check and refused its command line).
 */
export function runSandboxCheck(
  run: CliRun,
  sandbox: CodexWindowsSandbox,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<boolean | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        run.file,
        run.args,
        {
          cwd: opts.cwd,
          env: run.env ? { ...opts.env, ...run.env } : opts.env,
          encoding: "buffer",
          timeout: opts.timeoutMs ?? SANDBOX_CHECK_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          ...(run.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (err, out, errOut) => {
          const [stdout, stderr] = [consoleText(out), consoleText(errOut)];
          if (!err) return resolve(new RegExp(`\\b${sandboxMark(sandbox)}\\b`).test(stdout));
          const failed = err as { code?: unknown; killed?: boolean };
          // It ran and said no (its exit code), against it not starting or not ending in time. A refusal of the check
          // itself says nothing about Windows.
          resolve(typeof failed.code === "number" && !failed.killed && !codexRefusal(stderr) ? false : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * How long anything less than MXC is kept before MXC is asked again: Windows may have been updated meanwhile, or MXC's
 * check failed once (right after a restart, for one).
 */
export const WINDOWS_SANDBOX_RETRY_MS = 10 * 60_000;

type SandboxCheck = (
  sandbox: CodexWindowsSandbox,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<boolean | null>;

const choices = new Map<string, { sandbox: CodexSandbox; at: number }>();
const choosing = new Map<string, Promise<CodexSandbox | null>>();
const choiceKey = (version: string, bin = "codex") => `${bin}@${version}`;

/**
 * What holds Codex's commands on this computer: `mxc` where Codex's own check (`sandboxCheckArgs`) runs a command in
 * MXC, else `unelevated` where the same check runs one in that, else `none`. Checked in an empty Codex home of the
 * runner's (none of a person's config in it), once at a time. Kept per Codex version: `mxc` for as long as the runner
 * runs, anything less for `WINDOWS_SANDBOX_RETRY_MS`. Past that, `unelevated` stands while only MXC is asked again
 * (`wait`: the answer instead), and `none` is asked again whole. Null: it couldn't tell (not kept).
 */
export function windowsCodexSandbox(input: {
  runnerHome: string;
  version: string;
  bin?: string;
  check?: SandboxCheck;
  now?: () => number;
  wait?: boolean;
}): Promise<CodexSandbox | null> {
  const now = input.now ?? Date.now;
  const key = choiceKey(input.version, input.bin);
  const kept = choices.get(key);
  if (kept && (kept.sandbox === "mxc" || now() - kept.at < WINDOWS_SANDBOX_RETRY_MS)) {
    return Promise.resolve(kept.sandbox);
  }
  // A turn never waits for MXC to be asked again behind a sandbox that already ran a command here.
  const held = kept?.sandbox === "unelevated" && !input.wait ? Promise.resolve(kept.sandbox) : null;
  const running = choosing.get(key);
  if (running) return held ?? running;
  const home = path.join(input.runnerHome, "brain", "codex-windows-check");
  const check =
    input.check ??
    ((sandbox: CodexWindowsSandbox, o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const launch = codexLaunch(sandboxCheckArgs(sandbox), {
        ...(input.bin ? { bin: input.bin } : {}),
        pathList: envValue(o.env, "PATH") ?? "",
      });
      return "error" in launch ? Promise.resolve(null) : runSandboxCheck(launch, sandbox, o);
    });
  const choice = (async (): Promise<CodexSandbox | null> => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const opts = { cwd: home, env: accountEnv("codex", home) };
    const mxc = await check("mxc", opts);
    if (mxc !== false) return mxc && "mxc";
    if (kept?.sandbox === "unelevated") return "unelevated";
    const unelevated = await check("unelevated", opts);
    if (unelevated === null) return null;
    return unelevated ? "unelevated" : "none";
  })()
    .then((sandbox) => {
      if (sandbox) choices.set(key, { sandbox, at: now() });
      return sandbox;
    })
    .finally(() => choosing.delete(key));
  choosing.set(key, choice);
  return held ?? choice;
}

/** The last choice of `windowsCodexSandbox` for this Codex, without making one (`hello`); undefined: none yet. */
export const knownCodexSandbox = (version: string, bin?: string): CodexSandbox | undefined =>
  choices.get(choiceKey(version, bin))?.sandbox;

/**
 * `executors.codex` as `hello` and `executors.changed` say it on a Windows computer (`CODEX_UNELEVATED_PROTOCOL`): with
 * what holds Codex's commands there once a choice was made, never waited for (the check starts Codex, up to a minute
 * each sandbox). Where Codex may run (`may`: its switch on), a choice is made in the background when due (another
 * version, or `WINDOWS_SANDBOX_RETRY_MS` since the last), and `onChange` follows its answer so the server hears.
 */
export function codexSandboxReport(opts: {
  runnerHome: string;
  onChange: () => void;
  now?: () => number;
  choose?: (version: string) => Promise<unknown>;
}): (codex: RunnerExecutorInfo, may: boolean) => RunnerExecutorInfo {
  const now = opts.now ?? Date.now;
  const choose =
    opts.choose ?? ((version: string) => windowsCodexSandbox({ runnerHome: opts.runnerHome, version, wait: true }));
  let looked: { version: string; at: number } | undefined;
  return (codex, may) => {
    const { version } = codex;
    if (may && (looked?.version !== version || now() - looked.at >= WINDOWS_SANDBOX_RETRY_MS)) {
      looked = { version, at: now() };
      void choose(version).then(opts.onChange, () => undefined);
    }
    const sandbox = knownCodexSandbox(version);
    return sandbox ? { ...codex, sandbox } : codex;
  };
}
