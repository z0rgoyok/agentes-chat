import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "@agenteschat/db";
import { addChannelMember, createAgentGroup, createChannel, mySidebarView, setMySidebarView } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const migration = async () =>
  f.db.execute(
    sql.raw(await Bun.file(new URL("../../db/migrations/0366_sidebar_sections.sql", import.meta.url)).text()),
  );

test("migration 0366: everyone starts with one section per sector that holds channels, only the channels they see", async () => {
  const member = await addMember(f.db, f.org.id, "member");
  const launch = await createChannel(f.db, f.owner.id, f.org.id, { name: "lancamento" });
  const design = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "segredo", visibility: "private" });
  const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops" });
  await createAgentGroup(deps(), f.owner.id, f.org.id, { name: "Lançamento v3", channelIds: [launch.id, design.id] });
  await createAgentGroup(deps(), f.owner.id, f.org.id, { name: "Diretoria", channelIds: [secret.id] });
  // A sector with agents only gives no section.
  await createAgentGroup(deps(), f.owner.id, f.org.id, { name: "Só agentes" });
  await createAgentGroup(deps(), f.owner.id, f.org.id, { name: "Operação", channelIds: [ops.id] });
  // Someone who already made their own keeps them.
  await setMySidebarView(f.db, f.org.id, member.id, {
    sections: [{ id: "mine", name: "Minha", channelIds: [ops.id] }],
  });
  const third = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: third.id });

  await migration();

  const owner = await mySidebarView(f.db, f.org.id, f.owner.id);
  expect(owner.sections?.map((s) => [s.name, s.channelIds])).toEqual([
    ["Lançamento v3", [launch.id, design.id]],
    ["Diretoria", [secret.id]],
    ["Operação", [ops.id]],
  ]);
  expect((await mySidebarView(f.db, f.org.id, member.id)).sections).toEqual([
    { id: "mine", name: "Minha", channelIds: [ops.id] },
  ]);
  // Not in the private channel: no section of it.
  expect((await mySidebarView(f.db, f.org.id, third.id)).sections?.map((s) => s.name)).toEqual([
    "Lançamento v3",
    "Diretoria",
    "Operação",
  ]);
  // Run again (a retried deploy): nothing changes.
  await migration();
  expect((await mySidebarView(f.db, f.org.id, f.owner.id)).sections).toEqual(owner.sections);
});

test("a view saved without Favoritos or sections (an app built before them) keeps the stored ones", async () => {
  await setMySidebarView(f.db, f.org.id, f.owner.id, {
    favorites: ["agent:a1", "channel:c1", "nope:x", "agent:a1"],
    sections: [
      { id: "s1", name: "  Vendas  ", channelIds: ["c2", "c3"] },
      { id: "s2", name: "Repete", channelIds: ["c3"] },
      { id: "s3", name: "", channelIds: ["c4"] },
    ],
    dms: "recent",
  });
  const saved = await setMySidebarView(f.db, f.org.id, f.owner.id, {
    agentSort: "mine",
    showAllAgents: false,
    pins: null,
  });
  expect(saved).toEqual({
    agentSort: "mine",
    showAllAgents: false,
    pins: null,
    favorites: ["agent:a1", "channel:c1"],
    sections: [{ id: "s1", name: "Vendas", channelIds: ["c2", "c3"] }],
    dms: "recent",
  });
  expect(await mySidebarView(f.db, f.org.id, f.owner.id)).toEqual(saved);
});
