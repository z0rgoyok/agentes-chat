import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  CHANNEL_JOINED_JOB,
  createAgent,
  createChannel,
  createPassToolSource,
  drainOutbox,
  joinChannel,
  removeChannelMember,
  setBillingHold,
} from "../src";
import { isQuietNotice } from "../src/notices";
import { addMember, type Fixture, setup } from "./fixtures";

/*
 * Joining a channel says so (ADR 0090): one quiet line for everyone naming who joined and who added them, and, for one
 * agent alone with room, one welcome from an agent already there, in a turn that may only speak or pass.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const drain = (ms = 10_000) => drainOutbox(f.db, f.handlers, { now: new Date(Date.now() + ms) });
const notices = async (channelId: string) => {
  const rows = await f.db
    .select({ body: schema.messages.body, meta: schema.messages.meta, agentId: schema.messages.authorAgentId })
    .from(schema.messages)
    .where(eq(schema.messages.channelId, channelId))
    .orderBy(schema.messages.createdAt);
  return rows.flatMap((m) => {
    const n = (m.meta as { notice?: { kind: string; refs?: Record<string, string> } }).notice;
    return n
      ? [{ kind: n.kind, body: m.body, refs: n.refs ?? {}, agentId: m.agentId, quiet: isQuietNotice(m.meta) }]
      : [];
  });
};
const bot = (name: string, handle: string) =>
  createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
/**
 * A channel with Dev in it, its own line already said, and the moment past: a join's job runs only once the stretch it
 * stands for ended, which the drain's clock skips ahead of, and Dev in it for a while already.
 */
const room = async () => {
  const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
  await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id });
  await drain();
  await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, CHANNEL_JOINED_JOB));
  await f.db
    .update(schema.channelMembers)
    .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(schema.channelMembers.channelId, channel.id));
  return channel;
};

describe("an agent added to a channel", () => {
  test("one quiet line names it and who added it, and the agent already there welcomes it with words only", async () => {
    f = await setup({
      reply: () => ({ chunks: ["Bem-vinda, Iara: aqui ficam os pedidos dos clientes."] }),
      toolSources: [createPassToolSource()],
      contextTools: true,
    });
    const channel = await room();
    const iara = await bot("Iara", "iara");
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: iara.id });
    await drain();
    const lines = await notices(channel.id);
    expect(lines.map((l) => [l.kind, l.body, l.quiet])).toEqual([
      ["joined", "Dev joined this channel, added by ana", true],
      ["joined", "Iara joined this channel, added by ana", true],
      ["member_joined", "Iara just joined this channel, and you were picked to welcome them", true],
    ]);
    // Written as the newcomer; the welcome is Dev's to read, whose owner added Iara.
    expect(lines[1]?.agentId).toBe(iara.id);
    expect(lines[1]?.refs).toEqual({ members: `agent:${iara.id}`, by: f.owner.id });
    expect(lines[2]?.agentId).toBe(f.agent.id);
    // Its turn lists no tool but `pass`, and its words land in the channel.
    const request = f.provider.calls.at(-1)?.request;
    expect(request?.tools?.map((t) => t.name) ?? []).toEqual(["pass"]);
    const said = await f.db
      .select({ body: schema.messages.body })
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, channel.id), eq(schema.messages.authorAgentId, f.agent.id)));
    expect(said.map((m) => m.body)).toContain("Bem-vinda, Iara: aqui ficam os pedidos dos clientes.");
  });

  test("agents added together share one line and nobody welcomes them", async () => {
    f = await setup();
    const channel = await room();
    const iara = await bot("Iara", "iara");
    const bento = await bot("Bento", "bento");
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: iara.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: bento.id });
    const calls = f.provider.calls.length;
    await drain();
    const lines = await notices(channel.id);
    expect(lines.map((l) => l.body)).toEqual([
      "Dev joined this channel, added by ana",
      "Iara and Bento joined this channel, added by ana",
    ]);
    expect(f.provider.calls.length).toBe(calls);
  });

  test("on a billing hold the line comes and no model is called", async () => {
    f = await setup();
    const channel = await room();
    await setBillingHold({ db: f.db, pubsub: f.pubsub }, f.org.id, "payment");
    const iara = await bot("Iara", "iara");
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: iara.id });
    const calls = f.provider.calls.length;
    await drain();
    expect((await notices(channel.id)).map((l) => l.kind)).toEqual(["joined", "joined"]);
    expect(f.provider.calls.length).toBe(calls);
  });

  test("with 80% of the welcomer's budget used the line comes alone", async () => {
    f = await setup({ budgetNanoUsd: 1_000_000_000 });
    const channel = await room();
    await f.db
      .update(schema.agentBudgetPeriods)
      .set({ spentNanoUsd: 800_000_000 })
      .where(eq(schema.agentBudgetPeriods.agentId, f.agent.id));
    const iara = await bot("Iara", "iara");
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: iara.id });
    const calls = f.provider.calls.length;
    await drain();
    expect((await notices(channel.id)).map((l) => l.kind)).toEqual(["joined", "joined"]);
    expect(f.provider.calls.length).toBe(calls);
  });

  test("turning auto-reply on an agent already there says nothing", async () => {
    f = await setup();
    const channel = await room();
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id, autoReply: false });
    await drain();
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, CHANNEL_JOINED_JOB));
    expect(jobs).toHaveLength(0);
    expect(await notices(channel.id)).toHaveLength(1);
  });
});

describe("people, and leaving", () => {
  test("a person who joins by themself gets the line with no adder, and nobody welcomes a person", async () => {
    f = await setup();
    const channel = await room();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await joinChannel(f.db, bia.id, f.org.id, channel.id);
    const calls = f.provider.calls.length;
    await drain();
    const lines = await notices(channel.id);
    expect(lines.at(-1)).toMatchObject({ kind: "joined", body: "bia joined this channel", agentId: null });
    expect(f.provider.calls.length).toBe(calls);
  });

  test("people who join by themselves in the same moments share a line that names no adder", async () => {
    f = await setup();
    const channel = await room();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await joinChannel(f.db, bia.id, f.org.id, channel.id);
    await joinChannel(f.db, caio.id, f.org.id, channel.id);
    await drain();
    expect((await notices(channel.id)).at(-1)).toMatchObject({
      kind: "joined",
      body: "bia and caio joined this channel",
    });
  });

  test("an agent taken out gets its line at once", async () => {
    f = await setup();
    const channel = await room();
    await removeChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: f.agent.id });
    const lines = await notices(channel.id);
    expect(lines.at(-1)).toMatchObject({ kind: "left", body: "Dev left this channel", quiet: true });
  });
});

describe("the welcome's turn", () => {
  test("stays words or a pass when the judge loads tool groups for it", async () => {
    f = await setup({
      reply: () => ({ chunks: ["Bem-vinda, Iara."] }),
      toolSources: [createPassToolSource()],
      contextTools: true,
      issueTools: true,
      toolsOnDemand: true,
      judge: (kind) => (kind === "tool_groups" ? 0.9 : undefined),
    });
    const channel = await room();
    const iara = await bot("Iara", "iara");
    await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: iara.id });
    await drain();
    const request = f.provider.calls.at(-1)?.request;
    expect(request?.tools?.map((t) => t.name) ?? []).toEqual(["pass"]);
  });
});
