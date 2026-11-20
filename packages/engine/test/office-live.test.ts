import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  documentSource,
  readDeck,
  readDocument,
  SheetEngine,
  SYSTEM,
  setValues,
  sheetIds,
  sheetLocale,
  type WorkbookData,
} from "@agenteschat/live";
import {
  addFileVersion,
  artifactFile,
  createChannel,
  createFileArtifact,
  exportLive,
  getArtifact,
  type LiveDocs,
  listArtifactVersions,
  listAssets,
  loadHeadDoc,
  NotFoundError,
  officeLiveExporter,
  officePreview,
  openAsLive,
  readPptx,
  readXlsx,
  setLiveExporter,
  writeXlsx,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { liveDocsFor, makeLiveFile, personActor } from "./live-fixtures";
import { DECK_PICTURE, docxDocument, packageProblems, pptxDeck } from "./office-fixtures";

let f: Fixture;
let docs: LiveDocs;
beforeEach(async () => {
  f = await setup();
  docs = liveDocsFor(f, "a");
});
afterEach(async () => {
  await docs.stop();
  await f.close();
});
afterAll(() => setLiveExporter(null));

const owner = () => personActor(f.owner.id);
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const COSTS: WorkbookData = {
  sheets: [
    {
      name: "Costs",
      rows: 3,
      cols: 3,
      cells: [
        { r: 0, c: 0, v: "Item", s: { b: 1 } },
        { r: 0, c: 1, v: "Price", s: { b: 1 } },
        { r: 1, c: 0, v: "Coffee" },
        { r: 1, c: 1, v: 12.5, s: { nf: "0.00" } },
        { r: 2, c: 0, v: "Twice" },
        { r: 2, c: 1, f: "B2*2", v: 25 },
      ],
      colWidths: { 0: 180 },
      frozen: { rows: 1, cols: 0 },
    },
  ],
};

const upload = (name: string, bytes: Uint8Array, channelId: string | null = f.general.id, contentType?: string) =>
  createFileArtifact(f.artifactDeps, owner(), f.org.id, { title: name, name, bytes, contentType, channelId });

describe("previewing an uploaded Office file", () => {
  test("a workbook as the apps draw it, read once per version, each version its own", async () => {
    const file = await upload("costs.xlsx", writeXlsx(COSTS), f.general.id, XLSX_TYPE);
    const preview = await officePreview(f.artifactDeps, owner(), f.org.id, file.id);
    expect(preview.kind).toBe("workbook");
    const sheet = preview.kind === "workbook" ? preview.workbook.sheets[0] : undefined;
    expect(sheet?.name).toBe("Costs");
    expect(sheet?.cells.find((c) => c.r === 2 && c.c === 1)).toMatchObject({ f: "B2*2", v: 25 });
    expect(sheet?.frozen).toEqual({ rows: 1, cols: 0 });
    // Read once: the same answer while it is kept.
    expect(await officePreview(f.artifactDeps, owner(), f.org.id, file.id)).toBe(preview);
    const next: WorkbookData = { sheets: [{ name: "Costs", rows: 1, cols: 1, cells: [{ r: 0, c: 0, v: "v2" }] }] };
    await addFileVersion(f.artifactDeps, owner(), f.org.id, file.id, { name: "costs.xlsx", bytes: writeXlsx(next) });
    const latest = await officePreview(f.artifactDeps, owner(), f.org.id, file.id);
    expect(latest.kind === "workbook" && latest.workbook.sheets[0]?.cells[0]?.v).toBe("v2");
    expect(await officePreview(f.artifactDeps, owner(), f.org.id, file.id, 1)).toBe(preview);
  });

  test("a deck with its pictures' bytes, a Word document as HTML; others are refused by what they are", async () => {
    const deck = await upload("review.pptx", pptxDeck());
    const preview = await officePreview(f.artifactDeps, owner(), f.org.id, deck.id);
    expect(preview.kind).toBe("deck");
    const media = preview.kind === "deck" ? Object.values(preview.deck.media) : [];
    expect(media).toHaveLength(1);
    expect(media[0]?.bytes).toEqual(DECK_PICTURE);
    const doc = await upload("plan.docx", docxDocument());
    const html = await officePreview(f.artifactDeps, owner(), f.org.id, doc.id);
    expect(html.kind === "document" && html.html.startsWith("<h1>Plano &amp; metas</h1>")).toBe(true);
    const text = await upload("notes.txt", new TextEncoder().encode("hello"));
    await expect(officePreview(f.artifactDeps, owner(), f.org.id, text.id)).rejects.toMatchObject({
      code: "office.unsupported",
    });
    const broken = await upload("broken.xlsx", new TextEncoder().encode("not a workbook"));
    await expect(officePreview(f.artifactDeps, owner(), f.org.id, broken.id)).rejects.toMatchObject({
      code: "office.unreadable",
    });
  });

  test("only for who reads the file", async () => {
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const file = await upload("costs.xlsx", writeXlsx(COSTS), eng.id);
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await expect(officePreview(f.artifactDeps, personActor(ana.id), f.org.id, file.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(openAsLive(f.artifactDeps, personActor(ana.id), f.org.id, file.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("opening an Office file as a live file", () => {
  test("a workbook becomes a spreadsheet beside it, its formulas live, a note saying where it came from", async () => {
    const file = await upload("costs.xlsx", writeXlsx(COSTS));
    const made = await openAsLive(f.artifactDeps, owner(), f.org.id, file.id);
    expect(made).toMatchObject({ kind: "spreadsheet", title: "costs", channelId: f.general.id, version: 1 });
    const versions = await listArtifactVersions(f.artifactDeps, owner(), f.org.id, made.id);
    expect(versions[0]?.note).toMatch(/^(Made from|Feito a partir de) costs\.xlsx$/);
    const head = await loadHeadDoc(f.db, f.org.id, made.id);
    const doc = head?.doc;
    if (!doc) throw new Error("no live document");
    const engine = new SheetEngine(doc);
    const sheet = sheetIds(doc)[0] as string;
    expect(engine.valueAt(sheet, 2, 1)).toBe(25);
    engine.destroy();
    doc.destroy();
    // The upload stays as it was.
    expect((await getArtifact(f.artifactDeps, owner(), f.org.id, file.id)).kind).toBe("file");
  });

  test("a deck becomes a presentation with its pictures stored in it from its first version", async () => {
    const file = await upload("review.pptx", pptxDeck());
    const made = await openAsLive(f.artifactDeps, owner(), f.org.id, file.id);
    expect(made).toMatchObject({ kind: "slides", title: "review", version: 1 });
    const assets = await listAssets(f.artifactDeps, owner(), f.org.id, made.id);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ contentType: "image/png", width: 40, height: 30 });
    const head = await loadHeadDoc(f.db, f.org.id, made.id);
    const deck = head ? readDeck(head.doc) : null;
    head?.doc.destroy();
    expect(deck?.slides).toHaveLength(2);
    const image = deck?.slides[0]?.elements.find((e) => e.type === "image");
    expect(image?.asset).toBe(assets[0]?.id);
    expect(deck?.slides[1]?.hidden).toBe(true);
    expect(deck?.slides[0]?.notes).toBe("Mention the Acme deal.\nThank Ada.");
  });

  test("a Word document becomes a live document with its pictures; a workbook too large is refused", async () => {
    const file = await upload("plan.docx", docxDocument(), null);
    const made = await openAsLive(f.artifactDeps, owner(), f.org.id, file.id);
    expect(made).toMatchObject({ kind: "document", title: "plan", channelId: null });
    const detail = await getArtifact(f.artifactDeps, owner(), f.org.id, made.id);
    expect(detail.content.kind === "document" && detail.content.markdown.startsWith("# Plano & metas")).toBe(true);
    // Its PNG is the document's own picture (the SVG is left out, ADR 0198), and it says where it came from.
    const assets = await listAssets(f.artifactDeps, owner(), f.org.id, made.id);
    expect(assets).toHaveLength(1);
    const head = await loadHeadDoc(f.db, f.org.id, made.id);
    if (!head) throw new Error("no live document");
    const blocks = readDocument(head.doc);
    expect(blocks.filter((b) => b.type === "image").map((b) => (b.type === "image" ? b.asset : ""))).toEqual([
      assets[0]?.id as string,
    ]);
    expect(documentSource(head.doc)).toEqual({ name: "plan.docx", file: file.id });
    head.doc.destroy();
    const tall: WorkbookData = { sheets: [{ name: "A", rows: 1, cols: 1, cells: [{ r: 20_000, c: 0, v: "far" }] }] };
    const big = await upload("tall.xlsx", writeXlsx(tall));
    await expect(openAsLive(f.artifactDeps, owner(), f.org.id, big.id)).rejects.toMatchObject({
      code: "office.too_large_to_edit",
    });
  });
});

describe("exporting a live file", () => {
  test("a spreadsheet as xlsx (formulas and values) or csv, as it stands now", async () => {
    const sheet = await makeLiveFile(f, "spreadsheet", { title: "Budget 2026" });
    await docs.edit(f.org.id, sheet.id, SYSTEM, (doc) => {
      const id = sheetIds(doc)[0] as string;
      setValues(
        doc,
        { sheet: id, row: 0, col: 0 },
        [
          ["Item", "Price"],
          ["Café", 12.5],
          ["Twice", "=B2*2"],
        ],
        sheetLocale("en-US"),
        SYSTEM,
      );
    });
    const xlsx = await exportLive(f.artifactDeps, owner(), f.org.id, sheet.id, "xlsx");
    expect(xlsx.filename).toBe("Budget-2026.xlsx");
    expect(xlsx.contentType).toBe(XLSX_TYPE);
    const back = readXlsx(xlsx.body).sheets[0];
    expect(back?.cells.find((c) => c.r === 2 && c.c === 1)).toMatchObject({ f: "B2*2", v: 25 });
    const csv = await exportLive(f.artifactDeps, owner(), f.org.id, sheet.id, "csv");
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(csv.body)).toBe(
      "\ufeffItem,Price\r\nCafé,12.5\r\nTwice,25\r\n",
    );
    await expect(exportLive(f.artifactDeps, owner(), f.org.id, sheet.id, "pptx")).rejects.toMatchObject({
      code: "artifact.format_unavailable",
    });
  });

  test("a presentation as pptx with its pictures, or pdf; only for who reads it", async () => {
    const file = await upload("review.pptx", pptxDeck());
    const slides = await openAsLive(f.artifactDeps, owner(), f.org.id, file.id);
    const pptx = await exportLive(f.artifactDeps, owner(), f.org.id, slides.id, "pptx");
    expect(packageProblems(pptx.body)).toEqual([]);
    const back = readPptx(pptx.body);
    expect(Object.values(back.media)[0]?.bytes).toEqual(DECK_PICTURE);
    const pdf = await exportLive(f.artifactDeps, owner(), f.org.id, slides.id, "pdf");
    expect(pdf.filename).toBe("review.pdf");
    expect(
      Buffer.from(pdf.body)
        .toString("latin1")
        .match(/\/Type \/Page /g)?.length,
    ).toBe(1);
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const eng = await createChannel(f.db, f.owner.id, f.org.id, { name: "eng", visibility: "private" });
    const hidden = await makeLiveFile(f, "slides", { channelId: eng.id });
    await expect(exportLive(f.artifactDeps, personActor(ana.id), f.org.id, hidden.id, "pdf")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("the Drive's downloads use it for versions too, a canvas as its JSON", async () => {
    setLiveExporter(officeLiveExporter);
    const sheet = await makeLiveFile(f, "spreadsheet", { title: "Budget" });
    const v1 = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, sheet.id, { version: 1 });
    expect(v1.filename).toBe("Budget-v1.xlsx");
    expect(readXlsx(v1.body).sheets).toHaveLength(1);
    const csv = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, sheet.id, { version: 1, format: "csv" });
    expect(csv.contentType).toContain("text/csv");
    const canvas = await makeLiveFile(f, "canvas", { title: "Ideas" });
    const json = await artifactFile(f.artifactDeps, f.owner.id, f.org.id, canvas.id, {});
    expect(json.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(json.body))).toEqual({ kind: "canvas", v: 1, bg: "dots", shapes: [] });
    await expect(
      artifactFile(f.artifactDeps, f.owner.id, f.org.id, canvas.id, { format: "pdf" }),
    ).rejects.toMatchObject({ code: "artifact.format_unavailable" });
  });
});
