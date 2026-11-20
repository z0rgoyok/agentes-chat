import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import type { DeckView, ElementView, SlideView } from "@agenteschat/live";
import { slidesPdf } from "../src/office";
import { gifImage, jpegImage, pdfImage, pngImage } from "../src/office/pdf-images";
import { gif, jpeg, png } from "./office-fixtures";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Sixteen distinct colors for GIFs, so every index reads back as its own color. */
const tone = (i: number): [number, number, number] => [i * 16, 255 - i * 16, (i * 37) % 256];
const PALETTE = Array.from({ length: 16 }, (_, i) => tone(i));

describe("pictures as PDF images", () => {
  const pixels = (image: { data: Uint8Array }) => new Uint8Array(inflateSync(image.data));

  test("RGBA with every row filter: the colors, and the transparency as a separate mask", () => {
    const image = pngImage(png(7, 5, (x, y) => [x * 30, y * 40, 200, x === 0 ? 0 : 255]));
    expect(image).toMatchObject({ width: 7, height: 5, turn: 0 });
    const rgb = pixels(image as { data: Uint8Array });
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++)
        expect([...rgb.subarray((y * 7 + x) * 3, (y * 7 + x) * 3 + 3)]).toEqual([x * 30, y * 40, 200]);
    }
    const mask = new Uint8Array(inflateSync(image?.mask as Uint8Array));
    expect(mask[0]).toBe(0);
    expect(mask[1]).toBe(255);
  });

  test("RGB without transparency has no mask; 16-bit gray and a palette with transparency decode too", () => {
    const opaque = pngImage(png(3, 3, () => [1, 2, 3, 255], { type: 2 }));
    expect(opaque?.mask).toBeUndefined();
    expect([...pixels(opaque as { data: Uint8Array }).subarray(0, 3)]).toEqual([1, 2, 3]);
    const gray = pngImage(png(4, 2, (x) => [x * 60, 0, 0, 255], { type: 0, depth: 16 }));
    expect([...pixels(gray as { data: Uint8Array }).subarray(9, 12)]).toEqual([180, 180, 180]);
    const palette: [number, number, number, number][] = [
      [255, 0, 0, 255],
      [0, 0, 255, 0],
    ];
    const indexed = pngImage(png(2, 2, (x) => palette[x] as [number, number, number, number], { type: 3, palette }));
    expect([...pixels(indexed as { data: Uint8Array })]).toEqual([255, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 255]);
    expect([...new Uint8Array(inflateSync(indexed?.mask as Uint8Array))]).toEqual([255, 0, 255, 0]);
  });

  test("a JPEG goes in as it is, its EXIF turn read; anything else isn't drawn", () => {
    const shot = jpeg(30, 60, 6);
    expect(jpegImage(shot)).toMatchObject({ width: 30, height: 60, turn: 90, data: shot });
    expect(jpegImage(shot)?.dict).toContain("/DCTDecode");
    expect(jpegImage(jpeg(10, 10, 1, 4))?.dict).toContain("/DeviceCMYK");
    expect(pngImage(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  const colorAt = (image: { data: Uint8Array }, width: number, x: number, y: number) => {
    const at = (y * width + x) * 3;
    return [...pixels(image).subarray(at, at + 3)];
  };

  test("a GIF's first frame: its codes growing past each size, repeated colors in runs, no mask when opaque", () => {
    // Runs of one color (the codes LZW makes for a string it is still writing) and enough variety to grow the codes.
    const at = (x: number, y: number) => ((x >> 2) + y * 3) % 16;
    const image = gifImage(gif(40, 30, at, PALETTE));
    expect(image).toMatchObject({ width: 40, height: 30, turn: 0 });
    expect(image?.mask).toBeUndefined();
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 40; x++) expect(colorAt(image as { data: Uint8Array }, 40, x, y)).toEqual(tone(at(x, y)));
    }
  });

  test("a GIF whose table fills up starts it again, and still reads whole", () => {
    // A noisy picture in 256 colors: past 4,096 strings the encoder clears its table.
    const palette: [number, number, number][] = Array.from({ length: 256 }, (_, i) => [i, (i * 7) % 256, 255 - i]);
    const at = (x: number, y: number) => (x * 7919 + y * 104_729 + ((x * y) % 13)) % 256;
    const image = gifImage(gif(120, 90, at, palette)) as { data: Uint8Array };
    const expected: number[] = [];
    for (let y = 0; y < 90; y++) for (let x = 0; x < 120; x++) expected.push(...(palette[at(x, y)] ?? []));
    expect([...pixels(image)]).toEqual(expected);
  });

  test("an interlaced GIF frame inside a larger screen: its rows in place, the rest and its transparent color clear", () => {
    const at = (x: number, y: number) => (x + y) % 4;
    const screen = { width: 10, height: 14, left: 2, top: 1 };
    const image = gifImage(gif(7, 11, at, PALETTE.slice(0, 4), { interlace: true, transparent: 3, screen }));
    expect(image).toMatchObject({ width: 10, height: 14 });
    const mask = new Uint8Array(inflateSync(image?.mask as Uint8Array));
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 10; x++) {
        const inside = x >= 2 && x < 9 && y >= 1 && y < 12;
        const index = inside ? at(x - 2, y - 1) : -1;
        expect(mask[y * 10 + x]).toBe(inside && index !== 3 ? 255 : 0);
        if (inside && index !== 3) expect(colorAt(image as { data: Uint8Array }, 10, x, y)).toEqual(tone(index));
      }
    }
  });

  test("a damaged GIF draws what it has; one with no frame, or past the pixel limit, isn't drawn", () => {
    const whole = gif(20, 20, (x) => x % 4, PALETTE.slice(0, 4));
    // Cut inside the image data: the rows read so far stay, the rest is the first color.
    const cut = gifImage(whole.subarray(0, whole.length - 12));
    expect(cut).toMatchObject({ width: 20, height: 20 });
    expect(colorAt(cut as { data: Uint8Array }, 20, 3, 0)).toEqual(tone(3));
    const header = whole.subarray(0, 13 + 4 * 3);
    expect(gifImage(new Uint8Array([...header, 0x3b]))).toBeNull();
    const huge = new Uint8Array(whole);
    huge.set([0xff, 0xff, 0xff, 0xff], 6);
    expect(gifImage(huge)).toBeNull();
    // Every format through the one entry point.
    expect(pdfImage(whole)?.width).toBe(20);
    expect(pdfImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull();
  });
});

describe("a presentation as a PDF", () => {
  const el = (e: Partial<ElementView> & Pick<ElementView, "type">, i: number): ElementView => ({
    id: `e${i}`,
    x: 100,
    y: 100,
    w: 600,
    h: 200,
    z: `a${i}`,
    ...e,
  });
  const slide = (index: number, elements: ElementView[], extra: Partial<SlideView> = {}): SlideView => ({
    id: `s${index}`,
    index,
    layout: "blank",
    notes: "",
    elements,
    ...extra,
  });
  const photo = png(20, 10, (x) => [x * 12, 100, 50, x < 10 ? 255 : 100]);
  const shot = jpeg(16, 16, 1);
  const deck: DeckView = {
    theme: "sky",
    w: 1920,
    h: 1080,
    slides: [
      slide(0, [
        el({ type: "text", role: "title", text: [{ runs: [{ text: "Plano de ação — 2026" }] }] }, 0),
        el(
          {
            type: "text",
            role: "body",
            y: 320,
            w: 900,
            h: 600,
            text: [
              {
                list: "bullet",
                runs: [{ text: "A very long first point that has to wrap over more than one line in the box" }],
              },
              {
                list: "ordered",
                level: 1,
                runs: [
                  { text: "bold", bold: true },
                  { text: " and italic", italic: true },
                ],
              },
              {
                align: "right",
                runs: [
                  { text: "underlined", underline: true },
                  { text: " struck", strike: true },
                ],
              },
              { runs: [{ text: "Supercalifragilisticexpialidocious".repeat(4) }] },
            ],
          },
          1,
        ),
        el(
          {
            type: "shape",
            x: 1100,
            style: { shape: "ellipse", fill: "#0b7a6c", opacity: 0.6 },
            text: [{ runs: [{ text: "Hub" }] }],
          },
          2,
        ),
        el({ type: "shape", x: 1100, y: 400, style: { shape: "arrow", stroke: "#000000", strokeWidth: 3 } }, 3),
        el({ type: "line", x: 1100, y: 700, w: 400, h: 100, style: { lineEnd: "arrow" } }, 4),
        el({ type: "image", x: 1300, y: 800, w: 300, h: 150, asset: "photo", fit: "cover", rot: 15 }, 5),
      ]),
      slide(1, [el({ type: "text", text: [{ runs: [{ text: "Hidden" }] }] }, 0)], { hidden: true }),
      slide(
        2,
        [
          el({ type: "image", asset: "shot", fit: "contain" }, 0),
          el({ type: "image", x: 800, asset: "missing" }, 1),
          el(
            {
              type: "table",
              y: 400,
              table: {
                rows: [
                  ["Region", "Total"],
                  ["North", "10"],
                ],
                header: true,
              },
            },
            2,
          ),
          el(
            {
              type: "chart",
              x: 1000,
              y: 400,
              w: 800,
              h: 500,
              chart: {
                type: "line",
                title: "Sales",
                labels: ["Q1", "Q2", "Q3"],
                series: [{ name: "A", values: [1, 4, 2] }],
              },
            },
            3,
          ),
          el(
            {
              type: "chart",
              x: 100,
              y: 700,
              w: 300,
              h: 300,
              chart: { type: "pie", title: "", labels: ["x", "y"], series: [{ name: "s", values: [1, 3] }] },
            },
            4,
          ),
        ],
        { bg: { asset: "photo" } },
      ),
    ],
  };
  const media = async (asset: string) =>
    asset === "photo"
      ? { bytes: photo, type: "image/png" }
      : asset === "shot"
        ? { bytes: shot, type: "image/jpeg" }
        : null;

  test("one page per visible slide, a valid cross-reference table, pictures and their masks once each", async () => {
    const pdf = await slidesPdf(deck, media, "Plano");
    const text = latin1(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text.match(/\/Type \/Page /g)?.length).toBe(2);
    expect(text).toContain("/MediaBox [0 0 960 540]");
    // Every object where the cross-reference table says it is.
    const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    const table = text.slice(xref).split("\n");
    const count = Number(table[1]?.split(" ")[1]);
    for (let i = 1; i < count; i++) {
      const offset = Number(table[2 + i]?.slice(0, 10));
      expect(text.slice(offset, offset + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
    }
    // The PNG (once, though used twice) with its mask, and the JPEG as it is.
    expect(text.match(/\/Subtype \/Image/g)?.length).toBe(3);
    expect(text.match(/\/SMask/g)?.length).toBe(1);
    expect(text.match(/\/DCTDecode/g)?.length).toBe(1);
    expect(text).toContain("/Title (Plano)");
  });

  test("text is set in the engine's fonts, embedded, and can be copied (its characters are mapped back)", async () => {
    const text = latin1(await slidesPdf(deck, media));
    expect(text).toContain("/FontFile2");
    expect(text).toContain("/ToUnicode");
    // "ç" and "—" are drawn and copy back as themselves.
    expect(text).toMatch(/<[0-9a-f]{4}> <00e7>/);
    expect(text).toMatch(/<[0-9a-f]{4}> <2014>/);
  });

  test("every slide hidden still gives a page; a picture that can't be read leaves its place empty", async () => {
    const pdf = latin1(
      await slidesPdf(
        { ...deck, slides: [slide(0, [el({ type: "image", asset: "missing" }, 0)], { hidden: true })] },
        media,
      ),
    );
    expect(pdf.match(/\/Type \/Page /g)?.length).toBe(1);
  });

  test("a GIF picture is drawn like a PNG", async () => {
    const still = gif(8, 8, (x, y) => (x + y) % 4, PALETTE.slice(0, 4));
    const read = async () => ({ bytes: still, type: "image/gif" });
    const single = { ...deck, slides: [slide(0, [el({ type: "image", asset: "still" }, 0)])] };
    const pdf = latin1(await slidesPdf(single, read));
    expect(pdf.match(/\/Subtype \/Image/g)?.length).toBe(1);
    expect(pdf).toContain("/XObject << /Im1 ");
  });
});
