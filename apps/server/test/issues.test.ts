import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

test("issues API: create, by number, patch, criteria, comments, activity, ask agent, from a message", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/issues", { json: { title: "Login quebra", criteria: ["Funciona no Safari"] } });
  expect(created.status).toBe(201);
  const issue = (await created.json()) as { id: string; number: number; criteria: { id: string }[] };
  expect(issue.number).toBe(1);
  expect(await (await api("/issues/by-number/1")).json()).toMatchObject({ id: issue.id, title: "Login quebra" });
  expect(
    await (await api(`/issues/${issue.id}`, { method: "PATCH", json: { status: "in_progress" } })).json(),
  ).toMatchObject({
    status: "in_progress",
  });
  const githubUrl = "https://github.com/acme/app/issues/12";
  const linked = await api(`/issues/${issue.id}`, { method: "PATCH", json: { githubUrl } });
  expect(await linked.json()).toMatchObject({ githubUrl });
  const notGithub = { githubUrl: "https://example.org/a/b/issues/1" };
  expect((await api(`/issues/${issue.id}`, { method: "PATCH", json: notGithub })).status).toBe(400);
  const unlinked = await api(`/issues/${issue.id}`, { method: "PATCH", json: { githubUrl: null } });
  expect(await unlinked.json()).toMatchObject({ githubUrl: null });
  const criterion = await api(`/issues/${issue.id}/criteria/${issue.criteria[0]?.id}`, {
    method: "PUT",
    json: { done: true },
  });
  expect(((await criterion.json()) as { criteria: { done: boolean }[] }).criteria[0]?.done).toBe(true);
  expect((await api(`/issues/${issue.id}/comments`, { json: { text: "Olhando" } })).status).toBe(201);

  const asked = await api(`/issues/${issue.id}/ask-agent`, { json: { agentId } });
  expect(await asked.json()).toMatchObject({ assignees: [{ type: "agent", id: agentId }] });
  await t.drain();
  const activity = (await (await api(`/issues/${issue.id}/activity`)).json()) as {
    activity: { kind: string; event?: string; author: { type: string }; text: string }[];
  };
  // Comments are the task's conversation now (ADR 0145): the activity keeps its events.
  expect(activity.activity.map((a) => a.event ?? a.kind)).toEqual([
    "created",
    "status_changed",
    "github_link",
    "github_link",
    "criterion_checked",
    "assigned",
    "agent_asked",
  ]);

  // The conversation: opened once (the same thread again), read and written through the chat's own routes.
  const at = (await (await api(`/issues/${issue.id}/conversation`, { json: {} })).json()) as {
    channelId: string;
    rootId: string;
  };
  expect(await (await api(`/issues/${issue.id}/conversation`, { json: {} })).json()).toEqual(at);
  const read = await api(`/channels/${at.channelId}/messages?threadId=${at.rootId}`);
  const thread = (await read.json()) as {
    messages: { author: { type: string }; body: string; meta: Record<string, unknown> }[];
  };
  // The root stands for the task (never drawn); the replies are the conversation.
  expect(thread.messages.filter((m) => !m.meta.taskConversation).map((m) => [m.author.type, m.body])).toEqual([
    ["person", "Olhando"],
    ["person", "Please implement issue #1."],
    ["agent", "Feito."],
  ]);
  const posted = await api(`/channels/${at.channelId}/messages`, { json: { body: "Valeu", threadId: at.rootId } });
  expect(posted.status).toBe(201);
  const card = (await (await api(`/issues/${issue.id}`)).json()) as {
    conversation: { channelId: string; count: number; participants: { type: string }[]; working: boolean };
  };
  // The task's agent answers an unmentioned message in its conversation, as in a DM: it's working on "Valeu".
  expect(card.conversation).toMatchObject({ channelId: at.channelId, count: 4, working: true });
  expect(card.conversation.participants.map((p) => p.type)).toEqual(["person", "agent"]);
  // The agent's reply is unread for the task's creator, who follows its conversation, until they read the thread.
  expect(await (await api("/unread-tasks")).json()).toEqual({ tasks: [{ issueId: issue.id, unread: 1, mentions: 0 }] });
  expect((await api(`/threads/${at.rootId}/read`, { json: {} })).status).toBe(204);
  expect(await (await api("/unread-tasks")).json()).toEqual({ tasks: [] });

  const message = (await (
    await api(`/channels/${channelId}/messages`, { json: { body: "Bug no checkout" } })
  ).json()) as {
    id: string;
  };
  const fromMessage = await api(`/messages/${message.id}/issue`, { json: {} });
  expect(await fromMessage.json()).toMatchObject({ number: 2, title: "Bug no checkout", source: { type: "message" } });
  const list = (await (await api("/issues")).json()) as { issues: { number: number }[] };
  expect(list.issues.map((i) => i.number).sort()).toEqual([1, 2]);
});

test("board columns API: list, add, rename, move a task, delete with a destination", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  type Columns = { columns: { id: string; stage: string; name: string | null }[] };

  const start = (await (await api("/issue-columns")).json()) as Columns;
  expect(start.columns.map((c) => c.stage)).toEqual(["todo", "in_progress", "in_review", "done", "canceled"]);
  const added = await api("/issue-columns", { json: { name: "QA", stage: "in_review" } });
  expect(added.status).toBe(201);
  const qa = ((await added.json()) as Columns).columns.find((c) => c.name === "QA");
  if (!qa) throw new Error("QA column missing");
  const renamed = (await (
    await api(`/issue-columns/${qa.id}`, { method: "PATCH", json: { name: "Conferir" } })
  ).json()) as Columns;
  expect(renamed.columns.find((c) => c.id === qa.id)?.name).toBe("Conferir");

  const issue = (await (await api("/issues", { json: { title: "Relatório" } })).json()) as { id: string };
  const moved = await api(`/issues/${issue.id}`, { method: "PATCH", json: { columnId: qa.id } });
  expect(await moved.json()).toMatchObject({ status: "in_review", columnId: qa.id });

  const done = start.columns.find((c) => c.stage === "done");
  const deleted = await api(`/issue-columns/${qa.id}?moveTo=${done?.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(await (await api(`/issues/${issue.id}`)).json()).toMatchObject({ status: "done", columnId: done?.id });
});

test("projects API: create, list with counts, filter the tasks, rename, archive, delete; another workspace never reaches them", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  type Project = { id: string; name: string; color: string; archived: boolean; open: number };
  type Task = { id: string; title: string; project: { id: string; name: string; color: string } | null };

  expect(await (await api("/issue-projects")).json()).toEqual({ projects: [], unfiled: 0 });
  const made = await api("/issue-projects", { json: { name: "Clínica Teo", color: "teal" } });
  expect(made.status).toBe(201);
  const clinic = (await made.json()) as Project;
  expect(clinic).toMatchObject({ name: "Clínica Teo", color: "teal", archived: false, open: 0 });
  // The same name in other capitals, a colour outside the list, an empty and a too long name.
  const taken = await api("/issue-projects", { json: { name: "clínica teo" } });
  expect(taken.status).toBe(400);
  expect(await taken.json()).toMatchObject({ error: { code: "issue_project.name_taken" } });
  expect((await api("/issue-projects", { json: { name: "Azul", color: "sky" } })).status).toBe(400);
  expect((await api("/issue-projects", { json: { name: "" } })).status).toBe(400);
  expect((await api("/issue-projects", { json: { name: "x".repeat(81) } })).status).toBe(400);

  const inIt = (await (await api("/issues", { json: { title: "Lembrete", projectId: clinic.id } })).json()) as Task;
  expect(inIt.project).toMatchObject({ id: clinic.id, name: "Clínica Teo", color: "teal" });
  const loose = (await (await api("/issues", { json: { title: "Avulsa" } })).json()) as Task;
  expect(loose.project).toBeNull();
  const titles = async (query: string) =>
    ((await (await api(`/issues${query}`)).json()) as { issues: Task[] }).issues.map((i) => i.title).sort();
  expect(await titles(`?projectId=${clinic.id}`)).toEqual(["Lembrete"]);
  expect(await titles("?projectId=none")).toEqual(["Avulsa"]);
  expect(await titles(`?projectId=${clinic.id}&q=avulsa`)).toEqual([]);
  expect(await titles("")).toEqual(["Avulsa", "Lembrete"]);
  expect((await api("/issues?projectId=tudo")).status).toBe(400);
  expect(await (await api("/issue-projects")).json()).toMatchObject({ projects: [{ open: 1 }], unfiled: 1 });

  const moved = await api(`/issues/${loose.id}`, { method: "PATCH", json: { projectId: clinic.id } });
  expect(await moved.json()).toMatchObject({ project: { id: clinic.id } });
  const out = await api(`/issues/${loose.id}`, { method: "PATCH", json: { projectId: null } });
  expect(await out.json()).toMatchObject({ project: null });
  const unknown = "00000000-0000-7000-8000-000000000000";
  expect((await api(`/issues/${loose.id}`, { method: "PATCH", json: { projectId: unknown } })).status).toBe(400);

  const renamed = await api(`/issue-projects/${clinic.id}`, {
    method: "PATCH",
    json: { name: "Clínica", color: "rose" },
  });
  expect(await renamed.json()).toMatchObject({ name: "Clínica", color: "rose" });
  expect(await (await api(`/issues/${inIt.id}`)).json()).toMatchObject({ project: { name: "Clínica", color: "rose" } });
  const archived = await api(`/issue-projects/${clinic.id}`, { method: "PATCH", json: { archived: true } });
  expect(await archived.json()).toMatchObject({ archived: true });
  const refused = await api("/issues", { json: { title: "Tarde demais", projectId: clinic.id } });
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "issue_project.archived" } });

  // A member manages projects, as they create tasks. Through another workspace, this one's project doesn't exist.
  const member = await joinByInvitation(t, owner, orgId, "bruno@example.com");
  const theirs = await member(`/api/app/organizations/${orgId}/issue-projects`, { json: { name: "Do Bruno" } });
  expect(theirs.status).toBe(201);
  const { id: brunoProject } = (await theirs.json()) as Project;
  expect(
    (await member(`/api/app/organizations/${orgId}/issue-projects/${brunoProject}`, { method: "DELETE" })).status,
  ).toBe(204);
  // A workspace still in its onboarding comes back instead of a second one.
  await api("/onboarding", { method: "PATCH", json: { finished: true } });
  const made2 = (await (await owner("/api/app/organizations", { json: { name: "Beta" } })).json()) as {
    organization: { id: string };
  };
  const beta = `/api/app/organizations/${made2.organization.id}`;
  await owner(`${beta}/onboarding`, { method: "PATCH", json: { finished: true } });
  expect((await owner(`${beta}/issue-projects/${clinic.id}`, { method: "PATCH", json: { name: "Meu" } })).status).toBe(
    404,
  );
  expect((await owner(`${beta}/issue-projects/${clinic.id}`, { method: "DELETE" })).status).toBe(404);
  expect((await owner(`${beta}/issues`, { json: { title: "De fora", projectId: clinic.id } })).status).toBe(400);
  expect(await (await owner(`${beta}/issue-projects`)).json()).toEqual({ projects: [], unfiled: 0 });

  expect((await api(`/issue-projects/${clinic.id}`, { method: "DELETE" })).status).toBe(204);
  expect((await api(`/issue-projects/${clinic.id}`, { method: "DELETE" })).status).toBe(404);
  expect(await (await api(`/issues/${inIt.id}`)).json()).toMatchObject({ title: "Lembrete", project: null });
  expect(await (await api("/issue-projects")).json()).toEqual({ projects: [], unfiled: 2 });
});

test("deleting a task: 204, gone from the list and its address; a member who didn't create it is refused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const created = (await (await api("/issues", { json: { title: "Sobrou" } })).json()) as { id: string };
  const deleted = await api(`/issues/${created.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(204);
  expect((await api("/issues/by-number/1")).status).toBe(404);
  expect(await (await api("/issues")).json()).toMatchObject({ issues: [] });
  expect((await api(`/issues/${created.id}`, { method: "DELETE" })).status).toBe(404);
});

test("issues API: several assignees, sent as the whole list; asking an agent puts it first", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  type Actor = { type: string; id: string };
  type Issue = { id: string; createdBy: Actor; assignees: Actor[] };

  const bare = (await (await api("/issues", { json: { title: "Nobody's" } })).json()) as Issue;
  expect(bare.assignees).toEqual([]);
  const me = { type: "person", id: bare.createdBy.id };
  const agent = { type: "agent", id: agentId };

  // One named twice counts once.
  const created = await api("/issues", { json: { title: "Launch", assignees: [me, me] } });
  expect(created.status).toBe(201);
  const issue = (await created.json()) as Issue;
  expect(issue.assignees).toEqual([me]);
  const patch = (assignees: Actor[]) => api(`/issues/${issue.id}`, { method: "PATCH", json: { assignees } });
  expect(await (await patch([me, agent])).json()).toMatchObject({ assignees: [me, agent] });
  expect((await patch(Array.from({ length: 21 }, (_, n) => ({ type: "person", id: `user-${n}` })))).status).toBe(400);

  const asked = await api(`/issues/${issue.id}/ask-agent`, { json: { agentId } });
  expect(await asked.json()).toMatchObject({ assignees: [agent, me] });
  expect(await (await api(`/issues/${issue.id}`)).json()).toMatchObject({ assignees: [agent, me], subIssues: [] });

  expect(await (await patch([agent])).json()).toMatchObject({ assignees: [agent] });
  const { activity } = (await (await api(`/issues/${issue.id}/activity`)).json()) as {
    activity: { event?: string; textCode?: string; assignee?: Actor }[];
  };
  expect(activity.filter((a) => a.event === "assigned").map((a) => [a.textCode, a.assignee])).toEqual([
    ["assigned", agent],
    ["unassigned", me],
  ]);
});

test("issues API: a file taken off a task leaves its attachments, stays in the Drive, and the history names it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const file = (await (
    await api("/artifacts", { json: { title: "print.png", content: { kind: "document", markdown: "print" } } })
  ).json()) as { id: string };
  const created = await api("/issues", { json: { title: "Tela quebrada", attachmentIds: [file.id] } });
  const issue = (await created.json()) as { id: string; artifacts: { id: string }[] };
  expect(issue.artifacts.map((f) => f.id)).toEqual([file.id]);

  const taken = await api(`/issues/${issue.id}`, { method: "PATCH", json: { removeFiles: [file.id] } });
  expect(taken.status).toBe(200);
  expect(((await taken.json()) as { artifacts: unknown[] }).artifacts).toEqual([]);
  expect((await api(`/artifacts/${file.id}`)).status).toBe(200);
  const { activity } = (await (await api(`/issues/${issue.id}/activity`)).json()) as {
    activity: { event?: string; textCode?: string; textParams?: Record<string, string> }[];
  };
  expect(activity.find((a) => a.event === "artifact_unlinked")).toMatchObject({
    textCode: "files_removed",
    textParams: { names: "print.png" },
  });
  expect((await api(`/issues/${issue.id}`, { method: "PATCH", json: { removeFiles: ["not-an-id"] } })).status).toBe(
    400,
  );
});
