import { asc, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CONFIDENTIAL_META_KEY,
  type ConnectorDeps,
  connectCustomServer,
  createConnectorToolSource,
  type McpConnect,
  mcpSessionOver,
  saveCustomTools,
  type ToolSource,
} from "../src";
import { type WorldOptions, world } from "./autonomy/harness";

export const VAULT_HOST = "vault.example.com";
const VAULT_SECRET = "test-secret-".padEnd(32, "x");

/** What the vault's records say: a word no other text of a test holds. */
export const CANARY = "zebrafinch";

/**
 * An in-process MCP server of an operator's own (no network): `read_record` answers with the confidential mark in
 * its result's `_meta`, `list_records` and `change_record` without it. `requests`: every `tools/call` as it left.
 */
export function fakeVault() {
  const requests: { name: string; meta: Record<string, unknown> | undefined }[] = [];
  const build = () => {
    const server = new McpServer({ name: "fake-vault", version: "1" });
    server.registerTool(
      "read_record",
      { description: "Read one record", inputSchema: { id: z.string() } },
      async (args) => ({
        content: [{ type: "text", text: `Record ${args.id}: the customer wrote "${CANARY} ${args.id}".` }],
        _meta: { [CONFIDENTIAL_META_KEY]: true },
      }),
    );
    server.registerTool("list_records", { description: "List record ids", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "Records: r1, r2" }],
    }));
    server.registerTool(
      "change_record",
      { description: "Change a record's note", inputSchema: { id: z.string(), note: z.string() } },
      async (args) => ({ content: [{ type: "text", text: `Changed ${args.id}` }] }),
    );
    return server;
  };
  const connect: McpConnect = async () => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const send = client.send.bind(client);
    client.send = (message, options) => {
      if ("method" in message && message.method === "tools/call") {
        const params = message.params as { name: string; _meta?: Record<string, unknown> };
        requests.push({ name: params.name, meta: params._meta });
      }
      return send(message, options);
    };
    await build().connect(server);
    return mcpSessionOver(client);
  };
  return { connect, requests };
}

/**
 * A world (`autonomy/harness`) whose agents hold the vault's tools (`vault_read_record`, `vault_list_records`,
 * `vault_change_record`), connected by address. `listed: false`: the operator did not list its host, so its mark
 * counts for nothing. `changeAsks`: `vault_change_record` asks a person before it runs.
 */
export async function vaultWorld(options: WorldOptions & { listed?: boolean; changeAsks?: boolean }) {
  let real: ToolSource | null = null;
  const lazy: ToolSource = { name: "connectors", tools: (ctx) => (real ? real.tools(ctx) : Promise.resolve([])) };
  const w = await world({
    ...options,
    setup: { ...options.setup, toolSources: [lazy, ...(options.setup?.toolSources ?? [])] },
  });
  const vault = fakeVault();
  const deps: ConnectorDeps = {
    db: w.db,
    keyWrappers: [w.f.keyWrapper],
    publicUrl: "https://chat.example.com",
    resolveHost: async () => ["93.184.216.34"],
    connect: vault.connect,
  };
  const started = await connectCustomServer(deps, w.owner.id, w.org.id, {
    serverUrl: `https://${VAULT_HOST}/mcp`,
    apiKey: "test-key",
    label: "Vault",
  });
  if (started.status !== "connected") throw new Error(`expected connected, got ${started.status}`);
  await saveCustomTools(deps, w.owner.id, w.org.id, started.server.id, {
    label: "Vault",
    tools: [
      { name: "read_record", access: "read", label: "Read a record" },
      { name: "list_records", access: "read", label: "List records" },
      { name: "change_record", access: options.changeAsks ? "approval" : "write", label: "Change a record" },
    ],
  });
  real = createConnectorToolSource({
    ...deps,
    callerIdentity: options.listed === false ? new Map() : new Map([[VAULT_HOST, VAULT_SECRET]]),
  });

  /** Every message of the scenario's conversation as it is stored, oldest first. */
  const stored = () =>
    w.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.channelId, w.channelId))
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
  /** Every request a model got, the small judge's and the summaries' included, as text. */
  const modelInputs = () =>
    [...w.f.provider.calls, ...w.f.openaiProvider.calls].map((c) =>
      JSON.stringify([c.request.system, c.request.messages]),
    );
  /** The requests of one agent's own turns, as text. */
  const turnsOf = (handle: string) =>
    modelInputs().filter((text) => new RegExp(`You are [^\\\\n]*? \\(@${handle}\\)`).test(text));
  /** The tables with a row that holds `word` anywhere, a jsonb column included. */
  const tablesHolding = async (word: string) => {
    const tables = rowsOf<{ name: string }>(
      await w.db.execute(sql`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 1`),
    );
    const found: string[] = [];
    for (const { name } of tables) {
      const [hit] = rowsOf<{ n: number }>(
        await w.db.execute(
          sql`select count(*)::int as n from ${sql.identifier(name)} t where row_to_json(t)::text ilike ${`%${word}%`}`,
        ),
      );
      if ((hit?.n ?? 0) > 0) found.push(name);
    }
    return found;
  };
  return { ...w, vault, connectionId: started.server.id, stored, modelInputs, turnsOf, tablesHolding };
}

export type VaultWorld = Awaited<ReturnType<typeof vaultWorld>>;
