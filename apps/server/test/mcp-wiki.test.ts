import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray, schema } from "@agenteschat/db";
import { APP_WIKI_TOOL_NAMES, wikiNoteDetail } from "@agenteschat/engine";
import { callTool, connectApp, mcp } from "./ai-apps";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

async function setup() {
  const b = browser(t);
  await signUp(b, "owner@example.com");
  const seeded = await seedOrg(b);
  const ownerId = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { b, ownerId, ...seeded };
}

/** A personal token (`agp_`), the way a sync script holds one. */
async function personalToken(b: Browser, orgId: string, access: "read" | "write" | "manage", name = "Vault sync") {
  const res = await b(`/api/app/organizations/${orgId}/tokens`, { json: { name, access, expiresInDays: 30 } });
  if (res.status !== 201) throw new Error(`token: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { secret: string }).secret;
}

type Result = Awaited<ReturnType<typeof callTool>>;
const data = (r: Result) => r.structuredContent as Record<string, unknown>;
const text = (r: Result) => r.content[0]?.text ?? "";
const slugs = (r: Result) => (data(r).pages as { slug: string }[]).map((p) => p.slug);

const toolNames = async (bearer: string) =>
  (
    (await (await mcp(t, bearer, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as {
      result: { tools: { name: string }[] };
    }
  ).result.tools.map((x) => x.name);

const WIKI_READS = ["list_wiki_pages", "read_wiki_page"];
const WIKI_WRITES = APP_WIKI_TOOL_NAMES.filter((n) => !WIKI_READS.includes(n));

const pageRow = async (id: string) => {
  const [row] = await t.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.id, id));
  return row;
};

describe("a personal token keeps the wiki current", () => {
  test("as the person: create, list, read, change with base_version and trash, audited with the app", async () => {
    const { b, orgId, ownerId } = await setup();
    const token = await personalToken(b, orgId, "manage");

    const made = data(
      await callTool(t, token, "create_wiki_page", {
        title: "Guia de Deploy",
        folder: "Processos",
        body: "## Rollback\nVolte a tag.",
        tags: ["deploy"],
      }),
    );
    expect(made).toMatchObject({ slug: "guia-de-deploy", folder: "Processos", version: 1, existing: false });
    const id = String(made.id);
    expect(await pageRow(id)).toMatchObject({ createdByType: "person", createdById: ownerId, tags: ["deploy"] });
    const [first] = await t.db.select().from(schema.wikiPageVersions).where(eq(schema.wikiPageVersions.pageId, id));
    // The version is the person's, and its note says the app; the history still reads it as "created".
    expect(first).toMatchObject({
      authorType: "person",
      authorId: ownerId,
      note: "through Vault sync: created the page",
    });
    expect(wikiNoteDetail(first?.note ?? "")).toEqual({ noteCode: "created", noteParams: {} });
    // The same title again is that page, unchanged.
    const again = data(await callTool(t, token, "create_wiki_page", { title: "guia de deploy", body: "Outro texto." }));
    expect(again).toMatchObject({ id, existing: true, version: 1 });
    expect((await pageRow(id))?.body).toBe("## Rollback\nVolte a tag.");

    await callTool(t, token, "create_wiki_page", { title: "Preços", body: "Tabela." });
    const inFolder = await callTool(t, token, "list_wiki_pages", { folder: "Processos" });
    expect(slugs(inFolder)).toEqual(["guia-de-deploy"]);
    expect((data(inFolder).pages as unknown[])[0]).toMatchObject({
      id,
      title: "Guia de Deploy",
      folder: "Processos",
      version: 1,
      updated_by: { kind: "person", name: "owner" },
    });
    expect(slugs(await callTool(t, token, "list_wiki_pages", {}))).toEqual(
      expect.arrayContaining(["guia-de-deploy", "precos"]),
    );

    const read = await callTool(t, token, "read_wiki_page", { page: "guia-de-deploy" });
    expect(data(read)).toMatchObject({
      id,
      version: 1,
      tags: ["deploy"],
      locked: false,
      can_edit: true,
      body: { untrusted_text: "## Rollback\nVolte a tag." },
    });
    // The text others wrote is fenced as content in what the model reads.
    expect(text(read)).toStartWith("Text inside untrusted_text fields");
    expect(text(read).slice(text(read).indexOf("BEGIN MESSAGE"))).toContain("Volte a tag.");

    const saved = data(
      await callTool(t, token, "update_wiki_page", {
        page: "guia-de-deploy",
        base_version: 1,
        body: "## Rollback\nVolte a tag anterior.",
      }),
    );
    expect(saved).toMatchObject({ id, version: 2, changed: true });
    // Someone saved after the version it read: nothing is saved, and the result says the current version.
    const stale = await callTool(t, token, "update_wiki_page", { page: id, base_version: 1, body: "Velho." });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toStartWith("version_conflict:");
    expect(text(stale)).toContain('{"code":"version_conflict","current_version":2}');
    expect((await pageRow(id))?.body).toBe("## Rollback\nVolte a tag anterior.");
    const same = data(
      await callTool(t, token, "update_wiki_page", {
        page: id,
        base_version: 2,
        body: "## Rollback\nVolte a tag anterior.",
      }),
    );
    expect(same).toMatchObject({ version: 2, changed: false });
    const tagged = data(
      await callTool(t, token, "update_wiki_page", { page: id, base_version: 2, tags: ["deploy", "ops"] }),
    );
    expect(tagged).toMatchObject({ version: 3, changed: true });
    expect((await pageRow(id))?.tags).toEqual(["deploy", "ops"]);
    expect((await callTool(t, token, "update_wiki_page", { page: id, base_version: 3 })).isError).toBe(true);
    const notes = await t.db
      .select({ note: schema.wikiPageVersions.note })
      .from(schema.wikiPageVersions)
      .where(eq(schema.wikiPageVersions.pageId, id));
    expect(notes.map((v) => v.note).sort()).toEqual([
      "through Vault sync: created the page",
      "through Vault sync: edited",
      "through Vault sync: edited",
    ]);

    const later = new Date(Date.now() + 60_000).toISOString();
    expect(slugs(await callTool(t, token, "list_wiki_pages", { updated_since: later }))).toEqual([]);
    const earlier = new Date(Date.now() - 60_000).toISOString();
    expect(slugs(await callTool(t, token, "list_wiki_pages", { updated_since: earlier }))).toContain("guia-de-deploy");

    const trashed = data(await callTool(t, token, "delete_wiki_page", { page: "guia-de-deploy" }));
    expect(trashed).toMatchObject({ id, in_trash: true });
    expect((await pageRow(id))?.deletedAt).not.toBeNull();
    const gone = await callTool(t, token, "read_wiki_page", { page: "guia-de-deploy" });
    expect(gone.isError).toBe(true);
    expect(text(gone)).toContain("Not found");
    expect(slugs(await callTool(t, token, "list_wiki_pages", {}))).not.toContain("guia-de-deploy");

    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.orgId, orgId),
          eq(schema.auditLog.targetId, id),
          inArray(schema.auditLog.action, ["apps.created", "apps.updated", "apps.deleted"]),
        ),
      );
    expect(audit.map((a) => [a.action, a.actorType, a.actorId]).sort()).toEqual([
      ["apps.created", "person", ownerId],
      ["apps.deleted", "person", ownerId],
      ["apps.updated", "person", ownerId],
      ["apps.updated", "person", ownerId],
    ]);
    for (const row of audit) expect(row.details).toMatchObject({ client: "Vault sync" });
    expect(audit.find((a) => a.action === "apps.created")?.details).toMatchObject({ name: "Guia de Deploy" });
    // The engine's own rows stay the person's, as from the web app.
    const engine = await t.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.action, "wiki.page_deleted")));
    expect(engine.map((a) => a.actorId)).toEqual([ownerId]);
  });

  test("a long list comes a page at a time, pages saved at the same instant included", async () => {
    const { b, orgId } = await setup();
    const token = await personalToken(b, orgId, "manage");
    for (const title of ["Um", "Dois", "Três"])
      await callTool(t, token, "create_wiki_page", { title, folder: "Lote", body: title });
    // An import's batch: one instant for all.
    await t.db
      .update(schema.wikiPages)
      .set({ updatedAt: new Date("2026-11-01T12:00:00Z") })
      .where(and(eq(schema.wikiPages.orgId, orgId), eq(schema.wikiPages.folder, "Lote")));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const r = await callTool(t, token, "list_wiki_pages", {
        folder: "Lote",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...slugs(r));
      cursor = (data(r).next_cursor as string | null) ?? undefined;
      if (i < 2) expect(cursor).toBeString();
    }
    expect(cursor).toBeUndefined();
    expect(seen.sort()).toEqual(["dois", "tres", "um"]);
    const first = data(await callTool(t, token, "list_wiki_pages", { folder: "Lote", limit: 1 }));
    const other = await callTool(t, token, "list_wiki_pages", { cursor: String(first.next_cursor) });
    expect(other.isError).toBe(true);
    expect(text(other)).toContain("This cursor belongs to another query");
  });
});

describe("the person's access, and the connection's", () => {
  test("a read grant gets the wiki's reads only: no write tool is listed or runs", async () => {
    const { b, orgId } = await setup();
    const read = await personalToken(b, orgId, "read", "Reader");
    const names = await toolNames(read);
    expect(names).toEqual(expect.arrayContaining(WIKI_READS));
    for (const name of WIKI_WRITES) expect(names).not.toContain(name);
    const refused = (await (
      await mcp(t, read, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "create_wiki_page", arguments: { title: "Fantasma" } },
      })
    ).json()) as { error?: { message: string } };
    expect(refused.error?.message).toBe("Tool create_wiki_page not found");
    expect(await t.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Fantasma"))).toHaveLength(0);
    // Sending tasks is not managing: an app with write access reads the wiki and writes nothing to it.
    const write = await connectApp(t, b, orgId, { access: "write" });
    const writeNames = await toolNames(write.access);
    expect(writeNames).toEqual(expect.arrayContaining(WIKI_READS));
    for (const name of WIKI_WRITES) expect(writeNames).not.toContain(name);
  });

  test("a page limited to an audience: gone from a member's list, and no access to read, change or trash it", async () => {
    const { b, orgId } = await setup();
    const bia = await joinByInvitation(t, b, orgId, "bia@example.com");
    const api = (who: Browser, path: string, init?: Parameters<Browser>[1]) =>
      who(`/api/app/organizations/${orgId}${path}`, init);
    const { roles } = (await (await api(b, "/roles")).json()) as { roles: { id: string; permissions: string[] }[] };
    const adminRole = roles.find((r) => r.permissions.includes("administrator"))?.id ?? "";
    const created = (await (
      await api(b, "/wiki/pages", { json: { title: "Margens", body: "Margem mínima de 40%." } })
    ).json()) as { id: string; version: number };
    const limited = await api(b, "/wiki/pages/margens/audience", {
      method: "PUT",
      json: { audience: { roleIds: [adminRole], userIds: [] } },
    });
    expect(limited.status).toBe(200);

    const token = await personalToken(bia, orgId, "manage", "Bia's sync");
    expect(slugs(await callTool(t, token, "list_wiki_pages", {}))).not.toContain("margens");
    const read = await callTool(t, token, "read_wiki_page", { page: "margens" });
    expect(read.isError).toBe(true);
    expect(text(read)).toBe("You don't have access to this page");
    expect(text(read)).not.toContain("40%");
    const change = await callTool(t, token, "update_wiki_page", { page: "margens", base_version: 1, body: "0%" });
    expect(change.isError).toBe(true);
    expect((await callTool(t, token, "delete_wiki_page", { page: created.id })).isError).toBe(true);
    const row = await pageRow(created.id);
    expect(row).toMatchObject({ body: "Margem mínima de 40%.", version: created.version, deletedAt: null });
    // Its title isn't confirmed either: a page of hers with the same title takes the next free address.
    const mine = data(await callTool(t, token, "create_wiki_page", { title: "Margens", body: "As minhas." }));
    expect(mine.existing).toBe(false);
    expect(mine.slug).not.toBe("margens");
    // The owner's token still sees and edits it.
    const owner = await personalToken(b, orgId, "manage");
    expect(slugs(await callTool(t, owner, "list_wiki_pages", {}))).toContain("margens");
    expect(data(await callTool(t, owner, "read_wiki_page", { page: "margens" }))).toMatchObject({ can_edit: true });
  });

  test("who edits: a member off the editors' list reads and can't change; without edit_wiki no app writes", async () => {
    const { b, orgId } = await setup();
    const bia = await joinByInvitation(t, b, orgId, "bia@example.com");
    const api = (path: string, init?: Parameters<Browser>[1]) => b(`/api/app/organizations/${orgId}${path}`, init);
    const { roles } = (await (await api("/roles")).json()) as { roles: { id: string; permissions: string[] }[] };
    const adminRole = roles.find((r) => r.permissions.includes("administrator"))?.id ?? "";
    await api("/wiki/pages", { json: { title: "Processo", body: "Passo 1." } });
    const editors = await api("/wiki/pages/processo/audience", {
      method: "PUT",
      json: { audience: null, agentIds: null, editors: { roleIds: [adminRole], userIds: [] }, agentEditorIds: null },
    });
    expect(editors.status).toBe(200);

    const token = await personalToken(bia, orgId, "manage", "Bia's sync");
    const read = data(await callTool(t, token, "read_wiki_page", { page: "processo" }));
    expect(read).toMatchObject({ can_edit: false, body: { untrusted_text: "Passo 1." } });
    const refused = await callTool(t, token, "update_wiki_page", {
      page: "processo",
      base_version: Number(read.version),
      body: "Passo 2.",
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe("Only the people chosen edit this page");
    expect((await callTool(t, token, "delete_wiki_page", { page: "processo" })).isError).toBe(true);
    const [row] = await t.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.slug, "processo"));
    expect(row).toMatchObject({ body: "Passo 1.", deletedAt: null });

    const off = await api("/permissions/edit_wiki", { method: "PUT", json: { everyone: 0, roles: [] } });
    expect(off.status).toBe(200);
    const blocked = await callTool(t, token, "create_wiki_page", { title: "Rascunho", body: "x" });
    expect(blocked.isError).toBe(true);
    expect(await t.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Rascunho"))).toHaveLength(0);
  });

  test("wiki writes are limited per person: past the limit an error and nothing written", async () => {
    const { b, orgId } = await setup();
    const token = await personalToken(b, orgId, "manage");
    const limiter = t.adapters.rateLimiter;
    const real = limiter.consume.bind(limiter);
    limiter.consume = async (key, rule) =>
      key.startsWith("mcp:wiki:") ? { allowed: false, remaining: 0, resetAt: new Date() } : real(key, rule);
    const res = await callTool(t, token, "create_wiki_page", { title: "Excesso", body: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Too many wiki changes from apps.");
    expect(await t.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.title, "Excesso"))).toHaveLength(0);
  });
});
