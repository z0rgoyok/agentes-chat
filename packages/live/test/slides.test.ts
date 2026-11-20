import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { rectsIntersect } from "../src/canvas/geometry";
import { contrastRatio, relativeLuminance } from "../src/colors";
import { LiveEditError } from "../src/errors";
import { agentOrigin, LOCAL, SYSTEM } from "../src/origins";
import { richText } from "../src/rich/text";
import {
  addElement,
  addSlide,
  arrange,
  type DeckData,
  deleteElements,
  deleteSlides,
  duplicateSlide,
  elementTextFragment,
  initSlides,
  LAYOUTS,
  moveSlide,
  readDeck,
  readSlide,
  replaceSlides,
  SLIDE_H,
  SLIDE_LAYOUTS,
  SLIDE_W,
  setBackground,
  setHidden,
  setLayout,
  setNotes,
  setTheme,
  slideByNumber,
  slideIdsOf,
  slideNotes,
  slidesFromData,
  slidesPreview,
  slidesText,
  slidesToData,
  THEMES,
  textLook,
  themeOf,
  updateElement,
  validateSlides,
} from "../src/slides";
import { deckMapOf, slideMapOf, slideOrderOf, slidesMapOf } from "../src/slides/store";

function deck(): Y.Doc {
  const doc = new Y.Doc();
  initSlides(doc, SYSTEM);
  return doc;
}

function texts(doc: Y.Doc, slideId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of readSlide(doc, slideId)?.elements ?? []) {
    if (el.role && el.text) out[el.role] = richText(el.text);
  }
  return out;
}

function expectRefused(doc: Y.Doc, code: LiveEditError["code"], edit: () => void): void {
  const before = Y.encodeStateVector(doc);
  let error: unknown;
  try {
    edit();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(LiveEditError);
  expect((error as LiveEditError).code).toBe(code);
  expect(Y.encodeStateVector(doc)).toEqual(before);
}

describe("themes", () => {
  test("six themes, the app's fonts only, every text color at 4.5:1 on the background and the surface", () => {
    expect(Object.keys(THEMES).sort()).toEqual(["contrast", "forest", "graphite", "night", "paper", "sky"]);
    for (const theme of Object.values(THEMES)) {
      expect(["Funnel Display", "Source Sans 3"]).toContain(theme.fonts.heading);
      expect(theme.fonts.body).toBe("Source Sans 3");
      const { bg, surface, text, muted, accent, accent2 } = theme.colors;
      for (const ink of [text, muted, accent, accent2]) {
        expect(contrastRatio(ink, bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect((relativeLuminance(bg) ?? 0) < 0.2).toBe(theme.dark);
    }
    expect(themeOf("nope").id).toBe("sky");
    expect(themeOf("forest").id).toBe("forest");
  });

  test("a text's look: its role in the theme, under the element's own style", () => {
    const sky = THEMES.sky;
    const title = textLook(sky, { type: "text", role: "title" });
    expect(title).toMatchObject({ fontFamily: "Funnel Display", size: 72, weight: 600, color: sky.colors.text });
    expect(textLook(sky, { type: "text", role: "subtitle" }).color).toBe(sky.colors.muted);
    expect(textLook(sky, { type: "text", role: "number" })).toMatchObject({ size: 240, color: sky.colors.accent });
    expect(textLook(THEMES.contrast, { type: "text", role: "title" }).fontFamily).toBe("Source Sans 3");
    expect(textLook(sky, { type: "text", role: "title", style: { size: 112, color: "#123456" } })).toMatchObject({
      size: 112,
      color: "#123456",
    });
    const label = textLook(sky, { type: "shape" });
    expect(label).toMatchObject({ align: "center", valign: "middle" });
    expect(contrastRatio(label.color, sky.colors.accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("layouts", () => {
  test("every slot on the slide, text never closer than 80 to an edge, no two slots overlapping", () => {
    expect(Object.keys(LAYOUTS).sort()).toEqual([...SLIDE_LAYOUTS].sort());
    for (const layout of SLIDE_LAYOUTS) {
      const slots = LAYOUTS[layout];
      for (const slot of slots) {
        expect(slot.box.x).toBeGreaterThanOrEqual(0);
        expect(slot.box.y).toBeGreaterThanOrEqual(0);
        expect(slot.box.x + slot.box.w).toBeLessThanOrEqual(SLIDE_W);
        expect(slot.box.y + slot.box.h).toBeLessThanOrEqual(SLIDE_H);
        if (slot.type === "text") {
          expect(slot.box.x).toBeGreaterThanOrEqual(80);
          expect(slot.box.y).toBeGreaterThanOrEqual(80);
          expect(SLIDE_W - (slot.box.x + slot.box.w)).toBeGreaterThanOrEqual(80);
          expect(SLIDE_H - (slot.box.y + slot.box.h)).toBeGreaterThanOrEqual(80);
        }
      }
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          expect(
            rectsIntersect((slots[i] as (typeof slots)[number]).box, (slots[j] as (typeof slots)[number]).box),
          ).toBe(false);
        }
      }
    }
  });
});

describe("a new deck and its slides", () => {
  test("the default theme and one empty title slide", () => {
    const doc = deck();
    const view = readDeck(doc);
    expect(view.theme).toBe("sky");
    expect(view.w).toBe(1920);
    expect(view.h).toBe(1080);
    expect(view.slides).toHaveLength(1);
    expect(view.slides[0]?.layout).toBe("title");
    expect(view.slides[0]?.elements.map((el) => el.role)).toEqual(["title", "subtitle"]);
    initSlides(doc, SYSTEM);
    expect(readDeck(doc).slides).toHaveLength(1);
  });

  test("title and body fill the layout's slots, as light Markdown", () => {
    const doc = deck();
    const id = addSlide(doc, { title: "Q3 **plan**", body: "- grow\n- hire", notes: "Say hi" }, LOCAL);
    const slide = readSlide(doc, id);
    expect(slide?.layout).toBe("title-body");
    expect(slide?.index).toBe(1);
    expect(slide?.notes).toBe("Say hi");
    const title = slide?.elements.find((el) => el.role === "title");
    expect(title?.text).toEqual([{ runs: [{ text: "Q3 " }, { text: "plan", bold: true }] }]);
    expect(slide?.elements.find((el) => el.role === "body")?.text?.map((p) => p.list)).toEqual(["bullet", "bullet"]);
    const big = addSlide(doc, { layout: "big-number", title: "87%", body: "of people agree", at: 0 }, LOCAL);
    expect(slideIdsOf(doc)[0]).toBe(big);
    expect(texts(doc, big)).toEqual({ number: "87%", caption: "of people agree" });
    const quote = addSlide(doc, { layout: "quote", title: "Less, but better", body: "A designer" }, LOCAL);
    expect(texts(doc, quote)).toEqual({ quote: "Less, but better", caption: "A designer" });
  });

  test("pictures go in the image slot, or take the right column", () => {
    const doc = deck();
    const withSlot = addSlide(doc, { title: "Look", image: { asset: "asset-1" } }, LOCAL);
    const slide = readSlide(doc, withSlot);
    expect(slide?.layout).toBe("image-right");
    expect(slide?.elements.find((el) => el.type === "image")).toMatchObject({
      asset: "asset-1",
      fit: "cover",
      x: 1008,
    });
    const noSlot = addSlide(doc, { layout: "title-body", body: "Text", image: { asset: "asset-2" } }, LOCAL);
    const els = readSlide(doc, noSlot)?.elements ?? [];
    const image = els.find((el) => el.type === "image");
    const body = els.find((el) => el.role === "body");
    expect(image).toMatchObject({ asset: "asset-2", fit: "contain" });
    expect(body && image && rectsIntersect(body, image)).toBe(false);
    const blank = addSlide(doc, { layout: "blank", title: "Still here", body: "Me too" }, LOCAL);
    expect(texts(doc, blank)).toEqual({ title: "Still here", body: "Me too" });
  });

  test("refused edits change nothing", () => {
    const doc = deck();
    expectRefused(doc, "invalid", () => addSlide(doc, { layout: "weird" as never }, LOCAL));
    expectRefused(doc, "invalid", () => addSlide(doc, { image: { asset: "bad id!" } }, LOCAL));
    expectRefused(doc, "too_large", () => addSlide(doc, { body: "x".repeat(20_001) }, LOCAL));
    expectRefused(doc, "not_found", () => duplicateSlide(doc, "missing", LOCAL));
    expectRefused(doc, "invalid", () => setTheme(doc, "neon" as never, LOCAL));
    const id = slideIdsOf(doc)[0] as string;
    expectRefused(doc, "invalid", () => setBackground(doc, id, "red", LOCAL));
    expectRefused(doc, "invalid", () => addElement(doc, id, { type: "chart", chart: { type: "bar" } as never }, LOCAL));
    expectRefused(doc, "invalid", () => addElement(doc, id, { type: "text", box: { x: 0, y: 0, w: -1, h: 5 } }, LOCAL));
  });

  test("limits: 300 slides, 200 elements a slide", () => {
    const doc = deck();
    doc.transact(() => {
      for (let i = 1; i < 300; i++) addSlide(doc, { layout: "blank" }, LOCAL);
    });
    expect(slideIdsOf(doc)).toHaveLength(300);
    expectRefused(doc, "too_many", () => addSlide(doc, {}, LOCAL));
    const id = slideIdsOf(doc)[1] as string;
    doc.transact(() => {
      for (let i = 0; i < 200; i++) addElement(doc, id, { type: "shape" }, LOCAL);
    });
    expectRefused(doc, "too_many", () => addElement(doc, id, { type: "text", text: "one more" }, LOCAL));
  });
});

describe("slide order", () => {
  test("duplicate right after, move, delete", () => {
    const doc = deck();
    const a = slideIdsOf(doc)[0] as string;
    const b = addSlide(doc, { title: "B" }, LOCAL);
    const c = addSlide(doc, { title: "C" }, LOCAL);
    const copy = duplicateSlide(doc, b, LOCAL);
    expect(slideIdsOf(doc)).toEqual([a, b, copy, c]);
    expect(texts(doc, copy)).toEqual(texts(doc, b));
    const ids = (id: string) => readSlide(doc, id)?.elements.map((el) => el.id) ?? [];
    expect(ids(copy).some((id) => ids(b).includes(id))).toBe(false);
    moveSlide(doc, c, 0, LOCAL);
    expect(slideIdsOf(doc)).toEqual([c, a, b, copy]);
    moveSlide(doc, c, 99, LOCAL);
    expect(slideIdsOf(doc)).toEqual([a, b, copy, c]);
    deleteSlides(doc, [b, "missing"], LOCAL);
    expect(slideIdsOf(doc)).toEqual([a, copy, c]);
    expect(slideByNumber(doc, 2)?.id).toBe(copy);
    expect(slideByNumber(doc, 9)).toBeNull();
  });

  test("two people moving the same slide at once still see it once, in the same place", () => {
    const one = deck();
    const s2 = addSlide(one, { title: "2" }, LOCAL);
    addSlide(one, { title: "3" }, LOCAL);
    addSlide(one, { title: "4" }, LOCAL);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    moveSlide(one, s2, 0, LOCAL);
    moveSlide(two, s2, 3, LOCAL);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    const order = slideIdsOf(one);
    expect(order).toHaveLength(4);
    expect(new Set(order).size).toBe(4);
    expect(slideIdsOf(two)).toEqual(order);
    expect(validateSlides(one)).toEqual([]);
  });

  test("a slide missing from the order (a broken client) still shows, at the end", () => {
    const doc = deck();
    const id = addSlide(doc, { title: "lost" }, LOCAL);
    slideOrderOf(doc).delete(1, 1);
    expect(slideIdsOf(doc).at(-1)).toBe(id);
  });
});

describe("changing a slide's layout", () => {
  test("texts follow their role, or a role of the same family, and come back", () => {
    const doc = deck();
    const id = addSlide(doc, { title: "Revenue", body: "Up and to the right" }, LOCAL);
    setLayout(doc, id, "big-number", LOCAL);
    expect(texts(doc, id)).toEqual({ number: "Revenue", caption: "Up and to the right" });
    setLayout(doc, id, "title-body", LOCAL);
    expect(texts(doc, id)).toEqual({ title: "Revenue", body: "Up and to the right" });
    const slide = readSlide(doc, id);
    expect(slide?.elements).toHaveLength(2);
    expect(slide?.elements.find((el) => el.role === "caption")).toBeUndefined();
  });

  test("the layout's look goes with the slot, the person's own style stays", () => {
    const doc = deck();
    const first = slideIdsOf(doc)[0] as string;
    const title = readSlide(doc, first)?.elements.find((el) => el.role === "title");
    expect(title?.style?.size).toBe(112);
    updateElement(doc, first, title?.id as string, { style: { color: "#c0ffee" }, text: "Hello" }, LOCAL);
    setLayout(doc, first, "title-only", LOCAL);
    const after = readSlide(doc, first)?.elements.find((el) => el.role === "title");
    expect(after?.id).toBe(title?.id);
    expect(after?.style).toEqual({ color: "#c0ffee" });
    expect(after).toMatchObject({ x: 120, y: 80, w: 1680, h: 176 });
    // The empty subtitle has no slot on a title-only slide: it goes.
    expect(readSlide(doc, first)?.elements).toHaveLength(1);
  });

  test("a text with no slot left stays where it was; the picture moves to the new image slot", () => {
    const doc = deck();
    const cols = addSlide(doc, { layout: "two-columns", title: "T" }, LOCAL);
    const second = readSlide(doc, cols)?.elements.find((el) => el.role === "body2");
    updateElement(doc, cols, second?.id as string, { text: "right column" }, LOCAL);
    setLayout(doc, cols, "title-only", LOCAL);
    const kept = readSlide(doc, cols)?.elements.find((el) => el.id === second?.id);
    expect(kept && richText(kept.text ?? [])).toBe("right column");
    expect(kept?.x).toBe(1000);
    const pic = addSlide(doc, { layout: "image-left", image: { asset: "photo" } }, LOCAL);
    const image = readSlide(doc, pic)?.elements.find((el) => el.type === "image");
    setLayout(doc, pic, "image-right", LOCAL);
    const moved = readSlide(doc, pic)?.elements.find((el) => el.type === "image");
    expect(moved?.id).toBe(image?.id);
    expect(moved).toMatchObject({ asset: "photo", x: 1008, y: 0 });
    setLayout(doc, pic, "title-body", LOCAL);
    expect(readSlide(doc, pic)?.elements.find((el) => el.type === "image")?.asset).toBe("photo");
  });
});

describe("elements", () => {
  test("added on top with sensible boxes; patches change only what they name", () => {
    const doc = deck();
    const slide = slideIdsOf(doc)[0] as string;
    const box = addElement(doc, slide, { type: "text", text: "**Hi**" }, LOCAL);
    const shape = addElement(doc, slide, { type: "shape", style: { shape: "ellipse", fill: "#ff0000" } }, LOCAL);
    const line = addElement(doc, slide, { type: "line", box: { x: 10, y: 500, w: 300, h: -40 } }, LOCAL);
    const table = addElement(
      doc,
      slide,
      { type: "table", table: { rows: [["a", 1 as never], ["b"]], header: true } },
      LOCAL,
    );
    const chart = addElement(
      doc,
      slide,
      {
        type: "chart",
        chart: { type: "bar", title: "Sales", labels: ["Q1", "Q2"], series: [{ name: "x", values: [1, 2] }] },
      },
      LOCAL,
    );
    const view = readSlide(doc, slide);
    const ids = view?.elements.map((el) => el.id) ?? [];
    expect(ids.slice(-5)).toEqual([box, shape, line, table, chart]);
    const byId = new Map(view?.elements.map((el) => [el.id, el]));
    expect(byId.get(box)).toMatchObject({ x: 480, y: 440, w: 960, h: 200 });
    expect(byId.get(box)?.text).toEqual([{ runs: [{ text: "Hi", bold: true }] }]);
    expect(byId.get(line)).toMatchObject({ w: 300, h: -40 });
    expect(byId.get(table)?.table).toEqual({
      rows: [
        ["a", "1"],
        ["b", ""],
      ],
      header: true,
    });
    expect(byId.get(chart)?.chart?.series[0]?.values).toEqual([1, 2]);
    updateElement(doc, slide, shape, { style: { fill: null, stroke: "#000000" }, rot: 45, text: "label" }, LOCAL);
    expect(readSlide(doc, slide)?.elements.find((el) => el.id === shape)).toMatchObject({
      rot: 45,
      style: { shape: "ellipse", stroke: "#000000" },
      text: [{ runs: [{ text: "label" }] }],
    });
    updateElement(doc, slide, shape, { rot: null, style: null }, LOCAL);
    const plain = readSlide(doc, slide)?.elements.find((el) => el.id === shape);
    expect(plain?.rot).toBeUndefined();
    expect(plain?.style).toBeUndefined();
    expectRefused(doc, "invalid", () => updateElement(doc, slide, line, { text: "no" }, LOCAL));
    expectRefused(doc, "invalid", () => updateElement(doc, slide, box, { style: { size: 9999 } }, LOCAL));
    expectRefused(doc, "not_found", () => updateElement(doc, slide, "nope", { x: 1 }, LOCAL));
    arrange(doc, slide, [box], "front", LOCAL);
    expect(readSlide(doc, slide)?.elements.at(-1)?.id).toBe(box);
    arrange(doc, slide, [box], "back", LOCAL);
    expect(readSlide(doc, slide)?.elements[0]?.id).toBe(box);
    deleteElements(doc, slide, [box, "nope"], LOCAL);
    expect(readSlide(doc, slide)?.elements.some((el) => el.id === box)).toBe(false);
  });

  test("editors bind to the element's text and the slide's notes", () => {
    const doc = deck();
    const slide = slideIdsOf(doc)[0] as string;
    const title = readSlide(doc, slide)?.elements.find((el) => el.role === "title");
    expect(elementTextFragment(doc, slide, title?.id as string)).toBeInstanceOf(Y.XmlFragment);
    expect(slideNotes(doc, slide)).toBeInstanceOf(Y.Text);
  });
});

describe("slide settings", () => {
  test("background, hidden, theme and notes", () => {
    const doc = deck();
    const id = slideIdsOf(doc)[0] as string;
    setBackground(doc, id, { asset: "bg-1" }, LOCAL);
    expect(readSlide(doc, id)?.bg).toEqual({ asset: "bg-1" });
    setBackground(doc, id, "#101820", LOCAL);
    expect(readSlide(doc, id)?.bg).toBe("#101820");
    setBackground(doc, id, null, LOCAL);
    expect(readSlide(doc, id)?.bg).toBeUndefined();
    setHidden(doc, id, true, LOCAL);
    expect(readSlide(doc, id)?.hidden).toBe(true);
    setHidden(doc, id, false, LOCAL);
    expect(readSlide(doc, id)?.hidden).toBeUndefined();
    setTheme(doc, "forest", LOCAL);
    expect(readDeck(doc).theme).toBe("forest");
    setNotes(doc, id, "Remember the demo", LOCAL);
    expect(readSlide(doc, id)?.notes).toBe("Remember the demo");
  });

  test("notes change by the characters that differ, so two people typing both land", () => {
    const one = deck();
    const id = slideIdsOf(one)[0] as string;
    setNotes(one, id, "middle", LOCAL);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    setNotes(one, id, "start middle", LOCAL);
    setNotes(two, id, "middle end", LOCAL);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    expect(readSlide(one, id)?.notes).toBe("start middle end");
  });

  test("undo takes back only the person's own changes", () => {
    const doc = deck();
    const undo = new Y.UndoManager([deckMapOf(doc), slideOrderOf(doc), slidesMapOf(doc)], {
      trackedOrigins: new Set([LOCAL]),
    });
    const mine = addSlide(doc, { title: "mine" }, LOCAL);
    undo.stopCapturing();
    const theirs = addSlide(doc, { title: "agent's" }, agentOrigin("atlas", "run-1"));
    undo.undo();
    expect(slideIdsOf(doc)).not.toContain(mine);
    expect(slideIdsOf(doc)).toContain(theirs);
    undo.destroy();
  });
});

describe("office data", () => {
  const data: DeckData = {
    w: 960,
    h: 720,
    theme: "paper",
    media: { "image1.png": { type: "image/png", asset: "asset-a" }, "image2.emf": { type: "image/emf" } },
    slides: [
      {
        layout: "title",
        bg: { media: "image1.png" },
        notes: "Opening",
        elements: [
          {
            type: "text",
            x: 0,
            y: 0,
            w: 960,
            h: 100,
            role: "title",
            text: [{ runs: [{ text: "Hello" }] }],
            style: { size: 40 },
          },
          { type: "image", x: 100, y: 200, w: 400, h: 300, media: "image1.png", alt: "A cat" },
          { type: "image", x: 500, y: 200, w: 100, h: 100, media: "image2.emf" },
          { type: "table", x: 0, y: 600, w: 960, h: 120, table: { rows: [["a", "b"]], header: false } },
        ],
      },
      {
        hidden: true,
        bg: "#000000",
        elements: [{ type: "line", x: 0, y: 0, w: 960, h: 0, style: { strokeWidth: 2 } }],
      },
    ],
  };

  test("a 4:3 deck is scaled into the slide, centered; pictures that aren't assets are left out", () => {
    const doc = deck();
    slidesFromData(doc, data, SYSTEM);
    const view = readDeck(doc);
    expect(view.theme).toBe("paper");
    expect(view.slides).toHaveLength(2);
    const [first, second] = view.slides;
    expect(first?.bg).toEqual({ asset: "asset-a" });
    expect(first?.notes).toBe("Opening");
    const title = first?.elements[0];
    expect(title).toMatchObject({ x: 240, y: 0, w: 1440, h: 150, role: "title", style: { size: 60 } });
    const images = first?.elements.filter((el) => el.type === "image") ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ asset: "asset-a", alt: "A cat", x: 390, y: 300, w: 600, h: 450 });
    expect(second).toMatchObject({ hidden: true, bg: "#000000", layout: "blank" });
    expect(second?.elements[0]?.style?.strokeWidth).toBe(3);
  });

  test("a deck written out and read back is the same deck", () => {
    const doc = deck();
    const id = addSlide(doc, { title: "Plan", body: "- a\n- b", notes: "n", image: { asset: "pic" } }, LOCAL);
    setBackground(doc, id, "#eeeeee", LOCAL);
    const out = slidesToData(doc);
    expect(out.w).toBe(1920);
    expect(out.media.pic).toEqual({ type: "", asset: "pic" });
    const copy = new Y.Doc();
    slidesFromData(copy, out, SYSTEM);
    const strip = (doc: Y.Doc) =>
      readDeck(doc).slides.map((slide) => ({
        ...slide,
        id: "",
        elements: slide.elements.map((el) => ({ ...el, id: "", z: "" })),
      }));
    expect(strip(copy)).toEqual(strip(doc));
  });
});

describe("preview, text and rules of shape", () => {
  test("the preview is the first slide shown, kept small", () => {
    const doc = deck();
    const first = slideIdsOf(doc)[0] as string;
    setHidden(doc, first, true, LOCAL);
    const id = addSlide(doc, { title: "Shown", body: "y".repeat(1000), notes: "secret notes" }, LOCAL);
    const preview = slidesPreview(doc);
    expect(preview.count).toBe(2);
    expect(preview.theme).toBe("sky");
    expect(preview.first?.id).toBe(id);
    expect(preview.first?.notes).toBe("");
    const body = preview.first?.elements.find((el) => el.role === "body");
    expect(richText(body?.text ?? []).length).toBe(400);
    expect(slidesPreview(new Y.Doc())).toEqual({ theme: "sky", count: 0, first: null });
  });

  test("the text reads top to bottom, with tables and notes", () => {
    const doc = deck();
    const first = slideIdsOf(doc)[0] as string;
    const els = readSlide(doc, first)?.elements ?? [];
    updateElement(doc, first, els.find((el) => el.role === "subtitle")?.id as string, { text: "Second line" }, LOCAL);
    updateElement(doc, first, els.find((el) => el.role === "title")?.id as string, { text: "Top line" }, LOCAL);
    setNotes(doc, first, "Spoken words", LOCAL);
    const other = addSlide(doc, { layout: "blank" }, LOCAL);
    addElement(
      doc,
      other,
      {
        type: "table",
        table: {
          rows: [
            ["Name", "Score"],
            ["Ada", "10"],
          ],
          header: true,
        },
      },
      LOCAL,
    );
    expect(slidesText(doc)).toBe("Top line\nSecond line\nSpoken words\n\nName | Score\nAda | 10");
  });

  test("a sound deck has no problems; a broken one says what", () => {
    const doc = deck();
    expect(validateSlides(doc)).toEqual([]);
    const id = slideIdsOf(doc)[0] as string;
    const slide = slideMapOf(doc, id) as Y.Map<unknown>;
    const elements = slide.get("elements") as Y.Map<Y.Map<unknown>>;
    const broken = new Y.Map<unknown>();
    broken.set("type", "hologram");
    elements.set("broken", broken);
    slide.set("notes", "plain string");
    const problems = validateSlides(doc);
    expect(problems.some((p) => p.includes("broken") && p.includes("type"))).toBe(true);
    expect(problems.some((p) => p.includes("notes"))).toBe(true);
    // Readers still open it.
    expect(readSlide(doc, id)?.elements.some((el) => el.id === "broken")).toBe(false);
  });
});

describe("restoring a version", () => {
  test("the old content comes back as one change, and what didn't change keeps its identity", () => {
    const doc = deck();
    const keep = addSlide(doc, { title: "Unchanged" }, LOCAL);
    const edit = addSlide(doc, { title: "Before" }, LOCAL);
    const snapshot = Y.encodeStateAsUpdate(doc);
    const keptMap = slidesMapOf(doc).get(keep);
    const title = readSlide(doc, edit)?.elements.find((el) => el.role === "title");
    updateElement(doc, edit, title?.id as string, { text: "After" }, LOCAL);
    addSlide(doc, { title: "New" }, LOCAL);
    deleteSlides(doc, [slideIdsOf(doc)[0] as string], LOCAL);
    setTheme(doc, "night", LOCAL);
    const old = new Y.Doc();
    Y.applyUpdate(old, snapshot);
    let changes = 0;
    doc.on("afterTransaction", () => changes++);
    replaceSlides(doc, old, SYSTEM);
    expect(changes).toBe(1);
    expect(readDeck(doc)).toEqual(readDeck(old));
    expect(slidesMapOf(doc).get(keep)).toBe(keptMap);
    expect(validateSlides(doc)).toEqual([]);
  });
});
