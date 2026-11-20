import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("Drive folders over the API: create, nest, upload into, list, move, rename, delete", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const made = await api("/drive-folders", { json: { name: "Reports" } });
  expect(made.status).toBe(201);
  const reports = (await made.json()) as { id: string; name: string; parentId: string | null };
  expect(reports).toMatchObject({ name: "Reports", parentId: null });
  const year = (await (await api("/drive-folders", { json: { name: "2026", parentId: reports.id } })).json()) as {
    id: string;
  };

  const form = new FormData();
  form.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
  form.append("folderId", year.id);
  const uploaded = await api("/artifacts/files", { method: "POST", body: form });
  expect(uploaded.status).toBe(201);
  const file = (await uploaded.json()) as { id: string; folderId: string };
  expect(file.folderId).toBe(year.id);

  const list = async (folder: string) =>
    ((await (await api(`/artifacts?folder=${folder}`)).json()) as { artifacts: { id: string; title: string }[] })
      .artifacts;
  expect((await list(year.id)).map((a) => a.id)).toEqual([file.id]);
  expect(await list("root")).toEqual([]);

  const moved = await api("/artifacts/move", { json: { ids: [file.id], folderId: null } });
  expect(await moved.json()).toEqual({ moved: 1 });
  expect((await list("root")).map((a) => a.id)).toEqual([file.id]);

  const renamed = await api(`/artifacts/${file.id}`, { method: "PATCH", json: { title: "Notes 2026" } });
  expect(await renamed.json()).toMatchObject({ title: "Notes 2026", version: 1, folderId: null });

  const loop = await api(`/drive-folders/${reports.id}`, { method: "PATCH", json: { parentId: year.id } });
  expect(loop.status).toBe(400);
  expect(await loop.json()).toMatchObject({ error: { code: "drive.folder_into_itself" } });

  await api("/artifacts/move", { json: { ids: [file.id], folderId: year.id } });
  const gone = await api(`/drive-folders/${reports.id}`, { method: "DELETE" });
  expect(await gone.json()).toEqual({ trashed: 1, kept: 0 });
  expect(((await (await api("/drive-folders")).json()) as { folders: unknown[] }).folders).toEqual([]);
});
