import { afterEach, expect, test } from "bun:test";
import {
  AGENTS_CLI_PROTOCOL,
  AGY_COPY_PROTOCOL,
  ANTIGRAVITY_WINDOWS_PROTOCOL,
  CLI_COPIES_PROTOCOL,
  GROK_WINDOWS_PROTOCOL,
  orgTopic,
  type RealtimeEvent,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { brainOptions } from "../src/brain-settings";
import { cliOutdated } from "../src/brains/claude-code";
import { fetchesCli, fetchesOnAsk, fetchPercent, storeCliFetch } from "../src/cli-fetch";
import { listMachines } from "../src/machines";
import { type Fixture, setup } from "./fixtures";

/*
 * Computers that fetch their coding CLIs (ADR 0228 §6), on the server's side: a CLI the runner fetches is no reason to
 * refuse it, each fetch is kept with the computer and told to the apps.
 */

let f: Fixture | null = null;
afterEach(async () => {
  await f?.close?.();
  f = null;
});

const computer = (over: Record<string, unknown> = {}) => ({
  id: "m",
  name: "MacBook",
  kind: "connected",
  os: "darwin",
  protocol: CLI_COPIES_PROTOCOL,
  online: true,
  execAllowed: true,
  lastSeenAt: new Date(),
  access: { tools: { claude: true, codex: true, cursor: true, opencode: true, grok: true, antigravity: true } },
  executors: {
    detectedAt: new Date().toISOString(),
    copies: { fetchable: ["claude", "grok"] as ("claude" | "grok")[] },
  },
  ...over,
});

test("a CLI its runner fetches comes by itself; never on the workspace's own computer or in system mode", () => {
  expect(fetchesCli(computer(), "claude")).toBe(true);
  expect(fetchesCli(computer(), "codex")).toBe(false);
  expect(fetchesCli(computer({ kind: "managed" }), "claude")).toBe(false);
  expect(fetchesCli(computer({ executors: { mode: "system", copies: { fetchable: ["claude"] } } }), "claude")).toBe(
    false,
  );
  // An older runner brought only the Antigravity CLI, on macOS and Linux.
  expect(fetchesCli(computer({ protocol: AGY_COPY_PROTOCOL, executors: {} }), "antigravity")).toBe(true);
  expect(fetchesCli(computer({ protocol: AGY_COPY_PROTOCOL, executors: {} }), "claude")).toBe(false);
  expect(fetchesCli(computer({ protocol: AGY_COPY_PROTOCOL, os: "windows", executors: {} }), "antigravity")).toBe(
    false,
  );
});

test("system mode: the apps may ask for the agents' copy from a runner that makes one, which still never reads as there", () => {
  const system = (protocol: number, kind = "connected") =>
    computer({ kind, protocol, executors: { mode: "system", copies: { fetchable: ["claude", "codex"] } } });
  expect(fetchesOnAsk(system(AGENTS_CLI_PROTOCOL), "codex")).toBe(true);
  expect(fetchesOnAsk(system(AGENTS_CLI_PROTOCOL), "grok")).toBe(false);
  expect(fetchesOnAsk(system(AGENTS_CLI_PROTOCOL - 1), "codex")).toBe(false);
  expect(fetchesOnAsk(system(AGENTS_CLI_PROTOCOL, "managed"), "codex")).toBe(false);
  // Until the agents reach it, the brain waits for it: the turn would fail.
  expect(fetchesCli(system(AGENTS_CLI_PROTOCOL), "codex")).toBe(false);
  expect(fetchesOnAsk(computer(), "claude")).toBe(true);
});

test("not installed or too old is no reason where the runner fetches it: the brain can be chosen, the turn goes", () => {
  const options = brainOptions(computer() as never);
  expect(options.find((o) => o.kind === "claude_code")).toMatchObject({ available: true });
  expect(options.find((o) => o.kind === "grok")).toMatchObject({ available: true });
  expect(options.find((o) => o.kind === "codex")).toMatchObject({ available: false, reason: "not_installed" });
  const old = computer({
    executors: { claude: { version: "2.0.1 (Claude Code)" }, copies: { fetchable: ["claude"] } },
  });
  expect(cliOutdated(old as never, "claude", "Claude Code")).toBeNull();
  const notFetched = computer({ executors: { claude: { version: "2.0.1 (Claude Code)" } } });
  expect(cliOutdated(notFetched as never, "claude", "Claude Code")?.code).toBe("cli_outdated");
});

test("a fetch is kept with the computer and told to the apps as it goes", async () => {
  f = await setup();
  const [row] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "MacBook" }).returning();
  const id = row?.id as string;
  const told: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));
  const fetching = { state: "fetching" as const, version: "2.1.325", done: 45, total: 100 };
  await storeCliFetch({ db: f.db, pubsub: f.pubsub }, id, "claude", fetching);
  await storeCliFetch({ db: f.db, pubsub: f.pubsub }, id, "grok", {
    state: "failed",
    version: "1.0.92",
    reason: "offline",
  });
  const [stored] = await f.db.select().from(schema.machines).where(eq(schema.machines.id, id));
  expect(stored?.executors?.copies?.fetch).toEqual({
    claude: fetching,
    grok: { state: "failed", version: "1.0.92", reason: "offline" },
  });
  expect(JSON.stringify(told)).toContain('"cliFetch":{"claude":');
  expect(fetchPercent(fetching)).toBe(45);
  expect(fetchPercent({ state: "fetching", version: "1", done: 5, total: null })).toBeNull();
});

test("system mode: the apps hear which CLIs the runner installs for the agents, from the runner that does", async () => {
  f = await setup();
  const fx = f;
  const executors = { mode: "system" as const, copies: { fetchable: ["claude", "codex"] as ("claude" | "codex")[] } };
  const add = async (name: string, protocol: number) =>
    (
      await fx.db
        .insert(schema.machines)
        .values({ orgId: fx.org.id, name, protocol, executors, pairedByUserId: fx.owner.id })
        .returning()
    )[0]?.id;
  const now = await add("srv-new", AGENTS_CLI_PROTOCOL);
  const before = await add("srv-old", AGENTS_CLI_PROTOCOL - 1);
  const listed = await listMachines(fx.db, fx.owner.id, fx.org.id);
  expect(listed.find((m) => m.id === now)?.cliFetchable).toEqual(["claude", "codex"]);
  expect(listed.find((m) => m.id === before)?.cliFetchable).toEqual([]);
});

test("Windows: Cursor, Grok Build and Gemini can be chosen on a runner that keeps each sign-in in its folder there", () => {
  const all = ["claude", "codex", "cursor", "opencode", "grok", "antigravity", "git"] as const;
  const win = computer({
    os: "windows",
    executors: { detectedAt: new Date().toISOString(), copies: { fetchable: [...all] } },
  });
  for (const kind of ["cursor", "grok", "antigravity"] as const) {
    expect(brainOptions(win as never).find((o) => o.kind === kind)).toMatchObject({ available: true });
  }
  // An older Windows runner refuses their turns there: too old, never "not on this system". Grok Build runs there
  // from `GROK_WINDOWS_PROTOCOL`, Gemini from `ANTIGRAVITY_WINDOWS_PROTOCOL`, Cursor from `CLI_COPIES_PROTOCOL`.
  const reason = (protocol: number, kind: string) =>
    brainOptions(computer({ os: "windows", protocol, executors: {} }) as never).find((o) => o.kind === kind)?.reason;
  for (const kind of ["cursor", "grok", "antigravity"] as const) {
    expect(reason(GROK_WINDOWS_PROTOCOL - 1, kind)).toBe("runner_old");
  }
  expect(reason(ANTIGRAVITY_WINDOWS_PROTOCOL, "antigravity")).not.toBe("runner_old");
  expect(reason(ANTIGRAVITY_WINDOWS_PROTOCOL, "grok")).not.toBe("runner_old");
  expect(reason(CLI_COPIES_PROTOCOL - 1, "cursor")).toBe("runner_old");
  // Git for Windows comes by itself too, as the CLIs do.
  expect(fetchesCli(win as never, "git")).toBe(true);
});
