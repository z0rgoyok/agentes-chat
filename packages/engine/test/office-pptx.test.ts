import { describe, expect, test } from "bun:test";
import type { DeckElementData, DeckView, ElementView, SlideView } from "@agenteschat/live";
import { readPptx, writePptx } from "../src/office";
import { zip } from "../src/zip";
import { DECK_PICTURE, jpeg, packageProblems, partsOf, png, pptxDeck } from "./office-fixtures";

const near = (actual: number | undefined, expected: number) => expect(actual ?? Number.NaN).toBeCloseTo(expected, 1);

describe("reading a PowerPoint deck", () => {
  const deck = readPptx(pptxDeck());
  const [first, second] = deck.slides;
  const els = first?.elements ?? [];
  const textOf = (el: DeckElementData | undefined) =>
    (el?.text ?? []).map((p) => p.runs.map((r) => r.text).join("")).join("\n");
  const byText = (text: string) => els.find((e) => textOf(e).startsWith(text));

  test("the deck scaled to 1920 wide, its slides in order, hidden ones marked, notes kept", () => {
    expect(deck.w).toBe(1920);
    expect(deck.h).toBe(1080);
    expect(deck.theme).toBe("sky");
    expect(deck.slides).toHaveLength(2);
    expect(first?.layout).toBe("title-body");
    expect(first?.hidden).toBeUndefined();
    expect(second?.hidden).toBe(true);
    expect(first?.notes).toBe("Mention the Acme deal.\nThank Ada.");
  });

  test("backgrounds: the slide's own color, else the master's theme reference", () => {
    expect(first?.bg).toBe("#fdfbf7");
    expect(second?.bg).toBe("#e7e6e6");
  });

  test("what the master draws comes first; empty placeholders and pictures in other formats are left out", () => {
    expect(els[0]).toMatchObject({ type: "shape", x: 0, y: 1056, w: 1920, h: 24, style: { fill: "#4472c4" } });
    expect(els.some((e) => textOf(e).includes("Click to edit"))).toBe(false);
    expect(els.filter((e) => e.type === "image")).toHaveLength(1);
    expect(byText("Choice")).toBeUndefined();
    expect(byText("Fallback")?.type).toBe("text");
  });

  test("a title placeholder takes its place and look from the master", () => {
    const title = byText("Quarterly review");
    expect(title).toMatchObject({ type: "text", role: "title", x: 132, y: 57.5, w: 1656, h: 208.75 });
    expect(title?.style).toMatchObject({ size: 88, color: "#000000", font: "heading", weight: 400, valign: "middle" });
    expect(title?.text?.[0]?.runs[0]).toMatchObject({ text: "Quarterly review", bold: true });
    // The slide number field shows the slide's number.
    expect(
      second?.elements
        .at(-1)
        ?.text?.[0]?.runs.map((r) => r.text)
        .join(""),
    ).toBe("Appendix2");
  });

  test("a body placeholder: bullets and levels from the master, its own bullets off and numbering, shrunk text", () => {
    const body = byText("Revenue");
    expect(body).toMatchObject({ type: "text", role: "body", x: 132, y: 287.5, w: 1656, h: 685.25 });
    near(body?.style?.size, 50.4);
    const [a, b, c, d] = body?.text ?? [];
    expect(a).toMatchObject({ list: "bullet" });
    expect(a?.runs).toEqual([{ text: "Revenue " }, { text: "up 12%", bold: true }]);
    expect(b).toMatchObject({ list: "bullet", level: 1 });
    expect(b?.runs[0]?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b?.runs[0]?.color).not.toBe("#4472c4");
    expect(c?.list).toBeUndefined();
    expect(d).toMatchObject({ list: "ordered" });
  });

  test("a text box: rotation, anchor, alignment, run marks and only safe links", () => {
    const box = byText("Read the report");
    expect(box).toMatchObject({ type: "text", x: 960, y: 540, w: 480, h: 120, rot: 90 });
    expect(box?.style).toMatchObject({ size: 40, color: "#c00000", font: "body", align: "center", valign: "bottom" });
    const runs = box?.text?.[0]?.runs ?? [];
    expect(box?.text?.[0]?.align).toBe("center");
    expect(runs[0]).toEqual({ text: "Read the report", italic: true, underline: true, strike: true });
    expect(runs.find((r) => r.text === "acme.example")?.link).toBe("https://acme.example/report");
    expect(runs.find((r) => r.text.includes("local"))?.link).toBeUndefined();
    expect(runs.some((r) => r.text.includes("\n"))).toBe(true);
  });

  test("a shape: its theme fill and line by style reference, rounded corners, its label's color", () => {
    const goal = byText("Goal");
    expect(goal).toMatchObject({ type: "shape", x: 96, y: 720, w: 384, h: 192 });
    expect(goal?.style).toMatchObject({ shape: "rect", fill: "#ed7d31", strokeWidth: 2, radius: 48, color: "#ffffff" });
    expect(goal?.style?.stroke).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("pictures come out of the file, cropped ones fill their box", () => {
    const image = els.find((e) => e.type === "image");
    expect(image).toMatchObject({ x: 1440, y: 240, w: 384, h: 288, fit: "cover", alt: "Team photo" });
    const media = deck.media[image?.media as string];
    expect(media?.type).toBe("image/png");
    expect(media?.bytes).toEqual(DECK_PICTURE);
  });

  test("a group places its children; a line keeps its direction, width and arrow", () => {
    const dot = els.find((e) => e.style?.shape === "ellipse");
    near(dot?.x, 314.96);
    near(dot?.y, 236.22);
    near(dot?.w, 78.74);
    expect(dot?.style).toMatchObject({ fill: "#00b050", opacity: 0.5 });
    const line = els.find((e) => e.type === "line");
    expect(line).toMatchObject({ x: 480, y: 480, w: 240, h: -120 });
    expect(line?.style).toMatchObject({ stroke: "#1f4e79", strokeWidth: 6, lineEnd: "arrow" });
  });

  test("a table's text by cell, merged cells empty, its header row", () => {
    const table = els.find((e) => e.type === "table");
    expect(table?.table).toEqual({
      rows: [
        ["Region", "Total"],
        ["North\nand south", ""],
      ],
      header: true,
    });
  });

  test("past 300 slides it is too large; a broken or foreign file is unreadable", () => {
    const many = Array.from({ length: 301 }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
    const huge = zip([
      [
        "ppt/presentation.xml",
        `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${many}</p:sldIdLst></p:presentation>`,
      ],
      [
        "ppt/_rels/presentation.xml.rels",
        `<Relationships>${Array.from({ length: 301 }, (_, i) => `<Relationship Id="rId${i + 2}" Type="slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
      ],
      ...Array.from({ length: 301 }, (_, i): [string, string] => [`ppt/slides/slide${i + 1}.xml`, "<p:sld/>"]),
    ]);
    expect(() => readPptx(huge)).toThrow(expect.objectContaining({ code: "office.too_large" }));
    expect(() => readPptx(zip([["word/document.xml", "<w:document/>"]]))).toThrow(
      expect.objectContaining({ code: "office.unreadable" }),
    );
  });
});

describe("writing a PowerPoint deck", () => {
  const photo = png(64, 32, (x, y) => [x * 4, y * 8, 200, 255], { type: 2 });
  const shot = jpeg(30, 60, 1);
  const el = (e: Partial<ElementView> & Pick<ElementView, "type">, i: number): ElementView => ({
    id: `e${i}`,
    x: 100,
    y: 100,
    w: 400,
    h: 200,
    z: `a${i}`,
    ...e,
  });
  const slide = (index: number, elements: ElementView[], extra: Partial<SlideView> = {}): SlideView => ({
    id: `s${index}`,
    index,
    layout: "title-body",
    notes: "",
    elements,
    ...extra,
  });
  const deck: DeckView = {
    theme: "night",
    w: 1920,
    h: 1080,
    slides: [
      slide(
        0,
        [
          el(
            {
              type: "text",
              role: "title",
              x: 120,
              y: 80,
              w: 1680,
              h: 200,
              text: [{ runs: [{ text: "Plan & goals" }] }],
            },
            0,
          ),
          el(
            {
              type: "text",
              role: "body",
              x: 120,
              y: 320,
              w: 1680,
              h: 600,
              text: [
                { list: "bullet", runs: [{ text: "Grow " }, { text: "fast", bold: true, color: "#ff0000" }] },
                { list: "bullet", level: 1, runs: [{ text: "then steady", italic: true }] },
                { list: "ordered", runs: [{ text: "Hire", underline: true }] },
                {
                  align: "center",
                  runs: [
                    { text: "See ", strike: true },
                    { text: "acme", link: "https://acme.example" },
                  ],
                },
              ],
            },
            1,
          ),
        ],
        { notes: "Say hello to Ada.\nThen the numbers." },
      ),
      slide(
        1,
        [
          el(
            {
              type: "shape",
              style: { shape: "ellipse", fill: "#0b7a6c", stroke: "#ffffff", strokeWidth: 4 },
              text: [{ runs: [{ text: "Hub" }] }],
            },
            0,
          ),
          el({ type: "shape", x: 600, style: { shape: "rect", radius: 24, opacity: 0.5 } }, 1),
          el(
            {
              type: "line",
              x: 1000,
              y: 900,
              w: 400,
              h: -300,
              style: { stroke: "#f5b74f", strokeWidth: 6, lineEnd: "arrow" },
            },
            2,
          ),
          el({ type: "image", x: 100, y: 500, w: 400, h: 400, asset: "photo", fit: "contain", alt: "A chart" }, 3),
          el({ type: "image", x: 600, y: 500, w: 400, h: 400, asset: "shot", fit: "cover" }, 4),
          el({ type: "image", x: 1100, y: 500, w: 200, h: 200, asset: "gone" }, 5),
          el(
            {
              type: "table",
              x: 1300,
              y: 100,
              w: 500,
              h: 300,
              table: {
                rows: [
                  ["Region", "Total"],
                  ["North", "10"],
                ],
                header: true,
              },
            },
            6,
          ),
          el(
            {
              type: "chart",
              x: 1300,
              y: 500,
              w: 500,
              h: 400,
              chart: { type: "bar", title: "Sales", labels: ["Q1", "Q2"], series: [{ name: "2026", values: [3, 5] }] },
            },
            7,
          ),
        ],
        { bg: "#123456", hidden: true },
      ),
      slide(2, [], { bg: { asset: "photo" } }),
    ],
  };
  const media = async (asset: string) =>
    asset === "photo"
      ? { bytes: photo, type: "image/png" }
      : asset === "shot"
        ? { bytes: shot, type: "image/jpeg" }
        : null;

  test("a complete package every app opens: content types and relationships all point at parts that exist", async () => {
    const bytes = await writePptx(deck, media);
    expect(packageProblems(bytes)).toEqual([]);
    const parts = partsOf(bytes);
    expect(Object.keys(parts).filter((p) => p.startsWith("ppt/slides/slide"))).toHaveLength(3);
    expect(Object.keys(parts).filter((p) => p.startsWith("ppt/media/"))).toEqual([
      "ppt/media/image1.png",
      "ppt/media/image2.jpeg",
    ]);
    expect(parts["ppt/presentation.xml"]).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(parts["ppt/theme/theme1.xml"]).toContain('<a:latin typeface="Funnel Display"/>');
    expect(parts["ppt/slideMasters/slideMaster1.xml"]).toContain('bg1="dk1" tx1="lt1"');
    expect(parts["ppt/slides/slide1.xml"]).toContain('<p:ph type="title"/>');
    expect(parts["ppt/slides/slide2.xml"]).toContain('show="0"');
    expect(parts["ppt/notesSlides/notesSlide1.xml"]).toContain("Say hello to Ada.");
    expect(parts["ppt/slides/_rels/slide1.xml.rels"]).toContain('Target="https://acme.example" TargetMode="External"');
  });

  test("what it writes reads back: texts and their marks, shapes, lines, pictures, tables, notes", async () => {
    const back = readPptx(await writePptx(deck, media));
    expect(back.slides).toHaveLength(3);
    const [one, two, three] = back.slides;
    expect(one?.notes).toBe("Say hello to Ada.\nThen the numbers.");
    expect(two?.hidden).toBe(true);
    expect(two?.bg).toBe("#123456");
    expect(three?.bg).toMatchObject({ media: expect.any(String) });
    const title = one?.elements.find((e) => e.role === "title");
    expect(title).toMatchObject({ x: 120, y: 80, w: 1680, h: 200 });
    expect(title?.text?.[0]?.runs[0]?.text).toBe("Plan & goals");
    const body = one?.elements.find((e) => e.role === "body");
    const [a, b, c, d] = body?.text ?? [];
    expect(a).toMatchObject({ list: "bullet" });
    expect(a?.runs[1]).toMatchObject({ text: "fast", bold: true, color: "#ff0000" });
    expect(b).toMatchObject({ list: "bullet", level: 1 });
    expect(b?.runs[0]).toMatchObject({ italic: true });
    expect(c).toMatchObject({ list: "ordered" });
    expect(c?.runs[0]).toMatchObject({ underline: true });
    expect(d).toMatchObject({ align: "center" });
    expect(d?.runs.find((r) => r.text === "acme")?.link).toBe("https://acme.example");
    expect(d?.runs[0]).toMatchObject({ strike: true });

    const els = two?.elements ?? [];
    const hub = els.find((e) => e.style?.shape === "ellipse");
    expect(hub).toMatchObject({
      type: "shape",
      x: 100,
      y: 100,
      w: 400,
      h: 200,
      style: { fill: "#0b7a6c", stroke: "#ffffff" },
    });
    expect(hub?.text?.[0]?.runs[0]?.text).toBe("Hub");
    const rounded = els.find((e) => e.x === 600 && e.type === "shape");
    expect(rounded?.style).toMatchObject({ radius: 24, opacity: 0.5 });
    const line = els.find((e) => e.type === "line");
    expect(line).toMatchObject({ x: 1000, y: 900, w: 400, h: -300, style: { lineEnd: "arrow", strokeWidth: 6 } });
    const images = els.filter((e) => e.type === "image");
    expect(images).toHaveLength(2);
    // Fitted inside its box (PowerPoint stretches a picture to its frame): 2:1 in a square, centered.
    expect(images[0]).toMatchObject({ x: 100, y: 600, w: 400, h: 200, alt: "A chart" });
    expect(images[1]).toMatchObject({ x: 600, y: 500, w: 400, h: 400, fit: "cover" });
    expect(back.media[images[0]?.media as string]?.bytes).toEqual(photo);
    const table = els.find((e) => e.type === "table");
    expect(table?.table).toEqual({
      rows: [
        ["Region", "Total"],
        ["North", "10"],
      ],
      header: true,
    });
    // A chart is drawn with shapes: its title and labels are there to read.
    const words = els.flatMap((e) => (e.text ?? []).flatMap((p) => p.runs.map((r) => r.text)));
    expect(words).toEqual(expect.arrayContaining(["Sales", "Q1", "Q2"]));
  });

  test("an empty deck is still a valid file", async () => {
    const bytes = await writePptx({ theme: "sky", w: 1920, h: 1080, slides: [] }, media);
    expect(packageProblems(bytes)).toEqual([]);
    expect(readPptx(bytes).slides).toEqual([]);
  });
});
