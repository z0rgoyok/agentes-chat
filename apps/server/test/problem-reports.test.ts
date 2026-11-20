import { afterEach, describe, expect, test } from "bun:test";
import { problemReportSchema } from "@agenteschat/engine";
import { createLogger } from "../src/logger";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A receiver that answers like agentes.chat's, and keeps what it got. */
function receiver(answer: (n: number) => Response = () => Response.json({ id: "R-7K3QXM" }, { status: 201 })) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return answer(calls.length);
  }) as typeof fetch;
  return { http, calls };
}

async function server(env: Record<string, string> = {}, http?: typeof fetch) {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true", ...env }, http });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const other = await joinByInvitation(t, owner, orgId, "other@example.com");
  return { owner, other, orgId };
}

const preview = (b: ReturnType<typeof browser>, json: Record<string, unknown>) =>
  b("/api/app/problem-reports/preview", { json });

describe("problem reports", () => {
  test("preview: the always part, server lines only for the owner, a computer the person can't see ignored", async () => {
    const { owner, other, orgId } = await server();
    createLogger("info").info("problem report test line", { from: "someone@example.com" });
    const res = await preview(owner, {
      orgId,
      place: "computer",
      context: { machineId: "00000000-0000-4000-8000-000000000001" },
      client: { web: "2026.11.15.5", browser: "chrome 142", locale: "pt-BR" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: Record<string, unknown> & { facts: Record<string, unknown>; logs: { name: string; lines: string[] }[] };
      text: string;
      send: string;
      missing: Record<string, unknown>;
    };
    expect(problemReportSchema.safeParse(body.report).success).toBe(true);
    expect(body.send).toBe("on");
    expect(body.report).toMatchObject({ format: 1, source: "server", place: "computer", locale: "pt-BR" });
    expect(body.report.facts.machine).toBe("not_visible");
    expect(body.report.facts["config.ALLOW_SIGNUP"]).toBe("set");
    expect(body.report.facts["config.publicUrl"]).toBeDefined();
    const serverLog = body.report.logs.find((l) => l.name === "server");
    expect(serverLog?.lines.some((l) => l.includes("problem report test line"))).toBe(true);
    expect(JSON.stringify(body.report)).not.toContain("someone@example.com");
    expect(JSON.stringify(body.report)).not.toContain("Acme");
    expect(body.text).toContain('"format": 1');

    const theirs = (await (await preview(other, { orgId, place: "settings" })).json()) as typeof body;
    expect(theirs.report.logs.find((l) => l.name === "server")).toBeUndefined();
    expect(theirs.missing.serverLines).toBe(true);
  });

  test("send posts what preview returned, plus the note and address", async () => {
    const { http, calls } = receiver();
    const { owner, orgId } = await server({}, http);
    const { report } = (await (await preview(owner, { orgId, place: "settings" })).json()) as {
      report: Record<string, unknown>;
    };
    const res = await owner("/api/app/problem-reports/send", {
      json: { orgId, report, note: "It froze. key sk-ant-api-0000000000000000fake", replyTo: "someone@example.com" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "R-7K3QXM" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://telemetry.agentes.chat/v1/problem-report");
    const sent = calls[0]?.body as Record<string, unknown>;
    expect({ ...sent, note: undefined, replyTo: undefined }).toEqual({
      ...report,
      note: undefined,
      replyTo: undefined,
    });
    expect(sent.replyTo).toBe("someone@example.com");
    expect(String(sent.note)).toStartWith("It froze.");
    expect(String(sent.note)).not.toContain("sk-ant-api-0000000000000000fake");
  });

  test("the receiver's 429 passes through, its refusal and silence are 502", async () => {
    const answers = [
      new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "retry-after": "120" } }),
      Response.json({ error: "bad_request" }, { status: 400 }),
    ];
    const { http } = receiver((n) => answers[n - 1] ?? Response.json({}, { status: 503 }));
    const { owner, orgId } = await server({}, http);
    const { report } = (await (await preview(owner, { orgId, place: "settings" })).json()) as { report: unknown };
    const send = () => owner("/api/app/problem-reports/send", { json: { orgId, report } });
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { params: { retryAfterS: number } } }).error.params.retryAfterS).toBe(
      120,
    );
    const refused = await send();
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("refused");
    const down = await send();
    expect(((await down.json()) as { error: { code: string } }).error.code).toBe("unreachable");
  });

  test("a person sends at most 5 an hour", async () => {
    const { http, calls } = receiver();
    const { owner, orgId } = await server({}, http);
    const { report } = (await (await preview(owner, { orgId, place: "settings" })).json()) as { report: unknown };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await owner("/api/app/problem-reports/send", { json: { orgId, report } })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(calls).toHaveLength(5);
  });

  test("with PROBLEM_REPORT_URL=off, only Copy works", async () => {
    const { owner, orgId } = await server({ PROBLEM_REPORT_URL: "off" });
    const body = (await (await preview(owner, { orgId, place: "settings" })).json()) as {
      send: string;
      report: unknown;
    };
    expect(body.send).toBe("off");
    const res = await owner("/api/app/problem-reports/send", { json: { orgId, report: body.report } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("off");
  });

  test("on agentes.chat itself it isn't there", async () => {
    const origin = "https://agentes.chat";
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true", PUBLIC_URL: origin } });
    const first = browser(t);
    await first("/api/auth/sign-up/email", {
      json: { email: "first@example.com", password: "correct horse battery", name: "First" },
      origin,
    });
    const res = await first("/api/app/problem-reports/preview", {
      json: { orgId: "00000000-0000-4000-8000-000000000001", place: "settings" },
      origin,
    });
    expect(res.status).toBe(404);
    // Nor is its button: the apps show it only where health says `selfhost`.
    expect(((await (await t.app.request("/api/health")).json()) as { edition: string }).edition).toBe("cloud");
  });
});
