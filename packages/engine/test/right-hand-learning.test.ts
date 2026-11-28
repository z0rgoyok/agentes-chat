import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  ensureRightHand,
  forgetRightHandLearned,
  insertMessage,
  learnRun,
  listAgentMemoryRows,
  openPersonAgentDm,
  RIGHT_HAND,
  setLodiPrefs,
  updateOrgSettings,
} from "../src";
import { addRunStep } from "../src/runs";
import { addMember, setup as baseSetup, type Fixture } from "./fixtures";

/**
 * The right hand learns on its own like every agent (Q22 B): what it learns in a person's DM is theirs alone, what it
 * learns in a channel is that channel's, and a preference said in a channel stays the person's. Each person, and the
 * workspace, can turn it off; Forget all removes only the person's own.
 */

let f: Fixture;
afterEach(() => f?.close());

let learnOutput: { items: unknown[]; skill_fixes: unknown[] } = { items: [], skill_fixes: [] };

const setup = () =>
  baseSetup({
    contextTools: true,
    reply: (req) =>
      systemText(req.system).includes("You keep the memory of an AI agent")
        ? { chunks: [JSON.stringify(learnOutput)] }
        : { chunks: ["ok"] },
  });

async function lodiOf() {
  await ensureRightHand(f.db, f.org.id);
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
}

/** A finished run of the right hand on what `userId` wrote in `channelId`. */
async function lodiRun(userId: string, channelId: string, body: string, meta?: Record<string, unknown>) {
  const lodi = await lodiOf();
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId },
    body,
    ...(meta ? { meta } : {}),
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: lodi.id,
      channelId,
      threadRootId: msg.id,
      triggerMessageId: msg.id,
      trigger: "mention",
      hop: 1,
      status: "done",
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const fact = (content: string) => ({
  kind: "fact",
  scope: "workspace",
  about_person: "",
  title: content,
  content,
  refs: ["m1"],
});
/** `outside`: the run read a web page while it worked. */
const learn = async (
  userId: string,
  channelId: string,
  body: string,
  items: unknown[],
  meta?: Record<string, unknown>,
  outside = false,
) => {
  learnOutput = { items, skill_fixes: [] };
  const run = await lodiRun(userId, channelId, body, meta);
  if (outside) {
    const toolUseId = `tu_${crypto.randomUUID()}`;
    await addRunStep(f.db, run, "tool_call", { toolUseId, name: "web_fetch", input: {} });
    await addRunStep(f.db, run, "tool_result", { toolUseId, name: "web_fetch", content: "a page", isError: false });
  }
  return learnRun(f.context, { orgId: f.org.id, runId: run.id });
};
const seen = async (userId: string) =>
  (await listAgentMemoryRows(f.db, userId, f.org.id, (await lodiOf()).id)).items.map((i) => i.content).sort();

describe("the right hand learns on its own (Q22)", () => {
  test("a DM's memory is that person's alone, a channel's its readers', a preference said in a channel the person's", async () => {
    f = await setup();
    const lodi = await lodiOf();
    const joao = await addMember(f.db, f.org.id, "admin", "joao");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: joao.id });
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);

    const inDm = await learn(f.owner.id, dm.id, "my build box is called kestrel", [
      fact("Ana's build box is kestrel."),
    ]);
    expect(inDm.skipped).toBeUndefined();
    const inChannel = await learn(f.owner.id, f.general.id, "staging lives at staging.example.com, I review pricing", [
      fact("Staging is at staging.example.com."),
      {
        kind: "preference",
        scope: "person",
        about_person: "ana",
        title: "pricing reviews",
        content: "Ana reviews pricing changes herself.",
        refs: ["m1"],
      },
    ]);
    expect(inChannel.saved.map((s) => s.scopeType).sort()).toEqual(["agent", "person"]);

    const all = await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.agentId, lodi.id));
    expect(all.every((i) => i.channelIds.length === 1)).toBe(true);
    expect(await seen(f.owner.id)).toEqual([
      "Ana reviews pricing changes herself.",
      "Ana's build box is kestrel.",
      "Staging is at staging.example.com.",
    ]);
    // João reads #general and reviews memory as an admin: the channel's fact, never Ana's DM or her preference.
    expect(await seen(joao.id)).toEqual(["Staging is at staging.example.com."]);
  });

  test("off for the person, nothing is learned from them; off for the workspace, from nobody", async () => {
    f = await setup();
    const lodi = await lodiOf();
    const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    await setLodiPrefs(f.db, f.org.id, f.owner.id, { learnOff: true });
    expect((await learn(f.owner.id, dm.id, "remember kestrel", [fact("Kestrel.")])).skipped).toBe("learning_off");

    await setLodiPrefs(f.db, f.org.id, f.owner.id, { learnOff: false });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { rightHandLearns: false });
    expect((await learn(f.owner.id, dm.id, "remember kestrel", [fact("Kestrel.")])).skipped).toBe("learning_off");
    expect(await f.db.select().from(schema.contextItems).where(eq(schema.contextItems.agentId, lodi.id))).toEqual([]);

    await updateOrgSettings(f.db, f.owner.id, f.org.id, { rightHandLearns: true });
    expect((await learn(f.owner.id, dm.id, "remember kestrel", [fact("Kestrel.")])).saved).toHaveLength(1);
  });

  test("Forget all removes only what it learned on its own for that person", async () => {
    f = await setup();
    const lodi = await lodiOf();
    const joao = await addMember(f.db, f.org.id, "member", "joao");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: joao.id });
    const anaDm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, lodi.id);
    const joaoDm = await openPersonAgentDm(f.db, f.org.id, joao.id, lodi.id);
    await learn(f.owner.id, anaDm.id, "kestrel is mine", [fact("Ana's box is kestrel.")]);
    await learn(f.owner.id, f.general.id, "staging is staging.example.com and I review pricing", [
      fact("Staging is at staging.example.com."),
      {
        kind: "preference",
        scope: "person",
        about_person: "ana",
        title: "pricing",
        content: "Ana reviews pricing.",
        refs: ["m1"],
      },
    ]);
    await learn(joao.id, joaoDm.id, "osprey is mine", [fact("João's box is osprey.")]);
    // What Ana asked it to remember herself stays.
    await f.db.insert(schema.contextItems).values({
      orgId: f.org.id,
      kind: "preference",
      scopeType: "person",
      scopeId: f.owner.id,
      agentId: lodi.id,
      content: "Ana wants replies in English.",
      channelIds: [anaDm.id],
      createdByKind: "person",
      createdById: f.owner.id,
    });

    expect(await forgetRightHandLearned(f.db, f.owner.id, f.org.id)).toBe(2);
    expect(await seen(f.owner.id)).toEqual(["Ana wants replies in English.", "Staging is at staging.example.com."]);
    expect(await seen(joao.id)).toEqual(["João's box is osprey.", "Staging is at staging.example.com."]);
  });

  test("a person who turned it off isn't learned from in a channel either, even when someone else asked", async () => {
    f = await setup();
    const joao = await addMember(f.db, f.org.id, "member", "joao");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: joao.id });
    await setLodiPrefs(f.db, f.org.id, joao.id, { learnOff: true });
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: joao.id },
      body: "the release train leaves on Thursdays",
    });
    const every = ["m1", "m2", "m3", "m4", "m5", "m6"];
    const out = await learn(f.owner.id, f.general.id, "noted", [{ ...fact("Releases go on Thursdays."), refs: every }]);
    expect(out.saved).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual(["refused"]);
  });

  test("a person's preference said in a channel stays theirs even when the run read outside content", async () => {
    f = await setup();
    const joao = await addMember(f.db, f.org.id, "member", "joao");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: joao.id });
    const out = await learn(
      f.owner.id,
      f.general.id,
      "I review pricing changes myself",
      [
        {
          kind: "preference",
          scope: "person",
          about_person: "ana",
          title: "pricing reviews",
          content: "Ana reviews pricing changes herself.",
          refs: ["m1"],
        },
      ],
      undefined,
      true,
    );
    expect(out.saved.map((s) => s.scopeType)).toEqual(["person"]);
    expect(await seen(joao.id)).toEqual([]);
  });
});
