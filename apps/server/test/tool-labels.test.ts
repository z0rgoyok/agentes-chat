import { afterEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("POST /tool-labels: a member gets a connector tool's name in a language, written once and kept; nobody else does", async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  const asked: string[][] = [];
  t.engine.context.toolLabels = {
    write: async ({ locale, keys }): Promise<Record<string, string>> => {
      asked.push(keys);
      return locale === "pt-BR" ? { list_available_accounts: "Listar contas disponíveis" } : {};
    },
  };
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ask = (b: typeof owner, json: unknown) => b(`/api/app/organizations/${orgId}/tool-labels`, { json });

  const res = await ask(owner, { locale: "pt-BR", keys: ["list_available_accounts", "list_invoices"] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ labels: { list_available_accounts: "Listar contas disponíveis" } });
  // Kept: only the one it couldn't write is asked for again.
  await ask(owner, { locale: "pt-BR", keys: ["list_available_accounts", "list_invoices"] });
  expect(asked).toEqual([["list_available_accounts", "list_invoices"], ["list_invoices"]]);

  // Only names as the catalog keys them, a few at a time, in a language of the app's.
  expect((await ask(owner, { locale: "pt-BR", keys: ["Drop table;"] })).status).toBe(400);
  expect((await ask(owner, { locale: "xx", keys: ["list_invoices"] })).status).toBe(400);
  expect((await ask(owner, { locale: "pt-BR", keys: Array.from({ length: 31 }, (_, i) => `k${i}`) })).status).toBe(400);

  // Signed out, or someone of another workspace: nothing.
  expect((await ask(browser(t), { locale: "pt-BR", keys: ["list_invoices"] })).status).toBe(401);
  const outsider = browser(t);
  await signUp(outsider, "outsider@example.com");
  expect((await ask(outsider, { locale: "pt-BR", keys: ["list_invoices"] })).status).toBe(403);
  expect(asked).toHaveLength(2);
});
