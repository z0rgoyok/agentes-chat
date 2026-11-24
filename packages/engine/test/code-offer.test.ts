import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, orgOverview } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** Whether the apps offer Code (ADR 0215 §12): `OrgOverview.code`, read by the sidebar, ⌘K and the phone's Eu. */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** An open session of Dev's that only the owner takes part in. */
async function ownersSession() {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({
      orgId: f.org.id,
      name: "code-1a2b3c4d",
      kind: "code",
      visibility: "private",
      createdByUserId: f.owner.id,
    })
    .returning();
  const channelId = channel?.id ?? "";
  const root = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId,
    author: { type: "person", userId: f.owner.id },
    body: "Code session",
  });
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId, userId: f.owner.id });
  const [session] = await f.db
    .insert(schema.codeSessions)
    .values({
      orgId: f.org.id,
      channelId,
      rootMessageId: root.id,
      agentId: f.agent.id,
      repo: "acme/app",
      repoDir: "repos/acme/app",
      title: "Fix the login",
      branch: "agentes/dev/fix-login-1a2b",
      worktreePath: ".worktrees/c-1a2b3c4d",
      worktreeState: "ready",
      createdBy: f.owner.id,
    })
    .returning();
  if (!session) throw new Error("no session");
  return session;
}

test("Code has something only with an agent that programs on a computer, or an open session the person is in", async () => {
  f = await setup();
  const member = await addMember(f.db, f.org.id, "member");
  const code = async (userId: string) => (await orgOverview(f.db, userId, f.org.id)).code;
  const setAgent = (values: Partial<typeof schema.agents.$inferInsert>) =>
    f.db.update(schema.agents).set(values).where(eq(schema.agents.id, f.agent.id));

  // Dev thinks with the workspace's model: nothing to program with.
  expect(await code(f.owner.id)).toBe(false);
  // Claude Code with no computer to run on: still nothing.
  await setAgent({ brain: "claude_code" });
  expect(await code(f.owner.id)).toBe(false);

  // On a computer: Code for everyone in the workspace.
  const [machine] = await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "Mac" }).returning();
  await setAgent({ machineId: machine?.id });
  expect(await code(f.owner.id)).toBe(true);
  expect(await code(member.id)).toBe(true);

  // Archived, it takes Code with it; an open session keeps it for who takes part, not for the others.
  await setAgent({ archivedAt: new Date() });
  expect(await code(f.owner.id)).toBe(false);
  const session = await ownersSession();
  expect(await code(f.owner.id)).toBe(true);
  expect(await code(member.id)).toBe(false);

  // Closed: nothing left.
  await f.db.update(schema.codeSessions).set({ archivedAt: new Date() }).where(eq(schema.codeSessions.id, session.id));
  expect(await code(f.owner.id)).toBe(false);
});
