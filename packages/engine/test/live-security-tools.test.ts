import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import * as ss from "@agenteschat/live/spreadsheet";
import * as Y from "yjs";
import {
  createLiveFileToolSource,
  insertMessage,
  type LiveDocs,
  type ToolContext,
  type ToolOutput,
  type ToolSource,
} from "../src";
import { DocPresence, MAX_SOCKET_CLIENTS } from "../src/live/awareness";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor } from "./live-fixtures";

/**
 * Limits that keep one caller from exhausting a process (ADR 0196 §2 and §5): a socket speaks for a few awareness
 * client ids at most, and an agent's spreadsheet batch can't fill or style more cells than a spreadsheet holds.
 */

describe("presence: client ids per socket", () => {
  const who = { user: { kind: "person" as const, id: "u-ada" }, viewOnly: false, hidden: false };
  const state = { mode: "editing", cursor: { x: 1, y: 2, space: "canvas" } };

  test("a socket speaks for a few client ids; its own stay its own, other sockets are not affected", () => {
    const doc = new Y.Doc();
    const presence = new DocPresence(doc, { broadcast() {}, relay() {}, changed() {} });
    try {
      const socket = {};
      const kept: number[] = [];
      for (let id = 1; id <= 50; id++) {
        if (presence.filter(socket, who, { clientId: id, clock: 1, state })) kept.push(id);
      }
      expect(kept).toEqual(Array.from({ length: MAX_SOCKET_CLIENTS }, (_, i) => i + 1));
      expect(presence.socketClients(socket)).toHaveLength(MAX_SOCKET_CLIENTS);
      // Its own ids keep updating, and their removal goes through.
      expect(presence.filter(socket, who, { clientId: 1, clock: 2, state })).not.toBeNull();
      expect(presence.filter(socket, who, { clientId: 1, clock: 3, state: null })).not.toBeNull();
      // Another socket (another tab) has its own room.
      const other = {};
      expect(presence.filter(other, who, { clientId: 100, clock: 1, state })).not.toBeNull();
    } finally {
      presence.destroy();
      doc.destroy();
    }
  });
});

describe("edit_spreadsheet: ranges past what a spreadsheet holds", () => {
  let f: Fixture;
  let docs: LiveDocs;
  let source: ToolSource | null = null;
  const lazy: ToolSource = { name: "live-files", tools: async (ctx) => (source ? source.tools(ctx) : []) };

  beforeEach(async () => {
    f = await setup({ toolSources: [lazy] });
    docs = liveDocsFor(f, "a");
    source = createLiveFileToolSource({ artifacts: f.artifactDeps, live: docs });
  });
  afterEach(async () => {
    source = null;
    await docs.stop();
    await f.close();
  });

  async function ctx(): Promise<ToolContext> {
    const msg = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev do it",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: msg.id,
        triggerMessageId: msg.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
    };
  }

  async function call(c: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const r = await f.tools?.invoke(c, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
    if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
    return r.output;
  }

  const artifactOf = (out: ToolOutput) => out.data?.artifact as { id: string };

  async function sheetSize(fileId: string) {
    const { doc } = await docs.read(f.org.id, fileId);
    try {
      const sheet = ss.sheetIds(doc)[0] ?? "";
      return { size: ss.sheetSize(doc, sheet), cells: ss.cellsMap(doc, sheet)?.size ?? 0 };
    } finally {
      doc.destroy();
    }
  }

  test("a value set over a whole grown sheet is refused before the fill, and nothing changes", async () => {
    const c = await ctx();
    const made = await call(c, "create_spreadsheet", { title: "Big" });
    const file = artifactOf(made).id;
    const out = await call(c, "edit_spreadsheet", {
      file,
      ops: [{ op: "set", range: "A1:SF20000", values: [[1]] }],
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("A1:SF20000 is more cells than a spreadsheet holds");
    expect((await sheetSize(file)).cells).toBe(0);
    // A fill within the limit still repeats down.
    const fine = await call(c, "edit_spreadsheet", { file, ops: [{ op: "set", range: "A1:A40", values: [[1]] }] });
    expect(fine.isError).toBeFalsy();
    expect((await sheetSize(file)).cells).toBe(40);
  });

  test("styling more cells than a spreadsheet holds is refused, a sheet's worth of a column is not", async () => {
    const c = await ctx();
    const made = await call(c, "create_spreadsheet", { title: "Wide" });
    const file = artifactOf(made).id;
    // The sheet grows to 1100 rows by 500 columns in the batch, then all of it is made bold: 550,000 cells.
    const grow = [
      { op: "insert_rows", at: 1, count: 1000 },
      { op: "insert_columns", at: "A", count: 474 },
    ];
    const out = await call(c, "edit_spreadsheet", {
      file,
      ops: [...grow, { op: "format", range: "A1:SF1100", bold: true }],
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("A1:SF1100 is more cells than a spreadsheet holds");
    expect((await sheetSize(file)).size).toEqual({ rows: 100, cols: 26 });
    const column = await call(c, "edit_spreadsheet", {
      file,
      ops: [...grow, { op: "format", range: "B:B", bold: true }],
    });
    expect(column.isError).toBeFalsy();
    expect((await sheetSize(file)).size).toEqual({ rows: 1100, cols: 500 });
  });
});
