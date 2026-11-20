import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  askAgentAbout,
  cleanSelection,
  createArtifact,
  createChannel,
  type LiveAskDeps,
  NotFoundError,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { makeLiveFile, personActor } from "./live-fixtures";

/**
 * Ask an agent from inside a live file (ADR 0196 §6, ADR 0199): the person's own message, in the file's own
 * conversation when the agent may work on the file there, carrying what was selected; else their DM with the agent.
 */

let f: Fixture;
let deps: LiveAskDeps;
beforeEach(async () => {
  f = await setup();
  deps = { ...f.artifactDeps, pubsub: f.pubsub };
});
afterEach(async () => {
  await f.close();
});

const messageOf = async (id: string) => {
  const [m] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  if (!m) throw new Error("no message");
  return m;
};
const channelOf = async (id: string) => {
  const [c] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, id));
  if (!c) throw new Error("no channel");
  return c;
};
const runsFor = (messageId: string) =>
  f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId));

describe("where the message goes", () => {
  test("the file's own conversation, naming the agent, with the selection; the agent's run starts there", async () => {
    const sheet = await makeLiveFile(f, "spreadsheet", { title: "Budget", channelId: f.general.id });
    const sent = await askAgentAbout(deps, f.owner.id, f.org.id, sheet.id, {
      agentId: f.agent.id,
      text: "Sum this column",
      selection: { label: "Sheet 1!B2:B9", sheet: "Sheet 1", range: "B2:B9" },
    });
    const channel = await channelOf(sent.channelId);
    expect(channel.kind).toBe("file");
    expect(sent.threadId).not.toBeNull();
    const message = await messageOf(sent.id);
    expect(message.body).toBe("@dev Sum this column");
    expect(message.meta).toMatchObject({
      liveRef: {
        artifactId: sheet.id,
        kind: "spreadsheet",
        title: "Budget",
        selection: { label: "Sheet 1!B2:B9", sheet: "Sheet 1", range: "B2:B9" },
      },
    });
    // The file is right there: no card of it in its own conversation.
    expect(message.meta.artifacts).toBeUndefined();
    const runs = await runsFor(sent.id);
    expect(runs.map((r) => r.agentId)).toEqual([f.agent.id]);
  });

  test("a file in the shared Drive: its conversation too, which the agent joins", async () => {
    const canvas = await makeLiveFile(f, "canvas", { title: "Moodboard" });
    const sent = await askAgentAbout(deps, f.owner.id, f.org.id, canvas.id, {
      agentId: f.agent.id,
      text: "Make two more like these",
      selection: { label: "2 images", shapes: ["abc123", "def456"] },
    });
    const channel = await channelOf(sent.channelId);
    expect(channel.kind).toBe("file");
    const message = await messageOf(sent.id);
    expect(message.body).toBe("@dev Make two more like these");
    expect(message.meta).toMatchObject({
      liveRef: {
        artifactId: canvas.id,
        kind: "canvas",
        selection: { label: "2 images", shapes: ["abc123", "def456"] },
      },
    });
    expect((await runsFor(sent.id)).map((r) => r.agentId)).toEqual([f.agent.id]);
  });

  test("a channel the agent isn't in: its DM, carrying the file, never a mention that can't reach it", async () => {
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "planning", visibility: "private" });
    const deck = await makeLiveFile(f, "slides", { title: "Pitch", channelId: room.id });
    const sent = await askAgentAbout(deps, f.owner.id, f.org.id, deck.id, {
      agentId: f.agent.id,
      text: "Tighten slide 3",
      selection: { label: "slide 3", slide: "s3" },
    });
    expect(sent.channelId).not.toBe(room.id);
    expect((await channelOf(sent.channelId)).kind).toBe("dm");
    const message = await messageOf(sent.id);
    expect(message.meta).toMatchObject({ liveRef: { artifactId: deck.id }, artifacts: [{ id: deck.id }] });
  });
});

describe("refusals", () => {
  test("a file the person doesn't read, one that isn't live, an unknown agent, nothing to say", async () => {
    const room = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const hidden = await makeLiveFile(f, "spreadsheet", { title: "Salaries", channelId: room.id });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(
      askAgentAbout(deps, bia.id, f.org.id, hidden.id, { agentId: f.agent.id, text: "What is this?" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const notes = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Notes",
      content: { kind: "table", columns: ["what"], rows: [["Plain notes"]] },
    });
    await expect(
      askAgentAbout(deps, f.owner.id, f.org.id, notes.id, { agentId: f.agent.id, text: "Read it" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const sheet = await makeLiveFile(f, "spreadsheet");
    await expect(
      askAgentAbout(deps, f.owner.id, f.org.id, sheet.id, { agentId: crypto.randomUUID(), text: "Hi" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      askAgentAbout(deps, f.owner.id, f.org.id, sheet.id, { agentId: f.agent.id, text: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await f.db.select().from(schema.messages).where(eq(schema.messages.authorUserId, bia.id))).toEqual([]);
  });
});

test("the selection keeps only what the apps describe, each cut to its size", () => {
  expect(cleanSelection(undefined)).toBeUndefined();
  expect(cleanSelection({ label: "  " })).toBeUndefined();
  const raw = {
    label: `  Sheet 1!A1:C9 ${"x".repeat(400)}`,
    range: "A1:C9",
    shapes: ["ok_1", "not ok", "<script>", ...Array.from({ length: 300 }, (_, i) => `s${i}`)],
    extra: "dropped",
  } as unknown as Parameters<typeof cleanSelection>[0];
  const clean = cleanSelection(raw);
  expect(clean?.label.length).toBe(200);
  expect(clean?.label.startsWith("Sheet 1!A1:C9")).toBe(true);
  expect(clean?.range).toBe("A1:C9");
  expect(clean?.shapes?.[0]).toBe("ok_1");
  expect(clean?.shapes).toHaveLength(200);
  expect(clean?.shapes).not.toContain("not ok");
  expect(clean && "extra" in clean).toBe(false);
});
