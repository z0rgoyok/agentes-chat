import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  activeConnections,
  type ConnectorDeps,
  createApiKeyConnection,
  githubCallAuth,
  insertMessage,
  listAgentScopes,
} from "../src";
import { createAgentRuns } from "../src/dispatch";
import { codeCommitAuthor, personAccountOfPush, personAccountOfRun } from "../src/git/person-account";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const TEAM_TOKEN = "ghp_team_0000000000";
const OWN_TOKEN = "ghp_own_11111111111";

/** GitHub saying whose token it is. */
const github = (async (input: string | URL | Request, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get("authorization");
  if (String(input) === "https://api.github.com/user" && auth === `Bearer ${OWN_TOKEN}`) {
    return Response.json({ id: 4242, login: "ana-dev" });
  }
  return Response.json({ message: "Bad credentials" }, { status: 401 });
}) as typeof globalThis.fetch;

async function world() {
  f = await setup();
  const connectors: ConnectorDeps = {
    db: f.db,
    keyWrappers: [f.keyWrapper],
    publicUrl: "https://agentes.test",
    http: github,
  };
  const team = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: TEAM_TOKEN,
  });
  const own = await createApiKeyConnection(connectors, f.owner.id, f.org.id, {
    connector: "github",
    apiKey: OWN_TOKEN,
    personal: true,
  });
  return { connectors, team, own };
}

/** A code session of the agent, and a run in it asked by `userId` (or by nobody: an agent's own message). */
async function session(repo: string, branch: string, userId: string | null = f.owner.id) {
  const [channel] = await f.db
    .insert(schema.channels)
    .values({ orgId: f.org.id, name: `code-${branch}`, kind: "code", visibility: "private" })
    .returning();
  if (!channel) throw new Error("no channel");
  const ask = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: channel.id,
    author: userId
      ? { type: "person", userId }
      : { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body: "Fix the login",
  });
  const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask as never, [f.agent.id], "mention"));
  if (!run) throw new Error("no run");
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
  await f.db.insert(schema.codeSessions).values({
    orgId: f.org.id,
    channelId: channel.id,
    rootMessageId: ask.id,
    agentId: f.agent.id,
    repo,
    repoDir: `repos/${repo}`,
    title: "Fix the login",
    branch,
    createdBy: userId,
  });
  return run;
}

describe("a person's own GitHub account in a code session", () => {
  test("connecting it keeps the account, puts it on no agent and leaves the workspace's GitHub alone", async () => {
    const w = await world();
    expect(w.own).toMatchObject({ ownerUserId: f.owner.id, accountLabel: "ana-dev", accountId: "4242" });
    expect(w.team.ownerUserId).toBeNull();
    const live = await activeConnections(f.db, f.org.id);
    expect(live.filter((c) => c.connector === "github")).toHaveLength(2);
    // The team's is every agent's; a person's own account is nobody's tool.
    const scopes = await listAgentScopes(f.db, f.org.id, f.agent.id);
    expect(scopes.some((s) => s.connectionId === w.team.id)).toBe(true);
    expect(scopes.some((s) => s.connectionId === w.own.id)).toBe(false);
  });

  test("a token GitHub doesn't answer for is refused, since the account is the whole point", async () => {
    const w = await world();
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    await expect(
      createApiKeyConnection(w.connectors, other.id, f.org.id, {
        connector: "github",
        apiKey: "ghp_nobody_00000000",
        personal: true,
      }),
    ).rejects.toMatchObject({ code: "connector.key_refused" });
  });

  test("the commits of what they ask are authored as them, at GitHub's address for the account", async () => {
    await world();
    const run = await session("acme/app", "agentes/dev/fix-login");
    expect(await codeCommitAuthor(f.db, f.org.id, run.id)).toEqual({
      name: f.owner.name,
      email: "4242+ana-dev@users.noreply.github.com",
    });
    expect(await personAccountOfRun(f.db, f.org.id, run.id)).toMatchObject({
      personId: f.owner.id,
      repo: "acme/app",
      host: "github",
    });
  });

  test("nobody's run, someone without an account, a project only on the computer: the workspace's, as before", async () => {
    await world();
    const alone = await session("acme/app", "agentes/dev/alone", null);
    expect(await codeCommitAuthor(f.db, f.org.id, alone.id)).toBeNull();
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    const theirs = await session("acme/app", "agentes/dev/theirs", other.id);
    expect(await codeCommitAuthor(f.db, f.org.id, theirs.id)).toBeNull();
    const local = await session("notes", "agentes/dev/notes");
    expect(await codeCommitAuthor(f.db, f.org.id, local.id)).toBeNull();
    expect(await codeCommitAuthor(f.db, f.org.id, null)).toBeNull();
  });

  test("a push is theirs only on the session's own branch, while their run works there", async () => {
    await world();
    const run = await session("acme/app", "agentes/dev/fix-login");
    const push = (refs: string[], repo = "acme/app") =>
      personAccountOfPush(f.db, { orgId: f.org.id, agentId: f.agent.id, repo, refs });
    expect(await push(["refs/heads/agentes/dev/fix-login"])).toMatchObject({ personId: f.owner.id });
    // GitHub spells a repository any way: the session's is the same one.
    expect(await push(["refs/heads/agentes/dev/fix-login"], "Acme/App")).toMatchObject({ personId: f.owner.id });
    expect(await push(["refs/heads/agentes/dev/other"])).toBeNull();
    expect(await push(["refs/heads/agentes/dev/fix-login", "refs/heads/agentes/dev/other"])).toBeNull();
    expect(await push(["refs/heads/agentes/dev/fix-login"], "acme/api")).toBeNull();
    // Someone else's run working in the same session at the same time: the push names no run, so it is nobody's.
    const other = await addMember(f.db, f.org.id, "member", "Bia");
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, run.channelId));
    const theirs = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: channel?.id ?? "",
      author: { type: "person", userId: other.id },
      body: "And the logout",
    });
    const [second] = await f.db.transaction((tx) => createAgentRuns(tx, theirs as never, [f.agent.id], "mention"));
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running" })
      .where(eq(schema.agentRuns.id, second?.id ?? ""));
    expect(await push(["refs/heads/agentes/dev/fix-login"])).toBeNull();
    await f.db
      .update(schema.agentRuns)
      .set({ status: "done" })
      .where(eq(schema.agentRuns.id, second?.id ?? ""));
    expect(await push(["refs/heads/agentes/dev/fix-login"])).toMatchObject({ personId: f.owner.id });
    // Its run ended: nobody is asking now.
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
    expect(await push(["refs/heads/agentes/dev/fix-login"])).toBeNull();
  });

  test("what the agent writes on the session's repository goes with their token; reads and other repositories don't", async () => {
    const w = await world();
    const run = await session("acme/app", "agentes/dev/fix-login");
    const ctx = { db: f.db, orgId: f.org.id, runId: run.id };
    const as = async (scope: string, input: Record<string, unknown>) => {
      const auth = await githubCallAuth(w.connectors, undefined, ctx, w.team, {
        tool: "create_pull_request",
        scope,
        input,
      });
      return "token" in auth ? auth.token : null;
    };
    expect(await as("github:pr.write", { owner: "acme", repo: "app" })).toBe(OWN_TOKEN);
    expect(await as("github:pr.read", { owner: "acme", repo: "app" })).toBe(TEAM_TOKEN);
    expect(await as("github:pr.write", { owner: "acme", repo: "api" })).toBe(TEAM_TOKEN);
    // Merging stays the workspace's, with its approval.
    expect(await as("github:pr.merge", { owner: "acme", repo: "app" })).toBe(TEAM_TOKEN);
    // A call outside any run.
    const none = await githubCallAuth(w.connectors, undefined, { db: f.db, orgId: f.org.id }, w.team, {
      tool: "create_pull_request",
      scope: "github:pr.write",
      input: { owner: "acme", repo: "app" },
    });
    expect("token" in none ? none.token : null).toBe(TEAM_TOKEN);
  });
});
