import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  createWikiPage,
  deleteWikiPage,
  drainOutbox,
  enableCaches,
  postPersonMessage,
  renameWikiPage,
  retrieveWikiForRun,
  setWikiPageAgentContext,
  setWikiPageAudience,
  setWikiPagesAgents,
  updateChannel,
  type WikiActor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, fire } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  enableCaches(false);
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context });
const page = (title: string, body = `Context for ${title}.`) =>
  createWikiPage(deps(), { type: "person", userId: f.owner.id }, f.org.id, { title, body });
const reader = async (): Promise<WikiActor> => ({
  type: "agent",
  agentId: f.agent.id,
  requestedByUserId: f.owner.id,
  channelId: f.general.id,
});
const ask = (text: string, channelText?: string, budgetChars?: number) =>
  retrieveWikiForRun(deps(), { orgId: f.org.id, text, channelText, budgetChars, reader });
const prompt = (request: ModelRequest) => `${systemText(request.system)}\n${JSON.stringify(request.messages)}`;

describe("wiki links in the channel topic", () => {
  test("a topic brings its page even with an empty message and without the search index", async () => {
    f = await setup();
    const acme = await page("Acme", "A retainer client with a monthly campaign.");
    const run = await retrieveWikiForRun(
      { db: f.db },
      { orgId: f.org.id, text: "", channelText: "Acme · retainer client · [[Acme]]", reader },
    );
    expect(run).toMatchObject({ pageIds: [acme.id], held: false });
    expect(run.text).toContain("A retainer client with a monthly campaign.");
  });

  test("message links come before topic links, then always-in-context pages, within the same budget", async () => {
    f = await setup();
    const message = await page("Pedido", "m".repeat(3000));
    const topic = await page("Acme", "t".repeat(3000));
    const always = await page("Regras", "a".repeat(3000));
    await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, always.id, true);
    const run = await ask("[[Pedido]]", "[[Acme]] [[Pedido]] [[Regras]] [[Acme]]");
    expect(run.pageIds).toEqual([message.id, topic.id, always.id]);
    expect(run.text.indexOf("[[Pedido]]")).toBeLessThan(run.text.indexOf("[[Acme]]"));
    expect(run.text.indexOf("[[Acme]]")).toBeLessThan(run.text.indexOf("[[Regras]]"));
    // Once the message uses the budget, a topic page doesn't get a separate allowance.
    expect((await ask("[[Pedido]]", "[[Acme]]", 1500)).pageIds).toEqual([message.id]);
  });

  test("topic words never change the search; its linked pages precede the message's search hits", async () => {
    f = await setup();
    const acme = await page("Acme");
    const deploy = await page("Guia de deploy", "O deploy do backend roda pelo script deploy.sh.");
    await drainOutbox(f.db, f.handlers);
    const question = "como faço o deploy do backend?";
    const before = await ask(question);
    expect(before.pageIds).toEqual([deploy.id]);
    expect(await ask(question, "Acme · retainer client")).toEqual(before);
    expect(await ask("oi", "deploy backend Acme")).toEqual({ text: "", pageIds: [], held: false });
    expect((await ask(question, "Acme · retainer client · [[Acme]]")).pageIds).toEqual([acme.id, deploy.id]);
  });

  test("a topic-only page blocked by the conversation stays out without sending the question to a DM", async () => {
    f = await setup();
    await addMember(f.db, f.org.id, "member", "bia");
    await page("Margens", "Private commercial terms.");
    await setWikiPageAudience(deps(), f.owner.id, f.org.id, "margens", { roleIds: [], userIds: [f.owner.id] });
    expect(await ask("oi", "[[Margens]]")).toEqual({ text: "", pageIds: [], held: false });
    // The same page explicitly requested in the message keeps the existing DM behavior.
    expect(await ask("[[Margens]]", "[[Margens]]")).toEqual({ text: "", pageIds: [], held: true });
    await updateChannel(f.db, f.owner.id, f.org.id, f.general.id, { visibility: "private" });
    expect((await ask("oi", "[[Margens]]")).text).toContain("Private commercial terms.");
  });

  test("a topic page the requesting person or the agent cannot read stays out", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const acme = await page("Acme");
    await setWikiPageAudience(deps(), f.owner.id, f.org.id, acme.id, { roleIds: [], userIds: [f.owner.id] });
    expect(
      await retrieveWikiForRun(deps(), {
        orgId: f.org.id,
        text: "oi",
        channelText: "[[Acme]]",
        reader: async () => ({ ...(await reader()), requestedByUserId: bia.id }),
      }),
    ).toEqual({ text: "", pageIds: [], held: false });
    await setWikiPageAudience(deps(), f.owner.id, f.org.id, acme.id, null);
    await setWikiPagesAgents(deps(), f.owner.id, f.org.id, [acme.id], []);
    expect(await ask("oi", "[[Acme]]")).toEqual({ text: "", pageIds: [], held: false });
  });

  test("topic links resolve aliases, labels and sections; code, missing pages and deleted pages stay out", async () => {
    f = await setup();
    const acme = await page("Acme");
    await renameWikiPage(deps(), { type: "person", userId: f.owner.id }, f.org.id, acme.id, { title: "Acme Brasil" });
    await page("Código");
    const deleted = await page("Antiga");
    await deleteWikiPage(deps(), { type: "person", userId: f.owner.id }, f.org.id, deleted.id);
    expect((await ask("", "[[Clientes/Acme#brief|cliente]] `[[Código]]` [[Missing]] [[Antiga]]")).pageIds).toEqual([
      acme.id,
    ]);
  });
});

test("the executor reads topic pages on ordinary runs and follows topic edits on the next run", async () => {
  f = await setup({ wikiTools: true, reply: () => ({ chunks: ["ok"] }) });
  await page("Acme", "Acme's monthly allowance is twelve campaigns.");
  await page("Globex", "Globex's monthly allowance is six campaigns.");
  enableCaches();
  for (const [title, expected] of [
    ["Acme", "twelve"],
    ["Globex", "six"],
  ] as const) {
    await updateChannel(f.db, f.owner.id, f.org.id, f.general.id, { topic: `Client · [[${title}]]` });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls.at(-1)?.request;
    if (!request) throw new Error("no model call");
    expect(prompt(request)).toContain(`${title}'s monthly allowance is ${expected} campaigns.`);
  }
});

test("a routine keeps the wiki on demand even when its message and room topic name a page", async () => {
  f = await setup({ wikiTools: true, handOff: true, reply: () => ({ chunks: ["Nada novo."] }) });
  await page("Acme", "Acme's monthly allowance is twelve campaigns.");
  await setWikiPageAgentContext(deps(), f.owner.id, f.org.id, "acme", true);
  const routine = await channelRoutine(f, { prompt: "Confira [[Acme]]." });
  const fired = await fire(f, routine.id, new Date());
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, fired.agentRunId ?? ""));
  if (!run) throw new Error("no routine run");
  await f.db.update(schema.channels).set({ topic: "[[Acme]]" }).where(eq(schema.channels.id, run.channelId));
  await drainOutbox(f.db, f.handlers);
  const request = f.provider.calls.find((c) => (c.request.tools ?? []).some((t) => t.name === "hand_off"))?.request;
  if (!request) throw new Error("no routine model call");
  expect(prompt(request)).not.toContain("# Organization wiki");
  expect(prompt(request)).not.toContain("Acme's monthly allowance");
  expect(request.tools?.map((t) => t.name)).toContain("read_wiki_page");
});
