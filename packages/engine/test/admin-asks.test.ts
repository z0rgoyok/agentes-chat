import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { addChannelMember, askAdmins, ConflictError, createChannel, listNotifications, speechOwnerIn } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const asks = async (userId: string) =>
  (await listNotifications(deps(), userId, f.org.id)).items.filter((n) => n.kind === "admin_ask");

test("an ask to add an agent to a channel reaches who manages channels, merges, and is done once it's added", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "squad" });
  const ask = { what: "channel_agent" as const, channelId: room.id, agentId: f.agent.id };

  expect(await askAdmins(deps(), bia.id, f.org.id, ask)).toEqual({ sent: 1 });
  await askAdmins(deps(), bia.id, f.org.id, ask);
  const [row, ...more] = await asks(f.owner.id);
  expect(more).toEqual([]);
  expect(row).toMatchObject({
    waiting: true,
    source: { channelId: room.id, agentId: f.agent.id, label: "squad" },
    latest: { reason: "channel_agent" },
    actors: [{ type: "user", id: bia.id }],
  });

  await addChannelMember(f.db, f.owner.id, f.org.id, room.id, { agentId: f.agent.id }, { pubsub: f.pubsub });
  expect(await asks(f.owner.id)).toEqual([]);
});

test("someone who may do it is told to, and a webhook ask names its service", async () => {
  f = await setup();
  await expect(askAdmins(deps(), f.owner.id, f.org.id, { what: "create_agents" })).rejects.toBeInstanceOf(
    ConflictError,
  );
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await askAdmins(deps(), bia.id, f.org.id, { what: "webhook", provider: "github" });
  expect((await asks(f.owner.id))[0]).toMatchObject({ waiting: false, latest: { reason: "webhook", title: "GitHub" } });
});

test("an ask to turn on voice reaches the server's owner alone, who can't ask themselves", async () => {
  f = await setup();
  const admin = await addMember(f.db, f.org.id, "admin", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await f.db.insert(schema.instanceTelemetry).values({ ownerUserId: f.owner.id });
  expect(await speechOwnerIn(f.db, f.org.id)).toEqual({ userId: f.owner.id, name: f.owner.name });

  expect(await askAdmins(deps(), bia.id, f.org.id, { what: "voice" })).toEqual({ sent: 1 });
  expect((await asks(f.owner.id))[0]).toMatchObject({ latest: { reason: "voice" }, actors: [{ id: bia.id }] });
  // An admin of the workspace can't choose it: only who runs the server.
  expect(await asks(admin.id)).toEqual([]);
  await expect(askAdmins(deps(), f.owner.id, f.org.id, { what: "voice" })).rejects.toBeInstanceOf(ConflictError);
});
