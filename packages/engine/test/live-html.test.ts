import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { schema } from "@agenteschat/db";
import { readCanvasGroups, readShapes } from "@agenteschat/live/canvas";
import { readDocument } from "@agenteschat/live/document";
import { readDeck } from "@agenteschat/live/slides";
import type * as Y from "yjs";
import {
  createArtifact,
  createFileArtifact,
  createLiveFileToolSource,
  createLiveImages,
  enableSvgRasterizer,
  exportLive,
  insertMessage,
  type LiveDocs,
  type LiveImages,
  readZip,
  setSvgRasterizer,
  type ToolContext,
  type ToolOutput,
  type ToolSource,
} from "../src";
import { TextMeasurer } from "../src/fonts/library";
import { htmlToRich, layoutHtml, parseHtml, pictureInks } from "../src/live/layout/html";
import { type Fixture, setup } from "./fixtures";
import { liveDocsFor, personActor } from "./live-fixtures";

/**
 * Type and native layouts in live files (ADR 0220): `add_html` turns markup into a slide's or a canvas's own pieces
 * (shapes with their looks, texts with fonts and marks, pictures, groups), never a picture of a page; the style ops,
 * groups and the deck's fonts; and what a read says back.
 */

let f: Fixture;
let docs: LiveDocs;
let images: LiveImages;
let source: ToolSource | null = null;
const lazy: ToolSource = { name: "live-files", tools: async (ctx) => (source ? source.tools(ctx) : []) };

beforeEach(async () => {
  f = await setup({ toolSources: [lazy] });
  docs = liveDocsFor(f, "a");
  images = createLiveImages({ artifacts: f.artifactDeps, live: docs, gateway: f.gateway });
  source = createLiveFileToolSource({ artifacts: f.artifactDeps, live: docs, images });
});
afterEach(async () => {
  source = null;
  await docs.stop();
  await f.close();
});

async function runFor() {
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
  return run;
}

type Run = Awaited<ReturnType<typeof runFor>>;

const ctxOf = (run: Run): ToolContext => ({
  db: f.db,
  orgId: f.org.id,
  agentId: f.agent.id,
  runId: run.id,
  channelId: run.channelId,
  threadRootId: run.threadRootId,
  triggerMessageId: run.triggerMessageId,
});

async function call(run: Run, name: string, input: Record<string, unknown>): Promise<ToolOutput> {
  const r = await f.tools?.invoke(ctxOf(run), { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (r?.type !== "result") throw new Error(`expected a result, got ${r?.type}`);
  return r.output;
}

async function ok(run: Run, name: string, input: Record<string, unknown>) {
  const out = await call(run, name, input);
  if (out.isError) throw new Error(`${name} failed: ${out.content}`);
  return out;
}

const artifactOf = (out: ToolOutput) => out.data?.artifact as { id: string };

async function headOf<T>(fileId: string, read: (doc: Y.Doc) => T): Promise<T> {
  const { doc } = await docs.read(f.org.id, fileId);
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

const CARDS = `
<style>
  .cards { display: flex; gap: 24px; padding: 40px; font-family: Onest, sans-serif; }
  .card { flex: 1; background: #ffffff; border: 3px solid #b9d4f7; border-radius: 20px; padding: 24px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
  .label { font-family: "Martian Mono"; font-size: 16px; letter-spacing: 0.12em; text-transform: uppercase;
           color: #0063d1; margin-bottom: 8px; }
  .title { display: flex; align-items: center; gap: 12px; font-family: "Funnel Display"; font-size: 36px;
           font-weight: 300; color: #0e1a2b; }
  .badge { background: #0063d1; color: #fff; font-size: 16px; font-weight: 700; padding: 4px 10px;
           border-radius: 999px; }
  p { font-size: 24px; color: #4c5a6c; margin: 12px 0 0; }
</style>
<div class="cards" data-name="Ways to order">
  <div class="card" data-name="Delivery">
    <div class="label">Fastest</div>
    <div class="title"><svg width="32" height="32" viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" fill="#0063d1"/></svg> Delivery <span class="badge">New</span></div>
    <p>A courier brings it to your door in <b>under</b> an hour.</p>
  </div>
  <div class="card" data-name="Pickup">
    <div class="title">Pickup</div>
    <p>Ready at the counter in twenty minutes.</p>
  </div>
</div>`;

describe("add_html on a slide", () => {
  test("cards become shapes, texts with the brand's fonts, an icon and a badge, grouped by the markup", async () => {
    const run = await runFor();
    const deck = artifactOf(
      await ok(run, "create_presentation", { title: "Order guide", slides: [{ layout: "blank" }] }),
    );
    const out = await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "add_html", slide: 1, html: CARDS, box: { x: 0, y: 200, w: 1920, h: 600 } }],
    });
    expect(out.content).toContain("laid out HTML on slide 1");
    expect(out.content).not.toContain("picture of");

    await headOf(deck.id, (doc) => {
      const slide = readDeck(doc).slides[0];
      if (!slide) throw new Error("no slide");
      const shapes = slide.elements.filter((e) => e.type === "shape");
      const texts = slide.elements.filter((e) => e.type === "text");
      // Two cards and the badge (a shape holding its own label).
      expect(shapes).toHaveLength(3);
      const card = shapes.find((e) => e.style?.stroke === "#b9d4f7");
      expect(card?.style).toMatchObject({ fill: "#ffffff", strokeWidth: 3, radius: 20 });
      expect(card?.style?.shadow).toBeDefined();
      const badge = shapes.find((e) => e.style?.fill === "#0063d1");
      expect(JSON.stringify(badge?.text)).toContain("New");
      expect(badge?.style).toMatchObject({ weight: 700, color: "#ffffff", align: "center" });
      // Fonts from the catalog, by the names the CSS gave.
      const label = texts.find((e) => JSON.stringify(e.text).includes("Fastest"));
      expect(label?.style).toMatchObject({
        font: "martian-mono",
        size: 16,
        tracking: 120,
        caps: true,
        color: "#0063d1",
      });
      const title = texts.find((e) => JSON.stringify(e.text).includes("Delivery"));
      expect(title?.style).toMatchObject({ font: "funnel-display", weight: 300, size: 36 });
      // A word in bold is a mark on the run, the paragraph keeps its own look.
      const body = texts.find((e) => JSON.stringify(e.text).includes("A courier"));
      expect(body?.style).toMatchObject({ font: "onest", size: 24, color: "#4c5a6c" });
      expect(body?.text?.[0]?.runs.find((r) => r.text === "under")?.weight).toBe(700);
      // The icon is a picture of the file (the sanitized SVG), placed where the markup put it.
      const icon = slide.elements.find((e) => e.type === "image");
      expect(icon?.asset).toBeTruthy();
      expect(icon?.w).toBe(32);
      // Everything sits in the box given.
      for (const e of slide.elements) expect(e.y).toBeGreaterThanOrEqual(200);
      // The cards and the row are groups, named as the markup named them.
      const names = (slide.groups ?? []).map((g) => g.name);
      expect(names).toEqual(expect.arrayContaining(["Ways to order", "Delivery", "Pickup"]));
      const delivery = slide.groups?.find((g) => g.name === "Delivery");
      const row = slide.groups?.find((g) => g.name === "Ways to order");
      expect(delivery?.parent).toBe(row?.id);
      expect(card?.group).toBeTruthy();
    });

    const read = await ok(run, "read_presentation", { file: deck.id });
    expect(read.content).toContain('"Delivery"');
    expect(read.content).toContain("text Martian Mono");
    expect(read.content).toContain("caps");
    expect(read.content).toContain("font-weight:700");
  });

  test("style, move and fonts: a group restyled and moved as one, the deck's own fonts, text from HTML", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "title" }] }));
    await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [
        { op: "add_html", slide: 1, html: CARDS, box: { x: 0, y: 300, w: 1920, h: 500 } },
        { op: "style", slide: 1, group: "Delivery", style: { color: "#ff0000" } },
        { op: "move", slide: 1, group: "Pickup", x: 1000, y: 900 },
        { op: "set_fonts", fonts: { heading: "Funnel Display", body: "Inter" } },
        {
          op: "set_text",
          slide: 1,
          role: "title",
          html: 'Order <span style="font-weight:300;color:#0063d1">guide</span>',
        },
        {
          op: "add_shape",
          slide: 1,
          shape: "rect",
          text: "New",
          box: { x: 40, y: 40, w: 120, h: 40 },
          style: { fill: "#0063d1", radius: 20, color: "#ffffff", weight: 700, padding: 6 },
        },
      ],
    });
    await headOf(deck.id, (doc) => {
      const view = readDeck(doc);
      expect(view.fonts).toEqual({ heading: "funnel-display", body: "inter" });
      const slide = view.slides[0];
      if (!slide) throw new Error("no slide");
      const delivery = slide.groups?.find((g) => g.name === "Delivery");
      const inDelivery = slide.elements.filter((e) => e.group === delivery?.id);
      expect(inDelivery.length).toBeGreaterThan(1);
      for (const e of inDelivery) expect(e.style?.color).toBe("#ff0000");
      const pickup = slide.groups?.find((g) => g.name === "Pickup");
      const moved = slide.elements.filter((e) => e.group === pickup?.id);
      expect(Math.min(...moved.map((e) => e.x))).toBe(1000);
      expect(Math.min(...moved.map((e) => e.y))).toBe(900);
      const title = slide.elements.find((e) => e.role === "title");
      const run = title?.text?.[0]?.runs.find((r) => r.text === "guide");
      expect(run).toMatchObject({ weight: 300, color: "#0063d1" });
      const pill = slide.elements.find((e) => e.type === "shape" && e.x === 40 && e.y === 40);
      expect(JSON.stringify(pill?.text)).toContain("New");
      expect(pill?.style).toMatchObject({ fill: "#0063d1", radius: 20, color: "#ffffff", weight: 700, padding: 6 });
    });
  });

  test("a font nobody ships is named, and the text falls back to the file's", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "blank" }] }));
    const out = await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "add_html", slide: 1, html: '<p style="font-family: Helvetica Neue; font-size: 48px">Hello</p>' }],
    });
    expect(out.content).toContain("Helvetica Neue");
    const bad = await call(run, "edit_presentation", {
      file: deck.id,
      ops: [{ op: "set_fonts", fonts: { body: "Comic Sans" } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('no font "Comic Sans"');
  });
});

describe("add_html on a canvas", () => {
  test("in a frame: shapes with their looks and labels, texts, and the groups the markup makes", async () => {
    const run = await runFor();
    const board = artifactOf(await ok(run, "create_canvas", { title: "Menu" }));
    await ok(run, "edit_canvas", {
      file: board.id,
      ops: [
        { op: "add_frame", ref: "f", name: "Menu", x: 0, y: 0, w: 1600, h: 800 },
        { op: "add_html", html: CARDS, x: 40, y: 60, w: 1400, frame: "f", name: "Diagram" },
      ],
    });
    await headOf(board.id, (doc) => {
      const shapes = readShapes(doc);
      const frame = shapes.find((s) => s.type === "frame");
      const cards = shapes.filter((s) => s.type === "shape" && s.stroke === "#b9d4f7");
      expect(cards).toHaveLength(2);
      expect(cards[0]).toMatchObject({ fill: "#ffffff", strokeWidth: 3, radius: 20, parent: frame?.id });
      expect(cards[0]?.shadow).toBeDefined();
      const badge = shapes.find((s) => s.type === "shape" && s.fill === "#0063d1");
      expect(badge?.style).toMatchObject({ weight: 700, color: "#ffffff", align: "center" });
      const label = shapes.find((s) => s.type === "text" && JSON.stringify(s.text).includes("Fastest"));
      expect(label?.style).toMatchObject({ font: "martian-mono", tracking: 120, caps: true });
      expect(label?.x).toBeGreaterThanOrEqual(40);
      const groups = readCanvasGroups(doc);
      expect(groups.map((g) => g.name)).toEqual(expect.arrayContaining(["Delivery", "Pickup", "Ways to order"]));
    });

    await ok(run, "edit_canvas", {
      file: board.id,
      ops: [{ op: "move", group: "Delivery", x: 2000, y: 0 }],
    });
    await headOf(board.id, (doc) => {
      const delivery = readCanvasGroups(doc).find((g) => g.name === "Delivery");
      const inside = readShapes(doc).filter((s) => s.group === delivery?.id);
      expect(Math.min(...inside.map((s) => s.x))).toBe(2000);
    });
    const read = await ok(run, "read_canvas", { file: board.id });
    expect(read.content).toContain("Groups:");
    expect(read.content).toContain("text Martian Mono");
  });
});

describe("the layout itself", () => {
  const layout = (html: string, width = 800) => {
    const parsed = parseHtml(html);
    return layoutHtml(parsed, {
      width,
      base: { font: "source-sans-3", size: 20 },
      fontNamed: () => null,
      measurer: new TextMeasurer(),
      pictures: new Map(parsed.pictures.map((p) => [p.key, { w: 24, h: 24 }])),
      tables: true,
    });
  };

  test("a flex row shares its width; padding, gap and margins land where CSS puts them", () => {
    const r = layout(
      '<div style="display:flex;gap:20px;padding:10px"><div style="flex:1;background:#eee;height:50px"></div><div style="flex:1;background:#ddd;height:50px"></div></div>',
      420,
    );
    const boxes = r.pieces.filter((p) => p.kind === "box");
    expect(boxes.map((b) => b.box)).toEqual([
      { x: 10, y: 10, w: 190, h: 50 },
      { x: 220, y: 10, w: 190, h: 50 },
    ]);
  });

  test("a list is one text box of list paragraphs; plain paragraphs too, with their room between", () => {
    const list = layout("<ul><li>One</li><li>Two <b>bold</b></li></ul>");
    const text = list.pieces.filter((p) => p.kind === "text");
    expect(text).toHaveLength(1);
    expect(text[0]?.kind === "text" && text[0].text.map((p) => p.list)).toEqual(["bullet", "bullet"]);
    const paras = layout('<div><p style="margin:0 0 16px">A</p><p style="margin:0">B</p></div>');
    const one = paras.pieces.find((p) => p.kind === "text");
    expect(one?.kind === "text" && one.text[0]?.spaceAfter).toBe(16);
  });

  test("words wrap at the width they are given, and a long text grows its box", () => {
    const short = layout('<p style="margin:0;width:200px">one two three four five six seven eight nine ten</p>');
    const tall = short.pieces.find((p) => p.kind === "text");
    expect(tall?.box.h).toBeGreaterThan(40);
  });

  test("what isn't taken is said: scripts, floats, transforms, outside fonts", () => {
    const r = layout(
      '<script>alert(1)</script><div style="float:left;transform:rotate(3deg);font-family:Papyrus">x</div>',
    );
    expect(r.notes.join(" ")).toContain("script");
    expect(r.notes.join(" ")).toContain("float");
    expect(r.notes.join(" ")).toContain("transform");
    expect(r.notes.join(" ")).toContain("Papyrus");
  });

  test("a page as an agent writes it: custom properties on :root, a grid of columns, a cell spanning two", () => {
    const r = layout(
      `<!doctype html><html><head><style>
        :root { --accent: #0063d1; --gap: 20px; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); }
        .c { background: var(--accent); height: 40px; }
      </style></head><body style="margin:0"><div class="grid">
        <div class="c"></div><div class="c"></div><div class="c"></div><div class="c" style="grid-column: span 2"></div>
      </div></body></html>`,
      640,
    );
    const boxes = r.pieces.filter((p) => p.kind === "box" && p.fill === "#0063d1");
    expect(boxes.map((b) => b.box)).toEqual([
      { x: 0, y: 0, w: 200, h: 40 },
      { x: 220, y: 0, w: 200, h: 40 },
      { x: 440, y: 0, w: 200, h: 40 },
      { x: 0, y: 60, w: 420, h: 40 },
    ]);
  });

  test("::before and ::after content is text; an @font-face name reaches the catalog font its file is", () => {
    const r = layout(`<style>
      @font-face { font-family: "Brand Display"; src: url("fonts/FunnelDisplay-Bold.ttf") format("truetype"); }
      h1 { font-family: "Brand Display", sans-serif; margin: 0; }
      .step::before { content: "01 "; } .step::after { content: " \\2192"; }
    </style><h1>Order guide</h1><p class="step">Choose</p>`);
    // The heading and the paragraph are one text box of two paragraphs; each run carries its own font.
    const paragraphs = r.pieces.flatMap((p) => (p.kind === "text" ? p.text.map((para) => ({ para, box: p })) : []));
    const title = paragraphs.find(({ para }) => para.runs.some((x) => x.text.includes("Order guide")));
    const run = title?.para.runs.find((x) => x.text.includes("Order guide"));
    expect(run?.font ?? title?.box.style.font).toBe("funnel-display");
    const step = paragraphs.find(({ para }) => para.runs.some((x) => x.text.includes("Choose")));
    const words = step?.para.runs.map((x) => x.text).join("") ?? "";
    expect(words.replace(/\s+/g, " ").trim()).toBe("01 Choose \u2192");
  });

  test("data-arrow-to asks for an arrow between two boxes, by their pieces", () => {
    const r = layout(
      '<div style="display:flex;gap:100px"><div id="a" data-arrow-to="b" data-arrow-label="chama" style="width:100px;height:50px;background:#eee"></div><div id="b" style="width:100px;height:50px;background:#ddd"></div></div>',
    );
    expect(r.arrows).toHaveLength(1);
    const arrow = r.arrows[0];
    expect(arrow?.label).toBe("chama");
    expect(r.pieces[arrow?.from ?? -1]?.kind === "box" && r.pieces[arrow?.from ?? -1]?.box.x).toBe(0);
    expect(r.pieces[arrow?.to ?? -1]?.box.x).toBe(200);
  });

  test("an icon takes the text color around it", () => {
    const parsed = parseHtml(
      '<style>.hot { color: #d14a00 }</style><p class="hot"><img src="icon:agent"> Agente</p><p><img src="icon:search"></p>',
    );
    const inks = pictureInks(parsed, { size: 16, color: "#222222" });
    expect(inks.get("p0")).toBe("#d14a00");
    expect(inks.get("p1")).toBe("#222222");
  });

  test("htmlToRich keeps a paragraph per block and the inline looks as marks", () => {
    const rich = htmlToRich(parseHtml("<p>A <i>b</i></p><ul><li>c</li></ul>"), { size: 20 });
    expect(rich.map((p) => p.list ?? null)).toEqual([null, "bullet"]);
    expect(rich[0]?.runs.find((r) => r.text === "b")?.italic).toBe(true);
  });

  test("markup too big is refused before anything is parsed", () => {
    expect(() => parseHtml(`<p>${"x".repeat(210_000)}</p>`)).toThrow("split it");
  });
});

/** A real TrueType font the repository ships (Onest, SIL Open Font License), as a workspace would upload one. */
const ONEST = new Uint8Array(readFileSync(new URL("../assets/fonts/Onest-Regular.ttf", import.meta.url)));

describe("a workspace's own fonts", () => {
  test("a font uploaded to the Drive is checked; add_font brings it into a file, where its family names it", async () => {
    const run = await runFor();
    const bad = createFileArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Broken",
      name: "broken.ttf",
      bytes: new Uint8Array([0, 1, 0, 0, 0, 9, 0, 0, 1, 2, 3, 4, 5, 6]),
      channelId: f.general.id,
    });
    await expect(bad).rejects.toMatchObject({ code: "live.font_invalid" });
    const font = await createFileArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Brand",
      name: "Brand-Regular.ttf",
      bytes: ONEST,
      channelId: f.general.id,
    });
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "blank" }] }));
    const out = await ok(run, "edit_presentation", {
      file: deck.id,
      ops: [
        { op: "add_font", font_file: font.id },
        { op: "add_text", slide: 1, text: "Hello", style: { font: "Onest", size: 60 } },
        {
          op: "add_html",
          slide: 1,
          html: '<p style="font-family: Onest; margin: 0">From HTML</p>',
          box: { x: 0, y: 600, w: 1920, h: 200 },
        },
      ],
    });
    expect(out.content).toContain('brought the font "Onest"');
    await headOf(deck.id, (doc) => {
      const els = readDeck(doc).slides[0]?.elements ?? [];
      const typed = els.find((e) => JSON.stringify(e.text).includes("Hello"));
      // The file's own font wins over the catalog's of the same name: it is what the file carries.
      expect(typed?.style?.font).toMatch(/^asset:/);
      const html = els.find((e) => JSON.stringify(e.text).includes("From HTML"));
      expect(html?.style?.font).toBe(typed?.style?.font);
    });
    const read = await ok(run, "read_presentation", { file: deck.id });
    expect(read.content).toContain('its own fonts "Onest"');
  });
});

describe("documents take HTML", () => {
  test("headings, paragraphs with marks, lists and a table become blocks", async () => {
    const run = await runFor();
    const a = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Plano",
      content: { kind: "document", markdown: "# Plano" },
      channelId: f.general.id,
    });
    await ok(run, "edit_document", {
      file: a.id,
      ops: [
        {
          op: "append",
          html: '<h2 style="font-family: Fraunces; color: #0063d1">Pantry</h2><p>A <span style="font-weight:600;letter-spacing:0.1em;text-transform:uppercase">baker</span> knows.</p><ul><li>Flour</li><li>Water</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
        },
      ],
    });
    await headOf(a.id, (doc) => {
      const blocks = readDocument(doc);
      const heading = blocks.find((b) => b.type === "heading" && JSON.stringify(b).includes("Pantry"));
      expect(heading?.type === "heading" && heading.runs[0]).toMatchObject({ font: "fraunces", color: "#0063d1" });
      const para = blocks.find((b) => b.type === "paragraph" && JSON.stringify(b).includes("baker"));
      const word = para?.type === "paragraph" ? para.runs.find((r) => r.text === "baker") : undefined;
      expect(word).toMatchObject({ weight: 600, tracking: 100, caps: true });
      expect(blocks.filter((b) => b.type === "paragraph" && b.list === "bullet")).toHaveLength(2);
      const table = blocks.find((b) => b.type === "table");
      expect(table?.type === "table" && table.header).toBe(true);
    });
  });
});

describe("the agent sees its edit", () => {
  test("with the server's rasterizer, a slide edit comes back with a picture of the slide", async () => {
    expect(await enableSvgRasterizer()).toBe(true);
    try {
      const run = await runFor();
      const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "blank" }] }));
      const out = await ok(run, "edit_presentation", {
        file: deck.id,
        ops: [{ op: "add_html", slide: 1, html: CARDS }],
      });
      expect(out.content).toContain("A picture of the slide");
      expect(out.images?.[0]?.mediaType).toBe("image/png");
      const canvas = artifactOf(await ok(run, "create_canvas", { title: "Board" }));
      const drawn = await ok(run, "edit_canvas", { file: canvas.id, ops: [{ op: "add_html", html: CARDS }] });
      expect(drawn.images?.[0]?.mediaType).toBe("image/png");
    } finally {
      setSvgRasterizer(null);
    }
  });
});

describe("exports keep the type", () => {
  test("PowerPoint names the faces and keeps spacing, capitals and the shapes' looks; Word keeps the marks", async () => {
    const run = await runFor();
    const deck = artifactOf(await ok(run, "create_presentation", { title: "Deck", slides: [{ layout: "blank" }] }));
    await ok(run, "edit_presentation", { file: deck.id, ops: [{ op: "add_html", slide: 1, html: CARDS }] });
    const pptx = await exportLive(
      { ...f.artifactDeps, live: docs },
      personActor(f.owner.id),
      f.org.id,
      deck.id,
      "pptx",
    );
    const slide = readZip(pptx.body, { maxFiles: 200, maxBytes: 50_000_000 }).find(
      (e) => e.path === "ppt/slides/slide1.xml",
    );
    const xml = new TextDecoder().decode(slide?.data);
    expect(xml).toContain('typeface="Martian Mono"');
    expect(xml).toContain('typeface="Funnel Display"');
    expect(xml).toContain('cap="all"');
    expect(xml).toMatch(/spc="\d+"/);
    expect(xml).toContain("<a:outerShdw");

    const doc = await createArtifact(f.artifactDeps, personActor(f.owner.id), f.org.id, {
      title: "Plano",
      content: { kind: "document", markdown: "# Plano" },
      channelId: f.general.id,
    });
    await ok(run, "edit_document", {
      file: doc.id,
      ops: [
        {
          op: "append",
          html: '<p><span style="font-family: Inter; font-weight: 700; font-size: 24px">Label</span></p>',
        },
      ],
    });
    const docx = await exportLive({ ...f.artifactDeps, live: docs }, personActor(f.owner.id), f.org.id, doc.id, "docx");
    const body = readZip(docx.body, { maxFiles: 50, maxBytes: 50_000_000 }).find((e) => e.path === "word/document.xml");
    const word = new TextDecoder().decode(body?.data);
    expect(word).toContain('w:ascii="Inter"');
    expect(word).toContain('<w:sz w:val="36"/>');
  });
});
