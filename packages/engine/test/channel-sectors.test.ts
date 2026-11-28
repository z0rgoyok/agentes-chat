import { afterEach, beforeEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { asc, eq, schema, sql } from "@agenteschat/db";
import {
  createAgentGroup,
  createChannel,
  deleteAgentGroup,
  ForbiddenError,
  listAgentGroups,
  listChannels,
  NotFoundError,
  placeChannel,
} from "../src";
import { addMember, everyoneWithout, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** The channels as the sidebar reads them: [sector name or null, channel names in order]. */
async function sidebar(userId = f.owner.id) {
  const groups = await listAgentGroups(f.db, userId, f.org.id);
  const channels = await listChannels(f.db, userId, f.org.id);
  return [
    [null, channels.filter((c) => !c.groupId).map((c) => c.name)],
    ...groups.map((g) => [g.name, channels.filter((c) => c.groupId === g.id).map((c) => c.name)]),
  ];
}

async function sector(name: string, channelIds: string[] = []) {
  const groups = await createAgentGroup(deps(), f.owner.id, f.org.id, { name, channelIds });
  const made = groups.find((g) => g.name === name);
  if (!made) throw new Error("no sector");
  return made;
}

test("migration 0352: each channel category joins the sector of its name, ignoring case, or becomes a new one", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  const otherOrg = other?.id ?? "";
  const support = await sector("suporte");
  const cat = async (orgId: string, name: string, position: number) => {
    const [row] = await f.db.insert(schema.channelCategories).values({ orgId, name, position }).returning();
    return row?.id ?? "";
  };
  const supportCat = await cat(f.org.id, "Suporte", 0);
  const salesCat = await cat(f.org.id, "Vendas", 1);
  const theirs = await cat(otherOrg, "Suporte", 0);
  const channel = async (orgId: string, name: string, categoryId: string | null, position = 0) => {
    const [row] = await f.db
      .insert(schema.channels)
      .values({ orgId, name, categoryId, position })
      .returning({ id: schema.channels.id });
    return row?.id ?? "";
  };
  const n1 = await channel(f.org.id, "suporte-n1", supportCat, 1);
  const n2 = await channel(f.org.id, "suporte-n2", supportCat, 0);
  const orders = await channel(f.org.id, "pedidos", salesCat);
  const loose = await channel(f.org.id, "anuncios", null);
  const theirChannel = await channel(otherOrg, "help", theirs);

  const file = await Bun.file(new URL("../../db/migrations/0352_channels_in_sectors.sql", import.meta.url)).text();
  const data = file
    .split("--> statement-breakpoint")
    .filter((s) => /INSERT INTO "agent_groups"|UPDATE "channels"/.test(s));
  expect(data).toHaveLength(2);
  for (const part of data) await f.db.execute(sql.raw(part));

  const groups = await f.db.select().from(schema.agentGroups).orderBy(asc(schema.agentGroups.position));
  const ours = groups.filter((g) => g.orgId === f.org.id);
  // "Suporte" joined "suporte"; "Vendas" is new, after it, in a color of its own.
  expect(ours.map((g) => g.name)).toEqual(["suporte", "Vendas"]);
  const sales = ours[1];
  expect(sales?.color).not.toBe(ours[0]?.color);
  // The other workspace's "Suporte" is its own sector there, never ours.
  const theirGroup = groups.find((g) => g.orgId === otherOrg);
  expect(theirGroup?.name).toBe("Suporte");
  const groupOf = async (id: string) =>
    (await f.db.select().from(schema.channels).where(eq(schema.channels.id, id)))[0];
  expect((await groupOf(n1))?.groupId).toBe(support.id);
  expect((await groupOf(n2))?.groupId).toBe(support.id);
  expect((await groupOf(orders))?.groupId).toBe(sales?.id ?? "");
  expect((await groupOf(loose))?.groupId).toBeNull();
  const their = await groupOf(theirChannel);
  expect(their?.groupId).toBe(theirGroup?.id ?? "");
  expect(their?.orgId).toBe(otherOrg);
  // The channels keep their order inside the sector.
  expect((await sidebar())[1]).toEqual(["suporte", ["suporte-n2", "suporte-n1"]]);
});

test("who manages channels and a channel's creator move it between sectors; nobody else", async () => {
  const product = await sector("Produto");
  const member = await addMember(f.db, f.org.id, "member");
  // A member creates a channel straight into the sector, and may move their own channel.
  const roadmap = await createChannel(f.db, member.id, f.org.id, { name: "roadmap", groupId: product.id });
  expect(roadmap.groupId).toBe(product.id);
  await placeChannel(f.db, member.id, f.org.id, roadmap.id, { groupId: null });
  // …but not someone else's.
  await expect(placeChannel(f.db, member.id, f.org.id, f.general.id, { groupId: product.id })).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  // Who manages channels moves any of them.
  await placeChannel(f.db, f.owner.id, f.org.id, f.general.id, { groupId: product.id });
  expect(await sidebar()).toEqual([
    [null, ["roadmap"]],
    ["Produto", ["general"]],
  ]);
});

test("placing a channel puts it before another one, or at the end, and renumbers", async () => {
  const mkt = await sector("Marketing");
  const a = await createChannel(f.db, f.owner.id, f.org.id, { name: "marketing", groupId: mkt.id });
  const b = await createChannel(f.db, f.owner.id, f.org.id, { name: "campanhas", groupId: mkt.id });
  const c = await createChannel(f.db, f.owner.id, f.org.id, { name: "conteudo" });
  // Nobody arranged it yet: by name.
  expect((await sidebar())[1]).toEqual(["Marketing", ["campanhas", "marketing"]]);
  await placeChannel(f.db, f.owner.id, f.org.id, a.id, { groupId: mkt.id, beforeChannelId: b.id });
  await placeChannel(f.db, f.owner.id, f.org.id, c.id, { groupId: mkt.id, beforeChannelId: b.id });
  expect((await sidebar())[1]).toEqual(["Marketing", ["marketing", "conteudo", "campanhas"]]);
  // Arranged by hand: a new channel goes to the end.
  await createChannel(f.db, f.owner.id, f.org.id, { name: "anuncios", groupId: mkt.id });
  expect((await sidebar())[1]).toEqual(["Marketing", ["marketing", "conteudo", "campanhas", "anuncios"]]);
});

test("a new sector takes channels along; only who manages agents makes one, with channels they may move", async () => {
  const tech = await createChannel(f.db, f.owner.id, f.org.id, { name: "tech" });
  const bugs = await createChannel(f.db, f.owner.id, f.org.id, { name: "bugs" });
  await sector("Engenharia", [tech.id, bugs.id]);
  expect((await sidebar())[1]).toEqual(["Engenharia", ["tech", "bugs"]]);
  const member = await addMember(f.db, f.org.id, "member");
  const mine = await createChannel(f.db, member.id, f.org.id, { name: "mine" });
  await expect(
    createAgentGroup(deps(), member.id, f.org.id, { name: "Meu", channelIds: [mine.id] }),
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("a member who doesn't list every agent sees a sector holding a channel they see, not a private one's", async () => {
  await everyoneWithout(f.db, f.org.id, "view_all_agents");
  const open = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
  await sector("Vendas", [open.id]);
  await sector("Diretoria", [secret.id]);
  const member = await addMember(f.db, f.org.id, "member");
  expect((await listAgentGroups(f.db, member.id, f.org.id)).map((g) => g.name)).toEqual(["Vendas"]);
});

test("deleting a sector sends its channels to the end of the ones in none, in their order", async () => {
  const x = await createChannel(f.db, f.owner.id, f.org.id, { name: "x-one" });
  const y = await createChannel(f.db, f.owner.id, f.org.id, { name: "a-two" });
  const eng = await sector("Engenharia", [x.id, y.id]);
  await deleteAgentGroup(deps(), f.owner.id, f.org.id, eng.id);
  expect(await sidebar()).toEqual([[null, ["general", "x-one", "a-two"]]]);
});

test("another org's sector is not found; a move tells the org to refetch", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  const [foreign] = await f.db
    .insert(schema.agentGroups)
    .values({ orgId: other?.id ?? "", name: "Theirs" })
    .returning();
  await expect(
    createChannel(f.db, f.owner.id, f.org.id, { name: "leak", groupId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    placeChannel(f.db, f.owner.id, f.org.id, f.general.id, { groupId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(NotFoundError);

  const mine = await sector("Suporte");
  const seen: unknown[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => seen.push(e));
  await placeChannel(f.db, f.owner.id, f.org.id, f.general.id, { groupId: mine.id }, { pubsub: f.pubsub });
  expect(seen).toEqual([{ type: "org.broadcast", orgId: f.org.id, event: { type: "channels.layout" } }]);
});
