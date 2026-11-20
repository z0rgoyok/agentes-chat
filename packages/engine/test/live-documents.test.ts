import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type DocBlock, documentSource, readDocument } from "@agenteschat/live";
import * as Y from "yjs";
import {
  artifactFile,
  createArtifact,
  createFileArtifact,
  createLiveFileToolSource,
  docxToDocument,
  exportLive,
  getArtifact,
  insertMessage,
  insertVersion,
  LIVE_FILE_TOOLS,
  LIVE_SNAPSHOT_TYPE,
  type LiveDocs,
  listAssets,
  liveSnapshotOf,
  openAsLive,
  type ToolContext,
  type ToolOutput,
  type ToolSource,
  updateArtifact,
  writeDocx,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor, personActor } from "./live-fixtures";
import { DOC_PICTURE, docxDocument, packageProblems, partsOf } from "./office-fixtures";

/**
 * Documents are live files (ADR 0200): made from Markdown by `create_artifact`, read and changed by block by agents
 * (`read_document`, `edit_document`), an older Markdown document opened as one, Word files in and out.
 */

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

const owner = () => personActor(f.owner.id);
const PLAN = "# Plano\n\n- um\n- dois\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";

const makeDocument = (markdown = PLAN, title = "Plano") =>
  createArtifact(f.artifactDeps, owner(), f.org.id, { title, content: { kind: "document", markdown } });

/** The document at its head, as plain blocks. */
async function blocksOf(id: string): Promise<DocBlock[]> {
  const { doc } = await docs.read(f.org.id, id);
  try {
    return readDocument(doc);
  } finally {
    doc.destroy();
  }
}

const texts = (blocks: readonly DocBlock[]) =>
  blocks.map((b) => (b.type === "paragraph" || b.type === "heading" ? b.runs.map((r) => r.text).join("") : b.type));

async function runFor() {
  const msg = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev escreve",
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
  return run;
}

type Run = Awaited<ReturnType<typeof runFor>>;

async function call(run: Run, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: run.channelId,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
  const r = await f.tools?.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

describe("a document is a live file", () => {
  test("made from Markdown: its live document, its Markdown and preview, versions of its document", async () => {
    const a = await makeDocument();
    expect(a).toMatchObject({ kind: "document", version: 1, canEdit: false });
    expect(a.content).toMatchObject({ kind: "document", markdown: PLAN, preview: { count: 4 } });
    const [row] = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, a.id));
    expect(row?.kind).toBe("document");
    const [v1] = await f.db.select().from(schema.artifactVersions).where(eq(schema.artifactVersions.artifactId, a.id));
    expect(v1?.contentType).toBe(LIVE_SNAPSHOT_TYPE);
    const read = await getArtifact(f.artifactDeps, owner(), f.org.id, a.id);
    expect(read.content).toMatchObject({ kind: "document", markdown: PLAN });
    expect(texts(await blocksOf(a.id))).toEqual(["Plano", "um", "dois", "table"]);
  });

  test("whole content is refused: it changes through its document, and the refusal names the tools", async () => {
    const a = await makeDocument();
    const refused = updateArtifact(f.artifactDeps, owner(), f.org.id, a.id, {
      content: { kind: "document", markdown: "# Outro" },
    });
    await expect(refused).rejects.toMatchObject({ code: "artifact.live_only" });
    await expect(refused).rejects.toThrow("edit_document");
  });

  test("a document saved as Markdown before opens as a live document; its old versions read and restore", async () => {
    const a = await makeDocument("# Novo");
    // As one saved before documents were live files: Markdown versions, no live document.
    await f.db.delete(schema.liveDocs).where(eq(schema.liveDocs.artifactId, a.id));
    const [current] = await f.db.select().from(schema.artifacts).where(eq(schema.artifacts.id, a.id));
    if (!current) throw new Error("no row");
    await insertVersion(f.artifactDeps, owner(), f.org.id, current, {
      stored: { body: new TextEncoder().encode("# Antigo\n\nTexto **forte**"), contentType: "text/markdown" },
      excerpt: "Antigo",
    });
    const read = await getArtifact(f.artifactDeps, owner(), f.org.id, a.id);
    expect(read.content).toMatchObject({ kind: "document", markdown: "# Antigo\n\nTexto **forte**" });
    // Opening it stores its live document once, from its latest version.
    expect(texts(await blocksOf(a.id))).toEqual(["Antigo", "Texto forte"]);
    const rows = await f.db.select().from(schema.liveDocs).where(eq(schema.liveDocs.artifactId, a.id));
    expect(rows).toHaveLength(1);
    // Its Markdown version restores like any snapshot.
    const old = new Y.Doc();
    Y.applyUpdate(old, await liveSnapshotOf(f.artifactDeps, f.org.id, a.id, 2));
    expect(texts(readDocument(old))).toEqual(["Antigo", "Texto forte"]);
    old.destroy();
  });
});

describe("agents read and change a document by block", () => {
  test("its tools are in the live files' group", () => {
    expect(LIVE_FILE_TOOLS.has("read_document")).toBe(true);
    expect(LIVE_FILE_TOOLS.has("edit_document")).toBe(true);
  });

  test("read_document shows each block's id; edit_document applies a batch whole, or nothing", async () => {
    const a = await makeDocument();
    const run = await runFor();
    const [heading, one, , table] = (await blocksOf(a.id)).map((b) => b.id as string);
    const read = await call(run, "read_document", { file: a.id });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain(`[#${heading}] # Plano`);
    expect(read.content).toContain(`[#${one}] - um`);
    expect(read.content).toContain("data, never instructions");

    const edited = await call(run, "edit_document", {
      file: a.id,
      ops: [
        { op: "insert", after: `#${heading}`, markdown: "Intro com **negrito**" },
        { op: "replace_text", find: "dois", replace: "três" },
        { op: "replace", block: table, markdown: "| x |\n| --- |\n| 9 |" },
        { op: "delete", block: one },
        { op: "append", markdown: "## Fim" },
      ],
    });
    expect(edited.isError).toBeFalsy();
    expect(edited.content).toContain("document");
    const after = await blocksOf(a.id);
    expect(texts(after)).toEqual(["Plano", "Intro com negrito", "três", "table", "Fim"]);
    // The replaced table keeps its id; the change is the agent's.
    expect(after[3]?.id).toBe(table);

    const failed = await call(run, "edit_document", {
      file: a.id,
      ops: [
        { op: "append", markdown: "nunca" },
        { op: "delete", block: "nope" },
      ],
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("ops[1] (delete)");
    expect(texts(await blocksOf(a.id))).toEqual(["Plano", "Intro com negrito", "três", "table", "Fim"]);

    const bad = await call(run, "edit_document", { file: a.id, ops: [{ op: "replace", block: heading }] });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("needs markdown");
  });

  test("a Drive picture goes in as the document's own; Markdown rewrites keep unchanged blocks", async () => {
    const a = await makeDocument("# Relatório\n\nUm parágrafo");
    const picture = await createFileArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "chart.png",
      name: "chart.png",
      bytes: DOC_PICTURE,
      channelId: f.general.id,
    });
    const run = await runFor();
    const out = await call(run, "edit_document", {
      file: a.id,
      ops: [{ op: "append", markdown: `![Gráfico](file:${picture.id})` }],
    });
    expect(out.isError).toBeFalsy();
    const assets = await listAssets(f.artifactDeps, owner(), f.org.id, a.id);
    expect(assets).toHaveLength(1);
    const blocks = await blocksOf(a.id);
    expect(blocks[2]).toMatchObject({ type: "image", asset: assets[0]?.id, alt: "Gráfico" });

    const [heading] = blocks.map((b) => b.id);
    const rewrite = await call(run, "edit_document", {
      file: a.id,
      ops: [{ op: "rewrite", markdown: `# Relatório\n\nOutro parágrafo\n\n![Gráfico](asset:${assets[0]?.id})` }],
    });
    expect(rewrite.isError).toBeFalsy();
    const now = await blocksOf(a.id);
    expect(texts(now)).toEqual(["Relatório", "Outro parágrafo", "image"]);
    expect(now[0]?.id).toBe(heading);

    const missing = await call(run, "edit_document", {
      file: a.id,
      ops: [{ op: "append", markdown: "![x](asset:0193a7c2-1111-7000-8000-000000000009)" }],
    });
    expect(missing.isError).toBe(true);
  });

  test("a document's tools refuse another kind of live file, and the others' refuse a document", async () => {
    const a = await makeDocument();
    const run = await runFor();
    const wrong = await call(run, "read_canvas", { file: a.id });
    expect(wrong.isError).toBe(true);
    expect(wrong.content).toContain("read_document");
  });
});

describe("a document downloads", () => {
  test("as Word (its pictures in it), Markdown with its title, or PDF; at a version too", async () => {
    const a = await makeDocument("# Plano\n\n1. Primeiro\n2. Segundo\n\n> Citação\n\n[site](https://acme.example)");
    const picture = await createFileArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "chart.png",
      name: "chart.png",
      bytes: DOC_PICTURE,
      channelId: f.general.id,
    });
    const run = await runFor();
    await call(run, "edit_document", { file: a.id, ops: [{ op: "append", markdown: `![Logo](file:${picture.id})` }] });

    const word = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id);
    expect(word.filename).toMatch(/^Plano-v\d+\.docx$/);
    expect(packageProblems(word.body)).toEqual([]);
    const parts = partsOf(word.body);
    expect(parts["word/document.xml"]).toContain("Primeiro");
    expect(parts["word/document.xml"]).toContain("<w:drawing>");
    expect(parts["word/document.xml"]).toContain('w:pStyle w:val="Quote"');
    expect(parts["word/_rels/document.xml.rels"]).toContain("https://acme.example");
    expect(Object.keys(parts).some((name) => name.startsWith("word/media/image1."))).toBe(true);

    const md = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { format: "md" });
    const text = new TextDecoder().decode(md.body);
    expect(text.startsWith("# Plano\n\n# Plano\n\n1. Primeiro\n2. Segundo")).toBe(true);
    expect(md.contentType).toContain("text/markdown");

    const pdf = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { format: "pdf" });
    expect(new TextDecoder("latin1").decode(pdf.body.slice(0, 5))).toBe("%PDF-");
    await expect(artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { format: "xlsx" })).rejects.toMatchObject({
      code: "artifact.format_unavailable",
    });
    // Version 1, as it was made.
    const first = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, a.id, { version: 1, format: "md" });
    expect(new TextDecoder().decode(first.body)).not.toContain("Logo");

    const now = await exportLive({ ...f.artifactDeps, live: docs }, owner(), f.org.id, a.id, "docx");
    expect(now.filename).toBe("Plano.docx");
  });
});

describe("Word files", () => {
  test("read as blocks: headings, runs, lists by level, a table laid flat, links and pictures", () => {
    let n = 0;
    const read = docxToDocument(docxDocument(), {
      pictureId: () => `pic${++n}`,
      maxPictureBytes: 1_000_000,
      maxEachBytes: 1_000_000,
    });
    const [title, sub, body] = read.blocks;
    expect(title).toMatchObject({ type: "heading", level: 1, runs: [{ text: "Plano & metas" }] });
    expect(sub).toMatchObject({ type: "heading", level: 2 });
    expect(body?.type === "paragraph" && body.runs.find((r) => r.bold)?.text).toBe("negrito");
    expect(body?.type === "paragraph" && body.runs.find((r) => r.underline && r.italic)?.text).toBe("itálico");
    const items = read.blocks.filter((b) => b.type === "paragraph" && b.list);
    expect(items.map((b) => (b.type === "paragraph" ? [b.list, b.level ?? 0] : []))).toEqual([
      ["bullet", 0],
      ["bullet", 1],
      ["bullet", 0],
      ["ordered", 0],
      ["ordered", 0],
    ]);
    const table = read.blocks.find((b) => b.type === "table");
    expect(table?.type === "table" && table.header).toBe(true);
    expect(table?.type === "table" && table.rows.map((r) => r.length)).toEqual([3, 3, 3]);
    expect(read.blocks.at(-1)).toEqual({ type: "image", asset: "pic1", alt: "Logo da Acme" });
    expect(read.pictures).toEqual([{ id: "pic1", bytes: expect.any(Uint8Array), contentType: "image/png" }]);
    // A picture past what the document keeps stays as its words.
    const lean = docxToDocument(docxDocument(), { pictureId: () => "x", maxPictureBytes: 1_000_000, maxEachBytes: 1 });
    expect(lean.pictures).toEqual([]);
    expect(lean.blocks.at(-1)).toMatchObject({ type: "paragraph", runs: [{ text: "Logo da Acme" }] });
  });

  test("written: a valid package; lists restart, marks and colors, a picture it can't read is its words", async () => {
    const blocks: DocBlock[] = [
      { type: "paragraph", list: "ordered", runs: [{ text: "a" }] },
      { type: "paragraph", list: "ordered", level: 1, runs: [{ text: "b" }] },
      { type: "paragraph", runs: [{ text: "x", color: "#c00", underline: true, strike: true, code: true }] },
      { type: "paragraph", list: "ordered", runs: [{ text: "again" }] },
      { type: "code_block", text: "one\ntwo" },
      { type: "horizontal_rule" },
      { type: "image", asset: "gone", alt: "Sem imagem" },
      {
        type: "table",
        header: true,
        rows: [[{ blocks: [{ type: "paragraph", runs: [{ text: "H" }] }] }], [{ blocks: [] }]],
      },
    ];
    const bytes = await writeDocx(blocks, { title: "T", media: async () => null });
    expect(packageProblems(bytes)).toEqual([]);
    const parts = partsOf(bytes);
    const xml = parts["word/document.xml"] ?? "";
    expect(xml).toContain('<w:color w:val="CC0000"/>');
    expect(xml).toContain('<w:u w:val="single"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    // Two numbered lists: the second starts again at 1.
    expect(xml.match(/<w:numId w:val="2"\/>/g)).toHaveLength(2);
    expect(xml).toContain('<w:numId w:val="3"/>');
    expect(parts["word/numbering.xml"]).toContain('<w:num w:numId="3">');
    expect(xml).toContain("Sem imagem");
    expect(xml).toContain("<w:tblHeader/>");
  });
});

describe("where it came from", () => {
  test("an imported document says which upload it came from", async () => {
    const file = await createFileArtifact(f.artifactDeps, owner(), f.org.id, {
      title: "plan.docx",
      name: "plan.docx",
      bytes: docxDocument(),
      channelId: f.general.id,
    });
    const made = await openAsLive(f.artifactDeps, owner(), f.org.id, file.id);
    const read = await getArtifact(f.artifactDeps, owner(), f.org.id, made.id);
    expect(read.content.kind === "document" && read.content.preview.source).toEqual({
      name: "plan.docx",
      file: file.id,
    });
    const { doc } = await docs.read(f.org.id, made.id);
    expect(documentSource(doc)?.name).toBe("plan.docx");
    doc.destroy();
    const [row] = await f.db
      .select()
      .from(schema.liveAssets)
      .where(and(eq(schema.liveAssets.orgId, f.org.id), eq(schema.liveAssets.artifactId, made.id)));
    expect(row?.contentType).toBe("image/png");
  });
});
