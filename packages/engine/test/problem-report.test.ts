import { afterEach, describe, expect, test } from "bun:test";
import { capProblemReport, PROBLEM_REPORT_TARGET_BYTES, RUNNER_STOPPED_CLOSE } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { createChannel } from "../src/channels";
import { postPersonMessage } from "../src/messages";
import {
  buildProblemReport,
  finishProblemReport,
  type ProblemReport,
  problemReportSchema,
} from "../src/problem-report";
import { addMember, type Fixture, setup } from "./fixtures";
import vector from "./fixtures/problem-report.v1.json";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const SOURCES = {
  server: { version: "2026.11.15.5", install: "docker" as const, os: "linux", arch: "x64" },
  config: { "config.SMTP_URL": "set" },
  publicUrl: "https://chat.example.com",
};

const FAKE_KEY = "sk-ant-api03-FAKE-not-a-real-key-000000000000000000000000";

describe("problem report", () => {
  test("the shared vector parses", () => {
    expect(problemReportSchema.safeParse(vector.full).success).toBe(true);
    expect(problemReportSchema.safeParse(vector.minimal).success).toBe(true);
    expect(problemReportSchema.safeParse({ ...vector.minimal, place: "nowhere" }).success).toBe(false);
    expect(problemReportSchema.safeParse({ ...vector.minimal, replyTo: "not an email" }).success).toBe(false);
    // Unknown keys are dropped, not refused.
    expect(problemReportSchema.parse({ ...vector.minimal, extra: 1 })).not.toHaveProperty("extra");
  });

  test("the desktop app's computer: its system's version is optional in format 1, its size and opening fit as they are", () => {
    const desktop = {
      ...vector.minimal,
      source: "desktop",
      place: "desktop_server",
      timings: { opening: 6200 },
      versions: { desktop: "0.8.18", os: "windows", osVersion: "10.0.19045", arch: "x86_64" },
      facts: { "desktop.cpus": 8, "desktop.memoryGb": 15.5, "desktop.webviewMb": 412 },
    };
    expect(problemReportSchema.parse(desktop)).toMatchObject({
      versions: { osVersion: "10.0.19045" },
      timings: { opening: 6200 },
      facts: { "desktop.cpus": 8, "desktop.memoryGb": 15.5, "desktop.webviewMb": 412 },
    });
    const withVersion = (osVersion: string) => problemReportSchema.safeParse({ ...desktop, versions: { osVersion } });
    expect(withVersion("6.8.0-45-generic").success).toBe(true);
    expect(withVersion("build/19045").success).toBe(false);
  });

  test("a 5 MB log fits the cap and still parses", () => {
    const line = "x".repeat(999);
    const big: ProblemReport = {
      format: 1,
      source: "server",
      place: "settings",
      logs: [
        { name: "server", lines: Array.from({ length: 400 }, () => line) },
        { name: "runner", lines: Array.from({ length: 400 }, () => line) },
      ],
    };
    const capped = capProblemReport(big);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(PROBLEM_REPORT_TARGET_BYTES);
    expect(problemReportSchema.safeParse(capped).success).toBe(true);
  });

  test("names only, server lines for the owner, nothing of what people wrote", async () => {
    f = await setup();
    await f.db
      .update(schema.agents)
      .set({ instructions: "secret prompt words" })
      .where(eq(schema.agents.id, f.agent.id));
    const lines = [
      `{"time":"${new Date().toISOString()}","level":"info","msg":"org ${f.org.name} at https://chat.example.com/x?y"}`,
    ];
    const built = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: f.owner.id, place: "settings", client: { locale: "en" } },
      { ...SOURCES, serverLines: () => lines },
    );
    const text = JSON.stringify(built.report);
    expect(text).not.toContain("secret prompt words");
    expect(text).not.toContain(f.org.name);
    expect(text).not.toContain("chat.example.com");
    expect(built.report.logs?.[0]?.lines[0]).toContain("[workspace]");
    expect(built.report.facts?.["config.SMTP_URL"]).toBe("set");
    expect(built.report.facts?.["counts.agents"]).toBeGreaterThanOrEqual(1);

    const member = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: member.id, place: "computer", context: { machineId: crypto.randomUUID() } },
      { ...SOURCES, serverLines: () => lines },
    );
    expect(theirs.report.logs).toEqual([]);
    expect(theirs.missing.serverLines).toBe(true);
    expect(theirs.report.facts?.machine).toBe("not_visible");
  });

  test("a run: its facts and error code for who reads its conversation, nothing for who doesn't", async () => {
    const fx = await setup();
    f = fx;
    const priv = await createChannel(f.db, f.owner.id, f.org.id, { name: "private-run", visibility: "private" });
    const runIn = async (channelId: string) => {
      const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, channelId, {
        body: "x",
      });
      const [run] = await fx.db
        .insert(schema.agentRuns)
        .values({
          orgId: fx.org.id,
          agentId: fx.agent.id,
          channelId,
          threadRootId: msg.id,
          triggerMessageId: msg.id,
          trigger: "mention",
          hop: 1,
          status: "failed",
          error: `provider.unavailable: ${fx.org.name} refused key ${FAKE_KEY}`,
        })
        .returning();
      return run?.id ?? "";
    };
    const runId = await runIn(priv.id);
    const mine = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: f.owner.id, place: "run", context: { runId } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(mine.report.code).toBe("provider.unavailable");
    expect(mine.report.facts?.["run.status"]).toBe("failed");
    // Its words, scrubbed as a log line: the workspace's name and a key never leave.
    expect(mine.report.facts?.["run.error"]).toStartWith("provider.unavailable: [workspace] refused key ");
    expect(JSON.stringify(mine.report)).not.toContain(FAKE_KEY);

    const member = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: member.id, place: "run", context: { runId } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(theirs.report.facts?.run).toBe("not_visible");
    expect(theirs.report.facts?.["run.status"]).toBeUndefined();
    expect(theirs.report.facts?.["run.error"]).toBeUndefined();
    expect(theirs.report.code).toBeNull();
  });

  test("a run's computer is the one its turns ran on, also when its agent has none (the right hand's plan)", async () => {
    const fx = await setup();
    f = fx;
    const [machine] = await fx.db
      .insert(schema.machines)
      .values({ orgId: fx.org.id, name: "Plan box", os: "linux", arch: "x64" })
      .returning();
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "x",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "dm",
        hop: 1,
        status: "failed",
        error: "runner_error: No such file or folder",
        profiles: [{ stages: [] }, { stages: [], machineId: machine?.id }, { stages: [], machineId: "not-a-uuid" }],
      })
      .returning();
    const built = await buildProblemReport(
      fx.db,
      { orgId: fx.org.id, userId: fx.owner.id, place: "run", context: { runId: run?.id ?? "" } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(built.report.facts).toMatchObject({ "machine.os": "linux", "machine.arch": "x64", runnerLog: "no_answer" });
    expect(built.missing.computer).toBe("Plan box");
  });

  test("a Windows computer's report and a run's on it carry its build and what holds Codex there", async () => {
    const fx = await setup();
    f = fx;
    const [machine] = await fx.db
      .insert(schema.machines)
      .values({
        orgId: fx.org.id,
        name: "Desk",
        os: "windows",
        executors: {
          codex: { version: "codex-cli 0.170.0", sandbox: "unelevated" },
          windowsBuild: "10.0.19045",
          detectedAt: "2026-11-24T10:00:00.000Z",
        },
      })
      .returning();
    const machineId = machine?.id ?? "";
    const computer = await buildProblemReport(
      fx.db,
      { orgId: fx.org.id, userId: fx.owner.id, place: "computer", context: { machineId } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(computer.report.facts).toMatchObject({
      "machine.os": "windows",
      "machine.windowsBuild": "10.0.19045",
      "machine.codexSandbox": "unelevated",
    });

    await fx.db.update(schema.agents).set({ machineId }).where(eq(schema.agents.id, fx.agent.id));
    const msg = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
      body: "x",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: fx.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "failed",
        error: "run.windows_sandbox: no isolation",
      })
      .returning();
    const ofRun = await buildProblemReport(
      fx.db,
      { orgId: fx.org.id, userId: fx.owner.id, place: "run", context: { runId: run?.id ?? "" } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(ofRun.report.facts).toMatchObject({
      "machine.windowsBuild": "10.0.19045",
      "machine.codexSandbox": "unelevated",
    });

    // Elsewhere, not a word of it.
    await fx.db.update(schema.machines).set({ os: "linux" }).where(eq(schema.machines.id, machineId));
    const linux = await buildProblemReport(
      fx.db,
      { orgId: fx.org.id, userId: fx.owner.id, place: "computer", context: { machineId } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(linux.report.facts).not.toHaveProperty("machine.windowsBuild");
    expect(linux.report.facts).not.toHaveProperty("machine.codexSandbox");
  });

  test("an offline computer's report says why, from its runner's last close, never the close's text", async () => {
    const fx = await setup();
    f = fx;
    const now = Date.now();
    const iso = (agoS: number) => new Date(now - agoS * 1000).toISOString();
    const [machine] = await fx.db
      .insert(schema.machines)
      .values({
        orgId: fx.org.id,
        name: "Box",
        os: "linux",
        lastSeenAt: new Date(now - 3600_000),
        disconnects: [{ connectedAt: iso(7200), at: iso(3590), code: RUNNER_STOPPED_CLOSE, reason: "secret words" }],
      })
      .returning();
    const machineId = machine?.id ?? "";
    const build = () =>
      buildProblemReport(
        fx.db,
        { orgId: fx.org.id, userId: fx.owner.id, place: "computer", context: { machineId } },
        { ...SOURCES, serverLines: () => [] },
      );
    const stopped = await build();
    expect(stopped.report.facts).toMatchObject({
      "machine.connection": "offline",
      "machine.offlineCause": "stopped",
      "machine.lastCloseCode": RUNNER_STOPPED_CLOSE,
    });
    expect(stopped.report.facts?.["machine.lastCloseS"]).toBeWithin(3589, 3600);
    expect(stopped.report.facts?.["machine.lastConnectedS"]).toBeWithin(7199, 7210);
    expect(JSON.stringify(stopped.report)).not.toContain("secret words");

    // No close recorded: said so, not left out.
    await fx.db.update(schema.machines).set({ disconnects: [] }).where(eq(schema.machines.id, machineId));
    expect((await build()).report.facts).toMatchObject({
      "machine.offlineCause": null,
      "machine.lastCloseCode": null,
      "machine.lastCloseS": null,
    });
  });

  test("too many or too long facts are cut to the contract, never fail the report", async () => {
    f = await setup();
    const config = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`config.KEY_${i}`, "set"]));
    const clientFacts = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "y".repeat(500)]));
    const built = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: f.owner.id, place: "settings", clientFacts },
      { ...SOURCES, config, serverLines: () => [] },
    );
    expect(Object.keys(built.report.facts ?? {}).length).toBeLessThanOrEqual(120);
    expect(built.report.facts?.["client.k0"]).toHaveLength(200);
  });

  test("send keeps the report and masks credentials in the note", () => {
    const sent = finishProblemReport(vector.full as ProblemReport, {
      note: "  it broke, key sk-ant-api-0000000000000000fake ",
      replyTo: "someone@example.com",
      redact: (s) => s.replace(/sk-ant-[\w-]+/g, "[key]"),
    });
    expect(sent.note).toBe("it broke, key [key]");
    expect(sent.logs).toEqual(vector.full.logs as ProblemReport["logs"]);
  });
});
