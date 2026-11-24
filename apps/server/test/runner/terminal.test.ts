import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { hasBunTerminal } from "../../runner/launch";
import type { DataSocket } from "../../runner/streams";
import {
  type Pty,
  type PtyOptions,
  runnerTerminalUser,
  type SpawnPty,
  systemTerminalUser,
  type TerminalLimits,
  Terminals,
  type TerminalUser,
} from "../../runner/terminal";
import { errorCode, memoryDataSocket, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const opened: Terminals[] = [];
afterEach(() => {
  // Shells a test left open hang up (and their idle and max timers go with them).
  for (const t of opened.splice(0)) t.closeAll();
  removeDirs(dirs);
});

const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const ops: AgentScope = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const SIZE = { cols: 80, rows: 24 };

interface FakePty extends Pty {
  argv: string[];
  opts: PtyOptions;
  written: Buffer[];
  sizes: [number, number][];
  hungUp: boolean;
  /** The shell prints. */
  print(text: string): void;
  /** The shell ends with this code (null: a signal). */
  exit(code: number | null): void;
}

/** Shells that live until they exit or are hung up. */
function fakeShells() {
  const shells: FakePty[] = [];
  const spawn: SpawnPty = (argv, opts) => {
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const pty: FakePty = {
      argv,
      opts,
      written: [],
      sizes: [],
      hungUp: false,
      write: (data) => {
        pty.written.push(Buffer.from(data));
      },
      resize: (cols, rows) => {
        pty.sizes.push([cols, rows]);
      },
      hangup: () => {
        pty.hungUp = true;
        settle(null);
      },
      kill: () => settle(null),
      exited,
      print: (text) => opts.data(Buffer.from(text)),
      exit: (code) => settle(code),
    };
    shells.push(pty);
    return pty;
  };
  return { shells, spawn };
}

const USER: TerminalUser = {
  prefix: [],
  env: { HOME: "/home/dev", USER: "dev", LOGNAME: "dev", SHELL: "/bin/sh", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  cwd: "/srv/agentes/dev-01a142cb",
};

function setup(
  limits: Partial<TerminalLimits> = {},
  user: (agent: AgentScope, cwd?: string) => Promise<TerminalUser> = async () => USER,
) {
  const fake = fakeShells();
  const logs: string[] = [];
  const terminals = new Terminals({
    user,
    log: (line) => logs.push(line),
    spawn: fake.spawn,
    system: { platform: "linux", pty: true, runtime: "Bun 1.4.4", uid: 1000 },
    limits,
  });
  opened.push(terminals);
  /** Opens a terminal of `agent` on a data socket in memory. */
  const open = async (agent: AgentScope = dev) => {
    const data = memoryDataSocket();
    await terminals.open(agent, SIZE, async () => data.socket);
    const shell = fake.shells.at(-1) as FakePty;
    return { data, shell };
  };
  return { terminals, fake, logs, open };
}

const exitFrames = (data: ReturnType<typeof memoryDataSocket>) => data.texts().map((t) => JSON.parse(t));

test("info: Linux and Mac computers, with the runner on Bun 1.3.5 or newer", () => {
  const ask = (system: { platform: string; pty: boolean; runtime: string; uid?: number }) =>
    new Terminals({ user: async () => USER, log: () => undefined, system: { uid: 1000, ...system } }).info();
  expect(ask({ platform: "linux", pty: true, runtime: "Bun 1.4.4" })).toEqual({ available: true });
  expect(ask({ platform: "darwin", pty: true, runtime: "Bun 1.4.4" })).toEqual({ available: true });
  expect(ask({ platform: "win32", pty: true, runtime: "Bun 1.4.4" }).reason).toContain("Linux and Mac");
  expect(ask({ platform: "linux", pty: false, runtime: "Node 22.12.0" }).reason).toBe(
    "The terminal needs the runner on Bun 1.3.5 or newer (it runs on Node 22.12.0)",
  );
  expect(ask({ platform: "linux", pty: true, runtime: "Bun 1.4.4", uid: 0 })).toMatchObject({
    reason: expect.stringContaining("never run as root"),
    code: "not_as_root",
  });
});

test("a runner running as root opens a shell only through a launcher that runs it as the agent", async () => {
  const shells = fakeShells();
  const asRoot = (user: TerminalUser, agentUsers = true) =>
    new Terminals({
      user: async () => user,
      log: () => undefined,
      spawn: shells.spawn,
      system: { platform: "linux", pty: true, runtime: "Bun 1.4.4", uid: 0 },
      agentUsers,
    });
  const data = async () => memoryDataSocket().socket;
  expect(await errorCode(() => asRoot(USER, false).open(dev, SIZE, data))).toBe("terminal_unavailable");
  // Said to run agents as their own users, yet given no launcher: still never as root.
  expect(await errorCode(() => asRoot(USER).open(dev, SIZE, data))).toBe("terminal_unavailable");
  expect(shells.shells).toHaveLength(0);
  const prefix = ["/usr/bin/setpriv", "--reuid=ag-01a142cb", "--regid=ag-01a142cb", "--init-groups", "--"];
  const root = asRoot({ ...USER, prefix });
  opened.push(root);
  await root.open(dev, SIZE, data);
  expect(shells.shells[0]?.argv.slice(0, prefix.length)).toEqual(prefix);
});

test("the agent's login shell in its folder, through its launcher, with TERM and nothing of the runner's environment", async () => {
  const folder = tempDir("term-");
  dirs.push(folder);
  process.env.AGENTES_TEST_RUNNER_SECRET = "s3cret";
  try {
    const t = setup({}, async () => runnerTerminalUser(folder));
    const { shell } = await t.open();
    expect(shell.argv.at(-1)).toBe("-l");
    expect(shell.opts.cwd).toBe(folder);
    expect(Object.keys(shell.opts.env).sort()).toEqual(
      ["COLORTERM", "HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "USER"].sort(),
    );
    expect(shell.opts.env).toMatchObject({ HOME: os.homedir(), TERM: "xterm-256color", COLORTERM: "truecolor" });
    expect(JSON.stringify(shell.opts)).not.toContain("s3cret");
    expect([shell.opts.cols, shell.opts.rows]).toEqual([80, 24]);
  } finally {
    delete process.env.AGENTES_TEST_RUNNER_SECRET;
  }

  // In system mode the launcher runs it as the agent's own user.
  const prefix = [
    "/usr/bin/systemd-run",
    "--scope",
    "--",
    "/usr/bin/setpriv",
    "--reuid=ag-01a142cb",
    "--regid=ag-01a142cb",
    "--init-groups",
    "--",
  ];
  const t = setup({}, async () => ({ ...USER, prefix }));
  const { shell } = await t.open();
  expect(shell.argv).toEqual([...prefix, "/bin/sh", "-l"]);
});

test("system mode's terminal: root starts it in the agent's home, the agent's own user moves to its folder", async () => {
  const home = tempDir("term-home-");
  dirs.push(home);
  const launcher = {
    prefix: ["/usr/bin/setpriv", "--reuid=ag-01a142cb", "--regid=ag-01a142cb", "--init-groups", "--"],
    env: { HOME: home, USER: "ag-01a142cb", PATH: "/usr/bin:/bin", SHELL: "/bin/bash" },
    home,
  };
  const folder = path.join(home, "dev-01a142cb");
  mkdirSync(folder);
  // Even with the folder there: the agent could swap it for a link before root's chdir.
  const user = systemTerminalUser(launcher, dev);
  expect(user.cwd).toBe(home);
  expect(user.env).toEqual(launcher.env);
  expect(user.prefix.slice(0, launcher.prefix.length)).toEqual(launcher.prefix);
  // What runs after the launcher, here as this test's user: in the folder once made, else in the home.
  const pwd = (agent: AgentScope, cwd?: string) => {
    const rest = systemTerminalUser(launcher, agent, cwd).prefix.slice(launcher.prefix.length);
    return Bun.spawnSync([...rest, "/bin/sh", "-c", "pwd -P"], { cwd: home, env: launcher.env }).stdout.toString();
  };
  expect(pwd(dev).trim()).toBe(realpathSync(folder));
  expect(pwd(ops).trim()).toBe(realpathSync(home));

  // A code session's worktree (ADR 0215): the agent's own user changes into it after its folder.
  const worktree = path.join(folder, ".worktrees", "c-1a2b3c4d");
  mkdirSync(worktree, { recursive: true });
  expect(pwd(dev, ".worktrees/c-1a2b3c4d").trim()).toBe(realpathSync(worktree));
  // Not there: the agent's folder. A name like one of `cd`'s options is still a folder's name.
  expect(pwd(dev, ".worktrees/c-gone").trim()).toBe(realpathSync(folder));
  mkdirSync(path.join(folder, "-P"));
  expect(pwd(dev, "-P").trim()).toBe(realpathSync(path.join(folder, "-P")));
  // No folder for the agent yet: its home, whatever was asked.
  expect(pwd(ops, ".worktrees/c-1a2b3c4d").trim()).toBe(realpathSync(home));
  // Words that leave the folder are refused before anything runs.
  expect(await errorCode(() => systemTerminalUser(launcher, dev, "../ops-9f00aa11"))).toBe("outside_workspace");
  expect(await errorCode(() => systemTerminalUser(launcher, dev, "/etc"))).toBe("outside_workspace");
});

test("a code session's terminal starts in its worktree inside the agent's folder; one gone in the folder; never outside it", async () => {
  const folder = tempDir("term-cwd-");
  const outside = tempDir("term-out-");
  dirs.push(folder, outside);
  const worktree = path.join(folder, ".worktrees", "c-1a2b3c4d");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(folder, "notes.txt"), "x");
  symlinkSync(outside, path.join(folder, "away"));
  const at = async (cwd?: string) => (await runnerTerminalUser(folder, cwd)).cwd;
  expect(await at()).toBe(folder);
  expect(await at(".worktrees/c-1a2b3c4d")).toBe(worktree);
  // Gone (the session was closed), or not a folder: the agent's folder.
  expect(await at(".worktrees/c-gone")).toBe(folder);
  expect(await at("notes.txt")).toBe(folder);
  // Never outside it, by its words or through a link.
  expect(await errorCode(() => at("../"))).toBe("outside_workspace");
  expect(await errorCode(() => at("/etc"))).toBe("outside_workspace");
  expect(await errorCode(() => at("away"))).toBe("outside_workspace");

  // The folder asked reaches who says where the shell runs, and the log says where it opened.
  const asked: (string | undefined)[] = [];
  const t = setup({}, async (_agent, cwd) => {
    asked.push(cwd);
    return runnerTerminalUser(folder, cwd);
  });
  await t.terminals.open(dev, SIZE, async () => memoryDataSocket().socket, ".worktrees/c-1a2b3c4d");
  expect(asked).toEqual([".worktrees/c-1a2b3c4d"]);
  expect(t.fake.shells.at(-1)?.opts.cwd).toBe(worktree);
  expect(t.logs[0]).toBe("a terminal as dev opened in .worktrees/c-1a2b3c4d (80×24)");
  // Refused before any shell starts.
  const refused = () => t.terminals.open(dev, SIZE, async () => memoryDataSocket().socket, "../../etc");
  expect(await errorCode(refused)).toBe("outside_workspace");
  expect(t.fake.shells).toHaveLength(1);
  expect(t.terminals.count()).toBe(1);
});

test("what the shell prints before the data socket is ready waits for it; keys and a resize reach the shell", async () => {
  const t = setup();
  const data = memoryDataSocket();
  let ready: (socket: DataSocket) => void = () => undefined;
  const opening = t.terminals.open(dev, SIZE, () => new Promise<DataSocket>((resolve) => (ready = resolve)));
  await waitFor(() => t.fake.shells.length === 1);
  const shell = t.fake.shells[0] as FakePty;
  shell.print("Welcome\r\n$ ");
  ready(data.socket);
  await opening;
  expect(data.bytes().toString()).toBe("Welcome\r\n$ ");

  data.send("ls\r");
  data.control({ type: "resize", cols: 132, rows: 40 });
  expect(Buffer.concat(shell.written).toString()).toBe("ls\r");
  expect(shell.sizes).toEqual([[132, 40]]);
  expect(t.logs[0]).toBe("a terminal as dev opened (80×24)");
});

test("the shell's end goes to the person as `exit`, then the data socket closes (1000); a signal is null", async () => {
  const t = setup();
  const a = await t.open();
  a.shell.print("bye\r\n");
  a.shell.exit(3);
  await waitFor(() => a.data.closed !== null);
  expect(exitFrames(a.data)).toEqual([{ type: "exit", code: 3 }]);
  expect(a.data.closed?.code).toBe(1000);
  expect(t.terminals.count()).toBe(0);

  const b = await t.open();
  b.shell.exit(null);
  await waitFor(() => b.data.closed !== null);
  expect(exitFrames(b.data)).toEqual([{ type: "exit", code: null }]);
});

test("output the data socket can't take is dropped, and a marker says so once it drained", async () => {
  const t = setup({ bufferMax: 100 });
  const { data, shell } = await t.open();
  shell.print("one ");
  data.buffered = 1000;
  shell.print("lost ");
  shell.print("lost too ");
  data.buffered = 0;
  await waitFor(() => data.bytes().toString().includes("skipped"));
  shell.print("two");
  expect(data.bytes().toString()).toBe("one \r\n[output skipped: too fast]\r\ntwo");
});

test("the person leaving hangs the shell up; nothing more goes out", async () => {
  const t = setup();
  const { data, shell } = await t.open();
  data.end();
  expect(shell.hungUp).toBe(true);
  await waitFor(() => t.terminals.count() === 0);
  expect(data.texts()).toEqual([]);
  expect(t.logs.at(-1)).toContain("the person closed it");
});

test("idle with nothing either way, or open too long: hung up with a word for the person", async () => {
  const idle = setup({ idleMs: 60 });
  const a = await idle.open();
  await waitFor(() => a.shell.hungUp);
  await waitFor(() => a.data.closed !== null);
  expect(a.data.bytes().toString()).toContain("with nothing typed or shown]");
  expect(exitFrames(a.data)).toEqual([{ type: "exit", code: null }]);

  const busy = setup({ idleMs: 60, maxMs: 200 });
  const b = await busy.open();
  const started = Date.now();
  const typing = setInterval(() => b.data.send("x"), 10);
  await waitFor(() => b.shell.hungUp);
  clearInterval(typing);
  expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  expect(b.data.bytes().toString()).toContain("hours at most]");
});

test("caps: terminals per agent and per computer; a shell that can't get its data socket is ended", async () => {
  const t = setup({ perAgent: 2, perMachine: 3 });
  await t.open(dev);
  await t.open(dev);
  expect(await errorCode(() => t.open(dev))).toBe("too_many_streams");
  await t.open(ops);
  expect(await errorCode(() => t.open(ops))).toBe("too_many_streams");
  expect(t.terminals.count()).toBe(3);

  t.terminals.closeAll();
  await waitFor(() => t.terminals.count() === 0);
  const failing = t.terminals.open(dev, SIZE, async () => {
    throw new Error("no data socket");
  });
  await expect(failing).rejects.toThrow("The terminal couldn't start: no data socket");
  expect(t.fake.shells.at(-1)?.hungUp).toBe(true);
  expect(t.terminals.count()).toBe(0);

  // Turned off while one opens: it ends as soon as it is up.
  const data = memoryDataSocket();
  let ready: (socket: DataSocket) => void = () => undefined;
  const shells = t.fake.shells.length;
  const opening = t.terminals.open(dev, SIZE, () => new Promise<DataSocket>((resolve) => (ready = resolve)));
  await waitFor(() => t.fake.shells.length === shells + 1);
  t.terminals.closeAll();
  ready(data.socket);
  await opening;
  await waitFor(() => data.closed !== null);
  expect(data.bytes().toString()).toContain("[the terminal was turned off on this computer]");
  expect(t.terminals.count()).toBe(0);
});

test.skipIf(!hasBunTerminal())("a real shell in a PTY: its size, a resize, its output and its exit code", async () => {
  const folder = tempDir("pty-");
  dirs.push(folder);
  const terminals = new Terminals({
    user: async () => ({ prefix: [], env: { HOME: folder, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" }, cwd: folder }),
    log: () => undefined,
  });
  const data = memoryDataSocket();
  await terminals.open(dev, SIZE, async () => data.socket);
  data.send('echo "SIZE""=$(stty size)"\n');
  await waitFor(() => data.bytes().toString().includes("SIZE=24 80"), 5000);
  data.control({ type: "resize", cols: 132, rows: 40 });
  data.send('echo "SIZE""=$(stty size) in $PWD"; exit 7\n');
  await waitFor(() => data.closed !== null, 5000);
  expect(data.bytes().toString()).toContain(`SIZE=40 132 in ${folder}`);
  expect(exitFrames(data)).toEqual([{ type: "exit", code: 7 }]);
});

test("a named terminal keeps its shell when its viewer leaves, and the same name comes back to it", async () => {
  const { terminals, fake, logs } = setup({ keptMs: 60, replayMax: 64 });
  const first = memoryDataSocket();
  await terminals.open(dev, SIZE, async () => first.socket, undefined, "person.tab-0001");
  const shell = fake.shells[0] as FakePty;
  shell.print("one\r\n");
  expect(first.bytes().toString()).toBe("one\r\n");
  // The page is read again: the socket drops, the shell stays and goes on printing.
  first.end();
  expect(shell.hungUp).toBe(false);
  shell.print("two\r\n");
  expect(terminals.count(dev.id)).toBe(1);

  const second = memoryDataSocket();
  await terminals.open(dev, { cols: 100, rows: 30 }, async () => second.socket, undefined, "person.tab-0001");
  // The same shell, shown what it printed, and told to draw itself at the new size.
  expect(fake.shells).toHaveLength(1);
  expect(second.bytes().toString()).toBe("one\r\ntwo\r\n");
  expect(shell.sizes.at(-1)).toEqual([100, 30]);
  second.send("ls\n");
  expect(Buffer.concat(shell.written).toString()).toBe("ls\n");
  expect(logs.some((l) => l.includes("opened again"))).toBe(true);

  // Another name, or another agent with this name, is a shell of its own.
  await terminals.open(dev, SIZE, async () => memoryDataSocket().socket, undefined, "person.tab-0002");
  await terminals.open(ops, SIZE, async () => memoryDataSocket().socket, undefined, "person.tab-0001");
  expect(fake.shells).toHaveLength(3);

  // A third viewer takes it from the second, which closes without ending the shell.
  const third = memoryDataSocket();
  await terminals.open(dev, SIZE, async () => third.socket, undefined, "person.tab-0001");
  expect(second.closed).not.toBeNull();
  expect(second.texts().map((t) => JSON.parse(t))).toEqual([{ type: "moved" }]);
  expect(shell.hungUp).toBe(false);
  // The person closes its tab: the shell ends now.
  third.control({ type: "end" });
  expect(shell.hungUp).toBe(true);
});

test("a named terminal nobody comes back to ends; one without a name ends with its viewer", async () => {
  const { terminals, fake } = setup({ keptMs: 30 });
  const kept = memoryDataSocket();
  await terminals.open(dev, SIZE, async () => kept.socket, undefined, "person.tab-0003");
  const plain = memoryDataSocket();
  await terminals.open(dev, SIZE, async () => plain.socket);
  plain.end();
  expect((fake.shells[1] as FakePty).hungUp).toBe(true);
  kept.end();
  expect((fake.shells[0] as FakePty).hungUp).toBe(false);
  await waitFor(() => (fake.shells[0] as FakePty).hungUp);
  // Its name is free again: the next open is a new shell.
  await waitFor(() => terminals.count(dev.id) === 0);
  await terminals.open(dev, SIZE, async () => memoryDataSocket().socket, undefined, "person.tab-0003");
  expect(fake.shells).toHaveLength(3);
});
