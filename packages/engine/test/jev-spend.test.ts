import { afterEach, describe, expect, test } from "bun:test";
import {
  chooseAutoModel,
  createFakeJudge,
  createJevJudge,
  enableCaches,
  type Judge,
  JudgeGroup,
  type JudgeRequest,
  withJudgeFallback,
} from "../src";

afterEach(() => enableCaches(false));

/** A Jev stand-in: answers every Noul with `noul` and every Choice with its first option, and keeps what it was sent. */
function fakeJev(o: { noul?: number; fail?: boolean } = {}) {
  const sent: { kind?: string; state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
  const usage: { requestedModel?: string; inputTokens: number }[] = [];
  const judge = createJevJudge({
    key: "tk",
    gateway: {
      recordExternalUsage: async (u) => {
        usage.push(u);
        return null;
      },
    },
    fetch: (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        state: Record<string, unknown>;
        questions: Record<string, { type: string; criteria?: Record<string, string> }>;
      };
      sent.push(body);
      if (o.fail) return new Response("boom", { status: 529 });
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, q]) => [
          id,
          q.type === "noul"
            ? { type: "noul", noul: o.noul ?? 0.7 }
            : { type: "choice", choice: Object.keys(q.criteria ?? {})[0], probabilities: {} },
        ]),
      );
      return Response.json({ model: "jev-1", answers, usage: { input_tokens: 10 } });
    }) as unknown as typeof fetch,
  });
  return { judge, sent, usage };
}

const ask = (kind: string, more: Partial<JudgeRequest> = {}): JudgeRequest => ({
  orgId: "o",
  agentId: "a",
  runId: "r",
  kind,
  state: { message: "oi", recent: "" },
  questions: { q: { type: "noul", instructions: `${kind}?`, criteria: { true: "yes", false: "no" } } },
  ...more,
});

describe("Jev's spend", () => {
  test("each call records its judgment's name as what was asked for", async () => {
    const { judge, usage } = fakeJev();
    await judge.ask(ask("stop_request"));
    expect(usage).toMatchObject([{ requestedModel: "stop_request", inputTokens: 10 }]);
  });

  test("the same text-only request within minutes is answered from what Jev said; an image's never", async () => {
    enableCaches(true);
    const { judge, sent } = fakeJev();
    expect(await judge.ask(ask("agent_status"))).toEqual({ q: { noul: 0.7 } });
    expect(await judge.ask(ask("agent_status"))).toEqual({ q: { noul: 0.7 } });
    expect(sent).toHaveLength(1);
    await judge.ask(ask("agent_status", { state: { message: "outra coisa", recent: "" } }));
    expect(sent).toHaveLength(2);
    const screen = ask("screen_check", { state: { screen: "IMG" }, images: { IMG: { data: "AAAA", format: "png" } } });
    await judge.ask(screen);
    await judge.ask(screen);
    expect(sent).toHaveLength(4);
  });

  test("a failed request is asked again next time", async () => {
    enableCaches(true);
    const down = fakeJev({ fail: true });
    await expect(down.judge.ask(ask("x"))).rejects.toThrow();
    await expect(down.judge.ask(ask("x"))).rejects.toThrow();
    expect(down.sent).toHaveLength(2);
  });
});

describe("a run's start judgments in one request", () => {
  test("one request with each judgment's questions under its kind, the answers handed back to each", async () => {
    const { judge, sent, usage } = fakeJev();
    const group = new JudgeGroup(["auto_model", "tool_groups", "agent_status"]);
    const [auto, tools, status] = await Promise.all([
      judge.ask(
        ask("auto_model", {
          group,
          state: { message: "oi", recent: "", run: { routine: false } },
          questions: { tier: { type: "choice", instructions: "tier?", criteria: { small: "s", large: "l" } } },
        }),
      ),
      judge.ask(
        ask("tool_groups", {
          group,
          questions: { g0: { type: "noul", instructions: "g?", criteria: { true: "y", false: "n" } } },
        }),
      ),
      judge.ask(ask("agent_status", { group })),
    ]);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.questions ?? {}).sort()).toEqual([
      "agent_status__q",
      "auto_model__tier",
      "tool_groups__g0",
    ]);
    expect(sent[0]?.state).toEqual({ message: "oi", recent: "", run: { routine: false } });
    expect(auto).toEqual({ tier: { choice: "small", probabilities: {} } });
    expect(tools).toEqual({ g0: { noul: 0.7 } });
    expect(status).toEqual({ q: { noul: 0.7 } });
    expect(usage).toMatchObject([{ requestedModel: "agent_status+auto_model+tool_groups" }]);
  });

  test("a kind skipped is waited for no longer; one asked after the group went goes alone", async () => {
    const { judge, sent } = fakeJev();
    const group = new JudgeGroup(["auto_model", "agent_status"], 10_000);
    const started = Date.now();
    const auto = judge.ask(ask("auto_model", { group }));
    group.skip("agent_status");
    await auto;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.questions ?? {})).toEqual(["q"]);
    await judge.ask(ask("agent_status", { group }));
    expect(sent).toHaveLength(2);
  });

  test("past the wait the ones that came go together; a state that disagrees goes alone", async () => {
    const { judge, sent } = fakeJev();
    const group = new JudgeGroup(["auto_model", "tool_groups", "agent_status"], 20);
    await Promise.all([
      judge.ask(ask("auto_model", { group })),
      judge.ask(ask("tool_groups", { group, state: { message: "outra", recent: "" } })),
    ]);
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => Object.keys(s.questions))).toEqual([["q"], ["q"]]);
  });

  test("when Jev fails, each takes its own fallback", async () => {
    const { judge: jev } = fakeJev({ fail: true });
    const fallback = createFakeJudge((kind) => (kind === "auto_model" ? 0.2 : 0.4));
    const judge: Judge = withJudgeFallback(jev, fallback);
    const group = new JudgeGroup(["auto_model", "agent_status"]);
    const [auto, status] = await Promise.all([
      judge.ask(ask("auto_model", { group })),
      judge.ask(ask("agent_status", { group })),
    ]);
    expect(auto).toEqual({ q: { noul: 0.2 } });
    expect(status).toEqual({ q: { noul: 0.4 } });
    expect(fallback.calls.map((c) => c.kind).sort()).toEqual(["agent_status", "auto_model"]);
  });
});

describe("Automático for a routine", () => {
  const input = {
    orgId: "o",
    agent: { name: "Ada", role: "Ops", instructions: "" },
    message: "Confira os PRs abertos.",
    recent: [],
    routine: true,
    mission: false,
    computer: false,
    tools: true,
    cacheKey: "o:a:routine-1:hash",
  };

  test("the judge's choice for the same prompt stands for the day; a fallback is never kept", async () => {
    enableCaches(true);
    const judge = createFakeJudge((kind, id) =>
      kind === "auto_model" ? (id === "tier" ? "small" : "low") : undefined,
    );
    expect(await chooseAutoModel(judge, input)).toMatchObject({ tier: "small", effort: "low", source: "judge" });
    const group = new JudgeGroup(["auto_model", "agent_status"], 10_000);
    expect(await chooseAutoModel(judge, { ...input, group })).toMatchObject({ tier: "small", source: "judge" });
    expect(judge.calls).toHaveLength(1);
    // Not asked: the group no longer waits for it.
    const { judge: jev, sent } = fakeJev();
    await jev.ask(ask("agent_status", { group }));
    expect(sent).toHaveLength(1);

    const broken: Judge = {
      name: "broken",
      ask: async () => {
        throw new Error("down");
      },
    };
    const other = { ...input, cacheKey: "o:a:routine-2:hash" };
    expect(await chooseAutoModel(broken, other)).toMatchObject({ source: "error" });
    expect(await chooseAutoModel(judge, other)).toMatchObject({ source: "judge" });
    expect(judge.calls).toHaveLength(2);
  });
});
