import { describe, expect, test } from "bun:test";
import type { LiveRef } from "@agenteschat/client";
import type { DocBlock } from "@agenteschat/live/document";
import { appLinkFromUrl } from "../../src/features/links/app-links";
import { fileHref, hrefForPush, hrefFromUrl, notificationHref } from "../../src/features/links/logic";
import {
  canvasSelection,
  clampCrop,
  croppedPicture,
  isInk,
  STROKE_MAX,
  strokeOf,
  strokeShape,
  thinPoints,
} from "../../src/features/live-files/canvas/logic";
import {
  askSelection,
  blockStyle,
  editable,
  listNumbers,
  restyled,
  toggledList,
  toggledQuote,
} from "../../src/features/live-files/document/logic";
import {
  aboutParts,
  aboutWords,
  askText,
  fileAgentId,
  fileUnder,
  lastWords,
  oneLine,
  sheetParts,
  talkLine,
  talkPins,
} from "../../src/features/live-files/talk/logic";

/**
 * A live file's own conversation on the phone (ADR 0199) and the tools around it: the line under the file, the quote
 * over the composer and the line over a message, the file's agent, the canvas's comment pins and pen, the document's
 * blocks edited one at a time (ADR 0200), and the links and notices that open a file at a message.
 */

/** The words' keys with what they were given, so a test reads which words and values were picked. */
const t = (key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key);

describe("the quote and the line about the file", () => {
  test("each kind words its quote: cells in a sheet, a slide, canvas items or a spot, a document's passage", () => {
    expect(sheetParts("Custos!C2:D6")).toEqual({ sheet: "Custos", range: "C2:D6" });
    expect(sheetParts("Planilha 1!B2")).toEqual({ sheet: "Planilha 1", range: "B2" });
    expect(sheetParts("!B2")).toBeNull();
    expect(aboutWords(t, "spreadsheet", { label: "Custos!C2:D6", sheet: "s1", range: "C2:D6" })).toBe(
      'live.conversation.about.range {"sheet":"Custos","range":"C2:D6"}',
    );
    expect(aboutWords(t, "slides", { label: "Slide 3", slide: "x" })).toBe('live.conversation.about.slide {"n":"3"}');
    expect(aboutWords(t, "canvas", { label: "1 imagem", shapes: ["a"] })).toBe(
      'live.conversation.about.canvas {"label":"1 imagem"}',
    );
    expect(aboutWords(t, "canvas", { label: "Comentário", point: { x: 1, y: 2 } })).toBe("mobile.live.talk.aboutPoint");
    expect(aboutWords(t, "document", { label: "“Oi”", block: "b1", text: "Oi" })).toBe("live.conversation.about.text");
  });

  test("a message's line: what in bold, where quietly; the file alone with nothing chosen", () => {
    const ref = (r: Partial<LiveRef>): LiveRef => ({ artifactId: "f1", kind: "spreadsheet", title: "Orçamento", ...r });
    expect(aboutParts(t, ref({ selection: { label: "Custos!C2:D6" } }))).toEqual({ what: "C2:D6", where: "Custos" });
    expect(aboutParts(t, ref({ kind: "canvas", title: "Banner", selection: { label: "1 imagem" } }))).toEqual({
      what: "1 imagem",
      where: "Banner",
    });
    expect(aboutParts(t, ref({ kind: "slides" }))).toEqual({ what: "Orçamento", where: "live.kinds.slides" });
    expect(aboutParts(t, ref({ title: "" }))).toEqual({
      what: "live.conversation.untitled",
      where: "live.kinds.spreadsheet",
    });
  });
});

describe("the line under the file", () => {
  test("an agent at work wins, then the last message, then the invitation", () => {
    expect(talkLine({ count: 4, working: { agentId: "a1", text: "Atlas está criando…" }, last: null })).toEqual({
      state: "working",
      agentId: "a1",
      text: "Atlas está criando…",
      count: 4,
    });
    const last = { name: "Atlas", text: "Pronto, **somei** por situação." };
    expect(talkLine({ count: 3, working: null, last })).toEqual({
      state: "last",
      text: "Atlas: Pronto, somei por situação.",
      count: 3,
    });
    expect(talkLine({ count: 0, working: null, last: null })).toEqual({ state: "start", count: 0 });
    // Its messages not loaded yet: the count alone.
    expect(talkLine({ count: 2, working: null, last: null })).toEqual({ state: "last", text: "", count: 2 });
  });

  test("the last message on one line, Markdown's marks out", () => {
    expect(oneLine("Veja [o plano](https://x.y)\n\n- *um*\n- `dois`")).toBe("Veja o plano - um - dois");
    expect(oneLine("```\ncode\n```\nfim")).toBe("fim");
    expect(lastWords("Ada", "")).toBe("Ada");
    expect(lastWords("", "oi")).toBe("oi");
  });
});

describe("the file's agent", () => {
  const askable = (id: string) => id !== "no";
  const base = {
    spoke: [] as { type: string; id: string | null }[],
    participants: [] as { type: string; id: string | null }[],
    rightHandId: "rh",
    agentIds: ["first", "rh"],
    askable,
  };
  test("its maker, else the last agent that spoke, else one who took part, else the right hand", () => {
    expect(fileAgentId({ ...base, createdBy: { type: "agent", id: "atlas" } })).toBe("atlas");
    const spoke = [
      { type: "agent", id: "iris" },
      { type: "person", id: "ada" },
      { type: "agent", id: "theo" },
      { type: "agent", id: "no" },
    ];
    expect(fileAgentId({ ...base, createdBy: { type: "person", id: "ada" }, spoke })).toBe("theo");
    expect(
      fileAgentId({ ...base, createdBy: { type: "agent", id: "no" }, participants: [{ type: "agent", id: "iris" }] }),
    ).toBe("iris");
    expect(fileAgentId({ ...base, createdBy: { type: "person", id: "ada" } })).toBe("rh");
    expect(fileAgentId({ ...base, rightHandId: null, createdBy: { type: "person", id: "ada" } })).toBe("first");
    expect(fileAgentId({ ...base, agentIds: ["no"], rightHandId: "no", createdBy: { type: "person", id: "a" } })).toBe(
      null,
    );
  });

  test("Ask Atlas writes its handle, and the words when there are some", () => {
    expect(askText("atlas")).toBe("@atlas ");
    expect(askText("atlas", "faz variações desta imagem")).toBe("@atlas faz variações desta imagem");
  });
});

describe("comment pins and the way back to the file", () => {
  test("the conversation's messages about this file with a spot, numbered in order", () => {
    const at = (x: number, y: number) => ({ label: "Comentário", point: { x, y } });
    const msg = (id: string, ref: LiveRef | null) => ({ id, author: { type: "person", id: "ada" }, liveRef: ref });
    const pins = talkPins("f1", [
      msg("m1", { artifactId: "f1", kind: "canvas", title: "B", selection: at(10, 20) }),
      msg("m2", { artifactId: "f1", kind: "canvas", title: "B", selection: { label: "1 imagem", shapes: ["s"] } }),
      msg("m3", null),
      msg("m4", { artifactId: "other", kind: "canvas", title: "B", selection: at(1, 1) }),
      msg("m5", { artifactId: "f1", kind: "canvas", title: "B", selection: at(-5, 7) }),
    ]);
    expect(pins.map((p) => [p.messageId, p.n, p.at])).toEqual([
      ["m1", 1, { x: 10, y: 20 }],
      ["m5", 2, { x: -5, y: 7 }],
    ]);
  });

  test("a message's line goes back when the file is right under the conversation, else opens it", () => {
    const routes = [
      { name: "(tabs)" },
      { name: "canvas/[id]", params: { id: "f1" } },
      { name: "chat/[channelId]", params: { channelId: "c1" } },
    ];
    expect(fileUnder(routes, "f1")).toBe(true);
    expect(fileUnder(routes, "f2")).toBe(false);
    expect(fileUnder([{ name: "chat/[channelId]" }], "f1")).toBe(false);
    expect(fileUnder(undefined, "f1")).toBe(false);
  });
});

describe("the canvas's pen and its selection's words", () => {
  test("a stroke keeps the points far enough apart, always its last one, and fits the canvas's limit", () => {
    expect(thinPoints([0, 0, 1, 0, 2, 0, 10, 0, 10.5, 0], 2)).toEqual([0, 0, 2, 0, 10.5, 0]);
    expect(thinPoints([5, 5], 2)).toEqual([5, 5]);
    expect(thinPoints([], 2)).toEqual([]);
    const long = Array.from({ length: 3000 }, (_, i) => [i * 3, Math.sin(i) * 50]).flat();
    const thin = thinPoints(long, 1);
    expect(thin.length).toBeLessThanOrEqual(STROKE_MAX);
    expect(thin.slice(-2)).toEqual(long.slice(-2));
  });

  test("a stroke as a pen shape: its box, its points from the box's corner", () => {
    expect(strokeShape([10, 20, 30, 25, 15, 40])).toEqual({ x: 10, y: 20, w: 20, h: 20, points: [0, 0, 20, 5, 5, 20] });
    // A dot still has a box to stand in.
    expect(strokeShape([4, 4])).toEqual({ x: 4, y: 4, w: 1, h: 1, points: [0, 0] });
    expect(strokeShape([])).toBeNull();
  });

  test("what is chosen, in words for the quote: one kind counted, a mix as items", () => {
    expect(canvasSelection(t, [{ id: "a", type: "image" }])).toEqual({
      label: 'live.canvas.count.image {"count":1}',
      shapes: ["a"],
    });
    expect(
      canvasSelection(t, [
        { id: "a", type: "image" },
        { id: "b", type: "pending" },
      ])?.label,
    ).toBe('live.canvas.count.image {"count":2}');
    expect(
      canvasSelection(t, [
        { id: "a", type: "note" },
        { id: "b", type: "draw" },
      ])?.label,
    ).toBe('live.canvas.count.items {"count":2}');
    expect(canvasSelection(t, [])).toBeNull();
  });
});

describe("the canvas's pen bar and crop", () => {
  test("a stroke takes the bar's color and size; the highlighter is wide and says so", () => {
    expect(strokeOf({ tool: "pen", color: "#e5484d", size: "s" })).toEqual({ stroke: "#e5484d", strokeWidth: 2 });
    expect(strokeOf({ tool: "marker", color: "#f2a33a", size: "l" })).toEqual({
      stroke: "#f2a33a",
      strokeWidth: 24,
      tool: "marker",
    });
    expect(isInk("#151514")).toBe(true);
    expect(isInk("#000")).toBe(true);
    expect(isInk("#0063d1")).toBe(false);
    expect(isInk("nope")).toBe(false);
  });

  test("a crop keeps the part chosen of what shows, where it was, at its size", () => {
    const picture = { x: 100, y: 50, w: 400, h: 200 };
    expect(croppedPicture(picture, { x: 0.25, y: 0, w: 0.5, h: 0.5 })).toEqual({
      crop: { x: 0.25, y: 0, w: 0.5, h: 0.5 },
      x: 200,
      y: 50,
      w: 200,
      h: 100,
    });
    // Cropped again: inside the crop it had.
    const again = croppedPicture(
      { ...picture, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    );
    expect(again.crop).toEqual({ x: 0.75, y: 0.5, w: 0.25, h: 0.5 });
    expect(clampCrop({ x: -1, y: 0.9, w: 3, h: 0.5 })).toEqual({ x: 0, y: 0.9, w: 1, h: 0.09999999999999998 });
  });
});

describe("a document's blocks on the phone", () => {
  const p = (text: string, more: Partial<Extract<DocBlock, { type: "paragraph" }>> = {}): DocBlock => ({
    type: "paragraph",
    id: "b1",
    runs: [{ text }],
    ...more,
  });

  test("which blocks the phone edits: words, not pictures or a quote of many parts", () => {
    expect(editable(p("x"))).toBe(true);
    expect(editable({ type: "code_block", id: "c", text: "a\nb" })).toBe(true);
    expect(editable({ type: "image", id: "i", asset: "a" })).toBe(false);
    expect(editable({ type: "blockquote", id: "q", blocks: [p("um"), p("dois")] })).toBe(false);
    expect(editable({ type: "blockquote", id: "q", blocks: [p("um")] })).toBe(true);
  });

  test("its style changes, its words kept; a list and a quote toggle", () => {
    expect(restyled(p("Título"), "h2")).toEqual({ type: "heading", id: "b1", level: 2, runs: [{ text: "Título" }] });
    expect(blockStyle(restyled(p("x"), "h1"))).toBe("h1");
    expect(restyled(p("x"), "code")).toEqual({ type: "code_block", id: "b1", text: "x" });
    expect(toggledList(p("x"), "ordered")).toEqual({ ...p("x"), list: "ordered" });
    expect(toggledList(p("x", { list: "ordered", level: 1 }), "ordered")).toEqual(p("x"));
    expect(toggledQuote(p("x"))).toEqual({
      type: "blockquote",
      id: "b1",
      blocks: [{ type: "paragraph", runs: [{ text: "x" }] }],
    });
    expect(toggledQuote(toggledQuote(p("x")))).toEqual(p("x"));
  });

  test("a numbered list counts along its items, starting again after anything else", () => {
    const blocks: DocBlock[] = [
      p("a", { id: "1", list: "ordered" }),
      p("b", { id: "2", list: "ordered" }),
      p("c", { id: "3", list: "ordered", level: 1 }),
      p("d", { id: "4", list: "ordered" }),
      p("x", { id: "5" }),
      p("e", { id: "6", list: "ordered" }),
    ];
    expect([...listNumbers(blocks)]).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 1],
      ["4", 3],
      ["6", 1],
    ]);
  });

  test("Ask Atlas quotes the block (or the words chosen), its id with it", () => {
    expect(askSelection(p("O verão chegou mais cedo"))).toEqual({
      label: "“O verão chegou mais cedo”",
      block: "b1",
      text: "O verão chegou mais cedo",
    });
    expect(askSelection(p("O verão chegou"), "verão")?.text).toBe("verão");
    expect(askSelection(p("x".repeat(300)))?.text?.length).toBe(200);
    expect(askSelection(p("x".repeat(300)))?.label.length).toBeLessThanOrEqual(62);
    expect(askSelection({ type: "paragraph", runs: [] })).toBeNull();
  });
});

describe("links and notices open a file at its conversation's message", () => {
  test("a file's link, with or without the message", () => {
    expect(fileHref("f1")).toBe("/file/f1");
    expect(fileHref("f1", "m1")).toBe("/file/f1?m=m1");
    expect(fileHref("f1", "../x")).toBe("/file/f1");
    expect(hrefFromUrl("agenteschat://drive/f1?m=m1")).toBe("/file/f1?m=m1");
    expect(hrefFromUrl("agenteschat://drive/f1")).toBe("/file/f1");
    expect(hrefFromUrl("agenteschat://drive")).toBeNull();
    expect(appLinkFromUrl("https://app.agentes.chat/org/o1/drive/f1?m=m1", "o1")).toEqual({ href: "/file/f1?m=m1" });
    expect(appLinkFromUrl("https://app.agentes.chat/org/o1/drive/f1", "o1")).toEqual({ href: "/file/f1" });
  });

  test("a notice about a message in a file's conversation opens the file at it, its push too", () => {
    const source = { artifactId: "f1", channelId: "c1", threadId: "r1", messageId: "m1" };
    expect(notificationHref({ kind: "mention", source })).toBe("/file/f1?m=m1");
    expect(notificationHref({ kind: "thread_reply", source: { artifactId: "f1" } })).toBe("/file/f1");
    expect(hrefForPush({ kind: "mention", ...source })).toBe("/file/f1?m=m1");
  });
});
