import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createArtifact, createConversationArtifact, insertMessage } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("a conversation's page brings what its cards show (include=cards), so they draw whole at once", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const actor = { type: "agent" as const, agentId, channelId };
  const choices = await createConversationArtifact(t.engine.artifacts, actor, orgId, {
    title: "Deploy",
    content: {
      kind: "choices",
      questions: [{ question: "Faço agora?", options: [{ label: "Sim" }, { label: "Não" }] }],
    },
  });
  const poll = await createConversationArtifact(t.engine.artifacts, actor, orgId, {
    title: "Qual dia?",
    content: { kind: "poll", question: "Qual dia?", options: ["Terça", "Sexta"], multiple: false },
  });
  await t.db
    .insert(schema.polls)
    .values({ artifactId: poll.id, orgId, runId: crypto.randomUUID(), closesAt: new Date(Date.now() + 3_600_000) });
  // A file is a tile of one size: nothing of it comes with the page.
  const doc = await createArtifact(t.engine.artifacts, actor, orgId, {
    title: "Notas",
    channelId,
    content: { kind: "document", markdown: "# Notas" },
  });
  const ref = (a: { id: string; version: number; title: string }) => ({ id: a.id, version: a.version, title: a.title });
  await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "Decide aí.",
    meta: {
      // The vote's ref names no version: its head is what it shows.
      artifacts: [
        ref(choices),
        { id: poll.id, title: poll.title },
        ref(doc),
        { id: crypto.randomUUID(), deleted: true },
      ],
    },
  });
  const read = async (query: string) =>
    (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages${query}`)).json()) as {
      messages: unknown[];
      cards?: {
        artifacts: { id: string; shownVersion: number; content: { kind: string } }[];
        polls: { id: string; votes: unknown[] }[];
        choices: { id: string; answer: unknown }[];
        blocks: unknown[];
      };
    };

  expect((await read("")).cards).toBeUndefined();
  const { cards } = await read("?include=cards");
  expect(cards?.artifacts.map((a) => [a.id, a.shownVersion, a.content.kind]).sort()).toEqual(
    [
      [choices.id, 1, "choices"],
      [poll.id, 1, "poll"],
    ].sort(),
  );
  expect(cards?.polls).toEqual([expect.objectContaining({ id: poll.id, votes: [] })]);
  expect(cards?.choices).toEqual([{ id: choices.id, answer: null }]);
  expect(cards?.blocks).toEqual([]);
});

test("a card from a conversation the reader can't see stays out of the page's cards", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const hidden = (await (
    await owner(`/api/app/organizations/${orgId}/channels`, { json: { name: "cofre", visibility: "private" } })
  ).json()) as { id: string };
  const poll = await createConversationArtifact(
    t.engine.artifacts,
    { type: "agent", agentId, channelId: hidden.id },
    orgId,
    { title: "Bônus", content: { kind: "poll", question: "Bônus?", options: ["Sim", "Não"], multiple: false } },
  );
  await t.db
    .insert(schema.polls)
    .values({ artifactId: poll.id, orgId, runId: crypto.randomUUID(), closesAt: new Date(Date.now() + 3_600_000) });
  await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "Olhem isso.",
    meta: { artifacts: [{ id: poll.id, version: poll.version, title: poll.title }] },
  });
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  const cardsOf = async (b: typeof owner) =>
    (
      (await (await b(`/api/app/organizations/${orgId}/channels/${channelId}/messages?include=cards`)).json()) as {
        cards: { artifacts: { id: string }[]; polls: { id: string }[] };
      }
    ).cards;

  expect((await cardsOf(owner)).artifacts.map((a) => a.id)).toEqual([poll.id]);
  const seen = await cardsOf(member);
  expect(seen.artifacts).toEqual([]);
  expect(seen.polls).toEqual([]);
});
