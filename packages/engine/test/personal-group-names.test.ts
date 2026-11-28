import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  addChannelMember,
  ConflictError,
  createAgent,
  createChannel,
  createOrganization,
  deleteChannel,
  listChannels,
  namesChannel,
  personalChannelName,
  updateChannel,
  ValidationError,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";

/*
 * A personal workspace's group conversations (ADR 0159, amendment of 2026-11-26): named as the person writes them,
 * found in any case wherever a name is typed, and listed with their first agents (their face in the apps).
 */

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const home = async () => {
  const me = await addUser(f.db, "eu");
  const { organization } = await createOrganization(f.db, me.id, { name: "Pessoal", mode: "personal" });
  return { me, org: organization };
};

test("a group conversation keeps its name as written; a team's channel stays lower case", async () => {
  const { me, org } = await home();
  const trip = await createChannel(f.db, me.id, org.id, { name: "  Viagem   pra Lisboa " });
  expect(trip.name).toBe("Viagem pra Lisboa");
  expect((await createChannel(f.db, me.id, org.id, { name: "#Casa & contas" })).name).toBe("Casa & contas");
  // Another only in case reads as the same conversation.
  await expect(createChannel(f.db, me.id, org.id, { name: "viagem PRA lisboa" })).rejects.toBeInstanceOf(ConflictError);
  for (const name of ["", "   ", "#", "dm-casa", "a".repeat(81), "duas\u0007linhas"])
    await expect(createChannel(f.db, me.id, org.id, { name })).rejects.toBeInstanceOf(ValidationError);

  // Renamed as written too, its own case changed freely, another's name refused in any case.
  expect((await updateChannel(f.db, me.id, org.id, trip.id, { name: "Lisboa em maio" })).name).toBe("Lisboa em maio");
  expect((await updateChannel(f.db, me.id, org.id, trip.id, { name: "LISBOA em maio" })).name).toBe("LISBOA em maio");
  await expect(updateChannel(f.db, me.id, org.id, trip.id, { name: "casa & CONTAS" })).rejects.toBeInstanceOf(
    ConflictError,
  );

  // A team's channel: lower case, digits, - or _, as before.
  await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "Viagem pra Lisboa" })).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect((await createChannel(f.db, f.owner.id, f.org.id, { name: "Vendas" })).name).toBe("vendas");
});

test("the rule on its own: spaces folded, a leading # dropped, one line of at most 80, never dm-", () => {
  expect(personalChannelName("Casa\t de  praia")).toBe("Casa de praia");
  expect(personalChannelName("## Férias")).toBe("Férias");
  expect(personalChannelName("x".repeat(80))).toBe("x".repeat(80));
  for (const raw of ["", "  ", "x".repeat(81), "DM-tia", "a\u0000b"]) expect(personalChannelName(raw)).toBeNull();
});

test("a name typed by an agent or a person finds the conversation in any case", async () => {
  expect(namesChannel("Viagem pra Lisboa", "#viagem  PRA lisboa")).toBe(true);
  expect(namesChannel("eng", " #ENG ")).toBe(true);
  expect(namesChannel("Viagem pra Lisboa", "viagem-pra-lisboa")).toBe(false);

  // Deleting asks for its name: typed in another case, it goes.
  const { me, org } = await home();
  const trip = await createChannel(f.db, me.id, org.id, { name: "Viagem pra Lisboa" });
  await expect(deleteChannel({ db: f.db, pubsub: f.pubsub }, me.id, org.id, trip.id, "viagem")).rejects.toBeInstanceOf(
    ValidationError,
  );
  await deleteChannel({ db: f.db, pubsub: f.pubsub }, me.id, org.id, trip.id, "viagem PRA lisboa");
  expect((await listChannels(f.db, me.id, org.id)).map((c) => c.name)).not.toContain("Viagem pra Lisboa");
});

test("the channel list names each channel's first four agents and how many it has", async () => {
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "time" });
  const made: string[] = [];
  for (const name of ["Ana", "Bia", "Caio", "Duda", "Eli"]) {
    const agent = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name, handle: name.toLowerCase() },
      { model: "claude-haiku-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: agent.id });
    made.push(agent.id);
  }
  const listed = (await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === room.id);
  // Four of the five (the first to join; ties in the same instant break by id), and the count of all.
  expect(listed?.agentIds).toHaveLength(4);
  expect(new Set(listed?.agentIds).size).toBe(4);
  expect(listed?.agentIds.every((id) => made.includes(id))).toBe(true);
  expect(listed?.agentCount).toBe(5);
  // A channel with no agent: none.
  const empty = await createChannel(f.db, f.owner.id, f.org.id, { name: "vazio" });
  const none = (await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === empty.id);
  expect([none?.agentIds, none?.agentCount]).toEqual([[], 0]);
});
