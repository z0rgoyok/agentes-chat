import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AGENT_DESKTOP_SHA256,
  type AppsRunReply,
  agentDesktopUrl,
  MACHINE_OPS,
  parseRunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { APPS_STOP_MS, AppControl, type AppControlOptions, agentDesktopTarget, parseEnvelope } from "../../runner/apps";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const FAKE = path.join(import.meta.dir, "fake-agent-desktop.mjs");
const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const ops = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };

interface Logged {
  args: string[];
  stdin: string;
  home: string | null;
}

function setup(state: Record<string, unknown> = {}, opts: Partial<AppControlOptions> = {}) {
  const home = tempDir("apps-");
  dirs.push(home);
  const log = path.join(home, "log.jsonl");
  const stateFile = path.join(home, "state.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const needs: string[] = [];
  let changes = 0;
  let now = 1_000_000;
  const apps = new AppControl({
    home,
    log: () => {},
    command: [process.execPath, FAKE],
    platform: "darwin",
    env: { ...process.env, FAKE_AD_LOG: log, FAKE_AD_STATE: stateFile },
    needs: (p, trigger, agentId) => needs.push(`${p} ${trigger} ${agentId}`),
    onChange: () => changes++,
    now: () => now,
    ...opts,
  });
  const calls = (): Logged[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Logged)
      : [];
  return {
    apps,
    home,
    needs,
    calls,
    changes: () => changes,
    later: (ms: number) => {
      now += ms;
    },
    setState: (s: Record<string, unknown>) => writeFileSync(stateFile, JSON.stringify(s)),
  };
}

const ok = (r: AppsRunReply) => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as Record<string, unknown>;
};

describe("the person's apps through agent-desktop (ADR 0258)", () => {
  test("the protocol carries apps.run and hello.apps", () => {
    expect(MACHINE_OPS).toContain("apps.run");
    const hello = parseRunnerFrame(
      JSON.stringify({
        type: "hello",
        token: "t",
        protocol: 94,
        version: "1",
        hostname: "h",
        os: "darwin",
        arch: "arm64",
        workspace: "/w",
        exec: true,
        apps: { available: false, code: "apps_own_users", reason: "own users" },
      }),
    );
    expect(hello && "apps" in hello ? hello.apps : null).toEqual({
      available: false,
      code: "apps_own_users",
      reason: "own users",
    });
  });

  test("a snapshot names its app, runs headless with the agent's own state root, and its refs then act", async () => {
    const t = setup();
    const snap = ok(await t.apps.run(dev, { command: "snapshot", args: ["--app", "Mail", "-i", "--compact"] }));
    expect(snap.snapshot_id).toBe("s1abc");
    ok(await t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] }));
    ok(await t.apps.run(dev, { command: "type", args: ["@s1abc:e2"], text: "Hello -- --headed" }));
    const [first, click, type] = t.calls();
    expect(first?.args).toEqual(["snapshot", "--app", "Mail", "-i", "--compact"]);
    expect(click?.args).toEqual(["click", "@s1abc:e1"]);
    // The text goes on stdin, never among the arguments.
    expect(type?.args).toEqual(["type", "@s1abc:e2", "--stdin"]);
    expect(type?.stdin).toBe("Hello -- --headed");
    expect(first?.home).toBe(path.join(t.home, "apps", dev.id));
    for (const c of t.calls()) expect(c.args).not.toContain("--headed");
  });

  test("real input, coordinates, forcing and other windows are refused before anything runs", async () => {
    const t = setup();
    await t.apps.run(dev, { command: "snapshot", args: ["--app", "Mail"] });
    for (const args of [
      ["@s1abc:e1", "--headed"],
      ["@s1abc:e1", "--xy", "10,10"],
      ["@s1abc:e1", "--window-id", "w-1"],
      ["@s1abc:e1", "--session", "x"],
    ]) {
      expect(await errorCode(() => t.apps.run(dev, { command: "click", args }))).toBe("not_allowed");
    }
    expect(await errorCode(() => t.apps.run(dev, { command: "mouse-click", args: [] }))).toBe("bad_request");
    expect(await errorCode(() => t.apps.run(dev, { command: "clipboard-get", args: [] }))).toBe("bad_request");
    expect(
      await errorCode(() => t.apps.run(dev, { command: "press", args: ["cmd+q", "--force", "--app", "Mail"] })),
    ).toBe("not_allowed");
    // Without --app the CLI would read whatever is in front, agentes.chat included.
    expect(await errorCode(() => t.apps.run(dev, { command: "snapshot", args: [] }))).toBe("bad_request");
    expect(await errorCode(() => t.apps.run(dev, { command: "launch", args: ["/bin/sh"] }))).toBe("not_allowed");
    expect(t.calls()).toHaveLength(1);
  });

  test("agentes.chat is never read or acted on, by name or as a window in a browser", async () => {
    const t = setup();
    for (const app of ["agentes.chat", "chat.agentes.desktop", "agentes-runner"]) {
      expect(await errorCode(() => t.apps.run(dev, { command: "snapshot", args: ["--app", app] }))).toBe("not_allowed");
      expect(await errorCode(() => t.apps.run(dev, { command: "launch", args: [app] }))).toBe("not_allowed");
    }
    // Our web app runs in the person's browser signed in as them, under titles that don't name us.
    for (const app of [
      "Google Chrome",
      "Safari",
      "Firefox",
      "Microsoft Edge",
      "msedge.exe",
      "Arc",
      "com.google.Chrome",
    ]) {
      expect(await errorCode(() => t.apps.run(dev, { command: "snapshot", args: ["--app", app] }))).toBe("not_allowed");
      expect(await errorCode(() => t.apps.run(dev, { command: "launch", args: [app] }))).toBe("not_allowed");
    }
    expect(
      await errorCode(() => t.apps.run(dev, { command: "press", args: ["return", "--app", "Google Chrome"] })),
    ).toBe("not_allowed");
    expect(t.calls()).toHaveLength(0);
    // A browser we don't know, showing a page of ours that names us: dropped, by its window, its tree or a find's path.
    for (const state of [
      { window: "Settings · agentes.chat", snapshot: "s2abc" },
      { window: "Settings · agentes.chat", snapshot: "s3abc", noWindowField: true },
    ]) {
      t.setState(state);
      const shot = await t.apps.run(dev, { command: "snapshot", args: ["--app", "Some Browser"] });
      expect(shot.ok).toBe(false);
      // Its refs never act.
      const ref = `@${state.snapshot}:e1`;
      expect(await errorCode(() => t.apps.run(dev, { command: "click", args: [ref] }))).toBe("not_allowed");
    }
    t.setState({ window: "Settings · agentes.chat", snapshot: "s4abc" });
    const found = await t.apps.run(dev, { command: "find", args: ["--app", "Some Browser", "--text", "Approve"] });
    expect(found.ok).toBe(false);
    expect(await errorCode(() => t.apps.run(dev, { command: "click", args: ["@s4abc:e1"] }))).toBe("not_allowed");
    // A find in another app's window keeps its refs.
    t.setState({ window: "Inbox", snapshot: "s5abc" });
    expect((await t.apps.run(dev, { command: "find", args: ["--app", "Mail", "--text", "Send"] })).ok).toBe(true);
    expect((await t.apps.run(dev, { command: "click", args: ["@s5abc:e1"] })).ok).toBe(true);
  });

  test("the CLI never inherits variables of its own from the runner's environment", async () => {
    const t = setup({}, {});
    const env = { ...process.env, AGENT_DESKTOP_SESSION: "other", AGENT_DESKTOP_HOME: "/tmp/elsewhere" };
    const log = path.join(t.home, "env.jsonl");
    const probe = new AppControl({
      home: t.home,
      log: () => {},
      command: [
        process.execPath,
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.env) + "\\n"); console.log(JSON.stringify({ ok: true, data: {} }))`,
      ],
      platform: "darwin",
      env,
    });
    ok(await probe.run(dev, { command: "list-apps", args: [] }));
    const seen = JSON.parse(readFileSync(log, "utf8").trim()) as Record<string, string>;
    expect(seen.AGENT_DESKTOP_SESSION).toBeUndefined();
    expect(seen.AGENT_DESKTOP_HOME).toBe(path.join(t.home, "apps", dev.id));
  });

  test("a ref acts only from the same agent's snapshot", async () => {
    const t = setup();
    expect(await errorCode(() => t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] }))).toBe("not_allowed");
    await t.apps.run(ops, { command: "snapshot", args: ["--app", "Mail"] });
    expect(await errorCode(() => t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] }))).toBe("not_allowed");
    expect((await t.apps.run(ops, { command: "click", args: ["@s1abc:e1"] })).ok).toBe(true);
  });

  test("the menu bar hears who uses which app, and Stop refuses that agent for a while", async () => {
    const t = setup();
    await t.apps.run(dev, { command: "snapshot", args: ["--app", "Mail"] });
    expect(t.apps.using()).toEqual([]);
    await t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] });
    expect(t.apps.using()).toEqual([{ agentId: dev.id, app: "Mail", actedAt: new Date(1_000_000).toISOString() }]);
    expect(t.changes()).toBe(1);
    t.apps.stop(dev.id);
    expect(t.apps.using()).toEqual([]);
    expect(await errorCode(() => t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] }))).toBe("not_allowed");
    expect((await t.apps.run(ops, { command: "list-apps", args: [] })).ok).toBe(true);
    t.later(APPS_STOP_MS);
    expect((await t.apps.run(dev, { command: "click", args: ["@s1abc:e1"] })).ok).toBe(true);
  });

  test("a missing Accessibility permission becomes a wait the app asks for", async () => {
    const t = setup({ fail: { snapshot: { code: "PERM_DENIED" } } });
    const r = await t.apps.run(dev, { command: "snapshot", args: ["--app", "Mail"] });
    expect(r).toEqual({ ok: false, error: { code: "PERM_DENIED", message: "snapshot failed", retry: "safe" } });
    expect(t.needs).toEqual([`accessibility agent-desktop snapshot ${dev.id}`]);
  });

  test("hello.apps: never in system mode, nor on Linux without a graphical session", () => {
    expect(setup({}, { systemMode: true }).apps.info()).toMatchObject({ available: false, code: "apps_own_users" });
    expect(setup({}, { platform: "linux", env: {} }).apps.info()).toMatchObject({
      available: false,
      code: "apps_no_display",
    });
    expect(setup().apps.info()).toEqual({ available: true });
  });

  test("the pinned release: a target per system, refused when its checksum is wrong", async () => {
    expect(agentDesktopTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(agentDesktopTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
    expect(agentDesktopTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(agentDesktopTarget("freebsd", "x64")).toBeNull();
    const asked: string[] = [];
    const t = setup(
      {},
      {
        command: undefined,
        execPath: "/nowhere/agentes-runner",
        arch: "arm64",
        fetch: (async (url: string) => {
          asked.push(url);
          return new Response("not the archive");
        }) as unknown as typeof fetch,
      },
    );
    expect(await errorCode(() => t.apps.run(dev, { command: "list-apps", args: [] }))).toBe("unsupported");
    expect(asked).toEqual([agentDesktopUrl("aarch64-apple-darwin")]);
    expect(createHash("sha256").update("not the archive").digest("hex")).not.toBe(
      AGENT_DESKTOP_SHA256["aarch64-apple-darwin"],
    );
    expect(existsSync(path.join(t.home, "bin", "agent-desktop-1.3.1"))).toBe(false);
    // The failure is said in hello for a while, not downloaded again on every command.
    expect(t.apps.info()).toMatchObject({ available: false, code: "apps_download" });
  });

  test("parseEnvelope reads the last line, and a crash is a failure", () => {
    expect(parseEnvelope('log\n{"ok":true,"data":{"a":1}}\n', 0)).toEqual({ ok: true, data: { a: 1 } });
    expect(parseEnvelope("", 139)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});
