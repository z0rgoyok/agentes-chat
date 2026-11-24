import { afterEach, expect, test } from "bun:test";
import {
  type ChannelEvent,
  createLlmIntentWriter,
  drainOutbox,
  type IntentInput,
  intentLine,
  type ModelGateway,
  postPersonMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

/** The working line's first words: what the agent is about to do, a second or two after a person's message. */

let f: Fixture;
afterEach(() => f?.close());

type IntentEvent = Extract<ChannelEvent, { type: "agent.intent" }>;
const intents = (events: { type: string }[]) => (events as IntentEvent[]).filter((e) => e.type === "agent.intent");

test("the line is one short line of intent: quotes, closing dots and code names go, a long one is cut at a word", () => {
  expect(intentLine('  "Procurando o e-mail do dono do workspace…"  ')).toBe(
    "Procurando o e-mail do dono do workspace",
  );
  expect(intentLine("Looking up\nlast week's invoices.")).toBe("Looking up last week's invoices");
  expect(intentLine("")).toBeNull();
  expect(intentLine("   ")).toBeNull();
  expect(intentLine(null)).toBeNull();
  expect(intentLine("Rodando `list_users` no banco")).toBeNull();
  expect(intentLine("Lendo /Users/someone/notes.txt")).toBeNull();
  const long = intentLine(
    "Conferindo os pedidos de reembolso abertos desde segunda-feira passada no painel de pagamentos",
  ) as string;
  expect(long.length).toBeLessThanOrEqual(60);
  expect(long).toBe("Conferindo os pedidos de reembolso abertos desde");
});

test("the small model writes it through the gateway as a router call, and an empty answer is no line", async () => {
  const calls: Parameters<ModelGateway["complete"]>[0][] = [];
  let text = '{"line":"Procurando o e-mail do dono do workspace"}';
  const writer = createLlmIntentWriter({
    gateway: {
      complete: async (call) => {
        calls.push(call);
        return { text } as Awaited<ReturnType<ModelGateway["complete"]>>;
      },
    },
    resolveModel: async () => "claude-haiku-5-5",
  });
  const input: IntentInput = {
    orgId: "o1",
    agentId: "a1",
    runId: "r1",
    agent: { name: "Ada", role: "Ops" },
    message: "qual o e-mail do dono do workspace?",
    locale: "pt-BR",
  };
  expect(await writer.write(input)).toBe("Procurando o e-mail do dono do workspace");
  expect(calls[0]).toMatchObject({ kind: "router", model: "claude-haiku-5-5", agentId: "a1", runId: "r1" });
  expect(String(calls[0]?.messages[0]?.content)).toContain("qual o e-mail do dono do workspace?");

  text = '{"line":""}';
  expect(await writer.write({ ...input, message: "oi" })).toBeNull();
  text = "not json";
  expect(await writer.write(input)).toBeNull();

  const none = createLlmIntentWriter({
    gateway: { complete: async () => ({}) as never },
    resolveModel: async () => null,
  });
  expect(await none.write(input)).toBeNull();
});

test("a run on a person's message tells the conversation what it is about to do, before its reply", async () => {
  f = await setup({ reply: () => ({ chunks: ["O dono é walter@example.com."] }) });
  const asked: IntentInput[] = [];
  f.context.intents = {
    write: async (input) => {
      asked.push(input);
      return "procurando o e-mail do dono do workspace";
    },
  };
  const events = f.listen(f.general.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev qual o e-mail do dono do workspace?",
  });
  await drainOutbox(f.db, f.handlers);

  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ agentId: f.agent.id, message: "@dev qual o e-mail do dono do workspace?" });
  const [line] = intents(events);
  expect(line).toMatchObject({ agentId: f.agent.id, text: "procurando o e-mail do dono do workspace" });
  const at = (type: string) => events.findIndex((e) => e.type === type);
  expect(at("agent.intent")).toBeGreaterThan(at("agent.run"));
});

test("no line when the writer has nothing to say or fails, and the run answers all the same", async () => {
  f = await setup({ reply: () => ({ chunks: ["Oi!"] }) });
  let answer: () => Promise<string | null> = async () => null;
  f.context.intents = { write: () => answer() };
  const events = f.listen(f.general.id);
  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });

  await post("@dev oi");
  await drainOutbox(f.db, f.handlers);
  answer = async () => {
    throw new Error("no small model");
  };
  await post("@dev qual o plano de hoje?");
  await drainOutbox(f.db, f.handlers);

  expect(intents(events)).toEqual([]);
  // Both runs still answered: the line never stands in the way.
  expect(events.filter((e) => e.type === "message.created").length).toBeGreaterThanOrEqual(4);
});
