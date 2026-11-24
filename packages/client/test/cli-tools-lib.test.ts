import { expect, test } from "bun:test";
import { ptBR } from "@agenteschat/i18n";
import i18next from "i18next";
import { applyChannelEvent, emptyStreams } from "../src/index";
import { cliLineOf, cliMetaWords } from "../src/lib/cli-tools";
import { replySteps, savedOneLine, toolItemsLive, waitStep, workFromSteps } from "../src/lib/work";

/**
 * A computer brain's own tool calls in a code session (ADR 0215): one line each, live and saved, as its terminal shows
 * them.
 */

const i18n = i18next.createInstance();
await i18n.init({ lng: "pt-BR", resources: { "pt-BR": { translation: ptBR } }, interpolation: { escapeValue: false } });
const t = i18n.t;

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const step = (toolUseId: string, tool: string, cli: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: "agent.step", ...base, tool, toolUseId, cli, ...extra }) as unknown as Ev;
/** The run's live row after these events. */
const live = (events: Ev[]) =>
  events.reduce(applyChannelEvent, applyChannelEvent(emptyStreams, { type: "agent.thinking", ...base } as Ev)).runs.r1;

const read = { verb: "read", target: "src/app/router.ts" };

test("its start adds a running line that the step line names", () => {
  const started = live([step("t1", "Read", read, { said: "Vou ler o roteador" })]);
  expect(started?.work).toMatchObject([{ kind: "call", id: "t1", tool: "Read", running: true, cli: read }]);
  expect(waitStep(t, started?.work)).toBe("Lendo · router.ts…");
});

test("its end closes its line and leaves the step line's words", () => {
  const started = step("t1", "Read", read, { said: "Vou ler o roteador" });
  const ended = live([started, step("t1", "Read", read, { ended: true })]);
  expect(ended?.work).toMatchObject([{ id: "t1", running: false, cli: read }]);
  expect(ended?.step).toEqual({ tool: "Read", said: "Vou ler o roteador" });
});

test("a call told only once it ended is added ended, failed or not", () => {
  const cli = { verb: "run", target: "bun test", meta: { passed: 3 } };
  const ran = live([step("c1", "shell", cli, { ended: true, failed: true })]);
  expect(ran?.work).toMatchObject([{ id: "c1", running: false, failed: true, cli }]);
  expect(ran?.step).toEqual({ tool: "shell" });
});

test("each call is its own line, never folded with the one before", () => {
  const readOf = (id: string, target: string) => step(id, "Read", { verb: "read", target }, { ended: true });
  const items = toolItemsLive(live([readOf("a", "a.ts"), readOf("b", "b.ts")])?.work ?? []);
  const lines = items.map((i) => (i.kind === "call" ? [i.line.count, i.line.cli?.target] : null));
  expect(lines).toEqual([
    [1, "a.ts"],
    [1, "b.ts"],
  ]);
});

test("saved, each of its own calls is a line with what it gave back", () => {
  const at = "2026-11-20T10:00:00.000Z";
  const edit = {
    id: "e1",
    name: "Edit",
    verb: "edit",
    target: "src/a.ts",
    meta: { added: 2, removed: 1 },
    ok: true,
    output: "- a\n+ b",
    ms: 40,
  };
  const bash = { id: "b1", name: "Bash", verb: "run", target: "bun test", ok: false };
  const work = workFromSteps([
    { seq: 1, kind: "context", data: { cliTool: edit }, createdAt: at },
    { seq: 2, kind: "context", data: { steeredMessageIds: [] }, createdAt: at },
    { seq: 3, kind: "context", data: { cliTool: bash }, createdAt: at },
  ]);
  expect(work.steps).toMatchObject([
    { key: "cli-e1", tool: "Edit", failed: false, ms: 40, count: 1, result: "- a\n+ b", cli: { verb: "edit" } },
    { key: "cli-b1", tool: "Bash", failed: true, ms: null, cli: { verb: "run", target: "bun test" } },
  ]);
  expect(work.steps[0]?.cli?.meta).toEqual({ added: 2, removed: 1 });
});

test("a run that answered on the way lists each piece of work under the reply it led to", () => {
  const at = "2026-11-20T21:00:00.000Z";
  const later = "2026-11-20T21:01:30.000Z";
  const cli = (id: string, name: string, verb: string) => ({ id, name, verb, ok: true });
  const steps = [
    { seq: 1, kind: "context", data: { cliTool: cli("r1", "Read", "read") }, createdAt: at },
    { seq: 2, kind: "message", data: { messageId: "running" }, createdAt: at },
    { seq: 3, kind: "context", data: { cliTool: cli("w1", "Workflow", "workflow") }, createdAt: later },
    { seq: 4, kind: "message", data: { messageId: "result" }, createdAt: later },
  ];
  const first = replySteps(steps, "running");
  expect(first.whole).toBe(false);
  expect(workFromSteps(first.steps).steps.map((s) => s.tool)).toEqual(["Read"]);
  const second = replySteps(steps, "result");
  expect(workFromSteps(second.steps).steps.map((s) => s.tool)).toEqual(["Workflow"]);
  // Timed from the reply before it.
  expect(workFromSteps(second.steps).durationMs).toBe(90_000);
  // Its only reply, or one saved without its step: the whole run.
  expect(replySteps(steps.slice(0, 2), "running")).toEqual({ steps: steps.slice(0, 2), whole: true, cli: true });
  expect(replySteps(steps, "elsewhere").whole).toBe(true);
  // Work after its last reply stays with it.
  const after = [...steps, { seq: 5, kind: "context", data: { cliTool: cli("b1", "Bash", "run") }, createdAt: later }];
  expect(workFromSteps(replySteps(after, "result").steps).steps.map((s) => s.tool)).toEqual(["Workflow", "Bash"]);
});

test("in a code session a check that let a command through at once is no line; a refused one is", () => {
  const at = "2026-11-20T21:00:00.000Z";
  const check = (seq: number, id: string, content: string) => [
    {
      seq,
      kind: "tool_call",
      data: { name: "permission_prompt", toolUseId: id, input: { tool_name: "Bash" } },
      createdAt: at,
    },
    { seq: seq + 1, kind: "tool_result", data: { name: "permission_prompt", toolUseId: id, content }, createdAt: at },
  ];
  const steps = [
    {
      seq: 1,
      kind: "context",
      data: { cliTool: { id: "w1", name: "Workflow", verb: "workflow", ok: true } },
      createdAt: at,
    },
    ...check(2, "p1", '{"behavior":"allow"}'),
    ...check(4, "p2", '{"behavior":"deny","message":"Not here"}'),
  ];
  const mine = replySteps(steps, undefined);
  expect(mine.cli).toBe(true);
  const quiet = workFromSteps(mine.steps, undefined, { quietChecks: mine.cli });
  expect(quiet.steps.map((s) => [s.tool, s.failed])).toEqual([
    ["Workflow", false],
    ["permission_prompt", true],
  ]);
  // Elsewhere the check is the command's only line.
  expect(workFromSteps(steps).steps).toHaveLength(3);
  // Live, the same: a code session's run leaves out the check that let its command through.
  const allowed = { type: "agent.step", ...base, tool: "permission_prompt", toolUseId: "p1" } as unknown as Ev;
  const work = live([step("w1", "Workflow", { verb: "workflow" }), allowed])?.work ?? [];
  expect(toolItemsLive(work).map((i) => (i.kind === "call" ? i.line.tool : null))).toEqual(["Workflow"]);
});

test("a reply's lone call of its own reads as its line before its steps load", () => {
  const cli = { verb: "search", target: "parseRoute", meta: { found: 3 } };
  const meta = { work: { steps: 1, durationMs: 900, ms: 120, cli, calls: [{ name: "Grep", n: 1 }] } };
  expect(savedOneLine(meta)).toMatchObject({ tool: "Grep", state: "done", ms: 120, hint: null, cli });
});

test("what it came to, in words", () => {
  expect(cliMetaWords(t, { added: 2, removed: 1 })).toBe("+2 −1");
  expect(cliMetaWords(t, { added: 4 })).toBe("+4");
  expect(cliMetaWords(t, { found: 3 })).toBe("3 lugares");
  expect(cliMetaWords(t, { found: 1 })).toBe("1 lugar");
  expect(cliMetaWords(t, { passed: 14, failed: 1 })).toBe("14 passaram · 1 falhou");
  expect(cliMetaWords(t, { passed: 15, failed: 0 })).toBe("15 passaram");
  expect(cliMetaWords(t, { exit: 2 })).toBe("saiu com 2");
  expect(cliMetaWords(t, undefined)).toBeNull();
});

test("a line from the server is checked", () => {
  expect(cliLineOf({ verb: "nope" })).toBeNull();
  expect(cliLineOf({ verb: "run", target: " ", meta: { exit: -1, passed: 2 } })).toEqual({
    verb: "run",
    meta: { passed: 2 },
  });
});
