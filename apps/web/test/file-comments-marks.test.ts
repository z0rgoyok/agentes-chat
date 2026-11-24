import { describe, expect, test } from "bun:test";
import type { LiveRef, LiveSelection, Message } from "@agenteschat/client";
import type { TFunction } from "i18next";
import { cropRect, markOf, mediaPinsOf, pinAt } from "@/components/live/media/marks";
import { aboutParts, aboutWords, clockOf, selectionKey } from "@/components/live/talk";
import { createI18n } from "@/i18n";

/*
 * Comments on a picture, a video or a PDF (ADR 0208), the pure parts: a press and its release become a point or an
 * area in fractions of the picture, where its pin stands, the part of the picture the app's crop shows, the file's
 * pinned comments numbered oldest first (resolved, made on an older version), and the words that name them over the
 * composer and on a message's line.
 */

const pt = createI18n("pt-BR");
const t = pt.t.bind(pt) as TFunction;
const en = createI18n("en");
const tEn = en.t.bind(en) as TFunction;

/** The picture's box on screen: 200×100 at (100, 50). */
const BOX = { left: 100, top: 50, width: 200, height: 100 };

describe("markOf: a press and its release over the picture", () => {
  test("a press that barely moves is a point, in fractions of the box", () => {
    expect(markOf({ x: 150, y: 75 }, { x: 153, y: 77 }, BOX)).toEqual({ x: 0.25, y: 0.25 });
    expect(markOf({ x: 300, y: 150 }, { x: 300, y: 150 }, BOX)).toEqual({ x: 1, y: 1 });
  });

  test("a drag is an area from its top left corner, whichever way it was dragged", () => {
    const down = markOf({ x: 150, y: 100 }, { x: 300, y: 150 }, BOX);
    const up = markOf({ x: 300, y: 150 }, { x: 150, y: 100 }, BOX);
    expect(down).toEqual({ x: 0.25, y: 0.5, w: 0.75, h: 0.5 });
    expect(up).toEqual(down);
  });

  test("outside the box it is clamped to its edges; fractions keep four decimals", () => {
    expect(markOf({ x: 50, y: 0 }, { x: 400, y: 300 }, BOX)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(markOf({ x: 90, y: 40 }, { x: 91, y: 40 }, BOX)).toEqual({ x: 0, y: 0 });
    // 100 of 300 pixels: a third, rounded.
    expect(markOf({ x: 200, y: 50 }, { x: 200, y: 50 }, { ...BOX, width: 300 })).toEqual({ x: 0.3333, y: 0 });
  });

  test("a box with no size marks nothing", () => {
    expect(markOf({ x: 1, y: 1 }, { x: 50, y: 50 }, { ...BOX, width: 0 })).toBeNull();
    expect(markOf({ x: 1, y: 1 }, { x: 50, y: 50 }, { ...BOX, height: 0 })).toBeNull();
  });
});

describe("pinAt: where a comment's pin stands", () => {
  test("an area's top right corner; a point itself", () => {
    const area = pinAt({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
    expect(area).toEqual({ x: 0.75, y: 0.5 });
    expect(pinAt({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7 });
  });
});

describe("cropRect: the part of the picture the comment's crop shows", () => {
  test("around a point, a square of 30% of the picture's shorter side", () => {
    // 601 × 0.3 / 2 = 90.15 pixels each way from (500.5, 300.5).
    expect(cropRect({ x: 0.5, y: 0.5 }, 1001, 601)).toEqual({ x: 410, y: 210, w: 181, h: 181 });
  });

  test("a point at a corner keeps the crop inside the picture", () => {
    expect(cropRect({ x: 0, y: 0 }, 1001, 601)).toEqual({ x: 0, y: 0, w: 91, h: 91 });
    expect(cropRect({ x: 1, y: 1 }, 1001, 601)).toEqual({ x: 910, y: 510, w: 91, h: 91 });
  });

  test("an area gets 15% of its own size around it", () => {
    // 0.5 wide: 0.075 each side, from 0.175 to 0.825 of 1001 pixels.
    expect(cropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 1001, 1001)).toEqual({ x: 175, y: 175, w: 651, h: 651 });
  });

  test("a small area never gets less than 6% of the picture around it", () => {
    // 0.2 wide: 15% would be 0.03; it gets 0.06, from 0.44 to 0.76.
    expect(cropRect({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 1001, 501)).toEqual({ x: 440, y: 220, w: 321, h: 161 });
  });

  test("an area over the whole picture crops all of it, and a crop is never empty", () => {
    expect(cropRect({ x: 0, y: 0, w: 1, h: 1 }, 1000, 500)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
    const tiny = cropRect({ x: 1, y: 1 }, 1, 1);
    expect(tiny.w).toBeGreaterThanOrEqual(1);
    expect(tiny.h).toBeGreaterThanOrEqual(1);
  });
});

describe("mediaPinsOf: the file's comments with a pin", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
  const message = (id: string, minutes: number, extra: Partial<Message> = {}): Message => ({
    id,
    channelId: "file-conversation-f1",
    threadId: "file-root-f1",
    author: { type: "person", id: "u-1" },
    body: `comment ${id}`,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: at(minutes),
    ...extra,
  });
  const ref = (selection: LiveSelection, artifactId = "f1"): LiveRef => ({
    artifactId,
    kind: "image",
    title: "banner.png",
    selection,
  });
  const resolved = { by: { type: "agent", id: "agent-1" }, at: at(30) };

  test("numbered oldest first, skipping what has no place in this file", () => {
    const messages = [
      // The conversation's root stands for the file.
      message("root", 0, { threadId: null }),
      message("a", 1, { liveRef: ref({ label: "1", mark: { x: 0.1, y: 0.2 }, version: 1 }) }),
      // Another file's comment.
      message("other", 2, { liveRef: ref({ label: "1", mark: { x: 0.5, y: 0.5 } }, "f2") }),
      // About the file, with no place in it.
      message("plain", 3, { liveRef: ref({ label: "banner.png" }) }),
      // Read from `meta` (an older server), an area, resolved.
      message("b", 4, {
        meta: {
          liveRef: { ...ref({ label: "2", mark: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 }, version: 2 }) },
          resolved,
        },
      }),
      // A video's moment and a PDF's page are pinned too.
      message("c", 5, { liveRef: { ...ref({ label: "3", time: 42 }), kind: "video" } }),
      message("d", 6, { liveRef: { ...ref({ label: "4", page: 3 }), kind: "pdf" } }),
    ];
    const pins = mediaPinsOf(messages, "f1", 2);
    expect(pins.map((p) => [p.message.id, p.n])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
    expect(pins[1]?.selection.mark).toEqual({ x: 0.1, y: 0.1, w: 0.3, h: 0.2 });
    expect(pins[2]?.selection.time).toBe(42);
    expect(pins[3]?.selection.page).toBe(3);
  });

  test("resolved by whom and when; made on an older version is old (no version: never old)", () => {
    const messages = [
      message("a", 1, { liveRef: ref({ label: "1", mark: { x: 0.1, y: 0.2 }, version: 1 }) }),
      message("b", 2, { liveRef: ref({ label: "2", mark: { x: 0.2, y: 0.2 }, version: 2 }), meta: { resolved } }),
      message("c", 3, { liveRef: ref({ label: "3", mark: { x: 0.3, y: 0.2 } }) }),
      // A `resolved` that doesn't read right is open.
      message("d", 4, {
        liveRef: ref({ label: "4", mark: { x: 0.4, y: 0.2 }, version: 2 }),
        meta: { resolved: { by: { type: "robot", id: "x" }, at: at(9) } },
      }),
    ];
    const pins = mediaPinsOf(messages, "f1", 2);
    expect(pins.map((p) => p.old)).toEqual([true, false, false, false]);
    expect(pins.map((p) => p.resolved)).toEqual([null, resolved as never, null, null]);
    // The same comments on the file's first version: none is old.
    expect(mediaPinsOf(messages, "f1", 1).map((p) => p.old)).toEqual([false, false, false, false]);
  });

  test("no messages, no pins", () => {
    expect(mediaPinsOf([], "f1", 1)).toEqual([]);
  });
});

describe("clockOf: a video's moment", () => {
  test("m:ss, h:mm:ss past an hour; never negative, whole seconds", () => {
    expect(clockOf(0)).toBe("0:00");
    expect(clockOf(42.9)).toBe("0:42");
    expect(clockOf(61)).toBe("1:01");
    expect(clockOf(600)).toBe("10:00");
    expect(clockOf(3600)).toBe("1:00:00");
    expect(clockOf(3725)).toBe("1:02:05");
    expect(clockOf(-5)).toBe("0:00");
  });
});

describe("aboutWords: the quote over the composer", () => {
  test("a picture's area and point by their pin's number", () => {
    expect(aboutWords(t, "image", { label: "4", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toBe(
      "Sobre a área 4 da imagem",
    );
    expect(aboutWords(t, "image", { label: "2", mark: { x: 0.5, y: 0.5 } })).toBe("Sobre o ponto 2 da imagem");
    expect(aboutWords(tEn, "image", { label: "4", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toBe(
      "About area 4 of the image",
    );
  });

  test("a video's moment, a PDF's page; with no place, the file itself", () => {
    expect(aboutWords(t, "video", { label: "1", time: 42 })).toBe("Sobre 0:42 do vídeo");
    expect(aboutWords(t, "video", { label: "1", time: 3725, mark: { x: 0.1, y: 0.1 } })).toBe("Sobre 1:02:05 do vídeo");
    expect(aboutWords(t, "pdf", { label: "1", page: 3 })).toBe("Sobre a página 3 do PDF");
    expect(aboutWords(t, "pdf", { label: "1", page: 3, mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toBe(
      "Sobre a página 3 do PDF",
    );
    expect(aboutWords(t, "image", { label: "banner.png" })).toBe("Sobre a imagem");
    expect(aboutWords(t, "video", { label: "x" })).toBe("Sobre o vídeo");
    expect(aboutWords(t, "pdf", { label: "x" })).toBe("Sobre o PDF");
    expect(aboutWords(tEn, "video", { label: "1", time: 42 })).toBe("About 0:42 of the video");
  });

  test("a live file's selection keeps its words", () => {
    expect(aboutWords(t, "spreadsheet", { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" })).toBe(
      "Sobre C2:D6 em Custos",
    );
  });
});

describe("aboutParts: a comment's line over its message", () => {
  const line = (kind: LiveRef["kind"], selection?: LiveSelection, title = "banner.png") =>
    aboutParts(t, { artifactId: "f1", kind, title, ...(selection ? { selection } : {}) });

  test("a picture: its area or point by number, on the image; with no place, the file's name", () => {
    expect(line("image", { label: "1", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toEqual({
      what: "Área 1",
      where: "na imagem",
    });
    expect(line("image", { label: "2", mark: { x: 0.5, y: 0.5 } })).toEqual({ what: "Ponto 2", where: "na imagem" });
    // A label that is no number: "an area", "a point".
    expect(line("image", { label: "banner", mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }).what).toBe("Uma área");
    expect(line("image", { label: "banner", mark: { x: 0.1, y: 0.1 } }).what).toBe("Um ponto");
    expect(line("image", { label: "banner.png" })).toEqual({ what: "banner.png", where: "na imagem" });
    expect(line("image")).toEqual({ what: "banner.png", where: "na imagem" });
    expect(line("image", undefined, "")).toEqual({ what: "Arquivo sem nome", where: "na imagem" });
  });

  test("a video: its moment, with the area or point after it", () => {
    expect(line("video", { label: "1", time: 42 }, "abertura.mp4")).toEqual({ what: "0:42", where: "no vídeo" });
    expect(line("video", { label: "2", time: 3725, mark: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toEqual({
      what: "1:02:05 · área 2",
      where: "no vídeo",
    });
    expect(line("video", undefined, "abertura.mp4")).toEqual({ what: "abertura.mp4", where: "no vídeo" });
  });

  test("a PDF: its page, with the area or point as where", () => {
    expect(line("pdf", { label: "1", page: 3 })).toEqual({ what: "Página 3", where: "no PDF" });
    expect(line("pdf", { label: "1", page: 3, mark: { x: 0.2, y: 0.3 } })).toEqual({
      what: "Página 3",
      where: "ponto 1",
    });
  });

  test("a live file's line keeps its parts", () => {
    expect(line("spreadsheet", { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" }, "Orçamento")).toEqual({
      what: "C2:D6",
      where: "Custos",
    });
    expect(line("spreadsheet", undefined, "Orçamento")).toEqual({ what: "Orçamento", where: "Planilha" });
  });
});

describe("selectionKey: the same place in the file", () => {
  test("a mark, a moment or a page that moved is another selection", () => {
    const base: LiveSelection = { label: "1", mark: { x: 0.1, y: 0.1 } };
    expect(selectionKey(base)).toBe(selectionKey({ ...base }));
    expect(selectionKey(base)).not.toBe(selectionKey({ ...base, mark: { x: 0.2, y: 0.1 } }));
    expect(selectionKey({ label: "1", time: 4 })).not.toBe(selectionKey({ label: "1", time: 5 }));
    expect(selectionKey({ label: "1", page: 1 })).not.toBe(selectionKey({ label: "1", page: 2 }));
    expect(selectionKey(null)).toBe("");
    expect(selectionKey(undefined)).toBe("");
  });
});
