import { afterEach, describe, expect, test } from "bun:test";
import { capProblemReport, PROBLEM_REPORT_TARGET_BYTES } from "@agenteschat/adapters";
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

describe("problem report", () => {
  test("the shared vector parses", () => {
    expect(problemReportSchema.safeParse(vector.full).success).toBe(true);
    expect(problemReportSchema.safeParse(vector.minimal).success).toBe(true);
    expect(problemReportSchema.safeParse({ ...vector.minimal, place: "nowhere" }).success).toBe(false);
    expect(problemReportSchema.safeParse({ ...vector.minimal, replyTo: "not an email" }).success).toBe(false);
    // Unknown keys are dropped, not refused.
    expect(problemReportSchema.parse({ ...vector.minimal, extra: 1 })).not.toHaveProperty("extra");
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
          error: "provider.unavailable: the model said no",
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
    expect(JSON.stringify(mine.report)).not.toContain("the model said no");

    const member = await addMember(f.db, f.org.id, "member", "bia");
    const theirs = await buildProblemReport(
      f.db,
      { orgId: f.org.id, userId: member.id, place: "run", context: { runId } },
      { ...SOURCES, serverLines: () => [] },
    );
    expect(theirs.report.facts?.run).toBe("not_visible");
    expect(theirs.report.facts?.["run.status"]).toBeUndefined();
    expect(theirs.report.code).toBeNull();
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
