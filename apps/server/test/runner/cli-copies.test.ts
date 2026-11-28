import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { CliFetchState } from "@agenteschat/adapters/machine-protocol";
import { CLI_NO_SELF_UPDATE, CLI_PINS, type CliPins, type PinCli } from "@agenteschat/providers/cli-pins";
import { ANTIGRAVITY_NEON_CLI, cliVersionAtLeast } from "@agenteschat/providers/plans";
import {
  CLI_COMMAND,
  CliCopies,
  type CliCopiesOptions,
  holdCliSelfUpdates,
  PROGRESS_STEP,
  progressGate,
  RETRY_MS,
  unpackCommand,
} from "../../runner/cli-copies";
import { cliSpawn, pickedCli, pickedLaunch, resolveCommand, setCliPick } from "../../runner/executors";
import { removeDirs, tempDir } from "./helpers";

/*
 * The one way the runner gets its coding CLIs (ADR 0228 §6): a pinned build per CLI and system, its hash checked,
 * fetched where the person's own is older or missing and the CLI is wanted, told as it goes.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const command of Object.values(CLI_COMMAND)) setCliPick(command, undefined);
  removeDirs(dirs.splice(0));
});

/** A vendor's build: a tarball with one program that says its version. */
function tarball(program: string, version: string) {
  const src = tempDir("cli-src-");
  dirs.push(src);
  writeFileSync(path.join(src, program), `#!/bin/sh\necho "${program} ${version}"\n`, { mode: 0o755 });
  const file = path.join(src, "cli.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, program]);
  const bytes = readFileSync(file);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Pins where every CLI has a `linux-x64` build at a test address (the Antigravity CLI's is the tarball). */
function pinsFor(made: { sha256: string }, version = "9.9.9"): CliPins {
  const pin = (cli: PinCli) => ({
    version,
    builds: {
      "linux-x64": {
        url: `https://downloads.example/${cli}.tar.gz`,
        hash: { algorithm: "sha256" as const, value: made.sha256 },
        archive: "tar.gz" as const,
        executable: "antigravity",
      },
    },
  });
  return {
    claude: pin("claude"),
    codex: pin("codex"),
    cursor: pin("cursor"),
    opencode: pin("opencode"),
    grok: pin("grok"),
    antigravity: pin("antigravity"),
    devin: pin("devin"),
    git: pin("git"),
  };
}

function copies(over: Partial<CliCopiesOptions> & { bytes?: Buffer; sha256?: string; wanted?: PinCli[] } = {}) {
  const home = tempDir("cli-home-");
  dirs.push(home);
  const made = over.bytes ? { bytes: over.bytes, sha256: over.sha256 ?? "" } : tarball("antigravity", "9.9.9");
  const fetched: string[] = [];
  const changes: number[] = [];
  const logs: string[] = [];
  const told: [PinCli, CliFetchState][] = [];
  const wanted = over.wanted ?? ["antigravity"];
  const cli = new CliCopies({
    home,
    log: (l) => logs.push(l),
    inUse: (c) => wanted.includes(c),
    onChange: () => changes.push(1),
    onFetch: (c, s) => told.push([c, s]),
    pins: pinsFor(made),
    platform: "linux-x64",
    own: async () => null,
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(made.bytes, { headers: { "content-length": String(made.bytes.length) } });
    }) as unknown as typeof fetch,
    ...over,
  });
  return { cli, home, fetched, changes, logs, told };
}

test("a CLI wanted here with no copy of the person's: the pinned build, checked, runs every call of its command", async () => {
  const { cli, fetched, changes, told } = copies();
  await cli.check();
  const file = cli.file("antigravity") as string;
  expect(fetched).toEqual(["https://downloads.example/antigravity.tar.gz"]);
  expect(pickedCli("agy")).toBe(file);
  expect(resolveCommand("agy")).toBe(file);
  expect(execFileSync(file, { encoding: "utf8" }).trim()).toBe("antigravity 9.9.9");
  expect(changes).toHaveLength(1);
  expect(told[0]).toEqual(["antigravity", { state: "fetching", version: "9.9.9", done: 0, total: null }]);
  expect(told.at(-1)).toEqual(["antigravity", { state: "ready", version: "9.9.9" }]);
  expect(cli.info().fetch.antigravity).toEqual({ state: "ready", version: "9.9.9" });
  // Already there: nothing fetched again, nothing to tell.
  await cli.check();
  expect(fetched).toHaveLength(1);
  expect(changes).toHaveLength(1);
});

test("system mode: the agents' copy is root's alone to change, linked onto every agent's PATH where nothing else is", async () => {
  // An archive whose files say anyone may write them (tar run as root keeps that).
  const src = tempDir("cli-src-");
  dirs.push(src);
  writeFileSync(path.join(src, "antigravity"), '#!/bin/sh\necho "antigravity 9.9.9"\n', { mode: 0o777 });
  mkdirSync(path.join(src, "lib"), { mode: 0o777 });
  writeFileSync(path.join(src, "lib", "part.js"), "", { mode: 0o666 });
  chmodSync(path.join(src, "antigravity"), 0o777);
  chmodSync(path.join(src, "lib"), 0o777);
  chmodSync(path.join(src, "lib", "part.js"), 0o666);
  const file = path.join(src, "cli.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", src, "antigravity", "lib"]);
  const bytes = readFileSync(file);
  const bin = tempDir("bin-");
  dirs.push(bin);
  const { cli } = copies({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), shared: { bin } });
  expect(cli.forAgents).toBe(true);
  // As root's tar would, the archive's modes kept as they are.
  const umask = process.umask(0);
  try {
    await cli.check();
  } finally {
    process.umask(umask);
  }
  const copy = cli.file("antigravity") as string;
  const dir = path.dirname(copy);
  // Nobody but its owner writes there; everyone reads, and enters its folders.
  for (const f of [path.dirname(dir), dir, copy, path.join(dir, "lib"), path.join(dir, "lib", "part.js")]) {
    expect({ f, write: statSync(f).mode & 0o022 }).toEqual({ f, write: 0 });
    expect({ f, read: statSync(f).mode & 0o004 }).toEqual({ f, read: 0o004 });
  }
  expect(readlinkSync(path.join(bin, "agy"))).toBe(copy);
  expect(execFileSync(path.join(bin, "agy"), { encoding: "utf8" }).trim()).toBe("antigravity 9.9.9");
  // Someone's own `agy` there stays as it is.
  setCliPick("agy", undefined);
  const theirs = tempDir("bin-");
  dirs.push(theirs);
  writeFileSync(path.join(theirs, "agy"), "#!/bin/sh\n", { mode: 0o755 });
  const kept = copies({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), shared: { bin: theirs } });
  await kept.cli.check();
  expect(lstatSync(path.join(theirs, "agy")).isSymbolicLink()).toBe(false);
  // The runner's own link to an older copy moves to the new one.
  setCliPick("agy", undefined);
  const again = copies({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), shared: { bin } });
  rmSync(path.join(bin, "agy"));
  symlinkSync(path.join(again.home, "clis", "antigravity-1.0.0", "antigravity"), path.join(bin, "agy"));
  await again.cli.check();
  expect(readlinkSync(path.join(bin, "agy"))).toBe(again.cli.file("antigravity") as string);
});

test("system mode: a new pin replaces the runner's older copy the agents reach", async () => {
  const bin = tempDir("bin-");
  dirs.push(bin);
  // The agents reach whatever `bin/agy` is (`agentsCopy` claims the pinned version for any copy they start).
  const reach = async (_: PinCli, pinned: string) =>
    existsSync(path.join(bin, "agy")) ? { file: "agy", version: pinned } : null;
  const { cli, home, fetched } = copies({ shared: { bin }, own: reach });
  const older = path.join(home, "clis", "antigravity-1.0.0", "antigravity");
  mkdirSync(path.dirname(older), { recursive: true });
  writeFileSync(older, '#!/bin/sh\necho "antigravity 1.0.0"\n', { mode: 0o755 });
  symlinkSync(older, path.join(bin, "agy"));
  await cli.check();
  expect(fetched).toEqual(["https://downloads.example/antigravity.tar.gz"]);
  expect(readlinkSync(path.join(bin, "agy"))).toBe(cli.file("antigravity") as string);
  expect(existsSync(older)).toBe(false);
  // At this pin now: nothing fetched again.
  await cli.check();
  expect(fetched).toHaveLength(1);
});

test("nothing fetched for a CLI nobody wants here and the person doesn't have", async () => {
  const { cli, fetched } = copies({ wanted: [] });
  await cli.check();
  expect(fetched).toHaveLength(0);
  expect(pickedCli("agy")).toBeUndefined();
});

test("the person's own copy: an older one is replaced for the runner, one at the pin or newer runs as it is", async () => {
  const older = copies({
    wanted: [],
    own: async (c) => (c === "antigravity" ? { file: "/usr/local/bin/agy", version: "agy 1.5.0" } : null),
  });
  await older.cli.check();
  expect(pickedCli("agy")).toBe(older.cli.file("antigravity") as string);
  setCliPick("agy", undefined);
  const newer = copies({ own: async () => ({ file: "/usr/local/bin/agy", version: "10.0.1" }) });
  await newer.cli.check();
  expect(newer.fetched).toHaveLength(0);
  expect(pickedCli("agy")).toBeUndefined();
});

test("a download that isn't the pinned build is never used, says why, and waits before trying again", async () => {
  let now = 1_000_000;
  const { cli, fetched, told } = copies({
    sha256: "0".repeat(64),
    bytes: tarball("antigravity", "6.6.6").bytes,
    now: () => now,
  });
  await cli.check();
  expect(existsSync(cli.file("antigravity") as string)).toBe(false);
  expect(pickedCli("agy")).toBeUndefined();
  expect(told.at(-1)).toEqual(["antigravity", { state: "failed", version: "9.9.9", reason: "hash_mismatch" }]);
  await cli.check();
  expect(fetched).toHaveLength(1);
  now += RETRY_MS + 1;
  await cli.check();
  expect(fetched).toHaveLength(2);
});

test("a sign-in or a turn gets its CLI at once; a failure reads in words; the person's own new enough needs nothing", async () => {
  const { cli, fetched } = copies({ wanted: [] });
  await cli.ensure("antigravity");
  expect(fetched).toHaveLength(1);
  expect(pickedCli("agy")).toBe(cli.file("antigravity") as string);
  await cli.ensure("antigravity");
  expect(fetched).toHaveLength(1);
  setCliPick("agy", undefined);
  const broken = copies({ wanted: [], sha256: "0".repeat(64), bytes: tarball("antigravity", "6.6.6").bytes });
  await expect(broken.cli.ensure("antigravity")).rejects.toThrow(
    "Couldn't get the Antigravity CLI ready on this computer: the download didn't match the vendor's build",
  );
  const own = copies({ own: async () => ({ file: "/usr/local/bin/agy", version: "agy 9.9.9" }) });
  await own.cli.ensure("antigravity");
  expect(own.fetched).toHaveLength(0);
});

test("no build for this system: nothing fetchable, and a turn says so", async () => {
  const { cli, fetched } = copies({ platform: "win32-arm64" });
  expect(cli.info().fetchable).toEqual([]);
  await cli.check();
  expect(fetched).toHaveLength(0);
  await expect(cli.ensure("antigravity")).rejects.toThrow("there is no build of it for this computer's system");
  expect(cli.retry("antigravity")).toEqual({ state: "failed", version: "9.9.9", reason: "no_build" });
});

test("Try again: a fetch starts at once even right after a failure", async () => {
  const { cli, fetched } = copies({ sha256: "0".repeat(64), bytes: tarball("antigravity", "6.6.6").bytes });
  await cli.check();
  expect(fetched).toHaveLength(1);
  cli.retry("antigravity");
  await new Promise((r) => setTimeout(r, 50));
  expect(fetched).toHaveLength(2);
});

test("an older copy goes once the new one runs; the new one moves in whole, never half unpacked", async () => {
  const { cli, home } = copies();
  const old = path.join(home, "clis", "antigravity-1.0.0");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "antigravity"), "old", { mode: 0o755 });
  await cli.check();
  expect(existsSync(old)).toBe(false);
  expect(existsSync(cli.file("antigravity") as string)).toBe(true);
  expect(existsSync(`${path.dirname(cli.file("antigravity") as string)}.${process.pid}.tmp`)).toBe(false);
});

test("the server's pins replace the built-in ones and are kept for the next start; a bad one is ignored", async () => {
  const { cli, home } = copies({ wanted: [] });
  const made = tarball("antigravity", "9.9.10");
  await cli.setPins({ antigravity: pinsFor(made, "9.9.10").antigravity, codex: { version: "1", builds: "x" } });
  expect(cli.file("antigravity")).toContain("antigravity-9.9.10");
  const kept = JSON.parse(readFileSync(path.join(home, "cli-pins.json"), "utf8"));
  expect(Object.keys(kept)).toEqual(["antigravity"]);
  await cli.setPins({ antigravity: { version: "9.9.11", builds: { "linux-x64": { url: "http://plain.example" } } } });
  expect(cli.file("antigravity")).toContain("antigravity-9.9.10");
});

test("progress is told at most once a second, or every 5%", () => {
  let now = 0;
  const gate = progressGate(() => now);
  expect(gate(0, 100)).toBe(true);
  expect(gate(1, 100)).toBe(false);
  expect(gate(PROGRESS_STEP, 100)).toBe(true);
  now += 500;
  expect(gate(PROGRESS_STEP + 1, 100)).toBe(false);
  now += 600;
  expect(gate(PROGRESS_STEP + 2, 100)).toBe(true);
  // No total: by time only.
  const blind = progressGate(() => now);
  expect(blind(10, null)).toBe(true);
  expect(blind(10_000_000, null)).toBe(false);
});

test("every CLI the runner starts keeps from updating itself; a value already set stays", () => {
  const env: NodeJS.ProcessEnv = { DISABLE_AUTOUPDATER: "0" };
  holdCliSelfUpdates(env);
  expect(env.DISABLE_AUTOUPDATER).toBe("0");
  for (const [name, value] of Object.entries(CLI_NO_SELF_UPDATE))
    if (name !== "DISABLE_AUTOUPDATER") expect(env[name]).toBe(value);
});

test("the built-in pins: every CLI pinned, https and a hash for each build; the Antigravity CLI runs Gemini 4 Neon", () => {
  for (const [cli, pin] of Object.entries(CLI_PINS)) {
    expect(Object.keys(pin.builds).length).toBeGreaterThan(0);
    for (const b of Object.values(pin.builds)) {
      expect(b?.url.startsWith("https://")).toBe(true);
      expect(b?.hash.value).toMatch(b?.hash.algorithm === "sha512" ? /^[0-9a-f]{128}$/ : /^[0-9a-f]{64}$/);
      expect(b?.url).toContain(pin.version.split("-")[0] as string);
    }
    expect(cli in CLI_COMMAND).toBe(true);
  }
  expect(cliVersionAtLeast(CLI_PINS.antigravity.version, ANTIGRAVITY_NEON_CLI)).toBe(true);
});

test("a build made from another file of its package, started with files of its own: both kept with the pick", async () => {
  const made = tarball("antigravity", "9.9.9");
  const pins = pinsFor(made);
  // As MinGit's bash (a copy of `sh.exe` named `bash.exe`) and Cursor's Windows `node.exe` with its `index.js`.
  pins.antigravity.builds["linux-x64"] = {
    ...(pins.antigravity.builds["linux-x64"] as NonNullable<(typeof pins.antigravity.builds)["linux-x64"]>),
    executable: "bin/agy-copy",
    from: "antigravity",
    launch: ["antigravity"],
  };
  const { cli } = copies({ pins, bytes: made.bytes, sha256: made.sha256 });
  await cli.ensure("antigravity");
  const file = cli.file("antigravity") as string;
  expect(execFileSync(file, { encoding: "utf8" }).trim()).toBe("antigravity 9.9.9");
  expect(pickedCli("agy")).toBe(file);
  const launch = path.join(path.dirname(path.dirname(file)), "antigravity");
  expect(pickedLaunch("agy")).toEqual([launch]);
  // Every start of the command goes through the pick with its files first, on Windows as elsewhere.
  expect(cliSpawn(["agy"], ["-p", "hi"], "", "linux")).toEqual({ file, args: [launch, "-p", "hi"] });
  expect(cliSpawn(["agy"], ["-p", "hi"], "", "win32")).toMatchObject({ file, args: [launch, "-p", "hi"] });
});

test("a package that lacks the file its program is made from is refused, never half kept", async () => {
  const made = tarball("antigravity", "9.9.9");
  const pins = pinsFor(made);
  pins.antigravity.builds["linux-x64"] = {
    ...(pins.antigravity.builds["linux-x64"] as NonNullable<(typeof pins.antigravity.builds)["linux-x64"]>),
    executable: "bin/bash",
    from: "usr/bin/sh",
  };
  const { cli, told } = copies({ pins, bytes: made.bytes, sha256: made.sha256 });
  await expect(cli.ensure("antigravity")).rejects.toMatchObject({ code: "internal" });
  expect(told.at(-1)).toEqual(["antigravity", { state: "failed", version: "9.9.9", reason: "failed" }]);
  expect(existsSync(cli.file("antigravity") as string)).toBe(false);
});

test("Windows unpacks with its own tar.exe (bsdtar reads zips), never one on the PATH; Linux's zips need unzip", () => {
  const zip = { url: "https://x/y.zip", hash: { algorithm: "sha256" as const, value: "0".repeat(64) } };
  const build = { ...zip, archive: "zip" as const, strip: 1, executable: "node.exe" };
  expect(unpackCommand("a.zip", "out", build, "win32", { SystemRoot: "D:\\Win" })).toEqual([
    "D:\\Win\\System32\\tar.exe",
    ["-xf", "a.zip", "-C", "out", "--strip-components=1"],
  ]);
  expect(unpackCommand("a.zip", "out", build, "linux", {})).toEqual(["unzip", ["-q", "-o", "a.zip", "-d", "out"]]);
  expect(unpackCommand("a.tgz", "out", { ...build, archive: "tar.gz" }, "darwin", {})[0]).toBe("tar");
});

test("Git for Windows is fetched on Windows only, and only while Claude Code is wanted there", () => {
  const win = new CliCopies({
    home: "/nowhere",
    log: () => undefined,
    inUse: () => false,
    onChange: () => undefined,
    onFetch: () => undefined,
    platform: "win32-x64",
  });
  expect(win.info().fetchable).toContain("git");
  expect(win.file("git")).toMatch(/usr[\\/]bin[\\/]bash\.exe$/);
  const mac = new CliCopies({
    home: "/nowhere",
    log: () => undefined,
    inUse: () => false,
    onChange: () => undefined,
    onFetch: () => undefined,
    platform: "darwin-arm64",
  });
  expect(mac.info().fetchable).not.toContain("git");
  expect(mac.file("git")).toBeNull();
  expect(CLI_COMMAND.git).not.toBe("git");
});
