import { expect, test } from "bun:test";
import {
  AGY_COPY_PROTOCOL,
  ANTIGRAVITY_PROTOCOL,
  LOCKED_BRAIN_PROTOCOL,
  SHARED_GEMINI_PROTOCOL,
} from "@agenteschat/adapters";
import {
  ANTIGRAVITY_MODELS,
  GEMINI_ENTERPRISE_PROVIDER,
  sharedSignIn,
  signInProviderOf,
} from "@agenteschat/providers/plans";
import { antigravityModels, brainOptions, defaultBrainModel, isBrainKind } from "../src/brain-settings";
import { AntigravityBrain, type BrainTurnRequest, type ComputerBrainLink } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, UNAVAILABLE_CODES } from "../src/brains/select";
import { BRAIN_NAMES, BRAIN_PLAN_NAMES, type BrainEvent, type BrainTurn, isComputerBrain } from "../src/brains/types";
import { defaultAccountLabel, sharesSignIns } from "../src/machine-accounts";
import type { MachineStatus } from "../src/machine-hub";
import { scrubSignIns } from "../src/tool-detail";

const SESSION = "0193aaaa-0000-7000-8000-00000000f0df";
const ACCOUNT = { id: "0193eeee-0000-7000-8000-000000000002", label: "Gemini", status: "active" as const };

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: "0193aaaa-0000-7000-8000-000000000002",
  orgId: "org",
  agentId: "agent",
  channelId: "channel",
  threadRootId: null,
  system: "You are Dev.",
  messages: [{ role: "user", content: "run the tests" }],
  tools: [],
  trigger: "run the tests",
  session: { id: SESSION, resume: false, machineId: "m1", cwd: "" },
  account: ACCOUNT,
  ...over,
});

function link(opts: {
  protocol?: number;
  installed?: boolean;
  tools?: { claude: boolean; codex: boolean; antigravity?: boolean; commands: boolean };
  events?: BrainEvent[];
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? ANTIGRAVITY_PROTOCOL,
        executors: opts.installed === false ? {} : { antigravity: { version: "agy 1.4.12" } },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const brain = (l: ComputerBrainLink, permissions?: BrainTurnRequest["permissions"]) =>
  new AntigravityBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    ...(permissions ? { permissions: async () => permissions } : {}),
  });

test("a Gemini turn goes to the runner as kind antigravity with its account; its usage passes through as the person's plan", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 1000, output: 40, source: "plan", model: "gemini-4-argon-high", cacheRead: 400 },
      { type: "done", text: "All good.", session: { id: "c3b6" } },
    ],
  });
  const events = await collect(brain(l).run(turn({ model: "gemini-4-argon-high" }), io()));
  expect(l.sent[0]).toMatchObject({ kind: "antigravity", account: ACCOUNT.id, model: "gemini-4-argon-high" });
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(events.find((e) => e.type === "usage")).toMatchObject({ source: "plan", cacheRead: 400 });
});

test("Gemini refuses before the runner: an older runner, its CLI missing, its switch off (following Codex's when unset)", async () => {
  const first = async (l: ComputerBrainLink) => (await collect(brain(l).run(turn(), io())))[0];
  expect(await first(link({ protocol: ANTIGRAVITY_PROTOCOL - 1 }))).toMatchObject({ code: "runner_outdated" });
  expect(await first(link({ installed: false }))).toMatchObject({ code: "antigravity_missing" });
  expect(await first(link({ tools: { claude: true, codex: false, commands: true } }))).toMatchObject({
    code: "tool_off",
  });
  expect(await first(link({ tools: { claude: true, codex: true, antigravity: false, commands: true } }))).toMatchObject(
    { code: "tool_off" },
  );
  expect(ANTIGRAVITY_PROTOCOL).toBeGreaterThan(LOCKED_BRAIN_PROTOCOL);
  const l = link({ events: [{ type: "done", text: "ok" }] });
  await collect(brain(l, { mode: "chat" }).run(turn(), io()));
  expect(l.sent[0]?.permissions).toEqual({ mode: "chat" });
  expect(UNAVAILABLE_CODES.has("antigravity_missing") && NO_AI_CODES.has("antigravity_missing")).toBe(true);
});

test("Quem pensa: Gemini where its runner and CLI are, its models as the CLI listed them (else the known ones), each with its catalog model", () => {
  const machine = (over: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      name: "box",
      execAllowed: true,
      protocol: ANTIGRAVITY_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      executors: {
        antigravity: { version: "agy 1.4.12", models: [{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" }] },
      },
      ...over,
    }) as never;
  const option = (m: unknown) => brainOptions(m as never).find((o) => o.kind === "antigravity");
  expect(option(machine())).toMatchObject({
    available: true,
    defaultModel: null,
    models: [{ value: "gemini-4-argon-high", label: "Gemini 4 Argon (High)", modelId: "gemini-4-argon" }],
  });
  expect(option(machine({ protocol: ANTIGRAVITY_PROTOCOL - 1 }))).toMatchObject({ reason: "runner_old" });
  expect(option(machine({ executors: { detectedAt: "x" } }))).toMatchObject({ reason: "not_installed" });
  expect(option(machine({ executors: {} }))).toMatchObject({ reason: "not_reported" });
  expect(antigravityModels([]).map((m) => m.value)).toEqual(ANTIGRAVITY_MODELS.map((m) => m.id));
  // With none listed, Gemini 4 Neon leads, the CLI's own default; every level is its model, the extra one too.
  expect(antigravityModels([])[0]).toEqual({
    value: "gemini-4-neon-high",
    label: "Gemini 4 Neon (High)",
    modelId: "gemini-4-neon",
  });
  expect(antigravityModels([{ id: "gemini-4-neon-xhigh" }])[0]?.modelId).toBe("gemini-4-neon");
  expect(antigravityModels([{ id: "gemini-4-hydrogen-xhigh" }])[0]?.modelId).toBe("gemini-4-hydrogen");
  expect(defaultBrainModel("antigravity")).toBeNull();
  expect(isBrainKind("antigravity") && isComputerBrain("antigravity")).toBe(true);
  expect([BRAIN_NAMES.antigravity, BRAIN_PLAN_NAMES.antigravity, defaultAccountLabel("antigravity")]).toEqual([
    "Antigravity CLI",
    "Gemini",
    "Gemini",
  ]);
});

test("the Gemini plan's models: Gemini only, Neon where the CLI runs it, and why it's missing elsewhere", () => {
  const values = (listed: { id: string; label?: string }[], version?: string) =>
    antigravityModels(listed, version).map((m) => m.value);
  const free = [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "claude-sonnet-4-6-thinking", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ];
  // The CLI also lists other makers' models: the Gemini plan offers Gemini's alone.
  expect(values(free, "1.5.14")).toEqual(["gemini-3.8-flash-high"]);
  // Another maker's model only: as if nothing were listed.
  expect(values([{ id: "claude-opus-4-6-thinking" }], "1.5.14")).toEqual(ANTIGRAVITY_MODELS.map((m) => m.id));
  // A paid account's listing from 1.5.0 (Argon, no Neon): once the CLI runs Neon, Neon and Hydrogen come first.
  const older = [{ id: "gemini-4-argon-high" }, { id: "gemini-3.8-flash-medium" }];
  expect(values(older, "1.5.14").slice(0, 2)).toEqual(["gemini-4-neon-high", "gemini-4-neon-xhigh"]);
  expect(values(older, "1.5.14").slice(-2)).toEqual(["gemini-4-argon-high", "gemini-3.8-flash-medium"]);
  expect(values(older, "agy 1.5.0")).toEqual(["gemini-4-argon-high", "gemini-3.8-flash-medium"]);
  // A listing the new CLI took stands as it is.
  expect(values([{ id: "gemini-4-neon-high" }, { id: "gemini-4-argon-high" }], "1.5.14")).toEqual([
    "gemini-4-neon-high",
    "gemini-4-argon-high",
  ]);
  // Nothing listed by a CLI that predates Neon: no reserve row it can't run.
  expect(values([], "1.5.0").some((v) => v.includes("neon") || v.includes("hydrogen"))).toBe(false);

  const option = (
    antigravity: { version: string; models?: { id: string; label?: string }[] },
    over: { protocol?: number; kind?: string; mode?: "system" } = {},
  ) =>
    brainOptions({
      id: "m1",
      name: "box",
      execAllowed: true,
      protocol: over.protocol ?? AGY_COPY_PROTOCOL - 1,
      online: true,
      lastSeenAt: new Date(),
      ...(over.kind ? { kind: over.kind } : {}),
      executors: { antigravity, ...(over.mode ? { mode: over.mode } : {}) },
    } as never).find((o) => o.kind === "antigravity");
  const neon = { modelId: "gemini-4-neon", label: "Gemini 4 Neon" };
  // A CLI older than Neon: an app before protocol 76 doesn't bring its own, so the app is what to update.
  expect(option({ version: "agy 1.5.0", models: older })?.missing).toEqual({ ...neon, why: "app_old" });
  // A newer app brings it (still on its way); in system mode the computer's setup installs it.
  expect(option({ version: "agy 1.5.0", models: older }, { protocol: AGY_COPY_PROTOCOL })?.missing).toEqual({
    ...neon,
    why: "cli_old",
  });
  expect(option({ version: "agy 1.5.0", models: older }, { mode: "system" })?.missing).toEqual({
    ...neon,
    why: "cli_old",
  });
  // The workspace's own computer gets it with its image: nothing to say there.
  expect(option({ version: "agy 1.5.0", models: older }, { kind: "managed" })?.missing).toBeUndefined();
  expect(option({ version: "1.5.14", models: free })?.missing).toEqual({ ...neon, why: "plan" });
  expect(option({ version: "1.5.14", models: older })?.missing).toBeUndefined();
  // No CLI at all: where the runner brings its own (protocol 76, macOS or Linux, the person's computer), Gemini can
  // be connected and the first sign-in downloads it; anywhere else the CLI has to be installed first.
  const bare = (over: { protocol?: number; os?: string; kind?: string; mode?: "system" } = {}) =>
    brainOptions({
      id: "m2",
      name: "mac",
      execAllowed: true,
      protocol: over.protocol ?? AGY_COPY_PROTOCOL,
      os: over.os ?? "darwin",
      online: true,
      lastSeenAt: new Date(),
      ...(over.kind ? { kind: over.kind } : {}),
      executors: { detectedAt: new Date().toISOString(), ...(over.mode ? { mode: over.mode } : {}) },
    } as never).find((o) => o.kind === "antigravity");
  expect(bare()).toMatchObject({ available: true, models: expect.arrayContaining([expect.anything()]) });
  expect(bare()?.missing).toBeUndefined();
  expect(bare({ os: "linux" })?.available).toBe(true);
  expect(bare({ protocol: AGY_COPY_PROTOCOL - 1 })).toMatchObject({ available: false, reason: "not_installed" });
  expect(bare({ mode: "system", os: "linux" })).toMatchObject({ available: false, reason: "not_installed" });
  expect(bare({ kind: "managed", os: "linux" })).toMatchObject({ available: false, reason: "not_installed" });
  // Nothing listed yet (no account signed in): the reserve, with nothing to explain.
  expect(option({ version: "1.5.14" })?.missing).toBeUndefined();
});

test("a Gemini sign-in is made for all agents where each is its own OS user from protocol 58 on; Enterprise signs in again as Enterprise", () => {
  const system = (protocol: number) => ({ protocol, executors: { mode: "system" as const } }) as never;
  expect(sharesSignIns(system(SHARED_GEMINI_PROTOCOL), "antigravity")).toBe(true);
  expect(sharesSignIns(system(SHARED_GEMINI_PROTOCOL - 1), "antigravity")).toBe(false);
  expect(sharesSignIns(system(SHARED_GEMINI_PROTOCOL), "grok")).toBe(false);
  // Where every agent is the runner's own user, any sign-in thinks for all of them, as before.
  expect(sharesSignIns({ protocol: ANTIGRAVITY_PROTOCOL, executors: {} } as never, "antigravity")).toBe(true);
  expect([sharedSignIn("antigravity"), sharedSignIn("antigravity", GEMINI_ENTERPRISE_PROVIDER)]).toEqual([true, true]);
  expect(signInProviderOf(GEMINI_ENTERPRISE_PROVIDER)).toBe("enterprise");
  expect(signInProviderOf("zai")).toBe("zai");
  expect(signInProviderOf(null)).toBeUndefined();
});

test("availability: Gemini's account decides, signed out says so", () => {
  const status = {
    name: "box",
    online: true,
    execAllowed: true,
    protocol: ANTIGRAVITY_PROTOCOL,
    pairedByUserId: "u1",
    executors: { antigravity: { version: "agy 1.4.12" }, detectedAt: new Date().toISOString() },
  } as unknown as MachineStatus;
  expect(computerBrainUnavailable("antigravity", "m1", status, Date.now(), ACCOUNT)).toBeNull();
  expect(
    computerBrainUnavailable("antigravity", "m1", status, Date.now(), { ...ACCOUNT, status: "signed_out" }),
  ).toMatchObject({ code: "not_logged_in" });
});

test("the right hand's reply never carries a Google token, refresh token, key or client secret", () => {
  // Made up, and built here so no scanner reads them as real ones.
  const access = ["ya29", ".", "a0FakeAccessTokenForTestsOnly_x"].join("");
  const refresh = ["1//", "0gFakeRefreshTokenForTestsOnly"].join("");
  const key = ["AIza", "FakeKeyForTestsOnly0123456789abcdef"].join("");
  const secret = ["GOCSPX", "-FakeClientSecretForTests"].join("");
  const out = scrubSignIns(`token ${access} refresh ${refresh} key ${key} secret ${secret}`, "[removed]");
  for (const v of [access, refresh, key, secret]) expect(out.text).not.toContain(v);
  expect(out.found).toBe(4);
});
