import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createIssue,
  createIssueProject,
  createIssueToolSource,
  createOrganization,
  deleteIssueProject,
  ForbiddenError,
  getIssue,
  grantScopes,
  listIssueActivity,
  listIssueProjects,
  listIssues,
  openTasksBrief,
  PROJECTS_MAX,
  updateIssue,
  updateIssueProject,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ValidationError,
  );

describe("task projects", () => {
  test("a task takes one project, the list filters by it, and deleting the project keeps its tasks", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const clinic = await createIssueProject(deps, f.owner.id, f.org.id, { name: "  Clínica   Teo ", color: "teal" });
    const bakery = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Padaria Lia" });
    expect(clinic).toMatchObject({ name: "Clínica Teo", color: "teal", archived: false, open: 0 });
    expect(bakery.color).toBe("graphite");

    const a = await createIssue(deps, ana, f.org.id, { title: "Lembrete de retorno", projectId: clinic.id });
    const b = await createIssue(deps, ana, f.org.id, { title: "Cardápio com fotos", projectId: bakery.id });
    const loose = await createIssue(deps, ana, f.org.id, { title: "Organizar o trimestre" });
    expect(a.project).toEqual({ id: clinic.id, name: "Clínica Teo", color: "teal", archived: false });
    expect(loose.project).toBeNull();

    const titles = async (projectId?: string) =>
      (await listIssues(f.db, ana, f.org.id, { projectId })).map((i) => i.title).sort();
    expect(await titles(clinic.id)).toEqual(["Lembrete de retorno"]);
    expect(await titles("none")).toEqual(["Organizar o trimestre"]);
    expect(await titles()).toHaveLength(3);
    // The search still reads titles, inside a project too.
    expect((await listIssues(f.db, ana, f.org.id, { q: "cardápio", projectId: bakery.id })).map((i) => i.id)).toEqual([
      b.id,
    ]);
    expect(await listIssues(f.db, ana, f.org.id, { q: "cardápio", projectId: clinic.id })).toEqual([]);

    // Moving it and taking it out are events in the task's activity; setting the same project again is not.
    await updateIssue(deps, ana, f.org.id, loose.id, { projectId: clinic.id });
    await updateIssue(deps, ana, f.org.id, loose.id, { projectId: clinic.id });
    const out = await updateIssue(deps, ana, f.org.id, loose.id, { projectId: null });
    expect(out.project).toBeNull();
    const events = (await listIssueActivity(f.db, ana, f.org.id, loose.id)).filter(
      (e) => e.event === "project_changed",
    );
    expect(events.map((e) => [e.textCode, e.textParams])).toEqual([
      ["project_set", { project: "Clínica Teo" }],
      ["project_removed", {}],
    ]);

    // Closed tasks leave the count. Deleting the project clears it from its tasks and deletes none.
    await updateIssue(deps, ana, f.org.id, b.id, { status: "done" });
    const listed = await listIssueProjects(f.db, f.owner.id, f.org.id);
    expect(listed.projects.map((p) => [p.name, p.open])).toEqual([
      ["Clínica Teo", 1],
      ["Padaria Lia", 0],
    ]);
    expect(listed.unfiled).toBe(1);
    await deleteIssueProject(deps, f.owner.id, f.org.id, clinic.id);
    expect((await getIssue(f.db, ana, f.org.id, { id: a.id })).project).toBeNull();
    expect(await titles()).toHaveLength(3);
    expect((await listIssueProjects(f.db, f.owner.id, f.org.id)).unfiled).toBe(2);
  });

  test("names are unique whatever their capitals, cut at 80 characters, and colours come from the roles' list", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const first = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Petshop Bruno" });
    const taken = await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "petshop bruno" }));
    expect(taken).toMatchObject({ code: "issue_project.name_taken" });
    const other = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Mercado Ana" });
    expect(
      await rejection(updateIssueProject(deps, f.owner.id, f.org.id, other.id, { name: "PETSHOP BRUNO" })),
    ).toMatchObject({
      code: "issue_project.name_taken",
    });
    // Its own name in other capitals is a rename, not a clash.
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, first.id, { name: "PetShop Bruno" })).name).toBe(
      "PetShop Bruno",
    );
    const long = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Projeto ".repeat(40) });
    expect(long.name).toHaveLength(79);
    expect(await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "   " }))).toBeInstanceOf(
      ValidationError,
    );
    expect(
      await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "Azul", color: "sky" })),
    ).toBeInstanceOf(ValidationError);
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, first.id, { color: "violet" })).color).toBe("violet");
  });

  test("an archived project keeps its tasks and takes no new one; a project of another workspace is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const old = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Acme 2025" });
    const kept = await createIssue(deps, ana, f.org.id, { title: "Fechar o ano", projectId: old.id });
    const loose = await createIssue(deps, ana, f.org.id, { title: "Sem projeto" });
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, old.id, { archived: true })).archived).toBe(true);

    expect((await getIssue(f.db, ana, f.org.id, { id: kept.id })).project).toMatchObject({ archived: true });
    expect((await listIssues(f.db, ana, f.org.id, { projectId: old.id })).map((i) => i.id)).toEqual([kept.id]);
    // Its own task can still be edited, and saved with the project it already has.
    expect((await updateIssue(deps, ana, f.org.id, kept.id, { title: "Fechar 2025", projectId: old.id })).title).toBe(
      "Fechar 2025",
    );
    expect(await rejection(createIssue(deps, ana, f.org.id, { title: "Nova", projectId: old.id }))).toMatchObject({
      code: "issue_project.archived",
    });
    expect(await rejection(updateIssue(deps, ana, f.org.id, loose.id, { projectId: old.id }))).toMatchObject({
      code: "issue_project.archived",
    });
    // Archived ones list last, and come back.
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Zeta" });
    expect((await listIssueProjects(f.db, f.owner.id, f.org.id)).projects.map((p) => p.name)).toEqual([
      "Zeta",
      "Acme 2025",
    ]);
    await updateIssueProject(deps, f.owner.id, f.org.id, old.id, { archived: false });
    expect((await updateIssue(deps, ana, f.org.id, loose.id, { projectId: old.id })).project?.id).toBe(old.id);

    const { organization: elsewhere } = await createOrganization(f.db, f.owner.id, { name: "Outra" });
    const [foreign] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: elsewhere.id, name: "De fora" })
      .returning();
    expect(await rejection(updateIssue(deps, ana, f.org.id, loose.id, { projectId: foreign?.id ?? "" }))).toMatchObject(
      {
        code: "issue_project.not_found",
      },
    );
    expect(await rejection(deleteIssueProject(deps, f.owner.id, f.org.id, foreign?.id ?? ""))).toBeDefined();
  });

  test("who may create tasks manages projects; a workspace holds 200; the counts follow who sees each task", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno");
    const project = await createIssueProject(deps, bruno.id, f.org.id, { name: "Do Bruno" });
    // A task limited to the owner is not counted for Bruno.
    await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Só da Ana",
      projectId: project.id,
      audience: { mode: "people", userIds: [f.owner.id] },
    });
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "De todos", projectId: project.id });
    const open = async (userId: string) => (await listIssueProjects(f.db, userId, f.org.id)).projects[0]?.open;
    expect(await open(f.owner.id)).toBe(2);
    expect(await open(bruno.id)).toBe(1);

    expect(await rejection(createIssueProject(deps, "someone-else", f.org.id, { name: "Outro" }))).toBeInstanceOf(
      ForbiddenError,
    );

    await f.db
      .insert(schema.issueProjects)
      .values(Array.from({ length: PROJECTS_MAX - 1 }, (_, k) => ({ orgId: f.org.id, name: `Cliente ${k + 1}` })));
    expect(await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "Um a mais" }))).toMatchObject({
      code: "issue_project.too_many",
    });
  });

  test("agents set a project by name: an unknown one is refused with the existing names, a new one only when asked", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    await grantScopes(
      f.db,
      f.org.id,
      f.agent.id,
      ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
    );
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const run = async (name: string, input: Record<string, unknown>) => {
      const out = await tools.find((t) => t.name === name)?.execute(input, ctx);
      return { content: String(out?.content ?? ""), isError: out?.isError === true };
    };
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Clínica Teo" });
    const hidden = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Antigo" });
    await updateIssueProject(deps, f.owner.id, f.org.id, hidden.id, { archived: true });

    const typo = await run("create_issue", { title: "Agenda", project: "Clinica" });
    expect(typo.isError).toBe(true);
    expect(typo.content).toContain('The projects are: "Clínica Teo".');
    expect(typo.content).not.toContain("Antigo");
    expect(await listIssues(f.db, person(f.owner.id), f.org.id)).toEqual([]);

    // Its name in any capitals is the same project.
    const made = await run("create_issue", { title: "Agenda", project: "clínica teo" });
    expect(made).toMatchObject({ isError: false });
    expect(made.content).toContain("Agenda [project: Clínica Teo]");
    // Asked for a new one: made on the spot, once.
    const fresh = await run("create_issue", { title: "Vitrine", project: "Mercado Ana", new_project: true });
    expect(fresh.content).toContain("[project: Mercado Ana]");
    await run("create_issue", { title: "Preços", project: "mercado ana", new_project: true });
    const names = (await listIssueProjects(f.db, f.owner.id, f.org.id)).projects.map((p) => p.name);
    expect(names).toEqual(["Clínica Teo", "Mercado Ana", "Antigo"]);

    const only = await run("list_issues", { project: "Mercado Ana" });
    expect(only.content.split("\n")).toHaveLength(2);
    expect(only.content).not.toContain("Agenda");
    expect((await run("list_issues", { project: "Nada" })).isError).toBe(true);
    // An archived project is read, never written to.
    expect(await run("list_issues", { project: "antigo" })).toEqual({ content: "No issues.", isError: false });
    const late = await run("create_issue", { title: "Tarde", project: "Antigo", new_project: true });
    expect(late.isError).toBe(true);
    expect(late.content).toContain("is archived");

    const [agenda] = await listIssues(f.db, person(f.owner.id), f.org.id, { q: "Agenda" });
    const moved = await run("update_issue", { issue: `#${agenda?.number}`, project: "Mercado Ana" });
    expect(moved.content).toContain("[project: Mercado Ana]");
    const cleared = await run("update_issue", { issue: `#${agenda?.number}`, project: "none" });
    expect(cleared.content).not.toContain("[project:");
    expect((await run("list_issues", { project: "none" })).content).toContain("Agenda");
    expect((await run("list_issues", { project: "None" })).content).toContain("Agenda");
    // A change that names no project leaves it where it is.
    await run("update_issue", { issue: `#${agenda?.number}`, project: "Clínica Teo" });
    const kept = await run("update_issue", { issue: `#${agenda?.number}`, priority: "high" });
    expect(kept.content).toContain("[project: Clínica Teo]");
  });

  test("an agent's open tasks say each one's project", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Padaria Lia" });
    const assignees = [{ type: "agent" as const, id: f.agent.id }];
    await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Pedido no site",
      assignees,
      projectId: project.id,
    });
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem projeto", assignees });
    const brief = await openTasksBrief(f.db, f.org.id, f.agent.id, f.general.id, false);
    expect(brief).toContain("Pedido no site (todo, project Padaria Lia)");
    expect(brief).toContain("Sem projeto (todo)");
  });
});
