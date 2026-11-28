import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type CodexWindowsSandbox,
  codexExeBehindShim,
  codexLaunch,
  codexSandboxReport,
  codexStdinPrompt,
  codexWindowsConfig,
  knownCodexSandbox,
  runSandboxCheck,
  sandboxCheckArgs,
  WINDOWS_SANDBOX_RETRY_MS,
  windowsCodexSandbox,
} from "../../runner/codex-windows";
import { removeDirs, tempDir, waitFor } from "./helpers";

/**
 * Codex on Windows (`codex-windows.ts`): how it starts, and what holds its commands there (MXC, else Codex's own
 * `unelevated`, else nothing). The lookups take which files exist as given, so they run anywhere.
 */

const dirs: string[] = [];
afterEach(() => {
  delete process.env.FAKE_CODEX_LOG;
  delete process.env.FAKE_CODEX_SANDBOXES;
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE_CODEX = path.join(import.meta.dir, "fake-codex-app.mjs");
const NPM = "C:\\Users\\user\\AppData\\Roaming\\npm";
const SHIM = `${NPM}\\codex.cmd`;
const OPENAI = "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin";
const PATH_WIN = `${NPM};${OPENAI}`;
const NO_CWD_LOOKUP = { NoDefaultCurrentDirectoryInExePath: "1" };
const nested = (pkg: string, triple: string) =>
  `${NPM}\\node_modules\\@openai\\codex\\node_modules\\@openai\\${pkg}\\vendor\\${triple}\\bin\\codex.exe`;
const NESTED = nested("codex-win32-x64", "x86_64-pc-windows-msvc");
const has =
  (...files: string[]) =>
  (file: string) =>
    files.includes(file);

test("npm's codex.cmd: the codex.exe its package carries, nested as a global install puts it, beside it, or its own", () => {
  expect(codexExeBehindShim(SHIM, "x64", has(NESTED))).toBe(NESTED);
  expect(codexExeBehindShim(SHIM, "arm64", has(nested("codex-win32-arm64", "aarch64-pc-windows-msvc")))).toBe(
    nested("codex-win32-arm64", "aarch64-pc-windows-msvc"),
  );
  const hoisted = `${NPM}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  expect(codexExeBehindShim(SHIM, "x64", has(hoisted))).toBe(hoisted);
  const own = `${NPM}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`;
  expect(codexExeBehindShim(SHIM, "x64", has(own))).toBe(own);
  // Another CPU's, or a layout we don't know: not ours to guess.
  expect(codexExeBehindShim(SHIM, "arm64", has(NESTED))).toBeNull();
  expect(codexExeBehindShim(SHIM, "ia32", () => true)).toBeNull();
});

test("starting Codex on Windows: codex.exe as it is, npm's launcher as the exe behind it, cmd.exe only with our words", () => {
  const args = [
    "exec",
    "--json",
    "-c",
    'windows.sandbox="mxc"',
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
    "-",
  ];
  const win = { platform: "win32" as const, arch: "x64", pathList: PATH_WIN, pathExt: ".COM;.EXE;.BAT;.CMD" };
  // OpenAI's installer, winget, Scoop: a codex.exe on the PATH, started as it is, nothing looked up in the folder.
  expect(codexLaunch(args, { ...win, exists: has(`${OPENAI}\\codex.exe`) })).toEqual({
    file: `${OPENAI}\\codex.exe`,
    args,
    env: NO_CWD_LOOKUP,
  });
  // npm's launcher (first on the PATH): the codex.exe behind it, told how it was installed.
  expect(codexLaunch(args, { ...win, exists: has(SHIM, NESTED, `${OPENAI}\\codex.exe`) })).toEqual({
    file: NESTED,
    args,
    env: { ...NO_CWD_LOOKUP, CODEX_MANAGED_BY_NPM: "1" },
  });
  // A launcher laid out some other way: through cmd.exe, by its full path, nothing looked up in the current folder.
  const shell = codexLaunch(args, { ...win, exists: has(SHIM) });
  expect(shell).toMatchObject({ windowsVerbatimArguments: true, env: NO_CWD_LOOKUP });
  expect("args" in shell && shell.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
  expect("args" in shell && shell.args[4]?.startsWith(`""${SHIM}" "exec"`)).toBe(true);
  // ...and never with what cmd.exe would read, nor past its line.
  expect(codexLaunch(["exec", "-c", 'x="%USERPROFILE%"'], { ...win, exists: has(SHIM) })).toMatchObject({
    error: expect.stringContaining("% or !"),
  });
  expect(codexLaunch(["exec", "x".repeat(9000)], { ...win, exists: has(SHIM) })).toMatchObject({
    error: expect.stringContaining("too long"),
  });
  // Not on the PATH (the current folder is never searched).
  expect(codexLaunch(args, { ...win, exists: () => false })).toEqual({
    error: "Codex is not installed on this computer.",
    missing: true,
  });
  // Elsewhere: its full path, as before.
  expect(codexLaunch(args, { platform: "linux", bin: "/opt/codex/codex" })).toEqual({ file: "/opt/codex/codex", args });
});

test("a plan or work turn's sandbox on Windows goes by name; a new thread's instructions lead its prompt on stdin", () => {
  expect(codexWindowsConfig("mxc")).toEqual(['windows.sandbox="mxc"']);
  expect(codexWindowsConfig("unelevated")).toEqual(['windows.sandbox="unelevated"']);
  expect(codexStdinPrompt("Be brief.", "Say pong")).toBe("Be brief.\n\nSay pong");
  expect(codexStdinPrompt("  ", "Say pong")).toBe("Say pong");
});

type Check = (sandbox: CodexWindowsSandbox, o: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<boolean | null>;

/** A check that answers per sandbox from a list (each answer used once), and remembers what it was asked. */
const checkOf = (answers: Partial<Record<CodexWindowsSandbox, Array<boolean | null>>>) => {
  const calls: Array<{ sandbox: CodexWindowsSandbox; cwd: string; codexHome: string | undefined }> = [];
  const check: Check = async (sandbox, o) => {
    calls.push({ sandbox, cwd: o.cwd, codexHome: o.env.CODEX_HOME });
    return answers[sandbox]?.shift() ?? null;
  };
  return { calls, check };
};

test("what holds Codex on Windows is Codex's own check: MXC first, else its own unelevated sandbox, else nothing", async () => {
  const home = tempDir("codex-windows-");
  dirs.push(home);
  const ask = (bin: string, check: Check) =>
    windowsCodexSandbox({ runnerHome: home, version: "codex-cli 0.170.0", bin, check, now: () => 0 });

  // MXC ran a command: never a weaker sandbox, and nothing else asked.
  const mxc = checkOf({ mxc: [true] });
  expect(await ask("codex-mxc", mxc.check)).toBe("mxc");
  // In an empty Codex home of the runner's: none of a person's config in it.
  const checkHome = path.join(home, "brain", "codex-windows-check");
  expect(mxc.calls).toEqual([{ sandbox: "mxc", cwd: checkHome, codexHome: checkHome }]);

  // No MXC here (a Windows 10 computer, one without the August 2026 update): Codex's own sandbox where it runs.
  const fallback = checkOf({ mxc: [false], unelevated: [true] });
  expect(await ask("codex-unelevated", fallback.check)).toBe("unelevated");
  expect(fallback.calls.map((c) => c.sandbox)).toEqual(["mxc", "unelevated"]);

  // Neither ran a command.
  const neither = checkOf({ mxc: [false], unelevated: [false] });
  expect(await ask("codex-none", neither.check)).toBe("none");

  // Couldn't tell: MXC's check didn't end (never a weaker sandbox for that), or the fallback's didn't.
  const silent = checkOf({ mxc: [null] });
  expect(await ask("codex-silent", silent.check)).toBeNull();
  expect(silent.calls.map((c) => c.sandbox)).toEqual(["mxc"]);
  const half = checkOf({ mxc: [false], unelevated: [null] });
  expect(await ask("codex-half", half.check)).toBeNull();
  expect(knownCodexSandbox("codex-cli 0.170.0", "codex-half")).toBeUndefined();
});

test("the choice is kept per Codex: MXC while the runner runs, less for a while, no answer never", async () => {
  const home = tempDir("codex-windows-keep-");
  dirs.push(home);
  const ask = (bin: string, check: Check, at = 0, wait = false) =>
    windowsCodexSandbox({ runnerHome: home, version: "codex-cli 0.170.0", bin, check, now: () => at, wait });

  const mxc = checkOf({ mxc: [true] });
  expect(await ask("codex-keep-m", mxc.check)).toBe("mxc");
  expect(await ask("codex-keep-m", mxc.check, 99 * WINDOWS_SANDBOX_RETRY_MS)).toBe("mxc");
  expect(mxc.calls).toHaveLength(1);

  // MXC's check failed once (right after a restart, say): Codex's own sandbox for a while.
  const held = checkOf({ mxc: [false, false, true], unelevated: [true] });
  expect(await ask("codex-keep-a", held.check)).toBe("unelevated");
  expect(await ask("codex-keep-a", held.check, WINDOWS_SANDBOX_RETRY_MS - 1)).toBe("unelevated");
  expect(held.calls.map((c) => c.sandbox)).toEqual(["mxc", "unelevated"]);
  // Then MXC alone is asked again behind it: a turn takes Codex's own sandbox at once, the report waits for the answer.
  const later = WINDOWS_SANDBOX_RETRY_MS;
  expect(await ask("codex-keep-a", held.check, later)).toBe("unelevated");
  expect(await ask("codex-keep-a", held.check, later, true)).toBe("unelevated");
  expect(held.calls.map((c) => c.sandbox)).toEqual(["mxc", "unelevated", "mxc"]);
  // Once MXC runs, it is the choice from then on.
  expect(await ask("codex-keep-a", held.check, 2 * later, true)).toBe("mxc");
  expect(await ask("codex-keep-a", held.check, 99 * later)).toBe("mxc");
  expect(held.calls.map((c) => c.sandbox)).toEqual(["mxc", "unelevated", "mxc", "mxc"]);
  expect(knownCodexSandbox("codex-cli 0.170.0", "codex-keep-a")).toBe("mxc");
  // Another version is another choice.
  expect(knownCodexSandbox("codex-cli 0.171.0", "codex-keep-a")).toBeUndefined();

  const none = checkOf({ mxc: [null, false, true], unelevated: [false] });
  expect(await ask("codex-keep-b", none.check)).toBeNull();
  expect(await ask("codex-keep-b", none.check)).toBe("none");
  expect(await ask("codex-keep-b", none.check, WINDOWS_SANDBOX_RETRY_MS - 1)).toBe("none");
  // Windows may have been updated since.
  expect(await ask("codex-keep-b", none.check, WINDOWS_SANDBOX_RETRY_MS)).toBe("mxc");
  expect(none.calls.map((c) => c.sandbox)).toEqual(["mxc", "mxc", "unelevated", "mxc"]);

  // Asked twice at once (a turn and the computer's report): one check.
  const once = checkOf({ mxc: [true] });
  expect(await Promise.all([ask("codex-keep-c", once.check), ask("codex-keep-c", once.check)])).toEqual(["mxc", "mxc"]);
  expect(once.calls).toHaveLength(1);
});

test.if(posix)("Codex's check of a sandbox: its mark and a good end is a yes, its own failure a no", async () => {
  const home = tempDir("codex-windows-check-");
  dirs.push(home);
  const log = path.join(home, "cli.log");
  process.env.FAKE_CODEX_LOG = log;
  expect(sandboxCheckArgs("mxc")).toEqual([
    "-c",
    'windows.sandbox="mxc"',
    "sandbox",
    "--include-managed-config",
    "--permission-profile",
    ":workspace",
    "--",
    "cmd.exe",
    "/d",
    "/c",
    "echo",
    "MXC_OK",
  ]);
  expect(sandboxCheckArgs("unelevated")).toEqual([
    ...sandboxCheckArgs("mxc").slice(0, 1),
    'windows.sandbox="unelevated"',
    ...sandboxCheckArgs("mxc").slice(2, -1),
    "UNELEVATED_OK",
  ]);
  const runOf = (sandbox: CodexWindowsSandbox) => ({
    file: process.execPath,
    args: [FAKE_CODEX, ...sandboxCheckArgs(sandbox)],
  });
  const env = (sandboxes: string) => ({ ...process.env, FAKE_CODEX_SANDBOXES: sandboxes });
  expect(await runSandboxCheck(runOf("mxc"), "mxc", { cwd: home, env: env("mxc") })).toBe(true);
  const started = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0] ?? "{}") as { args?: unknown };
  expect(started.args).toEqual(sandboxCheckArgs("mxc"));
  expect(await runSandboxCheck(runOf("mxc"), "mxc", { cwd: home, env: env("unelevated") })).toBe(false);
  expect(await runSandboxCheck(runOf("unelevated"), "unelevated", { cwd: home, env: env("unelevated") })).toBe(true);
  // Another sandbox's mark is no yes for this one.
  expect(await runSandboxCheck(runOf("mxc"), "unelevated", { cwd: home, env: env("mxc") })).toBe(false);
  // It didn't start: nobody knows yet.
  const nowhere = { file: path.join(home, "nowhere"), args: [] };
  expect(await runSandboxCheck(nowhere, "mxc", { cwd: home, env: process.env })).toBeNull();
  // A Codex older than the check refuses its command line: that says nothing about Windows.
  expect(await runSandboxCheck(runOf("mxc"), "mxc", { cwd: home, env: env("old") })).toBeNull();
});

test("the computer's report says the choice once made, looks in the background where Codex may run, and says so", async () => {
  const home = tempDir("codex-windows-report-");
  dirs.push(home);
  const version = "codex-cli 0.172.0-report";
  let at = 0;
  let changed = 0;
  const choices: string[] = [];
  const fallback = checkOf({ mxc: [false, true], unelevated: [true] });
  const report = codexSandboxReport({
    runnerHome: home,
    onChange: () => changed++,
    now: () => at,
    choose: (v) => {
      choices.push(v);
      return windowsCodexSandbox({ runnerHome: home, version: v, check: fallback.check, now: () => at, wait: true });
    },
  });
  const codex = { version };
  // Codex off on this computer: nothing is started for it.
  expect(report(codex, false)).toEqual(codex);
  expect(choices).toEqual([]);
  // On: `hello` doesn't wait; the server hears once the choice is made.
  expect(report(codex, true)).toEqual(codex);
  await waitFor(() => changed === 1);
  expect(report(codex, true)).toEqual({ version, sandbox: "unelevated" });
  expect(choices).toEqual([version]);
  // Asked again only after a while: MXC alone, and the server hears once it runs.
  at = WINDOWS_SANDBOX_RETRY_MS - 1;
  report(codex, true);
  expect(choices).toHaveLength(1);
  at = WINDOWS_SANDBOX_RETRY_MS;
  report(codex, true);
  expect(choices).toHaveLength(2);
  await waitFor(() => changed === 2);
  expect(fallback.calls.map((c) => c.sandbox)).toEqual(["mxc", "unelevated", "mxc"]);
  expect(report(codex, true)).toEqual({ version, sandbox: "mxc" });
  // Another version: asked at once.
  report({ version: `${version}.1` }, true);
  expect(choices).toEqual([version, version, `${version}.1`]);
  await waitFor(() => changed === 3);
});
