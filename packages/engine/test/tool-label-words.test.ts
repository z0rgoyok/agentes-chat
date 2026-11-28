import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createLlmToolLabelWriter, type ModelGateway, toolLabelText, toolLabelWords } from "../src";
import { type Fixture, setup } from "./fixtures";

/** Connector tools' names in the reader's language: written once per workspace and language, kept, never waited on. */

let f: Fixture;
afterEach(() => f?.close());

const answer = (labels: Record<string, string>) =>
  JSON.stringify({ labels: Object.entries(labels).map(([key, label]) => ({ key, label })) });

test("a label is one short line: quotes and closing dots go, an answer too long is none", () => {
  expect(toolLabelText('  "Listar contas disponíveis."  ')).toBe("Listar contas disponíveis");
  expect(toolLabelText("Listar\ncontas")).toBe("Listar contas");
  expect(toolLabelText("")).toBeNull();
  expect(toolLabelText(42)).toBeNull();
  expect(toolLabelText("x".repeat(61))).toBeNull();
  expect(toolLabelText(`${'"'.repeat(100_000)}x`)).toBe("x");
  expect(toolLabelText("«Criar link».")).toBe("Criar link");
});

test("the workspace's cheap model writes the missing ones through the gateway, recorded on the org, then they are kept", async () => {
  let calls = 0;
  f = await setup({
    reply: () => {
      calls++;
      return {
        chunks: [
          answer({
            list_available_accounts: "Listar contas disponíveis",
            // Never a key it wasn't asked for.
            delete_everything: "Apagar tudo",
          }),
        ],
      };
    },
  });
  const words = await toolLabelWords(f.context, f.org.id, "pt-BR", ["list_available_accounts", "Not A Key!"]);
  expect(words).toEqual({ list_available_accounts: "Listar contas disponíveis" });
  expect(calls).toBe(1);
  const usage = await f.db
    .select({ kind: schema.usageRecords.kind, agentId: schema.usageRecords.agentId })
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.orgId, f.org.id));
  expect(usage).toEqual([{ kind: "summary", agentId: null }]);
  const kept = await f.db
    .select({ key: schema.toolLabelWords.key, words: schema.toolLabelWords.words })
    .from(schema.toolLabelWords)
    .where(and(eq(schema.toolLabelWords.orgId, f.org.id), eq(schema.toolLabelWords.locale, "pt-BR")));
  expect(kept).toEqual([{ key: "list_available_accounts", words: "Listar contas disponíveis" }]);

  // Asked again: read from what was kept, no model call.
  expect(await toolLabelWords(f.context, f.org.id, "pt-BR", ["list_available_accounts"])).toEqual(words);
  expect(calls).toBe(1);
  // English needs none: the name's words are already English.
  expect(await toolLabelWords(f.context, f.org.id, "en", ["list_available_accounts"])).toEqual({});
  expect(calls).toBe(1);
});

test("a model that fails or answers nonsense leaves the English words, and the next ask tries again", async () => {
  f = await setup();
  let fail = true;
  f.context.toolLabels = {
    write: async ({ keys }) => {
      if (fail) throw new Error("provider down");
      return Object.fromEntries(keys.map((k) => [k, "Criar link de pagamento"]));
    },
  };
  expect(await toolLabelWords(f.context, f.org.id, "pt-BR", ["create_payment_link"])).toEqual({});
  fail = false;
  expect(await toolLabelWords(f.context, f.org.id, "pt-BR", ["create_payment_link"])).toEqual({
    create_payment_link: "Criar link de pagamento",
  });

  const writer = createLlmToolLabelWriter({
    gateway: { complete: async () => ({ text: "not json" }) as Awaited<ReturnType<ModelGateway["complete"]>> },
    resolveModel: async () => "claude-haiku-5-5",
  });
  expect(await writer.write({ orgId: f.org.id, locale: "es", keys: ["list_invoices"] })).toEqual({});
  const none = createLlmToolLabelWriter({
    gateway: { complete: async () => ({}) as never },
    resolveModel: async () => null,
  });
  expect(await none.write({ orgId: f.org.id, locale: "es", keys: ["list_invoices"] })).toEqual({});
});
