import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import * as live from "../src";
import { LiveEditError } from "../src/errors";
import {
  docSeed,
  initLiveDoc,
  LIVE_DOC_VERSION,
  liveKindOf,
  livePreview,
  liveText,
  replaceLiveContent,
  validateLive,
} from "../src/kinds";
import { LOCAL, SYSTEM } from "../src/origins";

function make(kind: live.LiveKind, opts: { sheetName?: string; seed?: string } = {}): Y.Doc {
  const doc = new Y.Doc();
  initLiveDoc(doc, kind, opts);
  return doc;
}

describe("a new live document", () => {
  test("says its kind, its shape version and a seed", () => {
    for (const kind of live.LIVE_KINDS) {
      const doc = make(kind);
      expect(liveKindOf(doc)).toBe(kind);
      expect(doc.getMap("meta").get("v")).toBe(LIVE_DOC_VERSION);
      expect(docSeed(doc)).toMatch(/^[0-9a-f]{16}$/);
      expect(validateLive(doc)).toEqual([]);
    }
    expect(docSeed(make("canvas", { seed: "fixed" }))).toBe("fixed");
    expect(make("slides").getMap("meta").get("seed")).not.toBe(make("slides").getMap("meta").get("seed"));
    expect(liveKindOf(new Y.Doc())).toBeNull();
    expect(docSeed(new Y.Doc())).toBe("");
  });

  test("the default content of each kind", () => {
    const sheet = make("spreadsheet", { sheetName: "Planilha 1" });
    const sheets = live.sheetIds(sheet);
    expect(sheets).toHaveLength(1);
    expect(live.sheetName(sheet, sheets[0] as string)).toBe("Planilha 1");
    expect(live.sheetSize(sheet, sheets[0] as string)).toEqual({ rows: 100, cols: 26 });
    const deck = live.readDeck(make("slides"));
    expect(deck.theme).toBe("sky");
    expect(deck.slides.map((slide) => slide.layout)).toEqual(["title"]);
    expect(live.canvasPreview(make("canvas"))).toMatchObject({ bg: "dots", count: 0 });
  });

  test("one transaction, by the system unless told otherwise; never twice", () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    initLiveDoc(doc, "slides");
    expect(origins).toEqual([SYSTEM]);
    expect(() => initLiveDoc(doc, "slides")).toThrow(LiveEditError);
    const mine = new Y.Doc();
    const seen: unknown[] = [];
    mine.on("afterTransaction", (tr: Y.Transaction) => seen.push(tr.origin));
    initLiveDoc(mine, "canvas", { origin: LOCAL });
    expect(seen).toEqual([LOCAL]);
    expect(() => initLiveDoc(new Y.Doc(), "board" as never)).toThrow(LiveEditError);
  });
});

describe("previews, text and rules of shape for every kind", () => {
  test("a spreadsheet, shown in the reader's locale", () => {
    const doc = make("spreadsheet");
    const sheet = live.sheetIds(doc)[0] as string;
    const pt = live.sheetLocale("pt-BR");
    live.setInput(doc, { sheet, row: 0, col: 0 }, "Total", pt, LOCAL);
    live.setInput(doc, { sheet, row: 0, col: 1 }, "1234,5", pt, LOCAL);
    live.setInput(doc, { sheet, row: 1, col: 1 }, "=B1*2", pt, LOCAL);
    const preview = livePreview(doc) as live.SheetPreview;
    expect(preview.rows[0]?.[0]).toBe("Total");
    expect(preview.rows[1]?.[1]).toBe("2469");
    const inPortuguese = livePreview(doc, { locale: "pt-BR" }) as live.SheetPreview;
    expect(inPortuguese.rows[0]?.[1]).toBe("1234,5");
    const engine = new live.SheetEngine(doc);
    expect((livePreview(doc, { engine }) as live.SheetPreview).rows[1]?.[1]).toBe("2469");
    engine.destroy();
    expect(liveText(doc)).toContain("Total");
    expect(validateLive(doc)).toEqual([]);
  });

  test("a presentation and a canvas", () => {
    const deck = make("slides");
    live.addSlide(deck, { title: "Roadmap", body: "Ship it" }, LOCAL);
    expect((livePreview(deck) as live.SlidesPreview).count).toBe(2);
    expect(liveText(deck)).toContain("Roadmap\nShip it");
    const board = make("canvas");
    live.addShape(board, { type: "note", text: "Idea", x: 0, y: 0 }, LOCAL);
    expect((livePreview(board) as live.CanvasPreview).count).toBe(1);
    expect(liveText(board)).toBe("Idea");
  });

  test("a document", () => {
    const doc = make("document");
    expect(live.readDocument(doc)).toHaveLength(1);
    live.writeDocument(doc, live.markdownToBlocks("# Plan\n\nShip it"), LOCAL);
    const preview = livePreview(doc) as live.DocumentPreview;
    expect(preview.count).toBe(2);
    expect(preview.blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(liveText(doc)).toBe("Plan\nShip it");
    expect(validateLive(doc)).toEqual([]);
  });

  test("a document of no known kind", () => {
    const doc = new Y.Doc();
    expect(() => livePreview(doc)).toThrow(LiveEditError);
    expect(() => liveText(doc)).toThrow(LiveEditError);
    expect(validateLive(doc)).toEqual(["The document has no live file kind"]);
    const slides = make("slides");
    slides.getMap("meta").delete("v");
    expect(validateLive(slides)).toEqual(["The document has no shape version"]);
    // A caller that knows the kind can still read it.
    expect((livePreview(new Y.Doc(), { kind: "canvas" }) as live.CanvasPreview).count).toBe(0);
  });
});

describe("restoring a version, whatever the kind", () => {
  test.each(["spreadsheet", "slides", "canvas", "document"] as const)("%s", (kind) => {
    const doc = make(kind);
    const snapshot = Y.encodeStateAsUpdate(doc);
    if (kind === "spreadsheet") {
      const sheet = live.sheetIds(doc)[0] as string;
      live.setInput(doc, { sheet, row: 2, col: 2 }, "changed", live.sheetLocale("en-US"), LOCAL);
    } else if (kind === "slides") {
      live.addSlide(doc, { title: "extra" }, LOCAL);
    } else if (kind === "document") {
      live.insertBlocks(doc, [{ type: "paragraph", runs: [{ text: "extra" }] }], {}, LOCAL);
    } else {
      live.addShape(doc, { type: "note", text: "extra", x: 0, y: 0 }, LOCAL);
    }
    const old = new Y.Doc();
    Y.applyUpdate(old, snapshot);
    expect(liveText(doc)).not.toBe(liveText(old));
    replaceLiveContent(doc, old, SYSTEM);
    expect(liveText(doc)).toBe(liveText(old));
    expect(validateLive(doc)).toEqual([]);
  });

  test("kinds must match", () => {
    expect(() => replaceLiveContent(make("slides"), make("canvas"), SYSTEM)).toThrow(LiveEditError);
    expect(() => replaceLiveContent(make("slides"), new Y.Doc(), SYSTEM)).toThrow(LiveEditError);
    const blank = new Y.Doc();
    replaceLiveContent(blank, make("canvas", { seed: "s1" }), SYSTEM);
    expect(liveKindOf(blank)).toBe("canvas");
    expect(docSeed(blank)).toBe("s1");
  });
});

describe("the package's entry", () => {
  test("exports every part, with one arrange per kind", () => {
    for (const name of [
      "initLiveDoc",
      "readMessage",
      "sanitizePeerState",
      "peerColor",
      "toBase64",
      "keyBetween",
      "newId",
      "writeRich",
      "addSlide",
      "placeBoxes",
      "SheetEngine",
      "overwriteMap",
      "arrangeShapes",
      "arrangeElements",
      "markdownToBlocks",
      "readDocument",
    ]) {
      expect(typeof (live as Record<string, unknown>)[name]).toBe("function");
    }
    expect(live.arrange).toBe(live.arrangeElements);
    expect(live.LIVE_LIMITS.canvas.shapes).toBe(5000);
  });
});
